/**
 * test_booth_column.js
 *
 * The booth's right column (UI pass U2, group 1): the record deck's state badge and
 * next-action lines (READY, COUNT-IN, REC, SAVING, NO MIC, OFFLINE, someone else's
 * line), the segmented transport (Take N disabled until a take exists, the live A/B
 * switch while a take plays), the mic-sync hint, the Done footer with its inline ask
 * and the host's premiere dialog, the toolbar per role, the stage bar copy, and the
 * Level badge read from the take's real values. Socket and fetch are stubbed.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

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

const mk = (id, number, extra = {}) => ({ take_id: id, number, user_id: "u1", user_name: "Ana",
  duration: 0.8, url: `/api/rooms/R1/lines/t1000/takes/${id}/audio?v=1`, peaks: [],
  offset_ms: 0, gain_db: 0, ...extra });

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
  };
  w.scrollTo = () => {};
  w.confirm = (m) => fail(`window.confirm was used: ${m}`);
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });

  const calls = [];
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
  env.socketSent = [];
  app.showToast = (msg) => env.toasts.push(msg);
  app.user = { id: "u1", name: "Ana" };
  app.socket.send = (type, payload) => env.socketSent.push({ type, payload });
  app.socket.updateTakeParams = (lineId, takeId, params) => env.sent.push({ lineId, takeId, ...params });
  app.socket.connectionState = "open";
  app.audioSetup.permission = "granted";
  app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const visible = (el) => !!el && !el.hidden && el.style.display !== "none";

/** A room on these lines; Ana (u1) voices Ana unless `extra` says otherwise. */
function room(takes = {}, extra = {}) {
  return {
    state_version: 3, room_id: "R1", host_id: "u1", status: "recording",
    users: {
      u1: { id: "u1", name: "Ana", is_online: true, is_ready: false, color: "#d97706" },
      u9: { id: "u9", name: "Mika", is_online: true, is_ready: false, color: "#16a34a" },
    },
    role_assignments: { Ana: ["u1"], Ben: ["u9"] },
    pack: { id: "P", name: "Scene", lines: LINES, characters: ["Ana", "Ben"], video_url: "/v.mp4", line_count: 3 },
    takes,
    ...extra,
  };
}

const oneTake = (extra = {}) => ({ t1000: { picked: "a1", next_number: 2, takes: [mk("a1", 1, extra)] } });

async function show(env, state, index = 0) {
  env.app.roomState = state;
  await env.app.loadBoothLine(index);
  await tick();
}

(async () => {
  const env = await boot();
  const { app, w } = env;
  const doc = w.document;
  const badge = $(env, "record-engine-badge");
  const label = $(env, "record-status-label");
  const sub = $(env, "record-status-sub");
  const rec = $(env, "btn-record-main");
  const icon = $(env, "record-icon");

  // 1. The record deck's badge and lines follow the real state.
  {
    await show(env, room());
    if (!visible(badge) || text(badge) !== "READY") fail(`idle badge: ${visible(badge)} ${text(badge)}`);
    if (text(label) !== "Record take 1") fail(`idle label: ${text(label)}`);
    if (text(sub) !== "Space · 3-beat count-in") fail(`idle sub: ${text(sub)}`);
    if (rec.getAttribute("aria-label") !== "Record take 1 (Space)" || rec.dataset.tip !== "Record take 1 (Space)") {
      fail(`idle record name: ${rec.getAttribute("aria-label")} / ${rec.dataset.tip}`);
    }
    if (text(icon) !== "●") fail(`idle icon: ${text(icon)}`);

    await show(env, room(oneTake()));
    if (text(label) !== "Record take 2" || text(icon) !== "●") fail(`idle with a take: ${text(label)} ${text(icon)}`);

    app.recordState = "countdown";
    app.updateRecordButtonUI();
    if (text(badge) !== "COUNT-IN" || text(label) !== "Counting in… Space or click to cancel" || visible(sub)) {
      fail(`countdown: ${text(badge)} / ${text(label)} / ${visible(sub)}`);
    }
    if (rec.getAttribute("aria-label") !== "Cancel the count-in (Space)") fail(`countdown name: ${rec.getAttribute("aria-label")}`);
    if (text(icon) !== "✕") fail(`countdown icon: ${text(icon)}`);

    app.recordState = "recording";
    app.updateRecordButtonUI();
    if (text(badge) !== "REC" || !badge.classList.contains("is-rec") || text(label) !== "Recording · Space to stop") {
      fail(`recording: ${text(badge)} ${badge.className} / ${text(label)}`);
    }
    if (rec.getAttribute("aria-label") !== "Stop recording (Space)" || text(icon) !== "■") fail(`recording button: ${rec.getAttribute("aria-label")} ${text(icon)}`);

    app.recordState = "processing";
    app.updateRecordButtonUI();
    if (text(badge) !== "SAVING" || text(label) !== "Saving take 2…") fail(`saving: ${text(badge)} / ${text(label)}`);
    if (rec.getAttribute("aria-label") !== "Saving take 2") fail(`saving name: ${rec.getAttribute("aria-label")}`);
    app.recordState = "idle";

    // NO MIC: permission denied, with the plain mic line.
    app.audioSetup.permission = "denied";
    app.updateRecordButtonUI();
    if (text(badge) !== "NO MIC") fail(`denied badge: ${text(badge)}`);
    if (text(sub) !== "DubMate isn't allowed to use your microphone. Allow it, then try again.") fail(`denied line: ${text(sub)}`);

    // NO MIC: the last open failed. ensureMicReady keeps the error; a later success clears it.
    app.audioSetup.permission = "prompt";
    app.audioSetup.setupComplete = true;
    app.audio.getMicPermissionState = async () => "prompt";
    app.audio.requestMicrophone = async () => { const e = new Error("busy"); e.name = "NotReadableError"; throw e; };
    if (await app.ensureMicReady()) fail("ensureMicReady passed with a busy mic");
    if (text(badge) !== "NO MIC" || text(sub) !== "Another app is using your microphone. Close it and try again.") {
      fail(`failed open: ${text(badge)} / ${text(sub)}`);
    }
    app.audio.requestMicrophone = async () => {};
    app.audio.releaseMicrophone = () => {};
    app.refreshAudioDevices = async () => {};
    if (!(await app.ensureMicReady())) fail("ensureMicReady failed with a working mic");
    if (text(badge) !== "READY") fail(`badge after the mic came back: ${text(badge)}`);

    // OFFLINE: the room connection isn't open; the deck refreshes on connection_state.
    app.socket.connectionState = "reconnecting";
    app.socket.emit("connection_state", { type: "connection_state", payload: { state: "reconnecting" } });
    if (text(badge) !== "OFFLINE" || text(sub) !== "Takes will upload when you're back online.") {
      fail(`offline: ${text(badge)} / ${text(sub)}`);
    }
    app.socket.connectionState = "open";
    app.socket.emit("connection_state", { type: "connection_state", payload: { state: "open" } });
    if (text(badge) !== "READY") fail(`badge back online: ${text(badge)}`);

    // Someone else's line: no badge; who voices it.
    await show(env, room(), 2);
    if (visible(badge)) fail("badge shown on someone else's line");
    if (text(label) !== "Ben is voiced by Mika" || visible(sub)) fail(`other line: ${text(label)} / ${visible(sub)}`);
    console.log("PASS: the record deck shows READY, COUNT-IN, REC, SAVING, NO MIC, OFFLINE and who voices other lines");
  }

  // 2. Transport: Take N waits for a take; while the take plays, the other side switches in place.
  {
    const orig = $(env, "btn-play-orig");
    const take = $(env, "btn-preview-take");
    if ($(env, "btn-toggle-ab") || $(env, "label-ab-state")) fail("the old A/B switch is still there");
    await show(env, room());
    if (!take.disabled || text(take) !== "▶ Take") fail(`no take: ${take.disabled} ${text(take)}`);
    if (orig.disabled || text(orig) !== "▶ Original") fail(`original: ${orig.disabled} ${text(orig)}`);

    await show(env, room({ t1000: { picked: "b3", next_number: 4, takes: [mk("a1", 1), mk("b3", 3)] } }));
    if (take.disabled || text(take) !== "▶ Take 3") fail(`with take 3: ${take.disabled} ${text(take)}`);

    const spy = { orig: 0, preview: 0, ab: [] };
    const realOrig = app.playOriginalReference;
    const realPreview = app.previewCurrentTake;
    const realSetAB = app.audio.setABState;
    app.playOriginalReference = () => { spy.orig++; };
    app.previewCurrentTake = () => { spy.preview++; };
    app.audio.setABState = function (s) { spy.ab.push(s); this.abState = s; };

    // Idle: each side plays from the line start.
    orig.click();
    take.click();
    if (spy.orig !== 1 || spy.preview !== 1) fail(`idle presses: ${JSON.stringify(spy)}`);
    if (spy.ab[spy.ab.length - 1] !== "A") fail("Take did not start on the take side");

    // The take is playing: Original switches what you hear in place, and back.
    app.isPlayingTake = true;
    app.playingHistoryTakeId = null;
    app.renderTransport();
    if (take.getAttribute("aria-pressed") !== "true" || orig.getAttribute("aria-pressed") !== "false") fail("pressed state while the take plays");
    spy.ab = [];
    orig.click();
    if (spy.ab.join() !== "B" || spy.orig !== 1 || !app.isPlayingTake) fail(`switch to the original: ${JSON.stringify(spy)}`);
    if (orig.getAttribute("aria-pressed") !== "true" || take.getAttribute("aria-pressed") !== "false") fail("pressed state after switching");
    take.click();
    if (spy.ab.join() !== "B,A" || spy.preview !== 1) fail(`switch back: ${JSON.stringify(spy)}`);
    // Pressing the side you hear stops it.
    take.click();
    if (app.isPlayingTake || take.getAttribute("aria-pressed") !== "false") fail("pressing the playing side did not stop");

    // The original playing on its own: pressed, and nothing else.
    app.isPlayingReference = true;
    app.renderTransport();
    if (orig.getAttribute("aria-pressed") !== "true" || take.getAttribute("aria-pressed") !== "false") fail("pressed state for the original");
    app.isPlayingReference = false;

    app.playOriginalReference = realOrig;
    app.previewCurrentTake = realPreview;
    app.audio.setABState = realSetAB;
    app.stopBoothPlayback();
    console.log("PASS: Take N waits for a take, each side plays when idle, and the other side switches in place");
  }

  // 3. Mic-sync advice: an inline hint once per device pair per tab, not a toast.
  {
    await show(env, room());
    const hint = $(env, "mic-sync-hint");
    if (visible(hint)) fail("hint shown before any take");
    const realLoad = app.loadBoothLine;
    app.loadBoothLine = async () => {};
    env.reply = (u) => (/\/takes$/.test(u) ? { take: mk("n1", 1), line: { picked: "n1", next_number: 2, takes: [mk("n1", 1)] } } : {});
    env.toasts.length = 0;
    await app.uploadTake(0, new w.Blob(["x"], { type: "audio/webm" }));
    if (!visible(hint) || text(hint.querySelector(".mic-sync-hint-text")) !== "Sync your mic so takes line up on their own.") {
      fail(`hint after the first take: ${visible(hint)} ${text(hint)}`);
    }
    if (env.toasts.join() !== "Take saved") fail(`toasts: ${JSON.stringify(env.toasts)}`);
    $(env, "btn-mic-sync-dismiss").click();
    if (visible(hint)) fail("× did not close the hint");
    await app.uploadTake(0, new w.Blob(["x"], { type: "audio/webm" }));
    if (visible(hint)) fail("hint came back in the same tab");
    env.reply = null;
    app.loadBoothLine = realLoad;
    console.log("PASS: the mic-sync advice is an inline hint, once per device pair per tab");
  }

  // 4. Stage bar and timing: scene numbering, one decimal, one timing readout.
  {
    await show(env, room(oneTake({ offset_ms: -120, auto_offset_ms: -120, aligned: true })));
    if (text($(env, "booth-line-indicator")) !== "Line 1 of 3") fail(`stage line: ${text($(env, "booth-line-indicator"))}`);
    if (text($(env, "booth-time-badge")) !== "0.9 s") fail(`stage time: ${text($(env, "booth-time-badge"))}`);
    const tip = $(env, "booth-line-indicator").dataset.tip;
    if (tip !== "Your line 1 of 2 · 0.7–1.6 s") fail(`stage tip: ${tip}`);
    if ($(env, "waveform-offset-legend")) fail("the second offset readout is still there");
    if (text($(env, "nudge-display")) !== "-120 ms") fail(`readout: ${text($(env, "nudge-display"))}`);
    const reset = doc.querySelector(".btn-nudge-reset");
    if (text(reset) !== "Reset to auto") fail(`reset label: ${text(reset)}`);
    if (!reset.classList.contains("is-active")) fail("Reset to auto not active at the automatic timing");
    app.setNudgeValue(-95, true);
    if (reset.classList.contains("is-active")) fail("Reset to auto active after a nudge");
    await show(env, room(oneTake({ offset_ms: 0 })));
    if (!reset.classList.contains("is-active")) fail("an older take at 0 ms isn't at its automatic timing");
    const hint = doc.querySelector(".nudge-preset-bar .timing-drag-hint");
    if (!hint || text(hint) !== "Drag or press [ ] to adjust timing" || !visible(hint)) fail("drag hint not in the timing row");
    await show(env, room());
    if (visible(hint)) fail("drag hint shown with no take");
    console.log("PASS: the stage bar reads 'Line 1 of 3 · 0.9 s', one timing readout, Reset to auto at auto only");
  }

  // 5. Level: "✓ Matched" comes from the take's real gain and auto gain, not the 0.5-step dial.
  {
    const matchBadge = $(env, "badge-gain-match");
    const autoBtn = $(env, "btn-auto-match-gain");
    await show(env, room(oneTake({ gain_db: 1.87, auto_gain_db: 1.87 })));
    if (!visible(matchBadge) || text(matchBadge) !== "✓ Matched") fail(`matched take: ${visible(matchBadge)} ${text(matchBadge)}`);
    if (!visible(autoBtn)) fail("Auto hidden on a take with an auto gain");
    await show(env, room(oneTake({ gain_db: 3, auto_gain_db: 1.87 })));
    if (visible(matchBadge)) fail(`badge shown on an unmatched take: ${text(matchBadge)}`);
    if (doc.body.textContent.includes("Match:")) fail("'Match: …' is still shown");
    env.sent.length = 0;
    autoBtn.click();
    const last = env.sent[env.sent.length - 1];
    if (!last || last.gain_db !== 1.87) fail(`Auto sent ${JSON.stringify(last)}`);
    if (!visible(matchBadge) || text(matchBadge) !== "✓ Matched") fail("badge not back after Auto");
    console.log("PASS: ✓ Matched follows take.gain_db against take.auto_gain_db, and Auto sends the exact auto gain");
  }

  // 6. Toolbar per role.
  {
    const ready = $(env, "btn-toggle-ready");
    const start = $(env, "btn-launch-premiere");
    const jump = $(env, "btn-jump-screening");
    // Host, lines left to record.
    await show(env, room(oneTake()));
    app.renderCastActivityHUD();
    if (!visible(start) || text(start) !== "Start premiere · 0/2 ready" || !start.classList.contains("btn-primary")) {
      fail(`host start: ${visible(start)} ${text(start)} ${start.className}`);
    }
    if (visible(jump)) fail("host sees Premiere ›");
    if (text(ready) !== "Mark ready" || !ready.classList.contains("btn-secondary")) fail(`host ready: ${text(ready)} ${ready.className}`);
    // Host, every line recorded: still secondary.
    const allMine = { ...oneTake(), t2000: { picked: "c1", next_number: 2, takes: [mk("c1", 1)] } };
    await show(env, room(allMine));
    app.renderCastActivityHUD();
    if (text(ready) !== "All recorded · Mark ready" || !ready.classList.contains("btn-secondary")) fail(`host all recorded: ${text(ready)} ${ready.className}`);
    if (doc.querySelectorAll("#view-booth .stage-top-bar .btn-primary:not([hidden])").length !== 1) fail("host toolbar has more than one primary");

    // Guest: no Start; Back to the premiere only while it's on; All recorded is the primary.
    await show(env, room(allMine, { host_id: "u9" }));
    app.renderCastActivityHUD();
    if (visible(start)) fail("guest sees Start premiere");
    if (visible(jump)) fail("guest sees the premiere button while recording");
    if (text(ready) !== "All recorded · Mark ready" || !ready.classList.contains("btn-primary")) fail(`guest all recorded: ${text(ready)} ${ready.className}`);
    await show(env, room(oneTake(), { host_id: "u9" }));
    app.renderCastActivityHUD();
    if (text(ready) !== "Mark ready" || !ready.classList.contains("btn-secondary")) fail(`guest with lines left: ${text(ready)} ${ready.className}`);
    await show(env, room(oneTake(), { host_id: "u9", status: "screening" }));
    app.renderCastActivityHUD();
    if (!visible(jump) || text(jump) !== "Back to the premiere") fail(`guest during the premiere: ${visible(jump)} ${text(jump)}`);
    console.log("PASS: the host has one primary, Start premiere · 0/2 ready; guests get Back to the premiere and All recorded · Mark ready");
  }

  // 7. Done: the last line asks inline when lines have no take; the host then gets a dialog.
  {
    const next = $(env, "btn-next-line");
    const ask = $(env, "booth-done-ask");
    await show(env, room(oneTake()), 0);
    if (text(next) !== "Next line ›") fail(`first line footer: ${text(next)}`);
    if ($(env, "btn-clear-take")) fail("the trash button is still in the footer");
    await show(env, room(oneTake()), 1);
    if (text(next) !== "Done ›" || !next.classList.contains("btn-primary")) fail(`last line footer: ${text(next)} ${next.className}`);
    next.click();
    if (!visible(ask) || text($(env, "booth-done-ask-text")) !== "1 of 2 lines recorded. Mark ready anyway?") {
      fail(`inline ask: ${visible(ask)} ${text(ask)}`);
    }
    if (app.isReadyForScreening) fail("marked ready before answering");
    if (visible(next)) fail("Done still shown under the ask");
    $(env, "btn-done-keep-recording").click();
    if (visible(ask) || !visible(next) || app.isReadyForScreening) fail("Keep recording did not put the footer back");

    const views = [];
    const realShowView = app.showView;
    const realSetup = app.setupScreeningView;
    app.showView = (v) => views.push(v);
    app.setupScreeningView = () => {};
    next.click();
    $(env, "btn-done-mark-ready").click();
    if (!app.isReadyForScreening) fail("Mark ready did not mark you ready");
    const dialog = $(env, "modal-go-premiere");
    if (dialog.hidden || text($(env, "go-premiere-title")) !== "Go to the premiere now?" || text($(env, "go-premiere-text")) !== "1 of 2 ready.") {
      fail(`host dialog: ${dialog.hidden} ${text(dialog)}`);
    }
    $(env, "btn-go-premiere").click();
    if (views.join() !== "screening" || !dialog.hidden) fail(`Go to the premiere: ${views} ${dialog.hidden}`);

    // A guest with every line recorded: Done marks ready at once, no ask, no dialog.
    app.isReadyForScreening = false;
    const allMine = { ...oneTake(), t2000: { picked: "c1", next_number: 2, takes: [mk("c1", 1)] } };
    await show(env, room(allMine, { host_id: "u9" }), 1);
    next.click();
    if (visible(ask) || !app.isReadyForScreening || !dialog.hidden) fail(`guest done: ask ${visible(ask)} ready ${app.isReadyForScreening} dialog ${!dialog.hidden}`);
    app.showView = realShowView;
    app.setupScreeningView = realSetup;
    console.log("PASS: Done marks you ready, asks inline when lines are missing, and the host's premiere question is a dialog");
  }

  // 8. An open tooltip follows the record button's state.
  {
    await show(env, room());
    const tip = $(env, "dm-tip");
    const Pointer = w.PointerEvent || w.Event;
    rec.dispatchEvent(new Pointer("pointerover", { bubbles: true }));
    if (text(tip) !== "Record take 1 (Space)") fail(`open tip: ${text(tip)}`);
    app.recordState = "countdown";
    app.updateRecordButtonUI();
    await tick();
    if (text(tip) !== "Cancel the count-in (Space)") fail(`open tip after the count-in started: ${text(tip)}`);
    app.recordState = "idle";
    app.updateRecordButtonUI();
    console.log("PASS: the record button's open tooltip follows its state");
  }

  if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  console.log("All booth column checks passed");
  process.exit(0);
})();
