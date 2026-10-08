/**
 * test_builder_process.js
 *
 * Pack Builder's processing screen (UI plan 40f). One function, renderProcessState,
 * writes the whole view from one state, so:
 *  - every stage starts pending; Upload (driven by XHR upload progress) comes first
 *    only while a file still needs uploading;
 *  - the headline is the active stage, the bar caption is the engine's message, and
 *    only finished stages get a tick; skipped stages read "Skipped";
 *  - a failure stops the radar, turns one row red with the message (once, no toast),
 *    names the failed stage and offers a way forward by error_code and stage;
 *  - Try again re-POSTs /process with no upload, Back to video keeps everything,
 *    Write the lines myself opens an empty editor;
 *  - Cancel aborts the upload or POSTs /cancel, and returns to Video at once;
 *  - a failed subtitle import stops before /process.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "builder.html"), "utf8");
const BOOT = "new PackBuilderApp();";
const bundle = buildStudioBundle("static/js/pack_builder.js").replace(BOOT, "window.__builderApp = " + BOOT);
const { JSDOM, VirtualConsole } = jsdom;

const ALL = { separation: true, transcription: true, link_import: true, speakers: true, romaji: true, gpu: false };
const MB = 1024 * 1024;
const ROWS = ["stage-upload", "stage-extract", "stage-stems", "stage-whisper", "stage-speakers"];
const EMPTY_HINT = "Play the video and press N, or Add line, where someone speaks.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function check(cond, msg) {
  if (!cond) fail(msg);
  console.log("PASS: " + msg);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el ? (typeof el.innerText === "string" ? el.innerText : el.textContent).replace(/\s+/g, " ").trim() : "");
function shown(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden || n.style.display === "none") return false;
  }
  return true;
}

/**
 * Boots builder.html with a fake XMLHttpRequest (kept in `xhrs`, answered by the
 * test), a fake EventSource (kept in `sources`) and a stubbed fetch (kept in
 * `requests`). opts.fetch(url, init, json) answers a request first when it returns
 * a promise.
 */
async function boot(opts = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(err);
  });
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  const dom = new JSDOM(html, { url: "http://localhost:8000/builder.html", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  const proto = w.HTMLMediaElement.prototype;
  proto.load = function () {};
  proto.play = function () { return Promise.resolve(); };
  proto.pause = function () {};

  const requests = [];
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  w.fetch = (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || "GET", body: init.body });
    const own = opts.fetch && opts.fetch(u, init, json);
    if (own) return own;
    if (u === "/api/builder/capabilities") return json(opts.caps || ALL);
    if (u.includes("/waveform")) return json({ peaks: [], duration: 10 });
    return json({});
  };

  const xhrs = [];
  w.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.aborted = false; this.status = 0; xhrs.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(body) { this.body = body; }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    progress(loaded, total) { this.upload.onprogress({ lengthComputable: true, loaded, total }); }
    respond(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  };

  const sources = [];
  w.EventSource = class {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
    send(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
  };

  if (w.document.readyState === "loading") {
    await new Promise((r) => w.document.addEventListener("DOMContentLoaded", r));
  }
  const toasts = [];
  new w.MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.classList && node.classList.contains("toast")) toasts.push(text(node));
      }
    }
  }).observe(w.document.getElementById("toast-container"), { childList: true });
  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick(30);

  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const dropOn = (id, file) => {
    const ev = new w.Event("drop", { bubbles: true, cancelable: true });
    ev.dataTransfer = { files: [file] };
    $(id).dispatchEvent(ev);
  };
  const video = () => {
    const f = new w.File(["x"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(f, "size", { value: 120 * MB });
    return f;
  };
  // Row state, from its classes: exactly one of these.
  const rowState = (id) => {
    const row = $(id);
    const kinds = ["active", "is-done", "is-skipped", "is-failed"].filter((c) => row.classList.contains(c));
    if (kinds.length > 1) fail(`#${id} has more than one state: ${kinds.join(", ")}`);
    return kinds[0] || "pending";
  };
  const hasTick = (id) => !!$(id).querySelector(".stage-icon .icon-tick");
  const actions = () => [...$("process-actions").querySelectorAll("button")].filter(shown).map((b) => text(b));
  const processPosts = () => requests.filter((r) => /\/process$/.test(r.url) && r.method === "POST");
  const app = w.__builderApp;
  return { w, doc, $, app, requests, errors, toasts, xhrs, sources, dropOn, video, rowState, hasTick, actions, processPosts };
}

/** Boots, picks a 120 MB video and presses Process video. */
async function startWithUpload(opts = {}) {
  const b = await boot(opts);
  b.dropOn("video-dropzone", b.video());
  if (opts.before) await opts.before(b);
  b.$("btn-start-process").click();
  await tick();
  return b;
}

/** Boots, finishes the upload, and waits for the progress stream. */
async function startProcessing(opts = {}) {
  const b = await startWithUpload(opts);
  if (b.xhrs.length !== 1) fail("the upload goes through one XMLHttpRequest");
  b.xhrs[0].respond(200, { session_id: "sess1", duration: 10 });
  await tick(30);
  if (b.sources.length !== 1) fail("processing opens the progress stream");
  return b;
}

(async () => {
  // 1. Every stage starts pending; Upload is first only while a file needs uploading.
  {
    const b = await startWithUpload();
    check(b.app.currentStep === "process", "Process video opens the processing screen");
    check(shown(b.$("stage-upload")) && b.$("stage-upload").parentElement.firstElementChild === b.$("stage-upload"), "an Upload row comes first while the file uploads");
    for (const id of ROWS.slice(1)) {
      check(b.rowState(id) === "pending" && !b.hasTick(id), `#${id} starts pending, with no tick`);
      check(/^\d$/.test(text(b.$(id).querySelector(".stage-icon"))), `#${id} shows its number`);
    }
    check(text(b.$("stage-extract").querySelector(".stage-icon")) === "2", "Read the audio is number 2 after Upload");
    check(text(b.$("process-subtext")) === "Keep this page open until it finishes.", "the sub-line says to keep the page open");
    b.w.close();
  }
  {
    // A link import already made the session: no Upload row, and nothing is ticked before the first event.
    const b = await boot();
    b.app.sessionId = "link1";
    b.$("btn-start-process").disabled = false;
    b.$("btn-start-process").click();
    await tick();
    check(b.xhrs.length === 0, "a link session uploads nothing");
    check(!shown(b.$("stage-upload")), "no Upload row for a link session");
    check(ROWS.slice(1).every((id) => b.rowState(id) === "pending" && !b.hasTick(id)), "every stage is pending before the first event");
    check(text(b.$("stage-extract").querySelector(".stage-icon")) === "1", "Read the audio is number 1 without Upload");
    b.w.close();
  }

  // 2. XHR upload progress drives the Upload row and the caption.
  {
    const b = await startWithUpload();
    const xhr = b.xhrs[0];
    check(xhr.method === "POST" && xhr.url === "/api/builder/upload", "the upload POSTs /api/builder/upload");
    check(!b.requests.some((r) => r.url === "/api/builder/upload"), "the upload doesn't go through fetch");
    xhr.progress(42 * MB, 120 * MB);
    check(b.rowState("stage-upload") === "active", "the Upload row is active while uploading");
    check(text(b.$("process-headline")) === "Uploading the video", "the headline says the video is uploading");
    check(text(b.$("process-stage-text")) === "Uploading · 42 of 120 MB", "the caption reads 'Uploading · 42 of 120 MB'");
    check(text(b.$("process-percent-text")) === "35%", "the percentage follows the upload");
    check(b.$("builder-progress-fill").style.width === "35%", "the bar follows the upload");
    check(b.$("process-percent-text").classList.contains("process-percent") && !b.$("process-stage-text").classList.contains("process-percent"), "only the percentage is mono");
    b.w.close();
  }

  // 3. Each engine status: a matching headline, one active row, ticks only on finished stages.
  {
    const b = await startProcessing();
    const sse = b.sources[0];
    check(sse.url === "/api/builder/sess1/progress", "the stream follows the new session");
    const steps = [
      ["extracting_audio", "audio_extraction", "Reading the audio", "Reading the audio", "stage-extract"],
      ["separating_stems", "stem_separation", "Separating voices from the background", "Separating the voices", "stage-stems"],
      ["transcribing", "transcription", "Writing out the dialogue", "Writing out the lines", "stage-whisper"],
      ["detecting_speakers", "speakers", "Detecting who speaks", "Detecting who speaks", "stage-speakers"],
    ];
    steps.forEach(([status, stage, message, headline, id], i) => {
      sse.send({ status, stage, progress: 0.2 * (i + 1), message, skipped: [] });
      check(text(b.$("process-headline")) === headline, `${status}: the headline reads '${headline}'`);
      check(text(b.$("process-stage-text")) === message, `${status}: the caption is the engine's message`);
      check(b.rowState(id) === "active", `${status}: its row is active`);
      const idx = ROWS.indexOf(id);
      ROWS.forEach((other, j) => {
        if (j < idx && (b.rowState(other) !== "is-done" || !b.hasTick(other))) fail(`${status}: #${other} should be ticked`);
        if (j > idx && (b.rowState(other) !== "pending" || b.hasTick(other))) fail(`${status}: #${other} should be pending`);
      });
      check(!b.hasTick(id), `${status}: the active row has no tick`);
    });
    check(text(b.$("process-subtext")) === "Keep this page open until it finishes.", "the sub-line stays while processing");
    check(shown(b.$("btn-process-cancel")), "Cancel shows while processing");
    b.w.close();
  }
  {
    // Subtitles named everyone: transcription and speaker detection are skipped.
    const b = await startProcessing();
    const sse = b.sources[0];
    sse.send({ status: "separating_stems", stage: "stem_separation", progress: 0.4, message: "Separating", skipped: [] });
    sse.send({ status: "transcribing", stage: "transcription", progress: 0.85, message: "Using 2 lines from your subtitles", skipped: ["transcription"] });
    check(b.rowState("stage-whisper") === "is-skipped" && text(b.$("stage-whisper").querySelector(".stage-desc")) === "Skipped", "a skipped stage reads 'Skipped'");
    check(!b.hasTick("stage-whisper"), "a skipped stage gets no tick");
    sse.send({ status: "transcribed", stage: "complete", progress: 1, message: "Found 2 lines", skipped: ["transcription", "speakers"], segments: [{ start: 1, end: 2, text: "Hi", character: "Levi" }] });
    check(b.rowState("stage-speakers") === "is-skipped" && b.rowState("stage-stems") === "is-done", "at the end, finished stages are ticked and skipped ones say so");
    check(sse.closed, "the stream closes when the lines are ready");
    await tick(700);
    check(b.app.currentStep === "editor", "the editor opens when the lines are ready");
    b.w.close();
  }

  // 4. The error state: one red row, the message once, no toast, the radar stopped, focus on the primary.
  const failWith = async (state, opts = {}) => {
    const b = await startProcessing(opts);
    b.sources[0].send({ status: "separating_stems", stage: "stem_separation", progress: 0.4, message: "Separating", skipped: [] });
    b.sources[0].send({ status: "error", progress: 0, skipped: [], ...state, message: state.error });
    await tick();
    return b;
  };
  {
    const msg = "Separation ran out of memory. Close other apps and try again.";
    const b = await failWith({ stage: "stem_separation", error_code: "processing_failed", error: msg });
    const failed = ROWS.filter((id) => b.rowState(id) === "is-failed");
    check(failed.length === 1 && failed[0] === "stage-stems", "one row, the failed stage, turns red");
    check(text(b.$("stage-stems").querySelector(".stage-desc")) === msg, "the message shows in the failed row");
    check(!!b.$("stage-stems").querySelector(".stage-icon .icon-alert"), "the failed row has an alert icon");
    const card = b.$("view-step-process");
    check(card.textContent.split(msg).length - 1 === 1, "the message shows once on the screen");
    check(!b.toasts.includes(msg) && b.toasts.length === 0, "no toast repeats the failure");
    check(text(b.$("process-headline")) === "Couldn't separate the voices", "the headline names the failed stage");
    check(b.$("process-radar").classList.contains("is-stopped"), "the radar stops (.is-stopped)");
    check(b.doc.querySelector('#view-step-process [role="alert"]') !== null, "the screen is an alert");
    check(b.rowState("stage-extract") === "is-done" && b.rowState("stage-whisper") === "pending", "stages before the failure stay ticked, later ones pending");
    check(JSON.stringify(b.actions()) === JSON.stringify(["Try again", "Back to video"]), "another stage offers Try again and Back to video");
    check(b.doc.activeElement === b.$("btn-process-retry") && b.$("btn-process-retry").classList.contains("btn-primary"), "focus moves to the primary, Try again");
    check(!shown(b.$("btn-process-cancel")), "Cancel goes once it failed");
    check(b.sources[0].closed, "the stream closes on the failure");
    b.w.close();
  }
  {
    const msg = "Automatic transcription isn't installed.";
    const b = await failWith({ stage: "transcription", error_code: "pipeline_missing", error: msg });
    check(text(b.$("process-headline")) === "Couldn't write out the lines", "a transcription failure says it couldn't write out the lines");
    check(JSON.stringify(b.actions()) === JSON.stringify(["Write the lines myself", "Back to video"]), "transcription not installed: Write the lines myself and Back to video, no Try again");
    check(b.doc.activeElement === b.$("btn-process-write") && b.$("btn-process-write").classList.contains("btn-primary"), "Write the lines myself is the primary and has focus");
    check(b.doc.querySelectorAll("#process-actions .btn-primary:not([hidden])").length === 1, "one primary action");
    b.w.close();
  }
  {
    const b = await failWith({ stage: "transcription", error_code: "processing_failed", error: "Whisper crashed." });
    check(JSON.stringify(b.actions()) === JSON.stringify(["Try again", "Write the lines myself", "Back to video"]), "transcription failed otherwise: Try again, Write the lines myself, Back to video");
    check(b.$("btn-process-write").classList.contains("btn-secondary") && !b.$("btn-process-write").classList.contains("btn-primary"), "Write the lines myself is secondary then");
    b.w.close();
  }
  {
    const b = await failWith({ stage: "audio_extraction", error_code: "processing_failed", error: "No audio track." });
    check(text(b.$("process-headline")) === "Couldn't read the audio", "an audio failure says it couldn't read the audio");
    b.w.close();
  }
  {
    const b = await failWith({ stage: "speakers", error_code: "processing_failed", error: "Speaker model failed." });
    check(text(b.$("process-headline")) === "Couldn't detect who speaks", "a speaker failure says it couldn't detect who speaks");
    b.w.close();
  }
  {
    // The upload fails: its row turns red, and Try again uploads again.
    const b = await startWithUpload();
    b.xhrs[0].respond(507, { detail: "The disk is full." });
    await tick();
    check(text(b.$("process-headline")) === "The upload didn't finish", "a failed upload says the upload didn't finish");
    check(b.rowState("stage-upload") === "is-failed" && text(b.$("stage-upload").querySelector(".stage-desc")) === "The disk is full.", "the Upload row turns red with the message");
    check(b.toasts.length === 0, "no toast for a failed upload");
    check(b.processPosts().length === 0, "a failed upload never reaches /process");
    b.$("btn-process-retry").click();
    await tick();
    check(b.xhrs.length === 2, "Try again after a failed upload uploads again");
    b.xhrs[1].respond(200, { session_id: "sess2", duration: 10 });
    await tick(30);
    check(b.processPosts().length === 1 && b.processPosts()[0].url === "/api/builder/sess2/process", "the retried upload goes on to /process");
    b.w.close();
  }

  // 5. Try again re-POSTs /process for the same session, with no upload.
  {
    const b = await failWith({ stage: "stem_separation", error_code: "processing_failed", error: "Boom." });
    check(b.processPosts().length === 1, "one /process before the retry");
    b.$("btn-process-retry").click();
    await tick(30);
    check(b.processPosts().length === 2 && b.processPosts()[1].url === "/api/builder/sess1/process", "Try again POSTs /process for the same session");
    check(b.xhrs.length === 1, "Try again uploads nothing");
    check(b.sources.length === 2 && !b.$("process-radar").classList.contains("is-stopped"), "Try again follows a new stream, with the radar running");
    check(ROWS.every((id) => b.rowState(id) !== "is-failed"), "no row stays red");
    check(b.rowState("stage-upload") === "is-done", "the upload stays ticked");
    b.w.close();
  }

  // 6. Back to video keeps the file name, the chips and the language.
  {
    const b = await failWith({ stage: "stem_separation", error_code: "processing_failed", error: "Boom." }, {
      fetch: (u, init, json) => {
        if (u === "/api/builder/subtitles/check") return json({ count: 2, characters: ["Kenny", "Levi"] });
        if (u.endsWith("/import_subtitles")) return json({ status: "ok", count: 2, segments: [] });
        return null;
      },
      before: async (b) => {
        b.dropOn("sub-dropzone", new b.w.File(["x"], "scene.srt", { type: "text/plain" }));
        await tick();
        b.$("select-transcribe-lang").value = "ja";
        b.$("input-pack-title").value = "Levi vs Kenny";
      },
    });
    b.$("btn-process-back").click();
    await tick();
    check(b.app.currentStep === "upload", "Back to video returns to Video");
    check(text(b.$("selected-video-name")) === "clip.mp4" && shown(b.$("video-selected-card")), "the chosen video is kept");
    check(shown(b.$("sub-chip")) && text(b.$("sub-chip-summary")) === "2 lines · 2 speakers found", "the subtitles chip is kept");
    check(b.$("select-transcribe-lang").value === "ja" && b.$("input-pack-title").value === "Levi vs Kenny", "the language and pack name are kept");
    check(!b.$("btn-start-process").disabled, "Process video can be pressed again");
    b.$("btn-start-process").click();
    await tick(30);
    check(b.xhrs.length === 1 && b.processPosts().length === 2, "processing again reuses the session: no new upload");
    b.w.close();
  }

  // 7. Write the lines myself opens the editor with no lines, and the empty state.
  {
    const b = await failWith({ stage: "transcription", error_code: "pipeline_missing", error: "Not installed.", voices_separated: true });
    b.$("btn-process-write").click();
    await tick(50);
    check(b.app.currentStep === "editor" && b.app.segments.length === 0, "the editor opens with no lines");
    check(b.$("editor-stem-audio").getAttribute("src") === "/api/builder/sess1/audio/vocals", "the separated voice track is used");
    const list = b.$("segments-list-container");
    check(text(list).includes("No lines yet"), "the Lines column says 'No lines yet'");
    const hint = list.querySelector(".lines-empty-hint");
    check(hint && text(hint) === EMPTY_HINT, "a hint says how to add a line");
    const cont = b.$("btn-proceed-to-compile");
    check(cont.getAttribute("aria-disabled") === "true" && cont.dataset.tip === "Add a line first", "Continue is unavailable, with the tip 'Add a line first'");
    check(!b.toasts.some((t) => /^Found 0/.test(t)), "no 'Found 0 lines' toast");
    cont.click();
    await tick();
    check(b.app.currentStep === "editor", "Continue does nothing without lines");
    b.app.addNewSegmentAtPlayhead();
    await tick();
    check(!cont.hasAttribute("aria-disabled") && !text(list).includes("No lines yet"), "adding a line clears the empty state and enables Continue");
    b.w.close();
  }

  // 8. Cancel: aborts the upload, or POSTs /cancel while processing. Both return to Video at once.
  {
    const b = await startWithUpload();
    b.xhrs[0].progress(10 * MB, 120 * MB);
    check(shown(b.$("btn-process-cancel")) && b.$("btn-process-cancel").classList.contains("btn-secondary"), "Cancel (secondary) shows while uploading");
    b.$("btn-process-cancel").click();
    await tick();
    check(b.xhrs[0].aborted, "Cancel during upload aborts the request");
    check(b.app.currentStep === "upload" && text(b.$("selected-video-name")) === "clip.mp4", "Cancel returns to Video with the file kept");
    check(!b.requests.some((r) => r.url.endsWith("/cancel")) && b.processPosts().length === 0, "a cancelled upload never processes");
    check(b.toasts.length === 0, "cancelling isn't an error");
    b.w.close();
  }
  {
    const b = await startProcessing();
    b.sources[0].send({ status: "separating_stems", stage: "stem_separation", progress: 0.4, message: "Separating", skipped: [] });
    b.$("btn-process-cancel").click();
    await tick();
    check(b.requests.some((r) => r.url === "/api/builder/sess1/cancel" && r.method === "POST"), "Cancel while processing POSTs /cancel");
    check(b.sources[0].closed, "Cancel closes the progress stream");
    check(b.app.currentStep === "upload", "Cancel returns to Video at once");
    b.sources[0].send({ status: "transcribed", stage: "complete", progress: 1, message: "Found 1 line", segments: [{ start: 1, end: 2, text: "Hi", character: "A" }] });
    await tick(700);
    check(b.app.currentStep === "upload", "a late message from the cancelled run changes nothing");
    b.w.close();
  }

  // 9. A failed subtitle import stops there, and never reaches /process.
  {
    const b = await startWithUpload({
      fetch: (u, init, json) => {
        if (u === "/api/builder/subtitles/check") return json({ count: 2, characters: [] });
        if (u.endsWith("/import_subtitles")) return json({ detail: "No timed lines in this file. Use an SRT or VTT file." }, 400);
        return null;
      },
      before: async (b) => {
        b.dropOn("sub-dropzone", new b.w.File(["x"], "scene.srt", { type: "text/plain" }));
        await tick();
      },
    });
    b.xhrs[0].respond(200, { session_id: "sess1", duration: 10 });
    await tick(30);
    check(b.requests.some((r) => r.url === "/api/builder/sess1/import_subtitles"), "the subtitles are sent");
    check(b.processPosts().length === 0 && b.sources.length === 0, "a failed subtitle import never reaches /process");
    check(text(b.$("process-headline")) === "Couldn't read the subtitles", "the headline says it couldn't read the subtitles");
    const msg = "No timed lines in this file. Use an SRT or VTT file.";
    check(b.$("view-step-process").textContent.split(msg).length - 1 === 1 && b.toasts.length === 0, "the message shows once, with no toast");
    check(JSON.stringify(b.actions()) === JSON.stringify(["Try again", "Back to video"]), "a subtitle failure offers Try again and Back to video");
    b.w.close();
  }

  // 10. Starting processing fails (the session ended): it says so, with a way forward.
  {
    const b = await startWithUpload({
      fetch: (u, init, json) => (u.endsWith("/process") ? json({ detail: "That session has ended. Add the video again." }, 404) : null),
    });
    b.xhrs[0].respond(200, { session_id: "sess1", duration: 10 });
    await tick(30);
    check(b.$("process-radar").classList.contains("is-stopped") && ROWS.filter((id) => b.rowState(id) === "is-failed").length === 1, "a /process failure shows one red row");
    check(b.$("view-step-process").textContent.includes("That session has ended. Add the video again.") && b.toasts.length === 0, "it shows the engine's message, with no toast");
    b.w.close();
  }

  // 11. The progress stream drops: polling /status feeds the same screen.
  {
    const b = await startProcessing({
      fetch: (u, init, json) => (u.endsWith("/status") ? json({ status: "error", stage: "transcription", error_code: "pipeline_missing", error: "Not installed.", message: "Not installed.", skipped: [] }) : null),
    });
    b.sources[0].onerror();
    await tick(1100);
    check(text(b.$("process-headline")) === "Couldn't write out the lines" && JSON.stringify(b.actions()) === JSON.stringify(["Write the lines myself", "Back to video"]), "polling /status shows the same error state");
    check(b.toasts.length === 0, "polling adds no toast");
    b.w.close();
  }

  console.log("\nAll Pack Builder processing tests passed.");
  process.exit(0);
})().catch((e) => fail(e && e.stack || e));
