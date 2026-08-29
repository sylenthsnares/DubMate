# -*- coding: utf-8 -*-
"""
test_security_hardening.py
Regression tests for the security fixes in app.py and pack_loader.py:
path traversal, identifier validation, WebSocket authorization, the ZIP
extension allowlist, and CORS credential handling.
"""
import io
import os
import unittest
import zipfile

from fastapi import HTTPException
from fastapi.testclient import TestClient

# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import app as app_module
import pack_loader
from app import app, safe_join, require_safe_identifier, get_packs_registry

PROJECT_ROOT = _sys.path[0]


def _barrier(ws, max_frames: int = 40):
    """
    Waits until the server has processed everything sent so far on this socket.
    WebSocket delivery is ordered per connection, so once the pong for a ping sent
    after message X arrives, X has already been handled.
    """
    ws.send_json({"type": "ping", "payload": {}})
    for _ in range(max_frames):
        frame = ws.receive_json()
        if frame.get("type") == "pong":
            return
    raise AssertionError("no pong received; server did not acknowledge")


class TestPathTraversal(unittest.TestCase):
    """safe_join must contain every fragment, on Windows separators too."""

    def setUp(self):
        import tempfile
        self.base = tempfile.mkdtemp(prefix="dm_sec_")
        os.makedirs(os.path.join(self.base, "sub"), exist_ok=True)
        with open(os.path.join(self.base, "sub", "ok.wav"), "w") as f:
            f.write("x")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.base, ignore_errors=True)

    def test_allows_contained_paths(self):
        self.assertTrue(safe_join(self.base, "sub/ok.wav").endswith("ok.wav"))
        # Interior '..' that still resolves inside the base is fine.
        self.assertTrue(safe_join(self.base, "sub/../sub/ok.wav").endswith("ok.wav"))

    def test_blocks_forward_slash_traversal(self):
        with self.assertRaises(HTTPException):
            safe_join(self.base, "../../SECRET.txt")

    def test_blocks_backslash_traversal(self):
        # Backslash is a path separator on Windows but NOT a URL separator, so it
        # survives inside a single route segment. This was the live bypass.
        with self.assertRaises(HTTPException):
            safe_join(self.base, "..\\..\\SECRET.txt")

    def test_blocks_absolute_escape(self):
        with self.assertRaises(HTTPException):
            safe_join(self.base, os.path.join(os.path.dirname(self.base), "elsewhere.txt"))


class TestIdentifierValidation(unittest.TestCase):
    """user_id becomes a filename component, so it must be a plain token."""

    def test_accepts_normal_ids(self):
        for good in ("user-42", "abc_DEF", "0123456789"):
            self.assertEqual(require_safe_identifier(good), good)

    def test_rejects_traversal_and_separators(self):
        for bad in ("../../../evil", "a/b", "a\\b", "", "x" * 65, "a b"):
            with self.assertRaises(HTTPException, msg=f"should reject {bad!r}"):
                require_safe_identifier(bad)


class TestPackAudioEndpointTraversal(unittest.TestCase):
    def test_traversal_filename_is_rejected(self):
        client = TestClient(app)
        packs = get_packs_registry()
        if not packs:
            self.skipTest("no packs in registry")
        pack_id = list(packs.keys())[0]
        for payload in ("..%5C..%5Capp.py", "..%2F..%2Fapp.py"):
            resp = client.get(f"/api/packs/{pack_id}/audio/{payload}")
            self.assertIn(
                resp.status_code, (400, 404),
                f"{payload} returned {resp.status_code}; must not serve the file",
            )


class TestZipExtensionAllowlist(unittest.TestCase):
    """Extension-less entries previously bypassed BOTH allow and block lists."""

    def _archive_with(self, name: str) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("MyPack/dub_video.mp4", b"\x00" * 64)
            z.writestr("MyPack/01_Hero_1-000.wav", b"\x00" * 64)
            z.writestr(f"MyPack/{name}", b"#!/bin/sh\necho pwned\n")
        return buf.getvalue()

    def test_extensionless_file_is_rejected(self):
        import tempfile
        for name in ("payload", ".hidden"):
            data = self._archive_with(name)
            tmp = tempfile.mktemp(suffix=".zip")
            with open(tmp, "wb") as f:
                f.write(data)
            try:
                with self.assertRaises(
                    pack_loader.PackSecurityError, msg=f"{name!r} should be rejected"
                ):
                    pack_loader.import_pack_archive(tmp)
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)


class TestCorsConfiguration(unittest.TestCase):
    def test_wildcard_origin_does_not_allow_credentials(self):
        # "*" + credentials makes Starlette echo the caller's Origin, defeating CORS.
        client = TestClient(app)
        resp = client.get("/health", headers={"Origin": "https://evil.example"})
        self.assertNotEqual(
            resp.headers.get("access-control-allow-credentials"), "true",
            "credentials must not be allowed while origins are wildcarded",
        )


class TestWebSocketAuthorization(unittest.TestCase):
    """claim_host and assign_role were callable by any connected participant."""

    def _make_room(self, client):
        packs = get_packs_registry()
        if not packs:
            self.skipTest("no packs in registry")
        pack_id = list(packs.keys())[0]
        resp = client.post("/api/rooms", json={
            "pack_id": pack_id,
            "host_name": "HostA",
            "host_color": "#7c5cff",
            "app_version": "1.0.0",
        })
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_guest_cannot_steal_active_host(self):
        client = TestClient(app)
        data = self._make_room(client)
        room_id = data["room_id"]
        host_id = data["state"]["host_id"]

        with client.websocket_connect(f"/ws/{room_id}/{host_id}") as host_ws:
            host_ws.send_json({"type": "join", "payload": {
                "name": "HostA", "color": "#7c5cff", "app_version": "1.0.0"}})
            with client.websocket_connect(f"/ws/{room_id}/intruder") as guest_ws:
                guest_ws.send_json({"type": "join", "payload": {
                    "name": "Guest", "color": "#ff0000", "app_version": "1.0.0"}})
                guest_ws.send_json({"type": "claim_host", "payload": {}})

                room = app_module.ROOMS.get(room_id.upper())
                self.assertIsNotNone(room)
                _barrier(guest_ws)
                self.assertEqual(
                    room.host_id, host_id,
                    "an unauthorized client took over the room host",
                )

    def test_guest_cannot_assign_roles(self):
        client = TestClient(app)
        data = self._make_room(client)
        room_id = data["room_id"]
        host_id = data["state"]["host_id"]

        with client.websocket_connect(f"/ws/{room_id}/{host_id}") as host_ws:
            host_ws.send_json({"type": "join", "payload": {
                "name": "HostA", "color": "#7c5cff", "app_version": "1.0.0"}})
            room = app_module.ROOMS.get(room_id.upper())
            if not room or not room.role_assignments:
                self.skipTest("pack has no characters to assign")
            character = list(room.role_assignments.keys())[0]

            with client.websocket_connect(f"/ws/{room_id}/intruder") as guest_ws:
                guest_ws.send_json({"type": "join", "payload": {
                    "name": "Guest", "color": "#ff0000", "app_version": "1.0.0"}})
                guest_ws.send_json({"type": "assign_role", "payload": {
                    "character": character, "user_ids": ["intruder"]}})
                _barrier(guest_ws)
                self.assertNotIn(
                    "intruder", room.role_assignments.get(character, []),
                    "an unauthorized client reassigned a character role",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
