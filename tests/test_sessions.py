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


class TestNewRoomCode(SessionCase):
    def test_skips_codes_in_use(self):
        rooms.ROOMS["LOADED"] = object()
        os.makedirs(os.path.join(self.cache, "rooms", "ONDISK"), exist_ok=True)
        with mock.patch.object(rooms, "generate_room_code", side_effect=["ONDISK", "LOADED", "FRESH2"]):
            self.assertEqual(rooms.new_room_code(), "FRESH2")


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


if __name__ == "__main__":
    unittest.main()
