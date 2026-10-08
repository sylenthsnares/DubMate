/**
 * test_builder_step1.js
 *
 * Pack Builder only offers what is installed (GET /api/builder/capabilities):
 *  - the header pill has one signal, whether the graphics card speeds up the AI
 *    steps, and hides until that is known or when no AI tools are installed;
 *  - the hero line names only what will happen;
 *  - Paste link without link import explains how to add it (desktop or source);
 *  - without transcription, subtitles are "needed for lines" and the button reads
 *    "Process video without lines", sending transcribe:false;
 *  - chosen subtitles and cover images become chips with a remove button; a dropped
 *    subtitle file is checked at once, and a bad one shows an inline error;
 *  - in the editor, Transcribe is unavailable without transcription, and Romaji
 *    shows only for Japanese lines when it is installed.
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
const NO_LINES_HINT = "Automatic transcription isn't installed. Add a subtitle file, or write the lines yourself after processing.";

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
const text = (el) => (el ? (typeof el.innerText === "string" ? el.innerText : el.textContent).trim() : "");
// Hidden by the attribute, an inline display:none, or a hidden ancestor.
function shown(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden || n.style.display === "none") return false;
  }
  return true;
}

/**
 * Boots builder.html. caps is one capabilities answer, or a list answered in turn
 * (the last one repeats). opts.fetch(url, init, json) answers a request first when
 * it returns a promise. Every request is kept in `requests`.
 */
async function boot(caps = ALL, opts = {}) {
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
  if (opts.desktop) w.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };

  const queue = Array.isArray(caps) ? caps.slice() : [caps];
  const requests = [];
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  w.fetch = (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || "GET", body: init.body });
    const own = opts.fetch && opts.fetch(u, init, json);
    if (own) return own;
    if (u === "/api/builder/capabilities") return json(queue.length > 1 ? queue.shift() : queue[0]);
    if (u.includes("/waveform")) return json({ peaks: [], duration: 10 });
    return json({});
  };
  // The video uploads through XMLHttpRequest (for its progress); this one answers at once.
  w.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open(method, url) { this.url = url; }
    send() {
      setTimeout(() => {
        this.status = 200;
        this.responseText = JSON.stringify({ session_id: "sess1", duration: 10, device_info: { cuda_available: true } });
        this.onload();
      }, 0);
    }
    abort() {}
  };
  w.EventSource = class { constructor(url) { this.url = url; } close() {} };

  if (w.document.readyState === "loading") {
    await new Promise((r) => w.document.addEventListener("DOMContentLoaded", r));
  }
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
  const file = (name, type = "text/plain") => new w.File(["x"], name, { type });
  return { w, doc, $, app: w.__builderApp, requests, errors, dropOn, file };
}

(async () => {
  // 1. The pill: one signal, never green, hidden until known.
  {
    const b = await boot({ ...ALL, gpu: true });
    const pill = b.$("device-pill");
    check(shown(pill) && text(b.$("device-label")) === "Fast processing", "gpu true: the pill reads 'Fast processing'");
    check(pill.dataset.tip === "Your graphics card speeds up separating voices and writing out lines.", "gpu true: the tooltip says what the card speeds up");
    check(pill.classList.contains("is-gpu"), "gpu true: the dot is brass (.is-gpu)");
    check(!b.requests.some((r) => r.url.includes("/api/system/encoder")), "the video encoder probe is no longer asked");
    b.w.close();
  }
  {
    const b = await boot({ ...ALL, gpu: false });
    const pill = b.$("device-pill");
    check(shown(pill) && text(b.$("device-label")) === "Standard processing", "gpu false: the pill reads 'Standard processing'");
    check(pill.dataset.tip === "No supported graphics card, so separating voices and writing out lines use the processor and take longer.", "gpu false: the tooltip says why it is slower");
    check(!pill.classList.contains("is-gpu"), "gpu false: the dot is neutral");
    // Uploading reports a GPU in device_info; the pill no longer reads it.
    b.dropOn("video-dropzone", b.file("clip.mp4", "video/mp4"));
    b.$("btn-start-process").click();
    await tick(50);
    check(text(b.$("device-label")) === "Standard processing" && !pill.classList.contains("is-gpu"), "the pill says the same before and after the upload");
    check(pill.style.borderColor === "", "the pill gets no inline border colour");
    b.w.close();
  }
  {
    const b = await boot([{ ...ALL, gpu: null }, { ...ALL, gpu: true }]);
    check(!shown(b.$("device-pill")), "gpu null: the pill is hidden while the engine checks");
    await tick(1150);
    check(shown(b.$("device-pill")) && text(b.$("device-label")) === "Fast processing", "the page asks again each second until the GPU is known");
    b.w.close();
  }
  {
    const b = await boot({ ...ALL, separation: false, transcription: false, gpu: false });
    check(!shown(b.$("device-pill")), "no AI tools installed: the pill is hidden");
    b.w.close();
  }

  // 2. The hero line names only what will happen.
  {
    const hero = async (caps) => { const b = await boot(caps); const t = text(b.$("builder-hero-sub")); b.w.close(); return t; };
    check(await hero(ALL) === "Add a clip. DubMate separates the voices from the background and writes out each line for you to check.", "both installed: today's hero line");
    check(await hero({ ...ALL, transcription: false }) === "Add a clip and a subtitle file. DubMate separates the voices from the background.", "separation only: the hero asks for a subtitle file");
    check(await hero({ ...ALL, separation: false, transcription: false }) === "Add a clip and a subtitle file. DubMate turns them into a scene you can dub.", "neither: the hero promises no AI step");
  }

  // 3. Paste link without link import: why, and how to add it.
  {
    const b = await boot({ ...ALL, link_import: false }, { desktop: true });
    b.$("tab-btn-url").click();
    check(!shown(b.$("input-youtube-url")) && !shown(b.$("btn-fetch-url")), "without link import the link field and Import are gone");
    check(shown(b.$("url-import-missing")) && text(b.$("url-import-missing")).startsWith("Importing from a link needs the Pack Builder tools."), "Paste link says it needs the Pack Builder tools");
    check(shown(b.$("url-import-missing-desktop")) && text(b.$("url-import-missing-desktop")) === "Run the DubMate installer again and tick Pack Builder.", "the desktop app says to run the installer again");
    check(!shown(b.$("url-import-missing-source")), "the desktop app doesn't show the pip command");
    check(b.$("tab-btn-url").getAttribute("aria-selected") === "true", "the Paste link tab stays selectable");
    b.w.close();
  }
  {
    const b = await boot({ ...ALL, link_import: false });
    b.$("tab-btn-url").click();
    const details = b.$("url-import-missing-source");
    check(shown(details) && details.tagName === "DETAILS" && text(details.querySelector("summary")) === "Show details", "a source install gets 'Show details'");
    check(details.textContent.includes("pip install -r requirements_builder.txt") && details.textContent.includes("DubMate folder"), "the details hold the pip command, run in the DubMate folder");
    check(!shown(b.$("url-import-missing-desktop")), "a source install doesn't mention the installer");
    b.w.close();
  }
  {
    const b = await boot(ALL);
    b.$("tab-btn-url").click();
    check(shown(b.$("input-youtube-url")) && !shown(b.$("url-import-missing")), "with link import the link field shows as before");
    b.w.close();
  }

  // 4. Without transcription: subtitles are needed for lines, or none are written.
  {
    const b = await boot({ ...ALL, transcription: false });
    check(text(b.$("sub-label")) === "Subtitles (needed for lines)", "the Subtitles label says it is needed for lines");
    check(shown(b.$("sub-hint")) && text(b.$("sub-hint")) === NO_LINES_HINT, "a hint says transcription isn't installed");
    check(text(b.$("label-start-process")) === "Process video without lines", "the button reads 'Process video without lines'");
    b.dropOn("video-dropzone", b.file("clip.mp4", "video/mp4"));
    b.$("btn-start-process").click();
    await tick(50);
    const proc = b.requests.find((r) => r.url === "/api/builder/sess1/process");
    check(proc && JSON.parse(proc.body).transcribe === false, "the request sends transcribe:false");
    b.w.close();
  }
  {
    const b = await boot({ ...ALL, transcription: false }, {
      fetch: (u, init, json) => u === "/api/builder/subtitles/check" ? json({ count: 2, characters: ["Kenny", "Levi"] }) : null,
    });
    b.dropOn("sub-dropzone", b.file("scene.srt"));
    await tick(30);
    check(text(b.$("label-start-process")) === "Process video", "with a subtitle file the button reads 'Process video'");
    b.dropOn("video-dropzone", b.file("clip.mp4", "video/mp4"));
    b.$("btn-start-process").click();
    await tick(50);
    const proc = b.requests.find((r) => r.url === "/api/builder/sess1/process");
    check(proc && JSON.parse(proc.body).transcribe !== false, "with subtitles the request doesn't send transcribe:false");
    check(b.requests.some((r) => r.url === "/api/builder/sess1/import_subtitles"), "the checked subtitles are imported");
    b.w.close();
  }
  {
    const b = await boot(ALL);
    check(text(b.$("sub-label")) === "Subtitles (optional)" && !shown(b.$("sub-hint")), "with transcription the Subtitles field stays optional");
    check(text(b.$("label-start-process")) === "Process video", "with transcription the button reads 'Process video'");
    b.w.close();
  }

  // 5. Subtitle and cover chips.
  {
    let answer = { count: 2, characters: ["Kenny", "Levi"] };
    const b = await boot(ALL, {
      fetch: (u, init, json) => u === "/api/builder/subtitles/check" ? json(answer) : null,
    });
    const chip = b.$("sub-chip");
    check(!shown(chip) && shown(b.$("sub-dropzone")), "no chip before a file is chosen");
    b.dropOn("sub-dropzone", b.file("scene.srt"));
    await tick(30);
    const check1 = b.requests.find((r) => r.url === "/api/builder/subtitles/check");
    check(check1 && check1.method === "POST" && check1.body.get("file").name === "scene.srt", "a dropped SRT is checked at once");
    check(shown(chip) && text(chip.querySelector(".file-chip-name")) === "scene.srt", "the chip shows the file name");
    check(text(chip.querySelector(".file-chip-summary")) === "2 lines · 2 speakers found", "the chip reads '2 lines · 2 speakers found'");
    check(!shown(b.$("sub-dropzone")), "the dropzone hides while the chip shows");
    check(!b.$("sub-dropzone").querySelector("button") && !b.$("cover-dropzone").querySelector("button") && !b.$("video-dropzone").querySelector("button"), "no button sits inside a role=button dropzone");
    const x = b.$("btn-remove-sub");
    check(x.tagName === "BUTTON" && x.getAttribute("aria-label") === "Remove subtitles", "the × is a button labelled 'Remove subtitles'");
    x.click();
    await tick();
    check(!shown(chip) && shown(b.$("sub-dropzone")) && b.app.subFile === null, "× removes the subtitles and brings the dropzone back");

    // Only the parser's default "Actor": no speakers named.
    answer = { count: 1, characters: ["Actor"] };
    const input = b.$("input-sub-file");
    Object.defineProperty(input, "files", { configurable: true, value: [b.file("plain.vtt")] });
    input.dispatchEvent(new b.w.Event("change"));
    await tick(30);
    check(text(chip.querySelector(".file-chip-summary")) === "1 line", "a file naming nobody reads '1 line'");
    b.w.close();
  }
  {
    const b = await boot(ALL);
    const input = b.$("input-cover-file");
    Object.defineProperty(input, "files", { configurable: true, value: [b.file("cover.png", "image/png")] });
    input.dispatchEvent(new b.w.Event("change"));
    await tick();
    const chip = b.$("cover-chip");
    check(shown(chip) && text(chip.querySelector(".file-chip-name")) === "cover.png" && !shown(b.$("cover-dropzone")), "a chosen cover image becomes a chip");
    check(b.$("btn-remove-cover").getAttribute("aria-label") === "Remove cover image", "its × is labelled 'Remove cover image'");
    b.$("btn-remove-cover").click();
    check(!shown(chip) && shown(b.$("cover-dropzone")) && b.app.coverFile === null, "× removes the cover image");
    b.w.close();
  }

  // 6. A bad subtitle file isn't kept, and says why inline.
  {
    const b = await boot(ALL, {
      fetch: (u, init, json) => u === "/api/builder/subtitles/check"
        ? json({ detail: "No timed lines in this file. Use an SRT or VTT file." }, 400) : null,
    });
    b.dropOn("sub-dropzone", b.file("notes.srt"));
    await tick(30);
    check(shown(b.$("sub-error")) && text(b.$("sub-error")) === "No timed lines in this file. Use an SRT or VTT file.", "a file with no timed lines shows the error inline");
    check(!shown(b.$("sub-chip")) && b.app.subFile === null && shown(b.$("sub-dropzone")), "the bad file isn't kept");
    b.dropOn("video-dropzone", b.file("clip.mp4", "video/mp4"));
    b.$("btn-start-process").click();
    await tick(50);
    check(!b.requests.some((r) => r.url.includes("/import_subtitles")), "a rejected file is never imported");
    b.w.close();
  }

  // 7. Subtitles that came with a link import are a chip too; × removes them on the engine.
  {
    const b = await boot(ALL, {
      fetch: (u, init, json) => {
        if (u === "/api/builder/import_url") return json({ session_id: "sessL", duration: 30, title: "Clip", filename: "clip.mp4", has_subtitles: true, subtitles_count: 48 });
        return null;
      },
    });
    b.$("tab-btn-url").click();
    b.$("input-youtube-url").value = "https://www.youtube.com/watch?v=x";
    b.$("btn-fetch-url").click();
    await tick(600);
    const chip = b.$("sub-chip");
    check(shown(chip) && text(chip.querySelector(".file-chip-name")) === "From the video" && text(chip.querySelector(".file-chip-summary")) === "48 lines", "link subtitles show as 'From the video · 48 lines'");
    b.$("btn-remove-sub").click();
    await tick(30);
    check(b.requests.some((r) => r.url === "/api/builder/sessL/subtitles" && r.method === "DELETE"), "× removes the link's subtitles on the engine");
    check(!shown(chip) && shown(b.$("sub-dropzone")), "the chip goes once they are removed");
    b.w.close();
  }

  // 8. Editor: Transcribe needs transcription; Romaji only for Japanese.
  const openEditor = async (b, segments) => {
    b.app.sessionId = "s1";
    b.app.openEditor({ status: "transcribed", segments, voices_separated: true });
    await tick(50);
  };
  const LINES = [
    { start: 1, end: 2, text: "Hello there", character: "Levi" },
    { start: 3, end: 4, text: "進め！", character: "Kenny" },
  ];
  {
    const b = await boot({ ...ALL, transcription: false });
    await openEditor(b, LINES);
    const deck = b.$("btn-transcribe-line");
    check(deck.getAttribute("aria-disabled") === "true" && deck.dataset.tip === "Automatic transcription isn't installed.", "without transcription the deck's Transcribe is unavailable and says why");
    b.app.selectSegment(0);
    deck.click();
    await tick(30);
    check(!b.requests.some((r) => r.url.includes("/transcribe_segment")), "the unavailable Transcribe does nothing");
    check(b.doc.querySelectorAll(".btn-whisper-cue").length === 0, "the line rows and the card have no Transcribe action");
    b.w.close();
  }
  {
    const b = await boot(ALL);
    await openEditor(b, LINES);
    const deck = b.$("btn-transcribe-line");
    check(deck.getAttribute("aria-disabled") === "true" && deck.dataset.tip === "Select a line first", "with no line selected, Transcribe says 'Select a line first', like Start and End");
    b.app.selectSegment(0);
    const whisper = b.doc.querySelectorAll(".btn-whisper-cue");
    check(!deck.hasAttribute("aria-disabled") && deck.dataset.tip === "Fill in the selected line's text from the audio" && whisper.length === 1 && b.$("cue-card-0").contains(whisper[0]),
      "with transcription and a line selected, Transcribe is available, in the deck and the line's card");
    const romaji = (i) => { const btn = b.$(`cue-card-${i}`).querySelector(".btn-romaji-cue"); return !!btn && shown(btn); };
    check(!romaji(0), "Romaji doesn't show on a line without Japanese text");
    b.app.selectSegment(1);
    check(romaji(1), "Romaji shows on the line with Japanese text");
    b.app.selectSegment(0);
    // Typing Japanese into a line brings its Romaji action without a re-render.
    const box = b.$("cue-card-0").querySelector(".cue-text-input");
    const card = b.$("cue-card-0");
    box.value = "はい";
    box.dispatchEvent(new b.w.Event("input", { bubbles: true }));
    check(romaji(0) && b.$("cue-card-0") === card, "typing Japanese shows that line's Romaji");
    b.w.close();
  }
  {
    const b = await boot(ALL);
    b.$("select-transcribe-lang").value = "ja";
    await openEditor(b, LINES);
    b.app.selectSegment(0);
    check(shown(b.$("cue-card-0").querySelector(".btn-romaji-cue")), "with Japanese chosen the card offers Romaji for any line");
    b.w.close();
  }
  {
    const b = await boot({ ...ALL, romaji: false });
    await openEditor(b, LINES);
    b.app.selectSegment(1);
    check([...b.doc.querySelectorAll(".btn-romaji-cue")].every((btn) => !shown(btn)), "without the romaji tool no line offers Romaji");
    b.w.close();
  }

  console.log("\nAll Pack Builder Step 1 checks passed.");
  process.exit(0);
})().catch((e) => fail(e && e.stack || e));
