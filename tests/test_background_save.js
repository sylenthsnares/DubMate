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
    if (!chip(env, 0).classList.contains("is-saving") || text(chip(env, 0).querySelector(".chip-saving")) !== "↑") fail(`chip 1: ${chip(env, 0).className} ${text(chip(env, 0))}`);
    if (!/saving a take/.test(chip(env, 0).getAttribute("aria-label"))) fail(`chip 1 name: ${chip(env, 0).getAttribute("aria-label")}`);
    if (!presets(env).length || presets(env).some((b) => !b.disabled)) fail("line 1's Voice controls aren't locked while it saves");
    if (!beforeUnloadBlocked(env)) fail("leaving the page isn't guarded while a take saves");
    for (const id of ["btn-next-line", "btn-prev-line", "btn-play-orig", "nav-step-lobby"]) {
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
    if (chip(env, 0).classList.contains("is-saving") || text(chip(env, 0).querySelector(".chip-count")) !== "1"
      || !/1 take$/.test(chip(env, 0).getAttribute("aria-label"))) fail(`chip 1 after the save: ${text(chip(env, 0))}`);

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

  // 5. A failed upload is kept, retried when the room is back, and dropped by Discard.
  {
    app.roomState = room();
    await app.loadBoothLine(0);
    app.recordState = "recording";
    env.toasts.length = 0;
    const first = app.finishRecording();
    await tick();
    const lost = env.uploads.shift();
    lost.reject(new TypeError("Failed to fetch"));
    await first;
    await tick();
    if (app.savingLines.t1000) fail("still saving after the upload failed");
    if ((app.pendingUploads.t1000 || []).length !== 1) fail("the failed take wasn't kept");
    if (env.toasts.some((t) => /record it again/i.test(t))) fail(`asked to record again: ${env.toasts}`);
    let rows = pendingRows(env);
    if (rows.length !== 1 || !text(rows[0]).startsWith("Take · waiting to upload")) fail(`waiting row: ${rows.map(text)}`);
    if (!rows[0].querySelector(".take-retry")) fail("no Retry on the waiting row");
    if (!beforeUnloadBlocked(env)) fail("leaving the page isn't guarded while a take waits");
    if (!/waiting/.test(chip(env, 0).getAttribute("aria-label"))) fail(`chip name while waiting: ${chip(env, 0).getAttribute("aria-label")}`);

    // Offline: the take lane dims; back 'open': the kept take goes up again with its own fields.
    app.socket.connectionState = "reconnecting";
    app.socket.emit("connection_state", { type: "connection_state", payload: { state: "reconnecting" } });
    await tick();
    if (!app.waveform.takeLaneDimmed) fail("the take lane isn't dimmed while offline");
    if (env.uploads.length) fail("retried while still offline");
    app.socket.connectionState = "open";
    app.socket.emit("connection_state", { type: "connection_state", payload: { state: "open" } });
    await tick();
    if (app.waveform.takeLaneDimmed) fail("the take lane stays dimmed once back");
    if (env.uploads.length !== 1) fail("the kept take wasn't retried on 'open'");
    const retried = env.uploads[0].body;
    if (retried.get("noise_reduction") !== lost.body.get("noise_reduction") || retried.get("offset_ms") !== lost.body.get("offset_ms")
        || retried.get("gain_db") !== lost.body.get("gain_db")) fail("the retry didn't send the fields kept with the take");
    if (!app.savingLines.t1000 || (app.pendingUploads.t1000 || []).length) fail("the retrying take isn't shown as saving");
    answerUpload(env, "t1000", 1);
    await tick();
    if ((app.pendingUploads.t1000 || []).length || app.savingLines.t1000) fail("the retried take is still waiting");
    if (text($(env, "takes-card-title")) !== "TAKES · 1") fail(`card after the retry: ${text($(env, "takes-card-title"))}`);

    // Retry by hand, then Discard from the ⋯ menu.
    app.recordState = "recording";
    const third = app.finishRecording();
    await tick();
    env.uploads.shift().resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await third;
    await tick();
    rows = pendingRows(env);
    if (rows.length !== 1) fail("a server error didn't keep the take");
    rows[0].querySelector(".take-retry").click();
    await tick();
    if (env.uploads.length !== 1) fail("Retry didn't upload the kept take");
    env.uploads.shift().reject(new TypeError("Failed to fetch"));
    await tick();
    rows = pendingRows(env);
    if (rows.length !== 1) fail("the take isn't kept after a failed retry");
    rows[0].querySelector(".take-more").click();
    const discard = [...rows[0].querySelectorAll('[role="menuitem"]')].find((b) => /Discard/.test(text(b)));
    if (!discard) fail("no Discard in the waiting take's menu");
    const before = env.calls.length;
    discard.click();
    await tick();
    if ((app.pendingUploads.t1000 || []).length || pendingRows(env).length) fail("Discard kept the take");
    if (env.calls.length !== before) fail("Discard sent a request");
    if (beforeUnloadBlocked(env)) fail("leaving the page is still guarded after Discard");
    console.log("PASS: a failed take is kept, retried on 'open' and by Retry, dropped by Discard, and guards leaving");
  }

  // 6. On a saving line the takes can't change: no "Use this take" cue, a row click picks
  //    nothing, and ⋯ (Delete) is off; ▶ still plays.
  {
    const t = mk("t1000", "k1", 1);
    const t2 = mk("t1000", "k2", 2);
    app.roomState = room({ t1000: { picked: "k2", next_number: 3, takes: [t, t2] } });
    await app.loadBoothLine(0);
    app.savingLines.t1000 = { roomId: "R1", lineId: "t1000", number: 3, noiseReduction: false };
    app.renderTakesCard();
    const row = $(env, "takes-list").querySelector('[data-take-id="k1"]');
    if (row.querySelector(".take-use-cue")) fail("the Use this take cue shows on a saving line");
    if (text(pendingRows(env)[0]) !== "Take 3 · Saving…") fail(`saving row without cleanup: ${text(pendingRows(env)[0])}`);
    const picks = env.calls.filter((c) => /\/pick$/.test(c.url)).length;
    row.querySelector('[role="radio"]').click();
    await tick();
    if (env.calls.filter((c) => /\/pick$/.test(c.url)).length !== picks) fail("a row click picked a take while the line saves");
    const more = row.querySelector(".take-more");
    if (!more.disabled) fail("⋯ (Delete) works on a saving line");
    if (row.querySelector(".take-play").disabled) fail("▶ is off while the line saves");
    delete app.savingLines.t1000;
    app.renderTakesCard();
    if ($(env, "takes-list").querySelector('[data-take-id="k1"] .take-more').disabled) fail("⋯ stayed off after the save");
    console.log("PASS: a saving line's takes are locked: no Use cue, no pick, ⋯ off; ▶ still plays");
  }

  // 7. On a saving line, Level, Auto and the timing are locked too, [ and ] included: they'd
  //    change the take in the dub while the new one uploads.
  {
    const t = { ...mk("t1000", "k1", 1), auto_gain_db: 2 };
    app.roomState = room({ t1000: { picked: "k1", next_number: 2, takes: [t] } });
    await app.loadBoothLine(0);
    if ($(env, "slider-gain").disabled || $(env, "btn-auto-match-gain").disabled) fail("Level is locked on a line that isn't saving");
    app.savingLines.t1000 = { roomId: "R1", lineId: "t1000", number: 2, noiseReduction: false };
    app.renderLineSaveState("t1000");
    const locked = ["slider-gain", "btn-auto-match-gain", "slider-nudge"].filter((id) => !$(env, id).disabled);
    if (locked.length) fail(`not locked while the line saves: ${locked}`);
    if ([...w.document.querySelectorAll(".btn-nudge")].some((b) => !b.disabled)) fail("the timing nudges work while the line saves");
    let sent = 0;
    app.socket.updateTakeParams = () => { sent++; };
    const before = $(env, "slider-nudge").value;
    w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
    w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }));
    if (sent || $(env, "slider-nudge").value !== before) fail("[ or ] nudged the take while its line saves");
    app.socket.updateTakeParams = () => {};
    delete app.savingLines.t1000;
    app.renderLineSaveState("t1000");
    if ($(env, "slider-gain").disabled || $(env, "slider-nudge").disabled) fail("Level or timing stayed locked after the save");
    console.log("PASS: Level, Auto and the timing lock while the line saves");
  }

  // 8. A, "," and "." do nothing while counting in or recording: the take isn't thrown away.
  {
    app.roomState = room();
    await app.loadBoothLine(0);
    env.uploads.length = 0;
    w.document.dispatchEvent(new w.KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
    await tick();
    if (app.recordState !== "countdown") fail(`Space didn't count in (${app.recordState})`);
    for (const key of ["a", ",", "."]) {
      w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await tick();
      if (app.recordState !== "countdown" || app.currentLineIndex !== 0) fail(`"${key}" during the count-in: ${app.recordState}, line ${app.currentLineIndex}`);
    }
    for (let i = 0; i < 150 && app.recordState !== "recording"; i++) await tick();
    if (app.recordState !== "recording") fail("never started recording");
    for (const key of ["a", "A", ",", "."]) {
      w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await tick();
      if (app.recordState !== "recording" || app.currentLineIndex !== 0 || !app.audio.isRecording) {
        fail(`"${key}" while recording: ${app.recordState}, line ${app.currentLineIndex}, recorder ${app.audio.isRecording}`);
      }
    }
    const saved = app.finishRecording();
    await tick();
    if (env.uploads.length !== 1 || !/\/lines\/t1000\/takes$/.test(env.uploads[0].url)) fail("the take wasn't uploaded after the keys");
    answerUpload(env, "t1000", 1);
    await saved;
    await tick();
    console.log("PASS: A, ',' and '.' don't throw away a count-in or a recording");
  }

  // 9. The engine refusing a take (4xx) says why and drops it; it isn't kept to retry forever.
  {
    app.roomState = room();
    await app.loadBoothLine(0);
    env.toasts.length = 0;
    app.recordState = "recording";
    const done = app.finishRecording();
    await tick();
    env.uploads.shift().resolve({ ok: false, status: 403,
      json: () => Promise.resolve({ detail: "Line 1 belongs to Ana. Only their actor can record it." }) });
    await done;
    await tick();
    if ((app.pendingUploads.t1000 || []).length || pendingRows(env).length) fail("a refused take was kept to retry");
    if (app.savingLines.t1000) fail("still saving after a refusal");
    if (env.toasts.join() !== "Line 1 belongs to Ana. Only their actor can record it.") fail(`refusal toast: ${JSON.stringify(env.toasts)}`);
    if (beforeUnloadBlocked(env)) fail("leaving the page is guarded for a refused take");
    console.log("PASS: a take the engine refuses says why and isn't kept");
  }

  // 10. Small things: your take's echo before the upload's reply shows one row, not two; a
  //     background save doesn't scroll the line chips; the empty take lane and the record
  //     deck tell the truth on lines you can't record.
  {
    const mine2 = mk("t1000", "e2", 2);
    app.roomState = room({ t1000: { picked: "e2", next_number: 3, takes: [mk("t1000", "e1", 1), mine2] } });
    await app.loadBoothLine(0);
    await tick();
    // The strip centres its chip with its own scrollTo (JSDOM has no layout: give it a
    // width, a scroll range and a position away from the chip, so the move isn't a no-op).
    let scrolled = 0;
    const strip = $(env, "timeline-chips");
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => 2000 });
    Object.defineProperty(strip, "scrollLeft", { configurable: true, get: () => 500, set: () => {} });
    strip.scrollTo = () => { scrolled++; };
    app.savingLines.t1000 = { roomId: "R1", lineId: "t1000", number: 2, noiseReduction: false };
    app.renderLineSaveState("t1000");
    await tick();
    if (pendingRows(env).length) fail("the saving row shows next to the take it already became");
    if (scrolled) fail("a save-state redraw scrolled the line chips");
    delete app.savingLines.t1000;
    app.renderLineSaveState("t1000");
    await app.loadBoothLine(1);
    await tick();
    if (!scrolled) fail("a line change didn't scroll its chip into view");
    for (const prop of ["scrollTo", "clientWidth", "scrollWidth", "scrollLeft"]) delete strip[prop];

    await app.loadBoothLine(2);
    if (app.waveform.emptyTakeText !== "No takes yet.") fail(`empty lane on Ben's line: ${app.waveform.emptyTakeText}`);
    await app.loadBoothLine(0);
    if (app.waveform.emptyTakeText !== "No takes yet. Press Space to record.") fail(`empty lane on your line: ${app.waveform.emptyTakeText}`);
    app.roomState = { ...room(), role_assignments: { Ana: ["u1"] } };
    await app.loadBoothLine(2);
    if (text(label) !== "Nobody is cast as Ben yet") fail(`uncast line: ${text(label)}`);
    console.log("PASS: one row after an early echo, chips stay put on a save, truthful empty lane and deck");
  }

  // 11. A take waiting on a line that was saving another goes up once that save is done,
  //     not only at the next reconnect.
  {
    app.roomState = room();
    await app.loadBoothLine(0);
    env.uploads.length = 0;
    app.recordState = "recording";
    const first = app.finishRecording();
    await tick();
    env.uploads.shift().reject(new TypeError("Failed to fetch"));
    await first;
    await tick();
    if ((app.pendingUploads.t1000 || []).length !== 1) fail("the failed take wasn't kept");
    app.recordState = "recording";
    const second = app.finishRecording();
    await tick();
    answerUpload(env, "t1000", 1);
    await second;
    await tick();
    if (env.uploads.length !== 1 || (app.pendingUploads.t1000 || []).length) fail("the waiting take didn't go up after the line's save");
    answerUpload(env, "t1000", 2);
    await tick();
    if (app.savingLines.t1000 || (app.pendingUploads.t1000 || []).length) fail("still saving or waiting after both takes went up");
    console.log("PASS: a waiting take goes up as soon as its line's other save is done");
  }

  console.log("PASS: test_background_save");
  process.exit(0);
})();
