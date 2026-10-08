/**
 * test_cast_hud.js
 *
 * The cast strip and the hidden live region (UI pass U1, step 6):
 *  - the strip is not a live region; one hidden #sr-announcer is,
 *  - at the premiere the progress and the ready summary show as before,
 *  - in the booth and the lobby the strip is hidden: the shared who's-here stack says who
 *    is here (the booth bar, and the lobby's title row since the 2.0 join flow),
 *  - several characters read "2 roles", with the names in a tooltip that opens on keyboard focus,
 *  - joins, leaves and "is ready" by others are read out once each; a repeated status is not.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
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
  app.socket.send = () => true;
  return { w, doc: w.document, app };
}

function room(app) {
  const me = app.user.id;
  return {
    state_version: 3, room_id: "CAST01", host_id: "tani", status: "recording",
    pack: {
      id: "P", name: "Rooftop", line_count: 3, characters: ["Deku", "Todoroki", "Bakugo"],
      lines: [
        { index: 0, line_id: "a", character: "Deku", start: 0, end: 1 },
        { index: 1, line_id: "b", character: "Todoroki", start: 1, end: 2 },
        { index: 2, line_id: "c", character: "Bakugo", start: 2, end: 3 },
      ],
    },
    users: {
      tani: { id: "tani", name: "Tani", color: "#d97706", is_online: true, is_ready: false, location: "booth", current_line: 0 },
      [me]: { id: me, name: "Mika", color: "#7c5cff", is_online: true, is_ready: false, location: "booth", current_line: 0 },
    },
    role_assignments: { Deku: ["tani"], Todoroki: ["tani"], Bakugo: [me] },
    takes: {},
  };
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const chipFor = (doc, name) => Array.from(doc.querySelectorAll(".actor-hud-chip"))
  .find((c) => text(c.querySelector(".actor-hud-name")).startsWith(name));
const hiddenEl = (el) => !el || el.hidden;

(async () => {
  // The markup: the strip keeps its region and label but is not live; one hidden live region.
  {
    const doc = new JSDOM(html).window.document;
    const bar = doc.getElementById("cast-activity-bar");
    check(!bar.hasAttribute("aria-live"), "the cast strip is not a live region");
    check(bar.getAttribute("role") === "region" && bar.getAttribute("aria-label") === "Cast", "the cast strip keeps its region and label");
    const sr = doc.getElementById("sr-announcer");
    check(sr && sr.classList.contains("sr-only") && sr.getAttribute("aria-live") === "polite", "#sr-announcer is a hidden polite live region");
    const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8");
    check(/\.sr-only\s*\{[^}]*clip:/.test(css), "style.css hides .sr-only");
  }

  // Lobby, booth and premiere, and the roles summary.
  {
    const { doc, app } = await boot();
    app.roomState = room(app);

    // The premiere keeps the strip with progress and ready counts (until the who's-here
    // stack replaces it there too).
    app.currentView = "screening";
    app.renderCastActivityHUD();
    const summary = doc.getElementById("premiere-status-summary");
    check(!hiddenEl(summary) && summary.textContent === "0/2 ready", "at the premiere the ready summary shows", summary.textContent);
    check(text(chipFor(doc, "Mika").querySelector(".actor-hud-progress")) === "0/1 (0%)", "at the premiere the progress shows as before");
    check(text(chipFor(doc, "Tani").querySelector(".actor-hud-status-badge")) === "Line 1", "at the premiere the location badge shows");

    // The booth hides the strip: its bar says who's here (2.0 layout pass).
    const bar = doc.getElementById("cast-activity-bar");
    app.showView("booth");
    check(bar.style.display === "none", "in the booth the cast strip is hidden", bar.style.display);

    // The lobby hides it too: its title row holds the same who's-here stack as the booth.
    app.showView("lobby");
    check(bar.style.display === "none", "in the lobby the cast strip is hidden", bar.style.display);
    const stack = doc.querySelector("#view-lobby .lobby-title-row #lobby-presence .presence-stack");
    check(stack && stack.querySelectorAll(".avatar").length === 2, "the lobby's title row shows the who's-here stack");
    check(/Who's here: Tani, Mika/.test(stack.getAttribute("aria-label") || ""), "the stack names who's here", stack && stack.getAttribute("aria-label"));
    stack.focus();
    app.renderCastActivityHUD();
    check(doc.activeElement === stack, "an update keeps keyboard focus on the lobby's stack");

    // Back at the premiere the strip shows each person's roles.
    app.showView("screening");
    check(bar.style.display === "flex", "at the premiere the cast strip shows", bar.style.display);
    const tani = chipFor(doc, "Tani");
    check(tani && tani.querySelector(".actor-hud-avatar") && tani.querySelector(".actor-hud-status-badge"), "the strip keeps names, colour and the location badge");

    // Two characters: "2 roles", names in a focusable tooltip.
    const roles = tani.querySelector(".actor-hud-char");
    check(text(roles) === "2 roles", "two characters read '2 roles'", text(roles));
    check(roles.getAttribute("data-tip") === "Deku, Todoroki", "the tooltip names both characters", roles.getAttribute("data-tip"));
    check(roles.tabIndex === 0, "the roles summary is reachable by keyboard");
    // One character still shows its name.
    const mine = chipFor(doc, "Mika").querySelector(".actor-hud-char");
    check(text(mine) === "Bakugo" && !mine.hasAttribute("tabindex"), "one character shows its name", text(mine));

    // An unchanged update leaves the strip alone, so a focused tooltip stays put.
    roles.focus();
    app.renderCastActivityHUD();
    check(doc.activeElement === roles, "an unchanged update keeps keyboard focus on the roles summary");

    // Back at the premiere the progress returns.
    app.currentView = "screening";
    app.renderCastActivityHUD();
    check(!hiddenEl(summary) && doc.querySelectorAll(".actor-hud-progress").length === 2, "back at the premiere the progress and ready summary return");
  }

  // Announcements: once each, others only, real changes only.
  {
    const { w, doc, app } = await boot();
    const said = [];
    const sr = doc.getElementById("sr-announcer");
    new w.MutationObserver(() => { if (sr.textContent) said.push(sr.textContent); })
      .observe(sr, { childList: true, characterData: true, subtree: true });

    const base = room(app);
    app.roomState = JSON.parse(JSON.stringify(base));
    app.showView("lobby");
    const emit = (type, payload, mutate) => {
      const state = JSON.parse(JSON.stringify(app.roomState));
      delete state.current_line;
      mutate(state);
      app.socket.emit(type, { type, payload, state });
      app.socket.emit("*", { type, payload, state });
    };

    // A new member: connects (not in the room yet), then joins.
    emit("user_connected", { user_id: "kai" }, () => {});
    emit("user_joined", { user_id: "kai" }, (s) => {
      s.users.kai = { id: "kai", name: "Kai", color: "#16a34a", is_online: true };
    });
    await tick(20);
    check(said.length === 1 && said[0] === "Kai joined", "a join is read once", said);

    // Kai leaves, then comes back: connect brings them online, the join that follows is quiet.
    emit("user_disconnected", { user_id: "kai" }, (s) => { s.users.kai.is_online = false; });
    await tick(20);
    check(said.length === 2 && said[1] === "Kai left", "a leave is read once", said);
    emit("user_connected", { user_id: "kai" }, (s) => { s.users.kai.is_online = true; });
    emit("user_joined", { user_id: "kai" }, () => {});
    await tick(20);
    check(said.length === 3 && said[2] === "Kai joined", "coming back is read once as a join", said);

    // Ready: once, and a repeated identical status says nothing.
    const ready = () => {
      const user = { ...app.roomState.users.tani, is_ready: true };
      emit("user_status_updated", { user_id: "tani", user }, (s) => { s.users.tani = user; });
    };
    ready();
    await tick(20);
    check(said.length === 4 && said[3] === "Tani is ready", "'is ready' is read once", said);
    ready();
    await tick(20);
    check(said.length === 4, "a repeated identical status is not read again", said);

    // Your own changes are not read out.
    const me = app.user.id;
    const meReady = { ...app.roomState.users[me], is_ready: true };
    emit("user_status_updated", { user_id: me, user: meReady }, (s) => { s.users[me] = meReady; });
    emit("user_disconnected", { user_id: me }, (s) => { s.users[me].is_online = false; });
    await tick(20);
    check(said.length === 4, "your own ready and leave are not read out", said);
  }

  console.log("\nAll cast strip checks passed.");
  process.exit(0);
})().catch((e) => fail("unexpected error", e));
