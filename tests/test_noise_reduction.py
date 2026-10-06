# -*- coding: utf-8 -*-
"""
test_noise_reduction.py
Automated tests for Studio Noise Reduction, Mic Noise Profiling, Dual-Take Retention,
and on-demand toggling using Python's standard unittest framework.
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock
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


def generate_synthetic_wav_bytes(duration_sec: float = 1.5, sr: int = 44100, add_noise: bool = True) -> bytes:
    """Generates synthetic speech-like harmonic tone with background noise as PCM WAV bytes."""
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False, dtype=np.float32)
    # Speech tone: fundamental 220Hz + harmonics
    speech = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.15 * np.sin(2 * np.pi * 440 * t)
    # Background hiss + 60Hz hum
    noise = 0.08 * (np.random.rand(len(t)).astype(np.float32) * 2.0 - 1.0) + 0.05 * np.sin(2 * np.pi * 60 * t) if add_noise else 0.0
    mix = np.clip(speech + noise, -1.0, 1.0)
    
    tmp = tempfile.mktemp(suffix=".wav")
    try:
        audio_processor.write_wav_mono(tmp, mix, sr)
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


class TestStudioNoiseReduction(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app.app)
        cls.client.__enter__()
        cls.client.get("/api/packs")

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        rooms.prune_sessions(keep_room_id="NONE")

    def test_01_apply_noise_reduction_filters(self):
        """Verifies that apply_noise_reduction processes audio and preserves signal without clipping."""
        sr = 44100
        noisy_bytes = generate_synthetic_wav_bytes(1.0, sr=sr, add_noise=True)
        
        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            with open(tmp_in, "wb") as f:
                f.write(noisy_bytes)

            out_path = audio_processor.apply_noise_reduction(tmp_in, tmp_out, sr=sr)
            self.assertTrue(os.path.isfile(out_path))
            self.assertGreater(os.path.getsize(out_path), 1000)

            data_out = audio_processor.read_wav_mono(tmp_out, sr)
            self.assertLessEqual(np.max(np.abs(data_out)), 1.0)
            self.assertGreater(len(data_out), 0)
        finally:
            for p in (tmp_in, tmp_out):
                if os.path.exists(p):
                    os.remove(p)

    def test_02_save_noise_profile_round_trip(self):
        """A stored room check reads back with its report, file and cleanup settings."""
        cache = tempfile.mkdtemp(prefix="dm_nr_profile_")
        try:
            with mock.patch.object(audio_processor, "CACHE_DIR", cache):
                noise = (0.003 * np.random.default_rng(3).standard_normal(44100 * 3)).astype(np.float32)
                profile_id, stats = audio_processor.save_noise_profile(noise, 44100, device_id="d1")
                self.assertRegex(profile_id, r"^[0-9a-f]{12}$")
                loaded = audio_processor.load_noise_profile_stats(profile_id)
                self.assertEqual(loaded["profile_id"], profile_id)
                self.assertEqual(loaded["device_id"], "d1")
                self.assertEqual(loaded["verdict"], stats["verdict"])
                self.assertTrue(os.path.isfile(audio_processor.noise_profile_wav_path(profile_id)))
                self.assertEqual(audio_processor.noise_cleanup_settings(profile_id)["profile_id"], profile_id)
                self.assertTrue(audio_processor.delete_noise_profile(profile_id))
                self.assertIsNone(audio_processor.load_noise_profile_stats(profile_id))
        finally:
            shutil.rmtree(cache, ignore_errors=True)

    def test_03_save_uploaded_take_dual_preservation(self):
        """Tests that save_uploaded_take preserves raw take while generating denoised take."""
        test_room = "TEST_NR_ROOM_2"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        
        take_bytes = generate_synthetic_wav_bytes(1.5, add_noise=True)
        try:
            saved = audio_processor.save_uploaded_take(
                test_room,
                room_dir, "take_line_0",
                audio_bytes=take_bytes,
                enable_noise_reduction=True,
            )

            self.assertTrue(saved["noise_reduction"])
            self.assertIsNone(saved["nr_settings"])
            self.assertTrue(saved["has_raw"])
            self.assertTrue(os.path.isfile(saved["wav_path"]))
            self.assertTrue(os.path.isfile(saved["raw_path"]))
            self.assertTrue(os.path.isfile(saved["denoised_path"]))

            raw_wav = os.path.join(room_dir, "take_line_0_raw.wav")
            denoised_wav = audio_processor.denoised_take_path(room_dir, "take_line_0")
            self.assertEqual(saved["denoised_path"], denoised_wav)
            active_wav = os.path.join(room_dir, "take_line_0.wav")

            self.assertTrue(os.path.exists(raw_wav))
            self.assertTrue(os.path.exists(denoised_wav))
            self.assertTrue(os.path.exists(active_wav))

            # Active take should equal denoised take
            self.assertEqual(os.path.getsize(active_wav), os.path.getsize(denoised_wav))

            # Toggle to raw (noise reduction off)
            toggled_off = audio_processor.toggle_take_noise_reduction(
                test_room,
                room_dir, "take_line_0",
                enable_noise_reduction=False,
            )
            self.assertFalse(toggled_off["noise_reduction"])
            self.assertEqual(os.path.getsize(active_wav), os.path.getsize(raw_wav))

            # Toggle back to denoised (noise reduction on)
            toggled_on = audio_processor.toggle_take_noise_reduction(
                test_room,
                room_dir, "take_line_0",
                enable_noise_reduction=True,
            )
            self.assertTrue(toggled_on["noise_reduction"])
            self.assertIsNone(toggled_on["nr_settings"])
            self.assertEqual(os.path.getsize(active_wav), os.path.getsize(denoised_wav))

        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_03b_changed_setting_rebuilds_cleaned_take(self):
        """A changed noise-reduction setting cleans the take again and deletes the old cleaned files."""
        test_room = "TEST_NR_ROOM_REFRESH"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        take_bytes = generate_synthetic_wav_bytes(1.0, add_noise=True)
        try:
            saved = audio_processor.save_uploaded_take(
                test_room, room_dir, "take_line_0", audio_bytes=take_bytes, enable_noise_reduction=True
            )
            old_denoised = saved["denoised_path"]
            raw_wav = os.path.join(room_dir, "take_line_0_raw.wav")
            self.assertTrue(os.path.isfile(old_denoised))
            # A cleaned file left by an older version, and another line's cleaned take.
            legacy = os.path.join(room_dir, "take_line_0_denoised.wav")
            shutil.copy2(old_denoised, legacy)
            other_line = os.path.join(room_dir, "take_line_10_denoised.wav")
            shutil.copy2(old_denoised, other_line)

            # Same settings: the cached cleaned take is reused.
            with mock.patch.object(audio_processor, "apply_noise_reduction") as nr:
                audio_processor.toggle_take_noise_reduction(test_room, room_dir, "take_line_0", enable_noise_reduction=True)
            nr.assert_not_called()

            # Changed setting: a fresh cleaned file is written and the old ones are removed.
            with mock.patch.object(audio_processor, "NR_ATTENUATION_DB", 20.0):
                new_denoised = audio_processor.denoised_take_path(room_dir, "take_line_0")
                self.assertNotEqual(new_denoised, old_denoised)
                toggled = audio_processor.toggle_take_noise_reduction(test_room, room_dir, "take_line_0", enable_noise_reduction=True)
            self.assertTrue(toggled["noise_reduction"])
            self.assertTrue(os.path.isfile(new_denoised))
            self.assertFalse(os.path.exists(old_denoised))
            self.assertFalse(os.path.exists(legacy))
            self.assertTrue(os.path.exists(other_line))
            self.assertTrue(os.path.isfile(raw_wav))

            # A new recording saved without noise reduction drops the stale cleaned take.
            audio_processor.save_uploaded_take(test_room, room_dir, "take_line_0", audio_bytes=take_bytes, enable_noise_reduction=False)
            self.assertFalse(os.path.exists(new_denoised))
            self.assertTrue(os.path.isfile(raw_wav))
        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_04_api_noise_profile_and_take_endpoints(self):
        """End-to-end FastAPI test for noise profile calibration and take upload with noise reduction."""
        packs = pack_loader.get_all_packs()
        self.assertGreater(len(packs), 0, "Expected at least one pack for testing")
        pack_id = list(packs.keys())[0]

        # 1. Create Room
        res = self.client.post("/api/rooms", json={"pack_id": pack_id, "host_name": "TestActor"})
        self.assertEqual(res.status_code, 200)
        room_data = res.json()
        room_id = room_data["room_id"]
        user_id = room_data["user_id"]
        profile_id = None

        try:
            # 2. Room check: 3.3 s of quiet room tone
            noise = (0.003 * np.random.default_rng(4).standard_normal(int(44100 * 3.3))).astype(np.float32)
            noise_wav = tempfile.mktemp(suffix=".wav")
            audio_processor.write_wav_mono(noise_wav, noise, 44100)
            with open(noise_wav, "rb") as f:
                noise_bytes = f.read()
            os.remove(noise_wav)
            res_prof = self.client.post("/api/noise_profiles",
                                        files={"file": ("check.wav", noise_bytes, "audio/wav")})
            self.assertEqual(res_prof.status_code, 200, res_prof.text)
            profile_id = res_prof.json()["profile_id"]
            self.assertRegex(profile_id, r"^[0-9a-f]{12}$")

            # 3. Upload Take with Noise Reduction ON
            take_bytes = generate_synthetic_wav_bytes(1.2, add_noise=True)
            take_files = {"file": ("take_0.wav", take_bytes, "audio/wav")}
            take_data = {
                "user_id": user_id,
                "user_name": "TestActor",
                "offset_ms": "0",
                "pitch_semitones": "0.0",
                "reverb_wet": "0.0",
                "gain_db": "0.0",
                "noise_reduction": "true",
                "noise_profile_id": profile_id,
            }
            line_id = room_data["state"]["pack"]["lines"][0]["line_id"]
            res_take = self.client.post(f"/api/rooms/{room_id}/lines/{line_id}/takes", files=take_files, data=take_data)
            self.assertEqual(res_take.status_code, 200)
            take_resp = res_take.json()["take"]
            self.assertTrue(take_resp["noise_reduction"])
            self.assertTrue(take_resp["has_raw"])
            self.assertEqual(take_resp["nr_settings"]["profile_id"], profile_id)
            stored = rooms.ROOMS[room_id].find_take(line_id, take_resp["take_id"])
            self.assertEqual(stored["nr_settings"], audio_processor.noise_cleanup_settings(profile_id))

            # 4. Toggle Take Noise Reduction to OFF via API
            res_toggle = self.client.post(
                f"/api/rooms/{room_id}/lines/{line_id}/takes/{take_resp['take_id']}/noise_reduction",
                json={"noise_reduction": False}
            )
            self.assertEqual(res_toggle.status_code, 200)
            toggled_take = res_toggle.json()["take"]
            self.assertFalse(toggled_take["noise_reduction"])

            # 5. Fetch take audio stream
            res_audio = self.client.get(f"/api/rooms/{room_id}/lines/{line_id}/takes/{take_resp['take_id']}/audio")
            self.assertIn(res_audio.status_code, (200, 206))
            self.assertGreater(len(res_audio.content), 1000)

        finally:
            if profile_id:
                audio_processor.delete_noise_profile(profile_id)
            rooms.prune_sessions(keep_room_id="NONE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
