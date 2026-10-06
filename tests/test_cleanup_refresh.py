# -*- coding: utf-8 -*-
"""
test_cleanup_refresh.py
Refresh older takes: POST /api/rooms/{room}/cleanup/refresh moves one person's takes to
their latest room check and re-cleans them in the background, switching a take's settings
only once its new audio is written; renders are refused (or wait, for the premiere) while
it runs.
"""

import os
import asyncio
import functools
import threading
import contextlib
import time
import unittest
from unittest import mock

import anyio

import sys as _sys
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_sys.path.insert(0, os.path.dirname(_TESTS_DIR))
_sys.path.insert(0, _TESTS_DIR)

import audio_processor as ap
from test_recording_timing import UploadCase
from test_room_check import white, SR

REFRESHING = "Older takes are being refreshed. Try again in a moment."


class RefreshCase(UploadCase):
    """One event loop for the whole test, so the refresh task outlives the request that starts it."""

    def setUp(self):
        super().setUp()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.client.portal = stack.enter_context(anyio.from_thread.start_blocking_portal("asyncio"))
        stack.callback(setattr, self.client, "portal", None)
        for patcher in (mock.patch.object(ap, "get_deep_filter_path", return_value=None),
                        mock.patch.object(ap, "apply_noise_reduction", side_effect=self._fake_clean)):
            self.nr = patcher.start()
            self.addCleanup(patcher.stop)
        # Released by default; a test clears it to hold the refresh inside its first clean.
        self.gate = threading.Event()
        self.gate.set()
        self.addCleanup(self.gate.set)
        self.room = self._room()
        self.sent = []
        broadcast = self.room.broadcast

        async def capture(message_type, payload=None):
            self.sent.append((message_type, payload))
            await broadcast(message_type, payload)

        self.room.broadcast = capture
        pid, _ = ap.save_noise_profile(white(-50.0), SR)
        self.pid = pid
        self.settings = ap.noise_cleanup_settings(pid)

    def _fake_clean(self, src, dst, *a, **k):
        self.gate.wait(10)
        ap.write_wav_mono(dst, ap.read_wav_mono(src) * 0.5, SR)
        return dst

    def _take(self, line_id, take_id, user_id, noise_reduction=True, **fields):
        return self._add(self.room, line_id, take_id=take_id, user_id=user_id,
                         noise_reduction=noise_reduction, stretch=1.0, **fields)

    def _paths(self, line_id, take_id):
        d = ap.take_dir(self.ROOM, line_id)
        return os.path.join(d, f"{take_id}.wav"), os.path.join(d, f"{take_id}_raw.wav")

    def _refresh(self, user_id="u1", noise_profile_id="", status=200):
        res = self.client.post(f"/api/rooms/{self.ROOM}/cleanup/refresh",
                               json={"user_id": user_id, "noise_profile_id": noise_profile_id or self.pid})
        self.assertEqual(res.status_code, status, res.text)
        return res.json()

    def _wait(self):
        task = self.room.cleanup_refresh_task
        if task is not None:
            self.client.portal.call(functools.partial(asyncio.wait, {task}, timeout=20))
            self.assertTrue(task.done())

    def _types(self, message_type):
        return [payload for kind, payload in self.sent if kind == message_type]


class TestCleanupRefresh(RefreshCase):

    def test_moves_only_that_users_takes_and_recleans_nr_on_ones(self):
        on = self._take("t1000", "kon", "u1", gain_db=0.0, auto_gain_db=0.0)
        off = self._take("t3000", "koff", "u1", noise_reduction=False)
        ready = self._take("t5000", "kready", "u1")
        current = self._take("t3000", "kcurrent", "u1", nr_settings=self.settings)
        other = self._take("t1000", "kother", "u2")
        # kready has a cleaned file for the new settings but plays standard cleanup: its
        # active audio is rewritten from that file without cleaning again. kcurrent already
        # plays the new cleaning and is left alone.
        for line, take_id in (("t5000", "kready"), ("t3000", "kcurrent")):
            ap.write_wav_mono(ap.denoised_take_path(ap.take_dir(self.ROOM, line), take_id, self.settings),
                              ap.read_wav_mono(self._paths(line, take_id)[1]) * 0.25, SR)
        everyone = (("t1000", on), ("t3000", off), ("t5000", ready), ("t3000", current), ("t1000", other))
        raw_before = {t["take_id"]: self._read(self._paths(line, t["take_id"])[1]) for line, t in everyone}
        active_before = {t["take_id"]: self._read(self._paths(line, t["take_id"])[0]) for line, t in everyone}

        self.assertEqual(self._refresh(), {"status": "ok", "refreshing": 2})
        self._wait()

        for take in (on, off, ready, current):
            self.assertEqual(take["nr_settings"], self.settings)
        self.assertNotIn("nr_settings", other)
        self.assertEqual(self.nr.call_count, 1)
        self.assertEqual(self.nr.call_args.args[0], self._paths("t1000", "kon")[1])
        self.assertEqual(self.nr.call_args.kwargs["settings"], self.settings)
        self.assertNotEqual(on["audio_version"], 1)
        self.assertNotEqual(ready["audio_version"], 1)
        for take in (off, current, other):
            self.assertEqual(take["audio_version"], 1)
        for line, take_id in (("t1000", "kon"), ("t5000", "kready")):
            self.assertNotEqual(self._read(self._paths(line, take_id)[0]), active_before[take_id])
            self.assertTrue(os.path.isfile(ap.denoised_take_path(ap.take_dir(self.ROOM, line), take_id, self.settings)))
        for line, t in (("t3000", off), ("t3000", current), ("t1000", other)):
            self.assertEqual(self._read(self._paths(line, t["take_id"])[0]), active_before[t["take_id"]])
        for line, t in everyone:
            self.assertEqual(self._read(self._paths(line, t["take_id"])[1]), raw_before[t["take_id"]])

        updated = self._types("take_params_updated")
        self.assertEqual([(p["line_id"], p["take_id"]) for p in updated], [("t1000", "kon"), ("t5000", "kready")])
        self.assertTrue(all(p["noise_reduction"] for p in updated))
        self.assertEqual(updated[0]["url"], self.room.wire_take("t1000", on)["url"])
        self.assertEqual(self._types("cleanup_refreshed"), [{"user_id": "u1", "count": 2, "failed": 0}])
        self.assertEqual(self.room.cleanup_refreshing, {})

    def test_a_take_that_fails_keeps_its_settings_and_sound(self):
        settings_before = {"profile_id": "aaaaaaaaaaaa", "attenuation_db": 12, "notches_hz": []}
        bad = self._take("t1000", "kbad", "u1", nr_settings=settings_before, gain_db=0.0, auto_gain_db=0.0)
        good = self._take("t5000", "kgood", "u1")
        bad_before = dict(bad)
        active_before = self._read(self._paths("t1000", "kbad")[0])
        clean = self._fake_clean

        def clean_or_fail(src, dst, *a, **k):
            if os.path.basename(src).startswith("kbad"):
                raise RuntimeError("cleanup crashed")
            return clean(src, dst, *a, **k)

        self.nr.side_effect = clean_or_fail
        self.assertEqual(self._refresh()["refreshing"], 2)
        self._wait()

        self.assertEqual(bad, bad_before)
        self.assertEqual(self._read(self._paths("t1000", "kbad")[0]), active_before)
        self.assertEqual(good["nr_settings"], self.settings)
        self.assertEqual([p["take_id"] for p in self._types("take_params_updated")], ["kgood"])
        self.assertEqual(self._types("cleanup_refreshed"), [{"user_id": "u1", "count": 1, "failed": 1}])
        self.assertEqual(self.room.cleanup_refreshing, {})

    def test_line_outside_the_pack_keeps_a_cleaned_takes_settings(self):
        away_on = self._take("t9000", "kaway", "u1")
        away_off = self._take("t9000", "kraw", "u1", noise_reduction=False)
        self.assertEqual(self._refresh()["refreshing"], 0)
        self.assertNotIn("nr_settings", away_on)
        self.assertEqual(away_off["nr_settings"], self.settings)
        self.nr.assert_not_called()

    def test_nothing_to_reclean_reports_at_once(self):
        take = self._take("t3000", "koff", "u1", noise_reduction=False)
        self.assertEqual(self._refresh(), {"status": "ok", "refreshing": 0})
        self.assertIsNone(self.room.cleanup_refresh_task)
        self.assertEqual(take["nr_settings"], self.settings)
        self.assertEqual(self._types("cleanup_refreshed"), [{"user_id": "u1", "count": 0, "failed": 0}])
        self.assertEqual(self.room.cleanup_refreshing, {})
        self.nr.assert_not_called()

    def test_unknown_profile_moves_takes_to_standard_cleanup(self):
        take = self._take("t1000", "ka", "u1", nr_settings=self.settings)
        tuned = ap.denoised_take_path(ap.take_dir(self.ROOM, "t1000"), "ka", self.settings)
        ap.write_wav_mono(tuned, ap.read_wav_mono(self._paths("t1000", "ka")[1]), SR)
        self.assertEqual(self._refresh(noise_profile_id="0123456789ab")["refreshing"], 1)
        self._wait()
        self.assertNotIn("nr_settings", take)
        self.assertTrue(os.path.isfile(ap.denoised_take_path(ap.take_dir(self.ROOM, "t1000"), "ka")))
        self.assertFalse(os.path.exists(tuned))
        self.assertIsNone(self.nr.call_args.kwargs.get("settings"))

    def test_bad_user_id_is_rejected(self):
        self._refresh(user_id="../x", status=400)

    def test_refused_while_a_video_renders(self):
        take = self._take("t1000", "ka", "u1")
        self.room.export_status["16:9"] = "processing"
        body = self._refresh(status=409)
        self.assertEqual(body["detail"], "A video is rendering. Refresh older takes when it's done.")
        self.assertNotIn("nr_settings", take)
        self.assertEqual(self.room.cleanup_refreshing, {})

    def _premiere(self, ws):
        ws.send_json({"type": "launch_premiere", "payload": {}})

    def test_refused_while_the_premiere_renders(self):
        take = self._take("t1000", "ka", "u1")
        self.room.host_id = "hostT"
        rendering, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def render(*a, **k):
            rendering.set()
            release.wait(10)

        with mock.patch.object(ap, "export_dub_video", side_effect=render):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
                self._premiere(ws)
                self.assertTrue(rendering.wait(10))
                self.assertEqual(self.room.export_status.get("16:9"), "processing")
                body = self._refresh(status=409)
                self.assertEqual(body["detail"], "A video is rendering. Refresh older takes when it's done.")
                release.set()
                self._until(ws, "warp_to_screening")
        self.assertEqual(self.room.export_status["16:9"], "ready")
        self.assertNotIn("nr_settings", take)
        self.assertEqual(self._refresh()["refreshing"], 1)
        self._wait()
        self.assertEqual(take["nr_settings"], self.settings)

    def test_a_failed_premiere_render_lets_refresh_run(self):
        self._take("t1000", "ka", "u1")
        self.room.host_id = "hostT"
        with mock.patch.object(ap, "export_dub_video", side_effect=RuntimeError("render broke")):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
                self._premiere(ws)
                self._until(ws, "warp_to_screening")
        self.assertEqual(self.room.export_status["16:9"], "failed: render broke")
        self.assertEqual(self._refresh()["refreshing"], 1)
        self._wait()


class TestRefreshWhileRunning(RefreshCase):

    def setUp(self):
        super().setUp()
        self.first = self._take("t1000", "ka", "u1")
        self.second = self._take("t5000", "kb", "u1")
        self.gate.clear()

    def test_second_request_returns_running_count(self):
        self.assertEqual(self._refresh()["refreshing"], 2)
        task = self.room.cleanup_refresh_task
        self.assertEqual(self._refresh(), {"status": "ok", "refreshing": 2})
        self.assertIs(self.room.cleanup_refresh_task, task)
        # Room state says whose refresh runs, for a tab that misses cleanup_refreshed.
        self.assertEqual(self.room.to_state_dict()["cleanup_refreshing"], ["u1"])
        self.gate.set()
        self._wait()
        self.assertEqual(self.room.to_state_dict()["cleanup_refreshing"], [])
        self.assertEqual(self.nr.call_count, 2)
        self.assertEqual(self._types("cleanup_refreshed"), [{"user_id": "u1", "count": 2, "failed": 0}])

    def test_renders_and_project_zip_are_refused_until_it_ends(self):
        self._refresh()
        with mock.patch.object(ap, "export_dub_video") as render, \
                mock.patch.object(ap, "build_project_zip") as build_zip:
            for method, url in (("post", "export"), ("get", "export/download"), ("get", "export/project_zip")):
                res = getattr(self.client, method)(f"/api/rooms/{self.ROOM}/{url}")
                self.assertEqual(res.status_code, 409, url)
                self.assertEqual(res.json()["detail"], REFRESHING)
            render.assert_not_called()
            build_zip.assert_not_called()
            self.gate.set()
            self._wait()
            res = self.client.post(f"/api/rooms/{self.ROOM}/export")
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(res.json()["status"], "processing")
        self.assertEqual(self.room.cleanup_refreshing, {})

    def test_take_deleted_meanwhile_is_skipped(self):
        self._refresh()
        # The first clean is held inside the processing lock; the delete lands before the second.
        self.client.portal.call(self.room.remove_take, "t5000", "kb")
        self.gate.set()
        self._wait()
        self.assertEqual(self.nr.call_count, 1)
        self.assertEqual([p["take_id"] for p in self._types("take_params_updated")], ["ka"])
        self.assertEqual(self._types("cleanup_refreshed"), [{"user_id": "u1", "count": 1, "failed": 0}])
        self.assertIsNone(self.room.find_take("t5000", "kb"))

    def test_settings_switch_only_once_the_take_is_recleaned(self):
        self._refresh()
        # The first take is inside its clean: neither take has the new settings yet.
        self.assertNotIn("nr_settings", self.first)
        self.assertNotIn("nr_settings", self.second)
        self.gate.set()
        self._wait()
        self.assertEqual(self.first["nr_settings"], self.settings)
        self.assertEqual(self.second["nr_settings"], self.settings)

    def test_take_switched_to_raw_meanwhile_just_gets_the_settings(self):
        self._refresh()

        # As the toggle route does it, under the processing lock: it lands after the
        # first clean and before the second.
        waiting = threading.Event()

        async def to_raw():
            waiting.set()
            async with self.room.processing_lock:
                self.second["noise_reduction"] = False

        self.client.portal.start_task_soon(to_raw)
        self.assertTrue(waiting.wait(10))
        self.gate.set()
        self._wait()
        self.assertEqual(self.nr.call_count, 1)
        self.assertEqual(self.second["nr_settings"], self.settings)
        self.assertEqual(self.second["audio_version"], 1)
        self.assertEqual(self._types("cleanup_refreshed"), [{"user_id": "u1", "count": 1, "failed": 0}])

    def test_premiere_waits_for_the_refresh(self):
        self.room.host_id = "hostT"
        seen = []
        with mock.patch.object(ap, "export_dub_video",
                               side_effect=lambda *a, **k: seen.append(dict(self.room.cleanup_refreshing))):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
                self._refresh()
                ws.send_json({"type": "launch_premiere", "payload": {}})
                time.sleep(0.3)
                self.assertEqual(seen, [])
                self.gate.set()
                self._until(ws, "warp_to_screening")
        self.assertEqual(seen, [{}])
        self.assertEqual(self.nr.call_count, 2)


if __name__ == "__main__":
    unittest.main()
