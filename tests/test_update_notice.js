/**
 * test_update_notice.js
 *
 * Where to get DubMate 2.0 (documentation/design/v2-update-path.md, section 2;
 * static/js/studio/update_notice.js):
 *  - "Open download page": in the desktop app it asks the app to open the releases page;
 *    an older app refuses, so it copies the address and says so, or shows the address
 *    when the copy fails too; in a browser it is a plain link to a new tab;
 *  - the premiere notice is the host's, once per engine version and missing set, until
 *    Got it; its copy names what is missing and where to get it;
 *  - the room check row says when stronger cleanup needs the installer.
 * Socket and fetch are stubbed.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const BUNDLE = buildStudioBundle();

const URL = "https://github.com/sylenthsnares/DubMate/releases/latest";
const EFFECTS_COPY = "This DubMate saves videos, stems and projects without voice effects. "
  + "Install DubMate 2.0 from github.com/sylenthsnares/DubMate/releases to add them";
const CLEANUP_COPY = "Install DubMate 2.0 from github.com/sylenthsnares/DubMate/releases for stronger noise cleanup.";
const ROOM_CHECK_COPY = "Stronger cleanup needs the DubMate 2.0 installer.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const norm = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const isShown = (el) => !!el && !el.hidden && !el.closest("[hidden]");

async function boot(url, health) {
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
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET" });
    let body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : { status: "ok" };
    if (u === "/health") body = { status: "ok", ...health };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(BUNDLE);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  app.showToast = () => {};
  app.socket.send = () => {};
  app.user = { id: "u1", name: "Ana" };
  return { w, app, errors, calls, $: (id) => w.document.getElementById(id) };
}

const roomState = (extra = {}) => ({
  state_version: 3, room_id: "R1", host_id: "u1", status: "screening",
  users: { u1: { id: "u1", name: "Ana", is_online: true } },
  role_assignments: {}, voice: { session: null, characters: {} },
  pack: { id: "P", name: "Scene", lines: [], characters: [], video_url: "/v.mp4", duration: 6 },
  takes: {}, master_dialogue_presence_db: 0, master_mix_balance: 50,
  exports: { "16:9": "idle", "9:16": "idle" }, engine_missing: [], ...extra,
});

(async () => {
  // --- The download control --------------------------------------------------------
  {
    const env = await boot("http://127.0.0.1:8000/", { version: "2.0.0", missing: [] });
    const { w, app } = env;
    const invokes = [];
    let refuse = false;
    w.__TAURI__ = { core: { invoke: (cmd) => { invokes.push(cmd); return refuse ? Promise.reject("not allowed") : Promise.resolve(null); } } };
    const copied = [];
    let copyFails = false;
    Object.defineProperty(w.navigator, "clipboard", { configurable: true,
      value: { writeText: (t) => { copied.push(t); return copyFails ? Promise.reject(new Error("denied")) : Promise.resolve(); } } });

    const control = () => {
      const wrap = app.downloadPageControl();
      w.document.body.appendChild(wrap);
      const btn = wrap.querySelector("button, a");
      const hint = wrap.querySelector(".download-page-hint");
      return { wrap, btn, hint };
    };

    let { btn, hint } = control();
    if (!btn || btn.localName !== "button" || btn.type !== "button") fail(`desktop control is not a button: ${btn && btn.outerHTML}`);
    for (const c of ["btn", "btn-secondary", "btn-sm"]) if (!btn.classList.contains(c)) fail(`desktop button lacks .${c}`);
    if (norm(btn) !== "Open download page") fail(`desktop button text: ${norm(btn)}`);
    if (btn.getAttribute("data-tip") !== URL) fail(`desktop button tip: ${btn.getAttribute("data-tip")}`);
    if (!hint || isShown(hint)) fail("the hint shows before anything happened");
    btn.click();
    await tick();
    if (invokes.join() !== "open_download_page") fail(`invoked ${invokes}`);
    if (copied.length || isShown(hint)) fail("an accepted call still copied the link");
    console.log("PASS: in the desktop app, Open download page asks the app to open the releases page");

    // An older app refuses the call: the address is copied and the hint says so.
    refuse = true;
    ({ btn, hint } = control());
    btn.click();
    await tick();
    if (copied.join() !== URL) fail(`copied ${copied}`);
    if (!isShown(hint) || norm(hint) !== "Link copied. Paste it into your browser.") fail(`refusal hint: ${norm(hint)}`);
    console.log("PASS: a refused call copies the link and says so");

    // The copy fails too: the address itself, as selectable text.
    copyFails = true;
    ({ btn, hint } = control());
    btn.click();
    await tick();
    if (!isShown(hint) || norm(hint) !== URL) fail(`copy-failed hint: ${norm(hint)}`);
    console.log("PASS: when the copy fails too, the hint shows the address");

    // A browser on this computer: a link that opens a new tab.
    delete w.__TAURI__;
    ({ btn, hint } = control());
    if (!btn || btn.localName !== "a") fail(`browser control is not a link: ${btn && btn.outerHTML}`);
    for (const c of ["btn", "btn-secondary", "btn-sm"]) if (!btn.classList.contains(c)) fail(`browser link lacks .${c}`);
    if (btn.getAttribute("href") !== URL || btn.getAttribute("target") !== "_blank"
        || btn.getAttribute("rel") !== "noopener noreferrer") fail(`link attributes: ${btn.outerHTML}`);
    if (norm(btn) !== "Open download page" || btn.getAttribute("data-tip") !== URL) fail(`link text or tip: ${btn.outerHTML}`);
    console.log("PASS: in a browser, Open download page is a link to a new tab");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }

  // A page reached over the network never asks the desktop app, even inside it.
  {
    const { w, app } = await boot("http://192.168.1.20:8000/", { version: "2.0.0", missing: [] });
    w.__TAURI__ = { core: { invoke: () => fail("a network page asked the desktop app") } };
    const btn = app.downloadPageControl().querySelector("button, a");
    if (!btn || btn.localName !== "a" || btn.getAttribute("href") !== URL) fail(`network page control: ${btn && btn.outerHTML}`);
    console.log("PASS: a page on another computer's engine gets the plain link");
  }

  // --- The premiere notice ---------------------------------------------------------
  {
    const env = await boot("http://127.0.0.1:8000/", { version: "2.0.0", missing: ["voice_effects", "strong_cleanup"] });
    const { w, app, $ } = env;
    const notice = $("screening-update-notice");
    if (!notice || !notice.classList.contains("update-notice") || notice.getAttribute("role") !== "status") fail("no #screening-update-notice status row");
    if (notice.previousElementSibling?.id !== "screening-save-error") fail("the notice isn't right after the save error row");
    if (!notice.hidden) fail("the notice shows before a room");
    const text = () => norm(notice.querySelector(".update-notice-text"));
    const gotIt = () => [...notice.querySelectorAll("button.btn.btn-ghost.btn-sm")].find((b) => norm(b) === "Got it");

    app.roomState = roomState({ engine_missing: ["voice_effects", "strong_cleanup"] });
    app.showView("screening");
    await app.setupScreeningView();
    await tick();
    if (!isShown(notice)) fail("the host doesn't see the notice");
    if (text() !== `${EFFECTS_COPY} and stronger noise cleanup.`) fail(`effects + cleanup copy: ${text()}`);
    const lead = notice.querySelector(".update-notice-lead");
    if (!lead || norm(lead) !== "This DubMate saves videos, stems and projects without voice effects.") fail(`lead clause: ${norm(lead)}`);
    if (!notice.querySelector("svg") || notice.querySelector("svg").getAttribute("aria-hidden") !== "true") fail("no decorative info icon");
    const link = notice.querySelector(".download-page-control a, .download-page-control button");
    if (!link || norm(link) !== "Open download page") fail("no download control in the notice");
    if (!gotIt()) fail("no Got it button");
    if (env.calls.filter((c) => c.url === "/health").length !== 1) fail("the engine version wasn't read once from /health");
    console.log("PASS: the host sees the notice with what's missing, where to get it, and the download control");

    gotIt().click();
    if (isShown(notice)) fail("Got it didn't hide the notice");
    if (w.localStorage.getItem("dubmate_update_notice") !== "2.0.0|voice_effects,strong_cleanup") fail(`stored key: ${w.localStorage.getItem("dubmate_update_notice")}`);
    app.updateScreeningControls();
    await tick();
    if (isShown(notice)) fail("the notice came back for the same version and set");
    console.log("PASS: Got it hides it and stores the version and set; it stays away for the same ones");

    // Another set of missing parts: once more, with the copy for it.
    app.roomState = roomState({ engine_missing: ["voice_effects"] });
    app.updateScreeningControls();
    await tick();
    if (!isShown(notice) || text() !== `${EFFECTS_COPY}.`) fail(`effects-only copy: ${isShown(notice)} ${text()}`);
    app.roomState = roomState({ engine_missing: ["strong_cleanup"] });
    app.updateScreeningControls();
    await tick();
    if (!isShown(notice) || text() !== CLEANUP_COPY) fail(`cleanup-only copy: ${text()}`);
    console.log("PASS: a different set shows again, with the effects-only and the cleanup-only copy");

    // Nothing missing, or not the host: no notice.
    app.roomState = roomState({ engine_missing: [] });
    app.updateScreeningControls();
    if (isShown(notice)) fail("notice with nothing missing");
    app.roomState = roomState({ engine_missing: ["voice_effects"], host_id: "u2" });
    app.updateScreeningControls();
    await tick();
    if (isShown(notice)) fail("a member sees the notice");
    console.log("PASS: no notice when nothing is missing, and never for a member");

    // --- The room check row ---------------------------------------------------------
    const note = $("room-check-cleanup-note");
    if (!note || !note.classList.contains("audio-device-note")) fail("no #room-check-cleanup-note line");
    app.roomState = roomState({ engine_missing: ["strong_cleanup"] });
    app.renderRoomCheckRow();
    if (!isShown(note) || !norm(note).startsWith(ROOM_CHECK_COPY) || !note.querySelector(".download-page-control")) fail(`room check line: ${norm(note)}`);
    app.roomState = roomState({ engine_missing: ["voice_effects"] });
    app.renderRoomCheckRow();
    if (isShown(note)) fail("room check line without strong_cleanup missing");
    // Outside a room it asks /health.
    app.roomState = null;
    app.renderRoomCheckRow();
    await tick();
    if (!isShown(note)) fail("room check line from /health outside a room");
    // A guest's page: nothing they can install for the host.
    app.isEngineLocal = () => false;
    app.roomState = roomState({ engine_missing: ["strong_cleanup"] });
    app.renderRoomCheckRow();
    if (isShown(note)) fail("room check line on a guest's page");
    console.log("PASS: the room check line shows when stronger cleanup is missing on this computer's engine");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }

  // An engine whose /health can't be read still gets the notice, keyed without a version.
  {
    const env = await boot("http://127.0.0.1:8000/", { version: undefined });
    const { w, app, $ } = env;
    app.roomState = roomState({ engine_missing: ["voice_effects"] });
    app.showView("screening");
    await app.setupScreeningView();
    await tick();
    const notice = $("screening-update-notice");
    if (!isShown(notice)) fail("no notice without a version");
    [...notice.querySelectorAll("button")].find((b) => norm(b) === "Got it").click();
    if (w.localStorage.getItem("dubmate_update_notice") !== "|voice_effects") fail(`key without a version: ${w.localStorage.getItem("dubmate_update_notice")}`);
    console.log("PASS: without a version the notice still shows and is keyed by the set");
  }

  // The stylesheet: the notice on the walnut control surface, wrapping on narrow windows.
  {
    const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8");
    const rule = /\.update-notice\s*\{([^}]*)\}/.exec(css);
    if (!rule) fail("no .update-notice rule");
    for (const want of ["var(--secondary)", "var(--border-wood)", "var(--radius-md)", "10px 14px"]) {
      if (!rule[1].includes(want)) fail(`.update-notice lacks ${want}`);
    }
    if (/--primary|--accent-amber|--accent-red/.test(rule[1])) fail(".update-notice uses amber or red");
    if (!/@media\s*\(max-width:\s*1099px\)[^{]*\{[^@]*\.update-notice/.test(css)) fail("the notice doesn't wrap below 1100px");
    console.log("PASS: the notice is a walnut row that wraps its controls below 1100px");
  }

  console.log("All update notice tests passed");
  process.exit(0);
})();
