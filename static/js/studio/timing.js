// timing.js - Mic sync measurement: pure functions, no DOM.
//
// The studio plays a short click train and records it back through the mic
// (or the user claps along to steady beats) to measure how late a take
// arrives on this input + output pair. Times are relative to the first
// sample of the recording; the caller subtracts its own scheduling lead.

// Irregular spacing so only one lag lines every click up.
export const CLICK_TIMES_SEC = [0, 0.17, 0.42, 0.61, 0.93, 1.2];

// Clap-along fallback: 8 steady beats, 0.6 s apart (100 BPM).
export const CLAP_BEAT_SEC = [0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2];

// Each click is a 5 ms sweep from 400 Hz to 10 kHz at -1 dBFS peak: loud and broad,
// so small earbuds held to the mic still get through whatever band they play best.
export const CLICK_PEAK = Math.pow(10, -1 / 20);
const CLICK_LEN_SEC = 0.005;
const CLICK_LOW_HZ = 400;
const CLICK_HIGH_HZ = 10000;
// The pitch rises as time to this power: a touch slower at the low end than a straight
// sweep, which keeps every octave from 500 Hz to 8 kHz within a few dB of the others.
const CLICK_SWEEP_POWER = 1.25;
// Share of the click at each end that fades in or out (Tukey window).
const CLICK_TAPER = 0.1;

// The sweep and its quadrature twin, each with peak 1. The matched filter uses both,
// so the speaker's and mic's phase shifts don't matter.
function clickBurst(sampleRate) {
  const n = Math.max(2, Math.round(CLICK_LEN_SEC * sampleRate));
  const high = Math.min(CLICK_HIGH_HZ, 0.45 * sampleRate);
  const len = n / sampleRate;
  const edge = CLICK_TAPER * (n - 1) / 2;
  const sin = new Float32Array(n);
  const cos = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sweep = ((high - CLICK_LOW_HZ) * len * Math.pow(t / len, CLICK_SWEEP_POWER + 1)) / (CLICK_SWEEP_POWER + 1);
    const phase = 2 * Math.PI * (CLICK_LOW_HZ * t + sweep);
    const fromEnd = Math.min(i, n - 1 - i);
    const taper = fromEnd >= edge ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / edge);
    sin[i] = taper * Math.sin(phase);
    cos[i] = taper * Math.cos(phase);
    peak = Math.max(peak, Math.abs(sin[i]));
  }
  for (let i = 0; i < n; i++) {
    sin[i] /= peak;
    cos[i] /= peak;
  }
  return { sin, cos };
}

// One click at each of `times` (seconds), peak CLICK_PEAK.
export function clickTrainSamples(sampleRate, times) {
  const { sin } = clickBurst(sampleRate);
  const click = sin.map((v) => v * CLICK_PEAK);
  const last = times.length ? Math.max(...times) : 0;
  const out = new Float32Array(Math.round(last * sampleRate) + click.length);
  for (const t of times) {
    const start = Math.round(t * sampleRate);
    out.set(click, start);
  }
  return out;
}

// Matched filter: at each lag, the summed (phase-free) match of every click.
// Confident when the top peak is at least 1.8x the best peak more than 10 ms away.
export function findClickTrainLag(samples, sampleRate, times, maxLagMs) {
  const { sin, cos } = clickBurst(sampleRate);
  const n = sin.length;
  const starts = times.map(t => Math.round(t * sampleRate));
  const maxLag = Math.max(0, Math.round((maxLagMs / 1000) * sampleRate));
  const scores = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let score = 0;
    for (const s of starts) {
      const base = s + lag;
      if (base + n > samples.length) continue;
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const v = samples[base + i];
        re += v * sin[i];
        im += v * cos[i];
      }
      score += Math.sqrt(re * re + im * im);
    }
    scores[lag] = score;
  }

  let best = 0;
  for (let lag = 1; lag <= maxLag; lag++) if (scores[lag] > scores[best]) best = lag;
  const guard = Math.round(0.01 * sampleRate);
  let runnerUp = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    if (Math.abs(lag - best) > guard && scores[lag] > runnerUp) runnerUp = scores[lag];
  }
  const top = scores[best];
  return {
    lagMs: (best / sampleRate) * 1000,
    confident: top > 0 && top >= 1.8 * runnerUp,
  };
}

const CLAP_WINDOW_MS = 40;
// Only claps count: a sharp sound well above the room, not talking, typing or hum.
// The first 300 ms can hold the click of the recording starting.
const CLAP_SKIP_MS = 300;
// The room's noise floor is also measured in the quiet before the first beat (from
// CLAP_SKIP_MS up to CLAP_EARLY_MS before it), when that is at least CLAP_FLOOR_MIN_MS long.
const CLAP_FLOOR_MIN_MS = 100;
// Energy ratios on the 1 ms envelope: a clap starts 10 dB and peaks 15 dB over the floor,
// and peaks 10 dB over the 20 ms before it; within CLAP_RISE_MS of starting it is within
// 3 dB of its peak over the next 30 ms.
const CLAP_ONSET_OVER_FLOOR = 10;
const CLAP_PEAK_OVER_FLOOR = 31.6;
const CLAP_JUMP = 10;
const CLAP_RISE_MS = 5;
const CLAP_REFRACTORY_MS = 100;
// A hit for a beat is the clap nearest it within CLAP_EARLY_MS before to CLAP_LATE_MS after.
const CLAP_EARLY_MS = 150;
const CLAP_LATE_MS = 400;
// More claps than this away from every beat means the room, not the actor, was heard.
const CLAP_MAX_STRAYS = 3;
const CLAP_MIN_AGREE = 4;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// The 1 ms energy envelope.
function energyEnvelope(samples, sampleRate) {
  const frame = Math.max(1, Math.round(sampleRate / 1000));
  const frames = Math.floor(samples.length / frame);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    env[f] = sum / frame;
  }
  return { env, frameMs: (frame * 1000) / sampleRate };
}

// Clap-along: sharp onsets (see the CLAP_ constants) in ms; for beats 3 to 8, the onset
// nearest each beat within -150..+400 ms. Needs 4 hits, otherwise null.
// `inWindow` counts the hits within CLAP_WINDOW_MS of their median; `strays` counts the
// claps more than CLAP_EARLY_MS from every beat (at that median delay).
export function findClapLag(samples, sampleRate, beatTimes) {
  const { env, frameMs } = energyEnvelope(samples, sampleRate);
  const skip = Math.ceil(CLAP_SKIP_MS / frameMs);
  if (env.length <= skip) return null;
  const quietEnd = Math.floor((beatTimes[0] * 1000 - CLAP_EARLY_MS) / frameMs);
  // The louder of the quiet before the beats and the whole run, so noise that starts
  // with the beat counts too.
  let floor = Math.max(median(env.subarray(skip)), 1e-10);
  if (quietEnd - skip >= CLAP_FLOOR_MIN_MS / frameMs) floor = Math.max(floor, median(env.subarray(skip, quietEnd)));
  let peak = 0;
  for (let f = skip; f < env.length; f++) if (env[f] > peak) peak = env[f];
  const threshold = Math.max(floor * CLAP_ONSET_OVER_FLOOR, peak * 0.02);
  if (!(peak >= floor * CLAP_PEAK_OVER_FLOOR)) return null;

  const onsetsMs = [];
  const look = Math.max(1, Math.round(30 / frameMs));
  const before = Math.max(1, Math.round(20 / frameMs));
  for (let f = Math.max(1, skip); f < env.length; f++) {
    if (!(env[f] >= threshold && env[f - 1] < threshold)) continue;
    const ms = f * frameMs;
    if (onsetsMs.length && ms - onsetsMs[onsetsMs.length - 1] < CLAP_REFRACTORY_MS) continue;
    let top = 0;
    let early = 0;
    for (let k = f; k < Math.min(env.length, f + look); k++) {
      top = Math.max(top, env[k]);
      if ((k - f) * frameMs <= CLAP_RISE_MS) early = top;
    }
    let prior = 0;
    let count = 0;
    for (let k = Math.max(skip, f - before - 2); k < f - 2; k++) { prior += env[k]; count++; }
    prior = count ? prior / count : 0;
    const sharp = early >= top / 2 && top >= floor * CLAP_PEAK_OVER_FLOOR && top >= CLAP_JUMP * prior;
    if (sharp) onsetsMs.push(ms);
  }

  const lags = [];
  for (const beat of beatTimes.slice(2, 8)) {
    const beatMs = beat * 1000;
    let nearest = null;
    for (const onset of onsetsMs) {
      const lag = onset - beatMs;
      if (lag < -CLAP_EARLY_MS || lag > CLAP_LATE_MS) continue;
      if (nearest === null || Math.abs(lag) < Math.abs(nearest)) nearest = lag;
    }
    if (nearest !== null) lags.push(nearest);
  }
  if (lags.length < CLAP_MIN_AGREE) return null;
  // Human claps wander; the lag is the median of the hits within 40 ms of the overall median.
  const center = median(lags);
  const near = lags.filter(lag => Math.abs(lag - center) <= CLAP_WINDOW_MS);
  const strays = onsetsMs.filter(onset => !beatTimes.some(
    beat => Math.abs(onset - beat * 1000 - center) <= CLAP_EARLY_MS)).length;
  return {
    lagMs: median(near),
    spreadMs: Math.max(...lags) - Math.min(...lags),
    hits: lags.length,
    lags,
    inWindow: near.length,
    strays,
  };
}

// What a clap run heard: 'ok' (save found.lagMs), 'quiet' (no claps), 'noisy' (sharp
// sounds away from the beats) or 'uneven' (claps that don't agree).
export function judgeClaps(found) {
  if (!found) return 'quiet';
  if (found.strays > CLAP_MAX_STRAYS) return 'noisy';
  return found.inWindow >= CLAP_MIN_AGREE ? 'ok' : 'uneven';
}

// Median and spread (max - min) of several runs.
export function combineRuns(lags) {
  return {
    medianMs: median(lags),
    spreadMs: lags.length ? Math.max(...lags) - Math.min(...lags) : NaN,
  };
}

// Storage key for an input + output pair; a missing label reads as 'default'.
// Each part is capped so the key stays within the engine's 200-character limit.
export function devicePairKey(inputLabel, outputLabel) {
  const part = label => (String(label || '').trim() || 'default').slice(0, 95);
  return `${part(inputLabel)}|${part(outputLabel)}`;
}

// Nearest multiple of 5 ms.
export function snapMs(ms) {
  return Math.round(ms / 5) * 5 + 0;
}
