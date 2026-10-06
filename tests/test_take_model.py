import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
import pack_loader
from dubmate import packs_cache, rooms


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

    def test_migrate_moves_every_variant_byte_identically(self):
        key_suffix = os.path.basename(audio_processor.denoised_take_path(self.room_dir, "take_line_0"))[len("take_line_0"):-4]
        before = self._legacy(0, "", "_raw", key_suffix, "_denoised")
        other = self._legacy(10, "", "_raw")
        result = audio_processor.migrate_legacy_take_files(self.ROOM, 0, "t1000", "take1", True)
        self.assertEqual(result, {"has_audio": True, "has_raw": True, "noise_reduction": True})
        d = os.path.join(self.room_dir, "takes", "t1000")
        for suffix, data in before.items():
            self.assertEqual(self._read(os.path.join(d, f"take1{suffix}.wav")), data)
            self.assertFalse(os.path.exists(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")))
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


class RoomCase(unittest.TestCase):
    """Own cache dir, an empty room table and a synthetic 3-line pack in the registry, so
    load_persisted_rooms() (which prunes every room folder but the newest) only sees this case."""

    ROOM = "TMROOM"
    PACK_ID = "take_model_pack"

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
        self.assertNotIn("0", room.to_state_dict()["takes"])
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
        self.assertEqual(set(room.to_state_dict()["takes"]), {"0"})
        room._sync_save_to_disk()
        self.assertIn("t99999", self._reload().takes)

    def test_state_keeps_todays_wire_format(self):
        room = self._room()
        self._add(room, "t3000", 300, audio_version=1234, noise_reduction=True)
        wire = room.to_state_dict()["takes"]["1"]
        self.assertEqual(wire["url"], f"/api/rooms/{self.ROOM}/takes/1/audio?v=k300-1234")
        self.assertTrue(wire["noise_reduction"])
        self.assertNotIn("take_id", wire)

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
            self.assertFalse(os.path.exists(os.path.join(self.room_dir, f"take_line_0{suffix}.wav")))
        self.assertEqual(self._read(os.path.join(self.room_dir, "takes", "t3000", "take1.wav")), line1)
        self.assertFalse(os.path.exists(os.path.join(self.room_dir, "take_line_1.wav")))
        self.assertEqual(self._read(os.path.join(self.room_dir, "take_line_7.wav")), line7)

        saved = self._load_state()
        self.assertEqual(saved["state_version"], 2)
        self.assertEqual(saved["takes"], json.loads(json.dumps(room.takes)))
        self.assertEqual(room.to_state_dict()["takes"]["0"]["url"],
                         f"/api/rooms/{self.ROOM}/takes/0/audio?v=take1-{take0['audio_version']}")

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


class TestTakeRoutes(RoomCase):
    @classmethod
    def setUpClass(cls):
        import app
        from starlette.testclient import TestClient
        cls.client = TestClient(app.app)

    def _upload(self, line_index, freq, **form):
        data = {"user_id": "hostT", "user_name": "Ana", "noise_reduction": "false"}
        data.update(form)
        audio = self._wav(os.path.join(self.cache, f"upload_{freq}.wav"), freq, seconds=0.5)
        res = self.client.post(f"/api/rooms/{self.ROOM}/takes/{line_index}",
                               files={"file": ("take.wav", audio, "audio/wav")}, data=data)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["take"]

    def test_recording_twice_keeps_both_takes_and_serves_newest(self):
        room = self._room()
        first = self._upload(0, 300)
        second = self._upload(0, 600, offset_ms="25")
        entry = room.line_entry("t1000")
        self.assertEqual([t["number"] for t in entry["takes"]], [1, 2])
        newest = entry["takes"][1]
        self.assertEqual(entry["picked"], newest["take_id"])
        self.assertNotEqual(first["url"], second["url"])
        self.assertIn(f"v={newest['take_id']}-", second["url"])
        self.assertEqual(room.to_state_dict()["takes"]["0"]["url"], second["url"])
        self.assertEqual(room.to_state_dict()["takes"]["0"]["offset_ms"], 25)
        for take in entry["takes"]:
            self.assertTrue(os.path.isfile(audio_processor.take_wav_path(self.ROOM, "t1000", take["take_id"])))
        self.assertEqual([n for n in os.listdir(self.room_dir) if n.startswith("take_line")], [])

        res = self.client.get(second["url"])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, self._read(audio_processor.take_wav_path(self.ROOM, "t1000", newest["take_id"])))
        self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}/takes/1/audio").status_code, 404)
        self.assertEqual(self.client.get(f"/api/rooms/{self.ROOM}/takes/9/peaks").status_code, 404)

    def test_noise_reduction_switch_acts_on_picked_take(self):
        room = self._room()
        self._upload(0, 300)
        self._upload(0, 600)
        older, newest = room.line_entry("t1000")["takes"]
        newest["audio_version"] = 1
        with mock.patch.object(audio_processor, "apply_noise_reduction",
                               side_effect=lambda src, dst, *a, **k: shutil.copy2(src, dst)):
            res = self.client.post(f"/api/rooms/{self.ROOM}/takes/0/noise_reduction", json={"noise_reduction": True})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(newest["noise_reduction"])
        self.assertFalse(older["noise_reduction"])
        self.assertGreater(newest["audio_version"], 1)
        self.assertIn(f"v={newest['take_id']}-{newest['audio_version']}", res.json()["take"]["url"])

    def test_socket_edits_and_deletes_the_picked_take(self):
        room = self._room()
        self._upload(0, 300)
        self._upload(0, 600)
        older, newest = room.line_entry("t1000")["takes"]
        with self.client.websocket_connect(f"/ws/{self.ROOM}/hostT") as ws:
            ws.send_json({"type": "update_take_params", "payload": {"line_index": 0, "offset_ms": 80}})
            while ws.receive_json()["type"] != "take_params_updated":
                pass
            self.assertEqual(newest["offset_ms"], 80)
            self.assertEqual(older["offset_ms"], 0)
            ws.send_json({"type": "clear_take", "payload": {"line_index": 0}})
            while (msg := ws.receive_json())["type"] != "take_cleared":
                pass
        self.assertEqual(msg["payload"], {"line_index": 0})
        self.assertEqual(room.picked_take("t1000"), older)
        self.assertFalse(os.path.exists(audio_processor.take_wav_path(self.ROOM, "t1000", newest["take_id"])))
        self.assertEqual(msg["state"]["takes"]["0"]["url"], room.wire_take(0, older)["url"])

    def test_audio_route_serves_migrated_take(self):
        active = self._wav(os.path.join(self.room_dir, "take_line_0.wav"), 300)
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump({"room_id": self.ROOM, "pack_id": self.PACK_ID, "host_id": "hostT", "users": {},
                       "role_assignments": {}, "status": "lobby", "exported_video_path": None,
                       "takes": {"0": {"user_id": "hostT", "user_name": "Ana", "duration": 0.25,
                                       "wav_path": os.path.join(self.room_dir, "take_line_0.wav"),
                                       "url": "/old", "offset_ms": 0, "noise_reduction": False}}}, f)
        self._reload()
        res = self.client.get(f"/api/rooms/{self.ROOM}/takes/0/audio")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, active)

    def test_project_manifest_names_line_and_take(self):
        room = self._room()
        self._upload(1, 300)
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
