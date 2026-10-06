# -*- coding: utf-8 -*-
"""
dubmate/sessions_api.py
Recent session routes (/api/sessions/*): list the host's recent sessions, continue one
and remove one. Every route works only on the engine's own computer.

Works on the room model in dubmate.rooms and never imports app.
"""

import os
import time
import shutil
import asyncio

from fastapi import APIRouter, HTTPException, Request

from dubmate import common, rooms, room_registry
import audio_processor

router = APIRouter()


def _listed_summary(code: str):
    """The card row for a code, or None when the session isn't listed."""
    return next((s for s in rooms.recent_sessions() if s["room_id"] == code), None)


@router.get("/api/sessions")
async def list_sessions(request: Request):
    common.require_own_computer(request)
    sessions = await asyncio.to_thread(rooms.recent_sessions)
    return {"sessions": [{k: v for k, v in s.items() if k != "listed"} for s in sessions]}


@router.post("/api/sessions/{room_id}/open")
async def open_session(room_id: str, request: Request):
    common.require_own_computer(request)
    code = common.require_safe_identifier(room_id, "session").upper()
    async with rooms.sessions_lock():
        summary = await asyncio.to_thread(_listed_summary, code)
        folder = os.path.join(audio_processor.CACHE_DIR, "rooms", code)
        if summary is None or not os.path.isdir(folder):
            raise HTTPException(status_code=404, detail="That session is gone.")
        room = rooms.ROOMS.get(code)
        if room is None:
            # Tried again even when the summary says the pack is missing: a rescan may
            # have brought it back.
            room = await asyncio.to_thread(rooms.load_room_folder, code)
        if room is None:
            # The load failure is recorded in UNLOADABLE_ROOMS, so readable is checked
            # afresh: a room that can't load is not a missing scene.
            if summary["readable"] and code not in rooms.UNLOADABLE_ROOMS:
                raise HTTPException(status_code=409, detail="This scene isn't in your library anymore.")
            raise HTTPException(status_code=409, detail="That session couldn't be opened.")
        room.last_active_at = time.time()
        room.mark_dirty()
        # The code is deliberately not queued for the room-code registry: its ownership
        # token died with the earlier run (see room_registry.WORKER_PENDING_ROOMS).
        return {"room_id": code, "user_id": room.creator_id, "state": room.to_state_dict()}


def _remove_folder(room, folder: str) -> None:
    if room is not None:
        with room._save_lock:
            room.deleted = True
            shutil.rmtree(folder, ignore_errors=True)
    else:
        shutil.rmtree(folder, ignore_errors=True)


@router.delete("/api/sessions/{room_id}")
async def delete_session(room_id: str, request: Request):
    common.require_own_computer(request)
    code = common.require_safe_identifier(room_id, "session").upper()
    async with rooms.sessions_lock():
        folder = common.safe_join(os.path.join(audio_processor.CACHE_DIR, "rooms"), code)
        if not os.path.isdir(folder):
            raise HTTPException(status_code=404, detail="That session is gone.")
        room = rooms.ROOMS.get(code)
        if room is not None and room.sockets:
            raise HTTPException(status_code=409, detail="Someone is still in this session.")

        rooms.ROOMS.pop(code, None)
        rooms.UNLOADABLE_ROOMS.discard(code)
        for table in (room_registry.WORKER_PENDING_ROOMS, room_registry.WORKER_ROOM_STATUS,
                      room_registry.WORKER_PUBLISHED_TUNNEL, room_registry.WORKER_PUBLISHED_AT):
            table.pop(code, None)

        if room is not None:
            # A cancelled debounced save writes in its CancelledError branch when dirty,
            # so clear the flag first; the deleted flag below stops any save already
            # running in a thread.
            room._save_dirty = False
            tasks = [t for t in (room._save_task, room.cleanup_refresh_task) if t is not None and not t.done()]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        await asyncio.to_thread(_remove_folder, room, folder)
        if os.path.exists(folder):
            raise HTTPException(status_code=500, detail="Couldn't remove that session. Try again.")
        return {"status": "ok"}
