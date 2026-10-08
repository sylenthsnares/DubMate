# Design: recording timing (mic sync and auto-aligned takes)

Roadmap feature 2. Owner decisions: October 2026 interview (ROADMAP.md, Decisions; "Align takes in a fixed order: trim, then stretch, then offset"). Builds on the take model (`take-model.md`, PR #12). Branch `feat/recording-timing`.

**Status.** Implemented on `feat/recording-timing` (PR #14) in the eight steps listed at the end, as designed below. The calls listed under "Decided overnight, revisit" were made without the owner and shipped as written; the owner still has to confirm them. Two of them change settled roadmap lines (decisions 9 and 11) and need an explicit yes or no. If the owner says no to either, it is a follow-up change, not a blocker for the rest.

Revised after a claim audit, before any code: offsets snap to the 5 ms slider step, the delay is also kept in the host's engine config, the guide voice turns alignment off, alignment has explicit "not measured" guards, and steps 2 and 4 of the first draft are each split in two. Changed during the final review: timing scores run 0 to 1 (a take that wasn't lined up scores 0, not a negative correlation), the Takes panel hides negative scores from older takes and never highlights 0 %, and the delete fallback ranks zero or negative scores with unscored takes. After the final review, the booth takes the guide-voice flag from the checkbox as it was when recording started, not when the take is saved.

**Updated after PR #19 and UI pass U5b.** Mic sync changed after this PR shipped, and the parts below describe what runs now. PR #19 (`first-test-fixes.md`, "Mic sync, second pass") made the clicks a loud broadband sweep with a warning to take the earbuds out, added the `clicksFailed` and `clap` steps, made clap sync refuse room noise (`judgeClaps`), moved `POST /api/config` behind `require_own_computer`, sent `mic_sync` from `GET /api/config` only to the engine's own computer, and carried a member's sync in the join handoff. U5b (`ui-u5b-settings-launcher.md`) reworded the clap failure lines to say "beat". The user table, "Mic sync measurement" and the `/api/config` lines are updated in place; the rest of this document is as shipped in PR #14.

## Where timing went wrong before this PR

`booth.startCountdownAndRecord` awaits `audio.startRecording()` (fresh `getUserMedia` + `MediaRecorder.start(100)`), then seeks and plays `stageVideo` and starts the backing track at `ctx.currentTime`. The actor hears the scene `outputLatency` late, and their voice reaches the recorder `inputLatency` later, plus the recorder's start gap. A take's audio at 0 s is mixed at `line.start + offset_ms`, so the voice inside it sits that round trip late. Users fixed every take by hand with `[` and `]`. A new take inherited the slider value, which is the picked take's `offset_ms` (take model decision 4). That hid the problem after the first fix. The recording path itself is unchanged by this PR; the delay is measured and compensated instead.

## What changed for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| **Sync your mic.** A Timing row in Audio settings: "Not synced yet" or "Synced. New takes move 140 ms earlier.", and a **Sync your mic** button (**Sync again** once synced). Pressing it shows "The clicks are loud. Take out your earbuds or headphones and hold them right next to the mic." with **Play clicks** (tooltip "On speakers? Turn them up and stay near the mic.") and **Cancel**. DubMate plays a short, loud click pattern three times and listens for it. The level meter keeps moving meanwhile. | Audio settings, devices step (also reached on first-run setup) | One click away |
| If the clicks aren't heard (the `clicksFailed` step): "DubMate couldn't hear the clicks. Turn your computer's volume up, hold your earbuds closer to the mic and try again." with **Try again** and **Clap instead**. | Same panel | Only when it happens |
| **Clap instead** (the `clap` step): "Put your headphones back on, then clap on each beat you hear." Nothing records until **Start clapping**. Eight steady beats, quieter than the sync clicks; the actor claps on each. | Same panel | Only when it happens |
| Failure copy, by what the clap run heard: "DubMate couldn't hear your claps. Clap closer to the mic, right on each beat." (`quiet`), "Your claps were uneven. Try again, clapping right on each beat." (`uneven`), "DubMate heard other sounds besides your claps. Try again somewhere quieter, clapping right on each beat." (`noisy`). Nothing is saved on a failed run. Microphone errors get a toast from `micErrorMessage`. | Same panel | Only when it happens |
| Guests see the same row. Tooltip on the status: "Your browser keeps this until the host restarts DubMate." Members who joined from their own DubMate bring their sync along (the join handoff), and their tooltip reads "Sync on your own DubMate to keep it for every room." | Same panel | One click away |
| The measured delay is applied to every new take as its starting timing. `[` and `]` still fine-tune on top. | Booth (invisible) | Default |
| On the host's computer, an unsynced microphone and output pair gets one toast per tab session, after a take saves: "Take saved. Sync your mic in Audio settings so takes line up on their own." Guests get no toast (see decision 1). Recording is never blocked or delayed. | Toast | Only when it happens |
| **Lined up automatically.** After a take saves, the engine matches its timing to the original line's voice and sets the take's offset. A small caption by the timing readout says "Lined up automatically" (tooltip: "DubMate matched this take to the original line. Use [ and ] to adjust it.") until the user nudges. | Booth timing bar | Default (caption only) |
| If the take was clearly faster or slower than the original, it is also fitted (at most 8 % faster or slower). The caption reads "Lined up and fitted to the line" and an **Original speed** button appears (tooltip: "Play this take at the speed you recorded it"). | Booth timing bar | Only on a fitted take |
| With the guide voice on while recording, the take is not lined up (the mic can hear the guide and would line up to it). The starting timing still applies. | Booth (invisible) | Default |
| The timing bar's reset button becomes **Auto** (tooltip "Back to the automatic timing"): it returns to the take's automatic offset, or 0 for takes recorded before this PR. | Booth timing bar | Default |
| Each take in the history shows "Timing 82%" (tooltip: "How closely this take follows the original line's timing"). The best-timed take's figure is lightly highlighted. No score is shown when it couldn't be measured. | Takes panel | One click away |
| Deleting the take in the dub falls back to the best-timed remaining take (the newest when none has a score), instead of always the newest. | Takes panel / delete | Default |
| A new take is still always put in the dub. Picking a take by hand is never undone by the app. | Booth | Default |

No on-screen text names the methods (no "latency", "cross-correlation", "loopback").

## Data shapes and on-disk layout

### Mic sync

Browser: `localStorage["dubmate_mic_sync"]`, JSON:

```json
{ "Microphone (Yeti X)|Headphones (Realtek)": { "latency_ms": 140, "method": "clicks", "measured_at": 1790000000000 } }
```

- Key: `devicePairKey(inputLabel, outputLabel)` = `"<input>|<output>"`. Labels come from `enumerateDevices()`: the selected device, else the `deviceId === "default"` entry, else the first device. An empty label falls back to its `deviceId`, then to `"default"`. With no output entries (macOS WebView, which has no output routing), the output part is `"default"`; see Risks.
- `latency_ms`: integer, a multiple of 5, 0 to 800. `method`: `"clicks"` or `"claps"`.
- Read and written through `safeStorageGet/Set`, which `static/js/studio/audio_setup.js` now exports. A missing or unreadable value means "not synced".
- `localStorage` is per origin. On the host the origin is `http://127.0.0.1:<port>`, and the port changes when 8000 is busy (`sidecars.rs`). A guest's origin is a quick-tunnel host that changes every time the host launches. So, on the host only (`isEngineLocal()`), each successful sync is also written to the engine config, and an unsynced pair is looked up there before it counts as unsynced (then cached in `localStorage`).

Engine config (`pack_loader.load_config/save_config`, the existing `config.json`): new optional key `"mic_sync"`, the same `{pair: {latency_ms, method, measured_at}}` shape, at most 20 pairs (the oldest `measured_at` is dropped). Old configs without the key read as `{}`; nothing else in the file changes.

### Take fields (room state, `room_state.json`, still `state_version: 2`)

New optional fields on each take, set by the upload route:

| Field | Type | Meaning |
|---|---|---|
| `start_offset_ms` | int | The offset the take started with: the upload's `offset_ms` snapped to 5 ms. The client sends `-latency_ms` when the setup is synced, else the slider value (the picked take's offset) as before. Centre of the alignment search. |
| `auto_offset_ms` | int | The automatic timing, a multiple of 5: the aligned offset when alignment was confident, else `start_offset_ms`. What **Auto** returns to. |
| `aligned` | bool | Alignment was confident and applied. |
| `stretch` | float | Speed factor baked into the active audio (`1.0` = none; 0.92 to 1.08). |
| `timing_score` | float or null | 0 to 1, how closely the take's speech envelope follows the original line's at `auto_offset_ms` (after stretch). A property of the performance; nudging doesn't change it. Null when it couldn't be measured (see the guards below). Never NaN. |

`offset_ms` keeps its meaning (the offset everything plays and renders with). "Nudged" is derived, not stored: `abs(offset_ms - auto_offset_ms) >= 5`, the same tolerance pattern the noise-reduction toggle uses for `auto_gain_db` (`rooms_api.py`). Every offset the engine produces is a multiple of 5, because `#slider-nudge` has `step="5"` and `syncTakeParams` sends the slider value back with every pitch, reverb or gain change; an unsnapped `-137` would come back as `-135` and count as a nudge. The line entry (`picked`, `next_number`, `takes`) is unchanged.

### Files

Unchanged layout (`takes/<line_id>/<take_id>.wav`, `_raw.wav`, `_denoised_<key>.wav`). The active `<take_id>.wav` becomes `stretch(source)`, where source is the denoised or raw file. A new `audio_processor._write_active_take(source_wav, target_wav, stretch)` writes it: a copy at 1.0, ffmpeg `atempo` otherwise, always to `<target>.tmp.wav` then `os.replace`, so a failed pass leaves the previous active file intact. `_raw.wav` is never altered. Duration, peaks and auto gain are measured from the active file after it is written. `atempo` starts its output about 20 ms early (it drops half a window at the head), so after a fitted write the offset and score are measured again on the written file (offset only); the envelope result is kept if that pass isn't confident. Preview, premiere, render and ZIP all read the active file, so a fitted take sounds the same everywhere.

## Alignment (engine)

`audio_processor.align_take_timing(take, reference, start_offset_ms, sr, allow_stretch=True)` takes numpy arrays and needs no new dependency. The reference is the pack's original line audio, `os.path.join(pack.folder, line["filename"])`, which starts at `line.start`. The route reads it with the same guard as `_line_target_loudness`: missing or unreadable means "not measured".

1. **Envelope.** RMS in 20 ms windows every 5 ms, in dB, floored 50 dB below the peak, for take and reference.
2. **Trim** (analysis only, no audio is cut). Each side's voiced span = first to last frame within 35 dB of its peak, padded 100 ms and clipped to the file. Matching uses only those spans, so room tone before the line and the tail after it don't sway the result.
3. **Not measured.** Return `{auto_offset_ms: start_offset_ms, timing_score: None, stretch: 1.0, aligned: False}` when: either side has no voiced frames; the span ratio `r = take_span / reference_span` is outside 0.75 to 1.33 (an extra phrase, a noisy room or a missing line, where no fit is trustworthy); either envelope has zero variance over its span; or any score is not finite.
4. **Stretch, only if clearly needed.** Considered only when `allow_stretch` and `r` is outside 0.97 to 1.03. The candidate factor is `r` clamped to 0.92 to 1.08 (an `atempo` factor; above 1 speeds the take up). The take envelope is resampled by the factor and matched as in step 5. The stretch is kept only if its score beats the unstretched score by at least 0.05.
5. **Offset.** Pearson correlation of the two envelopes over their overlap for every 5 ms offset in `start_offset_ms ± 500 ms`, clipped to ±800 ms (the nudge range), refined by parabolic interpolation, then snapped to 5 ms. Applied (`aligned: True`) only when the best score is at least 0.5 and the best offset is not within 10 ms of the window edge; otherwise `auto_offset_ms = start_offset_ms` and `stretch = 1.0`, and `timing_score` is the score at the starting offset, raised to 0 when it is negative.
6. Returns `{auto_offset_ms, timing_score, stretch, aligned}`. `timing_score` is the score at the returned offset and stretch, rounded to 2 decimals.

The upload route skips alignment (not measured, no stretch) when the take was recorded with the guide voice on (new form field `guide_voice`). The guide is the exact reference, played from `ctx.currentTime` into the same headphones, so any bleed lands at the round-trip delay, correlates perfectly and would inflate the score.

Alignment runs inside the upload request under `room.processing_lock`, after transcoding and noise reduction (tens of ms, plus one ffmpeg pass when fitting). The take is added to the room only afterwards, so a nudge can't race it.

The existing take-model route tests upload 0.5 s flat tones against 0.25 s flat-tone reference lines. Their span ratio is 2, so step 3 returns "not measured" and their stored `offset_ms` and delete fallback are unchanged. Step 1 asserts this case directly.

## Mic sync measurement (studio)

Pure functions in a new `static/js/studio/timing.js` (no DOM, node-testable):

- `CLICK_TIMES_SEC`: 6 clicks at irregular spacing over about 1.2 s (irregular so only one lag matches). `clickTrainSamples(sampleRate, times)`: each click is a 5 ms sweep from 400 Hz to 10 kHz (capped at 0.45 of the sample rate) with a 10 % Tukey taper, peaking at `CLICK_PEAK` = -1 dBFS, so small earbuds held to the mic are heard. `AudioEngine.playClickTrain(times, leadSec, level = 1)` plays it on `ctx.destination`, the chosen output.
- `findClickTrainLag(samples, sampleRate, times, maxLagMs)`: quadrature matched filter (the sweep and its 90° twin, so phase shifts from the earbud and mic don't matter) of the recording against the click pattern over lags 0 to `maxLagMs`. Returns `{lagMs, confident}`; confident when the top peak is at least 1.8 times the best peak more than 10 ms away.
- `CLAP_BEAT_SEC`: 8 steady beats, 0.6 s apart. They play in the ears at `CLAP_BEAT_LEVEL` = 0.3 (about -11 dBFS).
- `findClapLag(samples, sampleRate, beatTimes)`: onsets from a 1 ms energy envelope. An onset counts only when it is sharp, measured against the room's floor (the quiet before the first beat, or the whole run if louder; the first 300 ms are skipped for the recorder's start click). For beats 3 to 8, the onset nearest each beat within -150 to +400 ms. Needs 4 hits, else null. Returns `{lagMs, spreadMs, hits, lags, inWindow, strays}`: `lags` are the hits, `inWindow` counts those within ±40 ms of their median, `lagMs` is the median of those, and `strays` counts the sharp sounds more than 150 ms from every beat at that delay.
- `judgeClaps(found)`: `quiet` (no result), `noisy` (more than 3 strays), `uneven` (fewer than 4 hits within ±40 ms of the median) or `ok`. Only `ok` saves.
- `combineRuns(lags)`: median and spread of the three click runs.
- `devicePairKey(inputLabel, outputLabel)`, `snapMs(ms)` (nearest multiple of 5).

Flow (`MicSyncMethods` mixin, `static/js/studio/mic_sync.js`):
- **Ready.** **Sync your mic** opens the panel on the earbuds-out warning with **Play clicks**. Nothing plays until it is pressed.
- **Clicks.** The meter's own stream closes (`pauseMeterStream`); the meter keeps showing the test's stream. Three times: `await audio.startRecording()`, `audio.playClickTrain(CLICK_TIMES_SEC, LEAD_SEC = 0.3)` at `ctx.currentTime + LEAD_SEC`, wait, `audio.stopRecording()`, `lag = findClickTrainLag(...) - LEAD_SEC`. This is the take's own audio path: fresh stream, recorder start, sound scheduled right after the recorder starts, `ctx.destination` on the chosen output. It measures the delay of a take whose actor follows the sound (see Risks for the picture). Accept when all three runs are confident, the spread is at most 20 ms and the median is between `browserEstimate - 20` and 800 ms, saving it with `method: "clicks"`.
- **Clicks failed.** Otherwise the panel shows the `clicksFailed` step: **Try again** runs the clicks again, **Clap instead** opens the `clap` step.
- **Clap.** The `clap` step waits for **Start clapping**, so the headphones can go back on. One pass records with the beat starting `CLAP_LEAD_SEC` = 0.8 s in (the quiet before it measures the room). `judgeClaps` decides; `ok` with `lagMs` at most 800 ms saves `max(lagMs, browserEstimate)` with `method: "claps"`; `quiet`, `noisy` and `uneven` show their failure line and **Start clapping** again.
- `browserEstimate = (ctx.outputLatency + ctx.baseLatency + track.getSettings().latency) * 1000`, each term 0 when the browser doesn't report it. The saved value is `snapMs` of the result. Sync is refused while a countdown, a recording or a room check is running. After a run ends, fails or is cancelled, the meter's stream reopens (`resumeInputMeter`).

If the mic opened through the last fallback in `requestMicrophone` (`{audio: true}`, echo cancellation on), the browser may cancel the clicks. They are then not confidently found, and the flow offers the clap test, which echo cancellation doesn't touch. The clap test stays because the owner brief asks for it.

Applying it: `booth.uploadTake` sends `offset_ms = -latency_ms` when `currentLatencyMs()` is known for the active pair, otherwise the slider value as before, plus `guide_voice`. The guide-voice flag is read from `checkGuideVoice` once, when recording starts (it also decides whether the guide plays), and passed through `finishRecording` to `uploadTake`, so toggling the checkbox before the take saves can't change it. The recording itself is untouched.

## API and WebSocket

- `POST /api/rooms/{room}/lines/{line}/takes`: new optional form field `guide_voice` (bool, default false; older tabs don't send it). `offset_ms` is read as the starting offset and snapped to 5 ms. The route passes the reference path, starting offset and `guide_voice` to `save_uploaded_take`, then stores the five fields above, with `offset_ms = auto_offset_ms`. The response's `take` (via `wire_take`) carries the new fields. The `take_recorded` payload is unchanged (`{line_id, line_index, take_id, url, noise_reduction, user_name, user_id}`); other clients get the fields from the full `state` that `Room.broadcast` attaches.
- New `POST /api/rooms/{room}/lines/{line}/takes/{take}/original_speed` with body `{"user_id"}`, guarded by `_require_line_actor` like pick and delete, and run under `room.processing_lock` like the noise-reduction toggle. It rewrites the active audio at 1.0 (`_write_active_take`), re-runs `align_take_timing(..., allow_stretch=False)`, and sets `stretch: 1.0`, the new `auto_offset_ms`, `timing_score` and `aligned`. It moves `offset_ms` to the new `auto_offset_ms` only if the take was not nudged. It bumps `audio_version`, refreshes `peaks`, `duration` and auto gain, calls `invalidate_exports()` and broadcasts `take_params_updated {line_id, take_id, url}`. 404 on an unknown take; a take with `stretch` 1.0 returns its unchanged wire take.
- `POST …/noise_reduction`: `toggle_take_noise_reduction` gains `stretch=1.0` and writes through `_write_active_take`; the route passes `take.get("stretch", 1.0)`. Timing fields are not recomputed.
- `GET /api/config` returns `mic_sync` (the stored pairs, `{}` when none) only to the engine's own computer; anyone else gets the pack list alone. `POST /api/config` also accepts `{"mic_sync": {"<pair>": {"latency_ms", "method", "measured_at"}}}` on its own, merges the pairs into the config (at most 20, the oldest dropped) and returns 400 on a bad entry (key over 200 characters, latency not an integer 0 to 800, unknown method). It is behind `require_own_computer`, so guests and members can't write it.
- Join handoff (`lobby.js`, `buildJoinHandoff`): a member joining from their own DubMate carries up to 20 of their newest synced pairs in the `#dm=` fragment, merged into the host page's `localStorage` (`first-test-fixes.md`).
- WebSocket: no change. `update_take_params` still sets `offset_ms`; the client derives "nudged".
- `Room.remove_take`: a deleted picked take falls back to the remaining take with the highest `timing_score` (unscored or zero-scored takes rank lowest; ties go to the newest).

## Existing data

No layout change and no `state_version` bump. The fields are optional and every reader defaults them: `stretch` 1.0, `timing_score` none, `aligned` false, and no `auto_offset_ms`, so **Auto** resets to 0 as before and no caption shows. Older tabs keep working against the new engine; the server aligns whatever starting offset they send. Take-model state v2 takes load verbatim (`rooms.py`), so the fields survive save and reload. Nothing is rewritten on load.

Tested in `tests/test_recording_timing.py`:
- A PR #12-era `room_state.json` (literal dict without the new fields) loads; `mix_takes` and `render_dub_mix` use `offset_ms` unchanged; the noise-reduction toggle works with stretch defaulting to 1.0; delete falls back to the newest; a save leaves the old takes' fields untouched.
- A `config.json` without `mic_sync` loads, reads as `{}`, and saving a pair keeps `packs_dir` and `exports_dir`.

## Export, render, premiere and project ZIP

No code change in `render_dub_mix`, `export_dub_video`, premiere or the screening: they read `offset_ms` and the active WAV, which already carries any stretch. `build_project_zip` renders `Raw_Takes/` from the active WAV, so those files are fitted too; the manifest line entry gains `stretch` so it says so. The booth stops reusing the locally recorded buffer for preview when the saved take has `stretch != 1.0`, so the first preview after recording plays the fitted audio from the engine.

## Not in this PR (still open)

- Re-aligning takes recorded before this PR, or re-running alignment when the pack or noise reduction changes.
- Moving existing takes when the user syncs or re-syncs (only new takes use the delay).
- Picking an older take automatically when a new one scores worse; changing which take a new recording puts in the dub.
- Trimming audio (trim is analysis-only), comping, word-level alignment, alignment to ASR timestamps.
- Aligning takes recorded with the guide voice on.
- Sharing the delay across browsers or computers; keeping a guest's sync across host restarts.
- Measuring the picture's delay (video seek, start-up and display), or delaying the video to match the sound.
- AudioWorklet capture (a precise recorder start timestamp); the recorder start gap is measured as part of the delay instead.
- Timing score in the booth outside the Takes panel; nagging about low scores.
- A switch to turn auto-align off (the nudge and **Auto**/**Original speed** are the overrides).

## Risks

- **Actors follow the picture as well as the sound.** The video is seeked and played after the recorder starts, and its delay is not in the click measurement. On high-delay outputs (Bluetooth), an actor who follows the lips speaks earlier than the sound suggests, so `-latency_ms` can over-correct. Auto-align fixes it when confident; when it isn't (dubbing in another language), the starting timing sticks and the nudge fixes it, as before. Hands-on check below.
- **macOS device key.** WebView has no output routing and may list no outputs, so the key's output part is always `default`, and switching from speakers to AirPods reuses the old delay. Auto-align absorbs it when confident; **Sync again** fixes it. Hands-on check below.
- **Guests lose their sync** when the host restarts DubMate (new tunnel origin). They get no toast, so nobody is asked again every session; auto-align still lines their takes up when confident.
- **Recorder start gap varies take to take.** The sync measures its typical value (median of three runs) and auto-align absorbs the rest when it is confident. Real-device spread is unknown until hands-on testing.
- **Dubbing in another language** gives weaker envelope matches. The 0.5 threshold, the span-ratio guard and the bounded window keep a poor match from moving a take; the starting timing still applies.
- **Noisy rooms or a vocal stem with music residue** widen the voiced span. The span-ratio guard then reports "not measured", which leaves the starting timing in place. Safe, but fewer takes get lined up in such rooms.
- **Headphones that can't reach the mic**, OS noise suppression (Krisp, NVIDIA Broadcast) or echo cancellation can hide the clicks; the clap test covers it.
- **Bluetooth headsets** have large, unstable delays; the 800 ms cap and spread check reject the worst.
- **Decode mismatch.** Sync measures the browser's decoded buffer; the stored take is decoded by ffmpeg. Opus pre-skip or a non-zero WebM start time could add a small constant difference. Low cost; covered by a hands-on check.
- **`atempo` quality** at up to 8 % is acceptable for speech; it is only applied when it clearly helps, and **Original speed** undoes it.
- **Pre-existing:** right after recording with noise reduction on, the booth previews the local un-cleaned recording. Out of scope; noted for feature 4.

## Hands-on checks

Automated tests use synthetic signals and stubbed audio. These need real devices on the owner's build; none is recorded as done yet:

- Bluetooth headphones: sync, record a few lines following the picture, and check whether takes land early.
- macOS: sync on speakers, switch to AirPods, record, and check how far off the reused delay is before **Sync again**.
- Sync three times on one setup and note the spread of the recorder start gap.
- Record a clap after syncing and check the saved take places it where the sync says (decode mismatch).

## Decided overnight, revisit

These were decided without the owner and are what shipped. The owner still has to confirm each one; 9 and 11 change roadmap lines and ROADMAP.md marks them as awaiting that answer.

1. The delay is stored in the browser (`localStorage`, keyed by device labels) and, on the host's computer, also in the engine config, so a port change doesn't lose it. A guest's sync lasts until the host restarts DubMate (the tunnel address changes), so guests get no "please sync" toast. Owner to confirm this is acceptable for guests. (Since PR #19, members who join from their own DubMate bring their sync along.)
2. Sync measures through the real recording path (fresh stream, `MediaRecorder`, sound scheduled right after the recorder starts), three click runs, median. It measures the sound's round trip, not the picture's.
3. The clap fallback stays (owner brief) and saves `max(measured, browser estimate)`. As shipped in PR #14 it needed a 40 ms spread; since PR #19 it needs 4 claps within ±40 ms of their median and refuses runs with other sharp sounds (`judgeClaps`). The auditor suggested cutting it as the easiest simplification; auto-align would absorb most of the residual delay.
4. The "please sync" prompt is a toast, once per device pair per tab session, after a take saves, on the host's computer only. No alert dot, no modal.
5. When synced, a new take starts at `-latency_ms` instead of inheriting the picked take's offset. This changes take-model decision 4 for offset only; pitch, reverb and level are still inherited. Unsynced setups keep the old inheritance.
6. Alignment runs synchronously in the upload request, so it can never overwrite a nudge. "Nudged" is derived (`abs(offset_ms - auto_offset_ms) >= 5`), not stored, and every engine-made offset is snapped to the 5 ms slider step.
7. Thresholds: window ±500 ms around the starting offset, clipped to ±800 ms; apply at score ≥ 0.5 and not at the window edge; "not measured" when the voiced spans differ by more than 0.75 to 1.33; stretch considered outside 0.97 to 1.03, capped at 0.92 to 1.08, kept only for a 0.05 score gain.
8. Stretch is baked into the active take audio with ffmpeg `atempo` (no new dependency), written to a temp file and swapped in, so preview equals export; **Original speed** undoes it.
9. **Changes a roadmap line.** ROADMAP says "trim, then stretch, then offset". Here trim is analysis-only: it picks the voiced span that stretch and offset match on, and no audio is cut. Cutting audio would only remove room tone that the offset already places correctly. Owner to confirm.
10. Timing score = envelope correlation at the automatic timing, independent of later nudges; shown only in the Takes panel as "Timing N%".
11. **Changes a roadmap line.** ROADMAP says "Auto-align also pre-selects the best-timed take". Here it only applies when the app picks on its own: the delete fallback, plus the highlight in the Takes panel. A new take is still always picked (take model), and a hand pick is never changed by the app. Alternative for the owner: pick an older take automatically when the new one scores clearly worse.
12. The reset button becomes **Auto** and returns to `auto_offset_ms` (0 for older takes).
13. No `state_version` bump; old takes keep their fields and are not re-aligned.
14. **Original speed** is guarded like pick and delete (`_require_line_actor`) and runs under `processing_lock`.
15. Takes recorded with the guide voice on are not aligned or scored; the starting timing still applies.

## Implementation steps (landed)

All eight landed on `feat/recording-timing`, one commit each (`feat(recording-timing): 1` to `7`, then the changelog and roadmap commit), followed by the final review fixes and the guide-voice flag fix.

1. **Alignment math.** `audio_processor.align_take_timing` and envelope helpers, pure numpy, with all "not measured" guards; synthetic-signal tests in `tests/test_recording_timing.py`. No callers yet.
2. **Auto-aligned offsets in the engine.** Upload aligns (no stretch yet) and stores the timing fields with 5 ms snapping; `guide_voice` form field and the booth sends it; reference read guard; delete falls back to the best-timed take; old-state compatibility test.
3. **Fitted takes.** `_write_active_take` (temp file and replace); upload allows stretch; noise-reduction toggle keeps the stretch; `original_speed` route under the lock; manifest `stretch`.
4. **Mic sync measurement.** `static/js/studio/timing.js` pure functions and `AudioEngine.playClickTrain`; node tests on synthetic recordings.
5. **Mic sync storage and starting offset.** Engine config `mic_sync` (GET/POST `/api/config`); exported storage helpers; read/write of the delay in `mic_sync.js`; starting offset in `uploadTake`; the host-only toast; tests.
6. **Mic sync in Audio settings.** Timing row and panel, the click and clap flow in `MicSyncMethods`; JSDOM tests with stubbed audio.
7. **Timing in the booth.** "Lined up automatically" caption, **Original speed**, **Auto** reset, timing score in the Takes panel, no local-buffer reuse for fitted takes; JSDOM tests.
8. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 2 marked done, with decisions 9 and 11 noted as awaiting the owner's confirmation.
