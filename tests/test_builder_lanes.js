/**
 * test_builder_lanes.js
 *
 * Pack Builder timeline tracks (static/js/builder_lanes.js): lines that overlap
 * get their own track, as many tracks as the most lines playing at once, up to 5.
 * Past 5 a line shares the track that frees soonest; no line is ever dropped.
 */
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");

const MODULE = path.join(__dirname, "..", "static", "js", "builder_lanes.js");

function pass(msg) {
  console.log("PASS: " + msg);
}

(async () => {
  const { packLanes } = await import(pathToFileURL(MODULE).href);
  const line = (start, end) => ({ start, end, text: "", character: "A" });

  // Nothing overlaps: one track.
  {
    const r = packLanes([line(0, 1), line(1.5, 2), line(3, 4)]);
    assert.strictEqual(r.count, 1);
    assert.deepStrictEqual(r.lane, [0, 0, 0]);
    pass("lines that don't overlap share one track");
  }

  // No lines still shows one track.
  {
    const r = packLanes([]);
    assert.strictEqual(r.count, 1);
    assert.deepStrictEqual(r.lane, []);
    pass("an empty timeline has one track");
  }

  // Three at once: three tracks, one each.
  {
    const r = packLanes([line(1, 3), line(1.2, 2.5), line(1.4, 4), line(5, 6)]);
    assert.strictEqual(r.count, 3);
    assert.deepStrictEqual(r.lane.slice(0, 3).sort(), [0, 1, 2]);
    assert.strictEqual(r.lane[3], 0, "a later line goes back to the first track");
    pass("three lines at once get three tracks");
  }

  // Touching lines (gap <= 0.05 s, even a small overlap) share a track.
  {
    assert.strictEqual(packLanes([line(0, 1), line(1, 2)]).count, 1);
    assert.strictEqual(packLanes([line(0, 1.04), line(1, 2)]).count, 1);
    assert.strictEqual(packLanes([line(0, 1.2), line(1, 2)]).count, 2);
    pass("lines that only touch share a track");
  }

  // Seven at once: five tracks, every line still has a track.
  {
    const lines = [];
    for (let i = 0; i < 7; i++) lines.push(line(i * 0.1, 5 + i * 0.1));
    const r = packLanes(lines);
    assert.strictEqual(r.count, 5);
    assert.strictEqual(r.lane.length, 7);
    for (const l of r.lane) assert.ok(Number.isInteger(l) && l >= 0 && l < 5, `lane ${l} is in range`);
    assert.deepStrictEqual(r.lane.slice(0, 5), [0, 1, 2, 3, 4]);
    pass("seven lines at once use five tracks and none is dropped");
  }

  // maxLanes is honoured.
  {
    const r = packLanes([line(0, 2), line(0.5, 2), line(1, 2)], 2);
    assert.strictEqual(r.count, 2);
    assert.ok(r.lane.every((l) => l < 2));
    pass("maxLanes caps the track count");
  }

  // The track a line gets doesn't depend on the order lines come in.
  {
    const lines = [line(4, 6), line(0, 2), line(1, 3), line(1.5, 5), line(2.5, 3.5), line(7, 8)];
    const base = packLanes(lines);
    const byLine = new Map(lines.map((l, i) => [l, base.lane[i]]));
    const shuffled = [lines[5], lines[2], lines[0], lines[4], lines[1], lines[3]];
    const r = packLanes(shuffled);
    assert.strictEqual(r.count, base.count);
    shuffled.forEach((l, i) => assert.strictEqual(r.lane[i], byLine.get(l), `line ${l.start} keeps its track`));
    assert.strictEqual(base.count, 3);
    pass("input order doesn't change which track a line gets");
  }

  // Input is not reordered or changed.
  {
    const lines = [line(3, 4), line(0, 1)];
    packLanes(lines);
    assert.strictEqual(lines[0].start, 3);
    pass("packing leaves the lines untouched");
  }

  console.log("All Pack Builder track packing checks passed.");
})().catch((err) => {
  console.error("FAIL: " + (err && err.stack || err));
  process.exit(1);
});
