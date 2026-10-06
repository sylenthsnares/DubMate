# -*- coding: utf-8 -*-
"""
dubmate/noise_profiles_api.py
Room check routes (/api/noise_profiles*): analyse and store a few seconds of room tone,
read a stored check's report, and remove a check.

Not room-scoped, so a check works before joining a room. Never imports app.
"""

import os
import asyncio
import tempfile

from fastapi import APIRouter, UploadFile, File, Form, HTTPException

import audio_processor

router = APIRouter()

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_DEVICE_FIELD = 200
DROP_SEC = 0.3  # the start can hold the click of the recording starting
MIN_SEC = 2.5
MAX_SEC = 10.0


def _require_profile_id(profile_id: str) -> None:
    if not audio_processor.NOISE_PROFILE_ID_RE.match(profile_id or ""):
        raise HTTPException(status_code=400, detail="That room check isn't valid.")


def _analyse_upload(content: bytes, filename_hint: str, device_id: str, device_label: str):
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        try:
            audio_processor._transcode_upload(content, filename_hint, wav,
                                              audio_processor.SUBPROCESS_TIMEOUT_PROBE, "room check transcoding")
            audio = audio_processor.read_wav_mono(wav, audio_processor.SR)
        except Exception as ex:
            print(f"[RoomCheck] Could not read the room check recording: {ex}")
            raise HTTPException(status_code=400, detail="That recording couldn't be read. Try again.")
    finally:
        audio_processor._remove_quietly(wav)
    audio = audio[int(DROP_SEC * audio_processor.SR):]
    seconds = len(audio) / float(audio_processor.SR)
    if seconds < MIN_SEC:
        raise HTTPException(status_code=400, detail="That was too short. Try again.")
    if seconds > MAX_SEC:
        raise HTTPException(status_code=400, detail="That was too long. Try again.")
    return audio_processor.save_noise_profile(audio, audio_processor.SR,
                                              device_id=device_id, device_label=device_label)


@router.post("/api/noise_profiles")
async def create_noise_profile(
    file: UploadFile = File(...),
    device_id: str = Form(""),
    device_label: str = Form(""),
):
    """Analyses a room check and stores it. profile_id is null when nothing was stored
    (the recording was silenced or clipped); the report says why."""
    if len(device_id) > MAX_DEVICE_FIELD or len(device_label) > MAX_DEVICE_FIELD:
        raise HTTPException(status_code=400, detail="That microphone name is too long.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That recording is too large. Try again.")
    profile_id, stats = await asyncio.to_thread(
        _analyse_upload, content, file.filename or "check.webm", device_id, device_label)
    return {"profile_id": profile_id, "report": stats}


@router.get("/api/noise_profiles/{profile_id}")
async def get_noise_profile(profile_id: str):
    _require_profile_id(profile_id)
    stats = await asyncio.to_thread(audio_processor.load_noise_profile_stats, profile_id)
    if stats is None:
        raise HTTPException(status_code=404, detail="That room check is gone.")
    return stats


@router.delete("/api/noise_profiles/{profile_id}")
async def delete_noise_profile(profile_id: str):
    _require_profile_id(profile_id)
    deleted = await asyncio.to_thread(audio_processor.delete_noise_profile, profile_id)
    return {"status": "ok", "deleted": deleted}
