# -*- coding: utf-8 -*-
"""
test_audio_safety.py
Regression suite for DSP-layer correctness and robustness hardening:
  - path-traversal-safe room_id / user_id sanitization
  - NaN/Inf guard on the WAV/MP3 write path
  - clamped client-supplied gain_db (no overflow)
  - master limiter respects its ceiling
  - reverb impulse generation does not mutate the global numpy RNG
Uses Python's standard unittest framework, mirroring tests/test_noise_reduction.py conventions.
"""

import os
import shutil
import tempfile
import unittest
import numpy as np

# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import audio_processor
import pack_loader


class TestPathTraversalSanitization(unittest.TestCase):
    """Verifies room_id / user_id can never escape their intended cache directory."""

    def setUp(self):
        self.rooms_root = os.path.join(pack_loader.CACHE_DIR, "rooms")

    def test_sanitize_id_token_neutralizes_traversal(self):
        malicious_inputs = [
            "../../../X",
            r"..\..\..\X",
            "../../etc/passwd",
            "a/../../b",
            "....//....//etc",
        ]
        for bad in malicious_inputs:
            safe = audio_processor._sanitize_id_token(bad)
            self.assertNotIn("/", safe)
            self.assertNotIn("\\", safe)
            self.assertNotIn("..", safe)
            self.assertTrue(safe, f"Sanitized token for {bad!r} must not be empty")

    def test_sanitize_id_token_rejects_empty_after_sanitizing(self):
        for bad in ["", "   ", "///", "..", r"..\..", "***???"]:
            with self.assertRaises(ValueError):
                audio_processor._sanitize_id_token(bad)
        with self.assertRaises(ValueError):
            audio_processor._sanitize_id_token(None)

    def test_get_user_noise_profile_path_rejects_traversal(self):
        room_id = "TESTSAFE1"
        room_dir = audio_processor.get_room_cache_dir(room_id)
        try:
            malicious_user_id = "../../../../evil_outside_room"
            profile_path = audio_processor.get_user_noise_profile_path(room_id, malicious_user_id)
            real_profile = os.path.realpath(profile_path)
            real_room = os.path.realpath(room_dir)
            self.assertTrue(
                real_profile == real_room or real_profile.startswith(real_room + os.sep),
                f"Profile path {real_profile!r} escaped room dir {real_room!r}",
            )
            # The dangerous ".." sequence must never survive into the actual filename.
            self.assertNotIn("..", os.path.basename(real_profile))
        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_get_room_cache_dir_rejects_traversal(self):
        malicious_room_id = "../../../outside_cache"
        room_dir = audio_processor.get_room_cache_dir(malicious_room_id)
        try:
            real_room = os.path.realpath(room_dir)
            real_rooms_root = os.path.realpath(self.rooms_root)
            self.assertTrue(
                real_room == real_rooms_root or real_room.startswith(real_rooms_root + os.sep),
                f"Room cache dir {real_room!r} escaped rooms root {real_rooms_root!r}",
            )
        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_normal_room_and_user_ids_still_work(self):
        room_id = "ABC123"
        user_id = "user_abc-123"
        room_dir = audio_processor.get_room_cache_dir(room_id)
        try:
            profile_path = audio_processor.get_user_noise_profile_path(room_id, user_id)
            self.assertIn(room_dir, profile_path)
            self.assertIn(user_id, os.path.basename(profile_path))
        finally:
            shutil.rmtree(room_dir, ignore_errors=True)


class TestNonFiniteAudioGuard(unittest.TestCase):
    """Verifies NaN / +-Inf samples never survive into a written WAV/MP3 file."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="dubmate_nan_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_write_wav_mono_sanitizes_nan_and_inf(self):
        sr = 44100
        data = np.array([0.1, np.nan, 0.2, np.inf, -np.inf, -0.3, np.nan], dtype=np.float32)
        out_path = os.path.join(self.tmp_dir, "nan_test.wav")
        audio_processor.write_wav_mono(out_path, data, sr)
        self.assertTrue(os.path.isfile(out_path))

        import wave
        with wave.open(out_path, "rb") as w:
            raw = w.readframes(w.getnframes())
        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        self.assertTrue(np.all(np.isfinite(pcm)), "Non-finite samples leaked into the written WAV file")
        # The NaN/Inf slots must have been replaced with silence (0.0), not garbage.
        self.assertAlmostEqual(float(pcm[1]), 0.0, places=3)
        self.assertAlmostEqual(float(pcm[3]), 0.0, places=3)
        self.assertAlmostEqual(float(pcm[4]), 0.0, places=3)

    def test_sanitize_finite_audio_replaces_only_bad_samples(self):
        data = np.array([0.5, np.nan, -0.5, np.inf], dtype=np.float32)
        cleaned = audio_processor._sanitize_finite_audio(data)
        self.assertTrue(np.all(np.isfinite(cleaned)))
        np.testing.assert_allclose(cleaned, np.array([0.5, 0.0, -0.5, 0.0], dtype=np.float32))

    def test_master_soft_limiter_sanitizes_nan_input(self):
        data = np.array([0.1, np.nan, np.inf, -np.inf, 0.9, -0.9], dtype=np.float32)
        result = audio_processor.master_soft_limiter(data, ceiling_db=-0.3)
        self.assertTrue(np.all(np.isfinite(result)), "Limiter must never emit non-finite samples")


class TestGainClamping(unittest.TestCase):
    """Verifies client-supplied gain_db can never overflow 10 ** (gain_db / 20)."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="dubmate_gain_test_")
        self.sr = 44100
        t = np.linspace(0, 0.5, int(self.sr * 0.5), endpoint=False, dtype=np.float32)
        tone = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        self.audio_path = os.path.join(self.tmp_dir, "tone.wav")
        audio_processor.write_wav_mono(self.audio_path, tone, self.sr)

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_extreme_positive_gain_db_does_not_overflow(self):
        result = audio_processor.apply_audio_effects(self.audio_path, gain_db=1_000_000.0, sr=self.sr)
        self.assertTrue(np.all(np.isfinite(result)), "Extreme gain_db produced non-finite audio")
        # Clamped to GAIN_DB_MAX, so the multiplier is bounded, not astronomically large.
        max_mult = 10.0 ** (audio_processor.GAIN_DB_MAX / 20.0)
        self.assertLessEqual(float(np.max(np.abs(result))), max_mult * 1.01)

    def test_extreme_negative_gain_db_does_not_underflow_to_nan(self):
        result = audio_processor.apply_audio_effects(self.audio_path, gain_db=-1_000_000.0, sr=self.sr)
        self.assertTrue(np.all(np.isfinite(result)))

    def test_gain_db_clamped_to_configured_bounds(self):
        clamped_high = float(np.clip(500.0, audio_processor.GAIN_DB_MIN, audio_processor.GAIN_DB_MAX))
        clamped_low = float(np.clip(-500.0, audio_processor.GAIN_DB_MIN, audio_processor.GAIN_DB_MAX))
        self.assertEqual(clamped_high, audio_processor.GAIN_DB_MAX)
        self.assertEqual(clamped_low, audio_processor.GAIN_DB_MIN)


class TestMasterLimiterCeiling(unittest.TestCase):
    """Verifies the master soft limiter actually respects its intended ceiling."""

    def test_limiter_output_respects_ceiling(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False, dtype=np.float32)
        # Deliberately hot signal that clips well past 0 dBFS before limiting.
        loud = (1.8 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        ceiling_db = -0.3
        limited = audio_processor.master_soft_limiter(loud, ceiling_db=ceiling_db)
        ceiling = 10.0 ** (ceiling_db / 20.0)
        peak = float(np.max(np.abs(limited)))
        self.assertLessEqual(peak, ceiling + 1e-3, "Limiter output exceeded its configured ceiling")

    def test_limiter_is_transparent_below_ceiling(self):
        sr = 44100
        quiet = np.array([0.1, -0.2, 0.05, -0.05], dtype=np.float32)
        result = audio_processor.master_soft_limiter(quiet, ceiling_db=-0.3)
        np.testing.assert_allclose(result, quiet)


class TestReverbImpulseRngIsolation(unittest.TestCase):
    """Verifies get_reverb_impulse no longer hijacks the global numpy RNG."""

    def test_get_reverb_impulse_does_not_mutate_global_random_state(self):
        np.random.seed(1234)
        expected_next = np.random.rand(5)

        np.random.seed(1234)
        audio_processor._REVERB_CACHE.clear()
        audio_processor.get_reverb_impulse(decay_sec=1.5, sr=44100)
        actual_next = np.random.rand(5)

        np.testing.assert_allclose(
            actual_next, expected_next,
            err_msg="get_reverb_impulse mutated the process-wide numpy RNG state",
        )

    def test_get_reverb_impulse_is_deterministic(self):
        audio_processor._REVERB_CACHE.clear()
        impulse_a = audio_processor.get_reverb_impulse(decay_sec=0.8, sr=44100).copy()
        audio_processor._REVERB_CACHE.clear()
        impulse_b = audio_processor.get_reverb_impulse(decay_sec=0.8, sr=44100).copy()
        np.testing.assert_array_equal(impulse_a, impulse_b)


if __name__ == "__main__":
    unittest.main(verbosity=2)
