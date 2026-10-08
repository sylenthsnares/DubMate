# Design: stems export (dialogue and music & effects as separate files)

Roadmap feature 6, "Stems export" (**S**). Owner decision: October 2026 interview, "Export and sessions": the dialogue and the music & effects (M&E) as separate WAV files, for people who finish the mix in another editor. Builds on the effects rack (`effects-rack.md`, PR #15: one render engine, float renders, master stage) and Calibrate Mic (`calibrate-mic.md`, PR #16: exports wait while older takes are refreshed). Branch `feat/stems-export`.

**Status.** The code for every step has landed on `feat/stems-export`. The "Decided overnight, revisit" list still awaits the owner's review; any change there lands as a follow-up.

## Where it stands

- **Video export** (`POST /export`, `GET /export/download`, premiere auto-render): `audio_processor._mix_scene(pack, takes, sr, presence_db)` builds one mono 44.1 kHz buffer, `_timeline_samples(pack)` long: backing × `BACKING_TRACK_LEVEL` (0.65), each picked take's cached render × its clamped Level + Dialogue level at `line.start + offset_ms` (`_render_take`, `_mix_into`; the take's WAV is already fitted to its stretch), and the original voice × `ORIGINAL_LINE_LEVEL` (0.9) × Dialogue level for lines nobody recorded. `master_stage` then masters it: a start gain `_master_gain_db(integrated_lufs(mix))` toward −16 LUFS, the true-peak limiter at −1.5 dBTP (`MASTER_LIMITER_CEILING_DB`), then the gain is raised pass by pass until the *limited* mix reads −16 LUFS (so its reported `gain_db` includes what the limiter took out), and a static trim to −1.0 dBTP (`_trim_true_peak`) if the limited mix still reads above it. ffmpeg muxes it as AAC with `-shortest`.
- **Premiere auto-render** (`dubmate/room_ws.py`, `launch_premiere`) calls `export_dub_video` without `master_dialogue_presence_db`, so it masters at 0 dB Dialogue level even when the room's Dialogue level is set (the theater slider shows the room's value). `POST /export` and `GET /export/download` then hand out that file as the ready 16:9 export.
- **Project ZIP** (`GET /export/project_zip`, `build_project_zip`): its own line loop. `Master_Vocal_Mix.mp3` and `Character_Stems/*.mp3` carry the master gain of the 0 dB Dialogue level mix and are each limited separately; character stems hold takes only; `Backing_Music_SFX.mp3` is the raw backing file (not × 0.65, no master gain). All MP3. Its files don't add up to the video's mix, and can't without changing what that ZIP already ships. It is rebuilt in place at a fixed name, so a second request can overwrite it while an earlier one is still being sent.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| A **Stems** button next to **Project files**, in the theater toolbar and in the finished export modal. Tooltip (`data-tip`): "Separate WAV files for the voices and for the music and effects, plus one per character, to finish the mix in another editor. They all start with the scene." | Theater | Default in the theater (explained in its tooltip) |
| It makes one `.zip`. On the host's own computer it is saved once to the export folder and the toast says "Saved to <folder>". Everyone else gets a normal download ("Stems downloaded"). Same route as Project files (`saveRemoteFile`, `exportSubfolder: ''`). | Theater | Default |
| While it is made the button reads "Preparing…" and the toast "Preparing stems…". A second click does nothing. | Theater | Default |
| Inside: `Dialogue.wav` (every voice in the dub: picked takes with their sound and Level, the original voice on lines nobody recorded, all at the room's Dialogue level), `Music_and_Effects.wav` (the scene's music and sound effects at the level the dub uses) and `Characters/<Character>.wav` (one per character with a line, including that character's unrecorded lines in the original voice, so the character files add up to `Dialogue.wav`). | Zip | Default |
| Every file starts at the start of the scene and has the same length and sample rate. Dialogue + Music_and_Effects has the video's balance (same takes, Levels, Dialogue level, backing level) and measures −16 LUFS, the loudness the video is mastered to. The video's peak limiting is not applied, so loud moments keep the peaks the video's limiter held down. | Zip | Invisible |
| The premiere video now uses the room's Dialogue level, like every other export. | Theater | Invisible (fixes a mismatch) |
| Stems wait while older takes are refreshed ("Older takes are being refreshed. Try again in a moment."), and Refresh older takes waits while stems are made or sent. The refresh refusal now reads "An export is running. Refresh older takes when it's done." because it also covers stems. | Theater, Audio settings | Only when it happens |
| Without voice effects installed, stems fail with the existing "Download and install the latest DubMate to use voice effects." (Superseded by [v2-update-path.md](v2-update-path.md): stems now save without voice effects.) While someone's stems are still being made or sent: "Someone is already getting the stems. Try again in a moment." Any other failure, including a download the browser couldn't hold: "Couldn't get the stems. Try again." | Toast | Only when it happens |

New strings: "Stems", the tooltip above, "Preparing stems…", "Stems downloaded", "Couldn't get the stems. Try again.", "Someone is already getting the stems. Try again in a moment.", "An export is running. Refresh older takes when it's done." (replaces "A video is rendering. …"). No on-screen text says LUFS, limiter, float or M&E. The tooltip doesn't promise that every editor reads the files (see Risks).

## Audio: one mix path, split into buses

`_mix_scene` is split, not copied:

- New `_mix_buses(pack, takes_dict, sr=SR, presence_db=0.0, by_character=False) -> (backing, voices)`. It is today's `_mix_scene` body: same backing fill, same take/original branches, same failure policy (an unreadable take is skipped, an unreadable original left out, `EffectsUnavailable` raised). The only difference is where voices are added: into `voices["dialogue"]`, or with `by_character` into `voices[line.get("character") or "Actor"]`. Voice buffers are created on the first line that lands in them (`_timeline_samples` long, float32).
- `_mix_scene` becomes `backing, voices = _mix_buses(...)` then `backing += buf` for each voice bus. The video, the download, the premiere and the project ZIP's master-gain measurement keep calling `_mix_scene`; the only numeric change is float32 summation order (≤ 1e-6 per sample).
- New `build_stems_zip(pack, takes_dict, output_zip_path, presence_db=0.0, sr=SR) -> str`:
  1. `backing, voices = _mix_buses(..., by_character=True)`; `dialogue` = sum of `voices` (zeros when there are none).
  2. `gain_db = _master_gain_db(integrated_lufs(backing + dialogue, sr))`: the master stage's start gain, the one it applies *before* the limiter (toward −16 LUFS, clamped ±24 dB, 0 for silence). `g = 10 ** (gain_db / 20)`. No `master_stage` call, so none of the limiter's working memory.
  3. Writes `dialogue × g`, `backing × g` and each `voices[c] × g` with `write_wav_float` (mono, 44.1 kHz, 32-bit float, not clipped) into a temp stage folder, then zips them `ZIP_STORED` (float audio barely deflates) under the root folder `DubMate_Stems_<Pack>_<ROOM>/`. Same `_sanitize_id_token` / `sanitize_filename` rules as `build_project_zip`; two character names that sanitize alike get `_2`, `_3`. Temp folder removed in `finally`. Logs the gain like `render_dub_mix`.

**Loudness, stated once.** Applied: the master stage's loudness gain, computed on the unlimited mix. Not applied: the limiter, the gain raise that makes up for it, and the −1.0 dBTP trim. So Dialogue + Music_and_Effects = the video's mix before mastering × one gain, and measures −16 LUFS integrated. The video measures the same −16 LUFS after its limiter (within `master_stage`'s 0.05 LU), except when its gain is clamped at +24 dB, the limiter loop stops after 6 passes short of target, or the −1.0 dBTP trim engages; then the video is slightly quieter than the summed stems. Where the limiter worked, the summed stems peak above −1.5 dBTP and can exceed 0 dBFS; float WAV keeps those peaks, and the editor's own master decides. Measured in mono, the layout DubMate mixes and the stems ship in (Dubious's trap: measure in the layout you mix in). Rejected: the video's final `gain_db` (the summed stems would be louder than the video wherever the limiter works) and no gain at all (stems at whatever level the raw mix happens to have).

**Dialogue level.** Stems use `room.master_dialogue_presence_db` (synced by `set_dialogue_presence`), as `POST /export` and `GET /export/download` do. The premiere render is changed to pass it too (one argument in `room_ws.py`), so "the video's balance" holds for every video the room hands out.

**Alignment and length.** Offsets, negative offsets at the scene start (head trimmed by `_mix_into`), fitted (stretched) takes and render tails are placed by the same code as the video. Every file is `_timeline_samples(pack, 44100)` samples: the scene plus at least 1 s of tail, the video's mix before ffmpeg's `-shortest` cuts it to the picture. The tail is kept so no reverb tail is lost.

**Cost.** One mix pass (renders come from the cache) plus one loudness measurement. Memory: one float32 timeline buffer per character plus three (≈ 32 MB each for a 3-minute scene), plus `integrated_lufs`'s working copy of one buffer. Size: 10.6 MB per minute per file, so a 3-minute scene with 4 characters is about 190 MB.

## Data shapes and on-disk layout

- Output: `<export folder>/DubMate_Stems_<pack_id>_<ROOM>.zip`, rebuilt on each request at that fixed name (it is the host's saved copy). Download name `DubMate_Stems_<Pack_Name>_<ROOM>.zip`. Only one request per room builds or sends it at a time (see API), so it is never rewritten under a running download.
- Zip layout: `DubMate_Stems_<Pack>_<ROOM>/Dialogue.wav`, `…/Music_and_Effects.wav`, `…/Characters/<Character>.wav`. No manifest, no text file.
- No new fields and no change of shape in `room_state.json`, takes, renders or the render cache. `Room.export_status["stems"]` is in-memory only (`export_status` is never saved).
- Like the video export, making stems goes through `mix_for_export`, which first matches the level of a picked take that was levelled while voice effects weren't installed (`target_lufs` without `loudness_lufs`) and saves that (`mark_dirty`). Existing behaviour, not a new format.

## API and WebSocket

| Route / message | Effect |
|---|---|
| `GET /api/rooms/{room}/export/stems` (new) | `_refuse_during_cleanup_refresh` (409). If `room.export_status.get("stems") == "processing"`: 409 "Someone is already getting the stems. Try again in a moment." Else claims `export_status["stems"] = "processing"` before the first await, `takes = await mix_for_export(room)`, `asyncio.to_thread(build_stems_zip, ..., presence_db=room.master_dialogue_presence_db)`. On any failure the claim is dropped; `EffectsUnavailable` → 503 with its message, other exceptions → 500 "Couldn't get the stems. Try again." On success the claim is **held until the file has been sent or the send broke off**: the route returns `_FileResponseThen(zip_path, done=…)`, a few-line `FileResponse` subclass in `rooms_api.py` whose `__call__` runs `super().__call__` inside `try/finally: done()`. (Starlette 1.6's `background=` isn't enough: it doesn't run when sending raises.) Headers as the project ZIP route. No permission check (as Project files). |
| `POST /api/rooms/{room}/cleanup/refresh` | Unchanged logic: it already refuses while any `export_status` value is `"processing"`, which now includes stems being made or sent. Message becomes "An export is running. Refresh older takes when it's done." |
| `launch_premiere` (WS) | `export_dub_video(..., master_dialogue_presence_db=room.master_dialogue_presence_db)`. |
| `GET /export/status?aspect_ratio=…` | Unchanged; the client never asks for `"stems"`. `invalidate_exports` already keeps `"processing"` entries. |

No new WebSocket messages, no state payload change, no wire version change.

## Existing data

Nothing on disk changes shape, so there is no migration. Old rooms (any take shape the effects-rack loader accepts) export stems straight away; takes without renders render on first use, as for the video. Test (`tests/test_stems_export.py`, step 3): a room loaded from the PR #14-era `room_state.json` that `tests/test_effects_rack.py` (`TestRoomLoads._v2_state`) writes gets a stems zip whose Dialogue + Music_and_Effects equals its `_mix_scene` mix × the stems gain. It proves old rooms export stems; it doesn't prove `room_state.json` is never rewritten (`mix_for_export` can rewrite it, as for the video).

## Studio

- `static/index.html`: `#btn-toolbar-stems` after `#btn-toolbar-project-zip`, and `#btn-download-stems` after `#btn-download-project-zip` in the export modal actions. Same classes (`btn btn-project-zip btn-lg`), an icon, a `<span>` label "Stems", the tooltip as `data-tip`.
- `static/js/app.js`: element refs `btnToolbarStems`, `btnDownloadStems` next to the project-zip refs.
- `static/js/studio/export.js`: `downloadStems(control)` beside `downloadFullProjectZip`, using `saveRemoteFile('/api/rooms/<id>/export/stems?v=<now>', 'DubMate_Stems_<pack>_<id>.zip', {control, busyText: 'Preparing…', startMessage: 'Preparing stems…', doneMessage: 'Stems downloaded', errorText: "Couldn't get the stems. Try again.", exportSubfolder: ''})`; listeners in `initExportEvents`; `btnToolbarStems` added to `lockScreeningUI`. On the host's computer `saveRemoteFile` cancels the body at once, so the claim is released straight away.

## Not in this PR

- Changing the project ZIP (MP3, per-stem limiting, raw backing) or folding its loop onto `_mix_buses`. Its in-place overwrite during a send is a known pre-existing flaw; `_FileResponseThen` could later fix it the same way.
- The project ZIP doesn't block Refresh older takes while it builds (it never did); stems do.
- Stereo stems, other sample rates, 24-bit or MP3 stems, a format picker, a "limited" variant, stems trimmed to the picture length, the clean video inside the stems zip, a manifest, per-line files (Project files has them), caching the stems zip between requests, streaming guest downloads to disk instead of through a blob.

## Risks

- **32-bit float support.** Premiere, Resolve, Audacity, Reaper, Vegas and Final Cut read it; CapCut (desktop and mobile) is unchecked. Hands-on. Fallback if it fails: 24-bit, with peaks over full scale clipped, a one-function change. Meanwhile the tooltip makes no "any editor" promise.
- **Summed peaks over 0 dBFS** in editors that clip float on import or export. Expected for an unlimited mix at −16 LUFS; anyone finishing elsewhere masters it there.
- **Guest downloads in memory.** `saveRemoteFile` takes the whole zip as a blob in the guest's browser: ~190 MB typical, over 1 GB for a long scene with many characters. Phones may fail; the guest then sees "Couldn't get the stems. Try again." The host is unaffected (body cancelled).
- **Claim held during a slow send.** A guest's download over the tunnel keeps `export_status["stems"]` set, so other stems requests and Refresh older takes wait until it finishes or breaks off. Accepted: it is what stops the zip being rebuilt under a running download.
- **Size over the tunnel.** The request is synchronous like the project ZIP; a very long scene could approach Cloudflare's 100 s first-byte limit before the file starts sending (same exposure as Project files today).
- **Memory.** One timeline buffer per character, ~32 MB per 3 minutes each; a 10-character 10-minute scene needs about 1.4 GB plus the loudness measurement's working copy. Not measured; hands-on check on a synthetic long pack.
- **Summation-order change** in `_mix_scene` moves video samples by ≤ 1e-6; inaudible, below 16-bit resolution.
- **Premiere change** alters the premiere video only for rooms whose Dialogue level isn't 0 dB at launch; it then matches the slider the theater shows.

## Decided overnight, revisit

1. One button, **Stems**, next to Project files in the theater toolbar and the export modal, visible to everyone who sees Project files.
2. One `.zip` for both host and guests (a guest needs a single download; the host gets it saved once to the export folder, "Saved to <folder>").
3. 32-bit float WAV, mono, 44.1 kHz: the rate and layout DubMate mixes in; float so the unlimited sum is exact and never clipped. CapCut support unchecked; the tooltip makes no editor promise.
4. Loudness: the master stage's pre-limiter gain is applied, nothing after it. Summed, the stems are the video's unmastered mix at −16 LUFS, the video's loudness; peaks the limiter would hold down are kept. (Not the video's final gain, which already makes up for limiting and would leave the stems louder than the video.)
5. Dialogue includes the original voice on lines nobody recorded (it is in the video's mix), and each character file includes its own unrecorded lines, so the character files add up to Dialogue. The project ZIP's character stems (takes only) are unchanged.
6. Character files are included: one buffer each and no extra mix code.
7. Files keep the full mix timeline (scene plus tail), not the picture length.
8. Stems use the room's Dialogue level, and the premiere render is fixed to use it too, so the stems match whichever video the room hands out.
9. Stems take part in the refresh gating through `export_status["stems"]`, held from the request until the file is sent; the refresh refusal text becomes "An export is running. Refresh older takes when it's done."
10. One stems request at a time per room; a second gets "Someone is already getting the stems. Try again in a moment." rather than its own copy (per-request copies would pile 190 MB files into the host's export folder or need a second cleanup path).
11. No manifest or readme inside the zip; the tooltip and the changelog say what the files are.
12. The project ZIP is left as it is, including its overwrite-during-send flaw.

## Implementation steps

Each step is one commit and leaves `python -m pytest tests` and the node tests (`tests/run_all_tests.py`) green.

1. **Split the scene mix into buses and build the stems zip.** `_mix_buses`, `_mix_scene` on top of it, `build_stems_zip` in `audio_processor.py`; `tests/test_stems_export.py`.
2. **Premiere video uses the room's Dialogue level.** One argument in `dubmate/room_ws.py`; a test in `tests/test_cleanup_refresh.py`.
3. **Stems route, claim held through the send, export gating.** `GET /api/rooms/{room}/export/stems` and `_FileResponseThen` in `dubmate/rooms_api.py`, the new refresh refusal text; route tests in `tests/test_stems_export.py`, `tests/test_cleanup_refresh.py` updated.
4. **Stems button in the studio.** `index.html`, `app.js`, `export.js`; JSDOM tests in `tests/test_export_downloads.js`.
5. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 6 "Stems export" marked done.
