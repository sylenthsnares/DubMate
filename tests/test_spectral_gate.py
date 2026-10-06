# -*- coding: utf-8 -*-
"""
test_spectral_gate.py
Tuned cleanup: the numpy spectral gate, the pre-filter and apply_noise_reduction(settings=...).
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock
import numpy as np

import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor as ap

SR = 44100


def _rms_db(x):
    return 10.0 * np.log10(np.mean(np.asarray(x, dtype=np.float64) ** 2))


def white(level_db, seconds=3.0, seed=1):
    x = np.random.default_rng(seed).standard_normal(int(SR * seconds))
    return (x * 10 ** (level_db / 20.0)).astype(np.float32)


def sine(freq, rms_db, seconds=3.0):
    t = np.arange(int(SR * seconds)) / SR
    return (np.sqrt(2) * 10 ** (rms_db / 20.0) * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _band_db(x, lo, hi):
    spec = np.abs(np.fft.rfft(np.asarray(x, dtype=np.float64))) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / SR)
    return 10.0 * np.log10(np.mean(spec[(freqs >= lo) & (freqs <= hi)]))


def _bin_db(x, freq):
    spec = np.abs(np.fft.rfft(np.asarray(x, dtype=np.float64)))
    k = int(round(freq * len(x) / SR))
    return 20.0 * np.log10(spec[k])


class TestSpectralGate(unittest.TestCase):

    def test_room_tone_alone_drops_about_12_db(self):
        noise = white(-50.0)
        out = ap.spectral_gate(noise, noise, SR)
        drop = _rms_db(noise) - _rms_db(out)
        self.assertGreaterEqual(drop, 10.0)
        self.assertLessEqual(drop, 14.0)

    def test_tone_above_room_tone_keeps_its_level(self):
        noise = white(-50.0)
        profile = white(-50.0, seed=7)
        take = noise + sine(1000.0, -30.0)
        out = ap.spectral_gate(take, profile, SR)
        self.assertLess(abs(_bin_db(out, 1000.0) - _bin_db(take, 1000.0)), 1.5)
        self.assertGreaterEqual(_band_db(take, 3000, 6000) - _band_db(out, 3000, 6000), 9.0)

    def test_output_length_dtype_and_finite(self):
        profile = white(-50.0, seconds=1.0)
        for n in (1, 1000, 2048, SR * 2 + 17):
            with self.subTest(n=n):
                out = ap.spectral_gate(white(-40.0, seconds=n / SR, seed=3)[:n], profile, SR)
                self.assertEqual(len(out), n)
                self.assertEqual(out.dtype, np.float32)
                self.assertTrue(np.all(np.isfinite(out)))

    def test_silence_stays_finite(self):
        out = ap.spectral_gate(np.zeros(SR, dtype=np.float32), np.zeros(SR, dtype=np.float32), SR)
        self.assertTrue(np.all(np.isfinite(out)))
        self.assertEqual(len(out), SR)


class TestCleanupPrefilter(unittest.TestCase):

    def test_highpass_and_notches(self):
        self.assertEqual(ap._cleanup_prefilter({"notches_hz": []}), "highpass=f=60")
        self.assertEqual(
            ap._cleanup_prefilter({"notches_hz": [50.0, 2412.5]}),
            "highpass=f=60,bandreject=f=50:width_type=q:width=30,bandreject=f=2412.5:width_type=q:width=30")

    def test_at_most_four_notches(self):
        af = ap._cleanup_prefilter({"notches_hz": [50.0, 100.0, 150.0, 200.0, 250.0]})
        self.assertEqual(af.count("bandreject"), 4)
        self.assertNotIn("f=250", af)


class _TempDirCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dm_gate_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.object(ap, "CACHE_DIR", os.path.join(self.tmp, "cache"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.input_wav = os.path.join(self.tmp, "take.wav")
        self.output_wav = os.path.join(self.tmp, "out", "take_denoised.wav")
        ap.write_wav_mono(self.input_wav, white(-40.0, seconds=1.0), SR)


class TestApplyNoiseReductionDeepFilter(_TempDirCase):
    """A fake deep-filter: _ffmpeg_to_mono_wav copies, _run_subprocess copies the input to -o."""

    def _run(self, settings):
        fake_bin = os.path.join(self.tmp, "deep-filter")
        open(fake_bin, "wb").close()
        ffmpeg_calls, df_cmds = [], []

        def fake_ffmpeg(src, dst, sr, timeout, context, af=None):
            ffmpeg_calls.append((context, af))
            shutil.copyfile(src, dst)

        def fake_run(cmd, **kwargs):
            df_cmds.append(list(cmd))
            out_dir = cmd[cmd.index("-o") + 1]
            shutil.copyfile(cmd[-1], os.path.join(out_dir, os.path.basename(cmd[-1])))

        with mock.patch.object(ap, "get_deep_filter_path", return_value=fake_bin), \
                mock.patch.object(ap, "_ffmpeg_to_mono_wav", side_effect=fake_ffmpeg), \
                mock.patch.object(ap, "_run_subprocess", side_effect=fake_run):
            result = ap.apply_noise_reduction(self.input_wav, self.output_wav, settings=settings)
        return result, ffmpeg_calls, df_cmds

    def test_settings_drive_attenuation_and_prefilter(self):
        settings = {"profile_id": "0123456789ab", "attenuation_db": 28, "notches_hz": [50.0, 150.0]}
        result, ffmpeg_calls, df_cmds = self._run(settings)
        self.assertEqual(result, self.output_wav)
        self.assertTrue(os.path.isfile(self.output_wav))
        cmd = df_cmds[0]
        self.assertEqual(cmd[cmd.index("-a") + 1], "28")
        resample_af = ffmpeg_calls[0][1]
        self.assertEqual(resample_af, "highpass=f=60,bandreject=f=50:width_type=q:width=30,"
                                      "bandreject=f=150:width_type=q:width=30")

    def test_attenuation_is_clamped(self):
        _, _, df_cmds = self._run({"profile_id": "0123456789ab", "attenuation_db": 4, "notches_hz": []})
        self.assertEqual(df_cmds[0][df_cmds[0].index("-a") + 1], "12")

    def test_no_settings_is_unchanged(self):
        _, ffmpeg_calls, df_cmds = self._run(None)
        self.assertIsNone(ffmpeg_calls[0][1])
        self.assertEqual(df_cmds[0][df_cmds[0].index("-a") + 1], "30")


class TestApplyNoiseReductionFallback(_TempDirCase):

    def test_no_settings_keeps_the_afftdn_chain(self):
        calls = []

        def fake_ffmpeg(src, dst, sr, timeout, context, af=None):
            calls.append(af)
            shutil.copyfile(src, dst)

        with mock.patch.object(ap, "get_deep_filter_path", return_value=None), \
                mock.patch.object(ap, "_ffmpeg_to_mono_wav", side_effect=fake_ffmpeg):
            result = ap.apply_noise_reduction(self.input_wav, self.output_wav)
        self.assertEqual(result, self.output_wav)
        self.assertEqual(calls, ["highpass=f=80,afftdn=nr=18.0:nf=-35:tn=1"])

    def test_gate_with_stored_profile_reduces_hum_and_noise(self):
        room = white(-55.0, seed=11) + sine(50.0, -35.0)
        profile_id, stats = ap.save_noise_profile(room, SR)
        self.assertIsNotNone(profile_id)
        settings = ap.noise_cleanup_settings(profile_id)
        self.assertIn(50.0, [round(f) for f in settings["notches_hz"]])
        take = white(-55.0, seconds=2.0, seed=12) + sine(50.0, -35.0, seconds=2.0)
        ap.write_wav_mono(self.input_wav, take, SR)

        with mock.patch.object(ap, "get_deep_filter_path", return_value=None):
            result = ap.apply_noise_reduction(self.input_wav, self.output_wav, settings=settings)
        self.assertEqual(result, self.output_wav)
        raw = ap.read_wav_mono(self.input_wav, SR)
        out = ap.read_wav_mono(self.output_wav, SR)
        self.assertEqual(len(out), len(raw))
        self.assertGreaterEqual(_band_db(raw, 48, 52) - _band_db(out, 48, 52), 15.0)
        self.assertGreaterEqual(_band_db(raw, 1000, 6000) - _band_db(out, 1000, 6000), 9.0)

    def test_gate_without_profile_returns_none_and_writes_nothing(self):
        settings = {"profile_id": "0123456789ab", "attenuation_db": 28, "notches_hz": [50.0]}
        with mock.patch.object(ap, "get_deep_filter_path", return_value=None), \
                mock.patch.object(ap, "_ffmpeg_to_mono_wav") as ffmpeg:
            result = ap.apply_noise_reduction(self.input_wav, self.output_wav, settings=settings)
        self.assertIsNone(result)
        self.assertFalse(os.path.exists(self.output_wav))
        ffmpeg.assert_not_called()


if __name__ == "__main__":
    unittest.main()
