# Design: fixes from the first hands-on test

The owner and a co-builder tested main at `c9ca8c4` on real machines. This PR fixes what they hit: takes were hard to find, joining lost your name and audio setup, the settings screen showed the host's folders, clap sync failed, and the input meter stopped. Branch `fix/first-test-findings`. It builds on `take-model.md`, `recording-timing.md`, `calibrate-mic.md` and `sessions-and-sharing.md`. The run was unattended, so every choice the brief left open is under "Decided overnight, revisit".

This is the revised version, after a claim audit of the first draft. The changes: mic tests keep recording from a fresh stream, the user id is no longer carried, `/api/packs/rescan` is redacted too, devices go through the normal apply path, and the tester's exact mic error is marked as unknown.

## What was found

1. **Takes.** `renderTakeHistory` (`static/js/studio/booth.js`) only shows `#take-history` when a line has 2 or more takes, as `take-model.md` decided. Anyone who recorded each line once never saw it. The button is also `btn-ghost btn-xs`, the faintest style in the booth.
2. **Joining.** A member types the code on their own DubMate, and the join modal there saves their name. `joinRoom` (`lobby.js`) then sends the page to the host's tunnel (`?room=…&home=…`).
   - On that origin `localStorage` is empty. `loadUser()` makes a new random "Actor 123", `initRouter` opens the join modal a second time, and `initAudioSetupOnBoot` opens first-run setup, because the mic permission and `dubmate_audio_setup_done` both belong to the old origin.
   - Mic sync (`dubmate_mic_sync`, keyed by device labels, plus `engineMicSync` from the member's own engine) and the chosen devices are lost too.
   - Chosen devices can't be copied directly: Chromium gives each origin its own `deviceId` values. Device labels stay the same.
   - **Desktop permission.** On Windows, wry 0.55 (Tauri 2.11) only handles `PermissionRequested` for clipboard reads, so WebView2 asks for the microphone again on every new tunnel origin. On macOS, wry's `WKUIDelegate` already grants media capture for every origin. But there is no `Info.plist` with `NSMicrophoneUsageDescription`, and macOS needs one before it lets the app use the mic.
3. **Settings privacy.**
   - `GET /api/config` (`app.py`, `_config_payload`) returns `exports_dir`, `cache_dir`, `install_root`, `packs_dir`, `default_packs_dir`, `scanned_paths`, `config_file` and `mic_sync` to any caller, the tunnel included.
   - `GET`/`POST /api/packs/rescan` (`dubmate/packs_api.py`) returns `scanned_paths` as absolute paths of the host's folders, with no guard. The studio calls it from `rescanPacksDirectory`.
   - `POST /api/config` is guarded only against Cloudflare headers (`require_local_request`), and its response returns the same paths.
   - Pack dicts (`PackInfo.to_dict`), the Pack Builder status and the export routes give URLs and file names only.
   - In the studio, `loadExportsDirSetting` (`audio_setup.js`) shows the export row whenever that key is present. That is how a member saw the host's export folder.
4. **Clap sync: "Can't read this microphone…".** That toast comes only from `micSyncError`, which runs when `getUserMedia` (through `requestMicrophone`) or `new MediaRecorder` throws. Uneven claps show the "That didn't line up" panel instead.
   - **The tester's exact error is not known.** In headless Chromium (fake devices, a WAV of clicks), the stream, recorder and detection all work.
   - Three causes fit what the tester saw, and this PR handles each one:
     - (a) A tunnel origin in the Windows desktop app prompts again. A dismissed or blocked prompt gives `NotAllowedError`, which shows the same generic line.
     - (b) The test stops the meter's stream and opens a new one straight away. On Windows the device can still be closing, which gives `NotReadableError` or `AbortError`.
     - (c) Two overlapping `startInputMeter` calls leak a live stream and a second animation loop. `startInputMonitor` stops nothing that a call still waiting has not stored yet.
   - Two more real faults turned up along the way:
     - **Output routing is lost after a reload.** `applyOutputRouting` calls `ctx.setSinkId` only when an AudioContext already exists. At boot it doesn't exist yet, and `initContext()` never applies `preferredOutputId`. So clicks, metronome, previews and backing track play on the system default output, and "hold your headphones against the mic" fails when the headphones aren't the default. Headless check: stored output `ab0c69f1`, `ctx.sinkId === ""`.
     - **Claps must be too exact.** `runClapSync` saves only when the claps `findClapLag` found (at least 4 of beats 3 to 8) fall within 40 ms of each other. In a simulation with an assumed 20 ms human spread, 72 % of honest attempts failed.
5. **Input meter.** `beginMicSyncRun`, `runRoomCheck` and `runLoudLineCheck` call `stopInputMeter()`, and five places restart it. The bar sits empty for the whole test, which is exactly when the user wants to see whether the mic hears them.
   - The restart is a fresh `getUserMedia`. When it fails, the meter stays dead, with only the generic hint.
   - So the dead meter the tester saw is most likely the same failed mic open as item 4.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| **Takes (1)**, **Takes (2)**, … shows as soon as a line you can record has one take, and opens the same take history panel. It uses the secondary button style with a small chevron. Escape inside the panel closes it and returns focus to the button. Tooltip: "Listen to your takes and choose the one used in the dub". | Under the record status | One click away (visible, not loud) |
| Joining from your own DubMate goes straight into the room. Your name, colour, chosen mic and headphones, mic sync and noise reduction setting come with you. There's no second name prompt and no setup screen. If the two versions differ, the version note shows as a toast. | Joining | Default |
| On a host's page, your first take asks for the mic before the count-in, never during it. The desktop app doesn't ask at all. | Booth | Only when it happens |
| Browser guests (no DubMate of their own) still get the join prompt. It is filled in with the name they last used for that host. | Joining | Default |
| On a host's page, Audio settings shows only your audio: microphone, headphones, meter, Timing and Room. The export folder, Packs folder and Remove Pack Builder rows are hidden. The Recent sessions card was already hidden there. | Audio settings, home screen | Default |
| For members from their own DubMate, the mic sync row's tooltip reads "Sync on your own DubMate to keep it for every room." Browser guests keep "Your browser keeps this until the host restarts DubMate." | Timing row | Tooltip |
| Clicks, previews, the count-in and the backing track play on the headphones you chose, even after DubMate restarts. | Everywhere | Default |
| Clap sync accepts normal human timing. It saves when at least 4 claps land within 40 ms of their median. | Timing row | One click away |
| Failures say what to do: "DubMate couldn't hear your claps. Clap closer to the mic, right on each click." or "Your claps were uneven. Try again, clapping right on each click." Microphone errors get one of the plain lines below. | Timing and Room rows (toast or panel), meter hint | Only when it happens |
| The level meter keeps moving during Sync your mic, Check your room and Check your loudest line. It comes back after they end, fail or are cancelled. | Audio settings | Default |

Microphone error lines, shared by mic sync, the room checks and the meter hint through `micErrorMessage(err)`:

- `NotAllowedError` / `SecurityError`: "DubMate isn't allowed to use your microphone. Allow it, then try again."
- `NotFoundError`: "No microphone was found. Plug one in and press Rescan."
- `NotReadableError` / `AbortError`: "Another app is using your microphone. Close it and try again."
- `OverconstrainedError`: "Your saved microphone isn't connected. Choose another one."
- Anything else: the current "Can't read this microphone. Try another one or press Rescan."

The console line keeps `err.name` and `err.message`, so the next hands-on test shows which case it was.

## Data shapes and on-disk layout

**No on-disk format changes.** Engine config, room state, takes and noise profiles are untouched.

**Join handoff.** `joinRoom` adds a URL fragment when it sends the page to a host's tunnel, and only when there is a home origin (`getHomeOrigin()`): `#dm=<base64url(JSON)>`. A fragment is never sent to the host's engine or to Cloudflare.

```json
{"v": 1,
 "user": {"name": "Ana", "color": "#d97706"},
 "audio": {"setup_done": true, "input_label": "Microphone (Yeti X)", "output_label": "Headphones (USB)"},
 "mic_sync": {"Microphone (Yeti X)|Headphones (USB)": {"latency_ms": 85, "method": "clicks", "measured_at": 1790000000000}},
 "noise_reduction": true}
```

- **Building it.** `buildJoinHandoff()` reads the current origin's `localStorage`.
  - `mic_sync` is the local map merged with `this.engineMicSync`; the newer `measured_at` wins. At most the 20 newest entries are sent.
  - Labels come from `deviceLabel(devices, id)`. When a label isn't known it is left empty, and nothing is chosen on the other side.
- **No user id.** On the host's origin, the member keeps the `dubmate_user.id` that origin already has, or gets a new one from `loadUser()`, exactly as today. Only `name` and `color` are written. A crafted link therefore can't make anyone take another person's id. A member who joined that tunnel earlier keeps their id, and with it their takes.
- **Checks on arrival.** Every field is optional and checked on its own:
  - `name`: a string, trimmed, at most 40 characters.
  - `color`: `^#[0-9a-fA-F]{6}$`.
  - Each label: a string of at most 200 characters.
  - `mic_sync`: entries must pass `validEntry`, and keys are at most 200 characters.
  - The fragment is read only when `?room=` and a loopback-looking `?home=` are also present. **That is not a security check:** anyone can write such a link. The worst a crafted link can do is set a guest's display name, colour, device-label preference, noise reduction setting and a mic delay of 0 to 800 ms (shown in the Timing row). It can also mark setup as done. All of these are visible to the guest and can be changed.
- **Applying it.** `captureJoinHandoff()` runs first in the `DubMateApp` constructor, before `loadUser()` and `initAudioSetupState()`. It removes the fragment with `history.replaceState`, then writes:
  - `dubmate_user`: the existing object, or `{}`, with `name` and `color` merged in. `loadUser()` adds an id if one is missing.
  - `dubmate_audio_setup_done` = `1`.
  - New key `dubmate_audio_handoff` = `{"input_label", "output_label"}`, a pending device choice.
  - `dubmate_mic_sync`, merged per key; the newer `measured_at` wins.
  - `dubmate_noise_reduction`.
  - It returns true, which sets `this.joinHandoff`.
- **Pending device choice.** `resolveHandoffDevices()` (`audio_setup.js`) runs whenever devices are listed with labels: in `refreshAudioDevices`, on boot when permission is granted, and after `ensureMicReady` opens the mic.
  - It matches each label exactly to a device and calls `applyInputDevice(id)` / `applyOutputDevice(id)`. Those set `audioSetup.inputId`/`outputId` (which `currentDevicePairKey()` and the meter read), the storage keys, `audio.preferredInputId`, and the live routing through `setPreferredOutputDevice`.
  - It removes `dubmate_audio_handoff` once labels were visible, whether or not a device matched. If nothing matched, the system default is used.

The room check is **not** carried. Its profile lives on the member's own engine, and takes are cleaned by the host's engine, which doesn't have it. The Room row on a host's page works as before.

## API and WebSocket

- `GET /api/config`:
  - Called from the engine's own computer (`common.is_own_computer(request)`), it returns the unchanged payload.
  - Called by anyone else (tunnel, LAN, a DNS-rebinding page, another site calling loopback), it returns `{"status": "ok", "pack_count", "packs"}` only. These are the pack dicts `GET /api/packs` already serves.
  - `_config_payload()` gets a `local: bool` parameter.
- `POST /api/config` moves from `require_local_request` to `common.require_own_computer`, so LAN callers now get 403 "This only works on the host's computer." This closes the `POST /api/config` part of the ROADMAP follow-up "Tighten … against LAN callers". `require_local_request` is deleted; nothing else uses it.
- `GET`/`POST /api/packs/rescan` still rescans for every caller, as the studio's Rescan button needs. For callers other than the engine's own computer, `scanned_paths` is `[]`.
- No WebSocket changes and no new routes.

**Mixed versions.** The page on a host's tunnel is served by the host's engine; the handoff is built by the member's own DubMate.
- A new member joining an old host: the old page ignores `#dm=`, and the member sees today's prompts. Harmless.
- An old member joining a new host: no fragment, so today's flow, plus the new privacy rules.
- The settings privacy fix protects members only once the **host** has upgraded.

## Studio

- **Takes.** In `renderTakeHistory`: `show = !!line && takes.length >= 1 && this.canRecordLine(line)`.
  - `index.html`: `#btn-take-history` becomes `btn btn-secondary btn-xs` with an `aria-hidden` chevron span, and its comment is updated.
  - A keydown listener on `#take-history` closes the panel on Escape and refocuses the button. It calls `stopPropagation`, so the global Escape handler doesn't also close a modal.
- **Privacy.** Each of these does nothing, or stays hidden, unless `isEngineLocal()`:
  - `loadExportsDirSetting()`
  - `fetchExportsDir()` (returns null)
  - `#btn-open-pack-folder` and `openPackConfigModal()`
  - `loadPackBuilderRemoval` and the Recent sessions card already check this.
- **Output routing.** Right after `AudioEngine.initContext()` creates a context, it calls `this.ctx.setSinkId(this.preferredOutputId)` once, when `setSinkId` exists and an output is chosen. Errors are ignored, and the default output stays.
- **Clap sync.**
  - `findClapLag` also returns `lags` and `inWindow`, the hits within ±40 ms of the median.
  - `runClapSync` saves when `inWindow >= 4`, using the median of those hits.
  - `null` (fewer than 4 hits) gives the "couldn't hear" line; a full set of hits with too few in the window gives "uneven".
  - `PANEL_COPY.failed` splits into `failedQuiet` and `failedUneven`, and `MAX_CLAP_SPREAD_MS` is removed.
  - The click test is unchanged.
- **Mic errors.** `micErrorMessage(err)` (exported from `audio_setup.js`) is used by `micSyncError`, the room check's two `ROOM_MIC_FAILED` toasts and `startInputMeter`'s hint. `renderMicDenial` keeps its heading and detail.
- **Reopening a closing device.** `requestMicrophone()` and `startInputMonitor()` retry an attempt once, after 300 ms, when it fails with `NotReadableError` or `AbortError`. There is no retry for permission errors.
- **Meter during the tests: the tests keep a fresh stream.** `recording-timing.md` decision 2 measures sync "through the real recording path (fresh stream…)", and booth takes always open a fresh stream. So the tests still stop the meter's own stream first and record from a stream they open themselves. What changes is what the meter reads:
  - `AudioEngine.requestMicrophone()` attaches `this.recordAnalyser`, a `MediaStreamSource` plus an analyser, never connected to the output, to every stream it opens. `releaseMicrophone()` disconnects it. `MediaRecorder` reads the track itself, so recording timing doesn't change.
  - `readInputLevel()` reads `this.monitorAnalyser || this.recordAnalyser`.
  - The tests call a new `pauseMeterStream()` instead of `stopInputMeter()`. It stops only `audio.stopInputMonitor()`, and the animation loop keeps running. While a test records, the bar follows the test's own stream. Between passes (no stream), `renderInputMeterFrame` draws the floor instead of freezing.
  - Every end, cancel and error path calls a new `resumeInputMeter()`, which replaces the five `startInputMeter().catch` restarts. It reopens the meter's stream only when the panel is open and `audio.monitorAnalyser` is null. On failure the hint shows `micErrorMessage(err)`.
  - `startInputMeter()` gets a token (`audioSetup.meterToken`), and `startInputMonitor()` gets its own (`this.monitorToken`). A start that finishes after a newer start or a stop stops its own stream and returns. This ends the leaked streams and duplicate loops of cause (c).
- **Join handoff (a).**
  - `lobby.js` exports `buildJoinHandoff()` and `captureJoinHandoff()`, and `joinRoom` sets `target.hash` when there is a home.
  - In `initRouter`, when `?room=` is present and `this.joinHandoff` is set, it calls `joinRoom(room)` directly, without the modal. `warnOnVersionMismatch({ toast: true })` shows the same note as a toast.
  - `initAudioSetupOnBoot` sees `setupComplete` and doesn't open first-run.
  - Browser guests: the join modal's name field is filled from `dubmate_user.name` on that origin. That is today's behaviour; a test now pins it.
- **Mic before the count-in (b).** In `ensureMicReady()`, when setup is complete but the permission state isn't `granted`, it calls `audio.requestMicrophone()` before the count-in, then right away `audio.releaseMicrophone()`. The take still opens its own fresh stream. This shows the browser prompt (the desktop app shows none), then runs `resolveHandoffDevices()`. If it fails, the denied step opens with `renderMicDenial`.

## Desktop

- New `tauri/src-tauri/src/mic_permission.rs`:
  - `pub fn auto_grant_origin(uri: &str) -> bool` is pure and unit-tested. It returns true for `http://127.0.0.1[:port]` and `http://localhost[:port]`, and for `https://` hosts equal to `trycloudflare.com` or `bkaproductions.com` or ending in `.` plus one of them. That is the same exact-or-dot-suffix rule as `ALLOWED_TUNNEL_URL_DOMAINS` / `isAllowedTunnelUrl` in `worker/src/index.ts` (verified: those two domains). A comment points to that list.
  - Windows only: `install(webview)` adds a `PermissionRequested` handler on the main window's `CoreWebView2`. It sets `COREWEBVIEW2_PERMISSION_STATE_ALLOW` only when the kind is `COREWEBVIEW2_PERMISSION_KIND_MICROPHONE` and `auto_grant_origin(args.Uri())` is true. Every other request is left alone, so WebView2 shows its own prompt.
- `main.rs` `setup` calls it under `#[cfg(windows)]` through `app.get_webview_window("main")` and `.with_webview(|w| …w.controller()…)`.
- `Cargo.toml`: `[target.'cfg(windows)'.dependencies] webview2-com = "0.38"` and `windows = "0.61"`, the versions already in `Cargo.lock` (MIT/Apache-2.0), with only the features needed.
- macOS: wry already grants.
  - Add `tauri/src-tauri/Info.plist` with `NSMicrophoneUsageDescription` = "DubMate records your lines with your microphone." Tauri merges it into the bundle.
  - Add `tauri/src-tauri/Entitlements.plist` with `com.apple.security.device.audio-input` = true, set as `bundle.macOS.entitlements` in `tauri.conf.json`. CI doesn't sign with an identity today, so it has no effect yet. Once the app is signed with hardened runtime, the mic needs it.
- **How it is checked.** There is no PR build of the desktop app; `release.yml` runs on a push to main or a manual `build_only` dispatch. The executor runs `cargo test` and `cargo check` locally on Windows (`tauri/src-tauri`; toolchain and sidecars are present on the build machine). The orchestrator's `build_only` run compiles Windows and macOS before merge.

## Migration of existing data

Nothing on disk changes, and existing `localStorage` keys keep their meaning. Old pages that join without `#dm=` behave as today, with a name prompt and first-run setup. JSDOM tests check that:
- no fragment means today's flow;
- a fragment without `?home=` is ignored;
- invalid fields are dropped one by one;
- an existing `dubmate_user.id` on the host origin is kept;
- newer mic sync entries already on the host origin aren't overwritten by older ones.

## Export, render, project ZIP

Unchanged. The handoff and the meter run in the browser only, and output routing changes only what the user hears live. The config redaction doesn't touch the export routes, which already return file names only.

## Not in this PR

- Carrying the room check to a host's page (it needs the profile audio on the host's engine).
- Carrying the user id: a member gets a new identity on each new tunnel origin, as today.
- Writing a sync or device change made on a host's page back to the member's own DubMate.
- Editing your own DubMate's folders from a host's page, and engine-to-engine fetches of any kind.
- Tightening `POST /api/rooms`, pack import and the pack media routes against LAN callers. They stay a ROADMAP follow-up.
- **The UI pass of every page** (screenshots, review, restyling the right-side booth panel). The owner asked for it after the same test, and it is its own PR right after this one. Step 9 adds it to the ROADMAP if no line for it exists yet.
- Auto-granting the camera or anything other than the microphone, and changing permissions in other windows.
- A headless browser test in the suite. CI has no Chromium, so the headless check is a dev script (step 5).

## Risks

- **Auto-granted mic on tunnel origins.** Any page that a host serves on `*.trycloudflare.com` or `*.bkaproductions.com` inside the app's main window can open the mic without a prompt. Today the member grants it once per origin anyway, and after that the page can record whenever it is open. The window reaches tunnels only through a room code or link the member chose. Browsers are unaffected.
- **Crafted handoff links** can set a guest's display preferences (see "Checks on arrival"), but not their id.
- **Label matching** can pick the wrong device when two devices share a label. The meter shows which one is in use.
- **The record analyser** adds one WebAudio source per take stream. It doesn't touch `MediaRecorder`; a JSDOM test checks that `releaseMicrophone` disconnects it.
- **The 300 ms retry** delays the error by 300 ms when a device is truly busy.
- **The tester's real error is still unconfirmed.** The specific lines plus `err.name` in the console settle it at the next hands-on test.
- **`webview2-com` API drift** when wry or Tauri is bumped. The crate is pinned to the lockfile versions, a compile break shows up in the local `cargo check` or the `build_only` run, and there is still no PR build.
- **The looser clap rule** accepts a slightly less precise delay. Clapping is the fallback path, the result is snapped to 5 ms, and it can be nudged.
- **Tests that go red with the guard and the redaction.** These need `TestClient(app, base_url="http://127.0.0.1:8000")`:
  - `test_security_hardening.py` `test_local_request_behaves_as_before` (lines 245-249)
  - `test_config_pack_path.py` (lines 72, 77, 93, 132, 154)
  - `test_recording_timing.py` `TestMicSyncConfig` (line 570)
  - any other `GET /api/config` reader the full suite shows

## Decided overnight, revisit

1. The takes button keeps the label **Takes (N)** and appears from the first take. The record status already says "Take 3 by Ana (2.4s)", so there's no separate "Take 1" chip.
2. **The user id is not carried.** Only name and colour are, so a crafted link can't hand someone else's id to a guest, and an earlier id on that origin survives. Continuity across host restarts stays as today.
3. The **room check is not carried**. A member checks their room again on each host session, as today.
4. A member on a host's page sees **no folder or Pack Builder settings at all**, not a link to their own DubMate.
5. `POST /api/config` moves to the **own-computer guard** (LAN callers refused), along with the GET redaction and `scanned_paths: []` on rescan.
6. `GET /api/config` keeps `packs` and `pack_count` for remote callers, which `/api/packs` already makes public. `mic_sync` is withheld.
7. **Mic tests keep a fresh stream** (`recording-timing.md` decision 2). The meter shows the test's own stream instead of sharing its stream with the test. The mic opened before the count-in is released before the take.
8. A failed open of a busy or closing device is **retried once after 300 ms**.
9. The desktop app **auto-grants only the microphone**, only in the main window, and only for loopback and the worker's two tunnel domains.
10. The macOS **audio-input entitlement** is added now, although it has no effect until signing.
11. Clap sync accepts **4 claps within ±40 ms of their median**.
12. Setup done on your own DubMate counts as done on the host's page. The browser prompt moves before the count-in.
13. The headless Chromium check is a **dev script** (`scripts/headless_mic_check.py`), not a suite test.

## Implementation steps

1. **Takes visible from the first take.** `booth.js` `renderTakeHistory`, `index.html` markup, Escape handling, chevron CSS; JSDOM.
2. **Config privacy, engine and studio.** `GET /api/config` redaction, `POST` own-computer guard, `scanned_paths` on rescan, test client updates, studio rows hidden off the engine's computer; Python and JSDOM.
3. **Output routing, clap rule, mic error lines, one retry.** `initContext` sink, `findClapLag`/`runClapSync`, `micErrorMessage`, retry in `requestMicrophone`/`startInputMonitor`; unit and JSDOM.
4. **Live meter during and after the tests.** `recordAnalyser`, `pauseMeterStream`/`resumeInputMeter`, start tokens, floor between passes; JSDOM.
5. **Headless mic check script.** `scripts/headless_mic_check.py`, stdlib only, fake devices, loopback and a non-loopback secure origin; run once and record the result in the commit message.
6. **Join handoff: identity and direct join.** `buildJoinHandoff`/`captureJoinHandoff` (no id), direct join, version toast, mic sync tooltip; JSDOM.
7. **Join handoff: devices and mic before the count-in.** `resolveHandoffDevices` through `applyInputDevice`/`applyOutputDevice`, `ensureMicReady` open then release; JSDOM.
8. **Desktop mic permission.** `mic_permission.rs`, the Windows handler, `Info.plist`, `Entitlements.plist`; `cargo test` and `cargo check` locally.
9. **CHANGELOG and ROADMAP.**
