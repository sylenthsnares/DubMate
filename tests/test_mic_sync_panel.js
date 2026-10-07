/**
 * test_mic_sync_panel.js
 *
 * The Timing row in Audio settings (static/js/studio/mic_sync.js): "Sync your mic"
 * plays a click pattern three times and listens for it; when the clicks aren't heard
 * the user claps along instead; a bad clap run saves nothing. The audio engine is
 * stubbed: each recording is a synthetic buffer built from timing.js signals.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const timingModule = import(pathToFileURL(path.join(PROJECT_ROOT, "static", "js", "studio", "timing.js")).href);
const { JSDOM, VirtualConsole } = jsdom;

const HOST = "http://127.0.0.1:8000/";
const GUEST = "https://abc.trycloudflare.com/";
const PAIR = "Microphone (Yeti X)|Headphones (Realtek)";
const SR = 16000;
const LEAD_SEC = 0.3;
const CLICKS_COPY = "Hold your headphones against the mic, or turn on your speakers. You'll hear a few clicks.";
const CLAP_COPY = "DubMate couldn't hear the clicks. Clap along with the beat instead.";
const UNEVEN_COPY = "Your claps were uneven. Try again, clapping right on each click.";
const QUIET_COPY = "DubMate couldn't hear your claps. Clap closer to the mic, right on each click.";
const GUEST_TIP = "Your browser keeps this until the host restarts DubMate.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function until(cond, what, ms = 15000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) fail(`timed out waiting for ${what}`);
    await tick(20);
  }
}

const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Microphone (Yeti X)" },
  { kind: "audioinput", deviceId: "usb2", label: "USB Headset Mic" },
  { kind: "audiooutput", deviceId: "default", label: "Headphones (Realtek)" },
];

// Deterministic noise so a run never depends on Math.random.
function noise(length, amplitude, seed = 1) {
  const out = new Float32Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = ((s / 2147483648) * 2 - 1) * amplitude;
  }
  return out;
}

// The recording a click pass would hear: the pattern `delayMs` after it was scheduled.
function heardClicks(timing, times, delayMs) {
  const shifted = times.map((t) => t + LEAD_SEC + delayMs / 1000);
  const clicks = timing.clickTrainSamples(SR, shifted);
  const out = noise(Math.round(3 * SR), 0.002, 7);
  for (let i = 0; i < clicks.length; i++) out[i] += clicks[i] * 0.4;
  return out;
}

// Claps (15 ms noise bursts) on each beat, `delayMs` late plus a per-beat jitter.
function heardClaps(beats, delayMs, jitterMs) {
  const out = new Float32Array(Math.round((LEAD_SEC + beats[beats.length - 1] + 1.5) * SR));
  beats.forEach((beat, i) => {
    const at = Math.round((LEAD_SEC + beat + (delayMs + jitterMs[i % jitterMs.length]) / 1000) * SR);
    const burst = noise(Math.round(0.015 * SR), 0.8, 11 + i);
    for (let k = 0; k < burst.length && at + k < out.length; k++) out[at + k] = burst[k];
  });
  return out;
}

/** Boots the studio with Audio settings open on the devices step and a stubbed audio engine. */
async function boot(url, { stored = null } = {}) {
  const timing = await timingModule;
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  if (stored !== null) w.localStorage.setItem("dubmate_mic_sync", stored);
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} }; }
    createConvolver() { return { connect: () => {} }; }
  };
  w.scrollTo = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => DEVICES, addEventListener: () => {} },
  });

  const calls = [];
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.startsWith("/api/packs")) return json([]);
    if (u.startsWith("/api/config")) return json({ mic_sync: {} });
    return json({});
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);

  const toasts = [];
  app.showToast = (msg) => toasts.push(msg);

  // Stubbed engine: what each recording "hears" is chosen by the test.
  const audio = app.audio;
  const log = { started: 0, stopped: 0, played: [], levels: [], stopAll: 0, meterOn: 0, meterOff: 0 };
  const env = { w, app, calls, toasts, errors, log, timing, hear: { clicks: "delayed", claps: "steady" } };
  let lastTimes = null;
  audio.ctx = { sampleRate: SR, currentTime: 0, outputLatency: 0.01, baseLatency: 0.005 };
  audio.initContext = () => {};
  audio.getMicPermissionState = async () => "granted";
  audio.supportsOutputRouting = () => true;
  audio.setPreferredOutputDevice = async () => ({ ok: true });
  audio.startInputMonitor = async () => { log.meterOn++; return {}; };
  audio.stopInputMonitor = () => { log.meterOff++; };
  audio.readInputLevel = () => ({ rmsDb: -60, peakDb: -60 });
  audio.startRecording = async () => {
    log.started++;
    audio.isRecording = true;
    audio.stream = { getAudioTracks: () => [{ getSettings: () => ({ latency: 0.01 }) }] };
  };
  audio.playClickTrain = (times, lead, level) => {
    if (lead !== LEAD_SEC) fail(`click lead ${lead}`);
    lastTimes = times;
    log.played.push(times.length);
    log.levels.push(level);
    return audio.ctx.currentTime;
  };
  audio.stopRecording = async () => {
    log.stopped++;
    audio.isRecording = false;
    audio.stream = null;
    let samples;
    if (lastTimes.length === timing.CLICK_TIMES_SEC.length) {
      samples = env.hear.clicks === "delayed" ? heardClicks(timing, timing.CLICK_TIMES_SEC, 140) : noise(3 * SR, 0.05, 3);
    } else {
      const jitter = env.hear.claps === "steady" ? [0, 6, -4, 8, -6, 2, 4, -2] : [0, 90, -60, 120, -80, 40, 100, -50];
      samples = env.hear.claps === "none" ? noise(6 * SR, 0.002, 5) : heardClaps(timing.CLAP_BEAT_SEC, 150, jitter);
    }
    return { blob: new w.Blob(["x"]), audioBuffer: { sampleRate: SR, getChannelData: () => samples } };
  };
  audio.stopAllPlayback = () => { log.stopAll++; };

  await app.openAudioSettings();
  await tick(50);
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const shown = (el) => !!el && el.style.display !== "none";
const text = (el) => (el.textContent || "").trim();
const stored = (env) => JSON.parse(env.w.localStorage.getItem("dubmate_mic_sync") || "{}");

(async () => {
  // 1. The row, the panel, and a click run that finds the clicks.
  {
    const env = await boot(HOST);
    const status = $(env, "mic-sync-status");
    const btn = $(env, "btn-mic-sync");
    if (!shown($(env, "audio-setup-step-devices"))) fail("devices step not shown");
    if (text(status) !== "Not synced yet") fail(`status: ${text(status)}`);
    if (text(btn) !== "Sync your mic") fail(`button: ${text(btn)}`);
    if (shown($(env, "mic-sync-panel"))) fail("panel visible before Sync your mic");
    if (status.hasAttribute("data-tip")) fail("host status has the guest tooltip");

    btn.click();
    if (!shown($(env, "mic-sync-panel"))) fail("panel did not open");
    if (text($(env, "mic-sync-message")) !== CLICKS_COPY) fail(`instruction: ${text($(env, "mic-sync-message"))}`);
    if (!shown($(env, "btn-start-mic-sync")) || shown($(env, "btn-start-clapping"))) fail("ready state shows the wrong buttons");
    if (env.w.document.activeElement !== $(env, "btn-start-mic-sync")) fail("Start not focused");
    if (env.log.started) fail("opening the panel started recording");

    const meterOffBefore = env.log.meterOff;
    const meterOnBefore = env.log.meterOn;
    $(env, "btn-start-mic-sync").click();
    if (env.log.meterOff <= meterOffBefore) fail("input meter not stopped for the sync");
    if (!$(env, "btn-start-mic-sync").disabled) fail("Start stays enabled while listening");
    await until(() => !env.app.micSyncBusy, "the click run");
    if (env.log.started !== 3 || env.log.stopped !== 3) fail(`click passes: ${env.log.started} started, ${env.log.stopped} stopped`);
    if (env.log.played.join() !== "6,6,6") fail(`played: ${env.log.played.join()}`);
    if (env.log.levels.some((l) => l !== 1)) fail(`sync clicks not at full level: ${env.log.levels.join()}`);
    const entry = stored(env)[PAIR];
    if (!entry || entry.latency_ms !== 140 || entry.method !== "clicks") fail(`saved: ${JSON.stringify(stored(env))}`);
    if (text(status) !== "Synced. New takes move 140 ms earlier.") fail(`status after sync: ${text(status)}`);
    if (text(btn) !== "Sync again") fail(`button after sync: ${text(btn)}`);
    if (shown($(env, "mic-sync-panel"))) fail("panel still open after a good sync");
    if (env.log.meterOn <= meterOnBefore) fail("input meter not restored after the sync");
    const post = env.calls.find((c) => c.url === "/api/config" && c.method === "POST");
    if (!post || JSON.parse(post.body).mic_sync[PAIR].latency_ms !== 140) fail("host sync not kept in the engine config");
    console.log("PASS: Sync your mic hears the clicks, saves 140 ms (clicks) and the row reads 'Synced' / 'Sync again'");

    // 7. A new microphone and output pair is not synced; the old one still is.
    const input = $(env, "select-audio-input");
    input.value = "usb2";
    input.dispatchEvent(new env.w.Event("change"));
    await tick(50);
    if (text(status) !== "Not synced yet" || text(btn) !== "Sync your mic") fail(`new pair: ${text(status)} / ${text(btn)}`);
    input.value = "";
    input.dispatchEvent(new env.w.Event("change"));
    await tick(50);
    if (text(status) !== "Synced. New takes move 140 ms earlier.") fail(`back to the synced pair: ${text(status)}`);
    console.log("PASS: switching to a new device pair shows 'Not synced yet'");
    if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  }

  // 2. No clicks heard: the clap test, then a steady clap run saves 'claps'.
  {
    const env = await boot(HOST);
    env.hear.clicks = "none";
    $(env, "btn-mic-sync").click();
    $(env, "btn-start-mic-sync").click();
    await until(() => !env.app.micSyncBusy, "the click run");
    if (text($(env, "mic-sync-message")) !== CLAP_COPY) fail(`clap copy: ${text($(env, "mic-sync-message"))}`);
    if (!shown($(env, "btn-start-clapping")) || shown($(env, "btn-start-mic-sync"))) fail("clap state shows the wrong buttons");
    if (text($(env, "btn-start-clapping")) !== "Start clapping") fail("Start clapping label");
    if (env.w.localStorage.getItem("dubmate_mic_sync") !== null) fail("a failed click run saved something");
    if (text($(env, "mic-sync-status")) !== "Not synced yet") fail("status changed without a sync");
    console.log("PASS: when the clicks aren't heard, the clap test is offered");

    env.hear.claps = "steady";
    $(env, "btn-start-clapping").click();
    if (!$(env, "btn-start-clapping").disabled) fail("Start clapping stays enabled while listening");
    await until(() => !env.app.micSyncBusy, "the clap run");
    if (env.log.played[env.log.played.length - 1] !== 8) fail(`clap run played ${env.log.played.join()}`);
    const beatLevel = env.log.levels[env.log.levels.length - 1];
    if (!(beatLevel > 0 && beatLevel <= 0.35)) fail(`clap beat (heard in the ears) at level ${beatLevel}`);
    const entry = stored(env)[PAIR];
    if (!entry || entry.method !== "claps" || entry.latency_ms !== 150) fail(`clap sync saved ${JSON.stringify(stored(env))}`);
    if (text($(env, "mic-sync-status")) !== "Synced. New takes move 150 ms earlier.") fail(`status: ${text($(env, "mic-sync-status"))}`);
    if (shown($(env, "mic-sync-panel"))) fail("panel open after a good clap run");
    console.log("PASS: a steady clap run saves the delay with method 'claps'");
  }

  // 3. Claps that don't line up: the failure copy, nothing saved.
  {
    const before = JSON.stringify({ "Other mic|Other output": { latency_ms: 60, method: "clicks", measured_at: 1 } });
    const env = await boot(HOST, { stored: before });
    env.hear.clicks = "none";
    env.hear.claps = "jittered";
    $(env, "btn-mic-sync").click();
    $(env, "btn-start-mic-sync").click();
    await until(() => !env.app.micSyncBusy, "the click run");
    $(env, "btn-start-clapping").click();
    await until(() => !env.app.micSyncBusy, "the clap run");
    if (text($(env, "mic-sync-message")) !== UNEVEN_COPY) fail(`failure copy: ${text($(env, "mic-sync-message"))}`);
    if (!$(env, "mic-sync-panel").classList.contains("is-error")) fail("failure not styled as an error");
    if (!shown($(env, "btn-start-clapping")) || $(env, "btn-start-clapping").disabled) fail("cannot try clapping again");
    if (env.w.localStorage.getItem("dubmate_mic_sync") !== before) fail("a failed clap run changed the stored syncs");
    if (env.calls.some((c) => c.url === "/api/config" && c.method === "POST")) fail("a failed run wrote the engine config");
    if (text($(env, "mic-sync-status")) !== "Not synced yet") fail("status changed after a failed run");
    console.log("PASS: claps that don't line up show the failure copy and save nothing");

    // Claps that weren't heard at all: the "couldn't hear" line, still an error step.
    env.hear.claps = "none";
    $(env, "btn-start-clapping").click();
    await until(() => !env.app.micSyncBusy, "the quiet clap run");
    if (text($(env, "mic-sync-message")) !== QUIET_COPY) fail(`quiet copy: ${text($(env, "mic-sync-message"))}`);
    if (!$(env, "mic-sync-panel").classList.contains("is-error")) fail("quiet failure not styled as an error");
    if (!shown($(env, "btn-start-clapping")) || $(env, "btn-start-clapping").disabled) fail("cannot clap again after a quiet run");
    if (env.w.localStorage.getItem("dubmate_mic_sync") !== before) fail("a quiet clap run changed the stored syncs");
    console.log("PASS: claps that weren't heard say so and save nothing");
  }

  // 3b. Microphone errors from getUserMedia get one plain line each.
  {
    const lines = {
      NotAllowedError: "DubMate isn't allowed to use your microphone. Allow it, then try again.",
      NotReadableError: "Another app is using your microphone. Close it and try again.",
      OverconstrainedError: "Your saved microphone isn't connected. Choose another one.",
    };
    for (const [name, line] of Object.entries(lines)) {
      const env = await boot(HOST);
      const audio = env.app.audio;
      env.w.navigator.mediaDevices.getUserMedia = async () => {
        throw Object.assign(new Error(`${name} from the test`), { name });
      };
      audio.startRecording = () => audio.requestMicrophone();
      env.toasts.length = 0;
      $(env, "btn-mic-sync").click();
      $(env, "btn-start-mic-sync").click();
      await until(() => !env.app.micSyncBusy, `the ${name} run`);
      if (env.toasts[env.toasts.length - 1] !== line) fail(`${name} toast: ${JSON.stringify(env.toasts)}`);
      if (env.w.localStorage.getItem("dubmate_mic_sync") !== null) fail(`${name} saved something`);
    }
    console.log("PASS: microphone errors show the matching plain line");
  }

  // 4. Cancel mid-run stops recording and playback, restores the meter and saves nothing.
  {
    const env = await boot(HOST);
    $(env, "btn-mic-sync").click();
    $(env, "btn-start-mic-sync").click();
    await until(() => env.log.started === 1, "the first pass");
    const meterOn = env.log.meterOn;
    $(env, "btn-cancel-mic-sync").click();
    if (shown($(env, "mic-sync-panel"))) fail("panel still open after Cancel");
    if (env.log.stopped !== 1 || env.log.stopAll !== 1) fail(`Cancel: stopped ${env.log.stopped}, stopAll ${env.log.stopAll}`);
    if (env.app.micSyncBusy) fail("still busy after Cancel");
    if ($(env, "btn-mic-sync").disabled) fail("Sync your mic disabled after Cancel");
    await tick(50);
    if (env.log.meterOn <= meterOn) fail("input meter not restored after Cancel");
    await tick(1200);
    if (env.log.started !== 1) fail(`the cancelled run kept recording (${env.log.started} passes)`);
    if (env.w.localStorage.getItem("dubmate_mic_sync") !== null) fail("a cancelled run saved something");
    if (text($(env, "mic-sync-status")) !== "Not synced yet") fail("status changed after Cancel");

    // Closing Audio settings mid-run cancels too.
    $(env, "btn-mic-sync").click();
    $(env, "btn-start-mic-sync").click();
    await until(() => env.log.started === 2, "the second run");
    env.app.closeAudioSettings();
    await tick(1200);
    if (env.log.started !== 2 || env.app.micSyncBusy) fail("closing Audio settings did not stop the run");
    if (env.w.localStorage.getItem("dubmate_mic_sync") !== null) fail("a closed run saved something");
    console.log("PASS: Cancel (or closing Audio settings) stops the run, restores the meter and saves nothing");
  }

  // 5. No sync while a take is counting down or recording.
  {
    const env = await boot(HOST);
    for (const state of ["countdown", "recording"]) {
      env.app.recordState = state;
      env.toasts.length = 0;
      await env.app.runMicSync();
      await env.app.runClapSync();
      $(env, "btn-mic-sync").click();
      if (env.log.started) fail(`sync recorded during ${state}`);
      if (shown($(env, "mic-sync-panel"))) fail(`panel opened during ${state}`);
      if (!env.toasts.length) fail(`no explanation during ${state}`);
    }
    console.log("PASS: sync is refused while a take is counting down or recording");
  }

  // 6. Guests see the same row, with a tooltip saying how long it lasts; buttons are keyboard-reachable.
  {
    const env = await boot(GUEST);
    const status = $(env, "mic-sync-status");
    if (text(status) !== "Not synced yet") fail(`guest status: ${text(status)}`);
    if (status.getAttribute("data-tip") !== GUEST_TIP) fail(`guest tooltip: ${status.getAttribute("data-tip")}`);
    if (status.getAttribute("tabindex") !== "0") fail("guest tooltip not reachable by keyboard");
    for (const id of ["btn-mic-sync", "btn-start-mic-sync", "btn-start-clapping", "btn-cancel-mic-sync"]) {
      const b = $(env, id);
      if (!b || b.tagName !== "BUTTON" || b.getAttribute("type") !== "button") fail(`${id} is not a button`);
      if (b.tabIndex < 0 || !text(b)) fail(`${id} is not focusable with a name`);
    }
    if (/latency|loopback|correlation/i.test(text($(env, "mic-sync-row")))) fail("method names on screen");
    console.log("PASS: guests see the row with the tooltip; every button is focusable and named");
  }

  console.log("ALL MIC SYNC PANEL TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
