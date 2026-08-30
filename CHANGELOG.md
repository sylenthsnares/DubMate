# DubMate Studio Changelog

## [1.1.0] - 2026-08-30

### Fixed Room Codes Never Reaching the Public Registry
- **Publishing No Longer Depends on Startup Timing (`app.py`)**: registration was gated on `ACTIVE_TUNNEL_URL` at the moment a room was created. The desktop app opens the studio as soon as the engine answers `/health` and only *then* starts cloudflared, so a room created in the first few seconds had no tunnel to advertise — the condition was false, nothing was sent, and nothing ever retried. Codes are now queued at creation and published on room creation, on every tunnel change, and on a heartbeat. A new cloudflared hostname republishes every live code using its ownership token.
- **Tunnel and Engine Now Agree on a Port (`tauri/src-tauri/src/main.rs`)**: the cloudflared target and the `/api/tunnel` callback were both hardcoded to port 8000 while the engine falls back to a free port when 8000 is taken. Both now use the port the engine actually bound. The callback retries instead of being fire-and-forget, and reads stdout as well as stderr.
- **Source Checkouts Report Their Tunnel (`scripts/run_tunnel.py`, `run_cloudflare.bat`)**: the batch launcher ran cloudflared directly and never called `/api/tunnel`, so `ACTIVE_TUNNEL_URL` stayed unset for the whole process and no room was ever registered on that path.
- **Invite Links Carry the Room Code (`worker/src/index.ts`)**: `/join/CODE` redirected to the bare tunnel URL with the code stripped, dropping guests on the scene picker with no indication which room they had been invited to.
- **Room Code Status Is Visible (`app.py`, `static/js/app.js`)**: a new `/api/rooms/{code}/share` endpoint reports whether a code resolves and why not. The room badge shows an unpublished state, and Copy Code hands out a working direct link rather than a code nobody can redeem.

### Fixed Pack Builder Link Imports
- **Subtitle Failures Are No Longer Fatal (`pack_builder.py`)**: yt-dlp writes subtitles *before* it downloads the media, so a caption failure aborted the import with zero video bytes on disk — and reported it as "Failed to download video with yt-dlp", pointing at the wrong thing entirely. `subtitleslangs` was `['all']`, which expands to roughly 157 machine-translated caption tracks and trips YouTube's rate limiter on the first request. Video now downloads first with subtitles off; captions follow as best-effort in the video's own language plus English.
- **Captions Are Actually Read**: even when they downloaded successfully, captions were written as `source_video.*.srt`, which the scan that reads them explicitly skipped. They now use their own filename prefix.
- **Full-Resolution Video Restored**: the pinned `player_client` override was stale — `android` is SABR-blocked and `mweb` requires a PO token, so every adaptive format was silently dropped and imports fell back to a 360p progressive stream while the UI claimed "highest resolution". Warnings are no longer suppressed, so this cannot hide again.

### Performance
- **Engine Cold Start Cut From 3.84s to 1.30s (`audio_processor.py`)**: `import scipy.signal` sat at module scope to serve exactly one line in the codebase — a reverb convolution — costing every user roughly 1.6s of startup and 67 MB of resident memory whether or not they ever applied reverb. It is now imported inside the reverb path.
- **Audio Reads 44x Faster (`audio_processor.py`)**: `read_wav_mono` spawned FFmpeg on every call (~100 ms flat, regardless of clip length) even for files already mono/44.1 kHz/16-bit — the exact format DubMate itself writes. A direct WAV read with fallback is byte-identical and runs in ~2 ms. This is called once per take inside `render_dub_mix`, where process spawns were 93% of wall time.
- **Warm Pack Scans 28x Faster (`pack_loader.py`)**: `get_all_packs()` rewrote a 131 KB index on every call including calls that changed nothing, and `/api/config` did this on every request. The write is now conditional: 14.8 ms to 0.52 ms.
- **Repeat Page Loads Transfer Nothing (`app.py`)**: static assets were sent with `no-store`, which forbids the browser from caching them at all, so the ETags the server already computed could never produce a `304`. Assets now revalidate, and the middleware honours `If-None-Match` — roughly 469 KB of JavaScript, CSS and HTML per repeat load becomes an empty `304`.
- **Startup No Longer Blocks on Hardware Detection (`app.py`)**: the 389 ms encoder probe runs in the background; only `/api/system/encoder` needs its result.

### Desktop and Studio Experience
- **Pack Builder Install Shows Real Progress (`tauri/src-tauri/src/main.rs`, `tauri/src/`)**: a roughly 2 GB one-time download was presented as truncated pip output ("Collecting nvidia-cublas-cu12==12.4.5.8") against a bar pinned at 100%, which reads as either finished or frozen. Pip output is now parsed into staged progress with a real percentage and plain-language component names, with the raw log moved into a collapsed "Technical details" pane.
- **The Export Modal Can Always Be Closed (`static/js/app.js`)**: a `throw` inside the status poll's own `try` was caught two lines below, so a failed render left `isRenderingExport` true — hiding the close button and disabling Esc, the backdrop, Leave Room and Back to Booth. A page reload was the only way out.
- **Downloading a Project No Longer Ejects You From the Room (`static/js/app.js`)**: "Download Full Project" navigated to the endpoint, which answers errors as JSON, so any failure replaced the running studio with a raw JSON document and dropped the websocket. It now downloads via `fetch` and reports failures as a toast.
- **Connection Loss Is Visible (`static/js/room_socket.js`, `static/js/app.js`)**: the socket tracked its state and reconnected with backoff but never surfaced either, and `send()` silently discarded messages while offline — so takes and role assignments evaporated with no indication. A persistent banner now shows the connection state, and dropped messages raise a toast.
- **Failed Transcription No Longer Blames the User (`pack_builder.py`)**: Whisper failures were swallowed and the pipeline reported success, so the only message shown was "Please add at least 1 dialogue line before building."
- **Degraded Audio Separation Is Disclosed (`pack_builder.py`)**: when Demucs is unavailable the pipeline falls back to a basic DSP filter. It previously did so silently while the interface promised AI vocal isolation.
- **Hardware Acceleration Is Reported Honestly (`static/js/pack_builder.js`)**: `detectHardware()` was defined twice, and the second definition overwrote the real probe with a stub that hardcoded "CUDA GPU & CPU Ready" on every machine, including CPU-only laptops.
- **Errors Are Written for People (`static/js/app.js`, `app.py`)**: FFmpeg command arrays, HTTP status codes, Python tracebacks and absolute filesystem paths were being shown verbatim in toasts. These now route through a single mapping layer and stay in the log. The missing-AI-pipeline path no longer prints a `pip install` command at users.
- **Two Overstated Claims Corrected**: pack import said it was "scanning file signatures, verifying malware security" — it validates archive structure and does no malware scanning — and the builder claimed "highest resolution" for a download capped at 1080p.

### Release Pipeline
- **A Push Can No Longer Split a Published Release (`.github/workflows/release.yml`)**: the installer matrix was gated on the version being new, but publishing the app bundle was not. Any push to `main` with an unchanged `VERSION` therefore overwrote the bundle attached to the already-published release without rebuilding its installers. That is exactly what happened to v1.0.9: OTA clients received new Python and static assets while the `.exe` and `.dmg` on the same release still contained the previous build. Publishing is now gated on the same condition as the installers, so the two move together or not at all.

## [1.0.9] - 2026-08-29

### Fixed OTA Updates Never Taking Effect
- **Engine Restart After Update (`tauri/src-tauri/src/main.rs`)**: `apply_update` now terminates and relaunches the Python sidecar after extracting the bundle. Previously the engine was started before the update check and kept the *previous* modules in memory, while the launcher only called `window.location.reload()` on the webview — so every backend fix in 1.0.6, 1.0.7 and 1.0.8 stayed inert until the next cold launch, making those releases appear to change nothing.
- **Version Read From Disk, Not Compiled In**: the update check now compares against the `VERSION` file shipped alongside `app.py` instead of a hardcoded string literal, so an OTA-updated install correctly reports itself as current instead of re-downloading the same bundle on every launch.
- **Update Failures Are Now Visible (`tauri/src/launcher.js`)**: a failed `apply_update` previously fell through to `enterStudio()` with only a console error, making a failed update indistinguishable from a successful one. It now shows an error card naming the version it is still running.
- **Write Preflight (`tauri/src-tauri/src/updater.rs`)**: the install directory is checked for writability before extraction begins, so a read-only per-machine install fails with an actionable message instead of a partially replaced bundle.
- **No Silent Downgrades**: release comparison now uses numeric semantic-version ordering rather than string inequality, which previously would have "updated" a client onto an older tag.
- **Retry Truly Restarts**: the launcher's Retry action now kills the existing sidecars before relaunching instead of racing a second engine onto port 8000.
- **Windows Installer Target**: Windows now bundles NSIS only, installing per-user so the application directory is writable and OTA updates can apply without elevation.

### Added Optional Pack Builder AI Pipeline in the Desktop Installer
- **Installer Components Page (`tauri/src-tauri/installer.nsi`)**: the Windows installer now presents the Pack Builder AI pipeline (PyTorch + Demucs + Whisper, ~2 GB) as a real, unchecked-by-default component between the License and Directory pages, rather than a post-install message box. Selecting it declares its footprint via `AddSize`, so the installer's space estimate responds to the choice.
- **Installed Beside the App, Not on C:**: dependencies install into `<install dir>/ai-packages`, so installing DubMate to another drive no longer writes gigabytes to the system drive. The uninstaller removes them.
- **First-Run Download With Progress**: the launcher performs the download on first launch with streamed pip output, rather than blocking the installer on a multi-gigabyte transfer.
- **Manage Later**: `install_packbuilder` and `remove_packbuilder` commands allow adding or removing the pipeline after installation.
- **AI Requirements Now Shipped**: `requirements_builder.txt` is included in the app bundle and staged into desktop installers; it was previously absent from both.

### Added Audio Device Setup and Monitoring
- **First-Run Audio Setup (`static/js/app.js`, `static/index.html`)**: a styled setup step now explains why the microphone is needed and requests permission on an explicit action, instead of the bare browser prompt ambushing the user the moment they entered a room. Denial gets a dedicated recovery step with Windows privacy-settings guidance.
- **Input and Output Device Selection (`static/js/audio_engine.js`)**: `getUserMedia` previously ran with no `deviceId` constraint and there was no `enumerateDevices` call anywhere, so the system default was the only option. Both input and output can now be chosen; output routing feature-detects `setSinkId` and hides itself where unsupported. Choices persist and are re-applied at launch, falling back gracefully when a remembered device is unplugged.
- **Input Level Meter**: a live dBFS meter with peak hold and green/amber/red zones, driven by an `AnalyserNode` whose animation loop stops when the panel is hidden.
- **Recording Gated On Readiness**: take recording and noise calibration now wait for microphone readiness rather than triggering a permission prompt mid-countdown.

### Configuration and Storage
- **Working Data Follows the Install (`pack_loader.py`)**: cache, exports, transcodes and the pack index now default to `<install root>/data` instead of `~/.dubmate/cache`, so installing to another drive no longer writes gigabytes to the system drive. Resolution order is `DUBMATE_CACHE_DIR`, then the configured `cache_dir`, then the install root, then the home directory if the install location is not writable — preserving the 1.0.5 fix for read-only install paths.
- **Configurable Export Folder (`app.py`)**: `GET /api/config` now reports `exports_dir`, `cache_dir` and `install_root`, and `POST /api/config` accepts an `exports_dir` update. It previously *required* `packs_dir`, so changing the export location alone was impossible.
- **Engine Port No Longer Hardcoded (`tauri/src-tauri/src/main.rs`, `app.py`, `tauri/src/launcher.js`)**: the desktop launcher selects the first free port from 8000 upward and passes it via `DUBMATE_PORT`; the engine honours it and reports it from `/health`, and the launcher resolves it rather than assuming. Previously anything else holding port 8000 made the app fail to start with an error that named the cause but offered no way out.

### Security Fixes
- **Room Hijack in the Public Registry (`worker/src/index.ts`)**: `POST /rooms/create` skipped its collision check whenever an explicit `code` was supplied — which the client always does — and overwrote the entry unconditionally. Anyone holding the (publicly distributed) shared key could repoint a live room's `tunnel_url` at their own server and silently redirect every joiner. Overwriting an existing code now requires proving ownership with the room's `room_token` via `Authorization: Bearer`, and returns 409 otherwise.
- **Open Redirect (`worker/src/index.ts`)**: `tunnel_url` was accepted if it merely started with `https://`, letting the trusted registry domain 302 anyone to an arbitrary site. URLs are now parsed and their hostname checked against an explicit domain allowlist.
- **Shared API Key Removed From Browser Source (`static/js/app.js`)**: the studio page embedded the registry key in client-side JavaScript and registered a *second*, weak 4-character room code that nothing ever read. That dead path is deleted; registration happens server-side with the real room code. The server-side key now reads from `DUBMATE_WORKER_KEY`.
- **Path Traversal in Pack Audio and Static Routes (`app.py`)**: `/api/packs/{pack_id}/audio/{filename}`, `/js/{path}`, `/css/{path}` and the pack export probe joined caller-supplied fragments straight onto a base directory. Because a backslash is a path separator on Windows but not a URL separator, a single route segment could escape the pack folder and read arbitrary files. All four now use a `safe_join()` that verifies containment with `realpath`.
- **Path Traversal via `user_id` (`app.py`, `audio_processor.py`)**: `user_id` came from an unvalidated form field and was interpolated into a noise-profile filename, writing outside the room cache directory on Windows. It is now rejected at the API boundary unless it is a plain token, with realpath containment as defence in depth.
- **Unauthenticated Host Takeover (`app.py`)**: the WebSocket `claim_host` handler reassigned `room.host_id` with no authorization check at all, so any participant could seize control of a room. `assign_role` was similarly ungated, letting one actor reassign every character to themselves and lock the rest of the cast out of recording. Both are now restricted.
- **ZIP Allowlist Bypass (`pack_loader.py`)**: `os.path.splitext("payload")` returns an empty extension, and the guard read `if ext and ext not in ALLOWED_PACK_EXTS`, so extension-less files skipped both the allowlist and the executable blocklist and were written into the installed pack. Empty extensions are now rejected.
- **Stored XSS (`static/js/app.js`, `static/js/pack_builder.js`)**: actor display names, pack titles/authors/character names and channel names were interpolated unescaped into `innerHTML`, including inside `title=` and `value=` attributes. All user- and pack-derived interpolations are now HTML-escaped; actor colours are additionally validated server-side as hex literals.
- **Update Source Allowlist (`tauri/src-tauri/src/updater.rs`)**: `apply_update` is an IPC command taking an arbitrary URL, and the window navigates to the local studio UI, so a script injection there could have pointed the updater at an attacker-hosted archive that is then extracted over the install directory and executed at next launch. Downloads are now restricted to this project's own GitHub release assets, validated on the parsed host and path so subdomain, credential and query-string spoofing all fail.
- **CORS (`app.py`)**: `allow_origins=["*"]` with `allow_credentials=True` makes Starlette echo the caller's own Origin, defeating the wildcard restriction. Credentials are now disabled.

### Credential Handling
- **Registry Key No Longer Hardcoded (`app.py`, `tauri/src-tauri/src/main.rs`)**: the `X-DubMate-Key` value was a literal in source, shipped inside every public build and present in git history. It now comes from `DUBMATE_WORKER_KEY` — baked into the desktop binary at compile time from a CI secret and forwarded to the Python engine, or supplied via env var / `.dubmate.env` for source checkouts. There is no fallback literal; an unset key disables public room registration rather than silently using a burned credential.
- **Dead Secret Plumbing Removed (`.github/workflows/build-installer.yml`)**: `VITE_DUBMATE_SECRET_KEY` was passed by CI and read by nothing — this project has no Vite build step — so the secret never reached the application at all. Replaced with `DUBMATE_WORKER_KEY`, which is actually consumed.
- **Rotation Now Takes Effect (`tauri/src-tauri/build.rs`)**: added `cargo:rerun-if-env-changed=DUBMATE_WORKER_KEY`, without which Cargo would keep a stale compiled-in key until an unrelated source change forced a rebuild.

### Reliability Fixes
- **Bundled FFmpeg Was Unreachable in Desktop Builds (`pack_loader.py`, `tauri/src-tauri/src/main.rs`)**: ffmpeg shipped as a Tauri sidecar next to the executable, but the engine only looked in its own `tools/` folder and the system PATH, so a packaged install silently had no ffmpeg unless one happened to be installed system-wide — and `probe_duration` swallowed the failure and reported a duration of 0.0. The launcher now passes `DUBMATE_TOOLS_DIR` and prepends the sidecar directory to PATH, and the resolver searches it.
- **Live Sessions Destroyed by Session Pruning (`app.py`)**: creating a room unconditionally deleted every other room from memory and `rmtree`'d their recorded takes, breaking every REST call for those casts mid-session. Rooms with connected actors are now retained.
- **Blocking Renders on the Event Loop (`app.py`)**: three synchronous ffmpeg renders ran directly inside async handlers, stalling every room's WebSocket traffic for the duration of the render. They now run on worker threads.
- **WebSocket Half-Open Detection (`static/js/room_socket.js`)**: pings were sent but no reply was ever tracked, so a half-open socket (sleep/wake, NAT or tunnel timeout) left the client believing it was connected while silently delivering nothing. Liveness is now tracked against inbound traffic, and reconnects use exponential backoff with jitter instead of hammering every 2s forever.
- **Sidecar Process Safety (`tauri/src-tauri/src/main.rs`)**: sidecars were terminated by bare PID, so a recycled PID could have killed an unrelated process; the executable name is now recorded at spawn and matched during termination. Concurrent `start_sidecars` calls — reachable from startup, Retry, update and the Pack Builder commands — are serialised, preventing a second engine being spawned and orphaned while only the last PID was tracked.
- **Pack Builder Install Was Silently Broken (`requirements_builder.txt`, `tauri/scripts/stage-sidecars.*`)**: the AI pipeline could never install. `yt-dlp` was pulled from a floating `master` source archive requiring a PEP 517 build backend, and the embedded Python ignores the isolated build environment pip creates, so the install aborted with `BackendUnavailable` and left an empty directory. It now uses the published wheel, stages `setuptools` and `wheel` into the runtime, and passes `--no-build-isolation`.
- **Installer Failed Against a Running App (`tauri/src-tauri/installer.nsi`)**: the upstream Tauri template has no running-process detection, so the previous version's uninstaller could not delete the in-use executable and the install aborted with a generic error. The installer and uninstaller now detect a running instance, ask permission, and close it along with its Python and cloudflared children.
- **DSP Numerical Safety (`audio_processor.py`)**: NaN bypassed the limiter's threshold comparison and reached the WAV writer as garbage samples; client-supplied `gain_db` was unclamped and could overflow to infinity; a single malformed take aborted an entire multi-actor export; `get_reverb_impulse` reseeded the global NumPy RNG; and no ffmpeg subprocess had a timeout. All addressed, with `tempfile.mktemp()` replaced by `mkstemp()` throughout.

### Release Process
- **Per-Version Release Notes**: `publish-bundle.yml` previously passed the entire `CHANGELOG.md` as the GitHub Release body, so every release republished the full project history. It now extracts only the section for the version being released, and fails the build if no matching section exists.

## [1.0.8] - 2026-08-29

### Fixed Pack Builder YouTube Extraction (yt-dlp) & Speech-to-Text (Whisper)
- **YouTube Anti-Bot & Signature Decryption**: Removed `'player_skip': ['js', 'configs']` in `pack_builder.py` that caused HTTP 403 Forbidden errors by preventing `yt-dlp` from parsing player JavaScript deciphering functions.
- **Enabled YouTube Subtitle Track Ingestion**: Enabled automatic caption and subtitle downloading (`writesubtitles: True`, `writeautomaticsub: True`, `subtitleslangs: ['all', '-live_chat']`) for YouTube imports.
- **Video Container Detection Safeguard**: Fixed download scanner to only match valid video container extensions (`.mp4`, `.webm`, `.mkv`, `.mov`), preventing thumbnail `.webp`/`.jpg` or metadata `.info.json` from being selected.
- **FFmpeg PATH Injection for Whisper & Demucs**: Automatically prepended project `tools/` directory to `os.environ["PATH"]` upon startup, eliminating `FileNotFoundError: ffmpeg` on machines without global system FFmpeg.
- **In-Memory Whisper Model Caching**: Implemented a thread-safe global cache for loaded Whisper PyTorch model instances (`get_whisper_model()`), eliminating multi-second reload latency and VRAM/RAM churn on timeline slice transcription.
- **Anti-Hallucination Tuning**: Added `condition_on_previous_text=False`, `fp16=(device == "cuda")`, and compression ratio thresholds to eliminate repetition loops on music/silence.
- **Subtitle Preservation in Pipeline**: Preserved user-uploaded `.srt`/`.vtt` and YouTube imported subtitles in `_run_builder_pipeline_sync`, preventing Whisper from wiping existing cues.

## [1.0.7] - 2026-08-29

### Fixed Cloudflare Registry Room Resolution & Isolated Preview KV
- **Worker Room Resolve Variable Fix (`worker/src/index.ts`)**: Resolved `ReferenceError: code is not defined` on `/rooms/:code/resolve` and `/join/:code` endpoints when clients request JSON responses by correctly referencing the local `rawCode` variable.
- **Wrangler Preview Namespace & Vitest Integration Suite**: Configured isolated `preview_id` in `wrangler.toml` and introduced 9 deep integration tests (`tests/room-integration.test.ts`) using `@cloudflare/vitest-plugin` running in the Workers environment to verify room creation, KV persistence, resolve, joining, and room updates.
- **Context-Aware Pack Builder Diagnostics (`pack_builder.py`)**: Enhanced `yt-dlp` import error handler to detect frozen executable runtime and provide clear, actionable instructions for web vs desktop distributions.

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
