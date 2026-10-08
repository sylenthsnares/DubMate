/**
 * test_shortcut_sheet.js
 *
 * The keyboard shortcut sheet (static/js/shortcuts.js) and openDialog
 * (static/js/ui_common.js): "?" opens it outside text fields, focus moves in
 * and stays in, Escape / a backdrop click close it and focus goes back, and
 * Space can't record behind it. Every SHORTCUT_GROUPS item must have an entry
 * in VERIFY below that presses its keys and checks they do what the sheet says,
 * so the list can't drift from the code. The sheet lists the current screen's
 * keys first, then Everywhere, then the rest in a closed "On other screens".
 * Also: the builder's step-button tooltips no longer claim the arrow keys.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const studioHtml = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const builderHtml = fs.readFileSync(path.join(PROJECT_ROOT, "static", "builder.html"), "utf8");
const EXPOSE = ["const __mods = {};", "const __mods = window.__mods = {};"];
const studioBundle = buildStudioBundle().replace(...EXPOSE);
const BOOT = "new PackBuilderApp();";
const builderBundle = buildStudioBundle("static/js/pack_builder.js").replace(...EXPOSE).replace(BOOT, "window.__builderApp = " + BOOT);
const { JSDOM, VirtualConsole } = jsdom;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function check(cond, msg) {
  if (!cond) fail(msg);
  console.log("PASS: " + msg);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeDom(html, url) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  return { w, errors };
}

async function bootStudio() {
  const { w, errors } = makeDom(studioHtml, "http://127.0.0.1:8000/");
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} }; }
    createConvolver() { return { connect: () => {} }; }
  };
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });
  w.fetch = (input) => {
    const u = String(input || "");
    let body = {};
    if (u.startsWith("/api/packs")) body = [];
    else if (u.startsWith("/api/config")) body = { mic_sync: {} };
    else if (u.startsWith("/api/sessions")) body = { sessions: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(studioBundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  app.showToast = () => {};
  // Audio settings may open on first run; the tests start with it closed.
  if (app.isAudioSettingsOpen()) app.closeAudioSettings();
  return { w, doc: w.document, app, errors, page: "studio" };
}

async function bootBuilder() {
  const { w, errors } = makeDom(builderHtml, "http://127.0.0.1:8000/builder.html");
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  if (w.document.readyState === "loading") {
    await new Promise((r) => w.document.addEventListener("DOMContentLoaded", r));
  }
  w.eval(builderBundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.__builderApp;
  if (!app) fail("Pack Builder did not boot");
  app.showToast = () => {};
  return { w, doc: w.document, app, errors, page: "builder" };
}

const SHIFTED = { "[": "{", "]": "}" };
const NAMED = {
  Esc: { key: "Escape", code: "Escape" },
  Space: { key: " ", code: "Space" },
  "←": { key: "ArrowLeft", code: "ArrowLeft" },
  "↑": { key: "ArrowUp", code: "ArrowUp" },
  "↓": { key: "ArrowDown", code: "ArrowDown" },
  Enter: { key: "Enter", code: "Enter" },
  ",": { key: ",", code: "Comma" },
  ".": { key: ".", code: "Period" },
  "→": { key: "ArrowRight", code: "ArrowRight" },
  Delete: { key: "Delete", code: "Delete" },
  Backspace: { key: "Backspace", code: "Backspace" },
  "/": { key: "/", code: "Slash" },
  "?": { key: "?", code: "Slash", shiftKey: true },
  "[": { key: "[", code: "BracketLeft" },
  "]": { key: "]", code: "BracketRight" },
};

/** The KeyboardEvent a US keyboard sends for a combo from SHORTCUT_GROUPS. */
function eventInit(combo) {
  const shiftKey = combo.includes("Shift");
  const name = combo.filter((k) => k !== "Shift");
  if (name.length !== 1) fail(`unexpected combo ${JSON.stringify(combo)}`);
  const k = name[0];
  let init;
  if (NAMED[k]) init = { ...NAMED[k] };
  else if (/^[A-Z]$/.test(k)) init = { key: shiftKey ? k : k.toLowerCase(), code: `Key${k}` };
  else fail(`no key mapping for ${k}`);
  if (shiftKey) {
    init.shiftKey = true;
    if (SHIFTED[init.key]) init.key = SHIFTED[init.key];
  }
  return init;
}

function press(env, init, target) {
  const t = target || env.doc.activeElement || env.doc.body;
  const ev = new env.w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  t.dispatchEvent(ev);
  return ev;
}

function showView(env, name) {
  for (const [k, el] of Object.entries(env.app.views)) el.classList.toggle("active", k === name);
}

function spy(obj, name) {
  const calls = [];
  obj[name] = (...args) => { calls.push(args); };
  return calls;
}

const sheet = (env) => env.doc.getElementById("shortcut-sheet");
const sheetOpen = (env) => !!sheet(env) && !sheet(env).hidden;
const closeSheet = (env) => { if (sheetOpen(env)) press(env, { key: "Escape", code: "Escape" }); };

function blur(env) {
  if (env.doc.activeElement && env.doc.activeElement.blur) env.doc.activeElement.blur();
}

/**
 * One entry per SHORTCUT_GROUPS item id. run(env, combo, i) presses the combo
 * (i is its position in item.keys) in the right view and checks the effect.
 */
const VERIFY = {
  "scenes-search": (env, combo) => {
    showView(env, "landing");
    blur(env);
    press(env, eventInit(combo));
    return env.doc.activeElement === env.app.inputPackSearch;
  },
  "scenes-clear": (env, combo) => {
    showView(env, "landing");
    const calls = spy(env.app, "clearPackSearch");
    env.app.inputPackSearch.focus();
    press(env, eventInit(combo));
    blur(env);
    return calls.length === 1;
  },
  "rec-toggle": (env, combo) => {
    showView(env, "booth");
    blur(env);
    const calls = spy(env.app, "toggleRecording");
    press(env, eventInit(combo));
    return calls.length === 1;
  },
  "rec-cancel": (env, combo) => {
    showView(env, "booth");
    blur(env);
    const calls = spy(env.app, "cancelCurrentCountdown");
    env.app.recordState = "countdown";
    press(env, eventInit(combo));
    env.app.recordState = "idle";
    return calls.length === 1;
  },
  "rec-nudge": (env, combo) => nudgeBy(env, combo, -25),
  "rec-nudge-later": (env, combo) => nudgeBy(env, combo, 25),
  "rec-nudge-big": (env, combo, i) => nudgeBy(env, combo, i === 0 ? -100 : 100),
  "rec-switch": (env, combo) => {
    showView(env, "booth");
    blur(env);
    const calls = spy(env.app, "switchTransportSide");
    press(env, eventInit(combo));
    return calls.length === 1;
  },
  "line-prev": (env, combo) => {
    showView(env, "booth");
    blur(env);
    const calls = spy(env.app, "stepLine");
    press(env, eventInit(combo));
    return calls.length === 1 && calls[0][0] === -1;
  },
  "line-next": (env, combo) => {
    showView(env, "booth");
    blur(env);
    const calls = spy(env.app, "stepLine");
    press(env, eventInit(combo));
    return calls.length === 1 && calls[0][0] === 1;
  },
  "takes-focus": (env, combo) => {
    takesOnScreen(env);
    blur(env);
    press(env, eventInit(combo));
    return env.doc.activeElement === takeRadio(env, "b2");
  },
  "takes-move": (env, combo, i) => {
    takesOnScreen(env);
    takeRadio(env, i === 0 ? "a1" : "b2").focus();
    press(env, eventInit(combo));
    return env.doc.activeElement === takeRadio(env, i === 0 ? "b2" : "a1");
  },
  "takes-play": (env, combo) => {
    takesOnScreen(env);
    takeRadio(env, "a1").focus();
    const calls = spy(env.app, "playHistoryTake");
    press(env, eventInit(combo));
    return calls.length === 1 && calls[0][0].take_id === "a1";
  },
  "takes-use": (env, combo) => {
    takesOnScreen(env);
    takeRadio(env, "a1").focus();
    const calls = spy(env.app, "pickTake");
    press(env, eventInit(combo));
    return calls.length === 1 && calls[0][0].take_id === "a1";
  },
  "takes-delete": (env, combo) => {
    takesOnScreen(env);
    takeRadio(env, "a1").focus();
    const calls = spy(env.app, "deleteTake");
    press(env, eventInit(combo));
    return calls.length === 1 && calls[0][0].take_id === "a1";
  },
  "rack-toggle": (env, combo) => {
    showView(env, "booth");
    blur(env);
    const calls = spy(env.app, "toggleAllEffects");
    press(env, eventInit(combo));
    return calls.length === 1;
  },
  "watch-play": (env, combo) => {
    showView(env, "screening");
    blur(env);
    const calls = spy(env.app, "handleScreeningPlayPause");
    press(env, eventInit(combo));
    return calls.length === 1;
  },
  "watch-replay": (env, combo) => {
    showView(env, "screening");
    blur(env);
    const calls = spy(env.app, "handleScreeningReplay");
    press(env, eventInit(combo));
    return calls.length === 1;
  },
  "builder-play": (env, combo) => builderCall(env, combo, "togglePlayPause"),
  "builder-in": (env, combo) => builderCall(env, combo, "markInAtPlayhead"),
  "builder-out": (env, combo) => builderCall(env, combo, "markOutAtPlayhead"),
  "builder-new": (env, combo) => builderCall(env, combo, "addNewSegmentAtPlayhead"),
  "builder-step": (env, combo, i) => {
    const calls = builderCalls(env, combo, "seekRelative");
    return calls.length === 1 && calls[0][0] === (i === 0 ? -0.2 : 0.2);
  },
  "builder-jump": (env, combo, i) => {
    const calls = builderCalls(env, combo, "seekRelative");
    return calls.length === 1 && calls[0][0] === (i === 0 ? -2 : 2);
  },
  "builder-delete": (env, combo) => {
    env.app.segments = [{ start: 1, end: 2, text: "Hi", character: "A" }];
    env.app.selectedSegmentIndex = 0;
    const calls = builderCalls(env, combo, "deleteSegment");
    return calls.length === 1 && calls[0][0] === 0;
  },
  help: (env, combo) => {
    if (env.page === "studio") showView(env, "landing");
    blur(env);
    press(env, eventInit(combo));
    const ok = sheetOpen(env);
    closeSheet(env);
    return ok;
  },
  close: (env, combo) => {
    env.doc.getElementById("btn-shortcuts").click();
    if (!sheetOpen(env)) return false;
    press(env, eventInit(combo));
    return !sheetOpen(env);
  },
};

/** The booth with two takes on line 1 in the Takes card, newest (b2, in the dub) first. */
function takesOnScreen(env) {
  showView(env, "booth");
  const app = env.app;
  const take = (id, number) => ({ take_id: id, number, user_id: app.user.id, duration: 0.8, url: `/t/${id}` });
  app.roomState = { state_version: 3, room_id: "R", host_id: app.user.id, users: {}, role_assignments: {},
    pack: { lines: [{ line_id: "t1", index: 0, character: "Ana", start: 0, end: 1, duration: 1 }] },
    takes: { t1: { picked: "b2", next_number: 3, takes: [take("a1", 1), take("b2", 2)] } } };
  app.currentLineIndex = 0;
  app.renderTakesCard();
}

const takeRadio = (env, id) => [...env.doc.querySelectorAll("#takes-list .take-row")]
  .find((r) => r.dataset.takeId === id)?.querySelector('[role="radio"]');

function nudgeBy(env, combo, delta) {
  showView(env, "booth");
  blur(env);
  env.app.sliderNudge.value = "0";
  const calls = spy(env.app, "setNudgeValue");
  press(env, eventInit(combo));
  return calls.length === 1 && calls[0][0] === delta;
}

function builderCalls(env, combo, method) {
  env.app.currentStep = "editor";
  blur(env);
  const calls = spy(env.app, method);
  press(env, eventInit(combo));
  return calls;
}

const builderCall = (env, combo, method) => builderCalls(env, combo, method).length === 1;

async function verifyItems(env, groups) {
  for (const group of groups) {
    for (const item of group.items) {
      const run = VERIFY[item.id];
      if (!run) fail(`shortcut "${item.id}" has no entry in the VERIFY table`);
      item.keys.forEach((combo, i) => {
        // ASCII only: the test runner reads output in the console code page.
        const name = combo.map((k) => ({ "←": "Left", "→": "Right", "↑": "Up", "↓": "Down" }[k] || k)).join("+");
        check(run(env, combo, i) === true, `${env.page}: ${name} does "${item.label}" (${item.id})`);
      });
    }
  }
}

async function testStudio() {
  const env = await bootStudio();
  const { doc, w, app } = env;
  const { SHORTCUT_GROUPS } = w.__mods["static/js/shortcuts.js"];
  const opener = doc.getElementById("btn-shortcuts");
  check(!!opener && opener.getAttribute("aria-label") === "Keyboard shortcuts"
    && opener.getAttribute("data-tip") === "Keyboard shortcuts (?)", "the studio header has the ? button");
  const el = sheet(env);
  check(!!el && el.hidden, "the sheet is built once and starts hidden");
  check(el.getAttribute("role") === "dialog" && el.getAttribute("aria-modal") === "true", "the sheet is a modal dialog");
  const title = doc.getElementById(el.getAttribute("aria-labelledby"));
  check(!!title && title.textContent === "Keyboard shortcuts", "the sheet is labelled 'Keyboard shortcuts'");
  const titles = [...el.querySelectorAll(".shortcut-group-title")].map((h) => h.textContent).sort();
  check(JSON.stringify(titles) === JSON.stringify(["Booth", "Choose a scene", "Everywhere", "Premiere"]),
    "the studio sheet has Choose a scene, Booth, Premiere and Everywhere");
  const kbdCount = SHORTCUT_GROUPS.filter((g) => g.page !== "builder")
    .reduce((n, g) => n + g.items.reduce((m, it) => m + it.keys.reduce((a, c) => a + c.length, 0), 0), 0);
  check(el.querySelectorAll("kbd").length === kbdCount, "every key has its own <kbd>");

  // '?' in a text field types a question mark.
  showView(env, "landing");
  app.inputPackSearch.focus();
  press(env, { key: "?", code: "Slash", shiftKey: true });
  check(!sheetOpen(env), "? in a text field does not open the sheet");

  // '?' opens it, focus moves inside and stays there.
  opener.focus();
  press(env, { key: "?", code: "Slash", shiftKey: true });
  check(sheetOpen(env) && el.classList.contains("is-open"), "? opens the sheet");
  const closeBtn = el.querySelector(".shortcut-sheet-close");
  check(doc.activeElement === closeBtn, "focus moves to the Close button");
  check(w.__mods["static/js/ui_common.js"].isDialogOpen(), "isDialogOpen() is true while it is open");
  press(env, { key: "Tab", code: "Tab" });
  check(doc.activeElement === closeBtn, "Tab stays inside the sheet");
  press(env, { key: "Tab", code: "Tab", shiftKey: true });
  check(doc.activeElement === el.querySelector("summary"), "Shift+Tab wraps to On other screens, inside the sheet");

  // Space behind the sheet does not record.
  showView(env, "booth");
  const rec = spy(app, "toggleRecording");
  press(env, { key: " ", code: "Space" }, doc.body);
  check(rec.length === 0, "Space while the sheet is open does not record");
  const nudges = spy(app, "setNudgeValue");
  press(env, { key: "[", code: "BracketLeft" }, doc.body);
  check(nudges.length === 0, "[ while the sheet is open does not nudge");
  showView(env, "landing");
  press(env, { key: "/", code: "Slash" }, doc.body);
  check(doc.activeElement !== app.inputPackSearch, "/ while the sheet is open does not jump to the search");

  // Escape closes it and focus goes back to the opener.
  closeBtn.focus();
  press(env, { key: "Escape", code: "Escape" });
  check(!sheetOpen(env) && !el.classList.contains("is-open"), "Escape closes the sheet");
  check(doc.activeElement === opener, "focus returns to the ? button");
  check(!w.__mods["static/js/ui_common.js"].isDialogOpen(), "isDialogOpen() is false after closing");

  // The ? button, the Close button, and a backdrop click.
  opener.click();
  check(sheetOpen(env), "the ? button opens the sheet");
  closeBtn.click();
  check(!sheetOpen(env) && doc.activeElement === opener, "Close closes it and focus returns");
  opener.click();
  el.querySelector(".shortcut-sheet-card").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  check(sheetOpen(env), "a click inside the card keeps it open");
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  check(!sheetOpen(env) && doc.activeElement === opener, "a backdrop click closes it and focus returns");

  // Blocked while Audio settings or an export is busy.
  app.isRenderingExport = true;
  blur(env);
  press(env, { key: "?", code: "Slash", shiftKey: true });
  check(!sheetOpen(env), "? does nothing while an export is rendering");
  app.isRenderingExport = false;

  // openDialog with several controls: Tab wraps last -> first, Shift+Tab first -> last.
  const { openDialog } = w.__mods["static/js/ui_common.js"];
  const box = doc.createElement("div");
  box.hidden = true;
  box.innerHTML = '<div><button id="d1">One</button><input id="d2"><button id="d3" hidden>Hidden</button><a id="d4" href="#x">Four</a></div>';
  doc.body.appendChild(box);
  const back = doc.createElement("button");
  doc.body.appendChild(back);
  back.focus();
  const close = openDialog(box, { returnFocus: back });
  const [d1, d4] = [doc.getElementById("d1"), doc.getElementById("d4")];
  check(!box.hidden && doc.activeElement === d1, "openDialog shows the overlay and focuses its first control");
  d4.focus();
  press(env, { key: "Tab", code: "Tab" });
  check(doc.activeElement === d1, "Tab from the last control wraps to the first");
  press(env, { key: "Tab", code: "Tab", shiftKey: true });
  check(doc.activeElement === d4, "Shift+Tab from the first control wraps to the last");
  close();
  close();
  check(box.hidden && doc.activeElement === back && !w.__mods["static/js/ui_common.js"].isDialogOpen(),
    "close() hides it, returns focus, and is safe to call twice");

  await verifyItems(env, SHORTCUT_GROUPS.filter((g) => g.page !== "builder"));
  testSheetByView(env, SHORTCUT_GROUPS);
  check(env.errors.length === 0, `no console errors in the studio (${env.errors.join(" | ")})`);
  return SHORTCUT_GROUPS;
}

async function testBuilder() {
  const env = await bootBuilder();
  const { doc, w } = env;
  const { SHORTCUT_GROUPS } = w.__mods["static/js/shortcuts.js"];
  const opener = doc.getElementById("btn-shortcuts");
  check(!!opener && opener.getAttribute("data-tip") === "Keyboard shortcuts (?)", "the Pack Builder header has the ? button");
  // Before the editor step: a muted line in place of the editor keys.
  env.app.currentStep = "upload";
  opener.click();
  let layout = sheetLayout(env);
  check(layout.note === "These work once your video is in the editor." && layout.noteFirst && JSON.stringify(layout.top) === JSON.stringify(["Everywhere"])
    && JSON.stringify(layout.more) === JSON.stringify(["In the editor"]) && layout.moreOpen === false,
    "before the editor, the builder sheet says when its keys start working");
  press(env, { key: "Escape", code: "Escape" });
  env.app.currentStep = "editor";
  opener.click();
  layout = sheetLayout(env);
  check(layout.note === null && JSON.stringify(layout.top) === JSON.stringify(["In the editor", "Everywhere"])
    && layout.more.length === 0, "in the editor, the builder sheet lists In the editor, then Everywhere");
  press(env, { key: "Escape", code: "Escape" });

  // Space in the editor doesn't play behind the sheet.
  env.app.currentStep = "editor";
  opener.click();
  const plays = spy(env.app, "togglePlayPause");
  press(env, { key: " ", code: "Space" }, doc.body);
  check(plays.length === 0, "Space while the sheet is open does not play the builder");
  press(env, { key: "Escape", code: "Escape" });
  check(!sheetOpen(env) && doc.activeElement === opener, "Escape closes the builder sheet and focus returns");

  await verifyItems(env, SHORTCUT_GROUPS.filter((g) => g.page !== "studio"));

  const tips = [...doc.querySelectorAll("[data-tip]")].map((n) => n.getAttribute("data-tip"));
  check(!tips.some((t) => t.includes("(←)") || t.includes("(→)")), "the builder tooltips no longer claim the arrow keys");
  check(doc.getElementById("btn-step-backward").getAttribute("data-tip") === "Back 1 second"
    && doc.getElementById("btn-step-forward").getAttribute("data-tip") === "Forward 1 second", "step buttons say Back / Forward 1 second");
  check(env.errors.length === 0, `no console errors in the Pack Builder (${env.errors.join(" | ")})`);
}

/** The sheet's group titles: the top level, the ones inside "On other screens", and the note. */
function sheetLayout(env) {
  const el = sheet(env);
  const more = el.querySelector("details.shortcut-more");
  const titles = (root, inside) => [...root.querySelectorAll(".shortcut-group-title")]
    .filter((h) => !!h.closest("details") === inside).map((h) => h.textContent);
  const note = el.querySelector(".shortcut-note");
  const top = titles(el, false);
  return {
    top,
    more: more ? titles(more, true) : [],
    moreOpen: more ? more.open : null,
    moreTitle: more ? more.querySelector("summary").textContent : null,
    note: note ? note.textContent : null,
    noteFirst: !!note && el.querySelector(".shortcut-sheet-groups").firstElementChild === note,
  };
}

function testSheetByView(env, groups) {
  const { app, doc } = env;
  check(groups.every((g) => ["landing", "booth", "screening", "editor", "any"].includes(g.view)), "every group names its screen");

  // Group titles are the screens' own names in index.html.
  const landing = doc.getElementById("view-landing").getAttribute("aria-label");
  const crumb = (id) => doc.querySelector(`#${id} .crumb-text`).textContent.trim();
  const byView = Object.fromEntries(groups.map((g) => [g.view, g.title]));
  check(byView.landing === landing && byView.booth === crumb("nav-step-booth") && byView.screening === crumb("nav-step-screening"),
    "group titles match the screen names (Choose a scene, Booth, Premiere)");

  const nudges = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, [i.keys, i.label]]));
  check(JSON.stringify(nudges["rec-nudge"]) === JSON.stringify([[["["]], "Move my take 25 ms earlier"])
    && JSON.stringify(nudges["rec-nudge-later"]) === JSON.stringify([[["]"]], "Move my take 25 ms later"])
    && nudges["rec-nudge-big"][1] === "Same, by 100 ms", "the nudge rows say which way the take moves");

  const opener = doc.getElementById("btn-shortcuts");
  app.currentView = "booth";
  opener.click();
  let layout = sheetLayout(env);
  check(JSON.stringify(layout.top) === JSON.stringify(["Booth", "Everywhere"])
    && JSON.stringify(layout.more) === JSON.stringify(["Choose a scene", "Premiere"])
    && layout.moreOpen === false && layout.moreTitle === "On other screens",
    "in the booth: Booth, then Everywhere, then the rest in a closed On other screens");
  press(env, { key: "Escape", code: "Escape" });

  app.currentView = "screening";
  opener.click();
  layout = sheetLayout(env);
  check(JSON.stringify(layout.top) === JSON.stringify(["Premiere", "Everywhere"])
    && JSON.stringify(layout.more) === JSON.stringify(["Choose a scene", "Booth"]), "reopening in the premiere puts Premiere first");
  press(env, { key: "Escape", code: "Escape" });

  app.currentView = "lobby";
  opener.click();
  layout = sheetLayout(env);
  check(JSON.stringify(layout.top) === JSON.stringify(["Everywhere"]) && layout.more.length === 3 && layout.note === null,
    "the lobby shows Everywhere and the other screens");
  press(env, { key: "Escape", code: "Escape" });
}

(async () => {
  const groups = await testStudio();
  await testBuilder();
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  check(new Set(ids).size === ids.length, "shortcut ids are unique");
  check(Object.keys(VERIFY).every((id) => ids.includes(id)), "VERIFY has no entries for shortcuts that are gone");
  console.log("All shortcut sheet checks passed.");
  process.exit(0);
})().catch((err) => fail(err && err.stack || String(err)));
