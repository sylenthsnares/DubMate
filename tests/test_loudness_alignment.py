import os
import shutil
import tempfile
import unittest
import json
import subprocess
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


class TestDialogueLoudnessAlignment(unittest.TestCase):
    """
    Comprehensive test suite for BS.1770 Dialogue Loudness Alignment,
    Static Gain-Matching, Dynamics Preservation, and Master Dialogue Prominence.
    """

    @classmethod
    def setUpClass(cls):
        cls.test_dir = tempfile.mkdtemp(prefix="dubmate_loudness_test_")
        cls.render_dir = os.path.join(cls.test_dir, "renders")
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

    def test_01_integrated_lufs_ignores_silence(self):
        """Verifies that gated integrated loudness measures active speech and ignores pauses."""
        speech = self._generate_synthetic_speech(duration_sec=3.0, target_rms_db=-18.0, pause_ratio=0.5)
        measured_db = audio_processor.integrated_lufs(speech, sr=self.sr)
        self.assertAlmostEqual(measured_db, -18.0, delta=2.5)

    def test_02_calculate_take_auto_gain_calculation(self):
        """Verifies that auto-gain correctly calculates static linear offsets to match scene target."""
        whisper_audio = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-28.0, pause_ratio=0.2)
        res_whisper = audio_processor.calculate_take_auto_gain(whisper_audio, target_lufs=-20.0, sr=self.sr)
        self.assertAlmostEqual(res_whisper["auto_gain_db"], 8.0, delta=2.5)
        self.assertEqual(res_whisper["target_lufs"], -20.0)

        shout_audio = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-12.0, pause_ratio=0.2)
        res_shout = audio_processor.calculate_take_auto_gain(shout_audio, target_lufs=-20.0, sr=self.sr)
        self.assertAlmostEqual(res_shout["auto_gain_db"], -8.0, delta=2.5)

    def test_03_save_uploaded_take_includes_loudness_metadata(self):
        """Verifies that save_uploaded_take returns loudness_lufs, target_lufs, and auto_gain_db."""
        room_id = "LOUDN1"
        line_index = 0
        audio_data = self._generate_synthetic_speech(duration_sec=1.5, target_rms_db=-26.0)
        
        wav_path = os.path.join(self.test_dir, "test_take.wav")
        audio_processor.write_wav_mono(wav_path, audio_data, sr=self.sr)
        with open(wav_path, "rb") as f:
            audio_bytes = f.read()

        saved = audio_processor.save_uploaded_take(
            room_id=room_id,
            take_dir=audio_processor.get_room_cache_dir(room_id),
            stem=f"take_line_{line_index}",
            audio_bytes=audio_bytes,
            filename_hint="take.wav",
            target_lufs=-20.0
        )

        self.assertIn("loudness_lufs", saved)
        self.assertIn("target_lufs", saved)
        self.assertIn("auto_gain_db", saved)
        self.assertNotIn("speech_loudness_db", saved)
        self.assertEqual(saved["target_lufs"], -20.0)
        # BS.1770 blocks that straddle the pause count too, so this short take reads a
        # little under its -26 dB active level.
        expected_lufs = audio_processor.integrated_lufs(audio_processor.read_wav_mono(wav_path), self.sr)
        self.assertAlmostEqual(saved["loudness_lufs"], expected_lufs, delta=0.1)
        self.assertAlmostEqual(saved["auto_gain_db"], -20.0 - expected_lufs, delta=0.15)
        self.assertAlmostEqual(saved["auto_gain_db"], 6.0, delta=3.0)

    def test_04_multi_character_gain_matching_preserves_dynamics(self):
        """
        Verifies that when two distinct actors (one quiet whisperer, one loud speaker)
        are gain-matched, their levels balance cohesively in render_dub_mix while preserving
        100% of the natural intra-take dynamic range. The master stage moves the whole mix
        to -16 LUFS, so the lines keep their balance, not their absolute level.
        """
        pack_dir = os.path.join(self.test_dir, "pack_multi_char")
        os.makedirs(pack_dir, exist_ok=True)
        
        ref_audio_1 = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-24.0)
        ref_audio_2 = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-18.0)
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
        # Each take is matched to its own original line, not to a pack-wide constant.
        ref1 = pack_loader.measure_line_loudness(ref_path_1)
        ref2 = pack_loader.measure_line_loudness(ref_path_2)
        self.assertAlmostEqual(ref1, -24.0, delta=2.5)
        self.assertAlmostEqual(ref2, -18.0, delta=2.5)

        actor1_take = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-27.0, pause_ratio=0.0)
        actor2_take = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-15.0, pause_ratio=0.0)

        t1_path = os.path.join(self.test_dir, "take_a1.wav")
        t2_path = os.path.join(self.test_dir, "take_a2.wav")
        audio_processor.write_wav_mono(t1_path, actor1_take, self.sr)
        audio_processor.write_wav_mono(t2_path, actor2_take, self.sr)

        g1 = audio_processor.calculate_take_auto_gain(t1_path, target_lufs=ref1)["auto_gain_db"]
        g2 = audio_processor.calculate_take_auto_gain(t2_path, target_lufs=ref2)["auto_gain_db"]

        takes_dict = {
            0: {"wav_path": t1_path, "render_dir": self.render_dir, "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": g1},
            1: {"wav_path": t2_path, "render_dir": self.render_dir, "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": g2},
        }
        mixed_wav = os.path.join(self.test_dir, "balanced_mix.wav")
        audio_processor.render_dub_mix(pack, takes_dict, mixed_wav, sr=self.sr)

        mixed_data = audio_processor.read_wav_mono(mixed_wav, self.sr)
        seg1 = mixed_data[0 : int(2.0 * self.sr)]
        seg2 = mixed_data[int(3.0 * self.sr) : int(5.0 * self.sr)]

        loudness1 = audio_processor.integrated_lufs(seg1, self.sr)
        loudness2 = audio_processor.integrated_lufs(seg2, self.sr)

        self.assertAlmostEqual(loudness2 - loudness1, ref2 - ref1, delta=1.0)
        self.assertAlmostEqual(audio_processor.integrated_lufs(mixed_data, self.sr), audio_processor.MASTER_TARGET_LUFS, delta=0.3)

        # Before the master stage each line sits at its original line's level.
        scene = audio_processor._mix_scene(pack, takes_dict, self.sr)
        self.assertAlmostEqual(audio_processor.integrated_lufs(scene[0 : int(2.0 * self.sr)], self.sr), ref1, delta=2.0)
        self.assertAlmostEqual(audio_processor.integrated_lufs(scene[int(3.0 * self.sr) : int(5.0 * self.sr)], self.sr), ref2, delta=2.0)

    def test_05_master_dialogue_presence_scaling(self):
        """Verifies that dialogue presence cleanly scales vocal prominence in the scene mix (before the master stage)."""
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
            0: {"wav_path": ref_path, "render_dir": self.render_dir, "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": 0.0}
        }

        loud_0db = audio_processor.integrated_lufs(audio_processor._mix_scene(pack, takes_dict, self.sr, presence_db=0.0), self.sr)
        loud_4db = audio_processor.integrated_lufs(audio_processor._mix_scene(pack, takes_dict, self.sr, presence_db=4.0), self.sr)

        self.assertAlmostEqual(loud_4db - loud_0db, 4.0, delta=1.5)

    # --- B3: auto gain-match must target the measured original line ---

    def _make_pack(self, name, line_levels_db):
        """Synthetic pack whose lines really sit at the given speech levels (active RMS, about the LUFS)."""
        pack_dir = os.path.join(self.test_dir, name)
        os.makedirs(pack_dir, exist_ok=True)
        captions = {}
        for i, level in enumerate(line_levels_db):
            fname = f"{i + 1:02d}_Line{i}_{i * 3}-00.wav"
            audio_processor.write_wav_mono(
                os.path.join(pack_dir, fname),
                self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=level, pause_ratio=0.0),
                self.sr,
            )
            captions[fname] = f"[Actor{i}] Line {i}"
        with open(os.path.join(pack_dir, "_captions.json"), "w") as f:
            json.dump(captions, f)
        subprocess.run([
            pack_loader.get_ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=black:s=320x240:d={3 * len(line_levels_db)}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            os.path.join(pack_dir, "dub_video.mp4"),
        ], check=True)
        pack = pack_loader.load_pack(pack_dir)
        self.assertIsNotNone(pack)
        return pack

    def _make_room(self, room_id, pack):
        room = rooms.Room(room_id, pack, "hostb3", "Host", "#7c5cff")
        rooms.ROOMS[room_id] = room
        self.addCleanup(rooms.ROOMS.pop, room_id, None)
        return room

    def _wav_bytes(self, level_db, duration_sec=2.0):
        path = os.path.join(self.test_dir, f"upload_{level_db}.wav")
        audio_processor.write_wav_mono(
            path,
            self._generate_synthetic_speech(duration_sec=duration_sec, target_rms_db=level_db, pause_ratio=0.0),
            self.sr,
        )
        with open(path, "rb") as f:
            return f.read()

    def _upload(self, room_id, line_index, level_db, **form):
        data = {"user_id": "hostb3", "user_name": "Host", "gain_db": "0.0", "noise_reduction": "false"}
        data.update(form)
        line_id = rooms.ROOMS[room_id].pack.lines[line_index]["line_id"]
        res = self.client.post(
            f"/api/rooms/{room_id}/lines/{line_id}/takes",
            files={"file": ("take.wav", self._wav_bytes(level_db), "audio/wav")},
            data=data,
        )
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["take"]

    def test_06_upload_targets_measured_line_loudness(self):
        """The same -21 dB take is matched to a quiet line and a loud line differently."""
        pack = self._make_pack("pack_b3_levels", [-32.0, -12.0])
        self._make_room("LOUDB3", pack)

        quiet = self._upload("LOUDB3", 0, -21.0)
        loud = self._upload("LOUDB3", 1, -21.0)
        self.assertAlmostEqual(quiet["target_lufs"], -32.0, delta=2.0)
        self.assertAlmostEqual(loud["target_lufs"], -12.0, delta=2.0)
        self.assertIn("loudness_lufs", quiet)
        self.assertNotIn("speech_loudness_db", quiet)
        self.assertAlmostEqual(quiet["auto_gain_db"], -11.0, delta=2.5)
        self.assertAlmostEqual(loud["auto_gain_db"], 9.0, delta=2.5)

    def test_07_upload_auto_gain_flag_applied_server_side(self):
        """auto_gain=true stores the matched gain before the broadcast; otherwise the slider value wins."""
        pack = self._make_pack("pack_b3_flag", [-18.0])
        room = self._make_room("LOUDB4", pack)

        take = self._upload("LOUDB4", 0, -26.0, auto_gain="true", gain_db="6.0")
        self.assertNotEqual(take["auto_gain_db"], 0.0)
        self.assertEqual(take["gain_db"], take["auto_gain_db"])
        line_id = pack.lines[0]["line_id"]
        self.assertEqual(room.picked_take(line_id)["gain_db"], take["auto_gain_db"])

        manual = self._upload("LOUDB4", 0, -26.0, auto_gain="false", gain_db="3.0")
        self.assertEqual(manual["gain_db"], 3.0)

    def test_08_auto_gain_boost_respects_peak_headroom(self):
        """A quiet take with a hot transient is not boosted past the peak ceiling."""
        take = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-33.0, pause_ratio=0.0)
        spike_level = 10.0 ** (-6.0 / 20.0)
        take[1000:1010] = spike_level
        res = audio_processor.calculate_take_auto_gain(take, target_lufs=-21.0, sr=self.sr)
        peak_db = 20.0 * np.log10(spike_level)
        self.assertGreater(res["auto_gain_db"], 0.0)
        self.assertLessEqual(res["auto_gain_db"], audio_processor.AUTO_GAIN_PEAK_CEILING_DB - peak_db)
        boosted_peak = np.max(np.abs(take)) * 10.0 ** (res["auto_gain_db"] / 20.0)
        self.assertLessEqual(boosted_peak, 10.0 ** (audio_processor.AUTO_GAIN_PEAK_CEILING_DB / 20.0) + 1e-6)

        # Cuts are never limited by the cap.
        hot = self._generate_synthetic_speech(duration_sec=2.0, target_rms_db=-9.0, pause_ratio=0.0)
        hot_gain = audio_processor.calculate_take_auto_gain(hot, target_lufs=-21.0, sr=self.sr)["auto_gain_db"]
        self.assertAlmostEqual(hot_gain, -12.0, delta=1.0)

    def test_09_noise_reduction_toggle_rematches_gain(self):
        """Swapping to quieter denoised audio re-measures the take and moves a matched gain with it."""
        pack = self._make_pack("pack_b3_nr", [-20.0])
        self._make_room("LOUDB5", pack)
        # -24, not -26: the take is measured through its low cut, and at -26 the halved
        # take's auto gain would sit on the +12 dB clamp.
        take = self._upload("LOUDB5", 0, -24.0, auto_gain="true")
        before = take["auto_gain_db"]

        def half_level(input_wav, output_wav, *args, **kwargs):
            audio_processor.write_wav_mono(output_wav, audio_processor.read_wav_mono(input_wav) * 0.5)
            return output_wav

        with mock.patch.object(audio_processor, "apply_noise_reduction", side_effect=half_level):
            res = self.client.post(take["url"].split("/audio")[0] + "/noise_reduction", json={"noise_reduction": True})
        self.assertEqual(res.status_code, 200, res.text)
        after = res.json()["take"]
        self.assertAlmostEqual(after["auto_gain_db"] - before, 6.0, delta=0.6)
        self.assertEqual(after["gain_db"], after["auto_gain_db"])

    def test_10_line_loudness_remeasured_when_file_changes(self):
        """The reference cache is keyed on the file, so an edited line is measured again."""
        path = os.path.join(self.test_dir, "edited_line.wav")
        audio_processor.write_wav_mono(path, self._generate_synthetic_speech(target_rms_db=-30.0, pause_ratio=0.0), self.sr)
        first = pack_loader.measure_line_loudness(path)
        audio_processor.write_wav_mono(path, self._generate_synthetic_speech(target_rms_db=-15.0, pause_ratio=0.0), self.sr)
        st = os.stat(path)
        os.utime(path, (st.st_atime, st.st_mtime + 5))
        second = pack_loader.measure_line_loudness(path)
        self.assertAlmostEqual(first, -30.0, delta=2.0)
        self.assertAlmostEqual(second, -15.0, delta=2.0)


if __name__ == "__main__":
    unittest.main()
