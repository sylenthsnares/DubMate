# -*- coding: utf-8 -*-
"""
audio_processor.py
High-Fidelity Audio DSP & Video Rendering Engine.
Matching filter chain for time-invariant pitch shifting, room acoustics, dynamic compression, and millisecond latency nudging.
"""

import os
import re
import wave
import shutil
import tempfile
import subprocess
import numpy as np
from typing import Dict, List, Optional, Any, Tuple

from pack_loader import get_ffmpeg_path, CACHE_DIR, PackInfo

SR = 44100  # Standard audio sample rate


def get_room_cache_dir(room_id: str) -> str:
    path = os.path.join(CACHE_DIR, "rooms", room_id)
    os.makedirs(path, exist_ok=True)
    return path


def read_wav_mono(path: str, sr: int = SR) -> np.ndarray:
    """Reads audio as a mono float32 numpy array normalized between -1.0 and 1.0."""
    ffmpeg = get_ffmpeg_path()
    tmp = tempfile.mktemp(suffix=".wav")
    try:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", path, "-ac", "1", "-ar", str(sr),
            "-c:a", "pcm_s16le", tmp
        ]
        subprocess.run(cmd, check=True)
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
    data = np.clip(np.asarray(data, dtype=np.float32), -1.0, 1.0)
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


def save_uploaded_take(
    room_id: str,
    line_index: int,
    audio_bytes: bytes,
    filename_hint: str = "take.webm"
) -> Dict[str, Any]:
    """
    Saves raw uploaded audio from browser (WebM/WAV/OGG) to standard WAV.
    Returns path, duration, and waveform peaks.
    """
    if not audio_bytes or len(audio_bytes) < 32:
        raise ValueError("Uploaded audio stream is empty or incomplete.")

    room_dir = get_room_cache_dir(room_id)
    ext = os.path.splitext(filename_hint)[1].lower() if filename_hint else ".webm"
    if ext not in (".webm", ".wav", ".ogg", ".mp4", ".m4a", ".aac", ".flac"):
        ext = ".webm"

    raw_tmp = tempfile.mktemp(suffix=ext)
    with open(raw_tmp, "wb") as f:
        f.write(audio_bytes)

    target_wav = os.path.join(room_dir, f"take_line_{line_index}.wav")
    ffmpeg = get_ffmpeg_path()
    try:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", raw_tmp,
            "-ac", "1", "-ar", str(SR),
            "-c:a", "pcm_s16le",
            target_wav
        ]
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as err:
        print(f"[AudioProcessor] ffmpeg conversion failed on {raw_tmp} ({len(audio_bytes)} bytes): {err}")
        raise RuntimeError(f"Audio transcoding failed: {err}")
    finally:
        if os.path.exists(raw_tmp):
            try:
                os.remove(raw_tmp)
            except Exception:
                pass

    audio_data = read_wav_mono(target_wav)
    duration = len(audio_data) / float(SR)
    peaks = compute_waveform_peaks(audio_data, 100)

    return {
        "wav_path": target_wav,
        "duration": round(duration, 3),
        "peaks": peaks,
        "url": f"/api/rooms/{room_id}/takes/{line_index}/audio",
    }


import scipy.signal

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

    np.random.seed(42)  # Deterministic room reflection pattern
    impulse[pre_delay:] = (np.random.rand(len(t)).astype(np.float32) * 2.0 - 1.0) * envelope
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
    enable_compressor: bool = True,
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

    # 3. Vocal Compressor
    if enable_compressor:
        filters.append("compand=attacks=0.015:decays=0.15:points=-80/-80|-24/-24|0/-6")

    ffmpeg = get_ffmpeg_path()
    if filters:
        filter_chain = ",".join(filters)
        tmp_out = tempfile.mktemp(suffix=".wav")
        try:
            cmd = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", audio_path,
                "-af", filter_chain,
                "-ac", "1", "-ar", str(sr),
                "-c:a", "pcm_s16le",
                tmp_out
            ]
            subprocess.run(cmd, check=True)
            audio = read_wav_mono(tmp_out, sr)
        except Exception as ex:
            print(f"Error applying filter chain: {ex}")
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
    # Direct vocal stays at 100% punch; room reflections are blended seamlessly on top
    if reverb_wet > 0.02 and len(audio) > 0:
        impulse = get_reverb_impulse(decay_sec=1.5, sr=sr)
        wet = scipy.signal.fftconvolve(audio, impulse)[:len(audio)]
        audio = audio + wet * np.float32(reverb_wet * 0.70)

    return audio


def render_dub_mix(
    pack: PackInfo,
    takes_dict: Dict[int, Dict[str, Any]],
    output_wav: str,
    sr: int = SR
) -> str:
    """
    Renders complete mix with millisecond offsets and voice effects.
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
            gain = float(take_info.get("gain_db", 0.0))

            processed_audio = apply_audio_effects(
                take_info["wav_path"],
                pitch_semitones=pitch,
                reverb_wet=reverb,
                gain_db=gain,
                sr=sr
            )

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
                        mix_buffer[start_sample:end_sample] += orig_audio[:samples_to_add] * 0.90
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
    aspect_ratio: str = "16:9"
) -> str:
    """Combines final mixed audio with scene video into a high quality MP4 (16:9 or 9:16 letterboxed)."""
    pack.ensure_web_ready()
    tmp_wav = tempfile.mktemp(suffix=".wav")
    render_dub_mix(pack, takes_dict, tmp_wav)

    ffmpeg = get_ffmpeg_path()
    os.makedirs(os.path.dirname(os.path.abspath(output_mp4)), exist_ok=True)
    try:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", pack.web_video_path,
            "-i", tmp_wav,
            "-map", "0:v:0", "-map", "1:a:0",
        ]
        if aspect_ratio == "9:16":
            # Letterbox 9:16 with black bars top and bottom without cropping
            cmd.extend(["-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"])

        cmd.extend([
            "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            output_mp4
        ])
        subprocess.run(cmd, check=True)
    finally:
        if os.path.exists(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass

    return output_mp4
