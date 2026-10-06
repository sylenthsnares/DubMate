# DubMate Roadmap

This plan comes from the October 2026 interview. It replaces FEATURE_BACKLOG.md. Sizes are rough: **S** is under a day, **M** is 1–3 days, **L** is more than that. Every feature gets a short design review with the owner before any code is written.

## Decisions

These are settled; don't reopen them without a reason.

### Product
- **Name.** DubMate. "Studio" and "Pack Builder" only label the two surfaces.
- **Cut.** Studio (synced prompter) mode.
- **Deferred.** Host hand-off moves to Later.
- **Who it's for.** Hobbyist on the surface, professional depth on request, through progressive disclosure: presets and gain by default, the full effects rack one click away. Guests never see controls they don't need.
- **Automation.** Automate labour that needs no creative judgement (timing, levels, noise, casting), and always allow an override.

### Audio
- **One effects implementation.** The engine renders effects with `pedalboard` for both preview and export, so they can't drift apart. This is what went wrong with the old COMPRESS and Low Cut controls.
- **Preview feel.** Controls and visuals react instantly. Audio crossfades into the real render, the part around the playhead renders first, and presets are rendered ahead of time. Never play an approximate sound.
- **Loudness.** Each take is matched to its original line, measured with BS.1770 (`pyloudnorm`). The master is limited to −16 LUFS integrated and −1 dBTP true peak.
- **Calibrate Mic is diagnose + tune.**
  - It records 3 s of room tone and reports the speech-band noise floor, hum, hiss, OS noise suppression and gain advice.
  - Those measurements set DeepFilterNet's attenuation instead of always using the maximum. They also add notches for detected hum and drive a profile-based fallback: a small numpy-only stationary gate using the same approach as `noisereduce`, so scipy stays out.
  - A cleaned take records the profile and settings it was made with, so it is rebuilt when they change.
- **DeepFilterNet** ships with the desktop app.

### Machine learning
- **Keep the current stack:** Demucs and openai-whisper (torch).
- **Speaker detection** uses `sherpa-onnx` on the CPU. That does not mean moving to onnxruntime or faster-whisper, which would bring a CUDA version pin.

### Taken from Dubious
Dubious was the earlier design project. Its notes are archived at github.com/ImTani/Dubious, `docs/PLAN.md` and `docs/BAKEOFF*.md`. These ideas from it were adopted:
- **Treat non-verbal performance as dialogue.** Grunts, efforts, screams and laughs are lines to record. Detect lines from activity on the vocal stem, not only from the transcript.
- **Match subtitle text onto detected lines.** Subtitle timings never become line boundaries.
- **Takes are unlimited and non-destructive, keyed by a stable line ID**, not by line index.
- **Align takes in a fixed order:** trim, then stretch, then offset. Trim only chooses the part of the take that is measured; no audio is cut (`design/recording-timing.md`, decision 9). Owner to confirm: this changes the original "trim" line.
- **Resolve effect settings by replacement, not stacking:** character default → session → take.
- **Fail loudly when yt-dlp is stale.** It is the one dependency that can't be pinned and left alone.
- **Download FFmpeg pinned and checksummed.**
- **Known limit:** when the soundtrack has sung vocals, they leak into the dialogue stem. No separation model fixes this.

These were not adopted: React/TypeScript, SQLite, Tailscale instead of Cloudflare, the content-addressed media store, and the "never download model weights" rule. The last one suits a dev machine, not an installed app.

## PR 2: fixes and cleanup follow-ups

All of this goes into one PR.

- **Copy pass.** Plain, outcome-first UI text and accessible tooltips (done).
- **Remove** studio mode.
- **Rooms and exports.**
  - Version check when joining.
  - A "You left" screen for guests who joined from a browser.
  - Save ZIPs once on the host.
  - Fix the crash when opening a new pack (`selectPack`).
- **Desktop.**
  - A "Remove Pack Builder" button in settings.
  - Real progress while an update downloads.
  - A macOS tunnel launcher.
  - Pin FFmpeg to a checksum.
  - Raw error details behind "Show details".
  - Use the name DubMate in the launcher and window titles, and correct the launcher messages the copy pass couldn't verify. The Tauri `productName` ("DubMate Studio") and the identifier stay unchanged, because they set the install folder and the updater identity.
- **Audio fixes.**
  - Stop maximum-strength noise reduction and the gate that eats whispers.
  - Rebuild cleaned takes when the settings change. This happens lazily: a take cleaned under the old maximum setting is rebuilt when its noise reduction is toggled or the line is recorded again. A visible "refresh older takes" action is part of feature 4.
  - A yt-dlp staleness error.
- **Tests and styling.** Stub the production-registry test, and add the missing `.btn-xs` styles.
- **Cleanup.**
  - Finish splitting `app.js` (booth, packs, lobby).
  - Turn hex colours into tokens.
  - Drop scipy.
  - S38: remove the Python sidecar fallback, so the installer no longer ships a second Python copy. Verified when the owner builds and installs PR 2, plus one macOS CI run.

## Features, in build order

1. **Take model.** Stable line IDs, take history and picking a take. Most of what follows needs this. **M/L** (done).
2. **Recording timing.** Latency auto-calibration, then auto-align takes. The best-timed take is highlighted in the Takes panel and picked when the picked take is deleted; a new take is still always picked (`design/recording-timing.md`, decision 11). Owner to confirm: the original line said auto-align pre-selects the best-timed take; as built it only does so on the delete fallback. Trim being analysis-only (decision 9) also needs the owner's yes or no. **M + M** (done).
3. **Effects rack.** (`design/effects-rack.md`)
   - Built on pedalboard and fed by the take model.
   - Presets, a progressive rack, and optimistic preview.
   - Compressor and Low Cut come back with export parity.
   - The loudness master.
   - Owner to confirm: the design's "Decided overnight, revisit" list. Items 1 (loudness measured by a numpy port of pyloudnorm, not the package, to keep scipy out), 2 (reverb keeps DubMate's own room impulse), 11 (the booth and live premiere play real renders without the master stage) and 12 (project ZIP stems carry the master gain) bend an owner instruction and need a yes or no.
   - **L** (done).
4. **Calibrate Mic, diagnose + tune**, plus bundling DeepFilterNet. Write the fallback as a small numpy-only stationary gate (the approach noisereduce uses), so scipy stays out after PR 2 drops it. **M** (done, `design/calibrate-mic.md`). It came out larger than **M**. Owner to confirm:
   - A guest's room check resets each host session, because the guest's browser address changes when the host restarts DubMate (the same trade as mic sync).
   - The bundled DeepFilterNet binary contains its model. It is the one bundled model; everything else downloads its weights at runtime.
   - **Refresh older takes** trusts the `user_id` in the request, as the noise-reduction toggle does, so a guest could move another person's takes to a different check. Raw takes are untouched and Refresh can be run again.
   - It was built ahead of feature 3 (Effects rack), out of the order listed here.
5. **Pack Builder.**
   - Stem preview **S/M** (done).
   - Pointer Events for touch and pen **M** (done).
   - Speaker detection **M** (done).
   - Non-verbal lines **M** (done). For now they are only found on transcribed clips, not on subtitle imports, pending owner confirmation (see `documentation/design/pack-builder-upgrades.md`, "Decided overnight").
6. **Export and sessions.** Sessions, the shortcut sheet and sharing are done (`design/sessions-and-sharing.md`); stems export remains.
   - Stems export **S**. Waits on feature 3 (Effects rack), which changes the export pipeline.
   - Keyboard shortcut sheet **S** (done).
   - Session autosave/resume **M** (done). The last 5 sessions are kept and listed under Continue where you left off.
   - Pack sharing **M** (done). Share on a scene card, plus Get this scene and Import pack for members who joined from their own DubMate.
   - Follow-ups:
     - Booth arrow keys to move between lines. They must skip events already handled and slider, radio and tab targets, because knobs use the arrow keys.
     - Engine-to-engine "Add to my scenes", where the member's own DubMate fetches and imports the host's scene directly.
     - Tighten `POST /api/config`, `POST /api/rooms` and pack import against LAN callers.

## Later
- **Host hand-off, done properly.** Move takes, casting and the pack to the new host's engine, re-register the room code, and redirect everyone. **L**
- **Comping inside a take.**
- **A quick listening A/B: Dubious's MDX models vs Demucs** on its 9 real clips. Switch only if MDX clearly wins.

## Appendix: removed in the cleanup (PR #9)

Nothing here was used, wired up or working when it was removed. It is listed in case you want any of it back as a real feature.

#### Rooms and multiplayer
- **"Make Host" hand-off** (`8ce0784`, S08). This was the lobby button plus its confirm modal and migration overlay (`initHostTransferModals` and related code in `static/js/app.js`), the `initiate_transfer` / `complete_transfer` WS branches in `app.py`, `room_socket.initiateTransfer` / `completeTransfer`, and the Tauri commands `get_tunnel_url`, `get_room_token` and `set_room_token`. Why it went: it never worked end to end. The server ignored `new_room_id` and wiped every take, and nobody was sent to the new room. If it comes back it needs a new design (see Later). **L**
- **Client version gate** (`8ce0784`, S08). This covered the `version_mismatch` message, the "DubMate Update Required" modal, `Room.min_required_version` and `app.is_version_outdated`. Why it went: every client sent `window.__dubmate_app_version || "1.0.0"` and nothing ever set that variable, so the gate could never fire. **S**
- **Worker `POST /rooms/:code/update`**, plus the `UpdateRoomRequest` and `UpdateRoomResponse` types (`5b58cec`, S09, `worker/src/`). Why it went: nothing called it, and anyone with the shared key could use it to repoint a live room. It is still live on Cloudflare until `npm run cf:deploy` is run.
- **WS message types `claim_host` and `toggle_noise_reduction`** (`93893cf`, S03, `app.py`). They are now silently ignored. The HTTP noise-reduction toggle is still there.
- **Room rebuilt from `take_line_*.wav` files when `room_state.json` is missing** (`93893cf`, S03, `load_persisted_rooms`). Why it went: it attached the room to whichever pack happened to be first, so line indices pointed at the wrong pack.

#### Audio
- **COMPRESS rocker in the booth** (`check-compressor`) and the preview-only Web Audio `DynamicsCompressor` in `buildVocalDSPChain` (`a6caef8`, B3; `static/index.html`, `static/js/audio_engine.js`). Why it went: exports were never compressed, so previews played several dB away from the final mix. To bring it back properly, send it with the take params and apply it in `apply_audio_effects`. **M**
- **Backend compressor branch** and the `enable_lowcut` / `enable_compressor` params of `audio_processor.apply_audio_effects` (`698ebc2`, S21). No caller ever passed them.
- **`pack_loader.get_cached_line_loudness` and the stale `*_loudness.json` reads** (`a6caef8`, B3). These were replaced by lazy, mtime-keyed `measure_line_loudness`. `PackInfo.mean_vocal_loudness_db` is no longer computed.

#### Pack Builder
- **Touch resizing of the timeline splitter** (`029a760`, S15, `static/js/pack_builder.js`). It never worked, because no `touchmove` or `touchend` handler was registered. Real touch support is feature 5.
- **`GET /api/builder/{session_id}/audio/{track}`** (`93893cf`, S03, `app.py`). Nothing fetched it. It is the route that stem playback in the builder would need (feature 5, stem preview).

#### Frontend and UI
- **`#booth-character-badge`**, a static "Character" chip that was never updated (`003229e`, S14, `static/index.html`).
- **`promptSetPackFolder()`**, the `GET /api/packs?rescan=true` fallback, `AudioEngine.isMonitoringInput()`, the `AnalogKnob` options `sensitivity` / `unit` / `accentColor` and `updateFromInput()` (`003229e`, S14). All of these were dead code.
- **The `window.app` and `window.packBuilderApp` globals** (`cc62544`, S26). `window.dubMateApp` remains.
- **`?v=` cache-busting** on the CSS and JS URLs in `index.html` and `builder.html` (S14, S15). The server's ETag revalidation already handles caching.

#### Backend routes and desktop
- **`GET/POST /api/admin/clean`**, `GET /api/tunnel` (POST kept), the `/static/*` mount and the extensionless `/builder` route (`93893cf`, S03). Why they went: admin/clean was unauthenticated and anyone could reach it through the tunnel.
- **Tauri `remove_packbuilder` command**, the unheard `packbuilder-complete` event, `tauri/src/launcher.css`, the vite/dev npm scripts and `shell:*` capabilities (`f11ab14`, S07). The installer used to promise "add or remove it later from the app". It comes back as a settings button in PR 2.

#### Scripts, docs and CI
- **`scripts/launch_local.py`**, the PyInstaller-era launcher (`f3af57b`, S06).
- **Legacy root-level `cloudflared.exe` migration and TEMP zip reuse** in `download_tools.ps1`, `run_cloudflare.bat` and `update.bat` (`f3af57b`, S06).
- **`documentation/HANDOVER.md`, `DESKTOP-APP-CHECKLIST.md` and `README_MAC.md`** (`6eb55bb`, S40). The checklist's pitfalls table now lives in the README Notes, and the Mac guide is merged into the README.
- **The CI step that ran `tests/test_host_transfer.py` on its own** (`dbadfe6`, S39). CI now runs the whole suite instead.
