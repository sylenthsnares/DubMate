# Design: UI pass U2, the booth's right column (Layout A)

Phase U2 of the UI plan (`design/ui-plan.md`, section 2 and steps 10 to 24 plus 22a, including every "(added from full critique)" item). Branch `ui/u2-booth` from `origin/main` at `57d6c67` (PR #19 and U1 merged, so BF-1, BF-3, BF-4 and the U1 floors are in).

## Goal

The owner tested the app and said the right side of the booth "needs a lot of work", and he "couldn't see the takes option anywhere". Today the column runs Monitor, Record, Voice, nav. It can't scroll, so at 1280x720 Prev and Next are cut off (before-shots `05`, `06`, `07`). Takes sit behind a small "Takes (3)" button whose list covers the Voice card. The full rack opens in a slot about 118px tall. Saving a take blurs and locks the whole booth.

After U2 the column reads top to bottom in the order people use it: record, pick a take, shape the sound, set what they hear, move to the next line. Every part can be reached at 1280x720.

## Owner decisions this implements (binding, plan section 6)

1. **Layout A, one stacked column:** Record, then Takes (always visible, a permanent section), then Voice presets with a "For" scope and Level, then a compact Monitor, with Prev/Next pinned at the bottom. "All effects" opens the full rack inside the column, not in a modal.
2. **The next line is usable while a take saves.** Only the line being saved is locked.
3. **The mouse wheel turns a knob only when that knob has focus.** Otherwise it scrolls.
4. **`style.css` is the source of truth: refine, don't redesign.** Use U1's floors: no text under 11px, 12px for sentences, the brass focus ring, the shared `.btn` classes, `.btn:disabled`. One amber primary per view. Green means "the take in the dub" or "done". Amp decoration (screws, diamond grille) appears only on faceplate headers and the record bezel.

Out of scope: the lobby (U3), landing, join and packs (U4), and premiere, export, Audio settings, Pack Builder and launcher (U5); mic sync and join logic. Effects rendering (engine-side pedalboard, optimistic UI) and the take model keep working as they do now. The one exception is listed under "Decided without the owner", item 1.

## Layout and behaviour

`#booth-controls-panel` becomes a three-row grid (`grid-template-rows: auto minmax(0,1fr) auto`) that fills the booth height.

### 1. Record deck (pinned, about 150px)

- **Faceplate header:** "● RECORD" and a state badge bound to real state. The badges are READY, COUNT-IN, REC (red), SAVING, NO MIC and OFFLINE. NO MIC applies when the mic permission is denied or the last mic open failed; `ensureMicReady` stores that error. OFFLINE applies when `socket.connectionState` isn't `open`. On a line you can't record, the badge is hidden.
- **Record button:** 62px, and 48px at a viewport height of 800px or less. It shows ● whenever it is idle (the ↺ glyph goes), ■ while recording, ✕ during the count-in and a spinner while that line saves. Its `aria-label` and tooltip change with the state: "Record take 4 (Space)", "Stop recording (Space)", "Cancel the count-in (Space)", "Saving take 3".
- **Next-action lines beside the button:**
  - Idle: "Record take 4" over "Space · 3-beat count-in".
  - Count-in: "Counting in… Space or click to cancel".
  - Recording: "Recording · Space to stop".
  - Saving: "Saving take 3…".
  - NO MIC: the `micErrorMessage` line.
  - OFFLINE: "Takes will upload when you're back online."
  - A line that isn't yours: "Black Guy 3 is voiced by Mika".
- **Segmented transport:** "▶ Original | ▶ Take 3". It replaces `#btn-toggle-ab`, `#label-ab-state` and the separate Original and Preview buttons. The element IDs `#btn-play-orig` and `#btn-preview-take` stay, to keep test churn small.
  - "Take N" is disabled until the line has a take.
  - While one side plays, pressing the other side switches what you hear in place, using the existing `setABState` gain swap, so you can compare without restarting. Otherwise a press plays that side from the line start.
  - `aria-pressed` marks the side that is playing.
- **Mic-sync advice (step 24):** a dismissible inline hint under the transport replaces the toast: "Sync your mic so takes line up on their own." with "Audio settings" and a × button. It has the same once-per-device-pair-per-tab rule as today's `takeSavedMessage`.

### 2. Scrolling middle (`overflow-y: auto`; it doesn't scroll at 1440x900 with the rack closed)

**TAKES · N card (`#card-takes`, replaces `#take-history`, the popover and `#btn-clear-take`)**

- **Header:** "TAKES · 3", plus a quiet `T` key hint ("T to pick").
- **Empty and single-take states:** with 0 takes the card reads "No takes yet. Press Space to record." With 1 take it adds the hint "Record again to compare takes."
- **Rows** form a `role="radiogroup"` with a roving tabindex (one tab stop). Each row is `role="radio"` and has these parts:
  - a radio dot;
  - "Take 3" and "0.8 s" (one decimal);
  - the recorder's name, only when it isn't you;
  - sync in words: "Tight sync" (score 0.8 or higher), "Good sync" (0.6 or higher), "Loose sync" (below 0.6), or "–" with no score. The tooltip keeps "Timing 82%: how closely this take follows the original line's timing".
  - for the take in the dub, a green row with "In the dub" (`aria-checked="true"`); every other row gets a "Use" button.
  - a "⋯" menu with "Play this take" and "Delete take".
- **Delete is undone in place.** The row turns into "Take 3 deleted · Undo" for 6 s. The `DELETE` request goes out when that time ends, when the line changes, when you leave the booth, or on `pagehide` (`fetch` with `keepalive`). Undo cancels the timer. No `confirm()`.
- **Lines that aren't yours:** the rows are read-only. They show the "In the dub" marker, and "⋯" holds only Play. This matches the server's `_require_line_actor`.

**VOICE card (`#card-voice-dsp`)**

- **Visibility:** visible on every line you can record, before the first take too, and hidden on other people's lines.
- **Header:** "VOICE", plus a bordered secondary button, at least 28px tall, labelled "All effects › · 4 on".
- **Preset chips:** Clean, Warm, Radio, Monster, and Custom when the sound has been edited.
- **"For" scope:** a native `<select>`, labelled "For", with these options:
  - "This take", which reads "Your next take" when the line has no take;
  - "All of Black Guy 1's lines";
  - "Every line", for the host only.
- **Which option it starts on:** on line load it shows where the current sound comes from (`resolveChain` order): the take's own chain, the character's, or the session's. With no source it shows "This take".
- **Where edits go:** preset and rack edits apply to the chosen scope:
  - **This take:** `PUT …/chain`, as today.
  - **Character or session:** `PUT /api/rooms/{id}/voice`, saved after the same 400 ms of quiet and on release.
- **Choosing a wider scope asks first, inline.** An inline row replaces `window.confirm`. It reads "Use Radio on all of Black Guy 1's lines? Lines with their own sound switch too." with "Use on all their lines" and "Cancel". "Every line" says "Lines and characters with their own sound switch too." Cancel puts the select back. On confirm, a `role="status"` line shows "✓ All of Black Guy 1's lines use Radio" until the next line loads. Choosing a narrower scope copies the current sound onto the take without asking.
- **Before the first take:** a chip sets the sound for the next take. It is kept per line in memory and sent as `chain` on upload (see "Decided without the owner", item 1). There's no preview until a take exists.
- **Level row:** a small knob (`#slider-gain`), "+4.5 dB", "✓ Matched" (shown only when `|take.gain_db - take.auto_gain_db| < 0.05`, comparing the take's real values instead of the 0.5-step slider) and an "Auto" button. "Match: +1.9 dB" goes. With no take, the row reads "Level is matched to the scene when you record." The unlabelled meter (`#voice-meter-fill`, `startVoiceMeter`) is removed.

**Monitor strip (about 70px, no faceplate, no grille)**

- A Backing slider (a native range on the U1 slider style) with "60%".
- Two labelled switches (`.switch-checkbox`): "Count-in" (tooltip "Beeps on the count-in") and "Hear original" (tooltip "Hear the original voice while you record").
- Each state shows once. The I/O rockers, the ON/OFF tags, the screws and the grille fill go.

### 3. Footer (pinned)

- "‹ Prev" (secondary) and "Next line ›" (amber).
- **On your last line:** the footer shows "Done ›". If every line you can record has a take, it marks you ready. If some don't, it asks inline instead of toasting: "2 of 3 lines recorded. Mark ready anyway?" with "Mark ready" and "Keep recording". Host and guests share this logic. The host then gets an `openDialog` confirm, "Go to the premiere now? 1 of 2 ready.", in place of `confirm()`.
- The trash icon is gone.

### All effects: the rack as the column's page

- **Opening it:** `E`, or the button. Takes and Monitor hide.
- **The record deck shrinks to one row:** a 40px button, "Record take 4" and "▶ Take 3". Space still records.
- **The middle shows the voice page:** a "‹ Back · VOICE · Custom · 4 on" header, then For and Level, then the module list.
- **Closing it:** Back or `Esc` closes it and returns focus to "All effects".
- **The rack does its own work, no longer inside the Voice card:** the `.advanced-rack-box` `max-height`, its nested scroll and the `fx-expanded` sizing rules go. The page scrolls in the middle region.
- **Modules:**
  - On modules are expanded. Off modules are one row: a switch, the name and "off".
  - Plain dial labels: Low cut "Cut below", Gate "Silence below", De-ess "Tame S above", Compress "Boost after" (make-up), Reverb "Delay before" (pre-delay) and "Room size" (decay).
  - The Mix dial goes from Low cut and Gate. Their `mix` stays in the chain untouched.
  - Pitch and Reverb get tooltips: "Raise or lower your voice" and "Puts your voice in a room".
- **Sizes and surfaces:**
  - Knobs are 36 to 40px with a 44px hit area. Switches are 40×22.
  - Readouts are full-contrast ivory.
  - The rack sits on a plain `--card` surface; the diamond pattern stays on the faceplate header only.
- "Clean up noise" stays as the last module row.

### Knobs (`static/js/knob.js`)

- **The wheel acts only when the knob has focus** (`document.activeElement === container`). Otherwise there's no `preventDefault`, and the page scrolls. You click or Tab to a knob first.
- **Wheel and arrow keys** send `input` on each step. They send one `change` 400 ms after the last step, so saves and renders are debounced the same way drags are.
- **Turning a dial on an off module no longer switches the module on.** `editTakeVoice` drops `on: true`. Off modules are collapsed, so their dials aren't visible anyway.
- **While the panel is locked** (that line is saving, or effects aren't available), each knob wrapper gets `aria-disabled="true"` and `tabIndex=-1`. The wheel, key and drag handlers return early.
- DESIGN.md's "Analog Dials" line changes to "the scroll wheel adjusts a focused dial".

### Keyboard (`app.js` keydown and `shortcuts.js`)

- `Space`, `[` and `]` work as today.
- `T` focuses the take in the dub in the Takes card. Inside the card:
  - `↑` and `↓` move between rows;
  - `P` plays the focused take;
  - `Enter` makes it the take in the dub;
  - `Delete` deletes it, with the in-place Undo.
- `A` switches the transport side. If something is playing, the sound switches in place; otherwise it plays that side.
- `,` and `.` go to the previous and next line.
- `E` opens or closes All effects. `Esc` closes it.
- None of these fire in inputs, selects or a focused knob, or while a dialog is open.
- All of them go into the `?` sheet's Booth group. `test_shortcut_sheet.js` presses every listed key.
- Each matching control's tooltip carries its key, the way "Record (Space)" already does.
- The global keydown guard drops `isProcessingTake`. Only the saving line's recording is blocked (decision 2).

### Live recording feedback and saving in the background

- **While recording** (step 21):
  - A REC tally with the time left ("● REC · 0.6 s left") sits in the video's top-left corner.
  - The take lane draws the incoming mic level live from `audio.readInputLevel()` (BF-4's `recordAnalyser`).
  - The line end shows as an "end" mark, with the tail (end to end + 0.8 s) hatched. These marks show on every take, not only while recording.
- **Saving** (step 22):
  - `#booth-processing-overlay` and the global lock in `setBoothProcessing` go.
  - A per-line `savingLines` map drives four things: the SAVING badge and spinner on that line's record button; "Saving… cleaning up noise" ("Saving…" with noise cleanup off) in its take lane and in the Takes card as a pending row; a "saving" mark on its line chip; and the Voice and Takes controls locked on that line only.
  - Every other line works, including recording.
  - Values the upload needs (the offset, gain, guide voice, noise reduction and pending chain) are captured when recording stops, before any `await`.
  - When the upload returns, the booth reloads only if you are still on that line and not counting in or recording. The same guard applies to the `take_recorded` echo, which otherwise only refreshes the Takes card and the chips.
  - "Take saved" toasts only when the saved line is off screen ("Take 3 saved on line 2"). On screen, the new row is the confirmation.
- **A failed upload keeps the take** (step 22a):
  - The blob stays in memory, keyed by line, and the Takes card shows "Take · waiting to upload" with "Retry" and, in its ⋯ menu, "Discard".
  - It retries on its own when the socket goes back to `open`.
  - While any take is waiting, a `beforeunload` guard warns before the page closes.
  - While OFFLINE, the waveform's take lane is dimmed.

## Data, API and WebSocket

- **One server change (decision 1):** `POST /api/rooms/{room}/lines/{line}/takes` accepts an optional form field, `chain`, as a JSON string. When it's present and valid (`vocal_chain.normalize_chain`), it replaces the copied picked-take chain as the new take's `sound`. A malformed value is a 400, "That sound couldn't be read." Absent means today's behaviour. Older tabs don't send it.
- No new routes, socket messages, on-disk fields or state version. Delete stays the existing `DELETE` route, only sent later. Scope changes use the existing `PUT …/chain` and `PUT /voice`.
- Client-only state: `savingLines`, `pendingUploads`, `pendingDelete`, `pendingNextTakeChain` (per line), `voiceScope`. None of it is persisted.

## Implementation groups (build order)

Every group works in `X:/Projects_X/DubMate-wt/ui-u2`, commits per step, keeps `X:/Projects_X/DubMate/.venv/Scripts/python.exe tests/run_all_tests.py` green, and takes after-shots with `C:/Users/tanis/AppData/Local/Temp/dm_u2/before.js <port> after-gN` (engine: `bash C:/Users/tanis/AppData/Local/Temp/dm_u2/boot.sh`, port in `dm_u2/port`) at 1440x900, 1366x768 and 1280x720. The script logs which column controls a click can reach; the 1280x720 lines must report `ok` for record, the transport, All effects, Prev and Next.

1. **G1: the column skeleton, record deck, monitor strip and toolbar** (plan steps 10, 11, 12, 13, 16, 17, 24). Builds the markup, CSS and booth.js described in sections 1 and 3 and the Monitor strip. The existing Takes (N) widget moves unchanged into the Takes slot for now. Also: one timing readout (no `#waveform-offset-legend`, no canvas "OFFSET" label, `loadBoothLine` via `setNudgeValue(v, false)`, "Reset to auto" looking active only at `auto_offset_ms`), the gain-badge fix, the copy (see "Line numbering" in Decided), the host toolbar (one primary "Start premiere · 0/2 ready", no "Premiere ›" for the host, guests get "Back to the premiere" only while the premiere is on, "All recorded · Mark ready"), the shared Done logic with the inline ask and `openDialog`, and the waveform box's minimum height (two 32px lanes plus the axis) with the drag hint in the timing row. Tests: a new `tests/test_booth_column.js` (badge states, transport enabling and live switch, Done flow, toolbar per role, gain badge on real values) and updates to `test_frontend.js`, `test_booth_timing.js` and `test_loading_screens.py`.
2. **G2: the Takes card, keyboard and line chips** (steps 14, 15, 23). Builds `#card-takes` as specified, the deferred delete with Undo, read-only rows on other people's lines, and the keys `T`, `↑`/`↓`, `P`, `Enter`, `Delete`, `A`, `,` and `.`. It adds them to `SHORTCUT_GROUPS` and to the tooltips. Line chips become `<button>`s with `aria-current="step"`, labels like "Line 6, Black Guy 3, recorded, 3 takes", a visible take count, and numbering that matches the stage bar. Remove the popover code, `toggleTakeHistory` and the interim button. Tests: a new `tests/test_takes_card.js` (states for 0, 1 and 3 takes; pick; undo and the timer firing; delete sent on line change; roving focus; read-only for others) and updates to `test_shortcut_sheet.js` and `test_frontend.js`.
3. **G3: the Voice card, For scope, the rack page and knobs** (steps 18, 19, 20 plus the upload `chain` field). Covers the server field and a test in `tests/test_effects_rack.py`; the Voice card before the first take; the For select with an inline confirm (no `confirm()` left in `voice_rack.js`); the Level row; the meter removed; the rack as a column page with collapsed off modules, plain labels, sizes and the `E`/`Esc` keys; `knob.js` focus-only wheel, the debounced change and the lock; and the DESIGN.md knob line. Tests: extend `test_voice_panel.js` and `test_voice_preview.js` (scope routing, confirm and cancel, pending chain sent on upload, the dial no longer turning a module on), and add `tests/test_knob.js` (wheel with and without focus, debounce, locked knob ignores input).
4. **G4: live recording feedback and saving in the background** (steps 21, 22, 22a). Covers the REC tally, live trace and end and tail marks in `waveform.js`; `savingLines` replacing the overlay and the global lock; the guarded reloads and echoes; the off-screen-only toast; the kept failed takes with retry on reconnect, Discard and the leave-page guard; and the dimmed lane while offline. Finish with the CHANGELOG `[Unreleased]` entry, ROADMAP ("UI pass: U2 done") and the final after-shots. Tests: a new `tests/test_background_save.js` (record line 2 while line 1 saves, upload reply doesn't yank you back, echo doesn't cancel a count-in, chip and badge states, failed upload kept then retried on `open`, Discard), plus updates to `test_connection_banner.js` and `test_frontend.js`.

## Risks

- **Concurrent uploads.** Two takes can now upload at once. The engine serializes them on `room.processing_lock`, along with background level re-matching, so a second save waits behind the first. Per-line state keeps the UI honest, but saving can take longer on slow machines with noise cleanup on (hands-on check).
- **Echo reloads.** `loadBoothLine` cancels a count-in. Every reload path that isn't user-driven (upload reply, `take_recorded`, `take_picked`/`take_deleted` from someone else) must skip the reload while you are counting in or recording on that line. A test covers the upload and `take_recorded` paths.
- **Wider-scope edits re-match many takes.** At "All of X's lines", each saved edit clears that character's take chains and queues a background re-match (`rematch_later` coalesces). Exports wait for it, as today.
- **Deferred delete.** A take deleted in the last 6 s before a crash or a killed tab survives. This is the safe direction.
- **In-memory waiting takes** are lost on reload. The leave-page guard warns first. IndexedDB is out (decision 9).
- **Height.** At 1280x720 the middle scrolls with Voice partly visible and Monitor below (the plan accepts this). If the after-shots show the Takes card itself cut, the fallback is plan section 2's one-step move of the Monitor strip under the waveform. Report it rather than build both.
- **Test churn.** About eight JSDOM suites reference removed IDs (`#take-history`, `#btn-toggle-ab`, `#btn-clear-take`, `#booth-processing-overlay`, `#waveform-offset-legend`). Each group updates the suites it breaks, in the same commit.
- **The native `<select>`** in WebView2 and WKWebView picks up the U1 select styling. The open list itself is drawn by the OS (hands-on check).

## Decided without the owner

1. **Presets before the first take** need the sound sent with the upload. The upload route gets an optional `chain` form field, the only server change. The alternative, a `PUT …/chain` right after upload, would render and re-level the take twice.
2. **The "For" scope sticks.** It starts on where the current sound comes from. Preset and rack edits go to the chosen scope. Widening asks inline; narrowing copies the sound onto the take without asking.
3. **Delete is deferred 6 s with an in-place Undo**, sent at once on line change, on leaving the booth or on `pagehide`. The server delete stays permanent; there's no soft delete.
4. **Sync in words:** "Tight sync" at 0.8 or more, "Good sync" at 0.6 or more, "Loose sync" below 0.6, and "–" when unscored. The score has no direction, so the plan's "A bit late" can't be said truthfully.
5. **Line numbering:** the stage bar uses scene numbers like the chips: "Line 6 of 8 · 0.9 s". Your own position ("Your line 2 of 3") and the time range go in its tooltip.
6. **Other people's lines:** the Takes card is read-only (Play only), Voice is hidden, the badge is hidden, and the next-action line names who voices the character.
7. **"Premiere ›" goes for the host.** Guests see "Back to the premiere" only while the premiere is on.
8. **"Take saved" toasts only when the saved line is off screen.**
9. **Failed takes are kept in memory only**, with a leave-page warning. No IndexedDB.
10. **Mix dials are hidden on Low cut and Gate.** Their value stays in the chain.
11. **No one-line summary mode for on modules.** The column page scrolls instead.
12. **"For" is a native `<select>`**, for accessibility and less code.
13. **Mark ready:** the host's stays secondary, because Start premiere is the one primary. A guest's becomes the primary, "All recorded · Mark ready", once every one of their lines has a take.
14. **"Count-in"** switches the beeps only. The visual 3-beat count-in always runs, and the tooltip says so.
15. **`A`** switches the side in place while playing, and starts that side when idle.
16. **Monitor stays in the column.** It moves under the waveform only if the 1280x720 after-shots cut the Takes card.

## Hands-on checks (the owner, on a real mic)

- Record line 1, press Next, and record line 2 while line 1 is still saving, with noise cleanup on. Both takes should land on the right lines, and the booth shouldn't jump back.
- Turn a knob with a mouse wheel and with a trackpad: unfocused it scrolls, and after a click it turns.
- At 1280x720 (laptop) and in the desktop app: reach Next, the Takes rows and All effects without the window clipping them. Open the For select in the desktop app.
- Delete a take, then Undo within 6 s, and once more letting it expire. Check with a second person that they see the take go only after the expiry.
- Pull the network during a save. The take should show "waiting to upload" and upload on its own when the connection is back.
- Keyboard only: T, the arrows, P, Enter, Delete, A, `,`, `.` and E, with a screen reader on the Takes rows if one is at hand.

**When the owner can look at the UI:** the new column layout is visible after G1, and the whole column (takes, voice, rack, background saving) after G4.
