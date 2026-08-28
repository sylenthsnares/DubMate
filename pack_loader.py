# -*- coding: utf-8 -*-
"""
pack_loader.py
Scans, parses, and normalizes DubMate native scene packs and Choicer Voicer packs.
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
from typing import Dict, List, Optional, Any, Tuple

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PACKS_DIRS = [
    os.path.join(BASE_DIR, "Packs"),
]
CACHE_DIR = os.path.join(BASE_DIR, ".cache")
os.makedirs(CACHE_DIR, exist_ok=True)

def get_config_path() -> str:
    """Returns the persistent config file path in user home or project base dir."""
    user_home = os.path.expanduser("~")
    dubmate_home = os.path.join(user_home, ".dubmate")
    try:
        os.makedirs(dubmate_home, exist_ok=True)
        return os.path.join(dubmate_home, "config.json")
    except Exception:
        return os.path.join(BASE_DIR, "dubmate_config.json")


def load_config() -> Dict[str, Any]:
    """Loads configuration from persistent disk storage."""
    config_file = get_config_path()
    if os.path.isfile(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception as ex:
            print(f"[pack_loader] Error reading config file {config_file}: {ex}")
    return {}


def save_config(config_data: Dict[str, Any]) -> bool:
    """Saves configuration to persistent disk storage."""
    config_file = get_config_path()
    try:
        os.makedirs(os.path.dirname(config_file), exist_ok=True)
        tmp_file = config_file + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=2)
        if os.path.exists(config_file):
            os.replace(tmp_file, config_file)
        else:
            os.rename(tmp_file, config_file)
        return True
    except Exception as ex:
        print(f"[pack_loader] Error saving config file {config_file}: {ex}")
        return False


def get_default_packs_dir() -> str:
    """Returns default project packs directory."""
    return os.path.join(BASE_DIR, "Packs")


def init_pack_dirs():
    """Initializes PACKS_DIRS from saved config and defaults."""
    global PACKS_DIRS
    dirs = []
    cfg = load_config()
    custom_dir = cfg.get("packs_dir")
    if custom_dir and os.path.isdir(custom_dir):
        norm = os.path.abspath(custom_dir)
        if norm not in dirs:
            dirs.append(norm)

    extra_dirs = cfg.get("extra_packs_dirs", [])
    if isinstance(extra_dirs, list):
        for ed in extra_dirs:
            if ed and os.path.isdir(ed):
                norm = os.path.abspath(ed)
                if norm not in dirs:
                    dirs.append(norm)

    # Always ensure default project Packs/ is included
    default_p = os.path.abspath(get_default_packs_dir())
    if default_p not in dirs and os.path.exists(default_p):
        dirs.append(default_p)

    # Also fallback to relative Packs/ if running in another CWD
    cwd_packs = os.path.abspath(os.path.join(os.getcwd(), "Packs"))
    if cwd_packs not in dirs and os.path.exists(cwd_packs):
        dirs.append(cwd_packs)

    if not dirs:
        dirs.append(default_p)

    PACKS_DIRS = dirs


def set_custom_packs_dir(path_str: str) -> Tuple[bool, str, int]:
    """
    Sets and persists a custom pack directory.
    Validates folder existence, handles single-pack folders by indexing their parent,
    persists to config.json, refreshes PACKS_DIRS, and clears cache for a fresh scan.
    Returns: (success, message, pack_count)
    """
    if not path_str or not str(path_str).strip():
        return False, "Pack folder path cannot be empty.", 0

    clean_path = str(path_str).strip().strip('"').strip("'")
    resolved_path = os.path.abspath(os.path.expanduser(clean_path))

    if not os.path.exists(resolved_path):
        return False, f"Directory does not exist: {resolved_path}", 0

    if not os.path.isdir(resolved_path):
        return False, f"Path is not a valid directory: {resolved_path}", 0

    # Check if the user pointed directly to a single scene pack folder (e.g. contains dub_video.* or clips)
    is_single_pack = False
    try:
        entries = os.listdir(resolved_path)
        has_video = any(f.lower().startswith("dub_video.") or any(f.lower().endswith(ext) for ext in VIDEO_EXTS) for f in entries)
        has_clips = any(f.lower().endswith(AUDIO_EXTS) for f in entries)
        if has_video or has_clips:
            is_single_pack = True
    except Exception:
        pass

    target_dir = resolved_path
    if is_single_pack:
        parent_dir = os.path.dirname(resolved_path)
        if parent_dir and os.path.isdir(parent_dir):
            target_dir = parent_dir

    # Save to config
    cfg = load_config()
    cfg["packs_dir"] = target_dir
    save_config(cfg)

    # Re-initialize PACKS_DIRS
    init_pack_dirs()

    # Clear memory cache
    PACK_OBJECT_CACHE.clear()

    # Scan and count
    all_packs = get_all_packs(force_disk_scan=True)
    count = len(all_packs)

    if count == 0:
        return True, f"Configured '{target_dir}', but 0 valid scene packs were found in that folder.", count

    return True, f"Successfully loaded {count} scene pack(s) from '{target_dir}'.", count


def get_current_packs_config() -> Dict[str, Any]:
    """Returns information about active packs directory and configuration."""
    cfg = load_config()
    active_primary = PACKS_DIRS[0] if PACKS_DIRS else get_default_packs_dir()
    all_packs = get_all_packs()
    return {
        "packs_dir": cfg.get("packs_dir") or active_primary,
        "default_packs_dir": get_default_packs_dir(),
        "scanned_paths": [os.path.abspath(d) for d in PACKS_DIRS if os.path.exists(d)],
        "config_file": get_config_path(),
        "pack_count": len(all_packs),
    }

# Initialize PACKS_DIRS on startup
init_pack_dirs()

AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".flac", ".m4a")
VIDEO_EXTS = (".mp4", ".ogv", ".mkv", ".webm", ".mov", ".avi")
SAFE_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
SAFE_TEXT_EXTS = (".ini", ".txt", ".json", ".csv")
ALLOWED_PACK_EXTS = AUDIO_EXTS + VIDEO_EXTS + SAFE_IMAGE_EXTS + SAFE_TEXT_EXTS

# Dangerous executable / script extensions that must trigger instant security rejection
PROHIBITED_EXTENSIONS = (
    ".exe", ".dll", ".so", ".dylib", ".bin", ".com", ".scr", ".msi", ".pif", ".app",
    ".bat", ".cmd", ".ps1", ".psm1", ".sh", ".bash", ".zsh", ".vbs", ".vbe", ".js",
    ".jse", ".wsf", ".wsh", ".mjs", ".py", ".pyw", ".pyc", ".pyd", ".php", ".phtml",
    ".hta", ".reg", ".jar", ".class", ".cgi", ".pl", ".rb", ".elf", ".iso", ".img",
    ".sys", ".drv", ".cpl", ".inf", ".ins", ".isp", ".lnk", ".url", ".desktop"
)

# Archive extraction security limits
MAX_ARCHIVE_SIZE_BYTES = 500 * 1024 * 1024       # 500 MB max zip upload
MAX_UNCOMPRESSED_SIZE_BYTES = 1200 * 1024 * 1024  # 1.2 GB max uncompressed total
MAX_ARCHIVE_FILE_COUNT = 500                     # 500 entries max
MAX_COMPRESSION_RATIO = 50.0                     # Max uncompressed / compressed ratio

class PackSecurityError(Exception):
    """Raised when an imported pack violates security rules or contains malware/dangerous files."""
    pass

class PackValidationError(Exception):
    """Raised when an imported pack is corrupted or missing required pack structure."""
    pass

# Memory cache for fast pack indexing: full_path -> (mtime, PackInfo)
PACK_OBJECT_CACHE: Dict[str, tuple[float, Any]] = {}

_TS_REGEX = re.compile(r"_(\d+)-(\d{1,3})(?:\.[A-Za-z0-9]+)?$")


def get_ffmpeg_path() -> str:
    """Finds ffmpeg binary in project-local tools folder or system PATH."""
    # 1. Project-local tools directory (Windows .exe or Unix binary)
    for name in ("ffmpeg.exe", "ffmpeg"):
        local_tool = os.path.join(BASE_DIR, "tools", name)
        if os.path.isfile(local_tool) and (os.access(local_tool, os.X_OK) or name.endswith(".exe")):
            return local_tool
    # 2. System PATH fallback
    tool = shutil.which("ffmpeg")
    if tool:
        return tool
    return "ffmpeg"


def get_ffprobe_path() -> str:
    """Finds ffprobe binary in project-local tools folder or system PATH."""
    # 1. Project-local tools directory (Windows .exe or Unix binary)
    for name in ("ffprobe.exe", "ffprobe"):
        local_tool = os.path.join(BASE_DIR, "tools", name)
        if os.path.isfile(local_tool) and (os.access(local_tool, os.X_OK) or name.endswith(".exe")):
            return local_tool
    # 2. System PATH fallback
    tool = shutil.which("ffprobe")
    if tool:
        return tool
    return "ffprobe"


def get_deep_filter_path() -> Optional[str]:
    """Finds deep-filter binary in project-local tools folder or system PATH."""
    for name in ("deep-filter.exe", "deep-filter"):
        local_tool = os.path.join(BASE_DIR, "tools", name)
        if os.path.isfile(local_tool) and (os.access(local_tool, os.X_OK) or name.endswith(".exe")):
            return local_tool
    tool = shutil.which("deep-filter")
    if tool:
        return tool
    return None


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


PEAKS_CACHE_DIR = os.path.join(CACHE_DIR, "peaks")
os.makedirs(PEAKS_CACHE_DIR, exist_ok=True)


def extract_waveform_peaks_from_file(file_path: str, columns: int = 100) -> List[List[float]]:
    """Calculates min/max peak pairs for a dialogue line audio file."""
    if not os.path.exists(file_path) or columns <= 0:
        return [[0.0, 0.0] for _ in range(columns)]
    
    # 1. Try fast wave read if uncompressed WAV
    if file_path.lower().endswith(".wav"):
        try:
            with wave.open(file_path, "rb") as w:
                n_frames = w.getnframes()
                n_channels = w.getnchannels()
                sampwidth = w.getsampwidth()
                if n_frames > 0 and sampwidth in (1, 2, 4):
                    raw = w.readframes(n_frames)
                    if sampwidth == 2:
                        dtype = "<i2"
                        scale = 32768.0
                    elif sampwidth == 1:
                        dtype = "u1"
                        scale = 128.0
                    else:
                        dtype = "<i4"
                        scale = 2147483648.0
                    
                    import numpy as np
                    samples = np.frombuffer(raw, dtype=dtype).astype(np.float32) / scale
                    if n_channels > 1:
                        samples = samples[::n_channels]
                    
                    n = len(samples)
                    step = n / float(columns)
                    peaks = []
                    for c in range(columns):
                        a = int(c * step)
                        b = max(a + 1, int((c + 1) * step))
                        chunk = samples[a:b]
                        if len(chunk) > 0:
                            peaks.append([round(float(chunk.min()), 3), round(float(chunk.max()), 3)])
                        else:
                            peaks.append([0.0, 0.0])
                    return peaks
        except Exception:
            pass

    # 2. Fallback via ffmpeg PCM pipe
    try:
        ffmpeg = get_ffmpeg_path()
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", file_path, "-ac", "1", "-ar", "22050",
            "-f", "s16le", "-"
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        raw, _ = proc.communicate()
        if proc.returncode == 0 and len(raw) > 0:
            import numpy as np
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            n = len(samples)
            step = n / float(columns)
            peaks = []
            for c in range(columns):
                a = int(c * step)
                b = max(a + 1, int((c + 1) * step))
                chunk = samples[a:b]
                if len(chunk) > 0:
                    peaks.append([round(float(chunk.min()), 3), round(float(chunk.max()), 3)])
                else:
                    peaks.append([0.0, 0.0])
            return peaks
    except Exception:
        pass

    return [[0.0, 0.0] for _ in range(columns)]


def get_cached_line_peaks(pack_id: str, filename: str, file_path: str, columns: int = 100) -> List[List[float]]:
    """Retrieves cached peaks or calculates and caches peaks for a dialogue line."""
    safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', f"{pack_id}_{filename}") + ".json"
    cache_path = os.path.join(PEAKS_CACHE_DIR, safe_name)
    try:
        if os.path.isfile(cache_path):
            file_mtime = os.path.getmtime(file_path) if os.path.exists(file_path) else 0
            cache_mtime = os.path.getmtime(cache_path)
            if cache_mtime >= file_mtime:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached_data = json.load(f)
                if isinstance(cached_data, list) and len(cached_data) == columns:
                    return cached_data
    except Exception:
        pass

    peaks = extract_waveform_peaks_from_file(file_path, columns)
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(peaks, f)
    except Exception:
        pass
    return peaks


def get_cached_line_loudness(pack_id: str, filename: str, file_path: str) -> float:
    """Retrieves cached speech loudness or calculates and caches it for a dialogue line."""
    safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', f"{pack_id}_{filename}") + "_loudness.json"
    cache_path = os.path.join(PEAKS_CACHE_DIR, safe_name)
    try:
        if os.path.isfile(cache_path):
            file_mtime = os.path.getmtime(file_path) if os.path.exists(file_path) else 0
            cache_mtime = os.path.getmtime(cache_path)
            if cache_mtime >= file_mtime:
                with open(cache_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, (int, float)):
                    return float(data)
    except Exception:
        pass

    import audio_processor
    try:
        if os.path.isfile(file_path):
            audio_data = audio_processor.read_wav_mono(file_path)
            loudness = audio_processor.calculate_speech_gated_loudness(audio_data)
        else:
            loudness = -21.0
    except Exception:
        loudness = -21.0

    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(loudness, f)
    except Exception:
        pass
    return loudness


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
    Parses pack metadata from pack.json (DubMate native) or _pack_info.ini (Choicer Voicer).
    """
    info = {"title": None, "subtitle": None, "icon": None, "authors": []}

    # 1. DubMate native pack.json
    json_path = os.path.join(folder, "pack.json")
    if os.path.isfile(json_path):
        try:
            with open(json_path, "r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
            if isinstance(data, dict):
                info["title"] = data.get("title") or data.get("name")
                info["subtitle"] = data.get("subtitle")
                info["icon"] = data.get("icon")
                auths = data.get("authors")
                if isinstance(auths, list):
                    info["authors"] = [str(a).strip() for a in auths if str(a).strip()]
                elif isinstance(auths, str) and auths.strip():
                    info["authors"] = [auths.strip()]
                return info
        except Exception:
            pass

    # 2. Choicer Voicer _pack_info.ini
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


_DETECTED_ENCODER: Optional[str] = None
_CACHED_ENCODER_INFO: Optional[Dict[str, Any]] = None


def preflight_probe_hardware_encoder() -> Dict[str, Any]:
    """
    Probes system video encoding capabilities and caches optimal hardware encoder settings.
    Logs clear diagnostics and ensures zero-latency runtime exports.
    """
    global _DETECTED_ENCODER, _CACHED_ENCODER_INFO
    if _CACHED_ENCODER_INFO is not None:
        return _CACHED_ENCODER_INFO

    ff = get_ffmpeg_path()
    candidates = [
        ("h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p4"], "NVIDIA NVENC (GeForce / RTX)", "NVIDIA", True),
        ("h264_amf", ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed"], "AMD AMF (Radeon RX)", "AMD", True),
        ("h264_qsv", ["-c:v", "h264_qsv", "-preset", "veryfast"], "Intel QuickSync (Arc / Core iGPU)", "Intel", True),
        ("h264_videotoolbox", ["-c:v", "h264_videotoolbox", "-b:v", "5000k"], "Apple Silicon VideoToolbox (M1/M2/M3/M4)", "Apple", True),
    ]

    detected = None
    for name, probe_args, desc, vendor, is_hw in candidates:
        try:
            test_cmd = [
                ff, "-y", "-f", "lavfi", "-i", "testsrc=duration=0.1:size=640x360:rate=30",
                *probe_args, "-f", "null", "-"
            ]
            res = subprocess.run(test_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if res.returncode == 0:
                detected = {
                    "encoder": name,
                    "description": desc,
                    "vendor": vendor,
                    "is_hardware": is_hw,
                }
                _DETECTED_ENCODER = name
                break
        except Exception:
            continue

    if detected is None:
        cpu_cores = os.cpu_count() or 4
        threads = max(1, min(cpu_cores, 8))
        detected = {
            "encoder": "libx264",
            "description": f"Universal Multi-Core CPU (libx264 - {threads} threads)",
            "vendor": "CPU",
            "is_hardware": False,
            "threads": threads,
        }
        _DETECTED_ENCODER = "libx264"

    _CACHED_ENCODER_INFO = detected
    badge = "[Hardware Accelerated]" if detected["is_hardware"] else "[Multi-Core CPU]"
    print(f"[DubMate Acceleration] {badge} {detected['description']}")
    return _CACHED_ENCODER_INFO


def get_hardware_encoder_info() -> Dict[str, Any]:
    """Returns cached hardware encoder info, running pre-flight probe if needed."""
    if _CACHED_ENCODER_INFO is None:
        return preflight_probe_hardware_encoder()
    return _CACHED_ENCODER_INFO


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
        preflight_probe_hardware_encoder()

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
    tmp_target = target_mp4_path + ".tmp.mp4"
    encoder_args = get_h264_encoder_args(crf=25, usage="web_preview")
    
    # 1. Attempt with primary detected encoder
    try:
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
        if os.path.isfile(tmp_target) and os.path.getsize(tmp_target) > 100:
            os.replace(tmp_target, target_mp4_path)
            return True
    except Exception as ex:
        print(f"[transcode_to_mp4] Primary encoder failed on {orig_video_path}: {ex}. Trying CPU libx264...")

    # 2. Fallback to CPU libx264
    try:
        cpu_cores = os.cpu_count() or 4
        threads = str(max(1, min(cpu_cores, 8)))
        fallback_args = ["-c:v", "libx264", "-crf", "25", "-preset", "faster", "-threads", threads]
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", orig_video_path,
            "-vf", "scale='min(1280,iw)':-2",
            "-r", "30",
            *fallback_args,
            "-pix_fmt", "yuv420p",
            "-an",
            "-movflags", "+faststart",
            tmp_target
        ]
        subprocess.run(cmd, check=True)
        if os.path.isfile(tmp_target) and os.path.getsize(tmp_target) > 100:
            os.replace(tmp_target, target_mp4_path)
            return True
    except Exception as ex:
        print(f"[transcode_to_mp4] Fallback CPU transcode failed on {orig_video_path}: {ex}")
    finally:
        if os.path.exists(tmp_target):
            try:
                os.remove(tmp_target)
            except Exception:
                pass
    return False


class PackInfo:
    def __init__(self, pack_id: str, folder: str, name: str):
        self.pack_id = pack_id
        self.folder = folder
        self.name = name
        self.subtitle: Optional[str] = None
        self.authors: List[str] = []
        self.pack_type: str = "dubmate"  # "dubmate" | "choicer_voicer"
        self.icon_path: Optional[str] = None
        self.video_path: Optional[str] = None
        self.web_video_path: Optional[str] = None
        self.backing_track_path: Optional[str] = None
        self.duration: float = 0.0
        self.lines: List[Dict[str, Any]] = []
        self.characters: List[str] = []
        self.mean_vocal_loudness_db: float = -21.0

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
            "export_url": f"/api/packs/{quoted_id}/export",
            "mean_vocal_loudness_db": getattr(self, "mean_vocal_loudness_db", -21.0),
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


def ensure_pack_compatibility(pack_folder: str, pack: PackInfo):
    """
    Auto-generates standard _captions.json and _TIMESTAMPS.txt for Choicer Voicer packs
    so they are 100% compatible with DubMate native format.
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
                "# Auto-generated DubMate timestamps and subtitle map",
                "# File | start time (s) | subtitle\n"
            ]
            for l in pack.lines:
                cap = (l.get("caption") or "").strip()
                sub = f"[{l['character']}] {cap}" if cap else f"[{l['character']}]"
                lines_out.append(f"{l['filename']:<40} {l['start']:>10.3f}s   | {sub}")
            with open(ts_path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines_out) + "\n")
    except Exception as ex:
        print(f"[pack_loader] Could not write compatibility files for {pack_folder}: {ex}")


def load_pack(pack_folder: str) -> Optional[PackInfo]:
    """Loads and indexes a single pack folder, supporting both DubMate and Choicer Voicer formats."""
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
        # DubMate standard format
        pack.pack_type = "dubmate"
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
        peaks = get_cached_line_peaks(pack_id, filename, audio_full_path, 100)
        ref_loudness = get_cached_line_loudness(pack_id, filename, audio_full_path)

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
            "peaks": peaks,
            "reference_loudness_db": ref_loudness,
            "image": entry.get("image"),
        })

    pack.lines = lines
    if pack.duration <= 0.0 and lines:
        pack.duration = max(l["end"] for l in lines)
    valid_loudness = [l["reference_loudness_db"] for l in lines if l.get("reference_loudness_db") is not None and l.get("reference_loudness_db") > -55.0]
    import numpy as np
    pack.mean_vocal_loudness_db = round(float(np.mean(valid_loudness)), 1) if valid_loudness else -21.0

    char_counts = {}
    for l in lines:
        c = l["character"]
        char_counts[c] = char_counts.get(c, 0) + 1
    pack.characters = sorted(list(character_set), key=lambda c: -char_counts.get(c, 0))

    # Auto-generate standard compatibility files if missing
    ensure_pack_compatibility(pack_folder, pack)

    return pack


def import_pack_archive(archive_path_or_bytes: Any, archive_filename: str = "pack.zip") -> Optional[PackInfo]:
    """
    Extracts a Choicer Voicer or DubMate zip archive, validates signatures,
    enforces strict anti-malware and zip-slip security checks, identifies pack root,
    installs into Packs directory, and returns initialized PackInfo.
    """
    import zipfile
    import io

    # 1. Magic Bytes / Header Signature Verification
    if isinstance(archive_path_or_bytes, (bytes, bytearray)):
        raw_bytes = bytes(archive_path_or_bytes)
        if len(raw_bytes) < 4 or raw_bytes[:4] not in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
            raise PackSecurityError("Invalid file signature: Uploaded file is not a valid ZIP archive.")
        zip_source = io.BytesIO(raw_bytes)
    else:
        if not os.path.isfile(archive_path_or_bytes):
            raise PackSecurityError("Pack archive file not found.")
        with open(archive_path_or_bytes, "rb") as fh:
            header = fh.read(4)
            if header not in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
                raise PackSecurityError("Invalid file signature: Uploaded file is not a valid ZIP archive.")
        zip_source = archive_path_or_bytes

    tmp_extract_dir = tempfile.mkdtemp(prefix="dubmate_import_")
    try:
        with zipfile.ZipFile(zip_source, "r") as z:
            infolist = z.infolist()
            
            # 2. File Count and Size Limit Checks (Anti-DoS & Zip-Bomb)
            if len(infolist) > MAX_ARCHIVE_FILE_COUNT:
                raise PackSecurityError(f"Archive contains too many entries ({len(infolist)} > {MAX_ARCHIVE_FILE_COUNT}).")

            total_uncompressed = sum(info.file_size for info in infolist)
            if total_uncompressed > MAX_UNCOMPRESSED_SIZE_BYTES:
                raise PackSecurityError(
                    f"Archive uncompressed size ({round(total_uncompressed / (1024 * 1024), 1)} MB) "
                    f"exceeds maximum allowed limit ({MAX_UNCOMPRESSED_SIZE_BYTES // (1024 * 1024)} MB)."
                )

            total_compressed = sum(info.compress_size for info in infolist)
            if total_compressed > 0 and (total_uncompressed / float(total_compressed)) > MAX_COMPRESSION_RATIO:
                raise PackSecurityError("Suspicious compression ratio detected (potential Zip Bomb attack).")

            # 3. Path Traversal & Malware / Prohibited File Extension Verification
            canonical_tmp_dir = os.path.abspath(tmp_extract_dir)
            for info in infolist:
                norm_name = info.filename.replace("\\", "/")
                
                # Check directory traversal
                if ".." in norm_name or norm_name.startswith("/") or re.match(r'^[a-zA-Z]:', norm_name):
                    raise PackSecurityError(f"Directory traversal detected in archive path: '{info.filename}'")

                # Sanitize member path to ensure it stays strictly within sandbox
                dest_path = os.path.abspath(os.path.join(tmp_extract_dir, info.filename))
                if not dest_path.startswith(canonical_tmp_dir + os.sep) and dest_path != canonical_tmp_dir:
                    raise PackSecurityError(f"Zip-slip path traversal attempt: '{info.filename}'")

                low_name = norm_name.lower().rstrip()
                base_name = os.path.basename(low_name)
                
                # Skip macOS metadata or harmless system files
                if base_name in (".ds_store", "thumbs.db", "desktop.ini", ".gitkeep") or "__macosx" in low_name:
                    continue

                # Block all prohibited executable, script, and system extensions
                if any(low_name.endswith(ext) for ext in PROHIBITED_EXTENSIONS):
                    raise PackSecurityError(f"Security Alert: Prohibited executable or script file detected in archive: '{base_name}'")

                # Block disguised executable extensions e.g. 'video.mp4.exe' or 'line.wav.bat'
                if any(ext + "." in low_name for ext in (".exe", ".dll", ".bat", ".cmd", ".ps1", ".vbs", ".sh", ".py")):
                    raise PackSecurityError(f"Security Alert: Disguised executable detected in archive: '{base_name}'")

                # Check strict whitelist for non-directory files
                if not info.is_dir() and not low_name.endswith("/"):
                    _, ext = os.path.splitext(base_name)
                    if ext and ext not in ALLOWED_PACK_EXTS:
                        raise PackSecurityError(
                            f"Security Alert: Disallowed file extension '{ext}' in '{base_name}'. "
                            f"DubMate packs only accept audio ({', '.join(AUDIO_EXTS)}), "
                            f"video ({', '.join(VIDEO_EXTS)}), images, and text/ini subtitle files."
                        )

            # 4. Safe Sandboxed Extraction
            for info in infolist:
                if "__MACOSX" in info.filename or os.path.basename(info.filename).lower() in (".ds_store", "thumbs.db"):
                    continue
                z.extract(info, tmp_extract_dir)

        # 5. Pack Root Detection & Structure Verification
        pack_root = None
        for dirpath, _dirnames, filenames in os.walk(tmp_extract_dir):
            has_video = any(f.lower().startswith("dub_video.") or any(f.lower().endswith(ext) for ext in VIDEO_EXTS) for f in filenames)
            has_clips = any(f.lower().endswith(AUDIO_EXTS) for f in filenames)
            if has_video and has_clips:
                pack_root = dirpath
                break

        if not pack_root:
            raise PackValidationError(
                "Archive does not contain a valid scene dub pack. "
                "A valid pack must include at least one scene video (e.g. dub_video.mp4) and dialogue audio clips."
            )

        # 6. Safe Destination Sanitization & Installation
        meta = parse_pack_info(pack_root)
        base_title = meta.get("title") or os.path.splitext(os.path.basename(archive_filename))[0]
        safe_folder_name = re.sub(r'[^A-Za-z0-9 _\-]+', '', base_title).strip() or "Imported_Pack"

        target_base = PACKS_DIRS[0]
        os.makedirs(target_base, exist_ok=True)
        dest_folder = os.path.join(target_base, safe_folder_name)

        # Ensure dest_folder resolves strictly within target_base
        if not os.path.abspath(dest_folder).startswith(os.path.abspath(target_base) + os.sep):
            raise PackSecurityError("Invalid destination folder name.")

        if os.path.exists(dest_folder):
            shutil.rmtree(dest_folder)

        shutil.copytree(pack_root, dest_folder)
        loaded = load_pack(dest_folder)
        if loaded:
            folder_mtime = os.path.getmtime(dest_folder)
            PACK_OBJECT_CACHE[dest_folder] = (folder_mtime, loaded)
            print(f"[pack_loader] Successfully validated, security-cleared, and imported pack '{loaded.name}' into {dest_folder}")
            return loaded

        raise PackValidationError("Pack files extracted but could not be parsed into a playable studio scene.")

    finally:
        if os.path.exists(tmp_extract_dir):
            shutil.rmtree(tmp_extract_dir, ignore_errors=True)


def import_multiple_pack_archives(archives: List[Tuple[Any, str]]) -> Dict[str, Any]:
    """
    Imports multiple pack .zip archives in a single batch with isolated per-pack validation.
    Returns summary reporting total, imported packs, and quarantined errors.
    """
    imported_packs: List[PackInfo] = []
    errors: List[Dict[str, str]] = []

    for content_bytes, filename in archives:
        try:
            if len(content_bytes) > MAX_ARCHIVE_SIZE_BYTES:
                errors.append({"filename": filename, "error": "Archive exceeds maximum 500 MB upload limit."})
                continue

            pack = import_pack_archive(content_bytes, archive_filename=filename)
            if pack:
                imported_packs.append(pack)
            else:
                errors.append({"filename": filename, "error": "Could not parse valid scene pack structure."})
        except Exception as ex:
            errors.append({"filename": filename, "error": str(ex)})

    return {
        "status": "ok" if imported_packs else ("error" if errors else "empty"),
        "total": len(archives),
        "imported_count": len(imported_packs),
        "failed_count": len(errors),
        "packs": [p.to_dict() for p in imported_packs],
        "errors": errors,
    }


def import_pack_folder_tree(files_with_paths: List[Tuple[bytes, str]]) -> Dict[str, Any]:
    """
    Imports an entire directory tree containing one or multiple unpacked scene packs or nested zip archives.
    Maintains security sandboxing:
    - Rejects path traversal (..)
    - Blocks executable binaries and dangerous scripts
    - Recursively scans discovered pack root folders (directories with dub_video + audio lines)
    - Automatically unpacks and installs each scene pack into Packs/
    """
    tmp_stage_dir = tempfile.mkdtemp(prefix="dubmate_folder_import_")
    canonical_stage = os.path.abspath(tmp_stage_dir)
    imported_packs: List[PackInfo] = []
    errors: List[Dict[str, str]] = []

    try:
        # 1. Stage all uploaded files into temporary sandbox directory
        for content, rel_path in files_with_paths:
            # Normalize path separators
            clean_rel = rel_path.replace("\\", "/").strip("/")
            norm_path = os.path.normpath(clean_rel)

            if ".." in norm_path.split(os.sep):
                continue

            base_name = os.path.basename(norm_path).lower()
            if any(base_name.endswith(ext) for ext in PROHIBITED_EXTENSIONS):
                continue

            dest = os.path.abspath(os.path.join(tmp_stage_dir, norm_path))
            if not dest.startswith(canonical_stage + os.sep):
                continue

            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(content)

        # 2. Check for any nested .zip files first
        for root, _dirs, files in os.walk(tmp_stage_dir):
            for f in files:
                if f.lower().endswith(".zip"):
                    zip_full = os.path.join(root, f)
                    try:
                        with open(zip_full, "rb") as zf:
                            pack = import_pack_archive(zf.read(), archive_filename=f)
                            if pack:
                                imported_packs.append(pack)
                    except Exception as ex:
                        errors.append({"filename": f, "error": str(ex)})

        # 3. Discover all distinct unpacked scene pack root directories in the staged tree
        discovered_pack_roots = []
        for dirpath, _dirnames, filenames in os.walk(tmp_stage_dir):
            has_video = any(f.lower().startswith("dub_video.") or any(f.lower().endswith(ext) for ext in VIDEO_EXTS) for f in filenames)
            has_clips = any(f.lower().endswith(AUDIO_EXTS) for f in filenames)
            if has_video and has_clips:
                # Ensure we don't pick subdirectories if parent is already a pack root
                is_sub = False
                for p_root in discovered_pack_roots:
                    if dirpath.startswith(p_root + os.sep):
                        is_sub = True
                        break
                if not is_sub:
                    discovered_pack_roots.append(dirpath)

        # 4. Install each discovered unpacked pack
        target_base = PACKS_DIRS[0]
        os.makedirs(target_base, exist_ok=True)

        for pack_root in discovered_pack_roots:
            try:
                meta = parse_pack_info(pack_root)
                base_title = meta.get("title") or os.path.basename(pack_root)
                safe_folder_name = re.sub(r'[^A-Za-z0-9 _\-]+', '', base_title).strip() or "Imported_Pack"
                dest_folder = os.path.join(target_base, safe_folder_name)

                if not os.path.abspath(dest_folder).startswith(os.path.abspath(target_base) + os.sep):
                    continue

                if os.path.exists(dest_folder):
                    shutil.rmtree(dest_folder)

                shutil.copytree(pack_root, dest_folder)
                loaded = load_pack(dest_folder)
                if loaded:
                    folder_mtime = os.path.getmtime(dest_folder)
                    PACK_OBJECT_CACHE[dest_folder] = (folder_mtime, loaded)
                    imported_packs.append(loaded)
                    print(f"[pack_loader] Successfully installed unpacked pack '{loaded.name}' into {dest_folder}")
            except Exception as ex:
                errors.append({"filename": os.path.basename(pack_root), "error": str(ex)})

    finally:
        if os.path.exists(tmp_stage_dir):
            shutil.rmtree(tmp_stage_dir, ignore_errors=True)

    return {
        "status": "ok" if imported_packs else "error",
        "total": len(imported_packs) + len(errors),
        "imported_count": len(imported_packs),
        "failed_count": len(errors),
        "packs": [p.to_dict() for p in imported_packs],
        "errors": errors,
    }


def get_all_packs(force_disk_scan: bool = False) -> Dict[str, PackInfo]:
    """
    Scans all pack directories with ultra-fast folder mtime caching.
    Returns dictionary of pack_id -> PackInfo.
    """
    packs = {}
    for base in PACKS_DIRS:
        if not os.path.isdir(base):
            continue
        try:
            entries = sorted(os.listdir(base))
        except Exception:
            continue
        for item in entries:
            if item.startswith(".") or item.startswith("__"):
                continue
            full_path = os.path.join(base, item)
            if not os.path.isdir(full_path):
                continue
            try:
                folder_mtime = os.path.getmtime(full_path)
            except Exception:
                folder_mtime = 0

            # Fast cache lookup: avoid expensive re-reading of 40+ folders
            if not force_disk_scan and full_path in PACK_OBJECT_CACHE:
                cached_mtime, cached_pack = PACK_OBJECT_CACHE[full_path]
                if cached_mtime == folder_mtime and cached_pack:
                    packs[cached_pack.pack_id] = cached_pack
                    continue

            pack = load_pack(full_path)
            if pack:
                PACK_OBJECT_CACHE[full_path] = (folder_mtime, pack)
                if pack.pack_id not in packs:
                    packs[pack.pack_id] = pack
    return packs


def export_pack_archive(pack_id_or_folder: str, output_zip_path: Optional[str] = None) -> str:
    """
    Packages an entire scene pack folder into a clean, portable .zip archive.
    Returns the absolute path to the generated .zip file.
    """
    import zipfile

    # 1. Resolve pack folder
    pack_folder = None
    if os.path.isdir(pack_id_or_folder):
        pack_folder = os.path.abspath(pack_id_or_folder)
    else:
        for base in PACKS_DIRS:
            candidate = os.path.join(base, pack_id_or_folder)
            if os.path.isdir(candidate):
                pack_folder = os.path.abspath(candidate)
                break

    if not pack_folder or not os.path.isdir(pack_folder):
        raise FileNotFoundError(f"Pack folder not found for '{pack_id_or_folder}'")

    pack_name = os.path.basename(os.path.normpath(pack_folder))
    safe_name = re.sub(r'[^A-Za-z0-9 _\-]+', '', pack_name).strip() or "scene_pack"

    # 2. Determine destination zip path
    if not output_zip_path:
        exports_dir = os.path.join(CACHE_DIR, "exports", "packs")
        os.makedirs(exports_dir, exist_ok=True)
        output_zip_path = os.path.join(exports_dir, f"{safe_name}.zip")
    else:
        os.makedirs(os.path.dirname(os.path.abspath(output_zip_path)), exist_ok=True)

    # 3. Create zip archive containing all pack assets at the root of the archive
    with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(pack_folder):
            dirs[:] = [d for d in dirs if not d.startswith(".") and not d.startswith("__")]
            for file in sorted(files):
                if file.startswith(".") or file.startswith("__") or file.endswith(".tmp"):
                    continue
                file_abs = os.path.join(root, file)
                rel_path = os.path.relpath(file_abs, pack_folder)
                zf.write(file_abs, arcname=rel_path)

    return output_zip_path


