# -*- coding: utf-8 -*-
"""
test_pack_builder.py
Automated unit and integration test suite for DubMate Pack Builder:
- Subtitle parsers (SRT, WebVTT)
- Speaker turn heuristics
- Audio line slicing & filename timestamp encoding
- Pack assembly & compliance with DubMate/DubStage loaders
- REST API endpoints for upload, progress, segments CRUD, and compilation
"""

import os
import io
import json
import shutil
import tempfile
import unittest
import wave
import struct

from starlette.testclient import TestClient

import pack_loader
import pack_builder
from app import app, BUILDER_SESSIONS


def create_dummy_wav(path: str, duration_sec: float = 3.0, sample_rate: int = 44100):
    """Generates a valid mono 16-bit PCM WAV file for testing."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    num_samples = int(duration_sec * sample_rate)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        raw_data = bytearray()
        for i in range(num_samples):
            val = int(3000 * ((i % 100) / 100.0 - 0.5))
            raw_data.extend(struct.pack("<h", val))
        wf.writeframes(raw_data)


def create_dummy_mp4(path: str, duration_sec: float = 3.0):
    """Generates a small valid MP4 video using FFmpeg testsrc."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ffmpeg = pack_loader.get_ffmpeg_path()
    import subprocess
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=duration={duration_sec}:size=320x240:rate=30",
        "-f", "lavfi", "-i", f"sine=frequency=1000:duration={duration_sec}",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+faststart",
        path
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    except Exception:
        with open(path, "wb") as f:
            f.write(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 4000)


class TestPackBuilder(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="dubmate_test_builder_")
        self.client = TestClient(app)

    def tearDown(self):
        if os.path.exists(self.tmp_dir):
            shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_01_parse_srt_subtitles(self):
        """Tests parsing of standard SRT subtitles with character brackets and tags."""
        srt_content = """1
00:00:02,169 --> 00:00:04,500
[Levi] <i>What are you doing here?</i>

2
00:00:05,200 --> 00:00:08,100
Kenny: I'm just looking for some fun!

3
00:00:09,000 --> 00:00:11,500
Don't move!
"""
        segments = pack_builder.parse_srt(srt_content)
        self.assertEqual(len(segments), 3)

        # Segment 1
        self.assertAlmostEqual(segments[0]["start"], 2.169, places=3)
        self.assertAlmostEqual(segments[0]["end"], 4.500, places=3)
        self.assertEqual(segments[0]["character"], "Levi")
        self.assertEqual(segments[0]["text"], "What are you doing here?")

        # Segment 2
        self.assertAlmostEqual(segments[1]["start"], 5.200, places=3)
        self.assertEqual(segments[1]["character"], "Kenny")
        self.assertEqual(segments[1]["text"], "I'm just looking for some fun!")

        # Segment 3
        self.assertAlmostEqual(segments[2]["start"], 9.000, places=3)
        self.assertEqual(segments[2]["character"], "Actor")
        self.assertEqual(segments[2]["text"], "Don't move!")

    def test_02_parse_vtt_subtitles(self):
        """Tests parsing of WebVTT format subtitles."""
        vtt_content = """WEBVTT
NOTE This is a test subtitle file

1
00:01.500 --> 00:03.200
[Eren] I will destroy them all!

2
00:04.000 --> 00:06.000
[Mikasa] Eren, please calm down.
"""
        segments = pack_builder.parse_vtt(vtt_content)
        self.assertEqual(len(segments), 2)
        self.assertAlmostEqual(segments[0]["start"], 1.500, places=3)
        self.assertEqual(segments[0]["character"], "Eren")
        self.assertEqual(segments[1]["character"], "Mikasa")

    def test_03_speaker_turn_heuristics(self):
        """Tests turn-taking heuristic assignment when no character names are present."""
        raw_segments = [
            {"start": 1.0, "end": 2.0, "text": "Line 1", "character": "Actor"},
            {"start": 2.2, "end": 3.0, "text": "Line 2 (rapid response)", "character": "Actor"},
            {"start": 5.5, "end": 6.5, "text": "Line 3 (after gap)", "character": "Actor"},
        ]
        assigned = pack_builder.assign_speakers_to_segments(raw_segments)
        self.assertEqual(assigned[0]["character"], "Speaker 1")
        self.assertEqual(assigned[1]["character"], "Speaker 1")
        # Line 3 has > 1.5s gap, switches speaker
        self.assertEqual(assigned[2]["character"], "Speaker 2")

    def test_04_audio_line_slicing_and_naming(self):
        """Tests audio slicing with exact DubMate/DubStage filename timestamp encoding."""
        src_wav = os.path.join(self.tmp_dir, "test_vocals.wav")
        create_dummy_wav(src_wav, duration_sec=6.0)

        segments = [
            {"start": 1.250, "end": 2.500, "text": "First line", "character": "Levi"},
            {"start": 3.169, "end": 4.800, "text": "Second line", "character": "Kenny"},
        ]
        slices_dir = os.path.join(self.tmp_dir, "slices")
        sliced = pack_builder.slice_audio_lines(src_wav, segments, slices_dir, "Test Pack")

        self.assertEqual(len(sliced), 2)
        
        # Verify file 1
        fn1 = sliced[0]["filename"]
        self.assertEqual(fn1, "01_Levi_1-250.wav")
        self.assertTrue(os.path.isfile(os.path.join(slices_dir, fn1)))
        
        # Verify pack_loader timestamp parser understands generated name
        ts1 = pack_loader.timestamp_from_filename(fn1)
        self.assertIsNotNone(ts1)
        self.assertAlmostEqual(ts1, 1.250, places=2)

        # Verify file 2
        fn2 = sliced[1]["filename"]
        self.assertEqual(fn2, "02_Kenny_3-169.wav")
        ts2 = pack_loader.timestamp_from_filename(fn2)
        self.assertIsNotNone(ts2)
        self.assertAlmostEqual(ts2, 3.169, places=2)

    def test_05_pack_assembly_and_loader_interoperability(self):
        """Tests full pack assembly and verifies that pack_loader.load_pack can load it."""
        src_wav = os.path.join(self.tmp_dir, "source_audio.wav")
        create_dummy_wav(src_wav, duration_sec=5.0)

        # Create valid dummy MP4 video container
        video_dummy = os.path.join(self.tmp_dir, "dummy_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=4.0)

        slices_dir = os.path.join(self.tmp_dir, "slices")
        segments = [
            {"start": 0.500, "end": 1.800, "text": "Line Alpha", "character": "Hero"},
            {"start": 2.200, "end": 3.500, "text": "Line Beta", "character": "Villain"},
        ]
        line_slices = pack_builder.slice_audio_lines(src_wav, segments, slices_dir, "Assembly_Test_Pack")

        pack_folder = pack_builder.assemble_pack(
            pack_name="Assembly_Test_Pack",
            video_source_path=video_dummy,
            backing_source_path=src_wav,
            line_slices=line_slices,
            authors=["DubMate Tester"],
            subtitle="Unit test generated scene pack"
        )

        try:
            self.assertTrue(os.path.isdir(pack_folder))
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "_captions.json")))
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "_TIMESTAMPS.txt")))
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "pack.json")))
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "dub_subs.txt")))
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "_backing_track.wav")))

            # Load with pack_loader
            loaded = pack_loader.load_pack(pack_folder)
            self.assertIsNotNone(loaded)
            self.assertEqual(len(loaded.lines), 2)
            self.assertIn("Hero", loaded.characters)
            self.assertIn("Villain", loaded.characters)
            self.assertEqual(loaded.lines[0]["character"], "Hero")
            self.assertEqual(loaded.lines[1]["character"], "Villain")
        finally:
            # Clean up assembled test pack from Packs/
            if os.path.isdir(pack_folder):
                shutil.rmtree(pack_folder, ignore_errors=True)

    def test_06_builder_api_endpoints(self):
        """Tests the REST API endpoints: upload, status, segments CRUD, and compile."""
        # 1. Upload
        video_dummy = os.path.join(self.tmp_dir, "api_test_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=4.0)

        with open(video_dummy, "rb") as fh:
            res = self.client.post("/api/builder/upload", files={"file": ("api_test_video.mp4", fh, "video/mp4")})

        self.assertEqual(res.status_code, 200)
        data = res.json()
        session_id = data["session_id"]
        self.assertIn("session_id", data)

        # 2. Check initial status
        res_status = self.client.get(f"/api/builder/{session_id}/status")
        self.assertEqual(res_status.status_code, 200)
        status_data = res_status.json()
        self.assertEqual(status_data["status"], "idle")

        # 3. Add and Update Segments CRUD
        add_res = self.client.post(f"/api/builder/{session_id}/segments", json={
            "start": 1.0,
            "end": 2.5,
            "text": "Hello world from API",
            "character": "Goku"
        })
        self.assertEqual(add_res.status_code, 200)
        self.assertEqual(len(add_res.json()["segments"]), 1)

        # Bulk update
        put_res = self.client.put(f"/api/builder/{session_id}/segments", json={
            "segments": [
                {"start": 0.8, "end": 2.0, "text": "First Line", "character": "Goku"},
                {"start": 2.5, "end": 4.0, "text": "Second Line", "character": "Vegeta"},
            ]
        })
        self.assertEqual(put_res.status_code, 200)
        self.assertEqual(put_res.json()["count"], 2)

        # Get segments
        get_res = self.client.get(f"/api/builder/{session_id}/segments")
        self.assertEqual(get_res.status_code, 200)
        self.assertEqual(len(get_res.json()["segments"]), 2)

        # Delete segment
        del_res = self.client.delete(f"/api/builder/{session_id}/segments/0")
        self.assertEqual(del_res.status_code, 200)
        self.assertEqual(len(del_res.json()["segments"]), 1)

        # 4. Import Subtitles via API
        srt_dummy = "1\n00:00:01,000 --> 00:00:03,000\n[Naruto] Believe it!\n"
        sub_res = self.client.post(
            f"/api/builder/{session_id}/import_subtitles",
            files={"file": ("subs.srt", io.BytesIO(srt_dummy.encode("utf-8")), "text/plain")}
        )
        self.assertEqual(sub_res.status_code, 200)
        self.assertEqual(sub_res.json()["count"], 1)
        self.assertEqual(sub_res.json()["segments"][0]["character"], "Naruto")

        # 5. Compile Pack via API
        # Provide dummy audio file for session vocals
        session = BUILDER_SESSIONS[session_id]
        test_vocals = os.path.join(session["folder"], "vocals.wav")
        create_dummy_wav(test_vocals, duration_sec=4.0)
        session["vocals_path"] = test_vocals
        session["full_audio_path"] = test_vocals

        compile_res = self.client.post(
            f"/api/builder/{session_id}/compile",
            json={
                "pack_name": "API_Compiled_Test_Pack",
                "authors": ["API Builder"],
                "subtitle": "Compiled via API test",
                "segments": [
                    {"start": 0.5, "end": 1.8, "text": "Believe it!", "character": "Naruto"}
                ]
            }
        )
        self.assertEqual(compile_res.status_code, 200)
        cdata = compile_res.json()
        self.assertEqual(cdata["status"], "ok")
        self.assertIn("download_url", cdata)
        self.assertTrue(cdata["download_url"].startswith("/api/packs/"))

        compiled_pack_folder = os.path.join(pack_loader.PACKS_DIRS[0], "API_Compiled_Test_Pack")
        if os.path.isdir(compiled_pack_folder):
            shutil.rmtree(compiled_pack_folder, ignore_errors=True)

        # Clean session
        session_folder = BUILDER_SESSIONS[session_id]["folder"]
        if os.path.exists(session_folder):
            shutil.rmtree(session_folder, ignore_errors=True)
        BUILDER_SESSIONS.pop(session_id, None)

    def test_07_romaji_romanization(self):
        """Tests Japanese to Romaji romanization for dubbing subtitles."""
        japanese_text = "心臓を捧げよ！進め！"
        romaji = pack_builder.to_romaji(japanese_text)
        self.assertIn("sasage", romaji.lower())
        self.assertIn("susume", romaji.lower())

        # Test API endpoint
        res = self.client.post("/api/builder/test_session/romanize", json={"text": "何をしている？"})
        self.assertEqual(res.status_code, 200)
        self.assertIn("nani", res.json()["romaji"].lower())

    def test_08_import_url_endpoint(self):
        """Tests the /api/builder/import_url endpoint for YouTube URL direct ingestion."""
        from unittest.mock import patch

        # 1. Validation error on empty URL
        res_empty = self.client.post("/api/builder/import_url", json={"url": ""})
        self.assertEqual(res_empty.status_code, 400)

        # 2. Successful URL import with mocked download_video_from_url
        video_dummy = os.path.join(self.tmp_dir, "yt_test_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=6.0)

        mock_result = {
            "video_path": video_dummy,
            "filename": "yt_test_video.mp4",
            "title": "Demon Slayer - Hinokami Kagura Scene",
            "duration": 6.0,
            "cover_path": None,
            "subtitle_segments": [
                {"start": 1.0, "end": 3.0, "text": "Hinokami Kagura!", "character": "Tanjiro"}
            ],
        }

        with patch("pack_builder.download_video_from_url", return_value=mock_result):
            res = self.client.post("/api/builder/import_url", json={
                "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            })
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data["status"], "ok")
            self.assertEqual(data["title"], "Demon Slayer - Hinokami Kagura Scene")
            self.assertEqual(data["duration"], 6.0)
            self.assertTrue(data["has_subtitles"])
            self.assertEqual(data["subtitles_count"], 1)

            session_id = data["session_id"]
            self.assertIn(session_id, BUILDER_SESSIONS)
            session = BUILDER_SESSIONS[session_id]
            self.assertTrue(session["imported_from_url"])

            # Clean session
            session_folder = session["folder"]
            if os.path.exists(session_folder):
                shutil.rmtree(session_folder, ignore_errors=True)
            BUILDER_SESSIONS.pop(session_id, None)

    def test_09_extract_audio_silent_video(self):
        """Tests that extract_audio_from_video handles silent video files without crashing."""
        # Create a video with NO audio stream
        silent_video = os.path.join(self.tmp_dir, "silent_video.mp4")
        ffmpeg = pack_loader.get_ffmpeg_path()
        import subprocess
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=duration=2.0:size=320x240:rate=30",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-an",  # NO audio stream
            silent_video
        ]
        subprocess.run(cmd, check=True)

        out_wav = os.path.join(self.tmp_dir, "extracted_silent.wav")
        result = pack_builder.extract_audio_from_video(silent_video, out_wav)
        self.assertTrue(os.path.isfile(result))
        self.assertGreater(os.path.getsize(result), 1000)

    def test_10_builder_waveform_endpoint(self):
        """Tests /api/builder/{session_id}/waveform endpoint returns valid min/max peak arrays."""
        # 1. Create a dummy session with vocals WAV
        test_wav = os.path.join(self.tmp_dir, "session_vocals.wav")
        create_dummy_wav(test_wav, duration_sec=4.0)

        session_id = "test_wf_sess"
        BUILDER_SESSIONS[session_id] = {
            "session_id": session_id,
            "folder": self.tmp_dir,
            "vocals_path": test_wav,
            "full_audio_path": test_wav,
            "duration": 4.0,
            "progress": pack_builder.BuildProgress(session_id),
        }

        try:
            res = self.client.get(f"/api/builder/{session_id}/waveform?columns=100")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertIn("peaks", data)
            self.assertEqual(data["count"], 100)
            self.assertEqual(len(data["peaks"]), 100)
            self.assertEqual(len(data["peaks"][0]), 2)  # [min, max]
        finally:
            BUILDER_SESSIONS.pop(session_id, None)

    def test_11_pack_zip_export_and_roundtrip(self):
        """Tests pack_loader.export_pack_archive creates valid .zip archives and roundtrips with import_pack_archive."""
        import zipfile

        # 1. Assemble a sample scene pack
        src_wav = os.path.join(self.tmp_dir, "export_audio.wav")
        create_dummy_wav(src_wav, duration_sec=3.0)
        video_dummy = os.path.join(self.tmp_dir, "export_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=3.0)

        slices_dir = os.path.join(self.tmp_dir, "export_slices")
        segments = [
            {"start": 0.500, "end": 1.500, "text": "Line One", "character": "CharacterA"},
            {"start": 1.800, "end": 2.800, "text": "Line Two", "character": "CharacterB"},
        ]
        line_slices = pack_builder.slice_audio_lines(src_wav, segments, slices_dir, "Zip_Export_Test_Pack")
        pack_folder = pack_builder.assemble_pack(
            pack_name="Zip_Export_Test_Pack",
            video_source_path=video_dummy,
            backing_source_path=src_wav,
            line_slices=line_slices,
            authors=["Zip Creator"],
            subtitle="Testing Zip Export"
        )

        try:
            # 2. Export pack to .zip
            zip_out = os.path.join(self.tmp_dir, "ExportedTestPack.zip")
            res_zip_path = pack_loader.export_pack_archive(pack_folder, output_zip_path=zip_out)
            self.assertTrue(os.path.isfile(res_zip_path))
            self.assertGreater(os.path.getsize(res_zip_path), 500)

            # Inspect zip entries
            with zipfile.ZipFile(res_zip_path, "r") as z:
                names = z.namelist()
                self.assertIn("dub_video.mp4", names)
                self.assertIn("_captions.json", names)
                self.assertIn("_TIMESTAMPS.txt", names)
                self.assertIn("pack.json", names)
                self.assertIn("dub_subs.txt", names)
                self.assertIn("_backing_track.wav", names)

            # 3. Test roundtrip import into loader
            with open(res_zip_path, "rb") as zf:
                imported_pack = pack_loader.import_pack_archive(zf.read(), "ExportedTestPack.zip")
            self.assertIsNotNone(imported_pack)
            self.assertEqual(imported_pack.name, "Zip_Export_Test_Pack")
            self.assertEqual(len(imported_pack.lines), 2)
            self.assertIn("CharacterA", imported_pack.characters)

        finally:
            if os.path.isdir(pack_folder):
                shutil.rmtree(pack_folder, ignore_errors=True)
            if 'imported_pack' in locals() and imported_pack and os.path.isdir(imported_pack.folder):
                shutil.rmtree(imported_pack.folder, ignore_errors=True)

    def test_12_pack_export_api_endpoint(self):
        """Tests GET /api/packs/{pack_id}/export endpoint streams valid application/zip."""
        # 1. Assemble pack
        src_wav = os.path.join(self.tmp_dir, "api_exp_audio.wav")
        create_dummy_wav(src_wav, duration_sec=2.0)
        video_dummy = os.path.join(self.tmp_dir, "api_exp_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=2.0)

        slices_dir = os.path.join(self.tmp_dir, "api_exp_slices")
        segments = [{"start": 0.200, "end": 1.200, "text": "API Line", "character": "Tester"}]
        line_slices = pack_builder.slice_audio_lines(src_wav, segments, slices_dir, "API_Export_Pack")
        pack_folder = pack_builder.assemble_pack(
            pack_name="API_Export_Pack",
            video_source_path=video_dummy,
            backing_source_path=src_wav,
            line_slices=line_slices,
            authors=["API Tester"]
        )

        try:
            pack_id = os.path.basename(os.path.normpath(pack_folder))
            # Test export API
            res = self.client.get(f"/api/packs/{pack_id}/export")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers.get("content-type"), "application/zip")
            self.assertIn("attachment", res.headers.get("content-disposition", ""))
            self.assertGreater(len(res.content), 500)
            # Verify magic bytes of returned zip
            self.assertTrue(res.content.startswith(b"PK\x03\x04"))
        finally:
            if os.path.isdir(pack_folder):
                shutil.rmtree(pack_folder, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

