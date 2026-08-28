# Handover — 2026-08-28, DubMate v1.0.3 Unified UI & Public Room Architecture

## State
DubMate Studio `v1.0.3` is live on GitHub Releases (`app-bundle-v1.0.3.zip` published, desktop installers compiling). The desktop `.exe` directly loads the full DubMate Studio Pro DAW interface into the native window upon engine readiness. Multiplayer room codes are unified into a single clean identifier (e.g. `QM9K29`) across local engine and `dubmate.bkaproductions.com`.

## Done this session
- **Unified Desktop Interface (`tauri/src/index.html`, `tauri/src/launcher.js`)**: Eliminated disconnected mini-launcher and replaced it with a fast startup bridge that loads `http://127.0.0.1:8000` directly into the desktop window.
- **Single Room Code Architecture (`app.py`, `worker/src/index.ts`, `static/js/app.js`)**: Removed code discrepancies between local room IDs and Worker KV entries.
- **Streamlined Invite Workflow (`static/js/app.js`, `static/index.html`)**: "Copy Code" button copies clean room code strings for actor-to-actor `.exe` joining.
- **Public Domain Multi-Actor Resolution (`static/js/app.js`, `worker/src/index.ts`)**: Joining a non-local room code automatically resolves the host tunnel through `https://dubmate.bkaproductions.com/rooms/{CODE}/resolve`.
- **Dynamic Path & Offline Resource Bundling (`tauri.conf.json`, `main.rs`, `stage-sidecars.ps1`, `stage-sidecars.sh`)**: Staged application files and dynamic `find_app_py()` resolver so standalone installers run out of the box.
- **Release v1.0.3 Published**: Bumped version, tagged, and pushed to remote; triggered `Publish App Bundle` and `Build Desktop Installers`.

## Next
1. Download `DubMate.Studio_1.0.3_x64-setup.exe` / macOS `.dmg` once GitHub Actions compilation completes on [Release v1.0.3](https://github.com/sylenthsnares/DubMate/releases/tag/v1.0.3).
2. Launch the desktop `.exe`, create a scene session, and verify that "Copy Code" copies the room code.
3. Test a multi-actor session by having a second machine/instance join with that room code via `dubmate.bkaproductions.com`.

## Read first
- [`CHANGELOG.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/CHANGELOG.md)
- [`VERSION`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/VERSION)
- [`DESKTOP-APP-CHECKLIST.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/DESKTOP-APP-CHECKLIST.md)
