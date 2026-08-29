# Handover — 2026-08-29, DubMate Studio v1.0.9 OTA Engine Restart, Security Hardening & Optional AI Pipeline

## State
`VERSION` is `1.0.9`. The headline fix is that OTA updates now actually take effect: the desktop
launcher restarts the Python engine after extracting a bundle, so the 1.0.6–1.0.8 backend fixes that
landed on disk but stayed inert in memory finally apply on the launch that downloads them. Alongside
that, the release carries a security pass over the worker registry, the Python API surface and the
studio frontend, moves working data onto the drive the user installed to, and adds an optional Pack
Builder AI pipeline as a real component in the Windows installer. `CHANGELOG.md` has the full list.

## Done this session
- **Engine Restart After OTA (`tauri/src-tauri/src/main.rs`)**: `apply_update` now calls
  `kill_sidecars` + `start_sidecars` after `download_and_extract_bundle`, and the update check
  compares against the `VERSION` file on disk rather than a compiled-in literal.
- **Update Safety (`tauri/src-tauri/src/updater.rs`)**: added `is_newer` (numeric per-segment
  comparison, so no silent downgrade onto an older tag), `ensure_writable` write preflight before
  extraction, and `is_trusted_update_url` so only this project's own release assets are extracted.
- **Windows Is NSIS Only**: `tauri.conf.json` bundles `["nsis", "app", "dmg"]` with
  `installMode: "currentUser"`, so the install directory is writable and OTA applies without elevation.
- **Optional Pack Builder AI Pipeline**: `installer.nsi` adds a components page with an unchecked-by-default
  `SecPackBuilder` section (~2 GB PyTorch + Demucs + Whisper) that writes a `packbuilder.optin` marker;
  packages install to `<install dir>/ai-packages` and are downloaded on first launch with progress.
  `install_packbuilder` / `remove_packbuilder` manage it afterwards, each restarting the engine.
  `installer-hooks.nsh` is now only uninstall cleanup.
- **Working Data Moved Off the System Drive (`pack_loader.py`)**: `get_cache_dir()` now prefers
  `DUBMATE_CACHE_DIR`, then `cache_dir` in `config.json`, then `<install root>/data`, falling back to
  `~/.dubmate/cache` and temp. Exports, peaks and `pack_index.json` follow it; `/api/config` reports
  `cache_dir`, `exports_dir` and `install_root`.
- **Dynamic Engine Port**: the launcher picks the first bindable port from 8000 (`find_available_port`)
  and passes it as `DUBMATE_PORT`; `app.py`'s `get_engine_port()` reads it and falls back to 8000.
- **Registry Key Is No Longer Hardcoded (`app.py`, `tauri/src-tauri/src/main.rs`, `build.rs`)**:
  `X-DubMate-Key` comes from `DUBMATE_WORKER_KEY` — compiled in from a CI secret and forwarded to the
  engine, or read from `.dubmate.env` in a source checkout. No fallback literal; an unset key just
  disables public room registration. See `.dubmate.env.example`.
- **Security Pass**: room-hijack and open-redirect fixes in `worker/src/index.ts`, `safe_join()` path
  traversal fixes and `user_id` validation in `app.py`, `claim_host`/`assign_role` authorization,
  ZIP extension-allowlist bypass in `pack_loader.py`, stored XSS escaping in `static/js/`, and CORS
  credentials disabled.
- **Release Notes Per Version**: `publish-bundle.yml` now extracts only the `## [VERSION]` section of
  `CHANGELOG.md` for the release body and fails the build if it is missing.

## Next
1. Push git commits and tag `v1.0.9` (tags currently stop at `v1.0.8`) to trigger the release pipelines.
2. Verify the NSIS installer and the app bundle zip on GitHub Releases, and confirm the release body
   contains only the 1.0.9 section.
3. Confirm an OTA update from a 1.0.8 install applies and the engine restarts on the same launch.

## Read first
- [`../CHANGELOG.md`](../CHANGELOG.md) — full 1.0.9 entry, source of truth for shipped behaviour
- [`../app.py`](../app.py) — engine, API surface, worker key and port resolution
- [`../pack_loader.py`](../pack_loader.py) — install root, cache/exports/data directory resolution
- [`../pack_builder.py`](../pack_builder.py) — AI pipeline, `ai-packages` path injection
- [`../tauri/src-tauri/src/main.rs`](../tauri/src-tauri/src/main.rs) — launcher, sidecars, `apply_update`
- [`../tauri/src-tauri/src/updater.rs`](../tauri/src-tauri/src/updater.rs) — OTA download, extract, version compare
- [`../tauri/src-tauri/installer.nsi`](../tauri/src-tauri/installer.nsi) — Windows components page
- [`../worker/src/index.ts`](../worker/src/index.ts) — public room registry
