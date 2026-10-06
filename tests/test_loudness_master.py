# -*- coding: utf-8 -*-
"""
test_loudness_master.py
BS.1770 integrated loudness (integrated_lufs), true peak (true_peak_db) and the master
stage (master_stage) on synthetic signals. See documentation/design/effects-rack.md, Loudness.
"""

import math
import tracemalloc
import unittest

import numpy as np

# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import audio_processor


def _sine(freq, amp, seconds, sr):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _pinkish_noise(seconds, sr, seed=7):
    """White noise shaped to 1/f power in the frequency domain, scaled to 0.1 RMS."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    spectrum[1:] /= np.sqrt(freqs[1:])
    spectrum[0] = 0.0
    noise = np.fft.irfft(spectrum, n)
    return (0.1 * noise / np.sqrt(np.mean(noise ** 2))).astype(np.float32)


def _speech_like(seconds, sr, seed=11):
    """Voiced syllables: a gliding 140 Hz harmonic tone in 80-300 ms bursts at random
    levels, with short gaps."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    phase = 2 * np.pi * np.cumsum(140 + 20 * np.sin(2 * np.pi * 0.7 * t)) / sr
    carrier = sum(np.sin(k * phase + rng.uniform(0, 2 * np.pi)) / k for k in range(1, 25))
    env = np.zeros(len(t))
    i = 0
    while i < len(env):
        n = int(rng.uniform(0.08, 0.3) * sr)
        seg = np.hanning(n)[:len(env) - i] * 10 ** (rng.uniform(-6, 0) / 20)
        env[i:i + len(seg)] = seg
        i += n + int(rng.uniform(0.05, 0.2) * sr)
    return (0.1 * carrier * env).astype(np.float32)


def _clap(peak_dbfs, sr, seed=3):
    """A 25 ms clap: white noise with a 6 ms decay, peaking at peak_dbfs."""
    n = int(0.025 * sr)
    c = np.random.default_rng(seed).standard_normal(n) * np.exp(-np.arange(n) / (0.006 * sr))
    return (c / np.max(np.abs(c)) * 10 ** (peak_dbfs / 20)).astype(np.float32)


def _python_lfilter(x, stages):
    """Plain-Python direct-form IIR, the reference for the FIR K-weighting."""
    sig = [float(v) for v in x]
    for (b0, b1, b2), (_, a1, a2) in stages:
        x1 = x2 = y1 = y2 = 0.0
        out = []
        for x0 in sig:
            y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            out.append(y0)
            x2, x1, y2, y1 = x1, x0, y1, y0
        sig = out
    return np.array(sig)


class TestIntegratedLufs(unittest.TestCase):

    def test_997hz_sine_reads_its_level(self):
        # BS.1770: a full-scale (peak 1.0, -3.01 dB RMS) 997 Hz sine in one channel reads -3.01 LUFS.
        for sr in (44100, 48000):
            self.assertAlmostEqual(audio_processor.integrated_lufs(_sine(997, 1.0, 5, sr), sr), -3.01, delta=0.1)
            quiet = _sine(997, 10 ** (-20 / 20), 5, sr)
            self.assertAlmostEqual(audio_processor.integrated_lufs(quiet, sr), -23.01, delta=0.1)

    def test_silence_and_short_signals(self):
        sr = 44100
        self.assertEqual(audio_processor.integrated_lufs(np.zeros(sr * 2, dtype=np.float32), sr), -70.0)
        self.assertEqual(audio_processor.integrated_lufs(np.zeros(0, dtype=np.float32), sr), -70.0)
        # Shorter than one 400 ms block: ungated mean square.
        self.assertAlmostEqual(audio_processor.integrated_lufs(_sine(997, 1.0, 0.2, sr), sr), -3.01, delta=0.15)

    def test_silence_gaps_are_gated(self):
        sr = 44100
        noise = _pinkish_noise(12, sr)
        gapped = noise.copy()
        for start in range(0, len(gapped), 6 * sr):
            gapped[start + 3 * sr:start + 6 * sr] = 0.0  # 3 s of noise, 3 s of silence
        continuous = audio_processor.integrated_lufs(noise, sr)
        measured = audio_processor.integrated_lufs(gapped, sr)
        ungated = -0.691 + 10 * math.log10(np.mean(audio_processor._k_weight(gapped, sr).astype(np.float64) ** 2))
        self.assertAlmostEqual(measured, continuous, delta=0.6)
        self.assertGreater(measured - ungated, 2.0)  # the plain mean would read ~3 dB lower

    def test_rate_independent(self):
        def tones(sr):
            return sum(_sine(f, 0.1, 4, sr) for f in (100, 997, 3000, 8000))
        self.assertAlmostEqual(
            audio_processor.integrated_lufs(tones(44100), 44100),
            audio_processor.integrated_lufs(tones(48000), 48000),
            delta=0.05,
        )

    def test_fir_k_weighting_matches_iir(self):
        sr = 44100
        noise = (np.random.default_rng(3).standard_normal(2 * sr) * 0.25).astype(np.float32)
        expected = _python_lfilter(noise, audio_processor._k_weighting_biquads(sr))
        np.testing.assert_allclose(audio_processor._k_weight(noise, sr), expected, rtol=0, atol=1e-6)

    def test_three_minutes_stay_small_in_memory(self):
        sr = 48000
        noise = (np.random.default_rng(5).standard_normal(180 * sr) * 0.1).astype(np.float32)
        audio_processor._k_weighting_ir(sr)  # cached per rate; not part of the measurement
        tracemalloc.start()
        try:
            lufs = audio_processor.integrated_lufs(noise, sr)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 64 * 1024 * 1024)
        self.assertTrue(-25.0 < lufs < -15.0)


class TestTruePeak(unittest.TestCase):

    def test_inter_sample_peak_is_found(self):
        sr = 44100
        # fs/4 sine at 45 degrees: samples sit at +/-0.5, the waveform peaks at 0.707.
        t = np.arange(2 * sr) / sr
        x = (0.7071 * np.sin(2 * np.pi * (sr / 4) * t + np.pi / 4) * np.hanning(len(t))).astype(np.float32)
        self.assertLess(20 * np.log10(np.max(np.abs(x))), -6.0)
        self.assertAlmostEqual(audio_processor.true_peak_db(x), -3.01, delta=0.05)

    def test_never_below_sample_peak(self):
        x = (np.random.default_rng(9).standard_normal(20000) * 0.2).astype(np.float32)
        self.assertGreaterEqual(audio_processor.true_peak_db(x), 20 * np.log10(np.max(np.abs(x))) - 1e-6)
        self.assertEqual(audio_processor.true_peak_db(np.zeros(100, dtype=np.float32)), -120.0)


class TestMasterStage(unittest.TestCase):

    def _check(self, x, sr):
        out, info = audio_processor.master_stage(x, sr)
        self.assertEqual(len(out), len(x))
        self.assertAlmostEqual(audio_processor.integrated_lufs(out, sr), -16.0, delta=0.2)
        self.assertLessEqual(audio_processor.true_peak_db(out), -1.0)
        self.assertLessEqual(info["true_peak_db"], -1.0)
        return out, info

    def test_hot_input(self):
        sr = 44100
        x = _pinkish_noise(6, sr) * np.float32(3.0)  # peaks well past 0 dBFS
        self.assertGreater(np.max(np.abs(x)), 1.0)
        _, info = self._check(x, sr)
        self.assertLess(info["gain_db"], 0.0)

    def test_quiet_input(self):
        sr = 48000
        x = _pinkish_noise(6, sr) * np.float32(10 ** (-12 / 20))
        _, info = self._check(x, sr)
        self.assertGreater(info["gain_db"], 0.0)

    def test_silence_is_left_alone(self):
        out, info = audio_processor.master_stage(np.zeros(44100, dtype=np.float32), 44100)
        self.assertEqual(info["gain_db"], 0.0)
        self.assertFalse(np.any(out))

    def test_speech_like_bursts(self):
        # Voiced syllables (a gliding 140 Hz harmonic tone, 80-300 ms bursts at random levels,
        # short gaps): at -16 LUFS their peaks sit about 2.5 dB over the limiter's ceiling,
        # and the result still lands on target under -1 dBTP.
        sr = 48000
        x = _speech_like(8, sr)
        gain = 10 ** (audio_processor._master_gain_db(audio_processor.integrated_lufs(x, sr)) / 20)
        self.assertGreater(audio_processor.true_peak_db(x * np.float32(gain)), audio_processor.MASTER_LIMITER_CEILING_DB)
        self._check(x, sr)

    def test_gain_is_clamped(self):
        sr = 44100
        x = _sine(997, 10 ** (-60 / 20), 3, sr)  # about -63 LUFS: needs +47 dB, gets +24
        out, info = audio_processor.master_stage(x, sr)
        self.assertEqual(info["gain_db"], 24.0)
        self.assertAlmostEqual(audio_processor.integrated_lufs(out, sr), info["lufs_in"] + 24.0, delta=0.05)


    def test_loud_clap_over_speech(self):
        # Film mixes put effects 20 dB and more over the dialogue. A 25 ms clap peaking at
        # +6 or +12 dBFS over speech at -16 LUFS must not pull the mix under target: the
        # limiter turns the clap down on its own and the master makes up what that removed.
        sr = 44100
        speech = _speech_like(8, sr)
        speech *= np.float32(10 ** ((-16.0 - audio_processor.integrated_lufs(speech, sr)) / 20))
        for peak_dbfs in (6.0, 12.0):
            with self.subTest(clap_dbfs=peak_dbfs):
                x = speech.copy()
                clap = _clap(peak_dbfs, sr)
                x[4 * sr:4 * sr + len(clap)] += clap
                out, _ = self._check(x, sr)
                # The speech away from the clap keeps its level: no mix-wide trim.
                self.assertAlmostEqual(audio_processor.integrated_lufs(out[:3 * sr], sr),
                                       audio_processor.integrated_lufs(speech[:3 * sr], sr), delta=0.3)


class TestPeakLimiter(unittest.TestCase):
    """The true-peak limiter on its own (_limit_true_peak, no loudness gain)."""

    def test_holds_the_true_peak_ceiling(self):
        sr = 44100
        x = _pinkish_noise(4, sr) * np.float32(4.0)  # peaks far past 0 dBFS
        out, peak_db = audio_processor._limit_true_peak(x, sr)
        self.assertEqual(len(out), len(x))
        self.assertLessEqual(peak_db, audio_processor.MASTER_LIMITER_CEILING_DB + 0.01)
        self.assertAlmostEqual(peak_db, audio_processor.true_peak_db(out), places=6)

    def test_unity_gain_just_under_the_ceiling(self):
        # A 220 Hz sine peaking at -2 dBFS is under the ceiling, so it passes untouched,
        # sample for sample (no delay).
        sr = 48000
        x = _sine(220, 10 ** (-2 / 20), 2, sr)
        out, peak_db = audio_processor._limit_true_peak(x, sr)
        np.testing.assert_array_equal(out, x)
        self.assertAlmostEqual(peak_db, -2.0, delta=0.01)

    def test_a_clap_is_turned_down_not_clipped(self):
        # A +12 dBFS clap in a quiet tone: the gain ramps down ahead of it and back up after
        # it, never faster than the attack allows, and the tone away from it is untouched.
        sr = 44100
        x = _sine(300, 0.05, 3, sr)
        clap = _clap(12.0, sr)
        x[sr:sr + len(clap)] += clap
        out, peak_db = audio_processor._limit_true_peak(x, sr)
        self.assertLessEqual(peak_db, audio_processor.MASTER_LIMITER_CEILING_DB + 0.01)
        ceiling = 10 ** (audio_processor.MASTER_LIMITER_CEILING_DB / 20)
        gain = audio_processor._limiter_gain(audio_processor._limiter_envelope(x), ceiling, sr)
        np.testing.assert_allclose(out, x * gain, rtol=1e-6, atol=1e-7)
        self.assertLess(gain.min(), 10 ** (-12 / 20))
        width = int(round(audio_processor._LIMITER_ATTACK_S * sr)) + 1
        self.assertLessEqual(np.max(np.abs(np.diff(gain))), 1.0 / width + 1e-9)
        # The interpolator sees the clap up to half its taps early.
        before = sr - width - audio_processor._TP_TAPS // 2 - 1
        np.testing.assert_array_equal(out[:before], x[:before])
        np.testing.assert_array_equal(out[2 * sr:], x[2 * sr:])


if __name__ == "__main__":
    unittest.main()
