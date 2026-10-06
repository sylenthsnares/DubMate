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


if __name__ == "__main__":
    unittest.main()
