# DubMate Studio Changelog

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
