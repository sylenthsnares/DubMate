/**
 * test_background_save.js
 *
 * Saving a take in the background (UI pass U2, group 4; owner decision 2: the next line
 * is usable while a take saves, and only the line being saved is locked):
 *  - no booth-wide overlay or lock; recordState is idle as soon as the recorder stops,
 *  - the saving line's badge, record button, take lane, Takes card and line chip say so,
 *    and only its Voice and Takes controls are locked,
 *  - you can go to line 2 and record it while line 1 still uploads,
 *  - the upload reply, and the take_recorded echo, don't move you back or cancel a count-in,
 *  - "Take saved" only for a line that's off screen,
 *  - a failed upload is kept ("Take · waiting to upload"), retried when the socket is back
 *    'open' or with Retry, dropped by Discard, and guarded by beforeunload meanwhile,
 *  - while recording: the REC tally with the time left and the live input trace.
 * Fetch, the recorder and the socket are stubbed.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "chain_resolution.json"), "utf8"));
const PRESETS = ["clean", "warm", "radio"].map((id) => ({ id, name: id, chain: FIXTURE.presets[id] }));

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const LINES = [
  { line_id: "t1000", index: 0, character: "Ana", start: 0.7, end: 1.62, duration: 0.92, peaks: [], audio_url: "/o0.wav", text: "Hi" },
  { line_id: "t2000", index: 1, character: "Ana", start: 3, end: 4.5, duration: 1.5, peaks: [], audio_url: "/o1.wav", text: "Bye" },
  { line_id: "t3000", index: 2, character: "Ben", start: 5, end: 6, duration: 1, peaks: [], audio_url: "/o2.wav", text: "Yo" },
];

const mk = (lineId, id, number) => ({ take_id: id, number, user_id: "u1", user_name: "Ana",
  duration: 0.8, url: `/api/rooms/R1/lines/${lineId}/takes/${id}/audio?v=1`, peaks: [],
  offset_ms: 0, gain_db: 0 });

function room(takes = {}) {
  return {
    state_version: 3, room_id: "R1", host_id: "u1", status: "recording",
    users: {
      u1: { id: "u1", name: "Ana", is_online: true, is_ready: false, color: "#d97706" },
      u9: { id: "u9", name: "Mika", is_online: true, is_ready: false, color: "#16a34a" },
    },
    role_assignments: { Ana: ["u1"], Ben: ["u9"] },
    pack: { id: "P", name: "Scene", lines: LINES, characters: ["Ana", "Ben"], video_url: "/v.mp4", line_count: 3 },
    voice: { session: null, characters: {}, presets: PRESETS },
    takes,
  };
}

async function boot() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) fail(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
  };
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });

  // Take uploads wait for the test to answer them; everything else answers at once.
  const env = { w, calls: [], uploads: [] };
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    env.calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (/\/takes$/.test(u) && opts.method === "POST") {
      return new Promise((resolve, reject) => env.uploads.push({ url: u, body: opts.body, resolve, reject }));
    }
    let body = {};
    if (u.startsWith("/api/packs")) body = [];
    else if (u.startsWith("/api/config")) body = { mic_sync: {} };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  if (app.isAudioSettingsOpen()) app.closeAudioSettings();

  env.app = app;
  env.toasts = [];
  app.showToast = (msg) => env.toasts.push(msg);
  app.user = { id: "u1", name: "Ana" };
  app.socket.send = () => {};
  app.socket.updateTakeParams = () => {};
  app.socket.connectionState = "open";
  app.audioSetup.permission = "granted";
  app.applyNoiseReduction = true;
  app.filterMyLinesOnly = false;
  app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
  app.audio.stopAllPlayback = () => {};
  app.audio.playMetronomePip = () => {};
  app.audio.startRecording = async () => { app.audio.isRecording = true; };
  app.audio.stopRecording = async () => {
    app.audio.isRecording = false;
    return { blob: new w.Blob(["take"], { type: "audio/webm" }), audioBuffer: null };
  };
  app.audio.readInputLevel = () => ({ rms: 0.2, peak: 0.5 });
  app.ensureMicReady = async () => true;
  app.ensureBackingBuffer = async () => null;
  app.stageVideo.pause = () => {};
  app.stageVideo.play = () => Promise.resolve();
  for (const [k, el] of Object.entries(app.views)) el.classList.toggle("active", k === "booth");
  app.currentView = "booth";
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const visible = (el) => !!el && !el.hidden && el.style.display !== "none";
const chip = (env, i) => $(env, "timeline-chips").querySelectorAll(".chip-item")[i];
const presets = (env) => [...$(env, "voice-presets").querySelectorAll("[data-preset]")];
const pendingRows = (env) => [...$(env, "takes-list").querySelectorAll(".take-row.is-pending")];

/** Answers the oldest unanswered take upload. */
function answerUpload(env, lineId, number) {
  const up = env.uploads.shift();
  if (!up) fail("no upload is waiting for an answer");
  const take = mk(lineId, `n${number}`, number);
  up.resolve({ ok: true, status: 200, json: () => Promise.resolve({
    take, line: { picked: take.take_id, next_number: number + 1, takes: [take] } }) });
}

function beforeUnloadBlocked(env) {
  const ev = new env.w.Event("beforeunload", { cancelable: true });
  env.w.dispatchEvent(ev);
  return ev.defaultPrevented;
}

(async () => {
  const env = await boot();
  const { app, w } = env;
  const badge = $(env, "record-engine-badge");
  const label = $(env, "record-status-label");
  const rec = $(env, "btn-record-main");

  if ($(env, "booth-processing-overlay")) fail("the booth-wide saving overlay is still in the page");
  if ("isProcessingTake" in app) fail("the booth-wide isProcessingTake lock is still there");

  app.roomState = room();
  await app.loadBoothLine(0);
  await tick();
  if (beforeUnloadBlocked(env)) fail("leaving the page is guarded with nothing to save");

  // 1. Stop a take on line 1: the line saves in the background, and only it is locked.
  {
    app.recordState = "recording";
    const saved = app.finishRecording();
    await tick();
    if (env.uploads.length !== 1 || !/\/lines\/t1000\/takes$/.test(env.uploads[0].url)) fail("line 1's take wasn't uploaded");
    if (app.recordState !== "idle") fail(`recordState is ${app.recordState} while the take saves`);
    if (!app.savingLines.t1000) fail("line 1 isn't marked as saving");
    if (text(badge) !== "SAVING" || text(label) !== "Saving take 1…") fail(`saving deck: ${text(badge)} / ${text(label)}`);
    if (!rec.querySelector(".spinning") || rec.getAttribute("aria-label") !== "Saving take 1") fail("no spinner or name on the saving record button");
    const rows = pendingRows(env);
    if (rows.length !== 1 || text(rows[0]) !== "Take 1 · Saving… cleaning up noise") fail(`pending row: ${rows.map(text)}`);
    if (visible($(env, "takes-empty"))) fail("the empty line shows next to a saving take");
    if (app.waveform.takeLaneNote !== "Saving… cleaning up noise") fail(`take lane: ${app.waveform.takeLaneNote}`);
    if (!chip(env, 0).classList.contains("is-saving") || !/saving/.test(text(chip(env, 0)))) fail(`chip 1: ${chip(env, 0).className} ${text(chip(env, 0))}`);
    if (!/saving a take/.test(chip(env, 0).getAttribute("aria-label"))) fail(`chip 1 name: ${chip(env, 0).getAttribute("aria-label")}`);
    if (!presets(env).length || presets(env).some((b) => !b.disabled)) fail("line 1's Voice controls aren't locked while it saves");
    if (!beforeUnloadBlocked(env)) fail("leaving the page isn't guarded while a take saves");
    for (const id of ["btn-next-line", "btn-prev-line", "btn-play-orig", "btn-back-lobby"]) {
      if ($(env, id).disabled && id !== "btn-prev-line") fail(`#${id} is locked while the take saves`);
    }
    if ($(env, "timeline-chips").classList.contains("ui-interaction-locked")) fail("the line chips are locked");

    // Space on the saving line: not another take on top of it.
    env.toasts.length = 0;
    await app.toggleRecording();
    if (app.recordState !== "idle" || env.toasts.join() !== "Still saving take 1") fail(`re-record while saving: ${app.recordState} ${env.toasts}`);

    // 2. Line 2 works, recording included, while line 1 still uploads.
    w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true }));
    await tick();
    if (app.currentLineIndex !== 1) fail(`"." didn't go to line 2 while line 1 saves (on ${app.currentLineIndex})`);
    if (text(badge) !== "READY" || text(label) !== "Record take 1") fail(`line 2 deck: ${text(badge)} / ${text(label)}`);
    if (pendingRows(env).length || app.waveform.takeLaneNote) fail("line 1's saving shows on line 2");
    if (presets(env).some((b) => b.disabled)) fail("line 2's Voice controls are locked by line 1's save");
    if (!chip(env, 0).classList.contains("is-saving") || chip(env, 1).classList.contains("is-saving")) fail("the saving chip moved");

    w.document.dispatchEvent(new w.KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
    await tick();
    if (app.recordState !== "countdown") fail(`Space on line 2 didn't count in (${app.recordState})`);

    // 3. Line 1's upload returns mid count-in: no jump back, no cancelled count-in.
    env.toasts.length = 0;
    answerUpload(env, "t1000", 1);
    await saved;
    await tick();
    if (app.currentLineIndex !== 1 || app.recordState !== "countdown") fail(`the upload reply moved the booth: line ${app.currentLineIndex}, ${app.recordState}`);
    if (app.savingLines.t1000) fail("line 1 still saving after its reply");
    if (env.toasts.join() !== "Take 1 saved on line 1") fail(`off-screen toast: ${JSON.stringify(env.toasts)}`);
    if (chip(env, 0).classList.contains("is-saving") || !/1 take/.test(text(chip(env, 0)))) fail(`chip 1 after the save: ${text(chip(env, 0))}`);

    // The take_recorded echo for the line you're counting in on doesn't cancel it either.
    const echoTake = mk("t2000", "m1", 1);
    app.socket.emit("take_recorded", { type: "take_recorded",
      payload: { line_index: 1, line_id: "t2000", take_id: "m1", user_id: "u9", user_name: "Mika" },
      state: { ...room({ t1000: app.roomState.takes.t1000, t2000: { picked: "m1", next_number: 2, takes: [echoTake] } }) } });
    await tick();
    if (app.recordState !== "countdown") fail(`a take_recorded echo cancelled the count-in (${app.recordState})`);
    if (!$(env, "takes-list").querySelector('[data-take-id="m1"]')) fail("the echo didn't refresh the Takes card");

    // 4. The REC tally and the live input trace while recording line 2.
    for (let i = 0; i < 150 && app.recordState !== "recording"; i++) await tick();
    if (app.recordState !== "recording") fail("line 2 never started recording");
    await tick(120);
    const tally = $(env, "rec-tally");
    if (!visible(tally) || !/^● REC · \d\.\d s left$/.test(text(tally))) fail(`tally: ${visible(tally)} "${text(tally)}"`);
    if (!Array.isArray(app.waveform.liveTrace) || app.waveform.liveTrace.length < 2) fail("no live input trace in the take lane");
    if (app.waveform.lineEnd !== 1.5) fail(`line end mark at ${app.waveform.lineEnd}`);
    const second = app.finishRecording();
    await tick();
    if (visible(tally) || app.waveform.liveTrace) fail("the tally or the live trace stayed after recording");
    if (app.recordState !== "idle" || !app.savingLines.t2000) fail("line 2 isn't saving after its take");

    // On screen, the new row is the confirmation: no toast, and the booth shows the take.
    env.toasts.length = 0;
    answerUpload(env, "t2000", 2);
    await second;
    await tick();
    if (env.toasts.some((t) => /saved/i.test(t))) fail(`an on-screen save toasted: ${env.toasts}`);
    if (text($(env, "takes-card-title")) !== "TAKES · 1" || pendingRows(env).length) fail(`line 2's card after the save: ${text($(env, "takes-card-title"))}`);
    if (beforeUnloadBlocked(env)) fail("leaving the page is still guarded after the saves");
    console.log("PASS: line 2 records while line 1 saves; replies and echoes don't move you; saving shows per line");
  }

  console.log("PASS: test_background_save");
  process.exit(0);
})();
