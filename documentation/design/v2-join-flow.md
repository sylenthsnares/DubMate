# Design: 2.0 joining, names, colours and the lobby

Branch `ui/v2-join-flow`, built on `ui/v2-booth-layout` (its `--space-1..5` tokens and the shared `presence.js` stack). The owner asked: "just joining, choosing, names, colors, the entire UX of that. For example why are some colors on the main screen but more colors on the choosing / joining screen? ... I think that entire flow needs to be rethought and streamlined."

The spec is the measured flow audit (`dubmate_ui/v2-layout/flow/join-flow-audit.md`), its mocks (`flow/mock-*.png`) and the second opinion (`dubmate_ui/v2-layout/critique.md`). Where they differ, corrections C3 to C6 and conflicts X1 to X9 win. This replaces `ui-plan.md` Phase U3 (steps 25 to 27) and U4 steps 28 to 35a. Steps 31 (import errors) and 32 (session rows) are not about joining; they stay open in `ui-plan.md` for a later PR.

Out of scope (other PRs): the booth beyond placing the stack (`ui/v2-booth-layout`), premiere and export (u5a; the premiere keeps its cast strip), the Audio settings modal and the launcher (u5b), Pack Builder (u5c).

## Goal

Today a person answers "who are you" up to three times from two palettes (5 hues on the landing, 10 in the join modal, 6 of them UI signal colours, two of them 2.7 ΔE apart), everyone starts on amber, a link guest meets two stacked modals, the host casts by hand with two clicks per character while friends wait with nothing to do, and leaving forgets the code. After this PR: one identity set once, one 8-hue palette unique per room, three screens to the booth for every persona, casting done for you with a way to override, and the mic set up in the lobby while you wait.

## Owner decisions this implements (decided overnight, revisit)

1. **One identity.** Name and colour are set once and reused on the landing, join, lobby, booth and premiere. Names are capped at 24 characters everywhere (client `maxlength`, handoff, server). No renaming inside a room for now.
2. **One 8-hue person palette, Palette B,** held in one place: Coral `#f08a6c`, Lime `#b5cf5a`, Mint `#6fd3a8`, Cornflower `#7d9cf0`, Orchid `#d987d9`, Pink `#ec4899`, Cyan `#06b6d4`, Blush `#e9a3b8`. None equals the record red, the done green or the amber (closest: Coral, 16.9 ΔE from amber, C5). The initial always sits on the colour (C6). The server gives each person a colour nobody in the room has, with a 9th-person rule. Older saved colours still load.
3. **Landing:** no New/Join tabs, no preselected scene, "Start a room ›" names the chosen scene, Enter on a focused scene card starts it, every scene card is keyboard reachable.
4. **Joining:** members joining from their own DubMate skip any join prompt (identity comes through the `#dm=` handoff from PR #19). Link guests get one join card with the host, the scene and who's here; the code is checked first. No stacked modals.
5. **Casting:** each newcomer is auto-cast to the free character with the most lines. Guests can pick ("I'll voice X" / "Give back"); the server accepts `assign_role` from a non-host only for themselves and only for an unassigned character. The host keeps the override and "Cast evenly". A one-time notice: "Tani's room gave you Old Man". Progress ("2 of 3 recorded") sits in the Lines column. "Ready" means premiere-ready only (X6).
6. **Lobby right rail:** a scene preview (video poster plus the hovered or selected character's first line with "▶ Play this line"), the mic card under it. The duplicate Cast list and the noise card go (the noise switch lives in All effects, booth PR).
7. **First-run mic setup** moves from the launch modal to a lobby card: device, level and sync, including "take your earbuds out" before the loud clicks (PR #19 behaviour kept). The booth keeps its NO MIC badge for anyone who skips it.
8. **The casting panel's scrollbar stays styled** (its `scrollbar-width: thin` switched off the WebKit scrollbar rules; `test_css_floors.js` missed it because it only checks `overflow`/`overflow-x`).

## Layout and behaviour

Room screens (landing, join card, lobby, You left) use the booth PR's scale with X2's room values: card padding 16 (`--space-4`), gaps 16, column gap 24 (`--space-5`), 24 only between page regions. No 5, 9, 10, 14, 18 or 20 px layout values. One inset per card: headers, table cells and footers share the card's content line (X3). One amber per view.

### Identity (one module)

- **`static/js/identity.js`** is the single source: `IDENTITY_COLORS` (8 `{ name, hex }` in the order above), `LEGACY_COLORS` (old hex → name), `normalizeColor(hex)`, `NAME_MAX = 24`, `cleanName(s)`, and `renderColorPicker(container, { selected, taken, label })`.
  - The file keeps a fixed literal format. **`dubmate/identity.py` reads the same file** at import and extracts both tables with a strict pattern; it raises if it finds anything but 8 hues. So there is one list, not two kept in step. It finds `static/` with app.py's `find_static_dir` candidate search, moved into `dubmate/common.py` (app.py calls it from there; `dubmate/*` never imports app).
  - Avatars everywhere use `presence.js` `avatarHtml`/`avatarEl` (espresso initial on the colour; 20, 28 and 44 px). The 8 px `.actor-color-dot`, `.join-modal-avatar-preview` and the white-initial variant go.
- **Legacy map** (fixed table, critique section 4; nearest ΔE2000 except Purple, which goes to Orchid to stay apart from Violet): Amber, Red, Bronze, Yellow → Coral; Gold → Lime; Green and `#25d3a4` → Mint; Violet, `#7c5cff`, `#8a6eff` → Cornflower; Purple → Orchid; Pink → Pink; Cyan → Cyan. Any other valid hex → Coral on the client (the server then makes it unique).
- **Picker:** native `<input type="radio">` in a `fieldset` (one tab stop, arrow keys move, Space selects), each a 28 px swatch with a 40 px hit area, the hue's name as its label. Your own selected swatch shows your initial. A hue someone in the room holds is `disabled`, shows their initial, and reads "Coral, taken by Tani".
- **Saved identity** (`dubmate_user`): `loadUser()` maps a legacy colour through the table and saves it back (one-time, no toast, nothing else changes). No more random "Actor 393": a first-run name is empty, and Start or Join asks for it inline ("Type your name first", focus moves to the field). The server's last-resort default stays "Actor".
- **Header identity pill** shows on every screen, the landing included (avatar 22 + name). Display only; its tooltip in a room says "Your name and colour in this room".

### Server (colour, names, casting)

- **`pick_color(room, wanted, user_id)`** in `dubmate/identity.py`, used by `create_room`, the socket `join` and nothing else:
  - `wanted` is normalized (legacy table; invalid or unknown → none).
  - Taken = colours of other users in the room. Prefer `wanted` if nobody else holds it; else the first palette hue nobody else holds (online or offline).
  - **9th person:** when all 8 are held, offline holders don't count; if still none is free, take the hue held by the fewest online people, earliest in palette order. The initial tells the two apart (C6).
  - A rejoining user keeps their room colour unless an online person took it meanwhile.
- **Names:** `cleanName` on the server too: strip, collapse whitespace, cut to 24. The handoff accepts up to 40 (older members) and cuts to 24.
- **`common.sanitize_color` fallbacks** (`#7c5cff`, `#25d3a4`, `#8a6eff`) go; the restored-room path keeps whatever colour is stored (no data loss) until that person joins again.
- **`join`** broadcasts `user_joined` with `{ user_id, color, wanted_color, cast }`. The joiner's client shows "Coral is taken here, so you're Lime in this room." when `color` differs from what it sent; `cast` drives the one-time casting notice.
- **Auto-cast:** on a user id's first join of a room while `status == "lobby"`, give them the unassigned character with the most lines (ties: pack order). The room creator gets the same rule in `Room.__init__` (today: `characters[0]`). No auto-cast during recording or premiere, none on a rejoin, none when no character is free.
- **`assign_role` from a non-host:** allowed when `user_ids == [self]` and the character is unassigned (claim), or `user_ids == []` and the character is exactly `[self]` (give back). Anything else keeps `_refuse` ("Mika is voicing Courier now." for a lost race). The host's rules don't change.
- **`cast_evenly`** (host only, new message): deal every character, most lines first, to the online person with the fewest lines so far (ties: host first, then join order). Unknown to older clients, which never send it.

### Landing (`mock-landing.png`)

```
header: logo · ············ · [T Tani] · Audio · ?
hero (first run only, until the first room is started or joined)
recent sessions (unchanged, local engine only)
| You (300)                     | Choose a scene · 16 scenes   [search /] [Make a scene] [⋯] |
|  (T) Your name [Tani      ]   |  cards: role=radiogroup, roving tabindex                     |
|  Your colour  ● ● ● ● ● ● ● ● |                                                             |
|  Friends see this name and    |                                                             |
|  colour in every room.        |                                                             |
|  ───────────────────────────  |  ─ pinned bar ───────────────────────────────────────────── |
|  Join a friend's room         |  [thumb] Rooftop Standoff · 8 lines · 5 characters · 19 s   |
|  [Room code or invite link][Join] |                               [Start a room ›] (amber) |
```

- **No tabs.** `#tab-btn-*`, `#panel-create-room`, `#panel-join-room` go. The "You" card holds identity and "Join a friend's room": one `<form>` with a field ("Room code or invite link", no `maxlength`, normal-case placeholder) and a secondary "Join".
  - The field accepts a code, a `/join/CODE` registry link or a `?room=CODE` link. A pasted direct link to another origin goes straight there with `home` and the `#dm=` handoff, without the registry.
  - Join shows "Finding room…" (disabled) while it resolves. A wrong code shows an inline `aria-invalid` error under the field ("No room 9UK6PX. Check the code, or ask the host for a new link."), keeping the text. No toast, no view change.
- **Scenes:** no preselection, ever (`renderPacks` never writes `selectedPackId`). Cards are a `role=radiogroup` with roving tabindex: arrows move and select, Space selects, **Enter on a focused card starts the room**, click selects. When search hides the selected scene, the bar keeps it and says "(hidden by search)".
- **Pinned bar** at the bottom of the scene panel: thumbnail, name, "8 lines · 5 characters · 19 s", and the view's one amber: "Start a room ›" (`aria-label` "Start a room with Rooftop Standoff"). With nothing chosen: disabled, reading "Pick a scene". C3: count cards as visible only when clear of the bar.
- **Toolbar:** "Create pack" becomes a secondary "Make a scene" (one amber). Import, Packs folder and Rescan move into a "⋯" menu button. The count is a neutral "16 scenes". Headings are `h2`. The Packs folder modal opens through `openDialog` (U4 step 34).

### Join card for link guests (`mock-join.png`)

- **A view, not a modal** (`#view-join`), routed on `?room=CODE` without a handoff. `#modal-join-room` is deleted, so nothing can stack.
- **The code first:** the card opens in "Finding room…", calls `GET /api/rooms/CODE`, then fills in. On 404 it says "Room CODE isn't open. Ask the host for a new link." with a code-or-link field and Join (same form as the landing).
- **Content, one column of 480:** 16:9 poster (the pack icon, else the video at the first line's start, `preload=metadata`), "Join Tani's room", "Rooftop Standoff · 8 lines · 5 characters", "Here now" with 20 px avatars and names, "Your name" (empty on a first visit, else the saved name), "Your colour" (the picker with taken hues marked; preselected: the saved colour if free, else the first free hue), the amber "Join as Sam ›" (reads "Join ›", disabled, while the name is empty), and one muted line: "You'll check your mic in the room while friends join."
- Enter submits. Focus starts in the name field. The chosen identity is saved on this origin, so a returning guest needs one click.

### Members from their own DubMate

- Landing → code or link → Join → "Finding room…" → navigate to the host's page with `#dm=` (identity, devices, mic sync, noise setting). The host's page joins straight into the room (already true in `initRouter`). **No modal**. The version check stays a toast.
- A local room (same engine) joins directly with the landing identity.

### Lobby (`mock-lobby.png`, `mock-lobby-guest.png`)

```
title row (no card): Rooftop Standoff (20/800) · 8 lines · 5 characters · 19 s
                     right: [(T)(M)(S) stack] 3 here · [Copy invite link] · [Start recording ›] | "Tani starts the recording"
gap 24
| Who voices who                  [Cast evenly] | scene preview (poster 16:9)                |
| Character | Voiced by            | Lines     |  OLD MAN · 1 LINE                          |
| Mika      | (T) [Tani (you) ▾]   | 3 lines   |  "Both of you, stop this."                 |
| Old Man   | (S) [Sam ▾]          | 2 of 3 rec|  [▶ Play this line] 0:08   Get this scene  |
| Courier   | ( ) [Original voice ▾]| 1 line   | Check your mic (card, until set)           |
| 2 characters keep the original voice.        |                                             |
```

- **Title row:** the scene name (headline), one meta line, then the shared `renderPresenceStack` (X1; the cast strip is hidden in the lobby, so the booth and lobby show people the same way), a muted "3 here", "Copy invite link" (secondary), and the host's amber "Start recording ›". Guests see muted "Tani starts the recording" instead, or the amber "Back to the booth ›" / "Back to the premiere ›" as today. The old header card, its badge row and the "Give each character an actor" line go.
- **One copy-invite control per view (X8).** "Copy invite link" always copies a link: the registry `join_url` when the code is live, else the tunnel `direct_url`, else this page's `?room=` link with "It works on your network only for now." In the lobby the header room pill shows the code only; on other room screens the pill stays the copy control, with the same action and the tooltip "Copy invite link".
- **Casting card** ("Who voices who" for the host, "Pick who you'll voice" for others), columns Character | Voiced by | Lines:
  - Voiced by: a 28 px avatar (an empty ring for "Original voice"), then the host's `<select>` (unchanged behaviour), or for others the name ("You" for yourself, with a ghost "Give back"), or "Original voice" plus a secondary "I'll voice Courier" on free characters.
  - The person voicing a character who is offline: avatar at 45% opacity, "(offline)" in its accessible name and tooltip.
  - Lines: "3 lines" until a take exists for that character, then "2 of 3 recorded" (X7). The booth deep link of U3 step 27 is left for later.
  - Footer note when any are free: "2 characters keep the original voice."
  - "Cast evenly" (host, secondary small) sends `cast_evenly`; a toast says it's done.
  - Row selection drives the preview: hover or focus within a row previews it, a click pins it. Default: your first character, else the first row. Selected row: `--secondary` background, no coloured side stripe (craft floor).
  - The 480 px cap goes; the card scrolls inside itself only when the window is too short, with the studio scrollbar (Firefox-only `scrollbar-*`).
- **One-time notice** for a non-host whose `user_joined.cast` is set: toast "Tani's room gave you Old Man. Pick another in the list if you like." (once per room, `sessionStorage`).
- **Scene preview** (rail, 360 to 560 px): the pack video (`preload=metadata`, muted until played) seeked to the selected character's first line; label "OLD MAN · 1 LINE" (brass label), the line in Newsreader 17 px, "▶ Play this line" (plays the video from the line's start to its end with its own sound, then stops; becomes "■ Stop"), the start time, and for members with a home engine the ghost "Get this scene" (moved from the title row). Changing the selection stops playback.
- **Below 1100 px wide** the rail drops under the casting card.
- **Removed:** the noise card (`#check-lobby-noise-reduction`; the booth's All effects keeps the switch), the rail Cast list (`#lobby-cast-list`, `#cast-online-count`), the cast strip in the lobby.

### Lobby mic card (replaces the launch modal)

- `initAudioSetupOnBoot` no longer opens Audio settings. It still restores devices and reads the permission. The alert dot on Audio stays.
- **New `static/js/studio/mic_card.js`**, in the rail under the preview, for anyone whose mic isn't set up, or set up but not synced for the current device pair. Title "Check your mic", one muted line "About a minute. Friends can't hear it." Its button is amber for non-hosts (their only task, so the One Amber Rule holds) and secondary for the host.
  1. **Microphone:** "Allow microphone" (the only cold `getUserMedia`, as in Audio settings). Then the input and output selects (`populateDeviceSelect`, `applyInputDevice`, `applyOutputDevice` reused as they are). Blocked: the denial text plus "Open Audio settings" for the recovery steps.
  2. **Level:** the live meter (its own loop on `audio.startInputMonitor`/`readInputLevel`, not the modal's) with "Say your loudest line. Aim for the amber zone." and Next.
  3. **Sync:** the PR #19 copy first, "The clicks are loud. Take out your earbuds or headphones and hold them right next to the mic.", then "Play clicks". Runs, failures and the clap fallback are `mic_sync.js`'s (`runMicSync`, `runClapSync`, `PANEL_COPY`); the card renders the same step through one hook in `showMicSyncPanel`. "Skip sync" is a ghost link.
  - **Done:** the card collapses to one line, "Mic set · Blue Yeti · Change" (Change opens Audio settings). Skipped sync: "Mic set · not synced", and the booth's mic-sync hint shows as today.
- **Members with a handoff** whose setup and sync came along see only the collapsed line.
- **Anyone who skips the card** meets the booth's NO MIC badge and its "Audio settings" action (unchanged). `checkMicReady`'s booth fallback still opens Audio settings.

### You left (U4 step 35a)

- `leaveRoom` uses an in-app confirm through `openDialog` (Escape cancels, focus returns), replacing `confirm()`.
- For a browser guest: `replaceState` to `/?left=CODE`, routed to `#view-left` on load (Back no longer reopens `?room=`).
- One column of 420 to 480, centred: "You left Rooftop Standoff", "The room is still open. Your takes stay in it.", the amber "Rejoin 9UK6PQ" (joins with the saved name and colour, no card: 1 click), then "Join a different room" with the code-or-link field prefilled. Errors inline. Focus starts on Rejoin. (Check the takes sentence against the engine before shipping.)
- On a host's page with no home engine, the left view hides Audio, `?`, the mode chevron and the logo menu, and shows the plain wordmark.

### Words

On the screens this PR touches: **scene** (not pack), **room** (not session), **host** and **friends** (not actor, cast member, guest), **voices / voiced by** (not role), "Copy invite link". "Profile" becomes "You". DESIGN.md: the segmented-tabs example drops "Create Room vs Join Code"; a short "Person colours" section names the 8 hues as data colours set inline, not tokens.

## Targets (before measured on this branch; after targets from the audit, [computed] until measured)

Before: the audit's drivers (`dm_shots/v2-join-flow/tools/`, copied from `flow/drv`, ports 18741/18742, 3 fixture scenes) on this branch, `data/before_*.json`, shots `before-*.png`.

| To the first take | Host before | Host target | Member before | Member target | Guest before | Guest target |
|---|---|---|---|---|---|---|
| Screens | 5 | 3 | 6 + tab state | 3 | 5, 2 stacked | 3, 0 stacked |
| Clicks (layout) | 7 | ~7 | 8 | ~5 | 3 | 3 |
| Clicks (casting) | 6 | 0 (auto-cast) | 0 | 0 | 0 | 0 (+1 to pick) |
| Repeated questions | 0 | 0 | 2 (name, colour) | 0 | 0 (3 on rejoin) | 0 (rejoin 1 click) |
| Colour sets seen / hues | 1 / 5 | 1 / 8 | 2 / 5 then 10 | 1 / 8 | 1 / 10 | 1 / 8 |
| Same colour as someone else | yes (Tani = Sam) | never below 9 people | | | | |

C4: the mic card's clicks are counted where they happen (in the lobby), and the PR table shows the layout effect and the auto-cast effect on separate lines. Screen-level: landing ambers 2 → 1; scene cards focusable 0 → all; swatch tab stops 5/10 → 1; Escape/stacked modals → no modal; lobby panels 5 → 2 (+ mic card); roster copies 3 → 1; name limits 4 → 1; palettes 2 + 3 server fallbacks → 1.

## Outcome (measured after G3)

Measured with the same drivers, engines, 3 fixture scenes, first-run storage and counting rules as the before run (`dm_shots/v2-join-flow/tools/flow_after.js`, `geometry_after.js`, `keyboard_after.js`; data in `data/after_*.json`, shots `after-G4-*.png`). Keystrokes include the Space for the first take. The mic set-up is counted where it happens: before in the two launch dialogs, after as the lobby card's four steps (Allow, Next, Next, then Play clicks or Skip sync).

| To the first take | Host before → after | Member before → after | Guest before → after |
|---|---|---|---|
| Screens | 5 → **3** | 6 + a tab state → **3** | 5 (2 stacked modals) → **3** (0 stacked) |
| Clicks, layout effect | 5 → 5 | 6 → **3** | 1 → 1 |
| Clicks, mic set-up | 2 → 4 | 2 → 4 | 2 → 4 |
| Clicks, auto-cast effect | 6 → **0** | 0 → 0 | 0 → 0 (+1 to pick another) |
| Clicks, total | 13 → **9** | 8 → **7** | 3 → 5 |
| Keystrokes | 5 → 5 | 11 → 11 | 4 → 4 |
| Decisions | 13 → **9** (4 are the mic card) | 8 → 8 (2 repeated → 0) | 4 → 7 (4 mic card, 1 keep or pick a character) |
| Repeated questions | 0 → 0 | **2 → 0** | 0 → 0; rejoin 3 → **0** |
| Colour sets seen / hues | 1 / 5 → 1 / 8 | 2 / 5 then 10 → **1 / 8** | 1 / 10 → 1 / 8, taken hues marked |

- **The layout alone (C4)** saves the member 3 clicks (no tab, no second name and colour prompt) and the host and guest nothing; auto-cast saves the host 6. The mic card costs everyone 2 more clicks than the launch dialogs because it also does level and sync, which the dialogs left optional.
- **Rejoin (guest):** 5 clicks, 6 keys and 3 repeated questions → 3 clicks (Leave, Leave, Rejoin), 0 keys, 0 questions.
- **Colours in the run:** Tani Coral, Mika Lime (asked for Coral; the toast said why), Sam Mint (first free). Before, the host and the guest were both amber.
- **Screen level, 1440x900 and 1280x720:** landing ambers 2 → 1; no tabs; no preselected scene; Start names the scene; scene cards focusable 0 → all (one tab stop, arrows choose, Enter starts); tabs from the name to the first scene 14 → 7; swatch tab stops 5 / 10 → 1 / 1; stacked modals 2 → 0 (the join prompt is a view); a wrong code is inline with the text kept, no toast; lobby panels 5 → 3 (casting, preview, mic card); roster copies besides the table 2 → 1 (the avatar stack); copy-invite controls in the lobby 2 → 1; name limits 4 → 1; palettes in the code 2 + 3 server fallbacks → 1. With 3 fixture scenes all cards sit clear of the pinned bar at both sizes (C3); the first card's top moved from 360 to 286 px with the hero shown.
- **Palette B (`tools/colors.js`):** weakest espresso-initial contrast 5.38:1 (Pink), all ≥ 4.5; closest pair Orchid/Blush 15.3 ΔE; closest to a signal colour Coral/amber 16.9 ΔE.
- **Console:** no errors in the three runs, apart from the member's own engine answering 404 for a code it doesn't host before asking the registry (the same lookup as on `main`).

### Decided while finishing (G4), revisit

- Joining a room no longer flashes "Back online" after the first "Connecting…" (a `main` bug that every link guest now met in the lobby, since no dialog covers it any more). It shows only after a real drop.
- The `.tab-pill` styles stay: `main` now uses them for the premiere's Mix presets (PR #25), and deleting them here would have unstyled those on merge without a conflict. DESIGN.md keeps the segmented-tabs entry, now naming the Mix presets instead of Create Room vs Join Code.

## Implementation groups (build order)

1. **Identity and the server.** `identity.js` + `identity.py`, legacy map, `loadUser` migration and empty first-run name, `pick_color`, name cap, fallbacks removed, `user_joined` payload, auto-cast, guest `assign_role`, `cast_evenly`, `RoomSocket.castEvenly`. Python and JS tests.
2. **Landing, join and leaving.** The landing restructure, scene radiogroup and pinned bar, code-or-link join with inline errors, the join card view, `#modal-join-room` deleted, header identity pill, You left with Rejoin and the in-app confirm, Packs folder via `openDialog`, words.
3. **Lobby.** Title row with the stack and one copy control, the casting card (picks, give back, Cast evenly, progress, offline), the one-time notices, the scene preview, the mic card and the launch modal's removal, the noise card / Cast list / cap removed, the scrollbar fix and its test.
4. **Measure and finish.** Merge `origin/ui/v2-booth-layout` if it moved. Rewrite the drivers' selectors for the new flow, run them at 1440x900 and 1280x720 for host, member and guest, the keyboard and palette checks, after-screenshots, the before → after table, CHANGELOG and DESIGN.md, the full suite.

## Tests

- **New `tests/test_room_identity.py`:** palette parsed from `identity.js` (8 hues, legacy table); `pick_color` (wanted free, taken → first free, offline holders, 9th person, rejoin keeps colour, legacy and unknown hexes, junk strings); name cap on create and join; a restored room with old colours loads with users intact; auto-cast (most lines, ties, lobby only, first join only, none free, creator); guest `assign_role` (claim, give back, refused on a held character, for someone else, several ids); `cast_evenly` (host only, the deal); `user_joined` payload.
- **New `tests/test_identity.js`:** the module, legacy migration in `loadUser` (and nothing else lost), the picker (one tab stop, arrows, taken disabled with initial and label).
- **New `tests/test_landing.js`:** no tabs, no preselection, Start disabled and named, Enter on a card starts, roving tabindex, code-or-link parsing, inline errors kept, name required, one amber, ⋯ menu.
- **New `tests/test_join_card.js`:** code checked first, 404 state, host/scene/here-now, taken colours, Enter, no overlay open on boot or after joining.
- **New `tests/test_lobby_mic_card.js`:** no launch modal; steps; the earbuds copy shows before Play clicks; skip → booth hint; done line; handoff members see the line only.
- **Updated:** `test_join_handoff.js` (no modal, 24-char cut), `test_left_room.js` (Rejoin, `?left=`), `test_lobby_guest.js` (I'll voice / Give back, notice once), `test_cast_hud.js` (strip hidden in the lobby, stack in the title row), `test_version_check.js` (toast only), `test_css_floors.js` (also `overflow-y` scrollers; `.panel-casting` in the Firefox-only block), `test_host_guards.py` (guest claims), `test_frontend.js` and `test_select_pack.js` selectors.
- Full suite: `python tests/run_all_tests.py`.

## Risks

- **Merge with u5b** (Audio settings rewrites `audio_setup.js`, touches `mic_sync.js`): this PR changes only the boot call and one render hook there; the card reuses methods by name. Whoever merges second re-checks `initAudioSetupOnBoot` and `showMicSyncPanel`.
- **Python parsing a JS file:** the format is pinned by a test and the parser fails loudly at import. The engine serves `static/` from the same folder in every build, so the file is always beside `index.html`; check a packaged desktop build starts.
- **Auto-cast surprises a host who casts by hand:** the override is one select per row, and "Original voice" stays an option.
- **Claim races:** the server decides; the loser gets a toast and the real state.
- **Video preview over a tunnel** costs a range request per guest; it loads only `metadata` until played.
- **Old clients** joining a new host: they send old hexes (mapped) and never send `cast_evenly`; a new member joining an old host keeps today's behaviour.
- **Mic card and the booth:** a solo host who goes straight to the booth meets NO MIC there, as designed.

## Decided without the owner

- The palette lives in `identity.js` and the server reads that file; no `--id-*` CSS tokens (person colours are data, set inline).
- The legacy map is a fixed table (critique section 4), Purple → Orchid; unknown hexes → Coral, then made unique by the server.
- First-run names start empty and are asked inline at Start/Join; no random "Actor NNN".
- A room colour that differs from your saved one is per room: your saved colour doesn't change, and a toast says why.
- Auto-cast only in the lobby and only on a person's first join of that room; the creator gets the most-lines character.
- "Cast evenly" deals every character (nobody keeps the original voice) and has no undo.
- The header room pill shows the code only in the lobby; elsewhere it stays the copy control (one copy control per view, no capability lost in the booth).
- "Get this scene" moves from the lobby title row into the scene preview.
- The selected casting row uses a background tint, not the mock's amber side stripe (craft floor).
- The mic card's button is amber for non-hosts (their only task) and secondary for the host.
- The booth deep link from the Lines cell (U3 step 27) is deferred; the cell shows progress only.
- ui-plan steps 31 and 32 stay open; they are not about joining.

### Decided while building G1 (identity and the server), revisit

- `common.sanitize_color` is gone rather than given a new fallback: `identity.normalize_color` is the only colour check on the server and only ever returns one of the 8 palette hexes, so nothing else reaches a style attribute.
- The server treats a colour outside the palette and the legacy table as "no wish" (the first free hue); the client maps it to Coral before sending. Same outcome for one person, and the server never trusts an arbitrary hex.
- Auto-cast (and the creator's character) skips characters with no lines.
- A guest repeating a claim or a give-back is harmless (no refusal). Refusals read "Tani is voicing Old Man now." (someone holds it) or "Only the host can change who voices Old Man." (someone else, several people, a shared character).
- Cast evenly broadcasts a `cast_evenly` message; older pages apply its state through the catch-all handler like any other.
- The "Coral is taken here" toast shows once per room and colour (`sessionStorage`), so a reconnect doesn't repeat it.
- Take uploads cut the uploader's name to 24 too, so the "every name is 24" rule has no back door.
- The landing's and the join prompt's swatches already use the new picker in G1 (the palette must be one list from the first commit); G2 restyles those screens.

### Decided while building G2 (landing, join card, You left), revisit

- The join card hides the header's name pill: it is the screen where you choose the name and colour. Every other screen shows it.
- The first-run Audio settings dialog no longer opens on a `?room=` or `?left=` page, so nothing stacks on the join card or You left (the lobby's mic card, G3, takes over there). The landing keeps it until G3 removes it.
- Someone the room already knows (same id on this origin, with a name), for example a reload of `?room=`, goes straight back in without the card.
- The code-or-link fields on the join card's "isn't open" state and on You left: someone with no name yet who finds a room on this engine gets the join card for it; everyone else goes straight in.
- You left after a reload looks the room up: an open room shows "You left <scene>" and Rejoin; a closed one says "The room has closed." and hides Rejoin (no claim the app can't back). The takes sentence holds: leaving only marks you offline, and takes stay in the room on the host's engine.
- The leave question reads "Leave the room?" / "Your takes stay in it. Rejoin any time with the code X." with Stay (secondary, focused first) and Leave (amber, the dialog's one action). Not red: leaving can be undone.
- A pasted link is read as a code when it is a `/join/CODE` path (any host) or a `?room=` link to this page; a `?room=` link to another page opens that page directly. A code is 3 to 16 letters, digits or dashes.
- The poster on the join card is the video at the first line through a `#t=` media fragment (`preload=metadata`, muted). It is at most 30% of the window's height, so Join stays in view at 960x680.
- The "You" card stays in view (sticky) while the scenes scroll; the scene bar sticks to the bottom of the window (`overflow: clip` on the panel keeps it sticky).
- The hero's accent is solid amber (no gradient text) and scene cards no longer lift on hover. The `.tab-pill` styles went with the tabs (nothing else used them), and DESIGN.md's segmented-tabs entry with them.

### Decided while building G3 (the lobby), revisit

- "Copy invite link" toasts "Invite link copied." whether it copied the public link or the direct one (it never copies a bare code now, so "copied instead" no longer applies). With neither, it copies this page's `?room=` link: "Invite link copied. It works on your network only for now."
- The header room pill keeps its dashed "code not live yet" look in the lobby, but there it is plain text (no role, no tab stop, no tooltip). On the other room screens Enter and Space now copy too (it was a `role=button` that only answered clicks).
- The mic card's button is amber for a friend only while the room is still in the lobby; once recording or the premiere is on, "Back to the booth ›" / "Back to the premiere ›" is the view's amber and the card's button is secondary.
- The level meter keeps running during the sync step, so the clicks and claps show on it; it closes when the card collapses, when the lobby is left, and while Audio settings is open (that dialog's meter has the mic then). It falls back slowly so a short word reads.
- An allowed mic whose device pair is already synced (on the host's computer, or brought along by a member) goes straight to "Mic set · <mic> · Change". Allowed but unsynced starts at the device step, not at Allow.
- "Skip sync" lasts for the tab (sessionStorage), like the old launch dialog's "Skip for now".
- Each character's name is a button: clicking it pins the preview (`aria-pressed`), so keyboard users can preview any row, including someone else's character.
- After a pick or Give back redraws a row, keyboard focus stays in that row (on Give back, else I'll voice, else the name).
- For friends, an offline voice reads "Tani (offline)" in the Voiced by cell; the host's select options say "(offline)" too.
- The preview poster keeps the whole frame (letterboxed, at most 34% of the window's height). Below 1100 px the preview and the mic card sit side by side under the casting card, and the page scrolls instead of the card.
- "Cast evenly" toasts "Characters shared out evenly." when the room confirms.
- The waiting line reads "Tani starts the recording" ("The host starts the recording" before the host's name is known).
- G2 follow-up: leaving to You left keeps the logo menu inert; the booth's recording focus had been giving it back as the view changed.

## Hands-on checks (owner, in the morning)

1. First run as a host: does the landing read "who, what, go"? Pick a scene with the keyboard and press Enter.
2. Join from a second DubMate by code and by pasted link: no prompt, and the same name and colour on the host's page?
3. Open an invite link in a private browser window: is the join card enough to know whose room and what scene? Are taken colours clear?
4. Do the 8 colours fit the warm world? (Palette B is the one look change.)
5. Auto-cast: is "Tani's room gave you Old Man" welcome or surprising? Try "I'll voice", "Give back" and "Cast evenly".
6. Hover characters in the lobby and press "Play this line". Does the preview tell you who a character is?
7. Run the mic card end to end, including the earbuds step and the clicks. Skip it once and check the booth's NO MIC.
8. Leave as a guest and Rejoin in one click; reload on the You left screen.
