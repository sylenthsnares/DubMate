import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

import anyio
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
import pack_loader
from dubmate import common, packs_cache, rooms


class TestStableLineIds(unittest.TestCase):
    def test_rounds_to_millisecond(self):
        lines = [{"start": 1.001}, {"start": 44.048}, {"start": 0}]
        pack_loader.assign_line_ids(lines)
        self.assertEqual([l["line_id"] for l in lines], ["t1001", "t44048", "t0"])

    def test_duplicates_get_suffix_in_line_order(self):
        lines = [{"start": 2.5}, {"start": 2.5}, {"start": 3.0}, {"start": 2.5}]
        pack_loader.assign_line_ids(lines)
        self.assertEqual([l["line_id"] for l in lines], ["t2500", "t2500-2", "t3000", "t2500-3"])

    def test_inserting_an_earlier_line_keeps_other_ids(self):
        lines = [{"start": 5.0, "index": 0}, {"start": 9.25, "index": 1}]
        pack_loader.assign_line_ids(lines)
        before = [l["line_id"] for l in lines]
        revised = [{"start": 1.0, "index": 0}, {"start": 5.0, "index": 1}, {"start": 9.25, "index": 2}]
        pack_loader.assign_line_ids(revised)
        self.assertEqual([l["line_id"] for l in revised], ["t1000"] + before)
        self.assertEqual([l["index"] for l in revised], [0, 1, 2])

    def test_reassigns_stale_ids(self):
        lines = [{"start": 1.0, "line_id": "old"}]
        pack_loader.assign_line_ids(lines)
        self.assertEqual(lines[0]["line_id"], "t1000")


class TestPackLineIds(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="dm_take_model_")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _make_pack(self):
        pack_dir = os.path.join(self.test_dir, "Line_Id_Pack")
        os.makedirs(pack_dir)
        sr = 16000
        tone = (0.1 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr)).astype(np.float32)
        captions = {}
        for fname in ("01_Ana_1-001.wav", "02_Ben_44-048.wav", "03_Cy_44-048.wav"):
            audio_processor.write_wav_mono(os.path.join(pack_dir, fname), tone, sr)
            captions[fname] = f"[{fname.split('_')[1]}] Hello"
        with open(os.path.join(pack_dir, "_captions.json"), "w", encoding="utf-8") as f:
            json.dump(captions, f)
        subprocess.run([
            pack_loader.get_ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            os.path.join(pack_dir, "dub_video.mp4"),
        ], check=True)
        return pack_dir

    def test_loaded_pack_carries_line_ids(self):
        pack = pack_loader.load_pack(self._make_pack())
        self.assertIsNotNone(pack)
        ids = [l["line_id"] for l in pack.to_dict()["lines"]]
        self.assertEqual(ids, ["t1001", "t44048", "t44048-2"])
        self.assertEqual([l["index"] for l in pack.lines], [0, 1, 2])

    def test_pack_restored_from_cache_carries_line_ids(self):
        pack_dir = self._make_pack()
        pack = pack_loader.load_pack(pack_dir)
        d = pack.to_dict()
        for line in d["lines"]:
            line.pop("line_id")  # old caches were written before line IDs
        cache_file = os.path.join(self.test_dir, "pack_index.json")
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({pack_dir: {"mtime": os.path.getmtime(pack_dir), "dict": d,
                                  "folder": pack_dir, "name": pack.name,
                                  "video_path": pack.video_path}}, f)
        object_cache = {}
        with mock.patch.object(pack_loader, "PACK_INDEX_CACHE_FILE", cache_file), \
                mock.patch.object(pack_loader, "PACK_OBJECT_CACHE", object_cache):
            pack_loader.load_persistent_pack_cache()
        self.assertIn(pack_dir, object_cache)
        restored = object_cache[pack_dir][1]
        self.assertEqual([l["line_id"] for l in restored.to_dict()["lines"]],
                         ["t1001", "t44048", "t44048-2"])


class TestTakeFiles(unittest.TestCase):
    """Take files by directory and stem, and moving old-layout takes into takes/<line_id>/."""

    ROOM = "TAKE_FILES_ROOM"

    def setUp(self):
        self.cache = tempfile.mkdtemp(prefix="dm_take_files_")
        patcher = mock.patch.object(audio_processor, "CACHE_DIR", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.cache, True)
        self.room_dir = audio_processor.get_room_cache_dir(self.ROOM)

    def _wav(self, path, freq):
        sr = audio_processor.SR
        tone = (0.2 * np.sin(2 * np.pi * freq * np.arange(sr // 4) / sr)).astype(np.float32)
        audio_processor.write_wav_mono(path, tone, sr)
        with open(path, "rb") as f:
            return f.read()

    def _legacy(self, index, *suffixes):
        """Writes take_line_<index><suffix>.wav files (distinct audio each) and returns {suffix: bytes}."""
        out = {}
        for n, suffix in enumerate(suffixes):
            out[suffix] = self._wav(os.path.join(self.room_dir, f"take_line_{index}{suffix}.wav"), 200 + 50 * n)
        return out

    def _read(self, path):
        with open(path, "rb") as f:
            return f.read()

    def test_take_dir_stays_inside_room(self):
        takes_root = os.path.join(self.room_dir, "takes")
        path = audio_processor.take_dir(self.ROOM, "../../evil")
        self.assertTrue(os.path.isdir(path))
        self.assertEqual(os.path.dirname(os.path.realpath(path)), os.path.realpath(takes_root))
        self.assertNotIn("..", os.path.basename(path))
        with self.assertRaises(ValueError):
            audio_processor.take_dir(self.ROOM, "../..")
        self.assertEqual(audio_processor.take_wav_path(self.ROOM, "t1000", "take2"),
                         os.path.join(takes_root, "t1000", "take2.wav"))

    def test_delete_take_files_removes_only_that_stem(self):
        d = audio_processor.take_dir(self.ROOM, "t1000")
        mine = ["take1.wav", "take1_raw.wav", "take1_denoised.wav", "take1_denoised_abcd1234.wav"]
        others = ["take10.wav", "take10_raw.wav", "take10_denoised_abcd1234.wav", "take2.wav"]
        for name in mine + others:
            self._wav(os.path.join(d, name), 300)
        audio_processor.delete_take_files(d, "take1")
        self.assertEqual(sorted(os.listdir(d)), sorted(others))

    def test_migrate_copies_every_variant_byte_identically_and_keeps_the_originals(self):
        key_suffix = os.path.basename(audio_processor.denoised_take_path(self.room_dir, "take_line_0"))[len("take_line_0"):-4]
        before = self._legacy(0, "", "_raw", key_suffix, "_denoised")
        other = self._legacy(10, "", "_raw")
        result = audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", True)
        self.assertEqual(result, {"has_audio": True, "has_raw": True, "noise_reduction": True})
        d = os.path.join(self.room_dir, "takes", "t1000")
        self.assertEqual(sorted(os.listdir(d)), sorted(f"take1{suffix}.wav" for suffix in before))
        for suffix, data in before.items():
            self.assertEqual(self._read(os.path.join(d, f"take1{suffix}.wav")), data)
            self.assertEqual(self._read(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")), data)
        for suffix, data in other.items():
            self.assertEqual(self._read(os.path.join(self.room_dir, f"take_line_10{suffix}.wav")), data)

        listing = sorted(os.listdir(d))
        again = audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", True)
        self.assertEqual(again, result)
        self.assertEqual(sorted(os.listdir(d)), listing)
        for suffix, data in before.items():
            self.assertEqual(self._read(os.path.join(d, f"take1{suffix}.wav")), data)

    def test_missing_active_uses_cleaned_file_when_noise_reduction_on(self):
        denoised_name = os.path.basename(audio_processor.denoised_take_path(self.room_dir, "take_line_0"))
        files = self._legacy(0, "_raw", denoised_name[len("take_line_0"):-4])
        result = audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", True)
        self.assertEqual(result, {"has_audio": True, "has_raw": True, "noise_reduction": True})
        active = os.path.join(self.room_dir, "takes", "t1000", "take1.wav")
        self.assertEqual(self._read(active), files[denoised_name[len("take_line_0"):-4]])

    def test_missing_active_uses_raw_and_turns_noise_reduction_off(self):
        files = self._legacy(0, "_raw", "_denoised")  # only a cleaned file from older settings
        result = audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", True)
        self.assertEqual(result, {"has_audio": True, "has_raw": True, "noise_reduction": False})
        active = os.path.join(self.room_dir, "takes", "t1000", "take1.wav")
        self.assertEqual(self._read(active), files["_raw"])

        files = self._legacy(1, "_raw")
        result = audio_processor.migrate_legacy_take_files(self.ROOM, 1, "t2000", "take1", False)
        self.assertEqual(result, {"has_audio": True, "has_raw": True, "noise_reduction": False})
        self.assertEqual(self._read(os.path.join(self.room_dir, "takes", "t2000", "take1.wav")), files["_raw"])

    def test_nothing_to_move(self):
        result = audio_processor.migrate_legacy_take_files(self.ROOM, 3, "t3000", "take1", False)
        self.assertEqual(result, {"has_audio": False, "has_raw": False, "noise_reduction": False})

    def test_failed_copy_removes_only_its_own_copies(self):
        key_suffix = os.path.basename(audio_processor.denoised_take_path(self.room_dir, "take_line_0"))[len("take_line_0"):-4]
        before = self._legacy(0, "", "_raw", key_suffix)
        real_replace = os.replace
        calls = []

        def flaky_replace(src, dst):
            calls.append(src)
            if len(calls) == 2:
                raise PermissionError(13, "The process cannot access the file", src)
            return real_replace(src, dst)

        with mock.patch.object(audio_processor.os, "replace", flaky_replace):
            with self.assertRaises(PermissionError):
                audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", True)
        for suffix, data in before.items():
            self.assertEqual(self._read(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")), data)
        self.assertEqual(os.listdir(os.path.join(self.room_dir, "takes", "t1000")), [])

    def test_failed_copy_removes_the_partial_active_file(self):
        files = self._legacy(0, "_raw")

        def broken_copy(src, dst):
            with open(dst, "wb") as f:
                f.write(b"partial")
            raise OSError(28, "No space left on device")

        with mock.patch.object(audio_processor.shutil, "copy2", broken_copy):
            with self.assertRaises(OSError):
                audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", False)
        self.assertEqual(self._read(os.path.join(self.room_dir, "take_line_0_raw.wav")), files["_raw"])
        self.assertEqual(os.listdir(os.path.join(self.room_dir, "takes", "t1000")), [])

    def test_read_paths_create_no_folders(self):
        audio_processor.take_wav_path(self.ROOM, "t4000", "take1")
        audio_processor.take_dir(self.ROOM, "t4000", create=False)
        self.assertFalse(os.path.exists(os.path.join(self.room_dir, "takes", "t4000")))


class RoomCase(unittest.TestCase):
    """Own cache dir, an empty room table and a synthetic 3-line pack in the registry, so
    load_persisted_rooms() (which prunes every room folder but the newest) only sees this case."""

    ROOM = "TMROOM"
    PACK_ID = "take_model_pack"
    PACK_MTIME = 1_789_000_000.0

    def setUp(self):
        self.cache = tempfile.mkdtemp(prefix="dm_take_rooms_")
        self.addCleanup(shutil.rmtree, self.cache, True)
        for patcher in (mock.patch.object(audio_processor, "CACHE_DIR", self.cache),
                        mock.patch.object(packs_cache, "PACKS_CACHE", {})):
            patcher.start()
            self.addCleanup(patcher.stop)
        rooms.ROOMS.clear()
        self.addCleanup(rooms.ROOMS.clear)
        self.pack = self._make_pack()
        packs_cache.PACKS_CACHE[self.PACK_ID] = self.pack
        self.room_dir = audio_processor.get_room_cache_dir(self.ROOM)

    def _make_pack(self):
        folder = os.path.join(self.cache, "pack")
        os.makedirs(folder)
        pack = pack_loader.PackInfo(self.PACK_ID, folder, "Take Model Pack")
        pack.characters = ["Ana", "Ben"]
        pack.duration = 8.0
        for i, (start, char) in enumerate([(1.0, "Ana"), (3.0, "Ben"), (5.0, "Ana")]):
            fname = f"{i + 1:02d}_{char}_{int(start)}-000.wav"
            self._wav(os.path.join(folder, fname), 180 + 20 * i)
            pack.lines.append({"index": i, "start": start, "end": start + 1.5, "character": char,
                               "filename": fname, "caption": f"Line {i + 1}"})
        pack_loader.assign_line_ids(pack.lines)  # t1000, t3000, t5000
        # Dated before the v1 takes' recorded_at, so a v1 take may be placed on its line.
        for path in [os.path.join(folder, line["filename"]) for line in pack.lines] + [folder]:
            os.utime(path, (self.PACK_MTIME, self.PACK_MTIME))
        return pack

    def _wav(self, path, freq, seconds=0.25):
        sr = audio_processor.SR
        tone = (0.2 * np.sin(2 * np.pi * freq * np.arange(int(sr * seconds)) / sr)).astype(np.float32)
        audio_processor.write_wav_mono(path, tone, sr)
        with open(path, "rb") as f:
            return f.read()

    def _read(self, path):
        with open(path, "rb") as f:
            return f.read()

    def _one_event_loop(self, client):
        """Runs every request and socket of `client` on one event loop for the rest of the test,
        so a background task (a refresh, an export render) outlives the request that starts it."""
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        client.portal = stack.enter_context(anyio.from_thread.start_blocking_portal("asyncio"))
        stack.callback(setattr, client, "portal", None)

    def _room(self):
        room = rooms.Room(self.ROOM, self.pack, "hostT", "Host", "#7c5cff")
        rooms.ROOMS[self.ROOM] = room
        return room

    def _add(self, room, line_id, freq=300, **fields):
        """Adds a take the way the upload route does: files first, then the model."""
        take_id = fields.pop("take_id", None) or f"k{freq}"
        self._wav(os.path.join(audio_processor.take_dir(self.ROOM, line_id), f"{take_id}.wav"), freq)
        self._wav(os.path.join(audio_processor.take_dir(self.ROOM, line_id), f"{take_id}_raw.wav"), freq)
        return room.add_take(line_id, {"take_id": take_id, "user_name": "Ana", "duration": 0.25,
                                       "audio_version": 1, **fields})

    def _state_file(self):
        return os.path.join(self.room_dir, "room_state.json")

    def _load_state(self):
        with open(self._state_file(), encoding="utf-8") as f:
            return json.load(f)

    def _reload(self):
        rooms.ROOMS.clear()
        rooms.load_persisted_rooms()
        self.assertIn(self.ROOM, rooms.ROOMS)
        return rooms.ROOMS[self.ROOM]


class TestTakeHistory(RoomCase):
    def test_new_take_keeps_older_takes_and_is_picked(self):
        room = self._room()
        first = self._add(room, "t1000", 300)
        second = self._add(room, "t1000", 400)
        entry = room.line_entry("t1000")
        self.assertEqual([t["take_id"] for t in entry["takes"]], [first["take_id"], second["take_id"]])
        self.assertEqual([t["number"] for t in entry["takes"]], [1, 2])
        self.assertEqual(room.picked_take("t1000"), second)
        self.assertIsNone(room.picked_take("t3000"))
        self.assertIsNone(room.line_entry("t3000"))
        made = room.add_take("t3000", {"user_name": "Ben"})
        self.assertEqual(len(made["take_id"]), 8)

    def test_pick(self):
        room = self._room()
        first = self._add(room, "t1000", 300)
        self._add(room, "t1000", 400)
        self.assertEqual(room.pick_take("t1000", first["take_id"]), first)
        self.assertEqual(room.picked_take("t1000"), first)
        self.assertIsNone(room.pick_take("t1000", "nope"))
        self.assertIsNone(room.pick_take("t3000", first["take_id"]))
        self.assertEqual(room.picked_take("t1000"), first)

    def test_numbers_are_not_reused_after_delete(self):
        room = self._room()
        for freq in (300, 400, 500):
            self._add(room, "t1000", freq)
        room.remove_take("t1000", "k500")
        self.assertEqual(self._add(room, "t1000", 600)["number"], 4)

    def test_deleting_picked_take_falls_back_to_newest(self):
        room = self._room()
        for freq in (300, 400, 500):
            self._add(room, "t1000", freq)
        room.pick_take("t1000", "k400")
        self.assertEqual(room.remove_take("t1000", "k400"), "k500")
        self.assertEqual(room.picked_take("t1000")["take_id"], "k500")
        # Deleting a take that is not picked leaves the pick alone.
        self.assertEqual(room.remove_take("t1000", "k300"), "k500")
        d = audio_processor.take_dir(self.ROOM, "t1000")
        self.assertEqual(sorted(os.listdir(d)), ["k500.wav", "k500_raw.wav"])

    def test_deleting_last_take_drops_entry_and_files(self):
        room = self._room()
        self._add(room, "t1000", 300)
        self.assertIsNone(room.remove_take("t1000", "k300"))
        self.assertNotIn("t1000", room.takes)
        self.assertEqual(os.listdir(audio_processor.take_dir(self.ROOM, "t1000")), [])
        self.assertNotIn("t1000", room.to_state_dict()["takes"])
        self.assertEqual(room.mix_takes(), {})

    def test_mix_takes_gives_picked_copies_with_wav_path(self):
        room = self._room()
        self._add(room, "t1000", 300, offset_ms=40)
        picked = self._add(room, "t5000", 400, gain_db=-2.0)
        mix = room.mix_takes()
        self.assertEqual(sorted(mix), [0, 2])
        self.assertEqual(mix[2]["wav_path"], audio_processor.take_wav_path(self.ROOM, "t5000", "k400"))
        self.assertTrue(os.path.isfile(mix[2]["wav_path"]))
        self.assertEqual(mix[2]["gain_db"], -2.0)
        mix[2]["gain_db"] = 9.0
        self.assertEqual(picked["gain_db"], -2.0)
        self.assertNotIn("wav_path", picked)

    def test_unknown_line_ids_are_kept_but_hidden(self):
        room = self._room()
        self._add(room, "t1000", 300)
        self._add(room, "t99999", 400)
        self.assertEqual(room.mix_takes().keys(), {0})
        self.assertEqual(set(room.to_state_dict()["takes"]), {"t1000"})
        room._sync_save_to_disk()
        self.assertIn("t99999", self._reload().takes)

    def test_state_payload_is_version_3(self):
        room = self._room()
        self._add(room, "t3000", 300, audio_version=1234, noise_reduction=True, peaks=[[0.1, 0.2]])
        self._add(room, "t3000", 400, audio_version=5, peaks=[[0.3, 0.4]])
        state = room.to_state_dict()
        self.assertEqual(state["state_version"], 3)   # the wire version; the saved file stays 2
        entry = state["takes"]["t3000"]
        self.assertEqual((entry["picked"], entry["next_number"]), ("k400", 3))
        older, newest = entry["takes"]
        self.assertEqual(older["url"], f"/api/rooms/{self.ROOM}/lines/t3000/takes/k300/audio?v=1234")
        self.assertEqual((older["take_id"], older["number"]), ("k300", 1))
        self.assertTrue(older["noise_reduction"])
        self.assertNotIn("peaks", older)
        self.assertEqual(newest["peaks"], [[0.3, 0.4]])
        self.assertEqual(room.find_take("t3000", "k300")["peaks"], [[0.1, 0.2]])
        self.assertNotIn("url", room.find_take("t3000", "k300"))

    def test_v2_save_and_load_round_trip(self):
        room = self._room()
        self._add(room, "t1000", 300, offset_ms=40)
        self._add(room, "t1000", 400)
        room.pick_take("t1000", "k300")
        self._add(room, "t3000", 500)
        room._sync_save_to_disk()
        saved = self._load_state()
        self.assertEqual(saved["state_version"], 2)
        expected = json.loads(json.dumps(room.takes))
        loaded = self._reload()
        self.assertEqual(loaded.takes, expected)
        self.assertEqual(loaded.picked_take("t1000")["take_id"], "k300")
        self.assertEqual(self._load_state(), saved)


class TestOldRoomMigration(RoomCase):
    """Rooms saved before take history: one take per line index, take_line_<i>*.wav files."""

    def _old_take(self, **fields):
        take = {"user_id": "hostT", "user_name": "Ana",
                "wav_path": os.path.join(self.room_dir, "take_line_0.wav"),
                "duration": 0.25, "peaks": [[0.1, 0.2]],
                "url": f"/api/rooms/{self.ROOM}/takes/0/audio?v=1790000000123",
                "offset_ms": 40, "pitch_semitones": 1.0, "reverb_wet": 0.1, "gain_db": -3.2,
                "noise_reduction": False, "has_raw": True, "speech_loudness_db": -18.1,
                "target_loudness_db": -21.3, "auto_gain_db": -3.2, "recorded_at": 1790000000.0}
        take.update(fields)
        return take

    def _write_v1(self, takes):
        state = {"room_id": self.ROOM, "pack_id": self.PACK_ID, "host_id": "hostT",
                 "users": {"hostT": {"id": "hostT", "name": "Host", "color": "#7c5cff",
                                     "is_host": True, "is_online": False}},
                 "role_assignments": {"Ana": ["hostT"], "Ben": []},
                 "takes": takes, "status": "recording", "exported_video_path": None}
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump(state, f)

    def _key_suffix(self, stem):
        return os.path.basename(audio_processor.denoised_take_path(self.room_dir, stem))[len(stem):-4]

    def _snapshot(self):
        out = {}
        for root, _, files in os.walk(self.room_dir):
            for name in files:
                path = os.path.join(root, name)
                out[os.path.relpath(path, self.room_dir)] = self._read(path)
        return out

    def test_old_layout_room(self):
        key = self._key_suffix("take_line_0")
        line0 = {s: self._wav(os.path.join(self.room_dir, f"take_line_0{s}.wav"), f)
                 for s, f in (("", 300), ("_raw", 350), (key, 400))}
        line1 = self._wav(os.path.join(self.room_dir, "take_line_1.wav"), 450)
        line7 = self._wav(os.path.join(self.room_dir, "take_line_7.wav"), 500)
        self._write_v1({"0": self._old_take(noise_reduction=True),
                        "1": self._old_take(user_name="Ben", noise_reduction=False, has_raw=True),
                        "7": self._old_take()})

        room = self._reload()
        self.assertEqual(sorted(room.takes), ["t1000", "t3000"])
        for line_id in ("t1000", "t3000"):
            entry = room.takes[line_id]
            self.assertEqual(entry["picked"], "take1")
            self.assertEqual(entry["next_number"], 2)
            self.assertEqual(len(entry["takes"]), 1)
            take = entry["takes"][0]
            self.assertEqual((take["take_id"], take["number"]), ("take1", 1))
            self.assertNotIn("wav_path", take)
            self.assertNotIn("url", take)
            self.assertIsInstance(take["audio_version"], int)
        take0 = room.picked_take("t1000")
        self.assertEqual((take0["offset_ms"], take0["gain_db"], take0["auto_gain_db"]), (40, -3.2, -3.2))
        self.assertTrue(take0["noise_reduction"])
        self.assertTrue(take0["has_raw"])
        self.assertFalse(room.picked_take("t3000")["has_raw"])
        self.assertEqual(room.picked_take("t3000")["user_name"], "Ben")

        new0 = os.path.join(self.room_dir, "takes", "t1000")
        for suffix, data in line0.items():
            self.assertEqual(self._read(os.path.join(new0, f"take1{suffix}.wav")), data)
            self.assertEqual(self._read(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")), data)
        self.assertEqual(self._read(os.path.join(self.room_dir, "takes", "t3000", "take1.wav")), line1)
        self.assertEqual(self._read(os.path.join(self.room_dir, "take_line_1.wav")), line1)
        self.assertEqual(self._read(os.path.join(self.room_dir, "take_line_7.wav")), line7)
        self.assertEqual(room.unplaced_v1_takes, {"7": self._old_take()})

        saved = self._load_state()
        self.assertEqual(saved["state_version"], 2)
        self.assertEqual(saved["unplaced_v1_takes"], {"7": self._old_take()})
        self.assertEqual(saved["takes"], json.loads(json.dumps(room.takes)))
        self.assertEqual(room.to_state_dict()["takes"]["t1000"]["takes"][0]["url"],
                         f"/api/rooms/{self.ROOM}/lines/t1000/takes/take1/audio?v={take0['audio_version']}")

        before = self._snapshot()
        again = self._reload()
        self.assertEqual(again.takes, saved["takes"])
        self.assertEqual(self._snapshot(), before)

    def test_half_migrated_room(self):
        """Files already moved but the state still says version 1 (a crash before saving)."""
        d = audio_processor.take_dir(self.ROOM, "t1000")
        active = self._wav(os.path.join(d, "take1.wav"), 300)
        raw = self._wav(os.path.join(d, "take1_raw.wav"), 350)
        self._write_v1({"0": self._old_take()})
        room = self._reload()
        self.assertEqual(room.picked_take("t1000")["take_id"], "take1")
        self.assertTrue(room.picked_take("t1000")["has_raw"])
        self.assertEqual(self._read(os.path.join(d, "take1.wav")), active)
        self.assertEqual(self._read(os.path.join(d, "take1_raw.wav")), raw)
        self.assertEqual(self._load_state()["state_version"], 2)

    def test_missing_active_with_noise_reduction_on_uses_cleaned_file(self):
        self._wav(os.path.join(self.room_dir, "take_line_0_raw.wav"), 300)
        cleaned = self._wav(os.path.join(self.room_dir, f"take_line_0{self._key_suffix('take_line_0')}.wav"), 400)
        self._write_v1({"0": self._old_take(noise_reduction=True)})
        room = self._reload()
        self.assertTrue(room.picked_take("t1000")["noise_reduction"])
        self.assertEqual(self._read(audio_processor.take_wav_path(self.ROOM, "t1000", "take1")), cleaned)

    def test_missing_active_with_noise_reduction_off_uses_raw(self):
        raw = self._wav(os.path.join(self.room_dir, "take_line_0_raw.wav"), 300)
        self._wav(os.path.join(self.room_dir, f"take_line_0{self._key_suffix('take_line_0')}.wav"), 400)
        self._write_v1({"0": self._old_take(noise_reduction=False)})
        room = self._reload()
        self.assertFalse(room.picked_take("t1000")["noise_reduction"])
        self.assertEqual(self._read(audio_processor.take_wav_path(self.ROOM, "t1000", "take1")), raw)

    def test_noise_reduction_turned_off_when_only_raw_is_left(self):
        raw = self._wav(os.path.join(self.room_dir, "take_line_0_raw.wav"), 300)
        self._write_v1({"0": self._old_take(noise_reduction=True)})
        room = self._reload()
        self.assertFalse(room.picked_take("t1000")["noise_reduction"])
        self.assertEqual(self._read(audio_processor.take_wav_path(self.ROOM, "t1000", "take1")), raw)

    def test_take_without_audio_is_dropped(self):
        self._write_v1({"2": self._old_take()})
        room = self._reload()
        self.assertEqual(room.takes, {})
        self.assertEqual(self._load_state()["takes"], {})

    def _locked_second_move(self):
        """Patches os.replace so the second file moved fails as a file held open on Windows does."""
        real_replace = os.replace
        calls = []

        def flaky_replace(src, dst):
            calls.append(src)
            if len(calls) == 2:
                raise PermissionError(13, "The process cannot access the file because it is being used by another process", src)
            return real_replace(src, dst)

        return mock.patch.object(audio_processor.os, "replace", flaky_replace)

    def test_failed_move_keeps_the_take_and_retries_next_start(self):
        key = self._key_suffix("take_line_0")
        line0 = {s: self._wav(os.path.join(self.room_dir, f"take_line_0{s}.wav"), f)
                 for s, f in (("", 300), ("_raw", 350), (key, 400))}
        line1 = self._wav(os.path.join(self.room_dir, "take_line_1.wav"), 450)
        old0 = self._old_take(noise_reduction=True)
        self._write_v1({"0": old0, "1": self._old_take(user_name="Ben")})

        with self._locked_second_move():
            room = self._reload()

        # The room loads and works; line 1 moved, line 0 stays in the old layout untouched.
        self.assertEqual(sorted(room.takes), ["t3000"])
        self.assertEqual(room.mix_takes().keys(), {1})
        for suffix, data in line0.items():
            self.assertEqual(self._read(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")), data)
        self.assertEqual(os.listdir(os.path.join(self.room_dir, "takes", "t1000")), [])
        self.assertEqual(self._read(audio_processor.take_wav_path(self.ROOM, "t3000", "take1")), line1)
        saved = self._load_state()
        self.assertEqual(saved["state_version"], 2)
        self.assertEqual(saved["pending_v1_takes"], {"0": json.loads(json.dumps(old0))})

        # A save during the session keeps the waiting take.
        room._sync_save_to_disk()
        self.assertEqual(self._load_state()["pending_v1_takes"], {"0": json.loads(json.dumps(old0))})

        room = self._reload()
        self.assertEqual(sorted(room.takes), ["t1000", "t3000"])
        take0 = room.picked_take("t1000")
        self.assertEqual((take0["take_id"], take0["number"], take0["offset_ms"]), ("take1", 1, 40))
        self.assertTrue(take0["noise_reduction"])
        new0 = os.path.join(self.room_dir, "takes", "t1000")
        for suffix, data in line0.items():
            self.assertEqual(self._read(os.path.join(new0, f"take1{suffix}.wav")), data)
            self.assertEqual(self._read(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")), data)
        saved = self._load_state()
        self.assertNotIn("pending_v1_takes", saved)
        self.assertEqual(room.pending_v1_takes, {})
        self.assertEqual(saved["takes"], json.loads(json.dumps(room.takes)))

    def test_waiting_take_joins_takes_recorded_meanwhile(self):
        old = self._wav(os.path.join(self.room_dir, "take_line_0.wav"), 300)
        self._wav(os.path.join(self.room_dir, "take_line_0_raw.wav"), 350)
        self._write_v1({"0": self._old_take()})
        with self._locked_second_move():
            room = self._reload()
        self.assertEqual(room.takes, {})
        self._add(room, "t1000", 500)
        room._sync_save_to_disk()

        room = self._reload()
        entry = room.line_entry("t1000")
        self.assertEqual([(t["take_id"], t["number"]) for t in entry["takes"]], [("k500", 1), ("take1", 2)])
        self.assertEqual((entry["picked"], entry["next_number"]), ("k500", 3))
        self.assertEqual(self._read(audio_processor.take_wav_path(self.ROOM, "t1000", "take1")), old)
        self.assertNotIn("pending_v1_takes", self._load_state())


class TestTakeRoutes(RoomCase):
    @classmethod
    def setUpClass(cls):
        import app
        from starlette.testclient import TestClient
        cls.client = TestClient(app.app)

    def _url(self, line_id, take_id=None, tail=""):
        url = f"/api/rooms/{self.ROOM}/lines/{line_id}/takes"
        return url + (f"/{take_id}" if take_id else "") + tail

    def _upload(self, line_id, freq, user_id="hostT", status=200, **form):
        data = {"user_id": user_id, "user_name": "Ana", "noise_reduction": "false"}
        data.update(form)
        audio = self._wav(os.path.join(self.cache, f"upload_{freq}.wav"), freq, seconds=0.5)
        res = self.client.post(self._url(line_id), files={"file": ("take.wav", audio, "audio/wav")}, data=data)
        self.assertEqual(res.status_code, status, res.text)
        return res.json().get("take")

    def _pick(self, line_id, take_id, user_id="hostT"):
        return self.client.post(self._url(line_id, take_id, "/pick"), json={"user_id": user_id})

    def _delete(self, line_id, take_id, user_id="hostT"):
        return self.client.delete(self._url(line_id, take_id), params={"user_id": user_id})

    def _until(self, ws, msg_type):
        while (msg := ws.receive_json())["type"] != msg_type:
            pass
        return msg

    def test_recording_twice_keeps_both_takes_and_serves_newest(self):
        room = self._room()
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            first = self._upload("t1000", 300)
            second = self._upload("t1000", 600, offset_ms="25")
            msg = self._until(ws, "take_recorded")
            msg = self._until(ws, "take_recorded")
        entry = room.line_entry("t1000")
        self.assertEqual([t["number"] for t in entry["takes"]], [1, 2])
        newest = entry["takes"][1]
        self.assertEqual(entry["picked"], newest["take_id"])
        self.assertEqual(second["url"],
                         f"/api/rooms/{self.ROOM}/lines/t1000/takes/{newest['take_id']}/audio?v={newest['audio_version']}")
        self.assertNotEqual(first["url"], second["url"])
        self.assertEqual(msg["payload"], {
            "line_id": "t1000", "line_index": 0, "take_id": newest["take_id"], "url": second["url"],
            "noise_reduction": False, "user_name": "Ana", "user_id": "hostT"})
        wire = msg["state"]["takes"]["t1000"]
        self.assertEqual(wire["picked"], newest["take_id"])
        self.assertEqual(wire["takes"][1]["offset_ms"], 25)
        for take in entry["takes"]:
            self.assertTrue(os.path.isfile(audio_processor.take_wav_path(self.ROOM, "t1000", take["take_id"])))
        self.assertEqual([n for n in os.listdir(self.room_dir) if n.startswith("take_line")], [])

        res = self.client.get(second["url"])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["cache-control"], common.LONG_CACHE)
        self.assertEqual(res.content, self._read(audio_processor.take_wav_path(self.ROOM, "t1000", newest["take_id"])))
        part = self.client.get(second["url"], headers={"Range": "bytes=0-99"})
        self.assertEqual(part.status_code, 206)
        self.assertEqual(part.content, res.content[:100])
        peaks = self.client.get(self._url("t1000", first["take_id"], "/peaks"))
        self.assertEqual(peaks.status_code, 200)
        self.assertEqual(peaks.json()["url"], first["url"])
        self.assertTrue(peaks.json()["peaks"])

    def test_state_sends_peaks_for_the_picked_take_only(self):
        room = self._room()
        first = self._upload("t1000", 300)
        self._upload("t1000", 600)
        state = room.to_state_dict()
        self.assertEqual(state["state_version"], 3)   # the wire version; the saved file stays 2
        older, newest = state["takes"]["t1000"]["takes"]
        self.assertNotIn("peaks", older)
        self.assertTrue(newest["peaks"])
        self.assertTrue(room.find_take("t1000", first["take_id"])["peaks"])

    def test_pick(self):
        room = self._room()
        first = self._upload("t1000", 300)
        self._upload("t1000", 600)
        room.exported_video_path = "old.mp4"
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            res = self._pick("t1000", first["take_id"])
            msg = self._until(ws, "take_picked")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(msg["payload"], {"line_id": "t1000", "line_index": 0,
                                          "take_id": first["take_id"], "user_id": "hostT"})
        self.assertEqual(room.picked_take("t1000")["take_id"], first["take_id"])
        self.assertEqual(msg["state"]["takes"]["t1000"]["picked"], first["take_id"])
        older, newest = msg["state"]["takes"]["t1000"]["takes"]
        self.assertTrue(older["peaks"])
        self.assertNotIn("peaks", newest)
        self.assertIsNone(room.exported_video_path)
        self.assertEqual(room.mix_takes()[0]["take_id"], first["take_id"])

    def test_delete_falls_back_to_newest_and_removes_files(self):
        room = self._room()
        oldest = self._upload("t1000", 300)
        middle = self._upload("t1000", 450)
        newest = self._upload("t1000", 600)
        d = audio_processor.take_dir(self.ROOM, "t1000")
        room.exported_video_path = "old.mp4"
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            self.assertEqual(self._pick("t1000", oldest["take_id"]).status_code, 200)
            res = self._delete("t1000", oldest["take_id"])
            msg = self._until(ws, "take_deleted")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["picked"], newest["take_id"])
        self.assertEqual(msg["payload"], {"line_id": "t1000", "line_index": 0, "take_id": oldest["take_id"],
                                          "picked": newest["take_id"], "user_id": "hostT"})
        self.assertEqual(room.picked_take("t1000")["take_id"], newest["take_id"])
        self.assertEqual([t["take_id"] for t in room.line_entry("t1000")["takes"]],
                         [middle["take_id"], newest["take_id"]])
        self.assertFalse([n for n in os.listdir(d) if n.startswith(oldest["take_id"])])
        self.assertTrue(os.path.isfile(os.path.join(d, f"{middle['take_id']}.wav")))
        self.assertIsNone(room.exported_video_path)
        self.assertEqual(self.client.get(oldest["url"]).status_code, 404)

    def test_delete_last_take(self):
        room = self._room()
        only = self._upload("t1000", 300)
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            res = self._delete("t1000", only["take_id"])
            msg = self._until(ws, "take_deleted")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertIsNone(msg["payload"]["picked"])
        self.assertNotIn("t1000", room.takes)
        self.assertNotIn("t1000", msg["state"]["takes"])
        self.assertEqual(os.listdir(audio_processor.take_dir(self.ROOM, "t1000")), [])
        self.assertEqual(room.mix_takes(), {})

    def test_cast_line_is_closed_to_other_users(self):
        room = self._room()
        room.role_assignments["Ana"] = ["actorA"]
        take = self._upload("t1000", 300, user_id="actorA")
        self._upload("t1000", 400, user_id="guestB", status=403)
        self.assertEqual(self._pick("t1000", take["take_id"], "guestB").status_code, 403)
        self.assertEqual(self._delete("t1000", take["take_id"], "guestB").status_code, 403)
        self.assertEqual(len(room.line_entry("t1000")["takes"]), 1)
        self.assertTrue(os.path.isfile(audio_processor.take_wav_path(self.ROOM, "t1000", take["take_id"])))
        # The host may still act on any line.
        self.assertEqual(self._pick("t1000", take["take_id"], "hostT").status_code, 200)

    def test_line_nobody_is_cast_on_is_open(self):
        room = self._room()
        self.assertEqual(room.role_assignments["Ben"], [])
        first = self._upload("t3000", 300, user_id="guestB")
        second = self._upload("t3000", 400, user_id="guestB")
        self.assertEqual(self._pick("t3000", first["take_id"], "guestB").status_code, 200)
        self.assertEqual(self._delete("t3000", second["take_id"], "guestB").status_code, 200)
        self.assertEqual(room.picked_take("t3000")["take_id"], first["take_id"])

    def test_unknown_lines_and_takes(self):
        room = self._room()
        take = self._upload("t1000", 300)
        self._add(room, "t99999", 400)  # kept from an older pack, not in this one
        res = self.client.post(self._url("t2000"), data={"user_id": "hostT"},
                               files={"file": ("take.wav", b"RIFF", "audio/wav")})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "That line isn't in this scene.")
        for line_id, take_id in (("t1000", "nope"), ("t2000", take["take_id"]), ("t99999", "k400")):
            self.assertEqual(self._pick(line_id, take_id).status_code, 404)
            self.assertEqual(self._delete(line_id, take_id).status_code, 404)
            self.assertEqual(self.client.get(self._url(line_id, take_id, "/audio")).status_code, 404)
            self.assertEqual(self.client.get(self._url(line_id, take_id, "/peaks")).status_code, 404)
            self.assertEqual(self.client.post(self._url(line_id, take_id, "/noise_reduction"),
                                              json={"noise_reduction": True}).status_code, 404)
        self.assertIn("t99999", room.takes)

    def test_noise_reduction_switch_acts_on_one_take(self):
        room = self._room()
        self._upload("t1000", 300)
        self._upload("t1000", 600)
        older, newest = room.line_entry("t1000")["takes"]
        newest["audio_version"] = 1
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            with mock.patch.object(audio_processor, "apply_noise_reduction",
                                   side_effect=lambda src, dst, *a, **k: shutil.copy2(src, dst)):
                res = self.client.post(self._url("t1000", newest["take_id"], "/noise_reduction"),
                                       json={"noise_reduction": True})
            msg = self._until(ws, "take_params_updated")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(newest["noise_reduction"])
        self.assertFalse(older["noise_reduction"])
        self.assertGreater(newest["audio_version"], 1)
        url = res.json()["take"]["url"]
        self.assertTrue(url.endswith(f"/takes/{newest['take_id']}/audio?v={newest['audio_version']}"))
        self.assertEqual(msg["payload"], {"line_id": "t1000", "take_id": newest["take_id"],
                                          "url": url, "noise_reduction": True})

    def test_socket_edits_one_take_by_id(self):
        room = self._room()
        self._upload("t1000", 300)
        self._upload("t1000", 600)
        older, newest = room.line_entry("t1000")["takes"]
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            ws.send_json({"type": "update_take_params",
                          "payload": {"line_id": "t1000", "take_id": older["take_id"], "offset_ms": 80}})
            msg = self._until(ws, "take_params_updated")
            self.assertEqual(msg["payload"], {"line_id": "t1000", "take_id": older["take_id"]})
            # An old tab's index-keyed messages change nothing.
            ws.send_json({"type": "update_take_params", "payload": {"line_index": 0, "offset_ms": 5}})
            ws.send_json({"type": "clear_take", "payload": {"line_index": 0}})
            ws.send_json({"type": "update_take_params",
                          "payload": {"line_id": "t1000", "take_id": newest["take_id"], "gain_db": -2.0}})
            msg = self._until(ws, "take_params_updated")
        self.assertEqual(msg["payload"]["take_id"], newest["take_id"])
        self.assertEqual((older["offset_ms"], newest["offset_ms"]), (80, 0))
        self.assertEqual(newest["gain_db"], -2.0)
        self.assertEqual(len(room.line_entry("t1000")["takes"]), 2)

    def test_audio_route_serves_migrated_take(self):
        active = self._wav(os.path.join(self.room_dir, "take_line_0.wav"), 300)
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump({"room_id": self.ROOM, "pack_id": self.PACK_ID, "host_id": "hostT", "users": {},
                       "role_assignments": {}, "status": "lobby", "exported_video_path": None,
                       "takes": {"0": {"user_id": "hostT", "user_name": "Ana", "duration": 0.25,
                                       "wav_path": os.path.join(self.room_dir, "take_line_0.wav"),
                                       "url": "/old", "offset_ms": 0, "noise_reduction": False,
                                       "recorded_at": self.PACK_MTIME + 60}}}, f)
        self._reload()
        res = self.client.get(self._url("t1000", "take1", "/audio"))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, active)

    def test_project_manifest_names_line_and_take(self):
        room = self._room()
        self._upload("t3000", 300)
        self.pack.ensure_web_ready = lambda: None  # no scene video in this pack
        zip_path = audio_processor.build_project_zip(
            self.pack, room.mix_takes(), output_zip_path=os.path.join(self.cache, "p.zip"), room_id=self.ROOM)
        with zipfile.ZipFile(zip_path) as zf:
            name = next(n for n in zf.namelist() if n.endswith("project_manifest.json"))
            lines = json.loads(zf.read(name))["lines"]
        self.assertEqual([l["line_id"] for l in lines], ["t1000", "t3000", "t5000"])
        self.assertEqual([l["take_id"] for l in lines], [None, room.picked_take("t3000")["take_id"], None])


if __name__ == "__main__":
    unittest.main()
