# -*- coding: utf-8 -*-
"""
dubmate/rooms_api.py
Room REST routes (/api/rooms/*): create, share, state, noise profile, takes,
voice chains and level matching, export render, video streaming and downloads.

Works on the room model in dubmate.rooms and never imports app.
"""

import os
import time
import uuid
import asyncio
import functools
import re
import math
import threading
from collections import deque
from typing import Dict, Any, Iterable, Optional, Tuple

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

import audio_processor
import pack_loader
from dubmate import common, packs_cache, rooms, room_registry, vocal_chain

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

    Falls back to DEFAULT_DIALOGUE_LUFS when the line can't be read or reads at or
    below DIALOGUE_LUFS_FLOOR.
    """
    try:
        measured = pack_loader.measure_line_loudness(os.path.join(pack.folder, line["filename"]))
    except Exception as ex:
        print(f"[Loudness] Could not measure reference line {line.get('filename')!r}: {ex}")
        return audio_processor.DEFAULT_DIALOGUE_LUFS
    if measured <= audio_processor.DIALOGUE_LUFS_FLOOR:
        return audio_processor.DEFAULT_DIALOGUE_LUFS
    return measured


def _render_level(room, line_id: str, take_id: str, wav_path: str, chain, target_lufs: float):
    """The take's matched level measured on its render through chain
    ({"loudness_lufs", "target_lufs", "auto_gain_db"}), or None when the voice effects
    aren't installed or the render failed."""
    try:
        path, _ = audio_processor.render_take_cached(
            wav_path, chain, audio_processor.room_render_dir(room.room_id),
            meta={"line_id": line_id, "take_id": take_id})
    except audio_processor.EffectsUnavailable:
        return None
    except Exception as ex:
        print(f"[Loudness] Could not render take {take_id} of line {line_id} for its level: {ex}")
        return None
    return audio_processor.calculate_take_auto_gain(path, target_lufs=target_lufs)


async def _rematch_level(room, line_id: str, take: Dict[str, Any], target_lufs: Optional[float] = None,
                         measured: Optional[Dict[str, Any]] = None) -> bool:
    """Matches a take's level again on the render of its resolved chain and stores
    loudness_lufs, target_lufs and auto_gain_db. A take that was sitting at its auto gain
    (within 0.05 dB) moves to the new auto gain. Without the voice effects the level
    measured on the take's own audio (`measured`, from an audio rewrite) is stored without
    loudness_lufs; with neither nothing changes. Returns whether a level was stored.
    The caller holds room.processing_lock."""
    line = room.find_line(line_id)
    if line is None:
        return False
    if target_lufs is None:
        target_lufs = await asyncio.to_thread(_line_target_loudness, room.pack, line)
    level = await asyncio.to_thread(
        _render_level, room, line_id, take["take_id"],
        audio_processor.take_wav_path(room.room_id, line_id, take["take_id"]),
        room.take_sound(line, take), target_lufs)
    if level is None:
        if measured is None:
            return False
        level = {"target_lufs": measured["target_lufs"], "auto_gain_db": measured["auto_gain_db"]}
        take.pop("loudness_lufs", None)
    old_auto = take.get("auto_gain_db")
    if old_auto is not None and abs(float(take.get("gain_db", 0.0)) - float(old_auto)) < 0.05:
        take["gain_db"] = level["auto_gain_db"]
    take.update(level)
    return True


def rematch_later(room, pairs: Iterable[Tuple[str, str]]) -> None:
    """Matches these (line_id, take_id) takes' levels again in the background
    (room.voice_job), then sends levels_updated. Pairs added while the job runs join it."""
    room.rematch_pending.update(pairs)
    if room.voice_job is None or room.voice_job.done():
        room.voice_job = asyncio.create_task(_rematch_pending(room))


async def _rematch_pending(room) -> None:
    while room.rematch_pending:
        batch = sorted(room.rematch_pending)
        room.rematch_pending.clear()
        matched = []
        for line_id, take_id in batch:
            try:
                async with room.processing_lock:
                    take = room.find_take(line_id, take_id)
                    if take and await _rematch_level(room, line_id, take):
                        matched.append({"line_id": line_id, "take_id": take_id})
            except Exception as ex:
                print(f"[Loudness] Could not match the level of take {take_id} of line {line_id}: {ex}")
        if matched:
            room.invalidate_exports()
            await room.broadcast("levels_updated", {"takes": matched})


async def mix_for_export(room) -> Dict[int, Dict[str, Any]]:
    """Room.mix_takes() once background level matching is done. A picked take that was
    levelled while the voice effects weren't installed (target_lufs but no loudness_lufs)
    is matched on its render first."""
    if room.voice_job is not None:
        await asyncio.wait({room.voice_job})
    changed = False
    for line in room.pack.lines:
        take = room.picked_take(line["line_id"])
        if take and "target_lufs" in take and "loudness_lufs" not in take:
            async with room.processing_lock:
                changed |= await _rematch_level(room, line["line_id"], take)
    if changed:
        room.mark_dirty()
    return room.mix_takes()


def legacy_sliders_onto_chain(room, line, take: Dict[str, Any], values: Dict[str, Any],
                             shown: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The old Pitch and Reverb sliders' values (pitch_semitones, reverb_wet), still accepted
    on an upload from a studio that sends them (the booth now edits chains and doesn't):
    values that differ from what the take showed (`shown`) are put on the take's resolved
    chain (vocal_chain.chain_with_legacy). Returns that chain, or None when neither moved."""
    moved = {}
    for key in ("pitch_semitones", "reverb_wet"):
        if key not in values:
            continue
        try:
            value, before = float(values[key]), float(shown.get(key) or 0.0)
        except (TypeError, ValueError):
            continue
        if abs(value - before) > 1e-6:
            moved[key] = value
    if not moved:
        return None
    return vocal_chain.chain_with_legacy(room.take_sound(line, take), pitch=moved.get("pitch_semitones"),
                                         reverb_wet=moved.get("reverb_wet"))


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


@router.post("/api/rooms/{room_id}/lines/{line_id}/takes")
async def upload_take(
    room_id: str,
    line_id: str,
    file: UploadFile = File(...),
    user_id: str = Form(...),
    user_name: str = Form("Actor"),
    offset_ms: int = Form(0),
    # Old studios only; the booth leaves them out and the take keeps the picked take's sound.
    pitch_semitones: Optional[float] = Form(None),
    reverb_wet: Optional[float] = Form(None),
    gain_db: float = Form(0.0),
    noise_reduction: bool = Form(False),
    auto_gain: bool = Form(False),
    guide_voice: bool = Form(False),
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
                target_lufs=target_loudness,
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

    # A new take keeps the sound of the take it replaces in the dub (its own chain, if any).
    previous = room.picked_take(line_id) or {}
    sound = {"chain": previous["chain"]} if isinstance(previous.get("chain"), dict) else {}
    sliders = {k: v for k, v in (("pitch_semitones", pitch_semitones), ("reverb_wet", reverb_wet)) if v is not None}
    legacy = legacy_sliders_onto_chain(room, line, sound, sliders, previous)
    if legacy is not None:
        sound["chain"] = legacy

    # The level is matched on the take's sound through its chain. Without the voice
    # effects it stays the one measured on the take itself, and loudness_lufs is left out.
    level = await asyncio.to_thread(_render_level, room, line_id, take_id, saved["wav_path"],
                                    room.take_sound(line, sound), target_loudness)
    if level is None:
        level = {"target_lufs": saved.get("target_lufs"), "auto_gain_db": saved.get("auto_gain_db", 0.0)}

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
        **sliders,
        **sound,
        # auto_gain: the client asked for the scene-matched level, applied here so the
        # take_recorded broadcast already carries it.
        "gain_db": level["auto_gain_db"] if auto_gain else gain_db,
        "noise_reduction": saved.get("noise_reduction", noise_reduction),
        "has_raw": True,
        **level,
        "recorded_at": time.time(),
    })
    wire = room.wire_take(line_id, take)
    queue_preset_renders(room, line_id, take)

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
    user_id = take.get("user_id", "host")
    target_loudness = await asyncio.to_thread(_line_target_loudness, room.pack, line)

    try:
        async with room.processing_lock:
            toggled = await asyncio.to_thread(
                audio_processor.toggle_take_noise_reduction,
                room.room_id,
                audio_processor.take_dir(room.room_id, line_id),
                take_id,
                enable_noise_reduction=enable,
                user_id=user_id,
                target_lufs=target_loudness,
                # A fitted take stays fitted; its timing fields don't change.
                stretch=float(take.get("stretch", 1.0)),
            )
            take["noise_reduction"] = enable
            take["audio_version"] = int(time.time() * 1000)
            take["peaks"] = toggled["peaks"]
            take["duration"] = toggled["duration"]
            # The swapped audio has a different level: re-match, and keep a take that was
            # sitting at its auto gain on the new auto gain.
            await _rematch_level(room, line_id, take, target_loudness, measured=toggled)
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
            user_id=take.get("user_id", "host"),
            target_lufs=target_loudness,
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
            take["auto_offset_ms"] = timing["auto_offset_ms"]
            take["timing_score"] = timing["timing_score"]
            take["aligned"] = timing["aligned"]
            take["audio_version"] = int(time.time() * 1000)
            take["peaks"] = written["peaks"]
            take["duration"] = written["duration"]
            await _rematch_level(room, line_id, take, target_loudness, measured=written)
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


def _chain_or_none(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The request's "chain", normalized, or None to clear it. 400 for anything else."""
    raw = payload.get("chain")
    if raw is None:
        return None
    try:
        return vocal_chain.normalize_chain(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="That sound couldn't be read.")


@router.put("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/chain")
async def set_take_chain(room_id: str, line_id: str, take_id: str, payload: Dict[str, Any]):
    """Sets the take's own sound, or with chain null makes it follow its character and the
    room again. Its level is matched on the new sound."""
    room = rooms.room_or_404(room_id)
    user_id = common.require_safe_identifier(str(payload.get("user_id") or ""), "user_id")
    line, take = _take_or_404(room, line_id, take_id)
    _require_line_actor(room, line, user_id)
    chain = _chain_or_none(payload)

    async with room.processing_lock:
        if chain is None:
            take.pop("chain", None)
        else:
            take["chain"] = chain
        await _rematch_level(room, line_id, take)
    room.invalidate_exports()
    await room.broadcast("take_params_updated", {"line_id": line_id, "take_id": take_id})
    return {"status": "ok", "line_id": line_id, "take": room.wire_take(line_id, take), "line": room.wire_line(line_id)}


@router.put("/api/rooms/{room_id}/voice")
async def set_room_voice(room_id: str, payload: Dict[str, Any]):
    """Sets (or with chain null clears) the sound of all of one character's lines (scope
    "character") or of every line (scope "session"). The takes on those lines drop their
    own sound, and "session" also drops every character's, so the new sound is heard.
    Their levels are matched again in the background."""
    room = rooms.room_or_404(room_id)
    user_id = common.require_safe_identifier(str(payload.get("user_id") or ""), "user_id")
    scope = payload.get("scope")
    is_host = user_id == room.host_id or room.host_id == "host"

    if scope == "character":
        character = payload.get("character")
        if not isinstance(character, str) or character not in room.pack.characters:
            raise HTTPException(status_code=400, detail="That character isn't in this scene.")
        assigned = room.role_assignments.get(character) or []
        if assigned and user_id not in assigned and not is_host:
            raise HTTPException(status_code=403,
                                detail=f"Only {character}'s actor or the host can change {character}'s sound.")
        chain = _chain_or_none(payload)
        if chain is None:
            room.voice["characters"].pop(character, None)
        else:
            room.voice["characters"][character] = chain
        lines = [l for l in room.pack.lines if l.get("character") == character]
    elif scope == "session":
        character = None
        if not is_host:
            raise HTTPException(status_code=403, detail="Only the host can change every line's sound.")
        room.voice["session"] = _chain_or_none(payload)
        room.voice["characters"] = {}
        lines = room.pack.lines
    else:
        raise HTTPException(status_code=400, detail="Choose a character or every line.")

    affected = []
    for line in lines:
        for take in (room.line_entry(line["line_id"]) or {}).get("takes", []):
            take.pop("chain", None)
            affected.append((line["line_id"], take["take_id"]))
    room.invalidate_exports()
    rematch_later(room, affected)
    await room.broadcast("voice_updated", {"scope": scope, "character": character})
    return {"status": "ok", "voice": room.to_state_dict()["voice"]}


# --- Voice chain renders (documentation/design/effects-rack.md, "API and WebSocket") ---
_RENDER_KEY_RE = re.compile(r"^[0-9a-f]{16}$")
_RENDER_CACHE_CONTROL = "public, max-age=31536000, immutable"   # a render key never changes content
_TAKE_AUDIO_MISSING = "This take's recording is missing."


class _RenderEngine:
    """Foreground render slots, supersede bookkeeping and the background preset queue
    of the running event loop (one per engine process)."""

    def __init__(self):
        self.foreground = asyncio.Semaphore(2)
        self.active = 0                      # foreground renders running
        self.idle = asyncio.Event()          # set while no foreground render runs
        self.idle.set()
        self.seq = 0
        self.latest: Dict[Tuple[str, str, str, str], int] = {}   # (client, room, line, take) -> newest request
        self.presets: deque = deque()        # (wav_path, chain, render_dir, meta) still to render
        self.queued: set = set()             # takes whose presets were queued this run
        self.worker: Optional[asyncio.Task] = None


_render_engine_state: Optional[Tuple[asyncio.AbstractEventLoop, _RenderEngine]] = None


def _render_engine() -> _RenderEngine:
    global _render_engine_state
    loop = asyncio.get_running_loop()
    if _render_engine_state is None or _render_engine_state[0] is not loop:
        _render_engine_state = (loop, _RenderEngine())
    return _render_engine_state[1]


def queue_preset_renders(room, line_id: str, take: Dict[str, Any]) -> None:
    """Renders the take through every preset in the background (once per take audio this
    run), after any foreground render, so switching presets is instant."""
    if not vocal_chain.available():
        return
    engine = _render_engine()
    take_id = take["take_id"]
    mark = (room.room_id, line_id, take_id, take.get("audio_version"))
    if mark in engine.queued:
        return
    engine.queued.add(mark)
    wav_path = audio_processor.take_wav_path(room.room_id, line_id, take_id)
    render_dir = audio_processor.room_render_dir(room.room_id)
    for preset in vocal_chain.PRESETS.values():
        engine.presets.append((wav_path, preset["chain"], render_dir, {"line_id": line_id, "take_id": take_id}))
    if engine.worker is None or engine.worker.done():
        engine.worker = asyncio.create_task(_drain_preset_renders(engine))


async def _drain_preset_renders(engine: _RenderEngine) -> None:
    while engine.presets:
        await engine.idle.wait()
        wav_path, chain, render_dir, meta = engine.presets.popleft()
        if not os.path.isfile(wav_path):
            continue   # take or room deleted meanwhile
        try:
            await asyncio.to_thread(audio_processor.render_take_cached, wav_path, chain, render_dir, meta=meta)
        except Exception as ex:
            print(f"[Render] Could not render a preset for take {meta['take_id']} of line {meta['line_id']}: {ex}")


@router.post("/api/rooms/{room_id}/lines/{line_id}/takes/{take_id}/render")
async def render_take(room_id: str, line_id: str, take_id: str, payload: Dict[str, Any]):
    """The take through a chain, rendered by the engine (the one sound for preview and
    export). A request still waiting for a render slot when a newer one arrives from the
    same client for the same take returns 409 without rendering. A take whose recording
    is gone returns 404."""
    room = rooms.room_or_404(room_id)
    _, take = _take_or_404(room, line_id, take_id)
    wav_path = audio_processor.take_wav_path(room.room_id, line_id, take_id)
    if not os.path.isfile(wav_path):
        raise HTTPException(status_code=404, detail=_TAKE_AUDIO_MISSING)
    try:
        chain = vocal_chain.normalize_chain(payload.get("chain"))
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex))
    until_s = payload.get("until_s")
    if until_s is not None:
        try:
            until_s = float(until_s)
        except (TypeError, ValueError):
            until_s = math.nan
        if not math.isfinite(until_s) or until_s < 0:
            raise HTTPException(status_code=400, detail="until_s must be a positive number of seconds.")

    engine = _render_engine()
    slot = (str(payload.get("client_id") or "")[:64], room.room_id, line_id, take_id)
    engine.seq += 1
    seq = engine.seq
    engine.latest[slot] = seq
    try:
        async with engine.foreground:
            if engine.latest.get(slot) != seq:
                return JSONResponse(status_code=409, content={"superseded": True})
            engine.active += 1
            engine.idle.clear()
            try:
                path, info = await asyncio.to_thread(
                    audio_processor.render_take_cached, wav_path, chain,
                    audio_processor.room_render_dir(room.room_id), until_s=until_s,
                    meta={"line_id": line_id, "take_id": take_id})
            except audio_processor.EffectsUnavailable as ex:
                return JSONResponse(status_code=503, content={"effects_unavailable": True, "message": str(ex)})
            except FileNotFoundError:
                if os.path.isfile(wav_path):
                    raise   # something else is missing (ffmpeg, say): not the recording
                raise HTTPException(status_code=404, detail=_TAKE_AUDIO_MISSING)   # deleted meanwhile
            finally:
                engine.active -= 1
                if engine.active == 0:
                    engine.idle.set()
    finally:
        if engine.latest.get(slot) == seq:
            del engine.latest[slot]

    queue_preset_renders(room, line_id, take)
    key = os.path.basename(path)[:-4]
    result = {"url": f"/api/rooms/{room.room_id}/renders/{key}.wav", "key": key,
              "duration": info.get("duration")}
    if "lufs" in info:
        result["lufs"] = info["lufs"]
    return result


@router.get("/api/rooms/{room_id}/renders/{key}.wav")
async def get_render(room_id: str, key: str, request: Request):
    """A cached render, range-streamed. Keys are content hashes, so it is cached for good."""
    room = rooms.room_or_404(room_id)
    if not _RENDER_KEY_RE.match(key):
        raise HTTPException(status_code=404, detail="Render not found")
    render_dir = audio_processor.room_render_dir(room.room_id)
    path = os.path.join(render_dir, f"{key}.wav")
    try:
        audio_processor._ensure_within_directory(path, render_dir)
    except ValueError:
        raise HTTPException(status_code=404, detail="Render not found")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Render not found")
    return common.range_stream_file(path, request, media_type="audio/wav", cache_control=_RENDER_CACHE_CONTROL)


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
    takes = await mix_for_export(room)

    # Captured here, on the event loop thread: the worker thread has no running loop
    # of its own, so asyncio.get_event_loop() there cannot reach the clients.
    loop = asyncio.get_running_loop()

    def notify_clients(message_type: str, payload: Dict[str, Any]):
        try:
            asyncio.run_coroutine_threadsafe(room.broadcast(message_type, payload), loop)
        except Exception as ex:
            print(f"[ExportWorkerWarning] Could not broadcast {message_type} for {room.room_id} ({aspect_ratio}): {ex}")

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
        takes = await mix_for_export(room)
        # ffmpeg render is fully synchronous; off-loading keeps it from stalling the
        # event loop (and therefore every other room's websocket) for its whole duration.
        try:
            await asyncio.to_thread(
                audio_processor.export_dub_video,
                room.pack, takes, out_path,
                aspect_ratio="9:16" if is_9_16 else "16:9",
                master_dialogue_presence_db=room.master_dialogue_presence_db,
            )
        except audio_processor.EffectsUnavailable as ex:
            raise HTTPException(status_code=503, detail=str(ex))
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
    takes = await mix_for_export(room)

    try:
        await asyncio.to_thread(
            functools.partial(
                audio_processor.build_project_zip,
                pack=room.pack,
                takes_dict=takes,
                role_assignments=room.role_assignments,
                users=room.users,
                output_zip_path=zip_path,
                room_id=room.room_id,
                bitrate="192k",
            )
        )
    except audio_processor.EffectsUnavailable as ex:
        raise HTTPException(status_code=503, detail=str(ex))
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
