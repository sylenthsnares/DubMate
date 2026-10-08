# Pack Builder editor fixes: scrolling, smooth playback, overlapping lines

Fixes from the owner's hands-on test of the Pack Builder editor. Files: `static/builder.html`,
`static/js/pack_builder.js`, `static/css/builder.css`, and `dubmate/builder_api.py` only if a
measurement in group D justifies it. The rest of U5 (40e to 40i in `ui-plan.md`) stays for later.
The next PR adds "Edit an existing pack", so session handling (`sessionId`, `setupEditorView`,
`editorSessionId`, the SSE flow) is not restructured here.

## What the owner reported, and what this PR does

| # | Owner, in their words | This PR |
|---|---|---|
| 1 | "If there's many tracks, then I can't scroll in the track section, I have to enlarge the track panel vertically to see the new track." | The timeline scrolls vertically when its tracks don't fit. The track column on the left scrolls with it. |
| 2 | "I can't scroll the horizontal character list on the pack builder when building a pack." | The Cast row scrolls by mouse wheel, trackpad, drag and keyboard, and fades at the edge that has more chips. |
| 3 | "The Pack Builder plays the first few milliseconds of the clip a few times when I click play, and doesn't feel very snappy or fast." | The voice track waits for the video instead of replaying its start. The main costs of Play, seek, select, edit and drag are measured and cut. |
| 4 | "The tracks were mainly for overlapping lines, let's say a collective gasp or talking over each other." | The editor adds tracks on its own: one per line that overlaps another, up to 5. "Add track", "Delete track" and track renaming go away. |

## What was found

**Are tracks saved anywhere? No.** `this.tracks` (`pack_builder.js` ~196) only exists in memory.
It is not part of the segment JSON (`PUT /segments` keeps only `start`, `end`, `text`,
`character`, `nonverbal`), the builder session, the compile payload, packs or `localStorage`
(the only stored editor value is `dubmate_pack_builder_timeline_h`). Tests don't mention it either.
The track a line sits in was always computed from its timing (`renderTimelineSegments`). So
there is no data to migrate and removing tracks can't lose lines. A line's `character` stays the
only thing that decides who voices it.

**Tracks didn't scroll (1).** `.daw-channel-strips` (builder.css ~967) and
`.timeline-canvas-scroll-container` (~1057) are `overflow-y: hidden`, and lanes keep a 38 px
minimum. With 5 tracks at the default panel height, the content is 214 px tall in a 190 px box,
so track 5 is cut off (`before-timeline-panel-1280x720.png`).

**The Cast row didn't scroll (2).** `.character-manager-strip` is `overflow-x: auto`. With 12
characters its content is 1820 px wide in an 853 px box. A vertical mouse wheel does nothing in a
box that only scrolls sideways (measured scrollLeft 0 → 0 after a 300 px wheel). The only way to
scroll it is an 8 px scrollbar that also carries the "Cast" title and the + button away.

**Repeated start (3), reproduced.** In headless Chromium, using a generated 30 s video and voice
track served by the real engine routes (dev scripts below), I logged events from both elements.
Steps: click a line's Play, or click the timeline and then Play, while the video is still seeking.

```
  0 click Play             voice play()  video play()
 36 video waiting (readyState 1)   voice playing 12.005
165 voice SET currentTime 12 (was 12.102, video still 12.000)   voice playing 12.000
305 voice SET currentTime 12 (was 12.101) ...  (repeats every ~140 ms)
1005 voice SET currentTime 12 (was 12.101)
1022 video seeked, video playing 12.007
```

The voice starts at once, while the video is still seeking or buffering and its clock is
stopped. After 0.1 s, `syncStemAudio()` (the rAF loop, ~1784) sees the drift and seeks the voice
back to the stopped video time. The voice plays the same 0.1 s again, and this repeats until the
video moves. That loop is the stutter: 7 repeats in 1 s on a 1080p video throttled to 40 Mbps,
and 3 to 4 repeats in 0.45 s on a small local video (a line's Play button seeks first, so it
always triggers this). There is a second cost too. Every Play writes `editorStemAudio.currentTime`
even when the voice is already at the right time (`playMedia` ~1714), which forces a seek and
adds about 30 ms before the voice sounds.

A related bug: a line's Play (`previewSegmentAudio`) stops after a timer that runs from the click.
If the video starts late, `currentTime >= end - 0.1` is still false when the timer fires, so
playback never stops.

**Snappiness (3), first look.** A Play click when nothing needs to seek: video `playing` 54 ms
after `play()`, voice `playing` 85 ms (30 ms of that is the extra seek). Group D measures the
rest. The likely costs are:
- every selection, text change and drag frame rebuilds every timeline block and the track
  column (`renderTimelineSegments` → `renderChannelStrips`, `innerHTML = ''`);
- drags re-render on every `pointermove`, without waiting for the next frame;
- the editor and the audio switch wait for `/waveform` before drawing anything, and the engine
  recomputes the peaks from the WAV on every request (`builder_get_waveform`);
- builder media is served with `Cache-Control: no-cache`, so seeks may refetch data the
  browser already has.

## Behaviour spec

### Tracks follow the overlap (4)

- **Packing.** This is a pure function in a new module `static/js/builder_lanes.js`:
  `packLanes(segments, maxLanes = 5, touch = 0.05) → { lane: number[], count: number }`.
  - Lines are taken in start order. Each goes into the lowest track whose last line ends by
    `start + touch`. When no track is free, a new one opens, up to `maxLanes`.
  - Past 5, the line goes into the track that frees up soonest. That is today's fallback, so a
    6th line playing at once overlaps visually; it is never dropped.
  - `count = max(1, tracks used)`. First-fit in start order gives exactly the largest number of
    lines that overlap at one moment, which is the minimum possible.
- **During a drag**, the other lines keep their tracks (frozen at drag start). The dragged line
  takes the lowest track that is free at its current time, and a new track appears if none is
  (up to 5). On drop everything is packed again. Nothing jumps under the pointer. If the
  dragged line's track is scrolled out of sight, the timeline scrolls it into view.
- **Track heights.**
  - One track: as today (50 to 70 px).
  - More than one: `clamp(floor(available / count), 38, 64)`.
  - When `count × 38` doesn't fit, the timeline scrolls vertically (below).
- **Removed:**
  - `#btn-add-audio-track` and its CSS;
  - `this.tracks`, `addAudioTrack`, `deleteAudioTrack` and `updateTrackButtonsState`;
  - the per-track name input, delete button and activity dot.
- **Kept:** the timeline header badge, now read-only and counting automatic tracks ("1 track",
  "3 tracks"), with the tooltip "Lines that overlap get their own track. A line's character
  decides who voices it."
- **Track column:** narrows from 165 px to about 44 px and shows only the number badge (A1 to A5).
  The column carries the same tooltip. The timeline gains about 120 px of width.
- Waveform drawing is unchanged (full waveform in track 1, faint copies in the others).

### The timeline scrolls vertically (1)

- `.timeline-canvas-scroll-container` becomes `overflow: auto`.
- The ruler is `position: sticky; top: 0` above the blocks, so time labels stay visible.
- The playhead spans the full height of all tracks and draws over the ruler. Its tag is
  `position: sticky` inside the playhead, so it stays in the ruler while the tracks scroll.
- Track column structure:
  - a fixed 24 px spacer, level with the ruler;
  - under it, a list with `overflow: hidden` whose `scrollTop` is copied from the timeline's
    `scroll` event, so headers and tracks never drift apart.
- Input:
  - **Mouse wheel over the tracks:** pans sideways (unchanged). Ctrl, Cmd or Alt + wheel zooms
    (unchanged). Horizontal trackpad swipes (`|deltaX| > |deltaY|`) pan sideways.
  - **Wheel over the track column:** scrolls up and down, and calls `preventDefault` only when
    the timeline can still move that way.
  - **Dragging empty timeline space:** pans both ways with mouse, touch and pen. The 4 px
    threshold uses both axes, and a click without movement still seeks.
  - **Vertical scrollbar:** visible on the timeline, styled like the studio's thin scrollbars.
    Pressing either scrollbar scrolls only: it no longer starts a pan or seeks on release.
- These keep working, because they use `clientX` and the viewport's bounding box:
  - seek x position;
  - segment drag and trim;
  - playhead auto-follow (horizontal only);
  - zoom, splitter resize, saved height.

### The Cast row scrolls (2)

- Layout:
  - The "Cast" title and the + button stay in place.
  - Only `#character-chips-list` scrolls: `flex: 1; min-width: 0; overflow-x: auto;
    overscroll-behavior-x: contain`, with a thin themed scrollbar and `touch-action: pan-x`.
  - `.character-manager-strip` loses its own `overflow-x`.
- Input:
  - **Mouse wheel:** a mostly vertical wheel (`|deltaY| > |deltaX|`, no Ctrl) scrolls the list
    sideways (line-mode deltas × 16). `preventDefault` only when `scrollLeft` actually changed.
  - **Trackpad:** horizontal swipes scroll natively.
  - **Drag (mouse and pen):** past a 5 px threshold the list scrolls with the pointer, and the
    `click` that follows is swallowed, so a drag never renames or deletes. Touch scrolls natively.
  - **Keyboard:** the list is focusable while it overflows (`tabindex="0"`,
    `aria-label="Cast"`), with the shared brass focus ring. Left and Right scroll by 120 px;
    Home and End go to the ends. Tabbing to a chip's delete button scrolls it into view (native,
    plus `scroll-margin-inline: 24px`).
- **Overflow affordance:** a 24 px fade (`mask-image`) on each edge that has more chips, toggled
  by `has-more-start` / `has-more-end` classes on scroll and resize. Plus the thin scrollbar.
  Nothing is shown when everything fits.
- Adding a character scrolls its new chip into view.
- `ui-plan.md` 40h says "Cast chips wrap". This replaces that bullet: the owner asked for a
  scrolling row (noted in 40h).

### Playback: the video leads, the voice waits (3)

- **Play click** (still one call stack, for WebKit's gesture rule):
  - Video ready (`readyState >= HAVE_FUTURE_DATA` and not `seeking`): align the voice only if
    it is more than 0.03 s off, then `play()` both.
  - Not ready: call `play()` on both to use the gesture, then hold the voice (pause it, set
    `voiceHeld`). An `AbortError` from that pause is already ignored.
- **Video events:**
  - `waiting` or `seeking`: hold the voice.
  - `playing`, or `seeked` while playing: align the voice if it is more than 0.03 s off and
    resume it.
  - The `seeking` mirror skips the write when the voice is already within 0.01 s.
- **Drift correction in the rAF loop** runs only when all of these hold:
  - the video is playing, not seeking, with `readyState >= 3`;
  - the voice is not seeking and not held;
  - at least 750 ms have passed since the last correction;
  - drift is over 0.15 s.

  It can never fire twice for the same stall.
- **The Play button** flips to Pause on click (optimistic), not on the video's `play` event. The
  `pause` and `ended` events still set the final state.
- **A line's Play** stops at `seg.end` by checking the video clock in the rAF loop
  (`this.stopAt`), not with a wall-clock timer. Any manual Play, Pause or seek clears `stopAt`.
- Full-audio mode and the fallback to full audio (toast, per-session reset) are unchanged.

### Snappiness (3)

Measure first, then fix the costs the numbers show, without a rewrite. Expected changes:

- **Selecting a line:** toggle `.selected` on the old and new block and card. No timeline
  re-render.
- **Drags:** coalesce `pointermove` to one update per animation frame. Move only the dragged
  block (`left`, `width`, `top`) and its card's timecode. Repack and re-render once on drop.
- **Track column:** re-render only when the track count changes.
- **Text edits:** update only that block's label.
- **Waveform:**
  - The editor draws tracks and blocks at once and draws the waveform when the peaks arrive.
  - The client keeps peaks per track, so switching back is instant.
  - The engine caches peaks per `(track, columns)` in the session dict.
- **Builder video and voice routes:** compare `no-cache` with `private, max-age=3600`. Switch
  only if seeks get measurably faster. Session files don't change during a session.

## Implementation groups (build order)

**A. Automatic tracks and vertical timeline scroll** (items 1 and 4).

- Files:
  - `static/js/builder_lanes.js` (new);
  - `static/js/pack_builder.js`: `getLaneDimensions`, `renderChannelStrips`,
    `renderTimelineSegments`, the drag handlers and the wheel and pan handlers;
  - `static/builder.html`: the timeline header and the track column;
  - `static/css/builder.css`.
- Tests:
  - `tests/test_builder_lanes.js` (node ESM import): no overlap gives 1 track; three lines at
    once give 3; touching lines (gap ≤ 0.05 s) share a track; 7 lines at once give 5 and none
    is dropped; output order doesn't depend on input order.
  - `tests/test_builder_editor.js`:
    - no `#btn-add-audio-track`, and the badge reads "3 tracks" for 3 overlapping lines;
    - blocks get 3 distinct `top` values;
    - a drag keeps the other blocks' `top`;
    - the track column's `scrollTop` follows the timeline's `scroll`;
    - a wheel over the track column moves the timeline's `scrollTop`;
    - pan and seek still work.

**B. Cast row scrolling** (item 2).

- Files: `renderCharacterChips` and a small `initCastScroller()` in `pack_builder.js`;
  `builder.html` (the list's attributes); `builder.css`.
- Tests (JSDOM in `test_builder_editor.js`, stubbing `scrollWidth`, `clientWidth` and
  `scrollLeft`):
  - a vertical wheel moves `scrollLeft` and calls `preventDefault`;
  - at the end there is no `preventDefault`;
  - a mouse drag past 5 px scrolls and swallows the next chip click;
  - ArrowRight, Home and End scroll;
  - the edge classes toggle;
  - the list is focusable only while it overflows.

**C. Playback sync** (item 3, the repeated start).

- Files: `playMedia`, `pauseMedia`, `syncStemAudio`, `previewSegmentAudio`,
  `startPlaybackLoop`, `onVideoPlayState` and the video listeners in `pack_builder.js`.
- Tests (JSDOM in `test_builder_editor.js`, with controllable `readyState`, `seeking` and
  `currentTime` on both elements):
  - Play while the video `readyState` is 1, run 30 loop ticks with the voice clock moving:
    0 voice seeks, and the voice is paused.
  - Fire video `playing`: the voice resumes once, from the video time.
  - Play when already aligned: no `currentTime` write.
  - A line's Play stops at `seg.end` even when the video started 1 s late.
  - The existing fallback and gesture tests stay green.
- Before and after event logs from the dev scripts (below).

**D. Snappiness: measure, fix, measure** (item 3, after A to C).

- Files: `pack_builder.js` render paths; `builder_api.py` `builder_get_waveform` (cache) and
  possibly the media `cache_control`.
- Before numbers come from origin/main in a temporary worktree. After numbers come from this
  branch, using the same script and fixture.
- Report click-to-sound, timeline-click-to-seeked, select, keystroke and drag-frame timings and
  editor open to first draw. Use the median of 5 runs, on the small and on the 1080p fixture.
- Tests:
  - `tests/test_pack_builder.py`: the second `/waveform` call doesn't recompute (patch
    `compute_waveform_peaks`, count the calls).
  - JSDOM: selecting a line doesn't rebuild the overlay (the block nodes stay the same objects);
    the editor draws blocks before the `/waveform` promise resolves.

Every group runs `python tests/run_all_tests.py`. `test_css_floors.js` applies to builder.css:
11 px minimum font size, and reduced-motion overrides for any new motion. The fade has no motion.

## Dev scripts (not committed)

- `C:/Users/tanis/AppData/Local/Temp/dm_pbfix/fixture_server.py <repo> <media_dir> <port>` runs
  the engine with a finished session `fixture1` (no Demucs or Whisper), served by the real range
  routes.
- Media made with ffmpeg:
  - `dm_pbfix/media`: 640x360 with a GOP of 60.
  - `dm_pbfix/media_big`: 1080p at 12 Mb/s with a GOP of 250.
  - Both have a 30 s voice WAV.
- `C:/Users/tanis/AppData/Local/Temp/dm_pw/pbfix_before.js <port> <prefix>` takes the screenshots
  and the geometry and wheel checks.
- `pbfix_play.js <port> <label> [Mbps]` writes the play, seek and `currentTime` event log
  (`playwright-core` from `dm_pw/node_modules`; full Chromium for real audio timing).

## Risks

- **WebKit (macOS desktop):** the held voice resumes from a `playing` event, outside the click.
  WebKit allows that once the element has played inside a gesture, and Play always calls
  `play()` inside the gesture. If it is refused, the existing fallback switches to full audio
  with its toast. Check on a Mac.
- **The voice now waits for the video.** After a slow seek there is silence until the video
  moves, where there used to be stutter. Faster seeks (group D) are the cure. A seek-friendly
  proxy video is out of scope.
- **Wheel meaning.** A plain wheel over the tracks still pans sideways. Vertical scrolling is by
  wheel over the track column, by drag, or by the scrollbar. The owner may expect the wheel over
  the tracks to scroll vertically; see the hands-on checks.
- **Frozen tracks during a drag** can briefly show the dragged line in a new track that
  disappears on drop. That is intended.

## Decided without the owner

- The track column stays, narrowed to number badges. Track names and renaming go, because names
  were never saved and tracks are now automatic.
- The header badge stays as a read-only track count, with a tooltip explaining automatic tracks.
- A plain mouse wheel over the tracks keeps panning sideways. Vertical scroll is by wheel over the
  track column, by drag (now in both directions) and by the scrollbar.
- More than 5 lines at once: the extra line shares the track that frees soonest (drawn
  overlapping), as today. There is no warning.
- The Cast row scrolls instead of wrapping (replaces the 40h "Cast chips wrap" bullet).
- A line's Play stops on the video clock. The voice waits silently for a slow video instead of
  playing ahead.
- No new pack, session or segment fields. No migration, because nothing stored tracks.
- Dev fixture and playback scripts stay outside the repo.

## Hands-on checks for the owner

1. Open a scene where 3 or 4 people talk over each other. The timeline shows that many tracks,
   with no Add track button. Lines that don't overlap sit in track 1.
2. Shrink the timeline panel until the tracks don't fit. Scroll down by wheel over the A1 to A5
   column, by dragging empty timeline space, and by the scrollbar. The track numbers stay level
   with their tracks, and the time ruler stays visible.
3. Drag a line across an overlap: the other lines stay put, and it settles into place on drop.
4. A scene with many characters: scroll the Cast row with the mouse wheel, by dragging it, with a
   trackpad, and with Tab and the arrow keys. The edge fades show when there's more. Dragging
   never renames or deletes a character.
5. Click a line's Play, click Play after clicking far along the timeline, and press Space at the
   start. The voice never repeats its first moment, and a line's Play stops at the line's end.
6. Does it feel faster: Play, clicking the timeline, selecting lines, typing, dragging?
7. On the Mac desktop app: voices-only playback still plays (no "isn't available" toast).
8. Tell us whether the wheel over the tracks should scroll up and down instead of sideways.
