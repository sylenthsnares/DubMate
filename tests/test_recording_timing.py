"""Take timing alignment math (audio_processor.align_take_timing) on synthetic signals."""
import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor
from audio_processor import SR, align_take_timing


def speech_like(seed=1, duration=4.0, lead=0.4):
    """Amplitude-modulated noise bursts with irregular syllable spacing."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(duration * SR))
    t = lead
    while t < duration - 0.5:
        length = rng.uniform(0.08, 0.3)
        n = int(length * SR)
        i = int(t * SR)
        env = np.sin(np.linspace(0, np.pi, n)) ** 2 * rng.uniform(0.2, 1.0)
        out[i:i + n] += rng.standard_normal(n) * env * 0.3
        t += length + rng.uniform(0.03, 0.35)
    return out


def delayed(x, ms):
    pad = np.zeros(int(round(ms * SR / 1000)))
    return np.concatenate([pad, x])


def time_stretched(x, factor):
    """Slow down by `factor` (>1 makes it longer)."""
    n = int(round(len(x) * factor))
    return np.interp(np.arange(n) / factor, np.arange(len(x)), x)


class AlignTakeTimingTests(unittest.TestCase):
    def setUp(self):
        self.ref = speech_like()

    def assertSane(self, res):
        self.assertEqual(set(res), {"auto_offset_ms", "timing_score", "stretch", "aligned"})
        self.assertIsInstance(res["auto_offset_ms"], int)
        self.assertEqual(res["auto_offset_ms"] % 5, 0)
        json.dumps(res, allow_nan=False)

    def test_late_take_gets_negative_offset(self):
        res = align_take_timing(delayed(self.ref, 140), self.ref, 0)
        self.assertSane(res)
        self.assertTrue(res["aligned"])
        self.assertLessEqual(abs(res["auto_offset_ms"] - (-140)), 5)
        self.assertGreater(res["timing_score"], 0.9)
        self.assertEqual(res["stretch"], 1.0)

    def test_start_offset_does_not_bias_result(self):
        res = align_take_timing(delayed(self.ref, 140), self.ref, -100)
        self.assertSane(res)
        self.assertTrue(res["aligned"])
        self.assertLessEqual(abs(res["auto_offset_ms"] - (-140)), 5)

    def test_offsets_are_multiples_of_five(self):
        for ms, start in ((37, 0), (212, 13), (0, -22), (73, 41)):
            res = align_take_timing(delayed(self.ref, ms), self.ref, start)
            self.assertSane(res)
            self.assertLessEqual(abs(res["auto_offset_ms"] + ms), 5)

    def test_slow_take_is_stretched(self):
        take = delayed(time_stretched(self.ref, 1.06), 60)
        res = align_take_timing(take, self.ref, 0)
        plain = align_take_timing(take, self.ref, 0, allow_stretch=False)
        self.assertSane(res)
        self.assertTrue(res["aligned"])
        self.assertLessEqual(abs(res["stretch"] - 1.06), 0.01)
        self.assertEqual(plain["stretch"], 1.0)
        self.assertGreater(res["timing_score"], plain["timing_score"] or 0)

    def test_small_drift_is_not_stretched(self):
        res = align_take_timing(delayed(time_stretched(self.ref, 1.01), 60), self.ref, 0)
        self.assertSane(res)
        self.assertEqual(res["stretch"], 1.0)

    def test_allow_stretch_false_never_stretches(self):
        for f in (0.94, 1.06, 1.1):
            res = align_take_timing(time_stretched(self.ref, f), self.ref, 0, allow_stretch=False)
            self.assertSane(res)
            self.assertEqual(res["stretch"], 1.0)

    def test_silence_is_not_measured(self):
        silence = np.zeros(SR * 2)
        for take, ref in ((silence, self.ref), (self.ref, silence), (silence, silence)):
            res = align_take_timing(take, ref, 20)
            self.assertSane(res)
            self.assertEqual(res, {"auto_offset_ms": 20, "timing_score": None, "stretch": 1.0, "aligned": False})

    def test_take_model_fixture_tones_not_measured(self):
        t1 = np.arange(int(0.5 * SR)) / SR
        t2 = np.arange(int(0.25 * SR)) / SR
        take = 0.3 * np.sin(2 * np.pi * 300 * t1)
        ref = 0.3 * np.sin(2 * np.pi * 180 * t2)
        res = align_take_timing(take, ref, 25)
        self.assertSane(res)
        self.assertEqual(res, {"auto_offset_ms": 25, "timing_score": None, "stretch": 1.0, "aligned": False})

    def test_noise_against_speech_not_aligned(self):
        noise = np.random.default_rng(7).standard_normal(len(self.ref)) * 0.1
        res = align_take_timing(noise, self.ref, 0)
        self.assertSane(res)
        self.assertFalse(res["aligned"])
        self.assertEqual(res["auto_offset_ms"], 0)
        self.assertEqual(res["stretch"], 1.0)

    def test_different_lines_not_aligned(self):
        res = align_take_timing(speech_like(seed=42), self.ref, 0)
        self.assertSane(res)
        self.assertFalse(res["aligned"])

    def test_start_offset_snapped(self):
        res = align_take_timing(np.zeros(100), self.ref, 23)
        self.assertEqual(res["auto_offset_ms"], 25)

    def test_envelope_floor(self):
        env = audio_processor._timing_envelope(self.ref, SR)
        self.assertAlmostEqual(env.max() - env.min(), 50.0, places=6)


if __name__ == "__main__":
    unittest.main()
