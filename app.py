# -*- coding: utf-8 -*-
"""
app.py
FastAPI + WebSocket backend server for DubMate Multiplayer Studio.
"""

import os
import sys
import time
import asyncio
import threading
from typing import Dict, Any
from contextlib import asynccontextmanager

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import pack_loader
from dubmate import common, packs_cache, rooms, room_registry, builder_api, packs_api, rooms_api, room_ws, noise_profiles_api, sessions_api

STATIC_DIR = common.find_static_dir()

try:
    os.makedirs(STATIC_DIR, exist_ok=True)
except Exception:
    pass


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
    rooms.load_persisted_rooms()

    # Keeps retrying room codes that could not be published on the first attempt,
    # so a slow tunnel or a network blip does not leave a room unjoinable forever.
    heartbeat = asyncio.create_task(room_registry.registry_heartbeat())
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


def _config_payload(local: bool) -> Dict[str, Any]:
    """Configuration and pack list shared by GET and POST /api/config.

    Off the engine's own computer (local=False) it is only the pack list: the folders
    and the mic sync results belong to the host's machine.
    Blocking (it scans pack folders), so callers run it in a worker thread.
    """
    # get_current_packs_config scans too; holding the lock keeps it from racing a
    # rescan that is clearing pack_loader's object cache in another thread.
    with packs_cache._RESCAN_LOCK:
        config_info = pack_loader.get_current_packs_config()
    registry = packs_cache.get_packs_registry()
    packs = [p.to_dict() for p in registry.values()]
    if not local:
        return {"pack_count": len(packs), "packs": packs}
    mic_sync = pack_loader.load_config().get("mic_sync")
    return {
        **config_info,
        # Storage locations are user-configurable so an install on one drive does
        # not scatter working files across the system drive.
        "exports_dir": common.exports_dir(),
        "cache_dir": pack_loader.CACHE_DIR,
        "install_root": pack_loader.get_install_root(),
        # Measured mic delay per microphone|output pair (Audio settings, Sync your mic).
        "mic_sync": mic_sync if isinstance(mic_sync, dict) else {},
        "packs": packs,
    }


MIC_SYNC_MAX_PAIRS = 20


def _valid_mic_sync(value: Any) -> Dict[str, Dict[str, Any]]:
    """Checks a {"<mic>|<output>": {latency_ms, method, measured_at}} map; 400 on a bad entry."""
    bad = HTTPException(status_code=400, detail="That sync result could not be saved.")
    if not isinstance(value, dict):
        raise bad
    entries = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 200 or not isinstance(entry, dict):
            raise bad
        latency = entry.get("latency_ms")
        measured = entry.get("measured_at")
        if (not isinstance(latency, int) or isinstance(latency, bool) or not 0 <= latency <= 800
                or entry.get("method") not in ("clicks", "claps")
                or not isinstance(measured, int) or isinstance(measured, bool)):
            raise bad
        entries[key] = {"latency_ms": latency, "method": entry["method"], "measured_at": measured}
    return entries


@app.get("/api/config")
async def get_config(request: Request):
    """Returns the current persistent configuration and pack paths; other computers get
    the pack list only."""
    local = common.is_own_computer(request)
    return {"status": "ok", **(await asyncio.to_thread(_config_payload, local))}


@app.post("/api/config")
async def update_config(payload: Dict[str, Any], request: Request):
    """
    Updates persistent configuration. Accepts packs_dir, exports_dir and/or mic_sync;
    at least one must be supplied. Previously packs_dir was mandatory, which made it
    impossible to change the export location on its own.
    """
    common.require_own_computer(request)

    packs_dir = (payload.get("packs_dir") or "").strip()
    exports_dir = (payload.get("exports_dir") or "").strip()
    mic_sync = payload.get("mic_sync")
    if not packs_dir and not exports_dir and mic_sync is None:
        raise HTTPException(status_code=400, detail="Enter a folder path.")

    messages = []
    count = None

    if mic_sync is not None:
        entries = _valid_mic_sync(mic_sync)
        cfg = pack_loader.load_config()
        old = cfg.get("mic_sync") if isinstance(cfg.get("mic_sync"), dict) else {}
        stored = {k: v for k, v in old.items() if isinstance(v, dict)}
        stored.update(entries)
        # Keep the most recently measured pairs.
        newest = sorted(stored.items(), reverse=True,
                        key=lambda kv: kv[1]["measured_at"] if isinstance(kv[1].get("measured_at"), int) else 0)
        cfg["mic_sync"] = dict(newest[:MIC_SYNC_MAX_PAIRS])
        if not pack_loader.save_config(cfg):
            raise HTTPException(status_code=500, detail="That sync result could not be saved.")

    if exports_dir:
        if not pack_loader._dir_is_writable(exports_dir):
            raise HTTPException(
                status_code=400,
                detail=f"DubMate can't save to {exports_dir}. Choose another folder.",
            )
        cfg = pack_loader.load_config()
        cfg["exports_dir"] = exports_dir
        if not pack_loader.save_config(cfg):
            raise HTTPException(status_code=500, detail="Couldn't save the export folder. Try again.")
        new_exports_dir = common.refresh_exports_dir()
        messages.append(f"Export folder set to {new_exports_dir}.")

    if packs_dir:
        success, message, count = await asyncio.to_thread(packs_cache.switch_packs_dir, packs_dir)
        if not success:
            raise HTTPException(status_code=400, detail=message)
        messages.append(message)

    config = await asyncio.to_thread(_config_payload, True)
    return {
        "status": "ok",
        "message": " | ".join(messages),
        "pack_count": count if count is not None else len(config["packs"]),
        **config,
    }


# Scene pack routes live in dubmate/packs_api.py; registered here so they keep
# their original position (rescan and import ahead of /api/packs/{pack_id}).
app.include_router(packs_api.router)

# Public tunnel and room registry (POST /api/tunnel) live in dubmate/room_registry.py;
# registered here so the route keeps its original position.
app.include_router(room_registry.router)


# Room REST routes and the room WebSocket live in dubmate/rooms_api.py and
# dubmate/room_ws.py; registered here so they keep their original position.
app.include_router(rooms_api.router)
# Recent sessions (list, continue, remove) live in dubmate/sessions_api.py.
app.include_router(sessions_api.router)
app.include_router(room_ws.router)

# Room check (noise profile) routes live in dubmate/noise_profiles_api.py.
app.include_router(noise_profiles_api.router)


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
