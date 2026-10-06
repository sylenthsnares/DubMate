"""Sessions: saved session details, loading older rooms, safe saves, room codes and the
own-computer guard."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from starlette.requests import Request

import audio_processor
import pack_loader
from dubmate import common, packs_cache, rooms

NEW_KEYS = ("last_active_at", "creator_id", "created_here", "master_dialogue_presence_db")
OLD_MTIME = 1_780_000_000.0

# A room_state.json as saved by the PR #16 build (state_version 2, no session fields).
PR16_STATE = {
    "state_version": 2,
    "room_id": "SSROOM",
    "pack_id": "sessions_pack",
    "host_id": "hostS",
    "users": {
        "hostS": {"id": "hostS", "name": "Host", "color": "#7c5cff", "is_host": True, "is_online": True},
        "guest1": {"id": "guest1", "name": "Ben", "color": "#ff8a00", "is_host": False, "is_online": True},
    },
    "role_assignments": {"Ana": ["hostS"], "Ben": ["guest1"]},
    "takes": {
        "t1000": {"picked": "a1b2c3d4", "next_number": 2, "takes": [{
            "take_id": "a1b2c3d4", "user_name": "Host", "duration": 0.25, "audio_version": 1,
            "noise_reduction": False, "has_raw": True, "number": 1}]},
    },
    "status": "recording",
    "exported_video_path": None,
}


class SessionCase(unittest.TestCase):
    ROOM = "SSROOM"
    PACK_ID = "sessions_pack"

    def setUp(self):
        self.cache = tempfile.mkdtemp(prefix="dm_sessions_")
        self.addCleanup(shutil.rmtree, self.cache, True)
        for patcher in (mock.patch.object(audio_processor, "CACHE_DIR", self.cache),
                        mock.patch.object(packs_cache, "PACKS_CACHE", {})):
            patcher.start()
            self.addCleanup(patcher.stop)
        rooms.ROOMS.clear()
        self.addCleanup(rooms.ROOMS.clear)
        packs_cache.PACKS_CACHE[self.PACK_ID] = self._make_pack()
        self.room_dir = audio_processor.get_room_cache_dir(self.ROOM)
        self.state_file = os.path.join(self.room_dir, "room_state.json")

    def _make_pack(self):
        folder = os.path.join(self.cache, "pack")
        os.makedirs(folder)
        pack = pack_loader.PackInfo(self.PACK_ID, folder, "Sessions Pack")
        pack.characters = ["Ana", "Ben"]
        pack.duration = 8.0
        sr = audio_processor.SR
        for i, (start, char) in enumerate([(1.0, "Ana"), (3.0, "Ben")]):
            fname = f"{i + 1:02d}_{char}_{int(start)}-000.wav"
            tone = (0.2 * np.sin(2 * np.pi * 300 * np.arange(sr // 4) / sr)).astype(np.float32)
            audio_processor.write_wav_mono(os.path.join(folder, fname), tone, sr)
            pack.lines.append({"index": i, "start": start, "end": start + 1.5, "character": char,
                               "filename": fname, "caption": f"Line {i + 1}"})
        pack_loader.assign_line_ids(pack.lines)  # t1000, t3000
        return pack

    def _write_state(self, state, mtime=OLD_MTIME):
        with open(self.state_file, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.utime(self.state_file, (mtime, mtime))

    def _read_state(self):
        with open(self.state_file, "r", encoding="utf-8") as f:
            return json.load(f)


class TestRoomStateCompat(SessionCase):
    def test_pr16_room_loads_with_fallbacks_and_saves_back(self):
        self._write_state(PR16_STATE)
        room = rooms.load_room_folder(self.ROOM)
        self.assertIsNotNone(room)
        self.assertIs(rooms.ROOMS[self.ROOM], room)
        self.assertEqual(room.last_active_at, OLD_MTIME)
        self.assertEqual(room.creator_id, "hostS")
        self.assertIs(room.created_here, True)
        self.assertEqual(room.master_dialogue_presence_db, 0.0)
        self.assertTrue(all(u["is_online"] is False for u in room.users.values()))
        self.assertFalse(room.deleted)

        room._sync_save_to_disk()
        saved = self._read_state()
        for key, value in PR16_STATE.items():
            if key == "users":
                continue
            self.assertEqual(saved[key], value, key)
        expected_users = json.loads(json.dumps(PR16_STATE["users"]))
        for user in expected_users.values():
            user["is_online"] = False
        self.assertEqual(saved["users"], expected_users)
        for key in NEW_KEYS:
            self.assertIn(key, saved)
        self.assertEqual(saved["last_active_at"], OLD_MTIME)
        self.assertEqual(saved["creator_id"], "hostS")
        self.assertIs(saved["created_here"], True)
        self.assertEqual(saved["master_dialogue_presence_db"], 0.0)

    def test_load_persisted_rooms_uses_load_room_folder(self):
        self._write_state(PR16_STATE)
        rooms.load_persisted_rooms()
        self.assertIn(self.ROOM, rooms.ROOMS)
        self.assertEqual(rooms.ROOMS[self.ROOM].last_active_at, OLD_MTIME)

    def test_missing_pack_or_unreadable_file_returns_none(self):
        self._write_state({**PR16_STATE, "pack_id": "gone"})
        self.assertIsNone(rooms.load_room_folder(self.ROOM))
        with open(self.state_file, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertIsNone(rooms.load_room_folder(self.ROOM))
        self.assertNotIn(self.ROOM, rooms.ROOMS)

    def test_v1_room_migrates_and_keeps_pre_migration_mtime(self):
        sr = audio_processor.SR
        tone = (0.2 * np.sin(2 * np.pi * 300 * np.arange(sr // 4) / sr)).astype(np.float32)
        audio_processor.write_wav_mono(os.path.join(self.room_dir, "take_line_0.wav"), tone, sr)
        v1 = {"room_id": self.ROOM, "pack_id": self.PACK_ID, "host_id": "hostS",
              "users": {"hostS": {"id": "hostS", "name": "Host", "color": "#7c5cff",
                                  "is_host": True, "is_online": True}},
              "role_assignments": {"Ana": ["hostS"], "Ben": []},
              "takes": {"0": {"user_name": "Host", "duration": 0.25, "noise_reduction": False}},
              "status": "recording", "exported_video_path": None}
        self._write_state(v1)
        room = rooms.load_room_folder(self.ROOM)
        self.assertIsNotNone(room)
        self.assertEqual(room.takes["t1000"]["picked"], "take1")
        self.assertEqual(room.last_active_at, OLD_MTIME)
        saved = self._read_state()
        self.assertEqual(saved["state_version"], rooms.STATE_VERSION)
        self.assertEqual(saved["last_active_at"], OLD_MTIME)
        # The migration save moved the file's time, but a reload keeps the saved value.
        self.assertNotEqual(os.path.getmtime(self.state_file), OLD_MTIME)
        rooms.ROOMS.clear()
        self.assertEqual(rooms.load_room_folder(self.ROOM).last_active_at, OLD_MTIME)

    def test_presence_round_trips(self):
        room = rooms.Room(self.ROOM, packs_cache.PACKS_CACHE[self.PACK_ID], "hostS", "Host", "#7c5cff")
        room.master_dialogue_presence_db = 4.5
        room.created_here = False
        room._sync_save_to_disk()
        rooms.ROOMS.clear()
        loaded = rooms.load_room_folder(self.ROOM)
        self.assertEqual(loaded.master_dialogue_presence_db, 4.5)
        self.assertIs(loaded.created_here, False)
        self.assertEqual(loaded.last_active_at, room.last_active_at)

    def test_presence_out_of_range_is_clamped(self):
        self._write_state({**PR16_STATE, "master_dialogue_presence_db": 40})
        self.assertEqual(rooms.load_room_folder(self.ROOM).master_dialogue_presence_db, 12.0)

    def test_mark_dirty_sets_last_active(self):
        room = rooms.Room(self.ROOM, packs_cache.PACKS_CACHE[self.PACK_ID], "hostS", "Host", "#7c5cff")
        room.last_active_at = 1.0
        room.mark_dirty()
        self.assertGreater(room.last_active_at, 1.0)

    def test_save_never_stamps_time(self):
        room = rooms.Room(self.ROOM, packs_cache.PACKS_CACHE[self.PACK_ID], "hostS", "Host", "#7c5cff")
        room.last_active_at = 123.0
        room._sync_save_to_disk()
        self.assertEqual(self._read_state()["last_active_at"], 123.0)


class TestDeletedRoomSave(SessionCase):
    def test_deleted_room_does_not_recreate_its_folder(self):
        room = rooms.Room(self.ROOM, packs_cache.PACKS_CACHE[self.PACK_ID], "hostS", "Host", "#7c5cff")
        room._sync_save_to_disk()
        self.assertTrue(os.path.isfile(self.state_file))
        with room._save_lock:
            room.deleted = True
            shutil.rmtree(self.room_dir)
        room._sync_save_to_disk()
        self.assertFalse(os.path.exists(self.room_dir))


def _take_entry(take_id="aa11bb22"):
    return {"picked": take_id, "next_number": 2, "takes": [{
        "take_id": take_id, "user_name": "Host", "duration": 0.25, "audio_version": 1,
        "noise_reduction": False, "has_raw": True, "number": 1}]}


class TestRetention(SessionCase):
    BASE = 1_790_000_000.0

    def _folder(self, room_id, state=None, raw=None, mtime=None):
        folder = audio_processor.get_room_cache_dir(room_id)
        path = os.path.join(folder, "room_state.json")
        if state is not None:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({**PR16_STATE, "room_id": room_id, **state}, f)
        elif raw is not None:
            with open(path, "w", encoding="utf-8") as f:
                f.write(raw)
        if mtime is not None:
            if os.path.exists(path):
                os.utime(path, (mtime, mtime))
            os.utime(folder, (mtime, mtime))
        return folder

    def _exists(self, room_id):
        return os.path.isdir(os.path.join(self.cache, "rooms", room_id))

    def _setup(self):
        shutil.rmtree(self.room_dir)  # setUp's empty folder would be the newest
        takes = {"t1000": _take_entry()}
        for i in range(5):  # REC0 newest .. REC4 oldest of the five
            self._folder(f"REC{i}", {"takes": takes, "last_active_at": self.BASE - i * 100, "created_here": True})
        self._folder("OLDTK", {"takes": takes, "last_active_at": self.BASE - 10_000})
        self._folder("EMPTY", {"takes": {}, "last_active_at": self.BASE + 50})
        self._folder("BROKEN", raw="{not json", mtime=self.BASE + 500)
        self._folder("GUEST", {"takes": takes, "last_active_at": self.BASE + 60, "created_here": False})
        self._folder("LIVE", {"takes": takes, "last_active_at": self.BASE - 20_000, "created_here": False})
        live = rooms.load_room_folder("LIVE")
        live.sockets.add(object())

    def test_summaries(self):
        self._setup()
        os.makedirs(os.path.join(self.cache, "rooms", "NOSTATE"))
        by_id = {s["room_id"]: s for s in rooms.session_summaries()}
        self.assertEqual(len(by_id), 11)
        rec0 = by_id["REC0"]
        self.assertEqual(rec0, {
            "room_id": "REC0", "pack_id": self.PACK_ID, "pack_name": "Sessions Pack", "pack_found": True,
            "recorded_lines": 1, "total_lines": 2, "last_active_at": self.BASE, "status": "recording",
            "readable": True, "listed": True})
        self.assertFalse(by_id["EMPTY"]["listed"])
        self.assertFalse(by_id["GUEST"]["listed"])
        self.assertFalse(by_id["LIVE"]["listed"])  # summarised from memory
        self.assertEqual(by_id["LIVE"]["pack_name"], "Sessions Pack")
        self.assertEqual(by_id["BROKEN"]["readable"], False)
        self.assertEqual(by_id["BROKEN"]["listed"], True)
        self.assertEqual(by_id["BROKEN"]["last_active_at"], self.BASE + 500)
        self.assertFalse(by_id["NOSTATE"]["listed"])

    def test_missing_pack_and_old_files(self):
        self._folder("NOPACK", {"pack_id": "gone_pack", "takes": {"t1000": _take_entry()}})
        os.utime(os.path.join(self.cache, "rooms", "NOPACK", "room_state.json"), (OLD_MTIME, OLD_MTIME))
        v1 = {k: v for k, v in PR16_STATE.items() if k != "state_version"}
        v1["takes"] = {"0": {"user_name": "Host", "duration": 0.25}, "7": {"user_name": "Host"}}
        self._folder("VONE")
        with open(os.path.join(self.cache, "rooms", "VONE", "room_state.json"), "w", encoding="utf-8") as f:
            json.dump(v1, f)
        by_id = {s["room_id"]: s for s in rooms.session_summaries()}
        nopack = by_id["NOPACK"]
        self.assertFalse(nopack["pack_found"])
        self.assertEqual(nopack["pack_name"], "gone_pack")
        self.assertEqual(nopack["last_active_at"], OLD_MTIME)
        self.assertTrue(nopack["listed"])
        self.assertEqual(by_id["VONE"]["recorded_lines"], 1)  # index 7 is not in the scene
        self.assertTrue(by_id["VONE"]["listed"])

    def test_prune_keeps_what_the_card_shows(self):
        self._setup()
        recent = [s["room_id"] for s in rooms.recent_sessions()]
        self.assertEqual(recent, ["BROKEN", "REC0", "REC1", "REC2", "REC3"])
        self._folder("NEWRM")
        from dubmate import room_registry
        for code in ("REC4", "GUEST"):
            room_registry.WORKER_PENDING_ROOMS[code] = "1.0"
            room_registry._set_room_status(code, "waiting", "x")
        self.addCleanup(room_registry.WORKER_PENDING_ROOMS.clear)
        self.addCleanup(room_registry.WORKER_ROOM_STATUS.clear)

        rooms.prune_sessions(keep_room_id="NEWRM")

        for kept in ("NEWRM", "LIVE", "BROKEN", "REC0", "REC1", "REC2", "REC3"):
            self.assertTrue(self._exists(kept), kept)
        for gone in ("REC4", "OLDTK", "EMPTY", "GUEST"):
            self.assertFalse(self._exists(gone), gone)
        for room_id in recent:
            self.assertTrue(self._exists(room_id), room_id)
        self.assertIn("LIVE", rooms.ROOMS)
        for code in ("REC4", "GUEST"):
            self.assertNotIn(code, room_registry.WORKER_PENDING_ROOMS)
            self.assertNotIn(code, room_registry.WORKER_ROOM_STATUS)

    def test_prune_without_keep_room_keeps_newest(self):
        self._setup()
        rooms.prune_sessions(keep=0)
        self.assertEqual(sorted(os.listdir(os.path.join(self.cache, "rooms"))), ["BROKEN", "LIVE"])

    def test_prune_everything_but_live(self):
        self._setup()
        rooms.prune_sessions(keep_room_id="NONE", keep=0)
        self.assertEqual(os.listdir(os.path.join(self.cache, "rooms")), ["LIVE"])
        self.assertEqual(list(rooms.ROOMS), ["LIVE"])

    def test_pruned_loaded_room_save_leaves_no_folder(self):
        self._folder("DIRTY", {"takes": {"t1000": _take_entry()}, "created_here": False})
        room = rooms.load_room_folder("DIRTY")
        room._save_dirty = True
        rooms.prune_sessions(keep_room_id="NONE", keep=0)
        self.assertTrue(room.deleted)
        self.assertNotIn("DIRTY", rooms.ROOMS)
        room._sync_save_to_disk()
        self.assertFalse(self._exists("DIRTY"))

    def test_unsaved_loaded_room_is_forgotten(self):
        room = rooms.Room("NOFOLD", packs_cache.PACKS_CACHE[self.PACK_ID], "hostS", "Host", "#7c5cff")
        rooms.ROOMS["NOFOLD"] = room
        rooms.prune_sessions(keep_room_id="NONE", keep=0)
        self.assertNotIn("NOFOLD", rooms.ROOMS)
        room._sync_save_to_disk()
        self.assertFalse(self._exists("NOFOLD"))


class TestNewRoomCode(SessionCase):
    def test_skips_codes_in_use(self):
        rooms.ROOMS["LOADED"] = object()
        os.makedirs(os.path.join(self.cache, "rooms", "ONDISK"), exist_ok=True)
        with mock.patch.object(rooms, "generate_room_code", side_effect=["ONDISK", "LOADED", "FRESH2"]):
            self.assertEqual(rooms.new_room_code(), "FRESH2")


class RouteCase(SessionCase):
    """The session routes, against a temp cache and a synthetic pack."""
    BASE = TestRetention.BASE
    _folder = TestRetention._folder
    _exists = TestRetention._exists

    @classmethod
    def setUpClass(cls):
        import app
        from starlette.testclient import TestClient
        cls.app = app.app
        cls.client = TestClient(app.app, base_url="http://127.0.0.1:8000")

    def setUp(self):
        super().setUp()
        from dubmate import room_registry
        self.registry = room_registry
        for table in self._registry_tables():
            table.clear()
            self.addCleanup(table.clear)
        shutil.rmtree(self.room_dir)  # setUp's empty folder
        self.takes = {"t1000": _take_entry()}

    def _registry_tables(self):
        r = self.registry
        return (r.WORKER_PENDING_ROOMS, r.WORKER_ROOM_STATUS, r.WORKER_PUBLISHED_TUNNEL, r.WORKER_PUBLISHED_AT)


class TestSessionRoutes(RouteCase):
    def test_list(self):
        self._folder("REC0", {"takes": self.takes, "last_active_at": self.BASE})
        self._folder("REC1", {"takes": self.takes, "last_active_at": self.BASE - 100})
        self._folder("GUEST", {"takes": self.takes, "last_active_at": self.BASE + 60, "created_here": False})
        self._folder("EMPTY", {"takes": {}, "last_active_at": self.BASE + 70})
        res = self.client.get("/api/sessions")
        self.assertEqual(res.status_code, 200, res.text)
        sessions = res.json()["sessions"]
        self.assertEqual([s["room_id"] for s in sessions], ["REC0", "REC1"])
        self.assertNotIn("listed", sessions[0])
        self.assertEqual(sessions[0]["pack_name"], "Sessions Pack")
        self.assertEqual(sessions[0]["recorded_lines"], 1)

    def test_open_restores_a_room_that_is_not_loaded(self):
        self._folder("REC0", {"takes": self.takes, "last_active_at": self.BASE, "creator_id": "maker1"})
        self.assertNotIn("REC0", rooms.ROOMS)
        res = self.client.post("/api/sessions/rec0/open")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["room_id"], "REC0")
        self.assertEqual(body["user_id"], "maker1")
        self.assertEqual(body["state"]["room_id"], "REC0")
        self.assertIn("t1000", body["state"]["takes"])
        room = rooms.ROOMS["REC0"]
        self.assertGreater(room.last_active_at, self.BASE)
        self.assertNotIn("REC0", self.registry.WORKER_PENDING_ROOMS)

    def test_open_loaded_room_returns_creator(self):
        self._folder("REC0", {"takes": self.takes, "last_active_at": self.BASE})
        room = rooms.load_room_folder("REC0")
        room.host_id = "someoneelse"  # host promotion never changes the creator
        res = self.client.post("/api/sessions/REC0/open")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["user_id"], "hostS")
        self.assertIs(rooms.ROOMS["REC0"], room)

    def test_open_missing_pack_is_409(self):
        self._folder("NOPACK", {"pack_id": "gone_pack", "takes": self.takes})
        res = self.client.post("/api/sessions/NOPACK/open")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], "This scene isn't in your library anymore.")
        self.assertNotIn("NOPACK", rooms.ROOMS)

    def test_open_unknown_or_unlisted_is_404(self):
        self._folder("EMPTY", {"takes": {}})
        self._folder("GUEST", {"takes": self.takes, "created_here": False})
        for code in ("NOSUCH", "EMPTY", "GUEST"):
            res = self.client.post(f"/api/sessions/{code}/open")
            self.assertEqual(res.status_code, 404, code)
            self.assertEqual(res.json()["detail"], "That session is gone.")
        self.assertNotIn("EMPTY", rooms.ROOMS)

    def test_open_bad_id_is_400(self):
        self.assertEqual(self.client.post("/api/sessions/..%5Cx/open").status_code, 400)

    def test_delete(self):
        self._folder("REC0", {"takes": self.takes})
        rooms.load_room_folder("REC0")
        for table in self._registry_tables():
            table["REC0"] = "x"
        res = self.client.delete("/api/sessions/REC0")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json(), {"status": "ok"})
        self.assertFalse(self._exists("REC0"))
        self.assertNotIn("REC0", rooms.ROOMS)
        for table in self._registry_tables():
            self.assertNotIn("REC0", table)
        self.assertEqual(self.client.delete("/api/sessions/REC0").status_code, 404)

    def test_delete_folder_that_is_not_loaded(self):
        self._folder("NOPACK", {"pack_id": "gone_pack", "takes": self.takes})
        self.assertEqual(self.client.delete("/api/sessions/NOPACK").status_code, 200)
        self.assertFalse(self._exists("NOPACK"))

    def test_delete_live_room_is_409(self):
        self._folder("LIVE", {"takes": self.takes})
        rooms.load_room_folder("LIVE").sockets.add(object())
        res = self.client.delete("/api/sessions/LIVE")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], "Someone is still in this session.")
        self.assertTrue(self._exists("LIVE"))
        self.assertIn("LIVE", rooms.ROOMS)

    def test_delete_bad_or_unknown_id(self):
        # A literal '../x' never reaches the route (the URL is normalised or doesn't
        # match), so the encoded forms and a direct call cover the id check.
        for path in ("..%5Cx", "%2E%2E"):
            self.assertEqual(self.client.delete(f"/api/sessions/{path}").status_code, 400, path)
        self.assertEqual(self.client.delete("/api/sessions/NOSUCH").status_code, 404)
        import asyncio
        from fastapi import HTTPException
        from dubmate import sessions_api
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(sessions_api.delete_session("../x", _request({"Host": "127.0.0.1:8000"})))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_delete_dirty_room_with_pending_save_leaves_no_folder(self):
        import asyncio
        import httpx
        self._folder("DIRTY", {"takes": self.takes})

        async def scenario():
            room = rooms.load_room_folder("DIRTY")
            room.mark_dirty()  # a debounced save is now pending on this loop
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as c:
                res = await c.delete("/api/sessions/DIRTY")
            self.assertEqual(res.status_code, 200, res.text)
            return room

        room = asyncio.run(scenario())  # the loop runs every remaining task to the end
        self.assertTrue(room.deleted)
        self.assertTrue(room._save_task.done())
        self.assertFalse(self._exists("DIRTY"))
        room._sync_save_to_disk()
        self.assertFalse(self._exists("DIRTY"))


class TestSessionRoutesGuard(RouteCase):
    REFUSED = ({"cf-ray": "abc123"}, {"host": "192.168.1.5:8000"}, {"origin": "https://evil.example"})

    def test_every_route_is_own_computer_only(self):
        self._folder("REC0", {"takes": self.takes})
        calls = (("get", "/api/sessions"), ("post", "/api/sessions/REC0/open"),
                 ("delete", "/api/sessions/REC0"))
        for headers in self.REFUSED:
            for method, url in calls:
                res = getattr(self.client, method)(url, headers=headers)
                self.assertEqual(res.status_code, 403, (method, url, headers))
                self.assertEqual(res.json()["detail"], "This only works on the host's computer.")
        self.assertTrue(self._exists("REC0"))
        self.assertNotIn("REC0", rooms.ROOMS)


def _request(headers):
    scope = {
        "type": "http", "method": "GET", "path": "/api/sessions", "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
    }
    return Request(scope)


class TestIsOwnComputer(unittest.TestCase):
    def test_loopback_without_origin(self):
        self.assertTrue(common.is_own_computer(_request({"Host": "127.0.0.1:8000"})))
        self.assertTrue(common.is_own_computer(_request({"Host": "localhost:8000"})))
        self.assertTrue(common.is_own_computer(_request({"Host": "[::1]:8000"})))
        self.assertTrue(common.is_own_computer(_request({"Host": "localhost"})))

    def test_same_origin(self):
        self.assertTrue(common.is_own_computer(_request(
            {"Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"})))

    def test_cloudflare_headers(self):
        self.assertFalse(common.is_own_computer(_request({"Host": "127.0.0.1:8000", "cf-ray": "abc"})))
        self.assertFalse(common.is_own_computer(_request(
            {"Host": "127.0.0.1:8000", "cf-connecting-ip": "1.2.3.4"})))

    def test_lan_host(self):
        self.assertFalse(common.is_own_computer(_request({"Host": "192.168.1.20:8000"})))

    def test_rebinding_host(self):
        self.assertFalse(common.is_own_computer(_request({"Host": "evil.example"})))
        self.assertFalse(common.is_own_computer(_request({"Host": "evil.example:8000"})))

    def test_other_origin(self):
        self.assertFalse(common.is_own_computer(_request(
            {"Host": "127.0.0.1:8000", "Origin": "https://evil.example"})))
        self.assertFalse(common.is_own_computer(_request(
            {"Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:9999"})))

    def test_null_origin(self):
        self.assertFalse(common.is_own_computer(_request({"Host": "127.0.0.1:8000", "Origin": "null"})))

    def test_require_own_computer_refuses(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            common.require_own_computer(_request({"Host": "evil.example"}))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.detail, "This only works on the host's computer.")
        common.require_own_computer(_request({"Host": "127.0.0.1:8000"}))


class TestPackShareFileName(SessionCase):
    """Share names the saved scene file so the studio can show its full path."""

    def test_export_names_the_saved_file(self):
        import app
        from starlette.testclient import TestClient
        exports = os.path.join(self.cache, "exports")
        patcher = mock.patch.object(common, "_exports_dir", exports)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.makedirs(exports)
        res = TestClient(app.app).get(f"/api/packs/{self.PACK_ID}/export")
        self.assertEqual(res.status_code, 200)
        name = res.headers["X-DubMate-File"]
        self.assertNotIn("/", name)
        self.assertNotIn("\\", name)
        self.assertEqual(os.listdir(os.path.join(exports, "packs")), [name])

    def test_non_ascii_pack_id_is_percent_encoded(self):
        import app
        from urllib.parse import unquote
        from starlette.testclient import TestClient
        exports = os.path.join(self.cache, "exports")
        patcher = mock.patch.object(common, "_exports_dir", exports)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.makedirs(exports)
        pack = packs_cache.PACKS_CACHE[self.PACK_ID]
        packs_cache.PACKS_CACHE["Szene_ü"] = pack
        res = TestClient(app.app).get("/api/packs/Szene_%C3%BC/export")
        self.assertEqual(res.status_code, 200)
        name = unquote(res.headers["X-DubMate-File"])
        self.assertTrue(name.endswith("_Szene_ü.zip"), name)
        self.assertIn(name, os.listdir(os.path.join(exports, "packs")))


if __name__ == "__main__":
    unittest.main()
