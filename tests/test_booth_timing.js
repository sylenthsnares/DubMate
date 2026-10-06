/**
 * test_booth_timing.js
 *
 * Automatic timing in the booth (static/js/studio/booth.js): the "Lined up
 * automatically" caption by the timing readout until the take is nudged, the fitted
 * caption and Original speed, the Auto reset, "Timing N%" in the Takes panel, and a
 * fitted take never previewing the local recording, and guide_voice following the
 * checkbox as it was when the take started recording. Socket and fetch are stubbed.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const LINED_UP = "Lined up automatically";
const FITTED = "Lined up and fitted to the line";
const CAPTION_TIP = "DubMate matched this take to the original line. Use [ and ] to adjust it.";
const SCORE_TIP = "How closely this take follows the original line's timing";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

const LINE = { line_id: "t1000", index: 0, character: "Ana", start: 1, end: 3, duration: 2,
  peaks: [], audio_url: "/orig0.wav", text: "Hello" };

const mk = (id, number, extra = {}) => ({ take_id: id, number, user_id: "u1", user_name: "Ana",
  duration: 2, url: `/api/rooms/R1/lines/t1000/takes/${id}/audio?v=1`, peaks: [],
  offset_ms: 0, pitch_semitones: 0, reverb_wet: 0, gain_db: 0, ...extra });

async function boot() {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
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
    value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });

  const calls = [];
  // Per-test responses: env.reply(url, opts) returns a body, or { status } for an error.
  const env = { w, calls, errors, reply: null };
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    let body = {};
    if (u.startsWith("/api/packs")) body = [];
    else if (u.startsWith("/api/config")) body = { mic_sync: {} };
    else if (env.reply) body = env.reply(u, opts) || {};
    const status = body.status && typeof body.status === "number" ? body.status : 200;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");

  env.app = app;
  env.toasts = [];
  env.sent = [];
  app.showToast = (msg) => env.toasts.push(msg);
  app.user = { id: "u1", name: "Ana" };
  app.socket.send = () => {};
  app.socket.updateTakeParams = (lineId, takeId, params) => env.sent.push({ lineId, takeId, ...params });
  env.loaded = [];
  app.audio.loadAudioBuffer = (url) => { env.loaded.push(url); return Promise.resolve({ duration: 2, url }); };
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const shown = (el) => !!el && el.style.display !== "none";

/** Puts `takes` (picked = `picked`) on the room's only line and opens it in the booth. */
async function showLine(env, takes, picked, extra = {}) {
  env.app.roomState = {
    state_version: 3, room_id: "R1", host_id: "u1", users: {}, role_assignments: {},
    pack: { id: "P", lines: [LINE], characters: ["Ana"], video_url: "/v.mp4" },
    takes: takes.length ? { t1000: { picked, next_number: takes.length + 1, takes } } : {},
    ...extra,
  };
  await env.app.loadBoothLine(0);
  await tick();
}

const nudge = (env, ms) => env.app.setNudgeValue(parseInt(env.app.sliderNudge.value, 10) + ms, true);
const clickAuto = (env) => env.w.document.querySelector(".btn-nudge-reset").click();

(async () => {
  const env = await boot();
  const caption = $(env, "timing-caption");
  const btnSpeed = $(env, "btn-original-speed");
  const auto = env.w.document.querySelector(".btn-nudge-reset");

  // 0. Markup: Auto replaces "0 ms"; caption and Original speed start hidden.
  {
    if (auto.textContent.trim() !== "Auto") fail(`reset label: ${auto.textContent}`);
    if (auto.dataset.tip !== "Back to the automatic timing") fail(`reset tip: ${auto.dataset.tip}`);
    if (shown(caption) || shown(btnSpeed)) fail("caption or Original speed shown at boot");
    if (caption.dataset.tip !== CAPTION_TIP) fail(`caption tip: ${caption.dataset.tip}`);
    if (btnSpeed.dataset.tip !== "Play this take at the speed you recorded it") fail(`speed tip: ${btnSpeed.dataset.tip}`);
    console.log("PASS: the reset button reads Auto; caption and Original speed start hidden");
  }

  // 1. An aligned, unnudged take shows the caption; a 25 ms nudge hides it; Auto brings it back.
  {
    await showLine(env, [mk("a1", 1, { offset_ms: -120, auto_offset_ms: -120, aligned: true, stretch: 1.0, timing_score: 0.8 })], "a1");
    if (!shown(caption) || caption.textContent !== LINED_UP) fail(`aligned take caption: ${shown(caption)} ${caption.textContent}`);
    if (shown(btnSpeed)) fail("Original speed shown on an unfitted take");
    nudge(env, 25);
    if (env.app.sliderNudge.value !== "-95") fail(`slider after nudge: ${env.app.sliderNudge.value}`);
    if (shown(caption)) fail("caption still shown after a 25 ms nudge");
    clickAuto(env);
    if (env.app.sliderNudge.value !== "-120") fail(`Auto went to ${env.app.sliderNudge.value}, not -120`);
    const last = env.sent[env.sent.length - 1];
    if (!last || last.offset_ms !== -120 || last.takeId !== "a1") fail(`Auto sent ${JSON.stringify(last)}`);
    if (!shown(caption)) fail("caption not back after Auto");
    console.log("PASS: caption on an aligned take, hidden after a 25 ms nudge, back after Auto (-120)");
  }

  // 2. A take that wasn't lined up (aligned false) shows no caption even at its auto offset.
  {
    await showLine(env, [mk("a1", 1, { offset_ms: -140, auto_offset_ms: -140, aligned: false, stretch: 1.0, timing_score: null })], "a1");
    if (shown(caption)) fail("caption shown on a take that wasn't lined up");
    console.log("PASS: no caption when the take wasn't lined up");
  }

  // 3. Old takes (no timing fields): no caption, no Original speed, Auto resets to 0.
  {
    await showLine(env, [mk("o1", 1, { offset_ms: 70 })], "o1");
    if (shown(caption) || shown(btnSpeed)) fail("caption or Original speed on an old take");
    clickAuto(env);
    if (env.app.sliderNudge.value !== "0") fail(`Auto on an old take went to ${env.app.sliderNudge.value}`);
    if (shown(caption)) fail("caption shown on an old take after Auto");
    console.log("PASS: old takes show no caption and Auto resets them to 0");
  }

  // 4. Changing pitch on an aligned take at -135 changes its sound (PUT .../chain), not its
  // timing: the offset stays -135 and the caption stays.
  {
    await showLine(env, [mk("p1", 1, { offset_ms: -135, auto_offset_ms: -135, aligned: true, stretch: 1.0, timing_score: 0.7 })], "p1");
    if (!shown(caption)) fail("caption not shown at -135");
    const sentBefore = env.sent.length;
    const pitch = env.w.document.querySelector('#voice-rack [data-node="pitch"] [data-voice-param="semitones"]');
    pitch.value = "2";
    pitch.dispatchEvent(new env.w.Event("input"));
    pitch.dispatchEvent(new env.w.Event("change"));   // let go: saved now
    await tick();
    const put = env.calls.find((c) => c.method === "PUT" && c.url === "/api/rooms/R1/lines/t1000/takes/p1/chain");
    if (!put) fail("pitch change did not save the take's sound");
    const body = JSON.parse(put.body);
    if (body.user_id !== "u1" || body.chain?.nodes?.pitch?.on !== true || body.chain.nodes.pitch.semitones !== 2) {
      fail(`pitch change saved ${put.body}`);
    }
    if (env.sent.length !== sentBefore) fail(`pitch change sent timing: ${JSON.stringify(env.sent.slice(sentBefore))}`);
    if (env.app.sliderNudge.value !== "-135") fail(`offset after a pitch change: ${env.app.sliderNudge.value}`);
    await env.app.loadBoothLine(0);
    if (pitch.value !== "2") fail(`pitch after reload: ${pitch.value}`);
    if (!shown(caption)) fail("pitch change on an aligned take counted as a nudge");
    console.log("PASS: a pitch change saves the take's sound (pitch 2) and keeps offset -135 and the caption");
  }

  // 5. Fitted take: fitted caption and Original speed; the button posts and the reply refreshes.
  {
    const fitted = () => mk("f1", 1, { offset_ms: -60, auto_offset_ms: -60, aligned: true, stretch: 1.05, timing_score: 0.9 });
    await showLine(env, [fitted()], "f1");
    if (!shown(caption) || caption.textContent !== FITTED) fail(`fitted caption: ${shown(caption)} ${caption.textContent}`);
    if (!shown(btnSpeed)) fail("Original speed hidden on a fitted take");
    nudge(env, -25);
    if (shown(caption)) fail("fitted caption still shown after a nudge");
    if (!shown(btnSpeed)) fail("Original speed hidden on a nudged fitted take");

    env.reply = (u) => (/\/original_speed$/.test(u)
      ? { status: "ok", line_id: "t1000", take: mk("f1", 1, { offset_ms: -85, auto_offset_ms: -40, aligned: true, stretch: 1.0, timing_score: 0.75,
          url: "/api/rooms/R1/lines/t1000/takes/f1/audio?v=2" }) }
      : {});
    btnSpeed.click();
    await tick();
    const post = env.calls.find((c) => /\/original_speed$/.test(c.url));
    if (!post || post.method !== "POST") fail("Original speed did not POST");
    if (post.url !== "/api/rooms/R1/lines/t1000/takes/f1/original_speed") fail(`posted to ${post.url}`);
    if (JSON.parse(post.body).user_id !== "u1") fail(`body ${post.body}`);
    if (shown(btnSpeed)) fail("Original speed still shown after the take was put back to its speed");
    if (env.app.sliderNudge.value !== "-85") fail(`slider after Original speed: ${env.app.sliderNudge.value}`);
    if (!env.loaded.includes("/api/rooms/R1/lines/t1000/takes/f1/audio?v=2")) fail("new take audio not loaded");

    // Failure: a toast, the take stays as it was.
    await showLine(env, [fitted()], "f1");
    env.reply = (u) => (/\/original_speed$/.test(u) ? { status: 500 } : {});
    const toastsBefore = env.toasts.length;
    btnSpeed.click();
    await tick();
    if (env.toasts.length !== toastsBefore + 1) fail(`no error toast: ${JSON.stringify(env.toasts)}`);
    if (!shown(btnSpeed)) fail("Original speed hidden after a failed request");
    env.reply = null;

    // Someone else's line: no Original speed.
    await showLine(env, [fitted()], "f1", { host_id: "someone", role_assignments: { Ana: ["u9"] } });
    if (shown(btnSpeed)) fail("Original speed shown on a line you can't record");
    if (!shown(caption)) fail("fitted caption hidden on someone else's line");
    console.log("PASS: fitted caption, Original speed visibility, its POST and its error toast");
  }

  // 6. Takes panel: "Timing 82%" with a tooltip, best highlighted, nothing for null.
  {
    await showLine(env, [
      mk("h1", 1, { timing_score: 0.64 }),
      mk("h2", 2, { timing_score: 0.82 }),
      mk("h3", 3, { timing_score: null }),
    ], "h3");
    $(env, "btn-take-history").click();
    const rows = [...$(env, "take-history-panel").querySelectorAll(".take-history-row")];
    if (rows.length !== 3) fail(`rows: ${rows.length}`);
    const scores = rows.map((r) => r.querySelector(".take-history-timing"));
    if (scores[0]?.textContent !== "Timing 64%" || scores[1]?.textContent !== "Timing 82%") {
      fail(`scores: ${scores.map((s) => s && s.textContent)}`);
    }
    if (scores[2]) fail("a score shown for an unmeasured take");
    if (scores[1].dataset.tip !== SCORE_TIP) fail(`score tip: ${scores[1].dataset.tip}`);
    if (!scores[1].classList.contains("best") || scores[0].classList.contains("best")) fail("best-timed take not highlighted alone");
    console.log("PASS: Takes panel shows Timing N%, highlights the best, nothing for null");

    await showLine(env, [
      mk("z1", 1, { timing_score: -0.06 }),
      mk("z2", 2, { timing_score: 0 }),
    ], "z2");
    if (!env.app.takeHistoryOpen) $(env, "btn-take-history").click();
    const zRows = [...$(env, "take-history-panel").querySelectorAll(".take-history-row")];
    const zScores = zRows.map((r) => r.querySelector(".take-history-timing"));
    if (zScores[0]) fail("a negative score shown");
    if (zScores[1]?.textContent !== "Timing 0%") fail(`zero score: ${zScores[1] && zScores[1].textContent}`);
    if (zScores[1].classList.contains("best")) fail("a 0% take highlighted as best");
    console.log("PASS: Takes panel hides negative scores and never highlights 0%");
  }

  // 7. Upload: a fitted take never reuses the local recording; an unfitted one does.
  {
    const upload = async (stretch) => {
      await showLine(env, [], null);
      const url = `/api/rooms/R1/lines/t1000/takes/n${stretch}/audio?v=1`;
      env.reply = (u) => (/\/takes$/.test(u)
        ? { take: mk(`n${stretch}`, 1, { stretch, url }), line: { picked: `n${stretch}`, next_number: 2, takes: [mk(`n${stretch}`, 1, { stretch, url })] } }
        : {});
      const recorded = { duration: 2, local: true };
      await env.app.uploadTake(0, new env.w.Blob(["x"], { type: "audio/webm" }), recorded);
      env.reply = null;
      return { reused: env.app.screeningBuffers.get(url) === recorded };
    };
    if ((await upload(1.06)).reused) fail("fitted take reused the local recording");
    if (!(await upload(1.0)).reused) fail("unfitted take did not reuse the local recording");
    console.log("PASS: a fitted take previews the engine's audio, not the local recording");
  }

  // 8. guide_voice is the checkbox as it was when recording started, not when the take saves.
  {
    const app = env.app;
    const audio = app.audio;
    const saved = {
      ensureMicReady: app.ensureMicReady, ensureBackingBuffer: app.ensureBackingBuffer,
      startRecording: audio.startRecording, stopRecording: audio.stopRecording,
      stopAllPlayback: audio.stopAllPlayback, playMetronomePip: audio.playMetronomePip,
      origBuffer: app.origBuffer, backingBuffer: app.backingBuffer,
    };
    app.ensureMicReady = async () => true;
    app.ensureBackingBuffer = () => {};
    audio.startRecording = async () => {};
    audio.stopRecording = async () => ({ blob: new env.w.Blob(["x"], { type: "audio/webm" }), audioBuffer: null });
    audio.stopAllPlayback = () => {};
    audio.playMetronomePip = () => {};

    const record = async (atStart, atSave) => {
      await showLine(env, [], null);
      // No audio graph in JSDOM: skip the guide and backing playback.
      app.origBuffer = null;
      app.backingBuffer = null;
      env.reply = (u) => (/\/takes$/.test(u)
        ? { take: mk("g1", 1), line: { picked: "g1", next_number: 2, takes: [mk("g1", 1)] } }
        : {});
      app.checkGuideVoice.checked = atStart;
      const started = app.startCountdownAndRecord();
      for (let i = 0; i < 100 && app.recordState !== "recording"; i++) await tick();
      await started;
      if (app.recordState !== "recording") fail(`never started recording (state ${app.recordState})`);
      app.checkGuideVoice.checked = atSave;
      const before = env.calls.length;
      await app.finishRecording();
      env.reply = null;
      const post = env.calls.slice(before).find((c) => c.method === "POST" && /\/takes$/.test(c.url));
      if (!post) fail("finishing the take did not POST it");
      return post.body.get("guide_voice");
    };

    let sent = await record(true, false);
    if (sent !== "true") fail(`guide voice on while recording, off at save: sent ${sent}`);
    sent = await record(false, true);
    if (sent !== "false") fail(`guide voice off while recording, on at save: sent ${sent}`);

    Object.assign(app, { ensureMicReady: saved.ensureMicReady, ensureBackingBuffer: saved.ensureBackingBuffer,
      origBuffer: saved.origBuffer, backingBuffer: saved.backingBuffer });
    Object.assign(audio, { startRecording: saved.startRecording, stopRecording: saved.stopRecording,
      stopAllPlayback: saved.stopAllPlayback, playMetronomePip: saved.playMetronomePip });
    app.checkGuideVoice.checked = false;
    console.log("PASS: guide_voice follows the checkbox at recording start, not at save");
  }

  if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  console.log("All booth timing tests passed.");
  process.exit(0);
})();
