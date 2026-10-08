# -*- coding: utf-8 -*-
"""
dubmate/common.py
Shared request-safety helpers, the static folder, version, cache constants, range
streaming and the configured exports folder.

Paths are anchored on pack_loader.BASE_DIR (the folder holding app.py), never on
this file's location.
"""

import os
import re
from typing import Any, Optional

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

import pack_loader

# Cache-Control for immutable or versioned media (pack assets, fingerprinted takes).
LONG_CACHE = "public, max-age=86400, stale-while-revalidate=604800"

# Extension -> MIME for served pack/builder assets. Unknown extensions keep their
# historical fallbacks (image/webp for images, audio/ogg for audio), so images and
# audio use separate tables.
IMAGE_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
AUDIO_MEDIA_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav"}


def find_static_dir() -> str:
    """Finds the static assets folder across dev, bundled desktop, and installed directory structures."""
    base_dir = pack_loader.BASE_DIR
    candidates = [
        os.path.join(base_dir, "static"),
        os.path.join(base_dir, "static", "static"),
        base_dir,
        os.path.join(base_dir, "resources", "static"),
        os.path.join(os.path.dirname(base_dir), "static"),
        os.path.join(os.path.dirname(base_dir), "static", "static"),
        os.path.join(os.path.dirname(base_dir), "resources", "static"),
        os.path.join(os.getcwd(), "static"),
        os.path.join(os.getcwd(), "resources", "static"),
    ]
    for c in candidates:
        if os.path.isdir(c) and os.path.isfile(os.path.join(c, "index.html")):
            return os.path.abspath(c)
    return os.path.join(base_dir, "static")


def read_version() -> str:
    version_path = os.path.join(pack_loader.BASE_DIR, "VERSION")
    try:
        with open(version_path, "r", encoding="utf-8") as f:
            return f.read().strip().lstrip("\ufeff")
    except Exception:
        return "1.0.0"


_UNSAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]")


def sanitize_identifier(value: str, max_len: int = 64) -> str:
    """
    Reduces a client-supplied identifier to a token that is safe to embed in a
    filename. Windows normalises '..' lexically, so an unsanitised id like
    '../../x' escapes its directory even when glued behind a filename prefix.
    """
    return _UNSAFE_ID_RE.sub("_", (value or "").strip())[:max_len]


def require_safe_identifier(value: str, field: str = "identifier") -> str:
    """
    Rejects a client-supplied id that is not a plain token. Rejecting rather than
    rewriting matters: these ids are also compared against role assignments and
    room.host_id, so silently transforming one would change authorization results.
    """
    if not value or _UNSAFE_ID_RE.search(value) or len(value) > 64:
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    return value


def safe_join(base_dir: str, *user_parts: str) -> str:
    """
    Joins client-supplied path fragments under base_dir and verifies the result
    cannot escape it, raising 400 rather than returning an outside path.

    Containment is checked with realpath because component-level filtering is
    not sufficient on Windows: a backslash is a path separator there but is
    not a URL separator, so one URL segment can still traverse directories.
    Backslashes are rejected outright on every OS: no served file name contains
    one, and on POSIX a name like '..\\..\\x' stays inside base_dir, so the
    containment check alone would treat the same request differently per platform.
    """
    for part in user_parts:
        if part is None or chr(0) in part or "\\" in part:
            raise HTTPException(status_code=400, detail="Invalid path")

    candidate = os.path.join(base_dir, *user_parts)
    base_real = os.path.realpath(base_dir)
    cand_real = os.path.realpath(candidate)
    if cand_real != base_real and not cand_real.startswith(base_real + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")
    return cand_real


def _etag_matches(if_none_match: Optional[str], etag: str) -> bool:
    """
    RFC 9110 If-None-Match comparison: a comma-separated list, "*" matches anything,
    and a weak validator (W/"...") compares equal to its strong form.
    """
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True

    def normalize(value: str) -> str:
        value = value.strip()
        return value[2:] if value.startswith("W/") else value

    target = normalize(etag)
    return any(normalize(candidate) == target for candidate in if_none_match.split(","))


def range_stream_file(
    file_path: str,
    request: Request,
    media_type: str,
    cache_control: str = LONG_CACHE
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


# Configured exports folder. Read through exports_dir(), never imported by name:
# POST /api/config rebinds it via refresh_exports_dir().
_exports_dir: Optional[str] = None


def exports_dir() -> str:
    global _exports_dir
    if _exports_dir is None:
        _exports_dir = pack_loader.get_exports_dir()
        try:
            os.makedirs(_exports_dir, exist_ok=True)
        except Exception:
            pass
    return _exports_dir


def refresh_exports_dir() -> str:
    """Re-reads the configured exports folder after a config change and creates it."""
    global _exports_dir
    _exports_dir = pack_loader.get_exports_dir()
    os.makedirs(_exports_dir, exist_ok=True)
    return _exports_dir


_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def is_own_computer(request: Request) -> bool:
    """True only for a request made on this computer by DubMate's own page: no Cloudflare
    tunnel headers, a loopback Host, and an Origin that is absent or the same as the Host.
    Refuses tunnel guests, LAN devices, DNS-rebinding pages and other sites calling
    127.0.0.1."""
    headers = request.headers
    if "cf-ray" in headers or "cf-connecting-ip" in headers:
        return False
    host = (headers.get("host") or "").strip()
    if host.startswith("["):
        hostname = host[1:host.find("]")] if "]" in host else ""
    else:
        hostname = host.rsplit(":", 1)[0] if ":" in host else host
    if hostname.lower() not in _LOOPBACK_HOSTS:
        return False
    origin = headers.get("origin")
    return origin is None or origin == "http://" + host


def require_own_computer(request: Request) -> None:
    """Refuses (403) a request that is_own_computer() doesn't accept."""
    if not is_own_computer(request):
        raise HTTPException(status_code=403, detail="This only works on the host's computer.")
