# DubMate Feature Backlog (after the codebase cleanup)

This list was written at the end of the `chore/codebase-cleanup` branch (base `259ae06`). Every item was checked against the code at the time of writing. Sizes are rough: **S** is under a day, **M** is 1 to 3 days, **L** is more than that.

Anything removed can be brought back from git: `git show <sha>^:<path>` gives the file as it was before the commit that removed it.

---

## Removed in the cleanup

Nothing here was used, wired up or working when it was removed. It is listed in case you want any of it back as a real feature.

### Rooms and multiplayer
- **"Make Host" hand-off** (`8ce0784`, S08). This was the lobby button plus its confirm modal and migration overlay (`initHostTransferModals` and related code in `static/js/app.js`), the `initiate_transfer` / `complete_transfer` WS branches in `app.py`, `room_socket.initiateTransfer` / `completeTransfer`, and the Tauri commands `get_tunnel_url`, `get_room_token` and `set_room_token`. Why it went: it never worked end to end. The server ignored `new_room_id` and wiped every take, and nobody was sent to the new room. If it comes back it needs a new design (see Missing features). **L**
- **Client version gate** (`8ce0784`, S08). This covered the `version_mismatch` message, the "DubMate Update Required" modal, `Room.min_required_version` and `app.is_version_outdated`. Why it went: every client sent `window.__dubmate_app_version || "1.0.0"` and nothing ever set that variable, so the gate could never fire. **S**
- **Worker `POST /rooms/:code/update`**, plus the `UpdateRoomRequest` and `UpdateRoomResponse` types (`5b58cec`, S09, `worker/src/`). Why it went: nothing called it, and anyone with the shared key could use it to repoint a live room. It is still live on Cloudflare until `npm run cf:deploy` is run.
- **WS message types `claim_host` and `toggle_noise_reduction`** (`93893cf`, S03, `app.py`). They are now silently ignored. The HTTP noise-reduction toggle is still there.
- **Room rebuilt from `take_line_*.wav` files when `room_state.json` is missing** (`93893cf`, S03, `load_persisted_rooms`). Why it went: it attached the room to whichever pack happened to be first, so line indices pointed at the wrong pack.

### Audio
- **COMPRESS rocker in the booth** (`check-compressor`) and the preview-only Web Audio `DynamicsCompressor` in `buildVocalDSPChain` (`a6caef8`, B3; `static/index.html`, `static/js/audio_engine.js`). Why it went: exports were never compressed, so previews played several dB away from the final mix. To bring it back properly, send it with the take params and apply it in `apply_audio_effects`. **M**
- **Backend compressor branch** and the `enable_lowcut` / `enable_compressor` params of `audio_processor.apply_audio_effects` (`698ebc2`, S21). No caller ever passed them.
- **`pack_loader.get_cached_line_loudness` and the stale `*_loudness.json` reads** (`a6caef8`, B3). These were replaced by lazy, mtime-keyed `measure_line_loudness`. `PackInfo.mean_vocal_loudness_db` is no longer computed.

### Pack Builder
- **Touch resizing of the timeline splitter** (`029a760`, S15, `static/js/pack_builder.js`). It never worked, because no `touchmove` or `touchend` handler was registered. Real touch support is listed under Missing features.
- **`GET /api/builder/{session_id}/audio/{track}`** (`93893cf`, S03, `app.py`). Nothing fetched it. It is the route that stem playback in the builder would need (see Half-built features).

### Frontend and UI
- **`#booth-character-badge`**, a static "Character" chip that was never updated (`003229e`, S14, `static/index.html`).
- **`promptSetPackFolder()`**, the `GET /api/packs?rescan=true` fallback, `AudioEngine.isMonitoringInput()`, the `AnalogKnob` options `sensitivity` / `unit` / `accentColor` and `updateFromInput()` (`003229e`, S14). All of these were dead code.
- **The `window.app` and `window.packBuilderApp` globals** (`cc62544`, S26). `window.dubMateApp` remains.
- **`?v=` cache-busting** on the CSS and JS URLs in `index.html` and `builder.html` (S14, S15). The server's ETag revalidation already handles caching.

### Backend routes and desktop
- **`GET/POST /api/admin/clean`**, `GET /api/tunnel` (POST kept), the `/static/*` mount and the extensionless `/builder` route (`93893cf`, S03). Why they went: admin/clean was unauthenticated and anyone could reach it through the tunnel.
- **Tauri `remove_packbuilder` command**, the unheard `packbuilder-complete` event, `tauri/src/launcher.css`, the vite/dev npm scripts and `shell:*` capabilities (`f11ab14`, S07). The installer used to promise "add or remove it later from the app". There is no UI for that (see Missing features).

### Scripts, docs and CI
- **`scripts/launch_local.py`**, the PyInstaller-era launcher (`f3af57b`, S06).
- **Legacy root-level `cloudflared.exe` migration and TEMP zip reuse** in `download_tools.ps1`, `run_cloudflare.bat` and `update.bat` (`f3af57b`, S06).
- **`documentation/HANDOVER.md`, `DESKTOP-APP-CHECKLIST.md` and `README_MAC.md`** (`6eb55bb`, S40). The checklist's pitfalls table now lives in the README Notes, and the Mac guide is merged into the README.
- **The CI step that ran `tests/test_host_transfer.py` on its own** (`dbadfe6`, S39). CI now runs the whole suite instead.

---

## Half-built features to finish

### 1. Wire up Studio (synced prompter) mode — M
- The lobby offers a Studio mode card (`static/index.html` `#mode-card-studio`, which calls `socket.setMode('studio')`), but nothing ever sends `set_line`. `RoomSocket.setLine` (`static/js/room_socket.js`) has no caller, so Studio behaves exactly like Booth.
- The receiving side is already there. `dubmate/room_ws.py` handles `set_line` and broadcasts `line_changed`. In `app.js`, the `line_changed` handler calls `loadBoothLine` when the mode is `studio`, and `applyIncomingState` takes `current_line` from the server in Studio mode.
- What's left: when the host changes line in Studio mode (`loadBoothLine` and the next/prev controls), send `setLine`. Make `set_mode` and `set_line` host-only on the server, because today any member can send them. Decide whether non-hosts can still navigate or record freely. Add a JSDOM test.

### 2. Make Calibrate Mic real (profile-based noise reduction) — M/L
- `audio_processor.apply_noise_reduction(noise_profile_wav=...)` never reads the profile. Both the DeepFilterNet path and the `afftdn` fallback ignore it. `save_uploaded_take` and `toggle_take_noise_reduction` resolve the profile path only to pass it into that unused parameter.
- The UI says otherwise. `calibrateMicNoiseProfile` in `static/js/app.js` shows "Computing spectral noise fingerprint via FFT" and "Custom noise fingerprint saved", then re-applies noise reduction "with new profile". The output is byte-identical with or without a profile.
- Re-applying can't pick up a new profile anyway. `toggle_take_noise_reduction` reuses an existing `take_line_N_denoised.wav`.
- Reset (`resetMicNoiseProfile`) only flips `hasCustomNoiseProfile` on this client. The server file `noise_profile_<user>.wav` is never deleted, because there is no DELETE route.
- What's left:
  - Use the profile in the fallback path, either with spectral subtraction in numpy or with `afftdn` noise sampling, and decide how it combines with DeepFilterNet.
  - Clear the cached denoised takes when the profile changes.
  - Add a DELETE `/api/rooms/{id}/noise_profile` route for Reset.
  - Make the UI text honest. The modal also records 3 s while the backend docstring says 1 s.

### 3. Pack Builder "Vocals Only / Full Audio" toggle — S/M
- `btnToggleAudioTrack` in `static/js/pack_builder.js` only refetches the waveform peaks. `editorVideo` always plays the original audio. The labels were made honest in S15, but auditioning the isolated stem is still missing.
- The route it needs was removed in S03 (`93893cf`, `builder_serve_audio_track`). Restore it into `dubmate/builder_api.py` and switch playback, or add a muted video plus a stem `<audio>` element synced to it.

### 4. Low Cut rocker only affects the preview — S
- In the booth, `#check-lowcut` feeds `enableLowCut` into the Web Audio preview chain (`static/js/audio_engine.js`). The export always applies `highpass=f=80` (`audio_processor.apply_audio_effects`), and no low-cut flag reaches the server. Turning Low Cut off changes the preview but not the export.
- Either send it with the take params and honour it in `apply_audio_effects`, or remove the rocker as was done for COMPRESS.

---

## Missing features / gaps

### 5. Host hand-off, done properly — L
The old flow was removed (see above). A working version needs to move the room state (takes, casting, pack) to the new host's engine, re-register the room code with the worker under the new tunnel URL, and redirect every member with `?room=`. It also has to handle the `?home=` origin that B2 added.

### 6. Version compatibility between host and members — S
Members' webviews load the host's frontend, but nothing compares app versions any more. The real version is already available from `GET /health` (`read_version()`). Compare it when joining and show a friendly warning if the major or minor versions differ.

### 7. Browser-joined members have no "home" — S/M
B2 only fixes members who joined through their own desktop engine. Someone who joined from a plain browser link still lands on the host's landing page and packs after Leave Room (`goHome()` in `static/js/app.js` falls back to the old behaviour). That page should show a "You left the session" screen instead of the host's library.

### 8. ZIP exports are saved twice on the host machine — S
B4 fixed video downloads only. `downloadFullProjectZip` (`static/js/studio/export.js`) and the pack-card ZIP button (`static/js/app.js`, `.btn-pack-download-icon`) still go through `saveRemoteFile`. The server has already written the ZIP to `exports_dir()` (`dubmate/rooms_api.py` `download_room_project_zip`, `dubmate/packs_api.py` `export_pack_zip`), so a local host gets a second copy in Downloads. Use the same `isEngineLocal()` branch as `downloadExportVideo`.

### 9. DeepFilterNet never ships with the desktop app — M
`scripts/download_tools.ps1` fetches `deep-filter.exe` for source installs. `tauri/scripts/stage-sidecars.ps1` doesn't stage it, so installed desktop builds always use the weaker `afftdn` fallback. Decide whether to bundle it (adds to installer size) or offer it as an optional download like the Pack Builder.

### 10. FFmpeg version drift between install paths — S
Staging pins FFmpeg 7.0.2 (`stage-sidecars.ps1`). `download_tools.ps1` pulls whatever is latest from gyan.dev or BtbN. Pin one version in both places.

### 11. Real download progress for updates — S
`updater.rs` `download_and_extract_bundle` reads the whole bundle with `.bytes()` and then emits a single `update-progress` event at 100%. Stream it with `bytes_stream()` (re-enable the reqwest `stream` feature) and emit progress as it downloads.

### 12. Remove the Pack Builder from inside the app — S
The installer lets users opt in to the AI Pack Builder (`packbuilder.rs` `install_packbuilder`), but there is no uninstall. The unused `remove_packbuilder` command was deleted in `f11ab14`. Add it back together with a settings button, or leave it out on purpose.

### 13. macOS tunnel launcher — S
Windows has `run_cloudflare.bat`. On a source install on macOS you have to start `scripts/run_tunnel.py` by hand next to `./run_mac.sh`. A `run_cloudflare.sh` would close that gap.

### 14. Missing `.btn-xs` styles — S
`btn-xs` is used on about ten buttons: the builder zoom, track toggle and add-lane buttons, the Whisper and Romaji cue buttons, Auto Match in the booth, and the presence presets. No CSS defines it, so these render as the base `.btn` size.

### 15. Real touch support in the Pack Builder timeline — M
The broken touch handler was removed in S15. The splitter, cue drag and scrub are mouse-only. Pointer Events would cover mouse, touch and pen with one code path.

---

## Bugs still open

- **User-reported bugs B1 to B5:** all five landed (`91b1465`, `182501a`, `a6caef8`, `d0d0d28`, `43d58b5`). None are open. The edges they left behind are items 7 and 8 above.
- **A registry test sends a real request to the production worker — S.** `tests/test_room_registry.py::test_a_failed_tunnel_is_reported_instead_of_waiting_forever` posts a tunnel URL without pointing `room_registry.WORKER_REGISTRY_BASE` at the `StubRegistry`. On a machine with a worker key it publishes a test room to `dubmate.bkaproductions.com`. Wrap it in the stub the same way the other tests do.
- **Any member can switch the room mode or line — S.** `set_mode` and `set_line` in `dubmate/room_ws.py` have no host check, unlike `assign_role`. This doesn't matter until Studio mode is wired up (item 1), and should be fixed then.

---

## Deferred cleanup

- **S38: remove the dead `externalBin` python shell-sidecar fallback.** This is `tauri.conf.json` `"sidecar/python-runtime/python"` and the `app.shell().sidecar("python")` block in `sidecars.rs`. It needs a packaged NSIS build, an install check and a macOS `workflow_dispatch` release run to verify.
- **Worker:**
  - Make `code` required and drop the `DUB-` fallbacks and `generateRoomCode` (worker-02).
  - Decide whether `bkaproductions.com` stays in `ALLOWED_TUNNEL_URL_DOMAINS` (OQ4).
- **Scripts:** route `run_cloudflare.bat` / `update.bat` through `download_tools.ps1` (hygiene-10). This also needs a cloudflared-only mode so the launchers don't pull FFmpeg.
- **Tauri:** stage only the macOS host triple in `stage-sidecars.sh` and remove `|| true` (tauri-14). This needs macOS CI runs to verify.
- **Backend:**
  - Unify `launch_premiere`'s render with `/export` (py-app-03 part 4).
  - Clean up the WS dispatch: a dispatch dict and `_parse_line_index` (py-app-10).
  - Replace scipy `fftconvolve` with a numpy convolution and drop scipy, for a smaller install (py-audio-10).
- **Frontend:**
  - Split booth, packs and lobby out of `app.js`.
  - Dedupe `pack_builder.js` and split its timeline code.
  - Dedupe `AudioEngine.playBuffer` / `_startBacking` and the waveform `_drawPeaks` / `_drawBadge`.
  - Turn hard-coded hex colours in `style.css` into tokens.
