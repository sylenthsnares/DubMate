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

import pack_loader
from app import app
from dubmate import common, rooms
from dubmate.common import safe_join, require_safe_identifier
from dubmate.packs_cache import get_packs_registry

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
        self.assertTrue(packs, 'fixture packs missing: run scripts/make_test_packs.py')
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

    def test_macosx_named_executables_are_rejected(self):
        # Validation used to skip any name merely containing '__macosx' while extraction
        # only skipped case-sensitive '__MACOSX', so these were extracted unchecked.
        for name in ("__macosx/evil.exe", "x__macosx.exe"):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                z.writestr("MyPack/dub_video.mp4", b"\x00" * 64)
                z.writestr("MyPack/01_Hero_1-000.wav", b"\x00" * 64)
                z.writestr(name, b"MZ payload")
            with self.assertRaises(
                pack_loader.PackSecurityError, msg=f"{name!r} should be rejected"
            ):
                pack_loader.import_pack_archive(buf.getvalue())


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
    """Host-only actions (and the host seat itself) must not be reachable by a guest."""

    def _make_room(self, client):
        packs = get_packs_registry()
        self.assertTrue(packs, 'fixture packs missing: run scripts/make_test_packs.py')
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
        """A guest joining a room with a live host must not take over the host seat."""
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

                room = rooms.ROOMS.get(room_id.upper())
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
            room = rooms.ROOMS.get(room_id.upper())
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


class TestConfigLocalOnly(unittest.TestCase):
    """POST /api/config must refuse requests that came through the Cloudflare tunnel."""

    def setUp(self):
        import tempfile
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.target = tempfile.mkdtemp(prefix="dm_cfg_")
        self.orig_config = pack_loader.load_config()
        self.orig_exports = common.exports_dir()

    def tearDown(self):
        import shutil
        pack_loader.save_config(self.orig_config)
        common._exports_dir = self.orig_exports
        shutil.rmtree(self.target, ignore_errors=True)

    def test_tunnel_request_is_rejected_and_config_unchanged(self):
        for header in ({"Cf-Connecting-Ip": "1.2.3.4"}, {"Cf-Ray": "abc123-LHR"}):
            resp = self.client.post("/api/config", json={"exports_dir": self.target}, headers=header)
            self.assertEqual(resp.status_code, 403, header)
            self.assertEqual(pack_loader.load_config(), self.orig_config)
            self.assertEqual(common.exports_dir(), self.orig_exports)

    def test_local_request_behaves_as_before(self):
        resp = self.client.post("/api/config", json={})
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post("/api/config", json={"exports_dir": self.target})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(pack_loader.load_config().get("exports_dir"), self.target)

    def test_lan_request_is_rejected_and_config_unchanged(self):
        lan = TestClient(app, base_url="http://192.168.1.5:8000")
        resp = lan.post("/api/config", json={"exports_dir": self.target})
        self.assertEqual(resp.status_code, 403, resp.text)
        self.assertEqual(pack_loader.load_config(), self.orig_config)
        self.assertEqual(common.exports_dir(), self.orig_exports)


_PRIVATE_CONFIG_KEYS = ("packs_dir", "default_packs_dir", "scanned_paths", "config_file",
                        "exports_dir", "cache_dir", "install_root", "mic_sync")


class TestConfigPrivacy(unittest.TestCase):
    """GET /api/config and /api/packs/rescan keep the host's folders off other computers."""

    LOCAL = "http://127.0.0.1:8000"

    def _remote_calls(self):
        """(label, client, headers) for every kind of caller that isn't this computer."""
        local = TestClient(app, base_url=self.LOCAL)
        return [
            ("testserver host", TestClient(app), {}),
            ("cf-ray", local, {"Cf-Ray": "abc123-LHR"}),
            ("cf-connecting-ip", local, {"Cf-Connecting-Ip": "1.2.3.4"}),
            ("lan host", TestClient(app, base_url="http://192.168.1.5:8000"), {}),
            ("foreign origin", local, {"Origin": "https://evil.example"}),
        ]

    def test_remote_get_config_has_packs_but_no_paths(self):
        for label, client, headers in self._remote_calls():
            resp = client.get("/api/config", headers=headers)
            self.assertEqual(resp.status_code, 200, label)
            data = resp.json()
            for key in _PRIVATE_CONFIG_KEYS:
                self.assertNotIn(key, data, f"{label}: {key} leaked")
            self.assertEqual(data["status"], "ok", label)
            self.assertIsInstance(data["packs"], list, label)
            self.assertEqual(data["pack_count"], len(data["packs"]), label)

    def test_local_get_config_is_complete(self):
        data = TestClient(app, base_url=self.LOCAL).get("/api/config").json()
        for key in _PRIVATE_CONFIG_KEYS:
            self.assertIn(key, data, key)
        self.assertIn("packs", data)
        self.assertIn("pack_count", data)

    def test_rescan_hides_scanned_paths_from_remote_callers(self):
        for method in ("get", "post"):
            for label, client, headers in self._remote_calls():
                resp = getattr(client, method)("/api/packs/rescan", headers=headers)
                self.assertEqual(resp.status_code, 200, (method, label))
                self.assertEqual(resp.json()["scanned_paths"], [], (method, label))
            local = getattr(TestClient(app, base_url=self.LOCAL), method)("/api/packs/rescan").json()
            expected = [os.path.abspath(d) for d in pack_loader.PACKS_DIRS if os.path.exists(d)]
            self.assertEqual(local["scanned_paths"], expected, method)


if __name__ == "__main__":
    unittest.main(verbosity=2)
