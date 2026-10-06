# Design: Calibrate Mic (room check that tunes noise cleanup)

Roadmap feature 4. Owner decisions: October 2026 interview (ROADMAP.md, Decisions: "Calibrate Mic is diagnose + tune", "DeepFilterNet ships with the desktop app"). Builds on PR #10 (gentler cleanup, settings-keyed cleaned takes), the take model (`take-model.md`) and recording timing (`recording-timing.md`). Branch `feat/calibrate-mic`. Revised after a claim audit (see "Revision notes" at the end).

## Where it stands before this PR

- `#modal-mic-calibration` exists in `static/index.html` and `booth.calibrateMicNoiseProfile` drives it, but nothing opens it: there is no `#btn-calibrate-mic`, `#btn-reset-noise-profile` or `#badge-noise-status` element. `AudioEngine.recordNoiseProfile` (1 s pre-roll + 3 s) is only used by that dead path.
- `POST /api/rooms/{room}/noise_profile` saves `<room dir>/noise_profile_<user_id>.wav` and returns a full-band RMS. `save_uploaded_take` and `toggle_take_noise_reduction` look that file up and pass it to `apply_noise_reduction`, which ignores it.
- The profile is room-scoped, but the host gets a new `user_id` with every room and `prune_sessions` deletes older room folders, so a host profile could never outlive a session anyway.
- "Reset" only flips `hasCustomNoiseProfile` in the browser.
- Cleanup today: DeepFilterNet `-D -a 30` at 48 kHz when `deep-filter` is found (Windows source installs get v0.5.6 from `scripts/download_tools.ps1`, which fixes the version in the URL but checks no SHA-256); otherwise ffmpeg `highpass=f=80,afftdn=nr=18.0:nf=-35:tn=1`. The desktop app ships no `deep-filter`, so desktop users always get the fallback.
- Cleaned files are `takes/<line_id>/<take_id>_denoised_<key>.wav`, `key = sha1(f"{NR_VERSION}:{NR_ATTENUATION_DB}:{engine}")[:8]` (`"2:30.0:dfn"` or `"2:30.0:fallback"`). A missing file for the current key is rebuilt on the next noise-reduction toggle (PR #10). `original_speed` goes through the same toggle function.

## What changes for the user

| Behaviour | Where | Disclosure level |
|---|---|---|
| A **Room** row under Timing: "Not checked yet" / "Quiet room. Cleanup is tuned to it." / "Some background noise. Cleanup is tuned to it." / "Noisy room. Cleanup is tuned to it." Button **Check your room** (**Check again** once checked). | Audio settings, devices step (also on first-run setup; works without a room) | One click away |
| Pressing it opens an inline panel: "Stay quiet for 3 seconds while DubMate listens to your room." **Start** / **Cancel**. While listening: "Listening… stay quiet." with a progress bar. | Same row | One click away |
| **Room report card**: a traffic light with one word (**Quiet** green, **Some noise** amber, **Noisy** red) and a sentence: "Your room is quiet. Good to record." / "Some background noise. Cleanup will handle it." / "Your room is noisy. Cleanup will help, but a quieter spot will sound better." The light's tooltip gives the number: "Background noise: −52 dB. Low rumble is removed automatically." (the rumble clause only when more than half the noise is below 80 Hz). | Same row | After a check |
| Advice lines under the light, only those that apply, in this order: "Mains hum at 50 Hz: check cables, USB hub or ground loop. Cleanup removes most of it." · "A steady whine, like a fan or a computer. Cleanup removes it; moving away from it helps too." · "Your mic hisses. Turn up the gain on the mic or interface, and turn down the level in your computer's sound settings." · "The noise kept changing. Check again in a quiet moment." | Card | Only when it happens |
| A check that can't be used saves nothing and says why: "Your mic sounds completely silent, so something is already removing noise. Turn off Windows mic enhancements, or noise removal in your mic's app, then check again." · "Something was very loud while DubMate listened. Check again in a quiet moment." | Card | Only when it happens |
| Optional **Check your loudest line** (secondary button on the card): "Say your loudest line now." 3 s recording. Result: "Good level." / "Turn your mic down by about 5 dB." / "Turn your mic up by about 4 dB." / "Your loudest line clips. Turn your mic down by about 7 dB." / "DubMate couldn't hear you. Try again, a bit louder." plus "Your voice is about 38 dB louder than the room." Nothing is stored. | Card | One click away |
| New takes are cleaned with settings tuned to the check (gentler in quiet rooms, stronger in noisy ones, hum and whine notched out). No new booth control; the noise-reduction rocker is unchanged. | Booth (invisible) | Default |
| **Refresh older takes**: "3 of your takes were cleaned before this check." with the button (tooltip: "Cleans them again with your latest room check. Your original recordings are kept."). Shown on the card after a check and in the Room row whenever the count is above 0 and the row isn't asking for a new check. Runs in the background; toast "Older takes refreshed." While it runs, rendering the video or saving the project waits: "Older takes are being refreshed. Try again in a moment." | Room row and card | Only when it happens |
| **Use standard cleanup** (link button in the row once checked; tooltip "Forget this room check. New takes get standard cleanup."). The row returns to "Not checked yet". Takes already cleaned keep their sound until the person presses **Refresh older takes**, which the row then offers. | Room row | One click away |
| Using a different microphone from the one that was checked: the row says "New microphone. Check your room so cleanup fits it." and new takes get standard cleanup until it is checked. No toast. | Room row | Only when it happens |
| Desktop builds clean with DeepFilterNet instead of the weaker fallback. | Everywhere | Default |

No on-screen text names DeepFilterNet, dBFS, spectra, gates or notches. "dB" appears only in level advice and the light's tooltip, where it is a number the user can compare, as the input meter already does.

**Guests.** A guest's browser keeps its check in `localStorage`, which is per origin, and a guest's origin is the quick-tunnel host that changes every time the host launches DubMate (`sidecars.rs`). So a guest's check lasts one host session; after the host restarts, the guest's row says "Not checked yet" and their new takes get standard cleanup until they check again. Their earlier takes keep the cleanup they were made with. No toast asks them, the same trade mic sync made (`recording-timing.md`, Risks). **Owner sign-off needed**, as for mic sync.

## Data shapes and on-disk layout

### Room profiles (engine)

Engine-wide, not per room: `<CACHE_DIR>/noise_profiles/<profile_id>.wav` (the room tone, mono 16-bit 44.1 kHz, first 0.3 s already dropped) and `<profile_id>.json` (stats). `prune_sessions` only touches `<CACHE_DIR>/rooms`, so profiles survive new rooms. `profile_id` = first 12 hex characters of `sha1(pcm bytes + device_label)`, validated as `^[0-9a-f]{12}$` everywhere it is accepted. At most 50 profiles are kept; saving the 51st deletes the oldest by `created_at`. Profiles are immutable; a new check makes a new id. Takes don't depend on a profile staying on disk (see "Takes"), so deleting or pruning one never changes a cleaned take.

```json
{
  "profile_id": "3fa9c01b7d2e", "version": 1, "created_at": 1790000000.0,
  "device_id": "<browser deviceId or ''>", "device_label": "Microphone (Yeti X)",
  "duration_sec": 3.0, "verdict": "ok",
  "speech_floor_db": -52.4, "full_band_db": -41.0, "rumble_share": 0.71,
  "hum_hz": 50, "tones_hz": [50.0, 150.0, 2412.5],
  "hiss_db": -2.1, "hiss": true, "stability_db": 3.2, "unstable": false,
  "suppressed": false, "clipped": false, "dc_offset": 0.0004,
  "cleanup": {"attenuation_db": 28, "notches_hz": [50.0, 150.0, 2412.5]}
}
```

Measurements (`audio_processor.analyse_room_tone(audio, sr)`, numpy only; dB values are dBFS of RMS re 1.0, like `noise_floor_db` today):

- `speech_floor_db`: RMS of the 100 Hz–8 kHz band (rfft of the whole clip, bins outside the band zeroed, Parseval). `verdict`: `good` below −60, `ok` −60 to −45, `noisy` above −45. Not full-band: most fan energy sits below 88 Hz and made full-band misleading.
- `rumble_share`: power below 80 Hz over total power. Informational only (the 60 Hz high-pass handles it).
- Tones: Welch PSD, `nfft = 32768` (1.35 Hz bins), Hann, 50 % overlap. A peak counts when it is more than 10 dB above the median of the bins within ±25 Hz (hum) or ±50 Hz (others), excluding ±3 Hz around it. Hum: harmonics 1–8 of 50 and of 60 Hz; `hum_hz` is the base with more harmonics found (tie: larger summed excess), else null. Other tones: local maxima in 100 Hz–8 kHz not within 3 Hz of a hum harmonic. `tones_hz` lists hum harmonics and other tones, strongest excess first.
- `hiss_db`: mean power per bin in 4–16 kHz over 300 Hz–2 kHz, in dB (white noise ≈ 0, pink ≈ −10). `hiss` when `hiss_db >= -3` and `verdict != "good"`.
- `stability_db`: p90 − p10 of 100 ms frame levels of the band-limited signal; `unstable` above 6 dB.
- `suppressed`: at least half the samples exactly 0, or full-band level below −90. `clipped`: 3 or more samples at |x| ≥ 0.999. `dc_offset`: the mean sample. A suppressed or clipped check returns its report with `profile_id: null` and nothing is saved.
- `cleanup` (`noise_cleanup_settings`): `attenuation_db = clamp(round(speech_floor_db + 80), 12, 40)`; `notches_hz` = the first 4 of `tones_hz`.

### Cleanup settings and the cleaned-file key

`settings = {"profile_id": str, "attenuation_db": int | float, "notches_hz": [float]}`, or `None` for standard cleanup. `noise_cleanup_settings(profile_id)` returns the stored `cleanup` plus the id, or `None` when the id is None, invalid or its files are gone.

`denoised_take_path(take_dir, stem, settings=None)`:
- `settings` None: `key_src = f"{NR_VERSION}:{NR_ATTENUATION_DB}:{engine}"`, byte-for-byte today's string, so every cleaned take on disk stays current;
- otherwise: `key_src += f":{profile_id}:{attenuation_db}:{','.join(f'{n:.1f}' for n in notches_hz)}"`.

The key is computed from the settings passed in (the take's own copy), never from whether the profile files still exist. `NR_VERSION` stays 2: the default chain doesn't change.

### Cleanup chain (`apply_noise_reduction(input_wav, output_wav, sr=SR, settings=None)`)

| | DeepFilterNet found | No DeepFilterNet |
|---|---|---|
| `settings` None | unchanged: resample to 48 kHz, `deep-filter -D -a 30` | unchanged: `highpass=f=80,afftdn=nr=18:nf=-35:tn=1` |
| `settings` given | resample to 48 kHz through `highpass=f=60` + `bandreject=f=<n>:width_type=q:width=30` per notch, then `deep-filter -D -a <attenuation_db>` (needs only the settings) | the same pre-filter at `sr`, then `spectral_gate(audio, profile_audio, sr)` (needs the profile WAV) |

If the gate needs a profile WAV that is gone, `apply_noise_reduction` returns without writing and the caller cleans with standard settings instead (see "Takes"). The parameters `noise_profile_wav` and `reduction_db` are removed (step 3): the first was never used, the second becomes `settings["attenuation_db"]`.

`spectral_gate` (numpy only, the stationary approach `noisereduce` uses; no scipy, no noisereduce): STFT `n_fft=2048`, hop 512, Hann. The profile (put through the same pre-filter) gives per-bin mean and std of dB magnitude; threshold = mean + 1.5 × std. The mask (signal dB above threshold) is smoothed with a separable triangular kernel over ±500 Hz and ±50 ms, then `gain = mask × 0.75 + (1 − 0.75)`, so noise-only bins drop by about 12 dB. Inverse STFT by windowed overlap-add with window-sum normalisation, trimmed to the input length. The existing "both failed, copy the input" safety net stays.

### Takes (room state, still `state_version: 2`)

New optional field `nr_settings` (the settings object above, or null): the cleanup this take is cleaned with, or would be when noise reduction is switched on. It is a copy, so the take keeps it after its profile is deleted or pruned, which is what ROADMAP means by "a cleaned take records the profile and settings it was made with". Set on upload from the form's `noise_profile_id` (via `noise_cleanup_settings`), kept by the toggle and by Original speed, changed only by Refresh. Missing reads as null (standard).

`save_uploaded_take(..., nr_settings=None)` and `toggle_take_noise_reduction(..., nr_settings=None)` replace their `user_id` parameter and return the `nr_settings` they actually used. They use the file for the take's key when it exists (no re-clean). When it is missing they clean with the take's settings; only when that needs the gate and the profile WAV is gone do they clean with standard settings and return `nr_settings: None`, which the route stores. That case needs all of: no DeepFilterNet, the cleaned file missing (noise reduction was off until now, or the engine changed), and the profile deleted.

Nothing on the wire is added: clients compare `take.nr_settings?.profile_id` with their current check to count older takes.

### Browser

`localStorage["dubmate_room_check"]` = one entry `{"profile_id": "3fa9c01b7d2e", "verdict": "ok", "device_label": "Microphone (Yeti X)", "device_id": "…", "measured_at": 1790000000000}`, read and written through `safeStorageGet/Set`. The current mic is chosen like mic sync's `deviceLabel` (selected device, else `default`, else the first; empty label falls back to `deviceId`); it matches the check when the label (or, with no labels, the deviceId) is equal. A mismatch means "New microphone" and no `noise_profile_id` on uploads. On opening Audio settings the entry is checked with `GET /api/noise_profiles/{id}`; a 404 drops it. A new saved check replaces the entry and the browser deletes the previous profile on the engine (best effort), so each person leaves at most one profile behind per host session. The loud-line check is never stored. No engine-config mirror for the host (mic sync has one); after a port change the host checks again.

## API and WebSocket

- `POST /api/noise_profiles` (multipart: `file` at most 2 MB, else 413; optional `device_id` and `device_label`, each at most 200 characters). Transcodes with `_transcode_upload`, drops the first 0.3 s, needs at least 2.5 s left and at most 10 s, else 400 "That was too short. Try again." Returns `{"profile_id": str | null, "report": stats}`. Not room-scoped, so it works before joining a room; guests reach it through the tunnel like every other route.
- `GET /api/noise_profiles/{profile_id}` returns the stats, or 404. `DELETE /api/noise_profiles/{profile_id}` removes the WAV and JSON and returns `{"status": "ok", "deleted": bool}`; a missing profile gives `deleted: false` (idempotent). A malformed id gives 400.
- Removed: `POST /api/rooms/{room}/noise_profile`, `audio_processor.save_user_noise_profile` and `get_user_noise_profile_path` (nothing reachable calls them).
- `POST /api/rooms/{room}/lines/{line}/takes`: new optional form field `noise_profile_id` (`""` = none). An invalid or unknown id means standard cleanup, never an error. The take stores `nr_settings`.
- `POST …/takes/{take}/noise_reduction` and `POST …/original_speed`: unchanged bodies; both pass `take.get("nr_settings")` and store the returned `nr_settings`.
- New `POST /api/rooms/{room}/cleanup/refresh`, body `{"user_id", "noise_profile_id": str | null}`. 409 "A video is rendering. Refresh older takes when it's done." while any `export_status` is `processing`. For every take in the room with `take.user_id == user_id`, it sets `nr_settings` to `noise_cleanup_settings(id)` (null when unknown). It queues the ones with noise reduction on whose cleaned file for the new settings doesn't exist, and returns `{"status": "ok", "refreshing": n}` at once. A background task re-cleans them one at a time, each under `room.processing_lock`, through `toggle_take_noise_reduction(enable=True)` at the take's stretch. Raw files are never touched; old cleaned files go through `_remove_old_denoised_takes`. Each take updates the same fields the toggle route does (`audio_version`, peaks, duration, auto-gain re-match) and broadcasts `take_params_updated {line_id, take_id, url, noise_reduction}`. Timing fields are not recomputed, as with the toggle. A take deleted meanwhile is skipped. At the end the task calls `invalidate_exports()` and broadcasts `cleanup_refreshed {user_id, count}`. A second request for the same user while one runs returns the running count and starts nothing (`room.cleanup_refreshing: set` of user ids).
- **No render during a refresh.** Renders don't take `processing_lock`, so a render started mid-refresh could finish "ready" with a mix of old and new audio. While `room.cleanup_refreshing` is non-empty, `POST …/export`, the dub download and the project ZIP return 409 "Older takes are being refreshed. Try again in a moment."; `launch_premiere` waits for the refresh task (`room.cleanup_refresh_task`) before it renders.
- WebSocket: one new server message, `cleanup_refreshed`. No client-to-server change.

## Existing data

- **Cleaned takes**: with `settings` None the key string is unchanged, so takes cleaned under PR #10 stay current and nothing is rebuilt on load. Takes without `nr_settings` read as null (standard).
- **Desktop installs** switch engine from `fallback` to `dfn` once DeepFilterNet ships. As in PR #10, their cleaned takes are rebuilt lazily on the next toggle or Original speed; nothing is rebuilt automatically. Refresh is not offered for an engine change.
- **Old room-scoped profiles** (`<room dir>/noise_profile_<user>.wav`): never used for cleaning, and without stats or a device. They are not migrated, not read and not deleted by this PR (room pruning removes them with their room, as before).
- Tests (`tests/test_room_check.py`, step 4):
  - the default key equals the hardcoded PR #10 formula for both engines;
  - a PR #14-era `room_state.json` literal (no `nr_settings`) loads, saves back with no `nr_settings` added, and a toggle on one of its takes reuses the existing default-key cleaned file (`apply_noise_reduction` not called);
  - a room folder holding `noise_profile_u1.wav` loads and the file is byte-identical afterwards.

## Export, render, premiere and project ZIP

No change to what they read. `render_dub_mix`, `export_dub_video`, premiere, screening and `build_project_zip` read each take's active WAV, which upload, toggle and Refresh write. Refresh calls `invalidate_exports()`, and renders are refused (or wait, for premiere) while it runs. Profiles are engine data and never go into a project ZIP. The manifest copies a whitelist of fields and is unchanged; `nr_settings` stays in room state only.

## Not in this PR

- Using the check while recording (live metering against it) or blocking recording in a noisy room.
- Storing or applying the loud-line result; automatic gain changes.
- Re-aligning takes after Refresh (timing fields stay, as with the toggle).
- Keeping a guest's check across host sessions; an engine-config mirror for the host; one check per microphone (only the latest check is remembered).
- A toast when the microphone changes.
- Picking a check per take or per line; sharing checks between people or computers.
- Offering Refresh after an engine change (lazy rebuild, as PR #10).
- DeepFilterNet on macOS source installs (`setup_dubmate_mac.sh`) and Linux.
- A setting to turn tuning off other than **Use standard cleanup**.
- Showing DC offset (kept in the stats only; the high-pass removes it).
- Fixing the existing toggle-versus-render race (a render started during one toggle can include the old audio); Refresh doesn't widen it.

## Risks

- **Thresholds come from synthetic tests.** Real rooms, Opus-coded browser audio and AGC may move the 10 dB tone rule, the −3 dB hiss rule or the 6 dB stability rule. A false hum or tone only adds a narrow notch (Q 30); a false hiss line is advice only. Hands-on checks cover it.
- **Only 0.3 s is dropped**, where the old dead code used a 1 s pre-roll for AGC settling. If browser AGC is still ramping, the stability rule flags "The noise kept changing". Not measured yet; hands-on check below.
- **The OS can suppress noise without producing exact silence** (Krisp, NVIDIA Broadcast, Voice Isolation). Those rooms read as "Quiet" and get gentle cleanup, which is the right result for already-clean audio.
- **Opus coding of the browser recording** shapes the noise floor above about 12 kHz; the hiss band stops at 16 kHz and is only used for advice.
- **The gate fallback is weaker than DeepFilterNet** and can leave musical noise. The 0.75 reduction and mask smoothing keep it mild. Desktop builds use DeepFilterNet.
- **Installer size** grows by about 27 MB (Windows) and 28 to 30 MB per macOS architecture (upstream asset sizes; the installer compresses somewhat).
- **DeepFilterNet 0.5.6 is from 2023** (the latest release). The binary is pinned by SHA-256, so an upstream change can't slip in. The macOS binaries are unsigned upstream and get signed with the app like the other sidecars. macOS staging can't be run from the Windows dev machine; it is checked by a static test here and by hand on a Mac.
- **The model is inside the binary.** This run's rules say model weights are downloaded at runtime, not bundled; ROADMAP doesn't set that rule (it lists "never download model weights" as not adopted). The official `deep-filter` binary embeds its model and can't be split, and the owner decided DeepFilterNet ships with the desktop app, so this is the one bundled model. Owner to confirm.
- **Profile routes reach the tunnel.** Anyone in a room could upload checks (capped at 50, 2 MB each, oldest pruned) or delete one whose 12-hex id they know. Ids are never broadcast, and deleting one changes no take.
- **Refresh trusts `user_id` from the body**, like the toggle route (which checks no actor at all): a guest could move another person's takes to a different check or to standard cleanup. Raw takes are untouched and Refresh can be run again. Owner to confirm this is acceptable.
- **Refresh time** per take is one cleanup run; not measured on the target CPU (hands-on). A take uploaded meanwhile waits for at most one re-clean, and renders wait for the whole refresh.

## Hands-on checks

Automated tests use synthetic room tone, stubbed audio and a faked `deep-filter`. These need real rooms and builds:

- Check a quiet room, a room with a fan or laptop running, and one with a phone playing pink noise. Compare the light with what you hear.
- Plug the mic into a laptop on its charger, or a USB hub with a known ground loop, and confirm the 50 Hz line shows and the hum is gone from a take.
- Turn on Windows mic enhancements (or Voice Isolation on a Mac, or NVIDIA Broadcast) and see what the check says.
- Record 3.3 s in Chrome with AGC on and compare the level of the first 0.3 s, 0.3 to 1.0 s and the rest; if 0.3 to 1.0 s still moves, raise the drop.
- Record the same line before and after a check in a noisy room. Listen for breaths and quiet endings with DeepFilterNet at the tuned strength.
- Loud-line check: shout a line and follow the advice. Confirm the next shout peaks between −10 and −6 on the input meter.
- Time `deep-filter -D -a 30` on a 5 s and a 15 s take on the target CPU.
- Windows desktop build: confirm `deep-filter.exe` sits next to `DubMate.exe` and the engine log shows DeepFilterNet in use. Same on a macOS build (arm64 and x86_64), also checking Gatekeeper doesn't block it.
- **Refresh older takes** on a room with about 20 takes: the booth stays responsive, rendering is refused until it ends, and the dub plays the refreshed audio afterwards.
- Guest: check the room as a guest, restart the host, rejoin and confirm the row says "Not checked yet" and old takes still sound the same.

## Decided overnight, revisit

1. Checks are stored engine-wide by content id, not per room or per `user_id`, because the host's id changes every room and old rooms are pruned.
2. The browser remembers one check (the latest) with its microphone label and deviceId. A guest's check lasts one host session, because `localStorage` is per origin and the tunnel origin changes each launch; no engine mirror, no toast. Owner sign-off needed, as for mic sync.
3. A take stores a copy of its cleanup settings (`nr_settings`). Toggling and Original speed reuse it and never change it; deleting or pruning a profile never changes a take. Only a new take or **Refresh older takes** moves takes to the latest check. Refresh is offered, never automatic.
4. **Use standard cleanup** deletes the engine copy right away. Takes keep their tuned cleanup until Refresh. The one exception is a missing cleaned file on an install without DeepFilterNet, which then gets standard cleanup.
5. Silent or clipped checks save nothing. A changing-noise check is saved, with the advice to check again.
6. `NR_VERSION` stays 2; the standard chain and key are unchanged.
7. The loud-line check runs in the browser only. Its "Good" range is −12 to −4 dB peak, advice aims for −8, and an "up" suggestion never lands a peak above −6.
8. Rumble appears only in the tooltip, and DC offset only in the stats (the brief lists both; neither needs an action).
9. Thresholds as specified in the brief; the rest chosen here: tones more than 10 dB over the local median; hiss at ≥ −3 dB relative to mids and only in a room that isn't Good; changing noise above 6 dB p90−p10; notches Q 30 for hum and other steady tones (the brief asks for hum and whine; ROADMAP only names hum); at most 50 stored checks.
10. The dead calibration modal and its booth code are removed; `AudioEngine.recordNoiseProfile` becomes a plain clip recorder. The check lives inline in Audio settings, like **Sync your mic**.
11. Old room-scoped profile WAVs are left alone, not migrated.
12. DeepFilterNet 0.5.6 is pinned with a SHA-256 for the desktop build, and the bundled binary includes its model (see Risks). `download_tools.ps1` already fixes v0.5.6 in its URL; it gets the same SHA-256 check.
13. Refresh re-cleans in a background task, one take at a time, doesn't re-align timing, and blocks renders while it runs; it refuses to start during a render.
14. Refresh trusts the body's `user_id`, as the toggle route does.
15. Scope is larger than ROADMAP's **M**. The loud-line check (step 7) and DeepFilterNet bundling (step 8) are separable if the owner wants a smaller PR.
16. ROADMAP lists features in build order and feature 3 (Effects rack) isn't done. This one was scheduled first; owner to confirm the order.

## Implementation steps

Each step is one commit and keeps `python run_all_tests.py` green.

1. **Room tone analysis and the profile store.** `analyse_room_tone`, `noise_cleanup_settings`, profile save/load/delete with pruning; synthetic tests. No callers yet.
2. **Cleanup chain driven by settings.** Numpy `spectral_gate`, the pre-filter, `settings=` on `apply_noise_reduction` (added; old parameters still work); tests. Existing tests untouched.
3. **Settings on takes and the cleaned-file key.** `denoised_take_path(settings)`, `nr_settings` replaces `user_id` in `save_uploaded_take` / `toggle_take_noise_reduction`, routes pass the take's copy, `noise_profile_wav`/`reduction_db` removed; the existing tests that use them are rewritten in the same commit.
4. **Profile API and upload wiring.** `/api/noise_profiles` routes, upload `noise_profile_id`, the old route and helpers removed with their tests replaced; old-data tests.
5. **Refresh older takes (engine).** Route, background re-clean, render guards, `cleanup_refreshed`; tests.
6. **Room row, check and report card (studio).** Storage, card model, the row and the check, `noise_profile_id` on uploads, dead modal removed; node and JSDOM tests.
7. **Loudest line, Use standard cleanup and Refresh older takes (studio).** JSDOM tests.
8. **DeepFilterNet in the desktop app.** Pinned and checksummed staging for Windows x64 and macOS arm64/x86_64, `externalBin`, licence, `download_tools.ps1` checksum, release guard test.
9. **Changelog and roadmap.**

## Revision notes

Changed after the claim audit: steps 2 and 3 now name the existing tests they change, and step 2 is additive; takes store a copy of their settings so deleting or pruning a profile can't re-clean a take through a toggle or Original speed; the guest limitation is stated and needs sign-off; the browser keeps one check instead of a per-mic map, and the mic-switch toast is dropped; the computed `cleanup_current` field is dropped (it ran engine detection per take on the event loop); renders are blocked during Refresh; the "model weights" rule is attributed to this run's rules, not ROADMAP; `download_tools.ps1` already pins the version and only lacks a checksum; the unmeasured timing and AGC claims moved to hands-on checks.
