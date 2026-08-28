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
import numpy as np
from starlette.testclient import TestClient

import audio_processor
import pack_loader
import app


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
        app.prune_sessions(keep_room_id="NONE")

    def test_01_apply_noise_reduction_filters(self):
        """Verifies that apply_noise_reduction processes audio and preserves signal without clipping."""
        sr = 44100
        noisy_bytes = generate_synthetic_wav_bytes(1.0, sr=sr, add_noise=True)
        
        tmp_in = tempfile.mktemp(suffix=".wav")
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            with open(tmp_in, "wb") as f:
                f.write(noisy_bytes)

            out_path = audio_processor.apply_noise_reduction(tmp_in, tmp_out, reduction_db=14.0, sr=sr)
            self.assertTrue(os.path.isfile(out_path))
            self.assertGreater(os.path.getsize(out_path), 1000)

            data_out = audio_processor.read_wav_mono(tmp_out, sr)
            self.assertLessEqual(np.max(np.abs(data_out)), 1.0)
            self.assertGreater(len(data_out), 0)
        finally:
            for p in (tmp_in, tmp_out):
                if os.path.exists(p):
                    os.remove(p)

    def test_02_save_user_noise_profile(self):
        """Tests 1-second room noise profile calibration."""
        test_room = "TEST_NR_ROOM_1"
        test_user = "user_calib_test"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        
        noise_bytes = generate_synthetic_wav_bytes(1.0, add_noise=True)
        try:
            result = audio_processor.save_user_noise_profile(test_room, test_user, noise_bytes)
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["user_id"], test_user)
            self.assertTrue(os.path.isfile(result["profile_path"]))
            self.assertIn("noise_floor_db", result)
        finally:
            shutil.rmtree(room_dir, ignore_errors=True)

    def test_03_save_uploaded_take_dual_preservation(self):
        """Tests that save_uploaded_take preserves raw take while generating denoised take."""
        test_room = "TEST_NR_ROOM_2"
        test_user = "user_dual_test"
        room_dir = audio_processor.get_room_cache_dir(test_room)
        
        take_bytes = generate_synthetic_wav_bytes(1.5, add_noise=True)
        try:
            saved = audio_processor.save_uploaded_take(
                test_room,
                line_index=0,
                audio_bytes=take_bytes,
                enable_noise_reduction=True,
                user_id=test_user
            )

            self.assertTrue(saved["noise_reduction"])
            self.assertTrue(saved["has_raw"])
            self.assertTrue(os.path.isfile(saved["wav_path"]))
            self.assertTrue(os.path.isfile(saved["raw_path"]))
            self.assertTrue(os.path.isfile(saved["denoised_path"]))

            raw_wav = os.path.join(room_dir, "take_line_0_raw.wav")
            denoised_wav = os.path.join(room_dir, "take_line_0_denoised.wav")
            active_wav = os.path.join(room_dir, "take_line_0.wav")

            self.assertTrue(os.path.exists(raw_wav))
            self.assertTrue(os.path.exists(denoised_wav))
            self.assertTrue(os.path.exists(active_wav))

            # Active take should equal denoised take
            self.assertEqual(os.path.getsize(active_wav), os.path.getsize(denoised_wav))

            # Toggle to raw (noise reduction off)
            toggled_off = audio_processor.toggle_take_noise_reduction(
                test_room,
                line_index=0,
                enable_noise_reduction=False,
                user_id=test_user
            )
            self.assertFalse(toggled_off["noise_reduction"])
            self.assertEqual(os.path.getsize(active_wav), os.path.getsize(raw_wav))

            # Toggle back to denoised (noise reduction on)
            toggled_on = audio_processor.toggle_take_noise_reduction(
                test_room,
                line_index=0,
                enable_noise_reduction=True,
                user_id=test_user
            )
            self.assertTrue(toggled_on["noise_reduction"])
            self.assertEqual(os.path.getsize(active_wav), os.path.getsize(denoised_wav))

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

        try:
            # 2. Upload Noise Profile
            noise_bytes = generate_synthetic_wav_bytes(1.0, add_noise=True)
            files = {"file": ("noise.wav", noise_bytes, "audio/wav")}
            data = {"user_id": user_id}
            res_prof = self.client.post(f"/api/rooms/{room_id}/noise_profile", files=files, data=data)
            self.assertEqual(res_prof.status_code, 200)
            prof_json = res_prof.json()
            self.assertEqual(prof_json["status"], "ok")

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
            }
            res_take = self.client.post(f"/api/rooms/{room_id}/takes/0", files=take_files, data=take_data)
            self.assertEqual(res_take.status_code, 200)
            take_resp = res_take.json()["take"]
            self.assertTrue(take_resp["noise_reduction"])
            self.assertTrue(take_resp["has_raw"])

            # 4. Toggle Take Noise Reduction to OFF via API
            res_toggle = self.client.post(
                f"/api/rooms/{room_id}/takes/0/noise_reduction",
                json={"noise_reduction": False}
            )
            self.assertEqual(res_toggle.status_code, 200)
            toggled_take = res_toggle.json()["take"]
            self.assertFalse(toggled_take["noise_reduction"])

            # 5. Fetch take audio stream
            res_audio = self.client.get(f"/api/rooms/{room_id}/takes/0/audio")
            self.assertIn(res_audio.status_code, (200, 206))
            self.assertGreater(len(res_audio.content), 1000)

        finally:
            app.prune_sessions(keep_room_id="NONE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
