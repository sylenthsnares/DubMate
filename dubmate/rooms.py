# -*- coding: utf-8 -*-
"""
dubmate/rooms.py
The in-memory Room model, the ROOMS table, room persistence and session pruning.

A leaf module: it imports no routers. The exports folder is read through
common.exports_dir() and the pack registry through packs_cache.PACKS_CACHE at call
time, so a changed setting or a rescan is always seen.
"""

import os
import json
import time
import random
import shutil
import asyncio
from typing import Dict, List, Optional, Set, Any

from fastapi import WebSocket, HTTPException

import pack_loader
import audio_processor
from dubmate import common, packs_cache


def generate_room_code() -> str:
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(letters) for _ in range(6))


class Room:
    def __init__(self, room_id: str, pack: pack_loader.PackInfo, host_id: str, host_name: str, host_color: str):
        self.room_id = room_id
        self.pack = pack
        self.host_id = host_id
        self.users: Dict[str, Dict[str, Any]] = {
            host_id: {
                "id": host_id,
                "name": host_name,
                "color": host_color,
                "is_host": True,
                "is_online": True,
            }
        }
        # Role assignments: character_name -> list of assigned user_ids
        self.role_assignments: Dict[str, List[str]] = {char: [] for char in pack.characters}
        # By default assign the first character to host
        if pack.characters:
            self.role_assignments[pack.characters[0]] = [host_id]

        # Takes: line_index -> take info dict
        self.takes: Dict[int, Dict[str, Any]] = {}
        self.status: str = "lobby"  # "lobby" | "recording" | "screening"
        self.exported_video_path: Optional[str] = None
        self.exported_video_9_16_path: Optional[str] = None
        self.master_dialogue_presence_db: float = 0.0
        self.export_status: Dict[str, str] = {}
        self.sockets: Set[WebSocket] = set()
        self._save_dirty: bool = False
        self._save_task: Optional[asyncio.Task] = None
        # Take processing runs in a worker thread; this keeps one room's uploads and
        # noise-reduction toggles serialized without blocking other rooms.
        self.processing_lock = asyncio.Lock()

    def invalidate_exports(self):
        """Drops renders made from takes or mix settings that just changed.

        An in-flight render keeps its "processing" entry so a second ffmpeg cannot
        start writing the same output file underneath it.
        """
        self.exported_video_path = None
        self.exported_video_9_16_path = None
        self.export_status = {k: v for k, v in self.export_status.items() if v == "processing"}

    def export_out_path(self, aspect_ratio: str) -> str:
        """Where a render for this aspect goes. Reads common.exports_dir() at call time so a
        changed Render & Export Folder applies to the next export."""
        suffix = "_9_16" if aspect_ratio == "9:16" else ""
        return os.path.join(common.exports_dir(), f"Dub_{self.pack.pack_id}_{self.room_id}{suffix}.mp4")

    def ready_export_path(self, aspect_ratio: str) -> Optional[str]:
        """The finished render for this aspect, or None if there is no usable file."""
        path = self.exported_video_9_16_path if aspect_ratio == "9:16" else self.exported_video_path
        if path and os.path.exists(path) and os.path.getsize(path) > 1000:
            return path
        return None

    def export_ready_payload(self, aspect_ratio: str) -> Dict[str, Any]:
        """URLs and stats the clients need once a render for this aspect is on disk."""
        path = self.exported_video_9_16_path if aspect_ratio == "9:16" else self.exported_video_path
        file_size_mb = round(os.path.getsize(path) / (1024 * 1024), 2) if path and os.path.exists(path) else 0.0
        timestamp_ms = int(time.time() * 1000)
        return {
            "download_url": f"/api/rooms/{self.room_id}/export/download?aspect_ratio={aspect_ratio}",
            "export_video_url": f"/api/rooms/{self.room_id}/export/video?aspect_ratio={aspect_ratio}&v={timestamp_ms}",
            "download_url_16_9": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=9:16",
            "file_size_mb": file_size_mb,
            "duration": round(self.pack.duration, 1),
            "aspect_ratio": aspect_ratio,
        }

    def mark_dirty(self):
        self._save_dirty = True
        if self._save_task is None or self._save_task.done():
            try:
                loop = asyncio.get_running_loop()
                self._save_task = loop.create_task(self._debounced_save())
            except RuntimeError:
                pass

    async def _debounced_save(self):
        try:
            await asyncio.sleep(3.0)
            if self._save_dirty:
                self._save_dirty = False
                await asyncio.to_thread(self._sync_save_to_disk)
        except asyncio.CancelledError:
            if self._save_dirty:
                self._save_dirty = False
                self._sync_save_to_disk()
        except Exception as ex:
            print(f"[RoomPersistence] Error in debounced save: {ex}")

    def _sync_save_to_disk(self):
        try:
            room_dir = audio_processor.get_room_cache_dir(self.room_id)
            state_file = os.path.join(room_dir, "room_state.json")
            data = {
                "room_id": self.room_id,
                "pack_id": self.pack.pack_id,
                "host_id": self.host_id,
                "users": self.users,
                "role_assignments": self.role_assignments,
                "takes": self.takes,
                "status": self.status,
                "exported_video_path": self.exported_video_path,
            }
            tmp_file = state_file + ".tmp"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            if os.path.exists(state_file):
                os.replace(tmp_file, state_file)
            else:
                os.rename(tmp_file, state_file)
        except Exception as ex:
            print(f"[RoomPersistence] Error saving room {self.room_id}: {ex}")

    def to_state_dict(self) -> Dict[str, Any]:
        has_export_16_9 = self.exported_video_path is not None and os.path.exists(self.exported_video_path)
        has_export = has_export_16_9
        return {
            "room_id": self.room_id,
            "pack": self.pack.to_dict(),
            "host_id": self.host_id,
            "users": self.users,
            "role_assignments": self.role_assignments,
            "takes": {
                str(k): {
                    "user_id": v.get("user_id"),
                    "user_name": v.get("user_name"),
                    "duration": v.get("duration"),
                    "peaks": v.get("peaks"),
                    "offset_ms": v.get("offset_ms", 0),
                    "pitch_semitones": v.get("pitch_semitones", 0.0),
                    "reverb_wet": v.get("reverb_wet", 0.0),
                    "gain_db": v.get("gain_db", 0.0),
                    "noise_reduction": v.get("noise_reduction", False),
                    "has_raw": v.get("has_raw", True),
                    "speech_loudness_db": v.get("speech_loudness_db"),
                    "target_loudness_db": v.get("target_loudness_db"),
                    "auto_gain_db": v.get("auto_gain_db", 0.0),
                    "url": v.get("url"),
                    "recorded_at": v.get("recorded_at"),
                }
                for k, v in self.takes.items()
            },
            "status": self.status,
            "master_dialogue_presence_db": self.master_dialogue_presence_db,
            "has_export": has_export,
            "export_video_url": f"/api/rooms/{self.room_id}/export/video?aspect_ratio=16:9" if has_export else None,
            "download_url": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9" if has_export else None,
            "download_url_16_9": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=9:16",
            "project_zip_url": f"/api/rooms/{self.room_id}/export/project_zip",
        }

    async def broadcast(self, message_type: str, payload: Any = None):
        self.mark_dirty()
        state = self.to_state_dict()
        data = json.dumps({"type": message_type, "payload": payload, "state": state})
        dead_sockets = set()
        for ws in list(self.sockets):
            try:
                await ws.send_text(data)
            except Exception:
                dead_sockets.add(ws)
        self.sockets -= dead_sockets


ROOMS: Dict[str, Room] = {}


def room_or_404(room_id: str) -> Room:
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


def prune_sessions(keep_room_id: Optional[str] = None):
    """
    Strict Single-Session Retention Policy:
    Ensures only the latest / active session is kept on disk and in memory.
    Purges all older room folders and their takes to keep the server ultra-light.

    The exports folder is never touched. It is the user's folder (often one they
    chose), the host is told a render or project ZIP is "saved" there, and it can
    hold files DubMate didn't write. Pruning it deleted those on the next new room.
    """
    rooms_dir = os.path.join(audio_processor.CACHE_DIR, "rooms")
    if not os.path.isdir(rooms_dir):
        return

    room_folders = []
    for r_id in os.listdir(rooms_dir):
        full_path = os.path.join(rooms_dir, r_id)
        if os.path.isdir(full_path):
            try:
                mtime = os.path.getmtime(full_path)
            except Exception:
                mtime = 0
            room_folders.append((r_id, full_path, mtime))

    # Sort newest first
    room_folders.sort(key=lambda x: x[2], reverse=True)

    retained_id = None
    if keep_room_id:
        retained_id = keep_room_id.upper()
    elif room_folders:
        retained_id = room_folders[0][0].upper()

    # Never purge a room that still has connected actors. This previously deleted
    # other live sessions' rooms and their recorded takes the moment anyone created
    # a new room, breaking every REST call for that room's cast mid-session.
    active_ids = {rid.upper() for rid, rm in ROOMS.items() if getattr(rm, "sockets", None)}

    # Delete all other room directories
    for r_id, full_path, _ in room_folders:
        if retained_id and r_id.upper() == retained_id:
            continue
        if r_id.upper() in active_ids:
            print(f"[DubMate Cache Pruner] Keeping active session: {r_id}")
            continue
        try:
            shutil.rmtree(full_path, ignore_errors=True)
            print(f"[DubMate Cache Pruner] Purged older session: {r_id}")
        except Exception as ex:
            print(f"[DubMate Cache Pruner] Could not delete {r_id}: {ex}")

    # Prune in-memory ROOMS
    to_delete = [
        r for r in list(ROOMS.keys())
        if (not retained_id or r.upper() != retained_id) and r.upper() not in active_ids
    ]
    for r in to_delete:
        ROOMS.pop(r, None)


def load_persisted_rooms():
    prune_sessions()
    registry = packs_cache.PACKS_CACHE
    rooms_dir = os.path.join(audio_processor.CACHE_DIR, "rooms")
    if not os.path.isdir(rooms_dir):
        return
    for r_id in os.listdir(rooms_dir):
        room_folder = os.path.join(rooms_dir, r_id)
        if not os.path.isdir(room_folder):
            continue

        state_file = os.path.join(room_folder, "room_state.json")
        if os.path.isfile(state_file):
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                pack_id = data.get("pack_id")
                pack = registry.get(pack_id)
                if pack:
                    host_id = data.get("host_id", "host")
                    users = data.get("users", {})
                    host_user = users.get(host_id, {})
                    host_name = host_user.get("name", "Host")
                    host_color = common.sanitize_color(host_user.get("color"), "#8a6eff")
                    room = Room(r_id, pack, host_id, host_name, host_color)
                    room.users = data.get("users", room.users)
                    room.role_assignments = data.get("role_assignments", room.role_assignments)
                    raw_takes = data.get("takes", {})
                    room.takes = {int(k): v for k, v in raw_takes.items()}
                    room.status = data.get("status", "lobby")
                    room.exported_video_path = data.get("exported_video_path")
                    ROOMS[r_id.upper()] = room
                    print(f"[DubMate] Preserved last active session {r_id.upper()} with {len(room.takes)} takes from disk.")
            except Exception as ex:
                print(f"[DubMate] Error restoring room {r_id}: {ex}")
