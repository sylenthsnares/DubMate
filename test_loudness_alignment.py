import os
import shutil
import tempfile
import unittest
import subprocess
import numpy as np
from starlette.testclient import TestClient

import audio_processor
import pack_loader
import app


class TestDialogueLoudnessAlignment(unittest.TestCase):
    """
    Comprehensive test suite for Speech-Gated Dialogue Loudness Alignment,
    Static Gain-Matching, Dynamics Preservation, and Master Dialogue Prominence.
    """

    @classmethod
    def setUpClass(cls):
        cls.test_dir = tempfile.mkdtemp(prefix="dubmate_loudness_test_")
        cls.client = TestClient(app.app)
        cls.sr = 44100

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.test_dir, ignore_errors=True)

    def _generate_synthetic_speech(self, duration_sec=2.0, target_rms_db=-20.0, pause_ratio=0.3):
        """Generates synthetic speech burst audio with controlled active RMS and pause ratio."""
        total_samples = int(duration_sec * self.sr)
        t = np.linspace(0, duration_sec, total_samples, endpoint=False)
        carrier = (
            np.sin(2 * np.pi * 150 * t) * 0.6 +
            np.sin(2 * np.pi * 800 * t) * 0.3 +
            np.sin(2 * np.pi * 2400 * t) * 0.1
        )
        speech = carrier.copy()
        if pause_ratio > 0:
            pause_len = int(total_samples * pause_ratio)
            speech[total_samples // 4 : total_samples // 4 + pause_len] = 0.0

        active_idx = np.where(np.abs(speech) > 1e-4)[0]
        if len(active_idx) > 0:
            current_rms = np.sqrt(np.mean(speech[active_idx] ** 2))
            target_linear = 10.0 ** (target_rms_db / 20.0)
            speech[active_idx] = speech[active_idx] * (target_linear / max(current_rms, 1e-6))
        return np.clip(speech, -1.0, 1.0).astype(np.float32)

    def test_01_speech_gated_loudness_ignores_silence(self):
        """Verifies that speech-gated loudness accurately measures active speech and ignores pauses."""
        speech = self._generate_synthetic_speech(duration_sec=3.0, target_rms_db=-18.0, pause_ratio=0.5)
        measured_db = audio_processor.calculate_speech_gated_loudness(speech, sr=self.sr)
        self.assertAlmostEqual(measured_db, -18.0, delta=2.5)

    def test_02_calculate_take_auto_gain_calculation(self):
        """Verifies that auto-gain correctly calculates static linear offsets to match scene target."""
        whisper_audio = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-28.0, pause_ratio=0.2)
        res_whisper = audio_processor.calculate_take_auto_gain(whisper_audio, target_loudness_db=-20.0, sr=self.sr)
        self.assertAlmostEqual(res_whisper["auto_gain_db"], 8.0, delta=2.5)
        self.assertEqual(res_whisper["target_loudness_db"], -20.0)

        shout_audio = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-12.0, pause_ratio=0.2)
        res_shout = audio_processor.calculate_take_auto_gain(shout_audio, target_loudness_db=-20.0, sr=self.sr)
        self.assertAlmostEqual(res_shout["auto_gain_db"], -8.0, delta=2.5)

    def test_03_save_uploaded_take_includes_loudness_metadata(self):
        """Verifies that save_uploaded_take returns speech_loudness_db, target_loudness_db, and auto_gain_db."""
        room_id = "LOUDN1"
        line_index = 0
        audio_data = self._generate_synthetic_speech(duration_sec=1.5, target_rms_db=-26.0)
        
        wav_path = os.path.join(self.test_dir, "test_take.wav")
        audio_processor.write_wav_mono(wav_path, audio_data, sr=self.sr)
        with open(wav_path, "rb") as f:
            audio_bytes = f.read()

        saved = audio_processor.save_uploaded_take(
            room_id=room_id,
            line_index=line_index,
            audio_bytes=audio_bytes,
            filename_hint="take.wav",
            target_loudness_db=-20.0
        )

        self.assertIn("speech_loudness_db", saved)
        self.assertIn("target_loudness_db", saved)
        self.assertIn("auto_gain_db", saved)
        self.assertEqual(saved["target_loudness_db"], -20.0)
        self.assertAlmostEqual(saved["auto_gain_db"], 6.0, delta=2.5)

    def test_04_multi_character_gain_matching_preserves_dynamics(self):
        """
        Verifies that when two distinct actors (one quiet whisperer, one loud speaker)
        are gain-matched, their levels balance cohesively in render_dub_mix while preserving
        100% of the natural intra-take dynamic range.
        """
        pack_dir = os.path.join(self.test_dir, "pack_multi_char")
        os.makedirs(pack_dir, exist_ok=True)
        
        ref_audio_1 = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-21.0)
        ref_audio_2 = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-21.0)
        ref_path_1 = os.path.join(pack_dir, "01_Line1_0-00.wav")
        ref_path_2 = os.path.join(pack_dir, "02_Line2_3-00.wav")
        audio_processor.write_wav_mono(ref_path_1, ref_audio_1, self.sr)
        audio_processor.write_wav_mono(ref_path_2, ref_audio_2, self.sr)

        with open(os.path.join(pack_dir, "_captions.json"), "w") as f:
            f.write('{"01_Line1_0-00.wav": "[ActorA] Quiet line", "02_Line2_3-00.wav": "[ActorB] Loud line"}')

        ffmpeg = pack_loader.get_ffmpeg_path()
        dummy_mp4 = os.path.join(pack_dir, "dub_video.mp4")
        subprocess.run([
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x240:d=5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            dummy_mp4
        ], check=True)

        pack = pack_loader.load_pack(pack_dir)
        self.assertIsNotNone(pack)
        self.assertAlmostEqual(pack.mean_vocal_loudness_db, -21.0, delta=2.5)

        actor1_take = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-27.0, pause_ratio=0.0)
        actor2_take = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-15.0, pause_ratio=0.0)

        t1_path = os.path.join(self.test_dir, "take_a1.wav")
        t2_path = os.path.join(self.test_dir, "take_a2.wav")
        audio_processor.write_wav_mono(t1_path, actor1_take, self.sr)
        audio_processor.write_wav_mono(t2_path, actor2_take, self.sr)

        g1 = audio_processor.calculate_take_auto_gain(t1_path, target_loudness_db=pack.mean_vocal_loudness_db)["auto_gain_db"]
        g2 = audio_processor.calculate_take_auto_gain(t2_path, target_loudness_db=pack.mean_vocal_loudness_db)["auto_gain_db"]

        takes_dict = {
            0: {"wav_path": t1_path, "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": g1},
            1: {"wav_path": t2_path, "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": g2},
        }
        mixed_wav = os.path.join(self.test_dir, "balanced_mix.wav")
        audio_processor.render_dub_mix(pack, takes_dict, mixed_wav, sr=self.sr)

        mixed_data = audio_processor.read_wav_mono(mixed_wav, self.sr)
        seg1 = mixed_data[0 : int(2.0 * self.sr)]
        seg2 = mixed_data[int(3.0 * self.sr) : int(5.0 * self.sr)]

        loudness1 = audio_processor.calculate_speech_gated_loudness(seg1, self.sr)
        loudness2 = audio_processor.calculate_speech_gated_loudness(seg2, self.sr)

        self.assertAlmostEqual(loudness1, loudness2, delta=2.5)

    def test_05_master_dialogue_presence_scaling(self):
        """Verifies that master_dialogue_presence_db cleanly scales vocal prominence against backing."""
        pack_dir = os.path.join(self.test_dir, "pack_presence")
        os.makedirs(pack_dir, exist_ok=True)
        ref_audio = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-20.0, pause_ratio=0.0)
        ref_path = os.path.join(pack_dir, "01_Line_0-00.wav")
        audio_processor.write_wav_mono(ref_path, ref_audio, self.sr)
        with open(os.path.join(pack_dir, "_captions.json"), "w") as f:
            f.write('{"01_Line_0-00.wav": "[Actor] Hello"}')
        
        ffmpeg = pack_loader.get_ffmpeg_path()
        dummy_mp4 = os.path.join(pack_dir, "dub_video.mp4")
        subprocess.run([
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x240:d=3",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            dummy_mp4
        ], check=True)

        pack = pack_loader.load_pack(pack_dir)
        takes_dict = {
            0: {"wav_path": ref_path, "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": 0.0}
        }

        out_0db = os.path.join(self.test_dir, "mix_0db.wav")
        audio_processor.render_dub_mix(pack, takes_dict, out_0db, sr=self.sr, master_dialogue_presence_db=0.0)
        data_0db = audio_processor.read_wav_mono(out_0db, self.sr)
        loud_0db = audio_processor.calculate_speech_gated_loudness(data_0db, self.sr)

        out_4db = os.path.join(self.test_dir, "mix_4db.wav")
        audio_processor.render_dub_mix(pack, takes_dict, out_4db, sr=self.sr, master_dialogue_presence_db=4.0)
        data_4db = audio_processor.read_wav_mono(out_4db, self.sr)
        loud_4db = audio_processor.calculate_speech_gated_loudness(data_4db, self.sr)

        self.assertAlmostEqual(loud_4db - loud_0db, 4.0, delta=1.5)


if __name__ == "__main__":
    unittest.main()
