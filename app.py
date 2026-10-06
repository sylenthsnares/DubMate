# -*- coding: utf-8 -*-
"""
app.py
FastAPI + WebSocket backend server for DubMate Multiplayer Studio.
"""

import os
import sys
import json
import time
import uuid
import random
import shutil
import asyncio
import functools
import threading
import traceback
from typing import Dict, List, Optional, Set, Any
from contextlib import asynccontextmanager

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import pack_loader
import audio_processor
from dubmate import common, packs_cache, builder_api, packs_api

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def find_static_dir() -> str:
    """Finds the static assets folder across dev, bundled desktop, and installed directory structures."""
    candidates = [
        os.path.join(BASE_DIR, "static"),
        os.path.join(BASE_DIR, "static", "static"),
        BASE_DIR,
        os.path.join(BASE_DIR, "resources", "static"),
        os.path.join(os.path.dirname(BASE_DIR), "static"),
        os.path.join(os.path.dirname(BASE_DIR), "static", "static"),
        os.path.join(os.path.dirname(BASE_DIR), "resources", "static"),
        os.path.join(os.getcwd(), "static"),
        os.path.join(os.getcwd(), "resources", "static"),
    ]
    for c in candidates:
        if os.path.isdir(c) and os.path.isfile(os.path.join(c, "index.html")):
            return os.path.abspath(c)
    return os.path.join(BASE_DIR, "static")

STATIC_DIR = find_static_dir()

try:
    os.makedirs(STATIC_DIR, exist_ok=True)
except Exception:
    pass


def require_local_request(request: Request) -> None:
    """
    Rejects requests that arrived through the Cloudflare tunnel. cloudflared
    connects to the engine from localhost, so the client address cannot tell a
    tunnel guest from the host; the headers Cloudflare adds can.
    """
    if request.headers.get("cf-connecting-ip") or request.headers.get("cf-ray"):
        raise HTTPException(status_code=403, detail="This setting can only be changed on the host machine")


DEFAULT_ENGINE_PORT = 8000


def get_engine_port() -> int:
    """
    Port to serve on. The desktop launcher picks a free port and passes it in via
    DUBMATE_PORT, so a busy 8000 no longer prevents the engine from starting.
    """
    raw = (os.environ.get("DUBMATE_PORT") or "").strip()
    if raw.isdigit():
        candidate = int(raw)
        if 1 <= candidate <= 65535:
            return candidate
    return DEFAULT_ENGINE_PORT


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
            "current_line": self.current_line,
            "mode": self.mode,
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

# create_room prunes old sessions in a worker thread; serializing creation keeps a
# concurrent create from inserting a room that an older prune then removes.
_ROOM_CREATE_LOCK = asyncio.Lock()


def _room_or_404(room_id: str) -> Room:
    room = ROOMS.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


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

    # Prune old exports in the exports folder
    if os.path.isdir(common.exports_dir()):
        for fname in os.listdir(common.exports_dir()):
            if fname.endswith((".mp4", ".zip")):
                if retained_id and retained_id in fname.upper():
                    continue
                if any(a in fname.upper() for a in active_ids):
                    continue
                try:
                    os.remove(os.path.join(common.exports_dir(), fname))
                    print(f"[DubMate Cache Pruner] Removed old export/zip: {fname}")
                except Exception:
                    pass


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
                    room.current_line = data.get("current_line", 0)
                    room.mode = data.get("mode", "booth")
                    room.status = data.get("status", "lobby")
                    room.exported_video_path = data.get("exported_video_path")
                    ROOMS[r_id.upper()] = room
                    print(f"[DubMate] Preserved last active session {r_id.upper()} with {len(room.takes)} takes from disk.")
            except Exception as ex:
                print(f"[DubMate] Error restoring room {r_id}: {ex}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Probed in the background. It costs ~0.39s and only /api/system/encoder needs
    # the answer, so blocking startup on it just delayed the window opening. The
    # probe caches its own result, so the first real caller either finds it ready
    # or pays for it then.
    def _probe_encoder():
        try:
            pack_loader.preflight_probe_hardware_encoder()
        except Exception as ex:
            print(f"[DubMate Acceleration] Startup probe warning: {ex}")

    threading.Thread(target=_probe_encoder, name="encoder-probe", daemon=True).start()

    registry = packs_cache.refresh_packs()
    print(f"[DubMate] Loaded {len(registry)} packs into studio registry.")
    load_persisted_rooms()

    # Keeps retrying room codes that could not be published on the first attempt,
    # so a slow tunnel or a network blip does not leave a room unjoinable forever.
    heartbeat = asyncio.create_task(registry_heartbeat())
    try:
        yield
    finally:
        heartbeat.cancel()
        try:
            await heartbeat
        except asyncio.CancelledError:
            pass
        except Exception as ex:
            print(f"[Worker Registry] Heartbeat shutdown warning: {ex}")


app = FastAPI(title="DubMate Multiplayer Studio", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # Must stay False while allow_origins is "*": with both set, Starlette echoes the
    # request's own Origin back, which defeats the point of the wildcard restriction.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_performance_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path.lower()
    # Only set default fallback cache headers if the route handler did not explicitly set Cache-Control
    if "cache-control" not in response.headers:
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        elif path.endswith((".html", ".js", ".css")) or path == "/":
            # "no-cache" means revalidate before use, NOT "do not cache". The old
            # "no-store" forbade the browser from keeping the response at all, so
            # the ETag and Last-Modified this server already sends could never
            # produce a 304 -- the full ~360 KB of JS and CSS re-transferred on
            # every single load.
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif path.endswith((".svg", ".png", ".jpg", ".woff", ".woff2", ".ttf", ".ico", ".mp4", ".wav", ".mp3", ".ogg")):
            response.headers["Cache-Control"] = common.LONG_CACHE

    # Answer 304 when the client already holds this exact version. FileResponse
    # emits an ETag but Starlette never checks the request against it, so without
    # this the revalidation above would always come back as a full 200 body.
    if request.method in ("GET", "HEAD") and response.status_code == 200:
        etag = response.headers.get("etag")
        if etag and common._etag_matches(request.headers.get("if-none-match"), etag):
            not_modified = Response(status_code=304)
            for header in ("Cache-Control", "ETag", "Last-Modified", "Vary", "Expires", "Pragma"):
                if header.lower() in response.headers:
                    not_modified.headers[header] = response.headers[header.lower()]
            return not_modified

    return response


@app.get("/health")
async def health_check():
    """Liveness probe used by the desktop app launcher and orchestrators."""
    return {
        "status": "ok",
        "version": common.read_version(),
        "port": get_engine_port(),
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


def _config_payload() -> Dict[str, Any]:
    """Configuration and pack list shared by GET and POST /api/config.

    Blocking (it scans pack folders), so callers run it in a worker thread.
    """
    # get_current_packs_config scans too; holding the lock keeps it from racing a
    # rescan that is clearing pack_loader's object cache in another thread.
    with packs_cache._RESCAN_LOCK:
        config_info = pack_loader.get_current_packs_config()
    registry = packs_cache.get_packs_registry()
    return {
        **config_info,
        # Storage locations are user-configurable so an install on one drive does
        # not scatter working files across the system drive.
        "exports_dir": common.exports_dir(),
        "cache_dir": pack_loader.CACHE_DIR,
        "install_root": pack_loader.get_install_root(),
        "packs": [p.to_dict() for p in registry.values()],
    }


@app.get("/api/config")
async def get_config():
    """Returns the current persistent configuration and pack paths."""
    return {"status": "ok", **(await asyncio.to_thread(_config_payload))}


@app.post("/api/config")
async def update_config(payload: Dict[str, Any], request: Request):
    """
    Updates persistent configuration. Accepts packs_dir and/or exports_dir; at least
    one must be supplied. Previously packs_dir was mandatory, which made it
    impossible to change the export location on its own.
    """
    require_local_request(request)

    packs_dir = (payload.get("packs_dir") or "").strip()
    exports_dir = (payload.get("exports_dir") or "").strip()
    if not packs_dir and not exports_dir:
        raise HTTPException(status_code=400, detail="packs_dir or exports_dir is required")

    messages = []
    count = None

    if exports_dir:
        if not pack_loader._dir_is_writable(exports_dir):
            raise HTTPException(
                status_code=400,
                detail=f"Export folder is not writable: {exports_dir}",
            )
        cfg = pack_loader.load_config()
        cfg["exports_dir"] = exports_dir
        if not pack_loader.save_config(cfg):
            raise HTTPException(status_code=500, detail="Could not persist export folder setting")
        new_exports_dir = common.refresh_exports_dir()
        messages.append(f"Export folder set to {new_exports_dir}")

    if packs_dir:
        success, message, count = await asyncio.to_thread(packs_cache.switch_packs_dir, packs_dir)
        if not success:
            raise HTTPException(status_code=400, detail=message)
        messages.append(message)

    config = await asyncio.to_thread(_config_payload)
    return {
        "status": "ok",
        "message": " | ".join(messages),
        "pack_count": count if count is not None else len(config["packs"]),
        **config,
    }


# Scene pack routes live in dubmate/packs_api.py; registered here so they keep
# their original position (rescan and import ahead of /api/packs/{pack_id}).
app.include_router(packs_api.router)


ACTIVE_TUNNEL_URL: Optional[str] = None

# Why the public tunnel is unavailable, when the desktop shell has told us it
# failed. Without this, a tunnel that never came up was indistinguishable from one
# that is still starting, and the UI said "waiting" forever.
TUNNEL_ERROR: Optional[str] = None

# Public room registry. A code registered here resolves to whichever tunnel the
# host is currently reachable on, which is what lets a guest join with six
# characters instead of a throwaway cloudflared hostname.
WORKER_REGISTRY_BASE = "https://dubmate.bkaproductions.com"

# How often the heartbeat retries rooms that have not been published yet, and how
# stale a published entry may get before it is rewritten to refresh the registry
# TTL (the worker expires entries after 12 hours).
REGISTRY_HEARTBEAT_SECONDS = 20
REGISTRY_REFRESH_SECONDS = 4 * 60 * 60

# Per-room ownership tokens issued by the public worker registry, keyed by room code.
# Presenting the token proves ownership when re-registering an existing code; without
# it the worker refuses to overwrite a live room, which is what prevents a third party
# repointing someone else's room at their own server.
WORKER_ROOM_TOKENS: Dict[str, str] = {}

# Codes created by *this* process, mapped to the app version they were created with.
# Rooms restored from disk on startup are deliberately excluded: those sessions are
# over, and republishing them would only collide with whoever holds the code now.
WORKER_PENDING_ROOMS: Dict[str, str] = {}

# Tunnel URL (and write time) each code is currently published under. Used to skip
# redundant writes, to force a republish when cloudflared hands out a new hostname,
# and to refresh the TTL on long sessions.
WORKER_PUBLISHED_TUNNEL: Dict[str, str] = {}
WORKER_PUBLISHED_AT: Dict[str, float] = {}

# Last registration outcome per code, surfaced through /api/rooms/{code}/share so a
# failure reaches the UI instead of only a console the desktop app keeps hidden.
WORKER_ROOM_STATUS: Dict[str, Dict[str, Any]] = {}

# Serializes registry writes so the tunnel callback and a concurrent room creation
# cannot post the same code twice.
_REGISTRY_LOCK: Optional[asyncio.Lock] = None


def _registry_lock() -> asyncio.Lock:
    """Lazily built so the lock binds to the running server loop, not import time."""
    global _REGISTRY_LOCK
    if _REGISTRY_LOCK is None:
        _REGISTRY_LOCK = asyncio.Lock()
    return _REGISTRY_LOCK


def _load_worker_api_key() -> str:
    """
    Shared key sent to the public room registry as X-DubMate-Key.

    Resolution order:
      1. DUBMATE_WORKER_KEY environment variable. The desktop launcher sets this
         from a value baked in at build time; CI supplies it from a repo secret.
      2. .dubmate.env beside the app (git-ignored) -- convenient for running the
         web version from a source checkout.

    There is deliberately no hardcoded fallback. The previous literal shipped in
    every public build and in git history, so it was never actually a secret.
    Authorization for overwriting a room is the per-room token above; this key
    only throttles casual writes, and an empty value simply means public room
    registration is unavailable rather than insecure.
    """
    from_env = (os.environ.get("DUBMATE_WORKER_KEY") or "").strip()
    if from_env:
        return from_env

    try:
        env_file = os.path.join(pack_loader.get_install_root(), ".dubmate.env")
        if os.path.isfile(env_file):
            with open(env_file, "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    if key.strip() == "DUBMATE_WORKER_KEY":
                        return value.strip().strip('"').strip("'")
    except Exception as ex:
        print(f"[Worker Registry] Could not read .dubmate.env: {ex}")
    return ""


WORKER_API_KEY = _load_worker_api_key()
if not WORKER_API_KEY:
    print(
        "[Worker Registry] No DUBMATE_WORKER_KEY configured. Local and LAN play are "
        "unaffected; public room codes will not be registered with the registry."
    )


# Verdicts that will not change on their own, so the heartbeat stops retrying them
# until the tunnel URL changes and makes the attempt meaningfully different.
TERMINAL_REGISTRY_STATES = ("unauthorized", "conflict")


def _set_room_status(room_id: str, state: str, message: str, tunnel_url: Optional[str] = None) -> None:
    """
    Records why a code is or is not joinable. States are:
      waiting      - queued, the public tunnel has not come up yet
      publishing   - queued, a registry write is in flight or about to be
      registered   - the code resolves to our current tunnel
      unauthorized - the registry rejected our key, so codes are unavailable
      conflict     - somebody else already holds this code
      error        - transient failure; the heartbeat will retry
    """
    WORKER_ROOM_STATUS[room_id.upper()] = {
        "state": state,
        "message": message,
        "tunnel": tunnel_url,
        "updated_at": int(time.time()),
    }


async def register_room_with_worker(room_id: str, tunnel_url: str, app_version: str) -> bool:
    """
    Publishes one room code to the public registry, returning True once the code
    resolves to `tunnel_url`. Callers use the result to decide whether the
    heartbeat should keep retrying.
    """
    code = room_id.upper()
    try:
        import httpx
        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"DubMate Studio Pro/{app_version}",
            "X-DubMate-Key": WORKER_API_KEY,
        }
        # Re-registering our own code (e.g. after a tunnel change) requires proving
        # ownership with the token the worker issued when we first created it.
        existing_token = WORKER_ROOM_TOKENS.get(code)
        if existing_token:
            headers["Authorization"] = f"Bearer {existing_token}"

        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                f"{WORKER_REGISTRY_BASE}/rooms/create",
                headers=headers,
                json={
                    "code": code,
                    "tunnel_url": tunnel_url,
                    "app_version": app_version,
                },
            )
            if resp.status_code in (200, 201):
                try:
                    token = (resp.json() or {}).get("room_token")
                    if token:
                        WORKER_ROOM_TOKENS[code] = token
                except Exception:
                    pass
                WORKER_PUBLISHED_TUNNEL[code] = tunnel_url
                WORKER_PUBLISHED_AT[code] = time.time()
                _set_room_status(code, "registered", "Room code is live. Anyone can join with it.", tunnel_url)
                print(f"[Worker Registry] Unified room code {code} registered with {tunnel_url}")
                return True

            if resp.status_code == 401:
                _set_room_status(
                    code,
                    "unauthorized",
                    "This build has no valid registry key, so public room codes are "
                    "unavailable. Share the direct invite link instead.",
                    tunnel_url,
                )
                print(f"[Worker Registry] Registry rejected our key; room {code} not published.")
                return False

            if resp.status_code == 409:
                _set_room_status(
                    code,
                    "conflict",
                    "That room code is already in use by another host. Create a new room.",
                    tunnel_url,
                )
                print(f"[Worker Registry] Room code {code} is already held by another host; not overwriting.")
                return False

            _set_room_status(
                code,
                "error",
                f"The room registry returned an error ({resp.status_code}). Retrying...",
                tunnel_url,
            )
            print(f"[Worker Registry] Registration rejected ({resp.status_code}): {resp.text[:200]}")
            return False
    except Exception as e:
        _set_room_status(code, "error", "Could not reach the room registry. Retrying...", tunnel_url)
        print(f"[Worker Registry] Note: Could not register with worker: {e}")
        return False


def _needs_publish(code: str, tunnel_url: str) -> bool:
    status = WORKER_ROOM_STATUS.get(code) or {}
    # A rejected key or a code held by someone else will not resolve itself while the
    # tunnel is unchanged, so stop re-asking the registry the same question.
    if status.get("state") in TERMINAL_REGISTRY_STATES and status.get("tunnel") == tunnel_url:
        return False
    if WORKER_PUBLISHED_TUNNEL.get(code) != tunnel_url:
        return True
    # Same tunnel, but the registry entry expires; rewrite it well before it does.
    return (time.time() - WORKER_PUBLISHED_AT.get(code, 0.0)) >= REGISTRY_REFRESH_SECONDS


async def publish_pending_rooms() -> None:
    """
    Publishes every room this process created that is not already live at the
    current tunnel URL.

    This runs on room creation, on every tunnel change, and on a heartbeat rather
    than only at creation time. The desktop app opens the studio as soon as the
    engine answers /health and only *then* starts cloudflared, so a room created in
    the first few seconds has no tunnel to advertise yet; publishing from here is
    what makes those rooms joinable at all.
    """
    async with _registry_lock():
        tunnel = ACTIVE_TUNNEL_URL
        if not tunnel or not tunnel.startswith("https://"):
            for code in WORKER_PENDING_ROOMS:
                if WORKER_ROOM_STATUS.get(code, {}).get("state") in (None, "publishing"):
                    _set_room_status(code, "waiting", "Waiting for the public tunnel to come up...")
            return

        for code, app_version in list(WORKER_PENDING_ROOMS.items()):
            if code not in ROOMS:
                WORKER_PENDING_ROOMS.pop(code, None)
                continue
            if not _needs_publish(code, tunnel):
                continue
            await register_room_with_worker(code, tunnel, app_version)


def schedule_registry_publish() -> None:
    """Fire-and-forget publish, safe to call from any request handler."""
    try:
        asyncio.get_running_loop().create_task(publish_pending_rooms())
    except RuntimeError:
        # No running loop (e.g. imported by a script); the heartbeat will catch up.
        pass


async def registry_heartbeat() -> None:
    """
    Retries codes that have not been published yet and refreshes ones nearing the
    registry TTL. Without this, a single failed publish -- a tunnel that was still
    coming up, or a momentary network blip -- left the room permanently unjoinable
    with nothing to recover it.
    """
    while True:
        try:
            await asyncio.sleep(REGISTRY_HEARTBEAT_SECONDS)
            await publish_pending_rooms()
        except asyncio.CancelledError:
            raise
        except Exception as ex:
            print(f"[Worker Registry] Heartbeat warning: {ex}")


def build_room_share_payload(room_id: str) -> Dict[str, Any]:
    """Everything the UI needs to hand out an invite, including a working fallback."""
    code = room_id.upper()
    default_state = "waiting"
    default_message = "Waiting for the public tunnel to come up..."
    if TUNNEL_ERROR and not ACTIVE_TUNNEL_URL:
        default_state = "tunnel_unavailable"
        default_message = TUNNEL_ERROR
    status = WORKER_ROOM_STATUS.get(code) or {
        "state": default_state,
        "message": default_message,
    }
    # A queued room whose tunnel has since failed should report the failure rather
    # than the stale "waiting".
    if TUNNEL_ERROR and not ACTIVE_TUNNEL_URL and status.get("state") == "waiting":
        status = {"state": "tunnel_unavailable", "message": TUNNEL_ERROR}
    is_live = (
        status.get("state") == "registered"
        and WORKER_PUBLISHED_TUNNEL.get(code) == ACTIVE_TUNNEL_URL
    )
    return {
        "room_id": code,
        "code_is_live": is_live,
        "join_url": f"{WORKER_REGISTRY_BASE}/join/{code}" if is_live else "",
        "direct_url": f"{ACTIVE_TUNNEL_URL}?room={code}" if ACTIVE_TUNNEL_URL else "",
        "tunnel_url": ACTIVE_TUNNEL_URL,
        "state": status.get("state"),
        "message": status.get("message"),
    }


@app.post("/api/tunnel")
async def set_tunnel_endpoint(payload: Dict[str, Any]):
    global ACTIVE_TUNNEL_URL, TUNNEL_ERROR
    url = payload.get("tunnel_url")
    if url:
        new_url = str(url).strip()
        if new_url != ACTIVE_TUNNEL_URL:
            ACTIVE_TUNNEL_URL = new_url
            print(f"[DubMate] Active public tunnel registered: {ACTIVE_TUNNEL_URL}")
        TUNNEL_ERROR = None
        # Drain the publish queue: rooms created before the tunnel existed become
        # joinable here, and a changed hostname republishes every live code.
        schedule_registry_publish()
        return {"status": "ok", "tunnel_url": ACTIVE_TUNNEL_URL}

    # The desktop shell reports tunnel failures here too, so a room that can never
    # be published says why instead of waiting indefinitely.
    reported_error = payload.get("error")
    if reported_error:
        TUNNEL_ERROR = str(reported_error).strip()[:300]
        print(f"[DubMate] Public tunnel unavailable: {TUNNEL_ERROR}")

    return {"status": "ok", "tunnel_url": ACTIVE_TUNNEL_URL, "error": TUNNEL_ERROR}


@app.post("/api/rooms")
async def create_room(payload: Dict[str, Any]):
    pack_id = payload.get("pack_id")
    host_name = payload.get("host_name", "Host").strip() or "Host"
    host_color = common.sanitize_color(payload.get("host_color"), "#7c5cff")
    app_version = common.read_version()

    pack = packs_cache.pack_or_404(pack_id, "Selected pack not found")

    async with _ROOM_CREATE_LOCK:
        room_id = generate_room_code()
        # Prune any previous session recordings from disk and RAM so only the new session is kept
        await asyncio.to_thread(prune_sessions, keep_room_id=room_id)

        host_id = str(uuid.uuid4())[:8]
        room = Room(room_id, pack, host_id, host_name, host_color)
        ROOMS[room_id] = room

    # Queue the code for the public registry instead of gating on the tunnel already
    # being up. publish_pending_rooms() sends it now if it can, and /api/tunnel or the
    # heartbeat sends it the moment the tunnel becomes available.
    WORKER_PENDING_ROOMS[room_id.upper()] = app_version
    _set_room_status(
        room_id,
        "publishing" if ACTIVE_TUNNEL_URL else "waiting",
        "Publishing room code to the registry..." if ACTIVE_TUNNEL_URL
        else "Waiting for the public tunnel to come up...",
    )
    schedule_registry_publish()

    return {
        "room_id": room_id,
        "user_id": host_id,
        "tunnel_url": ACTIVE_TUNNEL_URL,
        "share": build_room_share_payload(room_id),
        "state": room.to_state_dict(),
    }


@app.get("/api/rooms/{room_id}/share")
async def get_room_share(room_id: str):
    """Invite details for a room hosted here, including why a code may not be live yet."""
    code = (room_id or "").upper()
    if code not in ROOMS:
        raise HTTPException(status_code=404, detail="Room not found")
    return build_room_share_payload(code)


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    room = _room_or_404(room_id)
    return room.to_state_dict()


@app.post("/api/rooms/{room_id}/noise_profile")
async def upload_noise_profile(
    room_id: str,
    file: UploadFile = File(...),
    user_id: str = Form(...),
):
    """Calibrates and saves a 1-second room background noise profile for an actor."""
    common.require_safe_identifier(user_id, "user_id")
    room = _room_or_404(room_id)
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
    common.require_safe_identifier(user_id, "user_id")
    room = _room_or_404(room_id)

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
        async with room.processing_lock:
            saved = await asyncio.to_thread(
                audio_processor.save_uploaded_take,
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

    room.invalidate_exports()
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
    room = _room_or_404(room_id)
    if line_index not in room.takes:
        raise HTTPException(status_code=404, detail="Take not found")

    enable = bool(payload.get("noise_reduction", False))
    take = room.takes[line_index]
    user_id = take.get("user_id", "host")

    try:
        async with room.processing_lock:
            toggled = await asyncio.to_thread(
                audio_processor.toggle_take_noise_reduction,
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
        room.invalidate_exports()
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
    room = _room_or_404(room_id)
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
    room = _room_or_404(room_id)
    take = room.takes.get(line_index)
    if not take or not os.path.exists(take.get("wav_path", "")):
        raise HTTPException(status_code=404, detail="Take not found")
    
    # If versioned query param (?v=...) is present, the audio file is uniquely fingerprinted
    # and safe to cache heavily by browsers and Cloudflare edge CDN.
    cache_ctrl = common.LONG_CACHE if "v" in request.query_params else "no-cache, must-revalidate"
    return common.range_stream_file(
        take["wav_path"],
        request,
        media_type="audio/wav",
        cache_control=cache_ctrl
    )


@app.post("/api/rooms/{room_id}/export")
async def export_room_dub(room_id: str, aspect_ratio: str = "16:9", presence: float = 0.0):
    """Renders the final dubbed scene into MP4 (16:9 cinema or 9:16 shorts) asynchronously."""
    room = _room_or_404(room_id)

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


@app.get("/api/rooms/{room_id}/export/status")
async def get_export_status(room_id: str, aspect_ratio: str = "16:9"):
    """Pollable endpoint for export status to prevent Cloudflare 524 timeouts."""
    room = _room_or_404(room_id)

    if room.ready_export_path(aspect_ratio):
        return {"status": "ready", **room.export_ready_payload(aspect_ratio)}

    status = room.export_status.get(aspect_ratio, "idle")
    return {
        "status": status,
        "aspect_ratio": aspect_ratio,
    }


@app.get("/api/rooms/{room_id}/export/video")
async def get_room_exported_video(room_id: str, request: Request, aspect_ratio: str = "16:9"):
    """Streams the rendered master MP4 video with Range support for theater playback."""
    room = _room_or_404(room_id)

    target_path = room.ready_export_path(aspect_ratio) or room.ready_export_path("16:9")
    if not target_path:
        raise HTTPException(status_code=404, detail="Exported video not found")

    return common.range_stream_file(
        target_path,
        request,
        media_type="video/mp4",
        cache_control="no-cache, must-revalidate"
    )


@app.get("/api/rooms/{room_id}/export/download")
async def download_room_dub(room_id: str, aspect_ratio: str = "16:9"):
    room = _room_or_404(room_id)

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
            room.pack, dict(room.takes), out_path,
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


@app.get("/api/rooms/{room_id}/export/project_zip")
async def download_room_project_zip(room_id: str):
    """
    Assembles and streams a complete multi-track NLE project ZIP containing stems, video, markers.
    """
    room = _room_or_404(room_id)

    zip_filename = f"DubMate_Project_{room.pack.pack_id}_{room.room_id}.zip"
    zip_path = os.path.join(common.exports_dir(), zip_filename)

    try:
        await asyncio.to_thread(
            functools.partial(
                audio_processor.build_project_zip,
                pack=room.pack,
                takes_dict=dict(room.takes),
                role_assignments=room.role_assignments,
                users=room.users,
                output_zip_path=zip_path,
                room_id=room.room_id,
                bitrate="192k",
            )
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
            try:
                data = json.loads(raw)
                msg_type = data.get("type")
                payload = data.get("payload", {})
            except Exception as ex:
                print(f"[WS] {room_id}/{user_id} ignored malformed message: {ex!r}")
                continue

            if msg_type == "join":
                name = payload.get("name", "Actor").strip() or "Actor"
                color = common.sanitize_color(payload.get("color"), "#25d3a4")

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

            elif msg_type == "assign_role":
                if user_id != room.host_id and room.host_id != "host":
                    await websocket.send_json({
                        "type": "error",
                        "payload": {"message": "Only the host can assign roles."},
                    })
                    continue
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
                    room.invalidate_exports()
                    await room.broadcast("take_params_updated", {"line_index": line_idx})

            elif msg_type == "clear_take":
                raw_idx = payload.get("line_index")
                try:
                    line_idx = int(raw_idx)
                except (TypeError, ValueError):
                    line_idx = None
                if line_idx is not None and line_idx in room.takes:
                    del room.takes[line_idx]
                    room.invalidate_exports()
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
                        out_path = room.export_out_path("16:9")
                        await asyncio.to_thread(
                            audio_processor.export_dub_video,
                            room.pack, dict(room.takes), out_path,
                        )
                        room.exported_video_path = out_path
                        await room.broadcast("export_ready", room.export_ready_payload("16:9"))
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
                try:
                    presence_db = float(payload.get("presence_db", 0.0))
                except (TypeError, ValueError) as ex:
                    print(f"[WS] {room_id}/{user_id} ignored bad presence_db: {ex!r}")
                    continue
                room.master_dialogue_presence_db = max(-12.0, min(12.0, presence_db))
                room.invalidate_exports()
                await room.broadcast("dialogue_presence_sync", {
                    "presence_db": room.master_dialogue_presence_db,
                    "triggered_by": user_id
                })

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except (WebSocketDisconnect, ConnectionResetError, asyncio.CancelledError):
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        await room.broadcast("user_disconnected", {"user_id": user_id})
    except Exception as ex:
        print(f"[WS] {room_id}/{user_id} handler error: {ex!r}")
        traceback.print_exc()
        room.sockets.discard(websocket)
        if user_id in room.users:
            room.users[user_id]["is_online"] = False
        try:
            await room.broadcast("user_disconnected", {"user_id": user_id})
        except Exception:
            pass


# Pack Builder routes live in dubmate/builder_api.py; registered here to keep
# their position ahead of the static routes and the root StaticFiles mount.
app.include_router(builder_api.router)


@app.get("/")
@app.get("/index.html")
async def serve_root_index():
    static_dir = STATIC_DIR
    index_file = os.path.join(static_dir, "index.html")
    if os.path.isfile(index_file):
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail=f"index.html not found in {static_dir}")


@app.get("/builder.html")
async def serve_builder_index():
    static_dir = STATIC_DIR
    builder_file = os.path.join(static_dir, "builder.html")
    if os.path.isfile(builder_file):
        return FileResponse(builder_file, media_type="text/html")
    raise HTTPException(status_code=404, detail=f"builder.html not found in {static_dir}")


@app.get("/css/{file_path:path}")
async def serve_static_css(file_path: str):
    static_dir = STATIC_DIR
    full_path = common.safe_join(static_dir, "css", file_path)
    if os.path.isfile(full_path):
        return FileResponse(full_path, media_type="text/css")
    raise HTTPException(status_code=404, detail="CSS file not found")


@app.get("/js/{file_path:path}")
async def serve_static_js(file_path: str):
    static_dir = STATIC_DIR
    full_path = common.safe_join(static_dir, "js", file_path)
    if os.path.isfile(full_path):
        return FileResponse(full_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="JS file not found")


# Mount static assets as general fallback
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static_root")


if __name__ == "__main__":
    import uvicorn
    # High-performance production mode: eliminates file polling over pack assets
    uvicorn.run("app:app", host="0.0.0.0", port=get_engine_port(), reload=False, access_log=False)
