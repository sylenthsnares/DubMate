# Pack Builder upgrades: stem preview, touch and pen, speaker detection, non-verbal lines

Roadmap feature 5. Everything here lives in the Pack Builder: `static/builder.html`,
`static/js/pack_builder.js`, `static/css/builder.css`, `dubmate/builder_api.py`,
`pack_builder.py`. The studio, rooms, render and export code are not touched.

## What the user sees

| Change | Where | Disclosure level |
|---|---|---|
| **Voices only / Full audio** now changes what you hear, not only the waveform. "Voices only" (the default, as today) plays the separated voice track in sync with the muted video; "Full audio" plays the video's own sound. | Existing toggle in the editor's transport deck. Tooltip: "Hear and see voices only, or the full audio". Toast on switch: "Playing voices only" / "Playing full audio". | 1 (visible control, unchanged place) |
| **Touch and pen** work on the timeline: drag a line, drag its edges, drag the empty timeline to scroll, tap to move the playhead, drag the splitter to resize. Mouse behaves exactly as before. | Timeline | 0 (no control) |
| **Detecting who speaks**: lines are split between characters by voice ("Speaker 1", "Speaker 2", ...), instead of alternating on pauses. Rough is fine: the existing character menu on each line fixes mistakes. | New processing stage "Detect who speaks" (desc: "Gives each voice its own character"). Progress message "Detecting who speaks"; first time only "Downloading speaker detection (about 35 MB, first time only)". | 0 (automatic) |
| If speaker detection is not installed, can't be downloaded or fails, speakers are guessed from pauses as today, and the editor says so. | One-line notice above the line list (`#editor-notice`), e.g. "Speaker detection isn't installed, so speakers were guessed from pauses. Check who says each line." | 1, shown only when it applies |
| **Non-verbal lines**: grunts, efforts, screams and laughs that the transcript skipped become lines to record. They have no text. | Line card shows a "No words" badge (tooltip: "A grunt, laugh or other sound without words. Record it like any other line."). Text box placeholder: "No words. Type a cue like (laughs) if you want." Timeline label: `[Speaker 1] (no words)`. Completion message: "Found 14 lines, 2 without words". | 1 badge, 2 tooltip |

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

**Packs: no format change.** A non-verbal line is written like any line with an empty caption:
the slice `NN_Speaker2_5-020.wav`, the `_captions.json` value `"[Speaker 2]"`, and `dub_subs.txt`
`00.05-00.05: [Speaker 2] `. `pack_loader.load_pack` already reads that as caption `""`. The studio
already shows "(Speaker 2, no subtitle)" for it. The `nonverbal` flag is not written to the pack.

**Builder session folder** (unchanged): `<cache>/builder/<session>/full_audio.wav`,
`stems/vocals.wav`, `stems/backing.wav`, `slices/`.

**Speaker models (new, downloaded at runtime, never bundled):**

- Desktop: `<install root>/ai-packages/dubmate-models/speakers/`. It sits inside the Pack
  Builder add-on folder, so "Remove Pack Builder" deletes it too. The hyphenated name can't be
  imported as a Python package, because `ai-packages` is on `sys.path`.
- Source installs (no `ai-packages` folder): `<cache>/models/speakers/`.
- Files:
  - `pyannote-segmentation-3-0.onnx`, plus its `pyannote-segmentation-3-0.LICENSE`.
  - `campplus-sv-zh-en-16k-common-advanced.onnx`.
- Each download is pinned and checksummed. It is written to a `.part` file, checked with
  SHA-256, then moved into place with `os.replace`. A checksum mismatch deletes the `.part` file.

| Model | Source | SHA-256 | Size | Licence |
|---|---|---|---|---|
| Speaker segmentation (pyannote segmentation-3.0, ONNX export) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`. Only member `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` and `.../LICENSE` are read. | archive `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488`; `model.onnx` `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079` | 7.0 MB archive | MIT (CNRS); LICENSE file ships in the archive |
| Speaker embedding (3D-Speaker CAM++, zh+en, 16 kHz) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` ("recongition" is the real tag name) | `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2` | 28.3 MB | Apache-2.0 (ModelScope card `iic/speech_campplus_sv_zh_en_16k-common_advanced`; 3D-Speaker repo) |
| `sherpa-onnx` Python package (`requirements_builder.txt`) | PyPI, CPU wheels for Windows, macOS and Linux, Python 3.7+ | — | about 15 MB | Apache-2.0 |

MIT and Apache-2.0 are both GPLv3-compatible. No Hugging Face token is involved.
Both checksums were computed from the files on 2026-10-06.

## API, SSE and WebSocket changes

- **Restored:** `GET /api/builder/{session_id}/audio/{track}`. Only `track == "vocals"` is
  served. The path is always `common.safe_join(session["folder"], "stems", "vocals.wav")`. The
  response is `common.range_stream_file(..., media_type="audio/wav", cache_control="no-cache")`
  (200, or 206 with Range). It returns 404 "This audio isn't ready yet." when the session is
  unknown, the stem doesn't exist yet, or the track is anything else. Full audio comes from
  the video itself.
- **`PUT /api/builder/{session_id}/segments`** keeps `nonverbal: true` on a segment that has it.
- **SSE `/progress` and `/status`:**
  - New `status: "detecting_speakers"` with `stage: "speakers"` (progress 0.88 to 0.98).
  - `warning` can now hold more than one sentence: the separation notice and the speaker
    notice, joined with a space.
  - `segments[]` can contain `nonverbal`.
- **WebSocket:** no change.

## How it works (engine)

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
when (a) the lines came from Whisper (not subtitles), and (b) real separation ran, not the
basic-filter fallback, whose "voice" track is the full mix.

**Speaker detection** (`pack_builder.detect_speaker_turns(vocals_wav, on_progress=None) -> (turns | None, notice)`):

1. `import sherpa_onnx`. On ImportError, return `(None, "Speaker detection isn't installed, ...")`.
2. `_ensure_speaker_models()` downloads any missing files under a module lock. It uses
   `urllib.request.urlopen` with a 60 s timeout. On failure it returns
   `(None, "Couldn't download speaker detection, ...")`, and the next build tries again.
3. Build `sherpa_onnx.OfflineSpeakerDiarization` with:
   - pyannote segmentation, `window_shift_ratio=0.1`;
   - `SpeakerEmbeddingExtractorConfig(model=...)`;
   - `FastClusteringConfig(num_clusters=-1, threshold=SPEAKER_CLUSTER_THRESHOLD=0.5)`;
   - `min_duration_on=0.3`, `min_duration_off=0.5`.
4. Feed it 16 kHz mono float32 from the voice stem. Its progress callback maps to 0.90–0.98.
5. Return the result as `[(start, end, speaker_id), ...]`. Any exception gives
   `(None, "Speaker detection couldn't run, ...")`.

`assign_speakers_to_segments(segments, turns=None)` behaves as follows:

- If the subtitles named characters, nothing changes.
- With `turns`:
  - Each segment takes the speaker with the largest time overlap.
  - With no overlap, it takes the nearest turn within 1 s, or else the previous line's speaker.
  - IDs become "Speaker 1..N" in order of first appearance.
- With `turns=None`: today's gap heuristic, unchanged.

The pipeline only calls `detect_speaker_turns` when no names were given, so subtitles with
names never trigger a download.

**Stem preview** (`pack_builder.js`):

- A hidden `<audio id="editor-stem-audio" preload="auto">` sits next to the video. The video
  is the clock.
- In vocals mode the video is muted. `playMedia()` and `pauseMedia()` start and stop both
  elements in the same user-gesture call stack, which WebKit's autoplay rules require.
- `seeking`, `ratechange`, `pause` and `ended` on the video are mirrored to the audio. The rAF
  playhead loop re-syncs the audio when drift exceeds 0.1 s.
- In full mode the video is unmuted and the audio paused.
- If the audio element fires `error`, the editor switches to full audio and shows the toast
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
  `.builder-segment-handle`. The splitter already has it.
- Under `@media (pointer: coarse)` the handles grow from 8 px to 16 px, and the selected
  block's delete button stays visible (it already does).

## Export, render and project ZIP

- **Unchanged.** Non-verbal lines are ordinary lines once the pack is built. They are sliced
  by `slice_audio_lines`, recorded in the booth, mixed by `render_dub_mix`, and listed in the
  project ZIP's `Timeline_Cues.txt` with `Dialogue : ""`.
- Speaker names land in filenames and `_captions.json` exactly as hand-typed names do today.
- Stem preview and pointer input are editor-only.

## Migration

There is no on-disk format change:

- Packs are byte-compatible.
- Builder sessions are in memory and expire after 2 h.
- The model folder is new.

Two tests guard this:

- A pack assembled with a non-verbal, empty-caption line round-trips through `load_pack` with
  `caption == ""`, the right character and the right timing.
- `PUT /segments` without `nonverbal` returns segments without the key, as it does today.

## Not done

- Subtitle-to-line matching, MDX models and faster-whisper.
- Non-verbal detection on subtitle-sourced lines.
- A setting to turn either detector off. To undo a result, delete the line or change the speaker.
- Choosing the number of speakers.
- Studio prompter wording for lines without text.
- Pinch-zoom on the timeline.
- Transcoding the stem to a smaller format for preview.
- Automatic installation of `sherpa-onnx` into existing Pack Builder installs.

## Risks

- **Existing installs** lack `sherpa-onnx` until Pack Builder is downloaded again (desktop) or
  `update.bat`/`update.sh` runs (source). Until then they get the fallback notice.
- **Torch and onnxruntime in one process.** On macOS a duplicate OpenMP runtime can abort the
  engine, and a fallback can't catch that. Hands-on check below.
- **CPU time.** Diarization of a 30-minute clip may take a few minutes on CPU. Progress is shown.
- **Stem sync.** Two media elements can drift; the 0.1 s resync handles it. Large WAV stems
  (about 300 MB for 30 minutes) stream with Range requests.
- **Threshold tuning.** Energy rules can still let a loud breath or a sung phrase through, or
  miss a quiet effort. The constants are in one place and the user deletes extra lines.
- **Speaker accuracy** on anime voices is rough; correcting it is a dropdown.

## Decided overnight, revisit

1. Non-verbal lines are added only when Whisper wrote the lines, not when subtitles supplied them.
2. Non-verbal detection is skipped when separation fell back to the basic filter.
3. Non-verbal lines compile with an empty caption. The `nonverbal` flag stays in the builder and is not written to packs.
4. The embedding model is 3D-Speaker CAM++ zh/en (Apache-2.0, 28 MB). WeSpeaker and NeMo models were not picked because their weights are CC BY. ERes2Net was not picked because it is larger.
5. Models live in `ai-packages/dubmate-models/speakers`, or `<cache>/models/speakers` for source installs. A failed download is retried on the next build.
6. The speaker count is automatic (cluster threshold 0.5), with no UI.
7. The audio route serves only `vocals`. Full audio is the video's own track.
8. "Voices only" stays the default, so the editor now plays the voice track on open.
9. The editor now shows the server `warning`, which includes the existing separation notice.
10. There is a maximum non-verbal region length of 8 s, against song leaks and long walla.
11. Pointer: non-primary pointers are ignored, there is no pinch-zoom, and mouse buttons are not filtered.
12. Diarization is skipped when subtitles name the characters.

## Implementation steps

1. **Stem preview.** Restore the vocals audio route and play the stem while editing.
2. **Touch and pen.** Pointer Events across the timeline.
3. **Non-verbal lines (engine).** Detection, pipeline wiring, and `nonverbal` kept by `PUT /segments`.
4. **Non-verbal lines (editor).** Badge, placeholder, timeline label and completion message.
5. **Speaker detection (engine core).** Pinned model download, `detect_speaker_turns`, overlap mapping, requirement and licence notes.
6. **Speaker detection (pipeline and editor).** New stage, fallback notice and editor notice.
7. **Changelog and roadmap.**

Each step's full brief is in the plan returned with this doc. Every step keeps
`python tests/run_all_tests.py` green.
