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

  check("click train: 5 ms clicks at about -1 dBFS peak", () => {
    assert.ok(train instanceof Float32Array);
    const one = t.clickTrainSamples(SR, [0]);
    assert.strictEqual(one.length, Math.round(0.005 * SR));
    const peak = one.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const peakDb = 20 * Math.log10(peak);
    assert.ok(peakDb > -1.3 && peakDb <= -0.7, `peak ${peakDb.toFixed(2)} dBFS`);
    assert.ok(Math.abs(t.CLICK_PEAK - Math.pow(10, -1 / 20)) < 1e-9, `CLICK_PEAK ${t.CLICK_PEAK}`);
    assert.ok(Math.abs(one[0]) < 1e-6 && Math.abs(one[one.length - 1]) < 1e-6, "windowed ends");
  });

  // Mean power over an octave around `fc`, from a direct DFT of `x` at 24 points.
  function octavePower(x, sr, fc) {
    let sum = 0;
    const points = 24;
    for (let k = 0; k < points; k++) {
      const f = fc * Math.pow(2, -0.5 + k / (points - 1));
      let re = 0, im = 0;
      for (let i = 0; i < x.length; i++) {
        re += x[i] * Math.cos((2 * Math.PI * f * i) / sr);
        im -= x[i] * Math.sin((2 * Math.PI * f * i) / sr);
      }
      sum += re * re + im * im;
    }
    return sum / points;
  }

  check("click spectrum: every octave from 500 Hz to 8 kHz within 6 dB of the loudest", () => {
    const one = t.clickTrainSamples(SR, [0]);
    const bands = [500, 1000, 2000, 4000, 8000].map((fc) => [fc, 10 * Math.log10(octavePower(one, SR, fc))]);
    const top = Math.max(...bands.map((b) => b[1]));
    for (const [fc, db] of bands) assert.ok(db >= top - 6, `${fc} Hz octave is ${(db - top).toFixed(1)} dB down`);
  });

  // Small earbuds held to a mic: little below 1 kHz or above 6 kHz, and maybe inverted.
  function earbudPath(x, sr) {
    const hp = Math.exp((-2 * Math.PI * 1000) / sr);
    const lp = Math.exp((-2 * Math.PI * 6000) / sr);
    const out = new Float32Array(x.length);
    let hpPrevIn = 0, hpPrevOut = 0, lpPrev = 0;
    for (let i = 0; i < x.length; i++) {
      const h = hp * (hpPrevOut + x[i] - hpPrevIn);
      hpPrevIn = x[i];
      hpPrevOut = h;
      lpPrev = (1 - lp) * h + lp * lpPrev;
      out[i] = -lpPrev;
    }
    return out;
  }

  check("clicks through small inverted earbuds at -30 dB in noise are found within 2 ms", () => {
    const rec = noise(2.0, 0.002, 5);
    addAt(rec, earbudPath(train, SR), 0.211, minus30dB);
    const r = t.findClickTrainLag(rec, SR, t.CLICK_TIMES_SEC, 600);
    assert.ok(Math.abs(r.lagMs - 211) <= 2, `lag ${r.lagMs}`);
    assert.strictEqual(r.confident, true);
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

  // Claps on beats 3 to 8 at exact per-beat lags (ms); null skips that beat.
  function clapsAt(lagsMs, seed) {
    const rec = noise(5.0, 0.002, seed);
    t.CLAP_BEAT_SEC.slice(2).forEach((b, i) => {
      if (lagsMs[i] === null || lagsMs[i] === undefined) return;
      const burst = noise(0.03, 0.2, seed + i + 1);
      for (let k = 0; k < burst.length; k++) burst[k] *= Math.exp(-k / (0.006 * SR));
      addAt(rec, burst, b + lagsMs[i] / 1000, 1);
    });
    return rec;
  }

  check("clap-along: human spread plus one outlier is kept, lag is the in-window median", () => {
    const r = t.findClapLag(clapsAt([180, 195, 170, 188, 176, 330], 21), SR, t.CLAP_BEAT_SEC);
    assert.ok(r, "expected a result");
    assert.strictEqual(r.lags.length, 6);
    assert.ok(r.inWindow >= 4, `inWindow ${r.inWindow}`);
    assert.strictEqual(r.inWindow, 5);
    assert.ok(Math.abs(r.lagMs - 180) <= 3, `lag ${r.lagMs}`);
  });

  check("clap-along: 3 hits returns null", () => {
    assert.strictEqual(t.findClapLag(clapsAt([180, null, 190, null, 175, null], 31), SR, t.CLAP_BEAT_SEC), null);
  });

  check("clap-along: scattered hits leave fewer than 4 in the window", () => {
    const r = t.findClapLag(clapsAt([0, 300, -100, 200, 100, 50], 41), SR, t.CLAP_BEAT_SEC);
    assert.ok(r, "expected a result");
    assert.strictEqual(r.lags.length, 6);
    assert.ok(r.inWindow < 4, `inWindow ${r.inWindow}`);
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
      assert.ok(s.node.buffer && s.node.buffer.length === Math.round(0.005 * SR));
    });
    assert.strictEqual(engine.currentPlayingNodes.length, t.CLICK_TIMES_SEC.length);
    assert.ok(Math.abs(end - (10 + 0.3 + 1.2 + 0.005)) < 1e-6, `end ${end}`);
    const peakOf = (buf) => buf.getChannelData(0).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(Math.abs(peakOf(started[0].node.buffer) - t.CLICK_PEAK) < 1e-3, "sync clicks play at full level");

    // The clap beat is heard in the ears, so it plays softer when asked.
    started.length = 0;
    engine.playClickTrain(t.CLAP_BEAT_SEC, 0.8, 0.3);
    assert.strictEqual(started.length, 8);
    assert.ok(Math.abs(peakOf(started[0].node.buffer) - 0.3 * t.CLICK_PEAK) < 1e-3, "level scales the clicks");
  });

  console.log(`ALL ${passed} MIC SYNC TIMING CHECKS PASSED`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
