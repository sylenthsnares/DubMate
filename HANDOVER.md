# Handover — 2026-08-29, DubMate Studio v1.0.8 Pack Builder yt-dlp & Whisper Overhaul

## State
All yt-dlp and Whisper failure modes in Pack Builder have been resolved. YouTube signature decryption restored, subtitles auto-fetched, FFmpeg injected into system PATH for Whisper/Demucs, model loading cached in memory, and anti-hallucination safeguards applied. All test suites pass 100%.

## Done this session
- **yt-dlp Signature Decryption & Extraction**: Removed `'player_skip': ['js', 'configs']` in `pack_builder.py` that caused 403 Forbidden, and enabled automatic YouTube subtitle downloading.
- **Video Detection Safeguards**: Ensured downloaded raw video files strictly match video container formats (`.mp4`, `.webm`, `.mkv`), ignoring thumbnails or metadata `.info.json`.
- **FFmpeg PATH Injection (`pack_builder.py`)**: Automatically prepends `tools/` to `os.environ["PATH"]` so Whisper's internal audio loaders locate FFmpeg on all platforms.
- **Whisper In-Memory Model Cache (`pack_builder.py`)**: Added `get_whisper_model()` singleton cache to eliminate multi-second reload stalls on segment transcription.
- **Anti-Hallucination & Subtitle Preservation**: Configured `condition_on_previous_text=False`, `fp16`, and preserved uploaded SRT/VTT cues during pipeline execution.
- **Release Version Bump**: Bumped to `v1.0.8` across `VERSION`, `tauri.conf.json`, `Cargo.toml`, `package.json`, `main.rs`, and `CHANGELOG.md`.

## Next
1. Push git commits and tag `v1.0.8` to trigger GitHub Actions release pipelines.
2. Verify desktop installer and web bundle artifacts on GitHub Releases.

## Read first
- [`pack_builder.py`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/pack_builder.py)
- [`app.py`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/app.py)
- [`CHANGELOG.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/CHANGELOG.md)


