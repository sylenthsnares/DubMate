/**
 * test_recording_focus.js
 *
 * Recording focus (2.0 layout pass, documentation/design/v2-booth-layout.md): during the
 * count-in and while recording, everything but the record button, the picture, the line
 * and the waveform is inert and dimmed (body.is-taking):
 *  - one setRecordState() sets it; no other code assigns recordState,
 *  - the header's nav, Audio, ? and Leave, the booth bar, the timing row, the expand
 *    button, the transport, the mic-sync hint, the column and the footer go inert;
 *    the connection banner, the record button, the video and the prompter never do,
 *  - every way out clears it: Space or a click on stop, the end-of-line timeout,
 *    cancelling the count-in (Space, click, Esc), a mic that fails to open, loading
 *    another line, leaving the booth or the room, and "Nothing was recorded",
 *  - saving is live; the timing row keeps its own "no take yet" inert,
 *  - Esc cancels the count-in and does nothing while recording; ? and [ ] wait too.
 * Fetch, the recorder and the socket are stubbed; the count-in runs 20x faster.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const INERT_WHILE_TAKING = [
  "header .logo-dropdown-container", "#studio-breadcrumbs", "#header-room-badge", "#btn-audio-settings",
  "#btn-shortcuts", "#btn-leave-room", "#view-booth .stage-top-bar", "#view-booth .nudge-preset-bar",
  "#btn-expand-video", "#view-booth .transport-seg", "#mic-sync-hint", "#booth-column-scroll",
  "#view-booth .booth-nav-group",
];
const ALWAYS_LIVE = ["#connection-banner", "#btn-record-main", "#stage-video", "#stage-caption-text"];

// 1. Static: recordState is assigned in one place (the constructor's first value aside).
{
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".js")) files.push(p);
    }
  };
  walk(path.join(PROJECT_ROOT, "static", "js"));
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, "utf8").split("\n").forEach((src, i) => {
      if (/this\.recordState\s*=[^=]/.test(src)) hits.push(`${path.relative(PROJECT_ROOT, file)}:${i + 1}: ${src.trim()}`);
    });
  }
  const allowed = hits.filter((h) => !/app\.js:\d+: this\.recordState = 'idle'; \/\/ 'idle' \|/.test(h));
  if (allowed.length !== 1 || !/booth\.js/.test(allowed[0])) fail(`recordState is assigned outside setRecordState:\n${allowed.join("\n")}`);
  const booth = fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "studio", "booth.js"), "utf8");
  const helper = booth.match(/\n  setRecordState\(state\) \{([\s\S]*?)\r?\n  \}\r?\n/);
  if (!helper || !/this\.recordState = state;/.test(helper[1])) fail("the one assignment isn't in setRecordState(state)");

  // CSS: dimmed to .35 with a short fade that reduced motion drops; the waveform can't be dragged.
  if (!/body\.is-taking\s+\[inert\]:not\(\.waveform-canvas-box\)\s*\{[^}]*opacity:\s*0?\.35/.test(css)) fail("inert parts aren't dimmed to .35 while taking (the waveform excepted)");
  if (!/body\.is-taking[^{]*\.waveform-canvas-box\s*\{[^}]*pointer-events:\s*none/.test(css)) fail("the waveform is still draggable while taking");
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  if (!/\[inert\][^{]*\{[^}]*transition:\s*none/.test(reduced)) fail("reduced motion keeps the dimming fade");
  console.log("PASS: one setRecordState; dimmed .35, no fade with reduced motion; no waveform drag while taking");
}

const LINES = [
  { line_id: "t1000", index: 0, character: "Ana", start: 0, end: 20, duration: 20, peaks: [], audio_url: "/o0.wav", text: "Long" },
  { line_id: "t2000", index: 1, character: "Ana", start: 21, end: 21.5, duration: 0.5, peaks: [], audio_url: "/o1.wav", text: "Short" },
  { line_id: "t3000", index: 2, character: "Ana", start: 22, end: 30, duration: 8, peaks: [], audio_url: "/o2.wav", text: "Has a take" },
  { line_id: "t4000", index: 3, character: "Ben", start: 31, end: 33, duration: 2, peaks: [], audio_url: "/o3.wav", text: "Not yours" },
];

const mk = (lineId, id, number) => ({ take_id: id, number, user_id: "u1", user_name: "Ana",
  duration: 0.8, url: `/api/rooms/R1/lines/${lineId}/takes/${id}/audio?v=1`, peaks: [],
  offset_ms: 0, gain_db: 0 });

function room() {
  const t = mk("t3000", "a1", 1);
  return {
    state_version: 3, room_id: "R1", host_id: "u1", status: "recording",
    users: {
      u1: { id: "u1", name: "Ana", is_online: true, is_ready: false, color: "#d97706" },
      u9: { id: "u9", name: "Mika", is_online: true, is_ready: false, color: "#16a34a" },
    },
    role_assignments: { Ana: ["u1"], Ben: ["u9"] },
    pack: { id: "P", name: "Scene", lines: LINES, characters: ["Ana", "Ben"], video_url: "/v.mp4", line_count: 4 },
    voice: { session: null, characters: {}, presets: [] },
    takes: { t3000: { picked: "a1", next_number: 2, takes: [t] } },
  };
}

async function boot() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) fail(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  // The count-in and the end-of-line timeout run 20x faster.
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, ms / 20, ...args);
  w.requestAnimationFrame = (cb) => realSetTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => w.clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
  };
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });

  const env = { w, uploads: [] };
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    if (/\/takes$/.test(u) && opts.method === "POST") {
      return new Promise((resolve) => env.uploads.push({ url: u, resolve }));
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
  app.socket.disconnect = () => {};
  app.socket.updateTakeParams = () => {};
  app.socket.connectionState = "open";
  app.audioSetup.permission = "granted";
  app.filterMyLinesOnly = false;
  app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
  app.audio.stopAllPlayback = () => {};
  app.audio.playMetronomePip = () => {};
  app.audio.startRecording = async () => { app.audio.isRecording = true; };
  env.recorded = true;
  app.audio.stopRecording = async () => {
    app.audio.isRecording = false;
    return env.recorded ? { blob: new w.Blob(["take"], { type: "audio/webm" }), audioBuffer: null } : null;
  };
  app.audio.readInputLevel = () => ({ rms: 0.2, peak: 0.5 });
  app.ensureMicReady = async () => true;
  app.ensureBackingBuffer = async () => null;
  app.stageVideo.pause = () => {};
  app.stageVideo.play = () => Promise.resolve();
  app.roomState = room();
  app.showView("booth");
  await app.loadBoothLine(0);
  await tick();
  return env;
}

const q = (env, sel) => env.w.document.querySelector(sel);
const key = (env, init) => {
  const ev = new env.w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  env.w.document.body.dispatchEvent(ev);
  return ev;
};
const space = (env) => key(env, { code: "Space", key: " " });
const esc = (env) => key(env, { key: "Escape", code: "Escape" });

function expectFocus(env, where) {
  if (!env.w.document.body.classList.contains("is-taking")) fail(`${where}: body isn't .is-taking`);
  for (const sel of INERT_WHILE_TAKING) {
    const el = q(env, sel);
    if (!el) fail(`${where}: ${sel} is missing`);
    if (!el.hasAttribute("inert")) fail(`${where}: ${sel} isn't inert`);
  }
  for (const sel of ALWAYS_LIVE) {
    const el = q(env, sel);
    if (!el || el.closest("[inert]")) fail(`${where}: ${sel} is inert`);
  }
}

/** Nothing inert from the take; the timing row stays inert only when your line has no take. */
function expectClear(env, where) {
  const { app } = env;
  if (env.w.document.body.classList.contains("is-taking")) fail(`${where}: body is still .is-taking`);
  const line = app.roomState?.pack?.lines?.[app.currentLineIndex];
  const mine = !!line && app.canRecordLine(line);
  const noTake = !!line && !app.takeForLine(app.currentLineIndex);
  for (const sel of INERT_WHILE_TAKING) {
    const el = q(env, sel);
    const want = sel.endsWith(".nudge-preset-bar") && !!app.roomState && mine && noTake;
    if (el.hasAttribute("inert") !== want) fail(`${where}: ${sel} inert=${el.hasAttribute("inert")}, want ${want}`);
  }
}

async function until(env, state, where) {
  for (let i = 0; i < 200 && env.app.recordState !== state; i++) await tick(10);
  if (env.app.recordState !== state) fail(`${where}: never reached ${state} (${env.app.recordState})`);
}

async function answerUploads(env) {
  while (env.uploads.length) {
    const up = env.uploads.shift();
    const lineId = up.url.match(/lines\/([^/]+)\/takes$/)[1];
    const take = mk(lineId, `n${Math.random().toString(36).slice(2, 7)}`, 1);
    up.resolve({ ok: true, status: 200, json: () => Promise.resolve({ take, line: { picked: take.take_id, next_number: 2, takes: [take] } }) });
    await tick();
  }
}

(async () => {
  const env = await boot();
  const { app, w } = env;
  const rec = q(env, "#btn-record-main");
  expectClear(env, "idle, no take");
  if (!q(env, "#view-booth .nudge-preset-bar").hasAttribute("inert")) fail("the timing row lost its no-take inert");

  // 2. The count-in: inert at once; Esc, Space and a click each cancel it.
  {
    space(env);
    await until(env, "countdown", "Space");
    expectFocus(env, "count-in");
    const ev = esc(env);
    if (app.recordState !== "idle") fail(`Esc didn't cancel the count-in (${app.recordState})`);
    if (!ev.defaultPrevented) fail("Esc on the count-in wasn't handled");
    expectClear(env, "Esc on the count-in");
    await tick(200);
    if (app.recordState !== "idle") fail("the cancelled count-in started recording");

    rec.click();
    await until(env, "countdown", "click");
    rec.click();
    await tick();
    if (app.recordState !== "idle") fail("a second click didn't cancel the count-in");
    expectClear(env, "click on the count-in");

    space(env);
    await until(env, "countdown", "Space");
    space(env);
    await tick();
    if (app.recordState !== "idle") fail("a second Space didn't cancel the count-in");
    expectClear(env, "Space on the count-in");
    console.log("PASS: the count-in is inert and Esc, Space or a click clears it");
  }

  // 3. Recording: Esc, ? and [ ] do nothing; Space stops, and saving is live.
  {
    space(env);
    await until(env, "recording", "Space");
    expectFocus(env, "recording");
    const ev = esc(env);
    if (app.recordState !== "recording") fail(`Esc while recording changed it to ${app.recordState}`);
    if (!ev.defaultPrevented) fail("Esc while recording reached something else");
    expectFocus(env, "after Esc while recording");
    key(env, { key: "?" });
    if (q(env, "#shortcut-sheet")?.classList.contains("is-open")) fail("? opened the shortcut sheet mid-take");
    const nudge = app.sliderNudge.value;
    key(env, { key: "]" });
    key(env, { key: "{", shiftKey: true });
    if (app.sliderNudge.value !== nudge) fail("[ ] nudged the timing mid-take");

    space(env);
    await tick();
    if (app.recordState !== "idle") fail(`Space didn't stop (${app.recordState})`);
    if (!app.savingLines.t1000) fail("line 1 isn't saving after Space");
    expectClear(env, "saving after Space");
    console.log("PASS: recording is inert; Esc, ? and [ ] wait; Space stops and saving is live");
    await answerUploads(env);
  }

  // 4. A click on stop.
  {
    await app.loadBoothLine(0);
    rec.click();
    await until(env, "recording", "click");
    expectFocus(env, "recording (click)");
    rec.click();
    await tick();
    expectClear(env, "click on stop");
    await answerUploads(env);
  }

  // 5. The timeout at the end of the line.
  {
    await app.loadBoothLine(1);
    space(env);
    await until(env, "recording", "short line");
    expectFocus(env, "recording the short line");
    await until(env, "idle", "the end-of-line timeout");
    await tick();
    expectClear(env, "end-of-line timeout");
    await answerUploads(env);
    console.log("PASS: a click on stop and the end-of-line timeout clear it");
  }

  // 6. "Nothing was recorded."
  {
    await app.loadBoothLine(0);
    env.recorded = false;
    env.toasts.length = 0;
    space(env);
    await until(env, "recording", "nothing recorded");
    space(env);
    await tick();
    env.recorded = true;
    if (!env.toasts.some((t) => /Nothing was recorded/.test(t))) fail(`no "Nothing was recorded" toast: ${env.toasts}`);
    expectClear(env, "nothing recorded");
    console.log('PASS: "Nothing was recorded" clears it');
  }

  // 7. A mic that won't open: before the count-in, and when the take starts.
  {
    app.ensureMicReady = async () => false;
    space(env);
    await tick(100);
    if (app.recordState !== "idle") fail(`a refused mic counted in (${app.recordState})`);
    expectClear(env, "mic refused before the count-in");
    app.ensureMicReady = async () => true;

    const start = app.audio.startRecording;
    app.audio.startRecording = async () => {
      const err = new Error("Could not start audio source");
      err.name = "NotReadableError";
      throw err;
    };
    env.toasts.length = 0;
    space(env);
    await until(env, "countdown", "mic failure");
    expectFocus(env, "count-in before the mic fails");
    for (let i = 0; i < 100 && (app.recordState !== "idle" || w.document.body.classList.contains("is-taking")); i++) await tick(10);
    app.audio.startRecording = start;
    if (app.recordState !== "idle") fail(`a mic that failed to open left the booth ${app.recordState}`);
    expectClear(env, "mic failed to open");
    if (!env.toasts.length) fail("a mic that failed to open said nothing");
    if (q(env, "#record-engine-badge").textContent.trim() !== "NO MIC") fail(`deck after the mic failed: ${q(env, "#record-engine-badge").textContent}`);
    app.micError = null;
    app.updateRecordButtonUI();
    console.log("PASS: a mic that won't open, before or after the count-in, clears it");
  }

  // 8. Another line, during the count-in and while recording; a line with a take is live.
  {
    space(env);
    await until(env, "countdown", "count-in");
    await app.loadBoothLine(2);
    expectClear(env, "another line during the count-in");
    if (q(env, "#view-booth .nudge-preset-bar").hasAttribute("inert")) fail("the timing row is inert on a line with a take");

    space(env);
    await until(env, "recording", "line with a take");
    expectFocus(env, "recording a line with a take");
    await app.loadBoothLine(0);
    expectClear(env, "another line while recording");
    console.log("PASS: loading another line clears it; the timing row keeps its own no-take state");
  }

  // 9. Leaving the booth, then the room.
  {
    space(env);
    await until(env, "recording", "before the lobby");
    app.showView("lobby");
    expectClear(env, "leaving for the lobby");
    app.showView("booth");
    await app.loadBoothLine(0);

    space(env);
    await until(env, "countdown", "before leaving");
    app.leaveRoom();
    await tick();
    expectClear(env, "leaving the room");
    console.log("PASS: leaving the booth or the room clears it");
  }

  console.log("All recording focus checks passed");
  process.exit(0);
})().catch((err) => fail(err && err.stack || err));
