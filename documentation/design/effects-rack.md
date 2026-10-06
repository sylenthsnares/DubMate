# Design: effects rack (one sound engine, presets first)

Roadmap feature 3. Owner decisions: October 2026 interview (ROADMAP.md, Decisions: "One effects implementation", "Preview feel", "Loudness", "Resolve effect settings by replacement"). Builds on the take model (`take-model.md`, PR #12) and recording timing (`recording-timing.md`, PR #14). Branch `feat/effects-rack`.

**Gate.** ROADMAP.md asks for a design review with the owner before any code. Step 1 does not start until the owner has signed off "Decided overnight, revisit" below. Items 1, 2 and 12 there bend an owner instruction and need an explicit yes or no.

## Where sound goes wrong today

There are two effect implementations that disagree:

- **Export** (`audio_processor.apply_audio_effects`, called by `_render_take` for `render_dub_mix`, `export_dub_video` and `build_project_zip`): ffmpeg `highpass=f=80` always, pitch by `asetrate` + `atempo`, linear gain, then a numpy convolution reverb (`get_reverb_impulse(1.5)`, wet × 0.7). Master: `master_soft_limiter` at −0.3 dBFS, no loudness target.
- **Preview** (`audio_engine.js`: `pitchShiftBuffer`, `buildVocalDSPChain`, `_generateReverbImpulse`): its own overlap-add pitch shifter, a Web Audio high-pass that the Low Cut rocker can switch off, a random stereo impulse whose Decay and Pre-delay sliders exist only in the browser. `screening.js` uses the same browser chain for the live premiere.

So Low Cut, Decay and Pre-delay change only the preview, the pitch sounds different in preview and export, and COMPRESS was removed (B3) for the same reason. Level matching uses a homemade gated RMS (`calculate_speech_gated_loudness`).

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| A **Voice** panel replaces "Voice effects". It shows four presets, **Clean**, **Warm**, **Radio** and **Monster**, as chips, plus the **Level** dial with its Auto/Matched badge and a small output meter. Picking a preset changes the take's sound. Editing anything in the full rack shows a **Custom** chip. | Booth | Default |
| **All effects** opens the full rack: Low cut, Gate, Tone (low, mid, high, with a curve), De-ess, Compress, Pitch, Reverb (amount, decay, pre-delay) and Clean up noise. Every effect has an on/off switch and a **Mix** dial ("How much of this effect you hear"). | Booth | One click away |
| **Use on all of NAME's lines** (that character's actor or the host) and **Use on every line** (host only) sit at the bottom of the full rack. Both ask first: "Use this sound on all of Ana's lines? Lines you changed by hand will switch too." | Full rack | One click away |
| The panel is shown only on a line you can record (`canRecordLine`) that has a take. Nobody sees controls for someone else's line. | Booth | Default |
| Dials, chips, the Tone curve, the Level readout and the meter move the instant you touch them. The sound you hear is always a real render from DubMate: it keeps playing the last one and crossfades into the new one when it's ready, usually well under a second. While it catches up, the panel shows a slow pulse (tooltip "Your sound is updating"; a still dot with reduced motion). | Booth | Default |
| Switching presets on a saved take is instant: every take is rendered through every preset in the background when it's saved. | Booth | Invisible |
| Preview, Takes → Play, the premiere, the exported video and the project ZIP all use the same rendered sound. Low cut and Compress now reach the export. | Everywhere | Default |
| A take at its matched level stays matched when its sound changes (a Radio take is levelled as a Radio take). | Booth | Invisible |
| Exports are mastered: the whole scene is brought to a steady streaming loudness and its peaks are limited, so dubs from different rooms play at the same volume. | Export, premiere video, project ZIP | Invisible |
| Rooms from earlier versions keep their sound: a take's pitch and reverb become its own settings in the rack. | Engine start | Invisible |

New strings (PRODUCT.md voice): "Voice", "Clean", "Warm", "Radio", "Monster", "Custom", "Level", "All effects", "Low cut", "Gate", "Tone", "Low", "Mid", "High", "De-ess", "Compress", "Pitch", "Reverb", "Decay", "Pre-delay", "Mix", "Use on all of NAME's lines", "Use on every line". Tooltips: Clean "Your voice, with low rumble removed"; Warm "Fuller and smoother, with a little room"; Radio "Thin and boxy, like a speaker or a phone"; Monster "Lower and bigger"; Gate "Silences the gaps between words"; Tone "Shape the low, middle and high end"; De-ess "Softens harsh S sounds"; Compress "Evens out loud and quiet words"; Mix "How much of this effect you hear"; Level "How loud this take sits in the dub". Messages: "Getting voice effects ready. This happens once." and "Voice effects need a one-time download. Check your connection and restart DubMate." No on-screen text names pedalboard, Rubber Band, LUFS or BS.1770.

The old default-level Pitch and Reverb dials move into the full rack (decision 17). BOOST becomes Level. The Low cut rocker, Decay and Pre-delay become real reverb and low-cut settings.

## The sound engine

New root module `vocal_chain.py`: pure functions on dicts and float32 numpy arrays, no files, no imports from `audio_processor`.

### Chain

Fixed order, no reordering. Each node has `on` and `mix` (0 to 1; output = dry + mix × (wet − dry)). Hidden constants are not stored.

| Node | Stored params (range, Clean default) | Implementation (pedalboard 0.9.25 unless noted) |
|---|---|---|
| `lowcut` | `hz` 40–400 (80), on | Two `HighpassFilter(hz / 1.554)` in series: −3 dB at `hz`, 12 dB/octave |
| `gate` | `threshold_db` −80…−20 (−50), off | `NoiseGate(threshold_db, ratio=10, attack_ms=1, release_ms=120)` |
| `eq` (Tone) | `low_db` ±12 (0, shelf 150 Hz), `mid_db` ±12 (0, peak q 1.0), `mid_hz` 300–5000 (1500), `high_db` ±12 (0, shelf 6 kHz), off | `LowShelfFilter`, `PeakFilter`, `HighShelfFilter` |
| `deess` | `threshold_db` −50…−10 (−30), `hz` 3000–10000 (6000), off | Split band: `sib` = two `HighpassFilter(hz)`; `Compressor(threshold_db, ratio=6, attack_ms=0.5, release_ms=40)` on `sib`; wet = x − sib + compressed sib |
| `comp` | `threshold_db` −40…0 (−18), `ratio` 1–10 (3), `makeup_db` 0–12 (0), off | `Compressor(threshold_db, ratio, attack_ms=8, release_ms=120)`, `Gain(makeup_db)` |
| `pitch` | `semitones` −12…12, step 1 (0), off | `PitchShift(semitones)` |
| `reverb` | `mix` (0.3), `decay_s` 0.2–2.0 (1.5), `predelay_ms` 0–60 (20), off | DubMate's own room impulse (`get_reverb_impulse(decay_s, predelay_ms)`, moved here with a pre-delay argument) convolved in numpy (`_fft_convolve`, moved here). Node wet = x + 0.7 × conv(x), so `mix` = the old `reverb_wet` exactly. Not pedalboard: see decision 2. |

Shape (`"v"` is the chain schema version):

```json
{"v": 1, "preset": "warm",
 "nodes": {"lowcut": {"on": true, "mix": 1.0, "hz": 90},
           "gate": {"on": false, "mix": 1.0, "threshold_db": -50},
           "eq": {"on": true, "mix": 1.0, "low_db": 2, "mid_db": -1, "mid_hz": 400, "high_db": -1.5},
           "deess": {"on": true, "mix": 1.0, "threshold_db": -28, "hz": 6000},
           "comp": {"on": true, "mix": 1.0, "threshold_db": -20, "ratio": 2.5, "makeup_db": 3},
           "pitch": {"on": false, "mix": 1.0, "semitones": 0},
           "reverb": {"on": true, "mix": 0.12, "decay_s": 1.0, "predelay_ms": 15}}}
```

- `normalize_chain(raw)` fills missing nodes and params from Clean, clamps every value to its range, rounds floats to 3 decimals, drops unknown keys and raises `ValueError` on a non-dict. Every stored or rendered chain is normalized first.
- `preset` is the preset id when the chain is an untouched preset, else `null`. It is a label only; it is not part of the render key.
- `PRESETS`: `clean` (low cut 80 Hz only, which is today's export sound), `warm` (above), `radio` (low cut 300 Hz; Tone low −6, mid +5 at 1800 Hz, high −10; Compress −24 dB, 4:1, +6), `monster` (low cut 60 Hz; Pitch −5; Tone low +3, high −2; Compress −20 dB, 3:1, +3; Reverb 0.25, 1.8 s, 25 ms). Values are tuned by ear in hands-on.
- **Level is not a node.** It stays the take's `gain_db`, applied after the chain as one multiplication, in the engine's mix and as a `GainNode` in the browser (exact). It has no Mix dial. It is matched to the original line on the chain's render (see Loudness).

### Rendering

`vocal_chain.render(audio, chain, sr=44100, until_s=None) -> np.ndarray`:

- Input is the take's active WAV (raw or cleaned, at its fitted speed), mono float32, padded with `0.1 s` of silence plus the impulse length when Reverb is on, so tails are kept.
- Deterministic: the same audio and chain give identical samples (checked for PitchShift: identical output across two fresh boards).
- No added delay: pedalboard compensates plugin latency, so sample 0 is still the take's start and recording-timing offsets stay valid (checked at 0 semitones: an impulse stays on its sample; at −5 the peak smears by about 7 ms, so a test checks that the envelope onset of a burst moves less than 5 ms at ±5 semitones).
- `until_s` renders only the take's first `until_s + 0.25` s. A prefix render equals the full render except its last ~40 ms (checked), so only `[0, until_s]` is used.
- `ensure_pedalboard()` imports pedalboard lazily. See Dependencies for the in-place desktop update case.

`audio_processor.render_take_cached(wav_path, chain, render_dir, until_s=None) -> (path, info)` is the one entry point for preview and export:

- Key: `sha1(RENDER_VERSION, pedalboard.__version__, sha1(take file bytes), canonical JSON of the normalized chain minus preset, until_ms)[:16]`. The file hash is memoized by (path, mtime, size).
- Files: `<room>/renders/<key>.wav` (mono 16-bit PCM, 44.1 kHz, `write_wav_mono`) and `<key>.json` (`{"line_id", "take_id", "duration", "lufs", "peak_db"}`, `lufs` only for full renders). Written to `.tmp` then `os.replace`, so concurrent renders of one key are harmless. A hit touches the mtime.
- Cap: when the folder passes 500 MB, the oldest files by mtime are deleted. The folder goes with the room on `prune_sessions`.
- The mix and the browser read the same 16-bit file: preview and export differ by at most one 16-bit step (read divides by 32768, write multiplies by 32767) and by the browser's resampling when the output device isn't 44.1 kHz.

## Settings resolution (replacement, not stacking)

`resolve_chain(voice, character, take)` returns the most specific chain that exists: `take["chain"]` → `voice["session"]` → `voice["characters"][character]` → Clean. Each level replaces the whole chain. The same function exists in `static/js/studio/voice.js`; both are tested against one fixture, `tests/fixtures/chain_resolution.json`.

- **Take**: set by any edit in the Voice panel (`PUT …/chain`). A new take copies the picked take's own `chain` (take-model decision 4, extended); a take without one follows the room.
- **Character default**: **Use on all of NAME's lines**. Sets `voice.characters[NAME]` and removes `chain` from every take on that character's lines.
- **Session**: **Use on every line** (host). Sets `voice.session` and removes `chain` from every take in the room. `voice.characters` is kept (it returns if the session sound is cleared later).
- Choosing Clean on a take stores Clean on the take (it does not mean "follow the room").

## Loudness

### Per line (kept, re-measured)

- `audio_processor.integrated_lufs(x, sr)`: ITU-R BS.1770-4, pyloudnorm's algorithm ported to numpy with its MIT notice (decision 1). K-weighting with pyloudnorm's two biquads for the given rate, applied by their exact frequency response on a zero-padded FFT (padding ≥ 1 s, so the result equals `lfilter` to ~1e-6 for these fast-decaying filters); 400 ms blocks, 75 % overlap, −70 LUFS absolute gate, −10 LU relative gate. Shorter than one block: ungated mean square. Silence: −70.
- Measured in mono, the layout DubMate mixes and ships in (Dubious's trap): takes, pack lines and the mix are all mono.
- Target: `pack_loader.measure_line_loudness` now returns `integrated_lufs` of the original line (same lazy, mtime-keyed memo). Unmeasurable or below −55: `DEFAULT_DIALOGUE_LUFS = −21.0`.
- A take's `auto_gain_db` = target − `lufs` of the take's **render** through its resolved chain, clamped ±12 dB, and capped so the render's sample peak stays ≤ −1 dBFS (as today). `calculate_speech_gated_loudness` is removed.
- Re-matching (`rooms_api._rematch_level`): whenever a take's audio or resolved chain changes (upload, noise-reduction switch, Original speed, take chain change, character or session change), the engine renders it, stores `loudness_lufs`, `target_lufs`, `auto_gain_db`, and moves `gain_db` to the new auto gain if it was within 0.05 dB of the old one (today's rule).

### Master stage

`audio_processor.master_stage(mix, sr) -> (out, {"lufs_in", "gain_db", "true_peak_db"})`:

1. Gain to −16 LUFS integrated (`integrated_lufs`), clamped to ±24 dB; skipped when the mix is below −70.
2. `pedalboard.BrickwallLimiter(ceiling_db=−1.5, true_peak=True)` (checked: a 1.58 dBTP worst-case tone comes out ≈ −1.6 dBTP, length unchanged).
3. `true_peak_db` = 4× oversampled peak (numpy polyphase windowed-sinc, 48 taps per phase, in blocks). If it is still above −1.0 dBTP, a static trim takes it to −1.0.

It replaces `master_soft_limiter`. `render_dub_mix` is split into `_mix_scene(pack, takes, sr, presence_db)` (backing × 0.65, takes × level × presence, unrecorded originals × 0.9 × presence, all unchanged) and `master_stage`.

## Data shapes and on-disk layout

`room_state.json` goes to `"state_version": 3`:

```json
{"state_version": 3,
 "voice": {"session": null, "characters": {"Ogre": {"v": 1, "preset": "monster", "nodes": {}}}},
 "takes": {"t44048": {"picked": "9f3c1a2b", "next_number": 3, "takes": [
   {"take_id": "9f3c1a2b", "...": "take model + timing fields as before",
    "chain": {"v": 1, "preset": null, "nodes": {}},
    "gain_db": -2.5, "loudness_lufs": -19.4, "target_lufs": -21.9, "auto_gain_db": -2.5}]}}}
```

- `Room.voice = {"session": chain | None, "characters": {name: chain}}`, saved and loaded with the room.
- Take `chain` is optional (absent = follow the room). `loudness_lufs` and `target_lufs` are new; `speech_loudness_db`, `target_loudness_db`, `pitch_semitones` and `reverb_wet` stay on old takes as written and are no longer read or written.
- Render cache: `<room>/renders/<key>.wav` + `.json` (above). Nothing else on disk changes.

## API and WebSocket

| Route | Body | Effect | Broadcast |
|---|---|---|---|
| `POST /api/rooms/{room}/lines/{line}/takes/{take}/render` | `{chain, client_id, until_s?}` | Renders through `render_take_cached` (foreground semaphore of 2). A request still queued when a newer one arrives from the same `client_id` for the same take returns `409 {"superseded": true}` without rendering. Also queues the take's preset renders in the background if not done this run. 503 with the "Getting voice effects ready" text while pedalboard is being installed. No permission check (read-only; the premiere needs it). | none |
| `GET /api/rooms/{room}/renders/{key}.wav` | | Range stream, long cache (keys are immutable). Key must match `[0-9a-f]{16}`; path guarded like `take_dir`. | |
| `PUT /api/rooms/{room}/lines/{line}/takes/{take}/chain` | `{user_id, chain \| null}` | Sets or clears the take's chain (`_require_line_actor`), re-matches level, `invalidate_exports()`. Returns `{take, line}`. | `take_params_updated {line_id, take_id}` |
| `PUT /api/rooms/{room}/voice` | `{user_id, scope: "character" \| "session", character?, chain \| null}` | Character scope: host or an actor assigned to the character (anyone when nobody is). Session scope: host (everyone in a solo room). Clears the affected take chains, `invalidate_exports()`, then re-matches affected takes in a background job (`room.voice_job`); exports await it. | `voice_updated {scope, character}` |

- Upload (`POST …/takes`): the take copies the picked take's `chain`; the engine renders its resolved chain inside the request (needed for the matched level), then queues the four presets in the background (one background worker per engine, after foreground renders). The `pitch_semitones` and `reverb_wet` form fields are ignored.
- `update_take_params` keeps `offset_ms` and `gain_db` only.
- State payload: `state_version: 3`, `voice` plus `voice.presets` (`[{id, name, chain}]` from `vocal_chain.PRESETS`, so the client never hard-codes them), and takes carry `chain`. The client's `TAKE_STATE_VERSION` becomes 3 in the same commit; older tabs get the existing reload notice.

## Optimistic preview (studio)

`static/js/studio/voice.js`, pure and node-testable:

- `resolveChain(voice, character, take)`, `presetLabel(chain, presets)` ("Custom" when `preset` is null), `eqCurveDb(eq, freqs, sr)` (RBJ shelf/peak magnitudes, drawing only).
- `createRenderScheduler({debounceMs = 120, request, onReady, now, setTimer, clearTimer})`: `want(chain, {playheadS, takeDuration, playing})` bumps a sequence number and (re)starts the debounce; on fire it calls `request`. A response whose sequence isn't the latest is dropped. States: `current` → `waiting` (debounce) → `rendering` → `current`; the panel pulse shows in `waiting` and `rendering`. Playhead first: when `playing` and `takeDuration > 4`, it first requests `until_s = playheadS + 2`, hands that to `onReady`, then requests the full render.

Booth (`static/js/studio/voice_rack.js`, `VoiceRackMethods` mixin):

- On line load, request the resolved chain's render; Preview and Takes → Play wait for it (button pulse), then play it. No browser effects remain.
- Every control edit updates its UI at once, calls `want`, and persists with `PUT …/chain` after 400 ms of quiet and on release. Level only changes the `GainNode` and sends `update_take_params` as today.
- `AudioEngine.crossfadeTo(buffer, { atS })`: starts the new buffer at the current position in the take (both renders share the timeline), equal-power ramps over 30 ms, stops the old source. If a prefix render is about to run out (50 ms before its end) before the full one arrives, it crossfades back to the previous full render at that point; the sound is always a real render.
- Output meter: an `AnalyserNode` after the level gain.

## Export, render, premiere and project ZIP

- `Room.mix_takes()` adds `chain` (resolved, normalized) and `render_dir` to each entry. `_render_take` calls `render_take_cached` and multiplies by level; `apply_audio_effects` is deleted. The failure policy is unchanged (skip in the render, near-silent placeholder in the ZIP, logged).
- `render_dub_mix` / `export_dub_video` (export, download, premiere auto-render): `_mix_scene` + `master_stage`.
- Live premiere fallback (`screening.js`, before the exported video is ready): plays each picked take's render × level × presence, plus backing and originals as today. It has no master stage; the theater switches to the exported video as soon as it's ready, as today (decision 11).
- Project ZIP: per-line audio is the same render × level. The master gain from the scene mix (computed as in `render_dub_mix`) is applied to Master_Vocal_Mix and every character stem, each then limited to −1 dBTP. The backing stem is unchanged. Manifest: top-level `"master": {"target_lufs": -16, "gain_db"}`, per line `chain` (resolved), and the old `pitch_semitones` / `reverb_wet` keys derived from it (0 when the node is off). The cue sheet's "DSP Tuning" line reads `Sound: Warm` or `Sound: Custom`.

## Existing data

On load, `rooms.load_persisted_rooms` runs `_migrate_v2_chains(room)` for a state below version 3 (after the v1 → v2 step when needed), then saves as version 3:

- A take with `pitch_semitones` ≠ 0 or `reverb_wet` > 0.02 gets `chain = chain_from_legacy(pitch, reverb)`: Clean with Pitch on at that value and Reverb on at `mix = reverb_wet`, 1.5 s, 20 ms. Others get no chain and follow Clean, which is today's export sound.
- `gain_db` and every other field are unchanged, so levels stay where they were. `pitch_semitones` and `reverb_wet` stay in the file.
- `voice` starts as `{"session": null, "characters": {}}`.
- Idempotent: a take that already has `chain` is skipped. A `pending_v1_takes` entry migrated on a later start goes through the same conversion.

Old takes have no renders; they render on first use (the render route also queues their presets).

**Tests** (`tests/test_effects_rack.py`, no network, temp cache dir patched as in `test_take_model.py`): a PR #14-era version 2 `room_state.json` literal with three takes (pitch −3 and reverb 0.4; reverb only; neither) loads as version 3 with the expected chains and no chain on the third; legacy fields unchanged; a second load changes nothing; a version 1 room reaches version 3 in one load; a pending v1 take migrated later gets its chain. Sound: a reverb-only migrated take rendered by the new engine matches the old formula (ffmpeg 80 Hz high-pass + `_fft_convolve` with the 1.5 s impulse × 0.7) within −35 dB RMS difference on a 1 kHz burst-and-noise signal; the only difference is the low-cut slope (decision 8).

## Dependencies and packaging

- `requirements.txt`: `pedalboard==0.9.25` (GPLv3, numpy only). Wheels exist for cp312 `win_amd64`, `macosx_11_0_arm64`, `macosx_10_14_x86_64` and cp311 `manylinux_2_28_x86_64` (CI). No other new dependency (decision 1).
- `vocal_chain.py` joins the three ship lists (`release.yml` app-bundle zip, `stage-sidecars.ps1` `$FilesToCopy`, `stage-sidecars.sh`); `test_release_metadata.py` also checks the project modules `audio_processor.py` imports. Both import-smoke steps in `release.yml` add `import pedalboard`, because the macOS staging `pip install` ends in `|| true` and would otherwise ship without it.
- In-place desktop updates replace only the Python files; the bundled runtime of an existing install has no pedalboard, and the updater that runs is the old one. So the engine heals itself: at startup, if `import pedalboard` fails and `DUBMATE_TOOLS_DIR` is set (desktop), a background thread runs `sys.executable -m pip install --no-input --no-deps --target <CACHE_DIR>/engine-packages/py3XY pedalboard==<pin from requirements.txt>` (timeout 300 s), adds that folder to `sys.path` and imports. Source installs get it from `update.bat` / `update.sh`, which already run `pip install -r requirements.txt`. Until it's ready, renders return 503 and exports wait up to the install's end, then fail with the plain message.

## Not in this PR

- VST hosting, comping, smart ducking.
- Reordering effects, more than one instance of an effect, saving your own presets, presets per pack.
- Effects on unrecorded lines (the original voice plays untouched).
- A master stage in the booth preview or the live-premiere fallback (decision 11); a final mix file inside the project ZIP; changing the ZIP's backing stem level.
- A stereo mix or stereo reverb.
- Re-matching levels of old takes on migration.
- Permission checks on Level and timing (unchanged from the take model).

## Risks

- **Pitch sounds different from old exports.** Rubber Band replaces ffmpeg's resample-and-stretch. Same amount and length, different artifacts. Hands-on.
- **Low end of old takes.** The new low cut is 12 dB/octave like the old one but with a softer knee (−8.5 dB at 40 Hz instead of about −12). Inaudible on most mics; hands-on.
- **Render speed.** Measured 0.13 s for 4 s through PitchShift on the dev machine. Slow laptops with long takes lean on playhead-first and the background preset renders. The scheduler drops stale requests on both sides.
- **In-place desktop update** needs the internet once for pedalboard (a 2.5 to 3.7 MB wheel). Offline, effects and export say so. The pip call, numpy ABI and Windows `._pth` path rules are checked hands-on on both platforms.
- **Loudness jump on first export after the update.** Old exports were peak-limited only; new ones are −16 LUFS. Intended.
- **Mono measurement.** Platforms that play a mono file as dual mono and meter it as stereo read about +3 LU (−13). We follow the brief: measure in the layout we mix and ship.
- **Disk.** Five renders per take; capped at 500 MB per room and removed with the room.
- **Browser resampling** on 48 kHz devices is the one remaining preview/export difference besides one 16-bit step. Not an effect; inaudible.
- **Character/session apply clears hand edits** on the affected takes. Mitigated by the confirm text.
- **Concurrent edits** to one take's chain by two people: last write wins, as with the sliders today.

## Decided overnight, revisit

1. **Bends an owner instruction.** Loudness uses pyloudnorm's BS.1770 algorithm ported to numpy (MIT notice kept), not the pyloudnorm package, because pyloudnorm requires scipy and the cleanup removed scipy on purpose (CHANGELOG "Smaller Install"; Calibrate Mic avoids noisereduce for the same reason). Alternative: add `pyloudnorm` and scipy (a download of about 40 MB) and swap the function body; the tests stay.
2. **Bends an owner instruction.** Reverb keeps DubMate's own room impulse, convolved in numpy inside the engine, instead of a pedalboard plugin. It is still one engine-side implementation for preview and export, and it keeps old rooms' reverb identical. pedalboard's `Convolution` normalises impulses (checked: a 0.5 tap came out 0.11) and `Reverb` is a different room sound.
3. Level is the take's `gain_db` after the chain, not a chain node, and has no Mix dial (as in Dubious: "gain_db, not a chain node").
4. Fixed effect order (low cut, gate, tone, de-ess, compress, pitch, reverb); every effect has on/off and Mix.
5. Presets: Clean (today's export sound and the default), Warm, Radio, Monster. A preset is a whole chain; any edit shows Custom.
6. Resolution: take → session (`voice.session`, host) → character default (`voice.characters`, the character's actor or host) → Clean, most specific wins, each replacing the whole chain. Both room-level actions clear the affected takes' own chains after a confirm. Choosing Clean on a take stores it on the take.
7. Migration gives a take its own chain only when its pitch or reverb was set; levels and legacy fields are untouched; old takes are not re-levelled.
8. Low cut is two first-order high-passes (pedalboard has no second-order one): same slope, softer knee than the old ffmpeg filter.
9. Pitch now uses Rubber Band; old takes keep their pitch amount but not the old artifacts.
10. Master: −16 LUFS integrated, clamped ±24 dB, true-peak limiter at −1.5 plus a static trim that guarantees ≤ −1.0 dBTP measured at 4× oversampling; measured in mono.
11. The booth preview and the live-premiere fallback play real renders at mix level without the master stage (one scene-wide gain and a limiter). The premiere switches to the mastered video when it's ready, as today.
12. **Reads an owner instruction narrowly.** The project ZIP has no single final mix, so its vocal and character stems carry the export's master gain and are each limited to −1 dBTP; the backing stem is unchanged.
13. In-place desktop updates install pedalboard once into the cache in the background; no launcher (Rust) change, because the old launcher runs the update.
14. Playhead-first applies only to takes over 4 s while previewing: render from the take's start to playhead + 2 s, then the rest.
15. Render cache lives in the room folder, capped at 500 MB, oldest first.
16. The Voice panel appears only on lines you can record that have a take; Use on every line is host only.
17. Pitch and Reverb move from the default view into the full rack (owner: presets and level by default).
18. Rendering needs no permission; changing a take's chain needs `_require_line_actor`; character and session changes are guarded as above.
19. A new take copies the picked take's own chain.
20. Decay and Pre-delay become stored reverb settings; Decay is capped at 2.0 s, the impulse generator's existing cap.
21. When the original line can't be measured, the target is −21 LUFS.
22. pedalboard is pinned to 0.9.25 and its version is part of the render key.

## Implementation steps

1. **Voice chain module and pedalboard.** `vocal_chain.py` (chain schema, presets, resolution, legacy mapping, render with prefix, reverb impulse and convolution moved in, lazy import and desktop self-install), `pedalboard==0.9.25` in requirements, ship lists and import smoke; `tests/test_vocal_chain.py` and the shared resolution fixture. No callers yet.
2. **BS.1770 loudness and the master stage.** `integrated_lufs`, `true_peak_db`, `master_stage`; `_mix_scene` split; render, export and ZIP mastered; line targets and auto gain in LUFS; `tests/test_loudness_master.py`; old loudness tests updated.
3. **Exports render through the chain.** `render_take_cached` and the render cache; `_render_take` uses it with a chain derived from the take's pitch and reverb; `apply_audio_effects` removed; upload level matched on the render; ZIP manifest and cue sheet; parity tests.
4. **Chains in the room and the take model.** State version 3 with `voice` and take `chain`, migration, resolution in `mix_takes`; render, renders, take chain and voice routes; supersede; background preset renders; level re-matching; wire adapter for the current client; `tests/test_effects_rack.py`.
5. **Booth and premiere play the engine's renders.** `voice.js` scheduler and helpers, `AudioEngine` without browser effects plus `crossfadeTo`, current sliders edit the chain, screening uses renders, state version 3 on the wire; JSDOM tests.
6. **Voice panel: presets first, full rack one click away.** New panel markup, `VoiceRackMethods`, disclosure rules, Tone curve, meter, Use on all lines / every line; JSDOM tests.
7. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 3 marked done.
