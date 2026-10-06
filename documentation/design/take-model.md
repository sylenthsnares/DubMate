# Design: take model (stable line IDs, take history, picking a take)

Roadmap feature 1. Owner decisions: October 2026 interview (ROADMAP.md, Decisions). Branch `feat/take-model`.

**Gate.** ROADMAP.md asks for a design review with the owner before any code. Step 1 does not start until the owner has signed off "Decided overnight, revisit" below.

## What changes for the user

Today a line has one take. Recording again overwrites it, and takes are keyed by line position, so a rebuilt pack can attach takes to the wrong line.

After this PR:

| Behaviour | Where | Disclosure level |
|---|---|---|
| Recording again adds a new take. Nothing is overwritten. The new take is the one used in the dub. | Record button (unchanged) | Default |
| The booth shows the take in the dub: waveform, Preview, nudge, pitch, reverb, level and noise reduction all act on it. Status line reads "Take 3 by Ana (2.4s)". | Booth | Default |
| The delete button deletes the take in the dub, after a confirm. The newest remaining take takes its place. With no takes left, the line plays the original voice again. | Booth nav, existing button | Default |
| **Takes (3)** opens the line's take history. Each row: "Take 2 · Ana · 2.4s", **Play** (hear it over the scene with its own settings, sliders untouched), **Use** (put it in the dub), delete. The take in the dub is marked "In the dub". | Under the record status | One click away. Shown only when the line has 2+ takes and `canRecordLine(line)` is true, so guests only see their own lines' takes. |
| Preview, premiere, video export and the project ZIP use the take in the dub. | Everywhere | Default |
| Picking or deleting a take shows up for everyone in the room straight away. | Multiplayer | Default |
| Takes stay attached to their line when the pack is rebuilt with the same cue times, even if lines were added before them or characters renamed. | Engine restart | Invisible |
| A tab left open across a DubMate update says "DubMate was updated. Reload this page to keep going." instead of misbehaving. | Studio | Only when it happens |

New strings (PRODUCT.md voice): "Takes (N)", "Take N by NAME (Ds)", "In the dub", "Play", "Use"; tooltips "Listen to your other takes and choose the one used in the dub" (Takes), "Use this take in the dub" (Use); toasts "Take N is in the dub", "Take deleted"; confirm "Delete take N? This can't be undone."; the reload notice above.

## Data model

### Stable line ID

`pack_loader.assign_line_ids(lines)` sets `line["line_id"] = f"t{round(line['start'] * 1000)}"`, e.g. `t44048`. It must use `round`, not `int`: truncation gives the wrong millisecond for about 1% of start times (1.001 s becomes 1000). Lines on the same millisecond get `-2`, `-3` in line order (`t44048-2`). It runs at the end of `load_pack` and in `load_persistent_pack_cache` for restored lines (old caches have no `line_id`). `PackInfo.to_dict()` then carries `line_id` on every line.

Why start time: the Pack Builder writes it into each slice filename (`{i+1:02d}_{char}_{sec}-{ms:03d}.wav`, `pack_builder.py`) and the loader reads `start` from there. A recompile of the same builder session keeps the cue times, so IDs survive it. Index and filename prefix shift when a line is inserted earlier; character names change on rename. A retimed line is a new line (see Risks).

`line["index"]` stays: it is still the line's position for the timeline, the booth and the render.

### Room state (`room_state.json`, `"state_version": 2`)

```json
{
  "state_version": 2,
  "room_id": "ABC123", "pack_id": "...", "host_id": "...", "users": {}, "role_assignments": {},
  "status": "lobby", "exported_video_path": null,
  "takes": {
    "t44048": {
      "picked": "9f3c1a2b",
      "next_number": 3,
      "takes": [
        {"take_id": "take1", "number": 1, "user_id": "...", "user_name": "Ana",
         "duration": 2.41, "peaks": [[0.1, 0.2]], "audio_version": 1790000000123,
         "offset_ms": 0, "pitch_semitones": 0.0, "reverb_wet": 0.0, "gain_db": -3.2,
         "noise_reduction": true, "has_raw": true,
         "speech_loudness_db": -18.1, "target_loudness_db": -21.3, "auto_gain_db": -3.2,
         "recorded_at": 1790000000.0},
        {"take_id": "9f3c1a2b", "number": 2, "...": "..."}
      ]
    }
  }
}
```

- `Room.takes: Dict[line_id, {"picked": take_id | None, "next_number": int, "takes": [take, ...]}]`, oldest first.
- `take_id`: `uuid4().hex[:8]` for new takes; `take1` for a migrated take.
- `number` comes from `next_number`, which only goes up, so a number is never reused after a delete (takes 1, 2, 3; delete 3; next is 4).
- No file paths or URLs are stored. Paths are derived from room, line and take ID; the audio URL is derived from them plus `audio_version` (ms timestamp, bumped on upload and on a noise-reduction switch, used as `?v=` for cache busting).
- Entries for line IDs not in the current pack stay in state and on disk but are never shown or mixed. A rebuild that brings the line back brings its takes back.
- Offset, pitch, reverb, gain, auto gain (B3) and noise reduction stay per take, exactly as today. B1 per-room reset is unchanged: takes live in the room folder.

### Files on disk

```
<cache>/rooms/<ROOM>/
  room_state.json
  noise_profile_<user>.wav                       (unchanged)
  takes/<line_id>/<take_id>.wav                  active audio (raw or cleaned copy)
  takes/<line_id>/<take_id>_raw.wav              original recording, never altered
  takes/<line_id>/<take_id>_denoised_<key>.wav   cleaned version (P10 key = NR_VERSION, attenuation, engine)
```

The audio functions work on a directory plus a file stem instead of a line index: `denoised_take_path(take_dir, stem)`, `_remove_old_denoised_takes(take_dir, stem, keep)`, `save_uploaded_take(room_id, take_dir, stem, ...)`, `toggle_take_noise_reduction(room_id, take_dir, stem, ...)`, `delete_take_files(take_dir, stem)`. `take_dir(room_id, line_id)` builds `<room>/takes/<line_id>` with `_sanitize_id_token` and `_ensure_within_directory`, like `get_room_cache_dir`. Cleaning one take never touches another take's files.

## API and WebSocket

REST, all under `/api/rooms/{room_id}/lines/{line_id}/takes`:

| Method and path | Body | Effect | Broadcast |
|---|---|---|---|
| `POST …/takes` | multipart as today (`file, user_id, user_name, offset_ms, pitch_semitones, reverb_wet, gain_db, noise_reduction, auto_gain`) | adds a take and picks it | `take_recorded {line_id, line_index, take_id, url, noise_reduction, user_name, user_id}` |
| `POST …/takes/{take_id}/pick` | `{"user_id"}` | picks the take | `take_picked {line_id, line_index, take_id, user_id}` |
| `DELETE …/takes/{take_id}?user_id=` | | deletes the take's files and entry; a deleted picked take falls back to the newest remaining | `take_deleted {line_id, line_index, take_id, picked, user_id}` |
| `POST …/takes/{take_id}/noise_reduction` | `{"noise_reduction"}` | as today, per take | `take_params_updated {line_id, take_id, url, noise_reduction}` |
| `GET …/takes/{take_id}/peaks` | | as today | |
| `GET …/takes/{take_id}/audio` | | as today (Range, long cache with `?v=`) | |

- **Permissions.** Upload, pick and delete use today's upload check, moved into `rooms_api._require_line_actor(room, line, user_id)`: 403 only when the line's character has assigned actors and the caller is neither one of them nor the host. Unassigned lines are open to everyone, and in a solo room (`host_id == "host"`) everyone counts as host. This is no stricter than today for upload; pick and delete are new actions. The noise-reduction switch and `update_take_params` stay unguarded, as today. The client shows the history only where `canRecordLine(line)` is true, which is narrower than the server rule for unassigned lines; that difference exists today and is unchanged.
- Unknown line: 400 "That line isn't in this scene." on upload (as today), 404 elsewhere. Unknown take: 404.
- Delete removes files under `room.processing_lock`. Files that can't be removed (held by a running render on Windows) are skipped quietly by `_remove_quietly`; the entry is removed regardless.
- Every mutation calls `room.invalidate_exports()`.
- The old `/api/rooms/{room_id}/takes/{line_index}…` routes are removed in step 5.

WebSocket:
- `update_take_params` payload becomes `{line_id, take_id, offset_ms?, pitch_semitones?, reverb_wet?, gain_db?}`; broadcast `take_params_updated {line_id, take_id}`. A payload without `line_id`/`take_id` is ignored.
- `clear_take` and `take_cleared` are removed (delete is the REST route). An old tab's `clear_take` falls through the if/elif chain and is ignored.

State payload (`Room.to_state_dict()`): adds `"state_version": 2`; `takes` has the on-disk shape plus a derived `url` per take, minus `peaks` on takes that are not picked (fetched on demand from `…/peaks`), so unlimited takes don't bloat every broadcast.

**Stale tabs.** A guest's studio JS is always served by the host's engine (`room_socket.js` connects to `window.location.host`), so client and server versions only differ when a tab loaded before the host updated and restarted, then reconnects. From step 5 the client checks `state.state_version` against its own `TAKE_STATE_VERSION` and, on a mismatch, shows the reload notice and stops applying state. Tabs from before this PR have no such check; they fail harmlessly: their index routes 404 and their `clear_take` / index-keyed `update_take_params` are ignored, so no take is changed. Reloading fixes them.

## Export, render, premiere and project ZIP

`Room.mix_takes() -> Dict[int, dict]` returns `{line["index"]: {**picked_take, "wav_path": take_wav_path(room_id, line_id, take_id)}}` for the lines of the current pack, as copies. It replaces every `dict(room.takes)` passed to `audio_processor.export_dub_video`, `render_dub_mix` and `build_project_zip` (`rooms_api.export_room_dub`, `download_room_dub`, `download_room_project_zip`; `room_ws` `launch_premiere`). The render functions keep their `{line_index: take}` input and read `wav_path`, so render, levelling and the limiter are untouched. A line with no take still falls back to the original voice.

The project ZIP contains the picked take of each line, as today. `_project_manifest` adds `line_id` and `take_id` to each line entry.

The studio premiere and screening use the picked take via the same client helper as the booth.

## Migration of existing rooms

`rooms.load_persisted_rooms()` reads `room_state.json`. A file without `"state_version": 2` is the old layout: `takes` keyed by line index, files `take_line_N.wav`, `take_line_N_raw.wav`, `take_line_N_denoised_<key>.wav` (and the keyless `take_line_N_denoised.wav`) in the room folder.

For each old take, `rooms._migrate_v1_takes`:
1. Index outside the current pack: log it, leave its files in place. Nothing is deleted.
2. Otherwise `audio_processor.migrate_legacy_take_files(room_id, line_index, line_id, "take1", noise_reduction)` renames (`os.replace`, same volume) each file into `takes/<line_id>/take1*.wav`, keeping the denoised suffix. If the active file is missing: with noise reduction on and a denoised file for the current key, that is copied to the active name; otherwise the raw file is copied and the take's noise reduction is set off, so state matches what plays. It returns `has_audio`, `has_raw` and the final `noise_reduction`.
3. The take becomes `{"picked": "take1", "next_number": 2, "takes": [old fields minus wav_path and url, plus take_id "take1", number 1, audio_version now, has_raw from disk]}`.
4. The room is saved as version 2 straight away (`_sync_save_to_disk`).

It is idempotent: a crash after moving files but before saving leaves a version 1 state whose files are already under `takes/`; the next load finds them there and finishes. A take with no audio anywhere is dropped from state and logged (there was nothing to play).

Migration ships in the same commit as version 2 save/load (step 3), so no build ever skips old rooms on load and lets `prune_sessions` delete them.

**Test** (`tests/test_take_model.py`, no network, no committed binaries, safe to run directly): every case gets its own `tempfile.mkdtemp()` cache dir, patched in with `mock.patch.object(audio_processor, "CACHE_DIR", tmp)` (it is a separate binding from `pack_loader.CACHE_DIR`), clears `rooms.ROOMS` before and after, and registers a synthetic 3-line pack in `packs_cache.PACKS_CACHE`. This matters because `load_persisted_rooms()` calls `prune_sessions()` first, which keeps only the newest room folder. Fixture, built in code: a version 1 `room_state.json` from a literal dict in today's schema; `take_line_0.wav` + `_raw` + `_denoised_<key>`; `take_line_1.wav` only; `take_line_7.wav` for an index outside the pack. Assertions: takes keyed by line ID, one picked take each with `next_number` 2, byte-identical files at the new paths, old names gone for migrated lines, `take_line_7.wav` untouched, state rewritten with `state_version: 2`, a second load changes nothing. Separate cases: half-migrated folder (files moved, state still version 1); active file missing with noise reduction on (denoised copy used) and off (raw used); audio route serves the migrated take.

## Not in this PR

- Comping inside a take (Later).
- Auto-selecting the best-timed take, latency calibration, auto-align, trim and stretch (feature 2). Only the existing offset is kept per take.
- Effect chains per take, presets, the rack (feature 3). The existing pitch, reverb and level stay per take.
- "Refresh older cleaned takes" (feature 4).
- Exporting every take, undo for delete, keyboard shortcuts for takes.
- Permission checks on the noise-reduction switch and the effect sliders.
- Swapping a running room onto a rebuilt pack. A rebuilt pack is picked up when the engine restarts.

## Risks

- **Retimed or re-detected lines.** Moving a cue's start gives it a new ID; its takes stay on disk and in state but leave the mix until the line is back at that time. Not settled: whether a fresh builder session (new Whisper/Demucs run, and later feature 5's activity detection) reproduces the same millisecond starts. Check by building the same source twice in separate sessions and comparing slice filenames. If it drifts, a later PR can match by nearest start within a tolerance.
- **Migration attaches by old index.** Old state stores no start time or filename, so a v1 take goes to whichever line is at its index in the current pack. If the pack was rebuilt with lines inserted before the upgrade, a take lands on the wrong line, exactly as it would today. It can't be avoided; the take is still there and can be deleted.
- **Stale tabs** across an update (see API section). Covered from now on by `state_version`; tabs from before this PR fail harmlessly until reloaded.
- **Delete is permanent.** It removes files, where today's `clear_take` only dropped the state entry and left the WAVs behind. The owner brief asks for this; see decision 8.
- **Disk use.** Unlimited takes grow the room folder. Single-session pruning still removes old rooms when a new one is created.
- **Broadcast size.** Mitigated by sending peaks only for picked takes.
- **Intermediate commits.** The app works end to end after every step: step 3 keeps today's wire format as an adapter over the new model, step 4 is a client-only refactor, and step 5 switches server and client together.

## Decided overnight, revisit

1. Line ID = start time in ms (`t<round(start*1000)>`, `-2` for same-start duplicates), not index, filename or character. A retimed line counts as a new line.
2. Takes whose line ID is not in the current pack are kept (state and files) but hidden and not mixed.
3. A new take is always picked, including one recorded by someone else on a shared character.
4. A new take starts with the booth's current settings (the picked take's offset, pitch, reverb; level matched unless set by hand), as today.
5. Take numbers are per line, from a stored `next_number`, never reused.
6. The Takes button appears only with 2+ takes and only where `canRecordLine(line)` is true.
7. Upload, pick and delete use today's upload check exactly (403 only for a cast character when the caller is neither its actor nor the host). The noise-reduction switch and sliders stay unguarded, as today.
8. Delete removes the take's files, as the owner brief says. ROADMAP's "non-destructive" is read as "recording never overwrites". The alternative is a soft delete (hide the take, keep files). Owner to confirm.
9. Unpicked takes carry no peaks in broadcasts.
10. Migration renames old files into the new layout (no copies), maps each old index to the current pack's line at that index, and leaves out-of-pack files in place.
11. Migration with a missing active file prefers the current-key denoised file when noise reduction was on, else raw with noise reduction off.
12. Deleting the last take returns the line to the original voice. No undo; a confirm instead.
13. Play in the history uses that take's own settings and doesn't move the sliders.
14. Noise reduction and effect sliders act on the picked take only.
15. File paths and URLs are derived, not stored; `audio_version` is stored for cache busting.
16. The project ZIP has picked takes only; the manifest gains `line_id` and `take_id`.
17. A stale tab gets a reload notice; no automatic reload (it could cut off a recording).
18. Step 3 keeps the old index-keyed routes and state shape as an adapter for one commit, so the app keeps working until the client switches.

## Implementation steps

1. **Stable line IDs.** `pack_loader.assign_line_ids` (`round`), called from `load_pack` and `load_persistent_pack_cache`; tests.
2. **Per-take file functions.** `audio_processor` take functions move from line index to (directory, stem); routes pass `get_room_cache_dir(room_id), f"take_line_{i}"`, so nothing changes on disk. Add `take_dir`, `take_wav_path`, `delete_take_files`, `migrate_legacy_take_files`; update the direct-call tests; unit tests for the new functions.
3. **Take history in the engine, with migration.** `Room.takes` by line ID with history, `next_number` and picked take; `add_take`/`pick_take`/`remove_take`/`mix_takes`; version 2 save/load and the version 1 migration in one commit; old routes and socket messages become adapters over the picked take; render call sites and the ZIP manifest; `tests/test_take_model.py`.
4. **Studio reads takes through helpers.** `static/js/studio/takes.js` with `pickedTake`/`lineTakes`/`takeCount`/`takeAudioKey`, used at every call site; behaviour unchanged; JSDOM tests.
5. **Line and take IDs on the wire.** New REST routes (upload, pick, delete, noise reduction, peaks, audio) with `_require_line_actor`, version 2 state payload, socket by take, `take_picked`/`take_deleted`, old routes and `clear_take` removed; client helpers, URLs, socket handlers, delete button and the stale-tab notice switch in the same commit; Python and JSDOM tests.
6. **Take history in the booth.** Takes button and panel with Play, Use and delete; JSDOM tests.
7. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 1 marked done.
