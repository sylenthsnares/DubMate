# Design: UI pass U1, readability and accessibility floors

Phase U1 ("guards and floors") of the owner's UI pass. The full plan has per-surface verdicts, 59 steps and the owner's decisions of 2026-10-07. It lives outside the repo at `C:/Users/tanis/AppData/Local/Temp/dubmate_ui/ui-plan.md`, and step 1 copies it into the repo as `design/ui-plan.md`. This doc turns its U1 steps (1 to 9b, as amended "(added from full critique)") into commits. It does not redesign anything. Branch `ui/u1-floors`, based on `main` at `c9ca8c4`.

This revision follows a claim audit of the first draft. It lists all 13 unstyled lobby classes, makes "Room not found" end the retries, and splits the two steps that were too big.

**Owner decisions that bind this PR** (plan section 6): `style.css` is the source of truth for the look. DESIGN.md is rewritten from it, and the 8 and 9px mono sizes go. Every surface is an Operate surface, so this is refinement. The palette, fonts, wood and brass, and layouts all stay the same.

**What the bug-fix PR does instead.** The owner's routing (plan section 6) puts every host-only server guard (`set_status`, `set_dialogue_presence`, `POST /export`, `/export/stems`, `/export/project_zip`) and clap noise rejection (step 9c) in the bug-fix PR `fix/first-test-findings`. U1 does none of them and doesn't touch `dubmate/room_ws.py` or `dubmate/rooms_api.py`. U1 hides "Start recording" from guests on screen; the server refusal for a guest's `set_status` comes with that PR.

U1 still keeps away from the takes button, the Audio settings mic-sync and room-check logic, and the join handoff. Those surfaces only change here through shared classes.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| No text smaller than 11px. Labels, badges and mono readouts are at least 11px. Sentences, meta lines and hints are at least 12px. Meta text uses the muted ivory (6.9:1 on cards) instead of the dim brown (3.3:1). | Studio and Pack Builder (the launcher's 10px text is fixed in U5a; three Pack Builder timeline labels wait for 40h) | Default |
| A visible brass focus ring (2px, offset 2px) on every button, the record button, pack cards, colour swatches and line chips when reached by keyboard. | Studio, Pack Builder | Keyboard only |
| With reduced motion on, these stop moving: the recording pulse, record halo, Finish pulse, connection dot, export reel and Pack Builder radar. The state they show stays visible through colour, ring and text. | Booth, header, export, Pack Builder | Default (OS setting) |
| Disabled buttons look disabled: muted surface, dim text, no glow, a not-allowed cursor. Pack Builder's "Process video" no longer looks live before a video is chosen. | Studio, Pack Builder | Default |
| "Remove" in the Remove Pack Builder confirm row is red, not amber. | Audio settings (desktop app) | One click away (inside the confirm row) |
| Toasts appear at the bottom centre, at most 420px wide, with at most 3 at once (the oldest goes). Error toasts stay until closed, have a Close button and are announced at once. Each toast is read out alone. | Everywhere | Only when it happens |
| Your own take no longer says "Take saved" twice. Other people's takes still show "Mika recorded line 2". | Booth | Only when it happens |
| When the room refuses something (for example a guest's casting change), a toast says why. The page then reloads the room's real state instead of showing a change that didn't happen. | Lobby, booth | Only when it happens |
| Guests no longer see "Start recording". In the lobby they see "Waiting for Tani to start recording". If recording has already started, they see "Back to the booth", which only moves them; while the premiere is on, "Back to the premiere". The waiting line and these buttons follow the room's status even while the guest is on another screen. | Lobby | Default (guests) |
| Guests see who voices each character as text (colour dot and name) instead of a dropdown. Only the host gets the dropdowns. | Lobby | Default |
| The casting table lists characters in natural order (Black Guy 2 before Black Guy 10). Counts read "1 line" / "2 lines", and the empty choice reads "Original voice". The dropdown fills its column. | Lobby | Default |
| The lobby's "LOBBY" badge and its second "Leave room" button are gone; the header's Leave stays, and stays in the window down to 960px: in a room below 1280px the logo shows only its icon, and while the connection pill asks for attention the room code and your name step aside. The pill's sentence is the only thing that shrinks (with an ellipsis). All 13 lobby classes that had no styles get real ones: "Your role", the You tag, the online pills and dots, the line count, and the character badges. The Host tag uses a new `.tag-host`. | Lobby | Default |
| In the lobby, the cast strip shows who is here and their roles, without progress or ready counts. Someone with several characters shows "2 roles", with the names in a tooltip that also opens on keyboard focus. | Cast strip | Default; names in a tooltip |
| Screen readers hear joins, leaves, "is ready" and connection changes once each, instead of every rewrite of the cast strip. | Hidden live region | Assistive tech only |
| Losing the connection shows an amber pill, "Lost the room. Reconnecting…", with a "Retry now" button. After 5 failed tries (30 to 60 seconds), or straight away if the engine says the room is gone, it stops. The host's own page (served by this machine's engine) keeps trying every 15 to 30 seconds instead, because that engine comes back after a restart however long it takes; only "room is gone" stops it. It then shows a red "Can't reach the room. The host may have closed it." with "Try again" and "Leave room". Below 1280px wide, the amber pill shortens to "Reconnecting…" with the full sentence in its tooltip; the long sentences (gave up, dropped changes, updated) shorten below 1440px. After any reconnect the page sends where you are and whether you're ready again, because the engine's join forgets them. | Header | Only when it happens |
| If changes made while offline overflow the queue, the pill says "Some changes from the last minute didn't reach the room." The same line stays as a toast after reconnecting. | Header, toast | Only when it happens |
| The stale-tab notice ("DubMate was updated…") gets a "Reload" button. "Back online" uses the token green. | Header | Only when it happens |
| The `?` sheet shows the current screen's keys first, then Everywhere, then a closed "On other screens" section. Groups are named after the screens: "Choose a scene", "Booth", "Premiere", and "In the editor" in Pack Builder. Nudge rows say what moves: "Move my take 25 ms earlier" / "later", and "Same, by 100 ms". Key caps are bigger, with a visible edge. | `?` sheet | One key away; other screens one click inside it |

Copy follows PRODUCT.md: plain, outcome-first, no implementation names. The new strings are:

- **Lobby:** "Waiting for {host} to start recording" ("the host" when the name is unknown), "Back to the booth", "Back to the premiere", "Original voice", "Your role", "{n} roles".
- **Connection:** "Lost the room. Reconnecting…", "Reconnecting…", "Retry now", "Can't reach the room. The host may have closed it.", "Try again", "Leave room", "Some changes from the last minute didn't reach the room.", "Reload", "Close".
- **Announcements:** "{name} joined", "{name} left", "{name} is ready".
- **`?` sheet:** "On other screens", "These work once your video is in the editor.", and the sheet labels above.
- **Tooltips:**
  - Amber pill: "Casting and ready changes are sent when it's back. Wait for it before you record."
  - Red pill: "If Try again gets through, it sends what changed while it was reconnecting, and whether you're ready. Other changes made now aren't saved."

## Data shapes, on-disk layout, API and WebSocket

- **No on-disk change.** No config, room state, take, pack or localStorage key is added or changed.
- **No server change, no new route and no new socket message type.** Today `assign_role` is the one sender of a refusal; the bug-fix PR's `set_status` guard will be a second.
- **The client starts handling two shapes the server already sends:**
  - **Refused message:** `{"type": "error", "payload": {"message": …}}`. The handler toasts the message with the error tone, then reads `GET /api/rooms/{room_id}`, which returns the state object on its own (`rooms_api.py:79-82`). It wraps the result as `{ state }` for `applyIncomingState` and re-renders, the same way the `'*'` handler does after a broadcast.
  - **Connect-time error:** `{"type": "error", "message": "Room not found"}`, with a top-level `message` and no `payload`. The server sends it only when the room id isn't in `ROOMS`, then closes. It gets no toast and no GET. `room_socket.js` marks the room as gone, so `onclose` goes straight to `'failed'` instead of retrying. It matches on the missing `payload`, not on the text.
- **Client-only additions:**
  - **`ui_common.js`:** `showToast(message, { tone })` (`tone: 'error'`), `plural(n, word)`, `announce(text)`.
  - **`room_socket.js`:**
    - A `'failed'` connection state after `MAX_RECONNECT_ATTEMPTS = 5`, or at once on a connect-time error. A page on a loopback host (`isOwnEngine()`: localhost, 127.0.0.1, [::1]) never reaches the attempt limit; only the connect-time error ends its retries.
    - `retryNow()`.
    - A `queue_overflow` event, emitted once per outage when the 50-message cap drops one.
    - `pendingMessages` are kept in `'failed'`. Try again (`retryNow()`) flushes them on open. Leave calls `disconnect()`, which drops them deliberately, as today. Sends made while in `'failed'` take today's `send_failed` path ("You're offline. That change wasn't saved."), except `broadcastMyStatus()`, which skips the send: app.js sends where you are and whether you're ready again on every reconnect.
  - **`shortcuts.js`:**
    - Each group gets a `view` field (`landing`, `lobby`, `booth`, `screening`, `editor`, `any`) **alongside** the existing `page` field, which `test_shortcut_sheet.js` filters on.
    - `initShortcutSheet` takes `getView()`, and the sheet's content is rebuilt each time it opens.
- **Who counts as host on the client.** Casting dropdowns and "Start recording" use `isHost({ allowDummy: true })`, which matches the server's `host_id == "host"` rule.
- **Mixed versions:** an old page still shows guests "Start recording". Until the bug-fix PR's `set_status` guard lands, pressing it there moves the room as it does today.

## Migration of existing data

None is needed, because nothing persisted changes. Two tests guard against the drift that caused this pass:

- `tests/test_design_tokens.js` checks two things: every colour in DESIGN.md's frontmatter exists in `style.css :root`, and DESIGN.md has no type token under 11px.
- `tests/test_css_floors.js` checks the type, contrast, focus and reduced-motion floors on `style.css`, `builder.css`, `index.html` and `builder.html`. It has an explicit, commented exemption list:
  - `.ruler-tick`, `.segment-block-label` and `.segment-inline-delete-btn` wait for step 40h.
  - Any glyph-only button the sweep finds is named one by one with its reason.

The test reads CSS and HTML only. JS inline sizes are out of its reach:

- The 10px gear emoji in `packs.js`'s "Scanning…" badge is an icon, and emoji spinners go in U4.
- The launcher's `tauri/src/index.html` has three 10px rules, which go with U5a step 39.

## Export, render, project ZIP

Unchanged. This PR changes no audio, mix, render, file path or export route. The export modal only gets the type and contrast floor on its saved path, reassurance line and step list, plus reduced motion on its reel.

## Not in this PR

- **In the bug-fix PR `fix/first-test-findings`** (owner routing, plan section 6):
  - The host-only guards on `set_status`, `set_dialogue_presence`, `POST /export`, `/export/stems` and `/export/project_zip` (plan step 2).
  - Clap noise rejection (step 9c).
- **Left to their first callers:**
  - `updateToast(id, …)` (plan step 7). Its first caller is the import toast in step 31 (U4).
  - The status-text classes (plan step 6a). Their first user is Audio settings in step 40d (U5b).
- **Later phases:**
  - **U2:** the booth's right column, the takes UI, line chips as buttons, the rack and knob wheel.
  - **U3:** the lobby right rail and guest self-casting.
  - **U4:** scene choice, pack cards as a radio group, colour swatches as radios, and the join and Packs folder modals through `openDialog`. The focus ring added here applies to pack cards, swatches and chips as soon as those steps make them focusable.
  - **U5:** the launcher, premiere, export, Audio settings and Pack Builder flows.
- **Small text that stays for now:**
  - The Pack Builder timeline internals listed above stay under 11px until step 40h, because they sit inside fixed timeline geometry.
  - The launcher's 10px text stays until U5a.
- **Other U4 and U2 items:** emoji spinners and the hero gradient (U4), and the `?` sheet's take and line keys (U2 step 15).
- **Not done at all:**
  - No `.impeccable/design.json` sidecar. DESIGN.md stays at `documentation/DESIGN.md`.
  - The plan's mockups and screenshots stay outside the repo.

## Risks

- **Merge conflicts with `fix/first-test-findings`.**
  - Both PRs touch `app.js`, `lobby.js`, `index.html`, `style.css` and `test_frontend.js`.
  - The edits are in different functions:
    - **This PR:** socket handlers, `renderConnectionState`, `renderLobbyState`, `renderCastActivityHUD`, `showToast`.
    - **The bug-fix PR:** `initRouter`, `joinRoom`, `renderTakeHistory`, the Audio settings rows.
  - This PR doesn't touch `room_ws.py`, where the bug-fix PR adds the host-only guards.
  - Whichever PR merges second rebases.
- **Bigger text in the booth's right column.** That column already clips at 1280x720 (plan problem 2, fixed in U2), and raising its 8.5px labels to 11px can push it further. Each visual step lists which booth controls are reachable before and after, at 1280x720 and 960x680. If a control that was reachable no longer is, tighten that card's padding instead of keeping the text small.
- **Test suites that count toasts.** `tests/test_builder_editor.js` counts `.toast` nodes in the DOM and expects `FALLBACK_TOAST` to appear exactly once, and twice across sessions. The cap of 3 can evict it. Step 4 changes that file's `toasts()` helper to record every toast as it is added (a `MutationObserver` on `#toast-container`). The assertions keep their meaning: what was shown, not what is still on screen.
- **The stale-tab assertion** in `test_frontend.js` compares `#connection-banner-text` exactly. The new buttons sit beside that span, never inside it.
- **Bottom-centre toasts** can cover part of the waveform or the Pack Builder timeline for about 3 seconds. They are narrow, let clicks through around themselves, and at most 3 show.
- **Reconnecting stops after 5 tries** (30 to 60 seconds of jittered backoff). If a host's engine takes longer to come back, guests stay on the red message until they press Try again. Today they retry forever, every 15 to 30 seconds.
- **The refetch after an error** costs one GET per refused message, and it runs only after a server `error` that has a payload.
- **Disabled styling** now applies to every `.btn:disabled`. A button that was disabled but meant to look busy (for example "Preparing…") now looks disabled, which is correct. Screenshots check the export and stems buttons.

## Decided overnight, revisit

1. **Focus ring colour.** The plan says `--ring`, but `--ring` is brass at 40% alpha: 2.3:1 on cards, below the 3:1 minimum for non-text. The ring is a 2px solid `--accent-brass` outline with a 2px offset (7.7:1). The existing `.btn:focus-visible` box-shadow switches to it, so there is one focus style. `--ring` stays for input glows.
2. **The floor** is 11px for any text, including labels, badges and mono readouts, and 12px for sentences, meta and hints. This is how the plan's "11px mono, 12px for anything that must be read" is read.
3. **`updateToast` and the status-text classes** are left to their first callers (steps 31 and 40d), to avoid helpers nobody uses yet.
4. **Error tone** is used only by the new socket error handler and the offline-send warning. Other failure toasts keep auto-dismissing until their surfaces are reworked.
5. **Reconnecting copy.** The plan's "Your changes will send when it's back" over-claims until step 22a, because takes and voice changes go over HTTP and aren't queued. The pill says "Lost the room. Reconnecting…", and the tooltip names the changes that do wait.
6. **The countdown number is dropped**, not ticked from a deadline.
7. **The red state offers "Leave room"**, not "Back to lobby", because the lobby needs the connection that just failed.
8. **"Room not found" ends the retries at once.** The server sends it only when the room is no longer in memory (closed, expired, or the engine restarted), so retrying can't help until the host reopens it. There's no toast; the red pill says it, and Try again stays available.
9. **The lobby's own "Leave room" goes** and the header's Leave stays, because the header one is on every room screen.
10. **Rows are found by comparing `tr.dataset.character`**, not with `CSS.escape`. The result is the same, and it works in JSDOM.
11. **"On other screens"** is in the `?` sheet as a closed `<details>`. That way the lobby, which has no keys of its own, still leads to them.
12. **The live region announces** joins, leaves, "is ready" and connection changes. Takes by others aren't announced there, because their toast already is.
13. **The HUD in the lobby** hides only the progress and the ready summary. The location badge stays.
14. **"YOUR ROLE"** becomes "Your role" in the markup, styled as a badge.
15. **ROADMAP.** No branch has a "UI pass" line, so step 9 adds one with U1 done and U2 to U5 listed.
16. **The plan copy** is verbatim, with a short note on top. The note gives the source path, says the mockup PNGs aren't copied, and restates the owner's routing of the server guards and step 9c to the bug-fix PR.
17. **Server guards.** None in U1. All of them, `set_status` included, are in the bug-fix PR `fix/first-test-findings`, as the owner routed them.
18. **Clap noise rejection (9c)** is in the bug-fix PR `fix/first-test-findings`, as the owner routed it.
19. **Guests in the lobby while recording is on** get "Back to the booth". Hiding "Start recording" would otherwise strand a guest who stepped back to the lobby.
20. **Queued changes in the red state** are kept for Try again and dropped on Leave, as `disconnect()` does today.
21. **`aria-atomic` comes off `#toast-container`**, so each toast is read on its own.

## Implementation steps

Every step works in `X:/Projects_X/DubMate-wt/ui-u1` on `ui/u1-floors`, makes one commit, and keeps the full suite green (`X:/Projects_X/DubMate/.venv/Scripts/python.exe tests/run_all_tests.py`).

Visual steps take before and after headless screenshots at 1440x900, 1280x720 and 960x680. They use `playwright-core` from `C:/Users/tanis/AppData/Local/Temp/dm_pw/node_modules`, with the engine started from the worktree on a free `DUBMATE_PORT`. Scripts and screenshots stay outside the repo, in `C:/Users/tanis/AppData/Local/Temp/dm_shots/ui-u1/`.

1. **The plan and DESIGN.md.** Copy the plan in as `design/ui-plan.md`, with a note on top. Rewrite DESIGN.md from the `style.css` tokens. Add `tests/test_design_tokens.js`.
2. **Type and contrast floor** (plan step 6, first half). Covers `style.css`, `builder.css`, and the inline sizes in `index.html`. Add `tests/test_css_floors.js` with its exemption list.
3. **Shared states** (plan steps 6 second half, and 6a). The focus ring, reduced motion, `.btn:disabled` and `.btn-danger`. Extend `test_css_floors.js`.
4. **Toasts and refused changes** (plan steps 3 first half, 7 and 8). `showToast` tones and cap, the own-take echo, and the socket error handler with refetch. Add `tests/test_toasts.js`, a `test_frontend.js` case, and the `test_builder_editor.js` helper change.
5. **Guests in the lobby** (plan steps 3 second half, 4 and 5). Waiting line and Back to the booth, read-only casting, natural sort, plurals, "Original voice", the 13 missing classes plus `.tag-host`, and no LOBBY badge or second Leave. Add `tests/test_lobby_guest.js`.
6. **Cast strip and the live region** (plan step 9). Add `tests/test_cast_hud.js`, and update the HUD case in `test_frontend.js`.
7. **Reconnecting pill** (plan step 9a). `room_socket.js` gets the failed state, Retry now, overflow, and the room-gone handling. Also `renderConnectionState` and the Reload button. Extend `tests/test_room_socket.js` and add `tests/test_connection_banner.js`.
8. **The `?` sheet by screen** (plan step 9b). `shortcuts.js`, its CSS, and `tests/test_shortcut_sheet.js`.
9. **CHANGELOG and ROADMAP.**
