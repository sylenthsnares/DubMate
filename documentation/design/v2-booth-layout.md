# Design: 2.0 layout pass, a calmer booth

Branch `ui/v2-booth-layout` from `origin/main` at `012c142`. The owner asked for a layout pass, not a new look: "spacing, structure, centering, and the layout of pages, panels, and everything. For the studio booth most importantly... a streamlined and psychologically coherent studio booth that also doesn't look overwhelming. Run numbers on this."

The spec is the measured booth audit (`dubmate_ui/v2-layout/booth/booth-layout-audit.md`), its **Mock A**, and the second opinion (`dubmate_ui/v2-layout/critique.md`). Where they differ, the critique's corrections C1 to C9 and conflict resolutions X1 to X9 win. Mock B is dropped (critique section 4).

## Goal

Today the video picture gets 26.9% of a 1440x900 screen and 14.7% at 1280x720. Three stacked bars (148 px) sit above it. The actor's line ranks 14th by visual weight, while Next line ranks 2nd before a take exists. The same 34 controls stay live while you record. After this PR the booth reads in the order you use it: the picture and the line first, then record, judge the take, next. While you record, only Stop is live.

## Owner decisions this implements

Binding from earlier (`ui-plan.md` section 6, U2):
- **Layout A column order:** Record, then Takes, then Voice (with For), then Monitor, with Prev/Next pinned at the bottom.
- **The next line is usable while a take saves.** Only count-in and recording lock the booth.
- **The wheel turns a knob only when that knob has focus.**
- **`style.css` is the source of truth.** No colour or font changes. The one exception is the prompter line at 22 px.

Answered overnight for this PR (see "Decided overnight, revisit" below):
1. Retire the cast ribbon in the booth. One "who's here" avatar stack sits in the booth bar. It is built as a shared component, so the join/lobby PR can put the same stack in the lobby title row.
2. Keep the Voice card's "For: This take" scope, and move only the Level knob to All effects. On take rows, ▶ play replaces "Use". A row click uses the take, and the row shows a visible "Use this take" cue on hover and on focus.
3. While recording, everything except Stop, the picture, the line and the waveform is inert and dimmed. That includes the header's Lobby, Premiere and Leave.
4. The prompter line is 22 px in one centred row. Emphasis is earned: Next is amber only once the line has a take, and Start premiere is secondary until everyone is ready.
5. One spacing scale, added as `--space-*` tokens in `:root` (4/8/12/16/24), with one 12 px gutter. The booth uses only those values.
6. The noise switch lives in All effects, and the Voice card's summary line says whether it is on (X4). The Backing slider stays reachable on other people's lines (critique section 4). The OFFLINE and NO MIC states stay.

Out of scope: the lobby, landing and join flow (next PR), premiere and export, Audio settings, the launcher, and Pack Builder. Other PRs are running in those (u5a, u5b, u5c). The lobby keeps its cast ribbon until the join/lobby PR swaps in the stack.

## Layout and behaviour

### Frame (every booth state)

```
app header 50 (unchanged)
booth bar 44: Line 1 of 4 [1 ✓][2][3][4] [My lines]        (T)(M) [Mark ready] [Start premiere · 0/2 ready]
gap 12
main column 1fr                              | 16 | right column 340 (360 at 1550 and wider)
  video  flex:1, min 160                     |    |  RECORD deck (pinned)
  gap 12                                     |    |  scroll: TAKES, VOICE, Monitor (gap 12)
  prompter ~46: CAROL | "line" 22px | 1.5 s  |    |  footer: ‹ Prev | Next line ›
  gap 12                                     |    |
  waveform: legend · lanes · timing row      |    |
```

- **Spacing tokens** go in `:root`: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 24px`. They are numbered in order with no gaps (C9).
  - 8 inside a group: label to control, chip to chip, row to row.
  - 12 between groups: panel gaps and every card's inner gutter (deck, takes, voice, monitor, prompter, waveform).
  - 16 between the two columns and around the page.
  - 24 only between page-level regions. The booth has none.
  - Component insides (badge 2 px, `.btn` padding, chip padding) belong to the look and stay as they are.
  - `.legend-group` and `.record-track-tag` gaps go from 6 to 8.
- **Alignment lines:** in the right column, L1 (content) = card edge + 1 + 12, and every card header and body starts there. R1 (trailing items: badges, All effects, ⋯, %, switches) = right edge − 13. In the main column, card content also starts at L1. The prompter line is centred on the video picture's axis.
- **Booth bar** (`.stage-top-bar`) is the only booth-level bar.
  - The line strip's chips move into it, after "Line 1 of 4". They keep the `#timeline-chips` ID, are 28 px tall with a 4 px gap, and scroll sideways inside the bar when a scene has many lines.
  - With "My lines" on, the current line's chip always shows, even when the line isn't yours (C7).
  - `.timeline-chips-wrapper` and its 46 px card go. `#btn-back-lobby` ("‹ Lobby") goes too, because the header breadcrumb already has Lobby.
  - The line-length badge (`#booth-time-badge`) moves into the prompter.
- **Cast ribbon** (`#cast-activity-bar`): hidden while the booth is showing. The lobby and the premiere keep it until the next PR.
- **Who's here stack** (new `static/js/studio/presence.js`, shared):
  - One overlapping avatar per online person: their initial on their colour, 28 px. After 5 avatars, a "+N" disc.
  - The stack is one button. Its `aria-label` is "Who's here: Tani, Mika, 1 of 2 ready".
  - It opens a popover on hover, on focus and on click. Esc or leaving it closes it. It is not a modal.
  - The popover has one row per person: avatar, name ("(you)" for yourself), their roles, where they are ("Line 3", "Lobby", "Premiere"), progress ("1 of 2 lines recorded") and a "Ready" tag.
  - The popover is redrawn only when its content changes, so a focused popover survives socket updates.
  - The API is `renderPresenceStack(container, { users, roomState, selfId })`, which the lobby PR reuses as is.
- **Prompter** (`#stage-caption-card`) is one grid row, `minmax(0,1fr) auto minmax(0,1fr)`.
  - The character name (with "(locked)" on someone else's line) sits left and the length badge right, both vertically centred.
  - The line sits in the centre at 22 px, in the same face and colour.
  - A long caption wraps inside the centre column, which has a cap of about 70% of the card width. The text is never clipped.
  - The resize handle stays centred on the top edge.
  - DESIGN.md's `caption` size changes from 15 to 22 px.

### Right column

- **Record deck:** U2's states and badges are unchanged (READY, COUNT-IN, REC, SAVING, NO MIC, OFFLINE). The body padding becomes 12.
  - **Someone else's line:** no record bezel and no badge. The deck reads "Carol is voiced by Tani" over the transport.
  - **Mic-sync hint:** one unboxed line on L1 with "Audio settings" and ×, with no frame.
- **Takes rows** (`takes_card.js` `takeRow`):
  - Layout: `◉ Take 3 · 2.3 s · [avatar] · Loose sync · [slot] · ▶ · ⋯`.
  - **Duration:** stays in muted text (critique section 4: it is the quickest check for an overrun).
  - **Who recorded it:** the recorder's 20 px avatar from `presence.js`, with their name in its tooltip, replaces the cut-down "T…" name (X5). It shows only for other people's takes.
  - **The fixed slot:** it reads "In the dub" (green) on the picked row. On any other row of yours it shows "Use this take" in muted text, but only on hover or `:focus-visible`. The tooltip says "Use this take in the dub (Enter)".
  - **▶:** `.take-play`, "Play take 3" (`P` on a focused row), always in the same x position. It reads ■ while that take plays.
  - **The ⋯ menu:** only "Delete take", and only on your own takes. Rows on other people's lines show ▶ only.
  - **What stays:** row click and Enter use the take, the radiogroup and roving tabindex, and Undo on delete.
- **Voice card:** preset chips, then one row: "For [This take ▾]" on L1, and a muted summary on R1.
  - The summary reads "level matched", or "+2.0 dB" when the level was changed by hand, then " · noise cleanup on" (or "off").
  - The For select, the inline confirmation and the status line stay as in U2.
  - The Level row (`#slider-gain` knob, readout, ✓ Matched, Auto) moves to the top of the All effects page, as a "Level" module.
  - "Clean up noise" stays a module there.
  - Before the first take the summary reads "level matched when you record".
- **Monitor:** unboxed (no frame), two rows on L1. On someone else's line only the Backing row shows. Count-in and Hear original are hidden.
- **Footer:**
  - "Next line ›" or "Done ›" is `btn-secondary` while you are on your own line and it has no take. Otherwise it is `btn-primary`.
  - The label and tooltip rules don't change.
  - Prev is always secondary.

### Main column

- **Timing row:** −25 ms, Reset to auto, +25 ms, the slider and the readout.
  - The ±100 ms buttons go. Shift+`[`/`]` still nudges by 100 ms, and the slider tooltip says so.
  - With no take, the row and the waveform canvas are `inert` and dimmed, because there is nothing to nudge (C2).
  - On someone else's line the row is hidden.
  - While the line saves, U2's lock stays.
- **Start premiere** (host) is `btn-secondary` until every online person is ready, then `btn-primary`. Its label stays "Start premiere · 0/2 ready".

### Recording focus (count-in and recording)

- **State class:** `body.is-taking` is set from a single `setRecordState(state)` helper. Every `this.recordState = …` assignment goes through it, so no exit path can miss the cleanup.
- **What goes inert, at 35% opacity:**
  - the header's logo menu, breadcrumbs (Lobby, Booth, Premiere), room badge, Audio, `?` and Leave;
  - the booth bar;
  - the timing row, the expand-video button and the prompter's resize handle;
  - the transport, the mic-sync hint, the scrolling middle and the footer.
- **What stays live:**
  - the record button (Stop, or ✕ during the count-in);
  - the video and its REC tally;
  - the prompter text;
  - the waveform's live trace: the waveform is inert too, so it can't be dragged, but it isn't dimmed;
  - the connection banner, so a dropped socket still shows.
- **Dimming:** `prefers-reduced-motion` removes the opacity transition.
- **Keys:** Space stops or cancels as today. **Esc cancels the count-in.** Esc during recording does nothing, so a take is never thrown away by accident. `?` and `[` `]` wait until the take ends, like the other single-letter keys.
- **Exit paths that clear it:**
  - stop by Space or a click;
  - the timeout at the end of the line;
  - cancelling the count-in (Space, click or Esc);
  - a mic failure: refused before the count-in, or failing to open as the take starts;
  - loading another line;
  - leaving the booth or the room;
  - a recorder that yields nothing ("Nothing was recorded").
- **Saving** is not inert (owner decision 2).

### What shows in each state

| Region | Idle, no take | Idle, takes | Count-in / recording | Saving | Someone else's line | All effects |
|---|---|---|---|---|---|---|
| Header nav | live | live | **inert, dim** | live | live | live |
| Booth bar | live; premiere secondary until all ready | same | **inert, dim** | live | live | live |
| Video, REC tally, prompter | ✓ | ✓ | ✓ | ✓ | ✓ (locked label) | ✓ |
| Waveform | **inert** (no take) | drag | live trace, no drag | locked | view only | ✓ |
| Timing row | **inert, dim** | ✓ | inert | locked | **hidden** | ✓ |
| Record deck | ● Record take 1 | ● Record take 4 | ■ / ✕ live; transport inert | spinner; transport live | "Carol is voiced by Tani" + transport | U2 one-row deck |
| Takes | "No takes yet. Press Space to record." | rows with ▶ | inert | pending row | rows, ▶ only | hidden |
| Voice | presets + For + summary | same | inert | locked | hidden | page: Level, modules, Clean up noise |
| Monitor | Backing + 2 switches | same | inert | live | **Backing only** | hidden |
| Prev / Next | Next **secondary** | Next **amber** | inert | live | Next amber | live |

## Targets (audit numbers, corrected by the critique)

Measured with the audit's own scripts: `measure_inpage.js`, a copy of `run_measure.js` and `summarize.js`. They are copied into `C:/Users/tanis/AppData/Local/Temp/dm_shots/v2-booth-layout/tools/`. The only changes are the output paths and casting Carol to the host, because `main` no longer auto-casts. The before run reproduces the audit's U2 numbers: idle3 at 1440 has 48 controls, 148 words, 24 framed panels and a 26.9% picture. Raw data is in `dm_shots/v2-booth-layout/raw/before.json` and `raw/table-before.md`.

| Metric | Before (main) | Target |
|---|---|---|
| Video picture share, 1440 / 1280 / 960 | 26.9 / 14.7 / 12.5 % | ≥ 38 / 25 / 25 % |
| Chrome above the video | 148 px | ≤ 116 px |
| Prompter line rank by visual weight (idle) | 10–14 | ≤ 5 |
| Next line rank, own line, 0 takes, measured on a "Next line" button and not "Done" (C7) | 2 | ≥ 8 |
| Enabled controls, idle3 1440 | 48 | ≤ 40 |
| Enabled controls, idle0 1440 | 34 | ≤ 26 (C2) |
| Enabled controls, count-in / recording | 34 | ≤ 2 (Stop; the waveform if counted) |
| Guest on someone else's line, controls / words | 34 / 110 | ≤ 24 / ≤ 70 |
| Framed panels, idle3 / box depth | 24 / 2 | ≤ 16 / 1 |
| Layout spacing values (off the 4 px scale) | 7 (4): 2 4 6 8 10 12 14 | ≤ 5 (0), all from the scale |
| Column row-start edges (near misses) | 4 (1) | ≤ 3 (0) |
| Column content scrolled away, idle3 at 1280 | 133 px | 0 |

The PR body gets a before → after table of these, generated by `summarize.js`, plus before and after screenshots of idle0, idle3, recording, guestOther and allfx at 1440 and 1280.

## Measured result (G4)

The audit's own scripts, run on this branch (`run_measure.js 8793 after`, then `summarize.js before after`). The only change to `run_measure.js` is one extra state at the end, `idle3NoHint`: idle3 at 1280x720 after dismissing the one-time mic-sync hint. Raw data: `dm_shots/v2-booth-layout/raw/after.json`, `raw/table-after.md`. All numbers are at 1440x900 unless a size is given.

| Metric | Before (main) | After | Target | |
|---|---|---|---|---|
| Video picture share, 1440 / 1280 / 960 | 26.9 / 14.7 / 12.5 % | **39.3 / 26.3 / 28.0 %** | ≥ 38 / 25 / 25 % | met |
| Chrome above the video | 148 px | **114 px** | ≤ 116 px | met |
| Prompter line rank, idle0 (1440 / 1280 / 960) | 11 / 11 / 10 | **4 / 3 / 3** | ≤ 5 | met |
| Prompter line rank, idle3 | 14 / 13 / 11 | **6 / 5 / 4** | ≤ 5 | 1440 one over (ranks are ±2, C8) |
| Next line rank, own line, 0 takes, "Next line ›" (C7) | 2 / 2 / 2 | **9 / 8 / 7** | ≥ 8 | met at 1440 and 1280 |
| Enabled controls, idle3 | 48 | **45** | ≤ 40 | missed, see below |
| Enabled controls, idle0 | 34 | **27** | ≤ 26 (C2) | missed by 1, see below |
| Enabled controls, count-in / recording (every size) | 34 | **1** (Stop) | ≤ 2 | met |
| Enabled controls, saving | 23 | 22 | (live) | live, as decided |
| Guest on someone else's line, controls / words | 34 / 110 | **26 / 75** | ≤ 24 / ≤ 70 | missed, see below |
| Framed panels, idle3 / box depth | 24 / 2 | **16 / 1** | ≤ 16 / 1 | met |
| Layout spacing values (off the 4 px scale) | 7 (4): 2 4 6 8 10 12 14 | **4 (0): 4 8 12 16** | ≤ 5 (0) | met in every state |
| Column row-start edges (near misses), idle3 | 4 (1) | **4 (0)** | ≤ 3 (0) | near misses met |
| Column content scrolled away, idle3 at 1280 | 133 px | **27 px**; 0 with the mic-sync hint dismissed | 0 | met without the one-time hint |

What the misses are made of (each control is in the raw data's control list):
- **idle3, 45:** Mock A's 40, plus the who's-here stack (decision 1) and the For select (decision 2, which Mock A hid), plus the one-time mic-sync hint's two buttons and the expand-video button, which shows because the pointer rests on the video. Without those three it is 42: Mock A's 40 plus the two decisions (measured as `idle3NoHint` at 1280, where the Monitor's two switches no longer scroll away and count too).
- **idle0, 27:** C2's 26 assumed Mock A's controls. This branch adds the stack and keeps For (+2), and line 1 has no Prev (−1).
- **Guest, 26 / 75:** Mock A's 23, plus the stack, the current line's chip (C7: it stays with My lines) and the hover-only expand button. The 5 extra words are the take durations, which stay on the rows (critique section 4).
- **Column edges, 4:** card edge, L1, the take rows' contents and the Voice summary, which is right-aligned on R1 and only counted as a row start.
- **Scrolled away at 1280, 27 px:** the mic-sync hint, shown once after a take until you sync or dismiss it, takes two lines in the deck. Without it the column fits.

Screenshots (`C:/Users/tanis/AppData/Local/Temp/dm_shots/v2-booth-layout/`), before next to after:

| State | 1440x900 | 1280x720 |
|---|---|---|
| idle0 | `before-idle0-1440x900.png` → `after-idle0-1440x900.png` | `before-idle0-1280x720.png` → `after-idle0-1280x720.png` |
| idle3 | `before-idle3-1440x900.png` → `after-idle3-1440x900.png` | `before-idle3-1280x720.png` → `after-idle3-1280x720.png` |
| recording | `before-recording-1440x900.png` → `after-recording-1440x900.png` | `before-recording-1280x720.png` → `after-recording-1280x720.png` |
| guestOther | `before-guestOther-1440x900.png` → `after-guestOther-1440x900.png` | `before-guestOther-1280x720.png` → `after-guestOther-1280x720.png` |
| allfx | `before-allfx-1440x900.png` → `after-allfx-1440x900.png` | `before-allfx-1280x720.png` → `after-allfx-1280x720.png` |

The same after shots are also kept as `after-G4-*.png`, with 960x680, the count-in, saving and `after-G4-countin-column-1440x900.png` (the dimmed column, close up).

## Implementation groups (build order)

1. **Frame and spacing.**
   - `--space-*` tokens, and every booth container on the scale.
   - The booth bar holds the chips; `‹ Lobby` and the chip strip go.
   - The ribbon is hidden in the booth.
   - The single-row 22 px prompter with the length badge.
   - The mic-sync hint unboxed.
   - DESIGN.md's caption size.
2. **Who's here stack.** `presence.js`, its CSS, the booth-bar slot, and wiring from `renderBoothToolbar`.
3. **Column content and earned emphasis.**
   - Takes rows with ▶, the "Use this take" cue and avatars.
   - The Voice card summary, with Level moved into All effects.
   - The timing row without ±100, inert with no take.
   - The read-only line view.
   - Next and Start premiere emphasis.
4. **Recording focus and the measurement.** `setRecordState`, `body.is-taking` and inert, Esc on the count-in, the exit-path tests, then the after run of the audit scripts and the PR table.

## Tests

- **New: `tests/test_recording_focus.js`.**
  - Each exit path clears `is-taking` and every `inert`.
  - Header nav, booth bar, column and footer are inert during the count-in and recording, and live while saving.
  - Esc cancels the count-in, and Esc while recording does nothing.
- **New: `tests/test_presence_stack.js`.**
  - Initials and colours, the "+N" disc, and the accessible name.
  - The popover opens on focus and on hover, closes on Esc, and has the right rows (line, progress, Ready).
  - A focused popover is not redrawn when nothing changed.
- **New CSS check, in `test_css_floors.js` or a new `test_spacing_tokens.js`.**
  - The `--space-1..5` tokens exist with the values 4/8/12/16/24.
  - The booth container rules use only `var(--space-*)` or 0 for gap, padding and margin.
- **Updated suites:**
  - `test_booth_column.js`: Next and premiere emphasis; the read-only line (no bezel, Backing only); the current chip kept with My lines.
  - `test_takes_card.js`: ▶ instead of Use; the "Use this take" cue; ⋯ holds Delete only; row click and Enter pick; the avatar for other people's takes.
  - `test_voice_panel.js`: Level is on the All effects page; the summary line, including noise.
  - `test_booth_timing.js`: no ±100 buttons; Shift+brackets still nudge 100 ms; the row is inert with no take.
  - `test_cast_hud.js`: the ribbon is hidden in the booth, and the lobby is unchanged.
  - `test_frontend.js` and `test_background_save.js`: any selectors on `.take-use`, `#btn-back-lobby`, `.timeline-chips-wrapper` and `[data-nudge="100"]`.
- **The full suite:** `python tests/run_all_tests.py`.

## Risks

- **A missed exit path would leave the booth inert.** `setRecordState` is the single place that sets it, and each exit has a test, including a mic failure during the count-in.
- **Long captions at 22 px** aren't measured on real packs. Check the longest caption in `Packs/` at 1280x720. The picture must still beat the before numbers.
- **Many lines:** a 40-line scene's chips have to scroll inside the bar without pushing out Mark ready or Start premiere.
- **Removing "Use" hides the pick action.** The hover and focus cue must be visible, not only a tooltip.
- **`inert` on the header** takes the nav out of the accessibility tree mid-take. That is the intent. Focus stays on the record button, because it is the only live control.
- **Test churn** in five suites. The element IDs are kept.

## Decided overnight, revisit

These were answered overnight while you slept. They follow the critique's recommendations, but you never confirmed them:
1. The cast ribbon is retired from the booth, and a "who's here" avatar stack replaces it. In the lobby the ribbon stays until the join/lobby PR puts the same stack there and deletes it.
2. For stays in the Voice card, and only Level moves to All effects. ▶ replaces Use, and a row click or Enter uses the take, with a "Use this take" cue on hover and focus.
3. Recording makes the header's nav, Audio and `?` inert too. The connection banner stays live.
4. The prompter is 22 px. Next is amber only after a take, and Start premiere is amber only when everyone is ready.
5. The spacing tokens are `--space-1..5` = 4/8/12/16/24.
6. The noise switch stays in All effects, with "noise cleanup on/off" in the Voice summary. Backing stays on other people's lines.

## Decided without the owner

- **"One 12 px column gutter"** is read as the inner gutter of every booth card (the L1 line). The gap between the video column and the right column is 16, as in Mock A, whose measured numbers are the targets. If you meant the gap between the two columns, it is a one-token change.
- **"Done ›"** follows the same earned rule as "Next line ›": amber only once the line has a take. U2 always made it amber (C7).
- **Esc cancels the count-in only.** During recording it does nothing, because losing a take to a stray Esc is worse than one more Space press.
- **The waveform with no take** is inert, so idle0 meets ≤ 26 (C2). It is a drag target only, and with no take there is nothing to drag.
- **The take duration stays on the row**, in muted text, against the audit's move to a tooltip (critique section 4).
- **Avatar colours** are each person's current colour. The new 8-hue palette (critique Q6) is the join/lobby PR's.
- **The record button stays at 48 px** on screens 800 px tall or shorter, as in U2. A 62 px button at 720 wasn't mocked.
- **The ±100 ms buttons go** (audit step 10). Shift+`[`/`]` keeps 100 ms.
- **The chip strip is as wide as its chips** (`flex: 0 1 auto`, not `flex: 1`), so "My lines" sits right after the chips as in Mock A. It still shrinks and scrolls: with 40 lines, Mark ready and Start premiere stay in the bar at 1440, 1280 and 960.
- **Short windows (800 px tall or less) keep 8 px column gaps** and an 8 px vertical deck padding, as U2 did. Both are on the scale; the 12 px gutter (L1) is the same at every height.
- **The booth fills the window below the header.** Its height no longer subtracts the cast strip, which the booth no longer shows. The booth's page padding is 8 / 16 / 12 (top, sides, bottom), so the picture starts at y = 114.
- **The longest real caption** (92 characters, a pack in `~/Documents/DubMate/Packs`) wraps to two centred lines at 1280x720. The prompter is then 75 px tall and the picture 22.7% of the screen: below the 25% target, but well above today's 14.7%.
- **The who's-here popover** lists several roles by name ("2 roles: Carol, Dave"). Someone with no role reads "No role yet", with no progress line, and one line reads "0 of 1 line recorded". Hover and focus open it; a click keeps it open until a second click, Esc or focus leaving. While the stack is inert (recording), Esc is left to the booth. `presence.js` also exports `avatarHtml` and `avatarEl(user, size)` (28 px by default) for the take rows.
- **Take rows fit 340 px by tightening the row, not by dropping the duration.** Inside a row the gaps are 4 px, the slot is 70 px and "Use this take" is 11 px; ▶ and ⋯ are 24 px wide (the WCAG 2.2 minimum). The sync word ellipsizes if a platform's font runs wider. On a line two people share, another person's take shows their avatar instead of the duration, because both don't fit.
- **The "Use this take" cue** shows while the pointer is on the row or the row itself has focus. It doesn't show when ▶ or ⋯ has focus, since Enter there doesn't use the take. While the line saves it doesn't show at all, and ⋯ (Delete only) is off.
- **The recorder's avatar** reads "Recorded by Mika" in its tooltip and to screen readers.
- **The Voice summary** reads "level matched · noise cleanup on", or "level +2 dB" once you turn Level. Before the first take: "level matched when you record · noise cleanup on". It wraps under the For row when both don't fit, which at 340 px is always; it is still shorter than U2's Level row.
- **The waveform with no take** is inert but not dimmed: the original's waveform is what you watch before the first take. The timing row is inert and dimmed. On a line you can't record the waveform is inert too (view only): dragging it there moved someone else's take on your screen.

- **Only Stop is live while taking.** The prompter's resize handle goes inert too, and so does the waveform: `inert` stops a drag (and keys) where `pointer-events: none` would only stop the mouse. The waveform is left out of the dimming, so the live trace reads at full strength.
- **`?` and `[` `]` wait while taking.** The shortcut sheet over a running take would have kept Space from stopping it, and the timing row they move is inert.
- **A mic that fails as the take starts** (after the count-in) now gives the booth back with NO MIC and the reason. It used to leave the booth stuck in recording, which with recording focus would have meant a dimmed, dead booth.
- **The count-in label stays "Space or click to cancel".** Esc is listed in the `?` sheet as "Cancel the count-in", so the deck's text doesn't grow.
- **A saving or deleted take row** starts its contents 8 px in, on the scale, instead of 10.

## Hands-on checks (owner, in the morning)

1. At 1280x720, idle on your own line: does the booth feel calmer, with the picture and the line first? Is anything you use often now hard to find?
2. Record a take with the mouse and with Space. Does the dimmed header and column feel right, or too strong? Press Esc during the count-in.
3. Hover and Tab through take rows. Is "Use this take" discoverable? Does ▶ play the right take?
4. Open the "who's here" stack with the mouse and with Tab. Is each person's line and progress enough, without the ribbon?
5. As a guest on the host's line: no record button, Backing only, ▶ on rows. Does that read as "view only" without feeling broken?
6. Try a pack with a long caption. Does the 22 px line wrap acceptably?
7. Open All effects. Is the Level knob where you'd look for it, and is the noise summary on the Voice card clear?
