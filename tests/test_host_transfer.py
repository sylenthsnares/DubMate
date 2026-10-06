from fastapi.testclient import TestClient
# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from app import app
from dubmate.common import read_version
from dubmate.packs_cache import get_packs_registry

def test_health_endpoint():
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["version"] == read_version()
    print(f"[PASS] /health returned version={data['version']}")

def test_create_room():
    client = TestClient(app)
    packs = get_packs_registry()
    assert packs, 'fixture packs missing: run scripts/make_test_packs.py'
    pack_id = list(packs.keys())[0]

    resp = client.post("/api/rooms", json={
        "pack_id": pack_id,
        "host_name": "HostActor",
        "host_color": "#7c5cff",
    })
    assert resp.status_code == 200
    data = resp.json()
    room_id = data["room_id"]
    assert data["state"]["room_id"] == room_id
    print(f"[PASS] /api/rooms initialized room {room_id}")

if __name__ == "__main__":
    test_health_endpoint()
    test_create_room()
    print("\n[SUCCESS] ALL HEALTH & ROOM CREATION TESTS PASSED 100%!")
