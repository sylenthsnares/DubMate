// builder_lanes.js - Pack Builder timeline tracks.
// Lines that overlap get their own track: as many tracks as the most lines
// playing at once, up to maxLanes. A line's character decides who voices it;
// its track is only where it is drawn.

/**
 * Packs lines into tracks, first-fit in start order.
 * Returns { lane, count }: lane[i] is the track of segments[i] (input order kept),
 * count is the number of tracks used (at least 1).
 * Lines that only touch (the next starts within `touch` s of the last end) share a
 * track. Past maxLanes a line goes into the track that frees soonest, so it is
 * drawn overlapping but never dropped.
 */
export function packLanes(segments, maxLanes = 5, touch = 0.05) {
  const order = segments.map((_, i) => i).sort((a, b) =>
    (segments[a].start - segments[b].start) || (segments[a].end - segments[b].end) || (a - b));
  const laneEnds = [];
  const lane = new Array(segments.length);

  for (const i of order) {
    const seg = segments[i];
    let placed = laneEnds.findIndex((end) => end <= seg.start + touch);
    if (placed === -1 && laneEnds.length < maxLanes) {
      placed = laneEnds.length;
      laneEnds.push(0);
    }
    if (placed === -1) {
      placed = 0;
      for (let l = 1; l < laneEnds.length; l++) {
        if (laneEnds[l] < laneEnds[placed]) placed = l;
      }
    }
    laneEnds[placed] = Math.max(laneEnds[placed], seg.end);
    lane[i] = placed;
  }

  return { lane, count: Math.max(1, laneEnds.length) };
}
