# -*- coding: utf-8 -*-
"""
test_premiere_mix.py
The premiere's Mix slider (music <-> voices, 0..100, 50 = even) is the room's, like its
dialogue level: the host's change is kept on the room (set_mix_balance), invalidates the
renders, reaches every client, survives a reload, and every render of the scene mix (the
premiere video, POST /export, the download and the stems) uses it. At 50 the mix is unchanged.
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
        self.room = self._room()

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
        with mock.patch.object(audio_processor, "export_dub_video", side_effect=lambda *a, **k: seen.append(k)):
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as ws:
                self._join(ws, "Host")
                ws.send_json({"type": "launch_premiere", "payload": {}})
                for _ in range(40):
                    if ws.receive_json().get("type") == "warp_to_screening":
                        break
        self.assertEqual([k.get("mix_balance") for k in seen], [70])

    def test_download_and_stems_use_it(self):
        self.room.master_mix_balance = 65

        def write(*args, **kwargs):
            path = kwargs.get("output_zip_path") or args[2]
            with open(path, "wb") as f:
                f.write(b"PK")
            return path

        exports = os.path.join(self.cache, "exports")
        os.makedirs(exports, exist_ok=True)
        with mock.patch("dubmate.common._exports_dir", exports), \
                mock.patch.object(audio_processor, "export_dub_video", side_effect=write) as render, \
                mock.patch.object(audio_processor, "build_stems_zip", side_effect=write) as stems:
            self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}/export/download").status_code, 200)
            self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}/export/stems?user_id={HOST}").status_code, 200)
        self.assertEqual(render.call_args.kwargs.get("mix_balance"), 65)
        self.assertEqual(stems.call_args.kwargs.get("mix_balance"), 65)


if __name__ == "__main__":
    unittest.main()
