# -*- coding: utf-8 -*-
"""
test_export_render_job.py
The shared export render (rooms_api.start_export_render): one background task per aspect
that outlives the request or socket that started it. A mix or take change during a render
(Room.export_generation) throws its result away and renders again with the new settings, so
a stale video is never offered as ready. Room.invalidate_exports() tells the clients
(export_invalidated) only when a finished video or a running render was dropped, and the
room state lists each format's export state.
"""

import asyncio
import functools
import os
import threading
import unittest
from unittest import mock

import sys as _sys
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_sys.path.insert(0, os.path.dirname(_TESTS_DIR))
_sys.path.insert(0, _TESTS_DIR)

from fastapi.testclient import TestClient

import audio_processor
from app import app
from dubmate import rooms, rooms_api
from test_take_model import RoomCase

HOST = "hostT"


def write_video(*args, **kwargs):
    """Stands in for export_dub_video: writes a file big enough to count as a finished render."""
    with open(args[2], "wb") as f:
        f.write(b"\0" * 2048)


class RenderJobCase(RoomCase):

    def setUp(self):
        super().setUp()
        self.client = TestClient(app)
        self._one_event_loop(self.client)
        exports = os.path.join(self.cache, "exports")
        os.makedirs(exports, exist_ok=True)
        patcher = mock.patch("dubmate.common._exports_dir", exports)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.room = self._room()
        self.sent = []
        broadcast = self.room.broadcast

        async def capture(message_type, payload=None):
            self.sent.append((message_type, payload))
            await broadcast(message_type, payload)

        self.room.broadcast = capture
        # Released by default; a test clears it to hold the render inside its first pass.
        self.gate = threading.Event()
        self.gate.set()
        self.addCleanup(self.gate.set)
        self.rendering = threading.Event()
        self.calls = []

    def _render(self, *args, **kwargs):
        self.calls.append(kwargs)
        self.rendering.set()
        self.assertTrue(self.gate.wait(10))
        write_video(*args, **kwargs)

    def _types(self, message_type):
        return [payload for kind, payload in self.sent if kind == message_type]

    def _call(self, fn, *args):
        """Runs fn on the room's event loop (as a route or the socket would)."""
        async def run():
            return fn(*args)
        return self.client.portal.call(run)

    def _settle(self):
        self.client.portal.call(asyncio.sleep, 0.05)

    def _finish(self, task):
        self.client.portal.call(functools.partial(asyncio.wait, {task}, timeout=20))
        self.assertTrue(task.done())


class TestRestart(RenderJobCase):

    def test_a_mix_change_mid_render_renders_again(self):
        self.gate.clear()
        seen_between = []

        def render(*args, **kwargs):
            if self.calls:
                # The second pass: the first pass's file was not offered as ready.
                seen_between.append((self.room.ready_export_path("16:9"),
                                     self.room.to_state_dict()["exports"]["16:9"]))
            self._render(*args, **kwargs)

        with mock.patch.object(audio_processor, "export_dub_video", side_effect=render):
            res = self.client.post(f"/api/rooms/{self.ROOM}/export?user_id={HOST}")
            self.assertEqual(res.json()["status"], "processing", res.text)
            self.assertTrue(self.rendering.wait(10))

            def change_mix():
                self.room.master_mix_balance = 80
                self.room.invalidate_exports()

            self._call(change_mix)
            self.gate.set()
            self._finish(self.room.export_tasks["16:9"])

        self.assertEqual([k.get("mix_balance") for k in self.calls], [50, 80])
        self.assertEqual(seen_between, [(None, "processing")])
        self.assertEqual(self._types("export_started"),
                         [{"aspect_ratio": "16:9"}, {"aspect_ratio": "16:9", "restarted": True}])
        self.assertEqual(len(self._types("export_ready")), 1)
        self.assertEqual(self.room.export_status["16:9"], "ready")
        self.assertIsNotNone(self.room.ready_export_path("16:9"))
        self.assertEqual(self.room.to_state_dict()["exports"], {"16:9": "ready", "9:16": "idle"})

    def test_one_task_per_aspect(self):
        self.gate.clear()
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=self._render):
            first = self._call(rooms_api.start_export_render, self.room, "16:9")
            self.assertIs(self._call(rooms_api.start_export_render, self.room, "16:9"), first)
            res = self.client.post(f"/api/rooms/{self.ROOM}/export?user_id={HOST}")
            self.assertEqual(res.json()["status"], "processing", res.text)
            self.assertIs(self.room.export_tasks["16:9"], first)
            shorts = self._call(rooms_api.start_export_render, self.room, "9:16")
            self.assertIsNot(shorts, first)
            self.gate.set()
            self._finish(first)
            self._finish(shorts)
        self.assertEqual(sorted(k["aspect_ratio"] for k in self.calls), ["16:9", "9:16"])
        self.assertEqual(self.room.to_state_dict()["exports"], {"16:9": "ready", "9:16": "ready"})

    def test_a_failure_is_broadcast(self):
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=RuntimeError("ffmpeg broke")):
            task = self._call(rooms_api.start_export_render, self.room, "16:9")
            self._finish(task)
        self.assertEqual(self._types("export_failed"), [{"aspect_ratio": "16:9", "error": "ffmpeg broke"}])
        self.assertEqual(self.room.export_status["16:9"], "failed: ffmpeg broke")
        self.assertEqual(self.room.to_state_dict()["exports"]["16:9"], "failed")

    def test_missing_effects_keep_their_message(self):
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=audio_processor.EffectsUnavailable()):
            self._finish(self._call(rooms_api.start_export_render, self.room, "16:9"))
        self.assertEqual(self._types("export_failed"),
                         [{"aspect_ratio": "16:9", "error": audio_processor.EFFECTS_MISSING_MESSAGE}])

    def test_a_forgotten_room_stops_its_render(self):
        self.gate.clear()
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=self._render):
            task = self._call(rooms_api.start_export_render, self.room, "16:9")
            self.assertTrue(self.rendering.wait(10))
            self._call(rooms._forget_room, self.ROOM)
            self.gate.set()
            self.client.portal.call(functools.partial(asyncio.wait, {task}, timeout=20))
        self.assertTrue(task.cancelled())
        self.assertNotIn("16:9", self.room.export_status)
        self.assertEqual(self._types("export_ready"), [])


class TestSteps(RenderJobCase):

    def test_status_says_which_step_runs(self):
        # The modal's Mix audio / Make video strip follows these, not the POST's reply.
        mixing = threading.Event()
        mixed = threading.Event()
        self.addCleanup(mixing.set)
        self.gate.clear()

        def render(*args, **kwargs):
            self.rendering.set()
            self.assertTrue(mixing.wait(10))
            kwargs["on_audio_mixed"]()
            mixed.set()
            self._render(*args, **kwargs)

        def status():
            return self.client.get(f"/api/rooms/{self.ROOM}/export/status?aspect_ratio=16:9").json()

        with mock.patch.object(audio_processor, "export_dub_video", side_effect=render):
            res = self.client.post(f"/api/rooms/{self.ROOM}/export?user_id={HOST}")
            self.assertEqual(res.json()["status"], "processing", res.text)
            self.assertTrue(self.rendering.wait(10))
            self.assertEqual(status(), {"status": "processing", "aspect_ratio": "16:9", "step": "mix"})
            mixing.set()
            self.assertTrue(mixed.wait(10))
            self.assertEqual(status()["step"], "video")
            self.gate.set()
            self._finish(self.room.export_tasks["16:9"])
        self.assertEqual(status()["status"], "ready")
        self.assertNotIn("step", status())


class TestInvalidated(RenderJobCase):

    def test_sent_only_when_something_was_dropped(self):
        generation = self.room.export_generation
        self._call(self.room.invalidate_exports)
        self._settle()
        self.assertEqual(self._types("export_invalidated"), [])
        self.assertEqual(self.room.export_generation, generation + 1)

        path = self.room.export_out_path("9:16")
        write_video(None, None, path)
        self.room.exported_video_9_16_path = path
        self._call(self.room.invalidate_exports)
        self._settle()
        self.assertEqual(self._types("export_invalidated"), [{}])
        self.assertIsNone(self.room.exported_video_9_16_path)

        self.room.export_status["16:9"] = "processing"
        self._call(self.room.invalidate_exports)
        self._settle()
        self.assertEqual(self._types("export_invalidated"), [{}, {}])
        self.assertEqual(self.room.export_status["16:9"], "processing")

    def test_a_drag_during_a_render_sends_one_message(self):
        # Every step of a slider drag invalidates; while one message is still on its way,
        # the next steps don't queue more full-state broadcasts.
        self.room.export_status["16:9"] = "processing"

        def drag():
            for _ in range(5):
                self.room.invalidate_exports()

        self._call(drag)
        self._settle()
        self.assertEqual(self._types("export_invalidated"), [{}])
        self._call(self.room.invalidate_exports)
        self._settle()
        self.assertEqual(self._types("export_invalidated"), [{}, {}])

    def test_no_loop_no_message(self):
        self.room.exported_video_path = self.room.export_out_path("16:9")
        write_video(None, None, self.room.exported_video_path)
        self.room.invalidate_exports()   # no running loop here: nothing to tell
        self.assertIsNone(self.room.exported_video_path)


class TestStateExports(RenderJobCase):

    def test_each_format_has_a_state(self):
        self.assertEqual(self.room.to_state_dict()["exports"], {"16:9": "idle", "9:16": "idle"})
        self.room.export_status = {"16:9": "processing", "9:16": "failed: no ffmpeg"}
        self.assertEqual(self.room.to_state_dict()["exports"], {"16:9": "processing", "9:16": "failed"})
        path = self.room.export_out_path("16:9")
        write_video(None, None, path)
        self.room.exported_video_path = path
        self.room.export_status = {"16:9": "ready"}
        self.assertEqual(self.room.to_state_dict()["exports"], {"16:9": "ready", "9:16": "idle"})


if __name__ == "__main__":
    unittest.main()
