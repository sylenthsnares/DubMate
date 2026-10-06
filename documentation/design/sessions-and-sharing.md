# Design: Sessions and sharing

Roadmap feature 6, "Export and sessions", without stems export (that waits for the effects rack, PR #15). Three parts: pick up a session where you left off, a keyboard shortcut sheet, and sharing scenes. Owner decisions: October 2026 interview. Branch `feat/sessions-and-sharing`. Builds on the take model (`take-model.md`), recording timing and Calibrate Mic. The export render and master pipeline are not touched.

## Where it stands before this PR

- **Rooms already autosave.** Every broadcast calls `Room.mark_dirty()`, and `_debounced_save` writes `<CACHE_DIR>/rooms/<ROOM>/room_state.json` 3 s later (tmp file + replace). The saved fields are `state_version` (2), `room_id`, `pack_id`, `host_id`, `users` (each user has `current_line`, `location` and `is_ready` from `set_user_status`), `role_assignments`, `takes`, `status`, `exported_video_path` and `pending_v1_takes`. `master_dialogue_presence_db` is **not** saved, so it resets to 0 after a restart.
- **`prune_sessions(keep_room_id=None)`** (`dubmate/rooms.py`) keeps exactly one room folder: `keep_room_id` when given, otherwise the newest folder by mtime. It also keeps any room that has connected sockets. Every other folder under `<CACHE_DIR>/rooms` is deleted with its takes, and every other `ROOMS` entry is dropped. It never touches the exports folder. It runs when a room is created (`create_room` keeps the new code) and at startup (`load_persisted_rooms` keeps the newest). The docstring explains why: "Strict Single-Session Retention Policy … keep the server ultra-light". So all but the latest session's takes are lost as soon as a new room is made.
- **Restored rooms are not republished** to the room-code registry (`room_registry.WORKER_PENDING_ROOMS` only gets codes created by this process: "those sessions are over"). Registry ownership tokens (`WORKER_ROOM_TOKENS`) live in memory only.
- **The host's identity.** `createRoom` stores the room's `host_id` as `dubmate_user.id` in `localStorage`. A WS `join` promotes the joiner to host whenever the stored host is offline. `users[*].is_online` is saved as it was and is never cleared on load.
- **Nothing on the landing page lists earlier sessions.** `joinRoom` opens the booth at `findFirstAssignedLine()`, not at the line you were on.
- **Shortcuts in the code:**
  - Booth (`app.js` window `keydown`): Space records or stops; `[` / `]` nudge 25 ms; Shift+`[` / `]` nudge 100 ms.
  - Screening: Space plays or pauses; `R` replays.
  - Landing: `/` focuses the scene search; Escape in the search clears it.
  - Escape closes Audio settings and a finished export window.
  - Pack Builder editor (`pack_builder.js initKeyboardShortcuts`): Space, `I` or `[`, `O` or `]`, `N`, ←/→ (0.2 s, Shift 2 s), Delete/Backspace.
  - There are no booth arrow keys, although PRODUCT.md says "arrows to move between lines".
  - The builder's step buttons say "Back 1 second (←)", but ← moves 0.2 s.
  - No modal has a focus trap.
- **Pack ZIPs.** `GET /api/packs/{id}/export` writes `<exports>/packs/DubMate_Pack_<name>_<id>.zip` and streams it. It is open to anyone who reaches the engine, including tunnel guests, and so is every pack's video, backing and line audio. The pack card's "ZIP" chip goes through `saveRemoteFile`: on the engine's own computer it toasts "Saved to <exports>\packs", elsewhere it is a browser download.
- **Pack import.** `POST /api/packs/import` runs the safe import path (`pack_loader.import_pack_archive`: signature, size, count and ratio limits, zip-slip and blocked-extension checks). It installs into `PACKS_DIRS[0]/<safe title>` and **replaces** an existing folder of that name. It is not guarded against tunnel requests. `require_local_request` (cf-ray / cf-connecting-ip → 403) lives in `app.py` and only guards `POST /api/config`.
- **Members from their own DubMate.** A member who joins from their own DubMate is on the host's tunnel page with `?home=http://127.0.0.1:<port>` kept in `sessionStorage` (`getHomeOrigin()`). `warnOnVersionMismatch` already fetches `${home}/health` cross-origin from that page, best effort.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| **Continue where you left off**: a card above the scene list with up to 5 recent sessions that have takes, newest first. Each row has the scene title, "12 of 30 lines recorded · 2 hours ago" (tooltip: exact date and time), a **Continue** button and a remove button (bin icon, `aria-label` "Remove <title>", tooltip "Remove this session"). | Landing, on the engine's own computer only | Default (shown only when there is a session) |
| **Continue** reopens the room with its takes, casting, status, presence level and your line: the booth at the line you were on if the room was recording, the lobby or screening otherwise. You come back as the room's host. | Landing → room | Default |
| A session whose scene is gone from the library says "This scene isn't in your library" and **Continue** is disabled (tooltip "Add the scene again to continue"). It can still be removed. | Card row | Only when it happens |
| Remove asks "Remove this session? Its takes are deleted. Videos you saved stay in your export folder." On yes the row goes away; on failure a toast says "Someone is still in this session." or "Couldn't remove that session. Try again." | Card row | One click away |
| **Keyboard shortcuts**: press `?`, or the new `?` button in the header (tooltip "Keyboard shortcuts (?)"), to open a sheet grouped as Scenes, Recording, Watching together, Pack Builder and Everywhere. Escape, the Close button or a click outside closes it, and focus goes back to where it was. | Studio and Pack Builder headers | One click away |
| In the booth, ← and → go to the previous and next line. They do nothing while a take is counting in, recording or processing, and → on your last line does nothing (it never presses Finish). | Booth | Default (listed in the sheet) |
| The builder's step-button tooltips drop the "(←)" / "(→)" that wasn't true. The sheet says what the arrow keys really do. | Pack Builder | Default |
| The pack card's "ZIP" chip becomes **Share** (tooltip "Save this scene as a file to send to a friend"). On the engine's own computer, a small window opens titled "Ready to send" with the text "Send this file to a friend. They add it with Import pack in DubMate.", the full file path (read-only, selectable), **Copy** and **Done**. Elsewhere it downloads as before, with the toast "Downloaded "<title>". Send the file to a friend." | Landing, pack card | Default |
| **Add to my scenes**: a secondary button in the lobby header with the tooltip "Saves a copy of this scene in your own DubMate". It is shown only to a member who joined from their own DubMate. Results: "Adding "<title>" to your scenes…", then "Added "<title>" to your scenes.", or "You already have a scene with this name." Nothing is replaced. | Lobby, members from their own DubMate | Only when it applies |
| If the member's DubMate can't be reached from the room page (the webview blocks it), the scene ZIP downloads instead: "Couldn't reach your DubMate from here, so the scene was downloaded. Add it with Import pack." | Lobby | Only when it happens |

No text names rooms folders, JSON, tunnels, engines or ZIP internals. "Session" is used only in the card ("Continue where you left off", "Remove this session").

## Data shapes and on-disk layout

### Room state (`room_state.json`, still `state_version: 2`)

New optional top-level fields. All are additive; a missing field reads as the fallback.

| Field | Meaning | Missing → |
|---|---|---|
| `last_active_at` (float, epoch s) | When the room last changed. `mark_dirty()` sets `room.last_active_at = time.time()`; `_sync_save_to_disk` writes the attribute and never stamps now itself, so a migration save keeps the loaded value. Set at create and by `POST /api/sessions/{id}/open`. | Folder mtime (≈ last save) |
| `creator_id` (str) | The `host_id` the room was created with. Never changed by host promotion. Continue rejoins as this id. | `host_id` |
| `master_dialogue_presence_db` (float) | The dialogue presence level, clamped −12..12 as today. | `0.0` |

On load, every `users[*].is_online` is set to `False` (they were stale), so the host who continues is promoted back by the WS `join` rule. Nothing else in the layout changes; takes, the `takes/<line_id>/` folders, cleaned files and `pending_v1_takes` are untouched. `to_state_dict()` is unchanged on the wire.

### Retention (`rooms.prune_sessions(keep_room_id=None, keep=RECENT_SESSIONS_KEEP)`, `RECENT_SESSIONS_KEEP = 5`)

The rooms are summarised by `rooms.session_summaries()`, one dict per folder under `<CACHE_DIR>/rooms`: `{room_id, pack_id, pack_name, pack_found, recorded_lines, total_lines, last_active_at, status, has_takes, readable}`. A loaded room (`ROOMS`) is summarised from memory; any other folder from its `room_state.json`. `has_takes` means non-empty `takes`, a non-empty `pending_v1_takes`, or non-empty v1 `takes`.

| Kept | Why |
|---|---|
| `keep_room_id`, or when none is given the newest folder by `last_active_at` | Today's rule, so nothing kept today is lost |
| Rooms with connected sockets | Today's rule |
| The `keep` newest rooms with `has_takes`, by `last_active_at` | Exactly the rows the landing card can show |
| A folder whose `room_state.json` exists but can't be read | Never auto-delete data we can't inspect (logged, not listed) |

Everything else is deleted oldest first, as today, along with its `ROOMS` entry and `WORKER_PENDING_ROOMS` entry. The exports folder is never touched. Because the card lists the same top 5 sessions with takes, and a new room has no takes, **a session shown on the card is never pruned**. When a sixth session gets its first take, the oldest one leaves the card, and it is deleted at the next room creation or startup.

`load_persisted_rooms()` keeps its shape: `prune_sessions()`, then load every remaining folder whose pack is found. The per-folder body moves into `load_room_folder(room_id) -> Optional[Room]` so the open route can reuse it.

`generate_room_code()` callers now loop until the code is in neither `ROOMS` nor the rooms folder. With up to 6 kept rooms, a collision would otherwise mix two sessions' takes.

## API and WebSocket

All new session routes call `common.require_local_request(request)` (moved from `app.py` to `dubmate/common.py`; `app.py` imports it, so `POST /api/config` behaves the same). Through the tunnel they answer 403 "This can only be changed on the host's computer." They live in a new `dubmate/sessions_api.py`, registered in `app.py` next to `rooms_api`. `_ROOM_CREATE_LOCK` moves to `rooms.SESSIONS_LOCK` and is held by create, open and delete, so a prune can't race an open.

- `GET /api/sessions` returns `{"sessions": [summary, …]}`: the `has_takes` rooms, newest first, at most `RECENT_SESSIONS_KEEP`, without `has_takes` / `readable`.
- `POST /api/sessions/{room_id}/open`:
  - 404 "That session is gone." when there is no such folder;
  - 409 "This scene isn't in your library anymore." when the pack is missing (after trying `load_room_folder` again, in case a rescan brought it back).
  - Otherwise it sets `last_active_at`, marks the room dirty and queues the code for the registry: `WORKER_PENDING_ROOMS[code] = read_version()`, `_set_room_status(..., "waiting"|"publishing")`, `schedule_registry_publish()`.
  - Returns `{room_id, user_id: creator_id, state}`. The registry comment about restored rooms is updated: they stay unpublished until the host continues them.
- `DELETE /api/sessions/{room_id}`:
  - 409 "Someone is still in this session." while the room has sockets;
  - 404 when unknown;
  - 400 for an id failing `common.require_safe_identifier` or escaping the rooms folder (`common.safe_join`).
  - Otherwise it cancels the room's save task, drops `ROOMS` / `WORKER_PENDING_ROOMS` / `WORKER_ROOM_STATUS` entries, `shutil.rmtree`s the folder (in a thread) and returns `{"status": "ok"}`.
- `GET /api/packs/{pack_id}/export` adds the response header `X-DubMate-File: <basename of the saved ZIP>` (file name only, no directory).
- `POST /api/packs/import_from_room` (form fields `source`, `pack_id`; a CORS "simple" request, so no preflight):
  - `require_local_request`.
  - `source` must be an `https://host[:port]` origin with no path, and must equal the request's `Origin` header (the room page that asked); else 403 "Add scenes from the room you're in."
  - `pack_id`: 1–200 characters with no `/`, `\` or `..`; else 400.
  - A pack with that id already in the library returns `{"status": "exists"}`.
  - Otherwise it downloads `f"{source}/api/packs/{quote(pack_id)}/export"` with `httpx.AsyncClient` (no redirects; timeouts connect 15 s, read 120 s) into a temp file, streaming and stopping at `pack_loader.MAX_ARCHIVE_SIZE_BYTES` (413 "That scene is over the 500 MB limit."). Non-200 or a network error gives 502 "Couldn't get the scene from the host. Try again."
  - Then `import_pack_archive(tmp_path, f"{pack_id}.zip", replace_existing=False)` in a thread. Security and validation errors map to 422 / 400 as in `/api/packs/import`. `PackExistsError` gives `{"status": "exists"}`.
  - It refreshes the registry, deletes the temp dir and returns `{"status": "ok", "pack": …}`.
  - One import runs at a time (module `asyncio.Lock`).
- `pack_loader.import_pack_archive(..., replace_existing=True)` and `_install_pack_root(..., replace_existing=True)`: with `False`, an existing destination folder raises the new `PackExistsError` before anything is copied. Callers of the manual import path are unchanged.
- WebSocket: no change.

## Studio

- `static/js/studio/sessions.js` (new mixin `SessionMethods`) has `loadRecentSessions()`, `renderRecentSessions()`, `continueSession(roomId)`, `removeSession(roomId)` and a small `relativeTime(ts)`. It fills `#recent-sessions` (a `<section aria-labelledby>` above `.landing-grid` in `index.html`, `hidden` until there are rows). `showView('landing')` calls it only when `isEngineLocal()`.
- `continueSession` POSTs open, sets `this.user.id = user_id`, calls `saveUser()`, then `joinRoom(room_id)`.
- `joinRoom` (`lobby.js`), recording branch: it opens `this.savedLineIndex() ?? this.findFirstAssignedLine()`. `savedLineIndex()` reads `roomState.users[this.user.id]` as fetched, before any status broadcast. It returns `current_line` when that is an integer inside the pack and (`current_line > 0` or `location === 'booth'`), otherwise `null`. A fresh joiner's lobby broadcast (line 0) therefore never overrides their first assigned line. This also gives a guest who rejoins their last line.
- `static/js/shortcuts.js` (new) is the one list. `SHORTCUT_GROUPS = [{ id, title, items: [{ keys: [['Shift', '['], …], label, presses: [KeyboardEventInit, …], where }] }]`. `where` is `'landing' | 'booth' | 'screening' | 'builder' | 'any'`; `presses` are the real events the tests dispatch.
  - `initShortcutSheet(openerButton)` builds the sheet DOM once (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`, a `<kbd>` per key), binds `?` (ignored in inputs) and opens it with `openDialog`.
  - Both `app.js` and `pack_builder.js` call it.
  - The global key handlers in both files get `// shortcuts: begin` / `// shortcuts: end` markers and return early while `isDialogOpen()`.
- `ui_common.js` gets `openDialog(overlay, { returnFocus })` and `isDialogOpen()`.
  - `openDialog` shows the overlay (`is-open`, `hidden = false`), focuses its first focusable element and keeps Tab / Shift+Tab inside.
  - Escape and a backdrop click close it; closing restores focus to `returnFocus`. It returns `close()`.
  - Used by the shortcut sheet and the share window. Existing modals are not migrated.
- Pack card (`packs.js`): the `.btn-pack-download-icon` chip keeps its class and route, but its label becomes "Share" (icon + text).
  - On `isEngineLocal()`, after the save, it opens `#modal-share-pack` (in `index.html`), with the path = `exports_dir` + `packs` + the `X-DubMate-File` value. `saveRemoteFile` gains an `onSaved(res, dir)` option, so the dialog replaces the toast for this one caller.
  - **Copy** uses `navigator.clipboard.writeText`, falling back to selecting the text.
- Lobby (`lobby.js`, `index.html` `#btn-add-to-my-scenes` in `.lobby-action-group`): visible when `getHomeOrigin()` is set and differs from `location.origin`.
  - On click it POSTs `FormData{source: location.origin, pack_id}` to `${home}/api/packs/import_from_room`.
  - A rejected `fetch` (TypeError) falls back to `saveRemoteFile('/api/packs/<id>/export', …)` from the host, which is a browser download on this page.

## Existing data

- **Rooms on disk today**: one folder (plus any with live sockets). It loads as before. A missing `last_active_at` uses the folder mtime, a missing `creator_id` uses `host_id`, and a missing presence is 0. The next save adds the three fields and keeps every other key byte-for-byte as loaded.
- **Version 1 rooms** still migrate through `_migrate_v1_takes` and keep their loaded `last_active_at`.
- **Old room-scoped `noise_profile_<user>.wav`** files stay where they are, as in Calibrate Mic.
- **Tests** (`tests/test_sessions.py`, step 1), with a temp `CACHE_DIR` and a synthetic pack as in `test_take_model.RoomCase`:
  - a literal PR #16-era `room_state.json` (no new fields, `is_online: true`) loads, is listed with its folder mtime, opens as `host_id`, saves back with all original keys equal and the new ones added, and has every user offline;
  - a v1 literal still migrates and is listed;
  - retention with 8 folders (6 with takes at distinct times, 1 empty, 1 with unreadable JSON) keeps the newest 5 with takes plus the new room, keeps the unreadable one and an older room with a fake socket, deletes the 6th and the empty one, and never deletes anything `GET /api/sessions` returned before the prune;
  - presence round-trips.
- Existing tests that use `prune_sessions(keep_room_id="NONE")` to clean up (`test_noise_reduction.py` ×2, `test_noise_reduction_deep.py`) pass `keep=0`, which keeps their old meaning.

## Export, render, premiere and project ZIP

There is no change to the pipeline. `render_dub_mix`, `export_dub_video`, premiere and `build_project_zip` keep reading `room.mix_takes()`. A continued room renders with its saved presence level (it used to reset to 0), because the export route already falls back to `room.master_dialogue_presence_db`. The `exported_video_path` of a continued room is used only if the file still exists (`ready_export_path`, as today). Remove and prune never touch the exports folder, so saved videos, project ZIPs and shared scene ZIPs stay. The project ZIP manifest is unchanged; the new fields stay in room state.

## Not in this PR

- Stems export (needs PR #15).
- Reopening the last session automatically at launch; syncing sessions between computers; per-browser UI settings (my-lines filter, guide voice) as part of a session.
- Keeping registry tokens across restarts. A continued code may be refused for up to 12 h after its last publish, and Copy invite then falls back to the direct link it already offers.
- Listing sessions with no takes; a configurable limit.
- Closing the host's pack ZIP / media routes to tunnel guests, or guarding `POST /api/rooms` and `POST /api/packs/import` against tunnel requests (all pre-existing).
- Changing the manual import's replace-on-same-name behaviour.
- "Add to my scenes" outside the lobby, for browser-only guests, or for packs other than the room's.
- A "show in folder" button (the studio page has no desktop bridge for it).
- Shortcuts for knobs, sliders and the video size handle (control keys, not shortcuts); remapping shortcuts.
- Migrating existing modals to `openDialog`.

## Risks

- **Disk use.** Up to 5 sessions of takes (raw, cleaned and fitted WAVs per take) instead of 1. A long scene with many takes can be a few hundred MB. Users can remove sessions.
- **A hard kill loses up to 3 s of changes.** The desktop shell kills the engine, so the lifespan flush only helps on a clean stop. Take files written in those 3 s stay on disk but aren't in the state. This is the same as today.
- **The webview may block the room page from calling the member's own DubMate** (WebView2 local-network permission, WKWebView mixed content). The download fallback covers it; needs a hands-on check on both platforms.
- **Very large scenes over the tunnel.** The host builds the ZIP before answering, so a scene that takes over about 100 s to zip may hit Cloudflare's timeout. The member sees "Couldn't get the scene from the host."
- **`import_from_room` lets any web page the member visits ask their engine to fetch a scene from that same page's origin.** This is no wider than the existing `/api/packs/import`, which any page can already post a ZIP to. It is limited to https, `/api/packs/<id>/export`, no redirects, the size cap and the safe import path.
- **5 loaded rooms are reachable by code through the host's tunnel**, where there used to be 1. Codes are 6 characters from 32 symbols and the tunnel hostname is random.
- **Continue trusts the engine's own computer.** The routes refuse tunnel requests by header (as `POST /api/config` does), not by authentication.

## Decided overnight, revisit

1. Keep **5** sessions with takes. Empty sessions are neither listed nor kept, except the newest folder, which is always kept as today.
2. Order and "2 hours ago" use the **last change time** (`last_active_at`), falling back to the folder mtime for old rooms. Opening a session counts as a change.
3. Continue rejoins as the room's **creator** (`creator_id`, falling back to `host_id` for old rooms), not as a guest who was promoted.
4. A continued room's code is **republished**. If the registry refuses it, Copy invite falls back to the direct link. Registry tokens are not persisted.
5. The booth reopens at your saved line only when the room was recording and the saved line is past the first or you were in the booth.
6. **Booth ← / →** were added because PRODUCT.md promises arrows between lines. They are off while recording and never press Finish.
7. The sheet lists only shortcuts the tests prove. The builder's wrong "(←)" tooltips were fixed instead of changing the arrow step.
8. The pack card's "ZIP" becomes **Share**, with a path window on the engine's own computer.
9. **Add to my scenes**: lobby only, members from their own DubMate only, never replaces a scene of the same name, falls back to a download.
10. The host's pack ZIP route stays open to tunnel guests, as today. There is no host opt-out.
11. Session routes are local-only. A room someone creates through the host's link still shows on the host's card.
12. A `room_state.json` that can't be read is never auto-deleted.
13. The presence level is now saved with the session.

## Hands-on checks

- Desktop: record a few lines, pick takes, set presence, close DubMate from the booth, reopen. **Continue** lands on the same line with the same takes, casting and presence, and Render matches.
- Make 6 sessions with takes. The card shows 5. Creating a seventh room removes only the session no longer shown.
- Remove a session; its room folder is gone and its rendered video is still in the export folder.
- Two machines, Windows: a member who joined from their own DubMate presses **Add to my scenes**. Note any permission prompt. The scene appears in their library after leaving.
- The same on macOS (WKWebView). If blocked, the download fallback saves the ZIP and Import pack adds it.
- **Share** on Windows and macOS shows the real path; Copy works; a friend imports the file.
- Continue a session within 12 h of its last use and invite a friend: Copy invite gives a working link.
- Shortcut sheet with keyboard only and with NVDA / VoiceOver: focus stays inside, Escape closes, focus returns.
- A scene over 300 MB through the tunnel: note whether **Add to my scenes** finishes.

## Implementation steps

1. **Sessions engine: keep recent sessions, list, continue, remove.** (heavy)
2. **Continue where you left off on the landing page.**
3. **Keyboard shortcut sheet and booth arrow keys.**
4. **Pack sharing engine: import a scene from the room you're in.**
5. **Share and Add to my scenes in the studio.**
6. **CHANGELOG and ROADMAP.**

Each step's brief is in the step list returned with this design. Every step keeps `python tests/run_all_tests.py` green.
