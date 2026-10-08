# -*- coding: utf-8 -*-
"""
test_release_metadata.py
Keeps the three release ship lists in sync and the version numbers consistent.

The app bundle is assembled in three places: the GitHub release zip, the Windows
sidecar staging script and the macOS one. A module added to one list but not the
others ships a build that fails to import on that platform only. LICENSE and
THIRD_PARTY_NOTICES.md ride the same lists into both installers and the update zip.

release.yml publishes in two steps (documentation/design/v2-installer.md, section 5):
the bundle job makes a draft, the installer jobs attach to it by id, and only the
publish job makes it public, after all three assets are there. build_only publishes
nothing. Read with PyYAML, which uvicorn[standard] in requirements.txt brings along.
"""

import ast
import json
import os
import re

import yaml

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


LEGAL_FILES = ("LICENSE", "THIRD_PARTY_NOTICES.md")


def test_legal_files_ship():
    lists = {"release.yml": _release_yml_list(), "ps1": _ps1_list(), "sh": _sh_list()}
    for name, ship in lists.items():
        missing = [f for f in LEGAL_FILES if f not in ship]
        assert not missing, f"{name} does not ship {missing}"
    for entry in sorted(set().union(*lists.values())):
        if not os.path.exists(os.path.join(PROJECT_ROOT, entry)):
            hint = " Merge fix/v2-notices first." if entry == "THIRD_PARTY_NOTICES.md" else ""
            raise AssertionError(f"{entry} is in the ship lists but not in the repo.{hint}")
    print(f"[PASS] {' and '.join(LEGAL_FILES)} ship in the zip and both installers, and every shipped entry exists")


def _workflow():
    return yaml.safe_load(_read(".github", "workflows", "release.yml"))


def _step(job, uses=None, name=None):
    for step in job["steps"]:
        if (uses and step.get("uses", "").startswith(uses)) or (name and step.get("name") == name):
            return step
    raise AssertionError(f"no step uses={uses!r} name={name!r}")


def _tauri_steps(installers):
    """(release build, build_only build): the two tauri-action steps, told apart by their if."""
    steps = [s for s in installers["steps"] if s.get("uses", "").startswith("tauri-apps/tauri-action")]
    release = [s for s in steps if s.get("if") == "${{ !inputs.build_only }}"]
    build_only = [s for s in steps if s.get("if") == "${{ inputs.build_only }}"]
    assert len(release) == 1 and len(build_only) == 1, f"expected one release and one build_only tauri-action step: {steps}"
    return release[0], build_only[0]


def test_version_check_treats_a_draft_as_unreleased():
    run = _step(_workflow()["jobs"]["bundle"], name="Check whether this version is already released")["run"]
    assert "--json isDraft" in run and "-q .isDraft" in run, "the version check doesn't read isDraft"
    assert re.search(r'if \[ "\$\w+" = "false" \]; then\s*\n\s*echo "is_new=false"', run), \
        f"is_new=false must need isDraft == 'false':\n{run}"
    # Only "not found" may count as new: guessing on any other error would draft a published release.
    not_found = run.index("release not found")
    assert "exit 1" in run[not_found:run.index('if [ "$is_draft" = "false" ]')], "a failed check must stop the run"
    print("[PASS] a leftover draft counts as unreleased, so the next run rebuilds it")


def test_bundle_creates_a_draft():
    bundle = _workflow()["jobs"]["bundle"]
    step = _step(bundle, uses="softprops/action-gh-release")
    w = step["with"]
    # A new version (or a leftover draft) is a draft; a manual rebuild of a published one stays published.
    assert w.get("draft") == "${{ steps.check.outputs.is_new == 'true' }}", f"the bundle step must create a draft: {w}"
    # A draft can't be latest; a rebuilt published release keeps GitHub's own choice
    # ("legacy": newest by date and version), so it doesn't lose "latest" mid-build.
    assert w.get("make_latest") == "${{ steps.check.outputs.is_new == 'true' && 'false' || 'legacy' }}", (
        f"the draft must not become latest, and a rebuild must not drop it: {w}")
    assert w.get("target_commitish") == "${{ github.sha }}", f"the tag must point at this commit when published: {w}"
    assert step.get("id") == "release"
    assert bundle["outputs"].get("release_id") == "${{ steps.release.outputs.id }}", bundle["outputs"]
    assert "!inputs.build_only" in step["if"], step["if"]
    print("[PASS] the bundle job creates a draft (not latest) and hands its id to the installers")


def test_installers_attach_to_the_draft_by_id():
    release, _ = _tauri_steps(_workflow()["jobs"]["installers"])
    w = release["with"]
    assert w.get("releaseId") == "${{ needs.bundle.outputs.release_id }}", f"tauri-action must upload to the draft by id: {w}"
    assert w.get("releaseDraft") is True, w
    assert "tagName" not in w, "a draft isn't found by tag: give tauri-action the releaseId only"
    assert w.get("releaseBody") == "${{ env.RELEASE_NOTES }}", w
    print("[PASS] both installer jobs attach to the draft by its id")


def test_only_publish_makes_the_release_public():
    jobs = _workflow()["jobs"]
    publish = jobs.get("publish")
    assert publish, "release.yml has no publish job"
    assert sorted(publish["needs"]) == ["bundle", "installers"], publish["needs"]
    cond = publish["if"]
    for part in ("needs.installers.result == 'success'", "!inputs.build_only", "needs.bundle.outputs.release_id != ''"):
        assert part in cond, f"publish job if: is missing {part!r}: {cond}"
    for name, job in jobs.items():
        if name == "publish":
            continue
        text = yaml.safe_dump(job)
        assert "--draft=false" not in text and "--latest" not in text, f"{name} publishes the release"
        for step in job["steps"]:
            w = step.get("with") or {}
            assert w.get("draft", True) is not False and w.get("releaseDraft", True) is not False, \
                f"{name}: {step.get('name')} creates a public release"
    run = "\n".join(s.get("run", "") for s in publish["steps"])
    edit = run.index("gh release edit")
    for asset in (r"app-bundle-.*\.zip", r"-setup\.exe", r"\.dmg"):
        assert asset in run[:edit], f"publish doesn't check for {asset} before it publishes"
    assert "--draft=false" in run[edit:] and "--latest" in run[edit:], run
    print("[PASS] only the publish job makes the release public, after both installers and all three assets")


def test_build_only_steps_unchanged():
    installers = _workflow()["jobs"]["installers"]
    _, build_only = _tauri_steps(installers)
    assert build_only == {
        "name": "Build Tauri Desktop Installer (build only)",
        "if": "${{ inputs.build_only }}",
        "uses": "tauri-apps/tauri-action@v0",
        "env": {"DUBMATE_WORKER_KEY": "${{ secrets.DUBMATE_SECRET_KEY }}"},
        "with": {"projectPath": "tauri", "args": "${{ matrix.tauri-args }}"},
    }, build_only
    upload = _step(installers, name="Upload installers as workflow artifacts (build only)")
    assert upload == {
        "name": "Upload installers as workflow artifacts (build only)",
        "if": "${{ inputs.build_only }}",
        "uses": "actions/upload-artifact@v4",
        "with": {
            "name": "installer-${{ matrix.platform }}-v${{ needs.bundle.outputs.version }}",
            "path": "tauri/src-tauri/target/**/bundle/nsis/*.exe\ntauri/src-tauri/target/**/bundle/dmg/*.dmg\n",
            "if-no-files-found": "error",
            "retention-days": 14,
        },
    }, upload
    print("[PASS] build_only still builds both installers and uploads them to the run only")


# Strings the custom template must still hold after Tauri renders it.
NSIS_MARKERS = ("/KEEPDATA", "${If} $ReinstallPageCheck = 0", "Also remove Pack Builder and my DubMate data")


def test_windows_checks_the_generated_installer():
    installers = _workflow()["jobs"]["installers"]
    names = [s.get("name") for s in installers["steps"]]
    step = _step(installers, name="Check the generated Windows installer")
    assert step["if"] == "matrix.platform == 'windows-latest'", f"must run in both modes: {step['if']}"
    assert step.get("shell") == "pwsh"
    assert names.index(step["name"]) > max(names.index(s["name"]) for s in _tauri_steps(installers)), \
        "the check must run after both build steps"
    assert "tauri/src-tauri/target/release/nsis/x64/installer.nsi" in step["run"]
    template = _read("tauri", "src-tauri", "installer.nsi")
    for marker in NSIS_MARKERS:
        assert marker in step["run"], f"the check doesn't look for {marker!r}"
        assert marker in template, f"installer.nsi no longer has {marker!r}"
    assert "exit 1" in step["run"]
    print("[PASS] the Windows job fails if Tauri's generated installer.nsi lost the keep-data changes")


if __name__ == "__main__":
    test_ship_lists_match()
    test_app_local_imports_are_shipped()
    test_ffmpeg_pin_matches()
    test_deep_filter_pin_matches()
    test_versions_consistent()
    test_legal_files_ship()
    test_version_check_treats_a_draft_as_unreleased()
    test_bundle_creates_a_draft()
    test_installers_attach_to_the_draft_by_id()
    test_only_publish_makes_the_release_public()
    test_build_only_steps_unchanged()
    test_windows_checks_the_generated_installer()
    print("\n[OK] Release metadata suite passed")
