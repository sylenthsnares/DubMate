# Design: recording timing (mic sync and auto-aligned takes)

Roadmap feature 2. Owner decisions: October 2026 interview (ROADMAP.md, Decisions; "Align takes in a fixed order: trim, then stretch, then offset"). Builds on the take model (`take-model.md`, PR #12). Branch `feat/recording-timing`.

**Gate.** ROADMAP.md asks for a design review with the owner before any code. Step 1 does not start until the owner has signed off "Decided overnight, revisit" below.

## Where timing goes wrong today

`booth.startCountdownAndRecord` awaits `audio.startRecording()` (fresh `getUserMedia` + `MediaRecorder.start(100)`), then starts the video and the backing track at `ctx.currentTime`. The actor hears the scene `outputLatency` late and their voice reaches the recorder `inputLatency` later, plus the recorder's start gap. So a take's audio at 0 s is mixed at `line.start + offset_ms`, but the voice inside it sits that whole round trip late. Users fix every take by hand with `[` and `]`. A new take inherits the picked take's `offset_ms` (take model decision 4), which hides the problem after the first fix.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| **Sync your mic.** A Timing row in Audio settings: "Not synced yet" or "Synced. New takes move 140 ms earlier.", and a **Sync your mic** button (**Sync again** once synced). Pressing it shows "Hold your headphones against the mic, or turn on your speakers. You'll hear a few clicks." with **Start** and **Cancel**. DubMate plays a short click pattern three times and listens for it. | Audio settings, devices step (also reached on first-run setup) | One click away |
| If the clicks aren't heard: "DubMate couldn't hear the clicks. Clap along with the beat instead." and **Start clapping**. Eight steady clicks; the actor claps on each. | Same panel | Only when it happens |
| Failure copy: "That didn't line up. Try again, clapping right on each click." Nothing is saved on a failed run. | Same panel | Only when it happens |
| The measured delay is applied to every new take as its starting timing. `[` and `]` still fine-tune on top. | Booth (invisible) | Default |
| An unsynced microphone and output pair gets one toast per tab session, after a take saves: "Take saved. Sync your mic in Audio settings so takes line up on their own." Recording is never blocked or delayed. | Toast | Only when it happens |
| **Lined up automatically.** After a take saves, the engine matches its timing to the original line's voice and sets the take's offset. A small caption by the timing readout says "Lined up automatically" (tooltip: "DubMate matched this take to the original line. Use [ and ] to adjust it.") until the user nudges. | Booth timing bar | Default (caption only) |
| If the take was clearly faster or slower than the original, it is also fitted (at most 8 % faster or slower). The caption reads "Lined up and fitted to the line" and an **Original speed** button appears (tooltip: "Play this take at the speed you recorded it"). | Booth timing bar | Only on a fitted take |
| The timing bar's reset button becomes **Auto** (tooltip "Back to the automatic timing"): it returns to the take's automatic offset, or 0 for takes recorded before this PR. | Booth timing bar | Default |
| Each take in the history shows "Timing 82%" (tooltip: "How closely this take follows the original line's timing"). The best-timed take's figure is lightly highlighted. No score is shown when it couldn't be measured. | Takes panel | One click away |
| Deleting the take in the dub falls back to the best-timed remaining take (the newest when none has a score), instead of always the newest. | Takes panel / delete | Default |
| A new take is still always put in the dub. Picking a take by hand is never undone by the app. | Booth | Default |

No on-screen text names the methods (no "latency", "cross-correlation", "loopback").

## Data shapes and on-disk layout

### Mic sync (browser only)

`localStorage["dubmate_mic_sync"]`, JSON:

```json
{ "Microphone (Yeti X)|Headphones (Realtek)": { "latency_ms": 142, "method": "clicks", "measured_at": 1790000000000 } }
```

- Key: `devicePairKey(inputLabel, outputLabel)` = `"<input>|<output>"`. Labels come from `enumerateDevices()`: the selected device, else the `deviceId === "default"` entry, else the first device; an empty label falls back to its `deviceId`, then to `"default"`. Labels, not device IDs, because IDs are salted per origin and the desktop engine's port (part of the origin) can change; a changed system default shows up as a new pair, which is what should trigger a new sync.
- `method`: `"clicks"` or `"claps"`. `latency_ms`: integer, 0 to 800.
- Read and written through the existing `safeStorageGet/Set` guards. A missing or unreadable value means "not synced".
- Not stored in the engine config: for a guest the engine is the host's machine, and the delay belongs to the guest's own browser and devices.

### Take fields (room state, `room_state.json`, still `state_version: 2`)

New optional fields on each take, set by the upload route:

| Field | Type | Meaning |
|---|---|---|
| `start_offset_ms` | int | The offset the take started with: `-latency_ms` when the setup is synced, else the picked take's offset as today. Centre of the alignment search. |
| `auto_offset_ms` | int | The automatic timing: the aligned offset when alignment was confident, else `start_offset_ms`. What **Auto** returns to. |
| `aligned` | bool | Alignment was confident and applied. |
| `stretch` | float | Speed factor baked into the active audio (`1.0` = none; 0.92 to 1.08). |
| `timing_score` | float or null | 0 to 1: how closely the take's speech envelope follows the original line's at `auto_offset_ms` (after stretch). A property of the performance; nudging doesn't change it. Null when either side has no speech. |

`offset_ms` keeps its meaning (the offset everything plays and renders with). "Nudged" is derived, not stored: `offset_ms !== auto_offset_ms`. The line entry (`picked`, `next_number`, `takes`) is unchanged.

### Files

Unchanged layout (`takes/<line_id>/<take_id>.wav`, `_raw.wav`, `_denoised_<key>.wav`). The active `<take_id>.wav` becomes `stretch(source)` where source is the denoised or raw file, written by a new `_write_active_take(source_wav, target_wav, stretch)` (plain copy at 1.0, ffmpeg `atempo` otherwise). `_raw.wav` is never altered. Because preview, premiere, render and ZIP all read the active file, a fitted take sounds the same everywhere.

## Alignment (engine)

`audio_processor.align_take_timing(take, reference, start_offset_ms, sr, allow_stretch=True)`; numpy only, no new dependency. Reference = the pack's original line audio, `os.path.join(pack.folder, line["filename"])`, which starts at `line.start`.

1. **Envelope.** RMS in 20 ms windows every 5 ms, in dB, floored 50 dB below the peak, for take and reference.
2. **Trim** (analysis only, no audio is cut). Each side's voiced span = first to last frame within 35 dB of its peak, padded 100 ms. Matching uses only those spans, so room tone before the line and the tail after it don't sway the result. Either side with no voiced frames: return `timing_score: None, aligned: False, stretch: 1.0, auto_offset_ms: start_offset_ms`.
3. **Stretch, only if clearly needed.** `r = take_span / reference_span`. Considered only when `r` is outside 0.97 to 1.03; the candidate factor is `r` clamped to 0.92 to 1.08 (an `atempo` factor; above 1 speeds the take up). The envelope is resampled by the factor and matched as in step 4. The stretch is kept only if its score beats the unstretched score by at least 0.05.
4. **Offset.** Pearson correlation of the two envelopes over their overlap for every offset in `start_offset_ms ± 500 ms`, clipped to ±800 ms (the nudge range), refined by parabolic interpolation. Applied (`aligned: True`) only when the best score is at least 0.5 and the best offset is not within 10 ms of the window edge; otherwise `auto_offset_ms = start_offset_ms` and `stretch = 1.0`.
5. Returns `{auto_offset_ms, timing_score, stretch, aligned}`; `timing_score` is the score at the returned offset and stretch, rounded to 2 decimals.

Runs inside the upload request under `room.processing_lock`, after transcoding and noise reduction (tens of ms, plus one ffmpeg pass when fitting), so the `take_recorded` broadcast already carries the final timing and nothing can race a nudge.

## Mic sync measurement (studio)

Pure functions in a new `static/js/studio/timing.js` (no DOM, node-testable):

- `CLICK_TIMES_SEC`: 6 clicks at irregular spacing over about 1.2 s (irregular so only one lag matches). `clickTrainSamples(sampleRate, times)`: 4 ms Hann-windowed 2 kHz bursts.
- `findClickTrainLag(samples, sampleRate, times, maxLagMs)`: matched filter of the recording against the click pattern over lags 0 to `maxLagMs`; returns `{lagMs, confident}`, confident when the top peak is at least 1.8 times the best peak more than 10 ms away.
- `findClapLag(samples, sampleRate, beatTimes)`: onsets from a 1 ms energy envelope; for beats 3 to 8, the onset nearest each beat within -150 to +400 ms; needs 4 hits; returns `{lagMs: median, spreadMs: max - min of the hits, hits}`.
- `combineRuns(lags)`: median and spread of the three click runs.
- `devicePairKey(inputLabel, outputLabel)`.

Flow (`MicSyncMethods` mixin, new `static/js/studio/mic_sync.js`): stop the input meter; three times: `await audio.startRecording()`, `audio.playClickTrain(times, LEAD_SEC = 0.3)` at `ctx.currentTime + LEAD_SEC`, wait, `audio.stopRecording()`, `lag = findClickTrainLag(...) - LEAD_SEC`. This is the same path a take uses (fresh stream, recorder start, sound scheduled right after the recorder starts, `ctx.destination` on the chosen output), so the result is exactly the delay a take has. Accept when all three runs are confident, spread is at most 20 ms and the median is between `browserEstimate - 20` and 800 ms; otherwise switch to the clap test. Clap result: accept when `spreadMs <= 40` and it is at most 800 ms, saving `max(lagMs, browserEstimate)`. `browserEstimate = (ctx.outputLatency + ctx.baseLatency + track.getSettings().latency) * 1000`, each term 0 when the browser doesn't report it. Sync is refused while a countdown or recording is running.

Applying it: `booth.uploadTake` sends `offset_ms = -latency_ms` when `currentLatencyMs()` is known for the active pair, otherwise the picked take's offset as today. The recording itself is untouched.

## API and WebSocket

- `POST /api/rooms/{room}/lines/{line}/takes`: no new form fields. `offset_ms` is read as the starting offset. The route passes the reference line's path and the starting offset to `save_uploaded_take`, then stores the five fields above. Response and `take_recorded` broadcast unchanged in shape (the take carries the new fields).
- New `POST /api/rooms/{room}/lines/{line}/takes/{take}/original_speed` with body `{"user_id"}`, guarded by `_require_line_actor` like pick and delete. Rewrites the active audio at 1.0 (`_write_active_take`), re-runs `align_take_timing(..., allow_stretch=False)`, sets `stretch: 1.0`, the new `auto_offset_ms`, `timing_score`, `aligned`, and moves `offset_ms` to the new `auto_offset_ms` only if the take was not nudged. Bumps `audio_version`, refreshes `peaks`/`duration`, calls `invalidate_exports()`, broadcasts `take_params_updated {line_id, take_id, url}`. 404 on unknown take.
- `POST …/noise_reduction`: passes `take.get("stretch", 1.0)` so the swapped audio stays fitted; timing fields are not recomputed.
- WebSocket: no change. `update_take_params` still sets `offset_ms`; the client derives "nudged".
- `Room.remove_take`: a deleted picked take falls back to the remaining take with the highest `timing_score` (unscored takes rank lowest; ties go to the newest).

## Existing data

No layout change and no `state_version` bump: the fields are optional and every reader defaults them (`stretch` 1.0, `timing_score` none, `aligned` false, no `auto_offset_ms` so **Auto** resets to 0 as today). Older tabs keep working against the new engine; the server aligns whatever starting offset they send. Tested in `tests/test_recording_timing.py` by loading a PR #12-era `room_state.json` (literal dict without the new fields) and checking the room loads, `mix_takes` and `render_dub_mix` use `offset_ms` unchanged, the noise-reduction toggle works with stretch defaulting to 1.0, delete falls back to the newest, and a save leaves the old takes' fields untouched. Nothing is rewritten on load.

## Export, render, premiere and project ZIP

No code change in `render_dub_mix`, `export_dub_video`, premiere or the screening: they read `offset_ms` and the active WAV, which already carries any stretch. `build_project_zip`: `Raw_Takes/` files are rendered from the active WAV, so they are fitted too; the manifest line entry gains `stretch` so it says so. The booth stops reusing the locally recorded buffer for preview when the saved take has `stretch != 1.0`, so the first preview after recording plays the fitted audio from the engine.

## Not in this PR

- Re-aligning takes recorded before this PR, or re-running alignment when the pack or noise reduction changes.
- Moving existing takes when the user syncs or re-syncs (only new takes use the delay).
- Picking an older take automatically when a new one scores worse; changing which take a new recording puts in the dub.
- Trimming audio (trim is analysis-only), comping, word-level alignment, alignment to ASR timestamps.
- Storing the delay in the engine config or sharing it across browsers.
- AudioWorklet capture (a precise recorder start timestamp); the recorder start gap is measured as part of the delay instead.
- Timing score in the booth outside the Takes panel; nagging about low scores.
- A switch to turn auto-align off (the nudge and **Auto**/**Original speed** are the overrides).

## Risks

- **Recorder start gap varies take to take.** The sync measures its typical value (median of three runs) and auto-align absorbs the rest when it is confident. Real-device spread is unknown until hands-on testing.
- **Dubbing in another language** gives weaker envelope matches. The 0.5 threshold and the bounded window keep a poor match from moving a take; the latency offset still applies.
- **Guide voice bleed.** With the guide voice on and leaky headphones, the mic can pick up the original line, which then matches itself. Bleed is far quieter than the voice in the dB envelope; accepted.
- **Headphones that can't reach the mic** or OS noise suppression (Krisp, NVIDIA Broadcast) can hide the clicks; the clap test covers it.
- **Bluetooth headsets** have large, unstable delays; the 800 ms cap and spread check reject the worst.
- **`atempo` quality** at up to 8 % is acceptable for speech; only applied when it clearly helps, and **Original speed** undoes it.
- **Pre-existing:** right after recording with noise reduction on, the booth previews the local un-cleaned recording. Out of scope; noted for feature 4.

## Decided overnight, revisit

1. The delay is stored only in the browser (`localStorage`), keyed by device labels, not in the engine config.
2. Sync measures through the real recording path (fresh stream, `MediaRecorder`, sound scheduled right after the recorder starts), three click runs, median.
3. Clap fallback saves `max(measured, browser estimate)` and needs a 40 ms spread.
4. The "please sync" prompt is a toast, once per device pair per tab session, after a take saves. No alert dot, no modal.
5. When synced, a new take starts at `-latency_ms` instead of inheriting the picked take's offset (changes take-model decision 4 for offset only; pitch, reverb and level are still inherited). Unsynced setups keep the old inheritance.
6. Alignment runs synchronously in the upload request, so it can never overwrite a nudge; "nudged" is derived (`offset_ms != auto_offset_ms`), not stored.
7. Thresholds: window ±500 ms around the starting offset, clipped to ±800 ms; apply at score ≥ 0.5 and not at the window edge; stretch considered outside 0.97 to 1.03, capped at 0.92 to 1.08, kept only for a 0.05 score gain.
8. Stretch is baked into the active take audio with ffmpeg `atempo` (no new dependency), so preview equals export; **Original speed** undoes it.
9. Trim is analysis-only; no audio is cut.
10. Timing score = envelope correlation at the automatic timing, independent of later nudges; shown only in the Takes panel as "Timing N%".
11. Pre-selecting the best-timed take is limited to the delete fallback. A new take is still always picked, and a hand pick is never changed by the app. Alternative for the owner: pick an older take automatically when the new one scores clearly worse.
12. The reset button becomes **Auto** and returns to `auto_offset_ms` (0 for older takes).
13. No `state_version` bump; old takes keep their fields and are not re-aligned.
14. **Original speed** is guarded like pick/delete (`_require_line_actor`).

## Implementation steps

1. **Alignment math.** `audio_processor.align_take_timing` and envelope helpers, pure numpy; synthetic-signal tests in `tests/test_recording_timing.py`. No callers yet.
2. **Aligned takes in the engine.** `_write_active_take`; `save_uploaded_take` aligns and fits; the noise-reduction toggle keeps the stretch; `original_speed` route; delete falls back to the best-timed take; manifest `stretch`; old-state compatibility test.
3. **Mic sync measurement.** `static/js/studio/timing.js` pure functions and `AudioEngine.playClickTrain`; node tests on synthetic recordings.
4. **Mic sync in Audio settings.** Timing row and panel, `MicSyncMethods` mixin, storage, the sync prompt, starting offset in `uploadTake`; JSDOM tests with stubbed audio.
5. **Timing in the booth.** "Lined up automatically" caption, **Original speed**, **Auto** reset, timing score in the Takes panel, no local-buffer reuse for fitted takes; JSDOM tests.
6. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 2 marked done.
