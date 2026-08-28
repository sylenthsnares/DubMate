# DubMate Studio Changelog

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
