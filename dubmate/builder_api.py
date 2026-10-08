# -*- coding: utf-8 -*-
"""
dubmate/builder_api.py
Pack Builder routes (/api/builder/*) and the in-memory BUILDER_SESSIONS table.

Routes call pack_builder.<fn> through the module so tests can monkeypatch it.
"""

import os
import json
import time
import uuid
import shutil
import asyncio
import threading
import importlib.util
import urllib.parse
from typing import Dict, Optional, Any

from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

import pack_loader
import audio_processor
import pack_builder
from dubmate import common, packs_cache

router = APIRouter()


BUILDER_SESSIONS: Dict[str, Dict[str, Any]] = {}


def _builder_session_or_404(session_id: str) -> Dict[str, Any]:
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="This session is no longer available. Add the video again.")
    session["touched_at"] = time.time()
    return session


def _run_lock(session: Dict[str, Any]) -> threading.Lock:
    """One processing run at a time per session; held while the pipeline runs."""
    return session.setdefault("run_lock", threading.Lock())


def prune_old_builder_sessions(max_age_seconds: float = 7200.0):
    """Purges builder sessions 2 hours after their last activity, to keep disk space lean."""
    now = time.time()
    to_delete = []
    for s_id, session in list(BUILDER_SESSIONS.items()):
        lock = session.get("run_lock")
        if lock is not None and lock.locked():
            continue  # a running pipeline still writes to the folder
        last_active = session.get("touched_at") or session.get("created_at", now)
        if now - last_active > max_age_seconds:
            to_delete.append(s_id)
            folder = session.get("folder")
            if folder and os.path.isdir(folder):
                shutil.rmtree(folder, ignore_errors=True)
    for s_id in to_delete:
        BUILDER_SESSIONS.pop(s_id, None)


# The GPU probe imports torch (1 to 3 s), so it runs once, off the event loop.
_GPU_STATE: Dict[str, Any] = {"value": None, "started": False}
_GPU_LOCK = threading.Lock()


def _installed(name: str) -> bool:
    """Whether a module can be imported, found without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _probe_gpu() -> None:
    try:
        torch_avail, cuda_avail, _ = pack_builder.detect_torch_and_cuda()
        _GPU_STATE["value"] = bool(torch_avail and cuda_avail)
    except Exception as ex:
        print(f"[Builder] GPU check failed: {ex}")
        _GPU_STATE["value"] = False


def _gpu_available(torch_installed: bool) -> Optional[bool]:
    """True or False once known, None while the background probe runs."""
    if not torch_installed:
        return False
    with _GPU_LOCK:
        if not _GPU_STATE["started"]:
            _GPU_STATE["started"] = True
            threading.Thread(target=_probe_gpu, daemon=True).start()
    return _GPU_STATE["value"]


@router.get("/api/builder/capabilities")
async def builder_capabilities():
    """Which Pack Builder tools are installed, so the page only offers what works."""
    torch_installed = _installed("torch")
    return {
        "separation": torch_installed and _installed("demucs"),
        "transcription": _installed("whisper"),
        "link_import": _installed("yt_dlp"),
        "speakers": _installed("sherpa_onnx"),
        "romaji": _installed("pykakasi"),
        "gpu": _gpu_available(torch_installed),
    }


NO_SUBTITLE_LINES = "No timed lines in this file. Use an SRT or VTT file."


def _parse_subtitle_file(filename: Optional[str], content: bytes):
    text = content.decode("utf-8", errors="replace")
    if (filename or "").lower().endswith(".vtt"):
        return pack_builder.parse_vtt(text)
    return pack_builder.parse_srt(text)


@router.post("/api/builder/subtitles/check")
async def builder_check_subtitles(file: UploadFile = File(...)):
    """Checks a subtitle file as soon as it is chosen: how many lines, and who speaks."""
    parsed = _parse_subtitle_file(file.filename, await file.read())
    if not parsed:
        raise HTTPException(status_code=400, detail=NO_SUBTITLE_LINES)
    return {"count": len(parsed), "characters": sorted({s["character"] for s in parsed})}


@router.post("/api/builder/upload")
async def builder_upload_video(file: UploadFile = File(...)):
    """
    Accepts video file upload for pack authoring.
    Validates format, probes duration, and initializes a Builder session.
    """
    prune_old_builder_sessions()
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="Choose a video file first.")
    
    _, ext = os.path.splitext(file.filename.lower())
    if ext not in pack_loader.VIDEO_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"That video type isn't supported. Use {', '.join(pack_loader.VIDEO_EXTS)}."
        )

    session_id = str(uuid.uuid4())[:12]
    session_dir = os.path.join(pack_builder.BUILDER_CACHE_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    video_path = os.path.join(session_dir, f"source_video{ext}")
    
    try:
        content = await file.read()
        if len(content) > pack_loader.MAX_ARCHIVE_SIZE_BYTES:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise HTTPException(status_code=413, detail="This video is over 500 MB. Use a shorter clip.")

        def _save_and_probe() -> float:
            with open(video_path, "wb") as f:
                f.write(content)
            return pack_loader.probe_duration(video_path)

        duration = await asyncio.to_thread(_save_and_probe)
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
            "touched_at": time.time(),
            "run_lock": threading.Lock(),
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
        print(f"[Builder] Upload failed: {ex}")
        raise HTTPException(status_code=500, detail="The upload didn't finish. Try again.")


@router.post("/api/builder/import_url")
async def builder_import_url(payload: Dict[str, Any]):
    """
    Downloads a video from YouTube or a supported web URL using yt-dlp.
    Initializes a Builder session with the downloaded video, cover, and subtitles.
    """
    prune_old_builder_sessions()

    raw_url = str(payload.get("url") or "").strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="Paste a video link first.")

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
            progress.segments = [dict(s) for s in subtitle_segments]

        BUILDER_SESSIONS[session_id] = {
            "session_id": session_id,
            "folder": session_dir,
            "video_path": video_path,
            "filename": result["filename"],
            "title": title,
            "duration": round(duration, 3),
            "progress": progress,
            "created_at": time.time(),
            "touched_at": time.time(),
            "run_lock": threading.Lock(),
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

    except pack_builder.MissingPipelineError as missing:
        shutil.rmtree(session_dir, ignore_errors=True)
        # 503 + a code the wizard recognises, so it can offer the in-app installer
        # instead of quoting a pip command at the user.
        raise HTTPException(
            status_code=503,
            detail={"code": "pipeline_missing", "message": str(missing)},
        )
    except ValueError as val_err:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(val_err))
    except pack_builder.StaleYtDlpError as stale:
        shutil.rmtree(session_dir, ignore_errors=True)
        # The message says how to update; the generic "check the link" would mislead.
        # The steps go in `details` so the wizard can keep them on screen.
        raise HTTPException(
            status_code=500,
            detail={"code": "ytdlp_stale", "message": str(stale), "details": stale.details},
        )
    except RuntimeError as run_err:
        shutil.rmtree(session_dir, ignore_errors=True)
        print(f"[Builder] URL import failed: {run_err}")
        raise HTTPException(
            status_code=500,
            detail="We couldn't import that video. Check the link and try again.",
        )
    except Exception as ex:
        shutil.rmtree(session_dir, ignore_errors=True)
        print(f"[Builder] Unexpected URL import failure: {ex}")
        raise HTTPException(
            status_code=500,
            detail="We couldn't import that video. Check the link and try again.",
        )


def _run_builder_pipeline_sync(session_id: str, language: Optional[str] = None, whisper_model: str = "base", payload: Optional[Dict[str, Any]] = None):
    """Background synchronous worker executing the AI processing pipeline, one run per session at a time."""
    payload = payload or {}
    session = BUILDER_SESSIONS.get(session_id)
    if not session:
        return

    progress: pack_builder.BuildProgress = session["progress"]
    # Read before waiting, so a cancel sent while this run waits applies to this run.
    cancel = progress.cancel_requested
    lock = _run_lock(session)
    if not lock.acquire(blocking=False):
        progress.update("queued", 0.0, "Finishing the last run")
        lock.acquire()
    try:
        with progress.lock:
            progress.skipped = []
            progress.error = None
            progress.error_code = None
            progress.warning = None
        _run_pipeline_stages(session, progress, cancel, language, whisper_model, payload)
    except pack_builder.BuildCancelled:
        print(f"[PackBuilderPipeline] Cancelled in session {session_id}")
        with progress.lock:
            # A newer run is already waiting ("queued"); its screen must not see "cancelled".
            if progress.status != "queued":
                progress.status = "cancelled"
                progress.message = "Cancelled"
    except pack_builder.MissingPipelineError as missing:
        print(f"[PackBuilderPipeline] Pipeline missing in session {session_id}: {missing}")
        progress.error_code = "pipeline_missing"
        progress.update("error", 0.0, str(missing), error=str(missing))
    except RuntimeError as run_err:
        # These carry copy written for the user (see transcribe_audio).
        print(f"[PackBuilderPipeline] Error in session {session_id}: {run_err}")
        progress.error_code = "processing_failed"
        progress.update("error", 0.0, str(run_err), error=str(run_err))
    except Exception as ex:
        print(f"[PackBuilderPipeline] Error in session {session_id}: {ex}")
        progress.error_code = "processing_failed"
        progress.update(
            "error", 0.0,
            "Processing didn't finish. Please try again, or use a different clip.",
            error="Processing didn't finish. Please try again, or use a different clip.",
        )
    finally:
        lock.release()


def _run_pipeline_stages(session: Dict[str, Any], progress: "pack_builder.BuildProgress", cancel: threading.Event,
                         language: Optional[str], whisper_model: str, payload: Dict[str, Any]) -> None:
    """The stages of one run. Each progress write is a stage boundary, where a cancel stops the run."""
    session_dir = session["folder"]
    video_path = session["video_path"]

    def step(status: str, fraction: float, message: str, stage: str) -> None:
        if cancel.is_set():
            raise pack_builder.BuildCancelled()
        progress.update(status, fraction, message, stage=stage)

    # Steps 1 and 2 already ran when this session's audio and separated tracks exist
    # (a retry after a later stage failed, or Process again). The video can't change
    # within a session, so they are still valid.
    finished = [session.get(k) for k in ("full_audio_path", "vocals_path", "backing_path")]
    if all(p and os.path.isfile(p) for p in finished):
        progress.voices_separated = session.get("voices_separated")
        progress.warning = session.get("separation_notice") or None
    else:
        # Step 1: Extract Audio (0% -> 20%)
        step("extracting_audio", 0.10, "Reading the audio", "audio_extraction")
        full_wav = os.path.join(session_dir, "full_audio.wav")
        pack_builder.extract_audio_from_video(video_path, full_wav)
        session["full_audio_path"] = full_wav
        step("extracting_audio", 0.20, "Audio ready", "audio_extraction")

        # Step 2: Stem Separation via Demucs (20% -> 60%)
        step("separating_stems", 0.30, "Separating voices from the background", "stem_separation")
        stems_dir = os.path.join(session_dir, "stems")
        stem_results = pack_builder.separate_audio_stems(full_wav, stems_dir)
        session["vocals_path"] = stem_results["vocals"]
        session["backing_path"] = stem_results["backing"]
        # The basic filter writes a copy of the full mix as vocals.wav, so only a
        # real separation may be played back as "voices only".
        session["voices_separated"] = not stem_results.get("used_fallback")
        progress.voices_separated = session["voices_separated"]
        # Say so when the neural model was unavailable. Silently substituting the
        # crude filter meant the user was promised AI isolation and never told they
        # did not get it.
        notice = (stem_results.get("fallback_notice") or "") if stem_results.get("used_fallback") else ""
        session["separation_notice"] = notice
        if notice:
            progress.warning = notice
        step("separating_stems", 0.60, notice or "Voices separated", "stem_separation")

    # Step 3: the lines (60% -> 90%). Only this session's subtitles count, never the
    # last run's lines, so a retry transcribes once the subtitles are removed.
    subtitles = session.get("subtitle_segments") or []
    from_whisper = False
    if subtitles:
        progress.skipped.append("transcription")
        step("transcribing", 0.85, f"Using {len(subtitles)} lines from your subtitles", "transcription")
        segments = [dict(s) for s in subtitles]
    elif payload.get("transcribe") is False:
        progress.skipped.append("transcription")
        segments = []
    else:
        step("transcribing", 0.70, "Writing out the dialogue", "transcription")
        is_romaji = (language and "romaji" in language.lower()) or bool(payload.get("romanize", False))
        segments = pack_builder.transcribe_audio(session["vocals_path"], model_size=whisper_model, language=language, romanize=is_romaji)
        from_whisper = True

    # Whisper drops grunts, screams and laughs; find them on the voice stem.
    # Only on a real separation: the basic filter's stem is the full mix.
    if from_whisper and session.get("voices_separated"):
        segments = pack_builder.add_nonverbal_segments(segments, session["vocals_path"], session.get("duration", 0))

    # Step 4: who speaks (88% -> 98%). Only when the subtitles named nobody, so
    # named subtitles never trigger the first-time download.
    named = any(s.get("character") and s.get("character") != "Actor" for s in segments)
    if segments and not named:
        step("detecting_speakers", 0.88, "Detecting who speaks", "speakers")

        def _on_speaker_progress(fraction: float, message: str = "") -> None:
            if not cancel.is_set():
                progress.update("detecting_speakers", fraction, message or "Detecting who speaks", stage="speakers")

        turns, notice = pack_builder.detect_speaker_turns(session["vocals_path"], on_progress=_on_speaker_progress, cancel=cancel)
        if notice:
            progress.warning = f"{progress.warning} {notice}" if progress.warning else notice
        segments = pack_builder.assign_speakers_to_segments(segments, turns)
    else:
        progress.skipped.append("speakers")
        if segments:
            segments = pack_builder.assign_speakers_to_segments(segments)

    if cancel.is_set():
        raise pack_builder.BuildCancelled()
    progress.characters = sorted(list({s["character"] for s in segments}))
    total = len(segments)
    no_words = sum(1 for s in segments if s.get("nonverbal"))
    summary = f"Found {total} line{'' if total == 1 else 's'}" if total else "No lines yet"
    if no_words:
        summary += f", {no_words} without words"
    progress.update("transcribed", 1.0, summary, stage="complete", segments=segments)


@router.post("/api/builder/{session_id}/process")
async def builder_start_processing(session_id: str, payload: Optional[Dict[str, Any]] = None):
    """Starts reading the audio, separating the voices and writing out the lines, in the background."""
    session = _builder_session_or_404(session_id)

    payload = payload or {}
    language = payload.get("language")
    whisper_model = payload.get("whisper_model", "base")

    progress: pack_builder.BuildProgress = session["progress"]
    # A fresh cancel flag for this run. A cancelled run that is still finishing its
    # stage keeps its own, so it still stops, and this run waits for it (the run lock).
    progress.cancel_requested = threading.Event()
    # The progress stream must never find the last run's "error" or "transcribed".
    busy = _run_lock(session).locked()
    progress.update("queued", 0.0, "Finishing the last run" if busy else "Starting")

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _run_builder_pipeline_sync, session_id, language, whisper_model, payload)

    return {"status": "processing", "session_id": session_id}


@router.post("/api/builder/{session_id}/cancel")
async def builder_cancel_processing(session_id: str):
    """Asks the running pipeline to stop at its next stage boundary."""
    session = _builder_session_or_404(session_id)
    session["progress"].cancel_requested.set()
    return {"status": "cancelling", "session_id": session_id}


@router.get("/api/builder/{session_id}/progress")
async def builder_progress_stream(session_id: str):
    """Server-Sent Events (SSE) stream reporting real-time pipeline progress."""
    session = _builder_session_or_404(session_id)

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

            if curr_status in ("transcribed", "done", "error", "cancelled"):
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


@router.get("/api/builder/{session_id}/status")
async def builder_get_status(session_id: str):
    """Polling alternative to SSE for retrieving builder session status."""
    session = _builder_session_or_404(session_id)
    return session["progress"].to_dict()


@router.get("/api/builder/{session_id}/waveform")
async def builder_get_waveform(session_id: str, columns: int = 800, track: str = "vocals"):
    """Returns precomputed or on-demand min/max waveform peak pairs for the session audio track."""
    session = _builder_session_or_404(session_id)

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

    columns = max(100, min(2400, columns))
    # The editor asks again on every open and audio switch; the file only changes if
    # processing runs again, which the modification time catches.
    cache = session.setdefault("waveform_cache", {})
    key = (audio_path, os.stat(audio_path).st_mtime_ns, columns)
    peaks = cache.get(key)
    if peaks is None:
        loop = asyncio.get_running_loop()
        def _calc_peaks():
            try:
                arr = audio_processor.read_wav_mono(audio_path, sr=22050)
                return audio_processor.compute_waveform_peaks(arr, columns=columns)
            except Exception as e:
                print(f"[Waveform] Error computing peaks for {audio_path}: {e}")
                return []

        peaks = await loop.run_in_executor(None, _calc_peaks)
        if peaks:
            cache[key] = peaks
    return {
        "peaks": peaks,
        "duration": session.get("duration", 0.0),
        "count": len(peaks)
    }


@router.get("/api/builder/{session_id}/segments")
async def builder_get_segments(session_id: str):
    """Returns current dialogue line segments and character roster for session."""
    session = _builder_session_or_404(session_id)
    progress: pack_builder.BuildProgress = session["progress"]
    return {
        "segments": progress.segments,
        "characters": sorted(list({s.get("character", "Actor") for s in progress.segments})),
        "duration": session.get("duration", 0.0),
    }


@router.put("/api/builder/{session_id}/segments")
async def builder_update_segments(session_id: str, payload: Dict[str, Any]):
    """Replaces or bulk-updates the dialogue line segments for the session."""
    session = _builder_session_or_404(session_id)

    raw_segments = payload.get("segments", [])
    valid_segments = []
    max_dur = session.get("duration", 99999.0)

    for s in raw_segments:
        try:
            start = max(0.0, float(s["start"]))
            end = min(max_dur, float(s["end"]))
            if end <= start:
                end = min(max_dur, start + 0.5)
            seg = {
                "start": round(start, 3),
                "end": round(end, 3),
                "text": str(s.get("text", "")).strip(),
                "character": str(s.get("character", "Actor")).strip() or "Actor",
            }
            if s.get("nonverbal"):
                seg["nonverbal"] = True
            valid_segments.append(seg)
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


@router.post("/api/builder/{session_id}/segments")
async def builder_add_segment(session_id: str, payload: Dict[str, Any]):
    """Appends a new dialogue line segment."""
    session = _builder_session_or_404(session_id)

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


@router.delete("/api/builder/{session_id}/segments/{index}")
async def builder_delete_segment(session_id: str, index: int):
    """Deletes a dialogue line segment by chronological index."""
    session = _builder_session_or_404(session_id)

    progress: pack_builder.BuildProgress = session["progress"]
    with progress.lock:
        if 0 <= index < len(progress.segments):
            deleted = progress.segments.pop(index)
            progress.characters = sorted(list({s["character"] for s in progress.segments}))
            return {"status": "ok", "deleted": deleted, "segments": progress.segments}
        else:
            raise HTTPException(status_code=404, detail="That line no longer exists.")


@router.post("/api/builder/{session_id}/transcribe_segment")
async def builder_transcribe_segment(session_id: str, payload: Dict[str, Any]):
    """Transcribes a specific audio segment [start, end] using Whisper on demand."""
    session = _builder_session_or_404(session_id)

    vocals_path = session.get("vocals_path") or session.get("full_audio_path")
    if not vocals_path or not os.path.isfile(vocals_path):
        raise HTTPException(status_code=400, detail="The audio isn't ready yet. Wait for processing to finish.")

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


@router.post("/api/builder/{session_id}/romanize")
async def builder_romanize_text(session_id: str, payload: Dict[str, Any]):
    """Converts Japanese text into Romaji phonetic script for non-native anime dubbers."""
    raw_text = str(payload.get("text", "")).strip()
    romaji = pack_builder.to_romaji(raw_text)
    return {"status": "ok", "original": raw_text, "romaji": romaji}


@router.post("/api/builder/{session_id}/import_subtitles")
async def builder_import_subtitles(session_id: str, file: UploadFile = File(...)):
    """Imports an SRT or WebVTT subtitle file to instantly populate dialogue cues."""
    session = _builder_session_or_404(session_id)

    parsed = _parse_subtitle_file(file.filename, await file.read())
    if not parsed:
        raise HTTPException(status_code=400, detail=NO_SUBTITLE_LINES)

    # Clamp to video duration
    max_dur = session.get("duration", 99999.0)
    clamped = []
    for s in parsed:
        if s["start"] < max_dur:
            s["end"] = min(max_dur, s["end"])
            clamped.append(s)

    # The pipeline reads the subtitles from here, never from the last run's lines.
    session["subtitle_segments"] = clamped
    progress: pack_builder.BuildProgress = session["progress"]
    with progress.lock:
        progress.segments = [dict(s) for s in clamped]
        progress.characters = sorted(list({s["character"] for s in clamped}))

    return {
        "status": "ok",
        "count": len(clamped),
        "segments": clamped,
        "characters": progress.characters,
    }


@router.delete("/api/builder/{session_id}/subtitles")
async def builder_remove_subtitles(session_id: str):
    """Forgets the session's subtitles, so the next run writes out the lines itself."""
    session = _builder_session_or_404(session_id)
    session["subtitle_segments"] = []
    return {"status": "ok"}


@router.post("/api/builder/{session_id}/cover")
async def builder_upload_cover(session_id: str, file: UploadFile = File(...)):
    """Uploads custom cover art for the pack card."""
    session = _builder_session_or_404(session_id)

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


@router.get("/api/builder/{session_id}/cover")
async def builder_serve_cover(session_id: str):
    """Serves the uploaded cover image preview."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session or not session.get("cover_path") or not os.path.isfile(session["cover_path"]):
        raise HTTPException(status_code=404, detail="Cover not found.")
    ext = os.path.splitext(session["cover_path"])[1].lower()
    media_type = common.IMAGE_MEDIA_TYPES.get(ext, "image/webp")
    return FileResponse(session["cover_path"], media_type=media_type)


@router.get("/api/builder/{session_id}/video")
async def builder_serve_video(session_id: str, request: Request):
    """Streams uploaded builder source video with HTTP 206 partial range seeking."""
    session = BUILDER_SESSIONS.get(session_id)
    if not session or not os.path.isfile(session.get("video_path", "")):
        raise HTTPException(status_code=404, detail="Video not found.")
    return common.range_stream_file(
        session["video_path"],
        request,
        media_type="video/mp4",
        cache_control="no-cache"
    )


@router.get("/api/builder/{session_id}/audio/{track}")
async def builder_serve_audio_track(session_id: str, track: str, request: Request):
    """Streams the separated voice stem for voices-only preview in the editor."""
    session = BUILDER_SESSIONS.get(session_id)
    not_ready = HTTPException(status_code=404, detail="This audio isn't ready yet.")
    if track != "vocals" or not session or not session.get("voices_separated"):
        raise not_ready
    path = common.safe_join(session["folder"], "stems", "vocals.wav")
    if not os.path.isfile(path):
        raise not_ready
    return common.range_stream_file(
        path,
        request,
        media_type="audio/wav",
        cache_control="no-cache"
    )


@router.post("/api/builder/{session_id}/compile")
async def builder_compile_pack(session_id: str, payload: Dict[str, Any]):
    """
    Slices audio cues, packages all assets, generates compliance metadata,
    and installs the finished scene pack directly into DubMate's Packs directory.
    """
    session = _builder_session_or_404(session_id)

    progress: pack_builder.BuildProgress = session["progress"]
    segments = payload.get("segments") or progress.segments
    if not segments:
        raise HTTPException(status_code=400, detail="Add at least one line before building.")

    pack_name = (payload.get("pack_name") or session.get("filename") or "Custom Scene").strip()
    authors = payload.get("authors") or ["DubMate Creator"]
    subtitle = payload.get("subtitle") or f"{len(segments)} lines"

    session_dir = session["folder"]
    video_path = session["video_path"]
    vocals_path = session.get("vocals_path") or session.get("full_audio_path")
    backing_path = session.get("backing_path") or vocals_path
    cover_path = session.get("cover_path")

    # Step 1: Slice individual audio takes
    progress.update("slicing", 0.80, "Cutting the lines", stage="slicing")
    slices_dir = os.path.join(session_dir, "slices")
    try:
        sliced_lines = await asyncio.to_thread(pack_builder.slice_audio_lines, vocals_path, segments, slices_dir, pack_name)
    except RuntimeError as slice_err:
        progress.update("error", 0.0, str(slice_err), error=str(slice_err))
        raise HTTPException(status_code=500, detail=str(slice_err))

    # Step 2: Assemble complete pack folder
    progress.update("assembling", 0.90, "Adding the pack to your library", stage="assembling")
    pack_folder = await asyncio.to_thread(
        pack_builder.assemble_pack,
        pack_name=pack_name,
        video_source_path=video_path,
        backing_source_path=backing_path,
        line_slices=sliced_lines,
        cover_image_path=cover_path,
        authors=authors,
        subtitle=subtitle
    )

    # Step 3: Refresh server pack registry
    new_registry = await asyncio.to_thread(packs_cache.get_packs_registry, True)
    pack_id = os.path.basename(os.path.normpath(pack_folder))
    loaded_pack = new_registry.get(pack_id)

    if not loaded_pack:
        # Try loading directly
        loaded_pack = await asyncio.to_thread(pack_loader.load_pack, pack_folder)
        if loaded_pack:
            # Rebind rather than insert: a worker thread may be iterating the old dict.
            packs_cache.PACKS_CACHE = {**packs_cache.PACKS_CACHE, loaded_pack.pack_id: loaded_pack}

    progress.pack_info = loaded_pack.to_dict() if loaded_pack else {"id": pack_id, "name": pack_name}
    progress.update("done", 1.0, f"'{pack_name}' is ready", stage="done")

    quoted_pack_id = urllib.parse.quote(pack_id)
    return {
        "status": "ok",
        "message": f"'{pack_name}' is ready",
        "pack_id": pack_id,
        "download_url": f"/api/packs/{quoted_pack_id}/export",
        "pack": loaded_pack.to_dict() if loaded_pack else {"id": pack_id, "name": pack_name, "export_url": f"/api/packs/{quoted_pack_id}/export"},
    }
