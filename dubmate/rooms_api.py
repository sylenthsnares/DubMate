# -*- coding: utf-8 -*-
"""
dubmate/rooms_api.py
Room REST routes (/api/rooms/*): create, share, state, takes,
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

@router.post("/api/rooms")
async def create_room(payload: Dict[str, Any], request: Request):
    pack_id = payload.get("pack_id")
    host_name = payload.get("host_name", "Host").strip() or "Host"
    host_color = common.sanitize_color(payload.get("host_color"), "#7c5cff")
    app_version = common.read_version()

    pack = packs_cache.pack_or_404(pack_id, "Selected pack not found")

    async with rooms.sessions_lock():
        room_id = rooms.new_room_code()
        # Delete old sessions beyond the recent ones the Continue card keeps
        await asyncio.to_thread(rooms.prune_sessions, keep_room_id=room_id)

        host_id = str(uuid.uuid4())[:8]
        room = rooms.Room(room_id, pack, host_id, host_name, host_color)
        room.created_here = common.is_own_computer(request)
        room.creator_id = host_id
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


def _require_line_actor(room, line, user_id: str) -> None:
    """403 when the line's character has assigned actors and user_id is neither one of
    them nor the host. Unassigned lines are open to everyone, and in a solo room
    (host_id "host") everyone counts as host."""
    char_name = line.get("character")
    assigned_users = room.role_assignments.get(char_name, [])
    is_host = (user_id == room.host_id) or (room.host_id == "host")
    if assigned_users and user_id not in assigned_users and not is_host:
        raise HTTPException(
            status_code=403,
            detail=f"Line {line['index'] + 1} belongs to {char_name}. Only their actor can record it."
        )


def _take_or_404(room, line_id: str, take_id: str):
    """(line, take) for a take of a line in the current pack, or 404."""
    line = room.find_line(line_id)
    take = room.find_take(line_id, take_id) if line else None
    if not take:
        raise HTTPException(status_code=404, detail="Take not found")
    return line, take


def _store_nr_settings(take: Dict[str, Any], result: Dict[str, Any]) -> None:
    """Keeps the cleanup settings a take was (re)cleaned with; standard cleanup stores no field."""
    if result.get("nr_settings") is not None:
        take["nr_settings"] = result["nr_settings"]
    else:
        take.pop("nr_settings", None)


def _apply_toggled_take(take: Dict[str, Any], toggled: Dict[str, Any], enable: bool) -> None:
    """Stores what toggle_take_noise_reduction wrote: noise reduction on or off, the cleanup
    settings used, the new audio's version, peaks, duration and loudness."""
    take["noise_reduction"] = enable
    _store_nr_settings(take, toggled)
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


def _refuse_during_cleanup_refresh(room) -> None:
    """409 while older takes are re-cleaned: a render then would mix old and new audio."""
    if room.cleanup_refreshing:
        raise HTTPException(status_code=409, detail="Older takes are being refreshed. Try again in a moment.")


@router.post("/api/rooms/{room_id}/lines/{line_id}/takes")
async def upload_take(
    room_id: str,
    line_id: str,
    file: UploadFile = File(...),
    user_id: str = Form(...),
    user_name: str = Form("Actor"),
    offset_ms: int = Form(0),
    pitch_semitones: float = Form(0.0),
    reverb_wet: float = Form(0.0),
    gain_db: float = Form(0.0),
    noise_reduction: bool = Form(False),
    auto_gain: bool = Form(False),
    guide_voice: bool = Form(False),
    noise_profile_id: str = Form(""),
):
    common.require_safe_identifier(user_id, "user_id")
    room = rooms.room_or_404(room_id)

    line = room.find_line(line_id)
    if not line:
        raise HTTPException(status_code=400, detail="That line isn't in this scene.")
    _require_line_actor(room, line, user_id)

    # Recording again adds a take next to the line's earlier ones; nothing is overwritten.
    take_id = uuid.uuid4().hex[:8]
    take_dir = audio_processor.take_dir(room.room_id, line_id)
    # offset_ms is the take's starting timing; snapped to the 5 ms nudge step so an
    # untouched slider never reads as a nudge.
    start_offset_ms = int(5 * round(offset_ms / 5.0))
    try:
        target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, line)
        # The actor's room check tunes the cleanup; an unknown or malformed id means standard cleanup.
        nr_settings = audio_processor.noise_cleanup_settings(noise_profile_id) if noise_profile_id else None

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
                nr_settings=nr_settings,
                target_loudness_db=target_loudness,
                # The original line's voice; a take recorded with the guide voice on can
                # hear the guide itself, so it isn't lined up.
                reference_wav=os.path.join(room.pack.folder, line["filename"]),
                start_offset_ms=start_offset_ms,
                align=not guide_voice,
            )
    except Exception as ex:
        print(f"[UploadError] Error saving take for room {room_id} line {line_id}: {ex}")
        audio_processor.delete_take_files(take_dir, take_id)
        raise HTTPException(status_code=400, detail=str(ex))

    take = room.add_take(line_id, {
        "take_id": take_id,
        "user_id": user_id,
        "user_name": user_name,
        "duration": saved["duration"],
        "peaks": saved["peaks"],
        "audio_version": int(time.time() * 1000),
        "offset_ms": saved["auto_offset_ms"],
        "start_offset_ms": saved["start_offset_ms"],
        "auto_offset_ms": saved["auto_offset_ms"],
        "aligned": saved["aligned"],
        "stretch": saved["stretch"],
        "timing_score": saved["timing_score"],
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
    _store_nr_settings(take, saved)
    wire = room.wire_take(line_id, take)

    room.invalidate_exports()
    await room.broadcast("take_recorded", {
        "line_id": line_id,
        "line_index": line["index"],
        "take_id": take_id,
        "url": wire["url"],
        "noise_reduction": take["noise_reduction"],
        "user_name": user_name,
        "user_id": user_id,
    })
    return {"status": "ok", "line_id": line_id, "take": wire, "line": room.wire_line(line_id)}


@router.post("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/pick")
async def pick_take(room_id: str, line_id: str, take_id: str, payload: Dict[str, Any]):
    """Puts a take in the dub."""
    room = rooms.room_or_404(room_id)
    user_id = common.require_safe_identifier(str(payload.get("user_id") or ""), "user_id")
    line, _ = _take_or_404(room, line_id, take_id)
    _require_line_actor(room, line, user_id)

    room.pick_take(line_id, take_id)
    room.invalidate_exports()
    await room.broadcast("take_picked", {
        "line_id": line_id,
        "line_index": line["index"],
        "take_id": take_id,
        "user_id": user_id,
    })
    return {"status": "ok", "line_id": line_id, "line": room.wire_line(line_id)}


@router.delete("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}")
async def delete_take(room_id: str, line_id: str, take_id: str, user_id: str = ""):
    """Deletes a take and its files. A deleted picked take falls back to the best-timed
    remaining one (Room.remove_take); with none left the line plays the original voice again."""
    room = rooms.room_or_404(room_id)
    common.require_safe_identifier(user_id, "user_id")
    line, _ = _take_or_404(room, line_id, take_id)
    _require_line_actor(room, line, user_id)

    async with room.processing_lock:
        picked = room.remove_take(line_id, take_id)
    room.invalidate_exports()
    await room.broadcast("take_deleted", {
        "line_id": line_id,
        "line_index": line["index"],
        "take_id": take_id,
        "picked": picked,
        "user_id": user_id,
    })
    return {"status": "ok", "line_id": line_id, "picked": picked, "line": room.wire_line(line_id)}


@router.post("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/noise_reduction")
async def toggle_take_noise_reduction_endpoint(
    room_id: str,
    line_id: str,
    take_id: str,
    payload: Dict[str, Any]
):
    """Switches an existing take between raw and denoised audio without re-recording."""
    room = rooms.room_or_404(room_id)
    line, take = _take_or_404(room, line_id, take_id)

    enable = bool(payload.get("noise_reduction", False))
    target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, line)

    try:
        async with room.processing_lock:
            toggled = await asyncio.to_thread(
                audio_processor.toggle_take_noise_reduction,
                room.room_id,
                audio_processor.take_dir(room.room_id, line_id),
                take_id,
                enable_noise_reduction=enable,
                nr_settings=take.get("nr_settings"),
                target_loudness_db=target_loudness,
                # A fitted take stays fitted; its timing fields don't change.
                stretch=float(take.get("stretch", 1.0)),
            )
        _apply_toggled_take(take, toggled, enable)
        wire = room.wire_take(line_id, take)
        room.invalidate_exports()
        await room.broadcast("take_params_updated", {
            "line_id": line_id,
            "take_id": take_id,
            "url": wire["url"],
            "noise_reduction": enable
        })
        return {"status": "ok", "line_id": line_id, "take": wire}
    except Exception as ex:
        print(f"[ToggleNoiseReductionError] {ex}")
        raise HTTPException(status_code=400, detail=str(ex))


@router.post("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/original_speed")
async def take_original_speed(room_id: str, line_id: str, take_id: str, payload: Dict[str, Any]):
    """Plays a fitted take at the speed it was recorded: the active audio is rewritten
    without stretch and its automatic timing is matched again (offset only). A take that
    wasn't nudged moves to the new automatic timing; a nudged one keeps its offset."""
    room = rooms.room_or_404(room_id)
    user_id = common.require_safe_identifier(str(payload.get("user_id") or ""), "user_id")
    line, take = _take_or_404(room, line_id, take_id)
    _require_line_actor(room, line, user_id)
    if float(take.get("stretch", 1.0)) == 1.0:
        return {"status": "ok", "line_id": line_id, "take": room.wire_take(line_id, take)}

    target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, line)

    def rewrite():
        # Reuses the noise-reduction switch to rewrite the active file from its current
        # source (cleaned or raw) at 1.0 and re-measure it.
        written = audio_processor.toggle_take_noise_reduction(
            room.room_id,
            audio_processor.take_dir(room.room_id, line_id),
            take_id,
            enable_noise_reduction=bool(take.get("noise_reduction", False)),
            nr_settings=take.get("nr_settings"),
            target_loudness_db=target_loudness,
            stretch=1.0,
        )
        timing = audio_processor.match_take_timing(
            audio_processor.read_wav_mono(written["wav_path"]),
            os.path.join(room.pack.folder, line["filename"]),
            int(take.get("start_offset_ms", take.get("offset_ms", 0))),
            allow_stretch=False,
        )
        return written, timing

    try:
        async with room.processing_lock:
            written, timing = await asyncio.to_thread(rewrite)
            old_auto_offset = take.get("auto_offset_ms", take.get("offset_ms", 0))
            if abs(int(take.get("offset_ms", 0)) - int(old_auto_offset)) < 5:
                take["offset_ms"] = timing["auto_offset_ms"]
            take["stretch"] = 1.0
            _store_nr_settings(take, written)
            take["auto_offset_ms"] = timing["auto_offset_ms"]
            take["timing_score"] = timing["timing_score"]
            take["aligned"] = timing["aligned"]
            take["audio_version"] = int(time.time() * 1000)
            take["peaks"] = written["peaks"]
            take["duration"] = written["duration"]
            old_auto_gain = take.get("auto_gain_db")
            if old_auto_gain is not None and abs(float(take.get("gain_db", 0.0)) - float(old_auto_gain)) < 0.05:
                take["gain_db"] = written["auto_gain_db"]
            take["speech_loudness_db"] = written["speech_loudness_db"]
            take["target_loudness_db"] = written["target_loudness_db"]
            take["auto_gain_db"] = written["auto_gain_db"]
    except Exception as ex:
        print(f"[OriginalSpeedError] {ex}")
        raise HTTPException(status_code=400, detail=str(ex))

    wire = room.wire_take(line_id, take)
    room.invalidate_exports()
    await room.broadcast("take_params_updated", {
        "line_id": line_id,
        "take_id": take_id,
        "url": wire["url"],
    })
    return {"status": "ok", "line_id": line_id, "take": wire}


@router.post("/api/rooms/{room_id}/cleanup/refresh")
async def refresh_cleanup(room_id: str, payload: Dict[str, Any]):
    """Refresh older takes: moves one person's takes to their latest room check (an unknown
    or missing id means standard cleanup). A take with noise reduction off just gets the new
    settings. One with it on whose active audio isn't the new cleaning is re-cleaned in the
    background and gets the new settings only once that worked; the rest already sound
    right. Returns how many will be re-cleaned. Raw takes are never touched."""
    room = rooms.room_or_404(room_id)
    user_id = common.require_safe_identifier(str(payload.get("user_id") or ""), "user_id")
    if any(status == "processing" for status in room.export_status.values()):
        raise HTTPException(status_code=409, detail="A video is rendering. Refresh older takes when it's done.")
    if user_id in room.cleanup_refreshing:
        return {"status": "ok", "refreshing": room.cleanup_refreshing[user_id]}

    settings = audio_processor.noise_cleanup_settings(payload.get("noise_profile_id"))
    # Claimed before the first await, so a second request or a render can't slip in.
    room.cleanup_refreshing[user_id] = 0
    try:
        # Under the lock, so a toggle or Original speed in flight can't write its old
        # settings back over the new ones.
        async with room.processing_lock:
            mine = [
                (line_id, take)
                for line_id, entry in room.takes.items()
                for take in entry["takes"]
                if take.get("user_id") == user_id
            ]
            # Lines outside the current pack have no original to match loudness to: a take
            # there with noise reduction on keeps its cleanup until it's re-cleaned.
            cleaned = [(line_id, take) for line_id, take in mine
                       if take.get("noise_reduction") and room.find_line(line_id)]

            def stale_takes():
                return [(line_id, take["take_id"]) for line_id, take in cleaned
                        if _needs_reclean(room.room_id, line_id, take, settings)]

            queued = await asyncio.to_thread(stale_takes)
            stale = set(queued)
            in_pack = {id(take) for _, take in cleaned}
            for line_id, take in mine:
                if (line_id, take["take_id"]) in stale:
                    continue
                if not take.get("noise_reduction") or id(take) in in_pack:
                    _store_nr_settings(take, {"nr_settings": settings})
    except Exception:
        room.cleanup_refreshing.pop(user_id, None)
        raise

    if not queued:
        room.cleanup_refreshing.pop(user_id, None)
        await room.broadcast("cleanup_refreshed", {"user_id": user_id, "count": 0, "failed": 0})
        return {"status": "ok", "refreshing": 0}

    room.cleanup_refreshing[user_id] = len(queued)
    room.cleanup_refresh_task = asyncio.create_task(
        _refresh_takes(room, user_id, queued, settings, room.cleanup_refresh_task)
    )
    return {"status": "ok", "refreshing": len(queued)}


def _needs_reclean(room_id: str, line_id: str, take: Dict[str, Any], settings) -> bool:
    """True when the take's active audio isn't the cleaning `settings` give: the take is
    on other settings, or the cleaned file for these is missing."""
    take_dir = audio_processor.take_dir(room_id, line_id, create=False)
    wanted = audio_processor.denoised_take_path(take_dir, take["take_id"], settings)
    current = audio_processor.denoised_take_path(take_dir, take["take_id"], take.get("nr_settings"))
    return wanted != current or not os.path.exists(wanted)


async def _refresh_takes(room, user_id: str, queued, settings, previous) -> None:
    """Re-cleans the queued takes one at a time with `settings`, each under the room's
    processing lock, at the take's stretch. A take gets the new settings only once its new
    audio is written; one that fails keeps its settings and sound and is counted in
    `failed`. Timing fields stay, as with the toggle. A take deleted meanwhile is skipped;
    one switched to raw meanwhile just gets the new settings."""
    count = 0
    failed = 0
    try:
        # One refresh at a time, so the latest task finishes last and launch_premiere can wait on it.
        if previous is not None and not previous.done():
            await asyncio.wait({previous})
        for line_id, take_id in queued:
            line = room.find_line(line_id)
            try:
                if line and room.find_take(line_id, take_id):
                    target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, line)
                    async with room.processing_lock:
                        take = room.find_take(line_id, take_id)
                        if take and take.get("noise_reduction"):
                            toggled = await asyncio.to_thread(
                                audio_processor.toggle_take_noise_reduction,
                                room.room_id,
                                audio_processor.take_dir(room.room_id, line_id),
                                take_id,
                                enable_noise_reduction=True,
                                nr_settings=settings,
                                target_loudness_db=target_loudness,
                                stretch=float(take.get("stretch", 1.0)),
                            )
                            _apply_toggled_take(take, toggled, True)
                        else:
                            if take:
                                _store_nr_settings(take, {"nr_settings": settings})
                            take = None
                    if take:
                        count += 1
                        await room.broadcast("take_params_updated", {
                            "line_id": line_id,
                            "take_id": take_id,
                            "url": room.wire_take(line_id, take)["url"],
                            "noise_reduction": True,
                        })
            except Exception as ex:
                failed += 1
                print(f"[CleanupRefreshError] {room.room_id} {line_id}/{take_id}: {ex}")
            room.cleanup_refreshing[user_id] = max(0, room.cleanup_refreshing.get(user_id, 1) - 1)
        room.invalidate_exports()
        # Renders are allowed again before clients hear that the refresh is done.
        room.cleanup_refreshing.pop(user_id, None)
        await room.broadcast("cleanup_refreshed", {"user_id": user_id, "count": count, "failed": failed})
    finally:
        room.cleanup_refreshing.pop(user_id, None)


@router.get("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/peaks")
async def get_take_peaks(room_id: str, line_id: str, take_id: str):
    """Returns compact peaks waveform data for a specific take on-demand."""
    room = rooms.room_or_404(room_id)
    _, take = _take_or_404(room, line_id, take_id)
    return {
        "status": "ok",
        "line_id": line_id,
        "take_id": take_id,
        "peaks": take.get("peaks", []),
        "duration": take.get("duration", 0.0),
        "url": room.wire_take(line_id, take)["url"],
    }


@router.get("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/audio")
async def get_take_audio(room_id: str, line_id: str, take_id: str, request: Request):
    room = rooms.room_or_404(room_id)
    _take_or_404(room, line_id, take_id)
    wav_path = audio_processor.take_wav_path(room.room_id, line_id, take_id)
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
    _refuse_during_cleanup_refresh(room)

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
    _refuse_during_cleanup_refresh(room)

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
    _refuse_during_cleanup_refresh(room)

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
