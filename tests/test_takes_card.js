/**
 * test_takes_card.js
 *
 * The booth's TAKES card (UI pass U2, group 2): the 0, 1 and 3 take states, the rows
 * (radio, "Take 3", "0.8 s", the recorder's avatar when it isn't you, sync in words, "In
 * the dub" or the "Use this take" cue, ▶ and the ⋯ menu with Delete), picking by a row
 * click and by Enter, ▶ that turns to ■ while its take plays, the deferred delete with its
 * in-place Undo (no confirm; the DELETE goes out when the 6 s run out, at once on a
 * line change, or on pagehide with keepalive), the roving focus and the T, arrow, P,
 * Enter, Delete, A, "," and "." keys, read-only rows (▶ only) on someone else's line, and the
 * line chips (buttons with aria-current, spoken labels and a visible take count).
 * Socket and fetch are stubbed; the 6 s timer is captured, not waited for.
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
const UNDO_MS = 6000;

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
  w.Element.prototype.scrollIntoView = () => {};
  w.confirm = (m) => fail(`window.confirm was used: ${m}`);
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });

  // The undo timer is captured so the test can run it (or see it cleared) at once.
  const timers = new Map();
  let nextTimer = 1e6;
  const realSet = w.setTimeout.bind(w);
  const realClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => {
    if (ms !== UNDO_MS) return realSet(fn, ms, ...args);
    const id = nextTimer++;
    timers.set(id, fn);
    return id;
  };
  w.clearTimeout = (id) => { if (timers.has(id)) timers.delete(id); else realClear(id); };

  const calls = [];
  const env = { w, calls, errors, timers, reply: null };
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body, keepalive: !!opts.keepalive });
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
  if (app.isAudioSettingsOpen()) app.closeAudioSettings();

  env.app = app;
  env.toasts = [];
  app.showToast = (msg) => env.toasts.push(msg);
  app.user = { id: "u1", name: "Ana" };
  app.socket.send = () => {};
  app.socket.updateTakeParams = () => {};
  app.socket.connectionState = "open";
  app.audioSetup.permission = "granted";
  app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
  // Every line on the chips, so "," and "." walk the whole scene.
  app.filterMyLinesOnly = false;
  for (const [k, el] of Object.entries(app.views)) el.classList.toggle("active", k === "booth");
  app.currentView = "booth";
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const visible = (el) => !!el && !el.hidden && el.style.display !== "none";

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

/** Takes 1 (Mika, loose), 2 (unscored) and 3 (tight, in the dub) on line 1. */
const threeTakes = () => ({ t1000: { picked: "c3", next_number: 4, takes: [
  mk("a1", 1, { user_id: "u9", user_name: "Mika", duration: 1.74, timing_score: 0.41 }),
  mk("b2", 2, { duration: 0.8, timing_score: null }),
  mk("c3", 3, { duration: 0.83, timing_score: 0.82 }),
] } });

async function show(env, state, index = 0) {
  env.app.roomState = state;
  await env.app.loadBoothLine(index);
  await tick();
}

function press(env, key, target, extra = {}) {
  const t = target || env.w.document.activeElement || env.w.document.body;
  const ev = new env.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  t.dispatchEvent(ev);
  return ev;
}

const radios = (env) => [...$(env, "takes-list").querySelectorAll('[role="radio"]')];
const rowOf = (radio) => radio.closest(".take-row");
const deletes = (env) => env.calls.filter((c) => c.method === "DELETE");

(async () => {
  const env = await boot();
  const { app, w } = env;
  const doc = w.document;
  const card = $(env, "card-takes");
  const title = $(env, "takes-card-title");
  const empty = $(env, "takes-empty");
  const hint = $(env, "takes-hint");
  const list = $(env, "takes-list");
  const keyHint = card.querySelector(".takes-key-hint");

  for (const id of ["take-history", "btn-take-history", "take-history-panel"]) {
    if ($(env, id)) fail(`the old take history #${id} is still in the page`);
  }
  if (typeof app.toggleTakeHistory === "function") fail("toggleTakeHistory is still there");

  // 1. No takes, one take, three takes.
  {
    await show(env, room());
    if (!visible(card)) fail("the card is hidden with no takes");
    if (text(title) !== "TAKES") fail(`empty title: ${text(title)}`);
    if (!visible(empty) || text(empty) !== "No takes yet. Press Space to record.") fail(`empty line: ${text(empty)}`);
    if (visible(hint) || visible(keyHint) || radios(env).length) fail("rows, hint or T hint shown with no takes");

    await show(env, room({ t1000: { picked: "a1", next_number: 2, takes: [mk("a1", 1, { timing_score: 0.7 })] } }));
    if (text(title) !== "TAKES · 1" || visible(empty)) fail(`one take title: ${text(title)} / empty ${visible(empty)}`);
    if (!visible(hint) || text(hint) !== "Record again to compare takes.") fail(`one take hint: ${text(hint)}`);
    if (!visible(keyHint) || text(keyHint) !== "T to pick") fail(`T hint: ${text(keyHint)}`);
    const [only] = radios(env);
    if (!only || only.getAttribute("aria-checked") !== "true" || !rowOf(only).classList.contains("picked")) fail("the only take isn't the checked row");
    if (!text(rowOf(only)).includes("In the dub") || rowOf(only).querySelector(".take-use-cue")) fail("the take in the dub shows the Use cue or lacks In the dub");

    await show(env, room(threeTakes()));
    if (text(title) !== "TAKES · 3" || visible(hint) || visible(empty)) fail(`three takes: ${text(title)} hint ${visible(hint)}`);
    if (list.getAttribute("role") !== "radiogroup") fail("the rows aren't a radiogroup");
    const rs = radios(env);
    const names = rs.map((r) => text(r.querySelector(".take-name")));
    if (names.join("|") !== "Take 3|Take 2|Take 1") fail(`rows newest first: ${names}`);
    const durs = rs.map((r) => text(r.querySelector(".take-dur")));
    if (durs.join("|") !== "0.8 s|0.8 s|1.7 s") fail(`durations: ${durs}`);
    // Who recorded it: their avatar (initial on their colour), the name in its tooltip.
    if (list.querySelector(".take-by")) fail("the recorder's name is still cut-down text");
    const avatars = rs.map((r) => r.querySelector(".avatar"));
    if (avatars[0] || avatars[1] || !avatars[2]) fail("an avatar on your own take, or none on Mika's");
    if (text(avatars[2]) !== "M" || avatars[2].dataset.tip !== "Recorded by Mika"
        || avatars[2].getAttribute("aria-label") !== "Recorded by Mika") fail(`Mika's avatar: ${text(avatars[2])} ${avatars[2].dataset.tip}`);
    if (!/#16a34a|rgb\(22, 163, 74\)/.test(avatars[2].style.background) || avatars[2].style.getPropertyValue("--avatar-size") !== "20px") {
      fail(`avatar colour or size: ${avatars[2].style.cssText}`);
    }
    const sync = rs.map((r) => r.querySelector(".take-sync"));
    if (sync.map(text).join("|") !== "Tight sync|–|Loose sync") fail(`sync words: ${sync.map(text)}`);
    if (sync[0].dataset.tip !== "Timing 82%: how closely this take follows the original line's timing") fail(`sync tip: ${sync[0].dataset.tip}`);
    if (sync[2].dataset.tip !== "Timing 41%: how closely this take follows the original line's timing") fail(`sync tip 41: ${sync[2].dataset.tip}`);
    const checked = rs.map((r) => r.getAttribute("aria-checked"));
    if (checked.join() !== "true,false,false") fail(`aria-checked: ${checked}`);
    if (!rowOf(rs[0]).classList.contains("picked") || rowOf(rs[1]).classList.contains("picked")) fail("green row on the wrong take");
    // No Use button: a row click (or Enter) uses a take, and the row says so on hover and focus.
    if (list.querySelector(".take-use")) fail("the Use button is still there");
    const cues = rs.map((r) => r.querySelector(".take-use-cue"));
    if (cues[0] || !cues[1] || !cues[2]) fail("the Use this take cue is on the wrong rows");
    if (text(cues[1]) !== "Use this take" || cues[1].dataset.tip !== "Use this take in the dub (Enter)") fail(`cue: ${text(cues[1])} / ${cues[1].dataset.tip}`);
    if (!rs[1].contains(cues[1])) fail("the cue isn't part of the row's click target");
    // ▶ on every row, after the slot, and ⋯ last.
    for (const [i, r] of rs.entries()) {
      const play = rowOf(r).querySelector(".take-play");
      const n = [3, 2, 1][i];
      if (!play || play.tagName !== "BUTTON" || text(play) !== "▶" || play.getAttribute("aria-label") !== `Play take ${n}`
        || play.getAttribute("aria-pressed") !== "false") fail(`▶ on take ${n}: ${play && play.outerHTML}`);
      const more = rowOf(r).querySelector(".take-more");
      if (!more || more.getAttribute("aria-haspopup") !== "menu" || more.getAttribute("aria-expanded") !== "false") fail("⋯ button missing or not a menu button");
      if (play.nextElementSibling !== more) fail("▶ isn't right before ⋯");
    }
    // The cue shows only on hover and keyboard focus; its slot keeps its width so ▶ never moves.
    const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8");
    if (!/\.take-use-cue\s*\{[^}]*visibility:\s*hidden/.test(css)) fail("the cue isn't hidden by default");
    // Only over the part a click uses (not ▶ or ⋯), and on keyboard focus.
    if (!/\.take-pick:hover \.take-use-cue/.test(css) || !/\.take-pick:focus-visible \.take-use-cue/.test(css)) fail("the cue doesn't show on hover and keyboard focus of the row's pick area");
    if (/\.take-row:hover \.take-use-cue/.test(css)) fail("the cue shows while the pointer is on ▶ or ⋯");
    if (!/\.take-use-cue\s*\{[^}]*font-size:\s*12px/.test(css)) fail("the cue isn't 12px hint text");
    if (!/\.take-slot\s*\{[^}]*width:/.test(css) || !/\.take-slot\s*\{[^}]*overflow:\s*hidden/.test(css)) fail("the slot has no fixed width, or lets a wide cue spill over the sync word");
    const tabStops = rs.filter((r) => r.tabIndex === 0);
    if (tabStops.length !== 1 || tabStops[0] !== rs[0]) fail("one tab stop, on the take in the dub");

    // Good sync and a negative score.
    await show(env, room({ t1000: { picked: "a1", next_number: 3, takes: [
      mk("a1", 1, { timing_score: 0.6 }), mk("b2", 2, { timing_score: -0.2 })] } }));
    const words = radios(env).map((r) => text(r.querySelector(".take-sync")));
    if (words.join("|") !== "–|Good sync") fail(`good sync and negative score: ${words}`);
    console.log("PASS: the card reads 0, 1 and 3 takes, newest first, with sync in words and one green row in the dub");
  }

  // 2. Pick by a row click and by Enter; focus stays on the card after the reload.
  {
    await show(env, room(threeTakes()));
    env.reply = (u, opts) => {
      const m = /\/takes\/(\w+)\/pick$/.exec(u);
      if (!m || opts.method !== "POST") return null;
      const line = { ...threeTakes().t1000, picked: m[1] };
      return { status: "ok", line_id: "t1000", line };
    };
    radios(env)[1].querySelector(".take-use-cue").click();
    await tick();
    let pick = env.calls.filter((c) => /\/pick$/.test(c.url)).pop();
    if (!pick || pick.url !== "/api/rooms/R1/lines/t1000/takes/b2/pick" || JSON.parse(pick.body).user_id !== "u1") fail(`row click: ${JSON.stringify(pick)}`);
    if (app.takeForLine(0).take_id !== "b2" || radios(env)[1].getAttribute("aria-checked") !== "true") fail("a row click did not move the green row");
    // ▶ plays; it never picks.
    const picksBefore = env.calls.filter((c) => /\/pick$/.test(c.url)).length;
    const realPlay = app.playHistoryTake;
    const playedBy = [];
    app.playHistoryTake = (take, button) => { playedBy.push([take.take_id, button && button.className]); };
    rowOf(radios(env)[2]).querySelector(".take-play").click();
    app.playHistoryTake = realPlay;
    await tick();
    if (env.calls.filter((c) => /\/pick$/.test(c.url)).length !== picksBefore) fail("▶ picked the take");
    if (playedBy.length !== 1 || playedBy[0][0] !== "a1" || !/take-play/.test(playedBy[0][1])) fail(`▶ played ${JSON.stringify(playedBy)}`);

    radios(env)[2].focus();
    press(env, "Enter");
    await tick();
    pick = env.calls.filter((c) => /\/pick$/.test(c.url)).pop();
    if (pick.url !== "/api/rooms/R1/lines/t1000/takes/a1/pick") fail(`Enter picked ${pick.url}`);
    if (app.takeForLine(0).take_id !== "a1") fail("Enter did not pick");
    if (doc.activeElement !== radios(env)[2]) fail(`focus left the picked row after the reload: ${doc.activeElement && doc.activeElement.className}`);
    if (radios(env)[2].tabIndex !== 0) fail("the tab stop did not follow the pick");

    // Enter on the take already in the dub sends nothing.
    const before = env.calls.length;
    press(env, "Enter");
    await tick();
    if (env.calls.slice(before).some((c) => /\/pick$/.test(c.url))) fail("Enter re-picked the take in the dub");
    env.reply = null;
    console.log("PASS: a row click and Enter put a take in the dub, ▶ only plays, and focus stays on its row");
  }

  // 3. Roving focus, T, and P.
  {
    await show(env, room(threeTakes()));
    doc.activeElement && doc.activeElement.blur && doc.activeElement.blur();
    press(env, "t", doc.body);
    let rs = radios(env);
    if (doc.activeElement !== rs[0]) fail("T did not focus the take in the dub");
    press(env, "ArrowDown");
    if (doc.activeElement !== rs[1] || rs[1].tabIndex !== 0 || rs[0].tabIndex !== -1) fail("ArrowDown did not move the focus and the tab stop");
    press(env, "ArrowDown");
    press(env, "ArrowDown");
    if (doc.activeElement !== rs[2]) fail("ArrowDown went past the last row");
    press(env, "ArrowUp");
    if (doc.activeElement !== rs[1]) fail("ArrowUp did not move up");

    const played = [];
    const realPlay = app.playHistoryTake;
    app.playHistoryTake = (take, button) => { played.push(take.take_id); played.button = button; };
    press(env, "p");
    if (played.join() !== "b2") fail(`P played ${played}`);
    if (!played.button || !played.button.classList.contains("take-play") || rowOf(played.button) !== rowOf(rs[1])) fail("P doesn't pulse the row's ▶");

    // ▶ reads ■ while its take plays (or waits for its sound), and ▶ again once it stops.
    const plays = () => radios(env).map((r) => text(rowOf(r).querySelector(".take-play"))).join("");
    app.playingHistoryTakeId = "b2";
    app.isPlayingTake = true;
    app.renderTransport();
    if (plays() !== "▶■▶" || rowOf(radios(env)[1]).querySelector(".take-play").getAttribute("aria-pressed") !== "true") fail(`while take 2 plays: ${plays()}`);
    app.renderTakesCard();
    if (plays() !== "▶■▶") fail(`a redraw lost the playing take: ${plays()}`);
    app.stopBoothPlayback();
    if (plays() !== "▶▶▶") fail(`after stopping: ${plays()}`);
    // The current take's own preview isn't a row playing.
    app.isPlayingTake = true;
    app.playingHistoryTakeId = null;
    app.renderTransport();
    if (plays() !== "▶▶▶") fail(`the transport's preview lit a row: ${plays()}`);
    app.isPlayingTake = false;
    app.renderTransport();

    // With T on a line after a pick by someone else, T still finds the take in the dub.
    await show(env, room({ t1000: { ...threeTakes().t1000, picked: "a1" } }));
    press(env, "T", doc.body, { shiftKey: true });
    rs = radios(env);
    if (doc.activeElement !== rs[2]) fail("Shift+T did not focus the take in the dub");

    // Keys don't fire in a text field or a focused knob, or with Ctrl.
    played.length = 0;
    const input = doc.createElement("input");
    doc.body.appendChild(input);
    input.focus();
    press(env, "t", input);
    if (doc.activeElement !== input) fail("T fired in a text field");
    input.remove();
    const knob = doc.querySelector(".analog-dial-wrapper");
    if (knob) {
      knob.focus();
      press(env, "t", knob);
      if (doc.activeElement !== knob) fail("T fired on a focused knob");
    }
    doc.body.focus();
    press(env, "t", doc.body, { ctrlKey: true });
    if (radios(env).includes(doc.activeElement)) fail("Ctrl+T moved focus to the takes");
    app.playHistoryTake = realPlay;
    console.log("PASS: T goes to the take in the dub, the arrows move one tab stop, P plays the focused take");
  }

  // 4. Delete: in place with Undo, no confirm; Undo cancels the DELETE.
  {
    await show(env, room(threeTakes()));
    let rs = radios(env);
    const more = rowOf(rs[2]).querySelector(".take-more");
    more.click();
    const menu = rowOf(rs[2]).querySelector(".take-menu");
    if (!visible(menu) || more.getAttribute("aria-expanded") !== "true") fail("⋯ did not open its menu");
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((b) => text(b.querySelector(".take-menu-label") || b));
    if (items.join("|") !== "Delete take") fail(`menu items: ${items}`);
    if (doc.activeElement !== menu.querySelector('[role="menuitem"]')) fail("focus did not move into the menu");

    // Escape closes the menu and returns to ⋯; an outside click closes it too.
    press(env, "Escape");
    if (visible(menu) || doc.activeElement !== more || more.getAttribute("aria-expanded") !== "false") fail("Escape did not close the menu");
    more.click();
    doc.body.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    if (visible(menu)) fail("an outside click did not close the menu");

    more.click();
    [...menu.querySelectorAll('[role="menuitem"]')].find((b) => /Delete take/.test(text(b))).click();
    await tick();
    if (deletes(env).length) fail("the DELETE went out at once");
    if (env.timers.size !== 1) fail(`undo timer: ${env.timers.size}`);
    const gone = list.querySelector(".take-row.is-deleted");
    if (!gone || text(gone.querySelector(".take-deleted-text")) !== "Take 1 deleted") fail(`deleted row: ${text(gone)}`);
    const undo = gone.querySelector("button");
    if (!undo || text(undo) !== "Undo") fail("no Undo button");
    if (radios(env).length !== 2) fail("the deleted take is still a radio");
    if (doc.activeElement !== undo) fail("focus did not move to Undo");

    undo.click();
    await tick();
    if (env.timers.size !== 0) fail("Undo did not cancel the timer");
    if (radios(env).length !== 3 || list.querySelector(".take-row.is-deleted")) fail("Undo did not bring the row back");
    if (deletes(env).length) fail("Undo still sent the DELETE");
    if (doc.activeElement !== radios(env)[2]) fail("focus did not return to the take after Undo");
    console.log("PASS: Delete take turns the row into 'Take 1 deleted · Undo', and Undo cancels it");
  }

  // 5. The timer running out sends the DELETE; the Delete key starts it.
  {
    await show(env, room(threeTakes()));
    env.reply = (u, opts) => {
      if (opts.method !== "DELETE") return null;
      const t = threeTakes().t1000;
      return { status: "ok", line: { ...t, takes: t.takes.filter((x) => x.take_id !== "b2") } };
    };
    radios(env)[1].focus();
    press(env, "Delete");
    await tick();
    if (deletes(env).length || env.timers.size !== 1) fail("the Delete key did not defer the delete");
    const [fire] = [...env.timers.values()];
    env.timers.clear();
    fire();
    await tick();
    const sent = deletes(env);
    if (sent.length !== 1 || sent[0].url !== "/api/rooms/R1/lines/t1000/takes/b2?user_id=u1") fail(`timer delete: ${JSON.stringify(sent)}`);
    if (radios(env).length !== 2 || list.querySelector(".take-row.is-deleted")) fail("the row stayed after the delete went out");
    if (text(title) !== "TAKES · 2") fail(`count after delete: ${text(title)}`);
    if (env.toasts.includes("Take deleted")) fail("a toast repeated what the row already said");
    env.calls.length = 0;
    console.log("PASS: the Delete key defers the delete, and the DELETE goes out when the time runs out");
  }

  // 6. A line change sends a pending DELETE at once; so does pagehide (keepalive).
  {
    await show(env, room(threeTakes()));
    rowOf(radios(env)[0]).querySelector(".take-more").click();
    [...rowOf(radios(env)[0]).querySelectorAll('[role="menuitem"]')].find((b) => /Delete/.test(text(b))).click();
    if (deletes(env).length) fail("sent before the line changed");
    await app.loadBoothLine(1);
    await tick();
    let sent = deletes(env);
    if (sent.length !== 1 || sent[0].url !== "/api/rooms/R1/lines/t1000/takes/c3?user_id=u1") fail(`line change: ${JSON.stringify(sent)}`);
    if (env.timers.size !== 0) fail("the timer outlived the line change");
    env.calls.length = 0;

    // Reloading the same line keeps it pending.
    await show(env, room(threeTakes()));
    radios(env)[1].focus();
    press(env, "Delete");
    await app.loadBoothLine(0);
    await tick();
    if (deletes(env).length || !list.querySelector(".take-row.is-deleted")) fail("a reload of the same line lost or sent the pending delete");

    w.dispatchEvent(new w.Event("pagehide"));
    await tick();
    sent = deletes(env);
    if (sent.length !== 1 || !sent[0].keepalive || sent[0].url !== "/api/rooms/R1/lines/t1000/takes/b2?user_id=u1") fail(`pagehide: ${JSON.stringify(sent)}`);
    env.calls.length = 0;

    // Leaving the booth sends it too.
    await show(env, room(threeTakes()));
    radios(env)[1].focus();
    press(env, "Delete");
    app.showView("lobby");
    await tick();
    if (deletes(env).length !== 1) fail("leaving the booth did not send the pending delete");
    for (const [k, el] of Object.entries(app.views)) el.classList.toggle("active", k === "booth");
    app.currentView = "booth";
    env.calls.length = 0;
    env.reply = null;
    console.log("PASS: a pending delete goes out at once on a line change, on leaving the booth and on pagehide");
  }

  // 7. Someone else's line: read-only rows, Play only.
  {
    await show(env, room({ t3000: { picked: "m2", next_number: 3, takes: [
      mk("m1", 1, { user_id: "u9", user_name: "Mika" }), mk("m2", 2, { user_id: "u9", user_name: "Mika", timing_score: 0.9 })] } }), 2);
    if (!visible(card) || text(title) !== "TAKES · 2") fail(`other's line: ${visible(card)} ${text(title)}`);
    if (list.getAttribute("aria-readonly") !== "true") fail("the radiogroup isn't read-only");
    const rs = radios(env);
    if (rs.length !== 2 || rs[0].getAttribute("aria-checked") !== "true" || !text(rowOf(rs[0])).includes("In the dub")) fail("no In the dub marker on the read-only rows");
    if (list.querySelector(".take-use, .take-use-cue")) fail("Use on someone else's line");
    if (visible(keyHint)) fail("T to pick on someone else's line");
    if (list.querySelector(".take-more")) fail("⋯ on rows you can't delete");
    if (rs.some((r) => !rowOf(r).querySelector(".take-play"))) fail("a read-only row has no ▶");
    if (rs.some((r) => !rowOf(r).querySelector(".take-slot"))) fail("a read-only row lost its slot, so ▶ moves");
    rs[1].focus();
    press(env, "Enter");
    press(env, "Delete");
    rs[1].click();
    await tick();
    if (env.calls.some((c) => /\/pick$/.test(c.url) || c.method === "DELETE") || env.timers.size) fail("a read-only row picked or deleted");
    if (list.querySelector(".take-row.is-deleted")) fail("Delete marked a read-only row");

    await show(env, room({}), 2);
    if (text(empty) !== "No takes yet.") fail(`empty other's line: ${text(empty)}`);
    console.log("PASS: someone else's line shows read-only rows with In the dub and ▶, and no ⋯");
  }

  // 8. A, "," and "."
  {
    await show(env, room(threeTakes()), 1);
    doc.body.focus();
    press(env, ".", doc.body);
    await tick();
    if (app.currentLineIndex !== 2) fail(`. went to line ${app.currentLineIndex + 1}`);
    press(env, ",", doc.body);
    await tick();
    if (app.currentLineIndex !== 1) fail(`, went to line ${app.currentLineIndex + 1}`);

    await show(env, room(threeTakes()), 0);
    const spy = { orig: 0, preview: 0, ab: [] };
    const realOrig = app.playOriginalReference;
    const realPreview = app.previewCurrentTake;
    const realSetAB = app.audio.setABState;
    app.playOriginalReference = () => { spy.orig++; };
    app.previewCurrentTake = () => { spy.preview++; };
    app.audio.setABState = function (s) { spy.ab.push(s); this.abState = s; };
    press(env, "a", doc.body);
    if (spy.preview !== 1 || spy.orig !== 0) fail(`A when idle with a take: ${JSON.stringify(spy)}`);
    app.isPlayingTake = true;
    app.playingHistoryTakeId = null;
    spy.ab = [];
    press(env, "a", doc.body);
    press(env, "a", doc.body);
    if (spy.ab.join() !== "B,A" || spy.preview !== 1) fail(`A while the take plays: ${JSON.stringify(spy)}`);
    app.isPlayingTake = false;
    await show(env, room(), 0);
    press(env, "a", doc.body);
    if (spy.orig !== 1) fail(`A with no take plays the original: ${JSON.stringify(spy)}`);
    app.playOriginalReference = realOrig;
    app.previewCurrentTake = realPreview;
    app.audio.setABState = realSetAB;

    // Nothing fires behind an open dialog.
    await show(env, room(threeTakes()), 1);
    $(env, "btn-shortcuts").click();
    const sheet = $(env, "shortcut-sheet");
    if (!sheet || sheet.hidden) fail("the shortcut sheet did not open");
    const steps = [];
    const realStep = app.stepLine;
    app.stepLine = (d) => steps.push(d);
    press(env, ".", doc.activeElement);
    press(env, "t", doc.activeElement);
    app.stepLine = realStep;
    if (steps.length || radios(env).includes(doc.activeElement)) fail("a booth key fired behind the shortcut sheet");
    press(env, "Escape", doc.activeElement);
    if (!sheet.hidden) fail("the shortcut sheet did not close");

    const orig = $(env, "btn-play-orig");
    const prev = $(env, "btn-prev-line");
    if (!/\(A\)$/.test(orig.dataset.tip) || !/\(A\)$/.test($(env, "btn-preview-take").dataset.tip)) fail(`transport tips: ${orig.dataset.tip}`);
    if (prev.dataset.tip !== "Previous line (,)") fail(`Prev tip: ${prev.dataset.tip}`);
    if ($(env, "btn-next-line").dataset.tip !== "Next line (.)") fail(`Next tip: ${$(env, "btn-next-line").dataset.tip}`);
    await show(env, room(), 2);
    if ($(env, "btn-next-line").dataset.tip !== "Marks you ready for the premiere (.)") fail(`Done tip: ${$(env, "btn-next-line").dataset.tip}`);
    console.log("PASS: A switches the transport side, ',' and '.' change lines, and the tooltips carry the keys");
  }

  // 9. Line chips: buttons, aria-current, spoken labels, a visible take count.
  {
    await show(env, room({ ...threeTakes(), t2000: { picked: "x1", next_number: 2, takes: [mk("x1", 1)] } }), 0);
    const chips = [...$(env, "timeline-chips").children];
    if (chips.length !== 3 || chips.some((c) => c.tagName !== "BUTTON" || c.type !== "button")) fail("chips aren't buttons");
    if (chips[0].getAttribute("aria-current") !== "step" || chips[1].hasAttribute("aria-current")) fail("aria-current on the wrong chip");
    const labels = chips.map((c) => c.getAttribute("aria-label"));
    if (labels.join("|") !== "Line 1, Ana, recorded, 3 takes|Line 2, Ana, recorded, 1 take|Line 3, Ben, not recorded") fail(`chip labels: ${labels.join("|")}`);
    const counts = chips.map((c) => text(c.querySelector(".chip-count")));
    // The chip shows "1 ✓ 3" (one fixed width); the words are in its name and tooltip.
    if (counts.join("|") !== "3|1|") fail(`visible counts: ${JSON.stringify(counts)}`);
    if (text(chips[0].querySelector(".chip-num")) !== "1") fail("chip number");
    chips[2].click();
    await tick();
    if (app.currentLineIndex !== 2) fail("a chip click did not load its line");
    const after = [...$(env, "timeline-chips").children];
    if (after[2].getAttribute("aria-current") !== "step") fail("aria-current did not follow the line");
    console.log("PASS: line chips are buttons with aria-current, 'Line 1, Ana, recorded, 3 takes' and a visible count");
  }

  // 10. Backspace deletes too (the Mac's Delete key); Space on Undo doesn't record; the chip
  //     counts the take as gone while its Undo shows; focus stays on the card afterwards.
  {
    await show(env, room(threeTakes()));
    env.reply = (u, opts) => {
      if (opts.method !== "DELETE") return null;
      const t = threeTakes().t1000;
      return { status: "ok", line: { ...t, takes: t.takes.filter((x) => x.take_id !== "b2") } };
    };
    radios(env)[1].focus();
    press(env, "Backspace");
    await tick();
    if (!list.querySelector(".take-row.is-deleted") || env.timers.size !== 1) fail("Backspace did not defer the delete");
    const undo = list.querySelector(".take-undo");
    if (doc.activeElement !== undo) fail("focus didn't move to Undo");
    let recorded = 0;
    const realToggle = app.toggleRecording;
    app.toggleRecording = () => { recorded++; };
    const ev = press(env, " ", undo, { code: "Space" });
    app.toggleRecording = realToggle;
    if (recorded || ev.defaultPrevented) fail("Space on Undo started a recording instead of pressing Undo");
    const chip0 = $(env, "timeline-chips").children[0];
    if (text(chip0.querySelector(".chip-count")) !== "2") fail(`chip count during Undo: ${text(chip0.querySelector(".chip-count"))}`);
    const [fire] = [...env.timers.values()];
    env.timers.clear();
    fire();
    await tick();
    if (!doc.activeElement || doc.activeElement.getAttribute("role") !== "radio" || !list.contains(doc.activeElement)) {
      fail(`focus after the delete went out: ${doc.activeElement && doc.activeElement.tagName}`);
    }
    env.calls.length = 0;
    env.reply = null;
    console.log("PASS: Backspace deletes, Space on Undo doesn't record, the chip drops the take, focus stays on the card");
  }

  // 11. Many takes stay tidy: the list scrolls inside the card (its scrollbar in the
  //     card's gutter, so rows keep their width), a long card gives way before Voice and
  //     Monitor, the durations line up, the A/B switch keeps one line, and the take in
  //     the dub is scrolled into view without losing where you scrolled to on a redraw.
  {
    const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // The block whose whole selector is `sel` (not one in a selector list).
    const rule = (sel) => {
      const m = css.match(new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
      return m ? m[2] : "";
    };
    const listCss = rule(".takes-list");
    for (const [what, re] of [
      ["a max-height", /max-height\s*:\s*calc\(/],
      ["overflow-y: auto", /overflow-y\s*:\s*auto/],
      ["overflow-x: hidden", /overflow-x\s*:\s*hidden/],
      ["scrollbar-gutter: stable", /scrollbar-gutter\s*:\s*stable/],
    ]) {
      if (!re.test(listCss)) fail(`.takes-list needs ${what} so many takes scroll inside the card`);
    }
    if (/scrollbar-(width|color)\s*:/.test(listCss)) fail(".takes-list sets scrollbar-width/color; Chromium then draws the grey bar");
    if (!/@supports not selector\(::-webkit-scrollbar\)\s*\{[^}]*\.takes-list\s*[,{]/.test(css)) fail(".takes-list lacks the Firefox scrollbar colours");
    const longCss = rule(".takes-card.is-long");
    if (!/flex-shrink\s*:\s*1/.test(longCss) || !/min-height\s*:/.test(longCss)) fail("a long Takes card doesn't give way in the column");
    if (!/white-space\s*:\s*nowrap/.test(rule(".transport-seg-btn"))) fail("the A/B switch can wrap ('▶ Take 25')");
    if (!/minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/.test(rule(".transport-seg"))) fail("the A/B halves can grow past the deck");
    const nameCss = rule(".take-name");
    if (!/min-width\s*:/.test(nameCss) || !/tabular-nums/.test(nameCss)) fail("'Take 9' and 'Take 10' rows don't line up their durations");

    // 25 takes, the oldest in the dub: it sits at the bottom of the list.
    const many = () => ({ t1000: { picked: "k1", next_number: 26, takes: Array.from({ length: 25 }, (_, i) => mk(`k${i + 1}`, i + 1, { timing_score: 0.5 })) } });
    // A 150px list of 42px rows (JSDOM has no layout).
    const ROW = 42, VIEW = 150, TOP = 100;
    let scrolled = 0;
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => VIEW });
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => list.children.length * ROW });
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => scrolled,
      set: (v) => { scrolled = Math.max(0, Math.min(v, Math.max(0, list.scrollHeight - VIEW))); } });
    const realRect = w.Element.prototype.getBoundingClientRect;
    w.Element.prototype.getBoundingClientRect = function rect() {
      const box = (top, h) => ({ top, bottom: top + h, left: 0, right: 314, width: 314, height: h, x: 0, y: top });
      if (this === list) return box(TOP, VIEW);
      if (this.parentElement === list) return box(TOP + [...list.children].indexOf(this) * ROW - scrolled, ROW - 4);
      return realRect.call(this);
    };
    const inView = (row) => { const r = row.getBoundingClientRect(); return r.top >= TOP && r.bottom <= TOP + VIEW; };
    try {
      await show(env, room(many()), 1);
      await show(env, room(many()), 0);
      const picked = list.querySelector(".take-row.picked");
      if (!picked || text(picked.querySelector(".take-name")) !== "Take 1") fail("the oldest take isn't the row in the dub");
      if (!inView(picked)) fail(`the take in the dub is scrolled out of view (scrollTop ${list.scrollTop})`);
      if (!card.classList.contains("is-long")) fail("25 rows didn't mark the Takes card long");
      list.scrollTop = 300;
      app.renderTakesCard();
      if (list.scrollTop !== 300) fail(`a redraw lost the list's scroll place (${list.scrollTop})`);
      app.roomState.takes.t1000.picked = "k25";
      app.renderTakesCard();
      if (!inView(list.querySelector(".take-row.picked")) || list.scrollTop !== 0) fail(`a new take in the dub isn't scrolled into view (${list.scrollTop})`);
      await show(env, room({ t1000: { picked: "a1", next_number: 3, takes: [mk("a1", 1), mk("b2", 2)] } }), 0);
      if (card.classList.contains("is-long") || list.scrollTop !== 0) fail("two takes kept the long card or an old scroll place");
    } finally {
      w.Element.prototype.getBoundingClientRect = realRect;
      for (const k of ["clientHeight", "scrollHeight", "scrollTop"]) delete list[k];
    }
    console.log("PASS: many takes scroll inside the card, the long card gives way, rows line up, A/B keeps one line, the take in the dub stays in view");
  }

  if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  console.log("All takes card checks passed.");
  process.exit(0);
})().catch((err) => fail(err && err.stack || String(err)));
