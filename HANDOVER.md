# Handover — 2026-08-28, Desktop App Architecture, Rotating Host, and Cloudflare Worker Registry

## State
DubMate Studio is transitioning from a browser-only tool to a standalone cross-platform desktop application with dynamic multiplayer host-handover. The Cloudflare Worker KV room registry is live on `dubmate.bkaproductions.com`. All 5 sub-projects are implemented and passing automated test suites.

## Done this session
- **Cloudflare Worker KV Registry (`worker/`)**: Deployed live to `dubmate.bkaproductions.com` with KV namespace `ROOMS` (`e954cacd7b034f8ca646c2142034614b`), handling `POST /rooms/create`, `POST /rooms/:code/update`, and `GET /rooms/:code/resolve` with secret key authentication and 12-hour TTL.
- **Rotating Host Protocol (`app.py`, `static/js/room_socket.js`, `static/js/app.js`)**: Implemented clean slate host transfer with lobby `👑 Make Host` button, confirmation warning modal, 10s server timeout guard, and room broadcast state reset.
- **Version Gating & Health Probe (`app.py`, `VERSION`)**: Added `/health` endpoint and enforced `min_required_version` on room creation and WebSocket `join` to prevent client desync.
- **Tauri v2 Desktop Shell (`tauri/`)**: Implemented Rust supervisor (`main.rs`, `state.rs`, `updater.rs`) managing Python FastAPI (port 8000) and cloudflared sidecars with automatic PID cleanup, plus obsidian/amber Launcher UI (`tauri/src/`).
- **CI/CD & Releases (`.github/workflows/`)**: Created `.github/workflows/publish-bundle.yml` (passing on `main`) and `.github/workflows/build-installer.yml`. Published official `DubMate v1.0.0` release on GitHub.

## In flight
- **Desktop Installer CI (`build-installer.yml`)**: Windows x64 `.msi` / `.exe` installer compilation in progress on GitHub Actions (`run/33171873581`). macOS universal target requires splitting into native `aarch64` / `x86_64` targets in the CI matrix.

## Next
1. Verify Windows `.msi` / `.exe` installer asset appears under GitHub Releases `v1.0.0` once CI run completes.
2. In `.github/workflows/build-installer.yml`, refine the macOS matrix entry to target `aarch64-apple-darwin` natively instead of `universal-apple-darwin` for standard Apple Silicon DMG packaging.
3. Test live host rotation end-to-end between two desktop client instances.

## Watch out
- `cloudflared` prints its `trycloudflare.com` URL to **`stderr`**, not stdout; the Rust supervisor in `main.rs` listens on `CommandEvent::Stderr`.
- Sidecars in `tauri/src-tauri/sidecar/` must retain their target triple suffix (e.g. `cloudflared-x86_64-pc-windows-msvc.exe`) on disk for Tauri packaging.
- The CPython embeddable package requires `import site` uncommented in `python312._pth` to find `Lib\site-packages`.

## Read first
- [`DESKTOP-APP-CHECKLIST.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/DESKTOP-APP-CHECKLIST.md) — Master implementation checklist for all 5 sub-projects.
- [`docs/superpowers/specs/2026-08-28-desktop-app-design.md`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/docs/superpowers/specs/2026-08-28-desktop-app-design.md) — Technical architecture and data models.
- [`worker/src/index.ts`](file:///c:/Coding%20SHoding/DubSmash%20AntiAliasing/worker/src/index.ts) — Live Cloudflare Worker KV registry implementation.
