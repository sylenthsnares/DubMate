# Design: Sessions and sharing

Roadmap feature 6, "Export and sessions", without stems export (that waits for the effects rack, PR #15). Three parts: pick up a session where you left off, a keyboard shortcut sheet, and sharing scenes. Owner decisions: October 2026 interview. Branch `feat/sessions-and-sharing`. Builds on the take model (`take-model.md`), recording timing and Calibrate Mic. The export render and master pipeline are not touched.

ROADMAP.md asks for a design review with the owner before code. This run is unattended, so this doc stands in for that review: every choice the interview didn't settle is under "Decided overnight, revisit", and the owner reviews the PR before merge. This revision follows a claim audit. It narrows the scope: no engine-to-engine import, and no new booth arrow keys.

## Where it stands before this PR

- **Rooms already autosave.** Every broadcast calls `Room.mark_dirty()`, and `_debounced_save` writes `<CACHE_DIR>/rooms/<ROOM>/room_state.json` 3 s later (tmp file + replace).
  - `_sync_save_to_disk` rebuilds the file from attributes: `state_version` (2), `room_id`, `pack_id`, `host_id`, `users`, `role_assignments`, `takes`, `status`, `exported_video_path`, and `pending_v1_takes` when set. Unknown top-level keys are not carried over.
  - `master_dialogue_presence_db` and `exported_video_9_16_path` are not saved.
  - Cancelling the save task runs its `CancelledError` branch, which saves when `_save_dirty` is set. `get_room_cache_dir` calls `os.makedirs`, so a save can recreate a deleted room folder.
- **`prune_sessions(keep_room_id=None)`** (`dubmate/rooms.py`) keeps exactly one room folder: `keep_room_id` when given, otherwise the newest folder by mtime. It also keeps any room that has connected sockets.
  - Every other folder under `<CACHE_DIR>/rooms` is deleted with its takes, and every other `ROOMS` entry is dropped. The exports folder is never touched.
  - It runs on room creation (`create_room` keeps the new code, under `rooms_api._ROOM_CREATE_LOCK`) and at startup (`load_persisted_rooms` keeps the newest).
  - The docstring says why: "Strict Single-Session Retention Policy … keep the server ultra-light". So all but the latest session's takes are lost as soon as a new room is made.
- **Restored rooms are not republished** to the room-code registry. `WORKER_PENDING_ROOMS` only holds codes this process created, and ownership tokens (`WORKER_ROOM_TOKENS`) live in memory only.
  - Republishing after a restart would fail: without a token the worker answers 409, which the engine records as the terminal `conflict` state ("That room code is already taken. Create a new room.").
  - With no status at all, `build_room_share_payload` reports "waiting" ("Getting your room code ready.") for good.
- **The host's identity.** `createRoom` stores the room's `host_id` as `dubmate_user.id`. A WS `join` promotes the joiner to host whenever the stored host is offline, and replaces `users[id]` wholesale (dropping `current_line` / `location` / `is_ready` until the next status). `is_online` is never cleared on load. `joinRoom` fetches `/api/rooms/{code}` before the socket connects, then opens the booth at `findFirstAssignedLine()`.
- **Who can reach the engine.**
  - The desktop shell runs `app.py` as a script, so uvicorn binds `0.0.0.0`.
  - CORS allows every origin and method.
  - `require_local_request` (in `app.py`, guarding only `POST /api/config`) rejects requests that carry `cf-ray` / `cf-connecting-ip`. It does not stop a LAN device, or a web page in the user's browser calling `127.0.0.1:<port>`.
  - `POST /api/rooms` is reachable through the tunnel, so a guest can create a room on the host's engine.
- **Shortcuts in the code:**
  - Booth (`app.js` window `keydown`): Space records or stops; `[` / `]` nudge 25 ms; Shift+`[` / `]` nudge 100 ms.
  - Screening: Space plays or pauses; `R` replays.
  - Landing: `/` focuses the scene search; Escape in the search clears it.
  - Escape closes Audio settings, a finished export window and the mode menu.
  - Pack Builder editor (`pack_builder.js initKeyboardShortcuts`): Space; `I` or `[`; `O` or `]`; `N`; ←/→ (0.2 s, Shift 2 s); Delete/Backspace.
  - There are no booth arrow keys, although PRODUCT.md mentions "arrows to move between lines".
  - The builder's step buttons say "Back 1 second (←)", but ← moves 0.2 s.
  - Knobs (`knob.js`) handle arrows themselves with `preventDefault` and no `stopPropagation`.
  - Five overlays have `aria-modal`; a search finds no focus-trap code.
- **Pack ZIPs.** `GET /api/packs/{id}/export` writes `<exports>/packs/DubMate_Pack_<safe name>_<id>.zip` on the engine's computer and then streams it.
  - It is open to anyone who reaches the engine, including tunnel guests.
  - The pack card's "ZIP" chip goes through `saveRemoteFile`. On the engine's own computer it toasts "Saved to <exports>\packs"; elsewhere it is a blob download.
- **Pack import.** `POST /api/packs/import` → `pack_loader.import_pack_archive`, which runs signature, size (500 MB), count and ratio checks, zip-slip checks and blocked extensions. It installs into `PACKS_DIRS[0]/<safe title>`, replacing a folder of that name.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| **Continue where you left off**: a card above the scene list with up to 5 recent sessions, newest first. Each row has the scene title, "12 of 30 lines recorded · 2 hours ago" (tooltip: exact date and time), a **Continue** button and a remove button (bin icon, `aria-label` "Remove <title>", tooltip "Remove this session"). | Landing, on the engine's own computer only | Default (shown only when there is a session) |
| **Continue** reopens the room with its takes, casting, status and presence level. If the room was recording, you land in the booth on the line you were on; otherwise in the lobby or screening. You come back as the room's host. | Landing → room | Default |
| A session whose scene is gone from the library says "This scene isn't in your library" and **Continue** is disabled (tooltip "Add the scene again to continue"). It can still be removed. | Card row | Only when it happens |
| A session that can't be read shows as "A session that couldn't be opened", with its date and only the remove button. | Card row | Only when it happens |
| Remove asks "Remove this session? Its takes are deleted. Videos you saved stay in your export folder." On yes the row goes away. On failure a toast says "Someone is still in this session." or "Couldn't remove that session. Try again." | Card row | One click away |
| A continued room's code was published by an earlier run and can't be reused. With a tunnel up, the room badge tooltip says "Room codes stop working when DubMate closes. Copy invite gives a link that works now.", and Copy invite copies the direct link with the toast "Invite link copied." With no tunnel set up it says "Room codes stop working when DubMate closes. Only people on your network can join for now." | Lobby | Only when it applies |
| **Keyboard shortcuts**: press `?`, or the new `?` button in the header (tooltip "Keyboard shortcuts (?)"), to open a sheet grouped as Scenes, Recording, Watching together, Pack Builder and Everywhere. Escape, the Close button or a click outside closes it, and focus goes back to where it was. | Studio and Pack Builder headers | One click away |
| The builder's step-button tooltips drop the "(←)" / "(→)" that wasn't true. The sheet says what the arrow keys really do. | Pack Builder | Default |
| The pack card's "ZIP" chip becomes **Share** (tooltip "Save this scene as a file to send to a friend"). | Landing, pack card | Default |
| On the engine's own computer, Share opens a small window titled "Ready to send" with "Send this file to a friend. They add it with Import pack in DubMate.", the full file path (read-only, selectable), **Copy** and **Done**. Elsewhere it downloads as before, with the toast "Downloaded "<title>". Send the file to a friend." | Landing, pack card | Default |
| **Get this scene**: a secondary lobby button for members who joined from their own DubMate (tooltip "Download this scene to add to your own DubMate"). It downloads the scene file with the toast "Downloaded "<title>". Add it with Import pack in your DubMate." The host doesn't see it. | Lobby, members from their own DubMate | Only when it applies |

No text names rooms folders, JSON, tunnels, engines or ZIP internals. "Session" is used only on the card.

## Data shapes and on-disk layout

### Room state (`room_state.json`, still `state_version: 2`)

New optional top-level fields. All are additive; a missing field reads as the fallback.

| Field | Meaning | Missing → |
|---|---|---|
| `last_active_at` (float, epoch s) | When the room last changed. `mark_dirty()` sets `room.last_active_at = time.time()`. Set at create and by `POST /api/sessions/{id}/open`. `_sync_save_to_disk` writes the attribute and never stamps it itself. | The `room_state.json` mtime, **read before any migration save** in `load_room_folder` |
| `creator_id` (str) | The `host_id` the room was created with. Never changed by host promotion. Continue rejoins as this id. | `host_id` |
| `created_here` (bool) | The room was created from the engine's own computer (`common.is_own_computer(request)` in `POST /api/rooms`). Only these rooms are listed on the card. | `true` (today's single kept room is the host's) |
| `master_dialogue_presence_db` (float) | The dialogue presence level, clamped −12..12 as today. | `0.0` |

On load, every `users[*].is_online` is set to `False` (they were stale), so the WS `join` rule promotes whoever continues back to host. Takes, the `takes/<line_id>/` folders, cleaned files and `pending_v1_takes` are untouched. `to_state_dict()` is unchanged on the wire. `exported_video_9_16_path` stays unsaved, as today.

`Room` gains `_save_lock` (`threading.Lock`) and `deleted` (bool). `_sync_save_to_disk` runs under the lock and returns early when `deleted` is set. Delete and prune set `deleted` under the same lock before `rmtree`, so no save, whether queued, cancelled or mid-thread, can bring a folder back.

### Retention (`rooms.prune_sessions(keep_room_id=None, keep=RECENT_SESSIONS_KEEP)`, `RECENT_SESSIONS_KEEP = 5`)

`rooms.session_summaries()` returns one dict per folder under `<CACHE_DIR>/rooms`: `{room_id, pack_id, pack_name, pack_found, recorded_lines, total_lines, last_active_at, status, readable, listed}`.
- A loaded room (`ROOMS`) is summarised from memory, any other folder from its `room_state.json`.
- A folder with an unreadable `room_state.json` has `readable: false` and its folder mtime.
- **`listed`** is true for an unreadable folder, and otherwise `created_here and has takes`. "Has takes" means a non-empty `takes`, `pending_v1_takes` or v1 `takes`. A folder with no `room_state.json` is not listed.
- The card shows the `keep` newest listed summaries by `last_active_at`.

| Kept | Why |
|---|---|
| `keep_room_id`, or when none is given the newest folder by `last_active_at` | Today's rule, so nothing kept today is lost |
| Rooms with connected sockets | Today's rule |
| The `keep` newest listed sessions | Exactly the rows the card shows |

Everything else is deleted oldest first, as today, along with its `ROOMS`, `WORKER_PENDING_ROOMS` and `WORKER_ROOM_STATUS` entries; the exports folder is never touched. The card and the prune use the same function and the same order, so **a row on the card is never pruned**. When a sixth listed session appears, the oldest row leaves the card, and its folder is deleted at the next room creation or startup. Unreadable folders take a card slot, so they are bounded and the user can remove them. Rooms created by guests keep today's rule: they are deleted unless newest or live.

`load_persisted_rooms()` keeps its shape: `prune_sessions()`, then `load_room_folder(room_id)` for every remaining folder. That function is the per-folder body moved out, returning `Optional[Room]`, so the open route can reuse it. Rooms whose pack is missing are not loaded, as today.

`rooms.new_room_code()` loops `generate_room_code()` until the code is in neither `ROOMS` nor the rooms folder. With up to 6 kept rooms, a collision would otherwise mix two sessions' takes.

## API and WebSocket

**Own-computer guard.** `dubmate/common.py` gets `is_own_computer(request) -> bool` and `require_own_computer(request)`, which raises 403 "This only works on the host's computer." It answers true only when all three hold:
- there is no `cf-ray` / `cf-connecting-ip` header;
- the `Host` header's hostname is `127.0.0.1`, `localhost` or `::1`;
- the `Origin` header is absent or equal to `http://<Host header>`.

This refuses tunnel guests, LAN devices (their `Host` is the LAN address), DNS-rebinding pages (their `Host` is the attacker's name) and other web pages calling loopback (their `Origin` differs). The CORS preflight is still approved, but the real request is refused. `POST /api/config` keeps its current guard, so LAN behaviour there doesn't change in this PR.

New routes live in `dubmate/sessions_api.py`, registered in `app.py` next to `rooms_api`. `_ROOM_CREATE_LOCK` moves to `rooms.SESSIONS_LOCK` and is held by create, open and delete.

- `GET /api/sessions` (guarded) returns `{"sessions": [summary, …]}`: the card rows, without `listed`.
- `POST /api/sessions/{room_id}/open` (guarded):
  - 400 for an id failing `common.require_safe_identifier`;
  - 404 "That session is gone." when there is no folder or it isn't listed;
  - 409 "This scene isn't in your library anymore." when the pack is missing, after trying `load_room_folder` again in case a rescan brought it back.
  - 409 "That session couldn't be opened." when the session is unreadable: its `room_state.json` isn't a JSON object, or `load_room_folder` failed on it for another reason (recorded in `rooms.UNLOADABLE_ROOMS`, so its summary turns unreadable and the card offers only Remove).
  - Otherwise it sets `last_active_at`, marks the room dirty and returns `{room_id, user_id: creator_id, state}`.
  - It does not republish the code. When the code isn't in `WORKER_PENDING_ROOMS`, `build_room_share_payload` reports a new state `not_published` with the message above.
  - `lobby.js` shows that message in the badge and toasts "Invite link copied." for it. The registry docstring is updated: restored rooms stay unpublished.
- `DELETE /api/sessions/{room_id}` (guarded):
  - 400 for a bad id;
  - 404 when the folder is unknown;
  - 409 "Someone is still in this session." while the room has sockets.
  - Otherwise it pops the `ROOMS`, `WORKER_PENDING_ROOMS`, `WORKER_ROOM_STATUS` and `WORKER_PUBLISHED_*` entries, so new requests for the room 404.
  - It clears `_save_dirty`, cancels and awaits `_save_task` and `cleanup_refresh_task` (`asyncio.gather(..., return_exceptions=True)`), then in a thread takes `_save_lock`, sets `deleted` and `rmtree`s the folder.
  - It answers `{"status": "ok"}`, or 500 "Couldn't remove that session. Try again." if the folder is still there.
- `POST /api/rooms` takes `request: Request` and sets `created_here = common.is_own_computer(request)` and `creator_id = user_id`.
- `GET /api/packs/{pack_id}/export` adds the response header `X-DubMate-File: <basename of the saved ZIP>` (file name only). Access rules are unchanged.
- WebSocket: no change.

## Studio

- `static/js/studio/sessions.js` (new mixin `SessionMethods`) has `loadRecentSessions()`, `renderRecentSessions()`, `continueSession(roomId)`, `removeSession(roomId)` and a small `relativeTime(ts)`.
  - It fills `#recent-sessions`, a `<section aria-labelledby>` above `.landing-grid` in `index.html` that stays `hidden` until there are rows.
  - `showView('landing')` calls it only when `isEngineLocal()`.
- `continueSession` POSTs open, sets `this.user.id = user_id`, calls `saveUser()` (name and colour stay), then calls `joinRoom(room_id)`.
- `joinRoom` (`lobby.js`) computes `savedLineIndex()` from the REST `roomState` **before** `socket.connect`, because the WS `join` wipes the user's saved status. In the recording branch it opens `saved ?? this.findFirstAssignedLine()`.
  - `savedLineIndex()` returns `users[this.user.id].current_line` when it is an integer inside the pack and (`current_line > 0` or `location === 'booth'`); otherwise `null`.
- `static/js/shortcuts.js` (new) is the one list: `SHORTCUT_GROUPS = [{ id, title, items: [{ id, keys: [['Shift', '['], …], label }] }]`.
  - `initShortcutSheet({ opener, isBlocked })` builds the sheet once, with `role="dialog"`, `aria-modal="true"`, `aria-labelledby` and a `<kbd>` per key. It binds `?`, which is ignored in text fields, while `isBlocked()` is true, or while a sheet is already open.
  - `app.js` passes `isBlocked = () => this.isAudioSettingsOpen() || this.isRenderingExport`; `pack_builder.js` passes none.
  - Both global key handlers return early while `isDialogOpen()`, so Space can't record behind the sheet.
- `ui_common.js` gets `openDialog(overlay, { returnFocus })` and `isDialogOpen()`. `openDialog` shows the overlay, focuses its first focusable element, keeps Tab / Shift+Tab inside, closes on Escape and on a backdrop click, restores focus, and returns `close()`. It is used by the shortcut sheet and the Share window; existing modals are not migrated.
- Pack card (`packs.js`): the `.btn-pack-download-icon` chip keeps its class and route; its label becomes "Share".
  - On `isEngineLocal()`, after the save it opens `#modal-share-pack` (in `index.html`) with the path `exports_dir + sep + 'packs' + sep + X-DubMate-File`.
  - `saveRemoteFile` gains an `onSaved(res, dir)` option, so this one caller replaces the toast with the window.
  - **Copy** uses `navigator.clipboard.writeText` and falls back to selecting the text.
- Lobby: `#btn-get-scene` in `.lobby-action-group` is visible when `getHomeOrigin()` is set, differs from `location.origin`, and the user isn't the host. It calls `saveRemoteFile(pack.export_url, …)` with no `exportSubfolder`, so it is a browser download on the host's page.

## Existing data

- **Rooms on disk today** (one folder, plus any with live sockets) load as before. The fallbacks are: `last_active_at` → `room_state.json` mtime read before any save; `creator_id` → `host_id`; `created_here` → true; presence → 0.
- The next save writes the known keys with the same values, adds the four new fields, and has every user's `is_online` false. Unknown top-level keys are dropped, as today; none exist in any shipped build.
- **Version 1 rooms** still migrate through `_migrate_v1_takes`. Their `last_active_at` is the mtime read before the migration save.
- **Old room-scoped `noise_profile_<user>.wav`** files stay where they are, as in Calibrate Mic.
- **Downgrade**: an older build prunes down to its single newest folder on its next start, deleting the other kept sessions. Recorded under Risks; no mitigation.
- **Tests** (`tests/test_sessions.py`), with a temp `CACHE_DIR` and a synthetic pack as in `test_take_model.RoomCase`:
  - a literal PR #16-era `room_state.json` (no new fields, `is_online: true`, a known mtime) loads, is listed with that mtime, opens as `host_id`, and saves back with every known key equal except `users[*].is_online` (now false), plus the four new fields;
  - a v1 literal migrates, is listed, and keeps its pre-migration mtime as `last_active_at`;
  - retention: 5 folders created here with takes (distinct times), 1 older with takes, 1 empty, 1 unreadable (newest), 1 guest-created with takes, 1 guest-created with a fake socket, then `prune_sessions(keep_room_id=NEW)` for a new empty room. Kept: NEW, the socketed room, the unreadable one and the 4 newest with takes. Deleted: the 5th and the older one with takes, the empty one and the guest room without a socket. Nothing `GET /api/sessions` returned just before the prune is deleted;
  - a dirty room deleted while its debounced save is pending, and a room pruned then saved directly with `_sync_save_to_disk()`, leave no folder behind;
  - presence round-trips;
  - `prune_sessions(keep_room_id="NONE", keep=0)` still deletes everything that isn't socketed.
- Existing tests that clean up with `prune_sessions(keep_room_id="NONE")` (`test_noise_reduction.py` ×2, `test_noise_reduction_deep.py`) pass `keep=0`, which keeps their old meaning.

## Export, render, premiere and project ZIP

There is no change to the pipeline. `render_dub_mix`, `export_dub_video`, premiere and `build_project_zip` keep reading `room.mix_takes()`. A continued room renders with its saved presence level (it used to reset to 0), because the export route already falls back to `room.master_dialogue_presence_db`. A continued room's `exported_video_path` is used only if the file still exists (`ready_export_path`, as today). Remove and prune never touch the exports folder, so saved videos, project ZIPs and shared scene ZIPs stay. The project ZIP manifest is unchanged.

## Not in this PR

- Stems export (needs PR #15).
- **Engine-to-engine "Add to my scenes"**, where the member's own DubMate fetches and imports the host's scene. It is unproven that the https room page can call `http://127.0.0.1` inside WebView2 or WKWebView, and it needs a cross-origin exception to the own-computer guard. Get this scene + Import pack covers the need. If wanted later, a top-level navigation home (as `goHome` does) carrying the scene is the route to try.
- **Booth ← / → between lines.** They are not in the code today, and knobs already use the arrow keys. They are a follow-up that must skip `e.defaultPrevented` and `role="slider"|"radio"|"tab"` targets.
- Reopening the last session automatically at launch; syncing sessions between computers; per-browser UI settings as part of a session.
- Persisting registry tokens or republishing continued codes; a "new code" button for a continued room.
- Listing empty sessions; a configurable limit.
- Tightening `POST /api/config`, `POST /api/rooms`, `POST /api/packs/import` or the pack media / ZIP routes against LAN or tunnel callers (all pre-existing).
- Changing the manual import's replace-on-same-name behaviour.
- A "show in folder" button (the studio page has no desktop bridge for it).
- Shortcuts for knobs, sliders and the video size handle (these are control keys); remapping shortcuts.
- Migrating existing modals to `openDialog`.

## Risks

- **Disk use.** Up to 5 sessions of takes (raw, cleaned and fitted WAVs) instead of 1; a long scene can be a few hundred MB. Users can remove sessions.
- **A hard kill loses up to 3 s of changes.** The only flush is `_debounced_save`'s `CancelledError` branch when the event loop shuts down; the desktop shell kills the engine, so it may not run. Take files written in those 3 s stay on disk but aren't in the state, as today.
- **Delete during a take upload.** An upload already in its worker thread may write files after the folder is removed. The folder then has no `room_state.json`, so it isn't listed and the next prune deletes it.
- **The own-computer guard trusts `Host` / `Origin`.** Browsers can't forge them, but a local program can; local programs are outside the threat model. Opening the studio at a LAN address on the host's own computer hides the card.
- **Downgrade** deletes all but the newest session (see Existing data).
- **Get this scene** builds the ZIP on the host's computer and writes it into the host's export folder, as the route already does. Cloudflare closes requests whose answer doesn't start within about 100 s (its documented proxy read timeout; not checked with a quick tunnel), so a very large scene may fail with "Couldn't download that pack. Try again." The download is held in memory by the page (the `saveRemoteFile` blob), up to the 500 MB pack limit.
- **5 loaded rooms are reachable by code and direct link through the host's tunnel**, where there used to be 1. Codes are 6 characters from 32 symbols, the tunnel hostname is random, and restored codes aren't republished.

## Decided overnight, revisit

1. Keep **5** sessions. Empty sessions are neither listed nor kept, except the newest folder, which is always kept as today.
2. Order and "2 hours ago" use the **last change time**, falling back to the state file's mtime (read before any migration save).
3. Continue rejoins as the room's **creator**. Only rooms created on the host's own computer are listed.
4. A continued room's code is **not republished** after a restart; invites use the direct link, and the badge says why. Within one run, a kept room's code keeps working.
5. The booth reopens at your saved line only when the room was recording and the saved line is past the first or you were in the booth.
6. **No booth arrow keys** in this PR; the sheet lists only what the code does.
7. The builder's wrong "(←)" tooltips are fixed rather than changing the arrow step.
8. The pack card's "ZIP" becomes **Share**, with a path window on the engine's own computer.
9. Sharing between DubMates is **Get this scene** (a download) plus the existing Import pack, not an engine-to-engine import.
10. The host's pack ZIP route stays open to tunnel guests, as today. There is no host opt-out.
11. Session routes require the **own-computer guard** (Host and Origin loopback, no Cloudflare headers). `POST /api/config` is left as it is.
12. A session that can't be read is listed with only Remove, never auto-deleted while it is in the top 5.
13. The presence level is now saved with the session.

## Hands-on checks

- Desktop: record a few lines, pick takes, set presence, close DubMate from the booth, reopen. **Continue** lands on the same line with the same takes, casting and presence, and Render matches.
- Make 6 sessions with takes. The card shows 5. Creating a seventh room removes only the session no longer shown.
- Remove a session: its room folder is gone and its rendered video is still in the export folder.
- From a second device on the LAN, open `http://<host LAN IP>:<port>/api/sessions`: it is refused.
- Continue a session after restarting DubMate and invite a friend: the badge explains, and Copy invite gives a working link.
- Two machines: a member who joined from their own DubMate presses **Get this scene** on Windows and on macOS. The file downloads (note where), and Import pack adds it.
- **Share** on Windows and macOS shows the real path; Copy works; a friend imports the file.
- Shortcut sheet with keyboard only and with NVDA / VoiceOver: focus stays inside, Escape closes, focus returns. Space doesn't record while it is open.

## Implementation steps

1. **Room state: new fields, safe saves, load refactor.**
2. **Keep recent sessions: retention and summaries.**
3. **Session routes and the own-computer guard.**
4. **Continue where you left off on the landing page.**
5. **Keyboard shortcut sheet.**
6. **Share a scene and Get this scene.**
7. **CHANGELOG and ROADMAP.**

Each step's brief is in the step list returned with this design. Every step keeps `python tests/run_all_tests.py` green.
