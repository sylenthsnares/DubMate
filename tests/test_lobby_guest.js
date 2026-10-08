/**
 * test_lobby_guest.js
 *
 * The lobby for friends and for the host (UI pass U1 step 5, 2.0 join flow G3):
 *  - a title row with the scene, one meta line, who's here and Copy invite link,
 *  - only the host sees "Start recording"; a friend sees "Tani starts the recording",
 *    or "Back to the booth" once recording is on, which only moves them, or "Back to
 *    the premiere" while the premiere is on,
 *  - the waiting line follows the room's status while the friend is on another screen,
 *  - the header is marked in-room (it compacts so its Leave stays in view),
 *  - "Who voices who" for the host (selects, Cast evenly), "Pick who you'll voice" for
 *    friends: names, "You" with Give back, "Original voice" with "I'll voice X"; a pick
 *    is sent, not drawn, and the room's answer is what shows,
 *  - avatars (an empty ring for Original voice, dimmed and "(offline)" for someone gone),
 *  - characters in natural order, "1 line" / "2 lines", then "1 of 2 recorded",
 *    "N characters keep the original voice.",
 *  - "Tani's room gave you X" once per room, never for the host,
 *  - no noise card, no second cast list, no "LOBBY" badge and no second Leave room,
 *  - a room restored with the placeholder host id 'host' gives everyone the selects.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
// A socket message's state must carry this page's state version to be applied.
const STATE_VERSION = Number(fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "studio", "takes.js"), "utf8")
  .match(/TAKE_STATE_VERSION = (\d+)/)[1]);
const { JSDOM, VirtualConsole } = jsdom;

function fail(msg, ...rest) {
  console.error("FAIL: " + msg, ...rest);
  process.exit(1);
}

function check(cond, msg, ...rest) {
  if (!cond) fail(msg, ...rest);
  console.log("PASS: " + msg);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.HTMLMediaElement.prototype.pause = function () {};
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} }; }
    createConvolver() { return { connect: () => {} }; }
  };
  w.scrollTo = () => {};
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("the studio did not boot");
  app.showToast = () => {};
  const sent = [];
  app.socket.send = (type, payload) => { sent.push({ type, payload }); return true; };
  const booth = [];
  app.loadBoothLine = (index) => { booth.push(index); };
  return { w, doc: w.document, app, sent, booth };
}

const CHARACTERS = ["Black Guy 10", "Black Guy 2", 'The "Boss"', "alice"];

function room(app, { hostId = "tani", status = "lobby" } = {}) {
  const me = app.user.id;
  return {
    state_version: STATE_VERSION, room_id: "LOBBY1", host_id: hostId, status,
    pack: {
      id: "P", name: "Rooftop", line_count: 4, characters: [...CHARACTERS],
      lines: [
        { index: 0, line_id: "a", character: "Black Guy 10", start: 0, end: 1 },
        { index: 1, line_id: "b", character: "Black Guy 10", start: 1, end: 2 },
        { index: 2, line_id: "c", character: "Black Guy 2", start: 2, end: 3 },
        { index: 3, line_id: "d", character: 'The "Boss"', start: 3, end: 4 },
      ],
    },
    users: {
      tani: { id: "tani", name: "Tani", color: "#f08a6c", is_online: true },
      [me]: { id: me, name: "Mika", color: "#7d9cf0", is_online: true },
    },
    role_assignments: { "Black Guy 10": [], "Black Guy 2": [me], 'The "Boss"': ["tani"], alice: [] },
    takes: {},
  };
}

const visible = (el) => !!el && !el.hidden;
const rows = (doc) => Array.from(doc.querySelectorAll("#casting-tbody tr[data-character]"));
const rowFor = (doc, char) => rows(doc).find((tr) => tr.dataset.character === char);
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const toastsOf = (app) => {
  const list = [];
  app.showToast = (m) => list.push(m);
  return list;
};
const stateOf = (app) => ({ ...JSON.parse(JSON.stringify(app.roomState)), state_version: STATE_VERSION });

(async () => {
  // The lobby markup: no LOBBY badge, no second Leave room, no noise card, one cast list.
  {
    const doc = new JSDOM(html).window.document;
    const lobby = doc.getElementById("view-lobby");
    check(!doc.getElementById("btn-leave-room-lobby"), "the lobby has no second Leave room button");
    check(!Array.from(lobby.querySelectorAll(".badge-studio")).some((b) => /lobby/i.test(b.textContent)), "the lobby has no LOBBY badge");
    check(!!doc.getElementById("btn-leave-room"), "the header's Leave stays");
    check(!doc.getElementById("check-lobby-noise-reduction") && !!doc.getElementById("check-noise-reduction"),
      "the lobby's noise card is gone; the booth keeps its switch");
    check(!doc.getElementById("lobby-cast-list") && !doc.getElementById("cast-online-count"), "the rail's second cast list is gone");
    check(!lobby.querySelector(".lobby-header-card") && !lobby.querySelector(".lobby-desc"), "no header card and no 'Give each character an actor' line");
    check(lobby.querySelector(".lobby-title-row #lobby-presence") && lobby.querySelector(".lobby-title-row #btn-copy-invite"),
      "the title row holds who's here and Copy invite link");
    check(text(doc.getElementById("btn-copy-invite")) === "Copy invite link", "the copy control reads Copy invite link");
    check(lobby.querySelector(".lobby-rail #btn-get-scene"), "Get this scene sits in the scene preview");
    const heads = Array.from(lobby.querySelectorAll(".casting-table th")).map((th) => text(th));
    check(heads.join("|") === "Character|Voiced by|Lines", "the columns are Character, Voiced by, Lines", heads);
  }

  // A friend in a room that hasn't started: the host starts the recording.
  {
    const { doc, app } = await boot();
    app.roomState = room(app);
    app.showView("lobby");
    const waiting = doc.getElementById("lobby-waiting");
    check(visible(waiting) && waiting.textContent === "Tani starts the recording", "a friend sees who starts the recording", waiting && waiting.textContent);
    check(!visible(doc.getElementById("btn-start-session")), "a friend has no Start recording");
    check(!visible(doc.getElementById("btn-back-to-booth")), "a friend in a waiting room has no Back to the booth");
    check(text(doc.getElementById("lobby-pack-title")) === "Rooftop", "the title row names the scene");
    check(text(doc.getElementById("lobby-meta")) === "4 lines · 4 characters · 4 s", "one meta line", text(doc.getElementById("lobby-meta")));
    check(text(doc.getElementById("lobby-here-count")) === "2 here", "the title row counts who's here", text(doc.getElementById("lobby-here-count")));
    check(doc.querySelectorAll("#lobby-presence .presence-stack .avatar").length === 2, "the shared who's-here stack is in the title row");
    check(text(doc.getElementById("casting-title")) === "Pick who you'll voice", "a friend's card reads Pick who you'll voice");
    check(!visible(doc.getElementById("btn-cast-evenly")), "a friend has no Cast evenly");

    // The host's name isn't known yet: "The host".
    delete app.roomState.users.tani;
    app.renderLobbyState();
    check(waiting.textContent === "The host starts the recording", "without the host's name the line says 'The host'", waiting.textContent);
  }

  // A friend while recording is on: Back to the booth only moves them.
  {
    const { doc, app, sent, booth } = await boot();
    app.roomState = room(app, { status: "recording" });
    app.showView("lobby");
    const back = doc.getElementById("btn-back-to-booth");
    check(visible(back) && /Back to the booth/.test(back.textContent), "a friend sees Back to the booth while recording is on");
    check(!visible(doc.getElementById("btn-start-session")), "a friend has no Start recording while recording is on");
    check(!visible(doc.getElementById("lobby-waiting")), "no waiting line while recording is on");
    sent.length = 0;
    back.click();
    await tick(20);
    check(app.currentView === "booth" && booth.length === 1 && booth[0] === 2, "Back to the booth opens the friend's first line", app.currentView, booth);
    check(!sent.some((m) => m.type === "set_status"), "Back to the booth sends no set_status", sent);
  }

  // A friend who stepped back to the lobby during the premiere: Back to the premiere.
  {
    const { doc, app, sent } = await boot();
    let premieres = 0;
    app.setupScreeningView = () => { premieres += 1; };
    app.roomState = room(app, { status: "screening" });
    app.showView("lobby");
    const back = doc.getElementById("btn-back-to-premiere");
    check(visible(back) && /Back to the premiere/.test(back.textContent), "a friend sees Back to the premiere while the premiere is on");
    check(!visible(doc.getElementById("btn-back-to-booth")) && !visible(doc.getElementById("btn-start-session")),
      "and no Back to the booth or Start recording");
    check(!visible(doc.getElementById("lobby-waiting")) && doc.getElementById("lobby-waiting").textContent === "", "and no waiting line");
    sent.length = 0;
    back.click();
    await tick(20);
    check(app.currentView === "screening" && premieres === 1, "Back to the premiere opens the premiere", app.currentView);
    check(sent.some((m) => m.type === "set_user_status" && m.payload.location === "screening") && !sent.some((m) => m.type === "set_status"),
      "it says where the friend is and sends no set_status", sent);

    // Recording or lobby: no Back to the premiere; the host never gets it.
    app.roomState.status = "recording";
    app.renderLobbyState();
    check(!visible(back), "no Back to the premiere while recording");
    const host = await boot();
    host.app.roomState = room(host.app, { hostId: host.app.user.id, status: "screening" });
    host.app.showView("lobby");
    check(!visible(host.doc.getElementById("btn-back-to-premiere")), "the host gets no Back to the premiere");
  }

  // The host starts recording while the friend waits: the friend moves to the booth and
  // the lobby's waiting line doesn't stay behind.
  {
    const { doc, app } = await boot();
    app.roomState = room(app);
    app.showView("lobby");
    const waiting = doc.getElementById("lobby-waiting");
    check(visible(waiting), "the friend is waiting");
    const next = room(app, { status: "recording" });
    app.socket.emit("status_changed", { type: "status_changed", payload: { status: "recording" }, state: next });
    await tick(20);
    check(app.currentView === "booth", "recording starting moves the friend to the booth", app.currentView);
    check(!visible(waiting) && waiting.textContent === "", "the waiting line is cleared", waiting.textContent);
    check(visible(doc.getElementById("btn-back-to-booth")), "the lobby is ready with Back to the booth");
  }

  // The header knows when it is in a room, so it can keep its Leave in view.
  {
    const { doc, app } = await boot();
    const header = doc.querySelector(".app-header");
    check(!header.classList.contains("in-room"), "the home screen header is not in-room");
    app.roomState = room(app);
    app.showView("lobby");
    check(header.classList.contains("in-room"), "the lobby header is in-room");
    app.showView("booth");
    check(header.classList.contains("in-room"), "the booth header is in-room");
    app.roomState = null;
    app.showView("landing");
    check(!header.classList.contains("in-room"), "leaving the room clears in-room");
  }

  // The host: Start recording, the selects, Cast evenly.
  {
    const { doc, app, sent } = await boot();
    app.roomState = room(app, { hostId: app.user.id });
    app.showView("lobby");
    check(visible(doc.getElementById("btn-start-session")), "the host sees Start recording");
    check(!visible(doc.getElementById("lobby-waiting")) && !visible(doc.getElementById("btn-back-to-booth")), "the host sees no waiting line or Back to the booth");
    check(text(doc.getElementById("casting-title")) === "Who voices who", "the host's card reads Who voices who");
    check(doc.querySelectorAll("#casting-tbody select.cast-select").length === CHARACTERS.length, "the host gets a select for every character");
    const first = doc.querySelector("#casting-tbody select.cast-select");
    check(first.options[0].value === "" && first.options[0].textContent.trim() === "Original voice", "the empty choice reads Original voice", first.options[0].textContent);
    check(Array.from(first.options).some((o) => o.textContent.trim() === "Mika (you)"), "the host's own name reads (you)");
    check(rowFor(doc, "alice").querySelector(".avatar.avatar-empty"), "an uncast character shows an empty ring");
    check(rowFor(doc, 'The "Boss"').querySelector(".avatar:not(.avatar-empty)"), "a cast character shows the voice's avatar");

    // The host's change is drawn at once and sent.
    const select = rowFor(doc, "alice").querySelector(".cast-select");
    select.value = "tani";
    select.dispatchEvent(new (doc.defaultView.Event)("change"));
    check(app.roomState.role_assignments.alice[0] === "tani", "the host's casting change is drawn at once");
    check(sent.some((m) => m.type === "assign_role" && m.payload.character === "alice"), "the host's casting change is sent");
    check(!rowFor(doc, "alice").querySelector(".avatar-empty"), "the drawn change shows the new voice's avatar");

    // An open select survives a room update that changes nothing about it.
    select.focus();
    app.renderLobbyState();
    check(doc.activeElement === select && select.isConnected, "an update keeps the focused select in place");

    // Cast evenly: sent, and a toast once the room says it's done.
    const toasts = toastsOf(app);
    const evenly = doc.getElementById("btn-cast-evenly");
    check(visible(evenly) && evenly.classList.contains("btn-secondary"), "the host has a secondary Cast evenly");
    sent.length = 0;
    evenly.click();
    check(sent.some((m) => m.type === "cast_evenly"), "Cast evenly sends cast_evenly", sent);
    app.socket.emit("cast_evenly", { type: "cast_evenly", payload: { triggered_by: app.user.id }, state: stateOf(app) });
    check(toasts.length === 1 && /evenly/i.test(toasts[0]), "a toast says the characters were shared out", toasts);

    // Start recording still moves the room.
    sent.length = 0;
    doc.getElementById("btn-start-session").click();
    await tick(20);
    check(sent.some((m) => m.type === "set_status" && m.payload.status === "recording"), "the host's Start recording sends set_status");
  }

  // A friend: names, You with Give back, Original voice with I'll voice.
  {
    const { doc, app, sent } = await boot();
    app.roomState = room(app);
    app.showView("lobby");
    const me = app.user.id;
    check(doc.querySelectorAll("#casting-tbody select").length === 0, "a friend gets no casting selects");
    check(text(rowFor(doc, 'The "Boss"').querySelector(".cast-actor-name")) === "Tani", "a friend sees who voices a character");
    check(!rowFor(doc, 'The "Boss"').querySelector("button.cast-claim, button.cast-give-back"), "no pick on someone else's character");
    const mine = rowFor(doc, "Black Guy 2");
    check(text(mine.querySelector(".cast-actor-name")) === "You", "a friend's own character reads You");
    const giveBack = mine.querySelector("button.cast-give-back");
    check(giveBack && text(giveBack) === "Give back" && giveBack.classList.contains("btn-ghost"), "with a ghost Give back");
    const free = rowFor(doc, "alice");
    check(text(free.querySelector(".cast-actor-name")) === "Original voice", "an uncast character reads Original voice");
    check(free.querySelector(".avatar.avatar-empty"), "with an empty ring");
    const claim = free.querySelector("button.cast-claim");
    check(claim && text(claim) === "I'll voice alice" && claim.classList.contains("btn-secondary"), "and a secondary I'll voice alice");
    check(!/Unassigned/.test(doc.getElementById("casting-tbody").textContent), "no 'Unassigned' left in the casting table");

    // A pick is sent, not drawn: the room's answer is what shows.
    sent.length = 0;
    claim.click();
    check(sent.some((m) => m.type === "assign_role" && m.payload.character === "alice" && JSON.stringify(m.payload.user_ids) === JSON.stringify([me])),
      "I'll voice sends assign_role for yourself", sent);
    check(!(app.roomState.role_assignments.alice || []).length, "I'll voice draws nothing before the room answers");
    sent.length = 0;
    giveBack.click();
    check(sent.some((m) => m.type === "assign_role" && m.payload.character === "Black Guy 2" && m.payload.user_ids.length === 0),
      "Give back sends assign_role with nobody", sent);
    check(text(mine.querySelector(".cast-actor-name")) === "You", "Give back draws nothing before the room answers");

    // The room's answer: alice is yours now, focus moves to its Give back.
    claim.focus();
    app.roomState.role_assignments.alice = [me];
    app.renderLobbyState();
    const now = rowFor(doc, "alice");
    check(text(now.querySelector(".cast-actor-name")) === "You" && now.querySelector("button.cast-give-back"), "the claimed character reads You with Give back");
    check(doc.activeElement === now.querySelector("button.cast-give-back"), "keyboard focus moves to the new Give back");

    // Natural order and line counts, then progress.
    const order = rows(doc).map((tr) => tr.dataset.character);
    check(order.indexOf("Black Guy 2") < order.indexOf("Black Guy 10"), "Black Guy 2 sorts before Black Guy 10", order);
    check(order[0] === "alice", "the sort ignores case", order);
    check(text(rowFor(doc, "Black Guy 2").querySelector(".char-line-count")) === "1 line", "one line reads '1 line'");
    check(text(rowFor(doc, "Black Guy 10").querySelector(".char-line-count")) === "2 lines", "two lines read '2 lines'");
    check(text(rowFor(doc, "alice").querySelector(".char-line-count")) === "0 lines", "no lines read '0 lines'");
    app.roomState.takes = { a: { picked: "t1", takes: [{ take_id: "t1" }] } };
    app.renderLobbyState();
    check(text(rowFor(doc, "Black Guy 10").querySelector(".char-line-count")) === "1 of 2 recorded", "a take turns the count into progress",
      text(rowFor(doc, "Black Guy 10").querySelector(".char-line-count")));

    // Free characters: the footer note.
    const note = doc.getElementById("casting-free-note");
    check(visible(note) && text(note) === "1 character keeps the original voice.", "the note counts the free characters", text(note));
    app.roomState.role_assignments["Black Guy 10"] = [me];
    app.renderLobbyState();
    check(!visible(note), "with everyone cast the note goes");
    app.roomState.role_assignments["Black Guy 10"] = [];
    app.roomState.role_assignments.alice = [];
    app.renderLobbyState();
    check(text(note) === "2 characters keep the original voice.", "two free characters", text(note));

    // In-place update: the host recasts the character with a quote in its name.
    app.roomState.role_assignments['The "Boss"'] = [me];
    app.renderLobbyState();
    check(text(rowFor(doc, 'The "Boss"').querySelector(".cast-actor-name")) === "You", "a character name with a quote finds its row");

    // Someone who left: dimmed, "(offline)" in the name.
    app.roomState.role_assignments.alice = ["tani"];
    app.roomState.users.tani.is_online = false;
    app.renderLobbyState();
    const gone = rowFor(doc, "alice").querySelector(".avatar");
    check(gone.classList.contains("is-offline") && /\(offline\)/.test(gone.getAttribute("aria-label") || "") && /\(offline\)/.test(gone.getAttribute("data-tip") || ""),
      "an offline voice is dimmed with (offline) in its name and tooltip");
    check(text(rowFor(doc, "alice").querySelector(".cast-actor-name")) === "Tani (offline)", "and in the name shown");
  }

  // "Tani's room gave you X": once per room, never for the host.
  {
    const { app } = await boot();
    const toasts = toastsOf(app);
    app.roomState = room(app);
    app.showView("lobby");
    const me = app.user.id;
    const joined = { type: "user_joined", payload: { user_id: me, color: "#7d9cf0", wanted_color: "#7d9cf0", cast: "Black Guy 2" } };
    const send = () => {
      const state = stateOf(app);
      app.socket.emit("user_joined", { ...joined, state });
      app.socket.emit("*", { ...joined, state });
    };
    send();
    const notice = "Tani's room gave you Black Guy 2. Pick another in the list if you like.";
    check(toasts.filter((t) => t === notice).length === 1, "a friend is told which character the room gave them", toasts);
    send();
    app.renderLobbyState();
    check(toasts.filter((t) => t === notice).length === 1, "the notice shows once per room", toasts);

    const host = await boot();
    const hostToasts = toastsOf(host.app);
    host.app.roomState = room(host.app, { hostId: host.app.user.id });
    host.app.showView("lobby");
    const hostJoined = { type: "user_joined", payload: { user_id: host.app.user.id, cast: "Black Guy 2" } };
    const hs = stateOf(host.app);
    host.app.socket.emit("user_joined", { ...hostJoined, state: hs });
    host.app.socket.emit("*", { ...hostJoined, state: hs });
    check(!hostToasts.some((t) => /gave you/.test(t)), "the host gets no casting notice", hostToasts);
  }

  // The scene preview: your first character, hover and focus preview a row, a click pins it,
  // and "Play this line" plays just that line with its sound.
  {
    const { w, doc, app } = await boot();
    app.roomState = room(app);
    app.roomState.pack.video_url = "/api/packs/P/video";
    app.roomState.pack.lines[2].caption = "Both of you, stop this.";
    app.roomState.pack.lines[0].caption = "First.";
    app.showView("lobby");
    const label = doc.getElementById("scene-preview-label");
    const line = doc.getElementById("scene-preview-text");
    const video = doc.getElementById("scene-preview-video");
    const tbody = doc.getElementById("casting-tbody");
    check(video.closest(".lobby-rail") && video.getAttribute("src") === "/api/packs/P/video" && video.getAttribute("preload") === "metadata" && video.muted,
      "the rail's preview is the scene's video, metadata only, muted");
    check(text(label) === "Black Guy 2 · 1 line", "by default it previews your first character", text(label));
    check(text(line) === "“Both of you, stop this.”", "with that character's first line", text(line));
    check(text(doc.getElementById("scene-preview-time")) === "0:02", "and when it starts", text(doc.getElementById("scene-preview-time")));
    check(video.currentTime === 2, "the video waits at the line's start", video.currentTime);
    check(rowFor(doc, "Black Guy 2").classList.contains("is-selected"), "the previewed row is marked");

    rowFor(doc, "Black Guy 10").dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true }));
    check(text(label) === "Black Guy 10 · 2 lines" && text(line) === "“First.”", "hovering a row previews it", text(label));
    check(rowFor(doc, "Black Guy 10").classList.contains("is-selected") && !rowFor(doc, "Black Guy 2").classList.contains("is-selected"), "only the previewed row is marked");
    tbody.dispatchEvent(new w.MouseEvent("mouseleave"));
    check(text(label) === "Black Guy 2 · 1 line", "leaving the table goes back to the chosen row", text(label));

    const boss = rowFor(doc, 'The "Boss"').querySelector(".cast-char");
    check(boss && boss.tagName === "BUTTON", "each character name is a button that pins the preview");
    boss.click();
    tbody.dispatchEvent(new w.MouseEvent("mouseleave"));
    check(text(label) === 'The "Boss" · 1 line' && boss.getAttribute("aria-pressed") === "true", "a click pins the row", text(label));

    rowFor(doc, "alice").querySelector("button.cast-claim").focus();
    check(text(label) === "alice · 0 lines", "keyboard focus in a row previews it", text(label));
    check(doc.getElementById("btn-play-line").hidden, "a character with no lines has nothing to play");
    rowFor(doc, "alice").querySelector("button.cast-claim").blur();
    check(text(label) === 'The "Boss" · 1 line', "focus leaving the table goes back to the pinned row", text(label));

    // Play this line: from the line's start with sound, Stop, and it stops at the line's end.
    const play = doc.getElementById("btn-play-line");
    let plays = 0;
    video.play = () => { plays += 1; Object.defineProperty(video, "paused", { configurable: true, value: false }); return Promise.resolve(); };
    video.pause = () => { Object.defineProperty(video, "paused", { configurable: true, value: true }); };
    check(text(play) === "▶ Play this line", "the button reads Play this line");
    play.click();
    await tick(10);
    check(plays === 1 && !video.muted && video.currentTime === 3 && text(play) === "■ Stop", "Play this line plays the line with sound and becomes Stop");
    video.currentTime = 4.05;
    video.dispatchEvent(new w.Event("timeupdate"));
    check(video.paused && video.muted && text(play) === "▶ Play this line" && video.currentTime === 3, "it stops at the line's end, back at its start");

    play.click();
    await tick(10);
    check(text(play) === "■ Stop", "playing again");
    rowFor(doc, "Black Guy 2").querySelector(".cast-char").click();
    check(video.paused && video.muted && text(play) === "▶ Play this line" && video.currentTime === 2, "choosing another row stops it");
    play.click();
    await tick(10);
    app.showView("booth");
    check(video.paused && video.muted, "leaving the lobby stops it");
  }

  // A room restored with the placeholder host id: everyone casts and starts.
  {
    const { doc, app } = await boot();
    app.roomState = room(app, { hostId: "host" });
    app.showView("lobby");
    check(doc.querySelectorAll("#casting-tbody select.cast-select").length === CHARACTERS.length, "with host_id 'host' everyone gets selects");
    check(visible(doc.getElementById("btn-start-session")), "with host_id 'host' everyone sees Start recording");
  }

  console.log("ALL LOBBY GUEST TESTS PASSED");
  process.exit(0);
})().catch((e) => fail(e && e.stack || String(e)));
