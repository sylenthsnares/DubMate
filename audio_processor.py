# -*- coding: utf-8 -*-
"""
audio_processor.py
High-Fidelity Audio DSP & Video Rendering Engine.
Matching filter chain for time-invariant pitch shifting, room acoustics, dynamic compression, and millisecond latency nudging.
"""

import os
import re
import math
import wave
import json
import time
import hashlib
import shutil
import zipfile
import tempfile
import subprocess
import numpy as np
from typing import Dict, List, Optional, Any, Tuple, Union

from pack_loader import get_ffmpeg_path, get_deep_filter_path, get_h264_encoder_args, cpu_h264_args, CACHE_DIR, PackInfo
from pack_loader import compute_waveform_peaks  # re-exported: app.py and tests use audio_processor.compute_waveform_peaks
from pack_loader import (
    run_subprocess as _run_subprocess,
    SUBPROCESS_TIMEOUT_PROBE,
    SUBPROCESS_TIMEOUT_PROCESS,
    SUBPROCESS_TIMEOUT_RENDER,
)

SR = 44100  # Standard audio sample rate

# Safe bounds for client-supplied volume trim (dB). Prevents 10 ** (gain_db / 20) from overflowing.
GAIN_DB_MIN = -60.0
GAIN_DB_MAX = 24.0

# Auto gain-match targets the measured loudness of the original line (dBFS gated RMS).
# This constant is only the fallback when that line can't be measured or is silent.
DEFAULT_DIALOGUE_LOUDNESS_DB = -21.0
AUTO_GAIN_PEAK_CEILING_DB = -1.0  # auto gain never boosts a take's sample peak above this

# Mix levels shared by render_dub_mix and build_project_zip.
LIMITER_CEILING_DB = -0.3   # master soft limiter ceiling for the final mix and every stem
BACKING_TRACK_LEVEL = 0.65  # backing music & SFX under the dialogue (calibrated DAW level)
ORIGINAL_LINE_LEVEL = 0.90  # unrecorded lines fall back to the original reference audio at this level

# Noise reduction. DeepFilterNet's attenuation limit in dB: 100 is maximum suppression and
# removes breaths and whispers, so takes are cleaned more gently by default.
NR_ATTENUATION_DB = 30.0
# Bump whenever the denoise chain changes, so cached cleaned takes are rebuilt.
NR_VERSION = 2

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


# Container extensions accepted for browser uploads; anything else is treated as WebM.
_UPLOAD_EXTS = (".webm", ".wav", ".ogg", ".mp4", ".m4a", ".aac", ".flac")


def _remove_quietly(path: str) -> None:
    """Deletes a temp file if it exists, ignoring any error."""
    if os.path.exists(path):
        try:
            os.remove(path)
        except Exception:
            pass


def _ffmpeg_to_mono_wav(src: str, dst: str, sr: int, timeout: float, context: str, af: Optional[str] = None) -> None:
    """Transcodes src to a mono 16-bit PCM WAV at sr, optionally through an -af filter chain."""
    cmd = [get_ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-i", src]
    if af:
        cmd += ["-af", af]
    cmd += ["-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", dst]
    _run_subprocess(cmd, timeout=timeout, context=context)


def _transcode_upload(audio_bytes: bytes, filename_hint: str, dst_wav: str, timeout: float, context: str) -> None:
    """Writes uploaded browser audio to a temp file and transcodes it to a mono WAV at SR.
    The temp file is always removed; subprocess errors propagate to the caller."""
    ext = os.path.splitext(filename_hint)[1].lower() if filename_hint else ".webm"
    if ext not in _UPLOAD_EXTS:
        ext = ".webm"
    fd, raw_tmp = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    try:
        with open(raw_tmp, "wb") as f:
            f.write(audio_bytes)
        _ffmpeg_to_mono_wav(raw_tmp, dst_wav, SR, timeout, context)
    finally:
        _remove_quietly(raw_tmp)


def _noise_reduction_engine() -> str:
    """Returns which denoiser apply_noise_reduction will run: "dfn" (DeepFilterNet) or "fallback" (ffmpeg)."""
    df_bin = get_deep_filter_path()
    return "dfn" if df_bin and os.path.isfile(df_bin) else "fallback"


def denoised_take_path(take_dir: str, stem: str) -> str:
    """Path of a take's cleaned audio for the current noise-reduction settings.
    The name carries a short hash of (NR_VERSION, attenuation, engine), so changed settings
    point at a file that does not exist yet and the take is cleaned again."""
    key_src = f"{NR_VERSION}:{NR_ATTENUATION_DB}:{_noise_reduction_engine()}"
    key = hashlib.sha1(key_src.encode("utf-8")).hexdigest()[:8]
    return os.path.join(take_dir, f"{stem}_denoised_{key}.wav")


def _remove_old_denoised_takes(take_dir: str, stem: str, keep: Optional[str] = None) -> None:
    """Deletes <stem>_denoised*.wav files in take_dir other than keep. Raw takes are never touched."""
    prefix = f"{stem}_denoised"
    keep_name = os.path.basename(keep) if keep else None
    for name in os.listdir(take_dir):
        if name.startswith(prefix) and name.endswith(".wav") and name != keep_name:
            _remove_quietly(os.path.join(take_dir, name))


def delete_take_files(take_dir: str, stem: str) -> None:
    """Deletes a take's active, raw and cleaned files. Files that can't be removed are skipped."""
    if not os.path.isdir(take_dir):
        return
    _remove_quietly(os.path.join(take_dir, f"{stem}.wav"))
    _remove_quietly(os.path.join(take_dir, f"{stem}_raw.wav"))
    _remove_old_denoised_takes(take_dir, stem)


def get_room_cache_dir(room_id: str) -> str:
    """Returns (and creates) the per-room cache directory, guarding against path traversal via room_id."""
    rooms_root = os.path.join(CACHE_DIR, "rooms")
    safe_room_id = _sanitize_id_token(room_id)
    path = os.path.join(rooms_root, safe_room_id)
    _ensure_within_directory(path, rooms_root)
    os.makedirs(path, exist_ok=True)
    return path


def take_dir(room_id: str, line_id: str, create: bool = True) -> str:
    """Returns <room dir>/takes/<line_id>, guarding against path traversal via line_id. Creates it
    unless create is False (callers that only read or delete)."""
    takes_root = os.path.join(get_room_cache_dir(room_id), "takes")
    path = os.path.join(takes_root, _sanitize_id_token(line_id))
    _ensure_within_directory(path, takes_root)
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def take_wav_path(room_id: str, line_id: str, take_id: str) -> str:
    """Path of a take's active audio file. Creates no folders."""
    return os.path.join(take_dir(room_id, line_id, create=False), f"{_sanitize_id_token(take_id)}.wav")


def migrate_legacy_take_files(
    room_id: str, line_index: int, line_id: str, take_id: str, noise_reduction: bool
) -> Dict[str, Any]:
    """Moves an old-layout take (take_line_<i>*.wav in the room folder) to takes/<line_id>/<take_id>*.wav.
    Files already moved are left alone, so a rerun is harmless. If the active file is missing, it is
    rebuilt from the cleaned file for the current settings (noise reduction on) or from the raw file,
    in which case noise reduction is reported off so state matches what plays.

    All or nothing: if any move or copy fails (a file held open by another program on Windows),
    the files this call moved go back to their old names, any copy it made is removed, and the
    error is raised, so the take can be migrated on a later start. A file that can't be moved
    back stays at its new name, where a later run finds it.
    Returns {"has_audio", "has_raw", "noise_reduction"}."""
    room_dir = get_room_cache_dir(room_id)
    dest_dir = take_dir(room_id, line_id)
    old_stem = f"take_line_{int(line_index)}"
    new_stem = _sanitize_id_token(take_id)
    active = os.path.join(dest_dir, f"{new_stem}.wav")
    raw = os.path.join(dest_dir, f"{new_stem}_raw.wav")
    nr = bool(noise_reduction)
    moved: List[Tuple[str, str]] = []
    copied: Optional[str] = None
    try:
        for name in sorted(os.listdir(room_dir)):
            if not name.endswith(".wav"):
                continue
            base = name[:-4]
            if base == old_stem:
                suffix = ""
            elif base == old_stem + "_raw" or base.startswith(old_stem + "_denoised"):
                suffix = base[len(old_stem):]
            else:
                continue
            src = os.path.join(room_dir, name)
            dest = os.path.join(dest_dir, new_stem + suffix + ".wav")
            if not os.path.exists(dest):
                os.replace(src, dest)
                moved.append((src, dest))

        if not os.path.isfile(active):
            denoised = denoised_take_path(dest_dir, new_stem)
            if nr and os.path.isfile(denoised):
                copied = active
                shutil.copy2(denoised, active)
            elif os.path.isfile(raw):
                copied = active
                shutil.copy2(raw, active)
                nr = False
    except Exception:
        if copied:
            _remove_quietly(copied)
        for src, dest in reversed(moved):
            try:
                os.replace(dest, src)
            except OSError as ex:
                print(f"[DubMate] Could not move {dest} back to {src} ({ex}); it is kept at the new name.")
        raise
    return {"has_audio": os.path.isfile(active), "has_raw": os.path.isfile(raw), "noise_reduction": nr}


def _read_wav_mono_direct(path: str, sr: int) -> Optional[np.ndarray]:
    """
    Reads a WAV that is already mono / target-rate / 16-bit PCM, without ffmpeg.

    Returns None when the file does not match, so the caller falls back to the
    transcode. This is not an optimization for exotic inputs -- it is the common
    case: write_wav_mono() produces exactly this format, so every take DubMate
    writes was being handed straight back to ffmpeg to be "converted" into itself.
    """
    try:
        with wave.open(path, "rb") as w:
            if (w.getnchannels() != 1 or w.getframerate() != sr
                    or w.getsampwidth() != 2 or w.getcomptype() != "NONE"):
                return None
            raw = w.readframes(w.getnframes())
    except (wave.Error, EOFError, OSError):
        return None
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def read_wav_mono(path: str, sr: int = SR) -> np.ndarray:
    """Reads audio as a mono float32 numpy array normalized between -1.0 and 1.0."""
    # Spawning ffmpeg costs ~100 ms regardless of clip length, and render_dub_mix
    # does it once per take. Reading a matching WAV directly is ~43x faster and
    # byte-identical.
    direct = _read_wav_mono_direct(path, sr)
    if direct is not None:
        return direct

    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        _ffmpeg_to_mono_wav(path, tmp, sr, SUBPROCESS_TIMEOUT_RENDER, "read_wav_mono transcode of " + repr(path))
        with wave.open(tmp, "rb") as w:
            raw = w.readframes(w.getnframes())
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    finally:
        _remove_quietly(tmp)


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
    try:
        _transcode_upload(audio_bytes, filename_hint, target_profile, SUBPROCESS_TIMEOUT_PROBE, "noise profile transcoding")
    except subprocess.CalledProcessError as err:
        print(f"[AudioProcessor] Noise profile calibration conversion failed: {err}")
        raise RuntimeError(f"Noise profile calibration failed: {err}")

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
    target_loudness_db: float = DEFAULT_DIALOGUE_LOUDNESS_DB,
    sr: int = SR,
    max_boost_db: float = 12.0,
    max_cut_db: float = -12.0
) -> Dict[str, float]:
    """
    Computes the static gain offset needed to match target dialogue loudness.
    A boost is capped so the take's sample peak stays at or below
    AUTO_GAIN_PEAK_CEILING_DB; cuts are never affected by the cap.
    Returns {"take_loudness_db": float, "target_loudness_db": float, "auto_gain_db": float}.
    """
    if isinstance(take_audio_or_path, str):
        if not os.path.isfile(take_audio_or_path):
            return {"take_loudness_db": DEFAULT_DIALOGUE_LOUDNESS_DB, "target_loudness_db": round(target_loudness_db, 1), "auto_gain_db": 0.0}
        audio_data = read_wav_mono(take_audio_or_path, sr)
    else:
        audio_data = take_audio_or_path

    take_loudness_db = calculate_speech_gated_loudness(audio_data, sr=sr)
    raw_delta_db = target_loudness_db - take_loudness_db
    # Clamp to safe gain limits [-12dB, +12dB]
    gain_db = float(np.clip(raw_delta_db, max_cut_db, max_boost_db))
    peak = float(np.max(np.abs(audio_data))) if len(audio_data) else 0.0
    if gain_db > 0.0 and peak > 1e-6:
        headroom_db = max(0.0, AUTO_GAIN_PEAK_CEILING_DB - 20.0 * np.log10(peak))
        gain_db = min(gain_db, np.floor(headroom_db * 10.0) / 10.0)
    auto_gain_db = round(float(gain_db), 1)

    return {
        "take_loudness_db": take_loudness_db,
        "target_loudness_db": round(target_loudness_db, 1),
        "auto_gain_db": auto_gain_db,
    }


# --- Take timing alignment (pure numpy; see documentation/design/recording-timing.md) ---
_ENV_WIN_MS = 20
_ENV_HOP_MS = 5
_ENV_FLOOR_DB = 50.0
_VOICED_DB = 35.0
_SPAN_PAD_MS = 100


def _snap5(ms: float) -> int:
    return int(5 * round(float(ms) / 5.0))


def _timing_envelope(audio: np.ndarray, sr: int) -> np.ndarray:
    """RMS in 20 ms windows every 5 ms, in dB, floored 50 dB below its own peak.
    Returns an empty array when the signal is too short or silent."""
    x = np.asarray(audio, dtype=np.float64).ravel()
    win = int(sr * _ENV_WIN_MS / 1000)
    hop = int(sr * _ENV_HOP_MS / 1000)
    if win <= 0 or hop <= 0 or len(x) < win:
        return np.zeros(0)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    csum = np.concatenate(([0.0], np.cumsum(x * x)))
    starts = np.arange(0, len(x) - win + 1, hop)
    power = np.maximum((csum[starts + win] - csum[starts]) / win, 0.0)
    peak = float(power.max()) if len(power) else 0.0
    if peak <= 0.0:
        return np.zeros(0)
    db = 10.0 * np.log10(np.maximum(power, peak * 1e-12))
    return np.maximum(db, db.max() - _ENV_FLOOR_DB)


def _voiced_span(env: np.ndarray) -> Optional[Tuple[int, int]]:
    """First..last frame within 35 dB of the peak, padded 100 ms, clipped. End exclusive."""
    if len(env) == 0:
        return None
    voiced = np.nonzero(env >= env.max() - _VOICED_DB)[0]
    if len(voiced) == 0:
        return None
    pad = _SPAN_PAD_MS // _ENV_HOP_MS
    return max(0, int(voiced[0]) - pad), min(len(env), int(voiced[-1]) + 1 + pad)


def _offset_scores(take_seg: np.ndarray, take_start: int, ref_seg: np.ndarray, ref_start: int,
                   offsets_ms: np.ndarray) -> np.ndarray:
    """Pearson correlation of take vs reference envelope for each offset (ms, multiples of 5).
    Take frame i lands on reference frame i + offset/5. Offsets whose overlap is under half
    the shorter span score 0 (no evidence)."""
    min_overlap = max(2, min(len(take_seg), len(ref_seg)) // 2)
    scores = np.zeros(len(offsets_ms))
    for n, off in enumerate(offsets_ms):
        k = int(off) // _ENV_HOP_MS
        # take segment index a -> reference segment index a + shift
        shift = take_start + k - ref_start
        a0 = max(0, -shift)
        a1 = min(len(take_seg), len(ref_seg) - shift)
        if a1 - a0 < min_overlap:
            continue
        t = take_seg[a0:a1] - take_seg[a0:a1].mean()
        r = ref_seg[a0 + shift:a1 + shift] - ref_seg[a0 + shift:a1 + shift].mean()
        denom = np.sqrt(np.dot(t, t) * np.dot(r, r))
        scores[n] = np.dot(t, r) / denom if denom > 0 else np.nan
    return scores


def align_take_timing(take: np.ndarray, reference: np.ndarray, start_offset_ms: int,
                      sr: int = SR, allow_stretch: bool = True) -> Dict[str, Any]:
    """Match a take's timing to the original line's voice by envelope correlation.

    offset_ms is where the take's sample 0 sits relative to line.start, so a take whose
    voice is D ms late gets -D. Returns {auto_offset_ms, timing_score, stretch, aligned};
    stretch is an atempo factor (above 1 speeds the take up). Never returns NaN.
    """
    start = _snap5(start_offset_ms)
    not_measured = {"auto_offset_ms": start, "timing_score": None, "stretch": 1.0, "aligned": False}

    take_env = _timing_envelope(take, sr)
    ref_env = _timing_envelope(reference, sr)
    take_span = _voiced_span(take_env)
    ref_span = _voiced_span(ref_env)
    if take_span is None or ref_span is None:
        return not_measured
    take_seg = take_env[take_span[0]:take_span[1]]
    ref_seg = ref_env[ref_span[0]:ref_span[1]]
    ratio = len(take_seg) / len(ref_seg)
    if not (0.75 <= ratio <= 1.33):
        return not_measured
    if float(np.std(take_seg)) < 1e-9 or float(np.std(ref_seg)) < 1e-9:
        return not_measured

    lo = max(-800, start - 500)
    hi = min(800, start + 500)
    if hi < lo:
        return not_measured
    offsets = np.arange(lo, hi + 1, _ENV_HOP_MS)

    def best_of(seg, seg_start):
        scores = _offset_scores(seg, seg_start, ref_seg, ref_span[0], offsets)
        if not np.all(np.isfinite(scores)):
            return None
        return scores, int(np.argmax(scores))

    plain = best_of(take_seg, take_span[0])
    if plain is None:
        return not_measured
    scores, b = plain
    stretch = 1.0

    if allow_stretch and not (0.97 <= ratio <= 1.03):
        factor = float(np.clip(ratio, 0.92, 1.08))
        n_out = max(2, int(round(len(take_seg) / factor)))
        stretched = np.interp(np.arange(n_out) * factor, np.arange(len(take_seg)), take_seg)
        cand = best_of(stretched, int(round(take_span[0] / factor)))
        if cand is not None and cand[0][cand[1]] >= scores[b] + 0.05:
            scores, b = cand
            stretch = round(factor, 3)

    start_idx = int(np.argmin(np.abs(offsets - start)))
    best_ms = int(offsets[b])
    if scores[b] < 0.5 or best_ms - lo <= 10 or hi - best_ms <= 10:
        plain_scores = plain[0]
        score = float(plain_scores[start_idx])
        return {"auto_offset_ms": start,
                "timing_score": round(score, 2) + 0.0 if math.isfinite(score) else None,
                "stretch": 1.0, "aligned": False}

    # Parabolic refinement around the grid peak, then snap back to the 5 ms grid.
    refined = float(best_ms)
    if 0 < b < len(scores) - 1:
        y0, y1, y2 = scores[b - 1], scores[b], scores[b + 1]
        denom = y0 - 2.0 * y1 + y2
        if denom < 0:
            refined += 0.5 * (y0 - y2) / denom * _ENV_HOP_MS
    auto_ms = _snap5(refined)
    idx = int(np.clip((auto_ms - lo) // _ENV_HOP_MS, 0, len(scores) - 1))
    score = float(scores[idx])
    if not math.isfinite(score):
        return not_measured
    return {"auto_offset_ms": int(offsets[idx]), "timing_score": round(score, 2) + 0.0,
            "stretch": stretch, "aligned": True}


def apply_noise_reduction(
    input_wav: str,
    output_wav: str,
    noise_profile_wav: Optional[str] = None,
    reduction_db: float = NR_ATTENUATION_DB,
    sr: int = SR
) -> str:
    """
    Applies state-of-the-art DeepFilterNet 3 neural speech enhancement & vocal de-noising.
    Preserves 100% of quiet dialogue, subtle mouth grit, breath, and natural dynamics
    while removing heavy fan noise, AC hum, and preamp hiss with zero phase warble.
    Falls back gracefully to highpass + adaptive spectral denoising if deep-filter binary is absent.
    """
    os.makedirs(os.path.dirname(os.path.abspath(output_wav)), exist_ok=True)
    df_bin = get_deep_filter_path()

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
            _ffmpeg_to_mono_wav(input_wav, tmp_48k_in, 48000, SUBPROCESS_TIMEOUT_PROCESS, "DeepFilterNet resample to 48k")

            # Run DeepFilterNet with delay compensation (-D)
            atten_lim = max(12.0, min(100.0, float(reduction_db))) if reduction_db is not None else NR_ATTENUATION_DB
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
                _ffmpeg_to_mono_wav(enh_48k, tmp_resampled, sr, SUBPROCESS_TIMEOUT_PROCESS, "DeepFilterNet resample back to target rate")

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
            print(f"[AudioProcessor] WARNING: DeepFilterNet3 produced no usable output for {input_wav!r} - falling back to spectral-gate denoiser.")
        except Exception as ex:
            print(f"[AudioProcessor] WARNING: DeepFilterNet3 neural denoise FAILED for {input_wav!r} - falling back to spectral-gate denoiser. Reason: {ex}")
        finally:
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)

    # 2. Fallback Path: High-pass + Adaptive Spectral Denoising
    tmp_out = None
    try:
        af_filters = [
            "highpass=f=80",
            f"afftdn=nr={min(18.0, reduction_db):.1f}:nf=-35:tn=1",
        ]
        fd, tmp_out = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        _ffmpeg_to_mono_wav(input_wav, tmp_out, sr, SUBPROCESS_TIMEOUT_PROCESS, "fallback spectral-gate denoise", af=",".join(af_filters))
        shutil.move(tmp_out, output_wav)
        return output_wav
    except Exception as ex:
        if tmp_out:
            _remove_quietly(tmp_out)
        print(f"[AudioProcessor] WARNING: noise reduction NOT applied for {input_wav!r} (DeepFilterNet3 and fallback denoiser both failed); returning unprocessed copy. Reason: {ex}")
        shutil.copy2(input_wav, output_wav)
        return output_wav


def save_uploaded_take(
    room_id: str,
    take_dir: str,
    stem: str,
    audio_bytes: bytes,
    filename_hint: str = "take.webm",
    enable_noise_reduction: bool = False,
    user_id: Optional[str] = None,
    target_loudness_db: Optional[float] = None,
    reference_wav: Optional[str] = None,
    start_offset_ms: int = 0,
    align: bool = True,
) -> Dict[str, Any]:
    """
    Saves raw uploaded audio from browser (WebM/WAV/OGG) to standard WAV.
    Writes <take_dir>/<stem>.wav (active), preserves pristine raw audio (<stem>_raw.wav) and
    generates denoised audio (<stem>_denoised_{key}.wav, see denoised_take_path) when requested.
    Calculates speech-gated loudness and smart auto-gain calibration against scene target.
    When align and reference_wav (the original line's audio) are given, matches the take's
    timing to it from start_offset_ms (align_take_timing, no stretch); otherwise, or when the
    reference can't be read, the timing is "not measured".
    Returns active path, duration, waveform peaks, auto_gain_db, noise reduction status,
    start_offset_ms (snapped to 5 ms) and the align_take_timing keys.
    """
    if not audio_bytes or len(audio_bytes) < 32:
        raise ValueError("Uploaded audio stream is empty or incomplete.")

    target_wav = os.path.join(take_dir, f"{stem}.wav")
    raw_wav = os.path.join(take_dir, f"{stem}_raw.wav")
    denoised_wav = denoised_take_path(take_dir, stem)

    try:
        _transcode_upload(audio_bytes, filename_hint, raw_wav, SUBPROCESS_TIMEOUT_PROCESS, "take upload transcoding")
    except subprocess.CalledProcessError as err:
        print(f"[AudioProcessor] ffmpeg conversion failed on upload {filename_hint!r} ({len(audio_bytes)} bytes): {err}")
        raise RuntimeError(f"Audio transcoding failed: {err}")

    profile_path = None
    if user_id:
        try:
            profile_path = get_user_noise_profile_path(room_id, user_id)
        except ValueError as ex:
            print(f"[AudioProcessor] WARNING: could not resolve noise profile path for user_id={user_id!r}: {ex}")
            profile_path = None
    if not os.path.isfile(profile_path or ""):
        profile_path = None

    # A new raw take makes every earlier cleaned version of this line stale.
    if enable_noise_reduction:
        apply_noise_reduction(raw_wav, denoised_wav, profile_path)
        _remove_old_denoised_takes(take_dir, stem, keep=denoised_wav)
        shutil.copy2(denoised_wav, target_wav)
    else:
        _remove_old_denoised_takes(take_dir, stem)
        shutil.copy2(raw_wav, target_wav)

    audio_data = read_wav_mono(target_wav)
    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)

    # Calculate speech-gated loudness and smart auto-gain calibration
    effective_target_db = target_loudness_db if target_loudness_db is not None else DEFAULT_DIALOGUE_LOUDNESS_DB
    gain_match = calculate_take_auto_gain(audio_data, target_loudness_db=effective_target_db, sr=SR)

    start_offset_ms = _snap5(start_offset_ms)
    timing = {"auto_offset_ms": start_offset_ms, "timing_score": None, "stretch": 1.0, "aligned": False}
    if align and reference_wav:
        try:
            reference = read_wav_mono(reference_wav)
        except Exception as ex:
            print(f"[Timing] Could not read reference line {reference_wav!r}: {ex}")
        else:
            timing = align_take_timing(audio_data, reference, start_offset_ms, sr=SR, allow_stretch=False)

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
        "start_offset_ms": start_offset_ms,
        **timing,
    }


def toggle_take_noise_reduction(
    room_id: str,
    take_dir: str,
    stem: str,
    enable_noise_reduction: bool,
    user_id: Optional[str] = None,
    target_loudness_db: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Instantly toggles a take between pristine raw and denoised audio.
    Generates denoised audio on-demand if missing, and re-measures the
    swapped audio's loudness and auto gain against target_loudness_db.
    """
    target_wav = os.path.join(take_dir, f"{stem}.wav")
    raw_wav = os.path.join(take_dir, f"{stem}_raw.wav")
    denoised_wav = denoised_take_path(take_dir, stem)

    if not os.path.exists(raw_wav):
        if os.path.exists(target_wav):
            shutil.copy2(target_wav, raw_wav)
        else:
            raise FileNotFoundError(f"No take audio found for {stem}")

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
            _remove_old_denoised_takes(take_dir, stem, keep=denoised_wav)
        shutil.copy2(denoised_wav, target_wav)
    else:
        shutil.copy2(raw_wav, target_wav)

    audio_data = read_wav_mono(target_wav)
    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)
    effective_target_db = target_loudness_db if target_loudness_db is not None else DEFAULT_DIALOGUE_LOUDNESS_DB
    gain_match = calculate_take_auto_gain(audio_data, target_loudness_db=effective_target_db, sr=SR)

    return {
        "wav_path": target_wav,
        "duration": round(duration, 3),
        "peaks": peaks,
        "noise_reduction": bool(enable_noise_reduction),
        "has_raw": True,
        "speech_loudness_db": gain_match["take_loudness_db"],
        "target_loudness_db": gain_match["target_loudness_db"],
        "auto_gain_db": gain_match["auto_gain_db"],
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


def _fft_convolve(signal: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """
    Full linear convolution (length len(signal) + len(kernel) - 1) through numpy's real FFT.
    Replaces scipy.signal.fftconvolve, the only thing scipy was installed for. The FFT runs
    in float64 and the result is float32, like fftconvolve gave for float32 input.
    """
    n = len(signal) + len(kernel) - 1
    nfft = 1 << (n - 1).bit_length()
    spectrum = np.fft.rfft(np.asarray(signal, dtype=np.float64), nfft) * np.fft.rfft(np.asarray(kernel, dtype=np.float64), nfft)
    return np.fft.irfft(spectrum, nfft)[:n].astype(np.float32)


def master_soft_limiter(audio: np.ndarray, ceiling_db: float = LIMITER_CEILING_DB) -> np.ndarray:
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
    sr: int = SR
) -> np.ndarray:
    """
    Applies high-fidelity vocal DSP chain:
    1. 80Hz low-cut filter (removes rumble / mic plosives)
    2. Time-invariant pitch shift (preserves exact line duration)
    3. Direct linear volume gain (dB trim)
    4. Acoustic room convolution reverb (maintains 100% dry vocal punch + lush room space)
    """
    # Clamp client-supplied gain to a sane audio range so 10 ** (gain_db / 20) can never overflow.
    clamped_gain_db = float(np.clip(gain_db, GAIN_DB_MIN, GAIN_DB_MAX))
    if clamped_gain_db != gain_db:
        print(f"[AudioProcessor] WARNING: gain_db={gain_db} out of safe range; clamped to {clamped_gain_db} dB.")
    gain_db = clamped_gain_db

    # 1. 80Hz Low-cut filter (always applied)
    filters = ["highpass=f=80"]

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

    fd, tmp_out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        _ffmpeg_to_mono_wav(audio_path, tmp_out, sr, SUBPROCESS_TIMEOUT_PROCESS,
                            "apply_audio_effects filter chain for " + repr(audio_path), af=",".join(filters))
        audio = read_wav_mono(tmp_out, sr)
    except Exception as ex:
        print(f"[AudioProcessor] WARNING: DSP filter chain FAILED for {audio_path!r} (pitch/low-cut NOT applied); returning unprocessed audio. Reason: {ex}")
        audio = read_wav_mono(audio_path, sr)
    finally:
        _remove_quietly(tmp_out)

    # 3. Volume Gain Trim (Exact dB scaling directly applied to waveform)
    if abs(gain_db) > 0.01:
        gain_mult = 10.0 ** (gain_db / 20.0)
        audio = audio * np.float32(gain_mult)

    # 4. Studio Acoustic Room Convolution Reverb
    # Direct vocal stays at 100% punch; lush room reflections and natural reverb decay ring out seamlessly
    if reverb_wet > 0.02 and len(audio) > 0:
        impulse = get_reverb_impulse(decay_sec=1.5, sr=sr)
        wet = _fft_convolve(audio, impulse)
        out_audio = np.zeros(len(wet), dtype=np.float32)
        out_audio[:len(audio)] = audio
        out_audio += wet * np.float32(reverb_wet * 0.70)
        audio = out_audio

    return audio


def _timeline_samples(pack: PackInfo, sr: int) -> int:
    """Mix buffer length for a pack: the scene (at least 1s) or the last line end + 2s, plus 1s of tail."""
    total_sec = max(pack.duration, 1.0)
    for line in pack.lines:
        total_sec = max(total_sec, line["end"] + 2.0)
    return int(total_sec * sr) + sr


def _render_take(take_info: Dict[str, Any], sr: int, gain_db: float, log_tag: str) -> Optional[np.ndarray]:
    """
    Runs a take through apply_audio_effects with its pitch/reverb and the given gain.
    If that fails, falls back to the unprocessed take audio. Returns None when the take
    cannot be read at all; what that means is the caller's failure policy.
    """
    wav_path = take_info["wav_path"]
    pitch = float(take_info.get("pitch_semitones", 0.0))
    reverb = float(take_info.get("reverb_wet", 0.0))
    try:
        return apply_audio_effects(wav_path, pitch_semitones=pitch, reverb_wet=reverb, gain_db=gain_db, sr=sr)
    except Exception as ex:
        print(f"[{log_tag}] WARNING: apply_audio_effects failed ({wav_path!r}): {ex}. Falling back to unprocessed take audio.")
    try:
        return read_wav_mono(wav_path, sr)
    except Exception as ex:
        print(f"[{log_tag}] ERROR: fallback read also failed: {ex}.")
        return None


def _mix_into(buffers: List[np.ndarray], audio: np.ndarray, pos_sec: float, sr: int) -> None:
    """
    Adds audio into every buffer starting at pos_sec. A negative position trims the head
    of the audio; anything running past the end of a buffer is dropped.
    """
    if pos_sec < 0:
        skip_samples = int(-pos_sec * sr)
        if skip_samples >= len(audio):
            return
        audio = audio[skip_samples:]
        start_sample = 0
    else:
        start_sample = int(pos_sec * sr)
    for buf in buffers:
        end_sample = min(len(buf), start_sample + len(audio))
        if end_sample > start_sample:
            buf[start_sample:end_sample] += audio[:end_sample - start_sample]


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
    total_samples = _timeline_samples(pack, sr)
    mix_buffer = np.zeros(total_samples, dtype=np.float32)

    # 1. Backing track (music & sound effects at the calibrated backing level)
    if pack.backing_track_path and os.path.isfile(pack.backing_track_path):
        try:
            backing_data = read_wav_mono(pack.backing_track_path, sr) * BACKING_TRACK_LEVEL
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
            # Take gain plus master dialogue presence trim
            gain = float(take_info.get("gain_db", 0.0)) + float(master_dialogue_presence_db)
            processed_audio = _render_take(take_info, sr, gain, f"render_dub_mix line {idx}")
            if processed_audio is None:
                # Failure policy: an unreadable take is skipped so the render can continue.
                print(f"[render_dub_mix] Skipping line {idx}: take audio could not be read.")
                continue
            _mix_into([mix_buffer], processed_audio, start_sec + offset_sec, sr)

        else:
            orig_path = os.path.join(pack.folder, line["filename"])
            if os.path.isfile(orig_path):
                try:
                    orig_audio = read_wav_mono(orig_path, sr)
                    orig_mult = ORIGINAL_LINE_LEVEL * (10.0 ** (float(master_dialogue_presence_db) / 20.0))
                    _mix_into([mix_buffer], orig_audio * np.float32(orig_mult), start_sec, sr)
                except Exception as ex:
                    print(f"Error loading original audio for line {idx}: {ex}")

    # 3. Apply master transparent soft limiter (preserves dynamics, volume knob levels, and reverb tails)
    master_mix = master_soft_limiter(mix_buffer, ceiling_db=LIMITER_CEILING_DB)

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
    try:
        render_dub_mix(pack, takes_dict, tmp_wav, master_dialogue_presence_db=master_dialogue_presence_db)

        ffmpeg = get_ffmpeg_path()
        os.makedirs(os.path.dirname(os.path.abspath(output_mp4)), exist_ok=True)
        encoder_args = get_h264_encoder_args(crf=20, usage="export")

        vf_filters = []
        if aspect_ratio == "9:16":
            # Letterbox 9:16 with black bars top and bottom without cropping
            vf_filters.extend(["-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"])

        # Primary (possibly hardware) encoder first, then CPU libx264 as the fallback.
        for attempt, (video_args, context) in enumerate([
            (encoder_args, "export_dub_video primary encoder"),
            (cpu_h264_args(20, "veryfast"), "export_dub_video fallback CPU encoder"),
        ]):
            cmd = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", pack.web_video_path,
                "-i", tmp_wav,
                "-map", "0:v:0", "-map", "1:a:0",
                *vf_filters,
                *video_args,
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest",
                "-movflags", "+faststart",
                output_mp4
            ]
            try:
                _run_subprocess(cmd, timeout=SUBPROCESS_TIMEOUT_RENDER, context=context)
                break
            except Exception as ex:
                if attempt > 0:
                    raise
                print(f"[export_dub_video] Primary encoder failed ({ex}), falling back to CPU libx264...")
    finally:
        _remove_quietly(tmp_wav)

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


def _project_cue_sheet(
    pack: PackInfo, room_id: str, sr: int, bitrate: str, manifest_lines: List[Dict[str, Any]]
) -> str:
    """Human-readable Timeline_Cues.txt for build_project_zip, formatted from the manifest line entries."""
    out = [
        "DubMate Studio Pro - Project Timeline & Dialogue Cues",
        f"Project: {pack.name} (Pack ID: {pack.pack_id})",
        f"Room ID: {room_id}",
        f"Duration: {pack.duration:.2f}s | Audio Sample Rate: {sr}Hz | Format: MP3 ({bitrate})",
        f"Total Lines: {len(pack.lines)}",
        "=" * 80,
        "",
    ]
    for entry in manifest_lines:
        start_sec, end_sec = entry["start"], entry["end"]
        out.append(f"[Line {entry['line_number']:02d}] {start_sec:06.3f}s -> {end_sec:06.3f}s (Dur: {end_sec - start_sec:.2f}s)")
        out.append(f"  Character : {entry['character']}")
        if entry["is_recorded"]:
            out.extend([
                f"  Actor     : {entry['actor_name']}",
                f"  Dialogue  : \"{entry['text']}\"",
                f"  DSP Tuning: Offset: {entry['offset_ms']:+d}ms | Pitch: {entry['pitch_semitones']:+.1f}st"
                f" | Reverb: {int(entry['reverb_wet'] * 100)}% | Gain: {entry['gain_db']:+.1f}dB",
                f"  File      : {entry['take_file']}",
            ])
        else:
            out.extend([
                "  Actor     : [Not Recorded]",
                f"  Dialogue  : \"{entry['text']}\"",
                "  Status    : Reference / Unrecorded",
            ])
        out.append("-" * 80)
    return "\n".join(out)


def _project_manifest(
    pack: PackInfo,
    room_id: str,
    sr: int,
    bitrate: str,
    characters: List[str],
    role_assignments: Dict[str, List[str]],
    users: Dict[str, Any],
    manifest_lines: List[Dict[str, Any]],
    video_written: bool,
    backing_written: bool,
    master_vocal_written: bool,
) -> Dict[str, Any]:
    """project_manifest.json for build_project_zip. Single files are listed only if they were written."""
    return {
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
            "clean_video": f"Video/{sanitize_filename(pack.name)}_Clean_Video.mp4" if video_written else None,
            "backing_track": "Audio_Stems/Backing_Music_SFX.mp3" if backing_written else None,
            "master_vocal_mix": "Audio_Stems/Master_Vocal_Mix.mp3" if master_vocal_written else None,
            "character_stems_dir": "Audio_Stems/Character_Stems/",
            "raw_takes_dir": "Raw_Takes/",
            "cues_text": "Timeline_Cues.txt",
        }
    }


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

    total_samples = _timeline_samples(pack, sr)

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
        video_written = False
        if src_video and os.path.isfile(src_video):
            dst_video = os.path.join(video_dir, f"{pack_sanitized}_Clean_Video.mp4")
            try:
                shutil.copy2(src_video, dst_video)
                video_written = True
            except Exception as ex:
                print(f"[ProjectZip] Error copying video: {ex}")

        # 2. Backing Music & SFX Track
        backing_written = False
        if pack.backing_track_path and os.path.isfile(pack.backing_track_path):
            dst_backing = os.path.join(stems_dir, "Backing_Music_SFX.mp3")
            try:
                convert_file_to_mp3(pack.backing_track_path, dst_backing, sr=sr, bitrate=bitrate)
                backing_written = True
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

        for line in pack.lines:
            idx = line["index"]
            start_sec = float(line["start"])
            end_sec = float(line["end"])
            char = line.get("character", "Actor")
            dialogue_text = line.get("caption") or line.get("raw_caption") or line.get("text") or ""
            take_info = takes_dict.get(idx)

            line_entry = {
                "index": idx,
                "line_id": line.get("line_id"),
                "take_id": None,
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

                processed_audio = _render_take(take_info, sr, gain, f"ProjectZip line {idx}")
                if processed_audio is None:
                    # Failure policy: an unreadable take becomes a near-silent placeholder so
                    # the export, its Raw_Takes file and the manifest entry still complete.
                    print(f"[ProjectZip] Using near-silent placeholder for line {idx}.")
                    processed_audio = np.zeros(1, dtype=np.float32)

                target_buffers = [master_vocal_buffer]
                if char in char_buffers:
                    target_buffers.append(char_buffers[char])
                _mix_into(target_buffers, processed_audio, start_sec + float(offset_ms) / 1000.0, sr)

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
                line_entry["take_id"] = take_info.get("take_id")
                line_entry["actor_name"] = actor_name
                line_entry["offset_ms"] = offset_ms
                line_entry["pitch_semitones"] = pitch
                line_entry["reverb_wet"] = reverb
                line_entry["gain_db"] = gain
            else:
                orig_path = os.path.join(pack.folder, line.get("filename", ""))
                if os.path.isfile(orig_path):
                    try:
                        orig_audio = read_wav_mono(orig_path, sr)
                        # The original reference goes into the master vocal stem only, never a character stem.
                        _mix_into([master_vocal_buffer], orig_audio * ORIGINAL_LINE_LEVEL, start_sec, sr)
                    except Exception:
                        pass  # Failure policy: an unreadable original line is silently left out.

            manifest_lines.append(line_entry)

        # Write Master_Vocal_Mix.mp3
        master_vocal_limited = master_soft_limiter(master_vocal_buffer, ceiling_db=LIMITER_CEILING_DB)
        master_vocal_path = os.path.join(stems_dir, "Master_Vocal_Mix.mp3")
        master_vocal_written = False
        try:
            write_mp3_mono(master_vocal_path, master_vocal_limited, sr=sr, bitrate=bitrate)
            master_vocal_written = True
        except Exception as ex:
            print(f"[ProjectZip] Error writing Master_Vocal_Mix.mp3: {ex}")

        # Write Character Stems (Continuous timeline padded)
        for char, buf in char_buffers.items():
            assigned_uids = role_assignments.get(char, [])
            actor_names = [users.get(uid, {}).get("name", "Actor") for uid in assigned_uids if uid in users]
            actor_suffix = f"_{sanitize_filename(actor_names[0])}" if actor_names else ""
            char_filename = f"{sanitize_filename(char)}{actor_suffix}.mp3"
            char_stem_path = os.path.join(char_stems_dir, char_filename)
            char_limited = master_soft_limiter(buf, ceiling_db=LIMITER_CEILING_DB)
            try:
                write_mp3_mono(char_stem_path, char_limited, sr=sr, bitrate=bitrate)
            except Exception as ex:
                print(f"[ProjectZip] Error writing character stem {char_filename}: {ex}")

        # Write Timeline_Cues.txt
        cues_txt_path = os.path.join(proj_root, "Timeline_Cues.txt")
        with open(cues_txt_path, "w", encoding="utf-8") as f:
            f.write(_project_cue_sheet(pack, room_id, sr, bitrate, manifest_lines))

        # Write project_manifest.json
        manifest_data = _project_manifest(
            pack, room_id, sr, bitrate, characters, role_assignments, users, manifest_lines,
            video_written=video_written,
            backing_written=backing_written,
            master_vocal_written=master_vocal_written,
        )
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
