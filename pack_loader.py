# -*- coding: utf-8 -*-
"""
pack_loader.py
Scans, parses, and normalizes DubMate / DubStage packs and Choicer Voicer packs.
Extracts character roles, timestamps, captions, backing tracks, cover art, and handles video transcoding.
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

AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".flac", ".m4a")
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
                m = re.match(r"(\S+\.(?:wav|mp3|ogg|flac|m4a))\s+(-?[\d.]+)", line, re.IGNORECASE)
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


def parse_ini_metadata(path: str) -> Dict[str, Any]:
    """
    Parses Choicer Voicer per-clip .ini / .txt files:
    [data]
    caption="“Fear? NO This is not fear...”"
    image="nodt.png"
    dub_timestamps=[0] or [8.9]
    dub_characters=["Nodt"]
    """
    data = {}
    if not os.path.isfile(path):
        return data
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        for key in ("caption", "dub_timestamps", "dub_characters", "image"):
            m = re.search(rf'{key}\s*=\s*(.+)', content)
            if not m:
                continue
            val = m.group(1).strip()
            if key == "caption":
                data[key] = val.strip('"').strip('“').strip('”').strip()
            elif key == "dub_timestamps":
                nums = re.findall(r'[\d.]+', val)
                if nums:
                    data[key] = float(nums[0])
            elif key == "dub_characters":
                names = re.findall(r'["\']([^"\']+)["\']', val)
                if names:
                    data[key] = names[0].strip()
                else:
                    clean = re.sub(r'[\[\]"\']', '', val).strip()
                    if clean:
                        data[key] = clean
            elif key == "image":
                data[key] = val.strip('"').strip("'").strip()
    except Exception as ex:
        print(f"[pack_loader] Error reading ini {path}: {ex}")
    return data


def parse_pack_info(folder: str) -> Dict[str, Any]:
    """
    Parses Choicer Voicer _pack_info.ini:
    [data]
    title="Nodt crashout"
    subtitle="top 5 toughest quincys"
    icon="nodt.png"
    authors=["ChickenGobln"]
    """
    info = {"title": None, "subtitle": None, "icon": None, "authors": []}
    for cand in ("_pack_info.ini", "pack_info.ini"):
        path = os.path.join(folder, cand)
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                m_title = re.search(r'title\s*=\s*["\']([^"\']+)["\']', content)
                if m_title:
                    info["title"] = m_title.group(1).strip()
                m_sub = re.search(r'subtitle\s*=\s*["\']([^"\']+)["\']', content)
                if m_sub:
                    info["subtitle"] = m_sub.group(1).strip()
                m_icon = re.search(r'icon\s*=\s*["\']([^"\']+)["\']', content)
                if m_icon:
                    info["icon"] = m_icon.group(1).strip()
                m_auth = re.search(r'authors\s*=\s*(.+)', content)
                if m_auth:
                    authors = re.findall(r'["\']([^"\']+)["\']', m_auth.group(1))
                    if authors:
                        info["authors"] = [a.strip() for a in authors if a.strip()]
                    else:
                        clean = re.sub(r'[\[\]"\']', '', m_auth.group(1)).strip()
                        if clean:
                            info["authors"] = [clean]
            except Exception:
                pass
            break
    return info


def extract_character_and_caption(caption_text: str, filename: str) -> tuple[str, str]:
    """
    Extracts character name and display caption text from a raw caption string and filename.
    Handles:
    - Standard brackets: '[Levi] "You are..."' -> ('Levi', 'You are...')
    - Nested brackets: '[Kennys main helper [female]] Captain?' -> ('Kennys main helper [female]', 'Captain?')
    - Only speaker tag: '[Zeke] ' -> ('Zeke', '')
    - Colon prefix: 'Levi: Look out!' -> ('Levi', 'Look out!')
    - No caption: '' -> ('Zeke' from filename, '')
    """
    raw = (caption_text or "").strip()
    char_name = None
    display_cap = ""

    if raw.startswith("["):
        depth = 0
        end_idx = -1
        for i, ch in enumerate(raw):
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    end_idx = i
                    break
        if end_idx != -1:
            candidate = raw[1:end_idx].strip()
            if candidate:
                char_name = candidate
            display_cap = raw[end_idx + 1:].strip('“"” :-\t ')
        else:
            m = re.match(r"^\[([^\]]+)\](.*)$", raw)
            if m:
                char_name = m.group(1).strip()
                display_cap = m.group(2).strip('“"” :-\t ')
    elif ":" in raw and not raw.startswith("http"):
        parts = raw.split(":", 1)
        if len(parts[0].split()) <= 4 and not any(p in parts[0] for p in ('/', '\\', '.')):
            char_name = parts[0].strip('“"” ')
            display_cap = parts[1].strip('“"” ')
    else:
        display_cap = raw.strip('“"” ')

    if not char_name:
        stem = os.path.splitext(filename)[0]
        clean = re.sub(r"^\d+[_\-]", "", stem)
        clean = re.sub(r"_\d+-\d{1,3}$", "", clean)
        clean = re.sub(r"_\d+$", "", clean)
        clean = clean.replace("_", " ").strip()
        char_name = clean if clean else "Narrator"

    return char_name, display_cap


def extract_character_from_caption_or_name(caption: str, filename: str) -> str:
    """Extracts character name safely supporting nested brackets and fallbacks."""
    char_name, _ = extract_character_and_caption(caption, filename)
    return char_name


_DETECTED_ENCODER = None


def get_h264_encoder_args(crf: int = 22, usage: str = "export") -> List[str]:
    """
    Returns optimal FFmpeg video encoder arguments dynamically tuned for any system:
    1. NVIDIA NVENC (GeForce / RTX)
    2. AMD AMF (Radeon RX)
    3. Intel QuickSync (Intel Arc / Core i3/i5/i7/i9)
    4. Apple Silicon VideoToolbox (macOS M1/M2/M3/M4)
    5. Universal Multi-Threaded CPU (libx264 scaled to available cores)
    """
    global _DETECTED_ENCODER
    if _DETECTED_ENCODER is None:
        ff = get_ffmpeg_path()
        candidates = [
            ("h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p4"]),
            ("h264_amf", ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed"]),
            ("h264_qsv", ["-c:v", "h264_qsv", "-preset", "veryfast"]),
            ("h264_videotoolbox", ["-c:v", "h264_videotoolbox", "-b:v", "5000k"]),
        ]
        for name, probe_args in candidates:
            try:
                test_cmd = [
                    ff, "-y", "-f", "lavfi", "-i", "testsrc=duration=0.1:size=640x360:rate=30",
                    *probe_args, "-f", "null", "-"
                ]
                res = subprocess.run(test_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if res.returncode == 0:
                    _DETECTED_ENCODER = name
                    break
            except Exception:
                continue

        if _DETECTED_ENCODER is None:
            _DETECTED_ENCODER = "libx264"

    # Hardware-specific parameters
    if _DETECTED_ENCODER == "h264_nvenc":
        preset = "p2" if usage == "web_preview" else "p4"
        return ["-c:v", "h264_nvenc", "-preset", preset, "-b:v", "4000k" if usage == "web_preview" else "6000k"]

    if _DETECTED_ENCODER == "h264_amf":
        quality = "speed" if usage == "web_preview" else "quality"
        bitrate = "2500k" if usage == "web_preview" else "5000k"
        return ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", quality, "-rc", "cbr", "-b:v", bitrate]

    if _DETECTED_ENCODER == "h264_qsv":
        preset = "faster" if usage == "web_preview" else "veryfast"
        return ["-c:v", "h264_qsv", "-preset", preset, "-b:v", "3000k" if usage == "web_preview" else "5000k"]

    if _DETECTED_ENCODER == "h264_videotoolbox":
        bitrate = "3000k" if usage == "web_preview" else "5000k"
        return ["-c:v", "h264_videotoolbox", "-b:v", bitrate]

    # Universal multi-threaded CPU fallback (dynamically scales to 50%-75% of available CPU cores, max 8)
    cpu_cores = os.cpu_count() or 4
    threads = str(max(1, min(cpu_cores, 8)))
    preset = "faster" if usage == "web_preview" else "veryfast"
    return ["-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-threads", threads]


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
        self.subtitle: Optional[str] = None
        self.authors: List[str] = []
        self.pack_type: str = "dubstage"  # "dubstage" | "choicer_voicer"
        self.icon_path: Optional[str] = None
        self.video_path: Optional[str] = None
        self.web_video_path: Optional[str] = None
        self.backing_track_path: Optional[str] = None
        self.duration: float = 0.0
        self.lines: List[Dict[str, Any]] = []
        self.characters: List[str] = []

    @property
    def has_icon(self) -> bool:
        return bool(self.icon_path and os.path.isfile(self.icon_path))

    def ensure_web_ready(self):
        """Ensures the web video is converted to web-ready MP4."""
        cached = os.path.join(CACHE_DIR, f"{self.pack_id}_web.mp4")
        if not os.path.isfile(cached) or os.path.getsize(cached) < 1000:
            if transcode_to_mp4(self.video_path, cached):
                self.web_video_path = cached

    def to_dict(self) -> Dict[str, Any]:
        quoted_id = urllib.parse.quote(self.pack_id)
        has_icon = bool(self.icon_path and os.path.isfile(self.icon_path))
        return {
            "id": self.pack_id,
            "name": self.name,
            "title": self.name,
            "subtitle": self.subtitle,
            "authors": self.authors,
            "pack_type": self.pack_type,
            "has_icon": has_icon,
            "icon_url": f"/api/packs/{quoted_id}/icon" if has_icon else None,
            "duration": round(self.duration, 2),
            "line_count": len(self.lines),
            "characters": self.characters,
            "has_backing": self.backing_track_path is not None,
            "video_url": f"/api/packs/{quoted_id}/video",
            "backing_url": f"/api/packs/{quoted_id}/backing" if self.backing_track_path else None,
            "lines": self.lines,
        }


def find_pack_icon(folder: str, icon_hint: Optional[str] = None) -> Optional[str]:
    """Finds pack cover art / icon file."""
    if icon_hint:
        cand = os.path.join(folder, icon_hint)
        if os.path.isfile(cand):
            return cand
        # Sometimes icon hint has mismatched extension like .png vs .png.png
        for f in os.listdir(folder):
            if f.lower().startswith(os.path.splitext(icon_hint)[0].lower()) and f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                return os.path.join(folder, f)

    # Search common cover names
    common = ("icon.png", "cover.png", "cover.jpg", "thumb.png", "thumb.jpg", "banner.png", "banner.jpg")
    for c in common:
        cand = os.path.join(folder, c)
        if os.path.isfile(cand):
            return cand

    # Search any png or jpg that isn't a take
    for f in sorted(os.listdir(folder)):
        low = f.lower()
        if low.endswith((".png", ".jpg", ".jpeg", ".webp")) and not low.startswith("take_"):
            return os.path.join(folder, f)

    return None


def ensure_dubstage_compatibility(pack_folder: str, pack: PackInfo):
    """
    Auto-generates standard _captions.json and _TIMESTAMPS.txt for Choicer Voicer packs
    so they are 100% compatible with both DubMate and vanilla DubStage.
    """
    try:
        captions_path = os.path.join(pack_folder, "_captions.json")
        if not os.path.isfile(captions_path) and pack.lines:
            captions_map = {}
            for l in pack.lines:
                cap = (l.get("caption") or "").strip()
                captions_map[l["filename"]] = f"[{l['character']}] {cap}" if cap else f"[{l['character']}]"
            with open(captions_path, "w", encoding="utf-8") as f:
                json.dump(captions_map, f, ensure_ascii=False, indent=2)

        ts_path = os.path.join(pack_folder, "_TIMESTAMPS.txt")
        if not os.path.isfile(ts_path) and pack.lines:
            lines_out = [
                f"# {pack.name}",
                "# Auto-generated DubStage timestamps and subtitle map",
                "# File | start time (s) | subtitle\n"
            ]
            for l in pack.lines:
                cap = (l.get("caption") or "").strip()
                sub = f"[{l['character']}] {cap}" if cap else f"[{l['character']}]"
                lines_out.append(f"{l['filename']:<40} {l['start']:>10.3f}s   | {sub}")
            with open(ts_path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines_out) + "\n")
    except Exception as ex:
        print(f"[pack_loader] Could not write DubStage compatibility files for {pack_folder}: {ex}")


def load_pack(pack_folder: str) -> Optional[PackInfo]:
    """Loads and indexes a single pack folder, supporting both DubStage and Choicer Voicer formats."""
    if not os.path.isdir(pack_folder):
        return None

    # 1. Video detection
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
    info_meta = parse_pack_info(pack_folder)
    pack_name = info_meta.get("title") or pack_id.replace("_", " ").title()

    pack = PackInfo(pack_id=pack_id, folder=pack_folder, name=pack_name)
    pack.subtitle = info_meta.get("subtitle")
    pack.authors = info_meta.get("authors") or []
    pack.icon_path = find_pack_icon(pack_folder, info_meta.get("icon"))
    pack.video_path = video_path
    pack.web_video_path = get_web_video_path(pack_folder, video_path)
    pack.duration = probe_duration(pack.web_video_path)

    # 2. Backing track detection
    for f in os.listdir(pack_folder):
        low = f.lower()
        if low.startswith("_backing_track") and any(low.endswith(ext) for ext in AUDIO_EXTS):
            pack.backing_track_path = os.path.join(pack_folder, f)
            break

    # 3. Detect Format & Dialogue Lines
    # Check for Choicer Voicer .ini / .txt metadata files first
    candidate_meta_files = sorted([
        f for f in os.listdir(pack_folder)
        if (f.lower().endswith(".ini") or f.lower().endswith(".txt"))
        and not f.startswith("_")
        and not f.lower().startswith("readme")
    ])

    entries = []
    for meta_name in candidate_meta_files:
        meta_full = os.path.join(pack_folder, meta_name)
        meta = parse_ini_metadata(meta_full)
        if meta.get("dub_timestamps") is None:
            continue

        stem = os.path.splitext(meta_name)[0]
        # Find matching audio stem
        audio_file = None
        for ext in AUDIO_EXTS:
            cand = stem + ext
            if os.path.isfile(os.path.join(pack_folder, cand)):
                audio_file = cand
                break

        if not audio_file:
            # Fallback: check if audio stem matches by substring or extension
            for f in os.listdir(pack_folder):
                if f.lower().startswith(stem.lower()) and any(f.lower().endswith(ext) for ext in AUDIO_EXTS):
                    audio_file = f
                    break

        if audio_file:
            ts = meta["dub_timestamps"]
            char = meta.get("dub_characters") or "Actor"
            cap = meta.get("caption") or ""
            img = meta.get("image")
            entries.append({
                "filename": audio_file,
                "start": ts,
                "character": char,
                "caption": cap,
                "image": img,
            })

    if entries:
        pack.pack_type = "choicer_voicer"

    if not entries:
        # DubStage standard format
        pack.pack_type = "dubstage"
        ts_from_txt = read_timestamps_txt(pack_folder)
        captions = read_captions(pack_folder)

        raw_files = []
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
                raw_files.append((f, ts))

        for f, ts in raw_files:
            caption_text = captions.get(f, "")
            char_name, display_caption = extract_character_and_caption(caption_text, f)
            entries.append({
                "filename": f,
                "start": ts,
                "character": char_name,
                "caption": display_caption,
                "image": None,
            })

    if not entries:
        return None

    # Sort all dialogue lines chronologically by start timestamp
    entries.sort(key=lambda x: x["start"])

    character_set = set()
    lines = []
    for i, entry in enumerate(entries):
        filename = entry["filename"]
        start_ts = entry["start"]
        char_name = entry["character"]
        caption_text = entry["caption"]
        character_set.add(char_name)

        audio_full_path = os.path.join(pack_folder, filename)
        line_duration = probe_duration(audio_full_path)

        quoted_pack_id = urllib.parse.quote(pack_id)
        quoted_filename = urllib.parse.quote(filename)

        lines.append({
            "index": i,
            "filename": filename,
            "character": char_name,
            "start": round(start_ts, 3),
            "duration": round(line_duration, 3),
            "end": round(start_ts + line_duration, 3),
            "caption": caption_text,
            "raw_caption": f"[{char_name}] {caption_text}" if caption_text else f"[{char_name}]",
            "audio_url": f"/api/packs/{quoted_pack_id}/audio/{quoted_filename}",
            "image": entry.get("image"),
        })

    pack.lines = lines
    char_counts = {}
    for l in lines:
        c = l["character"]
        char_counts[c] = char_counts.get(c, 0) + 1
    pack.characters = sorted(list(character_set), key=lambda c: -char_counts.get(c, 0))

    # Auto-generate DubStage compatibility files if missing
    ensure_dubstage_compatibility(pack_folder, pack)

    return pack


def import_pack_archive(archive_path_or_bytes: Any, archive_filename: str = "pack.zip") -> Optional[PackInfo]:
    """
    Extracts a Choicer Voicer or DubStage zip archive, identifies pack root,
    installs into Packs directory, and returns initialized PackInfo.
    """
    import zipfile
    tmp_extract_dir = tempfile.mkdtemp(prefix="dubmate_import_")
    try:
        if isinstance(archive_path_or_bytes, (bytes, bytearray)):
            tmp_zip = os.path.join(tmp_extract_dir, "upload.zip")
            with open(tmp_zip, "wb") as f:
                f.write(archive_path_or_bytes)
            with zipfile.ZipFile(tmp_zip, "r") as z:
                z.extractall(tmp_extract_dir)
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)
        else:
            with zipfile.ZipFile(archive_path_or_bytes, "r") as z:
                z.extractall(tmp_extract_dir)

        # Locate the pack root folder inside the extracted contents
        pack_root = None
        for dirpath, _dirnames, filenames in os.walk(tmp_extract_dir):
            has_video = any(f.lower().startswith("dub_video.") for f in filenames)
            has_clips = any(f.lower().endswith(AUDIO_EXTS) for f in filenames)
            if has_video and has_clips:
                pack_root = dirpath
                break

        if not pack_root:
            print(f"[pack_loader] No valid pack found in archive {archive_filename}")
            return None

        # Determine target folder name
        meta = parse_pack_info(pack_root)
        base_title = meta.get("title") or os.path.splitext(os.path.basename(archive_filename))[0]
        safe_folder_name = re.sub(r'[^A-Za-z0-9 _\-]+', '', base_title).strip() or "Imported_Pack"

        target_base = PACKS_DIRS[0]
        os.makedirs(target_base, exist_ok=True)
        dest_folder = os.path.join(target_base, safe_folder_name)

        if os.path.exists(dest_folder):
            shutil.rmtree(dest_folder)

        shutil.copytree(pack_root, dest_folder)
        loaded = load_pack(dest_folder)
        if loaded:
            print(f"[pack_loader] Successfully imported pack '{loaded.name}' into {dest_folder}")
            return loaded

    except Exception as ex:
        print(f"[pack_loader] Error importing pack archive {archive_filename}: {ex}")
    finally:
        if os.path.exists(tmp_extract_dir):
            shutil.rmtree(tmp_extract_dir, ignore_errors=True)

    return None


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
                if pack and pack.pack_id not in packs:
                    packs[pack.pack_id] = pack
    return packs
