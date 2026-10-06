# Design: stems export (dialogue and music & effects as separate files)

Roadmap feature 6, "Stems export" (**S**). Owner decision: October 2026 interview, "Export and sessions": the dialogue and the music & effects (M&E) as separate WAV files, for people who finish the mix in another editor. Builds on the effects rack (`effects-rack.md`, PR #15: one render engine, float renders, master stage) and Calibrate Mic (`calibrate-mic.md`, PR #16: exports wait while older takes are refreshed). Branch `feat/stems-export`.

**Gate.** ROADMAP.md asks for a design review with the owner before any code. Step 1 waits for sign-off on "Decided overnight, revisit".

## Where it stands

- **Video export** (`POST /export`, `GET /export/download`, premiere auto-render): `audio_processor._mix_scene(pack, takes, sr, presence_db)` builds one mono 44.1 kHz buffer, `_timeline_samples(pack)` long: backing × `BACKING_TRACK_LEVEL` (0.65), each picked take's cached render × its clamped Level + dialogue presence at `line.start + offset_ms` (`_render_take`, `_mix_into`; the take's WAV is already fitted to its stretch), and the original voice × `ORIGINAL_LINE_LEVEL` (0.9) × presence for lines nobody recorded. `master_stage` then applies one gain (to −16 LUFS) and the true-peak limiter (−1 dBTP). ffmpeg muxes it as AAC with `-shortest`.
- **Project ZIP** (`GET /export/project_zip`, `build_project_zip`): has its own line loop. `Master_Vocal_Mix.mp3` and `Character_Stems/*.mp3` carry the master gain of the presence-0 mix and are each limited separately; character stems hold takes only; `Backing_Music_SFX.mp3` is the raw backing file (not × 0.65, no master gain). All MP3. So its files do not add up to the video's mix, and they can't be made to without changing what that ZIP already ships.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| A **Stems** button next to **Project files**, in the theater toolbar and in the finished export modal. Tooltip: "The voices and the music and effects as separate WAV files that line up in any editor, plus one file per character". | Theater | Default in the theater (explained in its tooltip) |
| It makes one `.zip`. On the host's own computer it is saved once to the export folder and the toast says "Saved to <folder>". Everyone else gets a normal download ("Stems downloaded"). Same route as Project files (`saveRemoteFile`, `exportSubfolder: ''`). | Theater | Default |
| While it is made the button reads "Preparing…" and the toast "Preparing stems…". A second click does nothing. | Theater | Default |
| Inside: `Dialogue.wav` (every voice in the dub: picked takes with their sound and Level, the original voice on lines nobody recorded, all at the room's Dialogue level), `Music_and_Effects.wav` (the scene's music and sound effects, at the level the dub uses) and `Characters/<Character>.wav` (one per character with a line, including that character's unrecorded lines in the original voice, so the character files add up to `Dialogue.wav`). | Zip | Default |
| Every file starts at the start of the scene video, has the same length and sample rate, and sits at the loudness of the exported video. Dropped at 0:00 on any timeline, Dialogue + Music_and_Effects plays exactly like the exported video before its peak limiter. | Zip | Invisible |
| Stems wait while older takes are refreshed ("Older takes are being refreshed. Try again in a moment."), and Refresh older takes waits while stems are made. The refresh refusal now reads "An export is running. Refresh older takes when it's done." because it also covers stems. | Theater, Audio settings | Only when it happens |
| Without voice effects installed, stems fail with the existing "Download and install the latest DubMate to use voice effects." Any other failure: "Couldn't make the stems. Try again." A second request while stems are being made: "Stems are already being made. Try again in a moment." | Toast | Only when it happens |

New strings: "Stems", the tooltip above, "Preparing stems…", "Stems downloaded", "Couldn't make the stems. Try again.", "Stems are already being made. Try again in a moment.", "An export is running. Refresh older takes when it's done." (replaces "A video is rendering. …"). No on-screen text says LUFS, limiter, float or M&E.

## Audio: one mix path, split into buses

`_mix_scene` is split, not copied:

- New `_mix_buses(pack, takes_dict, sr=SR, presence_db=0.0, by_character=False) -> (backing, voices)`. It is today's `_mix_scene` body: same backing fill, same take/original branches, same failure policy (an unreadable take is skipped, an unreadable original left out, `EffectsUnavailable` raised). The only difference is where voices are added: into `voices["dialogue"]`, or with `by_character` into `voices[line.get("character") or "Actor"]`. Voice buffers are created on the first line that lands in them (`_timeline_samples` long, float32), so a pack's unused character names cost nothing.
- `_mix_scene` becomes `backing, voices = _mix_buses(...)` then `backing += buf` for each voice bus. The video, the download, the premiere and the ZIP's master-gain measurement all keep calling `_mix_scene`; the only numeric change is float32 summation order (≤ 1e-6 per sample).
- New `build_stems_zip(pack, takes_dict, output_zip_path, presence_db=0.0, sr=SR) -> str`:
  1. `backing, voices = _mix_buses(..., by_character=True)`; `dialogue` = sum of `voices` (zeros when there are none).
  2. `gain_db = master_stage(backing + dialogue, sr)[1]["gain_db"]`: the video's own master gain for this mix and presence. `g = 10 ** (gain_db / 20)`.
  3. Writes `dialogue × g`, `backing × g` and each `voices[c] × g` with `write_wav_float` (mono, 44.1 kHz, 32-bit float, not clipped) into a temp stage folder, then zips them `ZIP_STORED` (float audio barely deflates) under the root folder `DubMate_Stems_<Pack>_<ROOM>/`. Same `_sanitize_id_token` / `sanitize_filename` rules as `build_project_zip`; two character names that sanitize alike get `_2`, `_3`. Temp folder removed in `finally`. Logs the gain like `render_dub_mix`.

**Loudness, stated once.** The master gain is applied; the limiter is not. Dialogue + Music_and_Effects = the video's pre-limiter mix × the video's master gain, within 0.005 dB (`master_stage` reports its gain rounded to 0.01 dB). Measured in mono, the layout DubMate mixes and the stems ship in (Dubious's trap). Where the limiter would have worked, the summed stems peak above −1 dBTP and can exceed 0 dBFS; float WAV keeps those peaks intact, and the editor's own master decides what to do with them. Presence is the room's Dialogue level (`room.master_dialogue_presence_db`, synced by `set_dialogue_presence`), as in `POST /export` and `GET /export/download`.

**Alignment and length.** Offsets, negative offsets at the scene start (head trimmed by `_mix_into`), fitted (stretched) takes and render tails are placed by the same code as the video. Every file is `_timeline_samples(pack, 44100)` samples: the scene plus at least 1 s of tail, the length of the video's mix before ffmpeg's `-shortest` cuts it to the picture. The extra tail is kept so no reverb tail is lost.

**Cost.** One mix pass (renders come from the cache) plus one `master_stage` analysis, the same work as the video's audio. Memory: one float32 timeline buffer per character plus three (≈ 32 MB each for a 3-minute scene). Size: 10.6 MB per minute per file, so a 3-minute scene with 4 characters is about 190 MB.

## Data shapes and on-disk layout

- Output: `<export folder>/DubMate_Stems_<pack_id>_<ROOM>.zip`, rebuilt on every request (as the project ZIP), overwritten in place. Download name `DubMate_Stems_<Pack_Name>_<ROOM>.zip`.
- Zip layout: `DubMate_Stems_<Pack>_<ROOM>/Dialogue.wav`, `…/Music_and_Effects.wav`, `…/Characters/<Character>.wav`. No manifest, no text file.
- No change to `room_state.json`, takes, renders, the render cache or any other file. `Room.export_status["stems"]` is in-memory only (never saved; `export_status` isn't).

## API and WebSocket

| Route | Effect |
|---|---|
| `GET /api/rooms/{room}/export/stems` (new) | `_refuse_during_cleanup_refresh` (409). If `room.export_status.get("stems") == "processing"`: 409 "Stems are already being made. Try again in a moment." Else claims `export_status["stems"] = "processing"` before the first await, `takes = await mix_for_export(room)`, `asyncio.to_thread(build_stems_zip, ..., presence_db=room.master_dialogue_presence_db)`, and in `finally` pops the key. `EffectsUnavailable` → 503 with its message; anything else → 500 "Couldn't make the stems. Try again." Returns `FileResponse(application/zip)` with the headers the project ZIP route uses. No permission check (as Project files). |
| `POST /api/rooms/{room}/cleanup/refresh` | Unchanged logic: it already refuses while any `export_status` value is `"processing"`, which now includes stems. Message becomes "An export is running. Refresh older takes when it's done." |
| `GET /export/status?aspect_ratio=…` | Unchanged; `"stems"` is never asked for by the client. `invalidate_exports` already keeps `"processing"` entries. |

No WebSocket messages, no state payload change, no wire version change.

## Existing data

Nothing on disk changes shape, so there is no migration. Old rooms (any take shape the effects-rack loader accepts) export stems straight away; takes without renders render on first use, as for the video. Test (`tests/test_stems_export.py`, step 2): a room loaded from the PR #14-era `room_state.json` that `tests/test_effects_rack.py` (`TestRoomLoads._v2_state`) writes gets a stems zip whose Dialogue + Music_and_Effects matches its pre-limiter mix, and its `room_state.json` bytes are unchanged by making stems.

## Studio

- `static/index.html`: `#btn-toolbar-stems` after `#btn-toolbar-project-zip`, and `#btn-download-stems` after `#btn-download-project-zip` in the export modal actions. Same classes (`btn btn-project-zip btn-lg`), an icon, a `<span>` label "Stems", the tooltip as `data-tip`.
- `static/js/app.js`: element refs `btnToolbarStems`, `btnDownloadStems` next to the project-zip refs.
- `static/js/studio/export.js`: `downloadStems(control)` beside `downloadFullProjectZip`, using `saveRemoteFile('/api/rooms/<id>/export/stems?v=<now>', 'DubMate_Stems_<pack>_<id>.zip', {control, busyText: 'Preparing…', startMessage: 'Preparing stems…', doneMessage: 'Stems downloaded', errorText: "Couldn't make the stems. Try again.", exportSubfolder: ''})`; listeners in `initExportEvents`; `btnToolbarStems` added to `lockScreeningUI`.

## Not in this PR

- Changing the project ZIP (its stems stay MP3 with per-stem limiting and the raw backing) or folding its line loop onto `_mix_buses`. Stems are the files that add up; Project files keep what they are.
- The project ZIP doesn't block Refresh older takes while it builds (it never did); stems do.
- Stereo stems, other sample rates, 24-bit or MP3 stems, a format picker, a "limited" variant, stems trimmed to the picture length, the clean video inside the stems zip, a text note or manifest, per-line files (Project files has them), caching the stems zip between requests.
- The premiere's auto-render passes no dialogue presence (pre-existing; it masters at 0 dB presence). Not touched here.

## Risks

- **32-bit float support.** Premiere, Resolve, Audacity, Reaper, Vegas and Final Cut read it; some lightweight or mobile editors (CapCut is the one to check) may not. Hands-on. Fallback if it fails: 24-bit with a note that peaks over full scale are clipped, a one-function change.
- **Summed peaks over 0 dBFS** in editors that clip float on import or on export. Expected for a pre-limiter mix; the summed level matches the video, and anyone finishing elsewhere masters it there.
- **Size over the tunnel.** ~190 MB for a 3-minute, 4-character scene; a remote guest's download takes a while. The request itself is synchronous like the project ZIP; a very long scene could approach Cloudflare's 100 s first-byte limit before the file starts sending (same exposure as Project files today).
- **Memory.** One timeline buffer per character, ~32 MB per 3 minutes each; a 10-character 10-minute scene needs about 1.4 GB. Acceptable for the scenes packs hold; noted.
- **Summation-order change** in `_mix_scene` moves video samples by ≤ 1e-6; inaudible, below 16-bit resolution.

## Decided overnight, revisit

1. One button, **Stems**, next to Project files in the theater toolbar and the export modal, visible to everyone who sees Project files.
2. One `.zip` for both host and guests (a guest needs a single download; the host gets it saved once to the export folder, "Saved to <folder>").
3. 32-bit float WAV, mono, 44.1 kHz: the rate and layout DubMate mixes in; float so the pre-limiter sum is exact and never clipped.
4. The master gain is applied, the limiter is not: Dialogue + Music_and_Effects = the video's mix before its limiter (within 0.005 dB).
5. Dialogue includes the original voice on lines nobody recorded (it is in the video's mix), and each character file includes its own unrecorded lines, so the character files add up to Dialogue. The project ZIP's character stems (takes only) are unchanged.
6. Character files are included: they cost one buffer each and no extra mix code.
7. Files keep the full mix timeline (scene plus tail), not the picture length.
8. Stems use the room's Dialogue level, as the video export does.
9. Stems take part in the refresh gating through `export_status["stems"]`; the refresh refusal text changes to "An export is running. Refresh older takes when it's done."
10. No manifest or readme inside the zip; the tooltip and the changelog say what the files are.
11. The project ZIP is left as it is.

## Implementation steps

Each step is one commit and leaves `python -m pytest tests` and the node tests (`tests/run_all_tests.py`) green.

1. **Split the scene mix into buses and build the stems zip.** `_mix_buses`, `_mix_scene` on top of it, `build_stems_zip` in `audio_processor.py`; `tests/test_stems_export.py` (sum, lengths, format, alignment with offsets and stretch, characters add up, originals, no backing, name collisions, `_mix_scene` against a reference).
2. **Stems route and export gating.** `GET /api/rooms/{room}/export/stems` in `dubmate/rooms_api.py`, `export_status["stems"]`, 409/503/500, the new refresh refusal text; route tests in `tests/test_stems_export.py`, `tests/test_cleanup_refresh.py` and `tests/test_room_check_panel.js` updated.
3. **Stems button in the studio.** `index.html`, `app.js`, `export.js`; JSDOM tests in `tests/test_export_downloads.js`.
4. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 6 "Stems export" marked done.
