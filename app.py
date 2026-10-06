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
import asyncio
import functools
import threading
import traceback
from typing import Dict, Any
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
from dubmate import common, packs_cache, rooms, room_registry, builder_api, packs_api

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


# create_room prunes old sessions in a worker thread; serializing creation keeps a
# concurrent create from inserting a room that an older prune then removes.
_ROOM_CREATE_LOCK = asyncio.Lock()


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

# Public tunnel and room registry (POST /api/tunnel) live in dubmate/room_registry.py;
# registered here so the route keeps its original position.
app.include_router(room_registry.router)


@app.post("/api/rooms")
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
        "Publishing room code to the registry..." if room_registry.ACTIVE_TUNNEL_URL
        else "Waiting for the public tunnel to come up...",
    )
    room_registry.schedule_registry_publish()

    return {
        "room_id": room_id,
        "user_id": host_id,
        "tunnel_url": room_registry.ACTIVE_TUNNEL_URL,
        "share": room_registry.build_room_share_payload(room_id),
        "state": room.to_state_dict(),
    }


@app.get("/api/rooms/{room_id}/share")
async def get_room_share(room_id: str):
    """Invite details for a room hosted here, including why a code may not be live yet."""
    code = (room_id or "").upper()
    if code not in rooms.ROOMS:
        raise HTTPException(status_code=404, detail="Room not found")
    return room_registry.build_room_share_payload(code)


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    room = rooms.room_or_404(room_id)
    return room.to_state_dict()


@app.post("/api/rooms/{room_id}/noise_profile")
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
    room = rooms.room_or_404(room_id)

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
    room = rooms.room_or_404(room_id)
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
    room = rooms.room_or_404(room_id)
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
    room = rooms.room_or_404(room_id)
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
    room = rooms.room_or_404(room_id)

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


@app.get("/api/rooms/{room_id}/export/download")
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
    room = rooms.room_or_404(room_id)

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
    room = rooms.ROOMS.get(room_id.upper())

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
