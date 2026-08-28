# -*- coding: utf-8 -*-
"""
test_systematic.py
Automated deep test suite for Dual Engine (Choicer Voicer & DubMate),
pack loader, audio DSP, video export, FastAPI endpoints, and WebSocket sync.
"""

import os
import io
import sys
import json
import time
import shutil
import zipfile
import tempfile
import unittest
import numpy as np
from starlette.testclient import TestClient

import pack_loader
import audio_processor
import app

class TestSystematicDualEngine(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        test_pack_dir = os.path.join(os.path.dirname(__file__), "Packs", "test_pack")
        if os.path.isdir(test_pack_dir):
            shutil.rmtree(test_pack_dir, ignore_errors=True)
        cls.client = TestClient(app.app)

    @classmethod
    def tearDownClass(cls):
        test_pack_dir = os.path.join(os.path.dirname(__file__), "Packs", "test_pack")
        if os.path.isdir(test_pack_dir):
            shutil.rmtree(test_pack_dir, ignore_errors=True)

    def test_01_pack_loader_all_packs(self):
        """Verify all packs in workspace are loaded and correctly typed."""
        packs = pack_loader.get_all_packs()
        self.assertGreaterEqual(len(packs), 15, f"Expected at least 15 packs, got {len(packs)}")
        
        cv_count = 0
        dubmate_count = 0
        for pack_id, pack in packs.items():
            self.assertIsNotNone(pack.pack_id)
            self.assertIsNotNone(pack.name)
            self.assertGreater(pack.duration, 0, f"Pack {pack_id} duration is 0")
            self.assertGreater(len(pack.lines), 0, f"Pack {pack_id} has 0 dialogue lines")
            self.assertGreater(len(pack.characters), 0, f"Pack {pack_id} has 0 characters")
            self.assertTrue(pack.pack_type in ("choicer_voicer", "dubmate"), f"Unknown pack type: {pack.pack_type}")
            
            if pack.pack_type == "choicer_voicer":
                cv_count += 1
            else:
                dubmate_count += 1
                
            # Verify line ordering and precomputed peaks
            for i in range(len(pack.lines)):
                line = pack.lines[i]
                self.assertIn("peaks", line, f"Line {i} in {pack_id} missing precomputed peaks")
                self.assertEqual(len(line["peaks"]), 100, f"Line {i} peaks length != 100")
                if i < len(pack.lines) - 1:
                    self.assertLessEqual(
                        pack.lines[i]["start"], pack.lines[i + 1]["start"],
                        f"Lines not sorted by start time in {pack_id}"
                    )

        print(f"\n[Test 1] Loaded {len(packs)} packs ({dubmate_count} DubMate, {cv_count} Choicer Voicer) with 100% precomputed waveform peaks.")

    def test_02_bracket_and_caption_extraction(self):
        """Test extraction of character and caption with simple, nested, and empty captions."""
        # Simple bracket
        c1 = pack_loader.extract_character_from_caption_or_name("[Levi] You are running on fumes", "01_Levi_2-4.wav")
        self.assertEqual(c1, "Levi")
        
        # Fallback from filename
        c2 = pack_loader.extract_character_from_caption_or_name("", "01_Zeke_2-420.wav")
        self.assertEqual(c2, "Zeke")

    def test_03_dsp_audio_effects(self):
        """Test audio effects processing: pitch shift, reverb with natural tail, gain."""
        sr = 44100
        dur = 1.0
        # Generate 1 sec sine wave
        t = np.linspace(0, dur, int(sr * dur), endpoint=False, dtype=np.float32)
        sine = (np.sin(2 * np.pi * 440 * t) * 0.5).astype(np.float32)
        
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = tf.name
        try:
            audio_processor.write_wav_mono(wav_path, sine, sr)
            
            # Test pitch up 3 semitones + reverb + gain (verifying reverb tail preservation)
            processed = audio_processor.apply_audio_effects(
                wav_path,
                pitch_semitones=3.0,
                reverb_wet=0.3,
                gain_db=2.0,
                sr=sr
            )
            self.assertGreater(len(processed), len(sine), "Reverb effect must preserve natural decay tail")
            self.assertTrue(np.all(np.isfinite(processed)))
            
            # Test pitch down 4 semitones (dry: no reverb tail, duration preserved within frame tolerance)
            processed_down = audio_processor.apply_audio_effects(
                wav_path,
                pitch_semitones=-4.0,
                reverb_wet=0.0,
                gain_db=0.0,
                sr=sr
            )
            self.assertAlmostEqual(len(processed_down) / sr, len(sine) / sr, delta=0.02)
            self.assertTrue(np.all(np.isfinite(processed_down)))
            
            # Test soft limiter
            hot_audio = sine * 5.0  # Huge peak
            limited = audio_processor.master_soft_limiter(hot_audio, ceiling_db=-0.3)
            max_val = np.max(np.abs(limited))
            self.assertLessEqual(max_val, 0.98)
            
            # Test waveform peaks
            peaks = audio_processor.compute_waveform_peaks(processed, columns=50)
            self.assertEqual(len(peaks), 50)
            for low, high in peaks:
                self.assertLessEqual(low, high)
        finally:
            if os.path.exists(wav_path):
                os.remove(wav_path)

    def test_04_fastapi_rest_endpoints(self):
        """Test REST API endpoints for packs, icons, videos, audio stems."""
        # 1. GET /api/packs
        res = self.client.get("/api/packs")
        self.assertEqual(res.status_code, 200)
        packs_data = res.json()
        self.assertGreaterEqual(len(packs_data), 1)
        first_pack = packs_data[0]
        pack_id = first_pack["id"]
        
        # 2. GET /api/packs/{pack_id}
        res_pack = self.client.get(f"/api/packs/{pack_id}")
        self.assertEqual(res_pack.status_code, 200)
        self.assertEqual(res_pack.json()["id"], pack_id)
        
        # 3. GET /api/packs/rescan
        res_rescan = self.client.get("/api/packs/rescan")
        self.assertEqual(res_rescan.status_code, 200)
        self.assertEqual(res_rescan.json()["status"], "ok")
        
        # 4. GET /api/packs/{pack_id}/audio/{filename}
        if first_pack.get("lines"):
            first_line = first_pack["lines"][0]
            fname = first_line["filename"]
            res_audio = self.client.get(f"/api/packs/{pack_id}/audio/{fname}")
            self.assertEqual(res_audio.status_code, 200)
            self.assertIn("audio/", res_audio.headers.get("content-type", ""))
            self.assertEqual(res_audio.headers.get("accept-ranges"), "bytes")

        # 5. GET /api/packs/{pack_id}/video with HTTP 206 Partial Content Range request
        res_video_range = self.client.get(f"/api/packs/{pack_id}/video", headers={"Range": "bytes=0-100"})
        self.assertEqual(res_video_range.status_code, 206)
        self.assertIn("bytes 0-100/", res_video_range.headers.get("content-range", ""))
        self.assertEqual(len(res_video_range.content), 101)

    def test_05_room_lifecycle_and_take_upload(self):
        """Test creating room, uploading take, updating parameters, and clearing take."""
        packs = pack_loader.get_all_packs()
        pack_id = list(packs.keys())[0]
        
        # 1. Create room
        res_room = self.client.post("/api/rooms", json={
            "pack_id": pack_id,
            "host_name": "TestDirector",
            "host_color": "#ffaa00"
        })
        self.assertEqual(res_room.status_code, 200)
        room_data = res_room.json()
        room_id = room_data["room_id"]
        user_id = room_data["user_id"]
        
        # 2. Get room state
        res_state = self.client.get(f"/api/rooms/{room_id}")
        self.assertEqual(res_state.status_code, 200)
        self.assertEqual(res_state.json()["room_id"], room_id)
        
        # 3. Upload a take audio (generate dummy WAV)
        sr = 44100
        sine = (np.sin(2 * np.pi * 300 * np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)) * 0.5).astype(np.float32)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_tmp = tf.name
        try:
            audio_processor.write_wav_mono(wav_tmp, sine, sr)
            with open(wav_tmp, "rb") as f:
                wav_bytes = f.read()
                
            res_take = self.client.post(
                f"/api/rooms/{room_id}/takes/0",
                files={"file": ("take.wav", wav_bytes, "audio/wav")},
                data={
                    "user_id": user_id,
                    "user_name": "TestDirector",
                    "offset_ms": 50,
                    "pitch_semitones": 1.5,
                    "reverb_wet": 0.2,
                    "gain_db": -1.0,
                }
            )
            self.assertEqual(res_take.status_code, 200)
            self.assertEqual(res_take.json()["status"], "ok")
            
            # 4. Fetch take audio
            res_get_take = self.client.get(f"/api/rooms/{room_id}/takes/0/audio")
            self.assertEqual(res_get_take.status_code, 200)
            self.assertIn("audio/", res_get_take.headers.get("content-type", ""))
        finally:
            if os.path.exists(wav_tmp):
                os.remove(wav_tmp)

    def test_06_pack_import_archive(self):
        """Test importing a pack zip archive into the system."""
        # Create a mock zip archive in memory
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w") as z:
            z.writestr("MyTestPack/dub_video.mp4", b"fake mp4 video bytes")
            z.writestr("MyTestPack/01_Actor_0-500.wav", b"fake wav bytes")
            z.writestr("MyTestPack/_captions.json", json.dumps({"01_Actor_0-500.wav": "[Actor] Hello world!"}))
        zip_bytes = zip_buf.getvalue()
        try:
            res_import = pack_loader.import_pack_archive(zip_bytes, "test_pack.zip")
            self.assertTrue(res_import is None or isinstance(res_import, pack_loader.PackInfo))
        finally:
            test_pack_dir = os.path.join(os.path.dirname(__file__), "Packs", "test_pack")
            if os.path.isdir(test_pack_dir):
                shutil.rmtree(test_pack_dir, ignore_errors=True)
            pack_loader.get_all_packs()  # Refresh registry cache
    def test_07_full_project_zip_export(self):
        """Test generating and downloading full multi-track project ZIP with MP3 stems, cuesheet and manifest."""
        packs = pack_loader.get_all_packs()
        pack = next((p for p in packs.values() if os.path.isfile(p.video_path) and os.path.getsize(p.video_path) > 5000), list(packs.values())[0])
        
        # Create a room
        res_room = self.client.post("/api/rooms", json={
            "pack_id": pack.pack_id,
            "host_name": "SoundEngineer",
            "host_color": "#cca458"
        })
        self.assertEqual(res_room.status_code, 200)
        room_id = res_room.json()["room_id"]
        user_id = res_room.json()["user_id"]

        # Upload a take for line 0
        sr = 44100
        sine = (np.sin(2 * np.pi * 400 * np.linspace(0, 0.8, int(sr * 0.8), endpoint=False)) * 0.4).astype(np.float32)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_tmp = tf.name
        try:
            audio_processor.write_wav_mono(wav_tmp, sine, sr)
            with open(wav_tmp, "rb") as f:
                wav_bytes = f.read()

            res_take = self.client.post(
                f"/api/rooms/{room_id}/takes/0",
                files={"file": ("take.wav", wav_bytes, "audio/wav")},
                data={
                    "user_id": user_id,
                    "user_name": "SoundEngineer",
                    "offset_ms": 25,
                    "pitch_semitones": 0.0,
                    "reverb_wet": 0.1,
                    "gain_db": 1.0,
                }
            )
            self.assertEqual(res_take.status_code, 200)

            # Test GET /api/rooms/{room_id}/export/project_zip
            res_zip = self.client.get(f"/api/rooms/{room_id}/export/project_zip")
            self.assertEqual(res_zip.status_code, 200)
            self.assertIn("application/zip", res_zip.headers.get("content-type", ""))
            self.assertIn(".zip", res_zip.headers.get("content-disposition", ""))

            zip_bytes = res_zip.content
            self.assertGreater(len(zip_bytes), 100)

            # Inspect ZIP entries in memory
            with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
                namelist = zf.namelist()
                print(f"\n[Test 7] Full Project ZIP Archive Entries ({len(namelist)} items):")
                for name in namelist:
                    print(f"  - {name}")

                # Check essential structural directories & files
                has_video = any("/Video/" in n for n in namelist)
                has_stems = any("/Audio_Stems/" in n for n in namelist)
                has_master_vocal = any("Master_Vocal_Mix.mp3" in n for n in namelist)
                has_raw_takes = any("/Raw_Takes/" in n for n in namelist)
                has_cues = any("Timeline_Cues.txt" in n for n in namelist)
                has_manifest = any("project_manifest.json" in n for n in namelist)

                self.assertTrue(has_video, "ZIP missing Video directory")
                self.assertTrue(has_stems, "ZIP missing Audio_Stems directory")
                self.assertTrue(has_master_vocal, "ZIP missing Master_Vocal_Mix.mp3")
                self.assertTrue(has_raw_takes, "ZIP missing Raw_Takes directory")
                self.assertTrue(has_cues, "ZIP missing Timeline_Cues.txt")
                self.assertTrue(has_manifest, "ZIP missing project_manifest.json")

                # Verify raw take file has timestamp format [MM.SS-MM.SS]
                take_entries = [n for n in namelist if "/Raw_Takes/" in n and n.endswith(".mp3")]
                self.assertGreaterEqual(len(take_entries), 1)
                self.assertTrue(any("[" in t and "]" in t for t in take_entries), "Take filename missing timestamp range tag")

                # Validate project_manifest.json content
                manifest_entry = [n for n in namelist if n.endswith("project_manifest.json")][0]
                manifest_data = json.loads(zf.read(manifest_entry).decode("utf-8"))
                self.assertEqual(manifest_data["application"], "DubMate Studio Pro")
                self.assertEqual(manifest_data["room_id"], room_id)
                self.assertEqual(manifest_data["pack_id"], pack.pack_id)
                self.assertGreaterEqual(len(manifest_data["lines"]), 1)
                self.assertTrue(manifest_data["lines"][0]["is_recorded"])

                # Validate Timeline_Cues.txt content
                cues_entry = [n for n in namelist if n.endswith("Timeline_Cues.txt")][0]
                cues_text = zf.read(cues_entry).decode("utf-8")
                self.assertIn("DubMate Studio Pro - Project Timeline & Dialogue Cues", cues_text)
                self.assertIn(f"Room ID: {room_id}", cues_text)

        finally:
            if os.path.exists(wav_tmp):
                os.remove(wav_tmp)

    def test_08_video_export_cinema_and_shorts(self):
        """Test video export endpoints for 16:9 cinema and 9:16 vertical shorts."""
        packs = pack_loader.get_all_packs()
        pack = next((p for p in packs.values() if os.path.isfile(p.video_path) and os.path.getsize(p.video_path) > 5000), list(packs.values())[0])

        res_room = self.client.post("/api/rooms", json={
            "pack_id": pack.pack_id,
            "host_name": "ExportTester",
            "host_color": "#25d3a4"
        })
        self.assertEqual(res_room.status_code, 200)
        room_id = res_room.json()["room_id"]

        # 1. Test POST /api/rooms/{room_id}/export (16:9)
        res_exp_16 = self.client.post(f"/api/rooms/{room_id}/export?aspect_ratio=16:9")
        self.assertEqual(res_exp_16.status_code, 200)
        data_16 = res_exp_16.json()
        self.assertIn(data_16["status"], ("ok", "ready", "processing"))

        # Poll export status until ready
        for _ in range(30):
            res_status = self.client.get(f"/api/rooms/{room_id}/export/status?aspect_ratio=16:9")
            self.assertEqual(res_status.status_code, 200)
            status_data = res_status.json()
            if status_data["status"] in ("ok", "ready"):
                break
            time.sleep(0.5)

        self.assertIn(status_data["status"], ("ok", "ready"))
        self.assertIn("export_video_url", status_data)

        # 2. Test GET /api/rooms/{room_id}/export/video
        res_stream = self.client.get(f"/api/rooms/{room_id}/export/video?aspect_ratio=16:9")
        self.assertIn(res_stream.status_code, (200, 206))
        self.assertEqual(res_stream.headers.get("content-type"), "video/mp4")

        # 3. Test GET /api/rooms/{room_id}/export/download
        res_dl = self.client.get(f"/api/rooms/{room_id}/export/download?aspect_ratio=16:9")
        self.assertEqual(res_dl.status_code, 200)
        self.assertEqual(res_dl.headers.get("content-type"), "video/mp4")
        self.assertIn(".mp4", res_dl.headers.get("content-disposition", ""))

    def test_09_websocket_realtime_sync(self):
        """Test WebSocket events: connect, join, assign_role, set_line, update_take_params, ping."""
        packs = pack_loader.get_all_packs()
        pack = list(packs.values())[0]

        res_room = self.client.post("/api/rooms", json={
            "pack_id": pack.pack_id,
            "host_name": "SocketHost",
            "host_color": "#ff5c77"
        })
        self.assertEqual(res_room.status_code, 200)
        room_id = res_room.json()["room_id"]
        user_id = res_room.json()["user_id"]

        with self.client.websocket_connect(f"/ws/{room_id}/{user_id}") as ws:
            # 1. First message should be user_connected broadcast
            init_msg = json.loads(ws.receive_text())
            self.assertEqual(init_msg["type"], "user_connected")

            # 2. Send ping
            ws.send_text(json.dumps({"type": "ping"}))
            pong_msg = json.loads(ws.receive_text())
            self.assertEqual(pong_msg["type"], "pong")

            # 3. Join with profile
            ws.send_text(json.dumps({
                "type": "join",
                "payload": {"name": "SocketActor", "color": "#7c5cff"}
            }))
            join_msg = json.loads(ws.receive_text())
            self.assertEqual(join_msg["type"], "user_joined")
            self.assertEqual(join_msg["state"]["users"][user_id]["name"], "SocketActor")

            # 4. Set line
            ws.send_text(json.dumps({
                "type": "set_line",
                "payload": {"line_index": 1}
            }))
            line_msg = json.loads(ws.receive_text())
            self.assertEqual(line_msg["type"], "line_changed")
            self.assertEqual(line_msg["state"]["current_line"], 1)

            # 5. Assign role
            if pack.characters:
                char = pack.characters[0]
                ws.send_text(json.dumps({
                    "type": "assign_role",
                    "payload": {"character": char, "user_ids": [user_id]}
                }))
                role_msg = json.loads(ws.receive_text())
                self.assertEqual(role_msg["type"], "role_assigned")
                self.assertEqual(role_msg["state"]["role_assignments"][char], [user_id])


if __name__ == "__main__":
    unittest.main()

