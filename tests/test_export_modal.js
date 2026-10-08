/**
 * test_export_modal.js
 *
 * The export modal of UI pass U5a (documentation/design/ui-u5a-premiere-export.md,
 * section 3, plan step 40). Only the host's explicit Save opens it.
 *  - Rendering: "Saving your dub", "Mixing your takes…" then "Making the video…", two real
 *    steps, an indeterminate bar that is a progressbar named by its step (no fake
 *    percentage), the keep-open line, and no close X. Esc and the backdrop do nothing.
 *  - After the poll window only "Keep working" is left; polling carries on.
 *  - Failed: a red FAILED badge, an alert icon, "The export didn't finish", the reason,
 *    Try again (the same format) and Close. No Watch, no Download, no toast.
 *  - Done: "Your dub is ready" with the facts ("16:9 · 0:06 · in DubMate Exports"),
 *    "Watch the dub" (plays for everyone), then Show in folder and Make 9:16 version on
 *    the engine's computer, or Download 16:9 / 9:16 for a remote host. No text Close;
 *    Esc closes and focus goes back to Save.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const BUNDLE = buildStudioBundle();
const EXPORTS_DIR = "C:\\Users\\Ana\\Videos\\DubMate Exports";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const norm = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const isShown = (el) => !!el && !el.hidden && !el.closest("[hidden]");

/** Boots the studio at url. `engine` decides what the export routes answer. */
async function boot(url) {
  const { JSDOM, VirtualConsole } = jsdom;
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(HTML, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.scrollTo = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [], addEventListener: () => {} } });

  const calls = [];
  const engine = { post: { status: "processing" }, poll: { status: "processing" }, postGate: null };
  w.fetch = async (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    const answer = (body, status = 200) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (u.startsWith("/api/rooms/R1/export?")) {
      if (engine.postGate) await engine.postGate;
      return engine.post.status >= 400 ? answer({ detail: engine.post.detail }, engine.post.status) : answer(engine.post);
    }
    if (u.startsWith("/api/rooms/R1/export/status")) return answer(engine.poll);
    if (u.startsWith("/api/packs")) return answer([]);
    if (u.startsWith("/api/config")) return answer({ mic_sync: {}, exports_dir: EXPORTS_DIR });
    return answer({ status: "ok" });
  };
  // The status poll runs on setInterval; the test drives its ticks.
  const intervals = new Map();
  let nextId = 1;
  w.setInterval = (fn) => { const id = nextId++; intervals.set(id, fn); return id; };
  w.clearInterval = (id) => { intervals.delete(id); };

  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(BUNDLE);
  await tick(20);
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  const toasts = [];
  app.showToast = (m) => toasts.push(String(m));
  app.user = { id: "u1", name: "Ana" };
  const sent = [];
  app.socket.send = (type, payload) => sent.push({ type, payload });
  const video = app.screeningVideo;
  let paused = true;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
  video.play = () => { paused = false; return Promise.resolve(); };
  video.pause = () => { paused = true; };
  app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 2 });

  app.roomState = {
    state_version: 3, room_id: "R1", host_id: "u1", status: "screening",
    users: { u1: { id: "u1", name: "Ana", is_online: true } },
    role_assignments: {}, voice: { session: null, characters: {} },
    pack: { id: "P", name: "Scene", lines: [], characters: ["Ana"], video_url: "/v.mp4", duration: 6 },
    takes: {}, master_dialogue_presence_db: 0, master_mix_balance: 50,
    exports: { "16:9": "idle", "9:16": "idle" },
    has_export: false, export_video_url: null, download_url: null,
  };
  app.showView("screening");
  await app.setupScreeningView();

  /** One tick of the export's status poll. */
  const pollTick = async () => {
    const fn = intervals.get(app.exportPollInterval);
    if (!fn) fail("no status poll is running");
    await fn();
    await tick();
  };
  return { w, app, doc: w.document, calls, engine, sent, toasts, errors, pollTick, intervals };
}

const readyPoll = (aspect) => ({
  status: "ready", aspect_ratio: aspect, duration: 6.0,
  export_video_url: `/api/rooms/R1/export/video?aspect_ratio=${aspect}&v=1`,
  download_url: `/api/rooms/R1/export/download?aspect_ratio=${aspect}`,
  download_url_16_9: "/api/rooms/R1/export/download?aspect_ratio=16:9",
  download_url_9_16: "/api/rooms/R1/export/download?aspect_ratio=9:16",
});

(async () => {
  const { w, app, doc, calls, engine, sent, toasts, errors, pollTick } = await boot("http://127.0.0.1:8000/");
  const $ = (id) => doc.getElementById(id);
  const modal = $("modal-export-rendering");
  const save = $("btn-export-video");
  const visibleButtons = () => [...modal.querySelectorAll("button, a")].filter(isShown);
  const visibleLabels = () => visibleButtons().filter((b) => b.id !== "btn-modal-close-x").map(norm);
  const esc = () => doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const isOpen = () => !modal.hidden && modal.classList.contains("is-open");

  if (!modal.hidden || modal.style.display) fail("the export modal is not hidden through the hidden attribute");
  if ($("modal-step-ready") || $("connector-mux-ready")) fail("the modal still has the Finish step");
  if ($("btn-modal-dismiss")) fail("the modal still has the text Close button");
  if (/✕/.test(norm($("btn-modal-close-x"))) || !$("btn-modal-close-x").querySelector("svg")) fail("the close X is a glyph, not an SVG");

  // --- Rendering ---------------------------------------------------------------------
  let releasePost;
  engine.postGate = new Promise((r) => { releasePost = r; });
  save.focus();
  save.click();
  await tick();
  if (!isOpen()) fail("Save did not open the export modal");
  if (!modal.contains(doc.activeElement)) fail(`focus did not move into the modal: ${doc.activeElement && doc.activeElement.id}`);
  if (norm($("export-modal-title")) !== "Saving your dub") fail(`rendering title: ${norm($("export-modal-title"))}`);
  if (norm($("export-modal-status-text")) !== "Mixing your takes…") fail(`status while the POST is out: ${norm($("export-modal-status-text"))}`);
  const track = modal.querySelector(".modal-progress-track");
  const fill = $("export-modal-progress-bar");
  if (track.getAttribute("role") !== "progressbar" || track.getAttribute("aria-valuetext") !== "Mix audio" || track.hasAttribute("aria-valuenow")) {
    fail(`progressbar: role=${track.getAttribute("role")} valuetext=${track.getAttribute("aria-valuetext")} now=${track.getAttribute("aria-valuenow")}`);
  }
  if (!fill.classList.contains("indeterminate") || fill.style.width) fail(`the bar fakes a percentage: ${fill.className} ${fill.style.width}`);
  if (!isShown(track) || !isShown($("modal-step-dsp")) || !isShown($("modal-step-mux"))) fail("the steps or the bar are hidden while rendering");
  if (!isShown($("export-modal-reassurance")) || norm($("export-modal-reassurance")) !== "Keep this window open until it's done.") {
    fail(`keep-open line: ${norm($("export-modal-reassurance"))}`);
  }
  if (isShown($("btn-modal-close-x"))) fail("the close X shows while rendering");
  if (visibleLabels().length) fail(`actions while rendering: ${visibleLabels()}`);
  if (!isShown(modal.querySelector(".render-film-reel"))) fail("the reel is hidden while rendering");

  esc();
  if (!isOpen()) fail("Esc closed the modal while rendering");
  modal.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  if (!isOpen()) fail("a backdrop click closed the modal while rendering");

  releasePost();
  engine.postGate = null;
  await tick(5);
  if (norm($("export-modal-status-text")) !== "Making the video…") fail(`status once processing: ${norm($("export-modal-status-text"))}`);
  if (track.getAttribute("aria-valuetext") !== "Make video") fail(`progressbar step: ${track.getAttribute("aria-valuetext")}`);
  if (!$("modal-step-mux").classList.contains("active") || !$("modal-step-dsp").classList.contains("completed")) fail("the step strip did not move to Make video");
  esc();
  if (!isOpen()) fail("Esc closed the modal while making the video");
  console.log("PASS: rendering says what it does, its bar is a named progressbar, and Esc and the backdrop do nothing");

  // --- Timeout: only Keep working --------------------------------------------------------
  for (let i = 0; i < 90; i++) await pollTick();
  if (!isOpen()) fail("the timeout closed the modal");
  for (const id of ["export-modal-badge", "modal-step-dsp", "export-modal-progress-bar", "export-modal-reassurance"]) {
    if (isShown($(id))) fail(`#${id} still shows after the timeout`);
  }
  if (norm($("export-modal-status-text")) !== "Still saving. Long scenes take a few minutes. The video shows up here when it's done.") {
    fail(`timeout line: ${norm($("export-modal-status-text"))}`);
  }
  if (visibleLabels().join("|") !== "Keep working") fail(`timeout actions: ${visibleLabels()}`);
  const keep = visibleButtons().find((b) => norm(b) === "Keep working");
  if (!keep.classList.contains("btn-primary")) fail("Keep working is not the primary");
  if (!app.exportPollInterval) fail("the timeout stopped polling");
  keep.click();
  if (isOpen()) fail("Keep working did not close the modal");
  if (doc.activeElement !== save) fail(`focus did not return to Save: ${doc.activeElement && doc.activeElement.id}`);
  // The poll still lands the video, without reopening the modal.
  engine.poll = readyPoll("16:9");
  await pollTick();
  if (isOpen()) fail("a video that landed after Keep working reopened the modal");
  if (app.exportState("16:9") !== "ready" || norm($("label-export-btn")) !== "Saved") fail(`after the late video: ${norm($("label-export-btn"))}`);
  console.log("PASS: after the poll window only Keep working is left, and the video still lands");

  // --- Failed --------------------------------------------------------------------------
  const failedChecks = (where) => {
    if (!isOpen()) fail(`${where}: the modal closed on a failure`);
    const badge = $("export-modal-badge");
    if (!isShown(badge) || norm(badge) !== "FAILED" || !badge.classList.contains("failed")) fail(`${where}: badge ${norm(badge)} ${badge.className}`);
    if (isShown(modal.querySelector(".render-film-reel")) || !isShown($("export-modal-icon-failed"))) fail(`${where}: the reel still spins instead of the alert icon`);
    if (!$("export-modal-icon-failed").querySelector("svg")) fail(`${where}: the alert icon is not an SVG`);
    if (norm($("export-modal-title")) !== "The export didn't finish") fail(`${where}: title ${norm($("export-modal-title"))}`);
    if (visibleLabels().join("|") !== "Try again|Close") fail(`${where}: actions ${visibleLabels()}`);
    if (!visibleButtons().find((b) => norm(b) === "Try again").classList.contains("btn-primary")) fail(`${where}: Try again is not the primary`);
    if (!visibleButtons().find((b) => norm(b) === "Close").classList.contains("btn-secondary")) fail(`${where}: Close is not secondary`);
    if (isShown(track)) fail(`${where}: the bar still shows`);
    if (toasts.length) fail(`${where}: the failure also toasted ${JSON.stringify(toasts)}`);
  };
  app.roomState.exports = { "16:9": "idle", "9:16": "idle" };
  app.updateScreeningControls();
  engine.poll = { status: "failed: ffmpeg returned non-zero exit status 1" };
  toasts.length = 0;
  save.focus();
  save.click();
  await tick(5);
  await pollTick();
  failedChecks("poll failure");
  if (norm($("export-modal-status-text")) !== "Something went wrong.") fail(`the reason: ${norm($("export-modal-status-text"))}`);
  if (app.exportState("16:9") !== "failed") fail(`Save does not know the render failed: ${app.exportState("16:9")}`);

  // Try again re-runs the same format; a refused POST says the engine's reason.
  calls.length = 0;
  engine.post = { status: 409, detail: "Older takes are being refreshed. Try again in a moment." };
  visibleButtons().find((b) => norm(b) === "Try again").click();
  await tick(5);
  const retried = calls.find((c) => c.method === "POST" && c.url.startsWith("/api/rooms/R1/export?"));
  if (!retried || !/aspect_ratio=16:9/.test(retried.url)) fail(`Try again did not save 16:9: ${JSON.stringify(calls)}`);
  failedChecks("refused");
  if (norm($("export-modal-status-text")) !== "Older takes are being refreshed. Try again in a moment.") fail(`refusal reason: ${norm($("export-modal-status-text"))}`);
  esc();
  if (isOpen()) fail("Esc did not close a failed modal");
  if (doc.activeElement !== save) fail("focus did not return to Save after a failure");

  // export_failed from the socket while the modal is open, for 9:16; Try again keeps 9:16.
  engine.post = { status: "processing" };
  engine.poll = { status: "processing" };
  app.exportFinalVideo("9:16");
  await tick(5);
  const deliver = (type, payload, state = {}) => {
    const data = { type, payload, state: { ...app.roomState, ...state } };
    app.socket.emit(type, data);
    app.socket.emit("*", data);
  };
  deliver("export_failed", { aspect_ratio: "9:16", error: "timed out" }, { exports: { "16:9": "failed", "9:16": "failed" } });
  failedChecks("export_failed");
  if (norm($("export-modal-status-text")) !== "That took too long.") fail(`socket failure reason: ${norm($("export-modal-status-text"))}`);
  calls.length = 0;
  visibleButtons().find((b) => norm(b) === "Try again").click();
  await tick(5);
  if (!calls.some((c) => c.method === "POST" && /aspect_ratio=9:16/.test(c.url))) fail(`Try again lost the 9:16 format: ${JSON.stringify(calls)}`);
  if (norm($("export-modal-title")) !== "Saving your dub") fail("Try again did not go back to saving");
  console.log("PASS: a failure shows FAILED, the reason, Try again for the same format and Close, with no Watch, Download or toast");

  // --- Done (engine's computer) ----------------------------------------------------------
  engine.poll = readyPoll("9:16");
  await pollTick();
  // 9:16 done: no Make 9:16 version.
  if (norm($("export-modal-title")) !== "Your dub is ready") fail(`9:16 done title: ${norm($("export-modal-title"))}`);
  await tick(5);
  if (!/^9:16 · 0:06/.test(norm($("export-modal-status-text")))) fail(`9:16 facts: ${norm($("export-modal-status-text"))}`);
  if (visibleLabels().includes("Make 9:16 version")) fail("Make 9:16 version shows when 9:16 is ready");
  esc();

  app.roomState.exports = { "16:9": "idle", "9:16": "idle" };
  app.roomState.has_export = false;
  app.updateScreeningControls();
  engine.poll = readyPoll("16:9");
  save.focus();
  save.click();
  await tick(5);
  await pollTick();
  await tick(5);
  if (!isOpen()) fail("done closed the modal");
  if (norm($("export-modal-title")) !== "Your dub is ready") fail(`done title: ${norm($("export-modal-title"))}`);
  const facts = $("export-modal-status-text");
  if (norm(facts) !== "16:9 · 0:06 · in DubMate Exports" || facts.getAttribute("title") !== EXPORTS_DIR) fail(`done facts: "${norm(facts)}" title=${facts.getAttribute("title")}`);
  if ($("export-saved-path")) fail("the separate Saved to line is still there");
  for (const id of ["export-modal-badge", "modal-step-dsp", "export-modal-progress-bar", "export-modal-reassurance"]) {
    if (isShown($(id))) fail(`#${id} still shows when done`);
  }
  if (isShown(modal.querySelector(".render-film-reel")) || !isShown($("export-modal-icon-done")) || !$("export-modal-icon-done").querySelector("svg")) fail("done shows the reel, not a static check");
  if (!isShown($("btn-modal-close-x"))) fail("done has no close X");
  if (visibleLabels().join("|") !== "Watch the dub|Show in folder|Make 9:16 version") fail(`done actions: ${visibleLabels()}`);
  const watch = $("btn-modal-close-view");
  if (!watch.classList.contains("btn-primary") || norm(watch) !== "Watch the dub") fail("Watch the dub is not the primary");
  if (visibleButtons().some((b) => norm(b) === "Close" || /download/i.test(norm(b)))) fail("done has a text Close or a Download on the engine's computer");
  if (visibleButtons().filter((b) => b.classList.contains("btn-primary")).length !== 1) fail("done has more than one primary");

  // Show in folder reveals this video.
  calls.length = 0;
  $("btn-modal-reveal").click();
  await tick(5);
  const reveal = calls.find((c) => c.url === "/api/rooms/R1/export/reveal");
  if (!reveal || JSON.stringify(JSON.parse(reveal.body)) !== JSON.stringify({ kind: "video", aspect_ratio: "16:9", user_id: "u1" })) fail(`Show in folder: ${JSON.stringify(calls)}`);

  // Esc closes once done and focus goes back to Save.
  esc();
  if (isOpen()) fail("Esc did not close the done modal");
  if (doc.activeElement !== save) fail(`focus after done: ${doc.activeElement && doc.activeElement.id}`);

  // Watch the dub plays from the start for everyone.
  engine.post = { ...readyPoll("16:9"), status: "ok" };
  app.exportFinalVideo("16:9");
  await tick(5);
  if (!isOpen() || norm($("export-modal-title")) !== "Your dub is ready") fail("an already saved video did not open done");
  sent.length = 0;
  watch.click();
  if (isOpen()) fail("Watch the dub did not close the modal");
  const controls = sent.filter((m) => m.type === "screening_control").map((m) => `${m.payload.action}@${m.payload.timestamp}`);
  if (controls.join() !== "seek@0,play@0") fail(`Watch the dub sent ${JSON.stringify(controls)}`);

  // Make 9:16 version goes back into saving, in this modal.
  app.roomState.exports = { "16:9": "ready", "9:16": "idle" };
  engine.post = { ...readyPoll("16:9"), status: "ok" };
  app.exportFinalVideo("16:9");
  await tick(5);
  if (!isShown($("btn-modal-make-916"))) fail("Make 9:16 version is missing while 9:16 isn't saved");
  calls.length = 0;
  engine.post = { status: "processing" };
  $("btn-modal-make-916").click();
  await tick(5);
  if (!calls.some((c) => c.method === "POST" && /aspect_ratio=9:16/.test(c.url))) fail(`Make 9:16 version: ${JSON.stringify(calls)}`);
  if (!isOpen() || norm($("export-modal-title")) !== "Saving your dub" || isShown($("btn-modal-close-x"))) fail("Make 9:16 version did not go back to saving in the modal");
  if (!modal.contains(doc.activeElement)) fail("focus left the modal when 9:16 started");
  esc();
  if (!isOpen()) fail("Esc closed the modal while 9:16 was saving");
  engine.poll = readyPoll("9:16");
  await pollTick();
  esc();
  console.log("PASS: done says the format, length and folder; Watch the dub plays for everyone; Show in folder and Make 9:16 version work; Esc closes and focus returns to Save");

  if (errors.length) fail(`console errors: ${errors.join("\n")}`);

  // --- A remote host: the facts without the folder, and Download 16:9 / 9:16 ---------------
  const r = await boot("http://192.168.1.5:8000/");
  const $r = (id) => r.doc.getElementById(id);
  const rModal = $r("modal-export-rendering");
  const rLabels = () => [...rModal.querySelectorAll("button, a")].filter(isShown).filter((b) => b.id !== "btn-modal-close-x").map(norm);
  r.engine.poll = readyPoll("16:9");
  $r("btn-export-video").click();
  await tick(5);
  await r.pollTick();
  await tick(5);
  if (norm($r("export-modal-status-text")) !== "16:9 · 0:06" || $r("export-modal-status-text").hasAttribute("title")) fail(`remote facts: ${norm($r("export-modal-status-text"))}`);
  if (rLabels().join("|") !== "Watch the dub|Download 16:9|Download 9:16") fail(`remote done actions: ${rLabels()}`);
  if ($r("btn-modal-download-169").getAttribute("href") !== "/api/rooms/R1/export/download?aspect_ratio=16:9") fail("Download 16:9 has no href");
  // 9:16 isn't saved: Download 9:16 makes it first, visibly, in this modal.
  r.calls.length = 0;
  r.engine.poll = { status: "processing" };
  $r("btn-modal-download-916").click();
  await tick(5);
  if (!r.calls.some((c) => c.method === "POST" && /aspect_ratio=9:16/.test(c.url))) fail(`remote Download 9:16 did not make it first: ${JSON.stringify(r.calls)}`);
  if (r.calls.some((c) => c.url.includes("/export/download"))) fail("remote Download 9:16 downloaded a video that isn't saved");
  if (norm($r("export-modal-title")) !== "Saving your dub") fail("remote Download 9:16 did not show the saving state");
  // When it lands, it downloads.
  r.engine.poll = readyPoll("9:16");
  r.calls.length = 0;
  await r.pollTick();
  await tick(5);
  if (!r.calls.some((c) => c.url === "/api/rooms/R1/export/download?aspect_ratio=9:16")) fail(`remote 9:16 did not download once made: ${JSON.stringify(r.calls)}`);
  if (r.errors.length) fail(`remote console errors: ${r.errors.join("\n")}`);
  console.log("PASS: a remote host sees the format and length, and Download 9:16 makes it first, in the modal, then downloads it");

  // --- A long folder is shortened in the middle, the full path in title ---------------------
  app.exportsDirCache = "D:\\Media\\A very long folder name for the DubMate renders of this summer";
  app.roomState.exports = { "16:9": "idle", "9:16": "idle" };
  engine.post = { status: "processing" };
  engine.poll = readyPoll("16:9");
  app.exportFinalVideo("16:9");
  await tick(5);
  await pollTick();
  await tick(5);
  const longFacts = norm($("export-modal-status-text"));
  const folder = longFacts.split(" · in ")[1] || "";
  if (!/^16:9 · 0:06 · in /.test(longFacts) || !folder.includes("…") || folder.length > 32 || !folder.startsWith("A very") || !folder.endsWith("summer")) {
    fail(`long folder: ${longFacts}`);
  }
  if ($("export-modal-status-text").getAttribute("title") !== app.exportsDirCache) fail("the long folder's full path is not in title");
  console.log("PASS: a long folder name is shortened in the middle, with the full path in title");

  console.log("ALL EXPORT MODAL TESTS PASSED");
  process.exit(0);
})();
