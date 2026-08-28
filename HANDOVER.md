# Handover — 2026-08-28, DubMate v1.0.1 Release & Pack Path Persistence

## State
DubMate Studio `v1.0.1` is published on GitHub Releases with persistent scene pack folder discovery, desktop launcher modal controls, and standalone binary assets.

## Done this session
- **Persistent Pack Configuration (`pack_loader.py`)**: Added `load_config()`, `save_config()`, and `set_custom_packs_dir()` persisting custom scene pack directories to `~/.dubmate/config.json` with fallback to `BASE_DIR/dubmate_config.json`.
- **Config REST Endpoints (`app.py`)**: Added `GET /api/config` and `POST /api/config` endpoints to retrieve active pack paths, update custom folders dynamically, trigger hot disk rescans, and return updated pack registries.
- **Desktop Launcher UI Controls (`tauri/src/`)**:
  - Added `📁 Pack Folder` configuration button in the header and quick `📁 Set Folder` link next to the pack selector.
  - Added warning banner and recovery prompt if 0 scene packs are found in the default location.
  - Implemented modal dialog for typing/pasting custom paths or browsing directories with instant scan and feedback.
- **Local Test Executable (`test.exe`)**: Compiled a standalone Windows x64 test executable [`test.exe`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/test.exe) that boots the server, loads the persistent configuration, and auto-opens the studio in the default browser.
- **Official GitHub Release v1.0.1**: Bumped version across repository, tagged `v1.0.1`, updated `CHANGELOG.md`, and published release on GitHub with `app-bundle-v1.0.1.zip` and `test.exe`.
- **Automated Verification**: Created `test_config_pack_path.py` (all 4 tests passing) and verified `test_pack_security.py` (all 11 tests passing).

## Next
1. Verify CI build installer matrix for `v1.0.1` completes and uploads `.msi` and `.exe` installer binaries.
2. In `.github/workflows/build-installer.yml`, refine macOS matrix entry to target `aarch64-apple-darwin` natively.
3. Test live host rotation end-to-end between two desktop client instances.

## Watch out
- `test.exe` runs the complete backend with persistent pack discovery; double-clicking it opens the studio at `http://127.0.0.1:8000`.
- If custom pack folders are changed inside the UI, the choice is saved permanently to `~/.dubmate/config.json`.

## Read first
- [GitHub Release `v1.0.1`](https://github.com/sylenthsnares/DubMate/releases/tag/v1.0.1) — Live GitHub release page.
- [`CHANGELOG.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/CHANGELOG.md) — Release notes and change history.
- [`test_config_pack_path.py`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/test_config_pack_path.py) — Pack directory config test suite.
