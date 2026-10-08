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
import time
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

    def test_10b_builder_waveform_is_computed_once(self):
        """A second /waveform call for the same track and width reuses the peaks."""
        import audio_processor
        test_wav = os.path.join(self.tmp_dir, "session_vocals.wav")
        create_dummy_wav(test_wav, duration_sec=2.0)
        session_id = "test_wf_cache"
        BUILDER_SESSIONS[session_id] = {
            "session_id": session_id,
            "folder": self.tmp_dir,
            "vocals_path": test_wav,
            "full_audio_path": test_wav,
            "duration": 2.0,
            "progress": pack_builder.BuildProgress(session_id),
        }
        real = audio_processor.compute_waveform_peaks
        calls = []

        def counting(*args, **kwargs):
            calls.append(kwargs.get("columns"))
            return real(*args, **kwargs)

        audio_processor.compute_waveform_peaks = counting
        try:
            first = self.client.get(f"/api/builder/{session_id}/waveform?columns=120").json()
            second = self.client.get(f"/api/builder/{session_id}/waveform?columns=120").json()
            self.assertEqual(len(calls), 1)
            self.assertEqual(second["peaks"], first["peaks"])
            self.assertEqual(second["count"], 120)
            # Another width is a different drawing, so it is computed.
            self.client.get(f"/api/builder/{session_id}/waveform?columns=200")
            self.assertEqual(len(calls), 2)
            # New audio in the session (processing run again) is never served stale peaks.
            create_dummy_wav(test_wav, duration_sec=3.0)
            st = os.stat(test_wav)
            os.utime(test_wav, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
            self.client.get(f"/api/builder/{session_id}/waveform?columns=120")
            self.assertEqual(len(calls), 3)
        finally:
            audio_processor.compute_waveform_peaks = real
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
        """Rebuilding a pack in its folder (Build again) must not keep the previous build's line slices or icon."""
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
                folder_name=os.path.basename(pack_folder),
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
        """Non-verbal lines come after Whisper, then speaker detection, only when nothing named the speakers."""
        from dubmate import builder_api
        calls = []
        names = ("extract_audio_from_video", "separate_audio_stems", "transcribe_audio",
                 "add_nonverbal_segments", "detect_speaker_turns", "assign_speakers_to_segments")
        originals = {n: getattr(pack_builder, n) for n in names}
        state = {"used_fallback": False, "turns": [(0.5, 2.5, 7), (4.8, 6.0, 3)], "notice": ""}
        statuses = []
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

        def fake_detect(vocals_wav, on_progress=None, cancel=None):
            calls.append(("detect", vocals_wav))
            on_progress(0.88, "Downloading speaker detection (about 35 MB, first time only)")
            statuses.append((progress_ref[0].status, progress_ref[0].message))
            on_progress(0.94, "")
            statuses.append((progress_ref[0].status, progress_ref[0].message))
            return state["turns"], state["notice"]

        def fake_assign(segments, turns=None):
            calls.append(("assign", any(s.get("nonverbal") for s in segments), turns))
            return originals["assign_speakers_to_segments"](segments, turns)

        session_id = "test_pipeline_order"
        try:
            pack_builder.extract_audio_from_video = fake_extract
            pack_builder.separate_audio_stems = fake_separate
            pack_builder.transcribe_audio = fake_transcribe
            pack_builder.add_nonverbal_segments = fake_nonverbal
            pack_builder.detect_speaker_turns = fake_detect
            pack_builder.assign_speakers_to_segments = fake_assign
            progress_ref = [None]

            def run(**extra):
                calls.clear()
                statuses.clear()
                session = {"session_id": session_id, "folder": self.tmp_dir, "duration": 10.0,
                           "progress": pack_builder.BuildProgress(session_id),
                           "video_path": os.path.join(self.tmp_dir, "clip.mp4")}
                session.update(extra)
                progress_ref[0] = session["progress"]
                BUILDER_SESSIONS[session_id] = session
                builder_api._run_builder_pipeline_sync(session_id)
                return session["progress"]

            vocals = os.path.join(self.tmp_dir, "stems", "vocals.wav")
            progress = run()
            self.assertEqual(calls, ["extract", "separate", "transcribe", "nonverbal", ("detect", vocals),
                                     ("assign", True, state["turns"])])
            self.assertEqual(statuses, [
                ("detecting_speakers", "Downloading speaker detection (about 35 MB, first time only)"),
                ("detecting_speakers", "Detecting who speaks"),
            ])
            self.assertEqual(progress.status, "transcribed")
            self.assertEqual(len(progress.segments), 2)
            self.assertTrue(progress.segments[1]["nonverbal"])
            # Turns, not pauses, pick the voice: speaker 7 is first heard, so "Speaker 1".
            self.assertEqual([s["character"] for s in progress.segments], ["Speaker 1", "Speaker 2"])
            self.assertEqual(progress.message, "Found 2 lines, 1 without words")
            self.assertFalse(progress.warning)
            # The editor learns whether there is a voice track to play.
            self.assertIs(progress.to_dict()["voices_separated"], True)

            # A speaker notice follows the separation notice, one space apart.
            state["used_fallback"] = True
            state["turns"], state["notice"] = None, "Speaker detection couldn't run."
            progress = run()
            self.assertEqual(calls, ["extract", "separate", "transcribe", ("detect", vocals), ("assign", False, None)])
            self.assertEqual(progress.status, "transcribed")
            self.assertEqual(progress.message, "Found 1 line")
            self.assertEqual(progress.warning, "basic filter Speaker detection couldn't run.")
            self.assertIs(progress.to_dict()["voices_separated"], False)

            state["used_fallback"] = False
            progress = run()
            self.assertEqual(progress.warning, "Speaker detection couldn't run.")

            # Named subtitles: no detection, so no download.
            progress = run(subtitle_segments=[{"start": 1.0, "end": 2.0, "text": "Hi", "character": "Levi"}])
            self.assertEqual(calls, ["extract", "separate", ("assign", False, None)])
            self.assertEqual(statuses, [])
            self.assertEqual(progress.status, "transcribed")
            self.assertFalse(progress.warning)
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
            messages = []
            turns, notice = pack_builder.detect_speaker_turns(os.path.join(self.tmp_dir, "vocals.wav"),
                                                              lambda f, m: messages.append(m))
            self.assertIsNone(turns)
            self.assertEqual(notice, pack_builder.SPEAKER_NOTICE_NO_DOWNLOAD)
            self.assertEqual(messages, ["Downloading speaker detection (about 35 MB, first time only)"])
        finally:
            for p in reversed(patches):
                p.stop()

    def test_21_speaker_detection_not_installed_on_source(self):
        """A source install without the package gets the update-script notice and never runs pip."""
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
                                     "To add it, run update.bat (Windows) or update.sh (macOS and Linux), "
                                     "then restart DubMate.")
            self.assertEqual(runs, [])
        finally:
            for p in reversed(patches):
                p.stop()

    def test_22_speaker_detection_in_addon(self):
        """
        A desktop add-on without the package gets the reinstall notice and the engine never
        installs anything; with the package, models live in the add-on folder.
        """
        import sys
        from unittest import mock
        addon = os.path.join(self.tmp_dir, "ai-packages")
        os.makedirs(addon)
        with open(os.path.join(addon, ".install-complete"), "w") as f:
            f.write("ok")
        os.makedirs(os.path.join(self.tmp_dir, "not-it", "ai-packages"))  # no marker: ignored

        runs = []
        patches, _fake, _script = self._speaker_env(addon=addon)
        try:
            patches.append(mock.patch.object(pack_builder.subprocess, "run", lambda *a, **k: runs.append(a)))
            patches.append(mock.patch.object(pack_builder.subprocess, "Popen", lambda *a, **k: runs.append(a)))
            for p in patches[-2:]:
                p.start()
            sys.path.insert(1, os.path.join(self.tmp_dir, "not-it", "ai-packages"))
            self.assertEqual(pack_builder._addon_dir(), addon)
            self.assertFalse(hasattr(pack_builder, "_install_speaker_package"))
            self.assertEqual(pack_builder._speaker_models_dir(), os.path.join(addon, "dubmate-models", "speakers"))

            sys.modules["sherpa_onnx"] = None  # import fails; restored by the slot patch
            turns, notice = pack_builder.detect_speaker_turns(os.path.join(self.tmp_dir, "vocals.wav"))
            self.assertIsNone(turns)
            self.assertEqual(notice, "Speaker detection isn't installed, so speakers were guessed from pauses. "
                                     "To add it, remove Pack Builder in Audio settings, then run the DubMate "
                                     "installer again and tick Pack Builder.")
            self.assertEqual(runs, [])
        finally:
            for p in reversed(patches):
                p.stop()

    def test_23_speaker_child_entry_point(self):
        """The child builds the pinned config, prints progress and then the turns as JSON on stdout."""
        import contextlib
        import json
        import sys
        patches, fake, script = self._speaker_env()
        try:
            folder = self._touch_speaker_models()
            script["segments"] = [(3.0, 4.0, 1), (0.5, 2.0, 0)]
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = pack_builder._speaker_turns_child(os.path.join(self.tmp_dir, "vocals.wav"), folder)
            self.assertEqual(code, 0)
            lines = out.getvalue().splitlines()
            self.assertEqual(lines[:2], ["DUBMATE_SPEAKER_PROGRESS 0.5000", "DUBMATE_SPEAKER_PROGRESS 1.0000"])
            self.assertTrue(lines[-1].startswith("DUBMATE_SPEAKER_TURNS "))
            self.assertEqual(json.loads(lines[-1][len("DUBMATE_SPEAKER_TURNS "):]), [[0.5, 2.0, 0], [3.0, 4.0, 1]])

            config = script["config"]
            self.assertEqual(config.segmentation.pyannote.window_shift_ratio, 0.1)
            self.assertEqual(config.segmentation.pyannote.model, os.path.join(folder, "pyannote-segmentation-3-0.onnx"))
            self.assertEqual(config.embedding.model, os.path.join(folder, "campplus-sv-zh-en-16k-common-advanced.onnx"))
            self.assertEqual(config.clustering.num_clusters, -1)
            self.assertEqual(config.clustering.threshold, 0.5)
            self.assertEqual((config.min_duration_on, config.min_duration_off), (0.3, 0.5))
            self.assertEqual(str(script["samples"].dtype), "float32")
            self.assertEqual(script["callbacks"], [0, 0])

            # No package in the child: its own exit code, so the parent can say how to add it.
            sys.modules["sherpa_onnx"] = None
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(pack_builder._speaker_turns_child("x.wav", folder), 3)
            sys.modules["sherpa_onnx"] = fake

            # Any other failure raises, so the child process exits non-zero.
            script["raise"] = RuntimeError("boom")
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                pack_builder._speaker_turns_child("x.wav", folder)
        finally:
            for p in reversed(patches):
                p.stop()

    def test_23b_speaker_child_process_outcomes(self):
        """Success, crash, timeout, bad JSON, no voices and a missing package, with Popen stubbed."""
        import json
        import sys
        import threading
        from unittest import mock

        class _Out:
            def __init__(self, lines, hang):
                self.lines, self.hang, self.closed = lines, hang, False

            def __iter__(self):
                for line in self.lines:
                    yield line + "\n"
                if self.hang:
                    self.hang.wait(5)  # until killed

            def close(self):
                self.closed = True

        class _Proc:
            def __init__(self, lines, code, hang=False):
                self.killed = threading.Event()
                self.stdout = _Out(lines, self.killed if hang else None)
                self.code, self.returncode = code, None

            def wait(self):
                self.returncode = -9 if self.killed.is_set() else self.code
                return self.returncode

            def poll(self):
                return self.returncode

            def kill(self):
                self.killed.set()

        patches, _fake, _script = self._speaker_env()
        calls = []
        plan = {}

        def fake_popen(cmd, **kwargs):
            calls.append((cmd, kwargs))
            if plan.get("raise"):
                raise OSError("no python")
            plan["proc"] = _Proc(plan["lines"], plan["code"], plan.get("hang", False))
            return plan["proc"]

        def run(lines, code, **extra):
            plan.clear()
            plan.update(lines=lines, code=code, **extra)
            progress = []
            result = pack_builder.detect_speaker_turns(wav, lambda f, m: progress.append((round(f, 4), m)))
            return result, progress

        try:
            patches.append(mock.patch.object(pack_builder.subprocess, "Popen", fake_popen))
            patches[-1].start()
            folder = self._touch_speaker_models()
            wav = os.path.join(self.tmp_dir, "vocals.wav")
            turns_line = "DUBMATE_SPEAKER_TURNS " + json.dumps([[3.0, 4.0, 1], [0.5, 2.0, 0]])

            # Success: progress maps to 0.90-0.98, other lines are ignored, turns come back sorted.
            (turns, notice), progress = run(["onnxruntime log line", "DUBMATE_SPEAKER_PROGRESS 0.5",
                                             "DUBMATE_SPEAKER_PROGRESS 1.0", turns_line], 0)
            self.assertEqual((turns, notice), ([(0.5, 2.0, 0), (3.0, 4.0, 1)], ""))
            self.assertEqual(progress, [(0.9, ""), (0.94, ""), (0.98, "")])
            self.assertTrue(plan["proc"].stdout.closed)
            cmd, kwargs = calls[-1]
            self.assertEqual(cmd[:2], [sys.executable, "-c"])
            self.assertIn("import pack_builder", cmd[2])
            self.assertEqual(cmd[4:], [wav, folder])
            child_path = json.loads(cmd[3])
            self.assertEqual(child_path[0], pack_builder.BASE_DIR)
            for p in sys.path:  # the engine's own path, add-on folder included, in order
                self.assertIn(os.path.abspath(p) if p else os.getcwd(), child_path)
            self.assertEqual(kwargs["stderr"], pack_builder.subprocess.STDOUT)
            self.assertEqual(kwargs["stdin"], pack_builder.subprocess.DEVNULL)
            self.assertNotIn("env", kwargs)  # PYTHONPATH and the rest are inherited

            # A crash (an OpenMP abort is SIGABRT) falls back, even after a partial turns line.
            (turns, notice), _ = run(["OMP: Error #15", turns_line], -6)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))
            (turns, notice), _ = run([], 1)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))

            # Exit 0 without a turns line, or with bad JSON, falls back.
            (turns, notice), _ = run(["DUBMATE_SPEAKER_PROGRESS 1.0"], 0)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))
            (turns, notice), _ = run(["DUBMATE_SPEAKER_TURNS [[0.5, 2.0"], 0)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))
            (turns, notice), _ = run(['DUBMATE_SPEAKER_TURNS {"a": 1}'], 0)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))
            (turns, notice), _ = run(["DUBMATE_SPEAKER_PROGRESS nan-ish", turns_line], 0)
            self.assertEqual(notice, "")  # a garbled progress line is skipped

            # No voices found.
            (turns, notice), _ = run(["DUBMATE_SPEAKER_TURNS []"], 0)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_NO_VOICES))

            # The child couldn't import the package (exit 3): the install notice.
            (turns, notice), _ = run(["DLL load failed"], 3)
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_NOT_INSTALLED_SOURCE))

            # A child that never finishes is killed at the timeout.
            with mock.patch.object(pack_builder, "SPEAKER_TIMEOUT_S", 0.2):
                (turns, notice), _ = run(["DUBMATE_SPEAKER_PROGRESS 0.1"], 0, hang=True)
            self.assertTrue(plan["proc"].killed.is_set())
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))

            # Cancelling processing stops a running child at once.
            cancel = threading.Event()
            threading.Timer(0.1, cancel.set).start()
            plan.clear()
            plan.update(lines=["DUBMATE_SPEAKER_PROGRESS 0.1"], code=0, hang=True)
            with self.assertRaises(pack_builder.BuildCancelled):
                pack_builder.detect_speaker_turns(wav, cancel=cancel)
            self.assertTrue(plan["proc"].killed.is_set())

            # The child can't even start.
            (turns, notice), _ = run([], 0, **{"raise": True})
            self.assertEqual((turns, notice), (None, pack_builder.SPEAKER_NOTICE_FAILED))
        finally:
            for p in reversed(patches):
                p.stop()

    def test_23c_speaker_child_real_process(self):
        """A real child process finds a package that only the engine's sys.path knows about."""
        import sys
        import textwrap
        from unittest import mock
        fake_dir = os.path.join(self.tmp_dir, "only-on-engine-path")
        os.makedirs(fake_dir)
        with open(os.path.join(fake_dir, "sherpa_onnx.py"), "w", encoding="utf-8") as f:
            f.write(textwrap.dedent("""
                import types

                class _Config:
                    def __init__(self, **kwargs):
                        self.__dict__.update(kwargs)

                    def validate(self):
                        return True

                OfflineSpeakerDiarizationConfig = OfflineSpeakerSegmentationModelConfig = _Config
                OfflineSpeakerSegmentationPyannoteModelConfig = SpeakerEmbeddingExtractorConfig = _Config
                FastClusteringConfig = _Config

                class _Result:
                    def __init__(self, n):
                        self.n = n

                    def sort_by_start_time(self):
                        half = self.n / 16000 / 2
                        return [types.SimpleNamespace(start=0.0, end=half, speaker=4),
                                types.SimpleNamespace(start=half, end=2 * half, speaker=9)]

                class OfflineSpeakerDiarization:
                    sample_rate = 16000

                    def __init__(self, config):
                        pass

                    def process(self, samples, callback=None):
                        callback(1, 1)
                        return _Result(len(samples))
            """))
        wav = os.path.join(self.tmp_dir, "vocals.wav")
        pack_builder.audio_processor.write_wav_mono(wav, __import__("numpy").zeros(32000, dtype="float32"), sr=16000)
        folder = os.path.join(self.tmp_dir, "models")
        os.makedirs(folder)
        progress = []
        with mock.patch.object(sys, "path", [fake_dir] + sys.path), \
                mock.patch.object(pack_builder, "_speaker_package_present", lambda: True):
            turns, notice = pack_builder._run_speaker_child(wav, folder, lambda f, m: progress.append(f))
        self.assertEqual((turns, notice), ([(0.0, 1.0, 4), (1.0, 2.0, 9)], ""))
        self.assertAlmostEqual(progress[-1], 0.98)
        # Only the child loaded it; this process never did.
        self.assertFalse(any((getattr(m, "__file__", None) or "").startswith(fake_dir) for m in list(sys.modules.values())))

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


SRT_THREE = ("1\n00:00:01,000 --> 00:00:02,000\n[Levi] Move.\n\n"
             "2\n00:00:02,500 --> 00:00:03,500\n[Kenny] Not yet.\n\n"
             "3\n00:00:04,000 --> 00:00:05,000\nSomeone shouts.\n")


class TestBuilderCapabilitiesAndRuns(unittest.TestCase):
    """What is installed, subtitles, retries, cancel, skipped stages and session expiry."""

    def setUp(self):
        from dubmate import builder_api
        self.api = builder_api
        self.tmp_dir = tempfile.mkdtemp(prefix="dubmate_test_builder_runs_")
        self.session_ids = []
        builder_api._GPU_STATE.update(value=None, started=False)

    def tearDown(self):
        for sid in self.session_ids:
            BUILDER_SESSIONS.pop(sid, None)
        self.api._GPU_STATE.update(value=None, started=False)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _session(self, sid, **extra):
        folder = os.path.join(self.tmp_dir, sid)
        os.makedirs(folder, exist_ok=True)
        session = {"session_id": sid, "folder": folder, "duration": 10.0,
                   "progress": pack_builder.BuildProgress(sid),
                   "video_path": os.path.join(folder, "clip.mp4"), "created_at": time.time(),
                   "vocals_path": None, "backing_path": None, "full_audio_path": None}
        session.update(extra)
        BUILDER_SESSIONS[sid] = session
        self.session_ids.append(sid)
        return session

    def _fake_pipeline(self, calls, transcribe=None, gate=None):
        """Patches the slow stages. Separation writes real files, so a retry can reuse them."""
        from unittest import mock

        def extract(video, out):
            calls.append("extract")
            if gate is not None:
                gate.wait(30)
            with open(out, "wb") as f:
                f.write(b"RIFF")
            return out

        def separate(wav, out_dir):
            calls.append("separate")
            os.makedirs(out_dir, exist_ok=True)
            paths = {k: os.path.join(out_dir, f"{k}.wav") for k in ("vocals", "backing")}
            for p in paths.values():
                with open(p, "wb") as f:
                    f.write(b"RIFF")
            return dict(paths, used_fallback=False)

        def fake_transcribe(wav, **kwargs):
            calls.append("transcribe")
            if transcribe:
                return transcribe()
            return [{"start": 1.0, "end": 2.0, "text": "Hi", "character": "Actor"}]

        def detect(vocals_wav, on_progress=None, **kwargs):
            calls.append("detect")
            return None, ""

        patches = [
            mock.patch.object(pack_builder, "extract_audio_from_video", extract),
            mock.patch.object(pack_builder, "separate_audio_stems", separate),
            mock.patch.object(pack_builder, "transcribe_audio", fake_transcribe),
            mock.patch.object(pack_builder, "add_nonverbal_segments", lambda segs, *a: segs),
            mock.patch.object(pack_builder, "detect_speaker_turns", detect),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _wait_for(self, client, sid, statuses, timeout=30.0):
        deadline = time.time() + timeout
        state = None
        while time.time() < deadline:
            state = client.get(f"/api/builder/{sid}/status").json()
            if state["status"] in statuses:
                return state
            time.sleep(0.02)
        self.fail(f"status never reached {statuses}: {state}")

    def test_25_capabilities_follow_find_spec(self):
        """Each flag is an installed module; torch is never imported when it is missing."""
        from unittest import mock
        present = set()
        detect_calls = []

        def find_spec(name, *args, **kwargs):
            return object() if name in present else None

        def detect():
            detect_calls.append(1)
            return True, True, "cuda"

        with mock.patch.object(self.api.importlib.util, "find_spec", find_spec), \
                mock.patch.object(pack_builder, "detect_torch_and_cuda", detect):
            client = TestClient(app)
            present.update({"whisper", "yt_dlp", "pykakasi"})
            caps = client.get("/api/builder/capabilities").json()
            self.assertEqual(caps, {"separation": False, "transcription": True, "link_import": True,
                                    "speakers": False, "romaji": True, "gpu": False})
            self.assertEqual(detect_calls, [], "torch is missing, so the GPU probe never imports it")

            present.clear()
            present.update({"torch", "demucs", "sherpa_onnx"})
            caps = client.get("/api/builder/capabilities").json()
            self.assertEqual({k: caps[k] for k in ("separation", "transcription", "link_import", "speakers", "romaji")},
                             {"separation": True, "transcription": False, "link_import": False,
                              "speakers": True, "romaji": False})
            # demucs alone isn't separation without torch.
            present.discard("torch")
            self.assertFalse(client.get("/api/builder/capabilities").json()["separation"])

    def test_26_capabilities_gpu_from_null_to_bool(self):
        """The GPU probe runs once in the background: null until it is known, then cached."""
        import threading
        from unittest import mock
        release = threading.Event()
        detect_calls = []

        def detect():
            detect_calls.append(1)
            release.wait(5)
            return True, True, "cuda"

        with mock.patch.object(self.api.importlib.util, "find_spec", lambda name, *a, **k: object()), \
                mock.patch.object(pack_builder, "detect_torch_and_cuda", detect):
            client = TestClient(app)
            self.assertIsNone(client.get("/api/builder/capabilities").json()["gpu"])
            self.assertIsNone(client.get("/api/builder/capabilities").json()["gpu"])
            release.set()
            deadline = time.time() + 3
            gpu = None
            while gpu is None and time.time() < deadline:
                gpu = client.get("/api/builder/capabilities").json()["gpu"]
                time.sleep(0.02)
            self.assertIs(gpu, True)
            self.assertEqual(len(detect_calls), 1, "the probe runs once per process")

    def test_27_subtitles_check(self):
        """A dropped file is checked without a session: its lines and named speakers, or a clear 400."""
        client = TestClient(app)
        res = client.post("/api/builder/subtitles/check",
                          files={"file": ("scene.srt", io.BytesIO(SRT_THREE.encode("utf-8")), "text/plain")})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"count": 3, "characters": ["Actor", "Kenny", "Levi"]})

        vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n"
        res = client.post("/api/builder/subtitles/check", files={"file": ("a.vtt", io.BytesIO(vtt.encode()), "text/vtt")})
        self.assertEqual(res.json(), {"count": 1, "characters": ["Actor"]})

        res = client.post("/api/builder/subtitles/check",
                          files={"file": ("notes.srt", io.BytesIO(b"just some text"), "text/plain")})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "No timed lines in this file. Use an SRT or VTT file.")

    def test_28_subtitles_live_in_the_session(self):
        """Imported subtitles skip transcription; DELETE clears them and the next run transcribes."""
        calls = []
        self._fake_pipeline(calls)
        sid = "t28"
        session = self._session(sid)
        client = TestClient(app)
        res = client.post(f"/api/builder/{sid}/import_subtitles",
                          files={"file": ("scene.srt", io.BytesIO(SRT_THREE.encode("utf-8")), "text/plain")})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(session["subtitle_segments"]), 3)

        self.api._run_builder_pipeline_sync(sid)
        progress = session["progress"]
        self.assertEqual(progress.status, "transcribed")
        self.assertNotIn("transcribe", calls)
        self.assertNotIn("detect", calls, "the subtitles named the speakers")
        self.assertEqual(progress.to_dict()["skipped"], ["transcription", "speakers"])
        self.assertEqual([s["character"] for s in session["subtitle_segments"]], ["Levi", "Kenny", "Actor"],
                         "the run doesn't change the stored subtitles")

        res = client.delete(f"/api/builder/{sid}/subtitles")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(session["subtitle_segments"], [])
        # The last run's lines are in progress.segments; they are not subtitles.
        self.assertTrue(progress.segments)
        calls.clear()
        self.api._run_builder_pipeline_sync(sid)
        self.assertIn("transcribe", calls)
        self.assertEqual(progress.to_dict()["skipped"], [])
        self.assertEqual(client.delete("/api/builder/nope/subtitles").status_code, 404)

    def test_29_process_without_transcription(self):
        """transcribe:false finishes with no lines: no transcription, no speaker detection, no placeholder."""
        calls = []
        self._fake_pipeline(calls)
        session = self._session("t29")
        self.api._run_builder_pipeline_sync("t29", None, "base", {"transcribe": False})
        progress = session["progress"]
        self.assertEqual(progress.status, "transcribed")
        self.assertEqual(progress.segments, [])
        self.assertEqual(calls, ["extract", "separate"])
        self.assertEqual(progress.to_dict()["skipped"], ["transcription", "speakers"])

    def test_29b_no_lines_heard_no_placeholder(self):
        """Transcription hearing nothing doesn't invent a "Dialogue line 1"."""
        calls = []
        self._fake_pipeline(calls, transcribe=lambda: [])
        session = self._session("t29b")
        self.api._run_builder_pipeline_sync("t29b")
        self.assertEqual(session["progress"].status, "transcribed")
        self.assertEqual(session["progress"].segments, [])
        self.assertEqual(session["progress"].to_dict()["skipped"], ["speakers"])

    def test_30_retry_reuses_audio_and_separation(self):
        """A failed transcription keeps its stage; the retry skips reading the audio and separating."""
        calls = []
        failing = {"on": True}

        def transcribe():
            if failing["on"]:
                raise RuntimeError("Couldn't write out the lines.")
            return [{"start": 1.0, "end": 2.0, "text": "Hi", "character": "Actor"}]

        self._fake_pipeline(calls, transcribe=transcribe)
        session = self._session("t30")
        self.api._run_builder_pipeline_sync("t30")
        state = session["progress"].to_dict()
        self.assertEqual((state["status"], state["stage"], state["error"]),
                         ("error", "transcription", "Couldn't write out the lines."))
        self.assertEqual(calls, ["extract", "separate", "transcribe"])

        failing["on"] = False
        calls.clear()
        self.api._run_builder_pipeline_sync("t30")
        state = session["progress"].to_dict()
        self.assertEqual(state["status"], "transcribed")
        self.assertEqual(calls, ["transcribe", "detect"])
        self.assertIsNone(state["error"])
        self.assertIsNone(state["error_code"])
        self.assertIs(state["voices_separated"], True)

    def test_31_cancel_and_the_run_lock(self):
        """Cancel stops at the next stage boundary; a new run waits for the last one to exit."""
        import threading
        calls = []
        gate = threading.Event()
        self._fake_pipeline(calls, gate=gate)
        sid = "t31"
        session = self._session(sid)
        with TestClient(app) as client:
            self.assertEqual(client.post(f"/api/builder/{sid}/process", json={}).status_code, 200)
            self._wait_for(client, sid, {"extracting_audio"})
            self.assertEqual(client.post(f"/api/builder/{sid}/cancel").status_code, 200)
            gate.set()
            state = self._wait_for(client, sid, {"cancelled", "transcribed", "error"})
            self.assertEqual(state["status"], "cancelled")
            self.assertEqual(calls, ["extract"], "nothing runs after the cancel")

            # Cancel, then process again while the cancelled run is still in its stage.
            gate.clear()
            calls.clear()
            os.remove(session["full_audio_path"])
            client.post(f"/api/builder/{sid}/process", json={})
            self._wait_for(client, sid, {"extracting_audio"})
            client.post(f"/api/builder/{sid}/cancel")
            client.post(f"/api/builder/{sid}/process", json={})
            time.sleep(0.2)
            state = client.get(f"/api/builder/{sid}/status").json()
            self.assertEqual((state["status"], state["message"]), ("queued", "Finishing the last run"))
            gate.set()
            state = self._wait_for(client, sid, {"transcribed", "error"})
            self.assertEqual(state["status"], "transcribed")
            self.assertEqual(calls, ["extract", "extract", "separate", "transcribe", "detect"])
            self.assertEqual(client.post("/api/builder/nope/cancel").status_code, 404)

    def test_32_error_keeps_the_failed_stage(self):
        """Separation failing reports stage stem_separation, not a reset stage."""
        from unittest import mock
        calls = []
        self._fake_pipeline(calls)

        def broken(wav, out_dir):
            raise RuntimeError("Couldn't separate the voices.")

        session = self._session("t32")
        with mock.patch.object(pack_builder, "separate_audio_stems", broken):
            self.api._run_builder_pipeline_sync("t32")
        state = session["progress"].to_dict()
        self.assertEqual((state["status"], state["stage"]), ("error", "stem_separation"))
        self.assertEqual(state["error_code"], "processing_failed")

    def test_33_sessions_expire_after_last_activity(self):
        """Pruning uses touched_at (set by session routes), and never removes a running pipeline."""
        import threading
        now = time.time()
        old = now - 3 * 3600
        idle = self._session("t33_idle", created_at=old, touched_at=old)
        active = self._session("t33_active", created_at=old, touched_at=old)
        running = self._session("t33_running", created_at=old, touched_at=old, run_lock=threading.Lock())
        client = TestClient(app)
        client.get("/api/builder/t33_active/status")
        self.assertGreaterEqual(active["touched_at"], now)
        running["run_lock"].acquire()
        try:
            self.api.prune_old_builder_sessions()
        finally:
            running["run_lock"].release()
        self.assertNotIn("t33_idle", BUILDER_SESSIONS)
        self.assertFalse(os.path.isdir(idle["folder"]))
        self.assertIn("t33_active", BUILDER_SESSIONS)
        self.assertIn("t33_running", BUILDER_SESSIONS)


    def test_34_replaced_run_never_overwrites_the_queued_one(self):
        """A cancelled run that then fails (not by the cancel) leaves a newer queued run's status alone."""
        import threading
        calls = []
        self._fake_pipeline(calls)
        session = self._session("t34")
        progress = session["progress"]

        def extract_then_break(video, out):
            # Cancel, then a newer /process arrives while this stage still runs; then it fails.
            progress.cancel_requested.set()
            progress.cancel_requested = threading.Event()
            progress.update("queued", 0.0, "Finishing the last run")
            raise RuntimeError("ffmpeg crashed.")

        from unittest import mock
        with mock.patch.object(pack_builder, "extract_audio_from_video", extract_then_break):
            self.api._run_builder_pipeline_sync("t34")
        state = progress.to_dict()
        self.assertEqual((state["status"], state["message"]), ("queued", "Finishing the last run"))
        self.assertIsNone(state["error"])

    def test_35_basic_filter_stage_says_so(self):
        """Without voice separation installed, the stage message names the backing track, not separation."""
        calls = []
        self._fake_pipeline(calls)
        session = self._session("t35")
        seen = []
        real_installed = self.api._installed
        from unittest import mock

        def separate(wav, out_dir):
            seen.append(session["progress"].message)
            os.makedirs(out_dir, exist_ok=True)
            paths = {k: os.path.join(out_dir, f"{k}.wav") for k in ("vocals", "backing")}
            for p in paths.values():
                with open(p, "wb") as f:
                    f.write(b"RIFF")
            return dict(paths, used_fallback=True, fallback_notice="Voice separation isn't installed, so a basic filter was used.")

        with mock.patch.object(pack_builder, "separate_audio_stems", separate), \
                mock.patch.object(self.api, "_installed", lambda name: False if name == "demucs" else real_installed(name)):
            self.api._run_builder_pipeline_sync("t35")
        self.assertEqual(seen, ["Making the backing track"])
        self.assertIs(session["progress"].voices_separated, False)

    def test_36_subtitles_wait_for_the_run(self):
        """Importing subtitles keeps the edited lines (a cancelled Process again loses nothing); /status counts them."""
        sid = "t36"
        session = self._session(sid)
        progress = session["progress"]
        edited = [{"start": 1.0, "end": 2.0, "text": "My edit", "character": "Levi"}]
        progress.segments = [dict(s) for s in edited]
        client = TestClient(app)
        self.assertEqual(client.get(f"/api/builder/{sid}/status").json()["subtitles_count"], 0)
        res = client.post(f"/api/builder/{sid}/import_subtitles",
                          files={"file": ("scene.srt", io.BytesIO(SRT_THREE.encode("utf-8")), "text/plain")})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["count"], 3)
        self.assertEqual(progress.segments, edited, "the lines being edited stay until a run replaces them")
        self.assertEqual(client.get(f"/api/builder/{sid}/status").json()["subtitles_count"], 3)
        client.delete(f"/api/builder/{sid}/subtitles")
        self.assertEqual(client.get(f"/api/builder/{sid}/status").json()["subtitles_count"], 0)

    def test_37_build_again_under_a_new_title_replaces_the_pack(self):
        """Build again after a title change rebuilds the same pack (same id and folder) with the new title."""
        sid = "t37"
        session = self._session(sid)
        video = os.path.join(session["folder"], "clip.mp4")
        create_dummy_mp4(video, duration_sec=4.0)
        vocals = os.path.join(session["folder"], "vocals.wav")
        create_dummy_wav(vocals, duration_sec=4.0)
        session.update(video_path=video, vocals_path=vocals, full_audio_path=vocals, backing_path=vocals)
        client = TestClient(app)
        lines = [{"start": 0.5, "end": 1.8, "text": "Believe it!", "character": "Naruto"}]
        folders = []
        try:
            first = client.post(f"/api/builder/{sid}/compile", json={"pack_name": "Rename Test Pack", "segments": lines})
            self.assertEqual(first.status_code, 200)
            folders.append(os.path.join(pack_loader.PACKS_DIRS[0], first.json()["pack_id"]))
            folders.append(os.path.join(pack_loader.PACKS_DIRS[0], "Rename Test Pack 2"))
            again = client.post(f"/api/builder/{sid}/compile", json={"pack_name": "Rename Test Pack 2", "segments": lines})
            self.assertEqual(again.status_code, 200)
            self.assertEqual(again.json()["pack_id"], first.json()["pack_id"], "Build again keeps the pack's id")
            self.assertFalse(os.path.isdir(folders[1]), "no second pack is made")
            with open(os.path.join(folders[0], "pack.json"), encoding="utf-8") as f:
                self.assertEqual(json.load(f)["title"], "Rename Test Pack 2")
        finally:
            for folder in folders:
                shutil.rmtree(folder, ignore_errors=True)

    # --- Build again and data safety: a build never harms a pack that isn't its own ---

    def _packs_dir(self):
        """Points the packs folder at a temp folder for this test; returns it."""
        from unittest import mock
        packs = os.path.join(self.tmp_dir, "Packs")
        os.makedirs(packs, exist_ok=True)
        p = mock.patch.object(pack_loader, "PACKS_DIRS", [packs])
        p.start()
        self.addCleanup(p.stop)
        return packs

    def _other_pack(self, packs, name):
        """A different pack already in the library, with a file no build would write."""
        folder = os.path.join(packs, name)
        os.makedirs(folder)
        files = {"pack.json": '{"title": "Theirs"}', "theirs.txt": "keep me",
                 "dub_video.mp4": "their video", "01.00.wav": "their line"}
        for fname, body in files.items():
            with open(os.path.join(folder, fname), "w", encoding="utf-8") as f:
                f.write(body)
        return folder, files

    def _assert_untouched(self, folder, files):
        self.assertEqual(sorted(os.listdir(folder)), sorted(files))
        for fname, body in files.items():
            with open(os.path.join(folder, fname), encoding="utf-8") as f:
                self.assertEqual(f.read(), body, fname)

    def _assemble_args(self, title):
        src = os.path.join(self.tmp_dir, "src")
        os.makedirs(src, exist_ok=True)
        wav = os.path.join(src, "line.wav")
        if not os.path.isfile(wav):
            create_dummy_wav(wav, duration_sec=1.0)
        line = {"filename": "00.50.wav", "file_path": wav, "start": 0.5, "end": 1.0,
                "character": "Levi", "caption": "Mine"}
        return dict(pack_name=title, video_source_path=os.path.join(src, "missing.mp4"),
                    backing_source_path=wav, line_slices=[line])

    def _compile_session(self, sid, **extra):
        session = self._session(sid, **extra)
        vocals = os.path.join(session["folder"], "vocals.wav")
        create_dummy_wav(vocals, duration_sec=3.0)
        session.update(vocals_path=vocals, full_audio_path=vocals, backing_path=vocals)
        return session

    def _no_leftovers(self, packs):
        self.assertEqual([n for n in os.listdir(packs) if n.startswith(".")], [], "no staging folders stay behind")

    def _files(self, folder):
        out = {}
        for name in os.listdir(folder):
            with open(os.path.join(folder, name), "rb") as f:
                out[name] = f.read()
        return out

    LINES = [{"start": 0.5, "end": 1.5, "text": "Mine", "character": "Levi"}]

    def test_38_new_pack_never_replaces_a_pack_with_the_same_name(self):
        """A first build whose title matches another pack's folder gets its own folder; the other pack is untouched."""
        packs = self._packs_dir()
        theirs, files = self._other_pack(packs, "Levi vs Beast Titan")
        folder = pack_builder.assemble_pack(**self._assemble_args("Levi vs Beast Titan"))
        self.assertEqual(os.path.basename(folder), "Levi vs Beast Titan 2")
        self._assert_untouched(theirs, files)
        with open(os.path.join(folder, "pack.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["title"], "Levi vs Beast Titan")
        # Names differing only by case are one folder on Windows: never shared either.
        folder3 = pack_builder.assemble_pack(**self._assemble_args("levi vs beast titan"))
        self.assertEqual(os.path.basename(folder3), "levi vs beast titan 3")
        self._assert_untouched(theirs, files)
        self._no_leftovers(packs)

    def test_39_build_again_with_another_packs_title_keeps_both(self):
        """Build again renamed to another pack's title rebuilds this session's pack (same id); the other pack is untouched."""
        packs = self._packs_dir()
        theirs, files = self._other_pack(packs, "Their Pack")
        sid = "t39"
        self._compile_session(sid)
        client = TestClient(app)
        first = client.post(f"/api/builder/{sid}/compile", json={"pack_name": "My Pack", "segments": self.LINES})
        self.assertEqual(first.status_code, 200)
        again = client.post(f"/api/builder/{sid}/compile", json={"pack_name": "Their Pack", "segments": self.LINES})
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["pack_id"], first.json()["pack_id"], "the pack keeps its id")
        self.assertEqual(sorted(os.listdir(packs)), ["My Pack", "Their Pack"])
        self._assert_untouched(theirs, files)
        with open(os.path.join(packs, "My Pack", "pack.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["title"], "Their Pack")

    def test_40_build_failing_midway_keeps_the_built_pack(self):
        """A rebuild that fails while writing, or can't move the old pack (open files on Windows), leaves the pack as it was."""
        from unittest import mock
        packs = self._packs_dir()
        folder = pack_builder.assemble_pack(**self._assemble_args("Kept Pack"))
        before = self._files(folder)

        def still_same():
            self.assertEqual(self._files(folder), before)
            self._no_leftovers(packs)

        args = dict(self._assemble_args("Kept Pack, renamed"), folder_name="Kept Pack")
        with mock.patch.object(pack_loader, "write_caption_files", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                pack_builder.assemble_pack(**args)
        still_same()

        real_rename = os.rename

        def locked(src, dst):
            if os.path.normcase(os.path.abspath(src)) == os.path.normcase(os.path.abspath(folder)):
                raise PermissionError(32, "The process cannot access the file")
            return real_rename(src, dst)

        with mock.patch.object(pack_builder.os, "rename", locked), mock.patch.object(pack_builder.time, "sleep"):
            with self.assertRaises(RuntimeError) as ctx:
                pack_builder.assemble_pack(**args)
        self.assertEqual(str(ctx.exception), pack_builder.PACK_IN_USE_MESSAGE)
        still_same()

        # The new build can't be moved in after the old one moved aside: the old one goes back.
        def stuck(src, dst):
            if os.path.basename(src).startswith(".building-"):
                raise PermissionError(5, "Access is denied")
            return real_rename(src, dst)

        with mock.patch.object(pack_builder.os, "rename", stuck), mock.patch.object(pack_builder.time, "sleep"):
            with self.assertRaises(PermissionError):
                pack_builder.assemble_pack(**args)
        still_same()

        # Through the API the failure reaches the Build step as an error, and the pack stays.
        sid = "t40"
        session = self._compile_session(sid, pack_folder=folder)
        with mock.patch.object(pack_loader, "write_caption_files", side_effect=OSError("disk full")):
            res = TestClient(app).post(f"/api/builder/{sid}/compile", json={"pack_name": "Kept Pack", "segments": self.LINES})
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.json()["detail"], "The pack couldn't be added to your library. Try again.")
        self.assertEqual(session["progress"].status, "error")
        self.assertEqual(session["pack_folder"], folder)
        still_same()

    def test_41_build_again_after_the_packs_folder_changed_makes_a_new_pack(self):
        """After the packs folder changes, Build again doesn't reuse the folder name there (it may be another pack)."""
        from unittest import mock
        old_packs = os.path.join(self.tmp_dir, "OldPacks")
        os.makedirs(old_packs)
        with mock.patch.object(pack_loader, "PACKS_DIRS", [old_packs]):
            mine = pack_builder.assemble_pack(**self._assemble_args("Same Name"))
        packs = self._packs_dir()
        theirs, files = self._other_pack(packs, "Same Name")
        sid = "t41"
        self._compile_session(sid, pack_folder=mine)
        res = TestClient(app).post(f"/api/builder/{sid}/compile", json={"pack_name": "Mine Again", "segments": self.LINES})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["pack_id"], "Mine Again")
        self._assert_untouched(theirs, files)
        self.assertTrue(os.path.isdir(mine), "the pack in the old packs folder stays")

    def _swap_dirs(self):
        """A pack folder and a staged rebuild of it, for _replace_pack_folder."""
        packs = self._packs_dir()
        pack_dir, old_files = self._other_pack(packs, "Swap Pack")
        staging = os.path.join(packs, ".building-test")
        os.makedirs(staging)
        with open(os.path.join(staging, "pack.json"), "w", encoding="utf-8") as f:
            f.write('{"title": "New"}')
        return packs, pack_dir, old_files, staging

    def test_42_pack_left_aside_by_a_crash_comes_back(self):
        """A crash between moving the old pack aside and moving the new one in: the next start, and the next build, put the old pack back."""
        from unittest import mock
        from dubmate import packs_cache
        packs = self._packs_dir()
        folder = pack_builder.assemble_pack(**self._assemble_args("Crash Pack"))
        before = self._files(folder)
        args = dict(self._assemble_args("Crash Pack"), folder_name="Crash Pack")
        real_rename = os.rename

        class Crash(BaseException):
            pass

        def dies_after_moving_aside(src, dst):
            if os.path.basename(dst).startswith(".replaced-"):
                return real_rename(src, dst)
            raise Crash()  # the process is gone: nothing else gets renamed

        def crash():
            with mock.patch.object(pack_builder.os, "rename", dies_after_moving_aside):
                with self.assertRaises(Crash):
                    pack_builder.assemble_pack(**args)
            self.assertFalse(os.path.exists(folder))
            set_aside = [n for n in os.listdir(packs) if n.startswith(".replaced-") and n != os.path.basename(aside)]
            self.assertEqual(len(set_aside), 1)

        # A pack set aside by another build whose new pack is in place is left alone.
        other = os.path.join(packs, "Other Pack")
        os.makedirs(other)
        aside = os.path.join(packs, ".replaced-0a1b2c3d-Other Pack")
        os.makedirs(aside)

        crash()
        saved_cache = packs_cache.PACKS_CACHE
        self.addCleanup(setattr, packs_cache, "PACKS_CACHE", saved_cache)
        packs_cache.refresh_packs()  # engine start
        self.assertEqual(self._files(folder), before)
        self.assertTrue(os.path.isdir(aside), "a set-aside pack whose folder exists is kept")
        self.assertTrue(os.path.isdir(other))

        crash()
        folder_again = pack_builder.assemble_pack(**args)  # the next build puts it back first
        self.assertEqual(folder_again, folder)
        self.assertEqual([n for n in os.listdir(packs) if n.startswith(".")], [os.path.basename(aside)])

    def test_43_failed_rollback_says_where_the_old_pack_is(self):
        """If the new pack can't go in and the old one can't go back, the error names where the old pack is, and nothing is deleted."""
        from unittest import mock
        packs, pack_dir, old_files, staging = self._swap_dirs()
        real_rename = os.rename

        def stuck(src, dst):
            name = os.path.basename(src)
            if name.startswith(".building-") or name.startswith(".replaced-"):
                raise PermissionError(5, "Access is denied")
            return real_rename(src, dst)

        with mock.patch.object(pack_builder.os, "rename", stuck), mock.patch.object(pack_builder.time, "sleep"):
            with self.assertRaises(RuntimeError) as ctx:
                pack_builder._replace_pack_folder(staging, pack_dir)
        aside = [n for n in os.listdir(packs) if n.startswith(".replaced-")]
        self.assertEqual(len(aside), 1)
        aside = os.path.join(packs, aside[0])
        self.assertIn(f"The old pack is safe in {aside}", str(ctx.exception))
        self.assertIsInstance(ctx.exception.__cause__, PermissionError)
        self._assert_untouched(aside, old_files)
        self.assertEqual(os.listdir(staging), ["pack.json"])

    def test_44_interrupt_while_swapping_puts_the_old_pack_back(self):
        """Ctrl+C while the new pack is moved in: the old pack goes back in place."""
        from unittest import mock
        packs, pack_dir, old_files, staging = self._swap_dirs()
        real_rename = os.rename

        def interrupted(src, dst):
            if os.path.basename(src).startswith(".building-"):
                raise KeyboardInterrupt()
            return real_rename(src, dst)

        with mock.patch.object(pack_builder.os, "rename", interrupted):
            with self.assertRaises(KeyboardInterrupt):
                pack_builder._replace_pack_folder(staging, pack_dir)
        self._assert_untouched(pack_dir, old_files)
        self.assertEqual([n for n in os.listdir(packs) if n.startswith(".replaced-")], [])


if __name__ == "__main__":
    unittest.main()
