# -*- coding: utf-8 -*-
"""
dubmate/room_registry.py
Public tunnel state, the worker room registry (publish, heartbeat, share payload)
and POST /api/tunnel.

ACTIVE_TUNNEL_URL, TUNNEL_ERROR, WORKER_REGISTRY_BASE and WORKER_API_KEY are
rebound at runtime (and by tests), so always read them as `room_registry.X`.
"""

import os
import time
import asyncio
from typing import Dict, Optional, Any

from fastapi import APIRouter

import pack_loader
from dubmate import rooms

router = APIRouter()


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
# Rooms restored from disk (at startup or by Continue) are deliberately excluded and
# stay unpublished: their ownership token died with the earlier run, so republishing
# would only collide with whoever holds the code now. Their share payload reports
# "not_published" and invites use the direct link.
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
    A restored room has no status and isn't queued; build_room_share_payload reports it
    as not_published (the code isn't published again, the direct link still works).
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
                    "Room codes aren't available. "
                    "Share the invite link instead.",
                    tunnel_url,
                )
                print(f"[Worker Registry] Registry rejected our key; room {code} not published.")
                return False

            if resp.status_code == 409:
                _set_room_status(
                    code,
                    "conflict",
                    "That room code is already taken. Create a new room.",
                    tunnel_url,
                )
                print(f"[Worker Registry] Room code {code} is already held by another host; not overwriting.")
                return False

            _set_room_status(
                code,
                "error",
                "Couldn't publish your room code. Retrying.",
                tunnel_url,
            )
            print(f"[Worker Registry] Registration rejected ({resp.status_code}): {resp.text[:200]}")
            return False
    except Exception as e:
        _set_room_status(code, "error", "Couldn't publish your room code. Retrying.", tunnel_url)
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
                    _set_room_status(code, "waiting", "Getting your room code ready.")
            return

        for code, app_version in list(WORKER_PENDING_ROOMS.items()):
            if code not in rooms.ROOMS:
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
    default_message = "Getting your room code ready."
    if code not in WORKER_ROOM_STATUS and code not in WORKER_PENDING_ROOMS:
        # A room restored from disk: its code was published by an earlier run. Copy
        # invite only has a working link to offer once a tunnel is up.
        default_state = "not_published"
        default_message = (
            "Room codes stop working when DubMate closes. Copy invite gives a link that works now."
            if ACTIVE_TUNNEL_URL else
            "Room codes stop working when DubMate closes. Only people on your network can join for now."
        )
    # A failed tunnel wins: without it there is no link that works now either.
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


@router.post("/api/tunnel")
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
