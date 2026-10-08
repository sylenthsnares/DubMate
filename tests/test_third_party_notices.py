# -*- coding: utf-8 -*-
"""
test_third_party_notices.py
THIRD_PARTY_NOTICES.md names everything the desktop app ships or the Pack Builder
installs, so a new sidecar, package, re-pinned FFmpeg build, runtime, speaker model
or font can't land without its notice.
"""

import ast
import json
import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTICES = os.path.join(PROJECT_ROOT, "THIRD_PARTY_NOTICES.md")
TAURI_CONF = os.path.join(PROJECT_ROOT, "tauri", "src-tauri", "tauri.conf.json")
STAGE_PS1 = os.path.join(PROJECT_ROOT, "tauri", "scripts", "stage-sidecars.ps1")
STAGE_SH = os.path.join(PROJECT_ROOT, "tauri", "scripts", "stage-sidecars.sh")
DOWNLOAD_TOOLS = os.path.join(PROJECT_ROOT, "scripts", "download_tools.ps1")
FONTS_DIR = os.path.join(PROJECT_ROOT, "tauri", "src", "fonts")


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _norm(text):
    """Case-insensitive, with - and _ treated alike (pip normalises names the same way)."""
    return text.lower().replace("_", "-")


def _notices():
    return _norm(_read(NOTICES))


def _requirement_names(path):
    names = []
    for line in _read(path).splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", line)
        if m:
            names.append(m.group(0))
    return names


def _ffmpeg_build_id(path):
    m = re.search(r"FFmpeg-Builds/releases/download/([^/\"]+)/(ffmpeg-[^\"/]+?)\.zip", _read(path))
    assert m, f"no pinned FFmpeg build URL in {os.path.relpath(path, PROJECT_ROOT)}"
    return m.group(1), m.group(2)


def _speaker_model_files():
    tree = ast.parse(_read(os.path.join(PROJECT_ROOT, "pack_builder.py")))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "SPEAKER_MODELS" for t in node.targets):
            return [entry.elts[0].value for entry in node.value.elts]
    raise AssertionError("pack_builder.SPEAKER_MODELS not found")


def test_every_external_binary_is_named():
    notices = _notices()
    bins = json.loads(_read(TAURI_CONF))["bundle"]["externalBin"]
    assert bins, "tauri.conf.json lists no externalBin"
    for entry in bins:
        name = os.path.basename(entry)
        assert _norm(name) in notices, f"THIRD_PARTY_NOTICES.md doesn't name the shipped binary {name}"
    print(f"[PASS] {len(bins)} shipped binaries are named")


def test_every_top_level_requirement_is_named():
    notices = _notices()
    checked = 0
    for req in ("requirements.txt", "requirements_builder.txt"):
        for name in _requirement_names(os.path.join(PROJECT_ROOT, req)):
            assert _norm(name) in notices, f"THIRD_PARTY_NOTICES.md doesn't name {name} ({req})"
            checked += 1
    assert checked >= 10
    print(f"[PASS] {checked} top-level requirements are named")


def test_pinned_ffmpeg_build_is_named():
    notices = _notices()
    pins = {_ffmpeg_build_id(STAGE_PS1), _ffmpeg_build_id(DOWNLOAD_TOOLS)}
    for tag, build in pins:
        assert _norm(tag) in notices, f"THIRD_PARTY_NOTICES.md doesn't name the FFmpeg autobuild {tag}"
        assert _norm(build) in notices, f"THIRD_PARTY_NOTICES.md doesn't name the FFmpeg build {build}"
        commit = re.search(r"-g([0-9a-f]{7,})-", build)
        assert commit and _norm(commit.group(1)) in notices, \
            f"THIRD_PARTY_NOTICES.md doesn't link the FFmpeg source commit of {build}"
    print(f"[PASS] FFmpeg build {sorted(pins)} is named with its source commit")


def test_pinned_deepfilternet_version_is_named():
    notices = _notices()
    versions = set()
    for path in (STAGE_PS1, STAGE_SH):
        versions.update(re.findall(r"DeepFilterNet/releases/download/v([0-9.]+)/", _read(path)))
    assert versions, "no pinned DeepFilterNet version in the stage scripts"
    for v in versions:
        assert f"deepfilternet {v}" in notices, f"THIRD_PARTY_NOTICES.md doesn't name DeepFilterNet {v}"
    print(f"[PASS] DeepFilterNet {sorted(versions)} is named")


def test_python_runtime_versions_are_named():
    notices = _notices()
    win = re.search(r"python/([0-9.]+)/python-[0-9.]+-embed", _read(STAGE_PS1))
    mac = re.search(r"python-build-standalone/releases/download/([0-9]+)/cpython-([0-9.]+)\+", _read(STAGE_SH))
    assert win and mac, "Python runtime pins not found in the stage scripts"
    assert f"cpython {win.group(1)}" in notices, f"THIRD_PARTY_NOTICES.md doesn't name CPython {win.group(1)}"
    assert f"cpython {mac.group(2)}" in notices, f"THIRD_PARTY_NOTICES.md doesn't name CPython {mac.group(2)}"
    assert f"python-build-standalone {mac.group(1)}" in notices, \
        f"THIRD_PARTY_NOTICES.md doesn't name python-build-standalone {mac.group(1)}"
    print(f"[PASS] CPython {win.group(1)} and python-build-standalone {mac.group(1)} are named")


def test_every_speaker_model_is_named():
    notices = _notices()
    files = _speaker_model_files()
    assert files
    for name in files:
        assert _norm(name) in notices, f"THIRD_PARTY_NOTICES.md doesn't name the speaker model file {name}"
    print(f"[PASS] {len(files)} speaker model files are named")


def test_every_bundled_font_is_named():
    notices = _notices()
    fonts = [n for n in os.listdir(FONTS_DIR) if n.endswith((".woff2", ".woff", ".ttf", ".otf"))]
    assert fonts
    for name in fonts:
        assert _norm(name) in notices, f"THIRD_PARTY_NOTICES.md doesn't name the bundled font {name}"
        assert os.path.isfile(os.path.join(FONTS_DIR, "OFL-" + name.split("-")[0] + ".txt")), \
            f"no OFL file beside {name}"
    print(f"[PASS] {len(fonts)} bundled fonts are named, each with its OFL file")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
    print("\n[OK] Third-party notices suite passed")
    sys.exit(0)
