# Design: UI pass U5b, Audio settings and an honest launcher

Phase U5 of the UI plan (`design/ui-plan.md`), steps **40d** (Audio settings), **39** (launcher look), **39a** (an honest launcher) and **39b** (Pack Builder installs in the background), including every "(added from full critique)" item. Also two follow-ups from PR #19 (`first-test-fixes.md`): the clap copy mismatch and the out-of-date `recording-timing.md`. Branch `ui/u5b-settings-launcher` from `origin/main` at `5ff5bc3` (PR #19, U1 and U2 merged, so BF-2, BF-3, BF-4 and the U1 floors, `.btn-danger` and `.btn:disabled` are in).

Before-shots: `C:/Users/tanis/AppData/Local/Temp/dm_shots/ui-u5b-settings-launcher/before-*` (script `dm_u5b/shots.js <port> <prefix>`, engine `dm_u5b/boot.sh <port>`).

## Goal

**Audio settings.**
- The meter speaks three languages at once. The bar is RMS, the zones are peak thresholds (-12 and -3), and green means "Quiet". The hint says "Aim for the amber zone", while "Check your loudest line" calls -10 to -6 good.
- At 1280x720 and 960x680, Done sits below the window (before-shot `audio-devices`: `off(724/720)`).
- Every status line is brass, so "Not synced yet" looks like a warning.
- The denied step shows three platforms' instructions at once.
- First run leads with an "AUDIO SETUP" badge and emoji icons.

**The launcher.**
- It is cool grey with system fonts. The studio is warm espresso with Plus Jakarta Sans.
- The startup text comes from two places that disagree.
- At 15 s it turns a slow start into a red error card.
- The update card dumps raw Markdown release notes (before-shot `launcher-update`).
- First-run Pack Builder holds the whole app behind a 2 GB download.

After U5b, Audio settings reads as one calm form whose colours mean what DESIGN.md says. The launcher looks like the studio's front door, only says what Rust knows, saves red for real failures, and lets people into the studio while Pack Builder installs.

## Owner decisions this implements (binding, plan section 6)

- **`style.css` is the source of truth; refine, don't redesign** (decision 5). The U1 floors apply:
  - no text under 11px, and 12px for sentences;
  - the brass focus ring;
  - one amber primary per view;
  - green only for done or OK, red only for recording, errors and irreversible actions;
  - `--foreground-dim` for decoration only.
- Routing: clap noise rejection (9c) landed in PR #19. Its behaviour is kept unchanged:
  - loud broadband clicks with the earbuds-out step;
  - `judgeClaps`;
  - the live meter during checks;
  - members on a host's page seeing only the audio rows.
- The updater and launcher rules in `effects-rack.md` stay:
  - the engine never runs pip;
  - the updater installs changed requirements before writing files;
  - nothing is installed globally.

Out of scope, owned elsewhere: the booth, the lobby, the landing page and the join flow (a separate redesign; `#btn-open-builder` on the landing page is not touched), premiere and export (another PR, including 40a's header Audio tooltip for members), and Pack Builder's own pages (U5c).

## Layout and behaviour

### A. Audio settings (`#modal-audio-settings`, step 40d)

**Header.**
- The "AUDIO SETUP" badge goes.
- The title is "Audio settings", or **"Set up your mic"** in first-run mode.
- The mic pill stays beside the title, uses the status classes, and keeps the label style (11px, uppercase via CSS):
  - "Mic ready": done, green.
  - "Mic blocked": error, red.
  - "No mic yet": pending, muted.
- The subtitle shows on the devices step only ("Choose your microphone and headphones."). The denied step's subtitle went, because it repeated the detail line.

**Status-text classes (plan 6a, left by U1 for this step).** In `style.css`:
- `.status-text`: 12px, weight 500.
- `.is-pending`: `--foreground-muted`.
- `.is-done`: `--accent-teal-light`, with a CSS-mask check icon (no glyph).
- `.is-attention`: `--primary-hover`.
- `.is-error`: `--accent-red-soft`.

They are applied to:
- `#mic-sync-status`: "Not synced yet" is pending; "Synced…" is done.
- `#room-check-status`:
  - "Not checked yet" is pending.
  - Quiet and some-noise verdicts are done.
  - Noisy, and "New microphone…", are attention.
- `#room-check-refresh-text`: attention.
- The device notes: their existing `is-warning`/`is-error` map onto attention/error.
- `#packbuilder-size-note`: pending.
- The meter hint.

**The meter: one quantity, one target.**
- New `static/js/studio/level_target.js` exports the shared target. It takes the loudest-line numbers already in `room_check.js`:
  - `LEVEL_GOOD_MIN_DB = -10` and `LEVEL_GOOD_MAX_DB = -6` (dBFS peak);
  - `LEVEL_QUIET_PEAK_DB = -45`.
- It also exports two pure functions:
  - `levelZone(db)`: `'quiet' | 'good' | 'loud'`.
  - `levelHint(windowMaxDb)`: `{text, tone}`.
- `room_check.js` imports the constants instead of its own `LOUD_GOOD_*`. Its advice strings and tests are unchanged.
- The bar shows **peak** with a fast attack and the existing decay, plus the peak-hold tick.
- Zones are drawn as a band behind the bar:
  - "Too quiet": dim, below -10.
  - "Good": a green band from -10 to -6.
  - "Too loud": red, above -6.
- The fill takes the colour of the zone it is in (neutral brass, green or red). The legend reads Too quiet · Good · Too loud.
- The hint works from the maximum peak over a rolling 2.5 s:
  - Below -45: neutral, "Say your loudest line. Aim for the green band."
  - Below -10: attention, "A bit quiet. Move closer or turn the mic up."
  - -10 to -6: done, "Good level."
  - Above -6: error, "Too loud. Move back from the mic or turn down its input level."
- After 2.5 s of quiet the hint goes back to neutral by itself. Mic error lines (`micErrorMessage`) and the fallback line still win.
- The numbers leave the face: `#level-meter-rms` and `#level-meter-peak-readout` go. A focusable tooltip on the meter ("Peak -8 dB") and `aria-valuetext` carry them, updated at most 4 times a second.
- The meter keeps following the test's own stream during checks (PR #19).

**Sticky footer.** The devices step's Done row is `position: sticky; bottom: 0` inside the scrolling card. It gets the card's background and a top hairline, so Done stays reachable at 1280x720 and 960x680. Intro and denied keep their action rows; they fit.

**Pack Builder row.** "Remove Pack Builder" becomes `btn btn-danger btn-sm`; the confirm's Remove is already danger.

**Room check.**
- The failed panel's primary reads **"Check again"** (it said "Start").
- The unusable card (talking or clipping heard) gets its own **"Check again"** button (`#btn-room-check-again`), which opens the ready step.

**Denied step (P1).**
- Detection:
  - The desktop app is `!!window.__TAURI__`.
  - The OS comes from `navigator.userAgentData?.platform || navigator.platform || UA`: `windows`, `mac` or `other`.
- The box gets an SVG mic-off icon in place of 🚫, plus the heading and detail.
- **One short list** for the detected case, built from a `RECOVERY_STEPS` table:
  - **Desktop app, Windows:**
    1. "Open Windows microphone settings."
    2. "Turn on Microphone access and Let desktop apps access your microphone."
    3. "Come back and press Try again. If it still doesn't work, restart DubMate."
  - **Desktop app, Mac:**
    1. "Open macOS microphone settings."
    2. "Turn on DubMate."
    3. "Restart DubMate."
  - **Browser:**
    1. "Click the icon at the left of the address bar."
    2. "Set Microphone to Allow."
    3. "Press Try again."
    - Plus one OS line: Windows "Still blocked? In Windows Settings → Privacy & security → Microphone, turn on Let desktop apps access your microphone."; Mac "Still blocked? In System Settings → Privacy & Security → Microphone, turn on your browser."
- In the desktop app on this computer (`desktopInvoke()`), step 1 includes a secondary button, "Open Windows microphone settings" or "Open macOS microphone settings". It calls `invoke('open_mic_settings')` (group 2). If that fails, the button hides and the text step stays.
- The other cases go in a closed `<details>`: **"Using something else?"**.
- For errors that aren't about permission (`NotFoundError`, `NotReadableError`, `OverconstrainedError`, other), the lists are hidden. Only the heading, detail and Try again show.

**First run (intro).**
- Title "Set up your mic".
- One hero line: "So you can record your lines." Then a privacy line, shown only where it is true:
  - on the engine's computer (`isEngineLocal()`): "Audio stays on this computer.";
  - on a host's page: "Your takes are saved on the host's computer."
- The fact row uses an SVG icon:
  - browser: "Your browser will ask for permission. Choose Allow.";
  - desktop app: "Your computer may ask for permission. Choose Allow."
- The output-unsupported box's 🎧 becomes an SVG. No emoji is left in the modal.

**Copy fix (PR #19 follow-up 1).** The clap step says "clap on each beat you hear", so the three failure lines say "beat" too:
- "DubMate couldn't hear your claps. Clap closer to the mic, right on each beat."
- "Your claps were uneven. Try again, clapping right on each beat."
- "DubMate heard other sounds besides your claps. Try again somewhere quieter, clapping right on each beat."

`first-test-fixes.md` gets a one-line note that these were reworded in U5b.

**`recording-timing.md` (follow-up 2).** These parts are updated in place to what shipped:
- the user table rows;
- the mic sync measurement section;
- the flow;
- the API lines.

The specific changes:
- The click is now a 5 ms 400 Hz to 10 kHz sweep at -1 dBFS (`CLICK_PEAK`); the clap beat plays at 0.3.
- The ready step's earbuds-out warning comes with **Play clicks**.
- New `clicksFailed` step, with Try again and **Clap instead**.
- New `clap` step, which waits for **Start clapping**.
- `findClapLag` returns `lags`/`inWindow`/`strays`; `judgeClaps` returns `quiet`/`noisy`/`uneven`/`ok`.
- `CLAP_LEAD_SEC` is 0.8.
- The rule is 4 claps within ±40 ms of the median, and the clap save is `max(lag, estimate)`.
- `POST /api/config` is behind `require_own_computer`; `GET` returns `mic_sync` only to the engine's own computer.
- Members carry their sync in the join handoff.
- The "That didn't line up" and "Hold your headphones against the mic" lines are replaced.

The "Status" paragraph notes the PR #19 second pass and U5b.

### B. Launcher look (step 39), `tauri/src/index.html`

- **Tokens.**
  - `:root` copies the studio's `--background` `#12100e`, `--card`, `--border`, `--border-wood`, `--foreground`, `--foreground-muted`, `--foreground-dim`, `--primary`, `--primary-hover`, `--accent-brass` and `--accent-red-soft`, by the same names.
  - `tauri.conf.json` `backgroundColor` is `#12100e`.
  - The window, launcher and studio are one colour.
- **Fonts.**
  - Plus Jakarta Sans (400 to 800) and JetBrains Mono (500 to 700) are bundled as local latin-subset woff2 in `tauri/src/fonts/`, with their OFL licence text, through `@font-face`.
  - The engine and the internet may not be up yet. The system stack stays as the fallback.
- **Wordmark.** The studio's: the mic icon in a 28px walnut tile with an amber stroke, then "DUBMATE" in 800.
- **Type.**
  - Status in the body font at 15px.
  - Mono only for numbers (percent, MB, elapsed) and the details log.
  - The h1 title on cards is 18px.
  - Stage labels in sentence case ("Prepare", "Download", "Install", "Finish") at 12px on `--foreground-muted`, with a check icon on done stages.
- **Contrast.**
  - The amber button gets espresso text; white was 3.19:1.
  - The details toggle is 12px on `--foreground-muted`.
- **Motion.** Under `prefers-reduced-motion`, the spinner stops on a static ring and the sheen is off. State stays visible through text and the bar.
- **Icons.** An SVG warning icon replaces ⚠️.

### C. An honest launcher (step 39a)

**One source of startup text.** Rust owns the stage text:
- `startup-progress` is now:
  - "Starting the engine", at spawn;
  - "Loading your scenes", when uvicorn's "Waiting for application startup" line arrives on stderr.
- The stderr "Error"/"Traceback" → "Still starting" hack goes.
- After `server-ready`, while `update-status` hasn't come yet, the launcher shows "Checking for updates".
- The JS poll still detects health, but writes no text.

**Elapsed time.** The JS timing is based on elapsed time, not poll count:
- From 8 s, a mono detail line reads "Still starting · 12 s", ticking every second.
- From 25 s, the splash stays neutral. The status line keeps the stage, and the detail line becomes "Taking longer than usual · 31 s", with a ghost text button, **"Restart DubMate"** (`trigger_start_sidecars`).
- No red card comes from the JS. Its only safety is a "DubMate didn't start" failure after 3 minutes with no answer from Rust.

**Real failures only, from Rust.**
- `wait_for_engine` waits up to 180 s, not 30.
- It stops early once the engine process has exited. The exit watcher sets a flag, so it doesn't send a second error.
- `server-error` carries a struct: `{ kind, title, message, detail }`. The launcher still accepts the old string.
- A pure `classify_engine_failure(last_stderr)` picks the kind (unit-tested):
  - "10048", "address already in use", "Errno 98" or "Errno 48" → `port_in_use`. Title "Another app is using DubMate's port"; message "Close any other copy of DubMate, or restart your computer, then press Restart DubMate."
  - "ModuleNotFoundError" or "ImportError" → `damaged`. Title "Some of DubMate's files are damaged"; message "Reinstall DubMate to fix this."
  - Anything else → `crashed`. Title "DubMate stopped while starting"; message "Press Restart DubMate to try again." (There is no support address to send details to, so the message doesn't ask for them.)
- Missing files → `missing_files`, with today's text.
- No runtime → `no_runtime`. Title "DubMate couldn't start"; message "Reinstall DubMate to fix this."
- Timeout → `timeout`. Title "DubMate didn't start"; message "It didn't answer for 3 minutes. Press Restart DubMate."

**Error card.**
- The title (h1) is the cause. The body is the action, in the body font at 14px on `--foreground-muted`; it is not a red mono box.
- The card has a red-soft hairline border and a red-soft icon.
- A text button, "Show details", toggles to "Hide details" (`aria-expanded`). The details are a mono log with `overflow-wrap:anywhere` and user-select.
- The card has `role=alert`, and focus moves to its primary.
- Buttons depend on the error:
  - **Engine failure** (all kinds above): **Restart DubMate** (primary) and **Copy details** (when there are details; clipboard, falling back to selecting the log).
  - **Update failed, engine files present:** **Open DubMate** (primary) waits for `/health`, then enters the studio without restarting. **Try the update again** (secondary) runs `apply_update` again with the same URL. Copy: "The update to DubMate {latest} didn't install. {reason} You're still on {current}." Today's "Click Try again" goes.
  - **First download failed** (no engine files): **Try again** (primary) and Copy details.
  - **"Open in browser"**: a tertiary text link, shown only after a `/health` check made when the card opens answers. It goes through `invoke('open_studio_in_browser')`, not `window.open`.

**Update card.**
- h1 "Updating to DubMate {latest_version}", with the line "DubMate restarts when it's done."
- A first download (`first_download: true`, new field on `UpdateAvailable`) shows h1 "Downloading DubMate", with "This happens once."
- The release body is not shown (see Decided).
- The bar has `role=progressbar` and `aria-valuenow`/`min`/`max`/`aria-valuetext`. The meta reads "42% · 21 MB of 51 MB · about 1 min left".
- The `update-stage` events keep the `effects-rack.md` copy ("Installing the update" / "Downloading the parts it needs").
- The splash text has `role=status` and `aria-live=polite`.

### D. Pack Builder installs in the background (step 39b)

**The launcher no longer has a Pack Builder card.**
- After `update-status` (up to date or offline), it reads `get_packbuilder_status`. When the user opted in and Pack Builder isn't installed, it calls `start_packbuilder_install`, which returns at once.
- It enters the studio as soon as the engine is healthy.
- The 20 s `builderCheckPending` hold goes. Entry still waits for `update-status`, capped at 20 s as now, so a pending update is never skipped by accident.

**Skipping an update.**
- When it isn't a first download, the update card offers **"Skip this time"** (ghost) while the download runs.
- It calls `cancel_update`, disables itself ("Skipping…"), and acts on `apply_update`'s result:
  - `Err("skipped")` → enter the studio;
  - success → `update-complete`, which opens the studio once the engine answers. Rust has already restarted it on the new files; the launcher no longer reloads itself, which used to wait out the 20 s update cap.
- It hides once the `update-stage` event ("Installing the update") arrives, because the engine may be stopped by then.
- The update is offered again on the next launch.

**Time remaining.** Rust computes `eta_secs` with a small `EtaEstimator` (smoothed speed). It is `None` until the speed is stable:
- for the update download: at least 10 s and 3 samples;
- for Pack Builder: at least 20 s and 2 finished files, because pip only reports whole files.

The UI shows "about N min left", or "less than a minute left".

**Studio (on the engine's computer, desktop app only, `desktopInvoke()`).**
- **Header chip.** `#packbuilder-install-chip` sits in `.header-status`, before the Audio button. It is hidden otherwise and for members. It polls `get_packbuilder_install` every second while `running`:
  - **Running.** A 40px mini bar plus "Pack Builder 42%", with `role=status`. A focusable tooltip reads "Step 2 of 4: Download · Downloading the speech recognition engine · 612 MB of ~2.0 GB · about 6 min left". Below 1280px only the bar and "42%" show.
  - **Failed.** "Pack Builder didn't install". A **Try again** text button calls `start_packbuilder_install` again. The tooltip gives the first line of the error.
  - **Done.** A secondary button, **"Restart to finish Pack Builder"**:
    - Outside a room it restarts at once.
    - In a room it first shows an inline confirm under the chip: "DubMate restarts, so anyone in your room is disconnected." with Cancel and Restart.
    - Restart calls `trigger_start_sidecars`, then `get_engine_port`, then navigates to the new port, the same pattern as Remove Pack Builder.
  - **Idle.** Hidden. A cold start with the marker present has Pack Builder already loaded.
- **Pack Builder link.** `#mode-opt-builder .mode-item-desc` in the header's mode menu follows the same state:
  - "Installing its tools · 42%";
  - "Its tools didn't install";
  - "Restart DubMate to finish installing";
  - otherwise the original "Turn a video into a scene pack".

## Data, API, commands and events

**Studio.** No engine (Python) change. No on-disk format change. No `localStorage` keys added.

**Rust (`tauri/src-tauri`).** Commands, each added to `build.rs`, `main.rs` and the capabilities:

| Command | Returns | Capability |
|---|---|---|
| `open_mic_settings` | `Result<(), String>`. Opens a fixed target: Windows `ms-settings:privacy-microphone` via `explorer.exe`, macOS `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` via `open`. Elsewhere it is an Err. | default, studio |
| `open_studio_in_browser` | `Result<(), String>`. Opens `http://127.0.0.1:{engine_port}/` in the default browser (same platform helper). | default |
| `start_packbuilder_install` | `Result<(), String>`. Idempotent. It checks writability and the requirements file synchronously, then spawns the pip task. | default, studio |
| `get_packbuilder_install` | `{ state: "idle"\|"running"\|"done"\|"failed", progress: PackBuilderProgress \| null, error: String \| null }` from a process-wide `Mutex`. | default, studio |
| `cancel_update` | `()`. Sets an `AtomicBool` that `download_bundle` checks per chunk; it returns `Err("skipped")`. `apply_update` clears the flag when it starts. | default |
| `trigger_start_sidecars` | unchanged | add studio |

- `install_packbuilder` (blocking) is removed. Its body becomes the spawned task, which no longer restarts the engine (the studio's "Restart to finish" does).
- External opening uses a pure `external_command(target, os) -> (program, args)` (unit-tested), so only those two targets can ever be opened. There are no new crates.

Events and payloads:
- `PackBuilderProgress` gains `done_bytes: f64`, `total_bytes: f64` and `eta_secs: Option<u64>`.
- `UpdateProgressPayload` gains `eta_secs: Option<u64>`.
- `UpdateCheckResult::UpdateAvailable` gains `first_download: bool`. `changelog` keeps the release body for compatibility; the launcher ignores it, and the "Downloading DubMate. This happens once." special case moves to the launcher.
- `server-error` becomes the struct described above.

**Mixed versions.**
- An older studio page only calls the commands it knew (`remove_packbuilder` and the others stay).
- The launcher and Rust ship together in the desktop app, so they never mismatch.
- The in-place updater ships only the Python and static bundle, so a new studio page can run inside an older desktop app. Then:
  - the chip calls `get_packbuilder_install`, which the old app refuses → the chip stays hidden;
  - `open_mic_settings` is refused → the button hides.

## Implementation groups (build order)

Every group works in `X:/Projects_X/DubMate-wt/u5b` and commits per step. It keeps `X:/Projects_X/DubMate/.venv/Scripts/python.exe tests/run_all_tests.py` green and takes after-shots with `node C:/Users/tanis/AppData/Local/Temp/dm_u5b/shots.js <port> after-gN` (engine: `bash C:/Users/tanis/AppData/Local/Temp/dm_u5b/boot.sh <port>`). Launcher after-shots need their own entry in `dm_u5b/launcher_states.js`. The Rust groups run `cargo check` and `cargo test` in `tauri/src-tauri` with `CARGO_TARGET_DIR=X:/Projects_X/DubMate/tauri/src-tauri/target`. The first build is slow.

1. **G1: Audio settings (40d) and the PR #19 follow-ups.**
   - Files: `level_target.js` (new), `audio_setup.js`, `room_check.js`, `mic_sync.js` (copy only), `index.html` (the Audio settings modal only), `style.css`, `recording-timing.md`, and a one-line note in `first-test-fixes.md`.
   - The OS-settings button calls `open_mic_settings` (added in G2) and hides on failure.
   - Tests:
     - A new `tests/test_audio_settings_layout.js` covers:
       - `levelZone`/`levelHint` edges, and the hint going back to neutral after 2.5 s of quiet;
       - the meter's zone class and the tooltip text;
       - the status classes on the Timing and Room rows and the pill;
       - the denied step for desktop-windows, desktop-mac and browser (one list, the button only with `desktopInvoke`, "Using something else?" holding the rest, the lists hidden for `NotFoundError`);
       - the first-run title and privacy line, local and member;
       - "Check again" on the failed panel and the unusable card;
       - no emoji in the modal.
     - Update `test_mic_sync_panel.js` (copy constants), `test_meter_during_checks.js`, `test_room_check_panel.js`, `test_settings_privacy.js` and `test_packbuilder_removal.js` (danger class) where IDs or text change.
     - Extend `test_css_floors.js`: the sticky footer rule, the status classes and no `--foreground-dim` on the meter text.
   - After-shots: devices at all three sizes (Done `ok` at 1280x720 and 960x680), first run, denied, member.
2. **G2: Rust for 39a and 39b.**
   - Files: `sidecars.rs` (stages, the 180 s wait with the exit flag, `classify_engine_failure`, the struct `server-error`), `packbuilder.rs` (install state, `start_packbuilder_install`, `get_packbuilder_install`, bytes and ETA on progress, no restart at the end), `updater.rs` (`EtaEstimator`, `eta_secs`, `first_download`, the cancel flag, `cancel_update`), a new `external.rs` (`external_command`, `open_mic_settings`, `open_studio_in_browser`), `main.rs`, `build.rs`, and `capabilities/default.json` and `studio.json`.
   - `cargo test` covers `classify_engine_failure`, `EtaEstimator` (unstable then stable, smoothing, None before the threshold), `external_command` per OS, the install-state transitions (idle → running → done/failed, start while running is a no-op), `UpdateAvailable` serialization with `first_download`, and the parser's byte fields.
   - Update `tests/test_loading_screens.py` for the new event and command names, and `test_launcher_ui.js` only if it breaks.
3. **G3: the launcher UI (39, 39a, and 39b's launcher side).**
   - Files: `tauri/src/index.html` and `launcher.js`; fonts plus OFL in `tauri/src/fonts/`, fetched once from Google Fonts' latin woff2 into the repo (nothing installed); `tauri.conf.json` `backgroundColor`.
   - Builds sections B, C and D's launcher part. The Pack Builder card code (`renderBuilderProgress`, the stages and the tech log) is removed.
   - Tests: rewrite `tests/test_launcher_ui.js` in JSDOM with a stubbed `__TAURI__` that records `invoke` calls and fires events. It covers:
     - the stage text only from events;
     - the 8 s and 25 s thresholds (fake timers);
     - no red card on a slow start;
     - each `server-error` kind's title and buttons, and the legacy string payload;
     - details toggle labels;
     - focus to the primary and `role=alert`;
     - the update card title, first download, Skip (calls `cancel_update`, then enters on `"skipped"`, hidden after `update-stage`);
     - ETA text;
     - start install then enter at once;
     - "Open in browser" only after health.
   - Update `test_loading_screens.py`.
   - After-shots: every launcher state at 960x680.
4. **G4: the studio side of 39b, and the records.**
   - Files: the header chip and the mode-menu line in `index.html`/`style.css`; a new `static/js/studio/packbuilder_install.js` mixin (poll, render, Try again, the restart confirm and navigate), wired in `app.js` boot.
   - Tests: a new `tests/test_packbuilder_install_chip.js` covers:
     - hidden without `desktopInvoke` and for members;
     - running, failed and done rendering, and the menu line;
     - polling stops on done or failed;
     - Try again calls the command;
     - the restart confirm only in a room, then `trigger_start_sidecars` → `get_engine_port` → navigate;
     - an old app refusing the command keeps the chip hidden.
   - CHANGELOG `[Unreleased]`; ROADMAP ("UI pass: U5b done").
   - Final after-shots, including the header with the chip at 1440, 1280 and 1024 wide.

## Risks

- **Background download during a session.** 2 GB of pip download and install compete with the room tunnel and recording for bandwidth and CPU. The chip makes it visible. There is no throttle, and no pause, in this PR.
- **The restart disconnects the room.** That's why it's never automatic, and why it confirms in a room. Ignoring it is safe: the next launch loads Pack Builder.
- **A retry after a partial install.** `ai-packages` may already be on the engine's `PYTHONPATH`. The engine only uses it once `.install-complete` exists (`pack_builder.py`), and pip writes that marker only after success.
- **The Skip race.** Skip can land as the download finishes. The launcher acts only on `apply_update`'s result, and Skip hides at `update-stage`.
- **The studio can call more commands.** The loopback studio page can now start the install and restart the engine. This matches what `remove_packbuilder` already allows. It is `127.0.0.1` only; a host's tunnel page gets nothing.
- **OS settings URLs.** `ms-settings:` via `explorer.exe`, and the macOS `x-apple.systempreferences` pane name, which Apple has moved before (hands-on). On failure the button hides and the written steps stay.
- **The meter turns red above -6 dBFS.** Loud speakers see "Too loud" sooner than before (red was at -3). It now agrees with the loudest-line check.
- **Fonts.** About 60 KB of woff2 in the desktop bundle (two variable latin subsets), OFL-licensed (licence included).
- **Test churn.** `test_launcher_ui.js` is rewritten. Five Audio settings suites change IDs or text in the same commits.
- **A 3-minute engine wait** delays the real "didn't start" card for a hung engine. The neutral splash offers Restart from 25 s.

## Decided without the owner

1. **One level target** for the meter, the hint and the loudest-line check: -10 to -6 dBFS peak, the loudest-line check's existing numbers. The meter shows peak. Red starts above -6.
2. **Pack Builder installs fully in the background** (the plan's main option). The launcher's "Open DubMate now" / "Install later" fallback isn't needed, and the launcher shows no Pack Builder card.
3. **Finishing Pack Builder needs a restart, and the user starts it** ("Restart to finish Pack Builder"), with a confirm in a room. Otherwise the next launch picks it up.
4. **The update card drops the release notes** instead of clamping them to three lines. "Updating to DubMate 1.1.4" and "restarts when it's done" are what someone needs at that moment.
5. **Time remaining is computed in Rust.** It shows only once stable: after 10 s and 3 samples for the update, and after 20 s and 2 finished files for Pack Builder.
6. **Slow-start thresholds.** "Still starting · N s" from 8 s. "Taking longer than usual" plus Restart from 25 s, still neutral. Rust waits 180 s before a real failure.
7. **Clap failure lines say "beat"**, matching "clap on each beat you hear". The clicks are a different step.
8. **The first-run privacy line shows only where it's true.** On your own computer: "Audio stays on this computer." On a host's page: "Your takes are saved on the host's computer."
9. **No new crates.** The OS settings page and the browser open through one fixed-target Rust helper (`std::process`), not the opener plugin, so no arbitrary URL can be opened.
10. **Progress reaches the studio by polling a command** (1 s), not by Tauri events. It survives page reloads and needs no event permission for the remote page.
11. **"Open in browser" stays** only as a tertiary link, and only after `/health` answers.
12. **"Skip this time" cancels the download.** The update is offered again next launch, and it can't be skipped once installing starts.
13. **The mic pill keeps the label style** (uppercase via CSS), with sentence-case source text: "Mic ready", "Mic blocked", "No mic yet".
14. **The recovery lists are hidden for errors that aren't about permission.** "No microphone was found" doesn't need padlock instructions.
15. **Not in this PR:**
    - 9c's UI leftovers: the "Heard 6 claps… Use this" preview, Forget sync, the 8-dot metronome and mic errors inside the sync panel.
    - 40a's header Audio tooltip for members (premiere PR).
    - The landing page's `#btn-open-builder` (landing redesign).

## Hands-on checks (the owner, on the desktop app)

- **Fresh Windows install with Pack Builder ticked.**
  - The studio opens while it installs, and the chip moves through the four steps with a time left.
  - Join or record during the install.
  - Press "Restart to finish Pack Builder" in a room (the confirm shows) and outside one. Pack Builder should then process a video.
- **Network lost mid-install.** The chip says it didn't install. Try again works once the network is back.
- **An update with "Skip this time".** The studio opens on the old version and the update is offered on the next launch. An update that installs requirements hides Skip at "Installing the update".
- **Mic denied.** Turn off "Let desktop apps access your microphone" in Windows. The denied step shows the Windows desktop steps, and "Open Windows microphone settings" opens that page. Turn it back on and press Try again. Repeat on macOS with "Open macOS microphone settings".
- **A slow first start** (antivirus scanning). The splash stays neutral with "Still starting · N s", then "Taking longer than usual". No red card appears unless the engine really fails.
- **Meter.** Speak normally, then shout your loudest line. The hint, the green band and "Check your loudest line" should agree.
- **Offline launch.** The launcher's fonts look like the studio's.
- **Window sizes.** At 1280x720 and the 960x680 window minimum, Done in Audio settings is reachable without scrolling.
- **Screen reader** (Narrator or VoiceOver) on the launcher. The stage changes and the error card are read out.
