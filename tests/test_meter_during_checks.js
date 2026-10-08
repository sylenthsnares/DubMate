/**
 * test_meter_during_checks.js
 *
 * The level meter in Audio settings keeps moving while Sync your mic, Check your room
 * and Check your loudest line record, and comes back after they end, fail or are
 * cancelled. The tests still record through a fresh stream of their own (recording-timing
 * decision 2): the meter reads that stream's analyser meanwhile. Runs the real AudioEngine
 * against a fake getUserMedia, AudioContext and MediaRecorder.
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
const SR = 16000;
const LEAD_SEC = 0.3;
const BUSY_LINE = "Another app is using your microphone. Close it and try again.";
const NOT_FOUND_LINE = "No microphone was found. Plug one in and press Rescan.";
const SYNC_HINT = "Syncing. The clicks and claps read loud here, and that's fine.";
const OK_REPORT = {
  verdict: "ok", speech_floor_db: -52.4, rumble_share: 0.71, hum_hz: 50, tones_hz: [50.0, 150.0],
  hiss: false, unstable: true, suppressed: false, clipped: false,
};
const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Microphone (Yeti X)" },
  { kind: "audiooutput", deviceId: "default", label: "Headphones (Realtek)" },
];

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
    await tick(10);
  }
}

// The recording a click pass would hear: the pattern `delayMs` after it was scheduled.
function heardClicks(timing, delayMs) {
  const shifted = timing.CLICK_TIMES_SEC.map((t) => t + LEAD_SEC + delayMs / 1000);
  const clicks = timing.clickTrainSamples(SR, shifted);
  const out = new Float32Array(Math.round(3 * SR));
  for (let i = 0; i < clicks.length; i++) out[i] += clicks[i] * 0.4;
  return out;
}

/** Boots the studio with Audio settings open and the meter running on fake media. */
async function boot() {
  const timing = await timingModule;
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url: HOST, runScripts: "dangerously", virtualConsole });
  const w = dom.window;

  const env = {
    w, errors, toasts: [], timing, streams: [], gumCalls: 0, gumDelay: 0, failNext: 0, failName: "NotFoundError",
    amp: 0.5, gaps: 0, watch: false, raf: new Set(), decoded: null,
  };

  // requestAnimationFrame on timers, with the pending frames visible to the test.
  w.requestAnimationFrame = (cb) => {
    const id = setTimeout(() => { env.raf.delete(id); cb(); }, 16);
    env.raf.add(id);
    return id;
  };
  w.cancelAnimationFrame = (id) => { env.raf.delete(id); clearTimeout(id); };
  // Room checks record 3.3 s: run the clock 20x so they take a moment.
  const t0 = Date.now();
  Object.defineProperty(w.performance, "now", { configurable: true, value: () => (Date.now() - t0) * 20 });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.scrollTo = () => {};
  if (typeof w.Blob.prototype.arrayBuffer !== "function") {
    w.Blob.prototype.arrayBuffer = async function () { return new ArrayBuffer(8); };
  }

  const node = (extra = {}) => ({
    connected: [], disconnected: false,
    connect(n) { this.connected.push(n); if (n && n.isAnalyser) n.source = this; },
    disconnect() { this.disconnected = true; },
    ...extra,
  });
  w.AudioContext = class {
    constructor() {
      this.state = "running"; this.currentTime = 0; this.sampleRate = SR;
      this.outputLatency = 0; this.baseLatency = 0; this.destination = { isDestination: true };
      env.ctx = this;
    }
    resume() { return Promise.resolve(); }
    createGain() { return node({ gain: { value: 1, setValueAtTime() {} } }); }
    createAnalyser() {
      return node({
        isAnalyser: true, fftSize: 2048, smoothingTimeConstant: 0.8, source: null,
        getFloatTimeDomainData(arr) {
          const live = this.source && this.source.stream && this.source.stream.track.readyState === "live";
          arr.fill(live ? env.amp : 0);
        },
      });
    }
    createMediaStreamSource(stream) { return node({ stream }); }
    createBiquadFilter() { return node({ frequency: { value: 0 }, Q: { value: 0 } }); }
    createDynamicsCompressor() { return node({ threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} }); }
    createConvolver() { return node(); }
    decodeAudioData() { return Promise.resolve(env.decoded()); }
  };

  const makeStream = () => {
    const track = {
      kind: "audio", label: "Microphone (Yeti X)", readyState: "live",
      stop() { this.readyState = "ended"; },
      getSettings: () => ({ deviceId: "default", latency: 0.01 }),
    };
    const stream = { id: env.streams.length + 1, track, getTracks: () => [track], getAudioTracks: () => [track] };
    env.streams.push(stream);
    return stream;
  };
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => DEVICES,
      addEventListener: () => {},
      getUserMedia: async () => {
        env.gumCalls++;
        if (env.gumDelay) await tick(env.gumDelay);
        if (env.failNext > 0) {
          env.failNext--;
          const err = new Error("fake getUserMedia failure");
          err.name = env.failName;
          throw err;
        }
        return makeStream();
      },
    },
  });
  w.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = "inactive"; this.mimeType = "audio/webm"; }
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new w.Blob(["x"]) });
        if (this.onstop) this.onstop();
      }, 0);
    }
  };

  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    if (u.startsWith("/api/packs")) return json([]);
    if (u.startsWith("/api/config")) return json({ mic_sync: {} });
    if (u === "/api/noise_profiles" && opts.method === "POST") return json({ profile_id: "3fa9c01b7d2e", report: OK_REPORT });
    return json({});
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  env.app = app;
  env.audio = app.audio;
  app.showToast = (msg) => env.toasts.push(msg);
  env.audio.getMicPermissionState = async () => "granted";
  // The click train itself is not under test: it "ends" 0.1 s after it is scheduled.
  env.audio.playClickTrain = () => 0.1;
  env.decoded = () => ({ sampleRate: SR, getChannelData: () => heardClicks(timing, 140) });

  // Counts any moment the meter has no animation frame pending while the panel is open.
  env.sampler = setInterval(() => {
    if (env.watch && app.isAudioSettingsOpen() && env.raf.size === 0) env.gaps++;
  }, 2);

  await app.openAudioSettings();
  await until(() => env.audio.monitorAnalyser && env.raf.size === 1, "the meter to start");
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
// How far the bar reaches, in percent of the meter.
const fillWidth = (env) => parseFloat($(env, "level-meter-fill").style.width);
const liveStreams = (env) => env.streams.filter((s) => s.track.readyState === "live");

function done(env) {
  clearInterval(env.sampler);
  if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  env.w.close();
}

/** The meter is back on its own stream: one live stream, one frame loop, the bar moving. */
async function expectMeterLive(env, what) {
  await until(() => env.audio.monitorAnalyser && !env.app.micSyncBusy && !env.app.roomCheckBusy, `${what}: meter stream back`);
  await until(() => liveStreams(env).length === 1, `${what}: the test's own stream released (${liveStreams(env).length} live)`, 3000);
  await tick(60);
  if (env.app.audioSetup.meterRaf === null) fail(`${what}: meter loop not scheduled`);
  if (env.raf.size !== 1) fail(`${what}: ${env.raf.size} frame loops`);
  if (liveStreams(env)[0] !== env.audio.monitorStream) fail(`${what}: the live stream is not the meter's`);
  if (!(fillWidth(env) > 50)) fail(`${what}: bar did not move (fill ${fillWidth(env)}%)`);
  if (env.gaps) fail(`${what}: the meter stopped for ${env.gaps} samples`);
}

// Starts each check and returns once it is recording from its own stream.
const CHECKS = {
  "mic sync": {
    start: (env) => $(env, "btn-start-mic-sync").click(),
    open: (env) => $(env, "btn-mic-sync").click(),
    cancel: (env) => $(env, "btn-cancel-mic-sync").click(),
    recording: (env) => env.audio.isRecording,
  },
  "room check": {
    open: (env) => $(env, "btn-room-check").click(),
    start: (env) => $(env, "btn-start-room-check").click(),
    cancel: (env) => $(env, "btn-cancel-room-check").click(),
    recording: (env) => !!env.audio.currentClip,
  },
  "loudest line": {
    open: () => {},
    start: (env) => { env.app.runLoudLineCheck(); },
    cancel: (env) => env.app.cancelRoomCheck(),
    recording: (env) => !!env.audio.currentClip,
  },
};

(async () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    // 1. While the check records, the bar follows its stream; after it, the meter's own stream is back.
    {
      const env = await boot();
      if (name === "loudest line") {
        env.decoded = () => ({ sampleRate: SR, getChannelData: () => new Float32Array(SR * 3).fill(0.3) });
      }
      check.open(env);
      env.watch = true;
      check.start(env);
      await until(() => check.recording(env) && env.audio.recordAnalyser, `${name}: recording`);
      env.amp = 0.5;
      await tick(60);
      if (env.audio.monitorAnalyser) fail(`${name}: the meter kept its own stream open during the check`);
      if (env.audio.recordSource.stream !== env.audio.stream) fail(`${name}: the record analyser is not on the check's stream`);
      if (env.raf.size !== 1) fail(`${name}: meter loop not running during the check (${env.raf.size})`);
      const level = env.audio.readInputLevel();
      if (!level || Math.abs(level.rms - 0.5) > 1e-6) fail(`${name}: readInputLevel during the check: ${JSON.stringify(level)}`);
      if (!(fillWidth(env) > 50)) fail(`${name}: bar frozen during the check (fill ${fillWidth(env)}%)`);
      if (name === "mic sync") {
        // The sync clicks and claps peak near full scale: the hint must not ask for a quieter mic.
        env.amp = 0.99;
        await tick(60);
        const hint = $(env, "level-meter-hint").textContent;
        if (hint !== SYNC_HINT) fail(`mic sync: the hint reads "${hint}" during the sync`);
        env.amp = 0.5;
      }
      await expectMeterLive(env, `${name} done`);
      if (name === "mic sync" && !/140 ms/.test($(env, "mic-sync-status").textContent)) fail("mic sync did not save");
      console.log(`PASS: ${name}: the bar follows the check's stream and the meter is live after it`);
      done(env);
    }

    // 2. The check can't open the mic: the meter is live again.
    {
      const env = await boot();
      check.open(env);
      env.watch = true;
      env.failName = "NotFoundError";
      env.failNext = 2;
      env.gumDelay = 20; // the mic answers after a moment, as a real one does
      check.start(env);
      await until(() => env.toasts.length, `${name}: the error toast`);
      if (env.toasts[0] !== NOT_FOUND_LINE) fail(`${name}: toast ${env.toasts[0]}`);
      await expectMeterLive(env, `${name} failed`);
      console.log(`PASS: ${name}: after a microphone error the meter is live again`);
      done(env);
    }

    // 3. Cancel: the meter is live again.
    {
      const env = await boot();
      check.open(env);
      env.watch = true;
      check.start(env);
      await until(() => check.recording(env), `${name}: recording`);
      check.cancel(env);
      await expectMeterLive(env, `${name} cancelled`);
      console.log(`PASS: ${name}: after Cancel the meter is live again`);
      done(env);
    }
  }

  // 4. The meter can't reopen the mic: the hint says why and the bar rests at the floor.
  {
    const env = await boot();
    $(env, "btn-mic-sync").click();
    env.watch = true;
    env.failName = "NotReadableError";
    env.failNext = 6; // two tries per attempt: the check's two attempts, then the meter's one
    $(env, "btn-start-mic-sync").click();
    await until(() => env.failNext === 0 && !env.app.micSyncBusy, "the failed reopen");
    await tick(100);
    const hint = $(env, "level-meter-hint");
    if (hint.textContent !== BUSY_LINE) fail(`hint after a failed reopen: ${hint.textContent}`);
    if (!hint.classList.contains("is-error")) fail("hint not shown as an error");
    if (env.raf.size !== 1 || env.gaps) fail(`loop after a failed reopen: ${env.raf.size} pending, ${env.gaps} gaps`);
    if (fillWidth(env) !== 0) fail(`bar not at the floor: ${fillWidth(env)}%`);
    if (liveStreams(env).length) fail("a stream is still open");
    console.log("PASS: when the meter can't reopen the mic the hint says so and the bar rests at the floor");
    done(env);
  }

  // 5. Two overlapping meter starts leave one live stream and one frame loop.
  {
    const env = await boot();
    env.gumDelay = 30;
    await Promise.all([env.app.startInputMeter(), env.app.startInputMeter()]);
    await tick(60);
    const live = liveStreams(env);
    if (live.length !== 1) fail(`overlapping starts left ${live.length} live streams`);
    if (live[0] !== env.audio.monitorStream) fail("the live stream is not the meter's");
    if (env.raf.size !== 1) fail(`overlapping starts left ${env.raf.size} frame loops`);
    console.log("PASS: two overlapping meter starts leave one live stream and one loop");
    done(env);
  }

  // 6. The record analyser: never routed to the speakers, released with the microphone.
  {
    const env = await boot();
    env.audio.stopInputMonitor();
    await env.audio.requestMicrophone();
    const { recordSource, recordAnalyser } = env.audio;
    if (!recordSource || !recordAnalyser) fail("requestMicrophone attached no analyser");
    if (recordSource.stream !== env.audio.stream || recordSource.connected[0] !== recordAnalyser) fail("analyser not fed by the stream");
    if (recordAnalyser.connected.length) fail("record analyser is connected onward");
    if (recordAnalyser.fftSize !== 2048 || recordAnalyser.smoothingTimeConstant !== 0.15) fail("record analyser settings");
    env.audio.releaseMicrophone();
    if (!recordSource.disconnected || !recordAnalyser.disconnected) fail("releaseMicrophone left the analyser connected");
    if (env.audio.recordSource !== null || env.audio.recordAnalyser !== null) fail("releaseMicrophone kept the analyser");
    if (env.audio.readInputLevel() !== null) fail("readInputLevel without a stream");
    console.log("PASS: releaseMicrophone disconnects the record analyser");
    done(env);
  }

  // 7. A take still opens a fresh stream while the meter runs.
  {
    const env = await boot();
    const before = env.gumCalls;
    await env.audio.startRecording();
    if (env.gumCalls !== before + 1) fail(`take opened ${env.gumCalls - before} streams`);
    if (!env.audio.stream || env.audio.stream === env.audio.monitorStream) fail("take reused the meter's stream");
    if (!env.audio.recordSource || env.audio.recordSource.stream !== env.audio.stream) fail("take stream has no analyser");
    await env.audio.stopRecording();
    if (env.audio.stream || env.audio.recordAnalyser) fail("take stream not released");
    console.log("PASS: a take opens its own stream, not the meter's");
    done(env);
  }

  process.exit(0);
})().catch((err) => fail(err && err.stack || String(err)));
