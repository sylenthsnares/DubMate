# Design: effects rack (one sound engine, presets first)

Roadmap feature 3. Owner decisions: October 2026 interview (ROADMAP.md, Decisions: "One effects implementation", "Preview feel", "Loudness", "Resolve effect settings by replacement"). Builds on the take model (`take-model.md`, PR #12) and recording timing (`recording-timing.md`, PR #14). Branch `feat/effects-rack`, which now includes the final PR #14 fixes (merge of `main` at e083763).

**Gate.** ROADMAP.md asks for a design review with the owner before any code. Step 1 does not start until the owner has signed off "Decided overnight, revisit" below. Items 1, 2, 11 and 12 there bend an owner instruction and need an explicit yes or no.

**Revision.** This version fixes the claim audit of the first draft: resolution order, pitch timing, where the module lives, data safety on load and downgrade, the gain clamp, offline behaviour, Windows file locking, the project ZIP's master gain, Decay range, and steps that would have left tests red.

## Where sound goes wrong today

There are two effect implementations that disagree:

- **Export** (`audio_processor.apply_audio_effects`, called by `_render_take` for `render_dub_mix`, `export_dub_video` and `build_project_zip`): ffmpeg `highpass=f=80` always, pitch by `asetrate` + `atempo`, gain clamped to `GAIN_DB_MIN..GAIN_DB_MAX` (−60…+24 dB), then a numpy convolution reverb (`get_reverb_impulse(1.5)`, wet × 0.7). Master: `master_soft_limiter` at −0.3 dBFS, no loudness target.
- **Preview** (`audio_engine.js`: `pitchShiftBuffer`, `buildVocalDSPChain`, `_generateReverbImpulse`): its own overlap-add pitch shifter, a Web Audio high-pass that the Low Cut rocker can switch off, a random stereo impulse whose Decay (0.2–4.0 s) and Pre-delay sliders exist only in the browser. `screening.js` uses the same browser chain for the live premiere.

So Low Cut, Decay and Pre-delay change only the preview (`update_take_params` and the upload form carry only pitch, reverb, offset and gain), the pitch sounds different in preview and export, and COMPRESS was removed (B3) for the same reason. Level matching uses a homemade gated RMS (`calculate_speech_gated_loudness`).

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| A **Voice** panel replaces "Voice effects". It shows four presets, **Clean**, **Warm**, **Radio** and **Monster**, as chips, plus the **Level** dial with its Auto/Matched badge and a small output meter. Picking a preset changes the take's sound. Editing anything in the full rack shows a **Custom** chip. | Booth | Default |
| **All effects** opens the full rack: Low cut, Gate, Tone (low, mid, high, with a curve), De-ess, Compress, Pitch, Reverb (Decay, Pre-delay) and Clean up noise. Every effect has an on/off switch and a **Mix** dial ("How much of this effect you hear"); for Reverb the Mix dial is the amount of reverb, there is no second amount dial. | Booth | One click away |
| **Use on all of NAME's lines** (that character's actor or the host) and **Use on every line** (host only) sit at the bottom of the full rack. Both ask first. Character: "Use this sound on all of Ana's lines? Lines you changed by hand will switch too." Every line: "Use this sound on every line? Lines and characters with their own sound will switch too." | Full rack | One click away |
| The panel is shown only on a line you can record (`canRecordLine`) that has a take. Nobody sees controls for someone else's line. | Booth | Default |
| Dials, chips, the Tone curve, the Level readout and the meter move the instant you touch them. The sound you hear is always a real render from DubMate: it keeps playing the last one and crossfades into the new one when it's ready, usually well under a second. While it catches up, the panel shows a slow pulse (tooltip "Your sound is updating"; a still dot with reduced motion). | Booth | Default |
| Switching presets on a saved take is instant: every take is rendered through every preset in the background when it's saved. | Booth | Invisible |
| Preview, Takes → Play, the premiere, the exported video and the project ZIP all use the same rendered sound. Low cut and Compress now reach the export. | Everywhere | Default |
| A take at its matched level stays matched when its sound changes (a Radio take is levelled as a Radio take). | Booth | Invisible |
| Exports are mastered: the whole scene is brought to a steady streaming loudness and its peaks are limited, so dubs from different rooms play at the same volume. | Export, premiere video, project ZIP | Invisible |
| Rooms from earlier versions keep their sound: a take's pitch and reverb become its own settings in the rack. | Engine start | Invisible |
| If voice effects aren't installed yet (see Dependencies), recording still works; takes play without effects, the effect controls are disabled and the panel says why. Export waits for the effects. | Booth, export | Default |

New strings (PRODUCT.md voice): "Voice", "Clean", "Warm", "Radio", "Monster", "Custom", "Level", "All effects", "Low cut", "Gate", "Tone", "Low", "Mid", "High", "De-ess", "Compress", "Pitch", "Reverb", "Decay", "Pre-delay", "Mix", "Use on all of NAME's lines", "Use on every line". Tooltips: Clean "Your voice, with low rumble removed"; Warm "Fuller and smoother, with a little room"; Radio "Thin and boxy, like a speaker or a phone"; Monster "Lower and bigger"; Gate "Silences the gaps between words"; Tone "Shape the low, middle and high end"; De-ess "Softens harsh S sounds"; Compress "Evens out loud and quiet words"; Mix "How much of this effect you hear"; Level "How loud this take sits in the dub". Messages: "Getting voice effects ready. This happens once." and "Voice effects need a one-time download. Check your connection and restart DubMate." No on-screen text names pedalboard, Rubber Band, LUFS or BS.1770.

The old default-level Pitch and Reverb dials move into the full rack (decision 17). BOOST becomes Level. The Low cut rocker, Decay and Pre-delay become real reverb and low-cut settings.

## The sound engine

New module `dubmate/vocal_chain.py` (the `dubmate/` folder already ships whole in all three ship lists, so no ship-list entry can be forgotten): pure functions on dicts and float32 numpy arrays, no files, no imports from `audio_processor`.

### Chain

Fixed order, no reordering. Each node has `on` and `mix` (0 to 1; output = dry + mix × (wet − dry)). Hidden constants are not stored.

| Node | Stored params (range, Clean default) | Implementation (pedalboard 0.9.25 unless noted) |
|---|---|---|
| `lowcut` | `hz` 40–400 (80), on | Two `HighpassFilter(hz / 1.554)` in series: −3.0 dB at `hz`, −8.5 dB an octave below, 12 dB/octave (decision 8) |
| `gate` | `threshold_db` −80…−20 (−50), off | `NoiseGate(threshold_db, ratio=10, attack_ms=1, release_ms=120)` |
| `eq` (Tone) | `low_db` ±12 (0, shelf 150 Hz), `mid_db` ±12 (0, peak q 1.0), `mid_hz` 300–5000 (1500), `high_db` ±12 (0, shelf 6 kHz), off | `LowShelfFilter`, `PeakFilter`, `HighShelfFilter` |
| `deess` | `threshold_db` −50…−10 (−30), `hz` 3000–10000 (6000), off | Split band: `sib` = two `HighpassFilter(hz)`; `Compressor(threshold_db, ratio=6, attack_ms=0.5, release_ms=40)` on `sib`; wet = x − sib + compressed sib |
| `comp` | `threshold_db` −40…0 (−18), `ratio` 1–10 (3), `makeup_db` 0–12 (0), off | `Compressor(threshold_db, ratio, attack_ms=8, release_ms=120)`, `Gain(makeup_db)` |
| `pitch` | `semitones` −12…12, step 1 (0), off | `PitchShift(semitones)` |
| `reverb` | `mix` (0.3; this is the reverb amount), `decay_s` 0.2–4.0 (1.5), `predelay_ms` 0–60 (20), off | DubMate's own room impulse (`get_reverb_impulse(decay_s, sr, predelay_ms=20)`, moved here) convolved in numpy (`_fft_convolve`, moved here). Impulse length = `min(decay_s, 4.0)` s (was capped at 2.0; identical output for every decay up to 2.0, so old takes and the cache tests are unchanged). Node wet = x + 0.7 × conv(x), so `mix` = the old `reverb_wet` exactly. Not pedalboard: see decision 2. |

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
- **Level is not a node.** It stays the take's `gain_db`, applied after the chain as one multiplication: in the engine's mix as `10 ** (clip(gain_db + presence_db, GAIN_DB_MIN, GAIN_DB_MAX) / 20)` (the clamp `apply_audio_effects` has today, kept in `_render_take`), and in the browser as a `GainNode` with the same clamp (`voice.js` `levelGain(db)`). It has no Mix dial. It is matched to the original line on the chain's render (see Loudness).

### Rendering

`vocal_chain.render(audio, chain, sr=44100, until_s=None) -> np.ndarray`:

- Input is the take's active WAV (raw or cleaned, at its fitted speed), mono float32. When Reverb is on it is padded with `0.1 s` of silence plus the impulse length, so tails are kept; otherwise the output has the input's length (PitchShift keeps length).
- Deterministic: the same audio and chain give identical samples (checked for PitchShift across two fresh boards).
- Timing: pedalboard compensates plugin latency, so at 0 semitones an impulse stays on its sample and recording-timing offsets stay valid. Pitch smears onsets a little (measured with 10–50 % envelope thresholds, 3 seeds): +5 st 7–10 ms earlier, −5 st 4–7 ms later, +12 st about 19 ms earlier. All are well inside lip-sync detectability (ITU-R BT.1359: about 45 ms audio-early), so no compensation (decision 23). Tests pin the measured behaviour so a pedalboard change can't grow it silently: onset shift ≤ 15 ms at ±5 st and ≤ 25 ms at ±12 st, and exactly 0 samples at 0 st with Pitch off.
- `until_s` renders only the take's first `until_s + 0.25` s. A prefix render equals the full render over `[0, until_s]` (checked bit-identical with compressor and pitch), so only that range is used.
- `available()` imports pedalboard lazily and caches the result. See Dependencies.

`audio_processor.render_take_cached(wav_path, chain, render_dir, until_s=None) -> (path, info)` is the one entry point for preview and export:

- Key: `sha1(RENDER_VERSION, pedalboard.__version__, sha1(take file bytes), canonical JSON of the normalized chain minus preset, until_ms)[:16]`. The file hash is memoized by (path, mtime, size).
- Files: `<room>/renders/<key>.wav` (mono 16-bit PCM, 44.1 kHz, `write_wav_mono`) and `<key>.json` (`{"line_id", "take_id", "duration", "lufs", "peak_db"}`, `lufs` only for full renders). A hit touches the mtime (errors ignored).
- Concurrency (Windows-safe): one `threading.Lock` per key in a module dict; inside it the file is checked again, rendered to a unique `<key>.<pid>.<thread id>.tmp`, then `os.replace`d. Because the lock serializes one key and a hit never rewrites, `os.replace` only targets a missing file; if it still raises `PermissionError` (another program holds the name) and the target exists, the temp file is deleted and the existing file is used (renders are deterministic). Stray `.tmp` files older than an hour are removed on eviction.
- Cap: when the folder passes 500 MB, the oldest files by mtime are deleted, skipping any touched in the last 10 minutes and ignoring `PermissionError`/`FileNotFoundError` (a file being streamed on Windows can't be deleted; it goes next time). On POSIX an open file can be unlinked safely. The folder goes with the room on `prune_sessions`.
- If `vocal_chain.available()` is false it raises `EffectsUnavailable` (see Dependencies for who handles it).
- The mix and the browser read the same 16-bit file: preview and export differ by at most one 16-bit step and by the browser's resampling when the output device isn't 44.1 kHz.

## Settings resolution (replacement, not stacking)

`resolve_chain(voice, character, take)` returns the most specific chain that exists: `take["chain"]` → `voice["characters"][character]` → `voice["session"]` → Clean. Each level replaces the whole chain; nothing stacks. The same function exists in `static/js/studio/voice.js`; both are tested against one fixture, `tests/fixtures/chain_resolution.json`.

In Dubious (PLAN.md §5.5–5.6) the character default lives on the project and the session override is per character; there is no "every line" level. DubMate has no project above the room, so both live in the room, and the room-wide `session` chain is the least specific level, below a character's (decision 6). This keeps "most specific wins" literal and means no action can silently do nothing:

- **Take**: set by any edit in the Voice panel (`PUT …/chain`). A new take copies the picked take's own `chain` (take-model decision 4, extended); a take without one follows the room.
- **Character**: **Use on all of NAME's lines**. Sets `voice.characters[NAME]` and removes `chain` from every take on that character's lines. It beats the room-wide sound, so it is heard immediately.
- **Every line** (`session`, host): **Use on every line**. Sets `voice.session`, removes `chain` from every take and clears `voice.characters`, so every line plays it. The confirm says characters switch too.
- Choosing Clean on a take stores Clean on the take (it does not mean "follow the room").
- The fixture includes the audit's case: session Radio, then Ogre's actor picks Monster for Ogre → an Ogre take without its own chain resolves to Monster, a non-Ogre take to Radio.

## Loudness

### Per line (kept, re-measured)

- `audio_processor.integrated_lufs(x, sr)`: ITU-R BS.1770-4, pyloudnorm's algorithm ported to numpy with its MIT notice (decision 1): pyloudnorm's two K-weighting biquads for the given rate; 400 ms blocks, 75 % overlap, −70 LUFS absolute gate, −10 LU relative gate. Shorter than one block: ungated mean square. Silence: −70.
- K-weighting without scipy and without a big FFT: the two biquads' impulse response is computed once per rate (1 s, a short Python recursion on an impulse; it decays below 1e-7), and applied as an FIR by block overlap-add (`_fft_convolve` on 2¹⁶-sample blocks). Memory stays at a few MB for any length; the result equals a direct IIR to ~1e-6. A test compares with a plain-Python `lfilter` on 2 s of noise, and a 3-minute scene measures with `tracemalloc` peak under 64 MB.
- Measured in mono, the layout DubMate mixes and ships in (Dubious's trap): takes, pack lines and the mix are all mono.
- Target: `pack_loader.measure_line_loudness` now returns `integrated_lufs` of the original line (same lazy, mtime-keyed memo). Unmeasurable or below −55: `DEFAULT_DIALOGUE_LUFS = −21.0`.
- A take's `auto_gain_db` = target − `lufs` of the take's **render** through its resolved chain, clamped ±12 dB, and capped so the render's sample peak stays ≤ −1 dBFS (as today). `calculate_speech_gated_loudness` is removed.
- Re-matching (`rooms_api._rematch_level`): whenever a take's audio or resolved chain changes (upload, noise-reduction switch, Original speed, take chain change, character or session change), the engine renders it, stores `loudness_lufs`, `target_lufs`, `auto_gain_db`, and moves `gain_db` to the new auto gain if it was within 0.05 dB of the old one (today's rule). A take whose `loudness_lufs` is missing (uploaded while effects weren't installed) is re-matched on its first successful render.

### Master stage

`audio_processor.master_stage(mix, sr) -> (out, {"lufs_in", "gain_db", "true_peak_db"})`:

1. NaN/inf sanitized (`sanitize_finite_audio`, as `master_soft_limiter` does today).
2. Gain to −16 LUFS integrated (`integrated_lufs`), clamped to ±24 dB; skipped when the mix is below −70.
3. `pedalboard.BrickwallLimiter(ceiling_db=−1.5, true_peak=True)` (checked: 1.58 dBTP in, −1.59 dBTP out, length unchanged).
4. `true_peak_db` = 4× oversampled peak (numpy polyphase windowed-sinc, 48 taps per phase, in blocks). If it is still above −1.0 dBTP, a static trim takes it to −1.0.

It replaces `master_soft_limiter`. `render_dub_mix` is split into `_mix_scene(pack, takes, sr, presence_db)` (backing × 0.65, takes × level × presence, unrecorded originals × 0.9 × presence, all unchanged) and `master_stage`. Because the master sets the overall loudness, dialogue presence now changes the balance of voices against the backing rather than the whole export's volume, which is what it was for. The −1 dBTP is measured before AAC/MP3 encoding; encoders can add a few tenths of a dB (hands-on measures it on real exports; lowering the ceiling is a one-number change).

## Data shapes and on-disk layout

`room_state.json` stays `"state_version": 2`. The new data is additive, so an older engine that opens the file (a rolled-back install, an older source checkout) still loads every take; it ignores `chain` (keeping it, since take dicts are saved as they are) and drops `voice` on its next save.

```json
{"state_version": 2,
 "voice": {"session": null, "characters": {"Ogre": {"v": 1, "preset": "monster", "nodes": {}}}},
 "takes": {"t44048": {"picked": "9f3c1a2b", "next_number": 3, "takes": [
   {"take_id": "9f3c1a2b", "...": "take model + timing fields as before",
    "chain": {"v": 1, "preset": null, "nodes": {}},
    "gain_db": -2.5, "loudness_lufs": -19.4, "target_lufs": -21.9, "auto_gain_db": -2.5}]}}}
```

- `Room.voice = {"session": chain | None, "characters": {name: chain}}`, saved and loaded with the room. Its presence on disk marks the room as migrated.
- Take `chain` is optional (absent = follow the room). `loudness_lufs` and `target_lufs` are new; `speech_loudness_db`, `target_loudness_db`, `pitch_semitones` and `reverb_wet` stay on old takes as written and are no longer read or written once the client moves (step 6).
- Render cache: `<room>/renders/<key>.wav` + `.json` (above). Nothing else on disk changes.
- **Loader fix** (`rooms.load_persisted_rooms`): today any file whose version isn't exactly `STATE_VERSION` goes down the v1 path, where `_migrate_v1_takes` skips take keys like `"t44048"` and the save then writes a room without takes. The branch becomes an explicit check: version missing or 1 → v1 migration; 2 → load as is; greater than `STATE_VERSION` → the room is not loaded and the file is not touched (log line). This protects every future version bump.

## API and WebSocket

| Route | Body | Effect | Broadcast |
|---|---|---|---|
| `POST /api/rooms/{room}/lines/{line}/takes/{take}/render` | `{chain, client_id, until_s?}` | Renders through `render_take_cached` (foreground semaphore of 2). A request still queued when a newer one arrives from the same `client_id` for the same take returns `409 {"superseded": true}` without rendering. Also queues the take's preset renders in the background if not done this run. `503 {"effects_unavailable": true, "message"}` while effects aren't installed. No permission check (read-only; the premiere needs it). Returns `{url, key, duration, lufs?}`. | none |
| `GET /api/rooms/{room}/renders/{key}.wav` | | Range stream, long cache (keys are immutable). Key must match `[0-9a-f]{16}`; path guarded like `take_dir`. | |
| `PUT /api/rooms/{room}/lines/{line}/takes/{take}/chain` | `{user_id, chain \| null}` | Sets or clears the take's chain (`_require_line_actor`), re-matches level, `invalidate_exports()`. Returns `{take, line}`. | `take_params_updated {line_id, take_id}` |
| `PUT /api/rooms/{room}/voice` | `{user_id, scope: "character" \| "session", character?, chain \| null}` | Character scope: host or an actor assigned to the character (anyone when nobody is). Session scope: host (everyone in a solo room); also clears `voice.characters`. Clears the affected take chains, `invalidate_exports()`, then re-matches affected takes in a background job (`room.voice_job`); exports await it. | `voice_updated {scope, character}` |

- Upload (`POST …/takes`): the take copies the picked take's `chain`; the engine renders its resolved chain inside the request (needed for the matched level), then queues the four presets in the background (one background worker per engine, after foreground renders). If effects aren't installed, the take is saved and levelled on its raw audio, `loudness_lufs` is left out, and it is re-matched later (above). The booth sends no `pitch_semitones` or `reverb_wet`; a studio from before step 6 that still sends them gets a value that differs from the picked take's put on the new take's chain (`chain_with_legacy`), and the fields are stored only when sent.
- `update_take_params` accepts `offset_ms` and `gain_db` only (from step 6; before it, a `pitch_semitones` or `reverb_wet` key was translated onto the take's chain). The booth's effect controls edit the take's chain with `PUT …/chain`.
- State payload: `voice` plus `voice.presets` (`[{id, name, chain}]` from `vocal_chain.PRESETS`, so the client never hard-codes them), and takes carry `chain`. The on-wire version splits from the on-disk one: `rooms.CLIENT_STATE_VERSION = 3` is sent by `to_state_dict` from step 6, while `STATE_VERSION` (disk) stays 2. The client's `TAKE_STATE_VERSION` becomes 3 in the same commit; older tabs get the existing reload notice.

## Optimistic preview (studio)

`static/js/studio/voice.js`, pure and node-testable:

- `resolveChain(voice, character, take)`, `presetLabel(chain, presets)` ("Custom" when `preset` is null), `eqCurveDb(eq, freqs, sr)` (RBJ shelf/peak magnitudes, drawing only), `levelGain(db)`.
- `createRenderScheduler({debounceMs = 120, request, onReady, now, setTimer, clearTimer})`: `want(chain, {playheadS, takeDuration, playing})` bumps a sequence number and (re)starts the debounce; on fire it calls `request`. A response whose sequence isn't the latest is dropped, and a 409 is ignored. States: `current` → `waiting` (debounce) → `rendering` → `current`; the panel pulse shows in `waiting` and `rendering`; a 503 moves it to `unavailable`. Playhead first: when `playing` and `takeDuration > 4`, it first requests `until_s = playheadS + 2`, hands that to `onReady`, then requests the full render.

Booth (`static/js/studio/voice_rack.js`, `VoiceRackMethods` mixin):

- On line load, request the resolved chain's render; Preview and Takes → Play wait for it (button pulse), then play it. No browser effects remain. In `unavailable` they play the raw take, the effect controls are disabled and the panel shows the download message.
- Every control edit updates its UI at once, calls `want`, and persists with `PUT …/chain` after 400 ms of quiet and on release. Level only changes the `GainNode` and sends `update_take_params` as today.
- `AudioEngine.crossfadeTo(buffer, { atS })`: starts the new buffer at the current position in the take (both renders share the timeline), equal-power ramps over 30 ms, stops the old source. If a prefix render is about to run out (50 ms before its end) before the full one arrives, it crossfades back to the previous full render at that point; the sound is always a real render.
- Output meter: an `AnalyserNode` after the level gain.

## Export, render, premiere and project ZIP

- `Room.mix_takes()` adds `chain` (resolved, normalized) and `render_dir` to each entry. `_render_take` calls `render_take_cached` and multiplies by the clamped level; `apply_audio_effects` is deleted. The failure policy is unchanged (skip in the render, near-silent placeholder in the ZIP, logged). `EffectsUnavailable` fails the whole export with the plain download message.
- `render_dub_mix` / `export_dub_video` (export, download, premiere auto-render): `_mix_scene` + `master_stage`.
- Live premiere fallback (`screening.js`, before the exported video is ready): plays each picked take's render × level × presence, plus backing and originals as today. It has no master stage; the theater switches to the exported video as soon as it's ready, as today (decision 11).
- Project ZIP: per-line audio is the same render × level. Its stems carry no dialogue presence today, so the master gain is computed on `_mix_scene(..., presence_db=0)` (decision 24) and applied to Master_Vocal_Mix and every character stem, each then limited to −1 dBTP. The backing stem is unchanged. Manifest: top-level `"master": {"target_lufs": -16, "gain_db"}`, per line `chain` (resolved), and the old `pitch_semitones` / `reverb_wet` keys derived from it (0 when the node is off). The cue sheet's "DSP Tuning" line reads `Sound: Warm` or `Sound: Custom`.

## Existing data

On load, `rooms.load_persisted_rooms` runs `_migrate_legacy_sound(room)` when the file has no `voice` key (after the v1 → v2 step when needed), then saves:

- A take with `pitch_semitones` ≠ 0 or `reverb_wet` > 0.02 gets `chain = chain_from_legacy(pitch, reverb)`: Clean with Pitch on at that value and Reverb on at `mix = reverb_wet`, 1.5 s, 20 ms. Others get no chain and follow Clean, which is today's export sound.
- `gain_db` and every other field are unchanged, so levels stay where they were. `pitch_semitones` and `reverb_wet` stay in the file. Nothing is deleted.
- `voice` starts as `{"session": null, "characters": {}}`.
- Idempotent: a take that already has `chain` is skipped. A `pending_v1_takes` entry migrated on a later start goes through the same conversion. After a downgrade-and-return the conversion runs again (no `voice`); it only adds chains to takes without one, so the worst case is that a take whose chain was cleared by a character choice gets its old pitch/reverb back.

Old takes have no renders; they render on first use (the render route also queues their presets).

**Tests** (`tests/test_effects_rack.py`, no network, temp cache dir patched as in `test_take_model.py`): a PR #14-era `room_state.json` literal (version 2, no `voice`) with three takes (pitch −3 and reverb 0.4; reverb only; neither) loads with the expected chains and no chain on the third; legacy fields unchanged; saved file still `state_version: 2` with take keys in v2 form; a second load changes nothing; a version 1 room reaches the new layout in one load; a pending v1 take migrated later gets its chain; a file with `state_version: 99` is not loaded and is byte-identical afterwards.

Sound of migrated takes (in `tests/test_vocal_chain.py`): (a) the reverb part is exact: with the low cut off, `chain_from_legacy(0, 0.4)` matches `x + 0.4·0.7·conv(x, get_reverb_impulse(1.5))` within 1e-5; (b) the new low cut's magnitude is −3.0 ± 0.2 dB at 80 Hz, −8.5 ± 0.5 dB at 40 Hz and within 0.2 dB of 0 at 1 kHz; (c) on a 1 kHz burst-and-noise signal the whole migrated render is within −35 dB RMS of the old ffmpeg formula. With voice fundamentals (150 Hz) the waveform difference is about −20 dB, mostly phase from the gentler low cut; that is a listening check, not a test.

## Dependencies and packaging

- `requirements.txt`: `pedalboard==0.9.25` (GPLv3, numpy only, needs Python ≥ 3.10). Wheels exist for cp312 `win_amd64`, `macosx_11_0_arm64`, `macosx_10_14_x86_64` and cp311 `manylinux_2_28_x86_64` (CI). No other new dependency (decision 1).
- `setup_dubmate_win.bat` and `setup_dubmate_mac.sh` raise their minimum from Python 3.9 to 3.10 (their install hints already say 3.10+).
- No ship-list change (`dubmate/` ships whole). Both import-smoke steps in `release.yml` add `import pedalboard`, because the macOS staging `pip install` ends in `|| true` and would otherwise ship without it.
- In-place desktop updates replace only the Python and static files; the bundled runtime of an existing install has no pedalboard, and the updater that runs is the old one. So the engine heals itself: at startup, if `import pedalboard` fails and `DUBMATE_TOOLS_DIR` is set (desktop), a background thread runs `sys.executable -m pip install --no-input --no-deps --target <CACHE_DIR>/engine-packages/py3XY pedalboard==<pin from requirements.txt>` (timeout 300 s), adds that folder to `sys.path` and imports. Source installs get it from `update.bat` / `update.sh`, which already run `pip install -r requirements.txt`.
- Until it's ready (or when offline): recording, timing and Takes work; uploads are levelled on the raw take; Preview and Takes → Play play the raw take with the effect controls disabled and the message shown; renders return 503; exports wait up to the install's end, then fail with the plain message.

## Not in this PR

- VST hosting, comping, smart ducking.
- Reordering effects, more than one instance of an effect, saving your own presets, presets per pack.
- Effects on unrecorded lines (the original voice plays untouched).
- A master stage in the booth preview or the live-premiere fallback (decision 11); a final mix file inside the project ZIP; changing the ZIP's backing stem level.
- A stereo mix or stereo reverb.
- Re-matching levels of old takes on migration.
- Compensating pitch onset shift (decision 23).
- Permission checks on Level and timing (unchanged from the take model).

## Risks

- **Pitch sounds different from old exports.** Rubber Band replaces ffmpeg's resample-and-stretch. Same amount and length, different artifacts, and onsets move up to ~10 ms at ±5 st. Hands-on A/B on a tight sync point.
- **Low end of old takes.** Same 12 dB/octave slope, softer knee (−8.5 dB at 40 Hz instead of about −12) and different phase. Hands-on.
- **Render speed.** 0.11–0.14 s for 4 s through PitchShift on the dev machine. Slow laptops with long takes lean on playhead-first and the background preset renders. The scheduler drops stale requests on both sides.
- **In-place desktop update** needs the internet once for pedalboard (a 2.5 to 3.7 MB wheel). Offline, recording still works and effects/export say why. The pip call, numpy ABI and Windows `._pth` path rules are checked hands-on on both platforms.
- **Loudness jump on first export after the update.** Old exports were peak-limited only; new ones are −16 LUFS. Intended.
- **Encoded true peak.** −1 dBTP holds before encoding; AAC/MP3 may overshoot slightly. Measured hands-on.
- **Mono measurement.** Platforms that play a mono file as dual mono and meter it as stereo read about +3 LU (−13). We follow the brief: measure in the layout we mix and ship.
- **Disk.** Five renders per take; capped at 500 MB per room and removed with the room.
- **Windows file locks.** Handled by per-key locks, replace fallback and tolerant eviction (above); tested by patching `os.replace` / `os.remove` to raise `PermissionError`.
- **Browser resampling** on 48 kHz devices is the one remaining preview/export difference besides one 16-bit step. Not an effect; inaudible.
- **Character/every-line apply clears hand edits** on the affected takes (and, for every line, character sounds). Mitigated by the confirm text.
- **Downgrade** keeps takes (additive format) but loses `voice` defaults.
- **Concurrent edits** to one take's chain by two people: last write wins, as with the sliders today.

## Decided overnight, revisit

1. **Bends an owner instruction.** Loudness uses pyloudnorm's BS.1770 algorithm ported to numpy (MIT notice kept), not the pyloudnorm package, because pyloudnorm 0.2.0 requires scipy and the cleanup removed scipy on purpose (CHANGELOG "Smaller Install"; Calibrate Mic avoids noisereduce for the same reason). Alternative: add `pyloudnorm` and scipy (about 40 MB) and swap the function body; the tests stay.
2. **Bends an owner instruction.** Reverb keeps DubMate's own room impulse, convolved in numpy inside the engine, instead of a pedalboard plugin. It is still one engine-side implementation for preview and export, and it keeps old rooms' reverb identical. pedalboard's `Convolution` normalises impulses and `Reverb` is a different room sound.
3. Level is the take's `gain_db` after the chain, clamped −60…+24 dB as today, not a chain node, and has no Mix dial (as in Dubious: "gain_db, not a chain node").
4. Fixed effect order (low cut, gate, tone, de-ess, compress, pitch, reverb); every effect has on/off and Mix; Reverb's Mix is its amount.
5. Presets: Clean (today's export sound and the default), Warm, Radio, Monster. A preset is a whole chain; any edit shows Custom.
6. Resolution: take → character (`voice.characters`) → every line (`voice.session`) → Clean, most specific wins, each replacing the whole chain. Character above every-line because a whole-room sound is less specific than one character (Dubious has no every-line level). Use on every line clears take chains and character sounds after a confirm; Use on all of NAME's lines clears that character's take chains. Choosing Clean on a take stores it on the take.
7. Migration gives a take its own chain only when its pitch or reverb was set; levels and legacy fields are untouched; old takes are not re-levelled.
8. Low cut is two first-order high-passes. pedalboard's only second-order high-pass is `LadderFilter` (HPF12), a Moog-style filter with drive and resonance, which colours the sound; the two first-order filters give the same slope with a clean, softer knee.
9. Pitch now uses Rubber Band; old takes keep their pitch amount but not the old artifacts.
10. Master: −16 LUFS integrated, clamped ±24 dB, true-peak limiter at −1.5 plus a static trim that guarantees ≤ −1.0 dBTP measured at 4× oversampling before encoding; measured in mono.
11. **Bends an owner instruction (PRODUCT.md "What you hear while editing is what you export").** The booth preview and the live-premiere fallback play real renders at mix level without the master stage (one scene-wide gain and a limiter); the effects are identical, the overall loudness is not. The premiere switches to the mastered video when it's ready, as today. Alternative: compute the scene's master gain on each take change and apply it in the browser (more renders, no limiter in the booth).
12. **Reads an owner instruction narrowly.** The project ZIP has no single final mix, so its vocal and character stems carry the export's master gain and are each limited to −1 dBTP; the backing stem is unchanged.
13. In-place desktop updates install pedalboard once into the cache in the background; no launcher (Rust) change, because the old launcher runs the update.
14. Playhead-first applies only to takes over 4 s while previewing: render from the take's start to playhead + 2 s, then the rest.
15. Render cache lives in the room folder, capped at 500 MB, oldest first, never deleting a file touched in the last 10 minutes.
16. The Voice panel appears only on lines you can record that have a take; Use on every line is host only.
17. Pitch and Reverb move from the default view into the full rack (owner: presets and level by default).
18. Rendering needs no permission; changing a take's chain needs `_require_line_actor`; character and every-line changes are guarded as above.
19. A new take copies the picked take's own chain.
20. Decay keeps today's 0.2–4.0 s range; the impulse cap rises from 2.0 to 4.0 s (identical output up to 2.0 s).
21. When the original line can't be measured, the target is −21 LUFS.
22. pedalboard is pinned to 0.9.25 and its version is part of the render key; Python 3.10 becomes the minimum for source installs.
23. Pitch onset shift (up to ~10 ms at ±5 st, ~19 ms at ±12 st) is accepted, not compensated; tests pin it.
24. The project ZIP's master gain uses dialogue presence 0, matching its stems, which never carried presence.
25. `room_state.json` stays version 2 with additive fields, so older engines keep every take; the client wire version alone goes to 3. Newer-than-known files are left untouched instead of being treated as version 1.
26. Without pedalboard (offline after an in-place update), recording works, takes play raw with effect controls disabled and a message, and export fails with the plain message rather than exporting without effects.

## Implementation steps

Each step is one commit and leaves `python -m pytest tests` and the node tests green.

1. **Voice chain module and pedalboard.** `dubmate/vocal_chain.py` (schema, presets, normalize, resolution, legacy mapping, render with prefix, `available()`, desktop self-install); `get_reverb_impulse`/`_fft_convolve` moved in with callers and `test_audio_safety.py` updated; pedalboard in requirements, release smoke, setup scripts at 3.10; `tests/test_vocal_chain.py` and the resolution fixture.
2. **BS.1770 loudness and the master stage.** `integrated_lufs`, `true_peak_db`, `master_stage`, `_mix_scene`; render/export/ZIP mastered; line targets and auto gain in LUFS; limiter tests in `test_audio_safety.py` and `test_systematic.py` retargeted; `tests/test_loudness_master.py`.
3. **Exports render through the chain.** `render_take_cached` with the cache, locks and eviction; `_render_take` with the gain clamp; `apply_audio_effects` removed and its tests retargeted; upload levelled on the render (raw fallback); ZIP manifest and cue sheet; `tests/test_render_cache.py`.
4. **Chains in the room.** `voice` and take `chain`, loader version fix, migration, `mix_takes` resolution, `PUT …/chain`, `PUT /voice`, re-matching, legacy translation in `update_take_params`; `tests/test_effects_rack.py`.
5. **Render routes.** `POST …/render` with supersede and 503, `GET …/renders/{key}.wav`, background preset worker; tests in `tests/test_effects_rack.py`.
6. **Booth plays the engine's renders.** `voice.js`, `AudioEngine.crossfadeTo`, browser effects removed from the booth path, current sliders edit the chain, wire version 3; JSDOM tests.
7. **Premiere plays the engine's renders.** `screening.js` uses renders; remaining browser DSP code deleted; JSDOM test.
8. **Voice panel: presets first, full rack one click away.** Markup, `VoiceRackMethods`, disclosure rules, Tone curve, meter, Use on all lines / every line; JSDOM tests.
9. **Changelog and roadmap.** CHANGELOG `[Unreleased]`, ROADMAP feature 3 marked done.
