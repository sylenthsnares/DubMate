# Handover — 2026-08-28, DubMate v1.0.1 Release & Pack Path Persistence

## State
DubMate Studio `v1.0.1` is published on GitHub Releases with persistent scene pack folder discovery, desktop launcher modal controls, and official setup installer binaries compiled and downloaded into `test_executables/`.

## Done this session
- **Persistent Pack Configuration (`pack_loader.py`)**: Added `load_config()`, `save_config()`, and `set_custom_packs_dir()` persisting custom scene pack directories to `~/.dubmate/config.json` with fallback to `BASE_DIR/dubmate_config.json`.
- **Config REST Endpoints (`app.py`)**: Added `GET /api/config` and `POST /api/config` endpoints to retrieve active pack paths, update custom folders dynamically, trigger hot disk rescans, and return updated pack registries.
- **Desktop Launcher & Web Studio UI Controls (`tauri/src/`, `static/`)**:
  - Added `📁 Packs Folder` toolbar button and empty state recovery card.
  - Implemented obsidian/amber modal dialogs for typing/pasting custom paths or browsing directories with instant scan and feedback.
- **Official GitHub Release v1.0.1**: Bumped version across repository, tagged `v1.0.1`, updated `CHANGELOG.md`, and published release on GitHub.
- **CI Installer Compilation**: GitHub Actions successfully compiled and uploaded `DubMate.Studio_1.0.1_x64-setup.exe` and `DubMate.Studio_1.0.1_x64_en-US.msi`.
- **Local Testing Sandbox**: Automatically fetched and staged `DubMate.Studio_1.0.1_x64-setup.exe` and `.msi` into `test_executables/`.

## Next
1. Test live room creation and custom pack folder selection with `DubMate.Studio_1.0.1_x64-setup.exe`.
2. Test live host rotation end-to-end between two desktop client instances.

## Watch out
- `~/.dubmate/config.json` is user-global so desktop updates will preserve custom scene pack paths across versions.
- If custom pack folders are changed inside the UI, the choice is saved permanently.

## Read first
- [`test_executables/DubMate.Studio_1.0.1_x64-setup.exe`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/test_executables/DubMate.Studio_1.0.1_x64-setup.exe) — Latest compiled installer.
- [GitHub Release `v1.0.1`](https://github.com/sylenthsnares/DubMate/releases/tag/v1.0.1) — Live GitHub release page.
- [`CHANGELOG.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/CHANGELOG.md) — Release notes and change history.
