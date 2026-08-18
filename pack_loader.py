# -*- coding: utf-8 -*-
"""
pack_loader.py
Scans, parses, and normalizes DubMate / DubStage packs.
Extracts character roles, timestamps, captions, backing tracks, and handles video transcoding.
"""

import os
import re
import glob
import json
import shutil
import subprocess
import tempfile
import urllib.parse
from typing import Dict, List, Optional, Any

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PACKS_DIRS = [
    os.path.join(BASE_DIR, "Packs"),
    os.path.join(BASE_DIR, "dubstage-1.1.0", "packs"),
]
CACHE_DIR = os.path.join(BASE_DIR, ".cache")
os.makedirs(CACHE_DIR, exist_ok=True)

AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".flac")
VIDEO_EXTS = (".mp4", ".ogv", ".mkv", ".webm", ".mov", ".avi")
_TS_REGEX = re.compile(r"_(\d+)-(\d{1,3})(?:\.[A-Za-z0-9]+)?$")


def get_ffmpeg_path() -> str:
    """Finds ffmpeg binary in system PATH or local tools folder."""
    tool = shutil.which("ffmpeg")
    if tool:
        return tool
    local_tool = os.path.join(BASE_DIR, "dubstage-1.1.0", "tools", "ffmpeg.exe")
    if os.path.exists(local_tool):
        return local_tool
    return "ffmpeg"


def get_ffprobe_path() -> str:
    tool = shutil.which("ffprobe")
    if tool:
        return tool
    local_tool = os.path.join(BASE_DIR, "dubstage-1.1.0", "tools", "ffprobe.exe")
    if os.path.exists(local_tool):
        return local_tool
    return "ffprobe"


import wave

def probe_duration(file_path: str) -> float:
    """Returns duration in seconds of an audio or video file quickly."""
    if not os.path.exists(file_path):
        return 0.0
    if file_path.lower().endswith(".wav"):
        try:
            with wave.open(file_path, "rb") as w:
                return round(w.getnframes() / float(w.getframerate()), 3)
        except Exception:
            pass

    ffprobe = get_ffprobe_path()
    try:
        cmd = [
            ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", file_path
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True).strip()
        return round(float(out), 3)
    except Exception:
        return 0.0


def timestamp_from_filename(filename: str) -> Optional[float]:
    """Extracts timestamp from filename e.g. '07_MyClip_44-048.wav' -> 44.048."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    m = _TS_REGEX.search(stem)
    if not m:
        return None
    whole, frac = m.group(1), m.group(2)
    return float(whole) + float(frac) / (10 ** len(frac))


def read_timestamps_txt(folder: str) -> Dict[str, float]:
    """Fallback timestamp parser from _TIMESTAMPS.txt."""
    path = os.path.join(folder, "_TIMESTAMPS.txt")
    out = {}
    if not os.path.isfile(path):
        return out
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"(\S+\.(?:wav|mp3|ogg|flac))\s+(-?[\d.]+)", line, re.IGNORECASE)
                if m:
                    out[m.group(1)] = float(m.group(2))
    except Exception:
        pass
    return out


def read_captions(folder: str) -> Dict[str, str]:
    """Reads captions from _captions.json or adjacent .txt files."""
    out = {}
    json_path = os.path.join(folder, "_captions.json")
    if os.path.isfile(json_path):
        try:
            with open(json_path, "r", encoding="utf-8", errors="replace") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                for k, v in raw.items():
                    if isinstance(v, str) and v.strip():
                        out[k] = v.strip()
        except Exception:
            pass

    # Read per-clip txt files if available
    try:
        for f in os.listdir(folder):
            if not f.lower().endswith(".txt") or f.startswith("_"):
                continue
            stem = os.path.splitext(f)[0]
            for ext in AUDIO_EXTS:
                clip = stem + ext
                if clip in out or not os.path.isfile(os.path.join(folder, clip)):
                    continue
                try:
                    with open(os.path.join(folder, f), "r", encoding="utf-8", errors="replace") as fh:
                        text = fh.read().strip()
                    if text:
                        out[clip] = text
                except Exception:
                    pass
    except Exception:
        pass
    return out


def extract_character_from_caption_or_name(caption: str, filename: str) -> str:
    """
    Extracts character name:
    1. From caption prefix e.g. '[Levi] “You are...”' -> 'Levi' or '[Hollow Ichigo] ...' -> 'Hollow Ichigo'
    2. Fallback from filename e.g. '01_Zeke_2-420.wav' -> 'Zeke', '01_Nendou_01_0-275.wav' -> 'Nendou'
    """
    if caption:
        m = re.match(r"^\[(.*?)\]", caption.strip())
        if m:
            char_name = m.group(1).strip()
            if char_name:
                return char_name

    stem = os.path.splitext(filename)[0]
    clean = re.sub(r"^\d+[_\-]", "", stem)
    clean = re.sub(r"_\d+-\d{1,3}$", "", clean)
    clean = re.sub(r"_\d+$", "", clean)
    clean = clean.replace("_", " ").strip()
    return clean if clean else "Narrator"


_DETECTED_ENCODER = None


def get_h264_encoder_args(crf: int = 22, usage: str = "export") -> List[str]:
    """
    Returns optimal FFmpeg video encoder arguments.
    Prefers AMD AMF GPU hardware acceleration (Radeon), falling back to multi-threaded CPU libx264 (Ryzen 6 threads).
    """
    global _DETECTED_ENCODER
    if _DETECTED_ENCODER is None:
        try:
            ff = get_ffmpeg_path()
            test_cmd = [
                ff, "-y", "-f", "lavfi", "-i", "testsrc=duration=0.1:size=640x360:rate=30",
                "-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed",
                "-pix_fmt", "yuv420p", "-f", "null", "-"
            ]
            res = subprocess.run(test_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if res.returncode == 0:
                _DETECTED_ENCODER = "h264_amf"
            else:
                _DETECTED_ENCODER = "libx264"
        except Exception:
            _DETECTED_ENCODER = "libx264"

    if _DETECTED_ENCODER == "h264_amf":
        if usage == "web_preview":
            return ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed", "-rc", "cbr", "-b:v", "2500k"]
        return ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "quality", "-rc", "cbr", "-b:v", "5000k"]

    # Ryzen 9600X CPU multi-threading fallback (capped at 6 threads)
    preset = "faster" if usage == "web_preview" else "veryfast"
    return ["-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-threads", "6"]


def get_web_video_path(pack_folder: str, orig_video_path: str) -> str:
    """Returns web-optimized video path. Converts/caches a muted 720p 30fps fastdecode mp4."""
    pack_name = os.path.basename(pack_folder)
    cached_mp4 = os.path.join(CACHE_DIR, f"{pack_name}_web.mp4")
    if os.path.isfile(cached_mp4) and os.path.getsize(cached_mp4) > 1000:
        return cached_mp4
    if transcode_to_mp4(orig_video_path, cached_mp4):
        return cached_mp4
    return orig_video_path


def transcode_to_mp4(orig_video_path: str, target_mp4_path: str) -> bool:
    """Transcodes a video to lightweight 720p 30fps H.264 MP4 without audio for fast web streaming."""
    ffmpeg = get_ffmpeg_path()
    try:
        tmp_target = target_mp4_path + ".tmp.mp4"
        encoder_args = get_h264_encoder_args(crf=25, usage="web_preview")
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", orig_video_path,
            "-vf", "scale='min(1280,iw)':-2",
            "-r", "30",
            *encoder_args,
            "-pix_fmt", "yuv420p",
            "-an",  # Strip audio track completely so reference video cannot bleed
            "-movflags", "+faststart",
            tmp_target
        ]
        subprocess.run(cmd, check=True)
        if os.path.isfile(tmp_target):
            os.replace(tmp_target, target_mp4_path)
            return True
    except Exception as ex:
        print(f"Error transcoding {orig_video_path}: {ex}")
    return False


class PackInfo:
    def __init__(self, pack_id: str, folder: str, name: str):
        self.pack_id = pack_id
        self.folder = folder
        self.name = name
        self.video_path: Optional[str] = None
        self.web_video_path: Optional[str] = None
        self.backing_track_path: Optional[str] = None
        self.duration: float = 0.0
        self.lines: List[Dict[str, Any]] = []
        self.characters: List[str] = []

    def ensure_web_ready(self):
        """Ensures the web video is converted to web-ready MP4."""
        cached = os.path.join(CACHE_DIR, f"{self.pack_id}_web.mp4")
        if not os.path.isfile(cached) or os.path.getsize(cached) < 1000:
            if transcode_to_mp4(self.video_path, cached):
                self.web_video_path = cached

    def to_dict(self) -> Dict[str, Any]:
        quoted_id = urllib.parse.quote(self.pack_id)
        return {
            "id": self.pack_id,
            "name": self.name,
            "title": self.name,
            "duration": round(self.duration, 2),
            "line_count": len(self.lines),
            "characters": self.characters,
            "has_backing": self.backing_track_path is not None,
            "video_url": f"/api/packs/{quoted_id}/video",
            "backing_url": f"/api/packs/{quoted_id}/backing" if self.backing_track_path else None,
            "lines": self.lines,
        }


def load_pack(pack_folder: str) -> Optional[PackInfo]:
    """Loads and indexes a single pack folder."""
    if not os.path.isdir(pack_folder):
        return None

    video_path = None
    for ext in VIDEO_EXTS:
        cand = os.path.join(pack_folder, "dub_video" + ext)
        if os.path.isfile(cand):
            video_path = cand
            break

    if not video_path:
        for f in os.listdir(pack_folder):
            if any(f.lower().endswith(ext) for ext in VIDEO_EXTS):
                video_path = os.path.join(pack_folder, f)
                break

    if not video_path:
        return None

    pack_id = os.path.basename(os.path.normpath(pack_folder))
    pack_name = pack_id.replace("_", " ").title()
    pack = PackInfo(pack_id=pack_id, folder=pack_folder, name=pack_name)
    pack.video_path = video_path
    pack.web_video_path = get_web_video_path(pack_folder, video_path)
    pack.duration = probe_duration(pack.web_video_path)

    for f in os.listdir(pack_folder):
        low = f.lower()
        if low.startswith("_backing_track") and any(low.endswith(ext) for ext in AUDIO_EXTS):
            pack.backing_track_path = os.path.join(pack_folder, f)
            break

    ts_from_txt = read_timestamps_txt(pack_folder)
    captions = read_captions(pack_folder)

    entries = []
    for f in sorted(os.listdir(pack_folder)):
        low = f.lower()
        if not any(low.endswith(ext) for ext in AUDIO_EXTS):
            continue
        if low.startswith("_"):
            continue
        ts = timestamp_from_filename(f)
        if ts is None:
            ts = ts_from_txt.get(f)
        if ts is not None:
            entries.append((f, ts))

    if not entries:
        return None

    entries.sort(key=lambda x: x[1])

    character_set = set()
    lines = []
    for i, (filename, start_ts) in enumerate(entries):
        audio_full_path = os.path.join(pack_folder, filename)
        line_duration = probe_duration(audio_full_path)
        caption_text = captions.get(filename, "")
        character = extract_character_from_caption_or_name(caption_text, filename)
        character_set.add(character)

        display_caption = re.sub(r"^\[.*?\]\s*", "", caption_text).strip('“"” ')
        if not display_caption:
            display_caption = caption_text

        quoted_pack_id = urllib.parse.quote(pack_id)
        quoted_filename = urllib.parse.quote(filename)
        lines.append({
            "index": i,
            "filename": filename,
            "character": character,
            "start": round(start_ts, 3),
            "duration": round(line_duration, 3),
            "end": round(start_ts + line_duration, 3),
            "caption": display_caption,
            "raw_caption": caption_text,
            "audio_url": f"/api/packs/{quoted_pack_id}/audio/{quoted_filename}",
        })

    pack.lines = lines
    char_counts = {}
    for l in lines:
        c = l["character"]
        char_counts[c] = char_counts.get(c, 0) + 1
    pack.characters = sorted(list(character_set), key=lambda c: -char_counts.get(c, 0))

    return pack


def get_all_packs() -> Dict[str, PackInfo]:
    """Scans all pack directories and returns dictionary of pack_id -> PackInfo."""
    packs = {}
    for base in PACKS_DIRS:
        if not os.path.isdir(base):
            continue
        for item in sorted(os.listdir(base)):
            full_path = os.path.join(base, item)
            if os.path.isdir(full_path) and not item.startswith("."):
                pack = load_pack(full_path)
                if pack:
                    packs[pack.pack_id] = pack
    return packs
