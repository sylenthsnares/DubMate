/**
 * test_lobby_guest.js
 *
 * The lobby for guests and for the host (UI pass U1, step 5):
 *  - only the host sees "Start recording"; a guest sees "Waiting for {host} to start
 *    recording", or "Back to the booth" once recording is on, which only moves them,
 *    or "Back to the premiere" while the premiere is on,
 *  - the waiting line follows the room's status while the guest is on another screen,
 *  - the header is marked in-room (it compacts so its Leave stays in view),
 *  - only the host gets the casting selects; a guest sees who voices each character as text,
 *  - characters in natural order, "1 line" / "2 lines", "Original voice", "Your role",
 *  - a character name with a quote still finds its row on an in-place update,
 *  - no "LOBBY" badge and no second Leave room in the lobby,
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
    state_version: 1, room_id: "LOBBY1", host_id: hostId, status,
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
      tani: { id: "tani", name: "Tani", color: "#d97706", is_online: true },
      [me]: { id: me, name: "Mika", color: "#7c5cff", is_online: true },
    },
    role_assignments: { "Black Guy 2": [me], 'The "Boss"': ["tani"] },
    takes: {},
  };
}

const visible = (el) => !!el && !el.hidden;
const rows = (doc) => Array.from(doc.querySelectorAll("#casting-tbody tr[data-character]"));
const rowFor = (doc, char) => rows(doc).find((tr) => tr.dataset.character === char);
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

(async () => {
  // The lobby markup: no "LOBBY" badge and no second Leave room; the header's Leave stays.
  {
    const doc = new JSDOM(html).window.document;
    const lobby = doc.getElementById("view-lobby");
    check(!doc.getElementById("btn-leave-room-lobby"), "the lobby has no second Leave room button");
    check(!Array.from(lobby.querySelectorAll(".badge-studio")).some((b) => /lobby/i.test(b.textContent)), "the lobby has no LOBBY badge");
    check(!!doc.getElementById("btn-leave-room"), "the header's Leave stays");
  }

  // A guest in a room that hasn't started: the waiting line with the host's name.
  {
    const { doc, app } = await boot();
    app.roomState = room(app);
    app.showView("lobby");
    const waiting = doc.getElementById("lobby-waiting");
    check(visible(waiting) && waiting.textContent === "Waiting for Tani to start recording", "a guest waits for the host by name", waiting && waiting.textContent);
    check(!visible(doc.getElementById("btn-start-session")), "a guest has no Start recording");
    check(!visible(doc.getElementById("btn-back-to-booth")), "a guest in a waiting room has no Back to the booth");

    // The host's name isn't known yet: "the host".
    delete app.roomState.users.tani;
    app.renderLobbyState();
    check(waiting.textContent === "Waiting for the host to start recording", "without the host's name the line says 'the host'", waiting.textContent);
  }

  // A guest while recording is on: Back to the booth only moves them.
  {
    const { doc, app, sent, booth } = await boot();
    app.roomState = room(app, { status: "recording" });
    app.showView("lobby");
    const back = doc.getElementById("btn-back-to-booth");
    check(visible(back) && /Back to the booth/.test(back.textContent), "a guest sees Back to the booth while recording is on");
    check(!visible(doc.getElementById("btn-start-session")), "a guest has no Start recording while recording is on");
    check(!visible(doc.getElementById("lobby-waiting")), "no waiting line while recording is on");
    sent.length = 0;
    back.click();
    await tick(20);
    check(app.currentView === "booth" && booth.length === 1 && booth[0] === 2, "Back to the booth opens the guest's first line", app.currentView, booth);
    check(!sent.some((m) => m.type === "set_status"), "Back to the booth sends no set_status", sent);
  }

  // A guest who stepped back to the lobby during the premiere: Back to the premiere.
  {
    const { doc, app, sent } = await boot();
    let premieres = 0;
    app.setupScreeningView = () => { premieres += 1; };
    app.roomState = room(app, { status: "screening" });
    app.showView("lobby");
    const back = doc.getElementById("btn-back-to-premiere");
    check(visible(back) && /Back to the premiere/.test(back.textContent), "a guest sees Back to the premiere while the premiere is on");
    check(!visible(doc.getElementById("btn-back-to-booth")) && !visible(doc.getElementById("btn-start-session")),
      "and no Back to the booth or Start recording");
    check(!visible(doc.getElementById("lobby-waiting")) && doc.getElementById("lobby-waiting").textContent === "", "and no waiting line");
    sent.length = 0;
    back.click();
    await tick(20);
    check(app.currentView === "screening" && premieres === 1, "Back to the premiere opens the premiere", app.currentView);
    check(sent.some((m) => m.type === "set_user_status" && m.payload.location === "screening") && !sent.some((m) => m.type === "set_status"),
      "it says where the guest is and sends no set_status", sent);

    // Recording or lobby: no Back to the premiere; the host never gets it.
    app.roomState.status = "recording";
    app.renderLobbyState();
    check(!visible(back), "no Back to the premiere while recording");
    const host = await boot();
    host.app.roomState = room(host.app, { hostId: host.app.user.id, status: "screening" });
    host.app.showView("lobby");
    check(!visible(host.doc.getElementById("btn-back-to-premiere")), "the host gets no Back to the premiere");
  }

  // The host starts recording while the guest waits: the guest moves to the booth and
  // the lobby's waiting line doesn't stay behind.
  {
    const { doc, app } = await boot();
    app.roomState = room(app);
    app.showView("lobby");
    const waiting = doc.getElementById("lobby-waiting");
    check(visible(waiting), "the guest is waiting");
    const next = { ...room(app, { status: "recording" }), state_version: STATE_VERSION };
    app.socket.emit("status_changed", { type: "status_changed", payload: { status: "recording" }, state: next });
    await tick(20);
    check(app.currentView === "booth", "recording starting moves the guest to the booth", app.currentView);
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

  // The host: Start recording and the selects.
  {
    const { doc, app, sent } = await boot();
    app.roomState = room(app, { hostId: app.user.id });
    app.showView("lobby");
    check(visible(doc.getElementById("btn-start-session")), "the host sees Start recording");
    check(!visible(doc.getElementById("lobby-waiting")) && !visible(doc.getElementById("btn-back-to-booth")), "the host sees no waiting line or Back to the booth");
    check(doc.querySelectorAll("#casting-tbody select.cast-select").length === CHARACTERS.length, "the host gets a select for every character");
    const first = doc.querySelector("#casting-tbody select.cast-select");
    check(first.options[0].value === "" && first.options[0].textContent.trim() === "Original voice", "the empty choice reads Original voice", first.options[0].textContent);

    // The host's change is drawn at once and sent.
    const select = rowFor(doc, "alice").querySelector(".cast-select");
    select.value = "tani";
    select.dispatchEvent(new (doc.defaultView.Event)("change"));
    check(app.roomState.role_assignments.alice[0] === "tani", "the host's casting change is drawn at once");
    check(sent.some((m) => m.type === "assign_role" && m.payload.character === "alice"), "the host's casting change is sent");

    // Start recording still moves the room.
    sent.length = 0;
    doc.getElementById("btn-start-session").click();
    await tick(20);
    check(sent.some((m) => m.type === "set_status" && m.payload.status === "recording"), "the host's Start recording sends set_status");
  }

  // A guest: the actor column is text, not selects.
  {
    const { doc, app } = await boot();
    app.roomState = room(app);
    app.showView("lobby");
    check(doc.querySelectorAll("#casting-tbody select").length === 0, "a guest gets no casting selects");
    check(text(rowFor(doc, 'The "Boss"').querySelector(".cast-actor-name")) === "Tani", "a guest sees the actor's name");
    check(text(rowFor(doc, "Black Guy 2").querySelector(".cast-actor-name")) === "Mika (You)", "a guest sees their own role marked (You)");
    const unassigned = rowFor(doc, "alice");
    check(text(unassigned.querySelector(".cast-actor-name")) === "Original voice", "an uncast character reads Original voice");
    check(unassigned.querySelector(".actor-color-dot").title === "Original voice", "the uncast dot's tooltip reads Original voice");
    check(!/Unassigned/.test(doc.getElementById("casting-tbody").textContent), "no 'Unassigned' left in the casting table");

    // Natural order, plurals, "Your role".
    const order = rows(doc).map((tr) => tr.dataset.character);
    check(order.indexOf("Black Guy 2") < order.indexOf("Black Guy 10"), "Black Guy 2 sorts before Black Guy 10", order);
    check(order[0] === "alice", "the sort ignores case", order);
    check(text(rowFor(doc, "Black Guy 2").querySelector(".char-line-count")) === "1 line", "one line reads '1 line'");
    check(text(rowFor(doc, "Black Guy 10").querySelector(".char-line-count")) === "2 lines", "two lines read '2 lines'");
    check(text(rowFor(doc, "alice").querySelector(".char-line-count")) === "0 lines", "no lines read '0 lines'");
    check(doc.getElementById("lobby-line-count").textContent === "4 lines", "the scene's line count is plural");
    const badge = rowFor(doc, "Black Guy 2").querySelector(".your-role-badge");
    check(badge && badge.textContent === "Your role", "the role badge reads 'Your role'", badge && badge.textContent);

    // In-place update: the host recasts the character with a quote in its name.
    app.roomState.role_assignments['The "Boss"'] = [app.user.id];
    app.renderLobbyState();
    const boss = rowFor(doc, 'The "Boss"');
    check(text(boss.querySelector(".cast-actor-name")) === "Mika (You)", "a character name with a quote finds its row");
    check(boss.classList.contains("assigned-to-me") && boss.querySelector(".your-role-badge").textContent === "Your role", "the recast row gains 'Your role'");

    // The cast list marks the host with .tag-host and you with the You tag.
    const list = doc.getElementById("lobby-cast-list");
    check(list.querySelectorAll(".tag-host").length === 1 && /Host/.test(list.querySelector(".tag-host").textContent), "the host is marked with .tag-host");
    check(list.querySelectorAll(".user-you-tag").length === 1, "you are marked once");
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
