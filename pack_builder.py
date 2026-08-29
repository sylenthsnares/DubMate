# -*- coding: utf-8 -*-
"""
pack_builder.py
Core processing engine for DubMate Pack Builder.
Handles video intake, audio extraction, Demucs vocal/instrumental separation,
Whisper speech-to-text transcription, SRT/VTT subtitle parsing,
audio line slicing, and DubMate / Choicer Voicer pack folder assembly.
"""

import os
import re
import io
import json
import time
import shutil
import tempfile
import threading
import subprocess
from typing import Dict, List, Optional, Tuple, Any

import pack_loader

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BUILDER_CACHE_DIR = os.path.join(pack_loader.CACHE_DIR, "builder")
try:
    os.makedirs(BUILDER_CACHE_DIR, exist_ok=True)
except Exception:
    pass

# Default character color palette (Warm Analog Studio & Pro DAW palette)
DEFAULT_CHARACTER_COLORS = [
    "#d97706",  # Vintage Amber
    "#cca458",  # Walnut Gold
    "#dc2626",  # Pilot Red
    "#16a34a",  # Studio Olive
    "#b45309",  # Terracotta Bronze
    "#7c5cff",  # Electric Violet
    "#ec4899",  # Magenta Neon
    "#06b6d4",  # Cyan Console
    "#8b5cf6",  # Purple Tone
    "#f59e0b",  # Amber Glow
]


class BuildProgress:
    """Thread-safe progress and state tracker for a pack building session."""
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.lock = threading.Lock()
        self.status = "idle"  # "idle" | "extracting_audio" | "separating_stems" | "transcribing" | "slicing" | "assembling" | "transcribed" | "done" | "error"
        self.progress = 0.0   # 0.0 to 1.0
        self.message = "Initializing builder session..."
        self.stage = "init"
        self.error: Optional[str] = None
        self.segments: List[Dict[str, Any]] = []
        self.characters: List[str] = []
        self.device_info: Dict[str, Any] = {}
        self.completed_at: Optional[float] = None
        self.pack_info: Optional[Dict[str, Any]] = None

    def update(self, status: str, progress: float, message: str, stage: str = "", segments: Optional[List[Dict[str, Any]]] = None, error: Optional[str] = None):
        with self.lock:
            self.status = status
            self.progress = max(0.0, min(1.0, float(progress)))
            self.message = message
            if stage:
                self.stage = stage
            if segments is not None:
                self.segments = segments
            if error is not None:
                self.error = error
            if status == "done":
                self.completed_at = time.time()

    def to_dict(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "session_id": self.session_id,
                "status": self.status,
                "progress": round(self.progress, 3),
                "message": self.message,
                "stage": self.stage,
                "error": self.error,
                "segments": self.segments,
                "characters": self.characters,
                "device_info": self.device_info,
                "completed_at": self.completed_at,
                "pack_info": self.pack_info,
            }


def detect_torch_and_cuda() -> Tuple[bool, bool, str]:
    """
    Checks if PyTorch and CUDA GPU are available.
    Returns: (torch_available, cuda_available, device_str)
    """
    try:
        import torch
        cuda_avail = torch.cuda.is_available()
        return True, cuda_avail, "cuda" if cuda_avail else "cpu"
    except ImportError:
        return False, False, "none"
    except Exception:
        return True, False, "cpu"


def extract_audio_from_video(video_path: str, output_wav: str) -> str:
    """
    Extracts high-quality 44.1kHz mono WAV audio track from video using FFmpeg.
    If the video has no audio streams (silent video / silent GIF), generates a clean silent WAV.
    """
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video file not found: {video_path}")

    ffmpeg = pack_loader.get_ffmpeg_path()
    os.makedirs(os.path.dirname(output_wav), exist_ok=True)
    
    # 1. Attempt standard audio extraction
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", video_path,
        "-vn",
        "-ac", "1",
        "-ar", "44100",
        "-f", "wav",
        output_wav
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode == 0 and os.path.isfile(output_wav) and os.path.getsize(output_wav) >= 100:
        return output_wav

    # 2. If extraction returned "Output file does not contain any stream" or video has no audio track,
    # generate a silent audio track matching video duration so the editor and pipeline function properly
    duration = pack_loader.probe_duration(video_path)
    if duration <= 0.0:
        duration = 5.0

    silent_cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=mono",
        "-t", str(duration),
        "-ac", "1",
        "-ar", "44100",
        "-f", "wav",
        output_wav
    ]
    silent_res = subprocess.run(silent_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if silent_res.returncode == 0 and os.path.isfile(output_wav):
        return output_wav

    raise RuntimeError(f"FFmpeg audio extraction failed: {res.stderr.strip() or 'Unknown error'}")


def download_video_from_url(
    url: str,
    output_dir: str,
    max_duration_seconds: float = 1800.0,
) -> Dict[str, Any]:
    """
    Downloads a video from YouTube / web URL using yt-dlp.
    Uses latest GitHub-grade client extractors to prevent 403 Forbidden errors.
    Merges high-res video and audio tracks via project FFmpeg binary.
    """
    if not url or not url.strip():
        raise ValueError("No video URL provided.")

    clean_url = url.strip()

    try:
        import yt_dlp
    except ImportError:
        import sys
        if getattr(sys, "frozen", False):
            raise RuntimeError(
                "YouTube / URL import is not available in this version of DubMate. "
                "Use the web version (run_cloudflare.bat or run_web_studio.bat) and install the Pack Builder "
                "AI pipeline (pip install -r requirements_builder.txt) to enable this feature."
            )
        raise RuntimeError("yt-dlp is not installed. Install it with: pip install -r requirements_builder.txt")

    os.makedirs(output_dir, exist_ok=True)
    video_out_tmpl = os.path.join(output_dir, "source_video.%(ext)s")
    thumb_out_tmpl = os.path.join(output_dir, "cover.%(ext)s")
    ffmpeg_bin = pack_loader.get_ffmpeg_path()

    # Options for yt-dlp optimized against YouTube 403/429 / throttling
    ydl_opts = {
        'format': 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[ext=mp4][height<=1080]/best[height<=1080]/best',
        'outtmpl': {
            'default': video_out_tmpl,
            'thumbnail': thumb_out_tmpl,
        },
        'merge_output_format': 'mp4',
        'ffmpeg_location': ffmpeg_bin,
        'writethumbnail': True,
        'writesubtitles': False,
        'writeautomaticsub': False,
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'socket_timeout': 30,
        'retries': 5,
        'fragment_retries': 5,
        'extractor_args': {
            'youtube': {
                'player_client': ['ios', 'android', 'web', 'mweb', 'tv_embedded'],
                'player_skip': ['js', 'configs'],
            }
        },
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        'max_filesize': pack_loader.MAX_ARCHIVE_SIZE_BYTES,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(clean_url, download=True)
            if not info:
                raise ValueError("Could not extract video metadata from the provided URL.")

            title = info.get("title") or "Imported YouTube Scene"
            duration = float(info.get("duration") or 0.0)
            if duration > max_duration_seconds:
                raise ValueError(
                    f"Video duration ({duration:.1f}s) exceeds the maximum allowed scene length ({max_duration_seconds/60:.0f} minutes)."
                )
    except Exception as ex:
        err_msg = str(ex)
        if "Unsupported URL" in err_msg or "is not a valid URL" in err_msg:
            raise ValueError(f"Invalid or unsupported video URL: {clean_url}")
        raise RuntimeError(f"Failed to download video with yt-dlp: {err_msg}")

    # Find the downloaded source_video file
    raw_video_path = None
    for f in os.listdir(output_dir):
        if f.startswith("source_video.") and not f.endswith(".part"):
            raw_video_path = os.path.join(output_dir, f)
            break

    if not raw_video_path or not os.path.isfile(raw_video_path):
        raise FileNotFoundError("Downloaded video file was not found on disk.")

    # Standardize video into 100% browser-compatible H.264 / AAC + faststart MP4
    standardized_mp4 = os.path.join(output_dir, "scene_video.mp4")
    transcode_cmd = [
        ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
        "-i", raw_video_path,
        "-vf", "scale='min(1920,iw)':-2",
        "-c:v", "libx264", "-preset", "faster", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        standardized_mp4
    ]
    trans_res = subprocess.run(transcode_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if trans_res.returncode == 0 and os.path.isfile(standardized_mp4) and os.path.getsize(standardized_mp4) > 1000:
        if os.path.abspath(raw_video_path) != os.path.abspath(standardized_mp4):
            try:
                os.remove(raw_video_path)
            except Exception:
                pass
        video_path = standardized_mp4
    else:
        video_path = raw_video_path

    # Extract audio stream immediately for waveform & processing pipeline
    audio_path = os.path.join(output_dir, "full_audio.wav")
    try:
        extract_audio_from_video(video_path, audio_path)
    except Exception as e:
        print(f"[PackBuilder] Audio extraction warning for URL import: {e}")

    # Find thumbnail file if downloaded
    cover_path = None
    for f in os.listdir(output_dir):
        if f.startswith("cover.") and not f.endswith(".wav") and not f.endswith(".part"):
            cover_path = os.path.join(output_dir, f)
            break

    # Find and parse subtitles if available
    subtitle_segments = []
    for f in os.listdir(output_dir):
        if (f.endswith(".srt") or f.endswith(".vtt")) and not f.startswith("source_video.") and not f.startswith("scene_video."):
            sub_file_path = os.path.join(output_dir, f)
            try:
                with open(sub_file_path, "r", encoding="utf-8", errors="ignore") as sf:
                    sub_content = sf.read()
                    if f.endswith(".srt"):
                        parsed = parse_srt(sub_content)
                    else:
                        parsed = parse_vtt(sub_content)
                    if parsed:
                        subtitle_segments = parsed
                        break
            except Exception:
                pass

    actual_dur = pack_loader.probe_duration(video_path)
    if actual_dur > 0.0:
        duration = actual_dur

    return {
        "video_path": video_path,
        "filename": os.path.basename(video_path),
        "title": title,
        "duration": round(duration, 3),
        "cover_path": cover_path,
        "full_audio_path": audio_path if os.path.isfile(audio_path) else None,
        "subtitle_segments": subtitle_segments,
    }


def separate_audio_stems(audio_wav: str, output_dir: str, model_name: str = "htdemucs") -> Dict[str, str]:
    """
    Runs Demucs audio source separation to split into vocals and backing (no_vocals) stems.
    GPU-first: Uses CUDA if available, falls back to CPU if not.
    Gracefully falls back to using the full audio track as vocals if Demucs/Torch is unavailable.
    """
    os.makedirs(output_dir, exist_ok=True)
    vocals_out = os.path.join(output_dir, "vocals.wav")
    backing_out = os.path.join(output_dir, "backing.wav")

    torch_avail, cuda_avail, device = detect_torch_and_cuda()

    # Attempt Demucs separation if installed
    if torch_avail:
        try:
            import demucs.separate
            import torch

            device_title = f"CUDA GPU: {torch.cuda.get_device_name(0)}" if cuda_avail else "CPU"
            print(f"[PackBuilder] Running Demucs stem separation on {device.upper()} ({device_title})...")
            
            demucs_temp = os.path.join(output_dir, "demucs_out")
            os.makedirs(demucs_temp, exist_ok=True)

            cmd = [
                "-n", model_name,
                "--two-stems", "vocals",
                "-o", demucs_temp,
                "-d", device,
                audio_wav
            ]
            demucs.separate.main(cmd)

            # Locate output files: demucs_temp/<model_name>/<track_name>/vocals.wav and no_vocals.wav
            track_stem = os.path.splitext(os.path.basename(audio_wav))[0]
            stem_dir = os.path.join(demucs_temp, model_name, track_stem)
            
            found_vocals = os.path.join(stem_dir, "vocals.wav")
            found_no_vocals = os.path.join(stem_dir, "no_vocals.wav")

            if os.path.isfile(found_vocals) and os.path.isfile(found_no_vocals):
                shutil.move(found_vocals, vocals_out)
                shutil.move(found_no_vocals, backing_out)
                shutil.rmtree(demucs_temp, ignore_errors=True)
                print(f"[PackBuilder] Demucs separation completed successfully on {device.upper()}.")
                return {"vocals": vocals_out, "backing": backing_out, "separated": True, "device": device}

        except ImportError:
            print("[PackBuilder] Demucs package not installed. Install requirements_builder.txt to enable AI vocal isolation.")
        except Exception as ex:
            print(f"[PackBuilder] Demucs execution failed: {ex}. Falling back to clean audio duplicate.")

    # Fallback: Apply DSP center-channel vocal attenuation for backing track
    print("[PackBuilder] Applying DSP center-channel vocal attenuation filter for backing track...")
    shutil.copyfile(audio_wav, vocals_out)
    success = attenuate_vocals_dsp(audio_wav, backing_out)
    if not success:
        shutil.copyfile(audio_wav, backing_out)
    return {"vocals": vocals_out, "backing": backing_out, "separated": success, "device": "dsp_filter"}


def attenuate_vocals_dsp(input_wav: str, output_wav: str) -> bool:
    """
    Applies center-channel vocal cancellation and bandpass attenuation using FFmpeg DSP
    as a fast lightweight fallback when neural Demucs is not installed.
    """
    ffmpeg = pack_loader.get_ffmpeg_path()
    filter_complex = "pan=stereo|c0=c0-0.85*c1|c1=c1-0.85*c0,lowshelf=f=180:g=+3"
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", input_wav,
        "-af", filter_complex,
        "-c:a", "pcm_s16le",
        "-ar", "44100",
        output_wav
    ]
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return res.returncode == 0 and os.path.isfile(output_wav) and os.path.getsize(output_wav) > 100


def to_romaji(text: str) -> str:
    """Converts Japanese Kanji/Kana text to clean Romaji Hepburn romanization for dubbing."""
    if not text:
        return ""
    try:
        import pykakasi
        k = pykakasi.kakasi()
        result = k.convert(text)
        romaji_words = []
        for item in result:
            hep = item.get("hepburn", "")
            if hep:
                romaji_words.append(hep)
            else:
                romaji_words.append(item.get("orig", ""))
        clean = " ".join(romaji_words).replace("  ", " ").strip()
        # Clean up punctuation spacing
        for p in [".", ",", "!", "?", "...", ":", ";"]:
            clean = clean.replace(f" {p}", p)
        return clean
    except Exception:
        return text


def transcribe_segment(audio_wav: str, start: float, end: float, model_size: str = "base", language: Optional[str] = None, romanize: bool = False) -> str:
    """
    Transcribes a specific time slice [start, end] using Whisper on-demand.
    Returns the recognized speech text string (with optional Romaji romanization).
    """
    torch_avail, cuda_avail, device = detect_torch_and_cuda()
    
    # 1. Extract slice to a temp wav file
    temp_slice = audio_wav + f".slice_{start:.2f}_{end:.2f}.wav"
    ffmpeg = pack_loader.get_ffmpeg_path()
    dur = max(0.2, end - start)
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(start),
        "-i", audio_wav,
        "-t", str(dur),
        "-c:a", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        temp_slice
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    except Exception:
        temp_slice = audio_wav

    try:
        import whisper
        print(f"[PackBuilder] Transcribing segment [{start:.2f}s - {end:.2f}s] with Whisper on {device.upper()}...")
        model = whisper.load_model(model_size, device=device)
        transcribe_opts = {"verbose": False}
        
        is_romaji_req = romanize or (language and "romaji" in language.lower())
        whisper_lang = "ja" if (language and "ja" in language.lower()) else language
        if whisper_lang and whisper_lang.strip().lower() not in ("auto", "none"):
            transcribe_opts["language"] = whisper_lang.strip().lower()

        res = model.transcribe(temp_slice, **transcribe_opts)
        text = (res.get("text") or "").strip()
        
        # If Japanese and Romaji is requested or text contains Japanese characters
        if is_romaji_req and text:
            romaji_text = to_romaji(text)
            return romaji_text if romaji_text else text
            
        return text
    except ImportError:
        print("[PackBuilder] Whisper not installed. Cannot transcribe segment.")
        return ""
    except Exception as ex:
        print(f"[PackBuilder] Segment transcription error: {ex}")
        return ""
    finally:
        if temp_slice != audio_wav and os.path.isfile(temp_slice):
            try:
                os.remove(temp_slice)
            except Exception:
                pass


def transcribe_audio(audio_wav: str, model_size: str = "base", language: Optional[str] = None, romanize: bool = False) -> List[Dict[str, Any]]:
    """
    Runs OpenAI Whisper speech-to-text transcription on the vocals audio track.
    GPU-first: Uses CUDA if available, CPU as fallback.
    Returns a list of segment dictionaries with start, end, text, and character.
    """
    torch_avail, cuda_avail, device = detect_torch_and_cuda()

    try:
        import whisper
        print(f"[PackBuilder] Running Whisper ({model_size}) transcription on {device.upper()}...")
        
        model = whisper.load_model(model_size, device=device)
        
        transcribe_opts = {"verbose": False}
        is_romaji_req = romanize or (language and "romaji" in language.lower())
        whisper_lang = "ja" if (language and "ja" in language.lower()) else language
        if whisper_lang and whisper_lang.strip().lower() not in ("auto", "none"):
            transcribe_opts["language"] = whisper_lang.strip().lower()

        result = model.transcribe(audio_wav, **transcribe_opts)
        raw_segments = result.get("segments", [])
        
        segments = []
        for s in raw_segments:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            if is_romaji_req:
                text = to_romaji(text) or text

            start = round(float(s.get("start", 0.0)), 3)
            end = round(float(s.get("end", start + 1.0)), 3)
            if end <= start:
                end = round(start + 1.0, 3)
            segments.append({
                "start": start,
                "end": end,
                "text": text,
                "character": "Actor"
            })

        print(f"[PackBuilder] Whisper detected {len(segments)} dialogue lines on {device.upper()}.")
        return segments

    except ImportError:
        print("[PackBuilder] Whisper package not installed. Install requirements_builder.txt to enable auto-transcription.")
        return []
    except Exception as ex:
        print(f"[PackBuilder] Whisper transcription failed: {ex}")
        return []


def parse_timestamp_seconds(ts_str: str) -> float:
    """Parses timestamp like '01:23:45.678', '01:23,456', or '02.50' into float seconds."""
    ts_str = ts_str.strip().replace(",", ".")
    parts = ts_str.split(":")
    if len(parts) == 3:
        h, m, s = float(parts[0]), float(parts[1]), float(parts[2])
        return h * 3600.0 + m * 60.0 + s
    elif len(parts) == 2:
        m, s = float(parts[0]), float(parts[1])
        return m * 60.0 + s
    elif len(parts) == 1:
        return float(parts[0])
    return 0.0


def parse_srt(srt_content: str) -> List[Dict[str, Any]]:
    """
    Parses SRT subtitle format into standard segment dictionaries.
    Supports HH:MM:SS,mmm and MM:SS,mmm formats.
    Strips HTML tags and extracts character prefix if present (e.g. '[Levi] text' or 'Kenny: text').
    """
    segments = []
    # Flexible timestamp regex supporting (HH:)?MM:SS[,.]mmm
    ts_pattern = re.compile(r"((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})")
    
    blocks = re.split(r"\r?\n\r?\n", srt_content.strip())
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        
        ts_match = None
        text_lines = []
        for line in lines:
            m = ts_pattern.search(line)
            if m:
                ts_match = m
            elif not line.isdigit() and ts_match:
                text_lines.append(line)

        if ts_match and text_lines:
            start = parse_timestamp_seconds(ts_match.group(1))
            end = parse_timestamp_seconds(ts_match.group(2))

            raw_text = " ".join(text_lines)
            clean_text = re.sub(r"<[^>]+>", "", raw_text).strip()
            
            char_name, display_text = pack_loader.extract_character_and_caption(clean_text, "take.wav")
            
            # Clean character fallback
            if not char_name or char_name.lower() in ("take", "line", "narrator", ""):
                char_name = "Actor" if not clean_text.startswith("Narrator:") else "Narrator"

            segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "text": display_text if display_text else clean_text,
                "character": char_name
            })

    segments.sort(key=lambda s: s["start"])
    return segments


def parse_vtt(vtt_content: str) -> List[Dict[str, Any]]:
    """
    Parses WebVTT subtitle format into standard segment dictionaries.
    """
    content = re.sub(r"^WEBVTT[^\n]*\n", "", vtt_content, flags=re.IGNORECASE)
    content = re.sub(r"NOTE[^\n]*\n[^\n]*\n", "", content)
    return parse_srt(content)


def assign_speakers_to_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Applies heuristic character grouping to segments based on conversational turn gaps.
    If no character names were found in subtitles, assigns Speaker 1, Speaker 2, etc.
    """
    if not segments:
        return []

    distinct_chars = {s.get("character") for s in segments if s.get("character") and s.get("character") != "Actor"}
    if distinct_chars:
        return segments

    current_speaker_idx = 1
    num_speakers = 2

    for i, seg in enumerate(segments):
        if i > 0:
            prev_end = segments[i - 1]["start"] + max(0.5, segments[i - 1].get("end", 0.0) - segments[i - 1]["start"])
            curr_start = seg["start"]
            gap = curr_start - prev_end
            if gap > 1.5:
                current_speaker_idx = (current_speaker_idx % num_speakers) + 1
        seg["character"] = f"Speaker {current_speaker_idx}"

    return segments


def slice_audio_lines(
    vocals_wav: str,
    segments: List[Dict[str, Any]],
    output_dir: str,
    pack_name: str
) -> List[Dict[str, Any]]:
    """
    Slices vocals WAV into individual audio cue files using FFmpeg with micro-fades.
    Generates exact DubMate filename encoding:
    `{index:02d}_{clean_character}_{seconds}-{millis}.wav`
    """
    ffmpeg = pack_loader.get_ffmpeg_path()
    os.makedirs(output_dir, exist_ok=True)
    
    total_audio_duration = pack_loader.probe_duration(vocals_wav)
    enriched_segments = []

    for i, seg in enumerate(segments):
        start = float(seg["start"])
        end = float(seg["end"])
        text = seg.get("text", "").strip()
        raw_char = seg.get("character", "Actor").strip() or "Actor"
        
        safe_char = re.sub(r'[^A-Za-z0-9]+', '', raw_char) or "Actor"

        start_sec = int(start)
        start_ms = int(round((start - start_sec) * 1000))
        ts_code = f"{start_sec}-{start_ms:03d}"

        filename = f"{i + 1:02d}_{safe_char}_{ts_code}.wav"
        out_wav = os.path.join(output_dir, filename)

        # Apply 10ms micro fade in/out to prevent audio pops
        fade_dur = 0.010
        seg_dur = max(0.05, end - start)
        fade_out_start = max(0.0, seg_dur - fade_dur)
        af_filter = f"afade=t=in:ss=0:d={fade_dur},afade=t=out:st={fade_out_start:.3f}:d={fade_dur}"

        cmd = [
            ffmpeg, "-y",
            "-ss", f"{start:.3f}",
            "-t", f"{seg_dur:.3f}",
            "-i", vocals_wav,
            "-af", af_filter,
            "-ar", "44100",
            "-ac", "2",
            out_wav
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0 or not os.path.isfile(out_wav) or os.path.getsize(out_wav) < 100:
            # Fallback simple slice without afade
            cmd_fallback = [
                ffmpeg, "-y",
                "-ss", f"{start:.3f}",
                "-t", f"{seg_dur:.3f}",
                "-i", vocals_wav,
                "-ar", "44100",
                "-ac", "2",
                out_wav
            ]
            subprocess.run(cmd_fallback, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        enriched_segments.append({
            "index": i,
            "filename": filename,
            "character": raw_char,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(seg_dur, 3),
            "caption": text,
            "raw_caption": f"[{raw_char}] {text}" if text else f"[{raw_char}]",
            "file_path": out_wav,
            "audio_file": out_wav
        })

    return enriched_segments


def assemble_pack(
    pack_name: str,
    video_source_path: str,
    backing_source_path: str,
    line_slices: List[Dict[str, Any]],
    cover_image_path: Optional[str] = None,
    authors: Optional[List[str]] = None,
    subtitle: Optional[str] = None
) -> str:
    """
    Assembles a complete, compliant DubMate scene pack inside `Packs/<pack_name>`.
    Generates:
    - `dub_video.mp4`
    - `_backing_track.wav`
    - individual line `.wav` files
    - `_captions.json`
    - `_TIMESTAMPS.txt`
    - `pack.json`
    - `dub_subs.txt`
    - `icon.png` (if provided)
    """
    safe_title = pack_name.strip() or "Custom Dub Scene"
    safe_folder_name = re.sub(r'[^A-Za-z0-9 _\-]+', '', safe_title).strip() or "Custom_Pack"
    
    target_base = pack_loader.PACKS_DIRS[0]
    os.makedirs(target_base, exist_ok=True)
    pack_dir = os.path.join(target_base, safe_folder_name)
    os.makedirs(pack_dir, exist_ok=True)

    # 1. Copy / Transcode Video to dub_video.mp4
    target_video = os.path.join(pack_dir, "dub_video.mp4")
    if os.path.isfile(video_source_path):
        pack_loader.transcode_to_mp4(video_source_path, target_video)
        if not os.path.isfile(target_video) or os.path.getsize(target_video) < 100:
            shutil.copyfile(video_source_path, target_video)

    # 2. Copy Backing Track to _backing_track.wav
    target_backing = os.path.join(pack_dir, "_backing_track.wav")
    if os.path.isfile(backing_source_path):
        shutil.copyfile(backing_source_path, target_backing)
    elif os.path.isfile(video_source_path):
        extract_audio_from_video(video_source_path, target_backing)

    # 3. Move/Copy line slices
    for line in line_slices:
        src = line.get("file_path")
        if src and os.path.isfile(src):
            dst = os.path.join(pack_dir, line["filename"])
            shutil.copyfile(src, dst)

    # 4. Copy Cover Image / Icon if provided
    if cover_image_path and os.path.isfile(cover_image_path):
        ext = os.path.splitext(cover_image_path)[1].lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp"):
            ext = ".png"
        target_icon = os.path.join(pack_dir, f"icon{ext}")
        shutil.copyfile(cover_image_path, target_icon)

    # 5. Generate _captions.json
    captions_map = {}
    for line in line_slices:
        cap = line.get("caption", "").strip()
        char = line.get("character", "Actor").strip()
        captions_map[line["filename"]] = f"[{char}] {cap}" if cap else f"[{char}]"
    
    with open(os.path.join(pack_dir, "_captions.json"), "w", encoding="utf-8") as f:
        json.dump(captions_map, f, ensure_ascii=False, indent=2)

    # 6. Generate _TIMESTAMPS.txt
    ts_lines = [
        f"# {safe_title}",
        "# Auto-generated DubMate Pack Builder timestamps",
        "# File | start time (s) | subtitle\n"
    ]
    for line in line_slices:
        cap = line.get("caption", "").strip()
        char = line.get("character", "Actor").strip()
        sub = f"[{char}] {cap}" if cap else f"[{char}]"
        ts_lines.append(f"{line['filename']:<40} {line['start']:>10.3f}s   | {sub}")
    
    with open(os.path.join(pack_dir, "_TIMESTAMPS.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(ts_lines) + "\n")

    # 7. Generate pack.json / info.ini metadata
    char_list = sorted(list({l.get("character", "Actor") for l in line_slices}))
    pack_meta = {
        "title": safe_title,
        "name": safe_title,
        "subtitle": subtitle or f"Dub scene with {len(line_slices)} dialogue lines",
        "authors": authors or ["DubMate Studio"],
        "characters": char_list,
        "line_count": len(line_slices),
        "created_with": "DubMate Pack Builder",
        "version": "1.0",
        "created_at": time.time(),
    }
    with open(os.path.join(pack_dir, "pack.json"), "w", encoding="utf-8") as f:
        json.dump(pack_meta, f, ensure_ascii=False, indent=2)

    # 8. Generate standard dub_subs.txt for backward compatibility
    dub_subs_lines = []
    for line in line_slices:
        cap = line.get("caption", "").strip()
        char = line.get("character", "Actor").strip()
        start = line["start"]
        end = line["end"]
        
        s_min, s_sec = divmod(int(start), 60)
        e_min, e_sec = divmod(int(end), 60)
        dub_subs_lines.append(f"{s_min:02d}.{s_sec:02d}-{e_min:02d}.{e_sec:02d}: [{char}] {cap}")

    with open(os.path.join(pack_dir, "dub_subs.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(dub_subs_lines) + "\n")

    return pack_dir
