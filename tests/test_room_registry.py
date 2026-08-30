# -*- coding: utf-8 -*-
"""
test_room_registry.py
Covers publishing room codes to the public registry.

The regression these guard: registration used to be gated on ACTIVE_TUNNEL_URL at
the instant the room was created. The desktop app opens the studio as soon as the
engine answers /health and starts cloudflared only afterwards, so a room created in
the first few seconds was never published and never retried -- the host saw a code
that resolved for nobody.

A stub registry stands in for the Cloudflare worker so the tests exercise the real
httpx path, including the per-room ownership token, without touching production.
"""

import json
import os as _os
import sys as _sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi.testclient import TestClient

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import app as dubmate
from app import app, get_packs_registry

STUB_SECRET = "test-registry-key"


class StubRegistry:
    """Minimal stand-in for worker/src/index.ts POST /rooms/create."""

    def __init__(self, require_key: bool = True):
        self.kv = {}
        self.require_key = require_key
        self.reject_all = False
        self.requests = []
        self._server = None
        self._thread = None

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address
        return f"http://127.0.0.1:{port}"

    def start(self):
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass  # keep test output readable

            def _send(self, status, payload):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                if self.path != "/rooms/create":
                    self._send(404, {"error": "not found"})
                    return

                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                stub.requests.append(body)

                if stub.reject_all:
                    self._send(500, {"error": "stub failure"})
                    return

                if stub.require_key and self.headers.get("X-DubMate-Key") != STUB_SECRET:
                    self._send(401, {"error": "Unauthorized"})
                    return

                code = (body.get("code") or "").upper()
                existing = stub.kv.get(code)
                if existing:
                    auth = self.headers.get("Authorization") or ""
                    token = auth[7:].strip() if auth.startswith("Bearer ") else ""
                    if token != existing["room_token"]:
                        self._send(409, {"error": "Room code already registered"})
                        return
                    room_token = existing["room_token"]
                else:
                    room_token = f"token-for-{code}"

                stub.kv[code] = {
                    "tunnel_url": body.get("tunnel_url"),
                    "room_token": room_token,
                    "app_version": body.get("app_version"),
                }
                self._send(200 if existing else 201, {"code": code, "room_token": room_token})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()


def _reset_registry_state():
    dubmate.ACTIVE_TUNNEL_URL = None
    dubmate.WORKER_ROOM_TOKENS.clear()
    dubmate.WORKER_PENDING_ROOMS.clear()
    dubmate.WORKER_PUBLISHED_TUNNEL.clear()
    dubmate.WORKER_PUBLISHED_AT.clear()
    dubmate.WORKER_ROOM_STATUS.clear()
    dubmate.ROOMS.clear()


def _first_pack_id():
    packs = get_packs_registry()
    return list(packs.keys())[0] if packs else None


def _wait_for_share(client, code, predicate, timeout=8.0):
    """Polls the share endpoint until `predicate` holds; publishing is asynchronous."""
    deadline = time.time() + timeout
    share = None
    while time.time() < deadline:
        resp = client.get(f"/api/rooms/{code}/share")
        assert resp.status_code == 200
        share = resp.json()
        if predicate(share):
            return share
        time.sleep(0.15)
    return share


def _create_room(client, pack_id):
    resp = client.post("/api/rooms", json={
        "pack_id": pack_id,
        "host_name": "HostActor",
        "host_color": "#7c5cff",
        "app_version": "1.0.9",
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_room_created_before_tunnel_is_published_when_tunnel_arrives():
    """The core regression: room first, tunnel second, code still ends up live."""
    pack_id = _first_pack_id()
    if not pack_id:
        print("[SKIP] No packs in registry")
        return

    stub = StubRegistry().start()
    original_base, original_key = dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY
    try:
        _reset_registry_state()
        dubmate.WORKER_REGISTRY_BASE = stub.base_url
        dubmate.WORKER_API_KEY = STUB_SECRET

        with TestClient(app) as client:
            created = _create_room(client, pack_id)
            code = created["room_id"]

            # No tunnel yet, so nothing can be published -- but the room must be
            # queued and must say so rather than pretending the code works.
            assert created["share"]["code_is_live"] is False
            assert created["share"]["state"] == "waiting"
            assert stub.kv == {}, "nothing should reach the registry without a tunnel"
            assert code.upper() in dubmate.WORKER_PENDING_ROOMS

            tunnel = "https://late-tunnel.trycloudflare.com"
            resp = client.post("/api/tunnel", json={"tunnel_url": tunnel})
            assert resp.status_code == 200

            share = _wait_for_share(client, code, lambda s: s["code_is_live"])
            assert share["code_is_live"] is True, share
            assert share["join_url"].endswith(f"/join/{code.upper()}")
            assert stub.kv[code.upper()]["tunnel_url"] == tunnel
            print(f"[PASS] room {code} published after the tunnel came up")
    finally:
        dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY = original_base, original_key
        stub.stop()
        _reset_registry_state()


def test_room_created_after_tunnel_publishes_immediately():
    pack_id = _first_pack_id()
    if not pack_id:
        print("[SKIP] No packs in registry")
        return

    stub = StubRegistry().start()
    original_base, original_key = dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY
    try:
        _reset_registry_state()
        dubmate.WORKER_REGISTRY_BASE = stub.base_url
        dubmate.WORKER_API_KEY = STUB_SECRET

        with TestClient(app) as client:
            tunnel = "https://early-tunnel.trycloudflare.com"
            client.post("/api/tunnel", json={"tunnel_url": tunnel})

            code = _create_room(client, pack_id)["room_id"]
            share = _wait_for_share(client, code, lambda s: s["code_is_live"])
            assert share["code_is_live"] is True, share
            assert stub.kv[code.upper()]["tunnel_url"] == tunnel
            print(f"[PASS] room {code} published immediately when the tunnel was already up")
    finally:
        dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY = original_base, original_key
        stub.stop()
        _reset_registry_state()


def test_new_tunnel_url_republishes_with_owner_token():
    """cloudflared quick tunnels change hostname on reconnect; the code must follow."""
    pack_id = _first_pack_id()
    if not pack_id:
        print("[SKIP] No packs in registry")
        return

    stub = StubRegistry().start()
    original_base, original_key = dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY
    try:
        _reset_registry_state()
        dubmate.WORKER_REGISTRY_BASE = stub.base_url
        dubmate.WORKER_API_KEY = STUB_SECRET

        with TestClient(app) as client:
            client.post("/api/tunnel", json={"tunnel_url": "https://first.trycloudflare.com"})
            code = _create_room(client, pack_id)["room_id"]
            _wait_for_share(client, code, lambda s: s["code_is_live"])

            client.post("/api/tunnel", json={"tunnel_url": "https://second.trycloudflare.com"})
            share = _wait_for_share(
                client, code,
                lambda s: s["code_is_live"] and s["tunnel_url"] == "https://second.trycloudflare.com",
            )
            assert share["code_is_live"] is True, share
            # The stub 409s an overwrite without the right bearer token, so reaching
            # the new URL also proves the ownership token was replayed.
            assert stub.kv[code.upper()]["tunnel_url"] == "https://second.trycloudflare.com"
            print(f"[PASS] room {code} followed the tunnel to a new hostname")
    finally:
        dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY = original_base, original_key
        stub.stop()
        _reset_registry_state()


def test_rejected_key_is_reported_with_a_usable_fallback():
    """A bad registry key must be visible in the UI, not swallowed into a console."""
    pack_id = _first_pack_id()
    if not pack_id:
        print("[SKIP] No packs in registry")
        return

    stub = StubRegistry().start()
    original_base, original_key = dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY
    try:
        _reset_registry_state()
        dubmate.WORKER_REGISTRY_BASE = stub.base_url
        dubmate.WORKER_API_KEY = "wrong-key"

        with TestClient(app) as client:
            tunnel = "https://unauthorized.trycloudflare.com"
            client.post("/api/tunnel", json={"tunnel_url": tunnel})
            code = _create_room(client, pack_id)["room_id"]

            share = _wait_for_share(client, code, lambda s: s["state"] == "unauthorized")
            assert share["state"] == "unauthorized", share
            assert share["code_is_live"] is False
            assert share["join_url"] == ""
            # The session is still usable via the tunnel, which is what the UI copies.
            assert share["direct_url"] == f"{tunnel}?room={code.upper()}"
            print("[PASS] rejected key surfaces as unauthorized with a direct invite link")
    finally:
        dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY = original_base, original_key
        stub.stop()
        _reset_registry_state()


def test_rejected_key_is_not_retried_until_the_tunnel_changes():
    """The heartbeat runs every 20s; a verdict that cannot change must not be re-asked."""
    pack_id = _first_pack_id()
    if not pack_id:
        print("[SKIP] No packs in registry")
        return

    stub = StubRegistry().start()
    original_base, original_key = dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY
    try:
        _reset_registry_state()
        dubmate.WORKER_REGISTRY_BASE = stub.base_url
        dubmate.WORKER_API_KEY = "wrong-key"

        with TestClient(app) as client:
            client.post("/api/tunnel", json={"tunnel_url": "https://denied.trycloudflare.com"})
            code = _create_room(client, pack_id)["room_id"]
            _wait_for_share(client, code, lambda s: s["state"] == "unauthorized")

            attempts_after_verdict = len(stub.requests)
            # Same tunnel: re-announcing it must not produce another 401 round trip.
            for _ in range(3):
                client.post("/api/tunnel", json={"tunnel_url": "https://denied.trycloudflare.com"})
            time.sleep(0.5)
            assert len(stub.requests) == attempts_after_verdict, "retried a settled rejection"

            # A new tunnel is a genuinely different request, so it is tried again.
            client.post("/api/tunnel", json={"tunnel_url": "https://denied-2.trycloudflare.com"})
            deadline = time.time() + 5
            while time.time() < deadline and len(stub.requests) == attempts_after_verdict:
                time.sleep(0.1)
            assert len(stub.requests) > attempts_after_verdict, "a new tunnel should be retried"
            print("[PASS] settled rejections are not retried, but a new tunnel is")
    finally:
        dubmate.WORKER_REGISTRY_BASE, dubmate.WORKER_API_KEY = original_base, original_key
        stub.stop()
        _reset_registry_state()


def test_share_endpoint_rejects_unknown_room():
    with TestClient(app) as client:
        resp = client.get("/api/rooms/NOSUCH/share")
        assert resp.status_code == 404
    print("[PASS] /api/rooms/{code}/share 404s for a room we do not host")


if __name__ == "__main__":
    test_room_created_before_tunnel_is_published_when_tunnel_arrives()
    test_room_created_after_tunnel_publishes_immediately()
    test_new_tunnel_url_republishes_with_owner_token()
    test_rejected_key_is_reported_with_a_usable_fallback()
    test_rejected_key_is_not_retried_until_the_tunnel_changes()
    test_share_endpoint_rejects_unknown_room()
    print("\n[OK] Room registry suite passed")
