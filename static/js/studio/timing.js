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

const CLICK_FREQ_HZ = 2000;
const CLICK_LEN_SEC = 0.004;

function clickBurst(sampleRate) {
  const n = Math.max(2, Math.round(CLICK_LEN_SEC * sampleRate));
  const sin = new Float32Array(n);
  const cos = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * CLICK_FREQ_HZ * i) / sampleRate;
    sin[i] = hann * Math.sin(phase);
    cos[i] = hann * Math.cos(phase);
  }
  return { sin, cos };
}

// 4 ms Hann-windowed 2 kHz bursts at `times` (seconds), peak 1.0.
export function clickTrainSamples(sampleRate, times) {
  const { sin } = clickBurst(sampleRate);
  const last = times.length ? Math.max(...times) : 0;
  const out = new Float32Array(Math.round(last * sampleRate) + sin.length);
  for (const t of times) {
    const start = Math.round(t * sampleRate);
    out.set(sin, start);
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

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Clap-along: onsets from a 1 ms energy envelope; for beats 3 to 8, the onset
// nearest each beat within -150..+400 ms. Needs 4 hits, otherwise null.
// `inWindow` counts the hits within CLAP_WINDOW_MS of their median.
export function findClapLag(samples, sampleRate, beatTimes) {
  const frame = Math.max(1, Math.round(sampleRate / 1000));
  const frames = Math.floor(samples.length / frame);
  if (!frames) return null;
  const env = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    env[f] = sum / frame;
    if (env[f] > peak) peak = env[f];
  }
  const floor = median(env);
  const threshold = Math.max(floor * 10, peak * 0.02);
  if (!(peak > threshold)) return null;

  const onsetsMs = [];
  const refractoryMs = 100;
  for (let f = 1; f < frames; f++) {
    if (env[f] >= threshold && env[f - 1] < threshold) {
      const ms = (f * frame * 1000) / sampleRate;
      if (!onsetsMs.length || ms - onsetsMs[onsetsMs.length - 1] >= refractoryMs) onsetsMs.push(ms);
    }
  }

  const lags = [];
  for (const beat of beatTimes.slice(2, 8)) {
    const beatMs = beat * 1000;
    let nearest = null;
    for (const onset of onsetsMs) {
      const lag = onset - beatMs;
      if (lag < -150 || lag > 400) continue;
      if (nearest === null || Math.abs(lag) < Math.abs(nearest)) nearest = lag;
    }
    if (nearest !== null) lags.push(nearest);
  }
  if (lags.length < 4) return null;
  // Human claps wander; the lag is the median of the hits within 40 ms of the overall median.
  const center = median(lags);
  const near = lags.filter(lag => Math.abs(lag - center) <= CLAP_WINDOW_MS);
  return {
    lagMs: median(near),
    spreadMs: Math.max(...lags) - Math.min(...lags),
    hits: lags.length,
    lags,
    inWindow: near.length,
  };
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
