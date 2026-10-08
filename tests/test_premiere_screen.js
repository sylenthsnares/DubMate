/**
 * test_premiere_screen.js
 *
 * The premiere screen of UI pass U5a (documentation/design/ui-u5a-premiere-export.md,
 * sections 1, 2, 4 and 6):
 *  - Save's label follows the room's 16:9 export state (Save video, Saving…, Saved,
 *    Mix changed · Save again), and its menu makes 9:16 on demand inline, without the modal;
 *  - a member sees "Download video", the host's mix read-only, and no sliders, separate
 *    tracks or editing project;
 *  - the host's own mix echo is ignored, so a slider never jumps back mid-drag;
 *  - a finished video swaps in at the next pause, never mid-play, keeping the position;
 *  - export_invalidated drops the saved video for the live mix and reads "Mix changed";
 *  - nobody but the client that pressed Save gets the export modal;
 *  - a failed render says why, with Try again for the host;
 *  - the Mix presets send both values; anything else reads Custom;
 *  - the header's live dot is amber, and the Audio tooltip fits a remote member.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const BUNDLE = buildStudioBundle();

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const norm = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const isShown = (el) => !!el && !el.hidden && !el.closest("[hidden]");

async function boot(url, calls) {
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
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.startsWith("/api/rooms/R1/export?")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "processing" }) });
    }
    const body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : { status: "ok" };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(BUNDLE);
  await tick(20);
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  return { w, app, errors };
}

(async () => {
  const calls = [];
  const { w, app, errors } = await boot("http://127.0.0.1:8000/", calls);
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  app.showToast = () => {};
  app.user = { id: "u1", name: "Ana" };
  const sent = [];
  app.socket.send = (type, payload) => sent.push({ type, payload });

  // The theater's video: playing state and position are the test's.
  const video = app.screeningVideo;
  let paused = true;
  let position = 0;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => position, set: (v) => { position = v; } });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
  video.play = () => { paused = false; return Promise.resolve(); };
  video.pause = () => { paused = true; };
  app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 2 });

  const lines = [
    { line_id: "t1000", index: 0, character: "Ana", start: 1, end: 3, duration: 2, peaks: [], audio_url: "/orig0.wav", text: "Hi" },
  ];
  const baseState = () => ({
    state_version: 3, room_id: "R1", host_id: "u1", status: "screening",
    users: { u1: { id: "u1", name: "Ana", is_online: true }, u2: { id: "u2", name: "Ben", is_online: true } },
    role_assignments: {}, voice: { session: null, characters: {} },
    pack: { id: "P", name: "Scene", lines, characters: ["Ana"], video_url: "/v.mp4", duration: 6 },
    takes: {}, master_dialogue_presence_db: 0, master_mix_balance: 50,
    exports: { "16:9": "processing", "9:16": "idle" },
    has_export: false, export_video_url: null, download_url: null,
  });
  const deliver = (type, payload, state = {}) => {
    const data = { type, payload, state: { ...app.roomState, ...state } };
    app.socket.emit(type, data);
    app.socket.emit("*", data);
  };
  const readyPayload = (aspect) => ({
    aspect_ratio: aspect,
    export_video_url: `/api/rooms/R1/export/video?aspect_ratio=${aspect}&v=1`,
    download_url: `/api/rooms/R1/export/download?aspect_ratio=${aspect}`,
  });

  app.roomState = baseState();
  app.showView("screening");
  await app.setupScreeningView();

  const main = $("btn-export-video");
  const label = () => norm($("label-export-btn"));
  const chevron = $("btn-save-menu");
  const menu = $("save-menu");
  const row = (id) => $(id);
  const rowState = (id) => norm(row(id).querySelector(".save-menu-state"));
  if (!main || !chevron || !menu) fail("the Save split button is missing");
  if (!main.classList.contains("btn-secondary") || main.classList.contains("btn-success")) fail(`Save is not a secondary button: ${main.className}`);
  for (const gone of ["btn-aspect-16-9", "btn-back-booth", "export-progress-box", "btn-download-link", "btn-toolbar-stems",
    "btn-toolbar-project-zip", "screening-master-badge", "screening-host-badge"]) {
    if ($(gone)) fail(`#${gone} is still on the premiere`);
  }
  if (doc.querySelector("#view-screening .screening-header-card, #view-screening .btn-presence-preset, #view-screening .btn-success, #view-screening .btn-project-zip")) {
    fail("the premiere still has the title card, the presence pills or a green / project button");
  }
  if (!$("screening-timeline")) fail("no slot for the timeline under the video");
  if (/[▶⏸↺]/.test(norm($("btn-screening-play-pause")) + norm($("btn-screening-replay")))) fail("Play or Replay still uses a glyph icon");
  if (!$("btn-screening-play-pause").querySelector("svg") || !$("btn-screening-replay").querySelector("svg")) fail("Play or Replay has no SVG icon");
  console.log("PASS: the premiere has one Save split button, an SVG Play and Replay, and none of the old controls");

  // --- Save follows the room's 16:9 state -------------------------------------------
  if (label() !== "Saving…" || main.getAttribute("aria-busy") !== "true" || main.getAttribute("aria-disabled") !== "true") {
    fail(`processing: "${label()}" busy=${main.getAttribute("aria-busy")} disabled=${main.getAttribute("aria-disabled")}`);
  }
  if (norm($("screening-status-desc")) !== "You control playback for everyone.") fail(`host status: ${norm($("screening-status-desc"))}`);
  if (norm($("screening-source-label")) !== "Live mix") fail(`source: ${norm($("screening-source-label"))}`);
  if ($("screening-source-label").getAttribute("data-tip") !== "What everyone hears now. Save makes the video from this mix.") fail("Live mix has no tooltip");
  // Nobody opened a modal for the premiere's own render.
  if ($("modal-export-rendering").style.display === "flex") fail("the premiere's background render opened the modal");

  deliver("export_ready", readyPayload("16:9"), { exports: { "16:9": "ready", "9:16": "idle" }, has_export: true });
  if (label() !== "Saved" || main.hasAttribute("aria-busy") || main.getAttribute("aria-disabled") === "true") fail(`ready: "${label()}"`);
  if (!main.querySelector("svg.save-icon-check")) fail("Saved has no check icon");
  if (!app.isUsingExportedVideo || norm($("screening-source-label")) !== "Final video") fail("a paused theater did not swap to the final video");
  if ($("screening-source-label").hasAttribute("data-tip")) fail("Final video kept the live mix tooltip");

  // The mix changes: the saved video is dropped for the live mix.
  deliver("export_invalidated", {}, { exports: { "16:9": "idle", "9:16": "idle" }, has_export: false });
  if (label() !== "Mix changed · Save again") fail(`after export_invalidated: "${label()}"`);
  if (main.getAttribute("data-tip") !== "Save makes a new video with the new mix.") fail("Mix changed has no tooltip");
  if (app.isUsingExportedVideo || norm($("screening-source-label")) !== "Live mix") fail("export_invalidated kept the old final video");

  // Main click: Save again opens the export (and its modal) for 16:9.
  const exportsAsked = [];
  const realExport = app.exportFinalVideo;
  app.exportFinalVideo = (aspect) => { exportsAsked.push(aspect); };
  main.click();
  if (exportsAsked.join() !== "16:9") fail(`Save again exported ${JSON.stringify(exportsAsked)}`);
  app.exportFinalVideo = realExport;

  deliver("export_started", { aspect_ratio: "16:9" }, { exports: { "16:9": "processing", "9:16": "idle" } });
  if (label() !== "Saving…") fail(`export_started: "${label()}"`);
  if ($("modal-export-rendering").style.display === "flex") fail("export_started opened the modal for a host who didn't press Save");
  deliver("export_started", { aspect_ratio: "16:9", restarted: true }, { exports: { "16:9": "processing", "9:16": "idle" } });
  if (label() !== "Saving…") fail(`restarted: "${label()}"`);
  console.log("PASS: Save reads Saving…, Saved and Mix changed · Save again from the room's state; no modal for a render nobody here started");

  // --- A failure says why, with Try again ---------------------------------------------
  deliver("export_failed", { aspect_ratio: "16:9", error: "timed out" }, { exports: { "16:9": "failed", "9:16": "idle" } });
  if (label() !== "Save video" && label() !== "Mix changed · Save again") fail(`failed: "${label()}"`);
  const errLine = $("screening-save-error");
  if (!isShown(errLine) || !/^The video didn't save: /.test(norm(errLine)) || /timed out/.test(norm(errLine))) fail(`failure line: ${norm(errLine)}`);
  const retry = $("btn-save-retry");
  if (!retry || !retry.classList.contains("btn-ghost") || !retry.classList.contains("btn-sm")) fail("no Try again ghost button");
  app.exportFinalVideo = (aspect) => { exportsAsked.push(aspect); };
  exportsAsked.length = 0;
  retry.click();
  if (exportsAsked.join() !== "16:9") fail(`Try again exported ${JSON.stringify(exportsAsked)}`);
  app.exportFinalVideo = realExport;
  deliver("export_started", { aspect_ratio: "16:9" }, { exports: { "16:9": "processing", "9:16": "idle" } });
  if (isShown(errLine)) fail("the failure line stayed after a new render started");
  console.log("PASS: a failed render tells the host why and Try again saves it again");

  // --- Swap at the next pause, never mid-play -------------------------------------------
  app.exportStale = false;
  app.applyLiveMixToTheater();
  paused = false;
  position = 3.25;
  deliver("export_ready", readyPayload("16:9"), { exports: { "16:9": "ready", "9:16": "idle" }, has_export: true });
  if (app.isUsingExportedVideo || /export\/video/.test(video.getAttribute("src") || "")) fail("the final video swapped in mid-play");
  if (!app.pendingExportSwap) fail("no swap was queued for the next pause");
  if (label() !== "Saved") fail(`ready while playing: "${label()}"`);
  position = 4.5;
  app.pauseScreeningPlayback();
  if (!app.isUsingExportedVideo || !/export\/video\?aspect_ratio=16:9/.test(video.getAttribute("src") || "")) fail("the pause did not swap to the final video");
  if (position !== 4.5) fail(`the swap moved the position to ${position}`);
  if (app.pendingExportSwap) fail("the queued swap was not cleared");
  if (video.muted) fail("the final video plays muted");
  console.log("PASS: a finished video waits for the next pause and keeps the position");

  // --- The 9:16 row renders on demand, inline ------------------------------------------
  chevron.click();
  if (chevron.getAttribute("aria-expanded") !== "true" || menu.hidden) fail("the chevron did not open the menu");
  if (doc.activeElement !== row("save-menu-video-169")) fail("opening the menu did not focus its first row");
  if (rowState("save-menu-video-169") !== "saved · Show in folder") fail(`16:9 row: ${rowState("save-menu-video-169")}`);
  if (!isShown(row("save-menu-stems")) || !isShown(row("save-menu-project"))) fail("the host has no separate tracks or editing project");
  calls.length = 0;
  row("save-menu-video-916").click();
  await tick(5);
  const post = calls.find((c) => c.method === "POST" && c.url.startsWith("/api/rooms/R1/export?"));
  if (!post) fail(`9:16 was not asked for: ${JSON.stringify(calls)}`);
  const params = new w.URL(post.url, "http://x").searchParams;
  if (params.get("aspect_ratio") !== "9:16" || params.get("user_id") !== "u1" || params.get("balance") !== "50" || !params.has("presence")) fail(`9:16 request: ${post.url}`);
  if (rowState("save-menu-video-916") !== "Making…" || !row("save-menu-video-916").querySelector(".save-menu-bar")) fail(`9:16 row while making: ${rowState("save-menu-video-916")}`);
  if (label() !== "Saved") fail(`the main label changed for 9:16: "${label()}"`);
  if ($("modal-export-rendering").style.display === "flex") fail("9:16 on demand opened the modal");
  if (menu.hidden) fail("the menu closed while 9:16 was being made");
  deliver("export_ready", readyPayload("9:16"), { exports: { "16:9": "ready", "9:16": "ready" }, has_export: true });
  if (rowState("save-menu-video-916") !== "saved · Show in folder") fail(`9:16 row when ready: ${rowState("save-menu-video-916")}`);
  if (!/aspect_ratio=16:9/.test(video.getAttribute("src") || "")) fail("the 9:16 video replaced the theater's 16:9");
  calls.length = 0;
  row("save-menu-video-916").click();
  await tick(5);
  const reveal = calls.find((c) => c.url === "/api/rooms/R1/export/reveal");
  if (!reveal || reveal.method !== "POST" || JSON.stringify(JSON.parse(reveal.body)) !== JSON.stringify({ kind: "video", aspect_ratio: "9:16", user_id: "u1" })) {
    fail(`Show in folder: ${JSON.stringify(reveal)}`);
  }

  // Arrow keys move through the rows, Esc closes and gives focus back to the chevron.
  row("save-menu-video-169").focus();
  menu.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  if (doc.activeElement !== row("save-menu-video-916")) fail("ArrowDown did not move to the next row");
  menu.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  if (doc.activeElement !== row("save-menu-video-169")) fail("ArrowUp did not move back");
  menu.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (!menu.hidden || chevron.getAttribute("aria-expanded") !== "false" || doc.activeElement !== chevron) fail("Esc did not close the menu onto the chevron");

  // Saved, on the engine's computer: the main part shows the video in its folder.
  calls.length = 0;
  main.click();
  await tick(5);
  const reveal169 = calls.find((c) => c.url === "/api/rooms/R1/export/reveal");
  if (!reveal169 || JSON.parse(reveal169.body).aspect_ratio !== "16:9") fail(`Saved did not show the video in its folder: ${JSON.stringify(calls)}`);
  console.log("PASS: 9:16 renders on demand inline, Show in folder reveals the file, and the menu works from the keyboard");

  // --- Mix presets ----------------------------------------------------------------------
  const mix = $("screening-mix");
  if (!mix || mix.tagName !== "DETAILS" || mix.open) fail("Mix is not a closed disclosure");
  const summary = () => norm(mix.querySelector("summary"));
  if (summary() !== "Mix · Balanced") fail(`host summary: ${summary()}`);
  const presets = [...mix.querySelectorAll('[role="radiogroup"] [role="radio"]')];
  if (presets.map(norm).join("|") !== "Balanced|Voices forward|Music forward") fail(`presets: ${presets.map(norm)}`);
  sent.length = 0;
  presets[1].click();
  if (!sent.some((m) => m.type === "set_mix_balance" && m.payload.balance === 65)) fail(`Voices forward balance: ${JSON.stringify(sent)}`);
  if (!sent.some((m) => m.type === "set_dialogue_presence" && m.payload.presence_db === 2.5)) fail(`Voices forward level: ${JSON.stringify(sent)}`);
  if (summary() !== "Mix · Voices forward" || presets[1].getAttribute("aria-checked") !== "true" || presets[0].getAttribute("aria-checked") !== "false") fail(`after Voices forward: ${summary()}`);
  if (label() !== "Mix changed · Save again") fail(`a preset kept "${label()}"`);
  app.setScreeningBalance(70, { share: true });
  if (summary() !== "Mix · Custom" || presets.some((p) => p.getAttribute("aria-checked") === "true")) fail(`custom: ${summary()}`);
  if (!isShown($("slider-screening-balance")) && !$("screening-fine-tune")) fail("the host has no Fine-tune");
  if ($("slider-screening-balance").closest("details") !== $("screening-fine-tune")) fail("the sliders are not inside Fine-tune");
  console.log("PASS: a Mix preset sends the balance and the dialogue level; anything else reads Custom");

  // --- The host's own echo is ignored; another's change applies ---------------------------
  app.setScreeningBalance(80, { share: true });
  deliver("mix_balance_sync", { balance: 70, triggered_by: "u1" });
  if (app.screeningBalance !== 80 || $("slider-screening-balance").value !== "80") fail(`the host's echo moved the slider to ${app.screeningBalance}`);
  app.setMasterDialoguePresence(4);
  deliver("dialogue_presence_sync", { presence_db: 2.5, triggered_by: "u1" });
  if (app.masterDialoguePresence !== 4) fail(`the host's echo moved the level to ${app.masterDialoguePresence}`);
  deliver("mix_balance_sync", { balance: 35, triggered_by: "u9" });
  deliver("dialogue_presence_sync", { presence_db: 0, triggered_by: "u9" });
  if (app.screeningBalance !== 35 || summary() !== "Mix · Music forward") fail(`another's change: ${app.screeningBalance} ${summary()}`);
  console.log("PASS: the host's own mix echo is ignored; another change applies and updates the summary");

  // --- A member: Download, the host's mix read-only, no host controls -------------------
  app.user = { id: "u2", name: "Ben" };
  sent.length = 0;
  app.roomState = { ...baseState(), exports: { "16:9": "processing", "9:16": "idle" }, master_mix_balance: 65, master_dialogue_presence_db: 2.5 };
  app.exportStale = false;
  await app.setupScreeningView();
  if (label() !== "Download video" || main.getAttribute("aria-disabled") !== "true") fail(`member, nothing saved: "${label()}"`);
  if (main.getAttribute("data-tip") !== "The host hasn't saved the video yet.") fail(`member tooltip: ${main.getAttribute("data-tip")}`);
  if (norm($("screening-status-desc")) !== "The host is saving the video…") fail(`member status while saving: ${norm($("screening-status-desc"))}`);
  if (summary() !== "Mix · Voices forward · set by the host") fail(`member summary: ${summary()}`);
  if (isShown($("slider-screening-balance")) || isShown($("slider-dialogue-presence")) || presets.some(isShown)) fail("a member sees the mix controls");
  const memberLine = $("screening-mix-member");
  if (!isShown(memberLine) || !/The host sets the mix\. You hear what the video will sound like\./.test(norm(memberLine)) || !/Voices forward/.test(norm(memberLine))) {
    fail(`member mix line: ${norm(memberLine)}`);
  }
  if (isShown(row("save-menu-stems")) || isShown(row("save-menu-project"))) fail("a member sees separate tracks or the editing project");
  if (rowState("save-menu-video-916") !== "Not saved yet" || row("save-menu-video-916").getAttribute("aria-disabled") !== "true") fail(`member 9:16: ${rowState("save-menu-video-916")}`);
  calls.length = 0;
  main.click();
  row("save-menu-video-916").click();
  await tick(5);
  if (calls.some((c) => c.url.includes("/export"))) fail(`a member's disabled Download asked the engine: ${JSON.stringify(calls)}`);
  // A member's mix calls stay local.
  app.setScreeningBalance(20, { share: true });
  app.setMasterDialoguePresence(-3);
  if (sent.some((m) => m.type === "set_mix_balance" || m.type === "set_dialogue_presence")) fail(`a member sent the mix: ${JSON.stringify(sent)}`);

  deliver("export_started", { aspect_ratio: "16:9" }, { exports: { "16:9": "processing", "9:16": "idle" } });
  if ($("modal-export-rendering").style.display === "flex") fail("a member got the export modal");
  deliver("export_failed", { aspect_ratio: "16:9", error: "timed out" }, { exports: { "16:9": "failed", "9:16": "idle" } });
  if (!/^The video didn't save: /.test(norm($("screening-status-desc"))) || isShown($("screening-save-error"))) fail(`member failure: ${norm($("screening-status-desc"))}`);
  deliver("export_ready", readyPayload("16:9"), { exports: { "16:9": "ready", "9:16": "idle" }, has_export: true });
  if (label() !== "Download video" || main.getAttribute("aria-disabled") === "true" || main.hasAttribute("data-tip")) fail(`member, saved: "${label()}"`);
  if (norm($("screening-status-desc")) !== "The host controls playback. Space or Replay plays it just for you.") fail(`member status: ${norm($("screening-status-desc"))}`);
  if (rowState("save-menu-video-169") !== "Download") fail(`member 16:9 row: ${rowState("save-menu-video-169")}`);
  console.log("PASS: a member gets Download video, the host's mix read-only and no host controls or modal");

  // --- Header: the live dot is amber -------------------------------------------------------
  const dot = $("crumb-premiere-live");
  if (!dot.classList.contains("badge-live-dot-amber")) fail(`the premiere's live dot: ${dot.className}`);
  // The Audio tooltip closes when Audio settings opens.
  const audioBtn = $("btn-audio-settings");
  audioBtn.focus();
  const tip = $("dm-tip");
  if (!tip || !tip.classList.contains("is-visible")) fail("focusing Audio did not show its tooltip");
  audioBtn.click();
  if (tip.classList.contains("is-visible")) fail("the Audio tooltip stayed over Audio settings");
  console.log("PASS: the premiere's live dot is amber and the Audio tooltip closes when the dialog opens");

  if (errors.length) fail(`console errors: ${errors.join("\n")}`);

  // A remote member's Audio tooltip leaves out the export folder.
  const remote = await boot("http://192.168.1.5:8000/", []);
  const remoteTip = remote.w.document.getElementById("btn-audio-settings").getAttribute("data-tip");
  if (remoteTip !== "Microphone and headphones") fail(`remote Audio tooltip: ${remoteTip}`);
  const localTip = $("btn-audio-settings").getAttribute("data-tip");
  if (localTip !== "Microphone, headphones and export folder") fail(`local Audio tooltip: ${localTip}`);
  console.log("PASS: a remote member's Audio tooltip reads Microphone and headphones");

  console.log("ALL PREMIERE SCREEN TESTS PASSED");
  process.exit(0);
})();
