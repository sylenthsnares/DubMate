/**
 * test_premiere_timeline.js
 *
 * The premiere's timeline and "In this dub" list (UI pass U5a, step 40c;
 * documentation/design/ui-u5a-premiere-export.md sections 1 and 5):
 *  - the timeline is one slider (Position, 0 to the duration, "0:03 of 0:06") with a
 *    tick at each line's start in its first actor's colour, muted when unassigned;
 *  - it follows the video, and a drag moves only the thumb and the time;
 *  - the host's release sends one screening_control seek; a member's seek stays local;
 *  - Left/Right move 5 s and , / . jump to the previous / next line start, through the
 *    same seek, only on the premiere and not from fields or controls that use arrows;
 *  - In this dub is open for the host, closed for members, counts the lines that use
 *    the original voice, and each row seeks to its line;
 *  - "Change take" shows only where canRecordLine, and opens that line in the booth
 *    with its take focused;
 *  - the list follows take and casting changes while the premiere is open.
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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const pct = (el, prop) => parseFloat(el.style[prop]);

async function boot() {
  const { JSDOM, VirtualConsole } = jsdom;
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(HTML, { url: "http://127.0.0.1:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.scrollTo = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [], addEventListener: () => {} } });
  w.fetch = (input) => {
    const u = String(input || "");
    const body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : { status: "ok" };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(BUNDLE);
  await tick(20);
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  if (app.isAudioSettingsOpen()) app.closeAudioSettings();
  return { w, app, errors };
}

(async () => {
  const { w, app, errors } = await boot();
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  app.showToast = () => {};
  app.user = { id: "u1", name: "Tani" };
  const sent = [];
  app.socket.send = (type, payload) => sent.push({ type, payload });
  const seeks = () => sent.filter((m) => m.type === "screening_control" && m.payload.action === "seek");

  // The theater's video: playing state, position and duration are the test's.
  const video = app.screeningVideo;
  let paused = true;
  let position = 0;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => position, set: (v) => { position = v; } });
  Object.defineProperty(video, "duration", { configurable: true, get: () => 6 });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
  video.play = () => { paused = false; return Promise.resolve(); };
  video.pause = () => { paused = true; };
  app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 1 });
  app.requestTakeRender = () => Promise.resolve({ status: 503 });
  const plays = [];
  const realStart = app.startScreeningPlayback.bind(app);
  app.startScreeningPlayback = (t) => { plays.push(t); };

  const lines = [
    { line_id: "a", index: 0, character: "Ana", start: 1, end: 2, duration: 1, peaks: [], audio_url: "/o0.wav", text: "Hi" },
    { line_id: "b", index: 1, character: "Cat", start: 2.5, end: 3.5, duration: 1, peaks: [], audio_url: "/o1.wav", text: "Yo" },
    { line_id: "c", index: 2, character: "Dan", start: 4, end: 5, duration: 1, peaks: [], audio_url: "/o2.wav", text: "No" },
  ];
  const take = (id, number, user) => ({ take_id: id, number, user_id: user, duration: 1, url: `/t/${id}.wav`, peaks: [] });
  const baseState = () => ({
    state_version: 3, room_id: "R1", host_id: "u1", status: "screening",
    users: {
      u1: { id: "u1", name: "Tani", color: "#d97706", is_online: true },
      u2: { id: "u2", name: "Ben", color: "#4ade80", is_online: true },
    },
    role_assignments: { Ana: ["u2"], Cat: ["u1"] },
    voice: { session: null, characters: {} },
    pack: { id: "P", name: "Scene", lines, characters: ["Ana", "Cat", "Dan"], video_url: "/v.mp4", duration: 6 },
    takes: { a: { picked: "a3", next_number: 4, takes: [take("a1", 1, "u2"), take("a2", 2, "u2"), take("a3", 3, "u2")] } },
    master_dialogue_presence_db: 0, master_mix_balance: 50,
    exports: { "16:9": "idle", "9:16": "idle" },
    has_export: false, export_video_url: null, download_url: null,
  });
  const deliver = (type, payload, state = {}) => {
    const data = { type, payload, state: { ...app.roomState, ...state } };
    app.socket.emit(type, data);
    app.socket.emit("*", data);
  };
  // jsdom's colour for a hex, so inline styles compare.
  const colour = (hex) => { const s = doc.createElement("span"); s.style.background = hex; return s.style.backgroundColor; };

  app.roomState = baseState();
  app.showView("screening");
  await app.setupScreeningView();

  // --- The timeline ---------------------------------------------------------------------
  const timeline = $("screening-timeline");
  const track = timeline && timeline.querySelector('[role="slider"]');
  if (!track) fail("the timeline has no slider");
  if (track.getAttribute("aria-label") !== "Position") fail(`slider name: ${track.getAttribute("aria-label")}`);
  if (track.getAttribute("aria-valuemin") !== "0" || track.getAttribute("aria-valuemax") !== "6") {
    fail(`slider range: ${track.getAttribute("aria-valuemin")}..${track.getAttribute("aria-valuemax")}`);
  }
  if (track.tabIndex !== 0 || timeline.querySelectorAll('[tabindex="0"], button, input').length !== 1) fail("the timeline is not one tab stop");
  const elapsed = $("screening-time-elapsed");
  const total = $("screening-time-total");
  if (norm(elapsed) !== "0:00" || norm(total) !== "0:06") fail(`times: ${norm(elapsed)} / ${norm(total)}`);
  if (track.getAttribute("aria-valuetext") !== "0:00 of 0:06") fail(`valuetext: ${track.getAttribute("aria-valuetext")}`);

  const ticks = [...timeline.querySelectorAll(".screening-tick")];
  if (ticks.length !== 3) fail(`${ticks.length} ticks for 3 lines`);
  if (!near(pct(ticks[0], "left"), 100 / 6) || !near(pct(ticks[1], "left"), 2.5 / 6 * 100) || !near(pct(ticks[2], "left"), 4 / 6 * 100)) {
    fail(`tick positions: ${ticks.map((t) => t.style.left)}`);
  }
  if (ticks[0].style.backgroundColor !== colour("#4ade80") || ticks[1].style.backgroundColor !== colour("#d97706")) {
    fail(`tick colours: ${ticks.map((t) => t.style.backgroundColor)}`);
  }
  if (ticks[2].style.backgroundColor || !ticks[2].classList.contains("is-unassigned")) fail("an unassigned line's tick is not muted");
  console.log("PASS: the timeline is one Position slider with a tick per line in its actor's colour");

  // It follows the video.
  position = 3.2;
  video.dispatchEvent(new w.Event("timeupdate"));
  const played = $("screening-track-played");
  const thumb = $("screening-track-thumb");
  if (norm(elapsed) !== "0:03" || track.getAttribute("aria-valuetext") !== "0:03 of 0:06") fail(`after timeupdate: ${norm(elapsed)} ${track.getAttribute("aria-valuetext")}`);
  if (!near(track.getAttribute("aria-valuenow"), 3.2)) fail(`valuenow: ${track.getAttribute("aria-valuenow")}`);
  if (!near(pct(played, "width"), 3.2 / 6 * 100) || !near(pct(thumb, "left"), 3.2 / 6 * 100)) fail(`played ${played.style.width}, thumb ${thumb.style.left}`);
  console.log("PASS: the timeline follows the video");

  // --- Drag as the host: only the thumb and time move, the release sends one seek -----------
  track.getBoundingClientRect = () => ({ left: 100, width: 600, top: 0, height: 20, right: 700, bottom: 20 });
  const pointer = (type, clientX, target = track) => target.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));
  sent.length = 0;
  pointer("pointerdown", 400);
  pointer("pointermove", 460);
  if (!near(pct(thumb, "left"), 60) || norm(elapsed) !== "0:04") fail(`mid-drag thumb ${thumb.style.left}, time ${norm(elapsed)}`);
  if (position !== 3.2) fail(`the video moved mid-drag to ${position}`);
  video.dispatchEvent(new w.Event("timeupdate"));
  if (!near(pct(thumb, "left"), 60)) fail("a timeupdate moved the thumb mid-drag");
  if (seeks().length) fail("the host sent a seek before letting go");
  pointer("pointerup", 460);
  if (seeks().length !== 1 || !near(seeks()[0].payload.timestamp, 3.6)) fail(`host release: ${JSON.stringify(sent)}`);
  console.log("PASS: a drag moves only the thumb and the time; the host's release sends one seek");

  // A click on a tick seeks to that line's start exactly.
  sent.length = 0;
  pointer("pointerdown", 351, ticks[1]);
  pointer("pointerup", 351, ticks[1]);
  if (seeks().length !== 1 || seeks()[0].payload.timestamp !== 2.5) fail(`tick click: ${JSON.stringify(sent)}`);
  console.log("PASS: a click on a tick seeks to its line's start");

  // --- Keys: Left/Right 5 s, , and . line starts -------------------------------------------
  const press = (key, target = doc.body, init = {}) => {
    const ev = new w.KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const keySeek = (key, at, target, init) => {
    sent.length = 0;
    position = at;
    press(key, target, init);
    return seeks().map((m) => m.payload.timestamp);
  };
  if (keySeek("ArrowRight", 3.2).join() !== "6") fail(`Right from 3.2: ${keySeek("ArrowRight", 3.2)}`);
  if (keySeek("ArrowLeft", 3.2).join() !== "0") fail(`Left from 3.2: ${keySeek("ArrowLeft", 3.2)}`);
  if (keySeek("ArrowLeft", 5.5).join() !== "0.5") fail(`Left from 5.5: ${keySeek("ArrowLeft", 5.5)}`);
  if (keySeek(".", 3.2).join() !== "4") fail(`. from 3.2: ${keySeek(".", 3.2)}`);
  if (keySeek(",", 3.2).join() !== "2.5") fail(`, from 3.2: ${keySeek(",", 3.2)}`);
  if (keySeek(",", 2.6).join() !== "1") fail(`, just after a line start: ${keySeek(",", 2.6)}`);
  if (keySeek(".", 4.5).join() !== "") fail("`.` after the last line moved");
  if (keySeek("ArrowRight", 1, track).join() !== "6") fail("Right on the focused timeline did not seek once");
  if (keySeek("ArrowRight", 1, doc.querySelector('#screening-mix .mix-preset')).length) fail("Right on a Mix preset also seeked");
  const field = doc.createElement("input");
  $("view-screening").appendChild(field);
  if (keySeek("ArrowRight", 1, field).length) fail("Right in a text field seeked");
  field.remove();
  if (keySeek("ArrowRight", 1, doc.body, { ctrlKey: true }).length) fail("Ctrl+Right seeked");
  console.log("PASS: Left/Right move 5 s and , / . jump between line starts, not from fields or presets");

  // Space plays for everyone only from the video, the timeline or the page; a focused
  // control (a section, a preset, a row, Save) gets its own Space.
  const space = (target) => {
    sent.length = 0;
    const ev = new w.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return sent.filter((m) => m.type === "screening_control" && m.payload.action !== "seek").length;
  };
  paused = true;
  if (space(doc.body) !== 1) fail("Space on the page did not play");
  if (space(track) !== 1) fail("Space on the timeline did not play");
  const spaceTargets = {
    "the Mix summary": doc.querySelector("#screening-mix > summary"),
    "a Mix preset": doc.querySelector("#screening-mix .mix-preset"),
    "In this dub's summary": doc.querySelector("#screening-lines > summary"),
    "a row": doc.querySelector(".screening-line-seek"),
    "Save": $("btn-export-video"),
    "the Save chevron": $("btn-save-menu"),
  };
  for (const [name, el] of Object.entries(spaceTargets)) {
    if (!el) fail(`no ${name} to press Space on`);
    if (space(el)) fail(`Space on ${name} played the premiere for everyone`);
  }
  console.log("PASS: Space on a focused control is the control's; elsewhere it plays");

  // --- In this dub (host) ------------------------------------------------------------------
  const list = $("screening-lines");
  if (!list || list.tagName !== "DETAILS" || !list.open) fail("In this dub is not an open disclosure for the host");
  const summary = () => norm(list.querySelector("summary"));
  if (summary() !== "In this dub · 3 lines · 2 use the original voice") fail(`summary: ${summary()}`);
  const rows = () => [...list.querySelectorAll(".screening-line")];
  const rowText = (i) => norm(rows()[i]);
  if (rows().length !== 3) fail(`${rows().length} rows`);
  const status = (i) => rows()[i].querySelector(".screening-line-status");
  if (!/#1/.test(rowText(0)) || !/Ana/.test(rowText(0)) || !/Ben/.test(rowText(0)) || norm(status(0)) !== "Take 3") fail(`row 1: ${rowText(0)}`);
  if (!/Cat/.test(rowText(1)) || !/Tani/.test(rowText(1)) || norm(status(1)) !== "Original voice · Unrecorded") fail(`row 2: ${rowText(1)}`);
  if (!status(1).classList.contains("is-original") || status(0).classList.contains("is-original")) fail("the original-voice status is not dimmed (or a take is)");
  if (!/Dan/.test(rowText(2)) || !/Unassigned/.test(rowText(2))) fail(`row 3: ${rowText(2)}`);
  const dot = (i) => rows()[i].querySelector(".screening-line-dot");
  if (dot(0).style.backgroundColor !== colour("#4ade80") || !dot(2).classList.contains("is-unassigned")) fail("row dots don't match the ticks");
  // Change take only where this user can record the line (the host is cast as Cat).
  const change = (i) => rows()[i].querySelector(".screening-line-change");
  if (change(0) || !change(1) || change(2)) fail(`Change take on rows ${rows().map((r, i) => (change(i) ? i + 1 : "")).join("")}`);
  // Cat has no takes yet: there is nothing to change, so the button says Record.
  if (!change(1).classList.contains("btn-ghost") || !change(1).classList.contains("btn-xs") || norm(change(1)) !== "Record"
      || change(1).getAttribute("aria-label") !== "Record line 2") fail(`Record: ${change(1).className} ${norm(change(1))}`);
  // A row click seeks (the host sends it).
  sent.length = 0;
  rows()[2].querySelector(".screening-line-seek").click();
  if (seeks().length !== 1 || seeks()[0].payload.timestamp !== 4) fail(`row click: ${JSON.stringify(sent)}`);
  console.log("PASS: In this dub lists each line's actor and take, counts original voices, and a row seeks");

  // Change take: the booth on that line, its take focused.
  const calls = [];
  const realShow = app.showView.bind(app);
  app.showView = (v) => { calls.push(["showView", v]); };
  app.broadcastMyStatus = (v) => calls.push(["broadcastMyStatus", v]);
  app.loadBoothLine = async (i) => {
    calls.push(["loadBoothLine", i]);
    $("takes-list").innerHTML = '<div class="take-row"><div role="radio" aria-checked="false" tabindex="-1">1</div></div>'
      + '<div class="take-row"><div role="radio" aria-checked="true" tabindex="0">2</div></div>';
  };
  change(1).click();
  await tick(5);
  if (JSON.stringify(calls) !== JSON.stringify([["showView", "booth"], ["loadBoothLine", 1], ["broadcastMyStatus", "booth"]])) fail(`Change take ran ${JSON.stringify(calls)}`);
  const focused = doc.activeElement;
  if (!focused || focused.getAttribute("aria-checked") !== "true" || !focused.closest("#card-takes")) fail(`Change take focused ${focused && focused.outerHTML}`);
  app.showView = realShow;
  app.showView("screening");
  console.log("PASS: Change take opens the line in the booth with its take focused");

  // --- It follows takes and casting while the premiere is open --------------------------------
  const takesB = { ...app.roomState.takes, b: { picked: "b1", next_number: 2, takes: [take("b1", 1, "u1")] } };
  deliver("take_picked", { line_index: 1, take_id: "b1" }, { takes: takesB });
  if (summary() !== "In this dub · 3 lines · 1 uses the original voice" || norm(status(1)) !== "Take 1") fail(`after take_picked: ${summary()} / ${norm(status(1))}`);
  if (norm(change(1)) !== "Change take" || change(1).getAttribute("aria-label") !== "Change take for line 2") fail(`with a take: ${norm(change(1))}`);
  // Take numbers stay the takes' own after a deletion ("Take 5", never "Take 5 of 3").
  const takesA = { ...app.roomState.takes, a: { picked: "a3", next_number: 4, takes: [take("a3", 3, "u2")] } };
  deliver("take_deleted", { line_index: 0, take_id: "a1" }, { takes: takesA });
  if (norm(status(0)) !== "Take 3") fail(`after a deletion: ${norm(status(0))}`);
  deliver("role_assigned", { character: "Dan", user_ids: ["u2"] }, { role_assignments: { Ana: ["u2"], Cat: ["u1"], Dan: ["u2"] } });
  if (!/Ben/.test(rowText(2)) || timeline.querySelectorAll(".screening-tick")[2].style.backgroundColor !== colour("#4ade80")) fail(`after role_assigned: ${rowText(2)}`);
  // Someone joins and is cast: the row names them once their join arrives.
  deliver("role_assigned", { character: "Dan", user_ids: ["u3"] }, { role_assignments: { Ana: ["u2"], Cat: ["u1"], Dan: ["u3"] } });
  if (!/Unassigned/.test(rowText(2))) fail(`cast before their join: ${rowText(2)}`);
  deliver("user_joined", { user_id: "u3" }, { users: { ...app.roomState.users, u3: { id: "u3", name: "Cleo", color: "#60a5fa", is_online: true } } });
  if (!/Cleo/.test(rowText(2)) || timeline.querySelectorAll(".screening-tick")[2].style.backgroundColor !== colour("#60a5fa")) fail(`after user_joined: ${rowText(2)}`);

  // Someone else records while a row or its button has the focus: the focus stays on it.
  rows()[1].querySelector(".screening-line-seek").focus();
  deliver("take_recorded", { line_index: 2, user_id: "u3" }, { takes: { ...app.roomState.takes } });
  if (doc.activeElement !== rows()[1].querySelector(".screening-line-seek")) fail(`a re-render dropped the row's focus to ${doc.activeElement && doc.activeElement.tagName}`);
  change(1).focus();
  deliver("take_picked", { line_index: 1, take_id: "b1" }, { takes: { ...app.roomState.takes } });
  if (doc.activeElement !== change(1)) fail(`a re-render dropped Change take's focus to ${doc.activeElement && doc.activeElement.tagName}`);
  console.log("PASS: the list and ticks follow take, casting and join changes, and keep the focus");

  // --- A member: closed list, local seeks ------------------------------------------------------
  app.user = { id: "u2", name: "Ben" };
  app.roomState = baseState();
  await app.setupScreeningView();
  if (list.open) fail("In this dub is open for a member");
  if (change(0) === null || change(1) || change(2)) fail("a member's Change take is not on their own line only");
  sent.length = 0;
  paused = true;
  pointer("pointerdown", 160);
  pointer("pointerup", 160);
  if (seeks().length || !near(position, 0.6)) fail(`member seek: sent ${JSON.stringify(sent)}, position ${position}`);
  paused = false;
  plays.length = 0;
  sent.length = 0;
  position = 1;
  press("ArrowRight");
  if (seeks().length || !near(position, 6)) fail(`member Right while playing: ${position} ${plays}`);
  if (plays.length !== 1 || !near(plays[0], 6)) fail(`a member's seek while playing did not restart playback there: ${plays}`);
  paused = true;
  rows()[1].querySelector(".screening-line-seek").click();
  if (seeks().length || position !== 2.5) fail(`member row click: ${position}`);
  console.log("PASS: a member's In this dub starts closed and their seeks stay local");

  // Not on another screen.
  app.showView("booth");
  sent.length = 0;
  position = 1;
  press("ArrowRight");
  if (position !== 1) fail("Right seeked the premiere from the booth");

  app.startScreeningPlayback = realStart;
  if (errors.length) fail(`console errors: ${errors.join("\n")}`);
  console.log("ALL PREMIERE TIMELINE TESTS PASSED");
  process.exit(0);
})();
