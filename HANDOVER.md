# Handover — 2026-08-28, DubMate v1.0.1 Performance & Pack Persistence

## State
DubMate Studio `v1.0.1` has sub-second scene pack indexing (cached down from 14s to 0.25s), persistent folder location discovery in `~/.dubmate/config.json`, robust error handling for local engine connectivity, and official setup installer binaries compiled and downloaded into `test_executables/`.

## Done this session
- **Sub-Second Indexing & Persistent Pack Cache (`pack_loader.py`)**: Added persistent `pack_index.json` caching and audio header duration probing. Loading 58 packs dropped from 14.3s to 0.25s.
- **Connection Error Handling (`static/js/app.js`, `tauri/src/launcher.js`)**: Enhanced error cards and feedback to clearly indicate local backend status when port 8000 is still booting or unreachable.
- **Persistent Pack Configuration**: Added dynamic directory resolution and `GET/POST /api/config` endpoints.
- **Official GitHub Release v1.0.1**: Built, tagged, uploaded `app-bundle-v1.0.1.zip`, and compiled `DubMate.Studio_1.0.1_x64-setup.exe` in GitHub Actions.
- **Automated Test Validation**: `test_config_pack_path.py` (4/4 passed) and `test_pack_security.py` (11/11 passed).

## Next
1. Launch `test_executables/DubMate.Studio_1.0.1_x64-setup.exe` or `run_web_studio.bat`.
2. Select or customize your scene pack directory with `📁 Packs Folder`.
3. Create room and verify ADR booth workflow.

## Read first
- [`test_executables/DubMate.Studio_1.0.1_x64-setup.exe`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/test_executables/DubMate.Studio_1.0.1_x64-setup.exe)
- [`CHANGELOG.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/CHANGELOG.md)
