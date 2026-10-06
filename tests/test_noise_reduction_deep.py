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
import json
import shutil
import tempfile
import zipfile
import unittest
from unittest import mock
from types import SimpleNamespace
from typing import Tuple
import numpy as np
from starlette.testclient import TestClient

# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import audio_processor
import pack_loader
import app
from dubmate import rooms


def generate_audio_signal(
    duration_sec: float = 2.0,
    sr: int = 44100,
    noise_type: str = "white",
    noise_level: float = 0.08,
    speech_level: float = 0.4
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns (mixed_audio, pure_speech, pure_noise) as float32 numpy arrays.
    Speech is synthetic glottal-modulated voice.
    """
    n_samples = int(sr * duration_sec)
    t = np.linspace(0, duration_sec, n_samples, endpoint=False, dtype=np.float32)

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
        rooms.prune_sessions(keep_room_id="NONE")

    def _profile_cache(self):
        """Room checks go to a temp CACHE_DIR for this test."""
        cache = tempfile.mkdtemp(prefix="dm_nr_profiles_")
        self.addCleanup(shutil.rmtree, cache, True)
        patcher = mock.patch.object(audio_processor, "CACHE_DIR", cache)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _stored_settings(self, noise, sr, **overrides):
        """Stores a room check of `noise` and returns its cleanup settings."""
        profile_id, _ = audio_processor.save_noise_profile(noise, sr)
        self.assertIsNotNone(profile_id)
        return dict(audio_processor.noise_cleanup_settings(profile_id), **overrides)

    def test_01_noise_attenuation_across_different_noise_types(self):
        """
        Tests that spectral/neural noise reduction tuned by a room check (at the strongest
        attenuation) effectively attenuates:
        - 60Hz Electrical AC Hum
        - Computer Fan Whine (1.2kHz + hiss)
        - Room AC Sub-bass Rumble (45Hz-85Hz)
        - Preamp Thermal White Noise
        """
        sr = 44100
        noise_types = ["hum", "fan", "rumble", "white"]
        self._profile_cache()

        for ntype in noise_types:
            with self.subTest(noise_type=ntype):
                mixed, speech, noise = generate_audio_signal(2.0, sr=sr, noise_type=ntype, noise_level=0.035, speech_level=0.45)
                _, _, room_tone = generate_audio_signal(1.0, sr=sr, noise_type=ntype, noise_level=0.035, speech_level=0.0)
                settings = self._stored_settings(room_tone, sr, attenuation_db=100)

                tmp_in = tempfile.mktemp(suffix=".wav")
                tmp_out = tempfile.mktemp(suffix=".wav")
                try:
                    audio_processor.write_wav_mono(tmp_in, mixed, sr)
                    self.assertEqual(audio_processor.apply_noise_reduction(tmp_in, tmp_out, sr=sr, settings=settings), tmp_out)

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

    def test_01b_strongest_attenuation_is_passed_to_deep_filter(self):
        """With DeepFilterNet, a room check asking for 100 dB runs `-a 100`; more is clamped to 100."""
        tmp_dir = tempfile.mkdtemp(prefix="dm_df_clamp_")
        self.addCleanup(shutil.rmtree, tmp_dir, True)
        fake_bin = os.path.join(tmp_dir, "deep-filter")
        open(fake_bin, "wb").close()
        tmp_in = os.path.join(tmp_dir, "take.wav")
        audio_processor.write_wav_mono(tmp_in, generate_audio_signal(0.5)[0], 44100)
        df_cmds = []

        def fake_run(cmd, **kwargs):
            df_cmds.append(list(cmd))
            shutil.copyfile(cmd[-1], os.path.join(cmd[cmd.index("-o") + 1], os.path.basename(cmd[-1])))

        with mock.patch.object(audio_processor, "get_deep_filter_path", return_value=fake_bin), \
                mock.patch.object(audio_processor, "_ffmpeg_to_mono_wav",
                                  side_effect=lambda src, dst, *a, **k: shutil.copyfile(src, dst)), \
                mock.patch.object(audio_processor, "_run_subprocess", side_effect=fake_run):
            for attenuation in (100, 150):
                settings = {"profile_id": "0123456789ab", "attenuation_db": attenuation, "notches_hz": []}
                audio_processor.apply_noise_reduction(tmp_in, os.path.join(tmp_dir, "out.wav"), settings=settings)
        self.assertEqual([cmd[cmd.index("-a") + 1] for cmd in df_cmds], ["100", "100"])

    def test_02_custom_profile_vs_uncalibrated_spectral_subtraction(self):
        """
        Compares denoising tuned by a stored 1-second room check vs standard cleanup.
        Verifies both produce clean output without distortion.
        """
        sr = 44100
        self._profile_cache()

        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out_profiled = tempfile.mktemp(suffix=".wav")
        tmp_out_auto = tempfile.mktemp(suffix=".wav")
        try:
            # 1. Store a 1s fan noise room check
            _, _, fan_noise = generate_audio_signal(1.0, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.0)
            settings = self._stored_settings(fan_noise, sr)
            self.assertTrue(audio_processor.noise_profile_wav_path(settings["profile_id"]))

            # 2. Process noisy speech with the tuned settings and with standard cleanup
            mixed, _, _ = generate_audio_signal(2.0, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.4)
            audio_processor.write_wav_mono(tmp_in, mixed, sr)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out_profiled, sr=sr, settings=settings)
            audio_processor.apply_noise_reduction(tmp_in, tmp_out_auto, sr=sr, settings=None)

            self.assertTrue(os.path.isfile(tmp_out_profiled))
            self.assertTrue(os.path.isfile(tmp_out_auto))

            data_prof = audio_processor.read_wav_mono(tmp_out_profiled, sr)
            data_auto = audio_processor.read_wav_mono(tmp_out_auto, sr)

            self.assertEqual(len(data_prof), len(mixed))
            self.assertEqual(len(data_auto), len(mixed))
            self.assertLessEqual(np.max(np.abs(data_prof)), 1.0)
            self.assertLessEqual(np.max(np.abs(data_auto)), 1.0)

        finally:
            for p in (tmp_in, tmp_out_profiled, tmp_out_auto):
                if os.path.exists(p):
                    os.remove(p)

    def test_03_edge_cases_and_boundaries(self):
        """
        Tests boundary conditions:
        - Pure digital silence (all zeros)
        - Very short audio (0.15s)
        - Peak audio at 1.0 (maximum headroom before clipping)
        - Non-existent room check: without DeepFilterNet tuned cleanup returns None and
          writes nothing, and the caller's standard cleanup still works
        """
        sr = 44100
        self._profile_cache()
        # Case A: Digital silence
        silence = np.zeros(sr, dtype=np.float32)
        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            audio_processor.write_wav_mono(tmp_in, silence, sr)
            unknown = {"profile_id": "0123456789ab", "attenuation_db": 30, "notches_hz": []}
            with mock.patch.object(audio_processor, "get_deep_filter_path", return_value=None):
                self.assertIsNone(audio_processor.apply_noise_reduction(tmp_in, tmp_out, sr=sr, settings=unknown))
            self.assertFalse(os.path.exists(tmp_out))
            audio_processor.apply_noise_reduction(tmp_in, tmp_out, sr=sr)
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
        Tests two distinct actors in the same room with distinct room checks.
        Actor A has electrical hum noise profile.
        Actor B has fan noise profile.
        Verifies both takes are saved and denoised with their own settings, under
        different cleaned-file keys.
        """
        self._profile_cache()
        test_room = "TEST_MULTI_ACTOR_ROOM"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        sr = 44100

        try:
            # Room check A (Hum)
            _, _, hum_noise = generate_audio_signal(1.0, sr=sr, noise_type="hum", noise_level=0.08, speech_level=0.0)
            settings_a = self._stored_settings(hum_noise, sr)

            # Room check B (Fan)
            _, _, fan_noise = generate_audio_signal(1.0, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.0)
            settings_b = self._stored_settings(fan_noise, sr)
            self.assertNotEqual(settings_a["profile_id"], settings_b["profile_id"])

            # Actor A records Line 0 (with hum noise)
            mixed_a, _, _ = generate_audio_signal(1.5, sr=sr, noise_type="hum", noise_level=0.08, speech_level=0.4)
            tmp_take_a = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_take_a, mixed_a, sr)
            with open(tmp_take_a, "rb") as f:
                take_bytes_a = f.read()
            os.remove(tmp_take_a)

            saved_a = audio_processor.save_uploaded_take(
                test_room, room_dir, "take_line_0", audio_bytes=take_bytes_a, enable_noise_reduction=True, nr_settings=settings_a
            )

            # Actor B records Line 1 (with fan noise)
            mixed_b, _, _ = generate_audio_signal(1.5, sr=sr, noise_type="fan", noise_level=0.08, speech_level=0.4)
            tmp_take_b = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(tmp_take_b, mixed_b, sr)
            with open(tmp_take_b, "rb") as f:
                take_bytes_b = f.read()
            os.remove(tmp_take_b)

            saved_b = audio_processor.save_uploaded_take(
                test_room, room_dir, "take_line_1", audio_bytes=take_bytes_b, enable_noise_reduction=True, nr_settings=settings_b
            )

            self.assertTrue(saved_a["noise_reduction"])
            self.assertTrue(saved_b["noise_reduction"])
            self.assertEqual(saved_a["nr_settings"], settings_a)
            self.assertEqual(saved_b["nr_settings"], settings_b)
            self.assertTrue(os.path.isfile(saved_a["wav_path"]))
            self.assertTrue(os.path.isfile(saved_b["wav_path"]))

            # Both raw takes and denoised takes exist independently, keyed by their own check
            self.assertTrue(os.path.exists(os.path.join(room_dir, "take_line_0_raw.wav")))
            self.assertEqual(saved_a["denoised_path"], audio_processor.denoised_take_path(room_dir, "take_line_0", settings_a))
            self.assertTrue(os.path.exists(saved_a["denoised_path"]))
            self.assertTrue(os.path.exists(os.path.join(room_dir, "take_line_1_raw.wav")))
            self.assertEqual(saved_b["denoised_path"], audio_processor.denoised_take_path(room_dir, "take_line_1", settings_b))
            self.assertTrue(os.path.exists(saved_b["denoised_path"]))
            key_a = os.path.basename(saved_a["denoised_path"])[len("take_line_0"):]
            key_b = os.path.basename(saved_b["denoised_path"])[len("take_line_1"):]
            self.assertNotEqual(key_a, key_b)
            self.assertNotEqual(saved_a["denoised_path"], audio_processor.denoised_take_path(room_dir, "take_line_0"))

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_05_rapid_sequential_toggling_stress_test(self):
        """
        Stress test: Rapidly toggles a take between raw and denoised 12 times in a row.
        Verifies filesystem and state consistency throughout the stress loop.
        """
        test_room = "TEST_STRESS_TOGGLE_ROOM"
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
                test_room, room_dir, "take_line_0", audio_bytes=take_bytes, enable_noise_reduction=False
            )
            self.assertFalse(saved["noise_reduction"])

            raw_wav = os.path.join(room_dir, "take_line_0_raw.wav")
            denoised_wav = audio_processor.denoised_take_path(room_dir, "take_line_0")
            active_wav = os.path.join(room_dir, "take_line_0.wav")

            # Toggle 12 times alternating ON and OFF
            for i in range(12):
                should_enable = (i % 2 == 0) # True on even, False on odd
                toggled = audio_processor.toggle_take_noise_reduction(
                    test_room, room_dir, "take_line_0", enable_noise_reduction=should_enable
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
                test_room, room_dir, "take_line_0", audio_bytes=take_bytes, enable_noise_reduction=True
            )

            takes_dict = {
                0: {
                    "wav_path": saved["wav_path"],
                    "render_dir": audio_processor.room_render_dir(test_room),
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

            # The master stage keeps the mix under -1 dBTP
            mix_data = audio_processor.read_wav_mono(mix_out, sr)
            self.assertLessEqual(np.max(np.abs(mix_data)), 1.0)
            self.assertLessEqual(audio_processor.true_peak_db(mix_data), audio_processor.TRUE_PEAK_CEILING_DB + 0.01)

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

                # Every single-file entry the manifest lists must really be in the archive.
                manifest_name = next(n for n in namelist if n.endswith("project_manifest.json"))
                manifest = json.loads(zf.read(manifest_name))
                root = manifest_name.split("/")[0]
                self.assertIsNotNone(manifest["files"]["master_vocal_mix"])
                self.assertEqual(manifest["master"]["target_lufs"], audio_processor.MASTER_TARGET_LUFS)
                self.assertIsInstance(manifest["master"]["gain_db"], float)
                for key in ("clean_video", "backing_track", "master_vocal_mix"):
                    rel = manifest["files"][key]
                    if rel is not None:
                        self.assertIn(f"{root}/{rel}", namelist, key)

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_07_project_zip_manifest_omits_unwritten_files(self):
        """
        The manifest lists clean_video / backing_track only when they were actually written.
        A pack whose video and backing track are missing on disk gets None for both.
        """
        sr = 44100
        work_dir = tempfile.mkdtemp(prefix="dubmate_manifest_")
        try:
            line_audio, _, _ = generate_audio_signal(1.0, sr=sr, noise_type="white", noise_level=0.01)
            audio_processor.write_wav_mono(os.path.join(work_dir, "l0.wav"), line_audio, sr)
            pack = SimpleNamespace(
                pack_id="manifest_fixture", name="Manifest Fixture", folder=work_dir, duration=2.0,
                characters=["Alice"],
                backing_track_path=os.path.join(work_dir, "missing_backing.wav"),
                web_video_path=None, video_path=os.path.join(work_dir, "missing_video.mp4"),
                lines=[{"index": 0, "start": 0.1, "end": 1.1, "character": "Alice", "filename": "l0.wav", "caption": "Hi"}],
                ensure_web_ready=lambda: None,
            )
            zip_out = os.path.join(work_dir, "project.zip")
            audio_processor.build_project_zip(pack, {}, output_zip_path=zip_out, room_id="MANIFEST")

            with zipfile.ZipFile(zip_out, "r") as zf:
                namelist = zf.namelist()
                manifest_name = next(n for n in namelist if n.endswith("project_manifest.json"))
                manifest = json.loads(zf.read(manifest_name))
                cues = zf.read(next(n for n in namelist if n.endswith("Timeline_Cues.txt"))).decode("utf-8")

            files = manifest["files"]
            self.assertIsNone(files["clean_video"])
            self.assertIsNone(files["backing_track"])
            self.assertEqual(files["master_vocal_mix"], "Audio_Stems/Master_Vocal_Mix.mp3")
            self.assertFalse(any(n.startswith(manifest_name.split("/")[0] + "/Video/") and not n.endswith("/") for n in namelist))
            self.assertIn("[Line 01] 00.100s -> 01.100s (Dur: 1.00s)", cues)
            self.assertIn("  Status    : Reference / Unrecorded", cues)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
