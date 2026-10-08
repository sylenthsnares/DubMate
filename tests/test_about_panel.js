/**
 * test_about_panel.js
 *
 * About DubMate (documentation/design/v2-notices.md, section 4; static/js/studio/about.js):
 *  - the logo menu's About row and the "?" sheet's footer open it; Escape closes it and
 *    focus goes back to what opened it;
 *  - on this computer: "Version X", one row per folder from GET /api/data-folders, Open
 *    folder posts the folder's key (an error shows under the row), a folder that isn't
 *    there yet says so, a folder that may hold other files (one you chose) says so and the
 *    note only tells you to delete the others, and a failed read says so;
 *  - on someone else's engine: "This room runs DubMate X", no /api/data-folders request,
 *    the line about this device, the takes line without "someone else's room", and no path
 *    anywhere in the panel;
 *  - the links: in a browser, anchors to a new tab; in the desktop app, open_dubmate_page
 *    with the page's name; an app older than 2.0 copies the link instead.
 * Socket and fetch are stubbed.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const BUNDLE = buildStudioBundle();

const HOST = "http://127.0.0.1:8000/";
const GUEST = "https://dubmate-host.test/";
const REPO = "https://github.com/sylenthsnares/DubMate";
const LINKS = [
  { page: "source", label: "Source code", url: REPO },
  { page: "licence", label: "Licence", url: `${REPO}/blob/main/LICENSE` },
  { page: "notices", label: "Third-party notices", url: `${REPO}/blob/main/THIRD_PARTY_NOTICES.md` },
  { page: "privacy", label: "Privacy", url: `${REPO}/blob/main/PRIVACY.md` },
  { page: "security", label: "Security", url: `${REPO}/blob/main/SECURITY.md` },
];
const FOLDERS = [
  { key: "rooms", label: "Rooms and takes", path: "C:\\Users\\ana\\AppData\\Local\\DubMate\\rooms", exists: true, own: true },
  { key: "exports", label: "Saved videos", path: "C:\\Users\\ana\\Videos", exists: true, own: false },
  { key: "packs", label: "Scene packs", path: "C:\\Program Files\\DubMate\\resources\\Packs", exists: false, own: true },
  { key: "data", label: "All DubMate data", path: "C:\\Users\\ana\\AppData\\Local\\DubMate", exists: true, own: true },
];
const NO_SERVER = "DubMate has no accounts and collects no usage data. Your takes are saved and mixed on the computer running the room, not on a server.";
const TAKES = "your takes are sent to the host's computer, and the host can export and share them.";
const PRIVACY = [NO_SERVER, `Recording in someone else's room: ${TAKES}`];
const GUEST_PRIVACY = [NO_SERVER, "Your takes are sent to the host's computer, and the host can export and share them."];
const SHARED = "May hold other files";
const DELETE_NOTE = `To remove everything, quit DubMate and delete each folder that isn't marked “${SHARED}”. In a marked folder, delete only what you don't need. The Privacy link at the top lists the rest.`;
const READ_ERROR = "Couldn't read the folders. The Privacy link at the top lists them.";
const GUEST_DATA = "Your name, colour and audio settings are kept on this device.";
const EMOJI = /\p{Extended_Pictographic}/u;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
function check(cond, msg) {
  if (!cond) fail(msg);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const norm = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const isShown = (el) => !!el && !el.hidden && !el.closest("[hidden]");

/**
 * Boots the studio at url. answer(url, opts) may return { status, body } (or throw) for a
 * request first; otherwise /health says 2.0.0 and /api/data-folders lists FOLDERS.
 */
async function boot(url, answer = () => null) {
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
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    let res;
    try {
      res = answer(u, opts);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!res) {
      let body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : { status: "ok" };
      if (u === "/health") body = { status: "ok", version: "2.0.0", missing: [] };
      if (u === "/api/data-folders") body = { folders: FOLDERS };
      res = { status: 200, body };
    }
    return Promise.resolve({ ok: res.status < 400, status: res.status, json: () => Promise.resolve(res.body) });
  };
  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(BUNDLE);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  app.showToast = () => {};
  app.socket.send = () => {};
  const $ = (id) => w.document.getElementById(id);
  const esc = () => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { w, app, errors, calls, $, esc };
}

/** Opens About from the logo menu and waits for its reads. */
async function openFromMenu(env) {
  env.$("btn-mode-dropdown").click();
  env.$("mode-opt-about").click();
  await tick();
}

(async () => {
  // --- Openers ---------------------------------------------------------------------
  {
    const env = await boot(HOST);
    const { w, $ } = env;
    const menuBtn = $("btn-mode-dropdown");
    check(menuBtn.getAttribute("aria-label") === "DubMate menu", `logo menu name: ${menuBtn.getAttribute("aria-label")}`);
    const row = $("mode-opt-about");
    check(!!row && row.localName === "button" && row.type === "button" && row.classList.contains("mode-dropdown-item"), `About row: ${row && row.outerHTML}`);
    check(norm(row.querySelector(".mode-item-title")) === "About DubMate", `About row title: ${norm(row.querySelector(".mode-item-title"))}`);
    check(norm(row.querySelector(".mode-item-desc")) === "Version, licences and privacy", `About row desc: ${norm(row.querySelector(".mode-item-desc"))}`);
    check(!!row.querySelector(".mode-item-icon svg") && !EMOJI.test(row.textContent), "the About row's icon isn't a drawn SVG");
    check(!!$("mode-dropdown-menu").querySelector(".mode-dropdown-divider"), "no divider above the About row");

    const modal = $("modal-about");
    check(!!modal && modal.hidden, "#modal-about is missing or shows at boot");
    check(modal.getAttribute("role") === "dialog" && modal.getAttribute("aria-modal") === "true"
      && modal.getAttribute("aria-labelledby") === "about-title", "About isn't a labelled modal dialog");
    check(norm($("about-title")) === "About DubMate", `About title: ${norm($("about-title"))}`);
    const close = modal.querySelector(".studio-modal-card.about-card .modal-close-btn");
    check(!!close && !!close.querySelector("svg") && norm(close) === "" && close.getAttribute("aria-label") === "Close", `About's close button isn't the drawn X: ${close && close.outerHTML}`);
    const builderLabel = (fs.readFileSync(path.join(PROJECT_ROOT, "static", "builder.html"), "utf8").match(/id="btn-mode-dropdown"[^>]*aria-label="([^"]*)"/) || [])[1];
    check(builderLabel === "DubMate menu", `the Pack Builder names the logo menu ${builderLabel}`);

    menuBtn.focus();
    await openFromMenu(env);
    check(isShown(modal), "the menu row didn't open About");
    check(!$("logo-dropdown-container").classList.contains("open") && $("mode-dropdown-menu").style.display === "none", "the menu stayed open");
    check(modal.contains(w.document.activeElement), "focus didn't move into About");
    env.esc();
    check(!isShown(modal), "Escape didn't close About");
    check(w.document.activeElement === menuBtn, `focus went to ${w.document.activeElement && w.document.activeElement.id}`);
    console.log("PASS: the logo menu's About row opens About; Escape closes it and focus goes back to the menu");

    // The "?" sheet's footer.
    const help = $("btn-shortcuts");
    help.focus();
    help.click();
    const sheet = $("shortcut-sheet");
    check(isShown(sheet), "the ? button didn't open the sheet");
    const footer = sheet.querySelector(".shortcut-sheet-footer button");
    check(!!footer && norm(footer) === "About DubMate" && footer.classList.contains("btn-ghost") && footer.classList.contains("btn-sm"), `sheet footer: ${footer && footer.outerHTML}`);
    footer.click();
    await tick();
    check(!isShown(sheet), "the sheet stayed open under About");
    check(isShown(modal), "the sheet's footer didn't open About");
    $("btn-close-about").click();
    check(!isShown(modal), "the close button didn't close About");
    check(w.document.activeElement === help, `after the sheet, focus went to ${w.document.activeElement && w.document.activeElement.id}`);
    console.log("PASS: the ? sheet's footer opens About, and focus goes back to the ? button");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }

  // --- On this computer --------------------------------------------------------------
  {
    let openAnswer = { status: 200, body: { status: "ok" } };
    const env = await boot(HOST, (u) => (u === "/api/data-folders/open" ? openAnswer : null));
    const { $ } = env;
    await openFromMenu(env);
    const modal = $("modal-about");
    check(isShown($("about-version")) && norm($("about-version")) === "Version 2.0.0", `version line: ${norm($("about-version"))}`);
    check(norm(modal.querySelector(".about-licence")) === "Free and open source under the GNU GPL v3.", "the licence line");
    const privacy = Array.from(modal.querySelectorAll(".about-privacy .about-text")).filter(isShown).map(norm);
    check(privacy.join("|") === PRIVACY.join("|"), `privacy lines: ${privacy.join(" | ")}`);
    check(env.calls.filter((c) => c.url === "/api/data-folders").length === 1, "the folders weren't read once on open");

    const rows = Array.from(modal.querySelectorAll(".about-folder"));
    check(rows.length === FOLDERS.length, `${rows.length} folder rows`);
    FOLDERS.forEach((f, i) => {
      check(norm(rows[i].querySelector(".about-folder-label")) === f.label, `row ${i} label: ${norm(rows[i].querySelector(".about-folder-label"))}`);
      check(norm(rows[i].querySelector(".about-folder-path")) === f.path, `row ${i} path: ${norm(rows[i].querySelector(".about-folder-path"))}`);
    });
    check(!rows[2].querySelector("button") && norm(rows[2].querySelector(".about-folder-missing")) === "Not created yet", "a missing folder doesn't say Not created yet");
    const open = rows[0].querySelector("button");
    check(!!open && norm(open) === "Open folder" && open.classList.contains("btn-secondary") && open.classList.contains("btn-xs"), `Open folder: ${open && open.outerHTML}`);
    // A folder you chose (Videos here) may hold other files: it says so, the others don't.
    FOLDERS.forEach((f, i) => {
      const shared = rows[i].querySelector(".about-folder-shared");
      check(f.own ? !shared : isShown(shared) && norm(shared) === SHARED, `row ${i} other-files mark: ${shared && shared.outerHTML}`);
    });
    check(isShown($("about-folders-note")) && norm($("about-folders-note")) === DELETE_NOTE, `delete note: ${norm($("about-folders-note"))}`);
    check(!isShown($("about-guest-data")), "the guest line shows on this computer");

    open.click();
    await tick();
    const post = env.calls.filter((c) => c.url === "/api/data-folders/open");
    check(post.length === 1 && post[0].method === "POST" && JSON.parse(post[0].body).key === "rooms"
      && Object.keys(JSON.parse(post[0].body)).join() === "key", `open request: ${JSON.stringify(post)}`);
    const err = rows[0].querySelector(".about-folder-error");
    check(!isShown(err), "an error shows after Open folder worked");
    openAnswer = { status: 404, body: { detail: "That folder doesn't exist yet." } };
    open.click();
    await tick();
    check(isShown(err) && err.getAttribute("role") === "status" && norm(err) === "That folder doesn't exist yet.", `open error: ${norm(err)}`);
    console.log("PASS: on this computer About shows the version, the folders, and Open folder posts the folder's key");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }
  {
    // Neither read answers: no version line, and the folders say they couldn't be read.
    const env = await boot(HOST, (u) => {
      if (u === "/health") throw new Error("offline");
      if (u === "/api/data-folders") return { status: 500, body: { detail: "boom" } };
      return null;
    });
    await openFromMenu(env);
    check(!isShown(env.$("about-version")), `version line after a failed read: ${norm(env.$("about-version"))}`);
    check(isShown(env.$("about-folders-error")) && norm(env.$("about-folders-error")) === READ_ERROR, `a failed read: ${norm(env.$("about-folders-error"))}`);
    check(!env.$("modal-about").querySelector(".about-folder") && !isShown(env.$("about-folders-note")), "a failed read still shows rows or the delete note");
    console.log("PASS: when the reads fail, the version line hides and the folders say they couldn't be read");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }

  // --- On someone else's engine -------------------------------------------------------
  {
    const env = await boot(GUEST);
    await openFromMenu(env);
    const modal = env.$("modal-about");
    check(isShown(modal), "About didn't open for a guest");
    check(norm(env.$("about-version")) === "This room runs DubMate 2.0.0", `guest version line: ${norm(env.$("about-version"))}`);
    check(!env.calls.some((c) => c.url.startsWith("/api/data-folders")), "a guest's About asked for the host's folders");
    const privacy = Array.from(modal.querySelectorAll(".about-privacy .about-text")).filter(isShown).map(norm);
    check(privacy.join("|") === GUEST_PRIVACY.join("|"), `guest privacy lines: ${privacy.join(" | ")}`);
    check(isShown(env.$("about-guest-data")) && norm(env.$("about-guest-data")) === GUEST_DATA, `guest line: ${norm(env.$("about-guest-data"))}`);
    check(!modal.querySelector(".about-folder") && !isShown(env.$("about-folders-note")), "a guest sees folder rows or the delete note");
    check(!/[A-Za-z]:\\|\/Users\/|\/home\/|AppData/.test(modal.textContent), "path text in a guest's About");
    console.log("PASS: a guest's About names the room's version, asks for no folders and shows no paths");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }

  // --- The links ---------------------------------------------------------------------
  {
    const env = await boot(HOST);
    const { w, app, $ } = env;
    await openFromMenu(env);
    let links = Array.from($("about-links").querySelectorAll("a, button"));
    check(links.length === LINKS.length, `${links.length} links`);
    LINKS.forEach((l, i) => {
      const a = links[i];
      check(a.localName === "a" && a.getAttribute("href") === l.url && a.getAttribute("target") === "_blank"
        && a.getAttribute("rel") === "noopener noreferrer", `browser link ${l.page}: ${a.outerHTML}`);
      check(norm(a) === l.label && a.getAttribute("aria-label") === `${l.label} (opens in a new tab)` && a.getAttribute("data-tip") === l.url, `link ${l.page} name or tip: ${a.outerHTML}`);
      check(a.classList.contains("btn-secondary") && a.classList.contains("btn-sm"), `link ${l.page} classes`);
    });
    check(!$("modal-about").querySelector(".btn-primary"), "an amber button in About");
    env.esc();
    console.log("PASS: in a browser the links are anchors to a new tab, named so");

    // The desktop app on its own engine asks the app to open the page by name.
    const invokes = [];
    let refuse = false;
    w.__TAURI__ = { core: { invoke: (cmd, args) => { invokes.push([cmd, args]); return refuse ? Promise.reject("not allowed") : Promise.resolve(null); } } };
    const copied = [];
    Object.defineProperty(w.navigator, "clipboard", { configurable: true,
      value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } });
    await openFromMenu(env);
    links = Array.from($("about-links").querySelectorAll("a, button"));
    check(links.every((b) => b.localName === "button" && b.type === "button"), "desktop links aren't buttons");
    check(links.map(norm).join("|") === LINKS.map((l) => l.label).join("|"), `desktop labels: ${links.map(norm).join("|")}`);
    links[3].click();
    await tick();
    check(invokes.length === 1 && invokes[0][0] === "open_dubmate_page" && JSON.stringify(invokes[0][1]) === '{"page":"privacy"}', `invoked ${JSON.stringify(invokes)}`);
    check(!copied.length, "an accepted call still copied the link");
    console.log("PASS: in the desktop app a link asks the app to open the page by name");

    // An older app refuses: the link is copied, and every link becomes a copy button.
    refuse = true;
    links[1].click();
    await tick();
    check(copied.join() === LINKS[1].url, `copied ${copied}`);
    const hint = links[1].parentElement.querySelector(".external-link-hint");
    check(isShown(hint) && norm(hint) === "Link copied. Paste it into your browser.", `copy hint: ${norm(hint)}`);
    check(links.map(norm).join("|") === LINKS.map((l) => `Copy ${l.label.toLowerCase()} link`).join("|"), `after a refusal: ${links.map(norm).join("|")}`);
    env.esc();
    const asked = invokes.length;
    await openFromMenu(env);
    links = Array.from($("about-links").querySelectorAll("button"));
    check(norm(links[4]) === "Copy security link", `reopened after a refusal: ${norm(links[4])}`);
    links[4].click();
    await tick();
    check(invokes.length === asked && copied[copied.length - 1] === LINKS[4].url, "an older app was asked again");
    console.log("PASS: an app older than 2.0 copies the link instead, and every link says so");
    if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  }

  process.exit(0);
})().catch((err) => fail(err && err.stack || String(err)));
