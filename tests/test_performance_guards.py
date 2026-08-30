# -*- coding: utf-8 -*-
"""
test_performance_guards.py
Guards for optimizations that are easy to silently undo.

Each of these was a measured cost, not a theory:
  * `import scipy.signal` at module scope cost ~1.6s of engine cold start and
    ~67 MB of resident memory to serve one convolution call.
  * `read_wav_mono` spawned ffmpeg (~100ms, flat) even for files already in the
    exact target format -- which is the format DubMate itself writes.
  * `get_all_packs()` rewrote a 131 KB index on every call, including calls that
    changed nothing. `/api/config` did this per request.
  * Static assets were sent with `no-store`, so the ETags the server computes
    could never produce a 304 and ~360 KB of JS/CSS re-transferred every load.
"""

import os as _os
import sys as _sys
import tempfile
import time
import wave

import numpy as np
from fastapi.testclient import TestClient

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import audio_processor
import pack_loader
from app import app


def test_scipy_is_not_imported_at_startup():
    """scipy must stay lazy; importing it eagerly is most of the cold start."""
    import subprocess
    probe = (
        "import sys, app; "
        "print('SCIPY_LOADED', any(m.split('.')[0] == 'scipy' for m in sys.modules))"
    )
    res = subprocess.run([_sys.executable, "-c", probe], capture_output=True, text=True)
    assert "SCIPY_LOADED False" in res.stdout, (
        "scipy is being imported at startup again; keep it inside the reverb path.\n"
        f"stdout={res.stdout[-400:]}\nstderr={res.stderr[-400:]}"
    )
    print("[PASS] scipy stays out of the startup import graph")


def test_read_wav_mono_fast_path_matches_ffmpeg_exactly():
    """The shortcut must be a pure optimization -- identical samples, or it is a bug."""
    sr = audio_processor.SR
    with tempfile.TemporaryDirectory() as tmp:
        path = _os.path.join(tmp, "take.wav")
        signal = (np.random.rand(sr * 3).astype(np.float32) - 0.5) * 0.4
        audio_processor.write_wav_mono(path, signal, sr)

        direct = audio_processor._read_wav_mono_direct(path, sr)
        assert direct is not None, "a WAV we just wrote ourselves should hit the fast path"

        original = audio_processor._read_wav_mono_direct
        try:
            audio_processor._read_wav_mono_direct = lambda *a, **k: None
            via_ffmpeg = audio_processor.read_wav_mono(path, sr)
        finally:
            audio_processor._read_wav_mono_direct = original

        assert np.array_equal(direct, via_ffmpeg), "fast path diverges from the ffmpeg path"
    print(f"[PASS] read_wav_mono fast path is byte-identical ({len(direct)} samples)")


def test_read_wav_mono_falls_back_for_mismatched_files():
    """Anything not already mono/44.1k/16-bit must still route through ffmpeg."""
    sr = audio_processor.SR
    with tempfile.TemporaryDirectory() as tmp:
        stereo = _os.path.join(tmp, "stereo48k.wav")
        with wave.open(stereo, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(48000)
            w.writeframes(np.zeros(48000 * 2, dtype="<i2").tobytes())

        assert audio_processor._read_wav_mono_direct(stereo, sr) is None, \
            "stereo/48k must not be accepted by the fast path"
        assert len(audio_processor.read_wav_mono(stereo, sr)) > 0, \
            "the ffmpeg fallback should still decode it"

        # A truncated/corrupt file must decline rather than raise.
        broken = _os.path.join(tmp, "broken.wav")
        with open(broken, "wb") as f:
            f.write(b"RIFF\x00\x00\x00\x00WAVEnope")
        assert audio_processor._read_wav_mono_direct(broken, sr) is None
    print("[PASS] mismatched and corrupt WAVs fall back instead of breaking")


def test_get_all_packs_does_not_rewrite_the_index_when_nothing_changed():
    """The index write dominated warm scans; it must only happen on a real change."""
    pack_loader.get_all_packs()  # warm the mtime cache

    writes = {"count": 0}
    original = pack_loader.save_persistent_pack_cache

    def counting_save(*args, **kwargs):
        writes["count"] += 1
        return original(*args, **kwargs)

    pack_loader.save_persistent_pack_cache = counting_save
    try:
        for _ in range(5):
            pack_loader.get_all_packs()
    finally:
        pack_loader.save_persistent_pack_cache = original

    assert writes["count"] == 0, (
        f"warm get_all_packs() wrote the pack index {writes['count']} times; "
        "it should write only when a pack was actually re-loaded"
    )
    print("[PASS] warm get_all_packs() performs no redundant index writes")


def test_static_assets_revalidate_instead_of_refusing_to_cache():
    """`no-store` made the server's own ETags useless; assets must be storable."""
    with TestClient(app) as client:
        res = client.get("/js/app.js")
        assert res.status_code == 200
        cache_control = res.headers.get("cache-control", "")
        assert "no-store" not in cache_control, (
            f"no-store is back on static assets ({cache_control}); "
            "the browser cannot cache, so revalidation can never happen"
        )

        etag = res.headers.get("etag")
        assert etag, "static assets must carry an ETag to revalidate against"

        conditional = client.get("/js/app.js", headers={"If-None-Match": etag})
        assert conditional.status_code == 304, (
            f"expected 304 for a matching ETag, got {conditional.status_code}"
        )
        assert not conditional.content, "a 304 must not carry a body"

        stale = client.get("/js/app.js", headers={"If-None-Match": '"stale"'})
        assert stale.status_code == 200 and stale.content, \
            "a stale ETag must serve the real file"
    print(f"[PASS] static assets revalidate to 304 ({len(res.content)} bytes saved per repeat load)")


def test_api_responses_are_never_cached():
    """Room and pack state must not be served stale."""
    with TestClient(app) as client:
        res = client.get("/api/packs")
        assert res.status_code == 200
        assert "no-store" in res.headers.get("cache-control", ""), \
            "API responses must stay uncached"
    print("[PASS] /api/ responses remain no-store")


def test_engine_imports_stay_fast():
    """
    A coarse ceiling, not a benchmark. Cold `import app` measured ~2.3s with scipy
    eager and ~0.6s without; 1.5s catches a regression of that size without being
    flaky on a loaded machine.
    """
    import subprocess
    timings = []
    for _ in range(2):
        started = time.perf_counter()
        subprocess.run([_sys.executable, "-c", "import app"], capture_output=True)
        timings.append(time.perf_counter() - started)
    best = min(timings)
    assert best < 1.5, f"importing app took {best:.2f}s; something heavy is back at module scope"
    print(f"[PASS] cold `import app` in {best:.2f}s")


if __name__ == "__main__":
    test_scipy_is_not_imported_at_startup()
    test_read_wav_mono_fast_path_matches_ffmpeg_exactly()
    test_read_wav_mono_falls_back_for_mismatched_files()
    test_get_all_packs_does_not_rewrite_the_index_when_nothing_changed()
    test_static_assets_revalidate_instead_of_refusing_to_cache()
    test_api_responses_are_never_cached()
    test_engine_imports_stay_fast()
    print("\n[OK] Performance guard suite passed")
