# -*- coding: utf-8 -*-
"""
test_release_metadata.py
Keeps the three release ship lists in sync and the version numbers consistent.

The app bundle is assembled in three places: the GitHub release zip, the Windows
sidecar staging script and the macOS one. A module added to one list but not the
others ships a build that fails to import on that platform only.
"""

import ast
import json
import os
import re

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*parts):
    with open(os.path.join(PROJECT_ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def _norm(names):
    return {n.strip().strip('"').rstrip("/") for n in names if n.strip()}


def _release_yml_list():
    m = re.search(r"zip -r app-bundle-[^\n]*?\.zip((?:[^\n]*\\\n)*[^\n]*)", _read(".github", "workflows", "release.yml"))
    tokens, skip = m.group(1).replace("\\\n", " ").split(), False
    kept = []
    for tok in tokens:
        if skip:
            skip = False
        elif tok == "-x":
            skip = True
        elif not tok.startswith("-"):
            kept.append(tok)
    return _norm(kept)


def _ps1_list():
    src = _read("tauri", "scripts", "stage-sidecars.ps1")
    files = re.search(r"\$FilesToCopy\s*=\s*@\(([^)]*)\)", src).group(1).split(",")
    dir_vars = dict(re.findall(r'\$(\w+)\s*=\s*Join-Path \$ProjectRoot "([^"]+)"', src))
    dirs = [dir_vars[v] for v in re.findall(r"Copy-Item \$(\w+) \S+ -Recurse", src) if v in dir_vars]
    return _norm(files + dirs)


def _sh_list():
    src = _read("tauri", "scripts", "stage-sidecars.sh")
    files = re.search(r"for file in ([^;]+); do", src).group(1).split()
    dirs = re.findall(r'cp -r "\$PROJECT_ROOT/([^"]+)"', src)
    return _norm(files + dirs)


def test_ship_lists_match():
    yml, ps1, sh = _release_yml_list(), _ps1_list(), _sh_list()
    assert yml == ps1 == sh, f"ship lists differ:\n  release.yml={sorted(yml)}\n  ps1={sorted(ps1)}\n  sh={sorted(sh)}"
    print(f"[PASS] release.yml, stage-sidecars.ps1 and .sh ship the same {len(yml)} entries")


def test_app_local_imports_are_shipped():
    mods = set()
    for node in ast.parse(_read("app.py")).body:
        if isinstance(node, ast.Import):
            mods.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            mods.add(node.module.split(".")[0])
    local = {m for m in mods if os.path.isfile(os.path.join(PROJECT_ROOT, m + ".py"))
             or os.path.isfile(os.path.join(PROJECT_ROOT, m, "__init__.py"))}
    assert local, "expected app.py to import at least one project module"
    for name, ship in (("release.yml", _release_yml_list()), ("ps1", _ps1_list()), ("sh", _sh_list())):
        missing = {m for m in local if m + ".py" not in ship and m not in ship}
        assert not missing, f"{name} does not ship modules imported by app.py: {sorted(missing)}"
    print(f"[PASS] every project module app.py imports is shipped: {sorted(local)}")


def test_ffmpeg_pin_matches():
    """Both Windows scripts fetch one pinned FFmpeg and check its SHA-256 before extracting."""
    pins = {}
    for parts in (("scripts", "download_tools.ps1"), ("tauri", "scripts", "stage-sidecars.ps1")):
        src = _read(*parts)
        url = re.search(r'\$FfmpegUrl\s*=\s*"([^"]+)"', src).group(1)
        sha = re.search(r'\$FfmpegSha256\s*=\s*"([^"]+)"', src).group(1)
        assert re.fullmatch(r"[0-9a-f]{64}", sha), f"{parts[-1]}: bad SHA-256 {sha!r}"
        assert "latest" not in url, f"{parts[-1]}: FFmpeg URL is not pinned: {url}"
        block = src[src.index("$FfmpegUrl"):]
        assert block.index("-ne $FfmpegSha256") < block.index("Expand-Archive"), f"{parts[-1]}: extracts before verifying"
        others = set(re.findall(r'https://[^"\s]*ffmpeg[^"\s]*', src, re.I)) - {url}
        assert not others, f"{parts[-1]}: unpinned FFmpeg URLs: {sorted(others)}"
        pins[parts[-1]] = (url, sha)
    assert len(set(pins.values())) == 1, f"FFmpeg pins differ: {pins}"
    print(f"[PASS] both Windows scripts pin {pins['download_tools.ps1'][0].rsplit('/', 1)[-1]} with one SHA-256")


def test_deep_filter_pin_matches():
    """DeepFilterNet ships with the desktop app: one pinned binary per platform, hash checked before use."""
    pins = {}
    for parts, copy in ((("scripts", "download_tools.ps1"), "Move-Item -Path $tempDeepFilter"),
                        (("tauri", "scripts", "stage-sidecars.ps1"), "Copy-Item $DeepFilterDownload")):
        src = _read(*parts)
        url = re.search(r'\$DeepFilterUrl\s*=\s*"([^"]+)"', src).group(1)
        sha = re.search(r'\$DeepFilterSha256\s*=\s*"([^"]+)"', src).group(1)
        assert re.fullmatch(r"[0-9a-f]{64}", sha), f"{parts[-1]}: bad SHA-256 {sha!r}"
        assert "latest" not in url and "/v0.5.6/" in url, f"{parts[-1]}: DeepFilterNet URL is not pinned: {url}"
        block = src[src.index("$DeepFilterUrl"):]
        assert block.index("-ne $DeepFilterSha256") < block.index(copy), f"{parts[-1]}: keeps the file before verifying"
        others = set(re.findall(r'https://[^"\s]*deep-?filter[^"\s]*', src, re.I)) - {url}
        assert not others, f"{parts[-1]}: unpinned DeepFilterNet URLs: {sorted(others)}"
        pins[parts[-1]] = (url, sha)
    assert len(set(pins.values())) == 1, f"DeepFilterNet pins differ: {pins}"
    stage = _read("tauri", "scripts", "stage-sidecars.ps1")
    # A tools\deep-filter.exe from a source install is reused only when its hash matches.
    assert stage.index("-eq $DeepFilterSha256") < stage.index("Copy-Item $LocalDeepFilter"), "stage-sidecars.ps1: reuses tools\\deep-filter.exe unverified"

    sh = _read("tauri", "scripts", "stage-sidecars.sh")
    for triple in ("aarch64-apple-darwin", "x86_64-apple-darwin"):
        assert re.search(triple + r'\)\s*DF_SHA256="[0-9a-f]{64}"', sh), f"stage-sidecars.sh: no SHA-256 for {triple}"
    sh_urls = re.findall(r'https://[^"\s]*deep-?filter[^"\s]*', sh, re.I)
    assert sh_urls and all("latest" not in u and "/v0.5.6/" in u for u in sh_urls), f"stage-sidecars.sh: unpinned DeepFilterNet URLs: {sh_urls}"
    block = sh[sh.index("DF_URL="):]
    assert block.index('!= "$DF_SHA256"') < block.index('cp "$DF_TMP"') < block.index('chmod +x "$DF_TARGET"'), \
        "stage-sidecars.sh: stages DeepFilterNet before verifying"

    external = json.loads(_read("tauri", "src-tauri", "tauri.conf.json"))["bundle"]["externalBin"]
    assert "sidecar/deep-filter" in external, f"tauri.conf.json does not ship deep-filter: {external}"
    print("[PASS] DeepFilterNet is pinned by SHA-256 on Windows and both macOS architectures and shipped as a sidecar")


def _cargo_package_version(cargo_toml: str) -> str:
    # tomllib is 3.11+; the project supports 3.10, and only [package].version is needed.
    package = re.search(r"^\[package\]\s*$(.*?)(?=^\[|\Z)", cargo_toml, re.M | re.S)
    assert package, "Cargo.toml has no [package] section"
    version = re.search(r'^version\s*=\s*"([^"]+)"', package.group(1), re.M)
    assert version, "Cargo.toml [package] has no version"
    return version.group(1)


def test_versions_consistent():
    versions = {
        "VERSION": _read("VERSION").strip(),
        "tauri.conf.json": json.loads(_read("tauri", "src-tauri", "tauri.conf.json"))["version"],
        "package.json": json.loads(_read("tauri", "package.json"))["version"],
        "Cargo.toml": _cargo_package_version(_read("tauri", "src-tauri", "Cargo.toml")),
    }
    assert len(set(versions.values())) == 1, f"version mismatch: {versions}"
    print(f"[PASS] all versions are {versions['VERSION']}")


if __name__ == "__main__":
    test_ship_lists_match()
    test_app_local_imports_are_shipped()
    test_ffmpeg_pin_matches()
    test_deep_filter_pin_matches()
    test_versions_consistent()
    print("\n[OK] Release metadata suite passed")
