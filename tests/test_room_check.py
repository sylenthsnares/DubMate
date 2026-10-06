# -*- coding: utf-8 -*-
"""
test_room_check.py
Room tone analysis (audio_processor.analyse_room_tone) and the engine-wide noise profile store.
"""

import os
import json
import shutil
import tempfile
import unittest
from unittest import mock
import numpy as np

import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor as ap

SR = 44100
SECONDS = 2.7


def _rms_db(x):
    return 10.0 * np.log10(np.mean(np.asarray(x, dtype=np.float64) ** 2))


def white(level_db, seconds=SECONDS, seed=1):
    x = np.random.default_rng(seed).standard_normal(int(SR * seconds))
    return (x * 10 ** (level_db / 20.0)).astype(np.float32)


def shaped(level_db, gain_fn, seconds=SECONDS, seed=2):
    """Noise with spectral amplitude gain_fn(freqs), scaled to level_db full band."""
    n = int(SR * seconds)
    spec = np.fft.rfft(np.random.default_rng(seed).standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    x = np.fft.irfft(spec * gain_fn(freqs), n=n)
    x *= 10 ** (level_db / 20.0) / np.sqrt(np.mean(x ** 2))
    return x.astype(np.float32)


def pink(level_db, seconds=SECONDS):
    return shaped(level_db, lambda f: 1.0 / np.sqrt(np.maximum(f, 20.0)), seconds)


def sine(freq, amp, seconds=SECONDS):
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class TestAnalyseRoomTone(unittest.TestCase):

    def test_white_noise_is_ok_with_hiss(self):
        x = white(-50.0)
        stats = ap.analyse_room_tone(x, SR)
        expected = _rms_db(x) + 10 * np.log10((8000 - 100) / (SR / 2.0))
        self.assertAlmostEqual(stats["speech_floor_db"], expected, delta=1.5)
        self.assertEqual(stats["verdict"], "ok")
        self.assertAlmostEqual(stats["full_band_db"], -50.0, delta=0.5)
        self.assertAlmostEqual(stats["hiss_db"], 0.0, delta=1.0)
        self.assertTrue(stats["hiss"])
        self.assertIsNone(stats["hum_hz"])
        self.assertEqual(stats["tones_hz"], [])
        self.assertFalse(stats["unstable"])
        self.assertFalse(stats["suppressed"])
        self.assertFalse(stats["clipped"])
        json.dumps(stats)  # JSON-safe

    def test_pink_noise_has_no_hiss(self):
        stats = ap.analyse_room_tone(pink(-45.0), SR)
        self.assertAlmostEqual(stats["hiss_db"], -10.0, delta=2.0)
        self.assertFalse(stats["hiss"])

    def test_verdict_bands(self):
        self.assertEqual(ap.analyse_room_tone(white(-70.0), SR)["verdict"], "good")
        self.assertEqual(ap.analyse_room_tone(white(-30.0), SR)["verdict"], "noisy")
        self.assertFalse(ap.analyse_room_tone(white(-70.0), SR)["hiss"])  # hiss never flagged in a good room

    def test_50hz_hum(self):
        x = white(-60.0) + sine(50, 0.01) + sine(150, 0.005)
        stats = ap.analyse_room_tone(x, SR)
        self.assertEqual(stats["hum_hz"], 50)
        self.assertIn(50.0, stats["tones_hz"])
        self.assertIn(150.0, stats["tones_hz"])
        self.assertEqual(stats["tones_hz"][0], 50.0)  # strongest first
        self.assertEqual(stats["cleanup"]["notches_hz"], stats["tones_hz"][:4])

    def test_60hz_hum(self):
        x = white(-60.0) + sine(60, 0.01) + sine(180, 0.005)
        self.assertEqual(ap.analyse_room_tone(x, SR)["hum_hz"], 60)

    def test_other_tone(self):
        x = white(-55.0) + sine(2400, 0.003)
        stats = ap.analyse_room_tone(x, SR)
        self.assertIsNone(stats["hum_hz"])
        self.assertTrue(any(abs(f - 2400) <= 2.0 for f in stats["tones_hz"]), stats["tones_hz"])

    def test_digital_silence_is_suppressed_and_not_saved(self):
        stats = ap.analyse_room_tone(np.zeros(int(SR * SECONDS), dtype=np.float32), SR)
        self.assertTrue(stats["suppressed"])
        self.assertTrue(ap.analyse_room_tone(white(-100.0), SR)["suppressed"])
        json.dumps(stats)

    def test_clipped(self):
        x = white(-50.0)
        x[1000:1005] = 1.0
        self.assertTrue(ap.analyse_room_tone(x, SR)["clipped"])

    def test_level_jump_is_unstable(self):
        x = white(-60.0)
        x[len(x) // 2:] *= 10 ** (15 / 20.0)
        stats = ap.analyse_room_tone(x, SR)
        self.assertTrue(stats["unstable"])
        self.assertGreater(stats["stability_db"], 10.0)

    def test_rumble_does_not_drive_verdict(self):
        x = shaped(-30.0, lambda f: np.where((f > 20) & (f < 60), 1.0, 0.0)) + white(-75.0)
        stats = ap.analyse_room_tone(x, SR)
        self.assertGreater(stats["rumble_share"], 0.5)
        self.assertEqual(stats["verdict"], "good")

    def test_attenuation_clamp(self):
        self.assertEqual(ap.analyse_room_tone(white(-20.0), SR)["cleanup"]["attenuation_db"], 40)
        self.assertEqual(ap.analyse_room_tone(white(-85.0), SR)["cleanup"]["attenuation_db"], 12)
        mid = ap.analyse_room_tone(white(-50.0), SR)
        self.assertEqual(mid["cleanup"]["attenuation_db"], round(mid["speech_floor_db"] + 80))


class TestNoiseProfileStore(unittest.TestCase):

    def setUp(self):
        self.cache = tempfile.mkdtemp(prefix="dm_room_check_")
        patcher = mock.patch.object(ap, "CACHE_DIR", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.cache, True)

    def _files(self):
        folder = ap.noise_profiles_dir()
        return sorted(os.listdir(folder)) if os.path.isdir(folder) else []

    def test_dir_is_under_cache(self):
        self.assertEqual(ap.noise_profiles_dir(), os.path.join(self.cache, "noise_profiles"))

    def test_round_trip(self):
        pid, stats = ap.save_noise_profile(white(-50.0), SR, device_id="dev1", device_label="Mic (USB)")
        self.assertRegex(pid, r"^[0-9a-f]{12}$")
        self.assertEqual(self._files(), [pid + ".json", pid + ".wav"])
        loaded = ap.load_noise_profile_stats(pid)
        self.assertEqual(loaded["profile_id"], pid)
        self.assertEqual(loaded["version"], 1)
        self.assertEqual(loaded["device_id"], "dev1")
        self.assertEqual(loaded["device_label"], "Mic (USB)")
        self.assertAlmostEqual(loaded["duration_sec"], SECONDS, delta=0.01)
        self.assertEqual(loaded["verdict"], stats["verdict"])
        wav = ap.noise_profile_wav_path(pid)
        self.assertTrue(wav and os.path.isfile(wav))
        audio = ap.read_wav_mono(wav, SR)
        self.assertEqual(len(audio), int(SR * SECONDS))
        settings = ap.noise_cleanup_settings(pid)
        self.assertEqual(settings, {"profile_id": pid,
                                    "attenuation_db": stats["cleanup"]["attenuation_db"],
                                    "notches_hz": stats["cleanup"]["notches_hz"]})
        self.assertTrue(ap.delete_noise_profile(pid))
        self.assertEqual(self._files(), [])
        self.assertFalse(ap.delete_noise_profile(pid))
        self.assertIsNone(ap.load_noise_profile_stats(pid))
        self.assertIsNone(ap.noise_profile_wav_path(pid))
        self.assertIsNone(ap.noise_cleanup_settings(pid))

    def test_id_depends_on_audio_and_label(self):
        x = white(-50.0)
        a, _ = ap.save_noise_profile(x, SR, device_label="A")
        b, _ = ap.save_noise_profile(x, SR, device_label="B")
        c, _ = ap.save_noise_profile(white(-50.0, seed=9), SR, device_label="A")
        self.assertEqual(len({a, b, c}), 3)

    def test_suppressed_and_clipped_write_nothing(self):
        pid, stats = ap.save_noise_profile(np.zeros(int(SR * SECONDS), dtype=np.float32), SR)
        self.assertIsNone(pid)
        self.assertTrue(stats["suppressed"])
        clipped = white(-50.0)
        clipped[:4] = 1.0
        pid, stats = ap.save_noise_profile(clipped, SR)
        self.assertIsNone(pid)
        self.assertTrue(stats["clipped"])
        self.assertEqual(self._files(), [])

    def test_51st_save_prunes_oldest(self):
        clock = [1000.0]

        def tick():
            clock[0] += 1.0
            return clock[0]

        x = white(-50.0, seconds=0.5)
        ids = []
        with mock.patch.object(ap.time, "time", side_effect=tick):
            for i in range(51):
                pid, _ = ap.save_noise_profile(x, SR, device_label="mic %d" % i)
                ids.append(pid)
        self.assertEqual(len(self._files()), 100)
        self.assertIsNone(ap.load_noise_profile_stats(ids[0]))
        self.assertIsNone(ap.noise_profile_wav_path(ids[0]))
        self.assertIsNotNone(ap.load_noise_profile_stats(ids[1]))
        self.assertIsNotNone(ap.load_noise_profile_stats(ids[50]))

    def test_invalid_ids_rejected(self):
        os.makedirs(ap.noise_profiles_dir(), exist_ok=True)
        # A file a traversal or uppercase id could reach must stay untouched.
        outside = os.path.join(self.cache, "x.json")
        with open(outside, "w") as f:
            json.dump({"cleanup": {"attenuation_db": 20, "notches_hz": []}}, f)
        for bad in ("../x", "ABCDEF123456", "", None, "abcdef12345", "abcdef1234567", 123):
            self.assertIsNone(ap.load_noise_profile_stats(bad), bad)
            self.assertIsNone(ap.noise_profile_wav_path(bad), bad)
            self.assertFalse(ap.delete_noise_profile(bad), bad)
            self.assertIsNone(ap.noise_cleanup_settings(bad), bad)
        self.assertTrue(os.path.isfile(outside))
        with mock.patch.object(ap.os.path, "isfile", side_effect=AssertionError("touched fs")):
            for bad in ("../x", "ABCDEF123456", ""):
                ap.load_noise_profile_stats(bad)
                ap.noise_profile_wav_path(bad)
                ap.delete_noise_profile(bad)
                ap.noise_cleanup_settings(bad)

    def test_missing_profile_gives_standard_cleanup(self):
        self.assertIsNone(ap.noise_cleanup_settings("0123456789ab"))
        self.assertIsNone(ap.noise_cleanup_settings(None))


if __name__ == "__main__":
    unittest.main()
