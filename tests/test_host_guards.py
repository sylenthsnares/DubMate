# -*- coding: utf-8 -*-
"""
test_host_guards.py
Only the host moves the whole room or renders on the host's computer: the room socket's
set_status and set_dialogue_presence, and POST /export, GET /export/stems and
GET /export/project_zip. A member gets a plain refusal and nothing changes. In a solo room
(host_id "host") everyone counts as host, as for assign_role. GET /export/download only
serves a saved video and never renders one, for anyone; POST /export/reveal (Show in
folder) is the host's, on the engine's own computer.
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
from dubmate import rooms_api
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

    def test_download_never_renders(self):
        with mock.patch.object(audio_processor, "export_dub_video") as render:
            for user_id in (MEMBER, HOST):
                res = self.client.get(f"/api/rooms/{self.ROOM}/export/download?aspect_ratio=9:16&user_id={user_id}")
                self.assertEqual(res.status_code, 409, res.text)
                self.assertEqual(res.json()["detail"], "The host hasn't saved this video yet.")
            self.room.export_status["16:9"] = "processing"
            res = self.client.get(f"/api/rooms/{self.ROOM}/export/download?user_id={MEMBER}")
            self.assertEqual(res.status_code, 409, res.text)
            self.assertEqual(res.json()["detail"], "Export still rendering")
            render.assert_not_called()
        self.assertNotIn("9:16", self.room.export_status)

    def test_member_downloads_a_saved_video(self):
        exports = os.path.join(self.cache, "exports")
        os.makedirs(exports, exist_ok=True)
        with mock.patch("dubmate.common._exports_dir", exports):
            path = self.room.export_out_path("16:9")
            with open(path, "wb") as f:
                f.write(b"\0" * 2048)
            self.room.exported_video_path = path
            res = self.client.get(f"/api/rooms/{self.ROOM}/export/download?user_id={MEMBER}")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.headers["content-type"], "video/mp4")


class TestReveal(HostGuardCase):
    """POST /export/reveal opens the file manager on a saved export: host only, on the
    engine's own computer, and only on a path the room itself knows."""

    def setUp(self):
        super().setUp()
        self.local = TestClient(app, base_url="http://127.0.0.1:8000")
        self.exports = os.path.join(self.cache, "exports")
        os.makedirs(self.exports, exist_ok=True)
        for patcher in (mock.patch("dubmate.common._exports_dir", self.exports),
                        mock.patch.object(rooms_api, "reveal_in_file_manager")):
            self.opener = patcher.start()
            self.addCleanup(patcher.stop)

    def _reveal(self, client, status, **body):
        res = client.post(f"/api/rooms/{self.ROOM}/export/reveal", json=body)
        self.assertEqual(res.status_code, status, res.text)
        return res

    def _save_video(self):
        path = self.room.export_out_path("16:9")
        with open(path, "wb") as f:
            f.write(b"\0" * 2048)
        self.room.exported_video_path = path
        return path

    def test_shows_the_rooms_own_video(self):
        path = self._save_video()
        self._reveal(self.local, 200, kind="video", aspect_ratio="16:9", user_id=HOST)
        self.opener.assert_called_once_with(path)

    def test_shows_the_separate_tracks_and_the_project(self):
        for kind, name in (("stems", f"DubMate_Stems_{self.pack.pack_id}_{self.ROOM}.zip"),
                           ("project", f"DubMate_Project_{self.pack.pack_id}_{self.ROOM}.zip")):
            path = os.path.join(self.exports, name)
            with open(path, "wb") as f:
                f.write(b"PK")
            self._reveal(self.local, 200, kind=kind, user_id=HOST)
            self.assertEqual(self.opener.call_args.args, (path,))

    def test_lan_and_tunnel_callers_are_refused(self):
        self._save_video()
        lan = TestClient(app, base_url="http://192.168.1.20:8000")
        self._reveal(lan, 403, kind="video", aspect_ratio="16:9", user_id=HOST)
        res = self.local.post(f"/api/rooms/{self.ROOM}/export/reveal", headers={"cf-ray": "abc"},
                              json={"kind": "video", "user_id": HOST})
        self.assertEqual(res.status_code, 403, res.text)
        self.opener.assert_not_called()

    def test_member_is_refused(self):
        self._save_video()
        res = self._reveal(self.local, 403, kind="video", aspect_ratio="16:9", user_id=MEMBER)
        self.assertIn("Only the host", res.json()["detail"])
        self.opener.assert_not_called()

    def test_missing_file_is_404(self):
        self._reveal(self.local, 404, kind="video", aspect_ratio="9:16", user_id=HOST)
        self._reveal(self.local, 404, kind="stems", user_id=HOST)
        self._reveal(self.local, 400, kind="../secrets", user_id=HOST)
        self.opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
