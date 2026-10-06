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
import functools
import shutil
import zipfile
import tempfile
import threading
import subprocess
import numpy as np
from typing import Dict, List, Optional, Any, Tuple, Union

from pack_loader import get_ffmpeg_path, get_deep_filter_path, get_h264_encoder_args, cpu_h264_args, CACHE_DIR, PackInfo
from pack_loader import compute_waveform_peaks  # re-exported: app.py and tests use audio_processor.compute_waveform_peaks
from dubmate import vocal_chain
from dubmate.vocal_chain import _fft_convolve  # K-weighting runs through the reverb's FFT convolution
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

# Auto gain-match targets the measured loudness of the original line (integrated LUFS).
# DEFAULT_DIALOGUE_LUFS is only the fallback when that line can't be measured or reads
# at or below DIALOGUE_LUFS_FLOOR.
DEFAULT_DIALOGUE_LUFS = -21.0
DIALOGUE_LUFS_FLOOR = -55.0
AUTO_GAIN_PEAK_CEILING_DB = -1.0  # auto gain never boosts a take's sample peak above this

# Master stage on the final mix (render, export, project ZIP stems).
MASTER_TARGET_LUFS = -16.0
MASTER_GAIN_LIMIT_DB = 24.0          # the loudness gain is clamped to +/- this
MASTER_LIMITER_CEILING_DB = -1.5     # true-peak limiter ceiling (dBTP)
TRUE_PEAK_CEILING_DB = -1.0          # static trim if the limited mix still reads above this
LUFS_FLOOR = -70.0                   # silence; also BS.1770's absolute gate

# Mix levels shared by render_dub_mix and build_project_zip.
BACKING_TRACK_LEVEL = 0.65  # backing music & SFX under the dialogue (calibrated DAW level)
ORIGINAL_LINE_LEVEL = 0.90  # unrecorded lines fall back to the original reference audio at this level

# Noise reduction. DeepFilterNet's attenuation limit in dB: 100 is maximum suppression and
# removes breaths and whispers, so takes are cleaned more gently by default.
NR_ATTENUATION_DB = 30.0
# Bump whenever the denoise chain changes, so cached cleaned takes are rebuilt.
NR_VERSION = 2

# Render cache (render_take_cached): bump RENDER_VERSION whenever a render's samples change
# for the same take and chain, so old cached renders are never played again.
RENDER_VERSION = 2
RENDER_CACHE_MAX_BYTES = 500 * 1024 * 1024
RENDER_KEEP_RECENT_S = 600       # eviction never deletes a render used in the last 10 minutes
RENDER_TMP_MAX_AGE_S = 3600      # stray temp files older than this are removed on eviction

EFFECTS_MISSING_MESSAGE = "Download and install the latest DubMate to use voice effects."


class EffectsUnavailable(RuntimeError):
    """The voice effects (pedalboard) aren't installed, so nothing can be rendered or exported.
    Only an install that predates them gets here (a source checkout not yet updated, or a
    desktop install updated by a launcher older than the dependency step); the engine
    never installs packages itself."""

    def __init__(self, message: str = EFFECTS_MISSING_MESSAGE):
        super().__init__(message)


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


def _write_active_take(source_wav: str, target_wav: str, stretch: float = 1.0) -> None:
    """Writes a take's active audio: source_wav (its raw or cleaned file) played at `stretch`
    speed (an atempo factor; 1.0 is a plain copy). Goes through <stem>.tmp.wav and os.replace,
    so a failed pass leaves the previous active file intact."""
    tmp = os.path.splitext(target_wav)[0] + ".tmp.wav"
    try:
        if abs(stretch - 1.0) <= 0.0005:
            shutil.copy2(source_wav, tmp)
        else:
            _ffmpeg_to_mono_wav(source_wav, tmp, SR, SUBPROCESS_TIMEOUT_PROCESS, "take fitting",
                                af=f"atempo={stretch:.4f}")
        os.replace(tmp, target_wav)
    except Exception:
        _remove_quietly(tmp)
        raise


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


def _read_wav_float_direct(path: str, sr: int) -> Optional[np.ndarray]:
    """
    Reads a mono / target-rate / 32-bit float WAV (what write_wav_float writes), samples
    above full scale kept. Returns None for any other file.
    """
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    fmt_ok = False
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = int.from_bytes(data[pos + 4:pos + 8], "little")
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            if len(body) < 16:
                return None
            tag = int.from_bytes(body[0:2], "little")
            channels = int.from_bytes(body[2:4], "little")
            rate = int.from_bytes(body[4:8], "little")
            bits = int.from_bytes(body[14:16], "little")
            fmt_ok = tag == _WAVE_FORMAT_IEEE_FLOAT and channels == 1 and rate == sr and bits == 32
            if not fmt_ok:
                return None
        elif cid == b"data":
            if not fmt_ok:
                return None
            usable = len(body) - len(body) % 4
            return np.frombuffer(body[:usable], dtype="<f4").astype(np.float32)
        pos += 8 + size + (size & 1)
    return None


def read_wav_mono(path: str, sr: int = SR) -> np.ndarray:
    """Reads audio as a mono float32 numpy array normalized between -1.0 and 1.0."""
    # Spawning ffmpeg costs ~100 ms regardless of clip length, and render_dub_mix
    # does it once per take. Reading a matching WAV directly is ~43x faster and
    # byte-identical.
    direct = _read_wav_mono_direct(path, sr)
    if direct is not None:
        return direct
    direct = _read_wav_float_direct(path, sr)
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


_WAVE_FORMAT_IEEE_FLOAT = 3


def write_wav_float(path: str, data: np.ndarray, sr: int = SR) -> str:
    """Writes a float32 numpy array to a mono 32-bit float WAV. Samples above full scale
    are kept, so a level applied later can bring them back without distortion."""
    data = np.ascontiguousarray(_sanitize_finite_audio(data, context="write_wav_float(" + repr(path) + ")"),
                                dtype="<f4")
    payload = data.tobytes()
    fmt = (_WAVE_FORMAT_IEEE_FLOAT.to_bytes(2, "little") + (1).to_bytes(2, "little")
           + int(sr).to_bytes(4, "little") + (int(sr) * 4).to_bytes(4, "little")
           + (4).to_bytes(2, "little") + (32).to_bytes(2, "little") + (0).to_bytes(2, "little"))
    fact = len(data).to_bytes(4, "little")
    chunks = (b"fmt " + len(fmt).to_bytes(4, "little") + fmt
              + b"fact" + len(fact).to_bytes(4, "little") + fact
              + b"data" + len(payload).to_bytes(4, "little") + payload)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"RIFF" + (4 + len(chunks)).to_bytes(4, "little") + b"WAVE" + chunks)
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


# --- Loudness: ITU-R BS.1770-4 integrated loudness and true peak (pure numpy) ---
#
# integrated_lufs follows pyloudnorm's Meter.integrated_loudness (K-weighting filters,
# block gating), ported to numpy without scipy:
#
#   MIT License
#
#   Copyright (c) 2018 Christian Steinmetz
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy
#   of this software and associated documentation files (the "Software"), to deal
#   in the Software without restriction, including without limitation the rights
#   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
#   copies of the Software, and to permit persons to whom the Software is
#   furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all
#   copies or substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
#   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.

_LUFS_BLOCK_S = 0.400
_LUFS_OVERLAP = 0.75
_LUFS_RELATIVE_GATE_LU = -10.0
_KW_FIR_BLOCK = 1 << 16      # K-weighting is applied as an FIR in blocks of this many samples
_TP_OVERSAMPLE = 4
_TP_TAPS = 48                # taps per phase of the true-peak interpolator
_TP_BLOCK = 8192


def _k_weighting_biquads(sr: int) -> List[Tuple[Tuple[float, float, float], Tuple[float, float, float]]]:
    """pyloudnorm's two K-weighting stages for the rate: high shelf (+4 dB, Q 1/sqrt 2,
    1500 Hz), then high pass (Q 0.5, 38 Hz). Returns [(b, a), ...] normalised by a0."""
    stages = []
    for gain_db, q, fc, kind in ((4.0, 1.0 / math.sqrt(2.0), 1500.0, "high_shelf"), (0.0, 0.5, 38.0, "high_pass")):
        a_lin = 10.0 ** (gain_db / 40.0)
        w0 = 2.0 * math.pi * (fc / sr)
        alpha = math.sin(w0) / (2.0 * q)
        cw = math.cos(w0)
        if kind == "high_shelf":
            sa = 2.0 * math.sqrt(a_lin) * alpha
            b = (a_lin * ((a_lin + 1) + (a_lin - 1) * cw + sa),
                 -2.0 * a_lin * ((a_lin - 1) + (a_lin + 1) * cw),
                 a_lin * ((a_lin + 1) + (a_lin - 1) * cw - sa))
            a = ((a_lin + 1) - (a_lin - 1) * cw + sa,
                 2.0 * ((a_lin - 1) - (a_lin + 1) * cw),
                 (a_lin + 1) - (a_lin - 1) * cw - sa)
        else:
            b = ((1 + cw) / 2.0, -(1 + cw), (1 + cw) / 2.0)
            a = (1 + alpha, -2.0 * cw, 1 - alpha)
        stages.append((tuple(v / a[0] for v in b), tuple(v / a[0] for v in a)))
    return stages


@functools.lru_cache(maxsize=4)
def _k_weighting_ir(sr: int) -> np.ndarray:
    """1 s impulse response of the K-weighting cascade (it decays below 1e-7 well before),
    computed once per rate by running the biquads on an impulse."""
    n = int(sr)
    signal = [0.0] * n
    signal[0] = 1.0
    for (b0, b1, b2), (_, a1, a2) in _k_weighting_biquads(sr):
        x1 = x2 = y1 = y2 = 0.0
        out = [0.0] * n
        for i in range(n):
            x0 = signal[i]
            y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            out[i] = y0
            x2, x1, y2, y1 = x1, x0, y1, y0
        signal = out
    return np.asarray(signal, dtype=np.float64)


def _k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    """K-weighted copy of a mono signal (same length, float32): the impulse response applied
    by overlap-add over 2^16-sample blocks, so memory stays small for any length."""
    h = _k_weighting_ir(int(sr))
    n = len(x)
    out = np.zeros(n, dtype=np.float32)
    for start in range(0, n, _KW_FIR_BLOCK):
        seg = _fft_convolve(x[start:start + _KW_FIR_BLOCK], h)
        end = min(n, start + len(seg))
        out[start:end] += seg[:end - start]
    return out


def integrated_lufs(x: np.ndarray, sr: int = SR) -> float:
    """
    Integrated loudness (LUFS) of a mono signal, ITU-R BS.1770-4: K-weighting, 400 ms
    blocks with 75 % overlap, -70 LUFS absolute gate, -10 LU relative gate. A signal
    shorter than one block is measured as its ungated mean square. Silence reads -70.
    """
    audio = np.asarray(x, dtype=np.float32).reshape(-1)
    if not len(audio):
        return LUFS_FLOOR
    weighted = _k_weight(audio, sr)
    block_len = _LUFS_BLOCK_S * sr
    if len(weighted) < block_len:
        seg = weighted.astype(np.float64)
        gated = np.array([float(np.dot(seg, seg)) / len(seg)])
    else:
        step = 1.0 - _LUFS_OVERLAP
        total_s = len(weighted) / float(sr)
        n_blocks = int(np.round((total_s - _LUFS_BLOCK_S) / (_LUFS_BLOCK_S * step))) + 1
        z = np.empty(n_blocks, dtype=np.float64)
        for j in range(n_blocks):
            lo = int(_LUFS_BLOCK_S * (j * step) * sr)
            hi = int(_LUFS_BLOCK_S * (j * step + 1) * sr)
            seg = weighted[lo:hi].astype(np.float64)
            z[j] = float(np.dot(seg, seg)) / block_len
        with np.errstate(divide="ignore"):
            block_lufs = -0.691 + 10.0 * np.log10(z)
        gated = z[block_lufs >= LUFS_FLOOR]
        if len(gated):
            relative_gate = -0.691 + 10.0 * np.log10(np.mean(gated)) + _LUFS_RELATIVE_GATE_LU
            gated = z[(block_lufs > relative_gate) & (block_lufs > LUFS_FLOOR)]
    mean_square = float(np.mean(gated)) if len(gated) else 0.0
    if mean_square <= 0.0:
        return LUFS_FLOOR
    return max(LUFS_FLOOR, -0.691 + 10.0 * math.log10(mean_square))


@functools.lru_cache(maxsize=1)
def _true_peak_phases() -> np.ndarray:
    """(48, 4) matrix of the 4x interpolator: column k is the windowed-sinc phase that
    reads the signal k/4 of a sample after the centre of a 48-sample window (Kaiser,
    beta 8). Phase 0 is the centre sample itself, so the true peak is never below the
    sample peak."""
    m = np.arange(_TP_TAPS, dtype=np.float64)
    half = _TP_TAPS / 2.0 + 1.0
    cols = []
    for k in range(_TP_OVERSAMPLE):
        t = (_TP_TAPS // 2) - m + k / float(_TP_OVERSAMPLE)
        window = np.i0(8.0 * np.sqrt(1.0 - (t / half) ** 2)) / np.i0(8.0)
        cols.append(np.sinc(t) * window)
    return np.stack(cols, axis=1)


def _true_peak_envelope(audio: np.ndarray, first: int) -> np.ndarray:
    """Per-sample true peak of a mono signal: element i is the largest |value| of the 4x
    interpolated waveform at positions first+i, +1/4, +1/2 and +3/4, for every position
    from first to len(audio)-1 (samples outside the signal read as 0). Runs in blocks."""
    n = len(audio)
    phases = _true_peak_phases()
    half = _TP_TAPS // 2
    env = np.zeros(max(n - first, 0), dtype=np.float64)
    for centre in range(first, n, _TP_BLOCK):
        count = min(_TP_BLOCK, n - centre)
        lo, hi = centre - half, centre + count - 1 + _TP_TAPS - half
        seg = np.zeros(hi - lo, dtype=np.float64)
        a, b = max(lo, 0), min(hi, n)
        if b > a:
            seg[a - lo:b - lo] = audio[a:b]
        block = env[centre - first:centre - first + count]
        for k in range(_TP_OVERSAMPLE):
            np.maximum(block, np.abs(np.convolve(seg, phases[::-1, k], mode="valid")), out=block)
    return env


def true_peak_db(x: np.ndarray) -> float:
    """True peak (dBTP) of a mono signal: 4x oversampled by a polyphase windowed-sinc
    interpolator (48 taps per phase), in blocks. Silence reads -120."""
    audio = np.asarray(x, dtype=np.float32).reshape(-1)
    env = _true_peak_envelope(audio, -(_TP_TAPS // 2))
    peak = float(np.max(env)) if len(env) else 0.0
    return 20.0 * math.log10(peak) if peak > 1e-6 else -120.0


# Master limiter: a true-peak limiter with lookahead and no clipper. The gain each sample
# needs comes from the 4x oversampled envelope, so inter-sample overs are prevented rather
# than trimmed off the whole mix afterwards. It runs offline, so the lookahead adds no
# delay: the gain ramps down over _LIMITER_ATTACK_S ahead of a peak and reaches what the
# peak needs exactly on it, then recovers at _LIMITER_RELEASE_PER_S (linear gain per
# second: quick out of a deep reduction, gentler near unity).
_LIMITER_ATTACK_S = 0.003
_LIMITER_RELEASE_PER_S = 10.0
_MASTER_MAX_PASSES = 6        # master_stage measures the limited mix at most this often
_MASTER_TOLERANCE_LU = 0.05


def _window_min_forward(x: np.ndarray, width: int) -> np.ndarray:
    """out[i] = min(x[i : i + width]), the window cut short at the end of x. O(n),
    vectorized (van Herk / Gil-Werman: per-block prefix and suffix minima)."""
    n = len(x)
    if width <= 1 or n == 0:
        return x.copy()
    blocks = -(-(n + width - 1) // width)
    padded = np.full(blocks * width, np.inf)
    padded[:n] = x
    grid = padded.reshape(blocks, width)
    prefix = np.minimum.accumulate(grid, axis=1).reshape(-1)
    suffix = np.minimum.accumulate(grid[:, ::-1], axis=1)[:, ::-1].reshape(-1)
    return np.minimum(suffix[:n], prefix[width - 1:width - 1 + n])


def _limiter_gain(env: np.ndarray, ceiling: float, sr: int) -> np.ndarray:
    """Gain per sample that keeps gain * env at or under ceiling: the gain each sample needs,
    held over the attack window ahead of it, released at a fixed rate, then smoothed by a
    moving average over the attack window. Every value averaged into sample i is at most
    the gain sample i needs, so the smoothing never lets a peak through. Only the spans
    around overs are computed; the gain is exactly 1 everywhere else."""
    width = max(1, int(round(_LIMITER_ATTACK_S * sr))) + 1
    needed = np.minimum(1.0, ceiling / np.maximum(env, 1e-12))
    gain = np.ones(len(needed))
    over = np.flatnonzero(needed < 1.0)
    if not len(over):
        return gain
    rate = _LIMITER_RELEASE_PER_S / float(sr)
    # A span ends once the release is back at 1 and the smoothing has caught up.
    tail = int(math.ceil(1.0 / rate)) + width + 1
    starts = np.concatenate([[0], np.flatnonzero(np.diff(over) > tail + width) + 1])
    ends = np.concatenate([starts[1:] - 1, [len(over) - 1]])
    for s, e in zip(over[starts], over[ends]):
        lo, hi = max(0, s - width), min(len(needed), e + tail)
        # Unity before the span, so its first peak still gets its attack ramp.
        held = _window_min_forward(np.concatenate([np.ones(width - 1), needed[lo:hi]]), width)
        ramp = rate * np.arange(len(held))
        released = np.minimum(held, np.minimum.accumulate(held - ramp) + ramp)
        reduction = np.concatenate([[0.0], np.cumsum(1.0 - released)])
        gain[lo:hi] = np.minimum(1.0, 1.0 - (reduction[width:] - reduction[:-width]) / width)
    return gain


def _limiter_envelope(audio: np.ndarray) -> np.ndarray:
    """The limiter's detector: element j covers positions j-1 .. j+3/4, so each sample's
    gain also answers for the inter-sample peak just before it."""
    env = _true_peak_envelope(audio, -1)
    return np.maximum(env[:-1], env[1:])


def _limit_scaled(audio: np.ndarray, env: np.ndarray, gain: float, sr: int) -> np.ndarray:
    """audio * gain through the true-peak limiter at MASTER_LIMITER_CEILING_DB, where env is
    _limiter_envelope(audio) (it scales with the gain). Unity, sample for sample, wherever
    the scaled signal stays under the ceiling."""
    ceiling = 10.0 ** (MASTER_LIMITER_CEILING_DB / 20.0)
    scaled = env * gain
    if not len(scaled) or float(np.max(scaled)) <= ceiling:
        return (audio * np.float32(gain)).astype(np.float32)
    return (audio * (gain * _limiter_gain(scaled, ceiling, sr))).astype(np.float32)


def _trim_true_peak(out: np.ndarray) -> Tuple[np.ndarray, float]:
    """Static trim to TRUE_PEAK_CEILING_DB if out still reads above it (a safety net: the
    limiter's ceiling sits 0.5 dB lower). Returns (audio, true peak in dBTP)."""
    peak_db = true_peak_db(out)
    if peak_db > TRUE_PEAK_CEILING_DB:
        # 0.001 dB under the ceiling so float32 rounding can't leave it a hair above.
        out = (out * np.float32(10.0 ** ((TRUE_PEAK_CEILING_DB - 0.001 - peak_db) / 20.0))).astype(np.float32)
        peak_db = true_peak_db(out)
    return out, peak_db


def _limit_true_peak(x: np.ndarray, sr: int) -> Tuple[np.ndarray, float]:
    """True-peak limiter at MASTER_LIMITER_CEILING_DB (lookahead, no clipping), then the
    static trim to TRUE_PEAK_CEILING_DB. Length is unchanged.
    Returns (audio, true peak in dBTP)."""
    audio = np.ascontiguousarray(_sanitize_finite_audio(x, context="master limiter input")).reshape(-1)
    if not len(audio):
        return audio, -120.0
    return _trim_true_peak(_limit_scaled(audio, _limiter_envelope(audio), 1.0, sr))


def _master_gain_db(lufs: float) -> float:
    """Gain that takes a mix at lufs to MASTER_TARGET_LUFS, clamped; 0 for silence."""
    if lufs <= LUFS_FLOOR:
        return 0.0
    return float(np.clip(MASTER_TARGET_LUFS - lufs, -MASTER_GAIN_LIMIT_DB, MASTER_GAIN_LIMIT_DB))


def master_stage(mix: np.ndarray, sr: int = SR) -> Tuple[np.ndarray, Dict[str, float]]:
    """
    Masters the final mono mix: non-finite samples become silence, the mix is brought to
    MASTER_TARGET_LUFS integrated (gain clamped to +/-24 dB, skipped at or below -70 LUFS)
    through the true-peak limiter, at or under TRUE_PEAK_CEILING_DB. Limiting a loud
    transient (a clap, a slam) takes loudness out of the mix, so the limited mix is measured
    again and the gain raised by what's missing until it lands on target. Length is unchanged.
    Returns (audio, {"lufs_in", "gain_db", "true_peak_db"}); gain_db is the final gain.
    """
    audio = np.ascontiguousarray(_sanitize_finite_audio(mix, context="master_stage input")).reshape(-1)
    lufs_in = integrated_lufs(audio, sr)
    gain_db = _master_gain_db(lufs_in)
    env = _limiter_envelope(audio) if len(audio) else np.zeros(0)
    out = _limit_scaled(audio, env, 10.0 ** (gain_db / 20.0), sr)
    if lufs_in > LUFS_FLOOR:
        # Loudness rises with the gain ever more slowly as the limiter works harder, so each
        # step uses the slope measured over the last two passes and stays under target.
        prev = None
        for _ in range(_MASTER_MAX_PASSES - 1):
            lufs_out = integrated_lufs(out, sr)
            missing = MASTER_TARGET_LUFS - lufs_out
            slope = 1.0
            if prev is not None and gain_db != prev[0]:
                slope = float(np.clip((lufs_out - prev[1]) / (gain_db - prev[0]), 0.1, 1.0))
            next_db = float(np.clip(gain_db + missing / slope, -MASTER_GAIN_LIMIT_DB, MASTER_GAIN_LIMIT_DB))
            if abs(missing) <= _MASTER_TOLERANCE_LU or next_db == gain_db:
                break
            prev = (gain_db, lufs_out)
            gain_db = next_db
            out = _limit_scaled(audio, env, 10.0 ** (gain_db / 20.0), sr)
    out, peak_db = _trim_true_peak(out)
    return out, {"lufs_in": round(lufs_in, 2), "gain_db": round(gain_db, 2), "true_peak_db": round(peak_db, 2)}


def calculate_take_auto_gain(
    take_audio_or_path: Union[np.ndarray, str],
    target_lufs: float = DEFAULT_DIALOGUE_LUFS,
    sr: int = SR,
    max_boost_db: float = 12.0,
    max_cut_db: float = -12.0
) -> Dict[str, float]:
    """
    Computes the static gain that brings the take's integrated loudness to target_lufs.
    A boost is capped so the take's sample peak stays at or below
    AUTO_GAIN_PEAK_CEILING_DB; cuts are never affected by the cap.
    Returns {"loudness_lufs": float, "target_lufs": float, "auto_gain_db": float}.
    """
    if isinstance(take_audio_or_path, str):
        if not os.path.isfile(take_audio_or_path):
            return {"loudness_lufs": DEFAULT_DIALOGUE_LUFS, "target_lufs": round(target_lufs, 1), "auto_gain_db": 0.0}
        audio_data = read_wav_mono(take_audio_or_path, sr)
    else:
        audio_data = take_audio_or_path

    loudness_lufs = round(integrated_lufs(audio_data, sr), 1)
    raw_delta_db = target_lufs - loudness_lufs
    # Clamp to safe gain limits [-12dB, +12dB]
    gain_db = float(np.clip(raw_delta_db, max_cut_db, max_boost_db))
    peak = float(np.max(np.abs(audio_data))) if len(audio_data) else 0.0
    if gain_db > 0.0 and peak > 1e-6:
        headroom_db = max(0.0, AUTO_GAIN_PEAK_CEILING_DB - 20.0 * np.log10(peak))
        gain_db = min(gain_db, np.floor(headroom_db * 10.0) / 10.0)
    auto_gain_db = round(float(gain_db), 1)

    return {
        "loudness_lufs": loudness_lufs,
        "target_lufs": round(target_lufs, 1),
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
        # Uncorrelated or inverted envelopes score 0: the score runs 0 to 1.
        score = min(1.0, max(0.0, float(plain[0][start_idx])))
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


def match_take_timing(audio: np.ndarray, reference_wav: str, start_offset_ms: int,
                      allow_stretch: bool = True) -> Dict[str, Any]:
    """align_take_timing against the original line's audio file. A missing or unreadable
    reference means "not measured": the starting offset, no score, no stretch."""
    try:
        reference = read_wav_mono(reference_wav)
    except Exception as ex:
        print(f"[Timing] Could not read reference line {reference_wav!r}: {ex}")
        start = _snap5(start_offset_ms)
        return {"auto_offset_ms": start, "timing_score": None, "stretch": 1.0, "aligned": False}
    return align_take_timing(audio, reference, start_offset_ms, sr=SR, allow_stretch=allow_stretch)


def save_uploaded_take(
    room_id: str,
    take_dir: str,
    stem: str,
    audio_bytes: bytes,
    filename_hint: str = "take.webm",
    enable_noise_reduction: bool = False,
    user_id: Optional[str] = None,
    target_lufs: Optional[float] = None,
    reference_wav: Optional[str] = None,
    start_offset_ms: int = 0,
    align: bool = True,
) -> Dict[str, Any]:
    """
    Saves raw uploaded audio from browser (WebM/WAV/OGG) to standard WAV.
    Writes <take_dir>/<stem>.wav (active), preserves pristine raw audio (<stem>_raw.wav) and
    generates denoised audio (<stem>_denoised_{key}.wav, see denoised_take_path) when requested.
    Measures the take's integrated loudness and the auto gain that matches it to target_lufs.
    When align and reference_wav (the original line's audio) are given, matches the take's
    timing to it from start_offset_ms (match_take_timing); a clearly faster or slower take is
    also fitted, so the active file is the raw or cleaned audio at that stretch. Otherwise the
    timing is "not measured" and the active file is a plain copy.
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
        source_wav = denoised_wav
    else:
        _remove_old_denoised_takes(take_dir, stem)
        source_wav = raw_wav

    # Timing is matched on the source (trim, stretch, offset), then the active file is
    # written at the chosen stretch.
    start_offset_ms = _snap5(start_offset_ms)
    if align and reference_wav:
        timing = match_take_timing(read_wav_mono(source_wav), reference_wav, start_offset_ms)
    else:
        timing = {"auto_offset_ms": start_offset_ms, "timing_score": None, "stretch": 1.0, "aligned": False}
    _write_active_take(source_wav, target_wav, timing["stretch"])

    audio_data = read_wav_mono(target_wav)
    if timing["stretch"] != 1.0:
        # atempo starts its output about 20 ms early, so the offset found on the ideal
        # stretched envelope is off by that much: measure it again on the written file.
        refit = match_take_timing(audio_data, reference_wav, start_offset_ms, allow_stretch=False)
        if refit["aligned"]:
            timing["auto_offset_ms"] = refit["auto_offset_ms"]
            timing["timing_score"] = refit["timing_score"]

    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)

    # Integrated loudness and the auto gain that matches the original line
    effective_target = target_lufs if target_lufs is not None else DEFAULT_DIALOGUE_LUFS
    gain_match = calculate_take_auto_gain(audio_data, target_lufs=effective_target, sr=SR)

    return {
        "wav_path": target_wav,
        "raw_path": raw_wav,
        "denoised_path": denoised_wav if enable_noise_reduction else None,
        "duration": round(duration, 3),
        "peaks": peaks,
        "noise_reduction": bool(enable_noise_reduction),
        "has_raw": True,
        "loudness_lufs": gain_match["loudness_lufs"],
        "target_lufs": gain_match["target_lufs"],
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
    target_lufs: Optional[float] = None,
    stretch: float = 1.0,
) -> Dict[str, Any]:
    """
    Instantly toggles a take between pristine raw and denoised audio.
    Generates denoised audio on-demand if missing, writes the active file at the take's
    stretch (so a fitted take stays fitted), and re-measures the swapped audio's loudness
    and auto gain against target_lufs.
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
        _write_active_take(denoised_wav, target_wav, stretch)
    else:
        _write_active_take(raw_wav, target_wav, stretch)

    audio_data = read_wav_mono(target_wav)
    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)
    effective_target = target_lufs if target_lufs is not None else DEFAULT_DIALOGUE_LUFS
    gain_match = calculate_take_auto_gain(audio_data, target_lufs=effective_target, sr=SR)

    return {
        "wav_path": target_wav,
        "duration": round(duration, 3),
        "peaks": peaks,
        "noise_reduction": bool(enable_noise_reduction),
        "has_raw": True,
        "loudness_lufs": gain_match["loudness_lufs"],
        "target_lufs": gain_match["target_lufs"],
        "auto_gain_db": gain_match["auto_gain_db"],
    }


# --- Voice chain renders (documentation/design/effects-rack.md, "Rendering") ---
# Memo of take file hashes: (path, mtime_ns, size) -> sha1 hex. A take rewritten in place
# gets a new mtime or size, so it is hashed again.
_FILE_SHA1: Dict[Tuple[str, int, int], str] = {}
_RENDER_LOCKS: Dict[str, threading.Lock] = {}
_RENDER_LOCKS_GUARD = threading.Lock()


def room_render_dir(room_id: str) -> str:
    """<room dir>/renders: the room's render cache (created by the first render)."""
    return os.path.join(get_room_cache_dir(room_id), "renders")


def take_chain(take_info: Dict[str, Any]) -> Dict[str, Any]:
    """A mix entry's normalized "chain" (Room.mix_takes resolves it); Clean when it has none."""
    chain = take_info.get("chain")
    return vocal_chain.normalize_chain(chain if isinstance(chain, dict) else vocal_chain.CLEAN)


def _file_sha1(path: str) -> str:
    st = os.stat(path)
    memo_key = (os.path.abspath(path), st.st_mtime_ns, st.st_size)
    digest = _FILE_SHA1.get(memo_key)
    if digest is None:
        h = hashlib.sha1()
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        digest = h.hexdigest()
        _FILE_SHA1[memo_key] = digest
    return digest


def render_key(wav_path: str, chain: Dict[str, Any], until_ms: Optional[int] = None) -> str:
    """The cache key of a render: the take's bytes, the chain's sound (not its preset label),
    the prefix length, RENDER_VERSION and the pedalboard version."""
    sound = {k: v for k, v in vocal_chain.normalize_chain(chain).items() if k != "preset"}
    parts = [
        str(RENDER_VERSION),
        str(getattr(vocal_chain._pedalboard_module(), "__version__", "")),
        _file_sha1(wav_path),
        json.dumps(sound, sort_keys=True, separators=(",", ":")),
        "full" if until_ms is None else str(int(until_ms)),
    ]
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _render_lock(key: str) -> threading.Lock:
    with _RENDER_LOCKS_GUARD:
        return _RENDER_LOCKS.setdefault(key, threading.Lock())


def _touch(path: str) -> None:
    try:
        os.utime(path, None)
    except OSError:
        pass


def _commit_render_file(tmp: str, target: str) -> None:
    """Moves a finished temp file onto its cache name. If another program holds the name
    (Windows) and the file is already there, the existing file is kept: renders are
    deterministic, so it has the same content."""
    try:
        os.replace(tmp, target)
    except PermissionError:
        _remove_quietly(tmp)
        if not os.path.isfile(target):
            raise


def _evict_renders(render_dir: str, max_bytes: int) -> None:
    """Keeps the render folder under max_bytes by deleting the least recently used files.
    Files used in the last RENDER_KEEP_RECENT_S are never deleted; files that can't be
    deleted (being played, on Windows) or are already gone are skipped. Temp files older
    than RENDER_TMP_MAX_AGE_S are left over from a crash and removed."""
    now = time.time()
    files = []
    total = 0
    try:
        entries = list(os.scandir(render_dir))
    except OSError:
        return
    for entry in entries:
        try:
            if not entry.is_file():
                continue
            st = entry.stat()
        except OSError:
            continue
        if entry.name.endswith(".tmp"):
            if now - st.st_mtime > RENDER_TMP_MAX_AGE_S:
                try:
                    os.remove(entry.path)
                except (PermissionError, FileNotFoundError):
                    pass
            continue
        total += st.st_size
        files.append((st.st_mtime, st.st_size, entry.path))
    for mtime, size, path in sorted(files):
        if total <= max_bytes or now - mtime < RENDER_KEEP_RECENT_S:
            break
        try:
            os.remove(path)
            total -= size
        except (PermissionError, FileNotFoundError):
            continue


def render_take_cached(
    wav_path: str,
    chain: Dict[str, Any],
    render_dir: str,
    until_s: Optional[float] = None,
    meta: Optional[Dict[str, Any]] = None,
) -> Tuple[str, Dict[str, Any]]:
    """
    The take's sound through its chain, rendered once and cached: the one entry point for
    preview and export. Writes <render_dir>/<key>.wav (mono 32-bit float, 44.1 kHz, not
    clipped: Level and the master come later) and <key>.json ({"line_id", "take_id",
    "duration", "peak_db"} plus "lufs" for full renders; line_id and take_id come from meta). until_s renders only the take's start (vocal_chain.render).
    Returns (wav path, info). Raises EffectsUnavailable when the voice effects aren't installed.
    """
    if not vocal_chain.available():
        raise EffectsUnavailable()
    chain = vocal_chain.normalize_chain(chain)
    until_ms = None if until_s is None else max(0, int(round(float(until_s) * 1000.0)))
    key = render_key(wav_path, chain, until_ms)
    wav_out = os.path.join(render_dir, f"{key}.wav")
    info_out = os.path.join(render_dir, f"{key}.json")

    with _render_lock(key):
        if os.path.isfile(wav_out) and os.path.isfile(info_out):
            try:
                with open(info_out, "r", encoding="utf-8") as fh:
                    info = json.load(fh)
                _touch(wav_out)
                _touch(info_out)
                return wav_out, info
            except (OSError, ValueError):
                pass  # unreadable info: render again

        audio = vocal_chain.render(read_wav_mono(wav_path, SR), chain, SR,
                                   until_s=None if until_ms is None else until_ms / 1000.0)
        # Not clipped: the take's Level and the master come after, and a hot render that
        # they bring down must not have been distorted on the way.
        audio = _sanitize_finite_audio(audio, context="render of " + repr(wav_path))
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        meta = meta or {}
        info = {
            "line_id": meta.get("line_id"),
            "take_id": meta.get("take_id"),
            "duration": round(len(audio) / float(SR), 3),
            "peak_db": round(20.0 * math.log10(peak), 2) if peak > 1e-6 else -120.0,
        }
        if until_ms is None:
            info["lufs"] = round(integrated_lufs(audio, SR), 2)

        os.makedirs(render_dir, exist_ok=True)
        tmp = os.path.join(render_dir, f"{key}.{os.getpid()}.{threading.get_ident()}.tmp")
        info_tmp = tmp[:-4] + ".json.tmp"
        try:
            with open(info_tmp, "w", encoding="utf-8") as fh:
                json.dump(info, fh)
            _commit_render_file(info_tmp, info_out)
            write_wav_float(tmp, audio, SR)
            _commit_render_file(tmp, wav_out)
        finally:
            _remove_quietly(info_tmp)
            _remove_quietly(tmp)

    _evict_renders(render_dir, RENDER_CACHE_MAX_BYTES)
    return wav_out, info


def _timeline_samples(pack: PackInfo, sr: int) -> int:
    """Mix buffer length for a pack: the scene (at least 1s) or the last line end + 2s, plus 1s of tail."""
    total_sec = max(pack.duration, 1.0)
    for line in pack.lines:
        total_sec = max(total_sec, line["end"] + 2.0)
    return int(total_sec * sr) + sr


def _render_take(take_info: Dict[str, Any], sr: int, gain_db: float, log_tag: str) -> Optional[np.ndarray]:
    """
    The take's cached render through its chain (take_chain) times its level, gain_db clamped
    to GAIN_DB_MIN..GAIN_DB_MAX. take_info needs "wav_path" and "render_dir". If the render
    fails, falls back to the unprocessed take audio. Returns None when the take cannot be
    read at all; what that means is the caller's failure policy. EffectsUnavailable is
    raised: an export never goes out without its effects.
    """
    wav_path = take_info["wav_path"]
    clamped_gain_db = float(np.clip(gain_db, GAIN_DB_MIN, GAIN_DB_MAX))
    if clamped_gain_db != gain_db:
        print(f"[{log_tag}] WARNING: gain_db={gain_db} out of safe range; clamped to {clamped_gain_db} dB.")
    try:
        path, _ = render_take_cached(wav_path, take_chain(take_info), take_info["render_dir"],
                                     meta={"line_id": take_info.get("line_id"), "take_id": take_info.get("take_id")})
        return read_wav_mono(path, sr) * np.float32(10.0 ** (clamped_gain_db / 20.0))
    except EffectsUnavailable:
        raise
    except Exception as ex:
        print(f"[{log_tag}] WARNING: voice chain render failed ({wav_path!r}): {ex}. Falling back to unprocessed take audio.")
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


def _mix_scene(
    pack: PackInfo,
    takes_dict: Dict[int, Dict[str, Any]],
    sr: int = SR,
    presence_db: float = 0.0,
) -> np.ndarray:
    """
    The scene's unmastered mono mix: backing x BACKING_TRACK_LEVEL, each take at its
    offset with its effects, gain and presence_db, and the original voice
    (x ORIGINAL_LINE_LEVEL, plus presence_db) for lines without a take.
    takes_dict format (Room.mix_takes): {line_index: {"wav_path": str, "render_dir": str,
    "offset_ms": int, "gain_db": float, "chain": dict}}
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
            gain = float(take_info.get("gain_db", 0.0)) + float(presence_db)
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
                    orig_mult = ORIGINAL_LINE_LEVEL * (10.0 ** (float(presence_db) / 20.0))
                    _mix_into([mix_buffer], orig_audio * np.float32(orig_mult), start_sec, sr)
                except Exception as ex:
                    print(f"Error loading original audio for line {idx}: {ex}")

    return mix_buffer


def render_dub_mix(
    pack: PackInfo,
    takes_dict: Dict[int, Dict[str, Any]],
    output_wav: str,
    sr: int = SR,
    master_dialogue_presence_db: float = 0.0,
) -> str:
    """
    Renders the scene mix (_mix_scene, with master dialogue presence) through the master
    stage (-16 LUFS, -1 dBTP) into output_wav.
    """
    master_mix, info = master_stage(_mix_scene(pack, takes_dict, sr, master_dialogue_presence_db), sr)
    print(f"[render_dub_mix] Master: {info['lufs_in']} LUFS in, {info['gain_db']:+} dB, {info['true_peak_db']} dBTP out.")
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


def _sound_name(chain: Dict[str, Any]) -> str:
    """The chain's preset name ("Warm"), or "Custom" when it isn't an untouched preset."""
    preset = vocal_chain.PRESETS.get(chain.get("preset") or "")
    return preset["name"] if preset else "Custom"


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
                f"  DSP Tuning: Offset: {entry['offset_ms']:+d}ms | Sound: {_sound_name(entry['chain'])}"
                f" | Gain: {entry['gain_db']:+.1f}dB",
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
    master_gain_db: float = 0.0,
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
        # Gain applied to the vocal mix and character stems to bring the scene to target_lufs.
        "master": {"target_lufs": MASTER_TARGET_LUFS, "gain_db": round(master_gain_db, 2)},
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

        # 3. Master Vocal Mix Stem & Character Stems. Their master gain is the one the master
        # stage settles on for the whole scene (backing included), limiter and all.
        master_gain_db = float(master_stage(_mix_scene(pack, takes_dict, sr, presence_db=0.0), sr)[1]["gain_db"])
        master_mult = np.float32(10.0 ** (master_gain_db / 20.0))
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
                "stretch": 1.0,
                "chain": None,
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
                chain = take_chain(take_info)
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
                # The take file is already fitted at this speed (1.0 = as recorded).
                line_entry["stretch"] = float(take_info.get("stretch", 1.0))
                line_entry["chain"] = chain
                # The old keys, read from the chain (0 when that effect is off).
                nodes = chain["nodes"]
                line_entry["pitch_semitones"] = float(nodes["pitch"]["semitones"]) if nodes["pitch"]["on"] else 0.0
                line_entry["reverb_wet"] = float(nodes["reverb"]["mix"]) if nodes["reverb"]["on"] else 0.0
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
        master_vocal_limited, _ = _limit_true_peak(master_vocal_buffer * master_mult, sr)
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
            char_limited, _ = _limit_true_peak(buf * master_mult, sr)
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
            master_gain_db=master_gain_db,
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
