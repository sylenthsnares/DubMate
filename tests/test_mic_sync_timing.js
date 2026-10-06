/**
 * test_mic_sync_timing.js
 *
 * Mic sync measurement on synthetic recordings (static/js/studio/timing.js)
 * and AudioEngine.playClickTrain scheduling against a stub AudioContext.
 * No DOM, no audio device.
 */
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");

const STUDIO = path.join(__dirname, "..", "static", "js");
const SR = 48000;

// Deterministic noise so a run never flakes.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

function noise(seconds, rms, seed) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  const scale = rms * Math.sqrt(12);
  for (let i = 0; i < out.length; i++) out[i] = r() * scale;
  return out;
}

function addAt(target, source, offsetSec, gain) {
  const start = Math.round(offsetSec * SR);
  for (let i = 0; i < source.length && start + i < target.length; i++) {
    if (start + i >= 0) target[start + i] += source[i] * gain;
  }
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS: ${name}`);
}

(async () => {
  const t = await import(pathToFileURL(path.join(STUDIO, "studio", "timing.js")).href);
  const { AudioEngine } = await import(pathToFileURL(path.join(STUDIO, "audio_engine.js")).href);

  const train = t.clickTrainSamples(SR, t.CLICK_TIMES_SEC);
  const minus30dB = Math.pow(10, -30 / 20);

  check("click times: 6 irregular clicks over about 1.2 s", () => {
    assert.strictEqual(t.CLICK_TIMES_SEC.length, 6);
    const last = t.CLICK_TIMES_SEC[5] - t.CLICK_TIMES_SEC[0];
    assert.ok(last > 1.0 && last <= 1.3, `span ${last}`);
    const gaps = t.CLICK_TIMES_SEC.slice(1).map((x, i) => Math.round((x - t.CLICK_TIMES_SEC[i]) * 1000));
    assert.strictEqual(new Set(gaps).size, gaps.length, "gaps must differ");
    assert.strictEqual(t.CLAP_BEAT_SEC.length, 8);
  });

  check("click train: 4 ms bursts, peak near 1", () => {
    assert.ok(train instanceof Float32Array);
    const one = t.clickTrainSamples(SR, [0]);
    assert.strictEqual(one.length, Math.round(0.004 * SR));
    const peak = one.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 0.9 && peak <= 1.0, `peak ${peak}`);
    assert.ok(Math.abs(one[0]) < 1e-6 && Math.abs(one[one.length - 1]) < 1e-6, "windowed ends");
  });

  check("click train delayed 137 ms at -30 dB in noise is found within 2 ms", () => {
    const rec = noise(2.0, 0.002, 1);
    addAt(rec, train, 0.137, minus30dB);
    const r = t.findClickTrainLag(rec, SR, t.CLICK_TIMES_SEC, 600);
    assert.ok(Math.abs(r.lagMs - 137) <= 2, `lag ${r.lagMs}`);
    assert.strictEqual(r.confident, true);
  });

  check("44.1 kHz recording is found too", () => {
    const sr = 44100;
    const rec = new Float32Array(Math.round(2.0 * sr));
    const src = t.clickTrainSamples(sr, t.CLICK_TIMES_SEC);
    const start = Math.round(0.311 * sr);
    for (let i = 0; i < src.length; i++) rec[start + i] += src[i] * minus30dB;
    const r = t.findClickTrainLag(rec, sr, t.CLICK_TIMES_SEC, 600);
    assert.ok(Math.abs(r.lagMs - 311) <= 2, `lag ${r.lagMs}`);
    assert.strictEqual(r.confident, true);
  });

  check("pure noise is not confident", () => {
    const r = t.findClickTrainLag(noise(2.0, 0.01, 2), SR, t.CLICK_TIMES_SEC, 600);
    assert.strictEqual(r.confident, false);
  });

  check("silence is not confident", () => {
    const r = t.findClickTrainLag(new Float32Array(SR * 2), SR, t.CLICK_TIMES_SEC, 600);
    assert.strictEqual(r.confident, false);
  });

  check("a periodic click decoy is not taken for the train", () => {
    const period = [];
    for (let x = 0; x < 2.0; x += 0.1) period.push(x);
    const decoy = t.clickTrainSamples(SR, period);
    const rec = noise(2.0, 0.002, 3);
    addAt(rec, decoy, 0, minus30dB);
    const r = t.findClickTrainLag(rec, SR, t.CLICK_TIMES_SEC, 600);
    assert.strictEqual(r.confident, false);

    // With the real train under a decoy of equal level, the lag is still right
    // and the decoy only lowers how clearly it stands out.
    const both = noise(2.0, 0.002, 4);
    addAt(both, train, 0.137, minus30dB);
    addAt(both, decoy, 0.05, minus30dB);
    const r2 = t.findClickTrainLag(both, SR, t.CLICK_TIMES_SEC, 600);
    assert.ok(Math.abs(r2.lagMs - 137) <= 2, `lag ${r2.lagMs}`);
  });

  // Clap-along: short noise bursts at each beat + 180 ms +-10 ms.
  function clapRecording(beats, lagSec, jitterMs, seed) {
    const r = rng(seed);
    const rec = noise(5.0, 0.002, seed + 100);
    for (const b of beats) {
      const burst = noise(0.03, 0.2, seed + Math.round(b * 1000));
      for (let i = 0; i < burst.length; i++) burst[i] *= Math.exp(-i / (0.006 * SR));
      addAt(rec, burst, b + lagSec + (r() * 2 * jitterMs) / 1000, 1);
    }
    return rec;
  }

  check("clap-along finds the lag within 10 ms with spread <= 25 ms", () => {
    const rec = clapRecording(t.CLAP_BEAT_SEC, 0.18, 10, 7);
    const r = t.findClapLag(rec, SR, t.CLAP_BEAT_SEC);
    assert.ok(r, "expected a result");
    assert.ok(Math.abs(r.lagMs - 180) <= 10, `lag ${r.lagMs}`);
    assert.ok(r.spreadMs <= 25, `spread ${r.spreadMs}`);
    assert.strictEqual(r.hits, 6);
  });

  check("clap-along with too few hits returns null", () => {
    const rec = clapRecording(t.CLAP_BEAT_SEC.slice(0, 5), 0.18, 5, 9);
    assert.strictEqual(t.findClapLag(rec, SR, t.CLAP_BEAT_SEC), null);
    assert.strictEqual(t.findClapLag(noise(5.0, 0.002, 11), SR, t.CLAP_BEAT_SEC), null);
  });

  check("combineRuns gives median and spread", () => {
    assert.deepStrictEqual(t.combineRuns([140, 120, 150]), { medianMs: 140, spreadMs: 30 });
    assert.deepStrictEqual(t.combineRuns([100, 110]), { medianMs: 105, spreadMs: 10 });
  });

  check("devicePairKey falls back to 'default'", () => {
    assert.strictEqual(t.devicePairKey("USB Mic", "Headphones"), "USB Mic|Headphones");
    assert.strictEqual(t.devicePairKey("", "Headphones"), "default|Headphones");
    assert.strictEqual(t.devicePairKey("USB Mic", undefined), "USB Mic|default");
    assert.strictEqual(t.devicePairKey(null, "  "), "default|default");
    assert.ok(t.devicePairKey("x".repeat(500), "y".repeat(500)).length <= 200);
  });

  check("snapMs rounds to the nearest 5 ms", () => {
    assert.strictEqual(t.snapMs(-137), -135);
    assert.strictEqual(t.snapMs(137), 135);
    assert.strictEqual(t.snapMs(138), 140);
    assert.ok(Object.is(t.snapMs(-1), 0), "no negative zero");
  });

  check("playClickTrain schedules one source per click on the destination", () => {
    const started = [];
    const destination = { name: "destination" };
    const ctx = {
      sampleRate: SR,
      currentTime: 10,
      destination,
      createBuffer(channels, length, rate) {
        const data = new Float32Array(length);
        return { length, sampleRate: rate, getChannelData: () => data };
      },
      createBufferSource() {
        const node = {
          connect(target) { node.target = target; },
          start(when) { started.push({ when, node }); },
          stop() {},
          disconnect() {},
        };
        return node;
      },
    };
    const engine = new AudioEngine();
    engine.ctx = ctx;
    engine.initContext = () => ctx;
    const end = engine.playClickTrain(t.CLICK_TIMES_SEC, 0.3);
    assert.strictEqual(started.length, t.CLICK_TIMES_SEC.length);
    started.forEach((s, i) => {
      assert.ok(Math.abs(s.when - (10 + 0.3 + t.CLICK_TIMES_SEC[i])) < 1e-9, `click ${i} at ${s.when}`);
      assert.strictEqual(s.node.target, destination);
      assert.ok(s.node.buffer && s.node.buffer.length === Math.round(0.004 * SR));
    });
    assert.strictEqual(engine.currentPlayingNodes.length, t.CLICK_TIMES_SEC.length);
    assert.ok(Math.abs(end - (10 + 0.3 + 1.2 + 0.004)) < 1e-6, `end ${end}`);
  });

  console.log(`ALL ${passed} MIC SYNC TIMING CHECKS PASSED`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
