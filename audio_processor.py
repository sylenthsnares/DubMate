# -*- coding: utf-8 -*-
"""
audio_processor.py
High-Fidelity Audio DSP & Video Rendering Engine.
Matching filter chain for time-invariant pitch shifting, room acoustics, dynamic compression, and millisecond latency nudging.
"""

import os
import re
import wave
import json
import time
import shutil
import zipfile
import tempfile
import subprocess
import numpy as np
import scipy.signal
from typing import Dict, List, Optional, Any, Tuple, Union

from pack_loader import get_ffmpeg_path, get_deep_filter_path, get_h264_encoder_args, CACHE_DIR, PackInfo

SR = 44100  # Standard audio sample rate

# Explicit subprocess timeouts (seconds) so a wedged ffmpeg/DeepFilterNet process can never
# block a request thread forever. Tuned generously for slow media work while still bounded.
SUBPROCESS_TIMEOUT_PROBE = 60      # tiny clips / 1s noise-profile samples
SUBPROCESS_TIMEOUT_PROCESS = 180   # per-take transcodes, filter chains, denoise passes
SUBPROCESS_TIMEOUT_RENDER = 300    # full mix renders, video export, project zip encoding

# Safe bounds for client-supplied volume trim (dB). Prevents 10 ** (gain_db / 20) from overflowing.
GAIN_DB_MIN = -60.0
GAIN_DB_MAX = 24.0

# Only these characters are allowed in filesystem-derived identifiers (room_id, user_id, ...).
_SAFE_ID_CHARS_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _sanitize_id_token(value, max_len: int = 96) -> str:
    """Reduces a caller-supplied identifier (room_id, user_id, etc.) to a filesystem-safe
    token containing only [A-Za-z0-9_-]. Strips path separators, traversal sequences,
    and any other unsafe characters; caps length; raises ValueError if nothing safe remains."""
    if value is None:
        raise ValueError("Identifier must not be None.")
    text = str(value).strip()
    safe = _SAFE_ID_CHARS_RE.sub("_", text).strip("_")[:max_len]
    if not safe:
        raise ValueError("Identifier " + repr(value) + " contains no safe characters after sanitization.")
    return safe


def _ensure_within_directory(path: str, parent_dir: str) -> str:
    """Resolves path and raises ValueError if it escapes parent_dir (path traversal guard)."""
    real_path = os.path.realpath(path)
    real_parent = os.path.realpath(parent_dir)
    if real_path != real_parent and not real_path.startswith(real_parent + os.sep):
        raise ValueError("Resolved path " + repr(real_path) + " escapes expected directory " + repr(real_parent))
    return path


def _sanitize_finite_audio(data, context: str = "") -> np.ndarray:
    """Replaces non-finite samples (NaN / +-Inf) with 0.0 so they can never reach a WAV/MP3
    writer or the limiter as raw bit patterns. Logs loudly (not silently) when triggered."""
    arr = np.asarray(data, dtype=np.float32)
    bad_mask = ~np.isfinite(arr)
    if bad_mask.any():
        n_bad = int(np.count_nonzero(bad_mask))
        where = " in " + context if context else ""
        print("[AudioProcessor] WARNING: " + str(n_bad) + " non-finite sample(s) (NaN/Inf) detected" + where + "; replacing with 0.0.")
        arr = np.where(bad_mask, np.float32(0.0), arr).astype(np.float32)
    return arr


def _run_subprocess(cmd, timeout: float, context: str = "ffmpeg", **kwargs):
    """Runs a subprocess (ffmpeg / DeepFilterNet / etc.) with an explicit timeout so a wedged
    child process can never block the calling thread forever. Converts subprocess.TimeoutExpired
    into a clear, loggable RuntimeError instead of leaving it as an opaque bare-except case."""
    try:
        return subprocess.run(cmd, check=True, timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired as ex:
        msg = "[AudioProcessor] " + context + " timed out after " + str(timeout) + "s (cmd: " + str(cmd[0] if cmd else "?") + ")"
        print(msg)
        raise RuntimeError(msg) from ex


def get_room_cache_dir(room_id: str) -> str:
    """Returns (and creates) the per-room cache directory, guarding against path traversal via room_id."""
    rooms_root = os.path.join(CACHE_DIR, "rooms")
    safe_room_id = _sanitize_id_token(room_id)
    path = os.path.join(rooms_root, safe_room_id)
    _ensure_within_directory(path, rooms_root)
    os.makedirs(path, exist_ok=True)
    return path


def read_wav_mono(path: str, sr: int = SR) -> np.ndarray:
    """Reads audio as a mono float32 numpy array normalized between -1.0 and 1.0."""
    ffmpeg = get_ffmpeg_path()
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", path, "-ac", "1", "-ar", str(sr),
            "-c:a", "pcm_s16le", tmp
        ]
        _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_RENDER, context="read_wav_mono transcode of " + repr(path))
        with wave.open(tmp, "rb") as w:
            raw = w.readframes(w.getnframes())
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


def write_wav_mono(path: str, data: np.ndarray, sr: int = SR) -> str:
    """Writes a float32 numpy array to a mono 16-bit PCM WAV."""
    data = _sanitize_finite_audio(data, context="write_wav_mono(" + repr(path) + ")")
    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2").tobytes()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return path


def compute_waveform_peaks(data: np.ndarray, columns: int = 120) -> List[Tuple[float, float]]:
    """Calculates min/max peak pairs for rendering waveforms."""
    n = len(data)
    if n == 0 or columns <= 0:
        return []
    step = n / float(columns)
    arr = np.asarray(data, dtype=np.float32)
    peaks = []
    for c in range(columns):
        a = int(c * step)
        b = max(a + 1, int((c + 1) * step))
        chunk = arr[a:b]
        if len(chunk) > 0:
            peaks.append((round(float(chunk.min()), 3), round(float(chunk.max()), 3)))
        else:
            peaks.append((0.0, 0.0))
    return peaks


def get_user_noise_profile_path(room_id: str, user_id: str) -> str:
    """Returns the persistent noise profile path for an actor in a room (path-traversal safe)."""
    room_dir = get_room_cache_dir(room_id)
    safe_user_id = _sanitize_id_token(user_id)
    target = os.path.join(room_dir, "noise_profile_" + safe_user_id + ".wav")
    _ensure_within_directory(target, room_dir)
    return target


def save_user_noise_profile(
    room_id: str,
    user_id: str,
    audio_bytes: bytes,
    filename_hint: str = "profile.webm"
) -> Dict[str, Any]:
    """
    Saves a 1-second sample of idle room background noise to calibrate the actor's noise profile.
    Returns path, duration, and estimated noise floor in dB.
    """
    if not audio_bytes or len(audio_bytes) < 32:
        raise ValueError("Uploaded noise profile audio stream is empty.")

    target_profile = get_user_noise_profile_path(room_id, user_id)
    ext = os.path.splitext(filename_hint)[1].lower() if filename_hint else ".webm"
    if ext not in (".webm", ".wav", ".ogg", ".mp4", ".m4a", ".aac", ".flac"):
        ext = ".webm"

    fd, raw_tmp = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    with open(raw_tmp, "wb") as f:
        f.write(audio_bytes)

    ffmpeg = get_ffmpeg_path()
    try:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", raw_tmp,
            "-ac", "1", "-ar", str(SR),
            "-c:a", "pcm_s16le",
            target_profile
        ]
        _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_PROBE, context="noise profile transcoding")
    except subprocess.CalledProcessError as err:
        print(f"[AudioProcessor] Noise profile calibration conversion failed: {err}")
        raise RuntimeError(f"Noise profile calibration failed: {err}")
    finally:
        if os.path.exists(raw_tmp):
            try:
                os.remove(raw_tmp)
            except Exception:
                pass

    profile_data = read_wav_mono(target_profile)
    rms = np.sqrt(np.mean(profile_data ** 2)) if len(profile_data) > 0 else 1e-6
    noise_floor_db = round(float(20.0 * np.log10(max(rms, 1e-6))), 1)

    return {
        "status": "ok",
        "user_id": user_id,
        "profile_path": target_profile,
        "duration": round(len(profile_data) / float(SR), 2),
        "noise_floor_db": noise_floor_db,
    }


def calculate_speech_gated_loudness(
    audio_data: np.ndarray,
    sr: int = SR,
    frame_len_ms: float = 50.0,
    hop_ms: float = 25.0,
    gate_thresh_db: float = -15.0
) -> float:
    """
    Measures the speech-gated integrated RMS loudness of an audio signal (ITU-R BS.1770 / EBU R128 inspired).
    Splits audio into overlapping frames (50ms frames, 25ms hop), computes frame RMS,
    filters out silent/pause frames below relative gate_thresh_db (relative to speech RMS),
    and returns the mean active speech loudness in dBFS.
    """
    if audio_data is None or len(audio_data) == 0:
        return -60.0

    frame_len = int(sr * (frame_len_ms / 1000.0))
    hop_len = int(sr * (hop_ms / 1000.0))
    if frame_len <= 0 or hop_len <= 0 or len(audio_data) < frame_len:
        rms = np.sqrt(np.mean(audio_data ** 2)) if len(audio_data) > 0 else 1e-6
        return float(np.clip(20.0 * np.log10(max(rms, 1e-6)), -70.0, 0.0))

    frames = np.lib.stride_tricks.sliding_window_view(audio_data, frame_len)[::hop_len]
    frame_rms = np.sqrt(np.mean(frames ** 2, axis=-1) + 1e-12)

    # Step 1: Absolute threshold (-55 dBFS) to discard pure digital silence
    abs_thresh = 10.0 ** (-55.0 / 20.0)
    speech_cand = frame_rms[frame_rms >= abs_thresh]
    if len(speech_cand) == 0:
        return -60.0

    # Step 2: Relative speech gate (-15 dB relative to initial active speech RMS)
    ungated_mean_rms = np.sqrt(np.mean(speech_cand ** 2))
    rel_thresh = ungated_mean_rms * (10.0 ** (gate_thresh_db / 20.0))
    active_frames = speech_cand[speech_cand >= rel_thresh]
    if len(active_frames) == 0:
        active_frames = speech_cand

    mean_speech_rms = np.sqrt(np.mean(active_frames ** 2))
    speech_loudness_db = float(20.0 * np.log10(max(mean_speech_rms, 1e-6)))
    return round(float(np.clip(speech_loudness_db, -70.0, 0.0)), 1)


def calculate_take_auto_gain(
    take_audio_or_path: Union[np.ndarray, str],
    target_loudness_db: float = -21.0,
    sr: int = SR,
    max_boost_db: float = 12.0,
    max_cut_db: float = -12.0
) -> Dict[str, float]:
    """
    Computes the static gain offset needed to match target dialogue loudness.
    Returns {"take_loudness_db": float, "target_loudness_db": float, "auto_gain_db": float}.
    """
    if isinstance(take_audio_or_path, str):
        if not os.path.isfile(take_audio_or_path):
            return {"take_loudness_db": -21.0, "target_loudness_db": round(target_loudness_db, 1), "auto_gain_db": 0.0}
        audio_data = read_wav_mono(take_audio_or_path, sr)
    else:
        audio_data = take_audio_or_path

    take_loudness_db = calculate_speech_gated_loudness(audio_data, sr=sr)
    raw_delta_db = target_loudness_db - take_loudness_db
    # Clamp to safe gain limits [-12dB, +12dB]
    auto_gain_db = round(float(np.clip(raw_delta_db, max_cut_db, max_boost_db)), 1)

    return {
        "take_loudness_db": take_loudness_db,
        "target_loudness_db": round(target_loudness_db, 1),
        "auto_gain_db": auto_gain_db,
    }


def apply_noise_reduction(
    input_wav: str,
    output_wav: str,
    noise_profile_wav: Optional[str] = None,
    reduction_db: float = 100.0,
    sr: int = SR
) -> str:
    """
    Applies state-of-the-art DeepFilterNet 3 neural speech enhancement & vocal de-noising.
    Preserves 100% of quiet dialogue, subtle mouth grit, breath, and natural dynamics
    while removing heavy fan noise, AC hum, and preamp hiss with zero phase warble.
    Falls back gracefully to highpass + adaptive spectral gating if deep-filter binary is absent.
    """
    os.makedirs(os.path.dirname(os.path.abspath(output_wav)), exist_ok=True)
    df_bin = get_deep_filter_path()
    ffmpeg = get_ffmpeg_path()

    # 1. Primary Path: DeepFilterNet 3 Neural Speech Enhancement
    if df_bin and os.path.isfile(df_bin):
        tmp_dir = tempfile.mkdtemp(prefix="dubmate_df_")
        try:
            # Read original input length for exact sample-accurate duration matching
            orig_audio = read_wav_mono(input_wav, sr)
            orig_len = len(orig_audio)

            tmp_48k_in = os.path.join(tmp_dir, "take_48k.wav")
            df_out_dir = os.path.join(tmp_dir, "out")
            os.makedirs(df_out_dir, exist_ok=True)

            # Resample cleanly to 48kHz for DeepFilterNet native processing
            cmd_resample = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", input_wav,
                "-ar", "48000", "-ac", "1",
                "-c:a", "pcm_s16le",
                tmp_48k_in
            ]
            _run_subprocess(cmd_resample, timeout=SUBPROCESS_TIMEOUT_PROCESS, context="DeepFilterNet resample to 48k")

            # Run DeepFilterNet with delay compensation (-D)
            atten_lim = max(12.0, min(100.0, float(reduction_db))) if reduction_db is not None else 100.0
            cmd_df = [
                df_bin, "-D",
                "-a", str(int(atten_lim)),
                "-o", df_out_dir,
                tmp_48k_in
            ]
            _run_subprocess(cmd_df, timeout=SUBPROCESS_TIMEOUT_RENDER, context="DeepFilterNet3 inference", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            enh_48k = os.path.join(df_out_dir, "take_48k.wav")
            if os.path.isfile(enh_48k) and os.path.getsize(enh_48k) > 100:
                # Transcode back to target sample rate (sr)
                tmp_resampled = os.path.join(tmp_dir, "enhanced_sr.wav")
                cmd_back = [
                    ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", enh_48k,
                    "-ar", str(sr), "-ac", "1",
                    "-c:a", "pcm_s16le",
                    tmp_resampled
                ]
                _run_subprocess(cmd_back, timeout=SUBPROCESS_TIMEOUT_PROCESS, context="DeepFilterNet resample back to target rate")

                # Ensure exact length matching with zero-padding if needed
                enhanced_audio = read_wav_mono(tmp_resampled, sr)
                if len(enhanced_audio) < orig_len:
                    padded = np.zeros(orig_len, dtype=np.float32)
                    padded[:len(enhanced_audio)] = enhanced_audio
                    enhanced_audio = padded
                elif len(enhanced_audio) > orig_len:
                    enhanced_audio = enhanced_audio[:orig_len]

                write_wav_mono(output_wav, enhanced_audio, sr)
                return output_wav
        except Exception as ex:
            print(f"[AudioProcessor] WARNING: DeepFilterNet3 neural denoise FAILED for {input_wav!r} - falling back to spectral-gate denoiser. Reason: {ex}")
        finally:
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)

    # 2. Fallback Path: High-pass + Adaptive Spectral Denoising
    try:
        af_filters = [
            "highpass=f=80",
            f"afftdn=nr={min(18.0, reduction_db):.1f}:nf=-35:tn=1",
            "agate=threshold=-34dB:ratio=2.0:range=-18dB:attack=15:release=120",
        ]
        fd, tmp_out = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", input_wav,
            "-af", ",".join(af_filters),
            "-ac", "1", "-ar", str(sr),
            "-c:a", "pcm_s16le",
            tmp_out
        ]
        _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_PROCESS, context="fallback spectral-gate denoise")
        shutil.move(tmp_out, output_wav)
        return output_wav
    except Exception as ex:
        print(f"[AudioProcessor] WARNING: noise reduction NOT applied for {input_wav!r} (DeepFilterNet3 and fallback denoiser both failed); returning unprocessed copy. Reason: {ex}")
        shutil.copy2(input_wav, output_wav)
        return output_wav


def save_uploaded_take(
    room_id: str,
    line_index: int,
    audio_bytes: bytes,
    filename_hint: str = "take.webm",
    enable_noise_reduction: bool = False,
    user_id: Optional[str] = None,
    target_loudness_db: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Saves raw uploaded audio from browser (WebM/WAV/OGG) to standard WAV.
    Preserves pristine raw audio (take_line_{index}_raw.wav) and generates denoised
    audio (take_line_{index}_denoised.wav) when requested.
    Calculates speech-gated loudness and smart auto-gain calibration against scene target.
    Returns active path, duration, waveform peaks, auto_gain_db, and noise reduction status.
    """
    if not audio_bytes or len(audio_bytes) < 32:
        raise ValueError("Uploaded audio stream is empty or incomplete.")

    room_dir = get_room_cache_dir(room_id)
    ext = os.path.splitext(filename_hint)[1].lower() if filename_hint else ".webm"
    if ext not in (".webm", ".wav", ".ogg", ".mp4", ".m4a", ".aac", ".flac"):
        ext = ".webm"

    fd, raw_tmp = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    with open(raw_tmp, "wb") as f:
        f.write(audio_bytes)

    target_wav = os.path.join(room_dir, f"take_line_{line_index}.wav")
    raw_wav = os.path.join(room_dir, f"take_line_{line_index}_raw.wav")
    denoised_wav = os.path.join(room_dir, f"take_line_{line_index}_denoised.wav")

    ffmpeg = get_ffmpeg_path()
    try:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", raw_tmp,
            "-ac", "1", "-ar", str(SR),
            "-c:a", "pcm_s16le",
            raw_wav
        ]
        _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_PROCESS, context="take upload transcoding")
    except subprocess.CalledProcessError as err:
        print(f"[AudioProcessor] ffmpeg conversion failed on {raw_tmp} ({len(audio_bytes)} bytes): {err}")
        raise RuntimeError(f"Audio transcoding failed: {err}")
    finally:
        if os.path.exists(raw_tmp):
            try:
                os.remove(raw_tmp)
            except Exception:
                pass

    profile_path = None
    if user_id:
        try:
            profile_path = get_user_noise_profile_path(room_id, user_id)
        except ValueError as ex:
            print(f"[AudioProcessor] WARNING: could not resolve noise profile path for user_id={user_id!r}: {ex}")
            profile_path = None
    if not os.path.isfile(profile_path or ""):
        profile_path = None

    if enable_noise_reduction:
        apply_noise_reduction(raw_wav, denoised_wav, profile_path)
        shutil.copy2(denoised_wav, target_wav)
    else:
        shutil.copy2(raw_wav, target_wav)

    audio_data = read_wav_mono(target_wav)
    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)

    # Calculate speech-gated loudness and smart auto-gain calibration
    effective_target_db = target_loudness_db if target_loudness_db is not None else -21.0
    gain_match = calculate_take_auto_gain(audio_data, target_loudness_db=effective_target_db, sr=SR)

    return {
        "wav_path": target_wav,
        "raw_path": raw_wav,
        "denoised_path": denoised_wav if enable_noise_reduction else None,
        "duration": round(duration, 3),
        "peaks": peaks,
        "noise_reduction": bool(enable_noise_reduction),
        "has_raw": True,
        "speech_loudness_db": gain_match["take_loudness_db"],
        "target_loudness_db": gain_match["target_loudness_db"],
        "auto_gain_db": gain_match["auto_gain_db"],
        "url": f"/api/rooms/{room_id}/takes/{line_index}/audio",
    }


def toggle_take_noise_reduction(
    room_id: str,
    line_index: int,
    enable_noise_reduction: bool,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Instantly toggles a take between pristine raw and denoised audio.
    Generates denoised audio on-demand if missing.
    """
    room_dir = get_room_cache_dir(room_id)
    target_wav = os.path.join(room_dir, f"take_line_{line_index}.wav")
    raw_wav = os.path.join(room_dir, f"take_line_{line_index}_raw.wav")
    denoised_wav = os.path.join(room_dir, f"take_line_{line_index}_denoised.wav")

    if not os.path.exists(raw_wav):
        if os.path.exists(target_wav):
            shutil.copy2(target_wav, raw_wav)
        else:
            raise FileNotFoundError(f"No take audio found for line {line_index}")

    profile_path = None
    if user_id:
        try:
            profile_path = get_user_noise_profile_path(room_id, user_id)
        except ValueError as ex:
            print(f"[AudioProcessor] WARNING: could not resolve noise profile path for user_id={user_id!r}: {ex}")
            profile_path = None
    if not os.path.isfile(profile_path or ""):
        profile_path = None

    if enable_noise_reduction:
        if not os.path.exists(denoised_wav) or os.path.getsize(denoised_wav) < 100:
            apply_noise_reduction(raw_wav, denoised_wav, profile_path)
        shutil.copy2(denoised_wav, target_wav)
    else:
        shutil.copy2(raw_wav, target_wav)

    audio_data = read_wav_mono(target_wav)
    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)

    return {
        "wav_path": target_wav,
        "duration": round(duration, 3),
        "peaks": peaks,
        "noise_reduction": bool(enable_noise_reduction),
        "has_raw": True,
        "url": f"/api/rooms/{room_id}/takes/{line_index}/audio",
    }


_REVERB_CACHE: Dict[Tuple[float, int], np.ndarray] = {}


def get_reverb_impulse(decay_sec: float = 1.5, sr: int = SR) -> np.ndarray:
    """Generates and caches an acoustic room impulse response with exponential decay and diffusion."""
    cache_key = (round(decay_sec, 2), sr)
    if cache_key in _REVERB_CACHE:
        return _REVERB_CACHE[cache_key]

    length = int(sr * min(2.0, max(0.2, decay_sec)))
    pre_delay = int(sr * 0.020)  # 20ms pre-delay
    impulse = np.zeros(length, dtype=np.float32)
    t = np.arange(length - pre_delay, dtype=np.float32) / float(sr)
    envelope = np.exp(-3.2 * t / max(0.1, decay_sec))

    rng = np.random.default_rng(42)  # Deterministic room reflection pattern (local RNG, no global mutation)
    impulse[pre_delay:] = (rng.random(len(t)).astype(np.float32) * 2.0 - 1.0) * envelope
    norm = np.sqrt(np.sum(impulse ** 2))
    if norm > 1e-6:
        impulse /= norm

    _REVERB_CACHE[cache_key] = impulse
    return impulse


def master_soft_limiter(audio: np.ndarray, ceiling_db: float = -0.3) -> np.ndarray:
    """
    Transparent studio soft-knee limiter that prevents digital clipping
    without crushing relative track dynamics or individual volume knob levels.
    """
    audio = _sanitize_finite_audio(audio, context="master_soft_limiter input")
    ceiling = 10.0 ** (ceiling_db / 20.0)  # ~0.966
    peak = np.max(np.abs(audio)) if len(audio) else 0.0
    if peak <= ceiling:
        return audio

    threshold = ceiling * 0.70  # ~0.676
    out = np.copy(audio)
    mask = np.abs(audio) > threshold
    if np.any(mask):
        excess = np.abs(audio[mask]) - threshold
        compressed = threshold + (ceiling - threshold) * np.tanh(excess / (ceiling - threshold + 1e-6))
        out[mask] = np.sign(audio[mask]) * compressed
    return out


def apply_audio_effects(
    audio_path: str,
    pitch_semitones: float = 0.0,
    reverb_wet: float = 0.0,
    gain_db: float = 0.0,
    enable_lowcut: bool = True,
    enable_compressor: bool = False,
    sr: int = SR
) -> np.ndarray:
    """
    Applies high-fidelity vocal DSP chain:
    1. 80Hz low-cut filter (removes rumble / mic plosives)
    2. Time-invariant pitch shift (preserves exact line duration)
    3. Vocal compressor
    4. Direct linear volume gain (dB trim)
    5. Acoustic room convolution reverb (maintains 100% dry vocal punch + lush room space)
    """
    # Clamp client-supplied gain to a sane audio range so 10 ** (gain_db / 20) can never overflow.
    clamped_gain_db = float(np.clip(gain_db, GAIN_DB_MIN, GAIN_DB_MAX))
    if clamped_gain_db != gain_db:
        print(f"[AudioProcessor] WARNING: gain_db={gain_db} out of safe range; clamped to {clamped_gain_db} dB.")
    gain_db = clamped_gain_db

    filters = []

    # 1. 80Hz Low-cut filter
    if enable_lowcut:
        filters.append("highpass=f=80")

    # 2. Time-Invariant Pitch Shift via asetrate + atempo
    if abs(pitch_semitones) > 0.01:
        ratio = 2.0 ** (pitch_semitones / 12.0)
        target_rate = int(sr * ratio)
        tempo = 1.0 / ratio
        
        tempo_filters = []
        rem_tempo = tempo
        while rem_tempo < 0.5:
            tempo_filters.append("atempo=0.5")
            rem_tempo /= 0.5
        while rem_tempo > 2.0:
            tempo_filters.append("atempo=2.0")
            rem_tempo /= 2.0
        tempo_filters.append(f"atempo={rem_tempo:.4f}")
        tempo_str = ",".join(tempo_filters)
        filters.append(f"asetrate={target_rate},{tempo_str},aresample={sr}")

    # 3. Vocal Compressor (Matching Web Audio 3:1 ratio, -24dB threshold, 12dB soft knee)
    if enable_compressor:
        filters.append("compand=attacks=0.015:decays=0.15:points=-80/-80|-30/-30|-18/-22|0/-16")

    ffmpeg = get_ffmpeg_path()
    if filters:
        filter_chain = ",".join(filters)
        fd, tmp_out = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            cmd = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", audio_path,
                "-af", filter_chain,
                "-ac", "1", "-ar", str(sr),
                "-c:a", "pcm_s16le",
                tmp_out
            ]
            _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_PROCESS, context="apply_audio_effects filter chain for " + repr(audio_path))
            audio = read_wav_mono(tmp_out, sr)
        except Exception as ex:
            print(f"[AudioProcessor] WARNING: DSP filter chain FAILED for {audio_path!r} (pitch/low-cut/compressor NOT applied); returning unprocessed audio. Reason: {ex}")
            audio = read_wav_mono(audio_path, sr)
        finally:
            if os.path.exists(tmp_out):
                try:
                    os.remove(tmp_out)
                except Exception:
                    pass
    else:
        audio = read_wav_mono(audio_path, sr)

    # 4. Volume Gain Trim (Exact dB scaling directly applied to waveform)
    if abs(gain_db) > 0.01:
        gain_mult = 10.0 ** (gain_db / 20.0)
        audio = audio * np.float32(gain_mult)

    # 5. Studio Acoustic Room Convolution Reverb
    # Direct vocal stays at 100% punch; lush room reflections and natural reverb decay ring out seamlessly
    if reverb_wet > 0.02 and len(audio) > 0:
        impulse = get_reverb_impulse(decay_sec=1.5, sr=sr)
        wet = scipy.signal.fftconvolve(audio, impulse)
        out_audio = np.zeros(len(wet), dtype=np.float32)
        out_audio[:len(audio)] = audio
        out_audio += wet * np.float32(reverb_wet * 0.70)
        audio = out_audio

    return audio


def render_dub_mix(
    pack: PackInfo,
    takes_dict: Dict[int, Dict[str, Any]],
    output_wav: str,
    sr: int = SR,
    master_dialogue_presence_db: float = 0.0,
) -> str:
    """
    Renders complete mix with millisecond offsets, voice effects, and master dialogue presence.
    takes_dict format: {line_index: {"wav_path": str, "offset_ms": int, "pitch_semitones": float, "reverb_wet": float, "gain_db": float}}
    """
    total_sec = max(pack.duration, 1.0)
    for line in pack.lines:
        total_sec = max(total_sec, line["end"] + 2.0)
    total_samples = int(total_sec * sr) + sr

    mix_buffer = np.zeros(total_samples, dtype=np.float32)

    # 1. Backing track (music & sound effects at calibrated DAW level 0.65)
    if pack.backing_track_path and os.path.isfile(pack.backing_track_path):
        try:
            backing_data = read_wav_mono(pack.backing_track_path, sr) * 0.65
            n_copy = min(len(backing_data), total_samples)
            mix_buffer[:n_copy] = backing_data[:n_copy]
        except Exception as ex:
            print(f"Error loading backing track: {ex}")

    # 2. Render each dialogue line (recorded takes or original reference)
    for line in pack.lines:
        idx = line["index"]
        start_sec = line["start"]
        take_info = takes_dict.get(idx)

        if take_info and os.path.isfile(take_info.get("wav_path", "")):
            offset_sec = float(take_info.get("offset_ms", 0)) / 1000.0
            pitch = float(take_info.get("pitch_semitones", 0.0))
            reverb = float(take_info.get("reverb_wet", 0.0))
            # Take gain plus master dialogue presence trim
            gain = float(take_info.get("gain_db", 0.0)) + float(master_dialogue_presence_db)

            try:
                processed_audio = apply_audio_effects(
                    take_info["wav_path"],
                    pitch_semitones=pitch,
                    reverb_wet=reverb,
                    gain_db=gain,
                    sr=sr
                )
            except Exception as ex:
                print(f"[render_dub_mix] WARNING: apply_audio_effects failed for line {idx} ({take_info.get('wav_path')!r}): {ex}. Falling back to unprocessed take audio so the render can continue.")
                try:
                    processed_audio = read_wav_mono(take_info["wav_path"], sr)
                except Exception as ex2:
                    print(f"[render_dub_mix] ERROR: fallback read also failed for line {idx}: {ex2}. Skipping this line.")
                    continue

            pos_sec = start_sec + offset_sec
            if pos_sec < 0:
                skip_samples = int(-pos_sec * sr)
                if skip_samples < len(processed_audio):
                    audio_slice = processed_audio[skip_samples:]
                    start_sample = 0
                    end_sample = min(total_samples, len(audio_slice))
                    if end_sample > 0:
                        mix_buffer[start_sample:end_sample] += audio_slice[:end_sample]
            else:
                start_sample = int(pos_sec * sr)
                end_sample = min(total_samples, start_sample + len(processed_audio))
                samples_to_add = end_sample - start_sample
                if samples_to_add > 0:
                    mix_buffer[start_sample:end_sample] += processed_audio[:samples_to_add]

        else:
            orig_path = os.path.join(pack.folder, line["filename"])
            if os.path.isfile(orig_path):
                try:
                    orig_audio = read_wav_mono(orig_path, sr)
                    start_sample = int(start_sec * sr)
                    end_sample = min(total_samples, start_sample + len(orig_audio))
                    samples_to_add = end_sample - start_sample
                    if samples_to_add > 0:
                        orig_mult = 0.90 * (10.0 ** (float(master_dialogue_presence_db) / 20.0))
                        mix_buffer[start_sample:end_sample] += orig_audio[:samples_to_add] * np.float32(orig_mult)
                except Exception as ex:
                    print(f"Error loading original audio for line {idx}: {ex}")

    # 3. Apply master transparent soft limiter (preserves dynamics, volume knob levels, and reverb tails)
    master_mix = master_soft_limiter(mix_buffer, ceiling_db=-0.3)

    write_wav_mono(output_wav, master_mix, sr)
    return output_wav


def export_dub_video(
    pack: PackInfo,
    takes_dict: Dict[int, Dict[str, Any]],
    output_mp4: str,
    aspect_ratio: str = "16:9",
    master_dialogue_presence_db: float = 0.0,
) -> str:
    """Combines final mixed audio with scene video into a high quality MP4 (16:9 or 9:16 letterboxed)."""
    pack.ensure_web_ready()
    fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    render_dub_mix(pack, takes_dict, tmp_wav, master_dialogue_presence_db=master_dialogue_presence_db)

    ffmpeg = get_ffmpeg_path()
    os.makedirs(os.path.dirname(os.path.abspath(output_mp4)), exist_ok=True)
    encoder_args = get_h264_encoder_args(crf=20, usage="export")
    
    vf_filters = []
    if aspect_ratio == "9:16":
        # Letterbox 9:16 with black bars top and bottom without cropping
        vf_filters.extend(["-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"])

    try:
        try:
            cmd = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", pack.web_video_path,
                "-i", tmp_wav,
                "-map", "0:v:0", "-map", "1:a:0",
                *vf_filters,
                *encoder_args,
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest",
                "-movflags", "+faststart",
                output_mp4
            ]
            _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_RENDER, context="export_dub_video primary encoder")
        except Exception as ex:
            print(f"[export_dub_video] Primary encoder failed ({ex}), falling back to CPU libx264...")
            cpu_cores = os.cpu_count() or 4
            threads = str(max(1, min(cpu_cores, 8)))
            fallback_args = ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-threads", threads]
            cmd = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", pack.web_video_path,
                "-i", tmp_wav,
                "-map", "0:v:0", "-map", "1:a:0",
                *vf_filters,
                *fallback_args,
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest",
                "-movflags", "+faststart",
                output_mp4
            ]
            _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_RENDER, context="export_dub_video fallback CPU encoder")
    finally:
        if os.path.exists(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass

    return output_mp4


def sanitize_filename(name: str) -> str:
    """Sanitizes strings for safe cross-platform file and directory names."""
    cleaned = re.sub(r'[\\/*?:"<>|]', "", name)
    cleaned = re.sub(r"\s+", "_", cleaned.strip())
    return cleaned or "Unnamed"


def format_time_tag(seconds: float) -> str:
    """Formats seconds into MM.SS for cross-platform safe filenames (e.g. 00.03)."""
    s = max(0.0, float(seconds))
    m = int(s // 60)
    sec = int(s % 60)
    return f"{m:02d}.{sec:02d}"


def write_mp3_mono(path: str, data: np.ndarray, sr: int = SR, bitrate: str = "192k") -> str:
    """Encodes float32 numpy audio array directly to an MP3 file via ffmpeg."""
    if len(data) == 0:
        data = np.zeros(sr, dtype=np.float32)
    data = _sanitize_finite_audio(data, context="write_mp3_mono(" + repr(path) + ")")
    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2").tobytes()
    ffmpeg = get_ffmpeg_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
        "-c:a", "libmp3lame", "-b:a", bitrate, "-ar", str(sr),
        path
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        _, stderr = proc.communicate(input=pcm, timeout=SUBPROCESS_TIMEOUT_RENDER)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise RuntimeError("FFmpeg MP3 encoding timed out after " + str(SUBPROCESS_TIMEOUT_RENDER) + "s for " + repr(path))
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg MP3 encoding failed: {stderr.decode(errors='ignore')}")
    return path


def convert_file_to_mp3(src_path: str, dst_path: str, sr: int = SR, bitrate: str = "192k") -> str:
    """Converts any input audio/video file to a standalone MP3 file."""
    ffmpeg = get_ffmpeg_path()
    os.makedirs(os.path.dirname(os.path.abspath(dst_path)), exist_ok=True)
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", src_path,
        "-c:a", "libmp3lame", "-b:a", bitrate, "-ar", str(sr),
        "-vn", dst_path
    ]
    _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_RENDER, context="convert_file_to_mp3(" + repr(src_path) + ")")
    return dst_path


def build_project_zip(
    pack: PackInfo,
    takes_dict: Dict[int, Dict[str, Any]],
    role_assignments: Optional[Dict[str, List[str]]] = None,
    users: Optional[Dict[str, Any]] = None,
    output_zip_path: Optional[str] = None,
    room_id: str = "SESSION",
    sr: int = SR,
    bitrate: str = "192k",
) -> str:
    """
    Assembles a complete NLE-ready multi-track project ZIP archive containing:
    1. Video/ -> Clean pack scene video
    2. Audio_Stems/ ->
       - Backing_Music_SFX.mp3
       - Master_Vocal_Mix.mp3
       - Character_Stems/[Character]_[Actor].mp3 (Continuous timeline-padded audio from t=0)
    3. Raw_Takes/ ->
       - Line_01_[Character]_[Actor].mp3
    4. Timeline_Cues.txt -> Human-readable cuesheet
    5. project_manifest.json -> Machine-readable timeline and track metadata
    """
    role_assignments = role_assignments or {}
    users = users or {}

    total_sec = max(pack.duration, 1.0)
    for line in pack.lines:
        total_sec = max(total_sec, line["end"] + 2.0)
    total_samples = int(total_sec * sr) + sr

    # Sanitize the caller-supplied room_id before it becomes part of any filesystem path.
    try:
        room_id_safe = _sanitize_id_token(room_id)
    except ValueError:
        room_id_safe = "SESSION"

    # Create temporary working directory for staging
    temp_stage_dir = tempfile.mkdtemp(prefix=f"dubmate_proj_{room_id_safe}_")
    try:
        pack_sanitized = sanitize_filename(pack.name)
        root_folder_name = f"DubMate_Project_{pack_sanitized}_{room_id_safe}"
        proj_root = os.path.join(temp_stage_dir, root_folder_name)
        video_dir = os.path.join(proj_root, "Video")
        stems_dir = os.path.join(proj_root, "Audio_Stems")
        char_stems_dir = os.path.join(stems_dir, "Character_Stems")
        raw_takes_dir = os.path.join(proj_root, "Raw_Takes")

        os.makedirs(video_dir, exist_ok=True)
        os.makedirs(stems_dir, exist_ok=True)
        os.makedirs(char_stems_dir, exist_ok=True)
        os.makedirs(raw_takes_dir, exist_ok=True)

        # 1. Clean Scene Video
        pack.ensure_web_ready()
        src_video = pack.web_video_path or pack.video_path
        if src_video and os.path.isfile(src_video):
            dst_video = os.path.join(video_dir, f"{pack_sanitized}_Clean_Video.mp4")
            try:
                shutil.copy2(src_video, dst_video)
            except Exception as ex:
                print(f"[ProjectZip] Error copying video: {ex}")

        # 2. Backing Music & SFX Track
        if pack.backing_track_path and os.path.isfile(pack.backing_track_path):
            dst_backing = os.path.join(stems_dir, "Backing_Music_SFX.mp3")
            try:
                convert_file_to_mp3(pack.backing_track_path, dst_backing, sr=sr, bitrate=bitrate)
            except Exception as ex:
                print(f"[ProjectZip] Error converting backing track: {ex}")

        # 3. Master Vocal Mix Stem & Character Stems
        master_vocal_buffer = np.zeros(total_samples, dtype=np.float32)

        # Determine all characters present
        characters = list(pack.characters) if pack.characters else []
        for line in pack.lines:
            c = line.get("character", "Actor")
            if c and c not in characters:
                characters.append(c)

        char_buffers: Dict[str, np.ndarray] = {
            char: np.zeros(total_samples, dtype=np.float32) for char in characters
        }

        manifest_lines = []
        cues_text_lines = [
            "DubMate Studio Pro - Project Timeline & Dialogue Cues",
            f"Project: {pack.name} (Pack ID: {pack.pack_id})",
            f"Room ID: {room_id}",
            f"Duration: {pack.duration:.2f}s | Audio Sample Rate: {sr}Hz | Format: MP3 ({bitrate})",
            f"Total Lines: {len(pack.lines)}",
            "=" * 80,
            "",
        ]

        for line in pack.lines:
            idx = line["index"]
            start_sec = float(line["start"])
            end_sec = float(line["end"])
            char = line.get("character", "Actor")
            dialogue_text = line.get("caption") or line.get("raw_caption") or line.get("text") or ""
            take_info = takes_dict.get(idx)

            line_entry = {
                "index": idx,
                "line_number": idx + 1,
                "character": char,
                "start": start_sec,
                "end": end_sec,
                "duration": round(end_sec - start_sec, 3),
                "text": dialogue_text,
                "is_recorded": False,
                "assigned_actors": [],
                "take_file": None,
                "offset_ms": 0,
                "pitch_semitones": 0.0,
                "reverb_wet": 0.0,
                "gain_db": 0.0,
            }

            assigned_uids = role_assignments.get(char, [])
            assigned_names = [users.get(uid, {}).get("name", "Actor") for uid in assigned_uids if uid in users]
            line_entry["assigned_actors"] = assigned_names

            if take_info and os.path.isfile(take_info.get("wav_path", "")):
                actor_name = take_info.get("user_name", "Actor")
                offset_ms = int(take_info.get("offset_ms", 0))
                pitch = float(take_info.get("pitch_semitones", 0.0))
                reverb = float(take_info.get("reverb_wet", 0.0))
                gain = float(take_info.get("gain_db", 0.0))

                try:
                    processed_audio = apply_audio_effects(
                        take_info["wav_path"],
                        pitch_semitones=pitch,
                        reverb_wet=reverb,
                        gain_db=gain,
                        sr=sr
                    )
                except Exception as ex:
                    print(f"[ProjectZip] WARNING: apply_audio_effects failed for line {idx} ({take_info.get('wav_path')!r}): {ex}. Falling back to unprocessed take audio so the export can continue.")
                    try:
                        processed_audio = read_wav_mono(take_info["wav_path"], sr)
                    except Exception as ex2:
                        print(f"[ProjectZip] ERROR: fallback read also failed for line {idx}: {ex2}. Using near-silent placeholder so the export and manifest still complete.")
                        processed_audio = np.zeros(1, dtype=np.float32)

                offset_sec = float(offset_ms) / 1000.0
                pos_sec = start_sec + offset_sec

                if pos_sec < 0:
                    skip_samples = int(-pos_sec * sr)
                    if skip_samples < len(processed_audio):
                        audio_slice = processed_audio[skip_samples:]
                        end_s = min(total_samples, len(audio_slice))
                        if end_s > 0:
                            master_vocal_buffer[:end_s] += audio_slice[:end_s]
                            if char in char_buffers:
                                char_buffers[char][:end_s] += audio_slice[:end_s]
                else:
                    start_s = int(pos_sec * sr)
                    end_s = min(total_samples, start_s + len(processed_audio))
                    s_to_add = end_s - start_s
                    if s_to_add > 0:
                        master_vocal_buffer[start_s:end_s] += processed_audio[:s_to_add]
                        if char in char_buffers:
                            char_buffers[char][start_s:end_s] += processed_audio[:s_to_add]

                # Save take to Raw_Takes/
                char_clean = sanitize_filename(char)
                actor_clean = sanitize_filename(actor_name)
                time_tag = f"[{format_time_tag(start_sec)}-{format_time_tag(end_sec)}]"
                take_filename = f"Line_{idx + 1:02d}_{char_clean}_{actor_clean} {time_tag}.mp3"
                take_path = os.path.join(raw_takes_dir, take_filename)
                try:
                    write_mp3_mono(take_path, processed_audio, sr=sr, bitrate=bitrate)
                except Exception as ex:
                    print(f"[ProjectZip] Error writing take {take_filename}: {ex}")

                line_entry["is_recorded"] = True
                line_entry["take_file"] = f"Raw_Takes/{take_filename}"
                line_entry["actor_name"] = actor_name
                line_entry["offset_ms"] = offset_ms
                line_entry["pitch_semitones"] = pitch
                line_entry["reverb_wet"] = reverb
                line_entry["gain_db"] = gain

                cues_text_lines.extend([
                    f"[Line {idx + 1:02d}] {start_sec:06.3f}s -> {end_sec:06.3f}s (Dur: {end_sec - start_sec:.2f}s)",
                    f"  Character : {char}",
                    f"  Actor     : {actor_name}",
                    f"  Dialogue  : \"{dialogue_text}\"",
                    f"  DSP Tuning: Offset: {offset_ms:+d}ms | Pitch: {pitch:+.1f}st | Reverb: {int(reverb * 100)}% | Gain: {gain:+.1f}dB",
                    f"  File      : Raw_Takes/{take_filename}",
                    "-" * 80,
                ])
            else:
                orig_path = os.path.join(pack.folder, line.get("filename", ""))
                if os.path.isfile(orig_path):
                    try:
                        orig_audio = read_wav_mono(orig_path, sr)
                        start_s = int(start_sec * sr)
                        end_s = min(total_samples, start_s + len(orig_audio))
                        s_to_add = end_s - start_s
                        if s_to_add > 0:
                            master_vocal_buffer[start_s:end_s] += orig_audio[:s_to_add] * 0.90
                    except Exception:
                        pass

                cues_text_lines.extend([
                    f"[Line {idx + 1:02d}] {start_sec:06.3f}s -> {end_sec:06.3f}s (Dur: {end_sec - start_sec:.2f}s)",
                    f"  Character : {char}",
                    f"  Actor     : [Not Recorded]",
                    f"  Dialogue  : \"{dialogue_text}\"",
                    f"  Status    : Reference / Unrecorded",
                    "-" * 80,
                ])

            manifest_lines.append(line_entry)

        # Write Master_Vocal_Mix.mp3
        master_vocal_limited = master_soft_limiter(master_vocal_buffer, ceiling_db=-0.3)
        master_vocal_path = os.path.join(stems_dir, "Master_Vocal_Mix.mp3")
        try:
            write_mp3_mono(master_vocal_path, master_vocal_limited, sr=sr, bitrate=bitrate)
        except Exception as ex:
            print(f"[ProjectZip] Error writing Master_Vocal_Mix.mp3: {ex}")

        # Write Character Stems (Continuous timeline padded)
        for char, buf in char_buffers.items():
            assigned_uids = role_assignments.get(char, [])
            actor_names = [users.get(uid, {}).get("name", "Actor") for uid in assigned_uids if uid in users]
            actor_suffix = f"_{sanitize_filename(actor_names[0])}" if actor_names else ""
            char_filename = f"{sanitize_filename(char)}{actor_suffix}.mp3"
            char_stem_path = os.path.join(char_stems_dir, char_filename)
            char_limited = master_soft_limiter(buf, ceiling_db=-0.3)
            try:
                write_mp3_mono(char_stem_path, char_limited, sr=sr, bitrate=bitrate)
            except Exception as ex:
                print(f"[ProjectZip] Error writing character stem {char_filename}: {ex}")

        # Write Timeline_Cues.txt
        cues_txt_path = os.path.join(proj_root, "Timeline_Cues.txt")
        with open(cues_txt_path, "w", encoding="utf-8") as f:
            f.write("\n".join(cues_text_lines))

        # Write project_manifest.json
        manifest_data = {
            "application": "DubMate Studio Pro",
            "version": "2.3",
            "room_id": room_id,
            "pack_id": pack.pack_id,
            "pack_name": pack.name,
            "duration": round(pack.duration, 3),
            "sample_rate": sr,
            "bitrate": bitrate,
            "created_at": time.time(),
            "characters": characters,
            "role_assignments": role_assignments,
            "users": users,
            "lines": manifest_lines,
            "files": {
                "clean_video": f"Video/{pack_sanitized}_Clean_Video.mp4",
                "backing_track": "Audio_Stems/Backing_Music_SFX.mp3" if pack.backing_track_path else None,
                "master_vocal_mix": "Audio_Stems/Master_Vocal_Mix.mp3",
                "character_stems_dir": "Audio_Stems/Character_Stems/",
                "raw_takes_dir": "Raw_Takes/",
                "cues_text": "Timeline_Cues.txt",
            }
        }
        manifest_json_path = os.path.join(proj_root, "project_manifest.json")
        with open(manifest_json_path, "w", encoding="utf-8") as f:
            json.dump(manifest_data, f, indent=2)

        # 4. Create ZIP Archive
        if not output_zip_path:
            output_zip_path = os.path.join(CACHE_DIR, "exports", f"DubMate_Project_{pack.pack_id}_{room_id_safe}.zip")
        os.makedirs(os.path.dirname(os.path.abspath(output_zip_path)), exist_ok=True)

        with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(proj_root):
                for f in files:
                    file_path = os.path.join(root, f)
                    arcname = os.path.relpath(file_path, temp_stage_dir)
                    zf.write(file_path, arcname)

        return output_zip_path

    finally:
        if os.path.exists(temp_stage_dir):
            try:
                shutil.rmtree(temp_stage_dir, ignore_errors=True)
            except Exception:
                pass
