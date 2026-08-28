# -*- coding: utf-8 -*-
"""
app.py
FastAPI + WebSocket backend server for DubMate Multiplayer Studio.
"""

import os
import re
import sys
import json
import time
import uuid
import random
import shutil
import asyncio
import threading
import urllib.parse
from typing import Dict, List, Optional, Set, Any
from contextlib import asynccontextmanager

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import pack_loader
import audio_processor
import pack_builder

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
EXPORTS_DIR = os.path.join(pack_loader.CACHE_DIR, "exports")
try:
    os.makedirs(EXPORTS_DIR, exist_ok=True)
except Exception:
    pass

try:
    os.makedirs(STATIC_DIR, exist_ok=True)
except Exception:
    pass

# In-memory pack cache & room manager
PACKS_CACHE: Dict[str, pack_loader.PackInfo] = {}


def read_version() -> str:
    version_path = os.path.join(BASE_DIR, "VERSION")
    try:
        with open(version_path, "r", encoding="utf-8") as f:
            return f.read().strip().lstrip("\ufeff")
    except Exception:
        return "1.0.0"


def is_version_outdated(client_v: str, req_v: str) -> bool:
    """Returns True if client_v is strictly older than req_v."""
    try:
        def parse_v(v_str: str) -> List[int]:
            clean = str(v_str).strip().lstrip("v")
            parts = [int(re.sub(r"[^\d]", "", p)) for p in clean.split(".") if re.search(r"\d", p)]
            while len(parts) < 3:
                parts.append(0)
            return parts[:3]
        return parse_v(client_v) < parse_v(req_v)
    except Exception:
        return False


def generate_room_code() -> str:
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(letters) for _ in range(6))


class Room:
    def __init__(self, room_id: str, pack: pack_loader.PackInfo, host_id: str, host_name: str, host_color: str, min_required_version: str = "1.0.0"):
        self.room_id = room_id
        self.pack = pack
        self.pack_id = pack.pack_id
        self.host_id = host_id
        self.min_required_version = min_required_version or "1.0.0"
        self.pending_transfer_to: Optional[str] = None
        self._transfer_timeout_task: Optional[asyncio.Task] = None
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
        self.exported_video_9_16_path: Optional[str] = None
        self.master_dialogue_presence_db: float = 0.0
        self.export_status: Dict[str, str] = {}
        self.sockets: Set[WebSocket] = set()
        self._save_dirty: bool = False
        self._save_task: Optional[asyncio.Task] = None

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
                "current_line": self.current_line,
                "mode": self.mode,
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

    def save_to_disk(self):
        self._sync_save_to_disk()

    def to_state_dict(self) -> Dict[str, Any]:
        has_export_16_9 = self.exported_video_path is not None and os.path.exists(self.exported_video_path)
        has_export = has_export_16_9
        return {
            "room_id": self.room_id,
            "min_required_version": self.min_required_version,
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
            "current_line": self.current_line,
            "mode": self.mode,
            "status": self.status,
            "master_dialogue_presence_db": getattr(self, "master_dialogue_presence_db", 0.0),
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
            if fname.endswith((".mp4", ".zip")):
                if retained_id and retained_id in fname.upper():
                    continue
                try:
                    os.remove(os.path.join(EXPORTS_DIR, fname))
                    print(f"[DubMate Cache Pruner] Removed old export/zip: {fname}")
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
                    ROOMS[r_id.upper()] = room
                    print(f"[DubMate] Preserved last active session {r_id.upper()} with {len(room.takes)} takes from disk.")
            except Exception as ex:
                print(f"[DubMate] Error restoring room {r_id}: {ex}")
        else:
            # Reconstruct room from take files
            try:
                take_files = [f for f in os.listdir(room_folder) if f.startswith("take_line_") and f.endswith(".wav")]
                if take_files and PACKS_CACHE:
                    default_pack = list(PACKS_CACHE.values())[0]
                    room = Room(r_id.upper(), default_pack, "host", "Host", "#8a6eff")
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
                                "url": f"/api/rooms/{r_id.upper()}/takes/{l_idx}/audio",
                                "offset_ms": 0,
                                "pitch_semitones": 0.0,
                                "reverb_wet": 0.0,
                                "gain_db": 0.0,
                                "recorded_at": time.time(),
                            }
                    room.save_to_disk()
                    ROOMS[r_id.upper()] = room
                    print(f"[DubMate] Auto-reconstructed last session {r_id.upper()} with {len(room.takes)} takes from existing files.")
            except Exception as ex:
                print(f"[DubMate] Error reconstructing room {r_id}: {ex}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global PACKS_CACHE
    try:
        pack_loader.preflight_probe_hardware_encoder()
    except Exception as ex:
        print(f"[DubMate Acceleration] Startup probe warning: {ex}")
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
    # Only set default fallback cache headers if the route handler did not explicitly set Cache-Control
    if "cache-control" not in response.headers:
        if path.endswith((".html", ".js", ".css")) or path == "/" or path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        elif path.endswith((".svg", ".png", ".jpg", ".woff", ".woff2", ".ttf", ".ico", ".mp4", ".wav", ".mp3", ".ogg")):
            response.headers["Cache-Control"] = "public, max-age=86400, stale-while-revalidate=604800"
    return response


@app.get("/health")
async def health_check():
    """Liveness probe used by the desktop app launcher and orchestrators."""
    return {
        "status": "ok",
        "version": read_version(),
        "timestamp": int(time.time()),
    }


@app.get("/api/system/encoder")
async def get_system_encoder():
    """Returns detected video encoding hardware acceleration metadata."""
    info = pack_loader.get_hardware_encoder_info()
    return {
        "status": "ok",
        **info
    }


def get_packs_registry(force_rescan: bool = False) -> Dict[str, pack_loader.PackInfo]:
    global PACKS_CACHE
    if force_rescan or not PACKS_CACHE:
        PACKS_CACHE = pack_loader.get_all_packs(force_disk_scan=force_rescan)
    return PACKS_CACHE


@app.get("/api/config")
async def get_config():
    """Returns the current persistent configuration and pack paths."""
    config_info = pack_loader.get_current_packs_config()
    registry = get_packs_registry()
    return {
        "status": "ok",
        **config_info,
        "packs": [p.to_dict() for p in registry.values()],
    }


@app.post("/api/config")
async def update_config(payload: Dict[str, Any]):
    """Updates and persists the scene packs folder path, immediately rescanning the folder."""
    global PACKS_CACHE
    packs_dir = payload.get("packs_dir", "")
    if not packs_dir:
        raise HTTPException(status_code=400, detail="packs_dir is required")

    success, message, count = pack_loader.set_custom_packs_dir(packs_dir)
    if not success:
        raise HTTPException(status_code=400, detail=message)

    PACKS_CACHE = pack_loader.get_all_packs(force_disk_scan=True)
    config_info = pack_loader.get_current_packs_config()

    return {
        "status": "ok",
        "message": message,
        "pack_count": count,
        **config_info,
        "packs": [p.to_dict() for p in PACKS_CACHE.values()],
    }


@app.get("/api/packs")
async def list_packs(rescan: bool = False):
    """Returns list of available dub packs, using fast memory registry or on-demand rescan."""
    registry = get_packs_registry(force_rescan=rescan)
    return [p.to_dict() for p in registry.values()]


@app.post("/api/packs/rescan")
@app.get("/api/packs/rescan")
async def rescan_packs():
    """Forces an immediate on-demand rescan of the packs directory."""
    registry = get_packs_registry(force_rescan=True)
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


@app.post("/api/packs/import")
async def import_pack_files(
    file: Optional[UploadFile] = File(None),
    files: Optional[List[UploadFile]] = File(None),
    paths: Optional[str] = Form(None)
):
    """
    Accepts single or batch pack imports:
    1. Single or multiple .zip archives (GameBanana / Pack Builder).
    2. Entire folder trees with relative paths (from folder drag-and-drop or webkitdirectory input).
    Validates signatures, sandboxes, and indexes all discovered packs.
    """
    uploaded_files: List[UploadFile] = []
    if files:
        uploaded_files.extend(files)
    if file:
        uploaded_files.append(file)

    if not uploaded_files:
        raise HTTPException(status_code=400, detail="No files uploaded for pack import.")

    # 1. Check if folder tree with relative paths was provided
    if paths:
        try:
            rel_paths = json.loads(paths)
        except Exception:
            rel_paths = [f.filename for f in uploaded_files]

        if len(rel_paths) != len(uploaded_files):
            rel_paths = [f.filename for f in uploaded_files]

        file_tuples = []
        for uf, r_path in zip(uploaded_files, rel_paths):
            content = await uf.read()
            file_tuples.append((content, r_path or uf.filename or "unknown"))

        result = pack_loader.import_pack_folder_tree(file_tuples)
        get_packs_registry(force_rescan=True)
        return result

    # 2. Check if all uploaded files are .zip archives
    all_zip = all(f.filename and f.filename.lower().endswith(".zip") for f in uploaded_files)
    if not all_zip and len(uploaded_files) > 1:
        # Multiple loose files without explicit paths
        file_tuples = []
        for uf in uploaded_files:
            content = await uf.read()
            file_tuples.append((content, uf.filename or "unknown"))
        result = pack_loader.import_pack_folder_tree(file_tuples)
        get_packs_registry(force_rescan=True)
        return result

    # 3. Batch or single .zip import
    if len(uploaded_files) == 1 and uploaded_files[0].filename and uploaded_files[0].filename.lower().endswith(".zip"):
        single_file = uploaded_files[0]
        try:
            content = await single_file.read()
            if len(content) > pack_loader.MAX_ARCHIVE_SIZE_BYTES:
                raise HTTPException(status_code=413, detail="Archive exceeds maximum allowed size (500 MB).")

            pack = pack_loader.import_pack_archive(content, single_file.filename)
            if not pack:
                raise HTTPException(status_code=422, detail="Could not parse a valid scene dub pack from the uploaded archive.")

            get_packs_registry(force_rescan=True)
            return {
                "status": "ok",
                "message": f"Successfully verified and imported pack '{pack.name}'",
                "pack": pack.to_dict(),
                "packs": [pack.to_dict()],
                "imported_count": 1,
                "failed_count": 0,
            }
        except pack_loader.PackSecurityError as sec_err:
            print(f"[Security Alert] Pack import rejected: {sec_err}")
            raise HTTPException(status_code=422, detail=f"{str(sec_err)}")
        except pack_loader.PackValidationError as val_err:
            print(f"[Validation Error] Pack import rejected: {val_err}")
            raise HTTPException(status_code=400, detail=f"{str(val_err)}")
        except HTTPException:
            raise
        except Exception as ex:
            print(f"[app] Error importing pack: {ex}")
            raise HTTPException(status_code=500, detail=f"Import failed: {str(ex)}")

    # Multi-zip batch upload
    archive_tuples = []
    for uf in uploaded_files:
        if uf.filename and uf.filename.lower().endswith(".zip"):
            content = await uf.read()
            archive_tuples.append((content, uf.filename))

    if not archive_tuples:
        raise HTTPException(status_code=400, detail="No valid .zip archives found in upload.")

    result = pack_loader.import_multiple_pack_archives(archive_tuples)
    get_packs_registry(force_rescan=True)
    return result


@app.get("/api/packs/{pack_id}/icon")
async def get_pack_icon(pack_id: str):
    """Serves pack cover art / icon."""
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack or not pack.icon_path or not os.path.exists(pack.icon_path):
        raise HTTPException(status_code=404, detail="Icon not found")
    
    ext = os.path.splitext(pack.icon_path)[1].lower()
    media_type = "image/png" if ext == ".png" else "image/jpeg" if ext in (".jpg", ".jpeg") else "image/webp"
    return FileResponse(
        pack.icon_path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"}
    )


def range_stream_file(
    file_path: str,
    request: Request,
    media_type: str,
    cache_control: str = "public, max-age=86400, stale-while-revalidate=604800"
) -> Any:
    """
    Streams a media file supporting HTTP 206 Partial Content for byte-range seeking.
    Ensures seamless frame seeking on Cloudflare tunnels, Safari, and Chrome HTML5 video.
    """
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    file_size = os.path.getsize(file_path)
    range_header = request.headers.get("range", "").strip()

    base_headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Cache-Control": cache_control,
    }

    if not range_header or not range_header.startswith("bytes="):
        def full_generator():
            with open(file_path, "rb") as f:
                while chunk := f.read(256 * 1024):
                    yield chunk

        headers = {
            **base_headers,
            "Content-Length": str(file_size),
        }
        return StreamingResponse(full_generator(), status_code=200, media_type=media_type, headers=headers)

    range_spec = range_header.replace("bytes=", "").split("-")
    try:
        start = int(range_spec[0]) if range_spec[0] else 0
        end = int(range_spec[1]) if len(range_spec) > 1 and range_spec[1] else file_size - 1
    except ValueError:
        start = 0
        end = file_size - 1

    start = max(0, min(start, file_size - 1))
    end = max(start, min(end, file_size - 1))
    content_length = end - start + 1

    def range_generator(start_pos: int, bytes_to_read: int):
        with open(file_path, "rb") as f:
            f.seek(start_pos)
            remaining = bytes_to_read
            while remaining > 0:
                chunk_size = min(256 * 1024, remaining)
                data = f.read(chunk_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    }
    return StreamingResponse(
        range_generator(start, content_length),
        status_code=206,
        media_type=media_type,
        headers=headers
    )


@app.get("/api/packs/{pack_id}/video")
async def get_pack_video(pack_id: str, request: Request):
    """Streams pack video with full HTTP 206 Range support for frame seeking."""
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack or not pack.web_video_path or not os.path.exists(pack.web_video_path):
        raise HTTPException(status_code=404, detail="Video not found")
    return range_stream_file(
        pack.web_video_path,
        request,
        media_type="video/mp4",
        cache_control="public, max-age=86400, stale-while-revalidate=604800"
    )


@app.get("/api/packs/{pack_id}/backing")
async def get_pack_backing(pack_id: str, request: Request):
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack or not pack.backing_track_path or not os.path.exists(pack.backing_track_path):
        raise HTTPException(status_code=404, detail="Backing track not found")
    ext = os.path.splitext(pack.backing_track_path)[1].lower()
    media_type = "audio/mpeg" if ext == ".mp3" else "audio/wav" if ext == ".wav" else "audio/ogg"
    return range_stream_file(
        pack.backing_track_path,
        request,
        media_type=media_type,
        cache_control="public, max-age=86400, stale-while-revalidate=604800"
    )


@app.get("/api/packs/{pack_id}/audio/{filename}")
async def get_pack_audio_line(pack_id: str, filename: str, request: Request):
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")
    file_path = os.path.join(pack.folder, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    ext = os.path.splitext(filename)[1].lower()
    media_type = "audio/mpeg" if ext == ".mp3" else "audio/wav" if ext == ".wav" else "audio/ogg"
    return range_stream_file(
        file_path,
        request,
        media_type=media_type,
        cache_control="public, max-age=86400, stale-while-revalidate=604800"
    )


@app.get("/api/packs/{pack_id}/export")
async def export_pack_zip(pack_id: str):
    """Packages and streams a scene pack as a downloadable .zip archive."""
    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    pack_folder = pack.folder if pack else None

    if not pack_folder or not os.path.isdir(pack_folder):
        for base in pack_loader.PACKS_DIRS:
            candidate = os.path.join(base, pack_id)
            if os.path.isdir(candidate):
                pack_folder = candidate
                break

    if not pack_folder or not os.path.isdir(pack_folder):
        raise HTTPException(status_code=404, detail="Pack not found")

    try:
        clean_name = re.sub(r'[^A-Za-z0-9 _\-]+', '', pack.name if pack else pack_id).strip() or "scene_pack"
        zip_filename = f"{clean_name}.zip"
        zip_dir = os.path.join(EXPORTS_DIR, "packs")
        os.makedirs(zip_dir, exist_ok=True)
        zip_path = os.path.join(zip_dir, f"DubMate_Pack_{clean_name}_{pack_id}.zip")

        pack_loader.export_pack_archive(pack_folder, output_zip_path=zip_path)

        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=zip_filename,
            headers={
                "Content-Disposition": f'attachment; filename="{zip_filename}"',
                "Cache-Control": "no-cache",
            }
        )
    except Exception as ex:
        print(f"[PackExportError] Error generating pack ZIP for {pack_id}: {ex}")
        raise HTTPException(status_code=500, detail=f"Failed to export pack ZIP: {str(ex)}")


ACTIVE_TUNNEL_URL: Optional[str] = None


async def register_room_with_worker(room_id: str, tunnel_url: str, app_version: str):
    """Registers the local room code with the public Cloudflare worker registry."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                "https://dubmate.bkaproductions.com/rooms/create",
                headers={
                    "Content-Type": "application/json",
                    "X-DubMate-Key": "dubmate_sec_99f3810a4c28f14b67e0e7a12b",
                },
                json={
                    "code": room_id,
                    "tunnel_url": tunnel_url,
                    "app_version": app_version,
                },
            )
            if resp.status_code in (200, 201):
                print(f"[Worker Registry] Unified room code {room_id} registered with {tunnel_url}")
    except Exception as e:
        print(f"[Worker Registry] Note: Could not register with worker: {e}")


@app.get("/api/tunnel")
async def get_tunnel_endpoint():
    return {"tunnel_url": ACTIVE_TUNNEL_URL}


@app.post("/api/tunnel")
async def set_tunnel_endpoint(payload: Dict[str, Any]):
    global ACTIVE_TUNNEL_URL
    url = payload.get("tunnel_url")
    if url:
        ACTIVE_TUNNEL_URL = str(url).strip()
        print(f"[DubMate] Active public tunnel registered: {ACTIVE_TUNNEL_URL}")
    return {"status": "ok", "tunnel_url": ACTIVE_TUNNEL_URL}


@app.post("/api/rooms")
async def create_room(payload: Dict[str, Any]):
    pack_id = payload.get("pack_id")
    host_name = payload.get("host_name", "Host").strip() or "Host"
    host_color = payload.get("host_color", "#7c5cff")
    app_version = payload.get("app_version", "1.0.0")

    pack = PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Selected pack not found")

    room_id = generate_room_code()
    # Prune any previous session recordings from disk and RAM so only the new session is kept
    prune_sessions(keep_room_id=room_id)

    host_id = str(uuid.uuid4())[:8]
    room = Room(room_id, pack, host_id, host_name, host_color, min_required_version=app_version)
    ROOMS[room_id] = room

    # Auto-register unified room code on dubmate.bkaproductions.com if tunnel is active
    if ACTIVE_TUNNEL_URL and ACTIVE_TUNNEL_URL.startswith("https://"):
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(register_room_with_worker(room_id, ACTIVE_TUNNEL_URL, app_version))
        except Exception:
            pass

    return {
        "room_id": room_id,
        "user_id": host_id,
        "tunnel_url": ACTIVE_TUNNEL_URL,
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


@app.post("/api/rooms/{room_id}/noise_profile")
async def upload_noise_profile(
    room_id: str,
    file: UploadFile = File(...),
    user_id: str = Form(...),
):
    """Calibrates and saves a 1-second room background noise profile for an actor."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
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
    noise_reduction: bool = Form(False),
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
        target_loudness = line.get("reference_loudness_db")
        if target_loudness is None or target_loudness <= -55.0:
            target_loudness = getattr(room.pack, "mean_vocal_loudness_db", -21.0)

        content = await file.read()
        saved = audio_processor.save_uploaded_take(
            room.room_id,
            line_index,
            content,
            filename_hint=file.filename or "take.webm",
            enable_noise_reduction=noise_reduction,
            user_id=user_id,
            target_loudness_db=target_loudness
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
        "noise_reduction": saved.get("noise_reduction", noise_reduction),
        "has_raw": True,
        "speech_loudness_db": saved.get("speech_loudness_db"),
        "target_loudness_db": saved.get("target_loudness_db"),
        "auto_gain_db": saved.get("auto_gain_db", 0.0),
        "recorded_at": time.time(),
    }

    room.exported_video_path = None
    await room.broadcast("take_recorded", {
        "line_index": line_index,
        "url": versioned_url,
        "noise_reduction": room.takes[line_index]["noise_reduction"],
        "user_name": user_name,
        "user_id": user_id,
    })
    return {"status": "ok", "take": room.takes[line_index]}


@app.post("/api/rooms/{room_id}/takes/{line_index}/noise_reduction")
async def toggle_take_noise_reduction_endpoint(
    room_id: str,
    line_index: int,
    payload: Dict[str, Any]
):
    """Switches an existing take between raw and denoised audio without re-recording."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if line_index not in room.takes:
        raise HTTPException(status_code=404, detail="Take not found")

    enable = bool(payload.get("noise_reduction", False))
    take = room.takes[line_index]
    user_id = take.get("user_id", "host")

    try:
        toggled = audio_processor.toggle_take_noise_reduction(
            room.room_id,
            line_index,
            enable_noise_reduction=enable,
            user_id=user_id
        )
        timestamp_ms = int(time.time() * 1000)
        versioned_url = f"/api/rooms/{room_id}/takes/{line_index}/audio?v={timestamp_ms}"
        room.takes[line_index]["noise_reduction"] = enable
        room.takes[line_index]["url"] = versioned_url
        room.takes[line_index]["peaks"] = toggled["peaks"]
        room.takes[line_index]["duration"] = toggled["duration"]
        room.exported_video_path = None
        await room.broadcast("take_params_updated", {
            "line_index": line_index,
            "url": versioned_url,
            "noise_reduction": enable
        })
        return {"status": "ok", "take": room.takes[line_index]}
    except Exception as ex:
        print(f"[ToggleNoiseReductionError] {ex}")
        raise HTTPException(status_code=400, detail=str(ex))


@app.get("/api/rooms/{room_id}/takes/{line_index}/peaks")
async def get_take_peaks(room_id: str, line_index: int):
    """Returns compact peaks waveform data for a specific take on-demand."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    take = room.takes.get(line_index)
    if not take:
        raise HTTPException(status_code=404, detail="Take not found")
    return {
        "status": "ok",
        "line_index": line_index,
        "peaks": take.get("peaks", []),
        "duration": take.get("duration", 0.0),
        "url": take.get("url"),
    }


@app.get("/api/rooms/{room_id}/takes/{line_index}/audio")
async def get_take_audio(room_id: str, line_index: int, request: Request):
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    take = room.takes.get(line_index)
    if not take or not os.path.exists(take.get("wav_path", "")):
        raise HTTPException(status_code=404, detail="Take not found")
    
    # If versioned query param (?v=...) is present, the audio file is uniquely fingerprinted
    # and safe to cache heavily by browsers and Cloudflare edge CDN.
    cache_ctrl = "public, max-age=86400, stale-while-revalidate=604800" if "v" in request.query_params else "no-cache, must-revalidate"
    return range_stream_file(
        take["wav_path"],
        request,
        media_type="audio/wav",
        cache_control=cache_ctrl
    )


@app.post("/api/rooms/{room_id}/export")
async def export_room_dub(room_id: str, aspect_ratio: str = "16:9", presence: float = 0.0):
    """Renders the final dubbed scene into MP4 (16:9 cinema or 9:16 shorts) asynchronously."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    presence_val = float(presence) if presence != 0.0 else getattr(room, "master_dialogue_presence_db", 0.0)
    room.master_dialogue_presence_db = presence_val

    is_9_16 = (aspect_ratio == "9:16")
    suffix = "_9_16" if is_9_16 else ""
    out_filename = f"Dub_{room.pack.pack_id}_{room.room_id}{suffix}.mp4"
    out_path = os.path.join(EXPORTS_DIR, out_filename)

    # Check if existing rendered file is already ready
    target_path = getattr(room, "exported_video_9_16_path", None) if is_9_16 else getattr(room, "exported_video_path", None)
    if target_path and os.path.exists(target_path) and os.path.getsize(target_path) > 1000:
        file_size_mb = round(os.path.getsize(target_path) / (1024 * 1024), 2)
        duration = round(room.pack.duration, 1)
        timestamp_ms = int(time.time() * 1000)
        export_video_url = f"/api/rooms/{room.room_id}/export/video?aspect_ratio={aspect_ratio}&v={timestamp_ms}"
        download_url = f"/api/rooms/{room.room_id}/export/download?aspect_ratio={aspect_ratio}"
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

    if not hasattr(room, "export_status"):
        room.export_status = {}

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

    def render_worker():
        try:
            audio_processor.export_dub_video(
                room.pack,
                dict(room.takes),
                out_path,
                aspect_ratio="9:16" if is_9_16 else "16:9",
                master_dialogue_presence_db=presence_val
            )
            if is_9_16:
                room.exported_video_9_16_path = out_path
            else:
                room.exported_video_path = out_path

            room.export_status[aspect_ratio] = "ready"
            file_size_mb = round(os.path.getsize(out_path) / (1024 * 1024), 2) if os.path.exists(out_path) else 0.0
            duration = round(room.pack.duration, 1)
            timestamp_ms = int(time.time() * 1000)
            export_video_url = f"/api/rooms/{room.room_id}/export/video?aspect_ratio={aspect_ratio}&v={timestamp_ms}"
            download_url = f"/api/rooms/{room.room_id}/export/download?aspect_ratio={aspect_ratio}"

            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        room.broadcast("export_ready", {
                            "download_url": download_url,
                            "export_video_url": export_video_url,
                            "download_url_16_9": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=16:9",
                            "download_url_9_16": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=9:16",
                            "file_size_mb": file_size_mb,
                            "duration": duration,
                            "aspect_ratio": aspect_ratio,
                        }),
                        loop
                    )
            except Exception:
                pass
        except Exception as ex:
            room.export_status[aspect_ratio] = f"failed: {str(ex)}"
            print(f"[ExportWorkerError] Error rendering {room.room_id} ({aspect_ratio}): {ex}")

    threading.Thread(target=render_worker, daemon=True).start()

    return {
        "status": "processing",
        "message": "Rendering started in background",
        "aspect_ratio": aspect_ratio,
        "poll_url": f"/api/rooms/{room.room_id}/export/status?aspect_ratio={aspect_ratio}"
    }


@app.get("/api/rooms/{room_id}/export/status")
async def get_export_status(room_id: str, aspect_ratio: str = "16:9"):
    """Pollable endpoint for export status to prevent Cloudflare 524 timeouts."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    is_9_16 = (aspect_ratio == "9:16")
    target_path = getattr(room, "exported_video_9_16_path", None) if is_9_16 else getattr(room, "exported_video_path", None)
    if target_path and os.path.exists(target_path) and os.path.getsize(target_path) > 1000:
        file_size_mb = round(os.path.getsize(target_path) / (1024 * 1024), 2)
        duration = round(room.pack.duration, 1)
        timestamp_ms = int(time.time() * 1000)
        export_video_url = f"/api/rooms/{room.room_id}/export/video?aspect_ratio={aspect_ratio}&v={timestamp_ms}"
        download_url = f"/api/rooms/{room.room_id}/export/download?aspect_ratio={aspect_ratio}"
        return {
            "status": "ready",
            "download_url": download_url,
            "export_video_url": export_video_url,
            "download_url_16_9": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=16:9",
            "download_url_9_16": f"/api/rooms/{room.room_id}/export/download?aspect_ratio=9:16",
            "file_size_mb": file_size_mb,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
        }

    status = getattr(room, "export_status", {}).get(aspect_ratio, "idle")
    return {
        "status": status,
        "aspect_ratio": aspect_ratio,
    }


@app.get("/api/rooms/{room_id}/export/video")
async def get_room_exported_video(room_id: str, request: Request, aspect_ratio: str = "16:9"):
    """Streams the rendered master MP4 video with Range support for theater playback."""
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    target_path = getattr(room, "exported_video_9_16_path", None) if aspect_ratio == "9:16" else getattr(room, "exported_video_path", None)
    if not target_path or not os.path.exists(target_path):
        target_path = room.exported_video_path

    if not target_path or not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="Exported video not found")

    return range_stream_file(
        target_path,
        request,
        media_type="video/mp4",
        cache_control="no-cache, must-revalidate"
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

    target_path = getattr(room, "exported_video_9_16_path", None) if is_9_16 else getattr(room, "exported_video_path", None)
    if not target_path or not os.path.exists(target_path):
        audio_processor.export_dub_video(room.pack, room.takes, out_path, aspect_ratio="9:16" if is_9_16 else "16:9")
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


@app.get("/api/rooms/{room_id}/export/project_zip")
async def download_room_project_zip(room_id: str):
    """
    Assembles and streams a complete multi-track NLE project ZIP containing stems, video, markers.
    """
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    zip_filename = f"DubMate_Project_{room.pack.pack_id}_{room.room_id}.zip"
    zip_path = os.path.join(EXPORTS_DIR, zip_filename)

    try:
        audio_processor.build_project_zip(
            pack=room.pack,
            takes_dict=room.takes,
            role_assignments=room.role_assignments,
            users=room.users,
            output_zip_path=zip_path,
            room_id=room.room_id,
            bitrate="192k"
        )
    except Exception as ex:
        print(f"[ProjectZipError] Error generating project ZIP for {room_id}: {ex}")
        raise HTTPException(status_code=500, detail=f"Failed to generate project ZIP: {str(ex)}")

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
                client_version = payload.get("app_version", "1.0.0")
                if room.min_required_version and is_version_outdated(client_version, room.min_required_version):
                    await websocket.send_text(json.dumps({
                        "type": "version_mismatch",
                        "payload": {
                            "required": room.min_required_version,
                            "yours": client_version,
                        }
                    }))
                    await websocket.close()
                    return

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
                    if user_id in room.users:
                        room.users[user_id]["current_line"] = line_idx
                    await room.broadcast("line_changed", {"line_index": line_idx, "user_id": user_id})

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

            elif msg_type == "toggle_noise_reduction":
                raw_idx = payload.get("line_index")
                enable = bool(payload.get("noise_reduction", False))
                try:
                    line_idx = int(raw_idx)
                except (TypeError, ValueError):
                    line_idx = None
                if line_idx is not None and line_idx in room.takes:
                    try:
                        toggled = audio_processor.toggle_take_noise_reduction(
                            room.room_id,
                            line_idx,
                            enable_noise_reduction=enable,
                            user_id=user_id
                        )
                        timestamp_ms = int(time.time() * 1000)
                        versioned_url = f"/api/rooms/{room.room_id}/takes/{line_idx}/audio?v={timestamp_ms}"
                        room.takes[line_idx]["noise_reduction"] = enable
                        room.takes[line_idx]["url"] = versioned_url
                        room.takes[line_idx]["peaks"] = toggled["peaks"]
                        room.takes[line_idx]["duration"] = toggled["duration"]
                        room.exported_video_path = None
                        await room.broadcast("take_params_updated", {
                            "line_index": line_idx,
                            "url": versioned_url,
                            "noise_reduction": enable
                        })
                    except Exception as ex:
                        print(f"[WSToggleNoiseReductionError] {ex}")

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

            elif msg_type == "set_dialogue_presence":
                presence_db = float(payload.get("presence_db", 0.0))
                room.master_dialogue_presence_db = max(-12.0, min(12.0, presence_db))
                room.exported_video_path = None
                room.exported_video_9_16_path = None
                await room.broadcast("dialogue_presence_sync", {
                    "presence_db": room.master_dialogue_presence_db,
                    "triggered_by": user_id
                })

            elif msg_type == "initiate_transfer":
                if user_id != room.host_id:
                    continue
                target_id = payload.get("target_user_id")
                if not target_id or target_id not in room.users:
                    continue
                if not room.users[target_id].get("is_online", False):
                    continue

                room.pending_transfer_to = target_id

                async def _timeout_transfer(tid=target_id):
                    await asyncio.sleep(10)
                    if room.pending_transfer_to == tid:
                        room.pending_transfer_to = None
                        await room.broadcast("host_transfer_cancelled", {"reason": "timeout"})

                if room._transfer_timeout_task and not room._transfer_timeout_task.done():
                    room._transfer_timeout_task.cancel()
                try:
                    loop = asyncio.get_running_loop()
                    room._transfer_timeout_task = loop.create_task(_timeout_transfer())
                except RuntimeError:
                    pass

                new_host_name = room.users[target_id].get("name", "Unknown")
                await room.broadcast("host_transfer_pending", {
                    "new_host_id": target_id,
                    "new_host_name": new_host_name,
                })

            elif msg_type == "complete_transfer":
                if user_id != room.pending_transfer_to:
                    continue

                new_tunnel_url = payload.get("new_tunnel_url", "")
                if not new_tunnel_url.startswith("https://") and not new_tunnel_url.startswith("http://"):
                    continue

                if room._transfer_timeout_task and not room._transfer_timeout_task.done():
                    room._transfer_timeout_task.cancel()
                room.pending_transfer_to = None

                # Clean slate: wipe all takes, role assignments, and resets room to lobby
                room.takes.clear()
                room.role_assignments = {char: [] for char in room.pack.characters}
                room.status = "lobby"
                room.current_line = 0
                room.exported_video_path = None
                room.exported_video_9_16_path = None

                # Promote new host and synchronize flags
                room.host_id = user_id
                for uid, u in room.users.items():
                    u["is_host"] = (uid == room.host_id)

                await room.broadcast("host_transfer_confirmed", {
                    "new_host_id": user_id,
                    "new_tunnel_url": new_tunnel_url,
                })

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except (WebSocketDisconnect, ConnectionResetError, asyncio.CancelledError):
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        await room.broadcast("user_disconnected", {"user_id": user_id})
    except Exception as ex:
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        try:
            await room.broadcast("user_disconnected", {"user_id": user_id})
        except Exception:
            pass


# =====================================================================
# DubMate Pack Builder API Endpoints
# =====================================================================

BUILDER_SESSIONS: Dict[str, Dict[str, Any]] = {}


def prune_old_builder_sessions(max_age_seconds: float = 7200.0):
    """Purges builder sessions older than 2 hours to keep disk space lean."""
    now = time.time()
    to_delete = []
    for s_id, session in list(BUILDER_SESSIONS.items()):
        created_at = session.get("created_at", now)
        if now - created_at > max_age_seconds:
            to_delete.append(s_id)
            folder = session.get("folder")
            if folder and os.path.isdir(folder):
                shutil.rmtree(folder, ignore_errors=True)
    for s_id in to_delete:
        BUILDER_SESSIONS.pop(s_id, None)


@app.post("/api/builder/upload")
async def builder_upload_video(file: UploadFile = File(...)):
    """
    Accepts video file upload for pack authoring.
    Validates format, probes duration, and initializes a Builder session.
    """
    prune_old_builder_sessions()
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="No video file provided.")
    
    _, ext = os.path.splitext(file.filename.lower())
    if ext not in pack_loader.VIDEO_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video format '{ext}'. Accepted formats: {', '.join(pack_loader.VIDEO_EXTS)}"
        )

    session_id = str(uuid.uuid4())[:12]
    session_dir = os.path.join(pack_builder.BUILDER_CACHE_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    video_path = os.path.join(session_dir, f"source_video{ext}")
    
    try:
        content = await file.read()
        if len(content) > pack_loader.MAX_ARCHIVE_SIZE_BYTES:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise HTTPException(status_code=413, detail="Video exceeds maximum allowed upload size (500 MB).")

        with open(video_path, "wb") as f:
            f.write(content)

        duration = pack_loader.probe_duration(video_path)
        if duration <= 0.0:
            duration = 5.0  # Fallback duration for synthetic or untagged video streams

        torch_avail, cuda_avail, device = pack_builder.detect_torch_and_cuda()
        progress = pack_builder.BuildProgress(session_id)
        progress.device_info = {
            "torch_available": torch_avail,
            "cuda_available": cuda_avail,
            "device": device,
        }

        BUILDER_SESSIONS[session_id] = {
            "session_id": session_id,
            "folder": session_dir,
            "video_path": video_path,
            "filename": file.filename,
            "duration": round(duration, 3),
            "progress": progress,
            "created_at": time.time(),
            "vocals_path": None,
            "backing_path": None,
            "full_audio_path": None,
            "cover_path": None,
        }

        return {
            "status": "ok",
            "session_id": session_id,
            "filename": file.filename,
            "duration": round(duration, 3),
            "device_info": progress.device_info,
            "video_url": f"/api/builder/{session_id}/video",
        }

    except HTTPException:
        raise
    except Exception as ex:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(ex)}")


@app.post("/api/builder/import_url")
async def builder_import_url(payload: Dict[str, Any]):
    """
    Downloads a video from YouTube or a supported web URL using yt-dlp.
    Initializes a Builder session with the downloaded video, cover, and subtitles.
    """
    prune_old_builder_sessions()

    raw_url = str(payload.get("url") or "").strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="Please provide a valid YouTube / web video URL.")

    session_id = str(uuid.uuid4())[:12]
    session_dir = os.path.join(pack_builder.BUILDER_CACHE_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    try:
        # Run yt-dlp download in thread pool to prevent blocking the event loop
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            pack_builder.download_video_from_url,
            raw_url,
            session_dir
        )

        video_path = result["video_path"]
        duration = result["duration"]
        title = result["title"]
        cover_path = result.get("cover_path")
        subtitle_segments = result.get("subtitle_segments", [])

        torch_avail, cuda_avail, device = pack_builder.detect_torch_and_cuda()
        progress = pack_builder.BuildProgress(session_id)
        progress.device_info = {
            "torch_available": torch_avail,
            "cuda_available": cuda_avail,
            "device": device,
        }
        if subtitle_segments:
            progress.segments = subtitle_segments

        BUILDER_SESSIONS[session_id] = {
            "session_id": session_id,
            "folder": session_dir,
            "video_path": video_path,
            "filename": result["filename"],
            "title": title,
            "duration": round(duration, 3),
            "progress": progress,
            "created_at": time.time(),
            "vocals_path": None,
            "backing_path": None,
            "full_audio_path": result.get("full_audio_path"),
            "cover_path": cover_path,
            "imported_from_url": True,
            "source_url": raw_url,
            "subtitle_segments": subtitle_segments,
        }

        return {
            "status": "ok",
            "session_id": session_id,
            "filename": result["filename"],
            "title": title,
            "duration": round(duration, 3),
            "cover_url": f"/api/builder/{session_id}/cover" if cover_path else None,
            "has_subtitles": len(subtitle_segments) > 0,
            "subtitles_count": len(subtitle_segments),
            "device_info": progress.device_info,
            "video_url": f"/api/builder/{session_id}/video",
        }

    except ValueError as val_err:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(val_err))
    except RuntimeError as run_err:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(run_err))
    except Exception as ex:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to import video from URL: {str(ex)}")


def _run_builder_pipeline_sync(session_id: str, language: Optional[str] = None, whisper_model: str = "base", payload: Optional[Dict[str, Any]] = None):
    """Background synchronous worker executing the AI processing pipeline."""
    payload = payload or {}
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        return

    progress: pack_builder.BuildProgress = session["progress"]
    session_dir = session["folder"]
    video_path = session["video_path"]

    try:
        # Step 1: Extract Audio (0% -> 20%)
        progress.update("extracting_audio", 0.10, "Extracting audio track from video with FFmpeg...", stage="audio_extraction")
        full_wav = os.path.join(session_dir, "full_audio.wav")
        pack_builder.extract_audio_from_video(video_path, full_wav)
        session["full_audio_path"] = full_wav
        progress.update("extracting_audio", 0.20, "Audio track extracted.", stage="audio_extraction")

        # Step 2: Stem Separation via Demucs (20% -> 60%)
        progress.update("separating_stems", 0.30, "Isolating dialogue and backing audio (Demucs AI)...", stage="stem_separation")
        stems_dir = os.path.join(session_dir, "stems")
        stem_results = pack_builder.separate_audio_stems(full_wav, stems_dir)
        session["vocals_path"] = stem_results["vocals"]
        session["backing_path"] = stem_results["backing"]
        progress.update("separating_stems", 0.60, "Audio stem separation complete.", stage="stem_separation")

        # Step 3: Speech-to-Text Transcription via Whisper (60% -> 90%)
        progress.update("transcribing", 0.70, "Transcribing dialogue lines & timestamps (Whisper AI)...", stage="transcription")
        is_romaji = (language and "romaji" in language.lower()) or bool(payload.get("romanize", False))
        segments = pack_builder.transcribe_audio(session["vocals_path"], model_size=whisper_model, language=language, romanize=is_romaji)
        
        # Step 4: Speaker Turn Heuristics (90% -> 100%)
        if segments:
            segments = pack_builder.assign_speakers_to_segments(segments)
        else:
            # If no speech detected, create 1 initial default segment
            dur = session.get("duration", 5.0)
            segments = [{
                "start": 0.5,
                "end": min(dur, 4.0),
                "text": "Dialogue line 1",
                "character": "Actor"
            }]

        progress.characters = sorted(list({s["character"] for s in segments}))
        progress.update("transcribed", 1.0, f"Detected {len(segments)} dialogue cues.", stage="complete", segments=segments)

    except Exception as ex:
        print(f"[PackBuilderPipeline] Error in session {session_id}: {ex}")
        progress.update("error", 0.0, f"Processing failed: {str(ex)}", error=str(ex))


@app.post("/api/builder/{session_id}/process")
async def builder_start_processing(session_id: str, payload: Optional[Dict[str, Any]] = None):
    """Kicks off background Demucs vocal isolation + Whisper transcription pipeline."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    payload = payload or {}
    language = payload.get("language")
    whisper_model = payload.get("whisper_model", "base")

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _run_builder_pipeline_sync, session_id, language, whisper_model, payload)

    return {"status": "processing", "session_id": session_id}


@app.get("/api/builder/{session_id}/progress")
async def builder_progress_stream(session_id: str):
    """Server-Sent Events (SSE) stream reporting real-time pipeline progress."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    progress: pack_builder.BuildProgress = session["progress"]

    async def event_generator():
        last_status = None
        last_progress = -1
        while True:
            state = progress.to_dict()
            curr_status = state["status"]
            curr_prog = state["progress"]

            # Send update if state changed
            if curr_status != last_status or abs(curr_prog - last_progress) >= 0.02:
                last_status = curr_status
                last_progress = curr_prog
                yield f"data: {json.dumps(state)}\n\n"

            if curr_status in ("transcribed", "done", "error"):
                yield f"data: {json.dumps(state)}\n\n"
                break

            await asyncio.sleep(0.35)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@app.get("/api/builder/{session_id}/status")
async def builder_get_status(session_id: str):
    """Polling alternative to SSE for retrieving builder session status."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")
    return session["progress"].to_dict()


@app.get("/api/builder/{session_id}/waveform")
async def builder_get_waveform(session_id: str, columns: int = 800, track: str = "vocals"):
    """Returns precomputed or on-demand min/max waveform peak pairs for the session audio track."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    audio_path = None
    if track == "vocals":
        audio_path = session.get("vocals_path") or session.get("full_audio_path")
    else:
        audio_path = session.get("full_audio_path") or session.get("vocals_path")

    if not audio_path or not os.path.isfile(audio_path):
        folder = session.get("folder")
        if folder:
            for cand in ("stems/vocals.wav", "vocals.wav", "full_audio.wav"):
                p = os.path.join(folder, cand)
                if os.path.isfile(p):
                    audio_path = p
                    break

    if not audio_path or not os.path.isfile(audio_path):
        return {"peaks": [], "duration": session.get("duration", 0.0), "count": 0}

    loop = asyncio.get_running_loop()
    def _calc_peaks():
        try:
            arr = audio_processor.read_wav_mono(audio_path, sr=22050)
            return audio_processor.compute_waveform_peaks(arr, columns=max(100, min(2400, columns)))
        except Exception as e:
            print(f"[Waveform] Error computing peaks for {audio_path}: {e}")
            return []

    peaks = await loop.run_in_executor(None, _calc_peaks)
    return {
        "peaks": peaks,
        "duration": session.get("duration", 0.0),
        "count": len(peaks)
    }


@app.get("/api/builder/{session_id}/segments")
async def builder_get_segments(session_id: str):
    """Returns current dialogue line segments and character roster for session."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")
    progress: pack_builder.BuildProgress = session["progress"]
    return {
        "segments": progress.segments,
        "characters": sorted(list({s.get("character", "Actor") for s in progress.segments})),
        "duration": session.get("duration", 0.0),
    }


@app.put("/api/builder/{session_id}/segments")
async def builder_update_segments(session_id: str, payload: Dict[str, Any]):
    """Replaces or bulk-updates the dialogue line segments for the session."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    raw_segments = payload.get("segments", [])
    valid_segments = []
    max_dur = session.get("duration", 99999.0)

    for s in raw_segments:
        try:
            start = max(0.0, float(s["start"]))
            end = min(max_dur, float(s["end"]))
            if end <= start:
                end = min(max_dur, start + 0.5)
            valid_segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "text": str(s.get("text", "")).strip(),
                "character": str(s.get("character", "Actor")).strip() or "Actor",
            })
        except (ValueError, KeyError, TypeError):
            continue

    valid_segments.sort(key=lambda x: x["start"])
    progress: pack_builder.BuildProgress = session["progress"]
    with progress.lock:
        progress.segments = valid_segments
        progress.characters = sorted(list({s["character"] for s in valid_segments}))

    return {
        "status": "ok",
        "count": len(valid_segments),
        "segments": valid_segments,
        "characters": progress.characters,
    }


@app.post("/api/builder/{session_id}/segments")
async def builder_add_segment(session_id: str, payload: Dict[str, Any]):
    """Appends a new dialogue line segment."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    max_dur = session.get("duration", 99999.0)
    start = max(0.0, min(max_dur, float(payload.get("start", 0.0))))
    end = max(start + 0.3, min(max_dur, float(payload.get("end", start + 2.0))))
    char = str(payload.get("character", "Actor")).strip() or "Actor"
    text = str(payload.get("text", "")).strip()

    new_seg = {
        "start": round(start, 3),
        "end": round(end, 3),
        "text": text,
        "character": char,
    }

    progress: pack_builder.BuildProgress = session["progress"]
    with progress.lock:
        progress.segments.append(new_seg)
        progress.segments.sort(key=lambda x: x["start"])
        progress.characters = sorted(list({s["character"] for s in progress.segments}))
        current_segs = list(progress.segments)

    return {"status": "ok", "segment": new_seg, "segments": current_segs}


@app.delete("/api/builder/{session_id}/segments/{index}")
async def builder_delete_segment(session_id: str, index: int):
    """Deletes a dialogue line segment by chronological index."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    progress: pack_builder.BuildProgress = session["progress"]
    with progress.lock:
        if 0 <= index < len(progress.segments):
            deleted = progress.segments.pop(index)
            progress.characters = sorted(list({s["character"] for s in progress.segments}))
            return {"status": "ok", "deleted": deleted, "segments": progress.segments}
        else:
            raise HTTPException(status_code=404, detail="Segment index out of range.")


@app.post("/api/builder/{session_id}/transcribe_segment")
async def builder_transcribe_segment(session_id: str, payload: Dict[str, Any]):
    """Transcribes a specific audio segment [start, end] using Whisper on demand."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    vocals_path = session.get("vocals_path") or session.get("full_audio_path")
    if not vocals_path or not os.path.isfile(vocals_path):
        raise HTTPException(status_code=400, detail="Audio track not ready for transcription.")

    start = float(payload.get("start", 0.0))
    end = float(payload.get("end", start + 2.0))
    lang = payload.get("language")
    model_size = payload.get("whisper_model", "base")
    romanize = bool(payload.get("romanize", False)) or (lang and "romaji" in lang.lower())

    loop = asyncio.get_running_loop()
    text = await loop.run_in_executor(
        None,
        pack_builder.transcribe_segment,
        vocals_path,
        start,
        end,
        model_size,
        lang,
        romanize
    )

    return {"status": "ok", "text": text, "start": start, "end": end}


@app.post("/api/builder/{session_id}/romanize")
async def builder_romanize_text(session_id: str, payload: Dict[str, Any]):
    """Converts Japanese text into Romaji phonetic script for non-native anime dubbers."""
    raw_text = str(payload.get("text", "")).strip()
    romaji = pack_builder.to_romaji(raw_text)
    return {"status": "ok", "original": raw_text, "romaji": romaji}


@app.post("/api/builder/{session_id}/import_subtitles")
async def builder_import_subtitles(session_id: str, file: UploadFile = File(...)):
    """Imports an SRT or WebVTT subtitle file to instantly populate dialogue cues."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    content = await file.read()
    text = content.decode("utf-8", errors="replace")
    
    fname = (file.filename or "").lower()
    if fname.endswith(".vtt"):
        parsed = pack_builder.parse_vtt(text)
    else:
        parsed = pack_builder.parse_srt(text)

    if not parsed:
        raise HTTPException(status_code=400, detail="Could not parse any timestamped subtitle lines from file.")

    # Clamp to video duration
    max_dur = session.get("duration", 99999.0)
    clamped = []
    for s in parsed:
        if s["start"] < max_dur:
            s["end"] = min(max_dur, s["end"])
            clamped.append(s)

    progress: pack_builder.BuildProgress = session["progress"]
    with progress.lock:
        progress.segments = clamped
        progress.characters = sorted(list({s["character"] for s in clamped}))

    return {
        "status": "ok",
        "count": len(clamped),
        "segments": clamped,
        "characters": progress.characters,
    }


@app.post("/api/builder/{session_id}/cover")
async def builder_upload_cover(session_id: str, file: UploadFile = File(...)):
    """Uploads custom cover art for the pack card."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    _, ext = os.path.splitext((file.filename or "").lower())
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(status_code=400, detail="Cover image must be PNG, JPG, or WebP.")

    session_dir = session["folder"]
    cover_path = os.path.join(session_dir, f"cover{ext}")
    content = await file.read()
    with open(cover_path, "wb") as f:
        f.write(content)

    session["cover_path"] = cover_path
    return {"status": "ok", "cover_url": f"/api/builder/{session_id}/cover"}


@app.get("/api/builder/{session_id}/cover")
async def builder_serve_cover(session_id: str):
    """Serves the uploaded cover image preview."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session or not session.get("cover_path") or not os.path.isfile(session["cover_path"]):
        raise HTTPException(status_code=404, detail="Cover not found.")
    ext = os.path.splitext(session["cover_path"])[1].lower()
    media_type = "image/png" if ext == ".png" else "image/jpeg" if ext in (".jpg", ".jpeg") else "image/webp"
    return FileResponse(session["cover_path"], media_type=media_type)


@app.get("/api/builder/{session_id}/video")
async def builder_serve_video(session_id: str, request: Request):
    """Streams uploaded builder source video with HTTP 206 partial range seeking."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session or not os.path.isfile(session.get("video_path", "")):
        raise HTTPException(status_code=404, detail="Video not found.")
    return range_stream_file(
        session["video_path"],
        request,
        media_type="video/mp4",
        cache_control="no-cache"
    )


@app.get("/api/builder/{session_id}/audio/{track}")
async def builder_serve_audio_track(session_id: str, track: str, request: Request):
    """Streams full, vocals, or backing audio track with HTTP 206 Range seeking."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    if track == "vocals":
        file_path = session.get("vocals_path") or session.get("full_audio_path")
    elif track == "backing":
        file_path = session.get("backing_path")
    else:
        file_path = session.get("full_audio_path")

    if not file_path or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"Audio track '{track}' is not ready yet.")

    return range_stream_file(
        file_path,
        request,
        media_type="audio/wav",
        cache_control="no-cache"
    )


@app.post("/api/builder/{session_id}/compile")
async def builder_compile_pack(session_id: str, payload: Dict[str, Any]):
    """
    Slices audio cues, packages all assets, generates compliance metadata,
    and installs the finished scene pack directly into DubMate's Packs directory.
    """
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Builder session not found.")

    progress: pack_builder.BuildProgress = session["progress"]
    segments = payload.get("segments") or progress.segments
    if not segments:
        raise HTTPException(status_code=400, detail="Cannot compile pack with 0 dialogue lines.")

    pack_name = (payload.get("pack_name") or session.get("filename") or "Custom Scene").strip()
    authors = payload.get("authors") or ["DubMate Creator"]
    subtitle = payload.get("subtitle") or f"Authored with DubMate Pack Builder ({len(segments)} lines)"

    session_dir = session["folder"]
    video_path = session["video_path"]
    vocals_path = session.get("vocals_path") or session.get("full_audio_path")
    backing_path = session.get("backing_path") or vocals_path
    cover_path = session.get("cover_path")

    # Step 1: Slice individual audio takes
    progress.update("slicing", 0.80, "Slicing audio dialogue lines with micro-fades...", stage="slicing")
    slices_dir = os.path.join(session_dir, "slices")
    sliced_lines = pack_builder.slice_audio_lines(vocals_path, segments, slices_dir, pack_name)

    # Step 2: Assemble complete pack folder
    progress.update("assembling", 0.90, "Compiling metadata and installing pack into Packs/...", stage="assembling")
    pack_folder = pack_builder.assemble_pack(
        pack_name=pack_name,
        video_source_path=video_path,
        backing_source_path=backing_path,
        line_slices=sliced_lines,
        cover_image_path=cover_path,
        authors=authors,
        subtitle=subtitle
    )

    # Step 3: Refresh server pack registry
    new_registry = get_packs_registry(force_rescan=True)
    pack_id = os.path.basename(os.path.normpath(pack_folder))
    loaded_pack = new_registry.get(pack_id)

    if not loaded_pack:
        # Try loading directly
        loaded_pack = pack_loader.load_pack(pack_folder)
        if loaded_pack:
            PACKS_CACHE[loaded_pack.pack_id] = loaded_pack

    progress.pack_info = loaded_pack.to_dict() if loaded_pack else {"id": pack_id, "name": pack_name}
    progress.update("done", 1.0, f"Successfully created and installed pack '{pack_name}'!", stage="done")

    quoted_pack_id = urllib.parse.quote(pack_id)
    return {
        "status": "ok",
        "message": f"Successfully created and installed pack '{pack_name}'!",
        "pack_id": pack_id,
        "download_url": f"/api/packs/{quoted_pack_id}/export",
        "pack": loaded_pack.to_dict() if loaded_pack else {"id": pack_id, "name": pack_name, "export_url": f"/api/packs/{quoted_pack_id}/export"},
    }


# Mount static assets
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    import sys
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    # High-performance production mode: eliminates file polling over pack assets
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False, access_log=False)
