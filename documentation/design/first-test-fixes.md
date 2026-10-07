# Design: fixes from the first hands-on test

The owner and a co-builder tested main at `c9ca8c4` on real machines. This PR fixes what they hit: takes were hard to find, joining lost your name and audio setup, the settings screen showed the host's folders, the clap sync failed, and the input meter stopped. Branch `fix/first-test-findings`. It builds on `take-model.md`, `recording-timing.md`, `calibrate-mic.md` and `sessions-and-sharing.md`. The run was unattended, so every choice the brief left open is under "Decided overnight, revisit".

## What was found

1. **Takes.** `renderTakeHistory` (`static/js/studio/booth.js`) only shows `#take-history` when a line has 2 or more takes, as `take-model.md` decided. Anyone who recorded each line once never saw it. The button is also `btn-ghost btn-xs`, the faintest style in the booth.
2. **Joining.** A member types the code on their own DubMate and the join modal there saves their name. `joinRoom` then sends the page to the host's tunnel (`?room=…&home=…`). On that origin `localStorage` is empty. `loadUser()` makes a new random "Actor 123", `initRouter` opens the join modal a second time, and `initAudioSetupOnBoot` opens first-run setup because the mic permission and `dubmate_audio_setup_done` both belong to the old origin. Mic sync (`dubmate_mic_sync`, keyed by device labels) and the chosen devices are lost too. The chosen devices can't simply be copied, because Chromium gives each origin its own `deviceId` values, while device labels stay the same.
   - **Desktop permission.** On Windows, wry 0.55 (Tauri 2.11) only handles `PermissionRequested` for clipboard reads. WebView2 therefore asks again for the microphone on every new tunnel origin. On macOS, wry's `WKUIDelegate` already grants media capture for every origin. However, the app has no `Info.plist` with `NSMicrophoneUsageDescription`, which macOS needs before it lets an app use the mic at all.
3. **Settings privacy.** `GET /api/config` (`app.py`, `_config_payload`) returns `exports_dir`, `cache_dir`, `install_root`, `packs_dir`, `default_packs_dir`, `scanned_paths`, `config_file` and `mic_sync` to any caller, including the tunnel. In the studio, `loadExportsDirSetting` (`audio_setup.js`) shows the export row whenever that key is present, so a member saw the host's export folder. `POST /api/config` is guarded only against Cloudflare headers, and its response returns the same paths. No other route returns a local path; the Pack Builder status and the export routes give file names only.
4. **Clap sync.** It was reproduced in headless Chromium (Playwright's build, fake devices, a WAV of clicks). The engine-level stream, recorder and detection all work. Two real causes were found:
   - **Output routing is lost after a reload.** `AudioEngine.applyOutputRouting` calls `ctx.setSinkId` only when an AudioContext already exists. At boot it doesn't exist yet, and `initContext()` never applies `preferredOutputId`. After any reload, the click test, metronome, previews and backing track therefore play on the system default output, not the chosen headphones. Headless check: stored output `ab0c69f1`, `ctx.sinkId === ""`. So "hold your headphones against the mic" can't work when the headphones aren't the default output, and the delay is saved under the wrong pair.
   - **Claps must be too exact.** `findClapLag` (`timing.js`) only saves when all 6 claps fall within 40 ms of each other. In a simulation of claps with a 20 ms human timing spread, 72 % of honest attempts fail with "That didn't line up".
   - **The error toast** reads "Can't read this microphone. Try another one or press Rescan." for every error, including a blocked permission.
5. **Input meter.** `beginMicSyncRun`, `runRoomCheck` and `runLoudLineCheck` call `stopInputMeter()` and restart it afterwards. In headless Chromium the restart works, but the bar sits empty for the whole test, which is exactly when the user wants to see whether the mic hears them. Each stop and restart also closes and reopens the device. When a reopen fails (a blocked permission, or a device that is busy or slow to reopen), the meter stays dead with only a hint. The meter and the tests each open their own `getUserMedia` stream.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| **Takes (1)**, **Takes (2)**, … is shown as soon as a line you can record has one take. It opens the same take history panel. The button uses the secondary style and has a small chevron. Escape inside the panel closes it and returns focus to the button. Tooltip: "Listen to your takes and choose the one used in the dub". | Under the record status | One click away (visible, not loud) |
| Joining from your own DubMate goes straight into the room with your name, colour, chosen mic and headphones, mic sync and noise reduction setting. There's no second name prompt and no setup screen. If the versions differ, the version note shows as a toast. | Joining | Default |
| The first take on a host's page asks for the mic before the count-in, never during it. In the desktop app it doesn't ask at all. | Booth | Only when it happens |
| Browser guests (no DubMate of their own) still get the join prompt, filled with the name they last used for that host. | Joining | Default |
| On a host's page, Audio settings shows only your audio: microphone, headphones, meter, Timing and Room. The export folder, Packs folder and Remove Pack Builder rows are hidden. The Recent sessions card was already hidden there. | Audio settings, home screen | Default |
| For members from their own DubMate, the mic sync row's tooltip reads "Sync on your own DubMate to keep it for every room." Browser guests keep "Your browser keeps this until the host restarts DubMate." | Timing row | Tooltip |
| Clicks, previews, the count-in and the backing track play on the headphones you chose, also after DubMate restarts. | Everywhere | Default |
| Clap sync accepts normal human timing. It saves when at least 4 claps land within 40 ms of their median. | Timing row | One click away |
| Failures say what to do: "DubMate couldn't hear your claps. Clap closer to the mic, right on each click." / "Your claps were uneven. Try again, clapping right on each click." Microphone errors get one of the plain lines below. | Timing and Room rows (toast or panel) | Only when it happens |
| The level meter keeps moving during Sync your mic, Check your room and Check your loudest line, and after they end, fail or are cancelled. | Audio settings | Default |

Microphone error lines, shared by mic sync, the room checks and the meter hint (`micErrorMessage(err)`):

- `NotAllowedError` / `SecurityError`: "DubMate isn't allowed to use your microphone. Allow it, then try again."
- `NotFoundError`: "No microphone was found. Plug one in and press Rescan."
- `NotReadableError`: "Another app is using your microphone. Close it and try again."
- `OverconstrainedError`: "Your saved microphone isn't connected. Choose another one."
- Anything else: the current "Can't read this microphone. Try another one or press Rescan."

## Data shapes and on-disk layout

**No on-disk format changes.** Engine config, room state, takes and noise profiles are untouched.

**Join handoff** is a URL fragment added by `joinRoom` when it navigates to a host's tunnel, but only when there is a home origin (`getHomeOrigin()`): `#dm=<base64url(JSON)>`. A fragment is never sent to the host's engine or to Cloudflare.

```json
{"v": 1,
 "user": {"id": "u_k3j9a2x", "name": "Ana", "color": "#d97706"},
 "audio": {"setup_done": true, "input_label": "Microphone (Yeti X)", "output_label": "Headphones (USB)"},
 "mic_sync": {"Microphone (Yeti X)|Headphones (USB)": {"latency_ms": 85, "method": "clicks", "measured_at": 1790000000000}},
 "noise_reduction": true}
```

- Built from the current origin's `localStorage`. Labels come from `deviceLabel(devices, id)`; they are empty when unknown, and then nothing is chosen on the other side.
- At most the 20 newest `mic_sync` entries are sent.
- Every field is optional and validated on arrival:
  - `id`: `^[A-Za-z0-9_-]{1,64}$`
  - `name`: a string, trimmed, at most 40 characters
  - `color`: `^#[0-9a-fA-F]{6}$`
  - each label: a string of at most 200 characters
  - `mic_sync` entries: `validEntry`, with keys of at most 200 characters
- It is accepted only together with a valid loopback `?home=`, so a plain browser link can't set it.
- `captureJoinHandoff()` runs first in the `DubMateApp` constructor, before `loadUser()` and `initAudioSetupState()`. It removes the fragment with `history.replaceState`. It writes:
  - `dubmate_user` = `{id, name, color}`
  - `dubmate_audio_setup_done` = `1`
  - new key `dubmate_audio_handoff` = `{"input_label", "output_label"}`, a pending device choice
  - `dubmate_mic_sync`, merged per key: the newer `measured_at` wins
  - `dubmate_noise_reduction`
- It returns true, which sets `this.joinHandoff`.
- **Pending device choice.** `resolveHandoffDevices()` (`audio_setup.js`) runs whenever devices are listed with labels: in `refreshAudioDevices`, on boot when permission is granted, and after `ensureMicReady` opens the mic.
  - It matches each label exactly to a device, then saves the device's id through the usual keys and `audio.preferredInputId` / `preferredOutputId`.
  - It removes `dubmate_audio_handoff` once labels were visible, whether or not a device matched. With no match, the system default is used.

The room check is **not** carried. Its profile lives on the member's own engine, and takes are cleaned by the host's engine, which doesn't have it. The Room row on a host's page works as before.

## API and WebSocket

- `GET /api/config`:
  - From the engine's own computer (`common.is_own_computer(request)`), the payload is unchanged.
  - From anyone else (tunnel, LAN, a DNS-rebinding page, another site calling loopback), it returns only `{"status": "ok", "pack_count", "packs"}`. Those are the same pack dicts `GET /api/packs` already serves.
  - `_config_payload()` gets a `local: bool` parameter. When it is false, it leaves out `packs_dir`, `default_packs_dir`, `scanned_paths`, `config_file`, `exports_dir`, `cache_dir`, `install_root` and `mic_sync`.
- `POST /api/config` switches from `require_local_request` to `common.require_own_computer`. LAN callers now get 403 "This only works on the host's computer." This closes the `POST /api/config` part of the ROADMAP follow-up "Tighten … against LAN callers". `require_local_request` is deleted if nothing else uses it.
- No WebSocket changes and no new routes.

## Studio

- **Takes.** `renderTakeHistory`: `show = !!line && takes.length >= 1 && this.canRecordLine(line)`. In `index.html`, the `#btn-take-history` class becomes `btn btn-secondary btn-xs`, with an `aria-hidden` chevron span, and the comment is updated. A keydown listener on `#take-history` closes the panel on Escape and refocuses the button. It calls `stopPropagation`, so the global Escape handler doesn't also close a modal.
- **Privacy.**
  - `loadExportsDirSetting()` returns with the row hidden unless `isEngineLocal()`.
  - `#btn-open-pack-folder` is hidden and `openPackConfigModal()` does nothing unless `isEngineLocal()`.
  - `fetchExportsDir()` returns null unless `isEngineLocal()`.
  - `loadPackBuilderRemoval` and the Recent sessions card already check this.
- **Output routing.** `AudioEngine.initContext()` calls `this.ctx.setSinkId(this.preferredOutputId)` once, right after it creates a context, when `setSinkId` exists and an output is chosen. Errors are ignored; the default output stays.
- **Clap sync.** `findClapLag` also returns `lags` and `inWindow` (the hits within ±40 ms of the median). `runClapSync` saves when `inWindow >= 4`, and `lagMs` becomes the median of those hits. `null` from `findClapLag` (fewer than 4 hits) gives the "couldn't hear your claps" line; too few hits in the window gives "uneven". `PANEL_COPY.failed` is split into `failedQuiet` and `failedUneven`. `MAX_CLAP_SPREAD_MS` is removed. The click test is unchanged; it already detects clicks 10 dB over the room (simulated).
- **Errors.** `micErrorMessage(err)` (exported from `audio_setup.js`) is used by `micSyncError`, the room check's two `ROOM_MIC_FAILED` toasts and `startInputMeter`'s hint. `renderMicDenial` keeps its two-line heading and detail.
- **One mic stream.** `AudioEngine` keeps one capture stream for the meter and the tests.
  - `requestMicrophone()` reuses `this.monitorStream` when it is live and was opened for the same wanted device without falling back (new `this.monitorWantedId`).
  - A stream's tracks are stopped only when neither `this.stream` nor `this.monitorStream` still points at it (`_stopUnlessInUse(stream)`, used by `releaseMicrophone` and `stopInputMonitor`).
  - `beginMicSyncRun`, `runRoomCheck` and `runLoudLineCheck` no longer call `stopInputMeter()`.
  - Their end, cancel and error paths call a new `resumeInputMeter()`. It starts the meter only if the panel is open and `audio.monitorAnalyser` is null. It replaces the five `startInputMeter().catch` restarts.
  - Booth takes are unchanged. Audio settings is closed while recording, so no monitor stream exists to share.
- **Join handoff.**
  - `lobby.js` exports `buildJoinHandoff()` and `captureJoinHandoff()`.
  - `joinRoom` sets `target.hash` when there is a home.
  - In `initRouter`, when `?room=` is present and `this.joinHandoff` is set, it calls `joinRoom(room)` directly, without the modal. `warnOnVersionMismatch({ toast: true })` then shows the same note as a toast.
  - `initAudioSetupOnBoot` sees `setupComplete` and so doesn't open first-run.
- **Mic before the count-in.** In `ensureMicReady()`, when setup is complete but permission isn't `granted`, it calls `audio.requestMicrophone()` before the count-in. That shows the browser prompt, or nothing in the desktop app. Then `resolveHandoffDevices()` runs. On failure the denied step opens with `renderMicDenial`. Today this case returns true and the prompt lands after the count-in.

## Desktop

- New `tauri/src-tauri/src/mic_permission.rs`:
  - `pub fn auto_grant_origin(uri: &str) -> bool` is pure and unit-tested. It is true for `http://127.0.0.1[:port]`, `http://localhost[:port]` and `https://` hosts equal to or ending in `.trycloudflare.com` or `.bkaproductions.com`, the worker's `ALLOWED_TUNNEL_URL_DOMAINS`. A comment says to keep the list in sync.
  - Windows only: `install(controller)` adds a `PermissionRequested` handler on the main window's `CoreWebView2`. It sets `ALLOW` only when the kind is `COREWEBVIEW2_PERMISSION_KIND_MICROPHONE` and `auto_grant_origin(args.Uri())`. Every other request is left alone, so WebView2's own prompt shows.
- `main.rs` `setup` calls it through `app.get_webview_window("main")?.with_webview(|w| …w.controller()…)` under `#[cfg(windows)]`.
- `Cargo.toml` adds `[target.'cfg(windows)'.dependencies] webview2-com = "0.38"` and `windows = "0.61"`, the versions already in `Cargo.lock` (MIT/Apache-2.0).
- macOS: wry already grants. Add `tauri/src-tauri/Info.plist` with `NSMicrophoneUsageDescription` = "DubMate records your lines with your microphone." Tauri merges it into the bundle.

## Migration of existing data

There is nothing on disk to migrate, and existing `localStorage` keys keep their meaning. Old pages that join without `#dm=` behave as today: name prompt and first-run. Tests check that no fragment means today's flow, that a fragment without `?home=` is ignored, that invalid fields are dropped one by one, and that newer mic sync entries already on the host origin aren't overwritten by older ones.

## Export, render, project ZIP

Unchanged. The handoff and the meter are browser-only. Output routing changes only what the user hears live. The config redaction doesn't touch the export routes, which already return file names only.

## Not in this PR

- Carrying the room check to a host's page (it needs the profile audio on the host's engine).
- Writing a sync or device change made on a host's page back to the member's own DubMate.
- Editing your own DubMate's folders from a host's page, and engine-to-engine fetches of any kind.
- Tightening `POST /api/rooms`, pack import and the pack media routes against LAN callers. Those are still a ROADMAP follow-up.
- Restyling the right-side booth panel. A UI pass follows.
- Auto-granting the camera or anything other than the microphone; changing permissions in other windows.
- A switch to turn the handoff off.

## Risks

- **Auto-granted mic on tunnel origins.** Any page that a host serves on `*.trycloudflare.com` inside the app's main window can open the mic without a prompt. Today the member grants it once per origin anyway, after which the page can record whenever it is open. The window only reaches tunnels through a room code or link the member chose. Browsers are unaffected.
- **User id travels with the member.** It is random and already visible to everyone in a room, and the actor checks that trust it are unchanged (`calibrate-mic.md`). This now makes a member the same person across host restarts.
- **Label matching** can pick the wrong device when two devices share a label. The meter shows which one is in use.
- **The shared stream** means the meter and a test use the same track. A bug that stops the track early would break both; tests cover end, cancel and error.
- **`webview2-com` API drift** with future wry/Tauri bumps. It is pinned to the lockfile versions, and the CI build will catch it.
- **The looser clap rule** accepts a slightly less precise delay. It is the fallback path, and the result is snapped to 5 ms and nudgeable.
- **Tests that read `GET /api/config`** through `TestClient` (Host `testserver`) now see the redacted payload and must use `base_url="http://127.0.0.1:8000"`.

## Decided overnight, revisit

1. The takes button keeps the label **Takes (N)** and appears from the first take. The record status already says "Take 3 by Ana (2.4s)", so there is no separate "Take 1" chip.
2. The handoff carries the **user id** as well as name and colour, so a member stays the same person in a continued session after the host restarts.
3. The **room check is not carried**. A member checks their room again on each host session, as today.
4. A member on a host's page sees **no folder or Pack Builder settings at all**, not a link to their own DubMate.
5. `POST /api/config` moves to the **own-computer guard** (LAN callers refused), along with the GET redaction.
6. `GET /api/config` keeps `packs` and `pack_count` for remote callers, which are already public through `/api/packs`. `mic_sync` is withheld.
7. The desktop app **auto-grants only the microphone**, only in the main window, and only for loopback and the worker's tunnel domains.
8. Clap sync accepts **4 of 6 claps within ±40 ms of their median**.
9. Setup done on your own DubMate counts as done on the host's page. The browser permission prompt moves before the count-in instead.
10. The headless Chromium test runs only where a Chromium build is found (`DUBMATE_CHROMIUM` or Playwright's cache). It skips in CI.

## Implementation steps

1. **Takes visible from the first take.** `booth.js` `renderTakeHistory`, `index.html` markup, Escape, CSS chevron; JSDOM.
2. **Config privacy, engine and studio.** `GET` redaction, `POST` guard, test updates, studio rows hidden off the engine's computer; Python and JSDOM.
3. **Output routing, clap rule and mic error lines.** `initContext` sink, `findClapLag`/`runClapSync`, `micErrorMessage`; unit and JSDOM.
4. **One mic stream, live meter.** `AudioEngine` sharing, `resumeInputMeter`, panels stop stopping the meter; JSDOM.
5. **Headless Chromium check.** `tests/test_headless_mic.py` with fake devices; skips without Chromium.
6. **Join handoff.** `buildJoinHandoff`/`captureJoinHandoff`, direct join, device labels, mic before the count-in, version toast, tooltip; JSDOM.
7. **Desktop mic permission.** `mic_permission.rs`, Windows handler, `Info.plist`; cargo tests.
8. **CHANGELOG and ROADMAP.**
