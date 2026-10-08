# -*- coding: utf-8 -*-
"""
test_stems_export.py
Stems export (documentation/design/stems-export.md): the scene mix split into buses
(_mix_buses, _mix_scene on top of it), the stems zip (build_stems_zip) and its route
(GET /api/rooms/{room}/export/stems), which holds export_status["stems"] until the file is sent.
Renders are mocked as the take itself (the voice chain is covered by test_vocal_chain.py);
the fitted take goes through the real take fitting.
"""

import asyncio
import contextlib
import io
import json
import os
import shutil
import struct
import tempfile
import unittest
import zipfile
from unittest import mock

import numpy as np

# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

import audio_processor
import test_effects_rack
from dubmate import common, rooms_api, vocal_chain
from pack_loader import PackInfo
from test_take_model import RoomCase

SR = 44100


def _speech(seconds, seed, level=0.2):
    """Voiced bursts: a few harmonics of a gliding pitch, gated on and off."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / SR
    x = sum(np.sin(k * phase) / k for k in (1, 2, 3, 5))
    gate = np.repeat(rng.random(n // 4410 + 1) > 0.25, 4410)[:n]
    return (level * x * gate).astype(np.float32)


def _clap(peak_dbfs, seed=3):
    rng = np.random.default_rng(seed)
    n = int(0.025 * SR)
    burst = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.006 * SR))
    return (burst / np.max(np.abs(burst)) * 10 ** (peak_dbfs / 20)).astype(np.float32)


def _identity_render(wav_path, chain, render_dir, until_s=None, meta=None):
    return wav_path, {}


def _gain(mix):
    """The master stage's start gain, worked out independently of build_stems_zip."""
    return 10 ** (audio_processor._master_gain_db(audio_processor.integrated_lufs(mix, SR)) / 20)


class StemsCase(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dubmate_stems_test_")
        patcher = mock.patch.object(audio_processor, "render_take_cached", side_effect=_identity_render)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.dir, True)

    def _wav(self, name, audio):
        path = os.path.join(self.dir, name)
        audio_processor.write_wav_float(path, audio, SR)
        return path

    def _pack(self, lines, backing=None, name="Test Pack", duration=7.0, originals=True):
        """lines: (character, start, end) tuples. Each line gets an original voice unless originals is False."""
        folder = os.path.join(self.dir, "pack_" + str(len(os.listdir(self.dir))))
        os.makedirs(folder)
        pack = PackInfo("test_pack", folder, name)
        pack.duration = duration
        for i, (char, start, end) in enumerate(lines):
            fname = f"{i + 1:02d}_line.wav"
            if originals:
                audio_processor.write_wav_mono(os.path.join(folder, fname), _speech(end - start, 100 + i), SR)
            pack.lines.append({"index": i, "line_id": f"l{i}", "character": char,
                               "start": start, "end": end, "filename": fname})
        if backing is not None:
            pack.backing_track_path = os.path.join(folder, "backing.wav")
            audio_processor.write_wav_float(pack.backing_track_path, backing, SR)
        return pack

    def _take(self, name, audio, offset_ms=0, gain_db=0.0, **extra):
        info = {"wav_path": self._wav(name, audio), "render_dir": os.path.join(self.dir, "renders"),
                "offset_ms": offset_ms, "gain_db": gain_db}
        info.update(extra)
        return info

    def _scene(self):
        """Alice (negative offset at the scene start, then a fitted take), Bob (positive offset,
        then an unrecorded line) over a backing track."""
        pack = self._pack([("Alice", 0.0, 1.5), ("Bob", 2.0, 3.5), ("Alice", 4.0, 5.0), ("Bob", 5.5, 6.5)],
                          backing=_speech(7.0, 9, level=0.3))
        fitted = os.path.join(self.dir, "fitted.wav")
        source = os.path.join(self.dir, "fitted_source.wav")
        audio_processor.write_wav_mono(source, _speech(1.2, 3), SR)
        audio_processor._write_active_take(source, fitted, stretch=1.25)
        takes = {
            0: self._take("t0.wav", _speech(1.4, 1), offset_ms=-300),
            1: self._take("t1.wav", _speech(1.3, 2), offset_ms=250, gain_db=3.0),
            2: {"wav_path": fitted, "render_dir": os.path.join(self.dir, "renders"),
                "offset_ms": 120, "gain_db": -2.0, "stretch": 1.25},
        }
        return pack, takes

    def _build(self, pack, takes, presence_db=0.0, room_id="ROOM1"):
        """Builds the zip and returns {path inside the root folder: (audio, raw bytes)}."""
        out = os.path.join(self.dir, "out", f"stems_{presence_db}.zip")
        self.assertEqual(audio_processor.build_stems_zip(pack, takes, out, presence_db=presence_db,
                                                         room_id=room_id), out)
        files = {}
        with zipfile.ZipFile(out) as zf:
            for zi in zf.infolist():
                self.assertEqual(zi.compress_type, zipfile.ZIP_STORED)
                root, _, rel = zi.filename.partition("/")
                self.assertEqual(root, f"DubMate_Stems_{audio_processor.sanitize_filename(pack.name)}_{room_id}")
                path = os.path.join(self.dir, "read", rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(zf.read(zi))
                files[rel] = (audio_processor.read_wav_mono(path, SR), zf.read(zi))
        return files


class TestMixBuses(StemsCase):

    def test_j_mix_scene_is_the_sum_of_the_buses(self):
        pack, takes = self._scene()
        for presence in (0.0, 3.0):
            mix = audio_processor._mix_scene(pack, takes, SR, presence_db=presence)
            backing, voices = audio_processor._mix_buses(pack, takes, SR, presence)
            self.assertEqual(list(voices), ["dialogue"])
            np.testing.assert_array_equal(mix, backing + voices["dialogue"])
            backing_c, by_char = audio_processor._mix_buses(pack, takes, SR, presence, by_character=True)
            self.assertEqual(sorted(by_char), ["Alice", "Bob"])
            np.testing.assert_array_equal(backing_c, backing)
            np.testing.assert_allclose(by_char["Alice"] + by_char["Bob"], voices["dialogue"], atol=1e-6)
            for buf in (backing, *by_char.values()):
                self.assertEqual(buf.dtype, np.float32)
                self.assertEqual(len(buf), audio_processor._timeline_samples(pack, SR))


class TestStemsZip(StemsCase):

    def test_a_b_stems_sum_to_the_scene_mix_at_minus_16(self):
        pack, takes = self._scene()
        for presence in (0.0, 3.0):
            with self.subTest(presence_db=presence):
                mix = audio_processor._mix_scene(pack, takes, SR, presence_db=presence)
                g = _gain(mix)
                self.assertNotAlmostEqual(g, 1.0, places=2)
                files = self._build(pack, takes, presence)
                summed = files["Dialogue.wav"][0] + files["Music_and_Effects.wav"][0]
                np.testing.assert_allclose(summed / g, mix, atol=1e-5)
                self.assertAlmostEqual(audio_processor.integrated_lufs(summed, SR), -16.0, delta=0.05)

    def test_c_stems_keep_the_peaks_the_limiter_holds_down(self):
        backing = _speech(7.0, 9, level=0.15)
        clap = _clap(12.0)
        backing[3 * SR:3 * SR + len(clap)] += clap
        pack = self._pack([("Alice", 0.5, 2.5), ("Bob", 4.0, 6.0)], backing=backing)
        takes = {0: self._take("t0.wav", _speech(2.0, 1))}
        mix = audio_processor._mix_scene(pack, takes, SR)
        master, _ = audio_processor.master_stage(mix, SR)
        files = self._build(pack, takes)
        summed = files["Dialogue.wav"][0] + files["Music_and_Effects.wav"][0]
        self.assertAlmostEqual(audio_processor.integrated_lufs(summed, SR), -16.0, delta=0.1)
        self.assertAlmostEqual(audio_processor.integrated_lufs(master, SR), -16.0, delta=0.1)
        self.assertGreater(audio_processor.true_peak_db(summed), audio_processor.true_peak_db(master))
        self.assertGreater(audio_processor.true_peak_db(summed), audio_processor.MASTER_LIMITER_CEILING_DB)

    def test_d_every_file_is_full_length_mono_float(self):
        pack, takes = self._scene()
        files = self._build(pack, takes)
        self.assertEqual(sorted(files), ["Characters/Alice.wav", "Characters/Bob.wav",
                                         "Dialogue.wav", "Music_and_Effects.wav"])
        n = audio_processor._timeline_samples(pack, SR)
        for rel, (audio, raw) in files.items():
            with self.subTest(file=rel):
                self.assertEqual(raw[:4], b"RIFF")
                self.assertEqual(raw[8:16], b"WAVEfmt ")
                tag, channels, rate = struct.unpack("<HHI", raw[20:28])
                bits = struct.unpack("<H", raw[34:36])[0]
                self.assertEqual((tag, channels, rate, bits), (3, 1, SR, 32))
                data_at = raw.index(b"data")
                self.assertEqual(struct.unpack("<I", raw[data_at + 4:data_at + 8])[0], n * 4)
                self.assertEqual(len(audio), n)

    def test_e_takes_land_where_the_video_puts_them(self):
        pack, takes = self._scene()
        mix = audio_processor._mix_scene(pack, takes, SR)
        g = _gain(mix)
        files = self._build(pack, takes)
        dialogue = files["Dialogue.wav"][0] / g

        n = audio_processor._timeline_samples(pack, SR)
        backing = np.zeros(n, dtype=np.float32)
        raw_backing = audio_processor.read_wav_mono(pack.backing_track_path, SR) * audio_processor.BACKING_TRACK_LEVEL
        backing[:len(raw_backing)] = raw_backing
        np.testing.assert_allclose(dialogue, mix - backing, atol=1e-5)

        # Worked out by hand: line start + offset, the head cut at the scene start, the fitted length.
        expected = np.zeros(n, dtype=np.float32)
        t0 = audio_processor.read_wav_mono(takes[0]["wav_path"], SR)
        cut = int(0.3 * SR)
        expected[:len(t0) - cut] += t0[cut:]
        t1 = audio_processor.read_wav_mono(takes[1]["wav_path"], SR) * np.float32(10 ** (3 / 20))
        at = int(2.25 * SR)
        expected[at:at + len(t1)] += t1
        t2 = audio_processor.read_wav_mono(takes[2]["wav_path"], SR) * np.float32(10 ** (-2 / 20))
        self.assertAlmostEqual(len(t2) / (1.2 * SR), 1 / 1.25, delta=0.02)
        at = int((4.0 + 120 / 1000.0) * SR)
        expected[at:at + len(t2)] += t2
        orig = audio_processor.read_wav_mono(os.path.join(pack.folder, pack.lines[3]["filename"]), SR)
        at = int(5.5 * SR)
        expected[at:at + len(orig)] += orig * np.float32(audio_processor.ORIGINAL_LINE_LEVEL)
        np.testing.assert_allclose(dialogue, expected, atol=1e-5)

    def test_f_characters_add_up_to_dialogue(self):
        pack, takes = self._scene()
        files = self._build(pack, takes)
        alice, bob = files["Characters/Alice.wav"][0], files["Characters/Bob.wav"][0]
        np.testing.assert_allclose(alice + bob, files["Dialogue.wav"][0], atol=1e-6)
        # Bob's unrecorded line is his original voice, in his file and not in Alice's.
        g = _gain(audio_processor._mix_scene(pack, takes, SR))
        orig = audio_processor.read_wav_mono(os.path.join(pack.folder, pack.lines[3]["filename"]), SR)
        at = int(5.5 * SR)
        np.testing.assert_allclose(bob[at:at + len(orig)],
                                   orig * np.float32(audio_processor.ORIGINAL_LINE_LEVEL * g), atol=1e-6)
        self.assertFalse(np.any(alice[at:at + len(orig)]))

    def test_g_no_backing_and_silent_scene(self):
        pack = self._pack([("Alice", 0.5, 2.0)])
        files = self._build(pack, {})
        n = audio_processor._timeline_samples(pack, SR)
        music = files["Music_and_Effects.wav"][0]
        self.assertEqual(len(music), n)
        self.assertFalse(np.any(music))
        self.assertTrue(np.any(files["Dialogue.wav"][0]))

        silent = self._pack([("Alice", 0.5, 2.0)], originals=False)
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            files = self._build(silent, {})
        self.assertIn("+0.0 dB", log.getvalue())
        self.assertEqual(sorted(files), ["Dialogue.wav", "Music_and_Effects.wav"])
        for audio, _ in files.values():
            self.assertEqual(len(audio), n)
            self.assertFalse(np.any(audio))

    def test_h_names_that_sanitize_alike_get_their_own_file(self):
        pack = self._pack([("Dr. Who?", 0.5, 1.5), ("Dr. Who", 2.0, 3.0), ("dr. who", 3.5, 4.5)])
        files = self._build(pack, {})
        self.assertEqual(sorted(f for f in files if f.startswith("Characters/")),
                         ["Characters/Dr._Who.wav", "Characters/Dr._Who_2.wav", "Characters/dr._who_3.wav"])
        # Each holds its own line only.
        for rel, start in (("Characters/Dr._Who.wav", 0.5), ("Characters/Dr._Who_2.wav", 2.0),
                           ("Characters/dr._who_3.wav", 3.5)):
            audio = files[rel][0]
            self.assertTrue(np.any(audio[int(start * SR):int((start + 1.0) * SR)]))
            self.assertAlmostEqual(float(np.sum(np.abs(audio))),
                                   float(np.sum(np.abs(audio[int(start * SR):int((start + 1.0) * SR)]))), places=3)

    def test_i_effects_unavailable_propagates_and_leaves_nothing(self):
        pack, takes = self._scene()
        made = []
        real_mkdtemp = tempfile.mkdtemp

        def mkdtemp(*args, **kwargs):
            made.append(real_mkdtemp(*args, **kwargs))
            return made[-1]

        out = os.path.join(self.dir, "out", "stems.zip")
        with mock.patch.object(audio_processor, "_render_take", side_effect=audio_processor.EffectsUnavailable()), \
                mock.patch.object(audio_processor.tempfile, "mkdtemp", side_effect=mkdtemp):
            with self.assertRaises(audio_processor.EffectsUnavailable):
                audio_processor.build_stems_zip(pack, takes, out, room_id="ROOM1")
        self.assertFalse(os.path.exists(out))
        for path in made:
            self.assertFalse(os.path.exists(path))

    def test_i_stage_folder_is_removed_when_writing_fails(self):
        pack, takes = self._scene()
        made = []
        real_mkdtemp = tempfile.mkdtemp

        def mkdtemp(*args, **kwargs):
            made.append(real_mkdtemp(*args, **kwargs))
            return made[-1]

        with mock.patch.object(audio_processor.tempfile, "mkdtemp", side_effect=mkdtemp), \
                mock.patch.object(audio_processor.zipfile, "ZipFile", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                audio_processor.build_stems_zip(pack, takes, os.path.join(self.dir, "out", "s.zip"))
        self.assertEqual(len(made), 1)
        self.assertFalse(os.path.exists(made[0]))



BUSY = "Someone is already getting the stems. Try again in a moment."
REFRESHING = "Older takes are being refreshed. Try again in a moment."
FAILED = "Couldn't get the stems. Try again."


class StemsRouteCase(RoomCase):
    """The export folder in a temp dir; TestStemsRoute mocks renders as the take itself,
    TestOldRoomStems uses the real ones."""

    @classmethod
    def setUpClass(cls):
        import app
        from starlette.testclient import TestClient
        cls.client = TestClient(app.app)

    def setUp(self):
        super().setUp()
        self.exports = tempfile.mkdtemp(prefix="dm_stems_exports_")
        self.addCleanup(shutil.rmtree, self.exports, True)
        patcher = mock.patch.object(common, "_exports_dir", self.exports)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _identity(self):
        return mock.patch.object(audio_processor, "render_take_cached", side_effect=_identity_render)

    def _get(self, status=200):
        res = self.client.get(f"/api/rooms/{self.ROOM}/export/stems?user_id=hostT")
        self.assertEqual(res.status_code, status, res.text)
        return res

    def _stems(self, body):
        """{name inside the zip's root folder: audio}."""
        files = {}
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            for zi in zf.infolist():
                root, _, rel = zi.filename.partition("/")
                self.assertEqual(root, f"DubMate_Stems_Take_Model_Pack_{self.ROOM}")
                path = os.path.join(self.cache, "read", rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(zf.read(zi))
                files[rel] = audio_processor.read_wav_mono(path, SR)
        return files


class TestStemsRoute(StemsRouteCase):

    def setUp(self):
        super().setUp()
        self.room = self._room()
        self._add(self.room, "t1000", 300, offset_ms=40)
        self._add(self.room, "t3000", 400, gain_db=-2.0)

    def test_a_download_is_a_zip_and_the_claim_is_gone_after_it(self):
        with self._identity():
            res = self._get()
        self.assertEqual(res.headers["content-type"], "application/zip")
        self.assertIn(f'filename="DubMate_Stems_Take_Model_Pack_{self.ROOM}.zip"',
                      res.headers["content-disposition"])
        self.assertEqual(res.headers["cache-control"], "no-cache, must-revalidate")
        files = self._stems(res.content)
        self.assertIn("Dialogue.wav", files)
        self.assertIn("Music_and_Effects.wav", files)
        self.assertNotIn("stems", self.room.export_status)
        self.assertTrue(os.path.isfile(
            os.path.join(self.exports, f"DubMate_Stems_{self.PACK_ID}_{self.ROOM}.zip")))

    def test_b_refused_while_someone_gets_them_or_takes_are_refreshed(self):
        with mock.patch.object(audio_processor, "build_stems_zip") as built:
            self.room.export_status["stems"] = "processing"
            self.assertEqual(self._get(409).json()["detail"], BUSY)
            self.assertEqual(self.room.export_status["stems"], "processing")
            del self.room.export_status["stems"]
            self.room.cleanup_refreshing["u1"] = 1
            self.assertEqual(self._get(409).json()["detail"], REFRESHING)
            self.assertNotIn("stems", self.room.export_status)
        built.assert_not_called()

    def test_c_failures_release_the_claim(self):
        for error, status, detail in ((audio_processor.EffectsUnavailable("Voice effects are missing."), 503,
                                       "Voice effects are missing."),
                                      (RuntimeError("boom"), 500, FAILED)):
            with self.subTest(status=status):
                with mock.patch.object(audio_processor, "build_stems_zip", side_effect=error), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(self._get(status).json()["detail"], detail)
                self.assertNotIn("stems", self.room.export_status)

    def test_d_claim_is_held_through_the_send(self):
        scope = {"type": "http", "method": "GET", "headers": []}

        async def receive():
            return {"type": "http.request"}

        with self._identity():
            response = asyncio.run(rooms_api.download_room_stems(self.ROOM, user_id="hostT"))
        self.assertEqual(self.room.export_status.get("stems"), "processing")
        seen = []

        async def send(message):
            if message["type"] == "http.response.body":
                seen.append(self.room.export_status.get("stems"))

        asyncio.run(response(scope, receive, send))
        self.assertGreater(len(seen), 1)
        self.assertEqual(set(seen), {"processing"})
        self.assertNotIn("stems", self.room.export_status)

        with self._identity():
            response = asyncio.run(rooms_api.download_room_stems(self.ROOM, user_id="hostT"))
        self.assertEqual(self.room.export_status.get("stems"), "processing")

        async def broken_send(message):
            if message["type"] == "http.response.body":
                raise OSError("connection reset")

        with self.assertRaises(OSError):
            asyncio.run(response(scope, receive, broken_send))
        self.assertNotIn("stems", self.room.export_status)

    def test_e_room_dialogue_level_reaches_the_stems(self):
        self.room.master_dialogue_presence_db = 4.5

        def build(**kwargs):
            with open(kwargs["output_zip_path"], "wb") as fh:
                fh.write(b"PK")
            return kwargs["output_zip_path"]

        with mock.patch.object(audio_processor, "build_stems_zip", side_effect=build) as built:
            self._get()
        kwargs = built.call_args.kwargs
        self.assertEqual(kwargs["presence_db"], 4.5)
        self.assertEqual(kwargs["room_id"], self.ROOM)
        self.assertIs(kwargs["pack"], self.room.pack)
        self.assertEqual(sorted(kwargs["takes_dict"]), [0, 1])


@unittest.skipUnless(vocal_chain.available(), "pedalboard is not installed")
class TestOldRoomStems(StemsRouteCase):
    """A room saved before the effects rack (PR #14 era) exports stems with its real renders."""

    def setUp(self):
        super().setUp()
        with open(self._state_file(), "w", encoding="utf-8") as f:
            json.dump(test_effects_rack.TestRoomLoads._v2_state(self), f)
        self.room = self._reload()

    def test_f_room_from_before_the_rack_gets_its_stems(self):
        files = self._stems(self._get().content)
        self.assertNotIn("stems", self.room.export_status)
        mix = audio_processor._mix_scene(self.room.pack, self.room.mix_takes(),
                                         presence_db=self.room.master_dialogue_presence_db)
        summed = files["Dialogue.wav"] + files["Music_and_Effects.wav"]
        self.assertEqual(len(summed), len(mix))
        self.assertGreater(float(np.max(np.abs(mix))), 0.01)
        np.testing.assert_allclose(summed, mix * _gain(mix), atol=1e-5)


if __name__ == "__main__":
    unittest.main()
