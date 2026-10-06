# Design: take model (stable line IDs, take history, picking a take)

Roadmap feature 1. Owner decisions: October 2026 interview (ROADMAP.md, Decisions). Branch `feat/take-model`.

## What changes for the user

Today a line has one take. Recording again overwrites it, and takes are keyed by line position, so a rebuilt pack can attach takes to the wrong line.

After this PR:

| Behaviour | Where | Disclosure level |
|---|---|---|
| Recording again adds a new take. Nothing is overwritten. The new take is the one used in the dub. | Record button (unchanged) | Default |
| The booth shows the take in the dub: waveform, Preview, nudge, pitch, reverb, level and noise reduction all act on it. Status line reads "Take 3 by Ana (2.4s)". | Booth | Default |
| The delete button deletes the take in the dub. The newest remaining take takes its place. With no takes left, the line plays the original voice again. | Booth nav, existing button | Default |
| **Takes (3)** button opens the line's take history. Each row: "Take 2 · Ana · 2.4s", **Play** (hear it over the scene with its own settings, sliders untouched), **Use** (put it in the dub), delete. The take in the dub is marked "In the dub". | Under the record status | One click away. Shown only when the line has 2+ takes and you can record the line, so guests only see their own lines' takes. |
| Preview, premiere, video export and the project ZIP use the take in the dub. | Everywhere | Default |
| Picking or deleting a take shows up for everyone in the room straight away. | Multiplayer | Default |
| Takes stay attached to their line when the pack is rebuilt with the same lines, even if lines were added before them or characters renamed. | Engine restart | Invisible |

Copy follows PRODUCT.md: plain, outcome-first. New strings: "Takes (N)", "Take N by NAME (Ds)", "In the dub", "Play", "Use", tooltips "Listen to your other takes and choose the one used in the dub" (Takes button), "Use this take in the dub" (Use), toasts "Take N is in the dub", "Take deleted", confirm "Delete take N? This can't be undone."

## Data model

### Stable line ID

`pack_loader.assign_line_ids(lines)` sets `line["line_id"]` for every line: `t<start in ms>`, e.g. `t44048`. Lines that start on the same millisecond get `-2`, `-3` in line order (`t44048-2`). It runs in `load_pack` and when `load_persistent_pack_cache` restores cached lines (old caches have no `line_id`). `PackInfo.to_dict()` therefore exposes `line_id` on every line.

Why start time: it is what the Pack Builder writes into each line's filename (`{n:02d}_{char}_{sec}-{ms}.wav`), so a rebuild with the same cue times gives the same IDs. Index and filename prefix shift when a line is inserted earlier; character names change when speakers are renamed. A retimed line is a new line (see Risks).

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
      "takes": [
        {"take_id": "take1", "number": 1, "user_id": "...", "user_name": "Ana",
         "duration": 2.41, "peaks": [[...]], "url": "/api/rooms/ABC123/lines/t44048/takes/take1/audio?v=...",
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

- `Room.takes: Dict[line_id, {"picked": take_id | None, "takes": [take, ...]}]`, oldest first.
- `take_id`: `uuid4().hex[:8]` for new takes; `take1` for a migrated take. `number` is per line, `max + 1`, never reused.
- No file paths are stored. Paths are derived from room, line and take ID (below), so state survives a moved cache folder.
- Entries for line IDs that are not in the current pack are kept in state and on disk but are never shown or mixed. A later rebuild that brings the line back brings its takes back.
- Offset, pitch, reverb, gain, auto gain (B3) and noise reduction stay per take, exactly as today.

### Files on disk

```
<cache>/rooms/<ROOM>/
  room_state.json
  noise_profile_<user>.wav                    (unchanged)
  takes/<line_id>/<take_id>.wav               active audio (raw or cleaned copy)
  takes/<line_id>/<take_id>_raw.wav           original recording, never altered
  takes/<line_id>/<take_id>_denoised_<key>.wav   cleaned version (P10 key = NR_VERSION, attenuation, engine)
```

`audio_processor.take_dir(room_id, line_id)` (sanitized, traversal-checked like `get_room_cache_dir`) and `take_wav_path(room_id, line_id, take_id)` build these. `denoised_take_path(take_dir, take_id)` and `_remove_old_denoised_takes(take_dir, take_id, keep)` work per take, so cleaning one take never touches another take's files.

## API and WebSocket

REST (all under `/api/rooms/{room_id}/lines/{line_id}/takes`):

| Method and path | Body | Effect | Broadcast |
|---|---|---|---|
| `POST …/takes` | multipart as today (`file, user_id, user_name, offset_ms, pitch_semitones, reverb_wet, gain_db, noise_reduction, auto_gain`) | adds a take and picks it | `take_recorded {line_id, line_index, take_id, url, noise_reduction, user_name, user_id}` |
| `POST …/takes/{take_id}/pick` | `{"user_id"}` | picks the take | `take_picked {line_id, line_index, take_id, user_id}` |
| `DELETE …/takes/{take_id}?user_id=` | | deletes the take's files and entry; a deleted picked take falls back to the newest remaining | `take_deleted {line_id, line_index, take_id, picked, user_id}` |
| `POST …/takes/{take_id}/noise_reduction` | `{"noise_reduction"}` | as today, per take | `take_params_updated {line_id, take_id, url, noise_reduction}` |
| `GET …/takes/{take_id}/peaks` | | as today | |
| `GET …/takes/{take_id}/audio` | | as today (Range, long cache with `?v=`) | |

- Upload, pick and delete share one permission rule (today's upload rule): the line's assigned actor, or the host. 403 otherwise. Unknown line → 400 "That line isn't in this scene." on upload, 404 elsewhere. Unknown take → 404.
- Delete removes files under `room.processing_lock`. Files that can't be removed (locked by a running render on Windows) are skipped quietly, as `_remove_quietly` does today; the entry is removed regardless.
- Every mutation calls `room.invalidate_exports()`.
- The old `/api/rooms/{room_id}/takes/{line_index}…` routes are removed.

WebSocket:
- `update_take_params` payload becomes `{line_id, take_id, offset_ms?, pitch_semitones?, reverb_wet?, gain_db?}`; broadcast `take_params_updated {line_id, take_id}`.
- `clear_take` and `take_cleared` are removed (delete is the REST route). An old client's `clear_take` falls through and is ignored, like other unknown types.

State payload (`Room.to_state_dict()["takes"]`): same shape as on disk, minus `peaks` on takes that are not picked (they are fetched on demand from `…/peaks`), so unlimited takes don't bloat every broadcast.

## Export, render, premiere and project ZIP

`Room.mix_takes() -> Dict[int, dict]` returns `{line["index"]: {**picked_take, "wav_path": take_wav_path(...)}}` for the lines of the current pack. It replaces every `dict(room.takes)` passed to `audio_processor.export_dub_video`, `render_dub_mix` and `build_project_zip` (`rooms_api.export_room_dub`, `download_room_dub`, `download_room_project_zip`; `room_ws` `launch_premiere`). The audio_processor render functions keep their `{line_index: take}` signature, so render, levelling and the limiter are untouched. The returned dicts are copies, so a render thread never sees later edits.

The project ZIP contains the picked take of each line, as today. Each manifest line entry also gets `line_id` and `take_id`.

The studio premiere (client-side) uses the picked take via the same helper as the booth.

## Migration of existing rooms

`rooms.load_persisted_rooms()` reads `room_state.json`. A file without `"state_version": 2` is the old layout: `takes` keyed by line index, files `take_line_N.wav`, `take_line_N_raw.wav`, `take_line_N_denoised_<key>.wav` (and the keyless `take_line_N_denoised.wav` from older versions) in the room folder.

For each old take:
1. Index outside the current pack: log it and leave its files where they are. Nothing is deleted.
2. Otherwise `audio_processor.migrate_legacy_take_files(room_id, line_index, line_id, "take1")` renames (`os.replace`, same volume) each file into `takes/<line_id>/take1*.wav`, keeping the denoised suffix. If the active file is missing but the raw one exists, the raw file is copied to the active name. Returns whether the take has audio.
3. The take becomes `{"picked": "take1", "takes": [old fields minus wav_path, plus take_id "take1", number 1, fresh url, has_raw from disk]}`.
4. The room is saved immediately as version 2 (`_sync_save_to_disk`).

It is idempotent: a crash after moving files but before saving leaves a version 1 state whose files are already at their new names; the next load finds them there and finishes. A take with no audio anywhere is dropped from state (there was nothing to play) and logged.

Test (`tests/test_take_model.py`, no network, no committed binaries): build an old-layout room in the test's cache dir from code: a synthetic 3-line pack, a version 1 `room_state.json` written from a literal dict in today's schema, `take_line_0.wav` + `_raw` + `_denoised_<key>`, `take_line_1.wav` only, and `take_line_7.wav` for an index outside the pack. Then `load_persisted_rooms()` and assert: takes keyed by line ID, one picked take each, byte-identical files at the new paths, old names gone for migrated lines, `take_line_7.wav` untouched, state rewritten with `state_version: 2`, a second load changes nothing, a half-migrated folder (files moved, state still version 1) loads correctly, and the audio route serves the migrated take.

## Not in this PR

- Comping inside a take (Later).
- Auto-selecting the best-timed take, latency calibration, auto-align, trim and stretch (feature 2). Only the existing offset is kept per take.
- Effect chains per take, presets, the rack (feature 3). The existing pitch, reverb and level stay per take.
- "Refresh older cleaned takes" (feature 4).
- Exporting every take, undo for delete, keyboard shortcuts for takes.
- Swapping a running room onto a rebuilt pack. A rebuilt pack is picked up when the engine restarts.

## Risks

- **Retimed lines.** Moving a cue's start in the Pack Builder gives it a new ID. Its old takes stay on disk and in state but leave the mix until the line is back at that time.
- **Mixed versions in one room.** An older client in a newer host's room (or the reverse) can't read the new state shape. The join version note already tells people to update; nothing else guards it.
- **Disk use.** Unlimited takes grow the room folder. Single-session pruning still removes old rooms when a new one is created.
- **Broadcast size.** Mitigated by sending peaks only for picked takes.
- **Intermediate commits.** Steps 2–3 change the server before step 4 changes the studio; the app works end to end again after step 4. The suite stays green at every step.

## Decided overnight, revisit

1. Line ID = start time in ms (`t<ms>`, `-2` for same-start duplicates), not index, filename or character, so it survives inserted lines and renamed characters. A retimed line counts as a new line.
2. Takes whose line ID is not in the current pack are kept (state and files) but hidden and not mixed.
3. A new take is always picked, including one recorded by someone else on a shared character.
4. A new take starts with the booth's current settings (the picked take's offset, pitch, reverb; level matched unless set by hand), as today.
5. Take numbers are per line and never reused.
6. The Takes button appears only with 2+ takes and only on lines you can record.
7. Pick and delete are REST routes with the recording permission rule; WS `clear_take` is removed.
8. Unpicked takes carry no peaks in broadcasts.
9. Migration renames old files into the new layout (no copies); takes for indexes outside the pack are left untouched in place.
10. Deleting the last take returns the line to the original voice. No undo; a confirm instead.
11. Play in the history uses that take's own settings and doesn't move the sliders.
12. Noise reduction and effect sliders act on the picked take only.
13. File paths are derived, not stored in `room_state.json`.
14. The project ZIP has picked takes only; the manifest gains `line_id` and `take_id`.

## Implementation steps

1. **Stable line IDs** — `pack_loader.assign_line_ids`, called from `load_pack` and `load_persistent_pack_cache`; tests.
2. **Engine take model** — per-take files in `audio_processor`, `Room.takes` by line ID with history and picked take, version 2 save/load, new REST routes (upload, pick, delete, noise reduction, peaks, audio), WS `update_take_params` by take, `Room.mix_takes()` for render, premiere and ZIP; Python tests moved to the new routes. Old-layout rooms are skipped on load until step 3.
3. **Migration of old rooms** — `audio_processor.migrate_legacy_take_files` and the version 1 branch of `load_persisted_rooms`; old-layout fixture test.
4. **Studio on the new model** — `lineTakes` / `pickedTake` helpers, new URLs and socket events, peaks merge by take ID, delete button deletes the picked take; JSDOM tests updated.
5. **Take history in the booth** — Takes button and panel with Play, Use and delete, shown only on your lines with 2+ takes; JSDOM tests.
6. **Changelog and roadmap** — CHANGELOG `[Unreleased]` and ROADMAP feature 1 marked done.
