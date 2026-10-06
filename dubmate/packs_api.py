# -*- coding: utf-8 -*-
"""
dubmate/packs_api.py
Scene pack routes (/api/packs/*): listing, rescan, import, media and zip export.

Reads the registry through dubmate.packs_cache and never imports app.
"""

import os
import json
import asyncio
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse

import pack_loader
from dubmate import common, packs_cache

router = APIRouter()


@router.get("/api/packs")
async def list_packs(rescan: bool = False):
    """Returns list of available dub packs, using fast memory registry or on-demand rescan."""
    registry = await asyncio.to_thread(packs_cache.get_packs_registry, rescan)
    return [p.to_dict() for p in registry.values()]


@router.post("/api/packs/rescan")
@router.get("/api/packs/rescan")
async def rescan_packs():
    """Forces an immediate on-demand rescan of the packs directory."""
    registry = await asyncio.to_thread(packs_cache.get_packs_registry, True)
    scanned_folders = [os.path.abspath(d) for d in pack_loader.PACKS_DIRS if os.path.exists(d)]
    return {
        "status": "ok",
        "count": len(registry),
        "packs": [p.to_dict() for p in registry.values()],
        "scanned_paths": scanned_folders,
        "message": f"Found {len(registry)} scene packs.",
    }


@router.post("/api/packs/import")
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
        raise HTTPException(status_code=400, detail="No file was uploaded.")

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

        result = await asyncio.to_thread(pack_loader.import_pack_folder_tree, file_tuples)
        await asyncio.to_thread(packs_cache.get_packs_registry, True)
        return result

    # 2. Check if all uploaded files are .zip archives
    all_zip = all(f.filename and f.filename.lower().endswith(".zip") for f in uploaded_files)
    if not all_zip and len(uploaded_files) > 1:
        # Multiple loose files without explicit paths
        file_tuples = []
        for uf in uploaded_files:
            content = await uf.read()
            file_tuples.append((content, uf.filename or "unknown"))
        result = await asyncio.to_thread(pack_loader.import_pack_folder_tree, file_tuples)
        await asyncio.to_thread(packs_cache.get_packs_registry, True)
        return result

    # 3. Batch or single .zip import
    if len(uploaded_files) == 1 and uploaded_files[0].filename and uploaded_files[0].filename.lower().endswith(".zip"):
        single_file = uploaded_files[0]
        try:
            content = await single_file.read()
            if len(content) > pack_loader.MAX_ARCHIVE_SIZE_BYTES:
                raise HTTPException(status_code=413, detail="That file is over the 500 MB limit.")

            pack = await asyncio.to_thread(pack_loader.import_pack_archive, content, single_file.filename)
            if not pack:
                raise HTTPException(status_code=422, detail="That .zip doesn't contain a scene pack.")

            await asyncio.to_thread(packs_cache.get_packs_registry, True)
            return {
                "status": "ok",
                "message": f"Imported '{pack.name}'.",
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
            raise HTTPException(status_code=500, detail="Couldn't import that pack. Check the file and try again.")

    # Multi-zip batch upload
    archive_tuples = []
    for uf in uploaded_files:
        if uf.filename and uf.filename.lower().endswith(".zip"):
            content = await uf.read()
            archive_tuples.append((content, uf.filename))

    if not archive_tuples:
        raise HTTPException(status_code=400, detail="Choose a .zip file.")

    result = await asyncio.to_thread(pack_loader.import_multiple_pack_archives, archive_tuples)
    await asyncio.to_thread(packs_cache.get_packs_registry, True)
    return result


@router.get("/api/packs/{pack_id}")
async def get_pack(pack_id: str):
    return packs_cache.pack_or_404(pack_id).to_dict()


@router.get("/api/packs/{pack_id}/icon")
async def get_pack_icon(pack_id: str):
    """Serves pack cover art / icon."""
    pack = packs_cache.find_pack(pack_id)
    if not pack or not pack.icon_path or not os.path.exists(pack.icon_path):
        raise HTTPException(status_code=404, detail="Icon not found")
    
    ext = os.path.splitext(pack.icon_path)[1].lower()
    media_type = common.IMAGE_MEDIA_TYPES.get(ext, "image/webp")
    return FileResponse(
        pack.icon_path,
        media_type=media_type,
        headers={"Cache-Control": common.LONG_CACHE}
    )


@router.get("/api/packs/{pack_id}/video")
async def get_pack_video(pack_id: str, request: Request):
    """Streams pack video with full HTTP 206 Range support for frame seeking."""
    pack = packs_cache.find_pack(pack_id)
    if not pack or not pack.web_video_path or not os.path.exists(pack.web_video_path):
        raise HTTPException(status_code=404, detail="Video not found")
    return common.range_stream_file(
        pack.web_video_path,
        request,
        media_type="video/mp4",
        cache_control=common.LONG_CACHE
    )


@router.get("/api/packs/{pack_id}/backing")
async def get_pack_backing(pack_id: str, request: Request):
    pack = packs_cache.find_pack(pack_id)
    if not pack or not pack.backing_track_path or not os.path.exists(pack.backing_track_path):
        raise HTTPException(status_code=404, detail="Backing track not found")
    ext = os.path.splitext(pack.backing_track_path)[1].lower()
    media_type = common.AUDIO_MEDIA_TYPES.get(ext, "audio/ogg")
    return common.range_stream_file(
        pack.backing_track_path,
        request,
        media_type=media_type,
        cache_control=common.LONG_CACHE
    )


@router.get("/api/packs/{pack_id}/audio/{filename}")
async def get_pack_audio_line(pack_id: str, filename: str, request: Request):
    pack = packs_cache.pack_or_404(pack_id)
    file_path = common.safe_join(pack.folder, filename)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    ext = os.path.splitext(filename)[1].lower()
    media_type = common.AUDIO_MEDIA_TYPES.get(ext, "audio/ogg")
    return common.range_stream_file(
        file_path,
        request,
        media_type=media_type,
        cache_control=common.LONG_CACHE
    )


@router.get("/api/packs/{pack_id}/export")
async def export_pack_zip(pack_id: str):
    """Packages and streams a scene pack as a downloadable .zip archive."""
    pack = packs_cache.find_pack(pack_id)
    pack_folder = pack.folder if pack else None

    if not pack_folder or not os.path.isdir(pack_folder):
        for base in pack_loader.PACKS_DIRS:
            candidate = common.safe_join(base, pack_id)
            if os.path.isdir(candidate):
                pack_folder = candidate
                break

    if not pack_folder or not os.path.isdir(pack_folder):
        raise HTTPException(status_code=404, detail="Pack not found")

    try:
        clean_name = pack_loader.safe_folder_name(pack.name if pack else pack_id, "scene_pack")
        zip_filename = f"{clean_name}.zip"
        zip_dir = os.path.join(common.exports_dir(), "packs")
        os.makedirs(zip_dir, exist_ok=True)
        zip_path = os.path.join(zip_dir, f"DubMate_Pack_{clean_name}_{pack_id}.zip")

        await asyncio.to_thread(pack_loader.export_pack_archive, pack_folder, output_zip_path=zip_path)

        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=zip_filename,
            headers={
                "Content-Disposition": f'attachment; filename="{zip_filename}"',
                "Cache-Control": "no-cache",
                # The saved file's name, so the studio can show where it is. Headers
                # are latin-1, so anything else (a non-ASCII pack id) is %-encoded.
                "X-DubMate-File": quote(os.path.basename(zip_path), safe=" !#$&'()+,;=@[]^`{}"),
            }
        )
    except Exception as ex:
        print(f"[PackExportError] Error generating pack ZIP for {pack_id}: {ex}")
        raise HTTPException(status_code=500, detail="Couldn't prepare that pack for download. Try again.")
