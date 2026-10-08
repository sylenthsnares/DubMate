# -*- coding: utf-8 -*-
"""
dubmate/data_folders.py
"Where your data lives" in About: the real folders DubMate uses on this computer
(GET /api/data-folders) and opening one in the file manager (POST /api/data-folders/open).

Both routes are for the engine's own computer only, so a tunnel guest or a LAN device never
learns the host's paths. Open takes a folder key, never a path. Every path comes from
data_folders(), the one place to change when the data root moves. Never imports app.
"""

import os
import subprocess
import sys
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request

import pack_loader
from dubmate import common

router = APIRouter()


def data_folders() -> List[Dict[str, Any]]:
    """The folders DubMate keeps your work and settings in: [{key, label, path, exists}]."""
    rows = [
        ("rooms", "Rooms and takes", os.path.join(pack_loader.CACHE_DIR, "rooms")),
        ("exports", "Saved videos", common.exports_dir()),
    ]
    for i, packs_dir in enumerate(pack_loader.PACKS_DIRS):
        rows.append(("packs" if i == 0 else f"packs-{i + 1}", "Scene packs", packs_dir))
    rows.append(("settings", "Settings", os.path.dirname(pack_loader.get_config_path())))
    import pack_builder  # already loaded by the builder routes; imported here to keep this module light
    addon = pack_builder._addon_dir()
    if addon:
        rows.append(("addon", "Pack Builder add-on", addon))
    rows.append(("data", "Everything else", pack_loader.CACHE_DIR))
    return [{"key": key, "label": label, "path": os.path.normpath(path), "exists": os.path.isdir(path)}
            for key, label, path in rows]


def open_folder(path: str) -> None:
    """Opens the system file manager on the folder itself."""
    if sys.platform == "win32":
        subprocess.Popen(["explorer", path])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


@router.get("/api/data-folders")
async def list_data_folders(request: Request):
    common.require_own_computer(request)
    return {"folders": data_folders()}


@router.post("/api/data-folders/open")
async def open_data_folder(payload: Dict[str, Any], request: Request):
    """Opens one of data_folders() by its key. Any path in the body is ignored."""
    common.require_own_computer(request)
    key = payload.get("key")
    folder = next((f for f in data_folders() if f["key"] == key), None)
    if folder is None:
        raise HTTPException(status_code=400, detail="That folder isn't one DubMate uses.")
    if not os.path.isdir(folder["path"]):
        raise HTTPException(status_code=404, detail="That folder doesn't exist yet.")
    open_folder(folder["path"])
    return {"status": "ok"}
