Copied from the owner's reviewed UI plan on 2026-10-07.
Mockup and screenshot images it names are not in the repo.

Routing (owner decision, section 6): the host-only guards (`set_status`, `set_dialogue_presence` and the export routes) and clap noise rejection (step 9c) are done in the bug-fix PR `fix/first-test-findings`, not in the UI PRs. When this copy was made, that PR had not landed them yet. The UI PRs only check that they are there.

---

# DubMate UI plan

**Inputs.** I read seven per-surface critiques: landing, pack card and Share, Packs folder modal, join flow, lobby, booth, and voice panel. The voice-panel critique arrived cut off after its sixth finding.
- (added from full critique) I then read the full critiques for the eight surfaces I had first judged from screenshots (audio settings, premiere, export, Pack Builder, desktop launcher, shortcut sheet, "You left", reconnecting banner) and the rest of the voice panel. Across all 15 critiques there are 13 P0s and 89 P1s. Everything they add is marked "(added from full critique)" below.
- I also read the screenshots in `dm_shots/ui-audit`, the impeccable skill (v4.0.4: Refinement vs Redesign, Operate mode), and `documentation/PRODUCT.md` and `DESIGN.md` from an `origin/main` export.
- I read the parallel bug-fix design `first-test-fixes.md` on branch `fix/first-test-findings`.
- I checked several critique claims against the source myself:
  - `room_ws.py` `set_status` has no host check.
  - `booth.js:1202` still requires 2 or more takes.
  - `booth.js:159` compares the gain against the quantized slider.

**Mode.** Every surface here is an Operate surface. The only exception is the first-run hero on the landing page, which is a small Persuade moment.

**Mockups.** These are rough HTML/CSS mocks built with the real `style.css` tokens and rendered in headless Chrome:
- `mock-A.png`: layout A at 1440x900.
- `mock-A-rack.png`: layout A with All effects open.
- `mock-A-1280x720.png`: layout A at 1280x720. The middle of the column scrolls, and the line navigation stays visible.
- `mock-B.png`: layout B at 1440x900.
- `mock-B-1280x720.png`: layout B at 1280x720.
- `mock/gen.mjs`, `mock/base.css`: the mock sources.

---

## 1. Verdicts and the top 10 problems

### Verdict per surface

Seven surfaces had a written critique; the rest were judged from screenshots only. (added from full critique) The last eight rows are now re-judged from their full critiques.

| Surface | Verdict |
|---|---|
| Landing / scene explorer | **Restructure the information.** It is a generic amber card dashboard: the scene choice changes silently, there's no route to takes, and the hero pushes the work down. The visual tokens are fine. |
| Pack card + Share | **Refine.** The card is on-brand, but its meta is cluttered, Share is a 16px target, and the Share modal clips the path and has no "Show in folder". |
| Packs folder modal | **Refine (low priority).** It asks the user to type a path and has no Browse button. It counts packs from every folder. It is a hand-rolled dialog. Rarely reached. |
| Join flow | **Fix the flow, then refine.** It assumes a single origin. The bug-fix PR fixes the identity and settings parts. What's left: check the code first, show a pending state, and give the modal context. |
| Lobby / casting | **Restructure.** Guests can move the whole room. The right rail is a stray switch plus a duplicate roster. Seven classes have no CSS. Nothing shows the scene. |
| Booth (whole view) | **Keep the look, rebuild the right column.** The left column (video, prompter, waveform) works. The right column is in the wrong order, decorates instead of informing, and clips at 1280x720. |
| Voice panel / effects rack | **Restructure the disclosure.** The presets work. The full rack sits in a 118px scroll slot. The mouse wheel changes the sound. The scope choice is buried about 940px down. |
| Audio settings | **Fix the meter and clap sync after the bug-fix PR lands.** (added from full critique) That PR hides the export row and keeps the meter moving. Still open: clap sync can save a delay from noise (P0, 305 ms with nobody clapping), the bar uses RMS but the verdict uses peak and the colour key is reversed, the denied step is a wall of instructions for every platform, every status line is the same brass, and Done falls below the fold at 1280x720. The "Audio setup" chip only repeats the title. |
| Premiere | **Fix the behaviour, then restructure the screen.** (added from full critique) The MIX slider never reaches the export and does nothing while the final video plays (P0). Guests can change the room's dialogue level and start renders on the host. Starting the premiere blocks on a full render, and a failure is only logged. There is no scrubber, the 16:9/9:16 toggle changes nothing, and the video is crushed to about 158px at 1280x720. The green Export video button competes with the amber Play. |
| Export modal | **Fix the states.** (added from full critique) On the host, "Download 16:9/9:16" never downloads anything. The progress bar is faked (25, 65, 85%) and the reel spins forever. A failed export keeps the "Rendering" title and offers downloads of a file that doesn't exist. The same four actions appear in three places. "Your dub is ready" is followed by "Your video is ready". The ghost Close button sits between the primary and the downloads. |
| Pack Builder | **Fix the dead ends; restructure the Lines column later in the pass.** (added from full critique) A processing failure has no Retry, no Back and no manual route (P0). Missing tools show up only after the user commits. Editor work can be lost (no undo, no reload guard, Backspace deletes). Lines can't be selected from the keyboard, and the flow only goes forward. |
| Desktop launcher | **Bring into the system and make it honest.** It is a cool grey world with an emoji warning icon, unlike everything else. (added from full critique) The 2 GB Pack Builder download blocks entry to the studio, the splash never shows real progress, a slow start is shown as a red error whose "Try again" restarts the engine, and a long release note pushes the update card off-screen. |
| Shortcut sheet | **Refine.** (added from full critique) It shows the same four groups on every screen, has no take or line keys, and its group names don't match the screen names. Add the new take and effects keys. |
| "You left" view | **Fix the flow, then polish.** (added from full critique) It still shows the host's Audio settings and tools, a reload drops the guest on the host's scene list, the code they just left is thrown away, and nothing says where their takes went. The placeholder renders as "E.G. DUB789", and its only button is secondary. |
| Reconnecting banner | **Fix the behaviour; keep the placement.** (added from full critique) Recording carries on while offline and a failed upload throws the take away. The copy says changes aren't saved, which isn't what the code does. There's no "Retry now" and no end to the retries. It uses the recording red. |

### The 10 most important problems, ranked

1. **Takes are effectively invisible.** (Booth P0, landing P1, lobby P2; this is the owner's main complaint.)
   - The booth shows nothing with 1 take, and only a ghost caption "Takes (3)" with 2 or more.
   - When the list does open, it is a popover that covers the VOICE card.
   - Neither the landing page nor the lobby names takes or links to them.
   - (added from full critique) The premiere and the export don't say which take each line uses, or that unrecorded lines play the original voice, and they offer no way back to change a take. The `?` sheet lists no take keys.
   - The bug-fix PR only makes the button visible from the first take.
2. **The booth's right column clips and can't scroll, and the rack is a 118px window.** (Booth P0, voice P0 x2.)
   - At 1280x720, Prev, Delete, Next and Finish disappear and VOICE is cut off. The cause is `.booth-controls{height:100%;overflow:hidden}` together with fixed flex minimums.
   - Opening All effects shows only Low cut, with 943px of content behind it.
3. **The right column is ordered and weighted wrongly.** (Booth P1; the owner said it "needs a lot of work".)
   - MONITOR sits above RECORD and soaks up about 250px of grille cloth for three controls.
   - Every toggle shows its state three times.
   - The A/B bar duplicates Original and Preview.
   - Two amber premiere buttons sit side by side, so there are five high-emphasis elements in one view.
   - (moved from old item 10) Three timing-offset readouts disagree ("Offset: 0 ms" next to "-260 ms"), and "+1.9 dB / Match: +1.9 dB" is a real bug: the comparison uses the 0.5-step slider.
4. **Guests can move the whole room and are shown host controls.** (Lobby P0; premiere and export P1.)
   - `set_status` has no host check, so a guest pressing "Start recording" pulls everyone into the booth. (added from full critique) This is a security fix and is being made in the bug-fix PR's hardening.
   - Guest cast dropdowns are enabled. The page shows the change before the server answers, and the server's rejection is silently dropped.
   - (added from full critique) The same gap exists in the premiere: `set_dialogue_presence` and `POST /export`, `/export/stems` and `/export/project_zip` have no host check. Any guest can change the room's dialogue level (which throws away the host's export) or start an ffmpeg render on the host's machine that opens a modal on every screen. Guests also see Export video, Project files and Stems.
5. **Joining loses your identity and shows the host's machine.** (Join P0, lobby P0.)
   - Covered by the bug-fix PR (handoff, config redaction).
   - Still open: the code is checked only after the name step, the only error is a 3.2-second toast, nothing shows a join is in progress, and the modal gives no context ("Join room" said three times).
6. **Recording and saving feedback is fake or blocking.** (Booth P1 x2.)
   - ARMED is static text.
   - While recording, the take lane still says "No take yet".
   - There's no REC tally, no remaining time and no line-end mark.
   - Saving blurs and locks the whole booth, which goes against principle 5.
   - (added from full critique) Recording carries on as normal while the room is reconnecting. If the take upload then fails, the recorded audio is thrown away and the user is told to record again. A network blip costs a good take.
7. **Results are faked after the booth.** (added from full critique: premiere P0, audio settings P0, export P1 x3, premiere P1 x3. Breaks "Never fake it".)
   - The premiere's MIX slider never reaches the export and does nothing while the final video plays, which is the default on arrival. People set a balance, hear no change, and download the default mix.
   - After a dialogue-level change, other clients keep the "Final video" badge and keep playing the outdated MP4.
   - On the host, "Download 16:9/9:16" never downloads: it shows a 3.2-second toast with a path, or quietly starts a new render.
   - The export progress is hard-coded (25, 65, 85%), the reel spins forever, and a failed export offers downloads of a file that doesn't exist.
   - Starting the premiere blocks on a full render with only a toast, and a render failure is only printed to the server log.
   - Clap sync can save a delay from noise (305 ms with nobody clapping), after which every new take is silently shifted.
8. **The effects rack works against the user.** (Voice P1 x2.)
   - Scrolling the rack turns whichever knob is under the cursor. That also switches its effect on, sets the preset to Custom, and saves and re-renders on every tick.
   - Where a sound applies (this take, the character, every line) is decided only at the very bottom of the rack, through `window.confirm()`.
9. **The scene choice isn't the user's.** (Landing P1 x2.)
   - The first card is selected before any click.
   - Search silently reassigns the selection.
   - "Create room" never names the scene, so it is easy to start a room for the wrong one.
10. **The keyboard, dialog and contrast floor is broken.** (P1 on 5 surfaces, more from the full critiques; PRODUCT.md promises full keyboard use. Old items 9 and 10 merged.)
    - Pack cards, line chips and colour swatches can't be operated from the keyboard.
    - The join, Packs folder and export modals have no Escape or focus trap. (added from full critique: export.)
    - The record button has `outline:none`.
    - Destructive actions use the native `confirm()`.
    - Every save fires two toasts, and toasts land top left over the controls.
    - Meta text is 2.98:1 to 3.44:1. Labels go down to 8.5px. (added from full critique) The premiere, export, audio meter, Pack Builder and launcher labels fail the same way, and the launcher's white-on-amber button is 3.19:1.

---

## 2. The right-side booth panel

### What's wrong today

The column is 340 or 360px wide and holds, from top to bottom: MONITOR, RECORD, VOICE (with the hidden rack), then the navigation.

- **Order.** The thing used least per take (monitor mix) is on top. The thing used every few seconds (record, then pick a take) is in the middle. Takes have no home.
- **Space.**
  - MONITOR's grille takes about 35% of the column for one knob and two rockers.
  - The rack gets whatever height is left, which is 118px at 1440x900 and 87px at 1280x720.
  - The column can't scroll, so the line navigation is the first thing cut off.
- **Status.**
  - ARMED never changes.
  - The record glyph turns into ↺, which reads as undo.
  - "Take 3 by Tani (0.812s)" sits in a status strip, and "Takes (3)" looks like a caption.
- **Duplication.**
  - A/B ("[ A: Your Dub ] ⇄ B: Orig") repeats Original / Preview.
  - "Use" and "In the dub" are the same amber.
  - "Auto", "Match:" and "✓Matched" are three words for one idea.
  - The Delete-take trash icon sits between Prev and Next.
- **Disclosure.**
  - VOICE appears only after the first take, which shifts the layout.
  - Presets apply silently to one take.
  - The rack is all or nothing: 23 knobs with off modules still drawn.
  - The wheel captures scrolling.
- **Decoration.** Screws, diamond grille and I/O rocker glyphs fill the control areas. The amp character belongs on the faceplate headers and the record bezel, not behind the controls.

Both layouts share these fixed decisions:

- **The line navigation is pinned.** It is the column's footer and can never be clipped.
- **The record deck is pinned at the top:**
  - A real state badge: READY, COUNT-IN, REC, SAVING or NO MIC.
  - A record button that keeps the ● glyph.
  - A next-action line ("Record take 4 · Space · 3-beat count-in").
  - One segmented transport, "▶ Original | ▶ Take 3", which replaces both A/B and Original/Preview.
- **Takes are a list in the page flow, never a popover.**
  - It is visible from the first take.
  - The picked take is shown as a selection: a radio column and a green row with "In the dub". The other rows get a "Use" button.
  - Timing appears in words ("Tight sync", "A bit late", "–" when there's no score).
  - Delete moves into each row's "⋯" menu and is undone with an Undo toast.
- **Saving never blocks the screen.** The take lane shows "Saving… cleaning up noise", and only re-recording on that line is locked.
- **While recording:** a REC tally and the remaining time show in the video corner, the incoming mic signal is drawn live in the take lane, and the line end and tail are marked on the waveform. The mocks show the end mark.
- **The rack never scrolls inside a scroll box.** Off modules collapse to one row (switch, name, "off"), and the wheel turns a knob only while that knob has focus.

### Layout A: stacked column (`mock-A.png`, `mock-A-rack.png`, `mock-A-1280x720.png`)

The regions, from top to bottom:

1. **Record deck, pinned, about 150px.**
   - Faceplate header "● RECORD" with the state badge.
   - A 62px record button next to "Record take 4 / Space · 3-beat count-in".
   - The segmented transport "▶ Original | ▶ Take 3". "Take 3" is disabled until a take exists.
2. **Scrolling middle** (`overflow-y:auto`; it doesn't scroll at 1440x900):
   - **TAKES · N card.**
     - The rows described above.
     - With 0 takes it reads "No takes yet. Press Space to record."
     - With 1 take it adds the hint "Record again to compare takes."
     - The header shows a `T` key hint.
   - **VOICE card.**
     - Header "VOICE" plus an "All effects ›" button (bordered secondary, not ghost).
     - Body:
       - Preset chips (Clean, Warm, Radio, Monster), usable before the first take.
       - **"For: This take ▾"**, which can be changed to "All of Black Guy 1's lines" or "Every line" (host only). It confirms inline with "✓ All of Black Guy 1's lines use Radio".
       - Level: a small knob, "+4.5 dB", "✓ Matched", and "Auto".
     - The unlabelled empty meter bar is removed.
   - **Monitor strip, about 70px, no faceplate.** A Backing slider with 60%, and two labelled switches, "Count-in" and "Hear original". Each state shows once.
3. **Footer, pinned:** "‹ Prev" and the amber "Next line ›".
   - On your last line it becomes "Done ›".
   - If some lines have no take, it asks inline "2 of 3 lines recorded. Mark ready anyway?"
   - The trash icon is gone.

**Default view vs one click away.**
- Visible by default: record, transport, every take, presets, scope, level, and the monitor basics.
- One click away: the full rack ("All effects ›"). The take actions behind each row's "⋯" are delete and "Use on…".

**All effects (`mock-A-rack.png`).**
- The rack becomes the column's page:
  - The record deck shrinks to one row: a 40px button, "Record take 4", and "▶ Take 3". Space still records.
  - Under it, a VOICE page with a header "‹ Back · Custom · 4 on", the "For" menu, the Level row, then the module list.
- On modules are expanded; off modules are one row each.
- Takes and Monitor are hidden while the rack is open and come back on Back or Esc.

**Keyboard flow.**
- `Space` records or stops, as today.
- `[` and `]` nudge the timing, as today.
- `T` moves focus into the takes list:
  - `↑` and `↓` move between rows.
  - `P` plays the focused take.
  - `Enter` makes it the take in the dub.
  - `Delete` removes it, and an Undo toast appears.
- `A` toggles Original / Take on the transport.
- `E` opens or closes All effects. `Esc` closes it and returns focus to the button.
- All of these go into the `?` sheet.
- Rows form a roving-tabindex group (one tab stop), so Tab goes record → transport → takes → voice → monitor → footer.

**At 1280x720:** the record deck and footer stay. The middle scrolls: Takes is fully visible, Voice partly, Monitor below. Nothing is clipped without a way to reach it. A height breakpoint at 800px or less shrinks the record button to 48px and tightens the padding.

### Layout B: tabbed inspector (`mock-B.png`, `mock-B-1280x720.png`)

1. **Record deck, pinned.** Identical to A.
2. **Inspector card with two tabs, filling the remaining height.**
   - Tabs: **Takes · 3** and **Voice · Radio**. Each tab label carries its summary, so the hidden tab still reports its state.
   - **Takes tab:** the same rows as A, plus a one-line key hint ("↑ ↓ to move, P to play, Enter to use a take").
     - It ends with a one-row voice summary: "Voice: Radio · this take · +4.5 dB ✓". Clicking it opens the Voice tab.
   - **Voice tab:** presets, For, Level, then the full rack inline in the tab, with off modules collapsed. The rack uses the whole tab height, so there's no separate "All effects" page.
     - The tab remembers whether the rack is expanded.
   - Default tab: Voice before the first take on a line (pick a sound, then record), Takes once a take exists.
3. **Monitor moves out of the column** into the waveform panel's toolbar, under Timing: Backing slider, "Count-in", "Hear original while recording". The reasoning is that these are playback settings and sit best next to the waveform.
4. **Footer, pinned.** Same as A.

**Keyboard flow.**
- `Space`, `[` and `]` are unchanged.
- `T` and `V` switch tabs and focus the first control.
- Inside Takes: `↑` `↓`, `P`, `Enter`, `Delete`, as in A.
- Inside Voice: arrow keys on a focused knob.
- `A` toggles the transport.

**At 1280x720:** everything fits with no scrolling, because the left column absorbs the monitor row and the inspector flexes.

### Recommendation: Layout A

- **A answers the owner's complaint most directly.**
  - Takes, presets and level are all visible together, with no tab that can hide the takes.
  - B would bring back a hidden state: someone sitting on the Voice tab sees only "Takes · 3" in a tab label, which is the same discoverability trap the owner fell into.
- **A matches PRODUCT.md principle 4 literally.**
  - Principle 4 says "Presets first, the full rack one click away". In A, presets are always visible and the rack is one click.
  - In B the presets are one tab away whenever you're on Takes.
- **A changes less.**
  - Monitor stays in the column, and the left column keeps its height for the video and waveform, which is already the squeezed part at 1280x720.
  - B takes another 30px from the waveform panel, which already collapses at that size (booth P1).
- **A's weakness is that the middle scrolls at 1280x720.**
  - It is mitigated by the pinned deck and footer, and by the height breakpoint.
  - If the 1280x720 test still feels cramped after that, the fallback is to borrow one piece of B: move the Monitor strip under the waveform. Both layouts are built so this is a one-step change.

---

## 3. Refinement or redesign

**Call: keep and refine the visual world. Rebuild the structure of two regions (the booth's right column and the lobby's right rail) inside that world. Do not redesign the look.**

Evidence for keeping it:
- **It is specific to the product.** The booth critique says the warm amp, wood and brass rack "is clearly DubMate", and that the video and prompter lead as PRODUCT.md asks. The pack-card critique: the card "mostly fits the product". Only the landing critique calls a surface generic, and that is about its layout (a card dashboard), not its palette.
- **The problems aren't visual.**
  - Of 13 P0s and about 45 P1s, almost all are about information architecture, behaviour, keyboard and accessibility, or copy: takes hidden, column clipping, set_status, identity, wheel capture, selection reassignment.
  - (added from full critique) The full count is 13 P0s and 89 P1s across 15 critiques. The new ones are behaviour too: the premiere mix, clap sync, the Pack Builder dead end, fake export progress, lost takes on reconnect. The only new visual failure is the launcher's off-system palette, which step 39 already covers.
  - The only aesthetic failures are subtractive: decoration inside control areas, gradient text on the hero, the 2px coloured left border, 8 to 10px mono labels, and two amber primaries.
- **The detector agrees.** Its only finding is "overused-font: Plus Jakarta Sans", which DESIGN.md pins and which is fine for Operate surfaces. Everyone marked it a false positive.
- **The tokens are sound, but they get bypassed.** `style.css :root` has complete surface, text, accent and motion tokens. The drift comes from JS-rendered inline hex values, seven lobby classes with no CSS, a hard-coded `#1c1814` and `#f59e0b`, and inline font sizes. That gets fixed by using the tokens, not by replacing them.
- **The owner's words** ("the UI on the right side of the screen … needs a lot of work") point at one region, not the identity.

What changes within the refinement:
- **Rewrite DESIGN.md first.**
  - Its frontmatter describes a different, plum-wine palette (`bg-surface-0 #12090e`, `wood-dark #441c2a`, `text-muted #ad9fa7`). The prose and `style.css` use espresso and walnut (`#12100e`, `#1a1714`, `#a89f95`), and that is what the owner tested.
  - `style.css` is the source of truth: regenerate DESIGN.md from it (impeccable `document`).
  - Retire `mono-xs` (9px) and `mono-micro` (8px). The new floor is 11px mono and 12px for anything that must be read.
  - Record the rule "amp decoration lives on faceplate headers and the record bezel only".
  - Record "one amber primary per context".
  - Record "green means the take in the dub / confirmed".
- **Remove:**
  - grille fill and screws from control bodies;
  - I/O rocker glyphs (use labelled switches);
  - gradient text on the hero;
  - the 2px coloured left border on search snippets;
  - the hover lift on cards;
  - `transition: all`;
  - emoji spinners and emoji icons.
- **Bring the desktop launcher's cool grey screens onto the same tokens.**
- **The two structural rebuilds** keep the look:
  - the booth right column (layout A);
  - the lobby right rail, which becomes a scene preview, with the cast table taking a Takes column.

---

## 4. Implementation plan

**42 steps, one commit each**, named by the files they touch. (added from full critique) 17 more steps are inserted with letter suffixes (6a, 9a…40i) so existing step references stay valid. That makes 59.

| Tag | Meaning |
|---|---|
| **Q** | Quick win: local, low risk. |
| **S** | Structural change. |
| **dep: BF-n** | Wait for step n of the bug-fix PR `fix/first-test-findings` to merge, then rebase. That PR's steps: 1 takes button from the first take, 2 config privacy, 3 output routing / clap rule / mic errors, 4 live meter, 6 and 7 join handoff. (added from full critique) "Hardening" means that PR's security hardening, which adds the `set_status` host check. |

Every booth step comes after BF-1 merges, because it rewrites `renderTakeHistory` and the `#take-history` markup.

Suggested PR split, one PR per phase: U1 floors and guards, U2 booth column, U3 lobby, U4 landing and join, U5 polish. Each PR attaches screenshots at 1440x900, 1280x720 and 1366x768. (added from full critique) U5 is now much larger. Split it into U5a (launcher, 39-39b), U5b (premiere, export and audio settings, 40-40d) and U5c (Pack Builder, 40e-40i, plus 41-42).

### Phase U1: guards and floors (start now, no booth conflicts)

1. **Q** `documentation/DESIGN.md`: regenerate from `style.css`. Reconcile the frontmatter, retire 8 and 9px mono tokens, add the decoration, primary and green rules.
2. **Q** `dubmate/room_ws.py`, `tests/test_room_*.py`: `set_status` accepts only `host_id`. Add a test that a guest's set_status is ignored and gets an error.
   - (added from full critique) **Security.** `dubmate/room_ws.py` `set_status` has no host check, so any guest can move the whole room. This is being fixed in the bug-fix PR's hardening. Once that merges, this step only checks that the guard and its test landed, and doesn't redo them.
   - (added from full critique) Apply the same host-only guard to `set_dialogue_presence` in `room_ws.py` (`screening_control` already has one) and to `POST /export`, `/export/stems` and `/export/project_zip` in `dubmate/rooms_api.py`, with a 403 and a plain message. Add a guest test for each. Check whether the hardening already covers any of them first.
3. **Q** `static/js/app.js`, `static/js/room_socket.js`:
   - Add a socket `error` handler: a toast with the message, plus a request for fresh room state.
   - Hide "Start recording" for guests and show "Waiting for Tani to start recording" instead.
4. **Q** `static/js/studio/lobby.js`:
   - The guest Actor column becomes read-only text (dot and name). Only the host updates the view before the server answers.
   - Also: `CSS.escape` in the row selector, natural sort of characters, a plural helper ("1 line"), "Original voice", and a full-width select.
5. **Q** `static/css/style.css`, `static/js/studio/lobby.js`:
   - Add rules for the 7 missing classes (`.your-role-badge`, `.char-badge`, `.char-badge-cell`, `.user-you-tag`, `.lobby-user-name`, `.cast-status-pill`, `.status-dot`, `.assigned-to-me`).
   - Add a `.tag-host` token class.
   - Remove the "LOBBY" badge and the duplicate "Leave room" button.
6. **Q** `static/css/style.css`: the contrast and type floor.
   - Readable meta uses `--foreground-muted`.
   - Mono at least 11px and readable text at least 12px across pack cards, the HUD and the rack.
   - A `:focus-visible` ring with `--ring` on `.pack-card`, `.btn-big-record`, `.color-option` and the line chips.
   - `prefers-reduced-motion` overrides for `pulse-halo`, `pulse-recording` and `btn-finished-pulse`.
   - (added from full critique) Extend the same floor to the audio meter's scale and zone legend, the premiere's "More music/More voice" and dB labels, the export's saved path, reassurance line and step list, and the Pack Builder stepper and timeline hint (`builder.css`). All of these use `--foreground-dim` at about 3.3:1. Keep `--foreground-dim` for dividers and decoration only.
   - (added from full critique) Add reduced-motion overrides for `.connection-dot`, the export reel (`spinFilmReel`, `.reel-pulse-ring`) and the Pack Builder radar pulse.
6a. **Q** `static/css/style.css`, `static/css/builder.css`: shared button and status states. (added from full critique)
   - One global `.btn:disabled` / `.btn[aria-disabled=true]` style: muted surface, dim text, no glow, `cursor:not-allowed`. Today no rule exists, so Pack Builder's disabled "Process video" looks like a live amber CTA.
   - A `.btn-danger` variant on `--accent-red` for irreversible actions, starting with "Remove Pack Builder" in Audio settings (now amber primary).
   - Status-text classes: muted for "not yet", green with a check for done, amber for needs attention, red for errors. Audio settings uses them in step 40d.
7. **Q** `static/js/ui_common.js`, `static/css/style.css`: toasts.
   - Anchored bottom centre, at most 420px wide, at most 3 visible.
   - Error toasts get `role=alert`, a Close button and no auto-dismiss.
   - Add `updateToast(id, …)` for in-place progress.
8. **Q** `static/js/app.js`: drop the socket-echo "Take saved" toast for your own takes (around line 917).
9. **Q** `static/js/studio/lobby.js`, `static/index.html`, `static/css/style.css`: cast HUD.
   - In the lobby, hide progress and ready counts.
   - "2 roles" with a focusable tooltip.
   - Remove `aria-live` from `#cast-activity-bar`. Add one visually hidden live region for discrete events.
9a. **Q** `static/js/app.js` (`renderConnectionState`), `static/js/room_socket.js`, `static/index.html`, `static/css/style.css`: the reconnecting banner. (added from full critique)
   - Honest copy: "Lost the room. Your changes will send when it's back." When the 50-message queue overflows, emit an event instead of dropping silently, and switch the copy to "Some changes from the last minute didn't reach the room."
   - A small text button in the pill: "Retry now" (calls `connect()` at once) while reconnecting, "Reload" on the stale-tab notice.
   - After about 5 failed attempts (about 1 minute), stop and show a terminal message: "Can't reach the room. The host may have closed it." with Try again and Back to lobby.
   - Amber for reconnecting and connecting; red only for the terminal state, because red means recording. Slow or stop the pulse. "Back online" uses `--accent-teal` instead of literals.
   - Let the countdown tick from a stored deadline, or drop the number ("Reconnecting… (try 3)").
   - Announce only real state changes (lost, back, gave up) through the hidden live region from step 9, not every rewrite. Text at least 12px.
   - Below about 1280px, show a short form (dot plus "Reconnecting…") with the full sentence in the tooltip.
   - The booth's offline state and kept takes are step 16 and step 22a.
9b. **Q** `static/js/shortcuts.js`, `static/css/style.css`, `tests/test_shortcut_sheet.js`: the `?` sheet. (added from full critique)
   - Tag each group with its view and filter when the sheet opens (from `app.currentView`), not once at init. The current screen's group comes first, then Everywhere. Optional: a collapsed, dimmed "On other screens" section.
   - Rename the groups to the screen names ("Choose a scene", "Booth", "Premiere") and test that each matches its crumb.
   - Nudge rows say what moves: "[ Move my take 25 ms earlier", "] Move my take 25 ms later", "Shift + [ / ] Same, by 100 ms".
   - Layout: one grid with `grid-template-columns: max-content 1fr`, a card of about 420-460px, and more space above a group heading than below.
   - Key caps 12-13px mono at weight 600, 24-26px tall, with a visible edge (`--border-wood`, a darker bottom border). Labels 14px.
   - In Pack Builder, title the group "In the editor", and on other steps show one muted line: "These work once your video is in the editor."
9c. **S** `static/js/studio/timing.js`, `static/js/studio/mic_sync.js`, `static/index.html`, tests: clap sync must not save noise (**dep: BF-3**). (added from full critique; audio settings P0)
   - BF-3 makes the rule accept normal human timing (4 claps within ±40 ms of the median). It doesn't stop a periodic beep or noise passing, which is how 305 ms was saved with nobody clapping. Add rejection on top: too many onsets outside the beat windows or in the silent lead and tail, or onset spacing that doesn't match the 600 ms beat.
   - Show the result before saving: "Heard 6 claps. Takes will move 305 ms earlier." with Use this and Try again.
   - Add "Forget sync".
   - While clapping: an 8-dot metronome that lights on each beat and fills when a clap is heard, the room check's progress bar, and a busy style for "Listening…" instead of the bright primary. Show BF-3's mic error lines inside the panel, not only as a toast.

### Phase U2: booth right column, layout A (after BF-1; steps 13, 14 and 19 also after BF-4)

10. **Q** `static/js/studio/booth.js`, `static/index.html`: one timing-offset readout.
    - Remove `#waveform-offset-legend` and the always-on canvas label.
    - `loadBoothLine` goes through `setNudgeValue`.
    - "Auto" becomes "Reset to auto" and looks active only at `auto_offset_ms`.
    - Fix the gain badge: compare `take.gain_db`, not the 0.5-step slider.
11. **Q** `static/js/studio/booth.js`: copy.
    - "Line 1 of 3 · 0.9 s", with the time range moved to a tooltip.
    - One-decimal durations everywhere.
    - "Counting in… Space or click to cancel".
    - ● in every idle state.
    - The record `aria-label` and tooltip change per state.
12. **Q** `static/js/studio/booth.js`, `static/index.html`: host toolbar.
    - One primary, "Start premiere · 0/2 ready". Remove the "Premiere ›" duplicate.
    - Promote Mark ready to "All recorded · Mark ready" when every line has a take.
    - Use the same Finish/Done logic for host and guests. Ask inline when lines have no take.
    - Replace the host `confirm()` with `openDialog`.
13. **S** `static/index.html`, `static/css/style.css`: the column skeleton.
    - Pinned record deck, a scrolling middle (`overflow-y:auto`) and a pinned footer.
    - Order: Record, Takes, Voice, Monitor.
    - Remove `.advanced-rack-box` `max-height` and the nested scroll.
    - A height breakpoint at 800px or less.
    - The waveform box gets a minimum height (two lanes of at least 32px plus the axis), and the drag hint moves into the timing row.
14. **S** `static/js/studio/booth.js` (`renderTakeHistory`), `static/js/studio/takes.js`, `static/css/style.css`: the TAKES card.
    - Shown in the page flow from 0 takes, with the empty and single-take states.
    - Radio pick, the green "In the dub" row, sync in words, and a "⋯" menu holding Delete (with Undo) and Play.
    - Remove the popover and `#btn-clear-take` from the nav.
    - This replaces the interim "Takes (N)" button from BF-1.
15. **S** `static/js/studio/booth.js`, `static/js/shortcuts.js`: take keyboard flow.
    - `T`, `↑`/`↓`, `P`, `Enter`, `Delete`, `A`, as a roving tabindex.
    - Add these entries to the `?` sheet.
    - (added from full critique) Add previous/next line keys, `,` and `.`, the same keys the premiere uses to jump between lines (step 40c). Today moving between lines needs the mouse.
    - (added from full critique) Show each key as a quiet hint in the matching control's tooltip, the way the record button already says "Record (Space)".
16. **S** `static/js/studio/booth.js`, `static/index.html`: the record deck.
    - Bind the state badge to real state, including NO MIC from the BF-3 mic errors.
    - (added from full critique) Add an OFFLINE state from the connection state (step 9a), with one line under the button: "Takes will upload when you're back online." While reconnecting, also dim the waveform's "Your take" row, so the problem shows where the user is looking and not only in the header pill.
    - The segmented transport replaces `#btn-toggle-ab` and Original/Preview. Disable "Take N" until a take exists.
17. **S** `static/index.html`, `static/css/style.css`, `static/js/studio/booth.js`: the monitor strip.
    - Backing slider plus "Count-in" and "Hear original" switches.
    - Remove the rockers, grille fill and screws from control bodies; keep the faceplate headers.
18. **S** `static/js/studio/voice_rack.js`, `static/js/studio/booth.js`, `static/index.html`: the VOICE card.
    - Visible before the first take.
    - The "For" scope menu with an inline confirm row instead of `window.confirm`.
    - The Level row: knob, value, "✓ Matched", Auto. Remove the unlabelled meter.
    - "All effects ›" becomes a bordered secondary button.
19. **S** `static/js/studio/voice_rack.js`, `static/css/style.css`, `static/index.html`: the rack as a column page.
    - "‹ Back · Custom · N on" header.
    - Off modules collapse to one row.
    - The record deck goes compact.
    - `E` and `Esc` open and close it.
    - Add tooltips to Pitch and Reverb.
    - (added from full critique) Every visible readout is full contrast, since dimmed readouts are about 3.1:1. If the chain still doesn't fit at 1440x900 with off modules collapsed, show on modules as a one-line summary ("Compress · −24 dB · 4:1") and expand one at a time.
    - (added from full critique) Plain dial labels: "Cut below", "Silence below", "Tame S above", "Boost after", "Delay before", "Room size". Drop the Mix dial from Low cut and Gate.
    - (added from full critique) Knobs 36-40px with a 44px hit area, switches 40×22, and "All effects" at least 28px tall with a count. A plain `--card` surface behind the rack text; the diamond pattern only on the faceplate header.
20. **Q** `static/js/knob.js`, `static/js/studio/voice_rack.js`: wheel and save behaviour.
    - The wheel adjusts only a focused knob; otherwise it scrolls.
    - Turning a dial on an off module no longer switches it on.
    - Debounce wheel saves like drag saves.
    - (added from full critique) When the panel is locked (a take is processing), give each knob wrapper `aria-disabled="true"` and `tabIndex=-1`, and make the wheel, key and drag handlers return early. Today only the hidden range inputs are disabled.
21. **S** `static/js/studio/booth.js`, `static/js/waveform.js`, `static/css/style.css`: live recording feedback.
    - A REC tally plus remaining time in the video corner.
    - A live input trace in the take lane from `readInputLevel()`/`recordAnalyser` (**dep: BF-4**).
    - Line-end and tail marks.
22. **S** `static/js/studio/booth.js`, `static/index.html`, `static/css/style.css`: non-blocking save.
    - Remove `#booth-processing-overlay`.
    - Add an inline saving state in the lane, the record button and the badge.
    - Lock only re-recording on that line.
    - Line chips show "saving".
22a. **S** `static/js/studio/booth.js`, `static/js/studio/takes.js`, `static/css/style.css`: never throw a take away (**dep: step 14, step 22, step 9a**). (added from full critique; reconnecting banner P1)
    - When the take upload fails, keep the recorded blob (in memory, plus IndexedDB if cheap) instead of resetting and toasting "That take didn't save. Record it again."
    - Show it in the TAKES card as "Take 4 · waiting to upload". Retry automatically when the connection comes back, and offer a manual Retry in the row.
23. **Q** `static/js/studio/booth.js`, `static/css/style.css`: line chips.
    - Chips become `<button>`s with `aria-current="step"`.
    - Labels like "Line 6, Black Guy 3, recorded, 3 takes".
    - A visible take count.
    - Chip numbering matches the stage bar.
24. **Q** `static/js/studio/mic_sync.js`, `static/js/studio/booth.js`: show the mic-sync advice as a dismissible inline hint in the record deck instead of a toast.

### Phase U3: lobby

25. **S** `dubmate/room_ws.py`, `static/js/studio/lobby.js`, tests: the guest lobby.
    - The server accepts `assign_role` from a non-host only when the target is that guest and the character is unassigned.
    - The UI headline is "Pick who you'll voice", with one-click "I'll voice Black Guy 5 · 1 line" buttons.
    - Characters held by others are read-only.
26. **S** `static/js/studio/lobby.js`, `static/index.html`, `static/css/style.css`: the right rail.
    - The Scene panel shows a video poster, plus the hovered or selected character's first line with "Play this line".
    - Remove the sidebar Cast list and the noise card. Noise reduction moves to the Voice card from step 18, with a one-line description.
    - Remove the 480px height cap.
27. **S** `static/js/studio/lobby.js`: casting table additions.
    - A Takes column ("2 of 3 recorded"). Clicking it opens the booth on that character's first line with the TAKES card focused (**dep: step 14**).
    - A "Cast evenly" secondary action.
    - An inline note "2 characters keep the original voice".

### Phase U4: landing, join and packs

28. **Q** `static/js/studio/packs.js`, `static/js/studio/lobby.js`, `static/index.html`: scene choice.
    - `renderPacks()` never writes `selectedPackId`. When search hides the selected pack, show a chip "Selected: … (hidden by search)".
    - No pre-selection on first run.
    - The button reads "Create room · <scene>", or is disabled with "Pick a scene to start".
29. **Q** `static/js/studio/packs.js`, `static/css/style.css`: pack cards.
    - A `role=radiogroup` with a roving tabindex; Enter on the selected card creates the room.
    - One meta line ("6 lines · 5 characters · 6s · by Tani").
    - A format badge only for CV packs; chips sorted naturally, capped at about 4 with "+N", in sans 12px.
    - Share as `btn-secondary btn-sm`, at least 28px, in a fixed slot.
    - No hover lift.
    - JS-rendered states use token classes: `.empty-state`, `.search-match-quote`, the SVG spinner.
30. **Q** `static/index.html`, `static/css/style.css`, `static/js/app.js`: landing hierarchy (**dep: BF-2**, which gates `#btn-open-pack-folder`).
    - One amber primary; "Create pack" becomes secondary.
    - Packs folder and Rescan move into a "⋯" menu.
    - A neutral "4 scenes" count.
    - The hero shows only on first run; the accent is solid instead of gradient.
    - The toolbar wraps.
    - Tablist ARIA; headings become h2.
31. **Q** `dubmate/packs_api.py`, `static/js/app.js` (`friendlyError`), `static/js/studio/packs.js`: import errors.
    - Plain copy for zip and signature errors.
    - One toast per import, updated in place.
    - Drop the duplicate loading modal (**dep: step 7**).
32. **S** `static/js/studio/sessions.js`, `static/js/app.js` (router), session API module if fields are missing: the session rows.
    - Rows show the take count and who recorded, cast dots and the room code.
    - A "Takes" deep link (`?takes=1`, opens booth step 14).
    - Rooms with no takes are listed too.
    - Delete uses `openDialog` with the take count.
    - A quiet "2 sessions · 14 takes" chip on pack cards.
33. **Q** `static/index.html`, `static/js/app.js`, `static/js/studio/lobby.js`, `static/css/style.css`: one shared 8-hue palette.
    - Native radio inputs styled as swatches, a 40px hit area.
    - Default to the first hue nobody in the room has.
    - Used by both pickers.
34. **Q** `static/js/studio/lobby.js`, `static/js/studio/packs.js`: the join modal and the Packs folder modal open through `openDialog`, which gives Escape, a focus trap and returned focus. Remove the custom backdrop and Escape code.
35. **S** `static/js/studio/lobby.js`, `static/index.html`, `static/css/style.css`: join flow (**dep: BF-6, BF-7**).
    - Check the code before the name step; show "Finding room…" on the button.
    - An inline `aria-invalid` error under the code field.
    - A persistent "Joining Tani's room · 9SL94U" interstitial.
    - The modal shows the host, the scene thumbnail and who's there; the button reads "Join as Mika".
    - First-time guests get an empty name field.
    - The landing "Join" submit becomes primary, with a 6-character mask and paste-a-link support.
    - Rename "Copy invite" to "Copy code" when it copies a code.
    - (added from full critique) Wrap the field and button in a `<form>` so Enter submits, and give every `.code-input` a normal placeholder (`::placeholder { text-transform:none; letter-spacing:normal; font-family:var(--font-sans) }`). Remove `maxlength=6` and take the code from a pasted link (`searchParams.get('room')`), with the hint "Room code or invite link".
35a. **S** `static/js/app.js` (`leaveRoom`, `showView`, init routing), `static/js/studio/lobby.js`, `static/index.html`, `static/css/style.css`: the "You left" view (**dep: BF-2, BF-6, BF-7, step 35**). (added from full critique)
    - When the page isn't served by the guest's own engine, hide Audio, `?`, the mode-switch chevron and the logo menu, and show the plain wordmark. Today Audio opens the host's settings and the menu links to the host's Studio and Pack Builder. BF-2 already stops the server sending the export path.
    - Keep the left state across reloads: `replaceState` to `/?left=CODE` (which also fixes Back reopening `?room=` without a view change), and route it to view-left on init. A tunnel page with no home origin never renders the landing view.
    - Keep the code: "You left room DUB789" with a primary "Rejoin DUB789" (`promptJoinRoom(code)`, keeping the name and colour), and a secondary "Join a different room" field prefilled with the code.
    - Two or three plain lines: where their takes are and that the room is still open, plus a quiet "Get DubMate" link. Check the takes claim against the engine before shipping the copy.
    - One compact column of 420-480px, centred vertically, heading about 1.75rem at weight 700; less glow on the card, so the primary is the brightest thing on screen.
    - Errors inline under the field with `aria-invalid` and `aria-describedby`, keeping the entered text. Focus moves to the primary when the view opens.
36. **S** `dubmate/packs_api.py`, `static/js/studio/packs.js`, `static/index.html`: the Share modal (**dep: BF-2**, for `require_own_computer`).
    - Opens immediately in a "Packing scene…" state.
    - The file name and size are the main line, with the folder truncated in the middle.
    - "Show in folder" uses a new local-only reveal endpoint.
    - One file name everywhere; reuse the zip when the pack hasn't changed.
37. **S** `pack_loader.py`, `app.py`, `static/js/studio/packs.js`, `static/index.html`: the Packs folder (**dep: BF-2**).
    - A shared folder-field component.
    - A count for the chosen folder plus an "Also loaded from" line.
    - A "Use default folder" button.
    - Honest outcome copy, plus `role=status`.
    - In the desktop app, "Browse…" through `tauri-plugin-dialog` (adds `tauri/src-tauri/Cargo.toml` and capabilities).
38. **S** `pack_loader.py`, `dubmate/packs_api.py`, `static/js/studio/packs.js`: poster frames. When a pack has no icon, generate a 16:9 frame at the first line's start and use it as the card header.

### Phase U5: polish and records (added from full critique: now also the launcher, premiere, export, audio settings and Pack Builder fixes)

39. **Q** `tauri/` splash and launcher HTML/CSS: warm tokens, an SVG warning icon instead of the emoji, and sentence-case "Show details".
    - (added from full critique) Port the studio's tokens into the launcher's `:root`. Bundle Plus Jakarta Sans and JetBrains Mono as local woff2 in `tauri/src`, because the engine and the internet may not be up yet. Use the studio's wordmark, and set `tauri.conf.json` `backgroundColor` to `#12100e` so the window, launcher and studio are one colour.
    - (added from full critique) Contrast: dark text (`#12100e`) on the amber button (white is 3.19:1). Details toggle and done-stage labels on the muted token at 11-12px.
    - (added from full critique) Status in the body font at 14-15px; mono only for numbers and the details log. Stage labels in sentence case at 11-12px, with check marks on done stages.
39a. **S** `tauri/src/launcher.js`, `tauri/src/index.html`, `tauri/src-tauri/src/sidecars.rs`, `main.rs`, `updater.rs`: an honest launcher. (added from full critique)
    - One source of startup text: Rust sends staged events ("Starting the engine", "Loading your scenes", "Checking for updates"), and the JS poll stops writing the text. After about 8 s show "Still starting · 12 s".
    - A slow start stays on the neutral splash with "Taking longer than usual" and a secondary "Restart DubMate" link. The red card is only for real failures sent by Rust. Base the JS timeout on elapsed time, not poll count.
    - The update card says "Updating to DubMate {version}". Drop the raw release body or clamp it to three lines with Markdown stripped, and let the body scroll as a safety net.
    - Error buttons depend on the error. Engine failure: "Restart DubMate" and "Copy details". Pack Builder or update failure: "Open DubMate", which enters the studio without restarting, and "Retry install". "Open in browser" only after `/health` answers, through the opener plugin.
    - Error copy: the title is the cause ("Another app is using DubMate's port"), the body is the action in the body font, Show/Hide details toggles its label, and the details use `overflow-wrap:anywhere`.
    - Accessibility: `role=status` with `aria-live=polite` on the splash text, `role=progressbar` with `aria-valuenow`/`min`/`max`/`aria-valuetext` on the bar, `role=alert` on the error card, focus to its primary, a reduced-motion state for the spinner and sheen, and the title as an h1.
39b. **S** `tauri/src/launcher.js`, `tauri/src-tauri/` (install command), `static/index.html`, `static/js/app.js`: Pack Builder installs in the background. (added from full critique; launcher P1, principle 5)
    - Enter the studio as soon as the engine is healthy. Show the 2 GB install as a compact progress chip in the studio header and on the Pack Builder link, using the same four stages.
    - If that is too big for this pass, add "Open DubMate now" (primary; the install continues) and "Install later" to the launcher card first.
    - The update download offers "Skip this time" when it isn't a first-run download, and both downloads show time remaining once the speed is stable.
40. **S** (re-tagged from Q, added from full critique) `static/js/studio/export.js`, `static/index.html`, `static/js/app.js`: the export modal.
    - A single title ("Your dub is ready").
    - Order the actions primary, then downloads, then Close last. (amended from full critique: the text Close goes; see Actions below.)
    - Shorten the saved-to path in the middle.
    - (added from full critique) **No fake progress.** Use the existing indeterminate bar (or only the step strip) until the engine reports real ffmpeg progress. On ready, stop the reel and pulse and show a static check.
    - (added from full critique) **A real failed state:** red badge, the title "The export didn't finish", the friendly reason, a static alert icon, and Try again (primary) plus Close. After the 3-minute timeout, show only "Keep working" and the "video will show up here" line. Watch, Download and Show in folder appear only after `handleExportSuccess`.
    - (added from full critique) **Done:** hide the badges, the step strip and the bar. The subtitle carries the facts ("16:9 · 0:06 · in DubMate Exports"), with the full path in a tooltip.
    - (added from full critique) **Actions:** a full-width "Watch the dub" that closes the modal and starts playback (today Watch and Close do the same thing), then the two formats as a pair. On the host, "Show in folder" (the reveal endpoint from step 36) and "Make 9:16 version", which renders visibly. "Download 16:9/9:16" only for remote members, where it really downloads. Remove the text Close; X and Esc are enough.
    - (added from full critique) Open it through `openDialog()` with an Esc guard while rendering, move focus in, return it to the Save control, and give the track `role=progressbar` with `aria-valuetext` set to the step name.
    - (added from full critique) Guests get no modal when the host exports, only a passive "Host is exporting…" line. The "keep this window open" line shows only to the client that started the render.
40a. **S** `static/js/studio/screening.js`, `static/js/studio/export.js`, `static/index.html`, `static/css/style.css`: the premiere screen (**dep: step 2, step 36**). (added from full critique; premiere P1 x4, export P1 x3)
    - The video owns the screen: exclude `#view-screening` from the booth's `max-height:720px` `.video-container` rule (it crushes the video to about 158px), size the theater to about 60vh or more, and drop the separate title card.
    - One primary, Play/Pause. Replace Export video, both download rows, Project files and Stems with one secondary "Save" split button: the video in the current shape, Video 16:9, Video 9:16 (renders on demand with inline progress), and under "For editing", "Separate tracks (WAV)" and "Editing project (.zip)". Retire `#export-progress-box`. Save's label tracks state: "Save video", "Saving…", "Saved ✓", "Mix changed · Save again".
    - Save keeps a fixed min-width and shows "Preparing…" inline without shifting the row. Results stay in the Save menu ("Separate tracks · saved · Show in folder"), not in a 3.2-second toast.
    - Remove the 16:9/9:16 toggle (no CSS exists for `.shorts-mode`, so it changes nothing), or render a real 9:16 frame.
    - Colours: an amber "Live" dot instead of the recording red, no green on save actions, and "Final video" as plain text next to Save.
    - Guests see Play/Replay (local), the scrubber from 40c and "Download video". No dialogue-level control, no Stems or Project files.
    - One "Mix" disclosure, closed by default, that combines MIX and Dialogue level: "Balanced", "Voices forward", "Music forward", with "Fine-tune" revealing the sliders and dB only there.
    - For remote members the header Audio tooltip reads "Microphone and headphones", and it closes when the dialog opens.
40b. **S** `dubmate/room_ws.py` (`launch_premiere`, balance), `dubmate/rooms_api.py`, export pipeline, `static/js/studio/screening.js`, `static/js/app.js`, tests: an honest premiere mix. (added from full critique; premiere P0 and P1 x2)
    - Store the MIX balance on the room through a socket message and pass it to `export_dub_video`, like dialogue level. If that can't land soon, remove the slider rather than ship a control that does nothing.
    - On any mix change, broadcast `export_invalidated` (or include it in `dialogue_presence_sync`). Every client switches to the live mix (`applyLiveMixToTheater`), hides "Final video", and Save says "Mix changed. Save renders a new video."
    - `launch_premiere` sends everyone to the premiere at once on the live Web Audio mix, then renders the MP4 in a background task that broadcasts `export_started`, progress, and `export_ready`/`export_failed`, as `POST /export` does. Swap to the MP4 at the next pause, never mid-play. A failure shows a plain message with Retry, not only a server log line.
40c. **S** `static/js/studio/screening.js`, `static/index.html`, `static/css/style.css`, `static/js/shortcuts.js`: the premiere timeline and "In this dub" (**dep: step 14, step 12**). (added from full critique; premiere P1, premiere and export P2)
    - A slim timeline under the video with elapsed and total time, ticks at each line's start in the character's colour, and click/drag to seek. Host seeks broadcast `screening_control` "seek"; guest seeks stay local. `←`/`→` for 5 s, `,`/`.` for previous/next line, listed in the `?` sheet.
    - A compact line list under the timeline (open by default for the host): character, speaker, and "Take 3 of 5" or a dimmed "Original voice · Unrecorded". A row click seeks; "Change take" opens the booth on that line with the TAKES card focused.
    - Step 12's "Start premiere" says how many lines will use original voices.
40d. **S** `static/js/studio/audio_setup.js`, `room_check.js`, `static/index.html`, `static/css/style.css`: Audio settings (**dep: BF-2, BF-3, BF-4, step 6a**). (added from full critique)
    - **The meter (P1).** One quantity (peak or short-term loudness) drives the bar, its zones and the hint. Zones are Too quiet (dim), Good (green), Too loud (red); today green means "Quiet". The hint is worked out over a rolling 2-3 s and goes back to neutral. Numbers move to a tooltip. One shared level target drives the meter, the hint and "Check your loudest line" (today -12..-3 vs -10..-6), drawn as a band on the meter.
    - **The denied step (P1).** Detect desktop app vs browser and the OS, show one short list, and put the rest behind "Using something else?". In the desktop app, a button opens the OS privacy page. Drop the duplicate subtitle sentence.
    - Status lines and the mic pill use the status classes from 6a instead of all-brass.
    - A sticky footer so Done is always reachable at 1280x720. "Remove Pack Builder" uses `.btn-danger`.
    - The room-check error card gets its own "Check again" button.
    - First run: title "Set up your mic", one hero line ("So you can record your lines. Audio stays on this computer."), SVG icons instead of 🎙️ 🚫 🎧. Drop the "AUDIO SETUP" badge.
40e. **S** `dubmate/builder_api.py`, `static/js/pack_builder.js`, `static/builder.html`, `static/css/builder.css`: Pack Builder knows what is installed. (added from full critique; Pack Builder P1 x2, P2)
    - A capability route (separation, transcription, link import) read at load.
    - Step 1 reflects it: Paste link shows a one-line explanation and install steps when import is missing; Subtitles says it is needed when transcription is missing, and the button reads "Process video without lines".
    - The pill uses one signal (can the AI steps use the GPU), a neutral dot for CPU, and hides when no AI tools are installed. Today it says "Fast processing" with a green dot, then "Standard processing", on the same machine.
    - Hide or `aria-disable` Transcribe (with the reason) when transcription is missing. Show Romaji only for Japanese.
40f. **S** `static/js/pack_builder.js`, `static/builder.html`, `static/css/builder.css`: processing failures and progress. (added from full critique; Pack Builder P0, P1 x2, P2)
    - A real error state: stop the radar pulse, mark the failed stage red, show the message once. Actions: "Try again" (re-POST `/process` for the same session, no re-upload), "Back to video" (file and options kept), and, when transcription is missing, "Write the lines myself" (opens the editor empty).
    - "Cancel" while processing.
    - Check an SRT when it's dropped ("12 lines · 3 speakers found" or a clear error). If the server import fails later, stop and say so instead of falling through to transcription. A × on the subtitle and cover chips.
    - All stages start pending; an Upload stage driven by XHR progress; ticks only on finished stages; the headline and stage line from one source.
40g. **S** `static/js/pack_builder.js`, `static/builder.html`, `static/js/shortcuts.js`: never lose editor work. (added from full critique; Pack Builder P1 x2, shortcut sheet P2)
    - Keep the session in the URL (`?session=`) and reopen the editor on reload. A `beforeunload` guard while editing, and Exit confirms.
    - "Line deleted · Undo" for 6 s, plus Ctrl+Z, listed in the `?` sheet. Until undo exists, drop Backspace as a delete key.
    - Replace `prompt()` and `confirm()` for cast members with inline editing.
    - Done steps in the stepper become buttons (`aria-current="step"` on the active one), with Back to Video and Back to Edit lines. `setStep` pushes history so browser Back stays inside Pack Builder. After a build, the fields lock or offer "Edited? Build again".
40h. **S** `static/js/pack_builder.js` (`renderSegmentsList`, timeline), `static/css/builder.css`: the Lines column. (added from full critique; Pack Builder P1 x2, P2 x2)
    - Each line becomes a compact row of about 44px (dot, #, character select, single-line text, timecode). Play, Transcribe, Romaji and Delete show only on the selected or hovered row, or in a "⋯" menu. Aim for 10 or more lines at 1440x900.
    - A listbox: rows get `tabindex`, `role="option"` and `aria-selected`; Up/Down move; a focused textarea selects its line; a visible focus ring. Start/End with nothing selected say "Select a line first" instead of adding a line.
    - One filled primary (Continue); Play neutral, Add line and Transcribe secondary, no purple. The character palette drops `#dc2626` and `#16a34a`, which mean recording and confirmed take.
    - Cast chips scroll in one row (owner request, see `pack-builder-editor-fixes.md`; this replaces "Cast chips wrap"). Clip labels drop the "[Black Guy 1]" prefix and use 11px sans.
40i. **Q** `static/builder.html`, `static/js/pack_builder.js`: Pack ready. (added from full critique; Pack Builder P1)
    - "Record it now" (renamed from Try it) is the primary. "Download .zip" becomes a quiet "Save a copy (.zip)" link. Drop "Go to Studio" and the duplicate "is ready" toast.
41. **Q** `scripts/` (dev-only screenshot script, playwright-core from a temp dir): capture every view at 1440x900, 1366x768 and 1280x720, as a release check for the booth column. (added from full critique) Capture the launcher at its real 960x680 window, and the header with the reconnecting pill at 1280 and 1024.
42. **Q** `CHANGELOG.md`, `documentation/ROADMAP.md`: record the UI pass and mark the bug-fix PR's "UI pass" line as done.

**Totals.**

| | Steps |
|---|---|
| Quick wins (Q) | 28: 1-12, 6a, 9a, 9b, 20, 23, 24, 28-31, 33, 34, 39, 40i, 41, 42 (added from full critique: 6a, 9a, 9b, 40i; 40 moved to S) |
| Structural (S) | 31: 9c, 13-19, 21, 22, 22a, 25-27, 32, 35, 35a, 36-38, 39a, 39b, 40, 40a-40h (added from full critique: 9c, 22a, 35a, 39a, 39b, 40, 40a-40h) |
| Directly dependent on the bug-fix PR | 2 (hardening), 9c (BF-3), 10-24 and 22a (BF-1, and BF-4 for 21), 30, 31 (via 7 only), 35, 35a, 36, 37, 40 and 40a (BF-2 via 36), 40d (BF-2, BF-3, BF-4) |

**What the bug-fix PR already covers. Don't redo it, build on it:**
- the takes indicator from the first take (step 14 replaces it with the full card);
- the export, Packs folder and Pack Builder rows hidden off the engine's computer;
- `GET /api/config` redaction and the own-computer guard;
- the live meter during tests;
- the join handoff (name, colour, devices, mic sync), so there's no second name prompt.
- (added from full critique) the `set_status` host check, in the hardening (step 2 only verifies it);
- (added from full critique) a looser clap rule and plain mic error lines (BF-3). It doesn't reject noise that passes as claps; step 9c adds that.

---

## 5. Open decisions for the owner

1. **Layout A or B for the booth's right column?** *Recommendation: A.* Takes and presets stay visible together, and it matches "Presets first, the full rack one click away". If 1280x720 still feels cramped after step 13, move only the Monitor strip under the waveform, which is B's best idea.
2. **Saving in the background: may people move to the next line while a take is still saving?** *Recommendation: yes.* Lock only re-recording that line and mark its chip "saving". This needs the save pipeline to accept a line change mid-upload. If that is risky, ship the inline saving state first and keep the line locked.
3. **The mouse wheel on knobs.** DESIGN.md promises "scroll wheel" support. *Recommendation:* the wheel adjusts a knob only while that knob has keyboard focus (click or Tab to it first). Otherwise it scrolls the page. The alternative is Shift+wheel, which is less discoverable.
4. **The lobby's right rail: a scene preview, or just remove it?** *Recommendation:* remove the duplicate Cast list and the noise card now (step 26). Build the scene preview, video poster plus "Play this line", in the same step, because it tells the host who "Black Guy 3" is before casting. If time is short, let the casting table go full width and do the preview later.
5. **Which is the source of truth for the look: `style.css` (espresso/walnut) or DESIGN.md's frontmatter (plum/wine)?** *Recommendation: `style.css`.* It is what you tested and what all the critiques judged. Regenerate DESIGN.md from it (step 1) and drop the 8 and 9px mono tokens. A move to the plum palette would be a redesign of the look, and nothing in the evidence calls for one.

## 6. Owner decisions (2026-10-07)
1. Booth right column: **Layout A (stacked column)**.
2. Next line while a take saves: **yes, lock only the line being saved**.
3. Mouse wheel only on a focused knob: **yes**.
4. Lobby right rail becomes a scene preview (after removing duplicates): **yes**.
5. style.css is the source of truth; rewrite DESIGN.md from it and drop the 8–9px mono sizes: **yes**.

Routing: the host-only guards (set_status, set_dialogue_presence, POST /export, /export/stems, /export/project_zip), the premiere mix not reaching the export, and clap-sync noise rejection (step 9c) move into the bug-fix PR's hardening (fix/first-test-findings), because they are correctness and security bugs, not UI.
