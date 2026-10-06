# -*- coding: utf-8 -*-
"""
dubmate/packs_cache.py
In-memory registry of installed scene packs.

Always read the registry as `packs_cache.PACKS_CACHE` (module attribute) or via
get_packs_registry(). It is rebound, never mutated in place, so a
`from dubmate.packs_cache import PACKS_CACHE` would keep a stale dict forever.
"""

import threading
from typing import Dict, Optional

from fastapi import HTTPException

import pack_loader

PACKS_CACHE: Dict[str, pack_loader.PackInfo] = {}

# Serializes pack-folder scans. A scan builds a fresh dict that is then rebound to
# PACKS_CACHE in one assignment, never mutated in place, so readers that grabbed a
# reference keep a consistent registry while a rescan runs in a worker thread.
_RESCAN_LOCK = threading.Lock()


def get_packs_registry(force_rescan: bool = False) -> Dict[str, pack_loader.PackInfo]:
    global PACKS_CACHE
    if force_rescan or not PACKS_CACHE:
        with _RESCAN_LOCK:
            fresh = pack_loader.get_all_packs(force_disk_scan=force_rescan)
            PACKS_CACHE = fresh
        return fresh
    return PACKS_CACHE


def refresh_packs() -> Dict[str, pack_loader.PackInfo]:
    """Rescans the pack folders into a fresh registry (startup load)."""
    global PACKS_CACHE
    with _RESCAN_LOCK:
        PACKS_CACHE = pack_loader.get_all_packs()
    return PACKS_CACHE


def switch_packs_dir(packs_dir: str):
    """
    Points pack_loader at a new packs folder and, on success, rescans it from disk.
    Both happen under the rescan lock so no other scan interleaves with the switch.
    Returns pack_loader.set_custom_packs_dir's (success, message, count).
    """
    global PACKS_CACHE
    with _RESCAN_LOCK:
        result = pack_loader.set_custom_packs_dir(packs_dir)
        if result[0]:
            PACKS_CACHE = pack_loader.get_all_packs(force_disk_scan=True)
    return result


def find_pack(pack_id: str) -> Optional[pack_loader.PackInfo]:
    return PACKS_CACHE.get(pack_id) or get_packs_registry().get(pack_id)


def pack_or_404(pack_id: str, detail: str = "Pack not found") -> pack_loader.PackInfo:
    pack = find_pack(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail=detail)
    return pack
