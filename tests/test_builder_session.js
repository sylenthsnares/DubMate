/**
 * test_builder_session.js
 *
 * Pack Builder never loses editor work, and Pack ready leads to recording (UI plan 40g, 40i):
 *  - the session lives in the URL: a reload reopens it by its status, an ended session says
 *    so on Step 1 and cleans the URL, and setStep / popstate move through browser history;
 *  - reached steps are buttons in the stepper (aria-current="step" on the active one), and
 *    Video on a processed session offers "Back to Edit lines" and asks before processing again;
 *  - saves go one PUT at a time with the latest lines, and a failed save says so and retries;
 *  - leaving asks first (beforeunload, and a dialog for Exit) until the lines are built;
 *  - Ctrl+Z and the toast's Undo restore lines; the Cast is edited in place, with no
 *    window.prompt or window.confirm;
 *  - an edit after a build offers "Build again"; Pack ready has one primary, "Record it now".
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
const LINES = [
  { start: 1, end: 2, text: "We go in at dawn", character: "Mori" },
  { start: 3, end: 4, text: "Not a minute later", character: "Aki" },
  { start: 5, end: 6, text: "Understood", character: "Mori" },
];

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
const copy = (v) => JSON.parse(JSON.stringify(v));

/**
 * Boots builder.html at `url` with a stubbed fetch (kept in `requests`). opts.fetch(url,
 * init, json) answers first when it returns a promise; /status and /segments answer from
 * opts.status (null for a 404) and opts.lines. window.prompt and window.confirm throw.
 */
async function boot(opts = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(err);
  });
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  const dom = new JSDOM(html, { url: opts.url || "http://localhost:8000/builder.html", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  w.Element.prototype.setPointerCapture = function () {};
  w.Element.prototype.hasPointerCapture = function () { return false; };
  w.Element.prototype.releasePointerCapture = function () {};
  const proto = w.HTMLMediaElement.prototype;
  proto.load = function () {};
  proto.play = function () { return Promise.resolve(); };
  proto.pause = function () {};
  w.prompt = (m) => { throw new Error(`window.prompt was used: ${m}`); };
  w.confirm = (m) => { throw new Error(`window.confirm was used: ${m}`); };
  if (opts.session) w.sessionStorage.setItem(`dubmate_builder_session_${opts.session.id}`, JSON.stringify(opts.session.details));

  const requests = [];
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  w.fetch = (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || "GET", body: init.body });
    const own = opts.fetch && opts.fetch(u, init, json);
    if (own) return own;
    if (u === "/api/builder/capabilities") return json(ALL);
    if (/\/status$/.test(u)) return opts.status === null ? json({ detail: "Session not found" }, 404) : json(opts.status || { status: "transcribed", voices_separated: true });
    if (/\/segments$/.test(u) && (init.method || "GET") === "GET") return json({ segments: copy(opts.lines || LINES), duration: 10 });
    if (u.includes("/waveform")) return json({ peaks: [], duration: 10 });
    if (/\/compile$/.test(u)) return json({ status: "ok", pack_id: "dawn_raid", download_url: "/api/packs/dawn_raid/export" });
    return json({});
  };
  const sources = [];
  w.EventSource = class {
    constructor(u) { this.url = u; sources.push(this); }
    close() { this.closed = true; }
  };

  if (w.document.readyState === "loading") {
    await new Promise((r) => w.document.addEventListener("DOMContentLoaded", r));
  }
  const toasts = [];
  new w.MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) if (node.classList && node.classList.contains("toast")) toasts.push(node);
  }).observe(w.document.getElementById("toast-container"), { childList: true });
  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick(60);

  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const app = w.__builderApp;
  const rows = () => Array.from(doc.querySelectorAll("#segments-list-container .builder-line-row"));
  const puts = () => requests.filter((r) => /\/segments$/.test(r.url) && r.method === "PUT");
  const key = (target, k, extra = {}) => {
    const ev = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(ev);
    return ev;
  };
  const chips = () => Array.from(doc.querySelectorAll("#character-chips-list .char-color-chip"));
  const chipNamed = (n) => chips().find((c) => text(c.querySelector(".chip-name")) === n);
  const lastToast = () => Array.from(doc.querySelectorAll("#toast-container .toast")).pop();
  return { w, doc, $, app, requests, errors, toasts, sources, rows, puts, key, chips, chipNamed, lastToast };
}

/** Boots straight into the editor through ?session=s1&step=editor. */
const editor = (opts = {}) => boot({ url: "http://localhost:8000/builder.html?session=s1&step=editor", ...opts });

/** Types into a field the way a person does: focus, input, then change and blur. */
function typeInto(b, field, value) {
  field.focus();
  field.value = value;
  field.dispatchEvent(new b.w.Event("input", { bubbles: true }));
  field.dispatchEvent(new b.w.Event("change", { bubbles: true }));
  field.blur();
}

(async () => {
  // 1. Restore: ?session= reopens the editor with the server's lines and the kept details.
  {
    const b = await editor({ session: { id: "s1", details: { packName: "Dawn raid", language: "ja", videoName: "raid.mp4" } } });
    check(b.app.sessionId === "s1" && b.app.currentStep === "editor", "?session=s1 with a transcribed status opens the editor");
    check(b.requests.some((r) => r.url === "/api/builder/s1/status") && b.requests.some((r) => r.url === "/api/builder/s1/segments" && r.method === "GET"),
      "restoring reads the session's status, then its lines");
    check(b.rows().length === 3 && b.rows()[1].querySelector(".cue-text-input").value === "Not a minute later", "the editor shows the server's lines");
    check(b.$("input-pack-title").value === "Dawn raid" && b.$("select-transcribe-lang").value === "ja", "the pack name and spoken language come back from sessionStorage");
    check(b.$("editor-video").getAttribute("src") === "/api/builder/s1/video", "the editor plays the session's video");
    check(b.w.history.state && b.w.history.state.step === "editor", "the restored entry carries its step, without a new history entry");
    check(b.errors.length === 0, `no console errors while restoring (${b.errors.join(" | ")})`);
    b.w.close();
  }
  {
    const b = await boot({ url: "http://localhost:8000/builder.html?session=s1&step=compile" });
    check(b.app.currentStep === "compile", "step=compile on a transcribed session opens Build");
    b.w.close();
  }
  {
    const b = await boot({ url: "http://localhost:8000/builder.html?session=s1&step=editor", status: { status: "separating_stems", stage: "stem_separation", progress: 0.4, message: "Separating the voices", skipped: [] } });
    check(b.app.currentStep === "process" && b.sources.length === 1 && /\/api\/builder\/s1\/progress$/.test(b.sources[0].url),
      "a session still processing shows the processing screen and follows its stream");
    check(text(b.$("process-headline")) === "Separating the voices", "the processing screen shows the running stage");
    b.w.close();
  }
  {
    const b = await boot({ url: "http://localhost:8000/builder.html?session=s1&step=editor", status: { status: "error", stage: "transcription", error: "Whisper ran out of memory.", skipped: [] } });
    check(b.app.currentStep === "process" && b.$("stage-whisper").classList.contains("is-failed"), "a failed session shows the error state");
    b.w.close();
  }
  {
    const b = await boot({ url: "http://localhost:8000/builder.html?session=s1&step=editor", status: { status: "cancelled", skipped: [] }, session: { id: "s1", details: { packName: "Dawn raid", language: "en", videoName: "raid.mp4" } } });
    check(b.app.currentStep === "upload" && b.app.sessionId === "s1", "a cancelled session opens Video with the session kept");
    check(shown(b.$("video-selected-card")) && text(b.$("selected-video-name")) === "raid.mp4" && !b.$("btn-start-process").disabled,
      "Video shows the kept video, ready to process");
    b.w.close();
  }

  // 2. An ended session: the notice on Step 1, and the URL cleaned.
  {
    const b = await boot({ url: "http://localhost:8000/builder.html?session=gone&step=editor", status: null });
    check(b.app.currentStep === "upload" && !b.app.sessionId, "a 404 session stays on Step 1");
    const notice = b.$("session-ended-notice");
    check(!!notice && shown(notice) && text(notice) === "That session has ended. Add the video again.", "Step 1 says the session has ended");
    check(b.w.location.search === "", "the URL is cleaned");
    b.w.close();
  }

  // 3. History, and the stepper.
  {
    const b = await editor();
    const before = b.w.history.length;
    const nav = (s) => b.$(`step-nav-${s}`);
    check(nav("upload").tagName === "BUTTON" && nav("editor").tagName === "BUTTON", "reached steps (Video, Edit lines) are buttons");
    check(nav("process").tagName !== "BUTTON" && nav("compile").tagName !== "BUTTON", "Process and the unreached Build are plain text");
    check(nav("editor").getAttribute("aria-current") === "step" && !nav("upload").hasAttribute("aria-current"), "the active step has aria-current=step");
    b.$("btn-proceed-to-compile").click();
    await tick();
    check(b.app.currentStep === "compile" && b.w.history.length === before + 1, "Continue pushes a history entry");
    check(new URLSearchParams(b.w.location.search).get("step") === "compile" && new URLSearchParams(b.w.location.search).get("session") === "s1",
      "the URL names the session and the step");
    check(nav("compile").tagName === "BUTTON" && nav("compile").getAttribute("aria-current") === "step", "Build becomes a button once reached");
    b.w.history.back();
    await tick(60);
    check(b.app.currentStep === "editor", "browser Back returns to Edit lines");
    check(b.w.history.length === before + 1, "popstate doesn't push another entry");
    nav("compile").click();
    await tick();
    check(b.app.currentStep === "compile", "the Build step button goes to Build");
    nav("upload").click();
    await tick();
    check(b.app.currentStep === "upload", "the Video step button goes back to Video");
    check(text(b.$("label-start-process")) === "Back to Edit lines", "on a processed session the primary is Back to Edit lines");
    const again = b.$("btn-reprocess");
    check(shown(again) && text(again) === "Process again" && !again.classList.contains("btn-primary"), "Process again is a secondary");
    again.click();
    const ask = b.$("reprocess-confirm");
    check(shown(ask) && text(ask.querySelector("p")) === "Replace your 3 lines with a new pass?", "Process again asks inline first");
    b.$("btn-reprocess-cancel").click();
    check(!shown(ask) && b.requests.every((r) => !/\/process$/.test(r.url)), "Cancel keeps the lines and starts nothing");
    b.$("btn-change-video").click();
    const askChange = b.$("change-confirm");
    check(shown(askChange) && b.app.sessionId === "s1", "Change on a processed video asks the same way first");
    b.$("btn-change-cancel").click();
    check(!shown(askChange) && b.app.sessionId === "s1", "Cancel keeps the video");
    b.$("btn-start-process").click();
    await tick();
    check(b.app.currentStep === "editor" && b.app.segments.length === 3, "Back to Edit lines returns to the lines");
    nav("upload").click();
    b.$("btn-reprocess").click();
    b.$("btn-reprocess-confirm").click();
    await tick(40);
    check(b.requests.some((r) => r.url === "/api/builder/s1/process" && r.method === "POST") && b.app.currentStep === "process",
      "confirming processes the same session again");
    check(b.errors.length === 0, `no console errors moving through the steps (${b.errors.join(" | ")})`);
    b.w.close();
  }

  // 4. Saving: one PUT at a time, the latest lines win; a failure says so and retries.
  {
    const held = [];
    const b = await editor({
      fetch: (u, init, json) => (init.method === "PUT" ? new Promise((resolve) => held.push(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }))) : null),
    });
    const fields = () => b.rows().map((r) => r.querySelector(".cue-text-input"));
    typeInto(b, fields()[0], "First");
    typeInto(b, fields()[0], "Second");
    typeInto(b, fields()[0], "Third");
    await tick();
    check(b.puts().length === 1, "a save waits while one is in flight");
    held.shift()();
    await tick();
    check(b.puts().length === 2, "the waiting edits go in one more PUT");
    check(JSON.parse(b.puts()[1].body).segments[0].text === "Third", "that PUT carries the latest lines");
    held.shift()();
    await tick();
    check(b.puts().length === 2, "nothing more is sent once saved");
    b.w.close();
  }
  {
    let failNext = true;
    const b = await editor({
      fetch: (u, init, json) => {
        if (init.method !== "PUT") return null;
        if (failNext) { failNext = false; return Promise.reject(new Error("offline")); }
        return json({ status: "ok" });
      },
    });
    typeInto(b, b.rows()[0].querySelector(".cue-text-input"), "Changed");
    await tick(40);
    const notice = b.$("editor-notice");
    check(shown(notice) && text(notice) === "Couldn't save your changes. Trying again…", "a failed save shows the notice");
    await tick(1300);
    check(b.puts().length === 2 && JSON.parse(b.puts()[1].body).segments[0].text === "Changed", "the save is tried again");
    check(!shown(notice), "the notice clears once saved");
    b.w.close();
  }

  // 5. Leaving: beforeunload until built, and Exit asks through a dialog.
  {
    const b = await editor();
    const unload = () => {
      const ev = new b.w.Event("beforeunload", { cancelable: true });
      b.w.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    check(unload(), "leaving the page while editing asks first");
    b.$("btn-exit-builder").click();
    const dialog = b.$("modal-leave-builder");
    check(!!dialog && !dialog.hidden, "Exit opens the leave dialog");
    check(text(dialog.querySelector(".modal-title")) === "Leave Pack Builder?" && text(dialog.querySelector(".modal-status-text")) === "Your lines aren't in a pack yet.",
      "the dialog says the lines aren't in a pack yet");
    check(b.doc.activeElement === b.$("btn-leave-stay"), "Stay has the focus");
    check(text(b.$("btn-leave-confirm")) === "Leave", "Leave is offered");
    b.$("btn-leave-stay").click();
    check(dialog.hidden && b.w.location.pathname === "/builder.html", "Stay closes it and stays");
    b.$("btn-proceed-to-compile").click();
    await tick();
    b.$("btn-execute-compile").click();
    await tick(40);
    check(!unload(), "after a build, leaving doesn't ask");
    b.$("btn-exit-builder").dispatchEvent(new b.w.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(b.$("modal-leave-builder").hidden, "after a build, Exit doesn't ask");
    b.w.close();
  }

  // 6. Delete, then the toast's Undo; Ctrl+Z after a drag, a recast and a text commit.
  {
    const b = await editor();
    b.rows()[1].click();
    b.key(b.rows()[1], "Delete");
    check(b.app.segments.length === 2, "Delete removes the selected line");
    const toast = b.lastToast();
    const undo = toast && toast.querySelector("button.toast-action");
    check(!!toast && text(toast.querySelector(".toast-message")) === "Line 2 deleted" && !!undo && text(undo) === "Undo", "the toast says 'Line 2 deleted' with Undo");
    undo.click();
    await tick();
    check(b.app.segments.length === 3 && b.app.segments[1].text === "Not a minute later" && b.rows().length === 3, "Undo brings the line back");
    check(b.app.selectedSegmentIndex === 1, "and selects it again");
    check(JSON.parse(b.puts()[b.puts().length - 1].body).segments.length === 3, "the restored lines are saved");
    b.rows()[1].click();
    b.key(b.rows()[1], "Backspace");
    check(b.app.segments.length === 2, "Backspace removes the selected line too");
    b.key(b.doc.body, "z", { ctrlKey: true });
    check(b.app.segments.length === 3, "Ctrl+Z undoes it");

    // A drag, on drop.
    const app = b.app;
    app.pixelsPerSecond = 100;
    app.startDrag(0, "move", 100, 10);
    app.handleGlobalPointerMove({ clientX: 150, clientY: 10 });
    await tick(30);
    app.handleGlobalPointerUp({ clientX: 150, clientY: 10, target: b.doc.body });
    check(app.segments[0].start === 1.5, "the drag moved the line");
    b.key(b.doc.body, "z", { metaKey: true });
    check(app.segments[0].start === 1 && app.segments[0].end === 2, "Cmd+Z puts it back");
    const depth = app.undoStack.length;
    app.startDrag(0, "move", 100, 10);
    app.handleGlobalPointerUp({ clientX: 100, clientY: 10, target: b.doc.body });
    check(app.undoStack.length === depth, "a click on a line without moving it adds no undo step");

    // A recast.
    const sel = b.rows()[0].querySelector(".cue-char-select");
    sel.focus();
    sel.value = "Aki";
    sel.dispatchEvent(new b.w.Event("change", { bubbles: true }));
    check(app.segments[0].character === "Aki", "the line is recast");
    b.key(sel, "z", { ctrlKey: true });
    check(app.segments[0].character === "Mori" && b.rows()[0].querySelector(".cue-char-select").value === "Mori", "Ctrl+Z on the select undoes the recast");

    // A text commit; inside the field the browser's own undo is left alone.
    const field = b.rows()[2].querySelector(".cue-text-input");
    field.focus();
    field.value = "Roger";
    field.dispatchEvent(new b.w.Event("input", { bubbles: true }));
    const inside = b.key(field, "z", { ctrlKey: true });
    check(!inside.defaultPrevented && app.segments[2].text === "Roger", "Ctrl+Z inside the text is the field's own undo");
    field.dispatchEvent(new b.w.Event("change", { bubbles: true }));
    field.blur();
    b.key(b.doc.body, "z", { ctrlKey: true });
    check(app.segments[2].text === "Understood" && b.rows()[2].querySelector(".cue-text-input").value === "Understood", "Ctrl+Z undoes a committed text edit");
    check(b.errors.length === 0, `no console errors while undoing (${b.errors.join(" | ")})`);
    b.w.close();
  }

  // 7. The Cast without prompt() or confirm().
  {
    const b = await editor();
    const app = b.app;
    const nameInput = () => b.doc.querySelector("#character-chips-list .chip-name-input");
    const enter = (el, v) => { el.value = v; b.key(el, "Enter"); };

    // Rename in place.
    b.chipNamed("Aki").querySelector(".chip-name").click();
    check(!!nameInput() && nameInput().value === "Aki" && b.doc.activeElement === nameInput(), "clicking a name edits it in place");
    b.key(nameInput(), "Escape");
    check(!nameInput() && !!b.chipNamed("Aki"), "Esc cancels the rename");
    b.chipNamed("Aki").querySelector(".chip-name").click();
    enter(nameInput(), "Akira");
    check(app.segments[1].character === "Akira" && !!b.chipNamed("Akira") && !b.chipNamed("Aki"), "Enter renames the character and its lines");
    check(b.rows()[1].querySelector(".cue-char-select").value === "Akira", "the line's row follows the rename");

    // Rename onto another name merges.
    b.chipNamed("Akira").querySelector(".chip-name").click();
    enter(nameInput(), "Mori");
    check(app.segments.every((s) => s.character === "Mori") && b.chips().length === 1, "renaming to an existing name merges the two");
    let toast = b.lastToast();
    check(text(toast.querySelector(".toast-message")) === "Merged into Mori" && !!toast.querySelector(".toast-action"), "the toast says 'Merged into Mori' with Undo");
    toast.querySelector(".toast-action").click();
    check(app.segments[1].character === "Akira" && !!b.chipNamed("Akira"), "Undo splits them again");

    // + adds a chip in edit mode; an empty name removes it.
    b.$("btn-add-character").click();
    check(!!nameInput() && nameInput().placeholder === "Name" && nameInput().value === "", "+ adds a chip with an empty name field");
    enter(nameInput(), "");
    check(!nameInput() && b.chips().length === 2, "an empty name removes the new chip");
    b.$("btn-add-character").click();
    enter(nameInput(), "Narrator");
    check(!!b.chipNamed("Narrator"), "a named new chip stays");

    // × deletes at once; the lines move to the first remaining character.
    b.chipNamed("Mori").querySelector(".chip-del-btn").click();
    check(!b.chipNamed("Mori") && app.segments[0].character === "Akira" && app.segments[2].character === "Akira", "× moves the lines to the first remaining character");
    toast = b.lastToast();
    check(text(toast.querySelector(".toast-message")) === "Mori deleted. 2 lines moved to Akira", "the toast says where the lines went");
    toast.querySelector(".toast-action").click();
    check(app.segments[0].character === "Mori" && !!b.chipNamed("Mori"), "Undo brings the character back");

    // The row's "+ New character…" swaps its select for a name field.
    const row = b.rows()[2];
    const sel = row.querySelector(".cue-char-select");
    sel.focus();
    check(Array.from(sel.options).some((o) => o.value === "__ADD_NEW__" && o.text === "+ New character…"), "the row select offers '+ New character…'");
    sel.value = "__ADD_NEW__";
    sel.dispatchEvent(new b.w.Event("change", { bubbles: true }));
    let input = row.querySelector(".cue-char-input");
    check(!!input && sel.hidden && b.doc.activeElement === input, "it swaps the select for a name field in the row");
    b.key(input, "Escape");
    check(!row.querySelector(".cue-char-input") && !sel.hidden && sel.value === "Mori" && app.segments[2].character === "Mori", "Esc restores the select");
    sel.focus();
    sel.value = "__ADD_NEW__";
    sel.dispatchEvent(new b.w.Event("change", { bubbles: true }));
    input = row.querySelector(".cue-char-input");
    enter(input, "Guard");
    check(app.segments[2].character === "Guard" && !row.querySelector(".cue-char-input") && sel.value === "Guard" && !!b.chipNamed("Guard"),
      "Enter creates the character and gives it the line");
    check(b.errors.length === 0, `no console errors editing the Cast (${b.errors.join(" | ")})`);
    b.w.close();
  }

  // 8. Build, then edit: "Build again". Pack ready leads to recording.
  {
    const b = await editor();
    b.$("btn-proceed-to-compile").click();
    await tick();
    b.$("btn-execute-compile").click();
    await tick(40);
    const box = b.$("compile-success-box");
    check(shown(box) && text(box.querySelector(".success-title")) === "Pack ready" && text(box.querySelector(".success-desc")) === "It's in your scene list.",
      "Pack ready says it's in your scene list");
    const primaries = Array.from(box.querySelectorAll(".btn-primary"));
    check(primaries.length === 1 && primaries[0] === b.$("btn-playtest-now") && text(primaries[0]) === "Record it now", "the one primary is Record it now");
    check(primaries[0].classList.contains("btn-md") && b.doc.activeElement === primaries[0], "Record it now is btn-md and takes the focus");
    const zip = b.$("btn-download-pack-zip");
    check(text(zip) === "Save a copy (.zip)" && !zip.classList.contains("btn-primary") && !zip.classList.contains("btn-secondary") && zip.getAttribute("href") === "/api/packs/dawn_raid/export",
      "Save a copy (.zip) is a quiet link to the pack's zip");
    check(!Array.from(b.doc.querySelectorAll("a, button")).some((el) => text(el) === "Go to Studio"), "there is no Go to Studio");
    check(!b.toasts.some((t) => /is ready/.test(text(t))), "no 'is ready' toast");
    check(!shown(b.$("btn-execute-compile")), "Build pack stays hidden while Pack ready shows");

    // A details edit after the build.
    const title = b.$("compile-pack-name");
    const builtTitle = title.value;
    title.value = "Dawn raid, take two";
    title.dispatchEvent(new b.w.Event("input", { bubbles: true }));
    const stale = b.$("compile-stale-box");
    check(shown(stale) && !shown(box) && text(stale.querySelector("p")) === "You changed the pack after building it.", "an edit to the details swaps Pack ready for the change notice");
    check(b.$("btn-build-again").classList.contains("btn-primary") && text(b.$("btn-build-again")) === "Build again", "the primary is Build again");
    check(text(b.$("btn-stale-record")) === "Record it now" && !b.$("btn-stale-record").classList.contains("btn-primary"), "the secondary is Record it now");
    title.value = builtTitle;
    title.dispatchEvent(new b.w.Event("input", { bubbles: true }));
    check(shown(box) && !shown(stale), "putting the details back shows Pack ready again");

    // A line edit after the build.
    b.$("step-nav-editor").click();
    await tick();
    typeInto(b, b.rows()[0].querySelector(".cue-text-input"), "We go in at noon");
    b.$("btn-proceed-to-compile").click();
    await tick();
    check(shown(stale) && !shown(box), "an edit to the lines shows the change notice on Build");
    const before = b.requests.filter((r) => /\/compile$/.test(r.url)).length;
    b.$("btn-build-again").click();
    await tick(40);
    const compiles = b.requests.filter((r) => /\/compile$/.test(r.url));
    check(compiles.length === before + 1 && JSON.parse(compiles[compiles.length - 1].body).segments[0].text === "We go in at noon", "Build again builds the edited lines");
    check(shown(box) && !shown(stale), "after Build again, Pack ready shows");
    check(b.errors.length === 0, `no console errors building (${b.errors.join(" | ")})`);
    b.w.close();
  }

  console.log("All Pack Builder session checks passed.");
  process.exit(0);
})();
