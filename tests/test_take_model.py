import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
import pack_loader


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


if __name__ == "__main__":
    unittest.main()
