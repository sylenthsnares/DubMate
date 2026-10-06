# Pack Builder upgrades: stem preview, touch and pen, speaker detection, non-verbal lines

Roadmap feature 5. Almost everything lives in the Pack Builder: `static/builder.html`,
`static/js/pack_builder.js`, `static/css/builder.css`, `dubmate/builder_api.py`,
`pack_builder.py`, `requirements_builder.txt`. The studio, rooms, render and export code and
the Tauri shell are not touched.

Revised after a claim audit: model location anchor, existing desktop installs, play() fallback,
zero speaker turns, pipeline order, completion message, tests, package pin and size.

## What the user sees

| Change | Where | Disclosure level |
|---|---|---|
| **Voices only / Full audio** now changes what you hear, not only the waveform. "Voices only" (the default, as today) plays the separated voice track in sync with the muted video; "Full audio" plays the video's own sound. | Existing toggle in the editor's transport deck. Tooltip: "Hear and see voices only, or the full audio". Toast on switch: "Playing voices only" / "Playing full audio". | 1 (visible control, unchanged place) |
| When voices-only playback can't run (voices weren't separated, the track can't load, or the browser blocks it), the editor switches to full audio and says so. | Toast: "Voices-only playback isn't available, so you're hearing the full audio." | 1, shown only when it applies |
| **Touch and pen** work on the timeline: drag a line, drag its edges, drag the empty timeline to scroll, tap to move the playhead, drag the splitter to resize. Mouse behaves exactly as before. | Timeline | 0 (no control) |
| **Detecting who speaks**: lines are split between characters by voice ("Speaker 1", "Speaker 2", ...), instead of alternating on pauses. Rough is fine: the existing character menu on each line fixes mistakes. | New processing stage "Detect who speaks" (desc: "Gives each voice its own character"). Progress "Detecting who speaks"; first time only "Downloading speaker detection (about 35 MB, first time only)", or "about 55 MB" when the desktop app also has to fetch the detector itself. | 0 (automatic) |
| If speaker detection is not installed, can't be downloaded, finds no voices or fails, speakers are guessed from pauses as today, and the editor says so. | One-line notice above the line list (`#editor-notice`), e.g. "Speaker detection isn't installed, so speakers were guessed from pauses. Check who says each line." | 1, shown only when it applies |
| **Non-verbal lines**: grunts, efforts, screams and laughs that the transcript skipped become lines to record. They have no text. | Line card shows a "No words" badge (tooltip: "A grunt, laugh or other sound without words. Record it like any other line."). Text box placeholder: "No words. Type a cue like (laughs) if you want." Timeline label: `[Speaker 1] (no words)`. | 1 badge, 2 tooltip |
| **Result summary** when the editor opens. | Toast: "Found 14 lines, 2 without words" (or "Found 14 lines"). The progress message keeps the same text, but the editor replaces it within 600 ms, so the toast is what people actually see. | 1 |

Copy follows PRODUCT.md: no model or library names on screen.

The server's `warning` field already carried the "basic filter was used" notice, but the
editor never showed it. The new `#editor-notice` shows every `warning`, so that notice now
appears too. This is intended, because it is the same field.

## Data shapes and on-disk layout

**Builder segment** (in memory in `BuildProgress.segments`, sent over SSE, `GET/PUT /segments`, compile payload):

```json
{"start": 5.02, "end": 5.6, "text": "", "character": "Speaker 2", "nonverbal": true}
```

`nonverbal` is optional. It appears only when true and marks a line found from voice activity
rather than the transcript. `PUT /segments` keeps it. Old clients that never send it keep
working unchanged.

**Builder session** (in memory): new key `session["voices_separated"]` (bool), true only when
real separation ran. The basic-filter fallback writes a copy of the full mix as
`stems/vocals.wav` (`pack_builder.py`, `separate_audio_stems`), so that file is never served as
"voices only".

**Packs: no format change.** A non-verbal line is written like any line with an empty caption:
the slice `NN_Speaker2_5-020.wav`, the `_captions.json` value `"[Speaker 2]"`, and `dub_subs.txt`
`00.05-00.05: [Speaker 2] `. `pack_loader.load_pack` already reads that as caption `""`. The studio
already shows "(Speaker 2, no subtitle)" for it. The `nonverbal` flag is not written to the pack.

**Builder session folder** (unchanged): `<cache>/builder/<session>/full_audio.wav`,
`stems/vocals.wav`, `stems/backing.wav`, `slices/`.

**Pack Builder add-on folder.** The engine finds it the way Tauri hands it over, not from
`get_install_root()` (which differs from Tauri's root on macOS, where the add-on sits in
`Contents/MacOS/ai-packages` and the engine in `Contents/Resources`):
`_addon_dir()` = the first `sys.path` entry whose basename is `ai-packages` (case-insensitive)
and that contains `.install-complete`. Tauri puts that folder on PYTHONPATH and
`ensure_ai_packages_on_path()` adds it on Windows, so this is the folder "Remove Pack
Builder" deletes on every platform. `None` for source installs.

**Speaker models (new, downloaded at runtime, never bundled):**

- Desktop: `<add-on folder>/dubmate-models/speakers/`, so "Remove Pack Builder" deletes it too.
  The hyphenated name can't be imported as a Python package.
- Source installs (no add-on folder): `<cache>/models/speakers/`.
- Files:
  - `pyannote-segmentation-3-0.onnx`, plus its `pyannote-segmentation-3-0.LICENSE`.
  - `campplus-sv-zh-en-16k-common-advanced.onnx`.
- Each download is pinned and checksummed. It is written to a `.part` file, checked with
  SHA-256, then moved into place with `os.replace`. A checksum mismatch deletes the `.part` file.

| Item | Source | SHA-256 | Size | Licence |
|---|---|---|---|---|
| Speaker segmentation (pyannote segmentation-3.0, ONNX export) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`. Only members `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` and `.../LICENSE` are read. | archive `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488`; `model.onnx` `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079` | 7.0 MB archive | MIT (CNRS); LICENSE file ships in the archive |
| Speaker embedding (3D-Speaker CAM++, zh+en, 16 kHz) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` ("recongition" is the real tag name) | `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2` | 28.3 MB | Apache-2.0 (ModelScope card `iic/speech_campplus_sv_zh_en_16k-common_advanced`; 3D-Speaker repo) |
| `sherpa-onnx==1.13.8` (pulls `sherpa-onnx-core==1.13.8`), in `requirements_builder.txt` | PyPI, CPU wheels for Windows, macOS and Linux | — (version pin) | about 19 MB download, 51 MB installed | Apache-2.0 |

MIT and Apache-2.0 are both GPLv3-compatible. No Hugging Face token is involved. Checksums
computed from the files on 2026-10-06; sherpa-onnx 1.13.8 accepted the exact config below on
Python 3.12 / Windows (`pip --target`). The licences are also listed in README "Licensing".

`requirements_builder.txt` is already in every ship list (release workflow, `stage-sidecars`),
`update.bat`/`update.sh` and `setup_dubmate_mac.sh`, so no packaging list changes.

## API, SSE and WebSocket changes

- **Restored:** `GET /api/builder/{session_id}/audio/{track}`. Only `track == "vocals"` is
  served, and only when `session["voices_separated"]` is true. The path is always
  `common.safe_join(session["folder"], "stems", "vocals.wav")`. The response is
  `common.range_stream_file(..., media_type="audio/wav", cache_control="no-cache")` (200, or
  206 with Range). Otherwise 404 "This audio isn't ready yet." (unknown session, stem missing,
  basic filter used, any other track). Full audio comes from the video itself.
- **`PUT /api/builder/{session_id}/segments`** keeps `nonverbal: true` on a segment that has it.
- **SSE `/progress` and `/status`:**
  - New `status: "detecting_speakers"` with `stage: "speakers"` (progress 0.88 to 0.98).
  - `warning` can now hold more than one sentence: the separation notice and the speaker
    notice, joined with a space.
  - `segments[]` can contain `nonverbal`.
- **WebSocket:** no change.

## How it works (engine)

**Pipeline order** in `builder_api._run_builder_pipeline_sync`: extract audio → separate →
transcribe (or take subtitles) → **add non-verbal lines** → **detect speakers** →
`assign_speakers_to_segments`. Non-verbal lines run first so they get a speaker too.

**Non-verbal lines** (`pack_builder.find_nonverbal_segments(samples, sr, transcribed)` plus a
file wrapper `add_nonverbal_segments(segments, vocals_wav, duration)`):

1. Read the voice stem with `audio_processor.read_wav_mono(path, sr=16000)`.
2. Compute the RMS level of each 20 ms frame in dBFS.
3. Work out three levels:
   - noise floor: the 20th percentile of frame levels;
   - dialogue level: the 75th percentile of frames inside the transcribed lines, or the 99th
     percentile of all frames when there are none;
   - frame threshold: `max(floor + 15 dB, dialogue − 30 dB)`.
4. If `dialogue − floor < 20 dB`, the stem is too noisy or too quiet to judge, so return nothing.
5. Merge active frames whose gaps are under 0.25 s into regions.
6. Keep a region only if all of these hold:
   - it lasts 0.3 to 8 s;
   - its loudest frame is within 10 dB of the dialogue level (foreground, not walla or breaths);
   - it is at least 0.2 s away from every transcribed line.
7. Pad kept regions by 0.08 s, clamped to the clip and to the neighbouring lines.

All thresholds are module constants in one block (`NONVERBAL_*`). The pipeline runs this only
when (a) the lines came from Whisper (not subtitles), and (b) `voices_separated` is true.
Any exception inside it is logged and the lines are kept as they were.

**Speaker detection** (`pack_builder.detect_speaker_turns(vocals_wav, on_progress=None) -> (turns | None, notice)`):

1. `import sherpa_onnx`. On ImportError:
   - Desktop (`_addon_dir()` is not None): `_install_speaker_package(addon)` runs
     `sys.executable -m pip install --no-input --no-deps --target <addon> sherpa-onnx==1.13.8 sherpa-onnx-core==1.13.8`
     (`subprocess.run`, 300 s timeout, hidden console on Windows), then
     `importlib.invalidate_caches()` and imports again. No `--upgrade`, so existing folders
     in the add-on (such as `bin/`) are left alone. This is how installs made before this
     release get speaker detection without the 2 GB Pack Builder download.
   - If that fails, or on a source install: `(None, "Speaker detection isn't installed, so speakers were guessed from pauses. Check who says each line.")`.
     Source installs get the package from `update.bat`/`update.sh`.
2. `_ensure_speaker_models()` downloads any missing files under a module lock. It uses
   `urllib.request.urlopen` with a 60 s timeout. On failure it returns
   `(None, "Couldn't download speaker detection, ...")`, and the next build tries again.
3. Build `sherpa_onnx.OfflineSpeakerDiarization` with:
   - pyannote segmentation, `window_shift_ratio=0.1`;
   - `SpeakerEmbeddingExtractorConfig(model=...)`;
   - `FastClusteringConfig(num_clusters=-1, threshold=SPEAKER_CLUSTER_THRESHOLD=0.5)`;
   - `min_duration_on=0.3`, `min_duration_off=0.5`.
4. Feed it 16 kHz mono float32 from the voice stem. Its progress callback maps to 0.90–0.98.
5. Return the result as `[(start, end, speaker_id), ...]`.
   - **Zero turns** (sherpa-onnx logs "No speakers found" and returns an empty result rather
     than raising): return `(None, "Speaker detection couldn't tell the voices apart, so speakers were guessed from pauses. Check who says each line.")`.
   - Any exception: `(None, "Speaker detection couldn't run, so speakers were guessed from pauses. ...")`.

`assign_speakers_to_segments(segments, turns=None)` behaves as follows:

- If the subtitles named characters, nothing changes.
- With a non-empty `turns`:
  - Each segment takes the speaker with the largest time overlap.
  - With no overlap, it takes the nearest turn within 1 s, or else the previous line's
    speaker, or else the speaker of the nearest turn at any distance (so the first line is
    always defined).
  - IDs become "Speaker 1..N" in order of first appearance.
- With `turns` None or empty: today's gap heuristic, unchanged.

The pipeline only calls `detect_speaker_turns` when no names were given, so subtitles with
names never trigger a download. `sherpa_onnx` is imported inside the function only, never at
module scope (guarded by `HEAVY_MODULES`).

**Stem preview** (`pack_builder.js`):

- A hidden `<audio id="editor-stem-audio" preload="auto">` sits next to the video. The video
  is the clock.
- In vocals mode the video is muted. `playMedia()` and `pauseMedia()` start and stop both
  elements in the same user-gesture call stack, which WebKit's autoplay rules require. Every
  current `editorVideo.play()` / `.pause()` call site (today around lines 1599, 1601, 1739,
  1743, 1874) goes through them.
- `seeking`, `ratechange`, `pause` and `ended` on the video are mirrored to the audio. The rAF
  playhead loop re-syncs the audio when drift exceeds 0.1 s.
- In full mode the video is unmuted and the audio paused.
- **Fallback to full audio** (`fallbackToFullAudio()`, once per session) runs when either:
  - the audio element fires `error` (including the 404 when voices weren't separated), or
  - the promise from `audio.play()` rejects (autoplay block, `NotAllowedError`, which fires
    no `error` event). The video keeps playing, unmuted.
  It sets the toggle to "Full audio", redraws the full waveform and shows the toast
  "Voices-only playback isn't available, so you're hearing the full audio."

**Pointer Events** (`pack_builder.js`, `builder.css`):

- Every timeline `mousedown`/`mousemove`/`mouseup` becomes `pointerdown`/`pointermove`/`pointerup`.
  `pointercancel` ends a drag the way `pointerup` does, but never seeks.
- Pointer capture goes on stable elements that aren't re-rendered: `timelineScrollWrap` for
  pan, seek and line drags, and the splitter handle for resizing. The block element is not
  used because `renderTimelineSegments()` replaces the blocks mid-drag.
- `if (e.isPrimary === false) return;` ignores second fingers.
- Mouse buttons are not filtered, so mouse behaviour stays identical.
- `touch-action: none` on `.timeline-canvas-scroll-container`, `.builder-segment-block` and
  `.builder-segment-handle`. The splitter already has it. The scroll container is
  `overflow-y: hidden`, so no vertical scrolling is lost.
- Under `@media (pointer: coarse)` the handles grow from 8 px to 16 px, and the selected
  block's delete button stays visible (it already does).

## Export, render and project ZIP

- **Unchanged.** Non-verbal lines are ordinary lines once the pack is built. They are sliced
  by `slice_audio_lines`, recorded in the booth, mixed by `render_dub_mix`, and listed in the
  project ZIP's `Timeline_Cues.txt` with `Dialogue : ""`. Take-model line IDs (`t{start_ms}`)
  are unaffected.
- Speaker names land in filenames and `_captions.json` exactly as hand-typed names do today.
- Stem preview and pointer input are editor-only.

## Migration

There is no pack or session format change:

- Packs are byte-compatible.
- Builder sessions are in memory and expire after 2 h.
- The model folder is new; nothing is moved or deleted.
- Existing desktop Pack Builder installs are topped up in place (one pinned package added to
  the add-on folder on first use). Nothing already there is replaced or deleted.

Tests guarding this:

- A pack assembled with a non-verbal, empty-caption line round-trips through `load_pack` with
  `caption == ""`, the right character and the right timing.
- `PUT /segments` without `nonverbal` returns segments without the key, as it does today.
- The top-up builds exactly the pip command above (no `--upgrade`, `--no-deps`, target is the
  add-on folder) against a fake add-on folder with a stubbed `subprocess.run`, and is never
  attempted on a source install.

## Tests (no network, no real models)

- Python, `tests/test_pack_builder.py` (run by `tests/run_all_tests.py`):
  - The audio route (200, Range 206, 404 cases, `safe_join` traversal).
  - `find_nonverbal_segments` on synthetic numpy signals (bursts, walla-level noise, breaths,
    long tones).
  - `_run_builder_pipeline_sync` driven directly: a fake session in `BUILDER_SESSIONS`, with
    `extract_audio_from_video`, `separate_audio_stems`, `transcribe_audio`,
    `add_nonverbal_segments` and `detect_speaker_turns` monkeypatched. Asserts order,
    `voices_separated`, warnings and the final segments.
  - Speaker detection with a fake `sherpa_onnx` module injected into `sys.modules`, and
    `urllib.request.urlopen` and `subprocess.run` stubbed. Covers: model download with a good
    and a bad checksum, ImportError on source and desktop, `[]` turns, exceptions, overlap
    mapping and the first-line case.
- `tests/test_performance_guards.py`: `"sherpa_onnx"` added to `HEAVY_MODULES`.
- JavaScript: a new jsdom suite `tests/test_builder_editor.js` loads `static/builder.html` and
  `pack_builder.js` through `tests/helpers/studio_dom.js` (given an optional entry file). It
  stubs `fetch`, `EventSource`, `HTMLMediaElement.prototype.play/pause` and
  `Element.prototype.setPointerCapture`, and dispatches pointer events as `MouseEvent`s with
  `pointerId`, `pointerType` and `isPrimary` defined (jsdom 25 has no `PointerEvent`). It
  covers stem playback and fallback, pointer drags, the badge, the notice and the toast.

## Not done

- Subtitle-to-line matching, MDX models and faster-whisper.
- Non-verbal detection on subtitle-sourced lines (see Decided overnight 1).
- A setting to turn either detector off. To undo a result, delete the line or change the speaker.
- Choosing the number of speakers.
- Studio prompter wording for lines without text.
- Pinch-zoom on the timeline.
- Transcoding the stem to a smaller format for preview.
- A general "update Pack Builder's packages" mechanism in the launcher. Only the one pinned
  package is topped up, by the engine.
- Running speaker detection in a separate process (only if the macOS check below fails).

## Risks

- **Torch and onnxruntime in one process.** On macOS a duplicate OpenMP runtime can abort the
  engine, and a fallback can't catch that. Hands-on check 1. If it aborts, the follow-up is to
  run `detect_speaker_turns` in a child Python process; that is not in this PR.
- **Engine-side pip top-up.** It writes into the add-on folder from the running engine. If pip
  is missing from the runtime, the folder is read-only, or PyPI is unreachable, the user gets
  the "isn't installed" notice and the next build tries again. Hands-on check 4.
- **Embedded Windows Python** (`._pth`) must load the sherpa-onnx-core DLLs from the add-on
  folder. Only a regular Python was tested. Hands-on check 4.
- **CPU time.** Diarization of a 30-minute clip may take a few minutes on CPU. Progress is
  shown. Hands-on check 3.
- **Autoplay.** WKWebView may block the hidden audio element; the `play()` rejection falls
  back to full audio. Hands-on check 2.
- **Stem sync.** Two media elements can drift; the 0.1 s resync handles it. Large WAV stems
  (about 300 MB for 30 minutes) stream with Range requests.
- **Threshold tuning.** Energy rules can still let a loud breath or a sung phrase through, or
  miss a quiet effort. The constants are in one place and the user deletes extra lines.
- **Speaker accuracy** on anime voices is rough; correcting it is a dropdown.

## Hands-on checks (before release)

1. macOS desktop build: build a pack from a 2-minute clip with real separation, so Demucs and
   then speaker detection run in one engine process. The engine must not abort.
2. macOS desktop app: open the editor with "Voices only" and press play. You hear the voices,
   or you get the fallback toast and the full audio. Never silence.
3. Windows, CPU only: time speaker detection on a real 30-minute voice stem.
4. Windows desktop install made before this release (Pack Builder installed): build a pack.
   The top-up installs into `ai-packages`, `import sherpa_onnx` works with the embedded
   runtime, speakers are detected, and "Remove Pack Builder" deletes the package and models.
5. Tablet or touchscreen laptop, and a pen: drag lines, edges, the splitter and the timeline.
   Then repeat with a mouse and confirm nothing changed.
6. Listen to non-verbal lines on two real clips, one with crowd noise. Few false lines, and no
   walla lines.

## Decided overnight, revisit

1. Non-verbal lines are added only when Whisper wrote the lines, not when subtitles supplied
   them, because subtitle timing is often loose enough to turn spoken words into false
   "no words" lines. This narrows the roadmap principle "detect lines from activity on the
   vocal stem" for URL imports with subtitles. Owner to confirm.
2. Non-verbal detection is skipped, and voices-only playback is off, when separation fell back
   to the basic filter (its "voice" track is the full mix).
3. Non-verbal lines compile with an empty caption. The `nonverbal` flag stays in the builder and is not written to packs.
4. The embedding model is 3D-Speaker CAM++ zh/en (Apache-2.0, 28 MB). WeSpeaker and NeMo models were not picked because their weights are CC BY. ERes2Net was not picked because it is larger.
5. Models live in `<add-on folder>/dubmate-models/speakers` (found from `sys.path`, not the
   install root, so macOS matches), or `<cache>/models/speakers` for source installs. A failed
   download is retried on the next build.
6. Existing desktop installs get `sherpa-onnx==1.13.8` by an engine-side pinned pip top-up on
   first use (about 19 MB), instead of a 2 GB Pack Builder re-download or a launcher change.
7. `sherpa-onnx` is pinned to `==1.13.8`, the version tested with this config.
8. The speaker count is automatic (cluster threshold 0.5), with no UI.
9. Zero speaker turns is treated as "detection failed": pause guess plus notice.
10. The audio route serves only `vocals`. Full audio is the video's own track.
11. "Voices only" stays the default, so the editor now plays the voice track on open.
12. The editor now shows the server `warning`, which includes the existing separation notice.
13. The result summary is a toast when the editor opens.
14. There is a maximum non-verbal region length of 8 s, against song leaks and long walla.
15. Pointer: non-primary pointers are ignored, there is no pinch-zoom, and mouse buttons are not filtered.
16. Diarization is skipped when subtitles name the characters.

## Implementation steps

Each step is one commit and keeps `python tests/run_all_tests.py` green.

1. **Stem preview.** Restore the vocals audio route (with `voices_separated`), `playMedia` /
   `pauseMedia`, sync and the `error`/`play()`-rejection fallback. Adds the jsdom suite
   `tests/test_builder_editor.js` and the entry option in `tests/helpers/studio_dom.js`.
2. **Touch and pen.** Pointer Events across the timeline, CSS, jsdom pointer tests.
3. **Non-verbal lines (engine).** Detection, pipeline wiring and order, `nonverbal` kept by
   `PUT /segments`, pipeline-driver test, pack round-trip test.
4. **Non-verbal lines and notices (editor).** Badge, placeholder, timeline label,
   `#editor-notice` for `warning`, result toast.
5. **Speaker detection (engine core).** Requirement pin, `_addon_dir`, package top-up, pinned
   model download, `detect_speaker_turns`, overlap mapping, README licences, `HEAVY_MODULES`.
6. **Speaker detection (pipeline and editor).** New stage, notices, progress, pipeline test.
7. **Changelog and roadmap.**
