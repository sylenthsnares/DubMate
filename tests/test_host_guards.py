# -*- coding: utf-8 -*-
"""
test_host_guards.py
Only the host moves the whole room or renders on the host's computer: the room socket's
set_status and set_dialogue_presence, and POST /export, GET /export/stems and
GET /export/project_zip. A member gets a plain refusal and nothing changes. In a solo room
(host_id "host") everyone counts as host, as for assign_role.
"""

import os
import unittest
from unittest import mock

import sys as _sys
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_sys.path.insert(0, os.path.dirname(_TESTS_DIR))
_sys.path.insert(0, _TESTS_DIR)

from fastapi.testclient import TestClient

import audio_processor
from app import app
from test_security_hardening import _barrier
from test_take_model import RoomCase

HOST = "hostT"
MEMBER = "member1"


class HostGuardCase(RoomCase):

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


class TestSocketGuards(HostGuardCase):

    def test_member_cannot_move_the_room(self):
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Host")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
                self._join(ws, "Member")
                ws.send_json({"type": "set_status", "payload": {"status": "screening"}})
                frames = self._frames_until_pong(ws)
                self.assertEqual(self.room.status, "lobby")
                errors = [f for f in frames if f.get("type") == "error"]
                self.assertEqual(len(errors), 1, frames)
                self.assertIn("Only the host", errors[0]["payload"]["message"])
                self.assertFalse(any(f.get("type") == "status_changed" for f in frames))

                host_ws.send_json({"type": "set_status", "payload": {"status": "recording"}})
                _barrier(host_ws)
                self.assertEqual(self.room.status, "recording")

    def test_member_cannot_change_the_dialogue_level(self):
        self.room.exported_video_path = os.path.join(self.cache, "kept.mp4")
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Host")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
                self._join(ws, "Member")
                ws.send_json({"type": "set_dialogue_presence", "payload": {"presence_db": 6}})
                frames = self._frames_until_pong(ws)
                self.assertEqual(self.room.master_dialogue_presence_db, 0.0)
                self.assertIsNotNone(self.room.exported_video_path, "a member threw away the host's export")
                self.assertTrue(any(f.get("type") == "error" for f in frames), frames)

                host_ws.send_json({"type": "set_dialogue_presence", "payload": {"presence_db": 6}})
                _barrier(host_ws)
                self.assertEqual(self.room.master_dialogue_presence_db, 6.0)
                self.assertIsNone(self.room.exported_video_path)

    def test_member_still_sets_their_own_status(self):
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{HOST}") as host_ws:
            self._join(host_ws, "Host")
            _barrier(host_ws)
            with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
                self._join(ws, "Member")
                ws.send_json({"type": "set_user_status", "payload": {"is_ready": True, "location": "booth"}})
                _barrier(ws)
                self.assertTrue(self.room.users[MEMBER]["is_ready"])
                self.assertEqual(self.room.users[MEMBER]["location"], "booth")

    def test_solo_room_everyone_is_host(self):
        self.room.host_id = "host"
        with self.client.websocket_connect(f"/ws/{self.ROOM}/{MEMBER}") as ws:
            ws.send_json({"type": "set_status", "payload": {"status": "recording"}})
            _barrier(ws)
        self.assertEqual(self.room.status, "recording")


class TestExportGuards(HostGuardCase):

    def _url(self, path, user_id):
        return f"/api/rooms/{self.ROOM}/{path}?user_id={user_id}"

    def test_member_cannot_start_a_render(self):
        with mock.patch.object(audio_processor, "export_dub_video") as render:
            res = self.client.post(self._url("export", MEMBER))
            self.assertEqual(res.status_code, 403, res.text)
            self.assertIn("Only the host", res.json()["detail"])
            res = self.client.post(f"/api/rooms/{self.ROOM}/export")
            self.assertEqual(res.status_code, 403, res.text)
            render.assert_not_called()
        self.assertNotIn("16:9", self.room.export_status)

    def test_host_starts_a_render(self):
        with mock.patch.object(audio_processor, "export_dub_video"):
            res = self.client.post(self._url("export", HOST))
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "processing")

    def test_member_cannot_get_stems_or_project_files(self):
        with mock.patch.object(audio_processor, "build_stems_zip") as stems, \
                mock.patch.object(audio_processor, "build_project_zip") as project:
            for path in ("export/stems", "export/project_zip"):
                res = self.client.get(self._url(path, MEMBER))
                self.assertEqual(res.status_code, 403, f"{path}: {res.text}")
                self.assertIn("Only the host", res.json()["detail"])
            stems.assert_not_called()
            project.assert_not_called()
        self.assertNotIn("stems", self.room.export_status)

    def test_host_gets_stems_and_project_files(self):
        def write(**kwargs):
            path = kwargs["output_zip_path"]
            with open(path, "wb") as f:
                f.write(b"PK")
            return path

        exports = os.path.join(self.cache, "exports")
        os.makedirs(exports, exist_ok=True)
        with mock.patch("dubmate.common._exports_dir", exports), \
                mock.patch.object(audio_processor, "build_stems_zip", side_effect=write), \
                mock.patch.object(audio_processor, "build_project_zip", side_effect=write):
            for path in ("export/stems", "export/project_zip"):
                res = self.client.get(self._url(path, HOST))
                self.assertEqual(res.status_code, 200, f"{path}: {res.text}")


if __name__ == "__main__":
    unittest.main()
