# Design: UI pass U1, readability and accessibility floors

Phase U1 ("guards and floors") of the owner's UI pass. The full plan, with per-surface verdicts, the 59 steps and the owner's decisions of 2026-10-07, is copied into the repo by step 1 as `design/ui-plan.md`. This doc converts its U1 steps (1, 3, 4, 5, 6, 6a, 7, 8, 9, 9a, 9b, as amended "(added from full critique)") into commits. It does not redesign anything. Branch `ui/u1-floors`, based on `main` at `c9ca8c4`.

**Owner decisions that bind this PR** (plan section 6): `style.css` is the source of truth for the look; DESIGN.md is rewritten from it and the 8 and 9px mono sizes go. Every surface is an Operate surface, so this is refinement: same palette, fonts, wood and brass, same layouts.

**Routed elsewhere.** The host-only server guards (plan step 2: `set_status`, `set_dialogue_presence`, `POST /export`, `/export/stems`, `/export/project_zip`) and clap-sync noise rejection (step 9c) are in the bug-fix PR `fix/first-test-findings`. So are the takes button, Audio settings mic sync and room check logic, and the join handoff. This PR only touches those surfaces through shared classes.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| No text smaller than 11px. Labels, badges and mono readouts are at least 11px; sentences, meta lines and hints at least 12px. Meta text uses the muted ivory (6.9:1 on cards) instead of the dim brown (3.3:1). | Everywhere, Pack Builder stepper and timeline hint | Default |
| A visible brass focus ring (2px, offset 2px) on every button, the record button, pack cards, colour swatches and line chips when reached by keyboard. | Everywhere | Keyboard only |
| With reduced motion on, the recording pulse, the record halo, the Finish pulse, the connection dot, the export reel and the Pack Builder radar stop moving. The state they show stays visible (colour, ring, text). | Booth, header, export, Pack Builder | Default (OS setting) |
| Disabled buttons look disabled: muted surface, dim text, no glow, a not-allowed cursor. Pack Builder's "Process video" no longer looks live before a video is chosen. | Everywhere | Default |
| "Remove" in the Remove Pack Builder confirm row is red, not amber. | Audio settings (desktop app) | One click away (inside the confirm row) |
| Toasts appear at the bottom centre, at most 420px wide, at most 3 at once (the oldest goes). Error toasts stay until closed, have a Close button and are announced at once. | Everywhere | Only when it happens |
| Your own take no longer says "Take saved" twice. Other people's takes still show "Mika recorded line 2". | Booth | Only when it happens |
| When the room refuses something (for example a guest's casting change), a toast says why and the page reloads the room's real state instead of showing a change that didn't happen. | Lobby, booth | Only when it happens |
| Guests no longer see "Start recording". They see "Waiting for Tani to start recording". | Lobby | Default (guests) |
| Guests see who voices each character as text (colour dot and name) instead of a dropdown. Only the host gets the dropdowns. | Lobby | Default |
| The casting table lists characters in natural order (Black Guy 2 before Black Guy 10), says "1 line" / "2 lines", and the empty choice reads "Original voice". The dropdown fills its column. | Lobby | Default |
| The lobby's "LOBBY" badge and its second "Leave room" button are gone; the header's Leave stays. "Your role", the Host tag, the online pills and the cast list get real styles (seven classes had none). | Lobby | Default |
| In the lobby the cast strip shows who is here and their roles, without progress or ready counts. Someone with several characters shows "2 roles", with the names in a tooltip that also opens on keyboard focus. | Cast strip | Default; names in a tooltip |
| Screen readers hear joins, leaves, "is ready" and connection changes once, instead of every rewrite of the cast strip. | Hidden live region | Assistive tech only |
| Losing the connection shows an amber pill "Lost the room. Reconnecting…" with a "Retry now" button. After about a minute of failed tries it stops and shows a red "Can't reach the room. The host may have closed it." with "Try again" and "Leave room". Below 1280px wide the pill shortens to "Reconnecting…" with the full sentence in its tooltip. | Header | Only when it happens |
| If changes made while offline overflow the queue, the pill says "Some changes from the last minute didn't reach the room." and the same line stays as a toast after reconnecting. | Header, toast | Only when it happens |
| The stale-tab notice ("DubMate was updated…") gets a "Reload" button. "Back online" uses the token green. | Header | Only when it happens |
| The `?` sheet shows the current screen's keys first, then Everywhere, then a closed "On other screens" section. Groups are named after the screens: "Choose a scene", "Booth", "Premiere", and "In the editor" in Pack Builder. Nudge rows say what moves: "Move my take 25 ms earlier" / "later", "Same, by 100 ms". Bigger key caps with a visible edge. | `?` sheet | One key away; other screens one click inside it |

Copy follows PRODUCT.md: plain, outcome-first, no implementation names. New strings: "Waiting for {host} to start recording" ("the host" when the name is unknown), "Original voice", "Your role", "{n} roles", "Lost the room. Reconnecting…", "Reconnecting…", "Retry now", "Can't reach the room. The host may have closed it.", "Try again", "Leave room", "Some changes from the last minute didn't reach the room.", "Reload", "Close", "{name} joined", "{name} left", "{name} is ready", "On other screens", "These work once your video is in the editor.", and the sheet labels above. The reconnecting pill's tooltip: "Casting and ready changes are sent when it's back. Wait for it before you record."

## Data shapes, on-disk layout, API and WebSocket

- **No on-disk change.** No config, room state, take, pack or localStorage key is added or changed.
- **No new route and no new socket message.** The client starts handling two things the server already sends:
  - `{"type": "error", "payload": {"message": …}}` (today only from `assign_role`; the bug-fix PR's hardening adds more with the same shape) and the connect-time `{"type": "error", "message": "Room not found"}`.
  - After an `error`, it reads `GET /api/rooms/{room_id}` (existing, returns `room.to_state_dict()`) and applies it through `applyIncomingState`, then re-renders exactly as a broadcast does.
- **Client-only additions.**
  - `ui_common.js`: `showToast(message, { tone })` (`tone: 'error'`), `plural(n, word)`, `announce(text)`.
  - `room_socket.js`: a `'failed'` connection state after `MAX_RECONNECT_ATTEMPTS = 5`, `retryNow()`, and a `queue_overflow` event emitted once per outage.
  - `shortcuts.js`: each group gets a `view` (`landing`, `booth`, `screening`, `editor`, `any`), and `initShortcutSheet` takes `getView()`. The sheet's content is rebuilt each time it opens.

## Migration of existing data

None needed: nothing persisted changes. Two tests guard against the drift that caused this pass: `tests/test_design_tokens.js` checks that every colour in DESIGN.md's frontmatter exists in `style.css :root` and that DESIGN.md has no token under 11px; `tests/test_css_floors.js` checks the type, contrast, focus and reduced-motion floors on `style.css`, `builder.css` and the two HTML files.

## Export, render, project ZIP

Unchanged. This PR changes no audio, mix, render or file path. The export modal only gets the type and contrast floor on its saved path, reassurance line and step list, and reduced motion on its reel.

## Not in this PR

- The host-only server guards (plan step 2) and clap-sync noise rejection (9c): bug-fix PR.
- `updateToast(id, …)` (plan step 7): its first caller is the import toast in step 31 (U4), so it lands there.
- Status-text classes (plan step 6a): their first user is Audio settings in step 40d (U5b), so they land there.
- The booth's right column, takes UI, line chips as buttons, the rack and knob wheel (U2); the lobby right rail and guest self-casting (U3); scene choice, pack cards as a radio group, colour swatches as radios, the join and Packs folder modals through `openDialog` (U4); launcher, premiere, export, Audio settings and Pack Builder flows (U5). The focus ring added here applies to pack cards, swatches and chips as soon as those steps make them focusable.
- Pack Builder timeline internals (`.ruler-tick`, `.segment-block-label` and the clip label beside it) stay under 11px until the Lines column is rebuilt in step 40h; they sit inside fixed timeline geometry.
- Emoji spinners and the hero gradient (U4), the `?` sheet's take and line keys (U2 step 15).
- No `.impeccable/design.json` sidecar; DESIGN.md stays at `documentation/DESIGN.md`.
- The plan's mockup and screenshot images stay outside the repo.

## Risks

- **Merge conflicts with `fix/first-test-findings`.** Both touch `app.js`, `lobby.js`, `index.html`, `style.css` and `test_frontend.js`. The edits are in different functions (this PR: socket handlers, `renderConnectionState`, `renderLobbyState`, `renderCastActivityHUD`; the bug-fix PR: `initRouter`, `joinRoom`, `renderTakeHistory`, Audio settings rows). Whichever merges second rebases; the orchestrator's merge order decides.
- **Bigger text in the booth's right column.** That column already clips at 1280x720 (plan problem 2; fixed in U2). Raising 8.5 to 11px labels there can push it further. Each step compares which booth controls are reachable before and after at 1280x720 and 960x680; if one that was reachable no longer is, tighten that card's padding instead of keeping text small.
- **Bottom-centre toasts** can cover part of the waveform or the Pack Builder timeline for about 3 seconds. They are narrow, pass clicks around themselves, and at most 3 show.
- **Reconnect stops after about a minute.** A host whose engine takes longer to come back leaves guests on the red message until they press Try again. Today they retry forever, every 30 s.
- **The error handler's refetch** costs one GET per refused message. It runs only after a server `error`.
- **Disabled styling** now applies to every `.btn:disabled`. A button that was disabled but meant to look busy (for example "Preparing…") now looks disabled, which is correct; screenshots check the export and stems buttons.

## Decided overnight, revisit

1. **Focus ring colour.** The plan says `--ring`, but `--ring` is brass at 40% alpha (2.3:1 on cards, below the 3:1 non-text minimum). The ring is a 2px solid `--accent-brass` outline with a 2px offset (7.7:1), and the existing `.btn:focus-visible` box-shadow switches to it, so there is one focus style. `--ring` stays for input glows.
2. **The floor** is 11px for any text, including labels, badges and mono readouts, and 12px for sentences, meta and hints. The plan's "11px mono, 12px for anything that must be read" is read that way.
3. **`updateToast` and the status-text classes** are left to their first callers (steps 31 and 40d), to avoid helpers nobody uses yet.
4. **Error tone** is used only by the new socket error handler and the offline-send warning. Other failure toasts keep auto-dismissing until their surfaces are reworked.
5. **Reconnecting copy.** The plan's "Your changes will send when it's back" over-claims until step 22a: takes and voice changes go over HTTP and aren't queued. The pill says "Lost the room. Reconnecting…", and the tooltip says which changes do wait ("Casting and ready changes are sent when it's back. Wait for it before you record.").
6. **The countdown number is dropped**, not ticked from a deadline.
7. **The red state offers "Leave room"**, not "Back to lobby": the lobby needs the connection that just failed.
8. **"Room not found" makes no toast.** It arrives on every reconnect, so the pill handles it.
9. **The lobby's own "Leave room" goes** and the header's Leave stays, because the header one is on every room screen.
10. **Rows are found by comparing `tr.dataset.character`**, not with `CSS.escape`. Same result, and it works in JSDOM.
11. **"On other screens"** is included in the `?` sheet as a closed `<details>`, so the lobby (which has no keys of its own) still leads to them.
12. **The live region announces** joins, leaves, "is ready" and the connection changes. Takes by others are not announced there, because their toast already is.
13. **The HUD in the lobby** hides progress and the ready summary only; the location badge stays.
14. **"YOUR ROLE"** becomes "Your role" in the markup, styled as a badge.
15. **ROADMAP.** If the bug-fix PR's "UI pass" line exists when step 9 runs, U1 is marked done on it; otherwise step 9 adds that line with U1 done and U2 to U5 listed.
16. **The plan copy** is verbatim, with a three-line note on top. The PNG mockups aren't copied.

## Implementation steps

Every step: work in `X:/Projects_X/DubMate-wt/ui-u1` on `ui/u1-floors`, one commit, full suite green (`X:/Projects_X/DubMate/.venv/Scripts/python.exe tests/run_all_tests.py`). Visual steps take before/after headless screenshots at 1440x900, 1280x720 and 960x680 (method in each step), outside the repo.

1. **The plan in the repo.** `documentation/design/ui-plan.md`, a verbatim copy including section 6 (owner decisions).
2. **DESIGN.md from style.css.** A rewrite in the impeccable `document` format from the real tokens: the plum frontmatter goes, as do `mono-xs` and `mono-micro`. Adds the floor, decoration, one-primary, green and red rules. Plus `tests/test_design_tokens.js`.
3. **Type, contrast, focus and motion floors** (plan step 6). `style.css`, `builder.css`, inline sizes in `index.html`; `tests/test_css_floors.js`.
4. **Shared button states and toasts** (plan steps 6a, 7, 8). `.btn:disabled`, `.btn-danger`, toasts at the bottom centre with an error tone, and no own-take echo toast; `tests/test_toasts.js` plus a `test_frontend.js` case.
5. **Guests in the lobby** (plan steps 3, 4, 5). The socket error handler and fresh state, guests without "Start recording", read-only casting for guests, lobby fixes and the missing lobby styles; `tests/test_lobby_guest.js`.
6. **Cast strip and the live region** (plan step 9). `tests/test_cast_hud.js`, and the HUD case in `test_frontend.js` updated.
7. **Reconnecting pill** (plan step 9a). `room_socket.js` stops after 5 tries, adds Retry now, emits overflow; `renderConnectionState`; `tests/test_room_socket.js` and `tests/test_connection_banner.js`.
8. **The `?` sheet by screen** (plan step 9b). `shortcuts.js`, its CSS, `tests/test_shortcut_sheet.js`.
9. **CHANGELOG and ROADMAP.**
