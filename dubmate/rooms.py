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
import threading
from typing import Dict, List, Optional, Set, Tuple, Any

from fastapi import WebSocket, HTTPException

import pack_loader
import audio_processor
from dubmate import common, identity, packs_cache, vocal_chain


# room_state.json layout. Version 1 (no state_version) kept one take per line index.
# Voice chains ("voice" and take "chain") are additive, so they stay version 2.
STATE_VERSION = 2
# A version 1 room_state.json is copied here, byte for byte, before its first save in the
# new layout, so DubMate 1.1.3 can still open the room. Never overwritten: a later, different
# version 1 state gets a numbered backup beside it (Room._write_v1_backup).
V1_BACKUP_NAME = "room_state.v1-backup.json"
# How much later than a v1 take's recorded_at a pack file may be dated and still count as
# unchanged since the take (file system time resolution and clock rounding).
V1_PACK_MTIME_SLACK_S = 2.0
# Room state sent to the studio (to_state_dict). 3: the booth edits voice chains, so a
# tab from before that stops applying state and asks for a reload (takes.js TAKE_STATE_VERSION).
CLIENT_STATE_VERSION = 3
# The video formats a room exports.
EXPORT_ASPECTS = ("16:9", "9:16")


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
        # The creator voices the character with the most lines.
        first = self.free_character_with_most_lines()
        if first:
            self.role_assignments[first] = [host_id]

        # Takes by stable line ID: {"picked": take_id or None, "next_number": int,
        # "takes": [take, ...] oldest first}. Entries for lines not in the current pack
        # are kept but never shown or mixed.
        self.takes: Dict[str, Dict[str, Any]] = {}
        # Version 1 takes (keyed by line index, files in the old layout) whose files could
        # not be copied yet. Saved as they are and retried on the next start.
        self.pending_v1_takes: Dict[str, Any] = {}
        # Version 1 takes that can't be matched to a line for sure (the pack changed after
        # they were recorded): {old line index: old entry}. Their files stay where they are.
        # Saved in room_state.json, never sent to the studio.
        self.unplaced_v1_takes: Dict[str, Any] = {}
        # The version 1 room_state.json as read, until its backup is written. While set,
        # nothing is saved without the backup (_sync_save_to_disk).
        self.v1_state_bytes: Optional[bytes] = None
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
        # The premiere's Mix slider: 0 = more music, 50 = even, 100 = more voice.
        self.master_mix_balance: float = 50.0
        self.export_status: Dict[str, str] = {}
        # The running video render per aspect (rooms_api.start_export_render), kept here so it
        # outlives the request or socket that started it. export_generation goes up whenever
        # the takes or the mix change; a render that ends on an older generation starts over.
        self.export_tasks: Dict[str, asyncio.Task] = {}
        # What a running render is doing ("mix", then "video"), for the export modal's steps.
        self.export_steps: Dict[str, str] = {}
        self.export_generation: int = 0
        self._invalidated_task: Optional[asyncio.Task] = None
        self._invalidated_queued: bool = False
        self.sockets: Set[WebSocket] = set()
        self._save_dirty: bool = False
        self._save_task: Optional[asyncio.Task] = None
        # Take processing runs in a worker thread; this keeps one room's uploads and
        # noise-reduction toggles serialized without blocking other rooms.
        self.processing_lock = asyncio.Lock()
        # Refresh older takes (not saved): user id -> takes still to re-clean, and the
        # running background task. Renders are refused while anyone's refresh runs.
        self.cleanup_refreshing: Dict[str, int] = {}
        self.cleanup_refresh_task: Optional[asyncio.Task] = None
        # Session details, saved with the room. last_active_at is the last change time;
        # creator_id is the host_id the room was made with (host promotion never changes
        # it); created_here says the room was made on the engine's own computer.
        self.last_active_at: float = time.time()
        self.creator_id: str = host_id
        self.created_here: bool = True
        # Set (under _save_lock) when the room's folder is deleted, so no later save,
        # queued or mid-thread, can bring the folder back.
        self.deleted: bool = False
        self._save_lock = threading.Lock()

    def line_counts(self) -> Dict[str, int]:
        """Lines per character in the pack."""
        counts: Dict[str, int] = {}
        for line in self.pack.lines:
            char = line.get("character")
            counts[char] = counts.get(char, 0) + 1
        return counts

    def free_character_with_most_lines(self) -> Optional[str]:
        """The character nobody voices yet with the most lines (ties: pack order), or
        None when every character with lines is taken."""
        counts = self.line_counts()
        free = [c for c in self.pack.characters
                if c in self.role_assignments and not self.role_assignments[c] and counts.get(c, 0) > 0]
        return max(free, key=lambda c: counts.get(c, 0)) if free else None

    def cast_evenly(self) -> None:
        """Deals every character, most lines first, to the person online with the fewest
        lines so far (ties: the host first, then join order)."""
        online = [uid for uid, u in self.users.items() if isinstance(u, dict) and u.get("is_online")]
        if not online:
            return
        people = sorted(online, key=lambda uid: uid != self.host_id)
        counts = self.line_counts()
        load = {uid: 0 for uid in people}
        for char in sorted(self.role_assignments, key=lambda c: -counts.get(c, 0)):
            uid = min(people, key=lambda u: load[u])
            self.role_assignments[char] = [uid]
            load[uid] += counts.get(char, 0)

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
        start writing the same output file underneath it; the generation bump makes it
        render again once its pass ends. When a finished video or a running render was
        dropped, the clients are told (export_invalidated), on the running loop since this
        stays sync; with no loop running there is no one to tell.
        """
        dropped = any(self.ready_export_path(aspect) or self.export_status.get(aspect) == "processing"
                      for aspect in EXPORT_ASPECTS)
        self.export_generation += 1
        self.exported_video_path = None
        self.exported_video_9_16_path = None
        self.export_status = {k: v for k, v in self.export_status.items() if v == "processing"}
        if dropped:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            # A slider drag invalidates on every step; a message that hasn't read the state
            # yet says it for all of them.
            if not self._invalidated_queued:
                self._invalidated_queued = True
                self._invalidated_task = loop.create_task(self._send_invalidated())

    async def _send_invalidated(self):
        # Cleared before broadcast reads the state, so a later drop sends its own message.
        self._invalidated_queued = False
        await self.broadcast("export_invalidated", {})

    def cancel_export_renders(self) -> List[asyncio.Task]:
        """Cancels the running video renders of a room being removed; returns them. Safe from
        a worker thread too (prune_sessions runs in one)."""
        tasks = [t for t in self.export_tasks.values() if not t.done()]
        for task in tasks:
            try:
                task.get_loop().call_soon_threadsafe(task.cancel)
            except RuntimeError:   # its loop is closed; nothing left to stop
                pass
        return tasks

    def export_state(self, aspect_ratio: str) -> str:
        """"ready", "processing", "failed" or "idle": what the studio's Save shows for this aspect."""
        if self.ready_export_path(aspect_ratio):
            return "ready"
        status = self.export_status.get(aspect_ratio, "")
        if status == "processing":
            return "processing"
        return "failed" if status.startswith("failed") else "idle"

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
        self.last_active_at = time.time()
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
        with self._save_lock:
            if self.deleted:
                return
            if self.v1_state_bytes is not None:
                if not self._write_v1_backup():
                    return
                self.v1_state_bytes = None
            self._write_state_file()

    def _write_v1_backup(self) -> bool:
        """Writes the room's version 1 room_state.json to V1_BACKUP_NAME. A backup already
        there is never overwritten: one with other contents (the room went back to 1.1.3 and
        was updated again) gets room_state.v1-backup-2.json beside it, then -3 and so on.
        False (and logged) when it can't, so the caller doesn't save."""
        folder = audio_processor.get_room_cache_dir(self.room_id)
        stem, ext = os.path.splitext(V1_BACKUP_NAME)
        number = 1
        while True:
            backup = os.path.join(folder, V1_BACKUP_NAME if number == 1 else f"{stem}-{number}{ext}")
            if not os.path.exists(backup):
                break
            try:
                with open(backup, "rb") as f:
                    if f.read() == self.v1_state_bytes:
                        return True
            except OSError:
                pass
            number += 1
        tmp = backup + ".tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(self.v1_state_bytes)
            os.replace(tmp, backup)
            return True
        except OSError as ex:
            audio_processor._remove_quietly(tmp)
            print(f"[RoomPersistence] Could not back up room {self.room_id}'s old room_state.json ({ex}). "
                  f"The room isn't saved in the new layout until the backup is written; "
                  f"it's tried again on the next save and the next start.")
            return False

    def _write_state_file(self):
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
                "last_active_at": self.last_active_at,
                "creator_id": self.creator_id,
                "created_here": self.created_here,
                "master_dialogue_presence_db": self.master_dialogue_presence_db,
                "master_mix_balance": self.master_mix_balance,
            }
            if self.pending_v1_takes:
                data["pending_v1_takes"] = self.pending_v1_takes
            if self.unplaced_v1_takes:
                data["unplaced_v1_takes"] = self.unplaced_v1_takes
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
            # Colours from older versions stay stored as they were, but show as their hue.
            "users": {uid: {**u, "color": identity.normalize_color(u.get("color"))} if isinstance(u, dict) else u
                      for uid, u in self.users.items()},
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
            # Whose older takes are being refreshed, so a tab that missed cleanup_refreshed
            # (a dropped socket) still learns the refresh ended.
            "cleanup_refreshing": sorted(self.cleanup_refreshing),
            "master_dialogue_presence_db": self.master_dialogue_presence_db,
            "master_mix_balance": self.master_mix_balance,
            # Each video format's export state, so a reload or a late joiner shows Saving… or Saved.
            "exports": {aspect: self.export_state(aspect) for aspect in EXPORT_ASPECTS},
            "has_export": has_export,
            "export_video_url": f"/api/rooms/{self.room_id}/export/video?aspect_ratio=16:9" if has_export else None,
            "download_url": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9" if has_export else None,
            "download_url_16_9": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=9:16",
            "project_zip_url": f"/api/rooms/{self.room_id}/export/project_zip",
            # What the host's engine lacks that only the 2.0 installer brings, so the studio
            # can say so without asking /health.
            "engine_missing": audio_processor.missing_parts(),
            # False for a source install: it gets them by running update.bat/update.sh again.
            "engine_bundled": audio_processor.bundled_runtime(),
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

# Codes of room folders whose room_state.json load_room_folder could not load for a
# reason other than a missing pack (bad contents, a newer layout). Their summaries are
# unreadable, so the Continue card offers only Remove.
UNLOADABLE_ROOMS: Set[str] = set()


def room_or_404(room_id: str) -> Room:
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


RECENT_SESSIONS_KEEP = 5

# Held by room creation (which prunes), Continue and Remove, so a concurrent create
# can't insert a room that an older prune then removes, and Continue can't load a
# session that Remove is deleting. Built lazily so it binds to the server's loop.
SESSIONS_LOCK: Optional[asyncio.Lock] = None


def sessions_lock() -> asyncio.Lock:
    global SESSIONS_LOCK
    if SESSIONS_LOCK is None:
        SESSIONS_LOCK = asyncio.Lock()
    return SESSIONS_LOCK


def _rooms_dir() -> str:
    return os.path.join(audio_processor.CACHE_DIR, "rooms")


def _count_recorded(pack: Optional[pack_loader.PackInfo], takes: Dict[str, Any], v1_takes: Dict[str, Any]) -> int:
    """Lines of the pack with a picked take. v1 takes are keyed by line index. Without the
    pack, every line entry with a pick counts."""
    picked = {lid for lid, e in takes.items() if isinstance(e, dict) and e.get("picked")}
    if pack is None:
        return len(picked) + len(v1_takes)
    count = 0
    for line in pack.lines:
        if line["line_id"] in picked or str(line["index"]) in v1_takes:
            count += 1
    return count


def _summary_from_room(room: Room) -> Dict[str, Any]:
    has_takes = bool(room.takes or room.pending_v1_takes or room.unplaced_v1_takes)
    return {
        "room_id": room.room_id.upper(),
        "pack_id": room.pack.pack_id,
        "pack_name": room.pack.name,
        "pack_found": True,
        "recorded_lines": _count_recorded(room.pack, room.takes, room.pending_v1_takes),
        "total_lines": len(room.pack.lines),
        "last_active_at": room.last_active_at,
        "status": room.status,
        "readable": True,
        "listed": bool(room.created_here) and has_takes,
    }


def _summary_from_folder(room_id: str, folder: str) -> Dict[str, Any]:
    state_file = os.path.join(folder, "room_state.json")
    summary = {
        "room_id": room_id.upper(), "pack_id": None, "pack_name": None, "pack_found": False,
        "recorded_lines": 0, "total_lines": 0, "last_active_at": 0.0, "status": None,
        "readable": True, "listed": False,
    }
    if not os.path.isfile(state_file):
        try:
            summary["last_active_at"] = os.path.getmtime(folder)
        except OSError:
            pass
        return summary
    try:
        file_mtime = os.path.getmtime(state_file)
        with open(state_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("room_state.json is not an object")
        if room_id.upper() in UNLOADABLE_ROOMS:
            raise ValueError("room_state.json could not be loaded")
    except Exception:
        try:
            summary["last_active_at"] = os.path.getmtime(folder)
        except OSError:
            pass
        summary.update(readable=False, listed=True)
        return summary
    pack_id = data.get("pack_id")
    pack = packs_cache.PACKS_CACHE.get(pack_id) if isinstance(pack_id, str) else None
    raw_takes = data.get("takes") if isinstance(data.get("takes"), dict) else {}
    pending = data.get("pending_v1_takes") if isinstance(data.get("pending_v1_takes"), dict) else {}
    unplaced = data.get("unplaced_v1_takes") if isinstance(data.get("unplaced_v1_takes"), dict) else {}
    if data.get("state_version") == STATE_VERSION:
        takes, v1_takes = raw_takes, pending
    else:
        takes, v1_takes = {}, raw_takes
    last_active = data.get("last_active_at")
    created_here = data.get("created_here")
    summary.update(
        pack_id=pack_id,
        pack_name=pack.name if pack else pack_id,
        pack_found=pack is not None,
        recorded_lines=_count_recorded(pack, takes, v1_takes),
        total_lines=len(pack.lines) if pack else 0,
        last_active_at=float(last_active) if isinstance(last_active, (int, float)) else file_mtime,
        status=data.get("status", "lobby"),
        # Kept-aside takes count too, so pruning never deletes them unseen.
        listed=(created_here if isinstance(created_here, bool) else True) and bool(takes or v1_takes or unplaced),
    )
    return summary


def session_summaries() -> List[Dict[str, Any]]:
    """One summary per folder under <CACHE_DIR>/rooms: {room_id, pack_id, pack_name,
    pack_found, recorded_lines, total_lines, last_active_at, status, readable, listed}.
    Loaded rooms are summarised from memory, other folders from their room_state.json.
    readable is False when the file isn't a JSON object or load_room_folder failed on it.
    listed is True for an unreadable folder (so the user can see and remove it), and
    otherwise for a room made on this computer that has takes."""
    rooms_dir = _rooms_dir()
    if not os.path.isdir(rooms_dir):
        return []
    out = []
    for name in os.listdir(rooms_dir):
        folder = os.path.join(rooms_dir, name)
        if not os.path.isdir(folder):
            continue
        room = ROOMS.get(name.upper())
        out.append(_summary_from_room(room) if room else _summary_from_folder(name, folder))
    return out


def recent_sessions(keep: int = RECENT_SESSIONS_KEEP) -> List[Dict[str, Any]]:
    """The listed sessions, newest first, cut to keep: exactly the rows the card shows
    and the sessions prune_sessions keeps."""
    listed = [s for s in session_summaries() if s["listed"]]
    listed.sort(key=lambda s: s["last_active_at"], reverse=True)
    return listed[:max(0, keep)]


def _forget_room(room_id: str) -> None:
    """Marks a loaded room deleted (so no save can bring its folder back) and drops it
    from ROOMS."""
    room = ROOMS.pop(room_id, None)
    UNLOADABLE_ROOMS.discard(room_id.upper())
    if room is not None and isinstance(room, Room):
        room.cancel_export_renders()
        with room._save_lock:
            room.deleted = True


def prune_sessions(keep_room_id: Optional[str] = None, keep: int = RECENT_SESSIONS_KEEP):
    """
    Keeps the host's recent sessions and deletes the rest, oldest first. Kept:
    - keep_room_id, or when none is given the newest folder by last_active_at;
    - rooms with connected sockets (deleting them broke a live session's takes);
    - the `keep` sessions recent_sessions() returns.
    The last rule uses the same function as the Continue card, so the card shows exactly
    what is kept: a row the user can see is never pruned. Rooms made by guests are
    deleted unless kept by the first two rules.

    The exports folder is never touched. It is the user's folder (often one they
    chose), the host is told a render or project ZIP is "saved" there, and it can
    hold files DubMate didn't write.
    """
    from dubmate import room_registry  # lazy: room_registry imports this module

    rooms_dir = _rooms_dir()
    summaries = session_summaries()
    summaries.sort(key=lambda s: s["last_active_at"])  # oldest first

    if keep_room_id:
        retained = {keep_room_id.upper()}
    elif summaries:
        retained = {summaries[-1]["room_id"]}
    else:
        retained = set()
    retained |= {rid.upper() for rid, rm in ROOMS.items() if getattr(rm, "sockets", None)}
    retained |= {s["room_id"] for s in recent_sessions(keep)}

    names = {name.upper(): name for name in os.listdir(rooms_dir)} if os.path.isdir(rooms_dir) else {}
    deleted = []
    for s in summaries:
        room_id = s["room_id"]
        if room_id in retained:
            continue
        _forget_room(room_id)
        folder = os.path.join(rooms_dir, names.get(room_id, room_id))
        try:
            shutil.rmtree(folder, ignore_errors=True)
            print(f"[DubMate Cache Pruner] Purged older session: {room_id}")
        except Exception as ex:
            print(f"[DubMate Cache Pruner] Could not delete {room_id}: {ex}")
        deleted.append(room_id)

    # Loaded rooms with no folder yet (never saved) follow the same rule.
    for room_id in [r for r in ROOMS if r.upper() not in retained]:
        _forget_room(room_id)
        deleted.append(room_id.upper())

    for room_id in deleted:
        room_registry.WORKER_PENDING_ROOMS.pop(room_id, None)
        room_registry.WORKER_ROOM_STATUS.pop(room_id, None)


def new_room_code() -> str:
    """A room code that is neither loaded nor has a folder on disk, so a new room can
    never mix its takes with a kept session's."""
    rooms_dir = _rooms_dir()
    while True:
        code = generate_room_code()
        if code.upper() not in ROOMS and not os.path.exists(os.path.join(rooms_dir, code)):
            return code


def load_room_folder(room_id: str) -> Optional[Room]:
    """Loads one room folder into ROOMS and returns the room, or None when its pack is
    missing or its room_state.json can't be read. Fields older builds didn't save fall
    back: last_active_at to the state file's time (read before any migration save),
    creator_id to host_id, created_here to True, the presence level to 0. Every user is
    marked offline, since nobody is connected yet. A version 1 room is backed up
    (V1_BACKUP_NAME) before its first save in the new layout."""
    room_folder = os.path.join(audio_processor.CACHE_DIR, "rooms", room_id)
    state_file = os.path.join(room_folder, "room_state.json")
    if not os.path.isfile(state_file):
        return None
    try:
        file_mtime = os.path.getmtime(state_file)
        with open(state_file, "rb") as f:
            state_bytes = f.read()  # read before anything writes: the backup is these bytes
        data = json.loads(state_bytes.decode("utf-8"))
        version = data.get("state_version")
        if version not in (None, 1, STATE_VERSION):
            # A newer DubMate wrote this room. Reading it as an older layout would
            # drop its takes on the next save, so it is left exactly as it is.
            print(f"[DubMate] Room {room_id} was saved by a newer DubMate (layout {version!r}); "
                  f"it is left untouched and not loaded.")
            UNLOADABLE_ROOMS.add(room_id.upper())
            return None
        pack = packs_cache.PACKS_CACHE.get(data.get("pack_id"))
        if not pack:
            return None
        host_id = data.get("host_id", "host")
        users = data.get("users", {})
        host_user = users.get(host_id, {})
        host_name = host_user.get("name", "Host")
        # Stored colours stay as they are (older ones included) until that person joins again.
        room = Room(room_id, pack, host_id, host_name, host_user.get("color", ""))
        room.users = data.get("users", room.users)
        for user in room.users.values():
            if isinstance(user, dict):
                user["is_online"] = False
        room.role_assignments = data.get("role_assignments", room.role_assignments)
        raw_takes = data.get("takes") or {}
        room.status = data.get("status", "lobby")
        room.exported_video_path = data.get("exported_video_path")
        if room.exported_video_path and not os.path.exists(room.exported_video_path):
            # Saved before 2.0 moved the data folder out of the install folder: the dub
            # moved with it, under the same name.
            moved = room.export_out_path("16:9")
            if os.path.isfile(moved):
                room.exported_video_path = moved
        last_active = data.get("last_active_at")
        room.last_active_at = float(last_active) if isinstance(last_active, (int, float)) else file_mtime
        room.creator_id = data.get("creator_id") or host_id
        created_here = data.get("created_here")
        room.created_here = created_here if isinstance(created_here, bool) else True
        try:
            presence = float(data.get("master_dialogue_presence_db") or 0.0)
        except (TypeError, ValueError):
            presence = 0.0
        room.master_dialogue_presence_db = max(-12.0, min(12.0, presence))
        try:
            balance = float(data.get("master_mix_balance", 50.0))
        except (TypeError, ValueError):
            balance = 50.0
        room.master_mix_balance = max(0.0, min(100.0, balance)) if balance == balance else 50.0
        if version == STATE_VERSION:
            room.takes = raw_takes
            v1_takes = data.get("pending_v1_takes") or {}
            unplaced = data.get("unplaced_v1_takes")
            room.unplaced_v1_takes = unplaced if isinstance(unplaced, dict) else {}
        else:
            v1_takes = raw_takes
            room.v1_state_bytes = state_bytes
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
        ROOMS[room_id.upper()] = room
        UNLOADABLE_ROOMS.discard(room_id.upper())
        return room
    except Exception as ex:
        print(f"[DubMate] Error restoring room {room_id}: {ex}")
        UNLOADABLE_ROOMS.add(room_id.upper())
        return None


def load_persisted_rooms():
    prune_sessions()
    rooms_dir = os.path.join(audio_processor.CACHE_DIR, "rooms")
    if not os.path.isdir(rooms_dir):
        return
    for r_id in os.listdir(rooms_dir):
        if not os.path.isdir(os.path.join(rooms_dir, r_id)):
            continue
        room = load_room_folder(r_id)
        if room:
            print(f"[DubMate] Preserved last active session {r_id.upper()} with {len(room.takes)} takes from disk.")


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


def _why_v1_take_kept_aside(pack: pack_loader.PackInfo, index: int, recorded_at: Any) -> Optional[str]:
    """None when a version 1 take recorded at recorded_at for line `index` can go on the line
    now at that index, because the pack can't have changed at or before it since: the line
    files at indexes 0..index and the pack folder itself are all dated no later than
    recorded_at + V1_PACK_MTIME_SLACK_S. Otherwise why not, for the log. An inserted or
    rebuilt line file is newer, and removing one makes the folder newer. Loading a pack
    writes nothing into its folder (peaks and web videos go to the cache) except a missing
    _captions.json or _TIMESTAMPS.txt, which 1.1.3 already wrote when it first loaded the
    pack, before any take. Anything else that adds a file to the folder (Finder's .DS_Store,
    say) also moves its time, and can't be told from a removed line file; then every v1
    take of the room is kept aside too, with its files."""
    if not 0 <= index < len(pack.lines):
        return f"the scene has only {len(pack.lines)} lines now"
    if isinstance(recorded_at, bool) or not isinstance(recorded_at, (int, float)) or recorded_at != recorded_at:
        return "it has no recording time to check the scene against"
    limit = recorded_at + V1_PACK_MTIME_SLACK_S
    try:
        for line in pack.lines[:index + 1]:
            if os.path.getmtime(os.path.join(pack.folder, line["filename"])) > limit:
                return "the scene changed after it was recorded"
        if os.path.getmtime(pack.folder) > limit:
            return "the scene's folder changed after it was recorded (a line may have been removed)"
    except (OSError, KeyError, TypeError):
        return "the scene changed after it was recorded (a line file is missing)"
    return None


def _migrate_v1_takes(room: Room, raw_takes: Dict[str, Any]) -> None:
    """Moves a version 1 room (one take per line index, take_line_<i>*.wav in the room folder)
    to takes by line ID: each take becomes take1 of the line now at its index, its files
    copied to takes/<line_id>/. The take_line_* originals are kept, for DubMate 1.1.3.

    v1 state names a line only by its index, so a take is placed only when the pack provably
    didn't change since it was recorded (_why_v1_take_kept_aside). Otherwise, and for an index
    outside the current pack, the take goes to room.unplaced_v1_takes with its files
    untouched: never onto a line it might not belong to.

    Each take is copied all or nothing. One whose files can't be copied (held open by another
    program) goes to room.pending_v1_takes, which is saved with the room and retried on the
    next start; the rest of the room loads and works meanwhile. If the line got new takes in
    the meantime, the old take is added after them and the pick is left alone. Safe to rerun
    after a crash: copies already made are found in their new place."""
    lines = room.pack.lines
    now_ms = int(time.time() * 1000)
    pending: Dict[str, Any] = {}
    for key, old in raw_takes.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            print(f"[DubMate] Room {room.room_id}: skipped a take with an unreadable line number {key!r}.")
            continue
        if not isinstance(old, dict):
            print(f"[DubMate] Room {room.room_id}: skipped an unreadable take for line {index + 1}.")
            continue
        why = _why_v1_take_kept_aside(room.pack, index, old.get("recorded_at"))
        if why:
            print(f"[DubMate] Room {room.room_id}: take for old line {index + 1} kept aside: {why}. "
                  f"Its files stay in the room folder as take_line_{index}*.wav.")
            room.unplaced_v1_takes[str(key)] = old
            continue
        line_id = lines[index]["line_id"]
        if room.find_take(line_id, "take1"):
            continue  # already migrated
        try:
            moved = audio_processor.migrate_legacy_take_files(
                room.room_id, index, line_id, "take1", bool(old.get("noise_reduction", False))
            )
        except Exception as ex:
            print(f"[DubMate] Room {room.room_id}: could not copy the take for line {index + 1} to the new "
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
