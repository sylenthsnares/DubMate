# Design: UI pass U5a, an honest premiere and export

Phase U5 steps 40, 40a, 40b and 40c of the UI plan (`design/ui-plan.md`, with every "(added from full critique)" note), plus four follow-ups PR #19 left open (`design/first-test-fixes.md`, "Host-only actions" and "Premiere mix reaches the export"). Branch `ui/u5a-premiere-export` from `origin/main` at `5ff5bc3` (PR #19, U1 and U2 merged).

## Goal

Before-shots: `%TEMP%/dm_shots/ui-u5a-premiere-export/before-*` (report in `before-report.txt`).

- **The video is crushed.** At 1280x720 and 960x680 the theater is 158px tall (`before-01-…-1280x720`). The booth's `@media (max-height: 720px) .video-container` rule also hits the premiere, and `.theater-player` caps it at `min(44vh, 400px)`.
- **Too many equal buttons.** Play, Replay, a 16:9/9:16 toggle that changes nothing, a green Export video, Project files, Stems, then a second row with Download 16:9/9:16, Project files and Stems again (`before-01-…-full-1440x900`).
- **Members see host controls.** A member sees Export video, Project files and Stems, which answer 403. They also see the Mix and Dialogue level sliders, which change only their own preview and don't say so (`before-02`, `before-05`). PRODUCT.md says "Never fake it".
- **Fake progress and a fake failure.** The bar jumps to 25% and then 65%. A failure keeps the title "Rendering your dub" and the spinning reel, and offers Watch and Download for a video that doesn't exist (`before-13`). A member gets the host's export modal (`before-08`).
- **The premiere waits for the render.** `launch_premiere` renders the MP4 before it sends anyone in (4 s on the 6 s test scene, minutes on a long one). A failed render is only a server log line.
- **Members can start a render.** A member's `GET /export/download?aspect_ratio=9:16` with no video ready rendered one on the host's machine (200 after 7.8 s, in `before-report.txt`).
- **The slider jumps.** The `mix_balance_sync` and `dialogue_presence_sync` handlers apply the host's own echo, so under lag the slider jumps back mid-drag.
- **A stale render is offered as ready.** If the mix changes while a render runs, the render still finishes with the old mix.

After U5a the video owns the premiere. Under it sit one primary (Play/Pause), a timeline, one Save button and two closed sections, Mix and In this dub. Everyone arrives at once on the live mix, and the MP4 renders in the background. Members get a read-only view of the host's mix and a Download button. A video is offered as ready only when it matches what the room hears.

## Owner decisions this implements

- Plan section 6, item 5: **`style.css` is the source of truth; refine, don't redesign.** U1 floors apply: no text under 11px, 12px for sentences, the brass focus ring, the shared `.btn` classes and `.btn:disabled`. One amber primary per view. Green means done or OK only. Red means recording or an error.
- Routing (section 6): the host-only guards and the premiere mix reaching the export landed in PR #19. This PR builds on `Room.master_mix_balance`, `set_mix_balance` and `rooms_api._require_host`.
- The brief: **don't change the booth, the lobby, the landing page or the join flow** (another effort is redesigning them). This PR only *calls* booth methods (`showView('booth')`, `loadBoothLine`, focusing `#card-takes`).

## Layout and behaviour

### 1. The premiere screen (`#view-screening`)

From top to bottom, all inside the view: theater, timeline, controls row, then the Mix and In this dub sections.

- **The title card goes** (`.screening-header-card`, the Host badge, the green "Final video" badge and "‹ Booth"). The header breadcrumb is the way back to the booth.
- **Theater:** `#view-screening .theater-player { height: clamp(280px, 62vh, 760px); max-height: none; }`. That is about 446px at 1280x720 and 421px at 960x680. The booth's rule stays as it is; the premiere rule wins on specificity, including inside the `max-height: 720px` media query. The expand button keeps working. At 1280x720 the theater, timeline and controls row fit without scrolling.
- **Timeline (40c), directly under the video:**
  - The left reads `0:03` and the right reads `0:06` (mono, 11px, `--foreground-muted`, tabular numerals). Between them is a 6px track with an amber played part and a 12px thumb.
  - Each line has a 2px tick at its start, in its first assigned actor's colour, or `--foreground-muted` for an unassigned line.
  - The track is `role="slider"` with `aria-label="Position"`, `aria-valuemin`/`max`/`now`, and `aria-valuetext` like "0:03 of 0:06". It is one tab stop.
  - Click or drag to seek. During a drag only the thumb and the time move. On release, the host sends `screening_control` `seek` (everyone follows; if playing, playback continues from there). A member's seek stays local.
  - Keys while the premiere is the view and focus isn't in a field: `←`/`→` move 5 s, and `,`/`.` jump to the previous/next line start. They go through the same seek path.
- **Controls row (one slim bar, wraps at 960px):**
  - `[Play/Pause]` is the one primary: `btn-primary btn-lg`, min-width 132px, SVG play/pause icons (no ▶ ⏸ glyphs). `[Replay]` is `btn-secondary` with an SVG icon.
  - Next to them is the status line (12px, muted): host "You control playback for everyone."; member "The host controls playback. Space or Replay plays it just for you."; member while the host saves "The host is saving the video…".
  - Pushed right: the **source label** and the **Save control**.
  - **Source label:** an amber dot and "Live mix" while the theater plays the stems, plain text "Final video" when it plays the MP4. The tooltip on "Live mix" reads "What everyone hears now. Save makes the video from this mix."
- **The 16:9/9:16 toggle goes** (no CSS ever existed for `.shorts-mode`), along with `selectedAspectRatio`.
- **`#export-progress-box` goes** (the second download row).
- **The header crumb's live dot** (`#crumb-premiere-live`) turns amber, not recording red.

### 2. Save (host) and Download (member)

The Save control is a split button with a fixed min-width of 208px, so a label change never shifts the row. It is `btn-secondary` (no green). The main part acts and the chevron opens a menu: `aria-haspopup="menu"`, `role="menu"`/`menuitem`, arrow keys, and Esc returns focus to the chevron.

**Host, main part label, driven by the 16:9 export state:**

| State | Label | Main click |
|---|---|---|
| none yet, or failed | "Save video" | starts the 16:9 render and opens the export modal (section 3) |
| rendering (any client started it, including the premiere's own render) | spinner + "Saving…" (`aria-busy`, static icon under reduced motion) | nothing (`aria-disabled`) |
| ready and current | SVG check + "Saved" | engine-local host: Show in folder; remote host: download |
| was ready, then the mix or a take changed | "Mix changed · Save again" (tooltip "Save makes a new video with the new mix.") | as "Save video" |

**Host menu.** Each row shows its own state inline and never uses a toast:
- "Video 16:9", the same as the main part. The row reads "saved · Show in folder" when ready, or just the format when not.
- "Video 9:16". If not ready, a click renders it on demand. The row reads "Making…" with a small indeterminate bar, and the Save label doesn't change. When ready, the row reads "saved · Show in folder" (engine-local) or "Download" (remote host).
- Then a group label, "For editing":
  - "Separate tracks (WAV)", the existing stems route.
  - "Editing project (.zip)", the existing project ZIP route.
  - On the engine's computer the file lands in the export folder, and the row then reads "Separate tracks · saved · Show in folder". Remote hosts get a browser download. While preparing, the row reads "Preparing…".

**Members** get a "Download video" split button:
- The main part downloads 16:9 when ready.
- With no video, the button is `aria-disabled`, with the tooltip "The host hasn't saved the video yet."
- The menu lists only "Video 16:9" and "Video 9:16". A format that isn't saved reads "Not saved yet" and is disabled.
- Members get no Separate tracks or Editing project, no Mix fine-tune and no Dialogue level control.

**Header Audio tooltip:** for remote members it reads "Microphone and headphones" (their export folder row is hidden). The tooltip closes when Audio settings opens.

### 3. The export modal (40), for the host's explicit Save only

Open the modal through `openDialog()`, which gets a new `canClose` option. While rendering, `canClose()` is false, so Esc and the backdrop do nothing. Focus moves in, and on close it returns to the Save control. The modal keeps its `hidden` attribute and `.is-open` class instead of `style.display`.

- **Rendering:**
  - Title "Saving your dub". Status: "Mixing your takes…" until the engine's status poll reports `step: "video"` (the audio is mixed and ffmpeg is encoding), then "Making the video…". A restart (`export_started` while the modal saves) goes back to "Mixing your takes…".
  - The step strip has two real steps, Mix audio and Make video ("Finish" goes), with the indeterminate bar `.modal-progress-fill.indeterminate`. The track is `role="progressbar"` with `aria-valuetext` set to the step name, and no `aria-valuenow`.
  - The reel spins (and is static under reduced motion).
  - "Keep this window open until it's done." shows only on this client, and only on the engine's computer (closing DubMate there stops the render; a remote host's window doesn't).
- **After the 3-minute poll window:** the badge, strip and bar are hidden, the line reads "Still saving. Long scenes take a few minutes. Save reads Saved when it's done.", and the only action is "Keep working" (primary), which closes the modal. Polling continues as today.
- **Failed:**
  - A red badge "FAILED", a static alert icon (the reel is hidden), the title "The export didn't finish", and the friendly reason (`friendlyError`).
  - Actions: "Try again" (primary), which re-runs the same aspect, and "Close".
  - No Watch or Download.
- **Done** (only after `handleExportSuccess`):
  - Badges, step strip and bar are hidden; a static check replaces the reel.
  - The title is "Your dub is ready". The subtitle carries the facts: "16:9 · 0:06 · in DubMate Exports", with the folder's last segment middle-shortened and the full path in `title`. Remote hosts see "16:9 · 0:06".
  - Actions:
    - "Watch the dub", full width, primary. It closes the modal and plays from 0 for everyone through `screening_control`.
    - Then a pair: on the engine-local host, "Show in folder" and "Make 9:16 version" (which re-enters the rendering state for 9:16); on a remote host, "Download 16:9" and "Download 9:16" (the latter renders first, visibly).
  - The text "Close" goes; X and Esc are enough.
- **Nobody else gets the modal.** `export_started` from someone else, or from the premiere's background render, only updates Save ("Saving…") and the members' status line.

### 4. Mix (40a), a `<details>`, closed by default

The summary reads "Mix · Balanced" for the host, and "Mix · Balanced · set by the host" for members.

- **Host, inside:**
  - Three presets as a segmented group (`.tab-pill-group`, `role="radiogroup"`):
    - Balanced: balance 50, dialogue 0 dB.
    - Voices forward: 65, +2.5 dB.
    - Music forward: 35, 0 dB.
  - A value that matches no preset shows "Custom" in the summary, with no preset checked.
  - A "Fine-tune" disclosure reveals the existing two sliders: Music↔Voices with "Even / More music / More voice", and Dialogue level with its dB readout. dB appears only in Fine-tune.
  - A preset sends `set_mix_balance` and `set_dialogue_presence` together.
- **Member, inside:** one read-only line, "The host sets the mix. You hear what the video will sound like.", with the preset name. No inputs. Their live preview follows the room's values from `mix_balance_sync` and `dialogue_presence_sync`, as now.

### 5. In this dub (40c), a `<details>`, open for the host, closed for members

- The summary reads "In this dub · 5 lines", plus "· 2 use the original voice" when any line has no take.
- Rows are compact (about 36px) in a list with `max-height: 240px`. It scrolls with the app's themed scrollbar: the global `::-webkit-scrollbar` rules. Don't set `scrollbar-width` or `scrollbar-color` on it, because in Chromium that brings back the grey bar (see `317da5b`).
- Each row has the tick-colour dot, `#n`, the character, the speaker (actor name or "Unassigned"), and either "Take 3" or a dimmed "Original voice · Unrecorded" (dim, but at `--foreground-muted`, never `--foreground-dim`).
- A row click seeks to the line's start, using the same path as the timeline.
- "Change take" (`btn-ghost btn-xs`; "Record" on a line with no takes yet) appears only where `canRecordLine(line)` is true. It runs `showView('booth')` and `loadBoothLine(index)`, broadcasts the location, and focuses `#card-takes`.

### 6. An honest premiere mix (40b) and the follow-ups

**`launch_premiere`:**
- Sets the status and locations, broadcasts `warp_to_screening` at once, then starts the 16:9 render as a background task through the shared render job (below).
- Everyone arrives on the live Web Audio mix.
- `export_started`, `export_ready` and `export_failed` go out as for `POST /export`.
- A failure reaches every client. The host's Save returns to "Save video", with a line under the controls: "The video didn't save: {reason}" plus "Try again" (`btn-ghost btn-sm`). Members see the reason in the status line.

**Swap at the next pause.** When `export_ready` arrives while the live mix is playing, the client sets `pendingExportSwap`. It swaps to the MP4 on the next pause or end, never mid-play. A paused swap keeps the current position.

**Any change that drops a finished video is broadcast.**
- `Room.invalidate_exports()` broadcasts `export_invalidated {}` when a finished video existed, or a render was running.
- The broadcast is scheduled on the running loop, because the method stays sync.
- Every client calls `dropStaleExport()`. That hides "Final video", switches to the live mix, and sets Save to "Mix changed · Save again" when a video had been saved.

**The shared render job** (`rooms_api.start_export_render(room, aspect_ratio)`) replaces the three copies: `POST /export`'s thread, `launch_premiere`'s inline render and the download's render.
- It is one `asyncio` task per aspect, kept in `room.export_tasks`, so it outlives the socket that started it. It waits for a running Refresh older takes first, then renders with `asyncio.to_thread(export_dub_video, …)` using the room's current presence and balance.
- **Generation and restart:** `Room.export_generation` goes up in `invalidate_exports()`. The task notes the generation before mixing. If the generation changed by the time the render finishes, the result is thrown away, `export_started {aspect_ratio, restarted: true}` goes out, and the task renders again with the current mix. Only a render whose generation still matches is marked ready and broadcast. A stale video is never offered.

**`GET /export/download` never renders, for anyone.** With no finished file it answers 409 "The host hasn't saved this video yet." (and 409 "Export still rendering" while processing, as now). Renders start only through host-only `POST /export` and `launch_premiere`. The remote host's on-demand formats go `POST /export`, then wait for ready, then download.

**Echoes are ignored.** `set_mix_balance` and `set_dialogue_presence` carry the tab's `client_id` (`renderClientId()`), and the engine echoes it. The `mix_balance_sync` and `dialogue_presence_sync` handlers return early when it is this tab's, so a host's second window still follows. On a member, a sync updates the read-only summary.

**The same value changes nothing.** `set_mix_balance` and `set_dialogue_presence` invalidate only when the value changes, and a click on the checked preset sends nothing, so it never drops a saved video.

**Off the premiere the theater is left alone.** `dropStaleExport` and `offerExportedVideo` only clear the flags when the premiere isn't the view (a take changed in the booth); `setupScreeningView` sets the theater on the way back. Setting a source stops every playing sound, the booth's included.

**New: `POST /api/rooms/{room_id}/export/reveal`** (Show in folder; step 36's endpoint doesn't exist yet).
- Body: `{kind: "video", aspect_ratio}`, `{kind: "stems"}` or `{kind: "project"}`.
- `common.require_own_computer` plus `_require_host`.
- 404 when the file isn't there.
- Opens the file manager on the file: `explorer /select,<path>` on Windows, `open -R` on macOS, `xdg-open <dir>` on Linux. It never takes a path from the client.

**Room state** adds `exports: {"16:9": "idle"|"processing"|"ready"|"failed", "9:16": …}`, so a reload or late joiner shows "Saving…" or "Saved" correctly.

## Implementation groups (build order)

1. **G1 Engine.** Covers `dubmate/rooms_api.py`, `dubmate/rooms.py`, `dubmate/room_ws.py`, and tests.
   - The shared render job with generation and restart.
   - `launch_premiere` warps first, then renders in the background with failures broadcast.
   - The `export_invalidated` broadcast, and `exports` in the room state.
   - Download never renders.
   - The reveal endpoint.
2. **G2 Premiere screen and Save.** Covers `static/index.html` (`#view-screening`, the crumb dot, the Audio tooltip), `static/css/style.css` (section 4), `static/js/studio/screening.js`, `static/js/studio/export.js` (the Save state machine, menu actions and downloads), and `static/js/app.js` (element refs, socket handlers, echo filter, swap at pause, member read-only mix).
3. **G3 Export modal.** Covers `#modal-export-rendering` in `static/index.html`, the modal functions in `export.js`, `openDialog({ canClose })` in `static/js/ui_common.js`, and its CSS: the rendering, timeout, failed and done states, plus focus and Esc.
4. **G4 Timeline and In this dub.** Covers `screening.js`, `index.html`, `style.css`, `static/js/shortcuts.js` and the premiere keys in `app.js`.

## Tests

**Python:**
- `test_premiere_mix.py`: the launch warps before the render finishes; a launch render failure broadcasts `export_failed`; download renders nothing (update `test_download_and_stems_use_it` to `POST /export`, then poll).
- New `test_export_render_job.py`: a mix change mid-render restarts and broadcasts `restarted`; the stale file is never marked ready; one task per aspect; `export_invalidated` only when something was dropped.
- `test_host_guards.py`: a member's download with nothing ready gets 409 and `export_dub_video` is not called; reveal is 403 for a LAN caller and for a member, 404 when missing, and calls the opener (mocked) with the room's own path.
- Update `test_render_cache.py` (the 503 path now goes through `POST /export`'s failure), `test_systematic.py` and `test_cleanup_refresh.py` (download now answers the refresh 409 or "not saved" 409).

**JS (jsdom):**
- `test_export_downloads.js`: drop the removed anchors and keep the no-navigation and toast guarantees for the menu actions.
- New `test_premiere_screen.js`: Save labels per state; a member sees Download and no sliders; the echo is ignored; swap at pause; `export_invalidated` gives "Mix changed · Save again"; the modal's failed and done states, the Esc guard while rendering and focus return; a guest gets no modal on `export_started`.
- `test_shortcut_sheet.js`: the new premiere keys really seek.
- `test_css_floors.js` and `test_design_tokens.js` stay green.

## Risks

- **Tests built on the old ids** (`btn-export-video`, `btn-download-link*`, `btn-toolbar-*`, `export-progress-box`, `btn-aspect-*`, `btn-back-booth`). Keep IDs where the element survives; `btn-export-video` stays as the Save main part.
- **Restart storms:** at most one pending restart per aspect, and it runs only after the current render ends. A long drag costs one extra render, not one per step.
- **The background task and room teardown:** cancel `room.export_tasks` when a room is removed (`rooms._forget_room`, `sessions_api`). Mark the status failed on exception, and pop `processing` on cancel, as the launch path does today.
- **The parallel booth and lobby effort** touches `index.html`, `style.css` and `app.js` too. Stay inside `#view-screening`, the export modal, CSS section 4, the crumb dot and the socket export/mix handlers, and keep the diff out of booth and lobby blocks.
- **The live mix and the export still differ by the master stage** (loudness and limiter), as PR #19 noted. That isn't changed here.

## Decided without the owner

1. **Members see the host's mix, read-only and labelled** ("Mix · Balanced · set by the host"), with no personal preview control. Their preview already plays the room's mix, so what they hear is what the video will be. This is simpler than a second, labelled local control, and it can't drift from the export.
2. **A render running when the mix or a take changes restarts when its pass ends** (the generation counter). It is never offered as ready. A labelled stale video would add a state everyone has to read.
3. **`GET /export/download` never renders.** This replaces a host check on a GET with side effects: members can't start renders, and every render shows its progress.
4. **Preset values:**
   - Balanced: 50 / 0 dB.
   - Voices forward: 65 / +2.5 dB (the old "Cinematic" level).
   - Music forward: 35 / 0 dB.
   - Anything else reads "Custom".
5. **The 16:9/9:16 toggle is removed.** "Save video" saves 16:9, the scene's shape, and 9:16 lives in the Save menu.
6. **The title card and "‹ Booth" go;** the breadcrumb is the way back. The Host badge is replaced by the status line.
7. **The step strip has two real steps** with an indeterminate bar, driven by the engine: `GET /export/status` reports `step` "mix" (the takes and `render_dub_mix`) or "video" (the ffmpeg encode, after `export_dub_video`'s `on_audio_mixed`). "Finish" is dropped because nothing reports it.
8. **Show in folder uses a new local-only, host-only reveal endpoint** for the videos, separate tracks and editing project, because step 36's endpoint hasn't been built.
9. **40c's "Start premiere says how many lines use original voices" is deferred.** The button lives in the booth, which this PR mustn't touch. In this dub's summary carries the count instead.
10. **A swap to the MP4 at a pause keeps the paused position.** It doesn't rewind.
11. **A saved video's main click:** Show in folder for the engine-local host, Download for a remote host.
12. **"Change take" follows `canRecordLine`,** so it never offers a pick the server would refuse.
13. **Save is 252px wide,** above the 208px minimum, because "Mix changed · Save again" needs it. A narrower button grew with that label and moved the row.
14. **Downloads started from the Save menu don't toast when they start.** The row reads "Preparing…" instead. A browser download still toasts when it finishes, and a failure still toasts its reason.
15. **When the mix changes while the saved video plays, playback carries on** with the live mix, from the same spot.
16. **The failed modal hides the step strip and the bar too,** not only the reel. A stopped bar would read as progress.
17. **A failed or refused Save marks that format failed,** so Save shows "The video didn't save: {reason}" with Try again after the modal closes. The modal's reason drops a trailing "Try again." because a Try again button sits under it.
18. **The timeout state has no close X** ("Keep working" is the only action); Esc still closes it. A video that lands after "Keep working" doesn't reopen the modal; Save reads "Saved", which the timeout line says.
19. **A remote host's "Download 9:16" for a format that isn't saved** makes it in the modal and downloads it as soon as it is ready.
20. **While saving, focus sits on the modal's title** (there is nothing to press), every time it enters saving, including from Try again and Make 9:16 version (the pressed button is hidden). Done moves it to "Watch the dub", failed to "Try again", timeout to "Keep working".
21. **Under reduced motion the indeterminate bars stand still at full width** (the modal's and the Save menu's "Making…"), so a parked bar never reads as a percentage.
22. **A click on (or within 5px of) a timeline tick seeks to that line's start exactly,** not to the pixel under the pointer.
23. **`,` just after a line's start (within 0.25 s) goes to the line before,** so pressing it while playing walks back instead of sticking on the current line. `.` after the last line does nothing.
24. **The elapsed and total times both round to the second,** so the end reads "0:06 of 0:06".
25. **A paused host's seek moves their own thumb at once** (the room's echo sets the same spot). While playing, the host's video moves when the echo arrives, so playback and the live mix restart together for everyone.
26. **"Change take" focuses the take in the dub inside TAKES** (the card itself is not focusable, and the booth markup stays as it is). A line with no takes yet opens in the booth without moving focus.
27. **A row's "Take 3" uses the take's own number,** the one the TAKES card shows. "of 5" went: after a deletion it could read "Take 5 of 3".
28. **The Mix and In this dub sit side by side from 1200px wide,** stacked below that. Rows keep a fixed status column, and a Change take column only when some row has one, so the statuses line up.
29. **Space on a focused control is the control's** (a summary opens, a preset is picked, a row seeks, Save saves). Only the video, the timeline and the page play for everyone.
30. **A member's Live mix tip reads "What everyone hears now."** Members have no Save.
31. **"Mix changed · Save again" stays after a take change** (the plan's label). It reads slightly wide there; renaming it is left to the owner.
32. **In this dub keeps the focus across a rebuild** (someone records), on the same row's button, and follows joins and status updates for names and colours.

## Hands-on checks (the owner, with a friend on a tunnel)

1. Start the premiere. Everyone lands at once on the live mix, and Save shows "Saving…". Press Play before the video is ready: it keeps playing, and the source label changes to "Final video" only after you pause.
2. Move the Mix (preset, then Fine-tune) while a friend watches. Their summary follows, and "Final video" becomes "Live mix" for both of you. Save reads "Mix changed · Save again". Drag the slider quickly: it never jumps back.
3. As the friend, there are no sliders, no Separate tracks and no Editing project. "Download video" is disabled until you save, then it downloads. The friend gets no modal while you save, only "The host is saving the video…".
4. Change the mix while a Save is running. The modal keeps going and the video it ends with sounds like the new mix.
5. Save video → the modal. Esc does nothing while saving. When done, "Watch the dub" plays for everyone, and "Show in folder" opens Explorer on the file. Make 9:16 from the menu: the row shows "Making…", then "saved · Show in folder".
6. Pull the ffmpeg tool (or rename it) and save. You get "The export didn't finish", the reason and Try again, with no Watch or Download.
7. At 1280x720 and 960x680 the video is large and Play, the timeline and Save are visible without scrolling. Click a tick and a line in In this dub: playback jumps for everyone. Use `←`/`→` and `,`/`.`. "Change take" opens that line in the booth with the takes focused.
