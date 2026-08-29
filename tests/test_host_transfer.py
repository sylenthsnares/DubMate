import asyncio
import json
from fastapi.testclient import TestClient
# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from app import app, is_version_outdated, read_version, ROOMS, Room, get_packs_registry

def test_version_helper():
    assert is_version_outdated("1.0.0", "1.1.0") is True
    assert is_version_outdated("1.0.9", "1.1.0") is True
    assert is_version_outdated("1.2.0", "1.1.0") is False
    assert is_version_outdated("v1.0.0", "1.0.0") is False
    assert is_version_outdated("2.0.0", "1.9.9") is False
    print("[PASS] is_version_outdated helper")

def test_health_endpoint():
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["version"] == read_version()
    print(f"[PASS] /health returned version={data['version']}")

def test_create_room_with_version():
    client = TestClient(app)
    packs = get_packs_registry()
    if not packs:
        print("[SKIP] No packs in registry")
        return
    pack_id = list(packs.keys())[0]

    resp = client.post("/api/rooms", json={
        "pack_id": pack_id,
        "host_name": "HostActor",
        "host_color": "#7c5cff",
        "app_version": "1.4.0"
    })
    assert resp.status_code == 200
    data = resp.json()
    room_id = data["room_id"]
    state = data["state"]
    assert state["min_required_version"] == "1.4.0"
    print(f"[PASS] /api/rooms initialized room {room_id} with min_required_version 1.4.0")

def test_websocket_version_gate_and_host_transfer():
    client = TestClient(app)
    packs = get_packs_registry()
    if not packs:
        return
    pack_id = list(packs.keys())[0]

    # Create room
    resp = client.post("/api/rooms", json={
        "pack_id": pack_id,
        "host_name": "HostA",
        "host_color": "#7c5cff",
        "app_version": "1.2.0"
    })
    data = resp.json()
    room_id = data["room_id"]
    host_id = data["user_id"]

    # 1. Test outdated guest connection
    with client.websocket_connect(f"/ws/{room_id}/guest_outdated") as ws_old:
        msg_conn = json.loads(ws_old.receive_text())
        assert msg_conn["type"] == "user_connected"
        ws_old.send_text(json.dumps({
            "type": "join",
            "payload": {"name": "OutdatedGuest", "color": "#ff0000", "app_version": "1.0.0"}
        }))
        msg = json.loads(ws_old.receive_text())
        assert msg["type"] == "version_mismatch"
        assert msg["payload"]["required"] == "1.2.0"
        print("[PASS] Outdated guest rejected with version_mismatch")

    # 2. Test valid guest connection and host transfer
    def recv_until(ws, target_type):
        for _ in range(10):
            raw = ws.receive_text()
            data = json.loads(raw)
            if data.get("type") == target_type:
                return data
        raise TimeoutError(f"Did not receive message type {target_type}")

    with client.websocket_connect(f"/ws/{room_id}/{host_id}") as ws_host:
        ws_host.send_text(json.dumps({
            "type": "join",
            "payload": {"name": "HostA", "color": "#7c5cff", "app_version": "1.2.0"}
        }))

        with client.websocket_connect(f"/ws/{room_id}/guest_valid") as ws_guest:
            ws_guest.send_text(json.dumps({
                "type": "join",
                "payload": {"name": "ActorB", "color": "#00ff00", "app_version": "1.2.0"}
            }))

            # Host initiates transfer to ActorB
            ws_host.send_text(json.dumps({
                "type": "initiate_transfer",
                "payload": {"target_user_id": "guest_valid"}
            }))
            transfer_pending = recv_until(ws_guest, "host_transfer_pending")
            assert transfer_pending["payload"]["new_host_id"] == "guest_valid"
            assert transfer_pending["payload"]["new_host_name"] == "ActorB"
            print("[PASS] Host transfer pending broadcasted to guest")

            # ActorB completes transfer with new tunnel URL
            ws_guest.send_text(json.dumps({
                "type": "complete_transfer",
                "payload": {
                    "new_tunnel_url": "https://new-host.trycloudflare.com",
                    "new_room_id": "DUB-NEW1"
                }
            }))
            transfer_confirmed = recv_until(ws_host, "host_transfer_confirmed")
            assert transfer_confirmed["payload"]["new_host_id"] == "guest_valid"
            assert transfer_confirmed["payload"]["new_tunnel_url"] == "https://new-host.trycloudflare.com"
            print("[PASS] Host transfer confirmed broadcasted to room")

if __name__ == "__main__":
    test_version_helper()
    test_health_endpoint()
    test_create_room_with_version()
    test_websocket_version_gate_and_host_transfer()
    print("\n[SUCCESS] ALL HOST TRANSFER & VERSION GATE TESTS PASSED 100%!")
