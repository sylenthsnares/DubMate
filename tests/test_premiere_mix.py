# -*- coding: utf-8 -*-
"""
test_premiere_mix.py
The premiere's Mix slider (music <-> voices, 0..100, 50 = even) is the room's, like its
dialogue level: the host's change is kept on the room (set_mix_balance), invalidates the
renders, reaches every client, survives a reload, and every render of the scene mix (the
premiere video, POST /export and the stems) uses it. At 50 the mix is unchanged.
The premiere sends everyone in at once and renders its video in the background.
"""

import os
import threading
import time
import unittest
from unittest import mock

import numpy as np

import sys as _sys
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_sys.path.insert(0, os.path.dirname(_TESTS_DIR))
_sys.path.insert(0, _TESTS_DIR)

from fastapi.testclient import TestClient

import audio_processor
from app import app
from dubmate import rooms
from test_security_hardening import _barrier
from test_stems_export import SR, StemsCase
from test_take_model import RoomCase

HOST = "hostT"
MEMBER = "member1"


def _studio_gains(balance):
    """getScreeningStemGains in static/js/studio/screening.js: what the premiere plays."""
    n = (balance - 50) / 50.0
    if n <= 0:
        return 0.65 + (-n) * 0.35, 0.95 * (1.0 + n * 0.80)
    return 0.65 * (1.0 - n * 0.75), 0.95 + n * 0.35


class TestBalanceGains(unittest.TestCase):

    def test_even_changes_nothing(self):
        self.assertEqual(audio_processor.mix_balance_gains(50), (1.0, 1.0))

    def test_follows_what_the_premiere_plays(self):
        for balance in (0, 10, 35, 50, 64, 90, 100):
            backing, voices = audio_processor.mix_balance_gains(balance)
            b, v = _studio_gains(balance)
            self.assertAlmostEqual(backing, b / 0.65, places=9, msg=balance)
            self.assertAlmostEqual(voices, v / 0.95, places=9, msg=balance)

    def test_out_of_range_is_clamped(self):
        self.assertEqual(audio_processor.mix_balance_gains(-20), audio_processor.mix_balance_gains(0))
        self.assertEqual(audio_processor.mix_balance_gains(400), audio_processor.mix_balance_gains(100))


class TestBalanceInTheMix(StemsCase):

    def test_buses_and_scene_follow_the_balance(self):
        pack, takes = self._scene()
        backing0, voices0 = audio_processor._mix_buses(pack, takes, SR, 0.0)
        for balance in (0, 80, 100):
            gb, gv = audio_processor.mix_balance_gains(balance)
            backing, voices = audio_processor._mix_buses(pack, takes, SR, 0.0, balance=balance)
            np.testing.assert_allclose(backing, backing0 * np.float32(gb), atol=1e-6)
            np.testing.assert_allclose(voices["dialogue"], voices0["dialogue"] * np.float32(gv), atol=1e-6)
            mix = audio_processor._mix_scene(pack, takes, SR, 0.0, balance=balance)
            np.testing.assert_array_equal(mix, backing + voices["dialogue"])

    def test_more_voice_is_heard_in_the_render(self):
        pack, takes = self._scene()
        out = {}
        for balance in (50, 100):
            path = os.path.join(self.dir, f"mix_{balance}.wav")
            audio_processor.render_dub_mix(pack, takes, path, mix_balance=balance)
            out[balance] = audio_processor.read_wav_mono(path, SR)
        self.assertFalse(np.allclose(out[50], out[100], atol=1e-4))


class MixRoomCase(RoomCase):

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

    def _until(self, ws, msg_type):
        while (msg := ws.receive_json())["type"] != msg_type:
            pass
        return msg

    def _join(self, ws, name):
        ws.send_json({"type": "join", "payload": {"name": name, "color": "#7c5cff"}})

    def _frames_until_pong(self, ws):
        ws.send_json({"type": "ping", "payload": {}})
        frames = []
        for _ in range(40):
            frame = ws.receive_json()
            if frame.get("type") == "pong":
                return frames
            frames.append(frame)
        raise AssertionError("no pong")


class TestRoomBalance(MixRoomCase):

    def test_host_sets_it_for_everyone_and_the_export_is_dropped(self):
        self.room.exported_video_path = os.path.join(self.cache, "old.mp4")
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Host")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
                self._join(ws, "Member")
                _barrier(ws)
                host_ws.send_json({"type": "set_mix_balance", "payload": {"balance": 80}})
                _barrier(host_ws)
                frames = self._frames_until_pong(ws)
        self.assertEqual(self.room.master_mix_balance, 80)
        self.assertIsNone(self.room.exported_video_path)
        syncs = [f for f in frames if f.get("type") == "mix_balance_sync"]
        self.assertEqual(len(syncs), 1, frames)
        self.assertEqual(syncs[0]["payload"]["balance"], 80)
        self.assertEqual(self.room.to_state_dict()["master_mix_balance"], 80)

    def test_member_is_refused(self):
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Host")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
                self._join(ws, "Member")
                ws.send_json({"type": "set_mix_balance", "payload": {"balance": 0}})
                frames = self._frames_until_pong(ws)
        self.assertEqual(self.room.master_mix_balance, 50)
        self.assertTrue(any(f.get("type") == "error" for f in frames), frames)

    def test_bad_values_are_ignored_or_clamped(self):
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
            self._join(ws, "Host")
            ws.send_json({"type": "set_mix_balance", "payload": {"balance": "loud"}})
            _barrier(ws)
            self.assertEqual(self.room.master_mix_balance, 50)
            ws.send_json({"type": "set_mix_balance", "payload": {"balance": 250}})
            _barrier(ws)
            self.assertEqual(self.room.master_mix_balance, 100)

    def test_survives_a_reload(self):
        self.room.master_mix_balance = 30
        self.room._sync_save_to_disk()
        rooms.ROOMS.clear()
        self.assertEqual(rooms.load_room_folder(self.ROOM).master_mix_balance, 30)


class TestRendersUseIt(MixRoomCase):

    def _wait_for(self, mocked):
        deadline = time.time() + 10
        while not mocked.called and time.time() < deadline:
            time.sleep(0.02)
        self.assertTrue(mocked.called)

    def test_export_route_uses_the_room_balance(self):
        self.room.master_mix_balance = 80
        with mock.patch.object(audio_processor, "export_dub_video") as render:
            res = self.client.post(f"/api/rooms/{self.ROOM}/export?user_id={HOST}")
            self.assertEqual(res.status_code, 200, res.text)
            self._wait_for(render)
        self.assertEqual(render.call_args.kwargs.get("mix_balance"), 80)

    def test_export_request_carries_the_balance_the_host_hears(self):
        with mock.patch.object(audio_processor, "export_dub_video") as render:
            res = self.client.post(f"/api/rooms/{self.ROOM}/export?user_id={HOST}&balance=20")
            self.assertEqual(res.status_code, 200, res.text)
            self._wait_for(render)
        self.assertEqual(render.call_args.kwargs.get("mix_balance"), 20)
        self.assertEqual(self.room.master_mix_balance, 20)

    def test_premiere_video_uses_it(self):
        self.room.master_mix_balance = 70
        seen = []

        def render(*args, **kwargs):
            seen.append(kwargs)
            _write(*args, **kwargs)

        with mock.patch.object(audio_processor, "export_dub_video", side_effect=render):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
                self._join(ws, "Host")
                ws.send_json({"type": "launch_premiere", "payload": {}})
                self._until(ws, "export_ready")
        self.assertEqual([k.get("mix_balance") for k in seen], [70])

    def test_export_and_stems_use_it(self):
        self.room.master_mix_balance = 65
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=_write) as render, \
                mock.patch.object(audio_processor, "build_stems_zip", side_effect=_write) as stems:
            res = self.client.post(f"/api/rooms/{self.ROOM}/export?user_id={HOST}")
            self.assertEqual(res.json()["status"], "processing", res.text)
            deadline = time.time() + 10
            while time.time() < deadline:
                status = self.client.get(res.json()["poll_url"]).json()["status"]
                if status != "processing":
                    break
                time.sleep(0.02)
            self.assertEqual(status, "ready")
            self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}/export/download").status_code, 200)
            self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}/export/stems?user_id={HOST}").status_code, 200)
        self.assertEqual(render.call_count, 1)
        self.assertEqual(render.call_args.kwargs.get("mix_balance"), 65)
        self.assertEqual(stems.call_args.kwargs.get("mix_balance"), 65)


def _write(*args, **kwargs):
    """Stands in for export_dub_video and build_stems_zip: a file big enough to count as done."""
    path = kwargs.get("output_zip_path") or args[2]
    with open(path, "wb") as f:
        f.write(b"PK" + b"\0" * 2048)
    return path


class TestPremiereLaunch(MixRoomCase):
    """launch_premiere sends everyone in at once; the video renders behind them."""

    def setUp(self):
        super().setUp()
        self.sent = []
        broadcast = self.room.broadcast

        async def capture(message_type, payload=None):
            self.sent.append((message_type, payload))
            await broadcast(message_type, payload)

        self.room.broadcast = capture

    def _launch(self, ws):
        self._join(ws, "Host")
        ws.send_json({"type": "launch_premiere", "payload": {}})

    def _wait_for_sent(self, message_type):
        deadline = time.time() + 10
        while time.time() < deadline:
            found = [p for kind, p in self.sent if kind == message_type]
            if found:
                return found
            time.sleep(0.02)
        self.fail(f"no {message_type}: {[kind for kind, _ in self.sent]}")

    def test_everyone_goes_in_before_the_video_is_done(self):
        release, finished = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def render(*args, **kwargs):
            release.wait(10)
            _write(*args, **kwargs)
            finished.set()

        with mock.patch.object(audio_processor, "export_dub_video", side_effect=render):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
                self._launch(ws)
                warp = self._until(ws, "warp_to_screening")
                self.assertFalse(finished.is_set(), "the premiere waited for the render")
                self.assertEqual(warp["state"]["status"], "screening")
                self.assertEqual(warp["state"]["exports"]["16:9"], "processing")
                release.set()
                ready = self._until(ws, "export_ready")
        self.assertEqual(ready["payload"]["aspect_ratio"], "16:9")
        self.assertEqual(self.room.export_status["16:9"], "ready")
        self.assertEqual([kind for kind, _ in self.sent if kind.startswith(("warp", "export"))],
                         ["warp_to_screening", "export_started", "export_ready"])

    def test_a_failed_render_reaches_everyone(self):
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=RuntimeError("render broke")):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
                self._launch(ws)
                self._until(ws, "warp_to_screening")
                failed = self._wait_for_sent("export_failed")
        self.assertEqual(failed, [{"aspect_ratio": "16:9", "error": "render broke"}])
        self.assertEqual(self.room.export_status["16:9"], "failed: render broke")

    def test_a_saved_video_is_not_rendered_again(self):
        path = self.room.export_out_path("16:9")
        _write(None, None, path)
        self.room.exported_video_path = path
        with mock.patch.object(audio_processor, "export_dub_video") as render:
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
                self._launch(ws)
                warp = self._until(ws, "warp_to_screening")
                _barrier(ws)
        render.assert_not_called()
        self.assertEqual(warp["state"]["exports"]["16:9"], "ready")

    def test_a_member_cannot_launch_it(self):
        with mock.patch.object(audio_processor, "export_dub_video") as render:
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
                self._join(host_ws, "Host")
                _barrier(host_ws)
                with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
                    self._join(ws, "Member")
                    ws.send_json({"type": "launch_premiere", "payload": {}})
                    _barrier(ws)
        render.assert_not_called()
        self.assertEqual(self.room.status, "lobby")
        self.assertNotIn("warp_to_screening", [kind for kind, _ in self.sent])


if __name__ == "__main__":
    unittest.main()
