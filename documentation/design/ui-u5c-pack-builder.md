# Design: UI pass U5c, Pack Builder polish

Phase U5 of the UI plan (`design/ui-plan.md`), steps **40e** (Pack Builder knows what is installed), **40f** (processing failures and progress), **40g** (never lose editor work), **40h** (the Lines column) and **40i** (Pack ready), including every "(added from full critique)" item. Branch `ui/u5c-pack-builder` from `origin/main` at `012c142` (PR #23, the editor fixes in `pack-builder-editor-fixes.md`, is in).

## Goal

Today Pack Builder promises things the machine can't do, loses work easily, and dead-ends when processing fails:

- The header pill says "Fast processing" with a green dot on load (the video encoder probe), then "Standard processing" after the upload (the torch probe), on the same machine (before-shots `step1-chosen` vs `process-running`).
- The hero says DubMate "separates the voices" and "writes out each line" whether or not those tools are installed. Paste link fails only after you paste.
- **P0:** when processing fails, the screen shows the message three times (headline sub-line, bar caption in mono, toast) and offers no way forward (`process-failed`). The radar keeps pulsing, "Read the audio" was ticked from the start, and the headline said "Uploading" while voices were being separated (`process-running`).
- A reload, an accidental browser Back, Exit, or Backspace outside a text box loses the editor's work. Cast edits use `prompt()` and `confirm()`.
- Each line card is 144px tall, so 2 lines fit in the Lines column at 1440x900 and 1 at 1280x720 (`before-results.json`). Four amber/purple buttons compete in the deck, and two character colours mean "recording" and "confirmed take".
- Pack ready offers Download .zip as the primary, plus Try it and Go to Studio, and a duplicate "is ready" toast.

After U5c, Pack Builder only offers what is installed and says plainly what isn't. A failed run always has a next step. Work survives reloads, Back and slips of the finger. The Lines column shows 10 or more lines at 1440x900. Pack ready leads to recording.

## Owner decisions this implements

- **From PR #23, binding here.** Tracks exist for overlapping lines (group gasps, talking over each other) and are automatic. A line's character decides who voices it. Keep the vertical timeline scroll, the scrollable Cast row, the voice track waiting for the video, and PR #23's measured speed: no whole-list or whole-timeline re-render on selection, drag or typing.
- **Section 6.5:** `style.css` is the source of truth. Refine `builder.css`, don't redesign it. U1 floors apply: no text under 11px, 12px for sentences, the brass focus ring, one amber primary per view, green only for done, red only for errors and irreversible actions.
- **Cast chips scroll in one row** (owner request, `pack-builder-editor-fixes.md`; replaces 40h's "Cast chips wrap").
- **Out of scope:** editing an existing pack (owner: later), a "duplicate line for another character" feature, the studio, U5b's background Pack Builder install (`#packbuilder-install-chip`), and steps 41 (screenshot script) and 42 (beyond this PR's own CHANGELOG entry).

## Layout and behaviour

### 1. What is installed (40e)

**Engine: `GET /api/builder/capabilities`** (new, in `builder_api.py`). It is read once when the page loads.

```json
{ "separation": true, "transcription": false, "link_import": true,
  "speakers": true, "romaji": true, "gpu": null }
```

- Tools are found with `importlib.util.find_spec`, so nothing heavy is imported:
  - `separation`: torch and demucs;
  - `transcription`: whisper;
  - `link_import`: yt_dlp;
  - `speakers`: sherpa_onnx;
  - `romaji`: pykakasi.
- **`gpu`** is `pack_builder.detect_torch_and_cuda()`, worked out once in a background thread on the first call and cached for the process. It is `null` until known, and `false` without torch. The client asks again every 1 s while it is `null`, for up to 20 s. Upload and link import keep returning `device_info`, but the pill no longer reads it. `/api/system/encoder` (the video encoder) is no longer used by Pack Builder.

**The pill (`#device-pill`).** It has one signal: can the AI steps use the graphics card.

| State | Pill |
|---|---|
| `gpu` true | Brass dot, "Fast processing". Tip: "Your graphics card speeds up separating voices and writing out lines." |
| `gpu` false | Neutral dot (`--foreground-muted`, no glow), "Standard processing". Tip: "No supported graphics card, so separating voices and writing out lines use the processor and take longer." |
| `gpu` null, or neither separation nor transcription installed | Hidden |

The label is in the body font. The green dot and the inline `borderColor` writes go.

**Step 1 follows the capabilities.**

- **Hero sub-line** (Never fake it). It names only what will happen:
  - Both installed: today's line.
  - Separation only: "Add a clip and a subtitle file. DubMate separates the voices from the background."
  - Neither: "Add a clip and a subtitle file. DubMate turns them into a scene you can dub."
- **Paste link without `link_import`.** The URL field and Import button are replaced by one line: "Importing from a link needs the Pack Builder tools." Under it, the install step:
  - Desktop app: "Run the DubMate installer again and tick Pack Builder." This is the studio's existing copy (`app.js`). Detect the desktop app the way `audio_setup.js` `desktopInvoke()` does.
  - Source install: "Show details" reveals `pip install -r requirements_builder.txt`, run in the DubMate folder.
  - The tab stays selectable, so people learn why.
- **Without transcription:**
  - The Subtitles label reads "Subtitles (needed for lines)".
  - A 12px muted hint under it: "Automatic transcription isn't installed. Add a subtitle file, or write the lines yourself after processing."
  - With no subtitle file chosen, the button reads **"Process video without lines"**, and the request sends `transcribe: false`.
- **Editor:**
  - Without transcription, the deck's Transcribe button gets `aria-disabled="true"` with the tip "Automatic transcription isn't installed." The row's Transcribe action is not rendered.
  - Romaji shows only when `romaji` is installed and the line is Japanese: the spoken language is `ja` or `ja_romaji`, or the text contains kana or kanji.

### 2. Processing: progress, failures, cancel (40f)

**Files chosen in Step 1 become chips.** A chip has the file name, a summary and a × button (`aria-label="Remove subtitles"` / `"Remove cover image"`). The dropzone hides while a chip shows. Buttons never sit inside the `role=button` dropzone.

- **A dropped SRT/VTT is checked at once** through a new stateless `POST /api/builder/subtitles/check`. It uses the same `parse_srt`/`parse_vtt` and returns `{count, characters}`.
  - The chip reads "12 lines · 3 speakers found". It counts characters other than the parser's default "Actor"; with none it reads "12 lines".
  - A file with no timed lines is not kept. The field shows the error inline: "No timed lines in this file. Use an SRT or VTT file."
- **Subtitles that came with a link import** show as a chip too: "From the video · 48 lines", with ×.

**Engine changes:**

- **Where subtitles live.** `import_subtitles` stores the lines in `session["subtitle_segments"]`. A new `DELETE /api/builder/{id}/subtitles` clears them. The pipeline reads only `session["subtitle_segments"]`, never `progress.segments`, so a retry can't mistake the last run's output for subtitles.
- **`/process` accepts `transcribe: false`.** The pipeline then skips transcription and speaker detection, and finishes `transcribed` with `[]`. It no longer invents "Dialogue line 1".
- **Retry reuses finished stages.** The audio and the separated tracks of this session are kept when their files exist. "Try again" never re-uploads and never re-separates.
- **Cancel.** A new `POST /api/builder/{id}/cancel` sets a flag. The pipeline checks it at each stage boundary, raises a private `BuildCancelled`, and ends with status `cancelled`. Demucs and Whisper can't be interrupted mid-stage. Speaker detection's child process is stopped.
  - Each session has a run lock. A new `/process` waits for the previous run to exit, with the status `queued` and the message "Finishing the last run".
- **Stages in the status.**
  - On `error`, `stage` keeps the failed stage (it already does; tests pin it).
  - `to_dict` gains `skipped`, a list of stage keys the run skipped:
    - `transcription` with subtitles or `transcribe: false`;
    - `speakers` with named subtitles or no lines.
- **Session expiry.** Sessions expire 2 h after their **last activity** (`touched_at`, set by every session route), not after creation. A running pipeline is never pruned.

**The processing screen has one source.** `renderProcessState(state)` updates everything from one state object (`status`, `stage`, `progress`, `message`, `skipped`, `error_code`):

- **Stage rows** start pending: a number in a neutral circle, at 60% opacity.
  - **Upload** is first, only for a file that isn't uploaded yet. Upload uses `XMLHttpRequest` with `upload.onprogress`, and the bar shows "Uploading · 42 of 120 MB".
  - After Upload come the existing four.
  - The active row has the amber border. A finished row gets the brass tick. A skipped row reads "Skipped" (muted). A failed row gets a red border, an alert icon and the message.
- **Headline:** the active stage as a sentence ("Separating the voices"). The sub-line stays "Keep this page open until it finishes."
- **Bar caption:** the engine's `message` in the body font at 12px. Only the percentage is mono.
- **Cancel** (secondary, under the stages, while uploading or processing):
  - During upload it aborts the XHR.
  - During processing it POSTs `/cancel`.
  - Both return to Video at once, with the file, the chips and the options kept.

**The error state** replaces the P0 dead end:

- The radar stops (`.is-stopped`). The centre icon becomes a static alert icon in `--accent-red-bright`.
- The headline names the failed stage: "Couldn't read the audio", "Couldn't separate the voices", "Couldn't write out the lines", "Couldn't detect who speaks", "The upload didn't finish", "Couldn't read the subtitles".
- The message shows once, in the failed row. There is no toast and no repeat in the bar caption. The container has `role=alert`, and focus moves to the primary action.
- Actions:

| Failure | Primary | Secondary |
|---|---|---|
| Transcription not installed (`pipeline_missing` at `transcription`) | "Write the lines myself" | "Back to video" |
| Transcription failed otherwise | "Try again" | "Write the lines myself", "Back to video" |
| Any other stage or upload | "Try again" | "Back to video" |

- **Try again** re-POSTs `/process` for the same session (for an upload failure, it retries the upload).
- **Back to video** keeps the file and the options.
- **Write the lines myself** opens the editor with no lines. The voice track is used if separation finished.
- **A subtitle import failure** (rare after the drop check) stops with the "Couldn't read the subtitles" state. It never falls through to transcription.

**The editor with no lines.** The Lines column shows "No lines yet" and the hint "Play the video and press N, or Add line, where someone speaks." (12px). Continue is `aria-disabled` with the tip "Add a line first".

### 3. The Lines column (40h)

**Header:** one row with "Lines", the count ("17 lines", mono badge) inline, and Continue on the right. That saves about 20px. Cast row below, unchanged from PR #23.

**Rows replace the 144px cards.** A row is about 40px, with 1px dividers instead of separate cards.

```
● 12  [Detective Mori ▾]  We go in at dawn, not a minute…    0:12.40   (hover: ▶)
```

- Grid: dot (8px), number (mono 11px), character select (140px, 30px tall), text (flex), actions, timecode (mono 11px).
- **Unselected rows:**
  - The text is a one-line `textarea` (`rows=1`), clipped with a right-edge fade.
  - A line with no words shows the "No words" badge in place of empty text.
  - Hovering shows only a Play icon button.
- **Selected row:**
  - Amber border and wash, as `.builder-cue-card.selected` today.
  - The text grows to its full height, up to 4 lines, then scrolls.
  - The timecode reads "0:12.40 – 0:14.90".
  - Icon actions show: Play, Transcribe (only when installed), Romaji (only when it applies), and Delete (red on hover).
  - Each icon has an `aria-label` and a `data-tip`.
  - No "⋯" menu.
- **Target:** 10 or more lines visible at 1440x900 with one selected. 6 or more at 1280x720.

**Keyboard and semantics:**

- The container is `role="list"` with `aria-label="Lines"`. Rows are `role="listitem"` with a roving `tabindex`: the selected row is 0, the others -1.
- The selected row has `aria-current="true"`, and each row has the label "Line 4, Detective Mori, 0:12.40".
- Up and Down on a row select the previous or next line, move focus and seek to its start, as a click does.
- Enter on a row focuses its text. Esc in the text returns to the row.
- Focusing a row's text or select selects that line without seeking.
- Rows show the shared brass `:focus-visible` ring.

**Speed (keep PR #23's numbers):**

- One delegated set of listeners on `#segments-list-container` (click, input, change, focusin, keydown) replaces the per-card listeners.
- Each row's character `<select>` holds only its current option, and is filled on `focus`/`pointerdown`. Adding or renaming a character then never rebuilds the list.
- Changing a line's character updates that row's dot, its timeline block colour and the Cast chips, with no full list or timeline render.
- Selection stays a class toggle plus growing one textarea.

**Deck and colours:**

- The deck has one amber primary per view, and in the editor that is Continue. Play becomes `btn-secondary`. Add line and Transcribe become `btn-secondary`; the gradient `.btn-cue-add-highlight` and purple `.btn-whisper-ai-deck` styles go.
- **Start/End with nothing selected:**
  - The buttons are `aria-disabled` with the tip "Select a line first".
  - I/O and [/] show the toast "Select a line first" and no longer add a line.
- **The character palette** drops `#dc2626` and `#16a34a`. The new 8-colour order keeps neighbours distinct: `#d97706` amber, `#06b6d4` cyan, `#ec4899` magenta, `#cca458` brass, `#7c5cff` violet, `#60a5fa` sky, `#b45309` terracotta, `#a3a3f5` periwinkle. Colours are per session and not saved, so nothing migrates.
- **Timeline blocks** show only the text, in an 11px sans. Their `data-tip` and `aria-label` read "Detective Mori: We go in…".
  - `.ruler-tick`, `.segment-block-label` and `.segment-inline-delete-btn` reach 11px.
  - Their `EXEMPT` entries leave `tests/test_css_floors.js`.

### 4. Never lose editor work (40g)

**The session lives in the URL.**

- `setStep` pushes `history.pushState({step}, '', '?session=<id>&step=<step>')`. `popstate` calls `setStep(state.step, {fromHistory: true})`, so browser Back moves between Pack Builder steps.
- **On load with `?session=`:** GET `/status`, then by status:

| Status | Opens |
|---|---|
| `transcribed` / `done` | GET `/segments`, then the editor, or Build when `step=compile` |
| `processing` / `queued` | The processing screen, following the SSE |
| `error` | The error state |
| `cancelled` | Video, with the session kept |
| 404 | Step 1, with the inline notice "That session has ended. Add the video again." and the URL cleaned |

- The pack name and spoken language are kept in `sessionStorage` per session.
- Characters without lines aren't kept across a reload.

**The stepper becomes buttons.**

- Reached steps (Video, Edit lines, Build) are `<button>`s. Process is not a destination.
- The active step has `aria-current="step"`. Unreached steps are plain text.
- **Back to Video from a processed session:**
  - The primary becomes "Back to Edit lines".
  - The secondary "Process again" asks inline, under the button: "Replace your 17 lines with a new pass?" with "Process again" and "Cancel".
  - "Change" on the video asks the same way.

**Saving:**

- `syncSegmentsToServer` becomes a queue: one PUT in flight, the latest state coalesced, so an older PUT can never overwrite a newer one.
- A failed save shows in `#editor-notice`: "Couldn't save your changes. Trying again…". It retries with backoff and clears on success.

**Leaving:**

- A `beforeunload` guard runs while on Edit lines or Build until the current state is built, and always while a save is pending or failed.
- **Exit** (header link) opens a small dialog through `openDialog` in that same state: "Leave Pack Builder? Your lines aren't in a pack yet." The buttons are "Stay" (default focus) and "Leave". There is no `confirm()`.

**Undo:**

- An undo stack of up to 50 snapshots (segments, character colours, selected index). It is pushed before each committed change:
  - add line, delete line;
  - a drag or trim (on drop, only if it moved);
  - Start/End;
  - character change;
  - add, rename or delete a character;
  - a Transcribe or Romaji result;
  - a text commit (`change`, compared against the text at `focusin`).
- **Ctrl/Cmd+Z** outside text fields undoes, re-renders, and saves. Inside a text field, the field's own undo works as usual.
- **Delete** shows "Line 4 deleted" with an **Undo** button for 6 s. `showToast` gains `{ action: { label, onClick }, duration }` in `ui_common.js`. The toast pauses while hovered or focused, and the button is a real `<button>`.
- Delete and Backspace keep deleting the selected line, because undo now exists.
- The `?` sheet gains "Undo" (Ctrl+Z), "Move to the line above or below" (↑ ↓ in the lines), and the label "Remove the selected line (you can undo)".

**Cast editing without `prompt()`/`confirm()`:**

- Clicking a chip's name turns it into an input in place. Enter or blur commits, and Esc cancels.
  - Renaming to an existing name merges the two, with the toast "Merged into Mika" and Undo.
- **+** appends a chip already in edit mode, with the placeholder "Name". An empty commit removes it.
- **×** deletes at once. The lines move to the first remaining character, with the toast "Mika deleted. 3 lines moved to Narrator" and Undo.
- The row select's "+ New character…" swaps that select for an inline input in the row. Enter creates the character and assigns it. Esc restores the select.

**After a build,** the state is remembered: a signature of segments plus details.

- Any later change, to the lines or to the Pack details fields, swaps the success box for: "You changed the pack after building it."
  - The primary is **"Build again"**, which overwrites the same pack, as the engine already does for the same name.
  - The secondary is "Record it now".

### 5. Pack ready (40i)

- **Title and line:** "Pack ready" (green: done) and "It's in your scene list."
- **Primary: "Record it now"** (renamed from Try it; `launchPlaytestSession` unchanged). It is `btn-primary btn-md` and takes focus on success.
- **"Save a copy (.zip)":** a quiet text link under it (`btn-link`, 12px).
- **Removed:** "Go to Studio" and the "'X' is ready" toast.
- The Build pack button stays hidden while the success box shows.

## Implementation groups (build order)

**A. Engine and Step 1: what is installed** (40e, plus 40f's engine side and Step 1 chips).

- Files:
  - `dubmate/builder_api.py`: capabilities, `subtitles/check`, `DELETE subtitles`, `cancel`, the run lock, `transcribe:false`, stage reuse, `skipped`, `touched_at` pruning;
  - `pack_builder.py`: the `BuildProgress` fields `skipped` and `cancel_requested`, `BuildCancelled`;
  - `static/js/pack_builder.js`: `loadCapabilities`, the pill, Step 1 states, chips, editor Transcribe/Romaji gating;
  - `static/builder.html`;
  - `static/css/builder.css`.
- Tests in `tests/test_pack_builder.py`:
  - the capability flags follow a patched `find_spec`, and torch is never imported when missing;
  - `gpu` goes from null to a bool;
  - `subtitles/check` counts lines and speakers, and answers 400 for an empty file;
  - DELETE clears and the pipeline then transcribes;
  - `transcribe:false` finishes with `[]` and never calls `transcribe_audio`;
  - a retry after a transcription error doesn't call `extract_audio_from_video` or `separate_audio_stems` again;
  - cancel ends `cancelled` at the next boundary, and a second `/process` waits for the lock;
  - an error keeps its failed `stage`;
  - `skipped` is listed;
  - pruning uses `touched_at` and spares a running pipeline.
- New `tests/test_builder_step1.js` (JSDOM, fetch stubbed):
  - the pill for gpu true, false, null and no tools;
  - the hero copy variants;
  - Paste link without `link_import`, desktop and source;
  - the Subtitles label, hint and "Process video without lines";
  - SRT drop leads to the chip "2 lines · 2 speakers found", and × clears it;
  - a bad file shows the inline error and isn't kept;
  - the deck Transcribe is `aria-disabled` without transcription;
  - Romaji is hidden for a non-Japanese line.

**B. Processing screen** (40f client).

- Files: `pack_builder.js` (`renderProcessState`, the XHR upload, `listenToProgressSSE`/`pollProgressStatus` feeding it, cancel, the error actions, the empty editor state), `builder.html` (Upload row, actions, alert icon), `builder.css` (pending, done, skipped and failed rows, `.is-stopped`).
- New `tests/test_builder_process.js` (JSDOM, fake XHR and EventSource):
  - every stage is pending before the first event;
  - XHR progress drives the Upload row and the caption;
  - each SSE status gives a matching headline, active row and ticks only on finished stages;
  - an error gives one red row, the message once and no toast, the pulse stopped, focus on the primary, and the actions by `error_code` and stage;
  - Try again re-POSTs `/process` with no upload;
  - Back to video keeps the file name, chips and language;
  - Write the lines myself opens the editor with 0 lines and the empty state;
  - Cancel aborts the XHR during upload and POSTs `/cancel` during processing;
  - a failed subtitle import never reaches `/process`.

**C. The Lines column** (40h).

- Files: `pack_builder.js` (`renderSegmentsList` as rows with delegated events, lazy selects, `selectSegment`, keyboard, the in-place character change, `blockLabel`, `PALETTE`, Start/End gating), `builder.html` (header, deck button classes, list role), `builder.css` (rows, focus ring, the 11px timeline floors; the deck gradient and purple styles go), `tests/test_css_floors.js` (EXEMPT entries go).
- Tests in `tests/test_builder_editor.js`:
  - rows have `role`, `tabindex` and `aria-current`;
  - ArrowDown and ArrowUp move the selection and focus;
  - `focusin` on a textarea selects without seeking;
  - selecting keeps the same row nodes, and so does changing a character;
  - Start and End with no selection add no line;
  - the palette doesn't contain the two signal colours;
  - block labels have no `[` prefix;
  - the deck has exactly one `.btn-primary` (Continue).
- Dev measurement: rerun `dm_pw/pbfix_perf.js` and the screenshot script (below). Select, drag and editor open must stay within PR #23's medians plus 20%. At least 10 rows must be fully visible at 1440x900 with one selected.

**D. Never lose work, and Pack ready** (40g, 40i, CHANGELOG).

- Files:
  - `pack_builder.js`: URL session and restore, history, stepper buttons, the save queue, `beforeunload`, the Exit dialog, the undo stack, inline cast editing, the build signature, Pack ready;
  - `static/js/ui_common.js`: the toast action;
  - `static/js/shortcuts.js`;
  - `builder.html`, `builder.css`;
  - `static/css/style.css`: only `.toast-action`, next to `.toast-close`;
  - `CHANGELOG.md`.
- Tests:
  - new `tests/test_builder_session.js`:
    - booting with `?session=s1` and a `transcribed` status opens the editor with the server's lines;
    - a 404 shows the notice and cleans the URL;
    - `setStep` pushes history, and `popstate` returns to the previous step;
    - the stepper buttons and `aria-current`;
    - two quick edits make two PUTs in order, never overlapping, and the last body wins;
    - a failed PUT shows the notice and retries;
    - `beforeunload` is set while editing and cleared after a build;
    - Exit opens the dialog;
    - Delete, then the toast Undo, restores the line;
    - Ctrl+Z undoes a drag, a character change and a text commit;
    - cast add, rename, merge and delete work with `window.prompt`/`confirm` stubbed to throw;
    - after a build, an edit shows "Build again";
    - Pack ready has one primary, "Record it now", the zip link, and no "Go to Studio".
  - `tests/test_toasts.js`: the action toast.
  - `tests/test_shortcut_sheet.js`: the new items are pressed and checked.

Every group runs `python tests/run_all_tests.py`.

## Before-shots and dev scripts (not committed)

- `C:/Users/tanis/AppData/Local/Temp/dm_shots/ui-u5c-pack-builder/before-*`, at 1440x900, 1366x768 and 1280x720:
  - `step1`, `step1-link`, `step1-chosen`;
  - `process-running`, `process-failed`;
  - `editor`, `lines-column`;
  - `compile`, `pack-ready`.
  - Plus `before-results.json`: the pill text, row height (144px) and fully visible lines (2 / 2 / 1).
- Engine: `dm_pbfix/fixture_server.py <repo> dm_pbfix/media <port>`, with its own `DUBMATE_CACHE_DIR`.
- Shots: `dm_pw/u5c_before.js <port> <prefix>`. It mocks upload, process, SSE and compile through Playwright routes. Reuse it with prefix `after-*`.

## Risks

- **Parallel branches.**
  - U5b also edits `tests/test_css_floors.js` and `static/css/style.css`. Keep this PR's edits there to the EXEMPT removals and one `.toast-action` rule, and rebase after U5b lands.
  - U5b's install chip lives in the studio. Pack Builder's "install" copy doesn't link to it yet (follow-up).
- **Cancel isn't instant on the engine.** Demucs or Whisper finishes its current stage first, and on a CPU that can take minutes. The UI returns at once, and a new run shows "Finishing the last run" until the lock frees.
- **The GPU probe imports torch** in the engine on the first Pack Builder visit (about 1 to 3 s and a few hundred MB). Upload already did this, so the cost is not new, only earlier. It runs off the event loop, and the pill stays hidden meanwhile.
- **Stage reuse** trusts the session's files. The video can't change within a session (Change makes a new one), so the audio and separation stay valid.
- **Performance.** Row DOM, delegated events and lazy selects are new code on the hot path. Group C must re-measure with PR #23's script and fixture, and keep selection and drags free of list rebuilds.
- **History.** `pushState` on every step must not leave a trap: Back from Video at the start leaves Pack Builder. Restore must not push a duplicate entry.
- **Undo memory.** 50 snapshots of a few hundred lines is well under 1 MB.

## Decided without the owner

1. **Lines are a list, not a listbox.** Rows contain editable fields, which an `option` can't hold. So rows use `role=listitem`, a roving `tabindex` and `aria-current`. Up/Down, the focus ring and "a focused field selects its line" behave as 40h asks.
2. **Row actions are icon buttons:** Play on hover, all of them on the selected row. There is no "⋯" menu. The deck keeps a labelled Transcribe button, so the action stays findable.
3. **Undo is Ctrl/Cmd+Z only**, 50 steps, with no redo. Typing keeps the text field's own undo, and a committed text edit is one step. Delete and Backspace keep deleting lines, because undo now exists.
4. **Deleting a character needs no confirm.** Undo covers it. Renaming to an existing name merges the two.
5. **Restore covers reloads while DubMate runs.** An engine restart still ends sessions, because they live in memory. Sessions now expire 2 h after the last activity instead of 2 h after creation.
6. **"Write the lines myself"** is offered only when writing out the lines failed or isn't installed. "Try again" is hidden when the failure is a missing tool.
7. **Try again reuses the finished audio and separation**, with no re-upload. Cancel returns at once, and the engine stops at the next stage boundary.
8. **Subtitles from a link import** show as a removable chip, like a dropped file.
9. **Pill colours:** a brass dot for the graphics card and a neutral dot for the processor, never green. The pill stays hidden until known, or when no AI tools are installed.
10. **The hero sub-line has three variants** that follow what's installed.
11. **Install copy:** desktop, "Run the DubMate installer again and tick Pack Builder." (the studio's existing words); source installs see the pip command behind "Show details".
12. **Going back to Video on a processed session:** "Back to Edit lines" is the primary. "Process again" and Change ask inline before replacing lines.
13. **"Build again" overwrites the same pack.**
14. **Romaji shows** when Japanese is chosen or the text has Japanese script, and the tool is installed.
15. **Palette:** the replacement colours, and the new order listed in section 3.
16. **Processing copy:** messages use the body font; mono is only for percentages and file sizes. The error title names the failed stage.
17. **Characters without lines** aren't kept across a reload; only lines are stored.

## Hands-on checks for the owner

1. On a machine without the Pack Builder tools, or after Remove Pack Builder:
   - Step 1 says what's missing;
   - Paste link explains how to add it;
   - the button reads "Process video without lines";
   - processing ends in an empty editor you can fill.
2. With the tools: the pill says the same thing before and after uploading.
3. Drop an SRT: the chip counts lines and speakers. Drop a text file renamed .srt: you get a clear error. × removes either chip.
4. Process a clip, then press Cancel during "Separate the voices". You're back at Video with everything kept, and Process works again.
5. Force a failure (for example rename the whisper package folder).
   - The failed stage turns red;
   - the message shows once;
   - "Try again" doesn't re-upload, and "Write the lines myself" opens the editor.
6. In the editor:
   - reload the page: you land back in the editor with your edits;
   - browser Back goes to the previous step;
   - Exit asks first.
7. Delete a line with Backspace, then press Undo in the toast, then Ctrl+Z after a drag.
8. Rename, add, merge and delete characters: no browser pop-ups.
9. At 1440x900, count the lines you can see: 10 or more. Use Up/Down and Tab. Does the selected row show everything you need?
10. Does selecting, typing and dragging still feel as fast as after PR #23?
11. Build, then edit a line: "Build again" appears. "Record it now" opens a room with the pack.
