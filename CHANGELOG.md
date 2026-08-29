# DubMate Studio Changelog

## [1.0.6] - 2026-08-29

### Fixed Desktop Webview 404 Route & Static Asset Resolution
- **Explicit Root & Asset Route Handlers**: Added direct `@app.get("/")`, `@app.get("/index.html")`, `@app.get("/builder")`, `/css`, and `/js` routes in `app.py` returning `FileResponse` directly to guarantee the DAW workspace UI loads instantly without relying solely on wildcard static mounting.
- **Dynamic Multi-Path Static Directory Discovery**: Implemented `find_static_dir()` checking bundled resources, executable directory, and development trees.
- **Clean Resource Staging**: Updated `stage-sidecars.ps1` and `stage-sidecars.sh` to remove existing destination folders before copying `static` assets, preventing nested folder structures (`static/static/`).

## [1.0.5] - 2026-08-28

### Desktop Packaging & Runtime Permissions
- **Safe User Home Caching**: Relocated internal `.cache` and temporary export directories to user space (`~/.dubmate/cache`), eliminating `PermissionError` (exit code 1) when running from restricted folders like `C:\Program Files`.
- **Complete Embedded Python Runtime**: Bundled full DLLs, standard library archive, `.pyd` dynamic extensions, and `Lib/site-packages` into desktop installer resources.
- **Direct Multi-Source Python Resolver**: Added automatic search paths in native Rust launcher with `PYTHONHOME`/`PYTHONPATH` configuration.
- **Live Error Diagnostics Capture**: Detailed stderr trace capture and telemetry reporting directly onto the launcher recovery card.
- **macOS Resource Staging Fix**: Corrected `$RESOURCE_DIR` definition order in `stage-sidecars.sh` to ensure universal macOS builds stage cleanly.

## [1.0.4] - 2026-08-28

### Desktop Launcher Startup Fixes
- **Non-Blocking Engine Launch**: Decoupled Python and Cloudflare sidecar startup from the synchronous GitHub OTA update check, eliminating startup stalls on offline or slow connections.
- **Tauri Global API Injection**: Enabled `withGlobalTauri` and configured static `devUrl` so event listeners (`server-ready`, `startup-progress`) trigger reliably.
- **Unbuffered Diagnostics**: Enabled Python `-u` unbuffered output and real-time process monitoring for clean startup telemetry.
- **Resilient Polling & Error Recovery**: Extended health check polling to 60s with progressive status updates, a dedicated error recovery card, and a "Retry Connection" action.

## [1.0.3] - 2026-08-28

### Unified Desktop & Web Experience
- Desktop application window now loads the authentic DubMate Studio Pro DAW interface directly on launch.
- Unified single room code architecture: removed duplicate codes between local engine and worker registry.
- Streamlined "Copy Code" invite workflow copying clean room codes for actor-to-actor `.exe` joining.
- Seamless public room code routing through `dubmate.bkaproductions.com` for cross-device and remote `.exe` multiplayer sessions.
- Bundled offline application resources and dynamic path resolution in desktop installers.

## [1.0.2] - 2026-08-28

### Performance
- Sub-second persistent pack indexing cache (`pack_index.json`) reducing 58+ scene pack boot time from 14.3s to 0.25s.
- Fast audio header probing for instant scene duration calculation without spawning external processes on cached assets.

### Improvements
- Local backend connectivity state monitoring and enhanced user feedback cards during initialization.
- GitHub Actions desktop installer CI workflow optimization for Windows and macOS native build runners.

## [1.0.1] - 2026-08-28

### Added
- Persistent startup scene pack folder configuration engine (`~/.dubmate/config.json`).
- Dynamic scene pack folder selector and obsidian/amber modal dialog in Desktop App Launcher.
- Empty state and error recovery card (`📁 Set Folder Location`) allowing instant pack folder selection.
- REST endpoints (`GET /api/config` & `POST /api/config`) for hot pack folder registration and cache invalidation.
- Standalone test executable compilation script and binary support.

### Fixed
- Fixed scene pack discovery for users running standalone `.exe` distributions outside the default folder.
- Fixed single-pack folder import and root directory resolution.

## [1.0.0] - 2026-08-28

### Added
- Cloudflare Worker KV room code registry (`https://dubmate.bkaproductions.com`) for ephemeral room mapping.
- Rotating host architecture allowing real-time session migration with clean slate safeguards.
- Liveness health probe (`/health`) and client/server version gating to prevent multiplayer desync.
- High-performance Web Audio DSP mastering, waveform alignment, noise reduction, and hardware-accelerated video export.
