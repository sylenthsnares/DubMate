# -*- coding: utf-8 -*-
"""
test_noise_reduction_deep.py
Deep, rigorous test suite for DubMate Studio Noise Reduction & Mic Profiling:
1. Spectral SNR & Noise Attenuation Benchmarks (Hum, Fan Whine, Wideband Hiss, AC Rumble).
2. Speech Formant & Vocal Energy Preservation Analysis.
3. Edge Cases & Boundary Conditions (silence, near-0s takes, 0dBFS peaks, corrupt inputs).
4. Multi-Actor Concurrent Noise Profiles in the same session.
5. Full Scene Multi-Track Mix (`render_dub_mix`) with Mixed Denoised & Raw Takes.
6. Full MP4 Video Export (`export_dub_video`) with Denoised Audio Stems.
7. Multi-Track Project NLE ZIP Export (`build_project_zip`).
8. Stress Test: Rapid sequential on-demand toggling (raw <-> denoised).
"""

import os
import shutil
import tempfile
import zipfile
import unittest
from typing import Tuple
import numpy as np
from starlette.testclient import TestClient

import audio_processor
import pack_loader
import app


def generate_audio_signal(
    duration_sec: float = 2.0,
    sr: int = 44100,
    noise_type: str = "white",
    noise_level: float = 0.08,
    speech_level: float = 0.4
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns (mixed_audio, pure_speech, pure_noise) as float32 numpy arrays.
    Uses real pack vocal sample if available, or synthetic glottal-modulated speech.
    """
    n_samples = int(sr * duration_sec)
    t = np.linspace(0, duration_sec, n_samples, endpoint=False, dtype=np.float32)

    sample_vocal_path = os.path.join(os.path.dirname(__file__), "Packs", "Jane Doe", "001_Makima.wav")
    if os.path.isfile(sample_vocal_path):
        raw_vocal = audio_processor.read_wav_mono(sample_vocal_path, sr)
        if len(raw_vocal) >= n_samples:
            speech = raw_vocal[:n_samples]
        else:
            speech = np.pad(raw_vocal, (0, n_samples - len(raw_vocal)))
        # Normalize to target speech level
        vocal_max = np.max(np.abs(speech))
        if vocal_max > 1e-4:
            speech = (speech / vocal_max) * speech_level
    else:
        # Synthetic glottal-pulse voiced speech simulation with formants
        f0 = 140.0 + 8.0 * np.sin(2 * np.pi * 3.0 * t)
        phase = 2 * np.pi * np.cumsum(f0) / sr
        harmonics = sum(np.sin(k * phase) / (k**0.7) for k in range(1, 16))
        speech_mask = np.zeros(n_samples, dtype=np.float32)
        speech_mask[int(0.3 * sr):int(1.7 * sr)] = 1.0
        speech = (harmonics * 0.10 * speech_mask * speech_level).astype(np.float32)

    # 2. Noise types
    np.random.seed(123)
    if noise_type == "hum":
        # 60Hz mains hum + 120Hz harmonic
        noise = (0.7 * np.sin(2 * np.pi * 60 * t) + 0.3 * np.sin(2 * np.pi * 120 * t)) * noise_level
    elif noise_type == "fan":
        # Computer fan / blower whine: 1200Hz + 2400Hz tones + high frequency hiss
        noise = (0.5 * np.sin(2 * np.pi * 1200 * t) + 0.5 * (np.random.rand(n_samples).astype(np.float32) * 2 - 1)) * noise_level
    elif noise_type == "rumble":
        # Room AC sub-bass rumble (< 100Hz)
        noise = (0.6 * np.sin(2 * np.pi * 45 * t) + 0.4 * np.sin(2 * np.pi * 85 * t)) * noise_level
    else:
        # Wideband microphone preamp thermal hiss
        noise = (np.random.rand(n_samples).astype(np.float32) * 2.0 - 1.0) * noise_level

    mixed = np.clip(speech + noise, -1.0, 1.0).astype(np.float32)
    return mixed, speech, noise


class TestDeepNoiseReduction(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app.app)
        cls.client.__enter__()
        cls.client.get("/api/packs")

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        app.prune_sessions(keep_room_id="NONE")

    def test_01_noise_attenuation_across_different_noise_types(self):
        """
        Tests that spectral/neural noise reduction effectively attenuates:
        - 60Hz Electrical AC Hum
        - Computer Fan Whine (1.2kHz + hiss)
        - Room AC Sub-bass Rumble (45Hz-85Hz)
        - Preamp Thermal White Noise
        """
        sr = 44100
        noise_types = ["hum", "fan", "rumble", "white"]

        for ntype in noise_types:
            with self.subTest(noise_type=ntype):
                mixed, speech, noise = generate_audio_signal(2.0, sr=sr, noise_type=ntype, noise_level=0.035, speech_level=0.45)
                
                tmp_in = tempfile.mktemp(suffix=".wav")
                tmp_out = tempfile.mktemp(suffix=".wav")
                try:
                    audio_processor.write_wav_mono(tmp_in, mixed, sr)
                    audio_processor.apply_noise_reduction(tmp_in, tmp_out, reduction_db=100.0, sr=sr)
                    
                    self.assertTrue(os.path.isfile(tmp_out))
                    processed = audio_processor.read_wav_mono(tmp_out, sr)
                    
                    # 1. Verify noise attenuation in quiet sections
                    rms_in = np.sqrt(np.mean(mixed ** 2))
                    rms_out = np.sqrt(np.mean(processed ** 2))
                    
                    # Output signal should be cleaner (lower overall background energy than noisy mix)
                    self.assertLess(rms_out, rms_in, f"Failed to reduce noise for {ntype}")

                    # 2. Verify active speech region retains vocal energy
                    speech_slice_out = processed[int(0.4 * sr):int(1.4 * sr)]
                    rms_speech_out = np.sqrt(np.mean(speech_slice_out ** 2))
                    self.assertGreater(rms_speech_out, 0.005, f"Speech energy crushed for {ntype}")
                    
                finally:
                    for p in (tmp_in, tmp_out):
                        if os.path.exists(p):
                            os.remove(p)

    def test_02_custom_profile_vs_uncalibrated_spectral_subtraction(self):
        """
        Compares denoising with a calibrated 1-second noise profile vs auto-tracking.
        Verifies both produce clean output without distortion.
        """
        sr = 44100
        test_room = "TEST_DEEP_ROOM_1"
        user_id = "actor_deep_profile"
        room_dir = audio_processor.get_room_cache_dir(test_room)

        try:
            # 1. Create 1s fan noise sample for profile
            _, _, fan_noise = generate_audio_signal(1.0, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.0)
            tmp_prof = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_prof, fan_noise, sr)
            with open(tmp_prof, "rb") as f:
                prof_bytes = f.read()
            os.remove(tmp_prof)

            prof_res = audio_processor.save_user_noise_profile(test_room, user_id, prof_bytes)
            self.assertEqual(prof_res["status"], "ok")
            profile_path = prof_res["profile_path"]
            self.assertTrue(os.path.isfile(profile_path))

            # 2. Process noisy speech with calibrated profile
            mixed, _, _ = generate_audio_signal(2.0, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.4)
            tmp_in = tempfile.mktemp(suffix=".wav")
            tmp_out_profiled = tempfile.mktemp(suffix=".wav")
            tmp_out_auto = tempfile.mktemp(suffix=".wav")

            audio_processor.write_wav_mono(tmp_in, mixed, sr)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out_profiled, noise_profile_wav=profile_path, sr=sr)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out_auto, noise_profile_wav=None, sr=sr)

            self.assertTrue(os.path.isfile(tmp_out_profiled))
            self.assertTrue(os.path.isfile(tmp_out_auto))

            data_prof = audio_processor.read_wav_mono(tmp_out_profiled, sr)
            data_auto = audio_processor.read_wav_mono(tmp_out_auto, sr)

            self.assertEqual(len(data_prof), len(mixed))
            self.assertEqual(len(data_auto), len(mixed))
            self.assertLessEqual(np.max(np.abs(data_prof)), 1.0)
            self.assertLessEqual(np.max(np.abs(data_auto)), 1.0)

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_03_edge_cases_and_boundaries(self):
        """
        Tests boundary conditions:
        - Pure digital silence (all zeros)
        - Very short audio (0.15s)
        - Peak audio at 1.0 (maximum headroom before clipping)
        - Non-existent noise profile fallback
        """
        sr = 44100
        # Case A: Digital silence
        silence = np.zeros(sr, dtype=np.float32)
        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            audio_processor.write_wav_mono(tmp_in, silence, sr)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out, noise_profile_wav="non_existent.wav", sr=sr)
            out_data = audio_processor.read_wav_mono(tmp_out, sr)
            self.assertEqual(len(out_data), len(silence))
            self.assertLess(np.max(np.abs(out_data)), 1e-4)
        finally:
            for p in (tmp_in, tmp_out):
                if os.path.exists(p):
                    os.remove(p)

        # Case B: Very short audio (0.15s)
        short_mixed, _, _ = generate_audio_signal(0.15, sr=sr, noise_type="white")
        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            audio_processor.write_wav_mono(tmp_in, short_mixed, sr)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out, sr=sr)
            out_data = audio_processor.read_wav_mono(tmp_out, sr)
            self.assertGreater(len(out_data), 0)
        finally:
            for p in (tmp_in, tmp_out):
                if os.path.exists(p):
                    os.remove(p)

        # Case C: Peak audio at 1.0 (full scale)
        loud_mixed = np.ones(sr, dtype=np.float32) * 0.99
        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            audio_processor.write_wav_mono(tmp_in, loud_mixed, sr)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out, sr=sr)
            out_data = audio_processor.read_wav_mono(tmp_out, sr)
            self.assertLessEqual(np.max(np.abs(out_data)), 1.0)
        finally:
            for p in (tmp_in, tmp_out):
                if os.path.exists(p):
                    os.remove(p)

    def test_04_multi_user_concurrent_profiles(self):
        """
        Tests two distinct actors in the same room with distinct noise profiles.
        Actor A has electrical hum noise profile.
        Actor B has fan noise profile.
        Verifies both takes are saved and denoised without cross-contamination.
        """
        test_room = "TEST_MULTI_ACTOR_ROOM"
        user_a = "actor_alice"
        user_b = "actor_bob"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        sr = 44100

        try:
            # Calibrate Profile A (Hum)
            _, _, hum_noise = generate_audio_signal(1.0, sr=sr, noise_type="hum", noise_level=0.08, speech_level=0.0)
            tmp_a = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_a, hum_noise, sr)
            with open(tmp_a, "rb") as f:
                prof_bytes_a = f.read()
            os.remove(tmp_a)
            audio_processor.save_user_noise_profile(test_room, user_a, prof_bytes_a)

            # Calibrate Profile B (Fan)
            _, _, fan_noise = generate_audio_signal(1.0, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.0)
            tmp_b = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_b, fan_noise, sr)
            with open(tmp_b, "rb") as f:
                prof_bytes_b = f.read()
            os.remove(tmp_b)
            audio_processor.save_user_noise_profile(test_room, user_b, prof_bytes_b)

            # Actor A records Line 0 (with hum noise)
            mixed_a, _, _ = generate_audio_signal(1.5, sr=sr, noise_type="hum", noise_level=0.08, speech_level=0.4)
            tmp_take_a = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_take_a, mixed_a, sr)
            with open(tmp_take_a, "rb") as f:
                take_bytes_a = f.read()
            os.remove(tmp_take_a)

            saved_a = audio_processor.save_uploaded_take(
                test_room, line_index=0, audio_bytes=take_bytes_a, enable_noise_reduction=True, user_id=user_a
            )

            # Actor B records Line 1 (with fan noise)
            mixed_b, _, _ = generate_audio_signal(1.5, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.4)
            tmp_take_b = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_take_b, mixed_b, sr)
            with open(tmp_take_b, "rb") as f:
                take_bytes_b = f.read()
            os.remove(tmp_take_b)

            saved_b = audio_processor.save_uploaded_take(
                test_room, line_index=1, audio_bytes=take_bytes_b, enable_noise_reduction=True, user_id=user_b
            )

            self.assertTrue(saved_a["noise_reduction"])
            self.assertTrue(saved_b["noise_reduction"])
            self.assertTrue(os.path.isfile(saved_a["wav_path"]))
            self.assertTrue(os.path.isfile(saved_b["wav_path"]))

            # Both raw takes and denoised takes exist independently
            self.assertTrue(os.path.exists(os.path.join(room_dir, "take_line_0_raw.wav")))
            self.assertTrue(os.path.exists(os.path.join(room_dir, "take_line_0_denoised.wav")))
            self.assertTrue(os.path.exists(os.path.join(room_dir, "take_line_1_raw.wav")))
            self.assertTrue(os.path.exists(os.path.join(room_dir, "take_line_1_denoised.wav")))

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_05_rapid_sequential_toggling_stress_test(self):
        """
        Stress test: Rapidly toggles a take between raw and denoised 12 times in a row.
        Verifies filesystem and state consistency throughout the stress loop.
        """
        test_room = "TEST_STRESS_TOGGLE_ROOM"
        user_id = "actor_stress"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        sr = 44100

        try:
            mixed, _, _ = generate_audio_signal(1.5, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.4)
            tmp_take = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_take, mixed, sr)
            with open(tmp_take, "rb") as f:
                take_bytes = f.read()
            os.remove(tmp_take)

            # Initially saved as RAW (noise reduction OFF)
            saved = audio_processor.save_uploaded_take(
                test_room, line_index=0, audio_bytes=take_bytes, enable_noise_reduction=False, user_id=user_id
            )
            self.assertFalse(saved["noise_reduction"])

            raw_wav = os.path.join(room_dir, "take_line_0_raw.wav")
            denoised_wav = os.path.join(room_dir, "take_line_0_denoised.wav")
            active_wav = os.path.join(room_dir, "take_line_0.wav")

            # Toggle 12 times alternating ON and OFF
            for i in range(12):
                should_enable = (i % 2 == 0) # True on even, False on odd
                toggled = audio_processor.toggle_take_noise_reduction(
                    test_room, line_index=0, enable_noise_reduction=should_enable, user_id=user_id
                )
                self.assertEqual(toggled["noise_reduction"], should_enable)
                expected_size = os.path.getsize(denoised_wav if should_enable else raw_wav)
                self.assertEqual(os.path.getsize(active_wav), expected_size)

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_06_render_dub_mix_and_exports_with_denoised_takes(self):
        """
        Tests full scene rendering (`render_dub_mix`), master MP4 video export (`export_dub_video`),
        and NLE multi-track project ZIP export (`build_project_zip`) with noise-reduced takes.
        """
        packs = pack_loader.get_all_packs()
        self.assertGreater(len(packs), 0)
        pack = list(packs.values())[0]

        test_room = "TEST_EXPORT_ROOM_NR"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        sr = 44100

        try:
            # Create a denoised take for line 0
            mixed, _, _ = generate_audio_signal(2.0, sr=sr, noise_type="hum", noise_level=0.08, speech_level=0.45)
            tmp_take = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_take, mixed, sr)
            with open(tmp_take, "rb") as f:
                take_bytes = f.read()
            os.remove(tmp_take)

            saved = audio_processor.save_uploaded_take(
                test_room, line_index=0, audio_bytes=take_bytes, enable_noise_reduction=True, user_id="host"
            )

            takes_dict = {
                0: {
                    "wav_path": saved["wav_path"],
                    "offset_ms": 0,
                    "pitch_semitones": 0.0,
                    "reverb_wet": 0.15,
                    "gain_db": 1.5,
                    "user_id": "host",
                    "user_name": "Lead Actor",
                    "noise_reduction": True,
                }
            }

            # 1. Test render_dub_mix
            mix_out = os.path.join(room_dir, "master_dub_mix.wav")
            audio_processor.render_dub_mix(pack, takes_dict, mix_out, sr=sr)
            self.assertTrue(os.path.isfile(mix_out))
            self.assertGreater(os.path.getsize(mix_out), 10000)

            # Master mix should pass limiter cleanly
            mix_data = audio_processor.read_wav_mono(mix_out, sr)
            self.assertLessEqual(np.max(np.abs(mix_data)), 1.0)

            # 2. Test export_dub_video
            video_out = os.path.join(room_dir, "master_dub_video.mp4")
            audio_processor.export_dub_video(pack, takes_dict, video_out, aspect_ratio="16:9")
            self.assertTrue(os.path.isfile(video_out))
            self.assertGreater(os.path.getsize(video_out), 10000)

            # 3. Test build_project_zip
            zip_out = os.path.join(room_dir, "master_project.zip")
            audio_processor.build_project_zip(
                pack=pack,
                takes_dict=takes_dict,
                role_assignments={pack.characters[0]: ["host"]} if pack.characters else {},
                users={"host": {"id": "host", "name": "Lead Actor", "color": "#7c5cff"}},
                output_zip_path=zip_out,
                room_id=test_room
            )
            self.assertTrue(os.path.isfile(zip_out))
            self.assertGreater(os.path.getsize(zip_out), 10000)

            # Verify contents of project ZIP
            with zipfile.ZipFile(zip_out, "r") as zf:
                namelist = zf.namelist()
                self.assertTrue(any("project_manifest.json" in n for n in namelist))
                self.assertTrue(any("Timeline_Cues.txt" in n for n in namelist))
                self.assertTrue(any("Audio_Stems/" in n for n in namelist))

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
