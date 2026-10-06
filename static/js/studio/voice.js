// studio/voice.js - The take's voice chain in the studio: which chain a take plays
// (resolveChain), its label, the Tone curve, the level gain, and the scheduler that asks
// the engine for renders. Pure ESM with no DOM, so node tests import it directly.
// The engine renders every sound (documentation/design/effects-rack.md, "Optimistic preview").

// The engine's Clean chain (dubmate/vocal_chain.py CLEAN): the sound of a take when
// nothing more specific is set. tests/test_voice_preview.js checks it against
// tests/fixtures/chain_resolution.json, which tests/test_vocal_chain.py checks against the engine.
export const CLEAN_CHAIN = {
  v: 1,
  preset: 'clean',
  nodes: {
    lowcut: { on: true, mix: 1.0, hz: 80.0 },
    gate: { on: false, mix: 1.0, threshold_db: -50.0 },
    eq: { on: false, mix: 1.0, low_db: 0.0, mid_db: 0.0, mid_hz: 1500.0, high_db: 0.0 },
    deess: { on: false, mix: 1.0, threshold_db: -30.0, hz: 6000.0 },
    comp: { on: false, mix: 1.0, threshold_db: -18.0, ratio: 3.0, makeup_db: 0.0 },
    pitch: { on: false, mix: 1.0, semitones: 0 },
    reverb: { on: false, mix: 0.3, decay_s: 1.5, predelay_ms: 20.0 },
  },
};

// Same clamp as the export's level (audio_processor GAIN_DB_MIN..GAIN_DB_MAX).
export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 24;

// Tone's fixed shelves (vocal_chain EQ_LOW_SHELF_HZ, EQ_HIGH_SHELF_HZ, EQ_MID_Q; pedalboard's
// shelf q is 1/sqrt(2)).
const EQ_LOW_SHELF_HZ = 150;
const EQ_HIGH_SHELF_HZ = 6000;
const EQ_MID_Q = 1.0;
const SHELF_Q = Math.SQRT1_2;

const copyChain = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** The most specific chain that exists, each level replacing the whole chain:
 *  the take's own chain, then its character's, then every line's, then Clean. A copy. */
export function resolveChain(voice, character, take) {
  const characters = isPlainObject(voice?.characters) ? voice.characters : {};
  const candidates = [
    isPlainObject(take) ? take.chain : null,
    character != null ? characters[character] : null,
    isPlainObject(voice) ? voice.session : null,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) return copyChain(candidate);
  }
  return copyChain(CLEAN_CHAIN);
}

/** The chain with one node's params changed. Any edit makes it a custom sound. */
export function editChain(chain, name, params) {
  const out = copyChain(isPlainObject(chain) ? chain : CLEAN_CHAIN);
  out.nodes = isPlainObject(out.nodes) ? out.nodes : {};
  out.nodes[name] = { ...CLEAN_CHAIN.nodes[name], ...out.nodes[name], ...params };
  out.preset = null;
  return out;
}

/** The preset's name ("Warm") for an untouched preset chain, else "Custom". */
export function presetLabel(chain, presets) {
  const id = chain?.preset;
  const preset = id ? (presets || []).find((p) => p.id === id) : null;
  return preset ? preset.name : 'Custom';
}

/** Linear gain for a level in dB, clamped like the export's. */
export function levelGain(db) {
  const value = Number(db);
  const clamped = Number.isFinite(value) ? Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, value)) : 0;
  return Math.pow(10, clamped / 20);
}

// RBJ cookbook biquads as [b0, b1, b2, a0, a1, a2].
function rbjShelf(kind, hz, db, sr) {
  const A = Math.pow(10, db / 40);
  const w0 = (2 * Math.PI * hz) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * SHELF_Q);
  const s = 2 * Math.sqrt(A) * alpha;
  if (kind === 'low') {
    return [A * ((A + 1) - (A - 1) * cos + s), 2 * A * ((A - 1) - (A + 1) * cos), A * ((A + 1) - (A - 1) * cos - s),
      (A + 1) + (A - 1) * cos + s, -2 * ((A - 1) + (A + 1) * cos), (A + 1) + (A - 1) * cos - s];
  }
  return [A * ((A + 1) + (A - 1) * cos + s), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - s),
    (A + 1) - (A - 1) * cos + s, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - s];
}

function rbjPeak(hz, db, q, sr) {
  const A = Math.pow(10, db / 40);
  const w0 = (2 * Math.PI * hz) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
}

// Complex response [re, im] of a biquad at angular frequency w.
function biquadResponse([b0, b1, b2, a0, a1, a2], w) {
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  const d = dr * dr + di * di;
  return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d];
}

/** Tone's curve in dB at each frequency (for drawing only): low shelf, mid peak and
 *  high shelf, blended with the dry voice by the node's Mix. 0 dB everywhere when off. */
export function eqCurveDb(eq, freqs, sr = 44100) {
  if (!isPlainObject(eq) || !eq.on) return freqs.map(() => 0);
  const mix = Number.isFinite(eq.mix) ? eq.mix : 1;
  const filters = [
    rbjShelf('low', EQ_LOW_SHELF_HZ, eq.low_db || 0, sr),
    rbjPeak(eq.mid_hz || 1500, eq.mid_db || 0, EQ_MID_Q, sr),
    rbjShelf('high', EQ_HIGH_SHELF_HZ, eq.high_db || 0, sr),
  ];
  return freqs.map((f) => {
    const w = (2 * Math.PI * Math.min(Math.max(f, 1), sr / 2 - 1)) / sr;
    let re = 1, im = 0;
    for (const filter of filters) {
      const [hr, hi] = biquadResponse(filter, w);
      [re, im] = [re * hr - im * hi, re * hi + im * hr];
    }
    // dry + mix * (wet - dry)
    const r = 1 + mix * (re - 1), i = mix * im;
    return 10 * Math.log10(Math.max(r * r + i * i, 1e-12));
  });
}

/**
 * Asks the engine for renders of the chain the controls show, without flooding it.
 * want() restarts a debounce; when it fires, request(chain, { untilS }) runs. A response
 * that isn't for the newest want() is dropped, a 409 (superseded on the engine) is
 * ignored and a 503 moves to "unavailable". While playing a take longer than 4 s, the
 * 2 s after the playhead are rendered first (untilS), then the whole take.
 *
 * request resolves to { status: 200, ...render } | { status: 409 } | { status: 503, message };
 * onReady({ ...render, chain, untilS, partial }) gets each render that is still wanted.
 * States: current -> waiting (debounce) -> rendering -> current, or unavailable.
 */
export function createRenderScheduler({
  debounceMs = 120,
  request,
  onReady,
  onState = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let seq = 0;
  let state = 'current';
  let timer = null;
  let pending = null;
  let disposed = false;

  const setState = (next) => {
    if (disposed || next === state) return;
    state = next;
    onState(next);
  };
  const isLatest = (n) => !disposed && n === seq;

  // 'ready' | 'stale' | 'superseded' | 'unavailable' | 'failed'
  async function run(n, chain, untilS) {
    let res;
    try {
      res = await request(chain, { untilS });
    } catch (err) {
      return isLatest(n) ? 'failed' : 'stale';
    }
    if (!isLatest(n)) return 'stale';
    if (!res || res.status === 409) return 'superseded';
    if (res.status === 503) {
      setState('unavailable');
      return 'unavailable';
    }
    onReady({ ...res, chain, untilS, partial: untilS != null });
    return 'ready';
  }

  async function fire() {
    timer = null;
    const { n, chain, opts, at } = pending;
    pending = null;
    setState('rendering');
    if (opts.playing && opts.takeDuration > 4) {
      const playheadS = Math.max(0, (Number(opts.playheadS) || 0) + Math.max(0, now() - at) / 1000);
      const untilS = Math.round((playheadS + 2) * 1000) / 1000;
      if (untilS < opts.takeDuration) {
        const first = await run(n, chain, untilS);
        if (first === 'stale' || first === 'unavailable') return;
      }
    }
    const outcome = await run(n, chain, null);
    if (outcome !== 'stale' && outcome !== 'unavailable') setState('current');
  }

  return {
    want(chain, opts = {}) {
      if (disposed) return;
      seq += 1;
      pending = { n: seq, chain, opts, at: now() };
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, debounceMs);
      setState('waiting');
    },
    get state() { return state; },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}
