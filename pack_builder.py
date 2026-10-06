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
import sys
import json
import time
import datetime
import shutil
import hashlib
import importlib
import threading
import subprocess
from typing import Dict, List, Optional, Tuple, Any

import numpy as np

import pack_loader
import audio_processor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class MissingPipelineError(RuntimeError):
    """
    The optional Pack Builder AI pipeline is not installed.

    Distinct from a generic RuntimeError so app.py can answer with a code the UI
    acts on -- pointing at the installer that already exists in the app -- instead
    of printing "pip install -r requirements_builder.txt" at someone who just
    wants to dub a clip.
    """


class StaleYtDlpError(RuntimeError):
    """
    A link import failed and the installed yt-dlp is old enough to be the likely cause.

    Kept apart from a generic RuntimeError so the API passes this message through
    instead of the catch-all "check the link" text, which sends the user hunting for
    a problem with their link.

    str(error) is the short, outcome-first line. `details` holds the steps to update,
    which can include a full folder path, so the UI keeps them out of the headline.
    """

    def __init__(self, message: str, details: str = ""):
        super().__init__(message)
        self.details = details


def ensure_ai_packages_on_path():
    """
    Adds the optional Pack Builder AI pipeline directory to sys.path.

    The desktop build installs torch/demucs/whisper/yt-dlp into '<app dir>/ai-packages'
    via 'pip install --target'. The launcher also passes that directory through
    PYTHONPATH, but the Windows embeddable Python distribution ignores PYTHONPATH
    whenever a '._pth' file is present, so relying on the environment variable alone
    would leave the pipeline installed-but-unimportable. Adding it here works in both
    the embedded desktop runtime and a normal virtualenv.
    """
    # The desktop installer puts these at the install root, which is one level above
    # BASE_DIR in a packaged build (Python files are staged into 'resources').
    candidates = [
        os.path.join(pack_loader.get_install_root(), "ai-packages"),
        os.path.join(BASE_DIR, "ai-packages"),
    ]
    for ai_dir in candidates:
        if os.path.isdir(ai_dir) and ai_dir not in sys.path:
            sys.path.insert(0, ai_dir)


ensure_ai_packages_on_path()
BUILDER_CACHE_DIR = os.path.join(pack_loader.CACHE_DIR, "builder")
try:
    os.makedirs(BUILDER_CACHE_DIR, exist_ok=True)
except Exception:
    pass

def ensure_tools_in_path():
    """Prepends project tools directory to PATH so external libraries (Whisper, Demucs) find ffmpeg."""
    tools_dir = os.path.join(BASE_DIR, "tools")
    if os.path.isdir(tools_dir):
        current_path = os.environ.get("PATH", "")
        if tools_dir not in current_path:
            os.environ["PATH"] = tools_dir + os.pathsep + current_path

ensure_tools_in_path()

_WHISPER_MODELS: Dict[Tuple[str, str], Any] = {}
_WHISPER_LOCK = threading.Lock()

def get_whisper_model(model_size: str, device: str) -> Any:
    """Returns a cached loaded Whisper model to prevent multi-second disk/RAM reload stalls."""
    import whisper
    key = (model_size, device)
    with _WHISPER_LOCK:
        if key not in _WHISPER_MODELS:
            print(f"[PackBuilder] Loading Whisper ({model_size}) onto {device.upper()} (cached)...")
            _WHISPER_MODELS[key] = whisper.load_model(model_size, device=device)
        return _WHISPER_MODELS[key]


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
        # Machine-readable companion to `error`, so the wizard can route a missing
        # pipeline to the installer instead of just printing the message.
        self.error_code: Optional[str] = None
        # Non-fatal notice, e.g. neural separation unavailable and a basic filter
        # was used instead. Shown alongside a successful result.
        self.warning: Optional[str] = None
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
                "error_code": self.error_code,
                "warning": self.warning,
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
    try:
        res = pack_loader.run_subprocess(cmd, timeout=pack_loader.SUBPROCESS_TIMEOUT_RENDER,
                                         context="audio extraction of " + repr(video_path),
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        extract_error = (res.stderr or "").strip()
        if os.path.isfile(output_wav) and os.path.getsize(output_wav) >= 100:
            return output_wav
    except subprocess.CalledProcessError as ex:
        extract_error = (ex.stderr or "").strip()

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
    try:
        pack_loader.run_subprocess(silent_cmd, timeout=pack_loader.SUBPROCESS_TIMEOUT_PROCESS,
                                   context="silent audio generation for " + repr(video_path),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if os.path.isfile(output_wav):
            return output_wav
    except (subprocess.CalledProcessError, RuntimeError):
        pass

    print(f"[PackBuilder] Audio extraction failed: {extract_error or 'unknown error'}")
    raise RuntimeError("Couldn't read the audio in this video. Try a different file.")


# Captions are written under their own prefix so the scan below cannot confuse them
# with the media file, and so a stale caption from an earlier attempt is easy to spot.
SUBTITLE_FILE_PREFIX = "caption"


def preferred_subtitle_langs(info: Dict[str, Any]) -> List[str]:
    """
    The video's own language plus English, never 'all'.

    Asking for 'all' expanded to ~157 machine-translated ASR tracks, which is both
    what tripped YouTube's rate limiter and useless for dubbing -- a Bengali ASR
    track auto-translated into Abkhaz is not a dialogue script. Only languages the
    video actually publishes are requested, so we never ask for a track that cannot
    exist.
    """
    available = set()
    for key in ("subtitles", "automatic_captions"):
        tracks = info.get(key) or {}
        if isinstance(tracks, dict):
            available.update(tracks.keys())

    wanted: List[str] = []
    for candidate in (info.get("language"), "en"):
        base = (candidate or "").split("-")[0].strip().lower()
        if not base or base in wanted:
            continue
        # Accept an exact match or a regional variant the video actually offers.
        matches = [t for t in available if t.split("-")[0].lower() == base]
        if matches:
            wanted.append(sorted(matches, key=len)[0])
    return wanted


def fetch_subtitles_best_effort(
    yt_dlp_module,
    url: str,
    info: Dict[str, Any],
    output_dir: str,
    base_opts: Dict[str, Any],
) -> List[str]:
    """
    Downloads captions for an already-downloaded video, swallowing every failure.

    Captions only pre-seed the dialogue timeline so Whisper can be skipped; when they
    are missing, transcribe_audio() produces the same result from the isolated vocals
    stem. Nothing here is allowed to fail the import.
    """
    langs = preferred_subtitle_langs(info)
    if not langs:
        return []

    sub_opts = dict(base_opts)
    sub_opts.update({
        'skip_download': True,
        'writethumbnail': False,
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitleslangs': langs,
        'subtitlesformat': 'srt/vtt/best',
        # Own template: yt-dlp otherwise names captions after the media file, and the
        # scan that reads them skips source_video.* -- so they were downloaded and
        # then silently ignored.
        'outtmpl': {'default': os.path.join(output_dir, f"{SUBTITLE_FILE_PREFIX}.%(ext)s")},
        # One quick attempt. A caption fetch is not worth making the user wait.
        'retries': 1,
        'socket_timeout': 10,
        'ignoreerrors': True,
    })

    try:
        with yt_dlp_module.YoutubeDL(sub_opts) as ydl:
            ydl.download([url])
    except Exception as ex:
        print(f"[PackBuilder] Captions unavailable ({ex}); Whisper will transcribe instead.")
        return []

    found = sorted(
        f for f in os.listdir(output_dir)
        if f.startswith(f"{SUBTITLE_FILE_PREFIX}.") and (f.endswith(".srt") or f.endswith(".vtt"))
    )
    if not found:
        print("[PackBuilder] No captions published for this video; Whisper will transcribe instead.")
    return found


# yt-dlp versions are release dates (YYYY.MM.DD). Sites change their players often
# enough that a release this old is the most likely reason a link stops working.
YTDLP_STALE_AFTER_DAYS = 60


def ytdlp_age_days(version: str, today: Optional[datetime.date] = None) -> Optional[int]:
    """Days since the yt-dlp release named by `version`, or None if it isn't a date."""
    match = re.match(r"^\s*(\d{4})\.(\d{1,2})\.(\d{1,2})", str(version or ""))
    if not match:
        return None
    try:
        released = datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None
    return max(0, ((today or datetime.date.today()) - released).days)


def stale_ytdlp_error(yt_dlp_module, today: Optional[datetime.date] = None) -> Optional[StaleYtDlpError]:
    """
    The user-facing error for a failed import when yt-dlp is out of date, or None
    when it is recent enough (or its age can't be told) to not be the suspect.

    The update steps depend on where yt-dlp lives. The desktop app installs it once
    into 'ai-packages' and never upgrades it in place, so the only way to a newer
    version there is to let the launcher download Pack Builder again. A source install
    gets it from requirements_builder.txt, which update.bat / update.sh upgrade.
    """
    try:
        version = yt_dlp_module.version.__version__
    except AttributeError:
        version = getattr(yt_dlp_module, "__version__", "")
    age = ytdlp_age_days(version, today)
    if age is None or age <= YTDLP_STALE_AFTER_DAYS:
        return None

    print(f"[PackBuilder] yt-dlp {version} is {age} days old; suggesting an update.")
    message = "Couldn't import that video. Pack Builder needs an update."
    package_dir = os.path.dirname(os.path.abspath(getattr(yt_dlp_module, "__file__", "") or ""))
    install_dir = os.path.dirname(package_dir)
    if os.path.basename(install_dir).lower() == "ai-packages":
        details = (
            "Close DubMate, delete this folder, then open DubMate again. "
            f"Pack Builder downloads again (about 2 GB).\n{install_dir}"
        )
    else:
        details = (
            "Run update.bat (Windows) or update.sh (macOS and Linux) in your DubMate folder, "
            "then restart DubMate."
        )
    return StaleYtDlpError(message, details)


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
        raise ValueError("Paste a video link first.")

    clean_url = url.strip()

    try:
        import yt_dlp
    except ImportError:
        raise MissingPipelineError(
            "Importing from a link needs the Pack Builder tools, which aren't installed yet."
        )

    os.makedirs(output_dir, exist_ok=True)
    video_out_tmpl = os.path.join(output_dir, "source_video.%(ext)s")
    thumb_out_tmpl = os.path.join(output_dir, "cover.%(ext)s")
    ffmpeg_bin = pack_loader.get_ffmpeg_path()
    ffmpeg_dir = os.path.dirname(ffmpeg_bin) if os.path.isfile(ffmpeg_bin) else ffmpeg_bin

    # Options for yt-dlp optimized for reliability, anti-throttling & signature decryption.
    #
    # Subtitles are deliberately NOT requested here. yt-dlp writes subtitles *before*
    # it fetches the media stream, so a caption failure aborted the whole import with
    # zero video bytes downloaded -- reported to the user as "Failed to download video",
    # which pointed at the wrong thing entirely. Captions are only an optimization
    # (see fetch_subtitles_best_effort), so they are fetched separately afterwards
    # where a failure costs nothing.
    ydl_opts = {
        'format': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        'outtmpl': {
            'default': video_out_tmpl,
            'thumbnail': thumb_out_tmpl,
        },
        'merge_output_format': 'mp4',
        'ffmpeg_location': ffmpeg_dir,
        'writethumbnail': True,
        'noplaylist': True,
        'quiet': True,
        # Warnings stay on: YouTube silently drops adaptive formats when a PO token
        # is missing, and swallowing that made a 360p fallback look like a 1080p
        # download. These land in the engine log, not in the user's face.
        'nocheckcertificate': True,
        'socket_timeout': 30,
        'retries': 5,
        'fragment_retries': 5,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        'max_filesize': pack_loader.MAX_ARCHIVE_SIZE_BYTES,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(clean_url, download=True)
            if not info:
                raise ValueError("Couldn't read that link. Check it and try again.")

            title = info.get("title") or "Imported YouTube Scene"
            duration = float(info.get("duration") or 0.0)
            if duration > max_duration_seconds:
                raise ValueError(
                    f"This video is {duration/60:.1f} minutes long. Scenes can be up to {max_duration_seconds/60:.0f} minutes."
                )
    except Exception as ex:
        err_msg = str(ex)
        if "Unsupported URL" in err_msg or "is not a valid URL" in err_msg:
            raise ValueError("That link isn't supported. Use a YouTube link or a direct video link.")
        # Our own messages above (too long, unreadable link) are not yt-dlp's fault.
        stale = None if isinstance(ex, ValueError) else stale_ytdlp_error(yt_dlp)
        if stale:
            print(f"[PackBuilder] URL import failed on an outdated yt-dlp: {err_msg}")
            raise stale
        raise RuntimeError(f"Failed to download video with yt-dlp: {err_msg}")

    # Best-effort captions, after the video is safely on disk.
    fetch_subtitles_best_effort(yt_dlp, clean_url, info, output_dir, ydl_opts)

    # Find the downloaded source_video file (must be a valid video container, not info.json or image)
    VIDEO_CONTAINER_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".ts", ".m4v"}
    raw_video_path = None
    for f in os.listdir(output_dir):
        ext = os.path.splitext(f)[1].lower()
        if f.startswith("source_video.") and not f.endswith(".part") and ext in VIDEO_CONTAINER_EXTS:
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
    try:
        pack_loader.run_subprocess(transcode_cmd, timeout=pack_loader.SUBPROCESS_TIMEOUT_RENDER,
                                   context="URL import transcode of " + repr(raw_video_path),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        transcoded = os.path.isfile(standardized_mp4) and os.path.getsize(standardized_mp4) > 1000
    except (subprocess.CalledProcessError, RuntimeError):
        transcoded = False
    if transcoded:
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

    # Find and parse subtitles if available. Prefer our own caption.* files; the
    # broader scan is a fallback for captions supplied by other means.
    subtitle_segments = []
    candidates = sorted(
        (f for f in os.listdir(output_dir) if f.endswith(".srt") or f.endswith(".vtt")),
        key=lambda f: (not f.startswith(f"{SUBTITLE_FILE_PREFIX}."), f),
    )
    for f in candidates:
        if not f.startswith("source_video.") and not f.startswith("scene_video."):
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
            fallback_reason = "not_installed"
            print("[PackBuilder] Demucs package not installed; using the basic filter instead.")
        except Exception as ex:
            fallback_reason = "failed"
            print(f"[PackBuilder] Demucs execution failed: {ex}. Falling back to the basic filter.")
    else:
        fallback_reason = "not_installed"

    # Fallback: Apply DSP center-channel vocal attenuation for backing track.
    # This is markedly worse than neural separation, so it is reported rather than
    # quietly substituted -- the user was promised AI vocal isolation.
    print("[PackBuilder] Applying DSP center-channel vocal attenuation filter for backing track...")
    shutil.copyfile(audio_wav, vocals_out)
    success = attenuate_vocals_dsp(audio_wav, backing_out)
    if not success:
        shutil.copyfile(audio_wav, backing_out)
    return {
        "vocals": vocals_out,
        "backing": backing_out,
        "separated": success,
        "device": "dsp_filter",
        "used_fallback": True,
        "fallback_reason": fallback_reason,
        "fallback_notice": (
            "Voice separation isn't installed, so a basic filter was used. "
            "Some background sound may stay in the dialogue."
            if fallback_reason == "not_installed" else
            "Voice separation couldn't run, so a basic filter was used. "
            "Some background sound may stay in the dialogue."
        ),
    }


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
    try:
        pack_loader.run_subprocess(cmd, timeout=pack_loader.SUBPROCESS_TIMEOUT_RENDER,
                                   context="vocal attenuation of " + repr(input_wav),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, RuntimeError):
        return False
    return os.path.isfile(output_wav) and os.path.getsize(output_wav) > 100


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


def _whisper_options(device: str, language: Optional[str], romanize: bool) -> Tuple[Dict[str, Any], bool]:
    """
    Whisper transcribe() options shared by transcribe_segment and transcribe_audio.
    Returns (options, romanize); a 'romaji' language request also turns romanization on.
    """
    opts: Dict[str, Any] = {
        "verbose": False,
        "fp16": (device == "cuda"),
        "condition_on_previous_text": False,
        "compression_ratio_threshold": 2.4,
        "no_speech_threshold": 0.6,
    }
    romanize = bool(romanize or (language and "romaji" in language.lower()))
    whisper_lang = "ja" if (language and "ja" in language.lower()) else language
    if whisper_lang and whisper_lang.strip().lower() not in ("auto", "none"):
        opts["language"] = whisper_lang.strip().lower()
    return opts, romanize


def transcribe_segment(audio_wav: str, start: float, end: float, model_size: str = "base", language: Optional[str] = None, romanize: bool = False) -> str:
    """
    Transcribes a specific time slice [start, end] using Whisper on-demand.
    Returns the recognized speech text string (with optional Romaji romanization).
    """
    _, _, device = detect_torch_and_cuda()

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
        pack_loader.run_subprocess(cmd, timeout=pack_loader.SUBPROCESS_TIMEOUT_PROCESS,
                                   context="segment slice for transcription",
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        temp_slice = audio_wav

    try:
        import whisper
        print(f"[PackBuilder] Transcribing segment [{start:.2f}s - {end:.2f}s] with Whisper on {device.upper()}...")
        model = get_whisper_model(model_size, device=device)
        transcribe_opts, is_romaji_req = _whisper_options(device, language, romanize)

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
    _, _, device = detect_torch_and_cuda()

    try:
        import whisper
        print(f"[PackBuilder] Running Whisper ({model_size}) transcription on {device.upper()}...")
        
        model = get_whisper_model(model_size, device=device)
        transcribe_opts, is_romaji_req = _whisper_options(device, language, romanize)

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

    # Failures raise rather than returning []. Swallowing them produced a pack with
    # an empty timeline that the pipeline reported as a success, so the only message
    # the user ever got was "Please add at least 1 dialogue line before building" --
    # blaming them for something that broke upstream.
    except ImportError:
        raise MissingPipelineError(
            "Automatic transcription needs the Pack Builder tools, which aren't installed yet."
        )
    except Exception as ex:
        print(f"[PackBuilder] Whisper transcription failed: {ex}")
        raise RuntimeError(
            "We couldn't pick out any dialogue in this clip. "
            "You can still add lines yourself, or try a clearer clip."
        )


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


# Non-verbal lines (grunts, efforts, screams, laughs) found from voice activity on
# the separated voice stem. Every threshold lives here so tuning is one place.
NONVERBAL_FRAME_S = 0.02                 # analysis frame length (20 ms)
NONVERBAL_FLOOR_PERCENTILE = 20          # noise floor: this percentile of all frame levels
NONVERBAL_DIALOGUE_PERCENTILE = 75       # dialogue level: this percentile of frames inside transcribed lines
NONVERBAL_DIALOGUE_PERCENTILE_NO_LINES = 99  # ...or of all frames when there are no lines
NONVERBAL_ABOVE_FLOOR_DB = 15            # an active frame is at least this far above the floor
NONVERBAL_BELOW_DIALOGUE_DB = 30         # ...and no more than this far below dialogue
NONVERBAL_MIN_CONTRAST_DB = 20           # dialogue minus floor below this: too noisy to judge, find nothing
NONVERBAL_MERGE_GAP_S = 0.25             # active frames closer than this join one region
NONVERBAL_MIN_LEN_S = 0.3                # shorter regions are clicks or breaths
NONVERBAL_MAX_LEN_S = 8.0                # longer regions are music, tones or crowd
NONVERBAL_PEAK_WITHIN_DB = 10            # loudest frame within this of dialogue: foreground, not walla
NONVERBAL_LINE_MARGIN_S = 0.2            # keep this far from every transcribed line
NONVERBAL_PAD_S = 0.08                   # padding added around a kept region


def find_nonverbal_segments(samples: np.ndarray, sr: int, transcribed: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Finds clear vocal activity on the voice stem that no transcribed line covers.

    Returns new lines {start, end, text: "", character: "", nonverbal: True}. The
    rules are deliberately conservative: a missed grunt is one click to add, while
    a flood of breath and crowd lines is a chore to delete.
    """
    frame_len = int(round(NONVERBAL_FRAME_S * sr))
    n_frames = len(samples) // frame_len if frame_len > 0 else 0
    if n_frames == 0:
        return []
    frame_s = frame_len / float(sr)
    clip_end = len(samples) / float(sr)

    frames = np.asarray(samples[:n_frames * frame_len], dtype=np.float64).reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    level_db = 20.0 * np.log10(np.maximum(rms, 1e-10))

    lines = sorted(
        (float(s["start"]), float(s.get("end", s["start"]))) for s in transcribed
    )
    centers = (np.arange(n_frames) + 0.5) * frame_s
    in_lines = np.zeros(n_frames, dtype=bool)
    for start, end in lines:
        in_lines |= (centers >= start) & (centers <= end)

    floor_db = float(np.percentile(level_db, NONVERBAL_FLOOR_PERCENTILE))
    if in_lines.any():
        dialogue_db = float(np.percentile(level_db[in_lines], NONVERBAL_DIALOGUE_PERCENTILE))
    else:
        dialogue_db = float(np.percentile(level_db, NONVERBAL_DIALOGUE_PERCENTILE_NO_LINES))
    if dialogue_db - floor_db < NONVERBAL_MIN_CONTRAST_DB:
        return []
    threshold_db = max(floor_db + NONVERBAL_ABOVE_FLOOR_DB, dialogue_db - NONVERBAL_BELOW_DIALOGUE_DB)

    active = np.flatnonzero(level_db >= threshold_db)
    if active.size == 0:
        return []
    # Split the active frames wherever the silent gap reaches the merge gap.
    breaks = np.flatnonzero((np.diff(active) - 1) * frame_s >= NONVERBAL_MERGE_GAP_S)
    run_starts = np.concatenate(([0], breaks + 1))
    run_ends = np.concatenate((breaks, [active.size - 1]))

    found = []
    for a, b in zip(run_starts, run_ends):
        first, last = int(active[a]), int(active[b])
        start, end = first * frame_s, (last + 1) * frame_s
        if not (NONVERBAL_MIN_LEN_S <= end - start <= NONVERBAL_MAX_LEN_S):
            continue
        if float(level_db[first:last + 1].max()) < dialogue_db - NONVERBAL_PEAK_WITHIN_DB:
            continue
        if any(start < l_end + NONVERBAL_LINE_MARGIN_S and end > l_start - NONVERBAL_LINE_MARGIN_S
               for l_start, l_end in lines):
            continue
        lo = max([0.0] + [l_end for _, l_end in lines if l_end <= start])
        hi = min([clip_end] + [l_start for l_start, _ in lines if l_start >= end])
        found.append({
            "start": round(max(lo, start - NONVERBAL_PAD_S), 3),
            "end": round(min(hi, end + NONVERBAL_PAD_S), 3),
            "text": "",
            "character": "",
            "nonverbal": True,
        })
    return found


def add_nonverbal_segments(segments: List[Dict[str, Any]], vocals_wav: str, duration: float) -> List[Dict[str, Any]]:
    """
    Adds the voice stem's non-verbal lines to the transcribed ones, sorted by start.
    Any failure keeps the lines as they were: this is a bonus, never a reason to fail.
    """
    try:
        samples = audio_processor.read_wav_mono(vocals_wav, sr=16000)
        found = find_nonverbal_segments(samples, 16000, segments)
        if duration and duration > 0:
            found = [s for s in found if s["start"] < duration]
            for s in found:
                s["end"] = round(min(s["end"], float(duration)), 3)
        print(f"[PackBuilder] Found {len(found)} non-verbal lines on the voice track.")
        return sorted(list(segments) + found, key=lambda s: s["start"])
    except Exception as ex:
        print(f"[PackBuilder] Non-verbal line detection failed, keeping the transcribed lines: {ex}")
        return segments


SPEAKER_CLUSTER_THRESHOLD = 0.5   # lower splits voices more eagerly, higher merges them
SPEAKER_PACKAGES = ("sherpa-onnx==1.13.8", "sherpa-onnx-core==1.13.8")
SPEAKER_SEGMENTATION_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/"
    "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
SPEAKER_SEGMENTATION_ARCHIVE_SHA256 = "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
# (file name, url, sha256 of the file or None, member of the archive at url or None).
# The LICENSE has no pin of its own: it is read from the checksummed archive.
SPEAKER_MODELS = (
    ("pyannote-segmentation-3-0.onnx", SPEAKER_SEGMENTATION_URL,
     "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
     "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"),
    ("pyannote-segmentation-3-0.LICENSE", SPEAKER_SEGMENTATION_URL, None,
     "sherpa-onnx-pyannote-segmentation-3-0/LICENSE"),
    ("campplus-sv-zh-en-16k-common-advanced.onnx",
     # "recongition" is the real release tag name.
     "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
     "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
     "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
     None),
)
SPEAKER_NOTICE_NOT_INSTALLED = "Speaker detection isn't installed, so speakers were guessed from pauses. Check who says each line."
SPEAKER_NOTICE_NO_DOWNLOAD = "Couldn't download speaker detection, so speakers were guessed from pauses. Check who says each line."
SPEAKER_NOTICE_NO_VOICES = "Speaker detection couldn't tell the voices apart, so speakers were guessed from pauses. Check who says each line."
SPEAKER_NOTICE_FAILED = "Speaker detection couldn't run, so speakers were guessed from pauses. Check who says each line."

_SPEAKER_LOCK = threading.Lock()


def _addon_dir() -> Optional[str]:
    """
    The installed Pack Builder add-on folder, found the way the desktop app hands it over:
    the first sys.path entry named 'ai-packages' that holds the '.install-complete' marker.
    Not get_install_root(): on macOS the add-on and the engine sit in different folders.
    None for source installs.
    """
    for p in sys.path:
        if not p:
            continue
        if os.path.basename(os.path.normpath(p)).lower() == "ai-packages" and os.path.isfile(os.path.join(p, ".install-complete")):
            return p
    return None


def _speaker_models_dir() -> str:
    """Inside the add-on folder when there is one, so removing the Pack Builder removes the models too."""
    addon = _addon_dir()
    if addon:
        return os.path.join(addon, "dubmate-models", "speakers")
    return os.path.join(pack_loader.CACHE_DIR, "models", "speakers")


def _install_speaker_package(addon: str) -> bool:
    """
    Tops up a desktop add-on installed before speaker detection existed with the one
    pinned package. No --upgrade, so nothing already in the folder is replaced.
    """
    cmd = [sys.executable, "-m", "pip", "install", "--no-input", "--no-deps", "--target", addon, *SPEAKER_PACKAGES]
    try:
        with _SPEAKER_LOCK:
            res = subprocess.run(cmd, timeout=300, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if res.returncode != 0:
            tail = res.stderr or b""
            if isinstance(tail, bytes):
                tail = tail.decode("utf-8", "replace")
            print(f"[PackBuilder] Installing speaker detection failed ({res.returncode}): {tail[-400:]}")
            return False
        importlib.invalidate_caches()
        return True
    except Exception as ex:
        print(f"[PackBuilder] Installing speaker detection failed: {ex}")
        return False


def _download_to(url: str, path: str) -> str:
    """Streams url into path and returns its SHA-256 hex digest."""
    import urllib.request
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as resp, open(path, "wb") as out:
        for chunk in iter(lambda: resp.read(1 << 20), b""):
            out.write(chunk)
            digest.update(chunk)
    return digest.hexdigest()


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _ensure_speaker_models(on_progress=None) -> bool:
    """
    Downloads any missing speaker model into _speaker_models_dir(). Every file is written
    to '<file>.part', checked against its pinned SHA-256 and only then moved into place.
    on_progress(fraction) reports the files done out of the files missing. Returns False
    on any failure; the next build tries again.
    """
    import tarfile
    with _SPEAKER_LOCK:
        folder = _speaker_models_dir()
        missing = [m for m in SPEAKER_MODELS if not os.path.isfile(os.path.join(folder, m[0]))]
        if not missing:
            return True
        archives: Dict[str, str] = {}
        try:
            os.makedirs(folder, exist_ok=True)
            for done, (name, url, sha256, member) in enumerate(missing):
                if on_progress:
                    on_progress(done / len(missing))
                target = os.path.join(folder, name)
                part = target + ".part"
                try:
                    if member:
                        if url not in archives:
                            archives[url] = os.path.join(folder, os.path.basename(url) + ".part")
                            if _download_to(url, archives[url]) != SPEAKER_SEGMENTATION_ARCHIVE_SHA256:
                                raise ValueError(f"checksum mismatch for {url}")
                        digest = hashlib.sha256()
                        # Only the named member's bytes are read; nothing is extracted by path.
                        with tarfile.open(archives[url], "r:bz2") as tar:
                            src = tar.extractfile(tar.getmember(member))
                            if src is None:
                                raise ValueError(f"{member} is not a file")
                            with src, open(part, "wb") as out:
                                for chunk in iter(lambda: src.read(1 << 20), b""):
                                    out.write(chunk)
                                    digest.update(chunk)
                        got = digest.hexdigest()
                    else:
                        got = _download_to(url, part)
                    if sha256 and got != sha256:
                        raise ValueError(f"checksum mismatch for {name}")
                    os.replace(part, target)
                except Exception:
                    _remove_quietly(part)
                    raise
            if on_progress:
                on_progress(1.0)
            return True
        except Exception as ex:
            print(f"[PackBuilder] Downloading speaker detection failed: {ex}")
            return False
        finally:
            for archive in archives.values():
                _remove_quietly(archive)


def detect_speaker_turns(vocals_wav: str, on_progress=None) -> Tuple[Optional[List[Tuple[float, float, int]]], str]:
    """
    Finds who speaks when on the voice stem: ([(start, end, speaker_id), ...] by start, "").
    On any failure the turns are None and the notice says speakers were guessed from pauses.
    on_progress(fraction) runs 0.88-0.90 while downloading (first time only) and 0.90-0.98
    while detecting.
    """
    try:
        try:
            import sherpa_onnx
        except ImportError:
            addon = _addon_dir()
            if addon is None or not _install_speaker_package(addon):
                return None, SPEAKER_NOTICE_NOT_INSTALLED
            try:
                import sherpa_onnx
            except ImportError as ex:
                print(f"[PackBuilder] Speaker detection still can't load after installing: {ex}")
                return None, SPEAKER_NOTICE_NOT_INSTALLED

        if not _ensure_speaker_models((lambda f: on_progress(0.88 + 0.02 * f)) if on_progress else None):
            return None, SPEAKER_NOTICE_NO_DOWNLOAD

        folder = _speaker_models_dir()
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=os.path.join(folder, SPEAKER_MODELS[0][0]),
                    window_shift_ratio=0.1,
                ),
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=os.path.join(folder, SPEAKER_MODELS[2][0])),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=SPEAKER_CLUSTER_THRESHOLD),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise RuntimeError("speaker detection config is not valid")
        sd = sherpa_onnx.OfflineSpeakerDiarization(config)
        if sd.sample_rate != 16000:
            raise RuntimeError(f"unexpected sample rate {sd.sample_rate}")
        samples = np.ascontiguousarray(audio_processor.read_wav_mono(vocals_wav, sr=16000), dtype=np.float32)

        if on_progress:
            def _callback(done: int, total: int) -> int:
                on_progress(0.90 + 0.08 * min(1.0, done / max(1, total)))
                return 0
            on_progress(0.90)
            result = sd.process(samples, callback=_callback)
        else:
            result = sd.process(samples)
        turns = [(float(seg.start), float(seg.end), int(seg.speaker)) for seg in result.sort_by_start_time()]
        if not turns:
            return None, SPEAKER_NOTICE_NO_VOICES
        print(f"[PackBuilder] Found {len({t[2] for t in turns})} voices in {len(turns)} turns.")
        return turns, ""
    except Exception as ex:
        print(f"[PackBuilder] Speaker detection failed, guessing from pauses: {ex}")
        return None, SPEAKER_NOTICE_FAILED


def _turn_speaker(start: float, end: float, turns: List[Tuple[float, float, int]], previous: Optional[int]) -> int:
    """Largest overlap, else the nearest turn within 1 s, else the previous line's speaker, else the nearest turn."""
    best, best_overlap = None, 0.0
    for t_start, t_end, speaker in turns:
        overlap = min(end, t_end) - max(start, t_start)
        if overlap > best_overlap:
            best, best_overlap = speaker, overlap
    if best is not None:
        return best
    gap = lambda t: max(t[0] - end, start - t[1], 0.0)
    nearest = min(turns, key=gap)
    if gap(nearest) <= 1.0 or previous is None:
        return nearest[2]
    return previous


def assign_speakers_to_segments(segments: List[Dict[str, Any]], turns: Optional[List[Tuple[float, float, int]]] = None) -> List[Dict[str, Any]]:
    """
    Names the speakers when the subtitles didn't. With detected speaker turns each line
    takes the voice it overlaps most; without them speakers alternate on pauses over 1.5 s.
    Either way the names are "Speaker 1", "Speaker 2", ... and a person corrects them.
    """
    if not segments:
        return []

    distinct_chars = {s.get("character") for s in segments if s.get("character") and s.get("character") != "Actor"}
    if distinct_chars:
        return segments

    if turns:
        names: Dict[int, str] = {}
        previous = None
        for seg in segments:
            start = float(seg["start"])
            end = max(start, float(seg.get("end", start)))
            previous = _turn_speaker(start, end, turns, previous)
            if previous not in names:
                names[previous] = f"Speaker {len(names) + 1}"
            seg["character"] = names[previous]
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
        try:
            pack_loader.run_subprocess(cmd, timeout=pack_loader.SUBPROCESS_TIMEOUT_PROCESS,
                                       context="line slice " + filename,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            sliced = os.path.isfile(out_wav) and os.path.getsize(out_wav) >= 100
        except (subprocess.CalledProcessError, RuntimeError):
            sliced = False
        if not sliced:
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
            try:
                pack_loader.run_subprocess(cmd_fallback, timeout=pack_loader.SUBPROCESS_TIMEOUT_PROCESS,
                                           context="line slice (no fades) " + filename,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                fallback_error = None
            except subprocess.CalledProcessError as ex:
                fallback_error = (ex.stderr or b"").decode("utf-8", "replace").strip() or f"ffmpeg exit code {ex.returncode}"
            except RuntimeError as ex:
                fallback_error = str(ex)
            # Both attempts failed: stop the build with a clear message instead of
            # installing a pack that is silently missing this line's audio.
            if fallback_error is not None or not os.path.isfile(out_wav):
                print(f"[PackBuilder] Slice {i + 1} failed: {fallback_error or 'no audio file was written'}")
                raise RuntimeError(
                    f"Could not cut dialogue line {i + 1} ({start:.2f}s to {end:.2f}s). "
                    "Adjust its start or end and build again."
                )

        enriched_segments.append({
            "index": i,
            "filename": filename,
            "character": raw_char,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(seg_dur, 3),
            "caption": text,
            "raw_caption": pack_loader.format_raw_caption(raw_char, text),
            "file_path": out_wav,
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
    folder_name = pack_loader.safe_folder_name(safe_title, "Custom_Pack")
    
    target_base = pack_loader.PACKS_DIRS[0]
    os.makedirs(target_base, exist_ok=True)
    pack_dir = os.path.join(target_base, folder_name)
    os.makedirs(pack_dir, exist_ok=True)

    # Rebuilding under an existing pack name must not leave the previous build's line
    # slices or icon behind: load_pack would pick stale slices up as extra lines.
    for existing in os.listdir(pack_dir):
        existing_path = os.path.join(pack_dir, existing)
        if not os.path.isfile(existing_path):
            continue
        low = existing.lower()
        is_stale_slice = low.endswith(pack_loader.AUDIO_EXTS) and pack_loader.timestamp_from_filename(existing) is not None
        if is_stale_slice or low.startswith("icon."):
            os.remove(existing_path)

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

    # 5-6. Generate _captions.json and _TIMESTAMPS.txt
    caption_lines = [
        {
            "filename": line["filename"],
            "start": line["start"],
            "character": line.get("character", "Actor").strip(),
            "caption": line.get("caption", "").strip(),
        }
        for line in line_slices
    ]
    pack_loader.write_caption_files(pack_dir, safe_title, caption_lines,
                                    "Auto-generated DubMate Pack Builder timestamps")

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
