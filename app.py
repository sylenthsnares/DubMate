# -*- coding: utf-8 -*-
"""
app.py
FastAPI + WebSocket backend server for DubMate Multiplayer Studio.
"""

import os
import re
import json
import time
import uuid
import random
import shutil
import asyncio
from typing import Dict, List, Optional, Set, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import pack_loader
import audio_processor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
EXPORTS_DIR = os.path.join(pack_loader.CACHE_DIR, "exports")
os.makedirs(EXPORTS_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

# In-memory pack cache & room manager
PACKS_CACHE: Dict[str, pack_loader.PackInfo] = {}


def generate_room_code() -> str:
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(letters) for _ in range(6))


class Room:
    def __init__(self, room_id: str, pack: pack_loader.PackInfo, host_id: str, host_name: str, host_color: str):
        self.room_id = room_id
        self.pack = pack
        self.pack_id = pack.pack_id
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
        self.current_line: int = 0
        self.mode: str = "booth"  # "booth" (solo self-paced) or "studio" (synced prompter)
        self.status: str = "lobby"  # "lobby" | "recording" | "screening"
        self.exported_video_path: Optional[str] = None
        self.sockets: Set[WebSocket] = set()

    def save_to_disk(self):
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
                "current_line": self.current_line,
                "mode": self.mode,
                "status": self.status,
                "exported_video_path": self.exported_video_path,
            }
            with open(state_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
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
                    "url": v.get("url"),
                    "recorded_at": v.get("recorded_at"),
                }
                for k, v in self.takes.items()
            },
            "current_line": self.current_line,
            "mode": self.mode,
            "status": self.status,
            "has_export": has_export,
            "export_video_url": f"/api/rooms/{self.room_id}/export/video?aspect_ratio=16:9" if has_export else None,
            "download_url": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9" if has_export else None,
            "download_url_16_9": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{self.room_id}/export/download?aspect_ratio=9:16",
        }

    async def broadcast(self, message_type: str, payload: Any = None):
        self.save_to_disk()
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


def prune_sessions(keep_room_id: Optional[str] = None):
    """
    Strict Single-Session Retention Policy:
    Ensures only the latest / active session is kept on disk and in memory.
    Purges all older room folders, old takes, and outdated export videos to keep the server ultra-light.
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

    # Delete all other room directories
    for r_id, full_path, _ in room_folders:
        if retained_id and r_id.upper() == retained_id:
            continue
        try:
            shutil.rmtree(full_path, ignore_errors=True)
            print(f"[DubMate Cache Pruner] Purged older session: {r_id}")
        except Exception as ex:
            print(f"[DubMate Cache Pruner] Could not delete {r_id}: {ex}")

    # Prune in-memory ROOMS
    to_delete = [r for r in list(ROOMS.keys()) if not retained_id or r.upper() != retained_id]
    for r in to_delete:
        ROOMS.pop(r, None)

    # Prune old exports in EXPORTS_DIR
    if os.path.isdir(EXPORTS_DIR):
        for fname in os.listdir(EXPORTS_DIR):
            if fname.endswith(".mp4"):
                if retained_id and retained_id in fname.upper():
                    continue
                try:
                    os.remove(os.path.join(EXPORTS_DIR, fname))
                    print(f"[DubMate Cache Pruner] Removed old export: {fname}")
                except Exception:
                    pass


def load_persisted_rooms():
    prune_sessions()
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
                pack = PACKS_CACHE.get(pack_id)
                if pack:
                    host_id = data.get("host_id", "host")
                    users = data.get("users", {})
                    host_user = users.get(host_id, {})
                    host_name = host_user.get("name", "Host")
                    host_color = host_user.get("color", "#8a6eff")
                    room = Room(r_id, pack, host_id, host_name, host_color)
                    room.users = data.get("users", room.users)
                    room.role_assignments = data.get("role_assignments", room.role_assignments)
                    raw_takes = data.get("takes", {})
                    room.takes = {int(k): v for k, v in raw_takes.items()}
                    room.current_line = data.get("current_line", 0)
                    room.mode = data.get("mode", "booth")
                    room.status = data.get("status", "lobby")
                    room.exported_video_path = data.get("exported_video_path")
                    ROOMS[r_id] = room
                    print(f"[DubMate] Preserved last active session {r_id} with {len(room.takes)} takes from disk.")
            except Exception as ex:
                print(f"[DubMate] Error restoring room {r_id}: {ex}")
        else:
            # Reconstruct room from take files
            try:
                take_files = [f for f in os.listdir(room_folder) if f.startswith("take_line_") and f.endswith(".wav")]
                if take_files and PACKS_CACHE:
                    default_pack = list(PACKS_CACHE.values())[0]
                    room = Room(r_id, default_pack, "host", "Host", "#8a6eff")
                    for tf in take_files:
                        m = re.search(r"take_line_(\d+)\.wav", tf)
                        if m:
                            l_idx = int(m.group(1))
                            wav_p = os.path.join(room_folder, tf)
                            audio_data = audio_processor.read_wav_mono(wav_p)
                            dur = len(audio_data) / float(audio_processor.SR)
                            peaks = audio_processor.compute_waveform_peaks(audio_data, 100)
                            room.takes[l_idx] = {
                                "user_id": "host",
                                "user_name": "Actor",
                                "wav_path": wav_p,
                                "duration": round(dur, 3),
                                "peaks": peaks,
                                "url": f"/api/rooms/{r_id}/takes/{l_idx}/audio",
                                "offset_ms": 0,
                                "pitch_semitones": 0.0,
                                "reverb_wet": 0.0,
                                "gain_db": 0.0,
                                "recorded_at": time.time(),
                            }
                    room.save_to_disk()
                    ROOMS[r_id] = room
                    print(f"[DubMate] Auto-reconstructed last session {r_id} with {len(room.takes)} takes from existing files.")
            except Exception as ex:
                print(f"[DubMate] Error reconstructing room {r_id}: {ex}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global PACKS_CACHE
    PACKS_CACHE = pack_loader.get_all_packs()
    print(f"[DubMate] Loaded {len(PACKS_CACHE)} packs into studio registry.")
    load_persisted_rooms()
    yield


app = FastAPI(title="DubMate Multiplayer Studio", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_performance_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path.lower()
    # Cache static web assets (JS, CSS, fonts, icons) for maximum browser throughput
    if path.endswith((".js", ".css", ".svg", ".png", ".jpg", ".woff", ".woff2", ".ttf", ".ico")):
        if "cache-control" not in response.headers:
            response.headers["Cache-Control"] = "public, max-age=86400, stale-while-revalidate=604800"
    return response


def get_packs_registry() -> Dict[str, pack_loader.PackInfo]:
    global PACKS_CACHE
    PACKS_CACHE = pack_loader.get_all_packs()
    return PACKS_CACHE


@app.get("/api/packs")
async def list_packs(rescan: bool = False):
    """Returns list of available dub packs, rescanning the packs directory."""
    if rescan or not PACKS_CACHE:
        get_packs_registry()
    registry = get_packs_registry()
    return [p.to_dict() for p in registry.values()]


@app.post("/api/packs/rescan")
@app.get("/api/packs/rescan")
async def rescan_packs():
    """Forces an immediate on-demand rescan of the packs directory."""
    registry = get_packs_registry()
    scanned_folders = [os.path.abspath(d) for d in pack_loader.PACKS_DIRS if os.path.exists(d)]
    return {
        "status": "ok",
        "count": len(registry),
        "packs": [p.to_dict() for p in registry.values()],
        "scanned_paths": scanned_folders,
        "message": f"Successfully rescanned {len(registry)} scene packs from {', '.join(scanned_folders)}",
    }


@app.get("/api/packs/{pack_id}")
async def get_pack(pack_id: str):
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    return pack.to_dict()


@app.get("/api/packs/{pack_id}/video")
async def get_pack_video(pack_id: str, request: Request):
    """Streams pack video with HTTP Range support for frame seeking."""
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack or not pack.web_video_path or not os.path.exists(pack.web_video_path):
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(
        pack.web_video_path,
        media_type="video/mp4",
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"}
    )


@app.get("/api/packs/{pack_id}/backing")
async def get_pack_backing(pack_id: str):
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack or not pack.backing_track_path or not os.path.exists(pack.backing_track_path):
        raise HTTPException(status_code=404, detail="Backing track not found")
    return FileResponse(
        pack.backing_track_path,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"}
    )


@app.get("/api/packs/{pack_id}/audio/{filename}")
async def get_pack_audio_line(pack_id: str, filename: str):
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    file_path = os.path.join(pack.folder, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(
        file_path,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"}
    )


@app.post("/api/rooms")
async def create_room(payload: Dict[str, Any]):
    pack_id = payload.get("pack_id")
    host_name = payload.get("host_name", "Host").strip() or "Host"
    host_color = payload.get("host_color", "#7c5cff")

    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Selected pack not found")

    room_id = generate_room_code()
    # Prune any previous session recordings from disk and RAM so only the new session is kept
    prune_sessions(keep_room_id=room_id)

    host_id = str(uuid.uuid4())[:8]
    room = Room(room_id, pack, host_id, host_name, host_color)
    ROOMS[room_id] = room

    return {
        "room_id": room_id,
        "user_id": host_id,
        "state": room.to_state_dict(),
    }


@app.post("/api/admin/clean")
@app.get("/api/admin/clean")
async def clean_server_cache(keep_last: bool = True):
    """Prunes old room caches and exports to keep the server ultra-light."""
    last_room = list(ROOMS.keys())[-1] if (keep_last and ROOMS) else None
    prune_sessions(keep_room_id=last_room)
    return {
        "status": "ok",
        "retained_room": last_room,
        "active_rooms": list(ROOMS.keys()),
        "message": "Server cache pruned to only keep the last recorded session."
    }


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room.to_state_dict()


@app.post("/api/rooms/{room_id}/takes/{line_index}")
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
):
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if line_index < 0 or line_index >= len(room.pack.lines):
        raise HTTPException(status_code=400, detail="Invalid line index")

    line = room.pack.lines[line_index]
    char_name = line.get("character")
    assigned_users = room.role_assignments.get(char_name, [])
    is_host = (user_id == room.host_id) or (room.host_id == "host")
    if assigned_users and user_id not in assigned_users and not is_host:
        raise HTTPException(
            status_code=403,
            detail=f"Line {line_index + 1} is assigned to {char_name}. Only assigned actors can record this line."
        )

    try:
        content = await file.read()
        saved = audio_processor.save_uploaded_take(
            room.room_id,
            line_index,
            content,
            filename_hint=file.filename or "take.webm"
        )
    except Exception as ex:
        print(f"[UploadError] Error saving take for room {room_id} line {line_index}: {ex}")
        raise HTTPException(status_code=400, detail=str(ex))

    timestamp_ms = int(time.time() * 1000)
    versioned_url = f"/api/rooms/{room_id}/takes/{line_index}/audio?v={timestamp_ms}"
    room.takes[line_index] = {
        "user_id": user_id,
        "user_name": user_name,
        "wav_path": saved["wav_path"],
        "duration": saved["duration"],
        "peaks": saved["peaks"],
        "url": versioned_url,
        "offset_ms": offset_ms,
        "pitch_semitones": pitch_semitones,
        "reverb_wet": reverb_wet,
        "gain_db": gain_db,
        "recorded_at": time.time(),
    }

    room.exported_video_path = None
    await room.broadcast("take_recorded", {"line_index": line_index, "url": versioned_url})
    return {"status": "ok", "take": room.takes[line_index]}


@app.get("/api/rooms/{room_id}/takes/{line_index}/audio")
async def get_take_audio(room_id: str, line_index: int):
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    take = room.takes.get(line_index)
    if not take or not os.path.exists(take.get("wav_path", "")):
        raise HTTPException(status_code=404, detail="Take not found")
    return FileResponse(
        take["wav_path"],
        media_type="audio/wav",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )


@app.post("/api/rooms/{room_id}/export")
async def export_room_dub(room_id: str, aspect_ratio: str = "16:9"):
    """Renders the final dubbed scene into MP4 (16:9 cinema or 9:16 shorts)."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    is_9_16 = (aspect_ratio == "9:16")
    suffix = "_9_16" if is_9_16 else ""
    out_filename = f"Dub_{room.pack.pack_id}_{room.room_id}{suffix}.mp4"
    out_path = os.path.join(EXPORTS_DIR, out_filename)

    try:
        audio_processor.export_dub_video(room.pack, room.takes, out_path, aspect_ratio="9:16" if is_9_16 else "16:9")
        if is_9_16:
            room.exported_video_9_16_path = out_path
        else:
            room.exported_video_path = out_path

        file_size_mb = round(os.path.getsize(out_path) / (1024 * 1024), 2) if os.path.exists(out_path) else 0.0
        duration = round(room.pack.duration, 1)
        timestamp_ms = int(time.time() * 1000)
        export_video_url = f"/api/rooms/{room.room_id}/export/video?aspect_ratio={aspect_ratio}&v={timestamp_ms}"
        download_url = f"/api/rooms/{room.room_id}/export/download?aspect_ratio={aspect_ratio}"

        await room.broadcast("export_ready", {
            "download_url": download_url,
            "export_video_url": export_video_url,
            "download_url_16_9": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=9:16",
            "file_size_mb": file_size_mb,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
        })
        return {
            "status": "ok",
            "download_url": download_url,
            "export_video_url": export_video_url,
            "download_url_16_9": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=9:16",
            "file_size_mb": file_size_mb,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
        }
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Export failed: {str(ex)}")


@app.get("/api/rooms/{room_id}/export/video")
async def get_room_exported_video(room_id: str, aspect_ratio: str = "16:9"):
    """Streams the rendered master MP4 video for in-browser theater preview."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    target_path = getattr(room, "exported_video_9_16_path", None) if aspect_ratio == "9:16" else room.exported_video_path
    if not target_path or not os.path.exists(target_path):
        target_path = room.exported_video_path

    if not target_path or not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="Exported video not found")

    return FileResponse(
        target_path,
        media_type="video/mp4",
        headers={"Cache-Control": "no-cache, must-revalidate"}
    )


@app.get("/api/rooms/{room_id}/export/download")
async def download_room_dub(room_id: str, aspect_ratio: str = "16:9"):
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    is_9_16 = (aspect_ratio == "9:16")
    suffix = "_9_16" if is_9_16 else ""
    out_filename = f"Dub_{room.pack.pack_id}_{room.room_id}{suffix}.mp4"
    out_path = os.path.join(EXPORTS_DIR, out_filename)

    # If requested format not yet rendered, render it on demand
    target_path = getattr(room, "exported_video_9_16_path", None) if is_9_16 else room.exported_video_path
    if not target_path or not os.path.exists(target_path):
        audio_processor.export_dub_video(room.pack, room.takes, out_path, aspect_ratio="9:16" if is_9_16 else "16:9")
        if is_9_16:
            room.exported_video_9_16_path = out_path
        else:
            room.exported_video_path = out_path
        target_path = out_path

    aspect_label = "Shorts_9x16" if is_9_16 else "Cinema_16x9"
    filename = f"Dub_{room.pack.name.replace(' ', '_')}_{room.room_id}_{aspect_label}.mp4"
    return FileResponse(target_path, media_type="video/mp4", filename=filename)


# --- WebSocket Handler ---

@app.websocket("/ws/{room_id}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, user_id: str):
    await websocket.accept()
    room = ROOMS.get(room_id.upper())

    if not room:
        await websocket.send_text(json.dumps({"type": "error", "message": "Room not found"}))
        await websocket.close()
        return

    room.sockets.add(websocket)
    if user_id in room.users:
        room.users[user_id]["is_online"] = True
    await room.broadcast("user_connected", {"user_id": user_id})

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")
            payload = data.get("payload", {})

            if msg_type == "join":
                name = payload.get("name", "Actor").strip() or "Actor"
                color = payload.get("color", "#25d3a4")

                # Auto-promote user to host if previous host is dummy "host" or offline
                active_host = room.users.get(room.host_id)
                if room.host_id == "host" or not active_host or not active_host.get("is_online", False):
                    room.host_id = user_id

                room.users[user_id] = {
                    "id": user_id,
                    "name": name,
                    "color": color,
                    "is_host": (user_id == room.host_id),
                    "is_online": True,
                }
                # Sync is_host flag for all users
                for uid, u in room.users.items():
                    u["is_host"] = (uid == room.host_id)

                await room.broadcast("user_joined", {"user_id": user_id})

            elif msg_type == "claim_host":
                room.host_id = user_id
                for uid, u in room.users.items():
                    u["is_host"] = (uid == room.host_id)
                await room.broadcast("host_changed", {"host_id": user_id})

            elif msg_type == "assign_role":
                character = payload.get("character")
                assigned_user_ids = payload.get("user_ids", [])
                if character in room.role_assignments:
                    room.role_assignments[character] = assigned_user_ids
                    await room.broadcast("role_assigned", {"character": character, "user_ids": assigned_user_ids})

            elif msg_type == "set_mode":
                new_mode = payload.get("mode", "booth")
                if new_mode in ("booth", "studio"):
                    room.mode = new_mode
                    await room.broadcast("mode_changed", {"mode": new_mode})

            elif msg_type == "set_status":
                new_status = payload.get("status", "lobby")
                if new_status in ("lobby", "recording", "screening"):
                    room.status = new_status
                    await room.broadcast("status_changed", {"status": new_status})

            elif msg_type == "set_line":
                line_idx = payload.get("line_index", 0)
                if 0 <= line_idx < len(room.pack.lines):
                    room.current_line = line_idx
                    await room.broadcast("line_changed", {"line_index": line_idx})

            elif msg_type == "update_take_params":
                raw_idx = payload.get("line_index")
                try:
                    line_idx = int(raw_idx)
                except (TypeError, ValueError):
                    line_idx = None
                if line_idx is not None and line_idx in room.takes:
                    for key in ("offset_ms", "pitch_semitones", "reverb_wet", "gain_db"):
                        if key in payload:
                            room.takes[line_idx][key] = payload[key]
                    room.exported_video_path = None
                    await room.broadcast("take_params_updated", {"line_index": line_idx})

            elif msg_type == "clear_take":
                raw_idx = payload.get("line_index")
                try:
                    line_idx = int(raw_idx)
                except (TypeError, ValueError):
                    line_idx = None
                if line_idx is not None and line_idx in room.takes:
                    del room.takes[line_idx]
                    room.exported_video_path = None
                    await room.broadcast("take_cleared", {"line_index": line_idx})

            elif msg_type == "set_user_status":
                if user_id in room.users:
                    if "current_line" in payload:
                        room.users[user_id]["current_line"] = payload["current_line"]
                    if "location" in payload:
                        room.users[user_id]["location"] = payload["location"]
                    if "is_ready" in payload:
                        room.users[user_id]["is_ready"] = payload["is_ready"]
                    await room.broadcast("user_status_updated", {
                        "user_id": user_id,
                        "user": room.users[user_id]
                    })

            elif msg_type == "launch_premiere":
                if user_id == room.host_id:
                    room.status = "screening"
                    for u in room.users.values():
                        u["location"] = "screening"

                    # Auto-master the scene into MP4 for the cast
                    try:
                        out_filename = f"Dub_{room.pack.pack_id}_{room.room_id}.mp4"
                        out_path = os.path.join(EXPORTS_DIR, out_filename)
                        audio_processor.export_dub_video(room.pack, room.takes, out_path)
                        room.exported_video_path = out_path
                        file_size_mb = round(os.path.getsize(out_path) / (1024 * 1024), 2) if os.path.exists(out_path) else 0.0
                        duration = round(room.pack.duration, 1)
                        timestamp_ms = int(time.time() * 1000)
                        export_video_url = f"/api/rooms/{room.room_id}/export/video?v={timestamp_ms}"
                        download_url = f"/api/rooms/{room.room_id}/export/download"
                        await room.broadcast("export_ready", {
                            "download_url": download_url,
                            "export_video_url": export_video_url,
                            "file_size_mb": file_size_mb,
                            "duration": duration,
                        })
                    except Exception as ex:
                        print(f"[PremiereRenderError] {ex}")

                    await room.broadcast("warp_to_screening", {"triggered_by": user_id})

            elif msg_type == "screening_control":
                # Only host can control screening sync
                if user_id == room.host_id:
                    action = payload.get("action")  # 'play', 'pause', 'seek'
                    timestamp = payload.get("timestamp", 0.0)
                    await room.broadcast("screening_sync", {
                        "action": action,
                        "timestamp": timestamp,
                        "triggered_by": user_id
                    })

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        await room.broadcast("user_disconnected", {"user_id": user_id})
    except Exception as ex:
        room.sockets.discard(websocket)


# Mount static assets
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    # High-performance production mode: eliminates file polling over pack assets
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False, access_log=False)
