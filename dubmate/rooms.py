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
import uuid
import random
import shutil
import asyncio
from typing import Dict, List, Optional, Set, Tuple, Any

from fastapi import WebSocket, HTTPException

import pack_loader
import audio_processor
from dubmate import common, packs_cache, vocal_chain


# room_state.json layout. Version 1 (no state_version) kept one take per line index.
# Voice chains ("voice" and take "chain") are additive, so they stay version 2.
STATE_VERSION = 2
# Room state sent to the studio (to_state_dict). 3: the booth edits voice chains, so a
# tab from before that stops applying state and asks for a reload (takes.js TAKE_STATE_VERSION).
CLIENT_STATE_VERSION = 3


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

        # Takes by stable line ID: {"picked": take_id or None, "next_number": int,
        # "takes": [take, ...] oldest first}. Entries for lines not in the current pack
        # are kept but never shown or mixed.
        self.takes: Dict[str, Dict[str, Any]] = {}
        # Version 1 takes (keyed by line index, files in the old layout) whose files could
        # not be moved yet. Saved as they are and retried on the next start.
        self.pending_v1_takes: Dict[str, Any] = {}
        # The room's voice chains: "session" is every line's sound, "characters" one
        # character's; a take's own "chain" beats both (vocal_chain.resolve_chain).
        self.voice: Dict[str, Any] = {"session": None, "characters": {}}
        # Background level matching after a sound change (rooms_api.rematch_later): the
        # (line_id, take_id) pairs still to match and the task matching them. Exports wait for it.
        self.rematch_pending: Set[Tuple[str, str]] = set()
        self.voice_job: Optional[asyncio.Task] = None
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

    def line_entry(self, line_id: str) -> Optional[Dict[str, Any]]:
        """The line's take history, or None if it has no takes."""
        return self.takes.get(line_id)

    def picked_take(self, line_id: str) -> Optional[Dict[str, Any]]:
        """The take used in the dub for this line, or None."""
        entry = self.takes.get(line_id)
        if not entry:
            return None
        return next((t for t in entry["takes"] if t["take_id"] == entry["picked"]), None)

    def add_take(self, line_id: str, fields: Dict[str, Any]) -> Dict[str, Any]:
        """Adds a take to the line and picks it. Older takes are kept. fields may carry the
        take_id its files were saved under; otherwise a new one is made."""
        entry = self.takes.setdefault(line_id, {"picked": None, "next_number": 1, "takes": []})
        take = {"take_id": uuid.uuid4().hex[:8], **fields, "number": entry["next_number"]}
        entry["next_number"] += 1
        entry["takes"].append(take)
        entry["picked"] = take["take_id"]
        return take

    def find_take(self, line_id: str, take_id: str) -> Optional[Dict[str, Any]]:
        """The line's take with this ID, or None."""
        entry = self.takes.get(line_id)
        return next((t for t in entry["takes"] if t["take_id"] == take_id), None) if entry else None

    def pick_take(self, line_id: str, take_id: str) -> Optional[Dict[str, Any]]:
        """Puts a take in the dub. Returns it, or None if the line has no such take."""
        take = self.find_take(line_id, take_id)
        if take:
            self.takes[line_id]["picked"] = take_id
        return take

    def remove_take(self, line_id: str, take_id: str) -> Optional[str]:
        """Deletes a take's files and entry. A deleted picked take falls back to the remaining
        take with the highest timing_score (unscored or zero-scored takes rank lowest; ties go
        to the newest),
        and the line's entry goes with its last take. Returns the picked take_id afterwards,
        or None when the line has no takes left."""
        entry = self.takes.get(line_id)
        if not entry:
            return None
        if any(t["take_id"] == take_id for t in entry["takes"]):
            audio_processor.delete_take_files(audio_processor.take_dir(self.room_id, line_id, create=False), take_id)
            entry["takes"] = [t for t in entry["takes"] if t["take_id"] != take_id]
        if not entry["takes"]:
            del self.takes[line_id]
            return None
        if entry["picked"] == take_id:
            ranked = [(max(0.0, t.get("timing_score") or 0.0), n) for n, t in enumerate(entry["takes"])]
            entry["picked"] = entry["takes"][max(ranked)[1]]["take_id"]
        return entry["picked"]

    def take_sound(self, line: Dict[str, Any], take: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """The chain a take of this line plays through: its own, else its character's, else
        the room's, else Clean."""
        return vocal_chain.resolve_chain(self.voice, line.get("character"), take)

    def mix_takes(self) -> Dict[int, Dict[str, Any]]:
        """{line index: copy of the picked take plus its line_id, resolved chain, wav_path and
        render_dir (the room's render cache)} for the lines of the current pack: the input of
        the render, export and project ZIP functions."""
        out = {}
        for line in self.pack.lines:
            take = self.picked_take(line["line_id"])
            if take:
                out[line["index"]] = {
                    **take,
                    "line_id": line["line_id"],
                    "chain": self.take_sound(line, take),
                    "wav_path": audio_processor.take_wav_path(self.room_id, line["line_id"], take["take_id"]),
                    "render_dir": audio_processor.room_render_dir(self.room_id),
                }
        return out

    def find_line(self, line_id: str) -> Optional[Dict[str, Any]]:
        """The current pack's line with this ID, or None."""
        return next((l for l in self.pack.lines if l["line_id"] == line_id), None)

    def wire_take(self, line_id: str, take: Dict[str, Any]) -> Dict[str, Any]:
        """A take as clients read it: the stored fields plus an audio url that changes
        whenever the audio does."""
        return {
            **take,
            "url": f"/api/rooms/{self.room_id}/lines/{line_id}/takes/{take['take_id']}/audio?v={take.get('audio_version', 0)}",
        }

    def wire_line(self, line_id: str) -> Optional[Dict[str, Any]]:
        """The line's take history as clients read it. Only the picked take carries peaks,
        so a line with many takes doesn't bloat every broadcast; the others are fetched on
        demand."""
        entry = self.takes.get(line_id)
        if not entry:
            return None
        takes = []
        for take in entry["takes"]:
            wire = self.wire_take(line_id, take)
            if take["take_id"] != entry["picked"]:
                wire.pop("peaks", None)
            takes.append(wire)
        return {"picked": entry["picked"], "next_number": entry["next_number"], "takes": takes}

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
                "state_version": STATE_VERSION,
                "room_id": self.room_id,
                "pack_id": self.pack.pack_id,
                "host_id": self.host_id,
                "users": self.users,
                "role_assignments": self.role_assignments,
                "takes": self.takes,
                "voice": self.voice,
                "status": self.status,
                "exported_video_path": self.exported_video_path,
            }
            if self.pending_v1_takes:
                data["pending_v1_takes"] = self.pending_v1_takes
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
            "state_version": CLIENT_STATE_VERSION,
            "room_id": self.room_id,
            "pack": self.pack.to_dict(),
            "host_id": self.host_id,
            "users": self.users,
            "role_assignments": self.role_assignments,
            "voice": {
                **self.voice,
                "presets": [{"id": pid, "name": p["name"], "chain": p["chain"]} for pid, p in vocal_chain.PRESETS.items()],
            },
            "takes": {
                line["line_id"]: self.wire_line(line["line_id"])
                for line in self.pack.lines
                if line["line_id"] in self.takes
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
                version = data.get("state_version")
                if version not in (None, 1, STATE_VERSION):
                    # A newer DubMate wrote this room. Reading it as an older layout would
                    # drop its takes on the next save, so it is left exactly as it is.
                    print(f"[DubMate] Room {r_id} was saved by a newer DubMate (layout {version!r}); "
                          f"it is left untouched and not loaded.")
                    continue
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
                    raw_takes = data.get("takes") or {}
                    room.status = data.get("status", "lobby")
                    room.exported_video_path = data.get("exported_video_path")
                    if version == STATE_VERSION:
                        room.takes = raw_takes
                        v1_takes = data.get("pending_v1_takes") or {}
                    else:
                        v1_takes = raw_takes
                    changed = False
                    if isinstance(v1_takes, dict) and v1_takes:
                        _migrate_v1_takes(room, v1_takes)
                        changed = True
                    if isinstance(data.get("voice"), dict):
                        room.voice = _voice_from_disk(data["voice"])
                    else:
                        _migrate_legacy_sound(room)
                        changed = True
                    if changed:
                        room._sync_save_to_disk()
                    ROOMS[r_id.upper()] = room
                    print(f"[DubMate] Preserved last active session {r_id.upper()} with {len(room.takes)} takes from disk.")
            except Exception as ex:
                print(f"[DubMate] Error restoring room {r_id}: {ex}")


def _voice_from_disk(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Room.voice from room_state.json, each chain normalized; anything unreadable is left out."""
    session = raw.get("session")
    characters = raw.get("characters") if isinstance(raw.get("characters"), dict) else {}
    return {
        "session": vocal_chain.normalize_chain(session) if isinstance(session, dict) else None,
        "characters": {name: vocal_chain.normalize_chain(chain) for name, chain in characters.items()
                       if isinstance(name, str) and isinstance(chain, dict)},
    }


def _legacy_take_chain(take: Dict[str, Any]) -> None:
    """Gives a take from before the voice chain its old Pitch and Reverb as its own chain
    when either was set. A take that already has a chain, or had neither, is left as it is."""
    if take.get("chain") is not None:
        return
    try:
        pitch = float(take.get("pitch_semitones") or 0.0)
        reverb = float(take.get("reverb_wet") or 0.0)
    except (TypeError, ValueError):
        return
    if pitch != 0.0 or reverb > 0.02:
        take["chain"] = vocal_chain.chain_from_legacy(pitch, reverb)


def _migrate_legacy_sound(room: Room) -> None:
    """A room saved without "voice" keeps its sound (documentation/design/effects-rack.md,
    "Existing data"): only "chain" is added to takes; nothing is changed or removed."""
    for entry in room.takes.values():
        for take in (entry.get("takes") or []) if isinstance(entry, dict) else []:
            if isinstance(take, dict):
                _legacy_take_chain(take)


def _migrate_v1_takes(room: Room, raw_takes: Dict[str, Any]) -> None:
    """Moves a version 1 room (one take per line index, take_line_<i>*.wav in the room folder)
    to takes by line ID: each take becomes take1 of the line now at its index. A take for an
    index outside the current pack keeps its files where they are.

    Each take moves all or nothing. One whose files can't be moved (held open by another
    program) keeps its old files and goes to room.pending_v1_takes, which is saved with the
    room and retried on the next start; the rest of the room loads and works meanwhile. If
    the line got new takes in the meantime, the old take is added after them and the pick is
    left alone. Safe to rerun after a crash: files already moved are found in their new place."""
    lines = room.pack.lines
    now_ms = int(time.time() * 1000)
    pending: Dict[str, Any] = {}
    for key, old in raw_takes.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            print(f"[DubMate] Room {room.room_id}: skipped a take with an unreadable line number {key!r}.")
            continue
        if not 0 <= index < len(lines) or not isinstance(old, dict):
            print(f"[DubMate] Room {room.room_id}: take for line {index + 1} is not in this scene; its files stay in the room folder.")
            continue
        line_id = lines[index]["line_id"]
        if room.find_take(line_id, "take1"):
            continue  # already migrated
        try:
            moved = audio_processor.migrate_legacy_take_files(
                room.room_id, index, line_id, "take1", bool(old.get("noise_reduction", False))
            )
        except Exception as ex:
            print(f"[DubMate] Room {room.room_id}: could not move the take for line {index + 1} to the new "
                  f"layout ({type(ex).__name__}: {ex}). Its files are unchanged and it will be retried on the "
                  f"next start; until then the line plays without it.")
            pending[key] = old
            continue
        if not moved["has_audio"]:
            print(f"[DubMate] Room {room.room_id}: take for line {index + 1} has no audio on disk; dropped.")
            continue
        take = {k: v for k, v in old.items() if k not in ("wav_path", "url")}
        take.update(
            take_id="take1", audio_version=now_ms,
            has_raw=moved["has_raw"], noise_reduction=moved["noise_reduction"],
        )
        _legacy_take_chain(take)
        entry = room.takes.get(line_id)
        if entry is None:
            take["number"] = 1
            room.takes[line_id] = {"picked": "take1", "next_number": 2, "takes": [take]}
        else:
            take["number"] = entry["next_number"]
            entry["next_number"] += 1
            entry["takes"].append(take)
    room.pending_v1_takes = pending
