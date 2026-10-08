# Design: the 2.0 update path, no dead ends after updating from 1.1.3

Branch `fix/v2-update-path` from `origin/main` at `d74e4c4` (PR #25 merged). Source: the 2.0.0 release-readiness audit (`%TEMP%/dubmate_overnight/release-2.0/READINESS.md`, sections 1.2, 1.4, 2 and 5). Before-shots: `%TEMP%/dm_shots/v2-update-path/before-*` (report in `before-report.txt`). They come from the engine run without pedalboard and without deep-filter, which is how a 1.1.3 desktop app sees 2.0 after the in-app update.

## Goal

A 1.1.3 desktop app updates itself to 2.0 without pedalboard and without the `deep-filter` sidecar. The old updater runs no pip and adds no sidecars. Only the 2.0 installer brings them. Today that user hits a dead end:

- **Every save fails.** Save video, Separate tracks and Editing project stop with "Download and install the latest DubMate to use voice effects." (`before-04`, `before-06`). A dub that was fine in 1.1.3 can't be saved at all.
- **The message says nothing about where to go.** "the latest DubMate" is what they just updated to. No link, no button (`before-01`, `before-04`).
- **Old rooms are rewritten with no backup.** Take WAVs are moved, so 1.1.3 can't open them again. A v1 take goes to whatever line is now at its old index, which is the wrong line if the pack changed after recording.
- **The update card shows only the top of the notes.** `[Unreleased]` starts with "Remove Pack Builder", and the one thing these users must do (run the 2.0 installer) sits at line 60.

After this PR, a 1.1.3 user who only took the update can record, preview and save everything. Takes play and save without effects, levelled as usual, and noise cleanup uses the built-in fallback. The host is told once, plainly, what's missing and where to get it, with a button that opens the download page. Old rooms keep a backup of their state and every original take file. A take is never put on a line it might not belong to. The release notes open with the installer note.

## Owner decisions this implements

- The brief for this PR. It **reverses effects-rack.md decision 26** ("export fails with that message rather than exporting without effects"): exports now degrade to dry takes. effects-rack.md gets a pointer to this doc.
- Calibrate-mic design: without DeepFilterNet, cleanup uses the existing fallback (afftdn, or the spectral gate for tuned cleanup). That path already works; this PR only adds the notice.
- The download place is the GitHub releases page of `sylenthsnares/DubMate`. In the desktop app it is opened through the allow-listed external command mechanism (`tauri/src-tauri/src/external.rs`), with exactly one new fixed target. In a browser it's a plain link.
- Out of scope (owner decisions elsewhere): `release.yml`, the installer, VERSION, draft releases, the reinstall option. Not touched: booth layout, lobby, landing, join flow, Pack Builder UI. The booth's Voice card only gets new text and a button inside its existing note element.

## Layout and behaviour

### 1. Engine: what is missing, and degrading instead of failing

- `audio_processor.missing_parts() -> List[str]`, in this order:
  - `"voice_effects"` when `vocal_chain.available()` is False;
  - `"strong_cleanup"` when `_noise_reduction_engine() == "fallback"` **and** the engine runs from the desktop app's bundled runtime (`python-runtime` is in the path of `sys.executable`). Source installs on macOS and Linux never had DeepFilterNet, so they aren't nagged.
- `DOWNLOAD_PAGE_URL = "https://github.com/sylenthsnares/DubMate/releases/latest"`, in `dubmate/common.py`, the one engine constant.
- `EFFECTS_MISSING_MESSAGE` becomes "Voice effects need the DubMate 2.0 installer. Get it from github.com/sylenthsnares/DubMate/releases." This is what the 503 from the render route and the logs carry.
- `/health` adds `"missing": [...]`. `Room.to_state_dict()` adds `"engine_missing": [...]`, the host engine's list, so the studio knows without an extra request.
- **Dry renders.** When `EffectsUnavailable` is raised, `_render_take` reads the take's own audio and applies the same clamped level (`gain_db`, which already holds the auto gain measured on the raw take when effects are missing: `_rematch_level`). It doesn't raise any more. This covers `render_dub_mix`, `export_dub_video` (Save video, the premiere's video, 9:16), `build_stems_zip` and `build_project_zip`. The master stage, mix balance and presence are unchanged; none of them needs pedalboard.
- Logged **once per engine run**: `[Effects] Voice effects aren't installed; videos, stems and projects are saved without them.` No log line per take.
- Project ZIP when dry: the manifest's `master` gets `"voice_effects": false`, and the cue sheet's sound line reads `Sound: none (voice effects not installed)` instead of a preset name it didn't apply.
- Kept as they are: the render route's 503 `{effects_unavailable, message}` (the Voice card and the premiere's live mix already play the raw take on it), `queue_preset_renders` returning early, and `_render_level` returning None.
- The export routes' `except EffectsUnavailable` branches (`rooms_api.py`: stems, project ZIP) can no longer fire. Remove them, and the docstrings that promise the failure.
- Missing `deep-filter`: no code path fails today (`apply_noise_reduction` falls back, room check and Refresh older takes run on the fallback). The tests below pin that.

### 2. Studio: one notice for the host, and where to get 2.0

New module `static/js/studio/update_notice.js` (methods mixed in like the other studio modules, plus exported helpers for tests):

- `DOWNLOAD_PAGE_URL` (the same address) and `DOWNLOAD_PAGE_LABEL = "github.com/sylenthsnares/DubMate/releases"`.
- `downloadPageControl({ size })` returns one control:
  - **Desktop app** (`window.__TAURI__?.core?.invoke` and the engine is this computer's, `isEngineLocal()`): a `button.btn.btn-secondary.btn-sm` "Open download page". It calls `invoke('open_download_page')`. If the app refuses the call (a launcher older than 2.0, which is every 1.1.3 user here), it copies the address to the clipboard and replaces the hint text beside it with "Link copied. Paste it into your browser." If the copy fails too, the hint shows the address as selectable text.
  - **Browser:** `a.btn.btn-secondary.btn-sm` with `href=DOWNLOAD_PAGE_URL`, `target="_blank"` and `rel="noopener noreferrer"`. The text is the same.
- Both get `data-tip` set to the address, so it is visible on hover and focus.

**The premiere notice (host only, once).** It's a row in `#view-screening` right after `#screening-save-error`, in the same slot and with the same width as that row: `<div id="screening-update-notice" class="update-notice" role="status" hidden>`.
- It is shown when the user is the host, `roomState.engine_missing` isn't empty, and it hasn't been dismissed for this engine version and this list. The localStorage key is `dubmate_update_notice` = `"<version>|<missing joined by ,>"`, using the version from `/health`, which the lobby already reads.
- **Copy**, plain and short, one sentence, then the controls:
  - effects missing (with or without cleanup): "This DubMate saves videos, stems and projects without voice effects. Install DubMate 2.0 from github.com/sylenthsnares/DubMate/releases to add them{ and stronger noise cleanup}."
  - cleanup only: "Install DubMate 2.0 from github.com/sylenthsnares/DubMate/releases for stronger noise cleanup."
  - controls: the download control, then `button.btn.btn-ghost.btn-sm` "Got it", which hides the row and stores the key.
- **Look:** walnut control surface (`--secondary`), 1px `--border-wood`, `--radius-md`, 10px 14px padding, an info-circle SVG in `--accent-brass` (14px, the stroke icon the export modal's reassurance row uses), 12px text in `--foreground-muted` with the first clause in `--foreground`. Controls sit on the right on wide windows and wrap under the text below 1100px. No amber: Play stays the one primary. No red: nothing failed. At 960x680 the theater keeps its height; the row pushes the sections down, as the save-error row does.
- A save that ran dry shows nothing else. The notice is the one place this is said, so no toast per export.

**Voice card note** (`#voice-effects-note`, existing element, booth layout unchanged):
- On the host's own engine: "Voice effects need the DubMate 2.0 installer, from the download page on GitHub. Takes play without them until then." Then the download control (small) inline after the text.
- A member on someone else's engine (`!isEngineLocal()`): "Voice effects aren't installed on the host's DubMate. Takes play without them." There's no control, because the member can't fix the host's install.
- The engine's 503 message is no longer copied verbatim into the note. The note is built from `voiceUnavailable` and `isEngineLocal()`.

**Room check row** (Audio settings, `#room-check-row`): when `engine_missing` (or `/health` `missing` before a room exists) includes `strong_cleanup` and the engine is local, a quiet line under the status reads "Stronger cleanup needs the DubMate 2.0 installer." with the download control. It uses `.audio-device-note` text, not amber.

**Export failures** keep their current UI. No export fails for missing effects any more, so the failed modal never shows the old message.

### 3. Desktop app: one fixed external target

- `external.rs`: `ExternalTarget::DownloadPage`. Windows: `rundll32 url.dll,FileProtocolHandler https://github.com/sylenthsnares/DubMate/releases/latest`. macOS: `open <url>`. Anything else returns Err. The URL is a `const` in Rust, and nothing from the page reaches the command.
- `#[tauri::command] pub fn open_download_page()`, registered in `main.rs`, listed in `build.rs`. `allow-open-download-page` goes in `capabilities/studio.json` (the studio page) and in `capabilities/default.json` (the launcher, for a later error card; it's harmless now). Update the studio.json description.
- A Rust test for both OSes, and one that rejects Linux.
- `cargo check` and `cargo test` with `CARGO_TARGET_DIR=X:/Projects_X/DubMate/tauri/src-tauri/target`.

### 4. Room migration safety

In `dubmate/rooms.py` `load_room_folder` / `_migrate_v1_takes` and `audio_processor.migrate_legacy_take_files`:

- **Backup first.** Before the first migration save of a room whose `state_version` is missing or 1, copy the original `room_state.json` byte for byte to `room_state.v1-backup.json` in the same folder. An existing backup is never overwritten. If the backup can't be written, the room loads in memory but **isn't saved**: it's logged and retried next start.
- **Never delete original take audio.** `migrate_legacy_take_files` **copies** `take_line_<i>{,_raw,_denoised*}.wav` to `takes/<line_id>/<take_id>…` (copy to a temp name, then `os.replace` into place) and leaves the originals. Rollback removes only the copies it made. A rerun finds the copies in place. Disk for old rooms doubles; that's the price of a way back.
- **Never on a wrong line.** Old state has no line text, start or filename, only `recorded_at`. So a v1 take is placed on the line at its old index only when the pack can't have changed since that take was recorded:
  - every line audio file at index ≤ the take's index has an mtime ≤ `recorded_at` + 2 s, so nothing was inserted or rebuilt at or before it;
  - and the pack folder's own mtime is ≤ `recorded_at` + 2 s, so no line file was removed.
  
  A take that fails either check, or has no usable `recorded_at`, is **unplaced**. Its old entry goes to `room.unplaced_v1_takes` (`{old_index: entry}`, saved in `room_state.json`), and its files stay where they are, untouched. It is logged: `take for old line N kept aside: the scene changed after it was recorded`. This PR adds no UI to place them. The backup and the files keep that possible.
- The engineer confirms that nothing in 2.0 writes into a pack folder on load, or the folder-mtime check would misfire. Covers and caches go to `data/`.
  - Confirmed (G3): loading a pack writes only a missing `_captions.json` or `_TIMESTAMPS.txt`, and 1.1.3 already wrote both the first time it loaded the pack, before any take. A pack loaded by 1.1.3 and then by 2.0 keeps its folder and file times (checked on the real 1.1.3 code).
  - Adding or removing any line file moves the folder's time, so in practice any edit of the pack after recording keeps all of that room's v1 takes aside, not only the ones after the edit. The line-file rule still guards against a file replaced in place.
  - Files kept aside are `take_line_<i>*.wav`; the room's `unplaced_v1_takes` names them by old index. A kept-aside take counts as a take for the Continue list, so session pruning keeps the room.
- `pending_v1_takes` (a copy that failed, retried next start) keeps working as today.

### 5. CHANGELOG `[Unreleased]`

- **Intro at the very top**, before `### Added`. Plain text, no markdown emphasis or links in the first lines, because the 1.1.3 card prints raw text and shows only the top:
  1. "Using the DubMate desktop app 1.1.3? Run the DubMate 2.0.0 installer from https://github.com/sylenthsnares/DubMate/releases/latest to get voice effects and the stronger noise cleanup. The in-app update alone brings everything else."
  2. One line for source installs: re-run `update.bat` / `update.sh`.
  3. A 3-line "What's new in 2.0".
  4. Back up `rooms/`. Rooms opened in 2.0 can't go back to 1.1.3. Each keeps `room_state.v1-backup.json` and its original take files.
- Add PR #25 (premiere and export) entries:
  - the Live mix / Final video label;
  - the bigger premiere and the "In this dub" list, where clicking a line jumps playback for everyone;
  - mix presets;
  - the two-step Save with Try again, Watch the dub and Show in folder;
  - 9:16 moved into Save;
  - friends can't start a video.
  
  Rewrite "Premiere Mix Reaches the Video" so it doesn't mention the slider.
- Add this PR's entries:
  - saves without voice effects instead of failing, with the notice;
  - the Open download page button;
  - old rooms keep a backup;
  - takes that can't be matched to a line are kept aside.
- Merge the second `### Changed` (Engine Layout, CI) away. Both are developer-only, so delete them.
- Remove the developer-only entries the audit lists: L46-48, L62/L74 px wording, L90-94, L104 jargon, L107, L109, L119-121, L135-136. Reword where the user-facing part matters.
- Fix the overclaims:
  - L43 applies only to the 2.0 installer;
  - L59 only from 2.0's launcher on;
  - L55 "exactly the same" becomes "the same effects", because overall loudness differs (effects-rack decision 11);
  - L93 contradicts L12, so keep L12.
  - "Voice Effects on Older Desktop Installs" now says exports save without effects, plus the notice.
- **Merge-friendly:** keep the four headings in today's order, change nothing within 3 lines of the anchors the other branches insert after ("Keep Going While a Take Saves", "Takes Kept When the Upload Fails", "Pack Builder Play", "\"Take Saved\" Twice"), and add new entries at the end of their section.

## Implementation groups (build order)

1. **G1 Engine degrades** (§1): Python plus tests, the effects-rack.md pointer, and verification on the real 1.1.3 runtime.
2. **G2 Studio notice and desktop button** (§2, §3): JS, CSS, Rust plus tests, and the after-shots.
3. **G3 Room migration safety** (§4): Python plus a verbatim 1.1.3 room fixture.
4. **G4 CHANGELOG** (§5).

## Tests

- Python, without pedalboard (`mock.patch.object(vocal_chain, "available", return_value=False)`, and once with `sys.modules["pedalboard"] = None` in a subprocess):
  - `export_dub_video`, `build_stems_zip` and `build_project_zip` succeed, and voices equal raw × level;
  - the stems and project routes return 200, and the export job broadcasts `export_ready`;
  - the render route still returns 503 with the new message;
  - `missing_parts`, `/health` `missing` and the room state's `engine_missing` are right;
  - the manifest has `voice_effects: false`.
- Python, without deep-filter (`get_deep_filter_path` returns None): upload with cleanup, the toggle, Refresh older takes and a room check all work, and `strong_cleanup` is reported only for a `python-runtime` executable.
- Python migration:
  - a room written by the real v1.1.3 code (fixture generated by `tests/fixtures/make_v113_room.py` from `git show v1.1.3:…`, committed so CI needs no tags) loads;
  - the backup is byte-identical, an existing backup isn't overwritten, and a failed backup means no save;
  - originals are kept and the copies are byte-identical;
  - a pack edited after recording (a line inserted before index 2, line file mtimes set by `os.utime`) leaves that take unplaced and the earlier ones placed;
  - a missing `recorded_at` leaves the take unplaced;
  - the folder mtime is newer;
  - a rerun is idempotent.
- Node:
  - `test_update_notice.js`: desktop invoke ok, the refusal copies the link, browser anchor attributes, the host-only premiere notice, the dismiss key, the copy variants;
  - `test_voice_panel.js` and `test_voice_preview.js`: the new texts, and members get no control.
- Rust: `external.rs` tests.
- The existing release-metadata, design-token and floor tests stay green.

## Risks

- **The 1.1.3 launcher refuses `open_download_page`.** Its studio page has no IPC capability at all, so on exactly the users who need it most, the button falls back to copying the link. The address is in the sentence, so it is never a dead end. Check it hands-on.
- **The mtime rule can leave takes unplaced** when a pack folder was copied or moved after recording, because a copy gets a fresh folder mtime. They are kept and logged, not lost. A later PR can add a "Place old takes" action.
- **Copying take files doubles an old room's disk use** until the room is pruned or removed.
- **Merges:**
  - `voice_rack.js` line 10 sits 3 lines under the header comment both layout branches rewrite;
  - `rooms.py` `load_room_folder` is touched by `ui/v2-join-flow` (the host colour line, away from the migration code);
  - CHANGELOG, as above.
- Dry exports change the cue sheet and manifest wording. No tool reads them back.

## Decided without the owner

1. Exports, stems, project ZIPs and the premiere's video save **dry** when voice effects are missing. This reverses effects-rack.md decision 26, as the brief asks.
2. The download address is `…/releases/latest`, the newest release page with its installers, rather than the release list.
3. The notice is shown once per engine version and missing set, to the host only, on the premiere, until "Got it". There's no toast per export.
4. `strong_cleanup` is reported only for the desktop app's bundled runtime. Source installs aren't nagged.
5. A member on a host's engine sees "not installed on the host's DubMate", with no button.
6. On an older desktop app, "Open download page" copies the link and says so. The address is always in the text.
7. The backup is named `room_state.v1-backup.json` and is written once. If it can't be written, the migration isn't saved.
8. Old take files are copied, not moved, and are never deleted by migration.
9. A v1 take is placed only when the pack provably didn't change after it was recorded (mtimes). Otherwise it is kept aside in `unplaced_v1_takes`, with no UI yet.
10. The project manifest gains `master.voice_effects: false` when dry, and keeps `"version": "2.3"`.
11. The `allow-open-download-page` permission is also granted to the launcher capability.
12. CHANGELOG (G4): `origin/main` (PR #27) was merged in first, because it adds entries right after "Easier to Read", which this PR rewords. New Changed entries go after "Older Rooms Keep Their Sound" and "Voice Effects on Older Desktop Installs", not at the end of Changed, because ui/v2-join-flow appends there. "Reconnecting" keeps "960px wide": the line above it is changed by ui/v2-join-flow, so rewording it would conflict. `git merge-tree` against both branches merges CHANGELOG.md cleanly.

## Hands-on checks

- **A.** Install 1.1.3, record a room, and apply the 2.0 bundle by extracting it over `resources` (READINESS 1.5 A). Then:
  1. the old room opens with its takes, and `room_state.v1-backup.json` and the `take_line_*.wav` files are still there;
  2. Save video, Separate tracks and Editing project all save;
  3. the premiere notice shows once, and "Got it" keeps it away;
  4. **Open download page** copies the link (1.1.3 launcher).
- **B.** On a 2.0 installer build, Open download page opens the browser on the releases page, on Windows and on macOS.
- **C.** Edit a pack in 1.1.3 after recording (rebuild with a line inserted), then update. The takes after the insert are kept aside, not on wrong lines.
- **D.** Read the top of the `[2.0.0]` notes in the 1.1.3 update card at 960x680. The installer line must be readable.
- **E.** A guest on a tunnel to an updated 1.1.3 host sees the member wording in the Voice card and no notice on the premiere.
