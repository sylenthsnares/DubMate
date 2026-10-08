# -*- coding: utf-8 -*-
"""
test_render_cache.py
The voice chain render cache (audio_processor.render_take_cached) and the export path
that goes through it (_render_take): keys, hits, locks, the Windows file-lock fallback,
eviction, the effects-missing error, the upload level and the sound of migrated takes.
See documentation/design/effects-rack.md, "Rendering" and "Export, render, premiere and
project ZIP".
"""

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
import zipfile
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
from dubmate import rooms, rooms_api, vocal_chain
from test_recording_timing import UploadCase, speech_like

SR = audio_processor.SR


def _tone(seconds=1.0, freq=330.0, amp=0.3):
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class RenderCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dm_render_cache_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.render_dir = os.path.join(self.tmp, "renders")
        self.take = os.path.join(self.tmp, "take.wav")
        audio_processor.write_wav_mono(self.take, _tone())

    def _counting_render(self, delay=0.0):
        """Patches vocal_chain.render with a wrapper that counts its calls."""
        real = vocal_chain.render
        calls = []

        def render(*args, **kwargs):
            calls.append(1)
            if delay:
                time.sleep(delay)
            return real(*args, **kwargs)

        patcher = mock.patch.object(vocal_chain, "render", side_effect=render)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def _names(self):
        return sorted(os.listdir(self.render_dir))


class TestRenderKey(RenderCase):
    def test_same_take_and_chain_give_the_same_file(self):
        first, info = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir,
                                                         meta={"line_id": "t1000", "take_id": "k1"})
        second, _ = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        self.assertEqual(first, second)
        key = os.path.basename(first)[:-4]
        self.assertRegex(key, r"^[0-9a-f]{16}$")
        self.assertEqual(self._names(), [key + ".json", key + ".wav"])
        with open(os.path.join(self.render_dir, key + ".json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), info)
        self.assertEqual((info["line_id"], info["take_id"]), ("t1000", "k1"))
        self.assertAlmostEqual(info["duration"], 1.0, places=3)
        self.assertIn("lufs", info)
        self.assertIn("peak_db", info)

    def test_second_call_is_a_hit(self):
        calls = self._counting_render()
        path, _ = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        os.utime(path, (time.time() - 3600, time.time() - 3600))
        before = os.path.getmtime(path)
        audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        self.assertEqual(len(calls), 1)
        self.assertGreater(os.path.getmtime(path), before, "a hit marks the render as recently used")

    def test_chain_change_gives_a_new_key(self):
        a = audio_processor.render_key(self.take, vocal_chain.CLEAN)
        b = audio_processor.render_key(self.take, vocal_chain.chain_from_legacy(0, 0.3))
        c = audio_processor.render_key(self.take, vocal_chain.PRESETS["radio"]["chain"])
        self.assertEqual(len({a, b, c}), 3)

    def test_preset_label_is_not_in_the_key(self):
        warm = vocal_chain.PRESETS["warm"]["chain"]
        unlabelled = dict(warm, preset=None)
        self.assertEqual(audio_processor.render_key(self.take, warm), audio_processor.render_key(self.take, unlabelled))

    def test_file_change_gives_a_new_key(self):
        before = audio_processor.render_key(self.take, vocal_chain.CLEAN)
        audio_processor.write_wav_mono(self.take, _tone(freq=440.0))
        later = time.time() + 5
        os.utime(self.take, (later, later))
        self.assertNotEqual(audio_processor.render_key(self.take, vocal_chain.CLEAN), before)

    def test_prefix_render_has_its_own_key(self):
        full, full_info = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        prefix, info = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir, until_s=0.5)
        self.assertNotEqual(full, prefix)
        self.assertNotEqual(audio_processor.render_key(self.take, vocal_chain.CLEAN, 500),
                            audio_processor.render_key(self.take, vocal_chain.CLEAN, 600))
        self.assertAlmostEqual(info["duration"], 0.5, places=3)
        self.assertNotIn("lufs", info)
        self.assertIn("lufs", full_info)
        # The prefix is the start of the full render.
        np.testing.assert_array_equal(audio_processor.read_wav_mono(prefix),
                                      audio_processor.read_wav_mono(full)[:int(0.5 * SR)])


class TestConcurrencyAndLocks(RenderCase):
    def test_replace_blocked_by_another_program_uses_the_existing_file(self):
        path, _ = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        with open(path, "rb") as fh:
            original = fh.read()
        os.remove(path[:-4] + ".json")  # forces a render onto an existing .wav
        real_replace = os.replace

        def replace(src, dst):
            if str(dst).endswith(".wav"):
                raise PermissionError(13, "The process cannot access the file", dst)
            return real_replace(src, dst)

        with mock.patch("os.replace", side_effect=replace):
            again, info = audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        self.assertEqual(again, path)
        self.assertAlmostEqual(info["duration"], 1.0, places=3)
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), original)
        self.assertFalse([n for n in self._names() if n.endswith(".tmp")], "no temp file is left behind")

    def test_replace_error_without_a_target_is_raised(self):
        def replace(src, dst):
            raise PermissionError(13, "denied", dst)

        with mock.patch("os.replace", side_effect=replace):
            with self.assertRaises(PermissionError):
                audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        self.assertFalse([n for n in self._names() if n.endswith(".tmp")])

    def test_two_threads_on_one_key_render_once(self):
        calls = self._counting_render(delay=0.3)
        barrier = threading.Barrier(2)
        results, errors = [], []

        def work():
            try:
                barrier.wait()
                results.append(audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)[0])
            except Exception as ex:  # pragma: no cover - reported below
                errors.append(ex)

        threads = [threading.Thread(target=work) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(len(results), 2)


class TestEviction(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dm_render_evict_")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def _file(self, name, age_s, size=1000):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(b"\0" * size)
        stamp = time.time() - age_s
        os.utime(path, (stamp, stamp))
        return path

    def test_oldest_go_first_and_recent_files_stay(self):
        oldest = self._file("a.wav", 7200)
        older = self._file("b.wav", 3600)
        old = self._file("c.wav", 1800)
        recent = self._file("d.wav", 60)
        newest = self._file("e.wav", 1)
        audio_processor._evict_renders(self.dir, max_bytes=3000)
        self.assertFalse(os.path.exists(oldest))
        self.assertFalse(os.path.exists(older))
        self.assertTrue(os.path.exists(old))
        self.assertTrue(os.path.exists(recent))
        self.assertTrue(os.path.exists(newest))

    def test_recent_files_are_kept_even_over_the_cap(self):
        files = [self._file(f"{n}.wav", 30 + n) for n in range(4)]
        audio_processor._evict_renders(self.dir, max_bytes=100)
        self.assertTrue(all(os.path.exists(f) for f in files))

    def test_files_that_cannot_be_deleted_are_skipped(self):
        locked = self._file("a.wav", 7200)
        free = self._file("b.wav", 3600)
        self._file("c.wav", 1)
        real_remove = os.remove

        def remove(path):
            if os.path.basename(path) == "a.wav":
                raise PermissionError(13, "in use", path)
            return real_remove(path)

        with mock.patch("os.remove", side_effect=remove):
            audio_processor._evict_renders(self.dir, max_bytes=1500)
        self.assertTrue(os.path.exists(locked))
        self.assertFalse(os.path.exists(free))

    def test_a_file_already_gone_is_skipped(self):
        self._file("a.wav", 7200)
        b = self._file("b.wav", 3600)
        real_remove = os.remove

        def remove(path):
            if os.path.basename(path) == "a.wav":
                real_remove(path)
                raise FileNotFoundError(2, "gone", path)
            return real_remove(path)

        with mock.patch("os.remove", side_effect=remove):
            audio_processor._evict_renders(self.dir, max_bytes=500)
        self.assertFalse(os.path.exists(b))

    def test_stale_temp_files_are_removed(self):
        stale = self._file("k.1.2.tmp", 2 * 3600)
        fresh = self._file("k.3.4.tmp", 60)
        audio_processor._evict_renders(self.dir, audio_processor.RENDER_CACHE_MAX_BYTES)
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(fresh))

    def test_render_evicts_after_writing(self):
        tmp = tempfile.mkdtemp(prefix="dm_render_evict_take_")
        self.addCleanup(shutil.rmtree, tmp, True)
        take = os.path.join(tmp, "take.wav")
        audio_processor.write_wav_mono(take, _tone())
        old = self._file("0000000000000000.wav", 7200, size=5000)
        with mock.patch.object(audio_processor, "RENDER_CACHE_MAX_BYTES", 50 * 1024):
            audio_processor.render_take_cached(take, vocal_chain.CLEAN, self.dir)
        self.assertFalse(os.path.exists(old))


class TestEffectsUnavailable(RenderCase):
    def test_render_raises_when_effects_are_missing(self):
        with mock.patch.object(vocal_chain, "available", return_value=False):
            with self.assertRaises(audio_processor.EffectsUnavailable) as caught:
                audio_processor.render_take_cached(self.take, vocal_chain.CLEAN, self.render_dir)
        self.assertEqual(str(caught.exception),
                         "Voice effects need the DubMate 2.0 installer. "
                         "Get it from github.com/sylenthsnares/DubMate/releases.")
        self.assertFalse(os.path.exists(self.render_dir))

    def test_export_path_saves_the_take_without_its_effects(self):
        take = {"wav_path": self.take, "render_dir": self.render_dir, "chain": vocal_chain.chain_from_legacy(0, 0.3)}
        with mock.patch.object(vocal_chain, "available", return_value=False):
            audio = audio_processor._render_take(take, SR, -6.0, "test")
        np.testing.assert_array_equal(audio, audio_processor.read_wav_mono(self.take, SR) * np.float32(10 ** (-6.0 / 20)))
        self.assertFalse(os.path.exists(self.render_dir))

    def test_upload_level_falls_back_without_effects(self):
        cache = tempfile.mkdtemp(prefix="dm_render_level_")
        self.addCleanup(shutil.rmtree, cache, True)
        room = types.SimpleNamespace(room_id="RENDER_LEVEL_ROOM")
        with mock.patch.object(audio_processor, "CACHE_DIR", cache):
            level = rooms_api._render_level(room, "t1000", "k1", self.take, vocal_chain.CLEAN, -21.0)
            with mock.patch.object(vocal_chain, "available", return_value=False):
                self.assertIsNone(rooms_api._render_level(room, "t1000", "k1", self.take, vocal_chain.CLEAN, -21.0))
            render = audio_processor.read_wav_mono(audio_processor.render_take_cached(
                self.take, vocal_chain.CLEAN, audio_processor.room_render_dir(room.room_id))[0])
        self.assertEqual(set(level), {"loudness_lufs", "target_lufs", "auto_gain_db"})
        self.assertAlmostEqual(level["loudness_lufs"], audio_processor.integrated_lufs(render), delta=0.05)


class TestExportThroughTheChain(RenderCase):
    def test_level_multiplies_the_render(self):
        take = {"wav_path": self.take, "render_dir": self.render_dir, "chain": vocal_chain.chain_from_legacy(-3.0, 0.0)}
        unity = audio_processor._render_take(take, SR, 0.0, "test")
        louder = audio_processor._render_take(take, SR, 6.0, "test")
        np.testing.assert_allclose(louder, unity * np.float32(10 ** (6.0 / 20.0)), rtol=1e-5, atol=1e-7)
        rendered = audio_processor.read_wav_mono(audio_processor.render_take_cached(
            self.take, vocal_chain.chain_from_legacy(-3.0, 0.0), self.render_dir)[0])
        np.testing.assert_array_equal(unity, rendered)

    def test_hot_take_through_a_boosting_chain_is_not_clipped_before_its_level(self):
        """A render louder than full scale keeps its peaks in the cached file, so a negative
        Level (the mix here, the browser's GainNode in preview) brings it back undistorted."""
        hot = os.path.join(self.tmp, "hot.wav")
        audio_processor.write_wav_mono(hot, _tone(freq=1000.0, amp=0.8))
        chain = vocal_chain._chain(None, eq={"on": True, "mid_db": 12.0, "mid_hz": 1000.0})
        path, info = audio_processor.render_take_cached(hot, chain, self.render_dir)
        expected = vocal_chain.render(audio_processor.read_wav_mono(hot), chain, SR)
        self.assertGreater(float(np.max(np.abs(expected))), 2.0)   # the chain drives it well past full scale
        self.assertGreater(info["peak_db"], 6.0)
        np.testing.assert_allclose(audio_processor.read_wav_mono(path), expected, rtol=1e-6, atol=1e-7)

        take = {"wav_path": hot, "render_dir": self.render_dir, "chain": chain}
        out = audio_processor._render_take(take, SR, -12.0, "test")
        np.testing.assert_allclose(out, expected * np.float32(10 ** (-12.0 / 20.0)), rtol=1e-5, atol=1e-6)
        self.assertLess(float(np.max(np.abs(out))), 1.0)

    def test_float_render_file_reads_back_exactly(self):
        path = os.path.join(self.tmp, "float.wav")
        data = np.array([0.0, 1.5, -2.25, 0.125, -0.5], dtype=np.float32)
        audio_processor.write_wav_float(path, data)
        np.testing.assert_array_equal(audio_processor.read_wav_mono(path), data)
        self.assertIsNone(audio_processor._read_wav_float_direct(self.take, SR))   # 16-bit take: not this reader

    def test_take_chain_reads_the_resolved_chain_only(self):
        """The mix entry's chain is resolved by Room.mix_takes; the old pitch / reverb fields
        are not read here any more (a migrated take carries them in its chain)."""
        radio = vocal_chain.PRESETS["radio"]["chain"]
        self.assertEqual(audio_processor.take_chain({"chain": radio, "pitch_semitones": 4}), vocal_chain.normalize_chain(radio))
        self.assertEqual(audio_processor.take_chain({"pitch_semitones": 4, "reverb_wet": 0.3}), vocal_chain.CLEAN)
        self.assertEqual(audio_processor.take_chain({})["preset"], "clean")

    def test_cue_sheet_names_the_sound(self):
        pack = types.SimpleNamespace(name="Scene", pack_id="scene", duration=4.0, lines=[{}, {}])
        entry = {"line_number": 1, "start": 0.0, "end": 1.0, "character": "Ana", "is_recorded": True,
                 "actor_name": "Ana", "text": "Hi", "offset_ms": 0, "gain_db": 0.0, "take_file": "x.mp3"}
        text = audio_processor._project_cue_sheet(pack, "ROOM", SR, "192k", [
            dict(entry, chain=vocal_chain.PRESETS["warm"]["chain"]),
            dict(entry, line_number=2, chain=vocal_chain.chain_from_legacy(2, 0.3)),
        ])
        self.assertIn("| Sound: Warm |", text)
        self.assertIn("| Sound: Custom |", text)
        self.assertNotIn("Pitch:", text)

    def test_migrated_reverb_take_sounds_like_the_old_export(self):
        """A reverb-only take from before the rack, rendered through its migrated chain, is
        within -35 dB RMS of the old export formula (ffmpeg highpass=f=80, then the take plus
        0.7 x reverb_wet x the room impulse) on a 1 kHz burst-and-noise signal."""
        rng = np.random.default_rng(7)
        n = 2 * SR
        t = np.arange(n) / SR
        bursts = ((t % 0.5) < 0.25).astype(np.float32)
        signal = (0.3 * np.sin(2 * np.pi * 1000 * t) * bursts + 0.02 * rng.standard_normal(n)).astype(np.float32)
        audio_processor.write_wav_mono(self.take, signal)
        wet = 0.4

        filtered_path = os.path.join(self.tmp, "old_highpass.wav")
        audio_processor._ffmpeg_to_mono_wav(self.take, filtered_path, SR, 60, "old export low cut", af="highpass=f=80")
        filtered = audio_processor.read_wav_mono(filtered_path)
        conv = vocal_chain._fft_convolve(filtered, vocal_chain.get_reverb_impulse(1.5, SR))
        old = np.zeros(len(conv), dtype=np.float32)
        old[:len(filtered)] = filtered
        old += conv * np.float32(wet * 0.7)

        take = {"wav_path": self.take, "render_dir": self.render_dir, "pitch_semitones": 0.0, "reverb_wet": wet}
        rooms._legacy_take_chain(take)  # what loading the old room adds
        new = audio_processor._render_take(take, SR, 0.0, "test")
        m = min(len(old), len(new))
        self.assertGreaterEqual(len(new), len(old) - 1)
        diff_db = 20 * np.log10(np.sqrt(np.mean((new[:m] - old[:m]) ** 2)) / np.sqrt(np.mean(old[:m] ** 2)))
        self.assertLess(diff_db, -35.0, f"migrated take differs by {diff_db:.1f} dB RMS")


class TestRoomRoutes(UploadCase):
    """Upload levels, the project ZIP and exports through the room's render cache."""

    def _zip(self):
        res = self.client.get(f"/api/rooms/{self.ROOM}/export/project_zip?user_id=hostT")
        self.assertEqual(res.status_code, 200, res.text)
        with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
            manifest = json.loads(zf.read(next(n for n in zf.namelist() if n.endswith("project_manifest.json"))))
            cues = zf.read(next(n for n in zf.namelist() if n.endswith("Timeline_Cues.txt"))).decode("utf-8")
        return manifest, cues

    def test_upload_is_levelled_on_its_render(self):
        room = self._room()
        take = self._upload("t1000", speech_like(duration=2.0, lead=0.3), reverb_wet=0.3, auto_gain="true")
        chain = vocal_chain.chain_from_legacy(0, 0.3)
        path, _ = audio_processor.render_take_cached(
            audio_processor.take_wav_path(self.ROOM, "t1000", take["take_id"]), chain,
            audio_processor.room_render_dir(self.ROOM))
        expected = audio_processor.calculate_take_auto_gain(path, target_lufs=take["target_lufs"])
        self.assertEqual(take["loudness_lufs"], expected["loudness_lufs"])
        self.assertEqual(take["auto_gain_db"], expected["auto_gain_db"])
        self.assertEqual(take["gain_db"], expected["auto_gain_db"])
        self.assertEqual(room.mix_takes()[0]["render_dir"], audio_processor.room_render_dir(self.ROOM))
        self.assertEqual(room.mix_takes()[0]["line_id"], "t1000")

    def test_upload_without_effects_is_levelled_on_the_take(self):
        self._room()
        with mock.patch.object(vocal_chain, "available", return_value=False):
            take = self._upload("t1000", speech_like(duration=2.0, lead=0.3), auto_gain="true")
        self.assertNotIn("loudness_lufs", take)
        raw = audio_processor.calculate_take_auto_gain(
            audio_processor.take_wav_path(self.ROOM, "t1000", take["take_id"]), target_lufs=take["target_lufs"])
        self.assertEqual(take["auto_gain_db"], raw["auto_gain_db"])
        self.assertEqual(take["gain_db"], raw["auto_gain_db"])

    def test_project_zip_lists_each_line_chain(self):
        self._room()
        self._upload("t1000", speech_like(duration=2.0, lead=0.3), pitch_semitones=2, reverb_wet=0.3)
        self._upload("t3000", speech_like(duration=1.0, lead=0.1))
        manifest, cues = self._zip()
        lines = {l["line_id"]: l for l in manifest["lines"]}
        self.assertEqual(lines["t1000"]["chain"], vocal_chain.chain_from_legacy(2, 0.3))
        self.assertEqual((lines["t1000"]["pitch_semitones"], lines["t1000"]["reverb_wet"]), (2.0, 0.3))
        self.assertEqual(lines["t3000"]["chain"]["preset"], "clean")
        self.assertEqual((lines["t3000"]["pitch_semitones"], lines["t3000"]["reverb_wet"]), (0.0, 0.0))
        self.assertIsNone(lines["t5000"]["chain"])
        self.assertIn("| Sound: Custom |", cues)
        self.assertIn("| Sound: Clean |", cues)

    def test_project_zip_saves_without_effects_and_says_so(self):
        self._room()
        self._upload("t1000", speech_like(duration=1.0, lead=0.1), reverb_wet=0.3)
        with mock.patch.object(vocal_chain, "available", return_value=False):
            manifest, cues = self._zip()
        self.assertEqual(manifest["version"], "2.3")
        self.assertIs(manifest["master"]["voice_effects"], False)
        self.assertIn("| Sound: none (voice effects not installed) |", cues)
        self.assertNotIn("| Sound: Custom |", cues)


if __name__ == "__main__":
    unittest.main()
