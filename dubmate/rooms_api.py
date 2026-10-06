# -*- coding: utf-8 -*-
"""
dubmate/rooms_api.py
Room REST routes (/api/rooms/*): create, share, state, noise profile, takes,
export render, video streaming and downloads.

Works on the room model in dubmate.rooms and never imports app.
"""

import os
import time
import uuid
import asyncio
import functools
import threading
from typing import Dict, Any

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse

import audio_processor
import pack_loader
from dubmate import common, packs_cache, rooms, room_registry

router = APIRouter()

# create_room prunes old sessions in a worker thread; serializing creation keeps a
# concurrent create from inserting a room that an older prune then removes.
_ROOM_CREATE_LOCK = asyncio.Lock()


@router.post("/api/rooms")
async def create_room(payload: Dict[str, Any]):
    pack_id = payload.get("pack_id")
    host_name = payload.get("host_name", "Host").strip() or "Host"
    host_color = common.sanitize_color(payload.get("host_color"), "#7c5cff")
    app_version = common.read_version()

    pack = packs_cache.pack_or_404(pack_id, "Selected pack not found")

    async with _ROOM_CREATE_LOCK:
        room_id = rooms.generate_room_code()
        # Prune any previous session recordings from disk and RAM so only the new session is kept
        await asyncio.to_thread(rooms.prune_sessions, keep_room_id=room_id)

        host_id = str(uuid.uuid4())[:8]
        room = rooms.Room(room_id, pack, host_id, host_name, host_color)
        rooms.ROOMS[room_id] = room

    # Queue the code for the public registry instead of gating on the tunnel already
    # being up. publish_pending_rooms() sends it now if it can, and /api/tunnel or the
    # heartbeat sends it the moment the tunnel becomes available.
    room_registry.WORKER_PENDING_ROOMS[room_id.upper()] = app_version
    room_registry._set_room_status(
        room_id,
        "publishing" if room_registry.ACTIVE_TUNNEL_URL else "waiting",
        "Getting your room code ready."
    )
    room_registry.schedule_registry_publish()

    return {
        "room_id": room_id,
        "user_id": host_id,
        "tunnel_url": room_registry.ACTIVE_TUNNEL_URL,
        "share": room_registry.build_room_share_payload(room_id),
        "state": room.to_state_dict(),
    }


@router.get("/api/rooms/{room_id}/share")
async def get_room_share(room_id: str):
    """Invite details for a room hosted here, including why a code may not be live yet."""
    code = (room_id or "").upper()
    if code not in rooms.ROOMS:
        raise HTTPException(status_code=404, detail="Room not found")
    return room_registry.build_room_share_payload(code)


@router.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    room = rooms.room_or_404(room_id)
    return room.to_state_dict()


@router.post("/api/rooms/{room_id}/noise_profile")
async def upload_noise_profile(
    room_id: str,
    file: UploadFile = File(...),
    user_id: str = Form(...),
):
    """Calibrates and saves a 1-second room background noise profile for an actor."""
    common.require_safe_identifier(user_id, "user_id")
    room = rooms.room_or_404(room_id)
    try:
        content = await file.read()
        res = audio_processor.save_user_noise_profile(
            room.room_id,
            user_id,
            content,
            filename_hint=file.filename or "profile.webm"
        )
        return res
    except Exception as ex:
        print(f"[NoiseProfileError] Failed calibrating noise profile for {user_id} in {room_id}: {ex}")
        raise HTTPException(status_code=400, detail=str(ex))


def _line_target_loudness(pack, line) -> float:
    """Measured loudness of the original line, the target for a take's auto gain.

    Falls back to DEFAULT_DIALOGUE_LOUDNESS_DB when the line can't be read or is silent.
    """
    try:
        measured = pack_loader.measure_line_loudness(os.path.join(pack.folder, line["filename"]))
    except Exception as ex:
        print(f"[Loudness] Could not measure reference line {line.get('filename')!r}: {ex}")
        return audio_processor.DEFAULT_DIALOGUE_LOUDNESS_DB
    if measured <= -55.0:
        return audio_processor.DEFAULT_DIALOGUE_LOUDNESS_DB
    return measured


@router.post("/api/rooms/{room_id}/takes/{line_index}")
async def upload_take(
    room_id: str,
    line_index: int,
    file: UploadFile = File(...),
    user_id: str = Form(...),
    user_name: str = Form("Actor"),
    offset_ms: int = Form(0),
    pitch_semitones: float = Form(0.0),
    reverb_wet: float = Form(0.0),
    gain_db: float = Form(0.0),
    noise_reduction: bool = Form(False),
    auto_gain: bool = Form(False),
):
    common.require_safe_identifier(user_id, "user_id")
    room = rooms.room_or_404(room_id)

    if line_index < 0 or line_index >= len(room.pack.lines):
        raise HTTPException(status_code=400, detail="That line isn't in this scene.")

    line = room.pack.lines[line_index]
    char_name = line.get("character")
    assigned_users = room.role_assignments.get(char_name, [])
    is_host = (user_id == room.host_id) or (room.host_id == "host")
    if assigned_users and user_id not in assigned_users and not is_host:
        raise HTTPException(
            status_code=403,
            detail=f"Line {line_index + 1} belongs to {char_name}. Only their actor can record it."
        )

    # Recording again adds a take next to the line's earlier ones; nothing is overwritten.
    line_id = line["line_id"]
    take_id = uuid.uuid4().hex[:8]
    take_dir = audio_processor.take_dir(room.room_id, line_id)
    try:
        target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, line)

        content = await file.read()
        async with room.processing_lock:
            saved = await asyncio.to_thread(
                audio_processor.save_uploaded_take,
                room.room_id,
                take_dir,
                take_id,
                content,
                filename_hint=file.filename or "take.webm",
                enable_noise_reduction=noise_reduction,
                user_id=user_id,
                target_loudness_db=target_loudness
            )
    except Exception as ex:
        print(f"[UploadError] Error saving take for room {room_id} line {line_index}: {ex}")
        audio_processor.delete_take_files(take_dir, take_id)
        raise HTTPException(status_code=400, detail=str(ex))

    take = room.add_take(line_id, {
        "take_id": take_id,
        "user_id": user_id,
        "user_name": user_name,
        "duration": saved["duration"],
        "peaks": saved["peaks"],
        "audio_version": int(time.time() * 1000),
        "offset_ms": offset_ms,
        "pitch_semitones": pitch_semitones,
        "reverb_wet": reverb_wet,
        # auto_gain: the client asked for the scene-matched level, applied here so the
        # take_recorded broadcast already carries it.
        "gain_db": saved.get("auto_gain_db", 0.0) if auto_gain else gain_db,
        "noise_reduction": saved.get("noise_reduction", noise_reduction),
        "has_raw": True,
        "speech_loudness_db": saved.get("speech_loudness_db"),
        "target_loudness_db": saved.get("target_loudness_db"),
        "auto_gain_db": saved.get("auto_gain_db", 0.0),
        "recorded_at": time.time(),
    })
    wire = room.wire_take(line_index, take)

    room.invalidate_exports()
    await room.broadcast("take_recorded", {
        "line_index": line_index,
        "url": wire["url"],
        "noise_reduction": take["noise_reduction"],
        "user_name": user_name,
        "user_id": user_id,
    })
    return {"status": "ok", "take": wire}


def _picked_take_at(room, line_index: int):
    """(line_id, picked take) of the line at line_index, or 404 if it has no take."""
    if not 0 <= line_index < len(room.pack.lines):
        raise HTTPException(status_code=404, detail="Take not found")
    line_id = room.pack.lines[line_index]["line_id"]
    take = room.picked_take(line_id)
    if not take:
        raise HTTPException(status_code=404, detail="Take not found")
    return line_id, take


@router.post("/api/rooms/{room_id}/takes/{line_index}/noise_reduction")
async def toggle_take_noise_reduction_endpoint(
    room_id: str,
    line_index: int,
    payload: Dict[str, Any]
):
    """Switches an existing take between raw and denoised audio without re-recording."""
    room = rooms.room_or_404(room_id)
    line_id, take = _picked_take_at(room, line_index)

    enable = bool(payload.get("noise_reduction", False))
    user_id = take.get("user_id", "host")
    target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, room.pack.lines[line_index])

    try:
        async with room.processing_lock:
            toggled = await asyncio.to_thread(
                audio_processor.toggle_take_noise_reduction,
                room.room_id,
                audio_processor.take_dir(room.room_id, line_id),
                take["take_id"],
                enable_noise_reduction=enable,
                user_id=user_id,
                target_loudness_db=target_loudness,
            )
        take["noise_reduction"] = enable
        take["audio_version"] = int(time.time() * 1000)
        take["peaks"] = toggled["peaks"]
        take["duration"] = toggled["duration"]
        # The swapped audio has a different level: re-match, and keep a take that was
        # sitting at its auto gain on the new auto gain.
        old_auto = take.get("auto_gain_db")
        if old_auto is not None and abs(float(take.get("gain_db", 0.0)) - float(old_auto)) < 0.05:
            take["gain_db"] = toggled["auto_gain_db"]
        take["speech_loudness_db"] = toggled["speech_loudness_db"]
        take["target_loudness_db"] = toggled["target_loudness_db"]
        take["auto_gain_db"] = toggled["auto_gain_db"]
        wire = room.wire_take(line_index, take)
        room.invalidate_exports()
        await room.broadcast("take_params_updated", {
            "line_index": line_index,
            "url": wire["url"],
            "noise_reduction": enable
        })
        return {"status": "ok", "take": wire}
    except Exception as ex:
        print(f"[ToggleNoiseReductionError] {ex}")
        raise HTTPException(status_code=400, detail=str(ex))


@router.get("/api/rooms/{room_id}/takes/{line_index}/peaks")
async def get_take_peaks(room_id: str, line_index: int):
    """Returns compact peaks waveform data for a specific take on-demand."""
    room = rooms.room_or_404(room_id)
    _, take = _picked_take_at(room, line_index)
    return {
        "status": "ok",
        "line_index": line_index,
        "peaks": take.get("peaks", []),
        "duration": take.get("duration", 0.0),
        "url": room.wire_take(line_index, take)["url"],
    }


@router.get("/api/rooms/{room_id}/takes/{line_index}/audio")
async def get_take_audio(room_id: str, line_index: int, request: Request):
    room = rooms.room_or_404(room_id)
    line_id, take = _picked_take_at(room, line_index)
    wav_path = audio_processor.take_wav_path(room.room_id, line_id, take["take_id"])
    if not os.path.exists(wav_path):
        raise HTTPException(status_code=404, detail="Take not found")

    # If versioned query param (?v=...) is present, the audio file is uniquely fingerprinted
    # and safe to cache heavily by browsers and Cloudflare edge CDN.
    cache_ctrl = common.LONG_CACHE if "v" in request.query_params else "no-cache, must-revalidate"
    return common.range_stream_file(
        wav_path,
        request,
        media_type="audio/wav",
        cache_control=cache_ctrl
    )


@router.post("/api/rooms/{room_id}/export")
async def export_room_dub(room_id: str, aspect_ratio: str = "16:9", presence: float = 0.0):
    """Renders the final dubbed scene into MP4 (16:9 cinema or 9:16 shorts) asynchronously."""
    room = rooms.room_or_404(room_id)

    presence_val = float(presence) if presence != 0.0 else room.master_dialogue_presence_db
    room.master_dialogue_presence_db = presence_val

    is_9_16 = (aspect_ratio == "9:16")
    out_path = room.export_out_path(aspect_ratio)

    # Check if existing rendered file is already ready
    if room.ready_export_path(aspect_ratio):
        return {"status": "ok", **room.export_ready_payload(aspect_ratio)}

    current_status = room.export_status.get(aspect_ratio)
    if current_status == "processing":
        return {
            "status": "processing",
            "message": "Rendering in progress...",
            "aspect_ratio": aspect_ratio,
            "poll_url": f"/api/rooms/{room.room_id}/export/status?aspect_ratio={aspect_ratio}"
        }

    room.export_status[aspect_ratio] = "processing"
    await room.broadcast("export_started", {"aspect_ratio": aspect_ratio})

    # Captured here, on the event loop thread: the worker thread has no running loop
    # of its own, so asyncio.get_event_loop() there cannot reach the clients.
    loop = asyncio.get_running_loop()

    def notify_clients(message_type: str, payload: Dict[str, Any]):
        try:
            asyncio.run_coroutine_threadsafe(room.broadcast(message_type, payload), loop)
        except Exception as ex:
            print(f"[ExportWorkerWarning] Could not broadcast {message_type} for {room.room_id} ({aspect_ratio}): {ex}")

    takes = room.mix_takes()

    def render_worker():
        try:
            audio_processor.export_dub_video(
                room.pack,
                takes,
                out_path,
                aspect_ratio="9:16" if is_9_16 else "16:9",
                master_dialogue_presence_db=presence_val
            )
            if is_9_16:
                room.exported_video_9_16_path = out_path
            else:
                room.exported_video_path = out_path

            room.export_status[aspect_ratio] = "ready"
            notify_clients("export_ready", room.export_ready_payload(aspect_ratio))
        except Exception as ex:
            room.export_status[aspect_ratio] = f"failed: {str(ex)}"
            print(f"[ExportWorkerError] Error rendering {room.room_id} ({aspect_ratio}): {ex}")
            notify_clients("export_failed", {"aspect_ratio": aspect_ratio, "error": str(ex)})

    threading.Thread(target=render_worker, daemon=True).start()

    return {
        "status": "processing",
        "message": "Rendering started in background",
        "aspect_ratio": aspect_ratio,
        "poll_url": f"/api/rooms/{room.room_id}/export/status?aspect_ratio={aspect_ratio}"
    }


@router.get("/api/rooms/{room_id}/export/status")
async def get_export_status(room_id: str, aspect_ratio: str = "16:9"):
    """Pollable endpoint for export status to prevent Cloudflare 524 timeouts."""
    room = rooms.room_or_404(room_id)

    if room.ready_export_path(aspect_ratio):
        return {"status": "ready", **room.export_ready_payload(aspect_ratio)}

    status = room.export_status.get(aspect_ratio, "idle")
    return {
        "status": status,
        "aspect_ratio": aspect_ratio,
    }


@router.get("/api/rooms/{room_id}/export/video")
async def get_room_exported_video(room_id: str, request: Request, aspect_ratio: str = "16:9"):
    """Streams the rendered master MP4 video with Range support for theater playback."""
    room = rooms.room_or_404(room_id)

    target_path = room.ready_export_path(aspect_ratio) or room.ready_export_path("16:9")
    if not target_path:
        raise HTTPException(status_code=404, detail="Exported video not found")

    return common.range_stream_file(
        target_path,
        request,
        media_type="video/mp4",
        cache_control="no-cache, must-revalidate"
    )


@router.get("/api/rooms/{room_id}/export/download")
async def download_room_dub(room_id: str, aspect_ratio: str = "16:9"):
    room = rooms.room_or_404(room_id)

    # A render for this aspect is already writing the file; rendering it again here
    # would put a second ffmpeg on the same output path.
    if room.export_status.get(aspect_ratio) == "processing":
        raise HTTPException(status_code=409, detail="Export still rendering")

    is_9_16 = (aspect_ratio == "9:16")
    target_path = room.ready_export_path(aspect_ratio)
    if not target_path:
        out_path = room.export_out_path(aspect_ratio)
        # ffmpeg render is fully synchronous; off-loading keeps it from stalling the
        # event loop (and therefore every other room's websocket) for its whole duration.
        await asyncio.to_thread(
            audio_processor.export_dub_video,
            room.pack, room.mix_takes(), out_path,
            aspect_ratio="9:16" if is_9_16 else "16:9",
            master_dialogue_presence_db=room.master_dialogue_presence_db,
        )
        if is_9_16:
            room.exported_video_9_16_path = out_path
        else:
            room.exported_video_path = out_path
        target_path = out_path

    aspect_label = "Shorts_9x16" if is_9_16 else "Cinema_16x9"
    filename = f"Dub_{room.pack.name.replace(' ', '_')}_{room.room_id}_{aspect_label}.mp4"
    return FileResponse(
        target_path,
        media_type="video/mp4",
        filename=filename,
        headers={
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        }
    )


@router.get("/api/rooms/{room_id}/export/project_zip")
async def download_room_project_zip(room_id: str):
    """
    Assembles and streams a complete multi-track NLE project ZIP containing stems, video, markers.
    """
    room = rooms.room_or_404(room_id)

    zip_filename = f"DubMate_Project_{room.pack.pack_id}_{room.room_id}.zip"
    zip_path = os.path.join(common.exports_dir(), zip_filename)

    try:
        await asyncio.to_thread(
            functools.partial(
                audio_processor.build_project_zip,
                pack=room.pack,
                takes_dict=room.mix_takes(),
                role_assignments=room.role_assignments,
                users=room.users,
                output_zip_path=zip_path,
                room_id=room.room_id,
                bitrate="192k",
            )
        )
    except Exception as ex:
        print(f"[ProjectZipError] Error generating project ZIP for {room_id}: {ex}")
        raise HTTPException(status_code=500, detail="Couldn't build the project files. Try again.")

    clean_name = audio_processor.sanitize_filename(room.pack.name)
    download_filename = f"DubMate_Project_{clean_name}_{room.room_id}.zip"
    file_size_mb = round(os.path.getsize(zip_path) / (1024 * 1024), 2) if os.path.exists(zip_path) else 0.0
    print(f"[ProjectZip] Packaged {zip_filename} ({file_size_mb} MB). Sending as '{download_filename}' to client.")

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=download_filename,
        headers={
            "Cache-Control": "no-cache, must-revalidate",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        }
    )
