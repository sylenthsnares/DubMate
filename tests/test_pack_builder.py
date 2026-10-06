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

# Ensure the project root is importable when this suite is run from tests/
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import pack_loader
import pack_builder
from app import app
from dubmate.builder_api import BUILDER_SESSIONS


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
        try:
            import pykakasi
            self.assertIn("sasage", romaji.lower())
            self.assertIn("susume", romaji.lower())
        except ImportError:
            # When optional pykakasi is not installed, to_romaji gracefully returns original text
            self.assertEqual(romaji, japanese_text)

        # Test API endpoint
        res = self.client.post("/api/builder/test_session/romanize", json={"text": "何をしている？"})
        self.assertEqual(res.status_code, 200)
        try:
            import pykakasi
            self.assertIn("nani", res.json()["romaji"].lower())
        except ImportError:
            self.assertEqual(res.json()["romaji"], "何をしている？")

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

    def test_08b_ytdlp_age_days(self):
        """yt-dlp versions are release dates; the age is counted in days from them."""
        import datetime
        today = datetime.date(2026, 3, 1)
        self.assertEqual(pack_builder.ytdlp_age_days("2026.03.01", today), 0)
        self.assertEqual(pack_builder.ytdlp_age_days("2025.12.31", today), 60)
        self.assertEqual(pack_builder.ytdlp_age_days("2025.12.30", today), 61)
        # Nightly builds append a time; single-digit months/days are fine too.
        self.assertEqual(pack_builder.ytdlp_age_days("2026.2.1.232744", today), 28)
        # A future date (clock skew) is not negative.
        self.assertEqual(pack_builder.ytdlp_age_days("2026.04.01", today), 0)
        for unknown in ("", None, "dev", "2026.13.40"):
            self.assertIsNone(pack_builder.ytdlp_age_days(unknown, today))

    def _fake_ytdlp(self, version, package_dir, error="ERROR: Unable to extract player response"):
        """A stand-in yt_dlp module whose download always fails with `error`."""
        import types

        class FakeYDL:
            def __init__(self, opts):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def extract_info(self, url, download=True):
                raise Exception(error)

        mod = types.ModuleType("yt_dlp")
        mod.__file__ = os.path.join(package_dir, "yt_dlp", "__init__.py")
        mod.version = types.SimpleNamespace(__version__=version)
        mod.YoutubeDL = FakeYDL
        return mod

    def test_08c_stale_ytdlp_message_on_failed_import(self):
        """A failed link import says Pack Builder needs an update, with the steps kept apart."""
        import datetime
        import sys
        from unittest.mock import patch

        old = (datetime.date.today() - datetime.timedelta(days=90)).strftime("%Y.%m.%d")
        fresh = (datetime.date.today() - datetime.timedelta(days=10)).strftime("%Y.%m.%d")
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        out_dir = os.path.join(self.tmp_dir, "stale_import")

        # Source install: points at the update scripts.
        source_mod = self._fake_ytdlp(old, os.path.join(self.tmp_dir, "site-packages"))
        with patch.dict(sys.modules, {"yt_dlp": source_mod}):
            with self.assertRaises(pack_builder.StaleYtDlpError) as ctx:
                pack_builder.download_video_from_url(url, out_dir)
        msg = str(ctx.exception)
        steps = ctx.exception.details
        # The headline is short and outcome-first: no tool name, no steps, no raw error.
        self.assertTrue(msg.startswith("Couldn't import that video."), msg)
        self.assertNotIn("yt-dlp", msg)
        self.assertNotIn("update.bat", msg)
        self.assertNotIn("Unable to extract", msg)  # raw error stays in the log
        self.assertLess(len(msg), 80)
        self.assertIn("update.bat", steps)
        self.assertIn("update.sh", steps)

        # Desktop app: points at re-downloading Pack Builder from its ai-packages folder.
        ai_dir = os.path.join(self.tmp_dir, "ai-packages")
        desktop_mod = self._fake_ytdlp(old, ai_dir)
        with patch.dict(sys.modules, {"yt_dlp": desktop_mod}):
            with self.assertRaises(pack_builder.StaleYtDlpError) as ctx:
                pack_builder.download_video_from_url(url, out_dir)
        msg = str(ctx.exception)
        steps = ctx.exception.details
        self.assertNotIn(ai_dir, msg)
        self.assertIn(ai_dir, steps)
        self.assertIn("open DubMate again", steps)
        self.assertNotIn("update.bat", steps)

        # A recent yt-dlp keeps the plain failure; so do our own link errors.
        fresh_mod = self._fake_ytdlp(fresh, os.path.join(self.tmp_dir, "site-packages"))
        with patch.dict(sys.modules, {"yt_dlp": fresh_mod}):
            with self.assertRaises(RuntimeError) as ctx:
                pack_builder.download_video_from_url(url, out_dir)
        self.assertNotIsInstance(ctx.exception, pack_builder.StaleYtDlpError)
        unsupported_mod = self._fake_ytdlp(
            old, os.path.join(self.tmp_dir, "site-packages"), error="Unsupported URL: x")
        with patch.dict(sys.modules, {"yt_dlp": unsupported_mod}):
            with self.assertRaises(ValueError):
                pack_builder.download_video_from_url(url, out_dir)

        # The API passes the message and update steps through instead of the generic text.
        with patch("pack_builder.download_video_from_url",
                   side_effect=pack_builder.StaleYtDlpError("STALE-MESSAGE", "STALE-STEPS")):
            res = self.client.post("/api/builder/import_url", json={"url": url})
        self.assertEqual(res.status_code, 500)
        detail = res.json()["detail"]
        self.assertEqual(detail["code"], "ytdlp_stale")
        self.assertEqual(detail["message"], "STALE-MESSAGE")
        self.assertEqual(detail["details"], "STALE-STEPS")

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

    def test_13_rebuild_same_pack_name_drops_stale_slices(self):
        """Rebuilding a pack under the same name must not keep the previous build's line slices or icon."""
        src_wav = os.path.join(self.tmp_dir, "rebuild_audio.wav")
        create_dummy_wav(src_wav, duration_sec=6.0)
        video_dummy = os.path.join(self.tmp_dir, "rebuild_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=4.0)
        cover = os.path.join(self.tmp_dir, "cover.png")
        with open(cover, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)

        first_segments = [
            {"start": 0.500, "end": 1.500, "text": "One", "character": "Hero"},
            {"start": 2.000, "end": 3.000, "text": "Two", "character": "Villain"},
            {"start": 3.500, "end": 4.500, "text": "Three", "character": "Hero"},
        ]
        second_segments = [
            {"start": 1.000, "end": 2.000, "text": "Uno", "character": "Hero"},
            {"start": 4.000, "end": 5.000, "text": "Dos", "character": "Villain"},
        ]

        pack_folder = None
        try:
            first_slices = pack_builder.slice_audio_lines(
                src_wav, first_segments, os.path.join(self.tmp_dir, "slices_1"), "Rebuild_Test_Pack")
            pack_folder = pack_builder.assemble_pack(
                pack_name="Rebuild_Test_Pack",
                video_source_path=video_dummy,
                backing_source_path=src_wav,
                line_slices=first_slices,
                cover_image_path=cover,
            )
            first = pack_loader.load_pack(pack_folder)
            self.assertIsNotNone(first)
            self.assertEqual(len(first.lines), 3)
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "icon.png")))

            second_slices = pack_builder.slice_audio_lines(
                src_wav, second_segments, os.path.join(self.tmp_dir, "slices_2"), "Rebuild_Test_Pack")
            second_folder = pack_builder.assemble_pack(
                pack_name="Rebuild_Test_Pack",
                video_source_path=video_dummy,
                backing_source_path=src_wav,
                line_slices=second_slices,
            )
            self.assertEqual(os.path.normpath(second_folder), os.path.normpath(pack_folder))
            second = pack_loader.load_pack(second_folder)
            self.assertIsNotNone(second)
            self.assertEqual(len(second.lines), 2)
            self.assertFalse(os.path.isfile(os.path.join(pack_folder, "icon.png")))
            self.assertTrue(os.path.isfile(os.path.join(pack_folder, "_backing_track.wav")))
        finally:
            if pack_folder and os.path.isdir(pack_folder):
                shutil.rmtree(pack_folder, ignore_errors=True)

    def test_14_slice_failure_raises_clear_error(self):
        """When both slice attempts fail, slice_audio_lines raises instead of returning a missing file."""
        missing_wav = os.path.join(self.tmp_dir, "does_not_exist.wav")
        segments = [{"start": 0.0, "end": 1.0, "text": "Hi", "character": "Hero"}]
        with self.assertRaises(RuntimeError) as ctx:
            pack_builder.slice_audio_lines(missing_wav, segments, os.path.join(self.tmp_dir, "slices_fail"), "Fail Pack")
        self.assertIn("Could not cut dialogue line 1", str(ctx.exception))

    def test_15_editor_video_does_not_size_the_pane(self):
        """B5: a 9:16 clip must not push the editor control deck off-screen.

        In normal flow the <video> takes its natural aspect-ratio height
        (~850px for 1080x1920 at 478px wide), which grows the editor's top row
        and hides Play / Mark IN/OUT / + Add Cue / Zoom below the clipped area.
        The player must be taken out of flow inside its relative container.
        """
        import re
        css_path = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
                                 "static", "css", "builder.css")
        with open(css_path, encoding="utf-8") as f:
            css = re.sub(r"/\*.*?\*/", "", f.read(), flags=re.S)

        def decls(selector):
            m = re.search(r"(?:^|\})\s*" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
            self.assertIsNotNone(m, f"{selector} rule missing from builder.css")
            return {k.strip(): v.strip() for k, v in
                    (d.split(":", 1) for d in m.group(1).split(";") if ":" in d)}

        player = decls(".editor-video-player")
        self.assertEqual(player.get("position"), "absolute")
        self.assertEqual(player.get("inset"), "0")
        self.assertEqual(player.get("object-fit"), "contain")
        container = decls(".editor-video-container")
        self.assertEqual(container.get("position"), "relative")
        self.assertEqual(container.get("overflow"), "hidden")

    def test_16_vocals_audio_route(self):
        """The editor's voices-only preview gets the separated voice stem, and only that."""
        folder = os.path.join(self.tmp_dir, "audio_sess")
        os.makedirs(os.path.join(folder, "stems"))
        create_dummy_wav(os.path.join(folder, "stems", "vocals.wav"), duration_sec=1.0)

        session_id = "test_audio_sess"
        session = {"session_id": session_id, "folder": folder, "voices_separated": True}
        BUILDER_SESSIONS[session_id] = session
        not_ready = "This audio isn't ready yet."
        try:
            res = self.client.get(f"/api/builder/{session_id}/audio/vocals")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers["content-type"], "audio/wav")

            res = self.client.get(f"/api/builder/{session_id}/audio/vocals",
                                  headers={"Range": "bytes=0-99"})
            self.assertEqual(res.status_code, 206)
            self.assertEqual(len(res.content), 100)

            res = self.client.get(f"/api/builder/{session_id}/audio/backing")
            self.assertEqual(res.status_code, 404)
            self.assertEqual(res.json()["detail"], not_ready)

            res = self.client.get("/api/builder/no_such_session/audio/vocals")
            self.assertEqual(res.status_code, 404)
            self.assertEqual(res.json()["detail"], not_ready)

            # The basic filter's vocals.wav is the full mix, never "voices only".
            session["voices_separated"] = False
            res = self.client.get(f"/api/builder/{session_id}/audio/vocals")
            self.assertEqual(res.status_code, 404)
            self.assertEqual(res.json()["detail"], not_ready)

            session["voices_separated"] = True
            os.remove(os.path.join(folder, "stems", "vocals.wav"))
            res = self.client.get(f"/api/builder/{session_id}/audio/vocals")
            self.assertEqual(res.status_code, 404)
            self.assertEqual(res.json()["detail"], not_ready)
        finally:
            BUILDER_SESSIONS.pop(session_id, None)

    def test_17_nonverbal_detection(self):
        """Grunts away from the dialogue become lines; walla, clicks, tones and line tails don't."""
        import numpy as np
        sr = 16000
        rng = np.random.default_rng(7)
        samples = rng.normal(0.0, 1e-4, 40 * sr)  # about -80 dBFS noise floor

        def tone(start, end, amp):
            n = int(round((end - start) * sr))
            t = np.arange(n) / sr
            i = int(round(start * sr))
            samples[i:i + n] += amp * np.sin(2 * np.pi * 220.0 * t)

        tone(2.0, 4.0, 0.3)     # the transcribed line, dialogue level
        tone(4.1, 4.5, 0.3)     # burst 0.1 s after the line: too close
        tone(8.0, 8.6, 0.25)    # the grunt: near dialogue level, far from the line
        tone(12.0, 17.0, 0.3 / 17.8)  # walla, about 25 dB below dialogue
        tone(20.0, 20.1, 0.3)   # click: too short
        tone(23.0, 35.0, 0.3)   # 12 s tone: too long
        transcribed = [{"start": 2.0, "end": 4.0, "text": "Hello", "character": "Actor"}]

        found = pack_builder.find_nonverbal_segments(samples.astype(np.float32), sr, transcribed)
        self.assertEqual(len(found), 1, found)
        self.assertAlmostEqual(found[0]["start"], 8.0 - pack_builder.NONVERBAL_PAD_S, delta=0.03)
        self.assertAlmostEqual(found[0]["end"], 8.6 + pack_builder.NONVERBAL_PAD_S, delta=0.03)
        self.assertIs(found[0]["nonverbal"], True)
        self.assertEqual(found[0]["text"], "")

        # A flat noisy stem has no contrast to judge by.
        flat = rng.normal(0.0, 0.1, 10 * sr).astype(np.float32)
        self.assertEqual(pack_builder.find_nonverbal_segments(flat, sr, []), [])

    def test_18_pipeline_order(self):
        """Non-verbal lines are added after Whisper and before speakers, only on a real separation."""
        from dubmate import builder_api
        calls = []
        names = ("extract_audio_from_video", "separate_audio_stems", "transcribe_audio",
                 "add_nonverbal_segments", "assign_speakers_to_segments")
        originals = {n: getattr(pack_builder, n) for n in names}
        state = {"used_fallback": False}
        grunt = {"start": 5.0, "end": 5.6, "text": "", "character": "", "nonverbal": True}

        def fake_extract(video, out):
            calls.append("extract")
            return out

        def fake_separate(wav, out_dir):
            calls.append("separate")
            return {"vocals": os.path.join(out_dir, "vocals.wav"), "backing": os.path.join(out_dir, "backing.wav"),
                    "used_fallback": state["used_fallback"], "fallback_notice": "basic filter"}

        def fake_transcribe(wav, **kwargs):
            calls.append("transcribe")
            return [{"start": 1.0, "end": 2.0, "text": "Hi", "character": "Actor"}]

        def fake_nonverbal(segments, vocals_wav, duration):
            calls.append("nonverbal")
            return segments + [dict(grunt)]

        def fake_assign(segments):
            calls.append(("assign", any(s.get("nonverbal") for s in segments)))
            return originals["assign_speakers_to_segments"](segments)

        session_id = "test_pipeline_order"
        try:
            pack_builder.extract_audio_from_video = fake_extract
            pack_builder.separate_audio_stems = fake_separate
            pack_builder.transcribe_audio = fake_transcribe
            pack_builder.add_nonverbal_segments = fake_nonverbal
            pack_builder.assign_speakers_to_segments = fake_assign

            def run(**extra):
                calls.clear()
                session = {"session_id": session_id, "folder": self.tmp_dir, "duration": 10.0,
                           "progress": pack_builder.BuildProgress(session_id),
                           "video_path": os.path.join(self.tmp_dir, "clip.mp4")}
                session.update(extra)
                BUILDER_SESSIONS[session_id] = session
                builder_api._run_builder_pipeline_sync(session_id)
                return session["progress"]

            progress = run()
            self.assertEqual(calls, ["extract", "separate", "transcribe", "nonverbal", ("assign", True)])
            self.assertEqual(progress.status, "transcribed")
            self.assertEqual(len(progress.segments), 2)
            self.assertTrue(progress.segments[1]["nonverbal"])
            self.assertTrue(progress.segments[1]["character"].startswith("Speaker"))
            self.assertEqual(progress.message, "Found 2 lines, 1 without words")

            state["used_fallback"] = True
            progress = run()
            self.assertEqual(calls, ["extract", "separate", "transcribe", ("assign", False)])
            self.assertEqual(progress.status, "transcribed")
            self.assertEqual(progress.message, "Found 1 line")

            state["used_fallback"] = False
            progress = run(subtitle_segments=[{"start": 1.0, "end": 2.0, "text": "Hi", "character": "Levi"}])
            self.assertEqual(calls, ["extract", "separate", ("assign", False)])
            self.assertEqual(progress.status, "transcribed")
        finally:
            for n, fn in originals.items():
                setattr(pack_builder, n, fn)
            BUILDER_SESSIONS.pop(session_id, None)

    def test_19_nonverbal_put_and_pack_roundtrip(self):
        """PUT /segments keeps the non-verbal flag; a line without words loads as an empty caption."""
        session_id = "test_nonverbal_put"
        BUILDER_SESSIONS[session_id] = {"session_id": session_id, "folder": self.tmp_dir, "duration": 10.0,
                                        "progress": pack_builder.BuildProgress(session_id)}
        try:
            res = self.client.put(f"/api/builder/{session_id}/segments", json={"segments": [
                {"start": 1.0, "end": 2.0, "text": "Hi", "character": "Speaker 1"},
                {"start": 3.0, "end": 3.6, "text": "", "character": "Speaker 2", "nonverbal": True},
                {"start": 4.0, "end": 4.5, "text": "", "character": "Speaker 2", "nonverbal": False},
            ]})
            self.assertEqual(res.status_code, 200)
            segs = res.json()["segments"]
            self.assertNotIn("nonverbal", segs[0])
            self.assertIs(segs[1]["nonverbal"], True)
            self.assertNotIn("nonverbal", segs[2])
        finally:
            BUILDER_SESSIONS.pop(session_id, None)

        src_wav = os.path.join(self.tmp_dir, "source_audio.wav")
        create_dummy_wav(src_wav, duration_sec=5.0)
        video_dummy = os.path.join(self.tmp_dir, "dummy_video.mp4")
        create_dummy_mp4(video_dummy, duration_sec=4.0)
        segments = [
            {"start": 0.500, "end": 1.800, "text": "Line Alpha", "character": "Speaker 1"},
            {"start": 2.200, "end": 2.800, "text": "", "character": "Speaker 2", "nonverbal": True},
        ]
        line_slices = pack_builder.slice_audio_lines(src_wav, segments, os.path.join(self.tmp_dir, "slices"),
                                                     "Nonverbal_Test_Pack")
        pack_folder = pack_builder.assemble_pack(
            pack_name="Nonverbal_Test_Pack",
            video_source_path=video_dummy,
            backing_source_path=src_wav,
            line_slices=line_slices,
            authors=["DubMate Tester"],
            subtitle="Unit test non-verbal line",
        )
        try:
            loaded = pack_loader.load_pack(pack_folder)
            self.assertIsNotNone(loaded)
            self.assertEqual(len(loaded.lines), 2)
            line = loaded.lines[1]
            self.assertEqual(line["caption"], "")
            self.assertEqual(line["character"], "Speaker 2")
            self.assertAlmostEqual(line["start"], 2.2, places=2)
        finally:
            if os.path.isdir(pack_folder):
                shutil.rmtree(pack_folder, ignore_errors=True)


    # ---- Speaker detection (no network, no real models) ----

    def _speaker_env(self, addon=None):
        """
        Patches for one speaker detection test: a sys.path with no real add-on folder (plus
        `addon` first when given), the cache in tmp_dir, and a fake sherpa_onnx module.
        Returns (patches, fake module, script dict). The caller stops the patches.
        """
        import sys
        import types
        from unittest import mock

        script = {"segments": [], "raise": None, "config": None, "samples": None, "callbacks": []}

        class _Config:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)

            def validate(self):
                return True

        class _Result:
            def __init__(self, segs):
                self.segs = segs

            def sort_by_start_time(self):
                return sorted(self.segs, key=lambda s: s.start)

        class _Diarization:
            sample_rate = 16000

            def __init__(self, config):
                script["config"] = config

            def process(self, samples, callback=None):
                script["samples"] = samples
                if callback:
                    script["callbacks"].append(callback(1, 2))
                    script["callbacks"].append(callback(2, 2))
                if script["raise"]:
                    raise script["raise"]
                return _Result([types.SimpleNamespace(start=a, end=b, speaker=c) for a, b, c in script["segments"]])

        class _ModuleSlot:
            """Puts one entry into sys.modules and restores just that entry (patch.dict would reset all of them)."""
            def __init__(self, name, value):
                self.name, self.value = name, value

            def start(self):
                self.had, self.old = self.name in sys.modules, sys.modules.get(self.name)
                sys.modules[self.name] = self.value

            def stop(self):
                if self.had:
                    sys.modules[self.name] = self.old
                else:
                    sys.modules.pop(self.name, None)

        fake = types.ModuleType("sherpa_onnx")
        for name in ("OfflineSpeakerDiarizationConfig", "OfflineSpeakerSegmentationModelConfig",
                     "OfflineSpeakerSegmentationPyannoteModelConfig", "SpeakerEmbeddingExtractorConfig",
                     "FastClusteringConfig"):
            setattr(fake, name, _Config)
        fake.OfflineSpeakerDiarization = _Diarization

        clean_path = [p for p in sys.path if os.path.basename(os.path.normpath(p or ".")).lower() != "ai-packages"]
        patches = [
            mock.patch.object(sys, "path", ([addon] if addon else []) + clean_path),
            mock.patch.object(pack_loader, "CACHE_DIR", self.tmp_dir),
            _ModuleSlot("sherpa_onnx", fake),
            mock.patch.object(pack_builder.audio_processor, "read_wav_mono",
                              lambda path, sr=16000: __import__("numpy").zeros(1600, dtype="float64")),
        ]
        for p in patches:
            p.start()
        return patches, fake, script

    def _touch_speaker_models(self):
        folder = pack_builder._speaker_models_dir()
        os.makedirs(folder, exist_ok=True)
        for name, _url, _sha, _member in pack_builder.SPEAKER_MODELS:
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"model")
        return folder

    def test_20_speaker_models_download_and_checksum(self):
        """Models download once, come out of the archive by member name and are checksummed; a bad one leaves nothing."""
        import hashlib
        import tarfile
        from unittest import mock

        def sha(data):
            return hashlib.sha256(data).hexdigest()

        seg_bytes, lic_bytes, emb_bytes = b"segmentation model", b"MIT License", b"embedding model"
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:bz2") as tar:
            for member, data in (("sherpa-onnx-pyannote-segmentation-3-0/model.onnx", seg_bytes),
                                 ("sherpa-onnx-pyannote-segmentation-3-0/LICENSE", lic_bytes),
                                 ("sherpa-onnx-pyannote-segmentation-3-0/README.md", b"not wanted")):
                info = tarfile.TarInfo(member)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        archive_bytes = archive.getvalue()
        seg_url = pack_builder.SPEAKER_SEGMENTATION_URL
        emb_url = pack_builder.SPEAKER_MODELS[2][1]
        payloads = {seg_url: archive_bytes, emb_url: emb_bytes}
        fetched = []

        def fake_urlopen(url, timeout=None):
            fetched.append((url, timeout))
            return io.BytesIO(payloads[url])

        def models(emb_sha):
            return (
                ("pyannote-segmentation-3-0.onnx", seg_url, sha(seg_bytes), "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"),
                ("pyannote-segmentation-3-0.LICENSE", seg_url, None, "sherpa-onnx-pyannote-segmentation-3-0/LICENSE"),
                ("campplus-sv-zh-en-16k-common-advanced.onnx", emb_url, emb_sha, None),
            )

        patches, _fake, _script = self._speaker_env()
        try:
            patches.append(mock.patch("urllib.request.urlopen", fake_urlopen))
            patches.append(mock.patch.object(pack_builder, "SPEAKER_SEGMENTATION_ARCHIVE_SHA256", sha(archive_bytes)))
            patches.append(mock.patch.object(pack_builder, "SPEAKER_MODELS", models(sha(emb_bytes))))
            for p in patches[-3:]:
                p.start()

            folder = pack_builder._speaker_models_dir()
            self.assertEqual(folder, os.path.join(self.tmp_dir, "models", "speakers"))
            seen = []
            self.assertTrue(pack_builder._ensure_speaker_models(seen.append))
            self.assertEqual(sorted(os.listdir(folder)), sorted(m[0] for m in pack_builder.SPEAKER_MODELS))
            with open(os.path.join(folder, "pyannote-segmentation-3-0.onnx"), "rb") as f:
                self.assertEqual(f.read(), seg_bytes)
            with open(os.path.join(folder, "pyannote-segmentation-3-0.LICENSE"), "rb") as f:
                self.assertEqual(f.read(), lic_bytes)
            with open(os.path.join(folder, "campplus-sv-zh-en-16k-common-advanced.onnx"), "rb") as f:
                self.assertEqual(f.read(), emb_bytes)
            self.assertEqual(fetched, [(seg_url, 60), (emb_url, 60)])  # the archive is fetched once
            self.assertEqual(seen[-1], 1.0)

            # Everything present: no network at all.
            fetched.clear()
            self.assertTrue(pack_builder._ensure_speaker_models())
            self.assertEqual(fetched, [])

            # A bad checksum leaves neither the file nor its .part.
            os.remove(os.path.join(folder, "campplus-sv-zh-en-16k-common-advanced.onnx"))
            patches.append(mock.patch.object(pack_builder, "SPEAKER_MODELS", models("0" * 64)))
            patches[-1].start()
            self.assertFalse(pack_builder._ensure_speaker_models())
            self.assertNotIn("campplus-sv-zh-en-16k-common-advanced.onnx", os.listdir(folder))
            self.assertEqual([n for n in os.listdir(folder) if n.endswith(".part")], [])

            # A bad archive leaves no model and no .part either.
            for name in os.listdir(folder):
                os.remove(os.path.join(folder, name))
            patches.append(mock.patch.object(pack_builder, "SPEAKER_SEGMENTATION_ARCHIVE_SHA256", "0" * 64))
            patches[-1].start()
            self.assertFalse(pack_builder._ensure_speaker_models())
            self.assertEqual(os.listdir(folder), [])

            # Through detect_speaker_turns, a failed download is the download notice.
            turns, notice = pack_builder.detect_speaker_turns(os.path.join(self.tmp_dir, "vocals.wav"))
            self.assertIsNone(turns)
            self.assertEqual(notice, pack_builder.SPEAKER_NOTICE_NO_DOWNLOAD)
        finally:
            for p in reversed(patches):
                p.stop()

    def test_21_speaker_detection_not_installed_on_source(self):
        """A source install without the package gets the notice and never runs pip."""
        import sys
        from unittest import mock
        runs = []
        patches, _fake, _script = self._speaker_env()
        try:
            sys.modules["sherpa_onnx"] = None  # import fails; restored by the slot patch
            patches.append(mock.patch.object(pack_builder.subprocess, "run", lambda *a, **k: runs.append(a)))
            patches[-1].start()
            self.assertIsNone(pack_builder._addon_dir())
            turns, notice = pack_builder.detect_speaker_turns(os.path.join(self.tmp_dir, "vocals.wav"))
            self.assertIsNone(turns)
            self.assertEqual(notice, "Speaker detection isn't installed, so speakers were guessed from pauses. "
                                     "Check who says each line.")
            self.assertEqual(runs, [])
        finally:
            for p in reversed(patches):
                p.stop()

    def test_22_speaker_package_top_up_in_addon(self):
        """A desktop add-on without the package gets exactly one pinned, no-upgrade pip install, then imports it."""
        import subprocess
        import sys
        from unittest import mock
        addon = os.path.join(self.tmp_dir, "ai-packages")
        os.makedirs(addon)
        with open(os.path.join(addon, ".install-complete"), "w") as f:
            f.write("ok")
        os.makedirs(os.path.join(self.tmp_dir, "not-it", "ai-packages"))  # no marker: ignored

        runs = []
        patches, fake, script = self._speaker_env(addon=addon)
        try:
            pip = {"returncode": 0}

            def fake_run(cmd, **kwargs):
                runs.append((cmd, kwargs))
                if pip["returncode"] == 0:
                    sys.modules["sherpa_onnx"] = fake
                return subprocess.CompletedProcess(cmd, pip["returncode"], b"", b"no pip")

            sys.modules["sherpa_onnx"] = None  # import fails; restored by the slot patch
            patches.append(mock.patch.object(pack_builder.subprocess, "run", fake_run))
            patches[-1].start()
            sys.path.insert(1, os.path.join(self.tmp_dir, "not-it", "ai-packages"))

            self.assertEqual(pack_builder._addon_dir(), addon)
            folder = self._touch_speaker_models()
            self.assertEqual(folder, os.path.join(addon, "dubmate-models", "speakers"))
            script["segments"] = [(3.0, 4.0, 1), (0.5, 2.0, 0)]
            progress = []
            turns, notice = pack_builder.detect_speaker_turns(os.path.join(self.tmp_dir, "vocals.wav"), progress.append)

            self.assertEqual(len(runs), 1)
            cmd, kwargs = runs[0]
            self.assertEqual(cmd, [sys.executable, "-m", "pip", "install", "--no-input", "--no-deps", "--target", addon,
                                   "sherpa-onnx==1.13.8", "sherpa-onnx-core==1.13.8"])
            self.assertNotIn("--upgrade", cmd)
            self.assertEqual(kwargs.get("timeout"), 300)
            self.assertEqual(notice, "")
            self.assertEqual(turns, [(0.5, 2.0, 0), (3.0, 4.0, 1)])

            config = script["config"]
            self.assertEqual(config.segmentation.pyannote.window_shift_ratio, 0.1)
            self.assertEqual(config.segmentation.pyannote.model, os.path.join(folder, "pyannote-segmentation-3-0.onnx"))
            self.assertEqual(config.embedding.model, os.path.join(folder, "campplus-sv-zh-en-16k-common-advanced.onnx"))
            self.assertEqual(config.clustering.num_clusters, -1)
            self.assertEqual(config.clustering.threshold, 0.5)
            self.assertEqual((config.min_duration_on, config.min_duration_off), (0.3, 0.5))
            self.assertEqual(str(script["samples"].dtype), "float32")
            self.assertEqual(script["callbacks"], [0, 0])
            self.assertTrue(progress and all(0.88 <= f <= 0.98 for f in progress))
            self.assertAlmostEqual(progress[-1], 0.98)

            # A failed top-up is the "isn't installed" notice.
            runs.clear()
            pip["returncode"] = 1
            sys.modules["sherpa_onnx"] = None
            turns, notice = pack_builder.detect_speaker_turns(os.path.join(self.tmp_dir, "vocals.wav"))
            self.assertIsNone(turns)
            self.assertEqual(notice, pack_builder.SPEAKER_NOTICE_NOT_INSTALLED)
            self.assertEqual(len(runs), 1)
        finally:
            for p in reversed(patches):
                p.stop()

    def test_23_speaker_detection_empty_and_failure(self):
        """No voices found and any error both fall back with their own notice."""
        patches, _fake, script = self._speaker_env()
        try:
            self._touch_speaker_models()
            wav = os.path.join(self.tmp_dir, "vocals.wav")
            turns, notice = pack_builder.detect_speaker_turns(wav)
            self.assertIsNone(turns)
            self.assertEqual(notice, "Speaker detection couldn't tell the voices apart, so speakers were guessed "
                                     "from pauses. Check who says each line.")

            script["raise"] = RuntimeError("boom")
            script["segments"] = [(0.0, 1.0, 0)]
            turns, notice = pack_builder.detect_speaker_turns(wav)
            self.assertIsNone(turns)
            self.assertEqual(notice, "Speaker detection couldn't run, so speakers were guessed from pauses. "
                                     "Check who says each line.")

            script["raise"] = None
            turns, notice = pack_builder.detect_speaker_turns(wav)
            self.assertEqual((turns, notice), ([(0.0, 1.0, 0)], ""))
        finally:
            for p in reversed(patches):
                p.stop()

    def test_24_assign_speakers_from_turns(self):
        """Lines take the voice they overlap most, then a near turn, then the previous line; names follow first appearance."""
        turns = [(0.0, 2.0, 7), (2.5, 4.0, 3), (10.0, 12.0, 7), (13.5, 15.0, 5)]
        segs = [
            {"start": 0.5, "end": 1.5, "text": "a", "character": "Actor"},    # overlaps 7
            {"start": 1.8, "end": 3.9, "text": "b", "character": "Actor"},    # overlaps 7 by 0.2, 3 by 1.4
            {"start": 7.5, "end": 7.8, "text": "", "character": "", "nonverbal": True},  # nothing within 1 s: previous (3)
            {"start": 10.5, "end": 11.0, "text": "d", "character": "Actor"},  # overlaps 7
            {"start": 13.0, "end": 13.2, "text": "e", "character": "Actor"},  # 0.3 s from 5, 1.0 s from 7
        ]
        out = pack_builder.assign_speakers_to_segments(segs, turns)
        self.assertEqual([s["character"] for s in out],
                         ["Speaker 1", "Speaker 2", "Speaker 2", "Speaker 1", "Speaker 3"])

        # The first line with no overlap and nothing near takes the nearest turn.
        first = [{"start": 0.0, "end": 0.5, "text": "x", "character": "Actor"},
                 {"start": 8.2, "end": 8.8, "text": "y", "character": "Actor"}]
        out = pack_builder.assign_speakers_to_segments(first, [(5.0, 6.0, 4), (8.0, 9.0, 2)])
        self.assertEqual([s["character"] for s in out], ["Speaker 1", "Speaker 2"])

        # Named characters are kept; no turns keeps the pause guess.
        named = [{"start": 0.5, "end": 1.5, "text": "a", "character": "Levi"}]
        self.assertEqual(pack_builder.assign_speakers_to_segments(named, turns)[0]["character"], "Levi")
        guess = [{"start": 1.0, "end": 2.0, "text": "1", "character": "Actor"},
                 {"start": 5.5, "end": 6.5, "text": "2", "character": "Actor"}]
        self.assertEqual([s["character"] for s in pack_builder.assign_speakers_to_segments(guess, [])],
                         ["Speaker 1", "Speaker 2"])


if __name__ == "__main__":
    unittest.main()

