# Design: Pack Builder lines you can work with

Branch `fix/pb-lines-expand` from `origin/main` at `f851fa9`. Follows U5c step 40h (`ui-u5c-pack-builder.md`, section 3 and "Group C, measured") and keeps the speed rules of `pack-builder-editor-fixes.md`. Pack Builder only: `static/js/pack_builder.js`, `static/css/builder.css`, `static/builder.html` if needed, tests, `CHANGELOG.md`. The studio, booth and lobby (PRs #26, #28) and the installer and notices PRs are not touched.

## Goal

The owner tested Pack Builder after PR #27:

> "the pack builder line selection [is] hard to use. the play button on a non selected line doesn't actually play but only selects it, so its a false input. other than that, i think we've made it too compact. the selected line should be properly expanded. think about this."

After this PR every control in the Lines column does what it says on the first click, rows at rest stay compact and easy to scan, and the selected line opens into a card with everything needed to edit it, labelled.

## What was found

**The false Play, reproduced** (`before-results.json`, real Chromium, real mouse). Clicking Play on an unselected row selects the line, and plays nothing (`previews: []`, video paused), at 1440x900, 1280x720 and 960x680. The cause:

1. The press focuses the Play button. The list's `focusin` handler (`initLinesList`) selects the line at once, on pointer down.
2. Selecting changes the row's layout: Transcribe and Delete appear, the timecode grows to "start – end", and below 1180px the actions move to a second row. The Play icon moves 60 to 100px to the left.
3. The pointer comes up somewhere else, so the browser sends `click` to the row, not the button. The row's click selects and seeks.

jsdom has no layout, so the existing test (`.btn-preview-cue` `.click()`) passed. The selected row also holds every field in all 40 rows (a textarea and a select each), which is why focusing any of them selects.

**Too compact** (`before-*` shots). The selected row is the same 39px as the others at 1280 and 1440 wide. Its text is capped at 4 lines and then scrolls inside (a 220-character line scrolls at 1280x720 and 960x680). Its actions are three 26px icons with no labels. Start and End exist only in the deck under the video.

| Before | 1440x900 | 1280x720 | 960x680 |
|---|---:|---:|---:|
| Lines list height | 452 | 272 | 232 |
| Row / selected row height | 39 / 39 | 39 / 39 | 39 / 69 |
| Rows fully visible, one selected | 11 | 6 | 4 |
| Long line: text height, inner scroll | 78, no | 78, yes | 78, yes |
| Play on an unselected row plays | no | no | no |

**Speed before** (`pbfix_perf.js` on main at `f851fa9`, 40 lines, 1440x900, median of 5, 2026-10-09; output `dm_pbfix/perf_pbl_before.json`): select click handler 1.8 ms, click to next frame 23.8 ms, no long tasks on select; keystroke `input` 0.4 ms; text commit `change` 2.1 ms; drag `pointermove` 0.1 / 0.2 ms (median / max), drop `pointerup` 25.3 ms; editor open, first blocks / waveform 90 / 166 ms. Group C compares against a "before" run on the same engine and day as its "after".

Sizes in px. Row text is 12.5px, numbers and times 11px, the select 12px. There are no `--space-*` tokens on main, so this PR uses the 8px rhythm and the existing motion tokens (`--ease-out`, `--duration-fast`).

## What this PR does

### 1. Rows at rest: compact, readable, nothing that only selects

```
●  12  Detective Mori   We go in at dawn, not a minute later…     0:12.40  [▶]
```

- A row is plain text plus one button. It has no form fields: the character is a name, the text is one line that fades at the right edge.
- Grid: dot (8px), number (mono 11px), character name (140px; 112px in a narrow column; 12px 700, ellipsis), text (13px, one line), start time (mono 11px), Play (28px icon button, `aria-label` "Play line 12").
- Play is the last column, so it sits at the right edge in both states. It shows on row hover, when the row has focus, and always where there is no hover (`@media (hover: none)`). Its place is kept at rest, so nothing shifts on hover.
- At least 40px tall (6px padding), 1px dividers as now. Hover fills the row with `--secondary` (#25201a) and shows Play. The pointer cursor stays.
- A click anywhere on the row except Play selects the line and seeks to its start (as now).
- **Play on a row selects the line and plays it, on the first click.** Pressing it changes nothing until the click: `focusin` on a button never selects. The click selects, plays the line from its start to its end, and leaves focus on the card's Play (the same place on screen, see 3).
- The "No words" badge stays in place of empty text.

### 2. The selected line: an editor card

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ●  3  [Detective Mori      ▾]               0:03.90 – 0:05.30   [▶ Play] │
│       ┌────────────────────────────────────────────────────────────────┐ │
│       │ Line 3: Not yet. (the whole text, as many lines as it takes)   │ │
│       └────────────────────────────────────────────────────────────────┘ │
│       [⇤ Set start] [Set end ⇥]                [Transcribe] [Romaji] [🗑 Delete] │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Header** (32px): dot, number, the character select (160px; 140px in a narrow column) with "+ New character…" as now, the times "0:03.90 – 0:05.30" (mono 11px, brass), and **Play** (`btn-sm` with icon and label) at the right edge. A row's Play turns into the card's Play in the same spot, so a second click plays again.
- **Text**: a textarea under the header, lined up with the select. 14px with a 20px line height (inputs are 14px in DESIGN.md). Sized to its content with `field-sizing: content` (the existing `fitLineText` measure where that is missing), at least 1 line. No 4-line cap: it grows to 10 lines, or to the space the card has in the list (the list's height at the default timeline, `100vh - 456px`, minus the header and footer; at least 3 lines), whichever is less, and only then scrolls. Focus: amber border, as inputs.
- **Footer** (32px): left, **Set start** and **Set end** (`btn-sm` secondary, icons from the deck's Start and End). They do what the deck's Start and End and the keys I, O, `[` and `]` do: set the selected line's start or end to the playhead (`markInAtPlayhead`, `markOutAtPlayhead`). Tooltips: "Set the start to the playhead (I or [)", "Set the end to the playhead (O or ])". Right, **Transcribe** (only when transcription is installed; tooltip "Fill in this line's text from the audio"), **Romaji** (only when it applies, updated while typing, as now) and **Delete** (ghost, trash icon, red on hover). All labelled. While Transcribe or Romaji runs, its icon becomes the spinner and the label stays.
- **Look**: 8px radius, 1px amber (`--primary`) border, an amber wash over `--card-header`, and a soft offset shadow (`0 6px 16px rgba(0,0,0,0.35)`, depth, not a glow). 6px margin above and below, 10px 12px 12px padding, 8px between header, text and footer. The card's number is ivory.
- **Narrow column** (a width container query on the list, under 520px wide, as at 960x680): the select is 140px. The footer wraps onto two lines only if it must (`flex-wrap`), never clipping a button.
- **Motion**: layout changes at once, so clicks, keys and the scroll position are exact. The card's border and wash fade in and its text and footer fade and settle 2px over `--duration-fast` with `--ease-out`. None of it under `prefers-reduced-motion: reduce`.
- **Clicking the card's empty space** does nothing (no seek while editing). Play, the timeline and the arrow keys move the video.

### 3. Changing the selection

- Only two rows change: the old card becomes a row and the new row becomes a card (`row.innerHTML` from `lineRowHtml` and `lineCardHtml`). The row elements, their ids (`cue-card-N`) and `data-idx` stay. No list or timeline render, as PR #23 and #27 require.
- The card's select is filled with the whole cast when the card is built (one select, a handful of options). The lazy fill on focus goes.
- **The clicked row stays under the pointer.** When the old card was above the new one, collapsing it would pull the new one up by about 100px. The list sets `overflow-anchor: none` and corrects `scrollTop` itself: the target's top is read before the swap (free on a click, layout is clean), and the next frame moves the list by however far it moved. Then the card is scrolled fully into view (`block: 'nearest'`; `'start'` if the card is taller than the list), with the smooth behaviour that follows reduced motion.
- **Focus** follows the swap: if focus was inside a row that is rebuilt, it goes to the same control in the new markup by `data-action` (Play to Play), or to the row. It never drops to `<body>`.
- Results that arrive after the selection moved (Transcribe, Romaji) write the line's text and refresh whichever form its row has now (`refreshRowText(idx)`), instead of a field that may be gone.

### 4. Keyboard and screen readers

- The list stays `role="list"`, rows `role="listitem"` with the roving `tabindex` and `aria-current` of U5c.
- Up and Down on a row or the card select the previous or next line, move focus to it and seek to its start. Enter on the card focuses its text; Esc in the text returns to the card. Enter on an unselected focused row (before any selection) selects it first.
- Tab from the card goes through the select, text, Play, Set start, Set end, Transcribe, Romaji and Delete. Rows at rest are not Tab stops, and neither is their Play (`tabindex="-1"`): the keyboard plays a line with the card's Play.
- The card shows the brass `:focus-visible` ring (2px, 2px offset; the list's 4px padding keeps it inside the scroller).
- Row labels stay "Line 4, Detective Mori, 0:12.40". The card's Play reads "Play line 4".

### 5. Fit

Targets, with a short line selected (one line of text) and the timeline at its default height:

| | 1440x900 | 1280x720 | 960x680 |
|---|---:|---:|---:|
| Card height (about) | 150 | 150 | 150 to 190 |
| Rows fully visible besides the card, at least | 6 | 3 | 2 |

The selected card is always fully in view after selecting, including the last line and a long line. U5c's "10 or more at 1440x900" is traded for the card, as the owner asked.

## Groups (build order)

**A. Rows and an honest Play** (`pack_builder.js`, tests). Two templates, `lineRowHtml` (plain row) and `lineCardHtml` (the card's final markup and `data-action`s), `renderSegmentsList` building rows plus the one card, `selectSegment` swapping two rows with the scroll anchor and focus rules, the click handler (Play selects then plays; Set start and Set end call the mark functions; empty card space does nothing), `focusin` ignoring buttons, `refreshRowText` for Transcribe and Romaji, `updateNonverbalBadge`, `updateCardTimecode` and `changeLineCharacter` working on both forms. Delete the lazy select fill. Tests first (see Tests).

**B. The look** (`builder.css`). Rows (40px, 13px text, hover, Play column, `hover: none`), the card (header, text, footer, look, motion and its reduced-motion rule), the container query on the list, the text cap, `overflow-anchor: none`. Remove what no longer applies: the 1180px row rules, the rest-state select styling, the 4-line `max-height: 78px`, `.line-action` display rules. Run the fit check at the three sizes and fix until the targets hold.

**C. Measure and record.** `dm_pw/pbfix_perf.js` before and after, `pbl_before.js <port> after`, the measured tables in this doc, the CHANGELOG line, the full suite.

## Tests

`tests/test_builder_editor.js`, written first; the first two fail on main:

- **Play on an unselected row**: focusing its Play (the pointer-down focus) leaves the selection and the row's markup unchanged; the click then selects the line, starts the video and voice track at the line's start, sets `stopAt` to its end, and leaves focus on the card's Play.
- Rows at rest have no `select`, `textarea` or `input`; their only control is Play. The selected row has the select, the text, Play, Set start, Set end, Delete, and Transcribe only with transcription installed.
- Set start and Set end in the card set the times to the playhead, update the card's times and the block, and add one undo step each.
- Selecting keeps the same row elements (ids and nodes) and rebuilds only the old and new rows; the timeline blocks are the same nodes.
- Up and Down from the card move selection and focus; Enter focuses the text; Esc returns to the card; focus is never on `<body>` after a swap.
- A Transcribe that finishes after the selection moved updates the line's row text.
- Clicking the card's empty space neither seeks nor changes the selection.

Existing tests that read `.cue-text-input` or `.cue-char-select` of an unselected row select the line first (`test_builder_editor.js`, `test_builder_session.js`, `test_builder_step1.js`). "With Japanese chosen every line offers Romaji" becomes "the card offers Romaji for any line". `tests/test_css_floors.js` and its reduced-motion check cover the new rules. Every group runs `python tests/run_all_tests.py`.

Dev checks (not committed): `pbl_before.js` (shots, fit, the real-mouse Play click, keyboard, long and last line) and `pbfix_perf.js` (40 lines, 1440x900, median of 5). Select, drag, keystroke and text commit stay within the "before" medians measured the same day plus 20%, with no long tasks during select.

## Risks

- **Tests that assume fields in every row**: about 20 assertions change. Each keeps its intent; none is dropped.
- **Speed**: a selection now writes two rows' markup and builds one textarea (field-sizing measures it). That is less than the old 40 rows of fields cost to render, but the click handler is on the hot path. Measure with `pbfix_perf.js`.
- **The scroll correction** reads layout once per selection. On a click the layout is clean, so the read is free; holding Down could force one layout per key. Measure key repeat; if it costs more than a frame, read the target's top in the frame instead.
- **Container queries** need Chromium 105+ and Safari 16+. WebView2 and current macOS WKWebView have them. Without them the select stays 160px and the footer wraps. The list is a width container only: a size container (for a `cqh` text cap) made every editor frame's layout about 5x slower (see Measured).
- **Parallel PRs**: #26 and #28 change `style.css` and studio files, not `builder.css` or `pack_builder.js`. No overlap expected.

## Measured

Group C, 2026-10-09. Real Chromium, headless, the fixture engine on an isolated home. "Before" is main (`f851fa9`; the Pack Builder files are the same on `dd783ef`), "after" is this branch, both served by the same engine build in the same session.

### Fit (`pbl_before.js`, a short line selected, timeline at its default height)

| | 1440x900 | 1280x720 | 960x680 |
|---|---:|---:|---:|
| Lines list height | 452 | 272 | 232 |
| Row height, before / after | 39 / 40 | 39 / 40 | 39 / 40 |
| Selected line height, before / after | 39 / 134 | 39 / 134 | 69 / 134 |
| Rows fully visible besides the selected line, before / after (target) | 10 / 7 (6) | 5 / 3 (3) | 3 / 2 (2) |
| Long line (220 characters): text height, inner scroll, before | 78, no | 78, yes | 78, yes |
| Long line: text height, inner scroll, after | 52, no | 72, no | 110, yes (5 lines; the card fills the list) |
| Long line card fully in view, after | yes | yes | yes |
| Last line selected, fully in view (before and after) | yes | yes | yes |
| Down from line 4: line 5 selected, focused, brass ring (before and after) | yes | yes | yes |
| Console errors | 0 | 0 | 0 |

Card buttons at every size: Play, Set start, Set end, Transcribe and Delete, 32px tall, labelled (Delete keeps only its icon in the narrow column, its name stays for screen readers). Text sizes: row text 13px, name and select 12px, number and times 11px, card text 14px.

### Play on an unselected row (real mouse)

Hover line 8, move to its Play and click (`page.mouse.click` at the button's centre, real layout). Before: line 8 selected, nothing played (`previews: []`, video paused) at all three sizes. After: line 8 selected and played on the first click (`previews: [7]`, video playing) at all three sizes. Screenshots `after-C-lines-after-play-click-*`.

### Speed (`pbfix_perf.js`, 40 lines, 1440x900, median of 5)

The first after runs showed a regression in the browser's layout, not in the code. With the list as a size container (for a `cqh` text cap), every layout in the editor cost 3 to 4 ms instead of 0.5 to 0.7: a trace of 8 selects had 34 ms of layout in the 120 ms after each click, against 9 ms on main. Two paired runs agreed: click to next frame 49 against 36 ms and 45 against 25 ms, select handler 3.9 against 2.0 and 3.8 against 1.8 ms, one run with a 117 ms long task during select, and more dropped drag frames (19 against 8, 10 against 5). The list is now a width container only, and the text cap comes from the window height (`100vh - 570px`, the same height at the default timeline). Layout after a select is back to 12 ms, and `tests/test_css_floors.js` now fails on a size container or `cqh` in `builder.css`. The paired run after that change:

| | Before (main) | After |
|---|---:|---:|
| Select: click handler, ms | 2.4 | 3.4 |
| Select: click to next frame, ms | 31.4 | 33.2 |
| Select: long tasks, ms | 0 | 0 |
| Keystroke `input`, ms | 0.4 | 0.3 |
| Text commit `change`, ms | 2.9 | 2.8 |
| Drag `pointermove` median / max, ms | 0.1 / 0.4 | 0.1 / 0.3 |
| Drop `pointerup`, ms | 28.9 | 17.3 |
| Drag frames over 16 ms | 11 of 811 | 6 of 636 |
| Editor open: first blocks / waveform, ms | 112 / 332 | 87 / 164 |
| Console errors | 0 | 0 |

Outputs in `dm_pbfix/perf_pbl_{before,after}_C{,2,3}.json` (C3 is this table). The machine was busier than in the morning's baseline (select to next frame 23.8 ms then), which is why every comparison is paired.

Within the before medians plus 20%: the next frame after a select (+6%), keystroke, commit, drag and drop, with no long tasks during select. **Not within it: the select click handler**, 3.4 ms against a 2.9 ms bound (2.4 before). The extra 1 ms is the card being built on select: writing the new card's markup (0.8 ms, a select, a textarea and six icons) and the closed card's row (0.25 ms) and removing the old card (0.25 ms). It stays far under a frame, and the next frame comes only 2 ms later. Building every card ahead of time is what made the old rows' fields select on press, so this PR keeps the cost.

### Holding Down through 10 rows (`pbl_c_keys.js`, 5 rounds, 50 keys, key every 33 ms)

| | Before | After |
|---|---:|---:|
| `keydown` handler median / max, ms | 1.2 / 3.0 | 2.9 / 5.4 |
| Key to next frame median / 90th percentile, ms | 19.2 / 31.5 | 21.2 / 36.4 |
| Long tasks, ms | 53 | 0 |
| The target's top read (`getBoundingClientRect`) median / max, ms | none | 0 / 0.5 |
| Ends on line 15, focused, fully in view | yes | yes |

Each key's handler is under one frame and the layout read before the swap costs nothing measurable, so the read stays in the handler (the Risks fallback, reading it in the frame, isn't needed).

## Decided without the owner

1. **Rows at rest have no form fields.** A row is text plus Play, and selecting it opens the card. Clicking a row's text no longer puts a caret in it: the first click opens the card, and the text field is right there. This is what makes every control honest; the old rows held 40 fields that only selected on first use.
2. **Play sits at the right edge of a row and of the card's header**, so it stays under the pointer when the row opens.
3. **The card's Play restarts the line** each time. There is no Stop: Space pauses, as everywhere in the editor.
4. **Set start and Set end** are the card's start and end controls, reusing the deck's "to the playhead" behaviour and keys. There are no new ±25 ms nudge buttons in this PR; the timeline handles fine trims. The deck's Start and End stay.
5. **No height animation.** The layout snaps and only the card's colour and contents fade in (140ms). An animated height would move rows under the pointer and make the scroll target land late.
6. **Clicking the card's empty space does nothing**, so editing never moves the video by accident.
7. **Fit target** traded down from U5c's 10 rows at 1440x900 to the card plus 6 rows (3 at 1280x720, 2 at 960x680).
8. **Card text is 14px**, the input size in DESIGN.md; row text goes from 12.5px to 13px.

## Hands-on checks for the owner

1. Hover a line you haven't selected and click its Play: the line opens and plays from its start, and stops at its end. Click Play again: it plays again.
2. Click a line's text or name: it opens as a card with its character, text, times and buttons, and the line you clicked stays where it was on screen.
3. Type a long line (three or four sentences): the text box grows to show it all.
4. Play the video, press Set start, then Set end a little later: the times in the card and the block on the timeline follow. I and O still do the same.
5. With a card focused, use Up and Down, then Enter to type and Esc to go back. The brass ring shows where you are.
6. At the smallest window size, select the last line: the whole card is in view with a couple of lines above it.
7. Delete a line from its card, then Undo in the toast.
