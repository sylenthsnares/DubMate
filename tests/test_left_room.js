/**
 * test_left_room.js
 *
 * P22 / 2.0 join flow G2 (U4 35a): a guest who joined from a plain browser link (no
 * ?home=, page on the host's tunnel) has no DubMate of their own to go back to.
 *  - Leaving asks first in an in-app dialog (Escape and Stay keep you in, focus returns).
 *  - Then "You left <scene>", "The room is still open. Your takes stay in it.", the amber
 *    "Rejoin CODE" (one click, the saved name and colour, errors inline, focus on it) and
 *    "Join a different room" with the field prefilled with the code. Never the host's
 *    home screen and pack library.
 *  - The address becomes /?left=CODE (a reload shows the same view, Back doesn't reopen
 *    the room), and the header hides Audio, ? and the logo menu there.
 * Hosts still land on the home screen as before.
 *
 * Also: Copy invite in a continued session (code not published again) copies the
 * direct link with "Invite link copied."
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

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function boot(url, { rooms = {} } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
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
  w.confirm = (m) => fail(`window.confirm was used: ${m}`);
  w.WebSocket = class { constructor(u) { this.url = u; this.readyState = 0; } send() {} close() {} };

  const fetches = [];
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input) => {
    const u = String(input || "");
    fetches.push(u);
    if (/\/rooms\/[^/]+\/resolve$/.test(u)) return json(404, {});
    const room = u.match(/^\/api\/rooms\/([^/]+)$/);
    if (room && rooms[decodeURIComponent(room[1])]) return json(200, rooms[decodeURIComponent(room[1])]);
    if (u.startsWith("/api/rooms/")) return json(404, { detail: "Room not found" });
    if (u.startsWith("/api/packs")) return json(200, [{ id: "HostPack", name: "Host Pack", lines: [], characters: [] }]);
    return json(200, {});
  };

  // JSDOM fires DOMContentLoaded itself; a second, manual one would boot a second app.
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  const navigations = [];
  app.navigateTo = (target) => navigations.push(target);
  app.showToast = () => {};
  return { w, app, fetches, navigations };
}

function fakeRoom(hostId) {
  return {
    state_version: 3, room_id: "DUB-AB12", host_id: hostId, status: "lobby",
    pack: { id: "HostPack", name: "Host Pack", lines: [], characters: [] },
    takes: {}, users: {}, role_assignments: {},
  };
}

const isActive = (w, id) => w.document.getElementById(id).classList.contains("active");
const visible = (el) => !!el && !el.hidden && !el.closest("[hidden]") && el.style.display !== "none";
const key = (w, k) => w.document.activeElement.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

/** Clicks Leave and answers the in-app question. */
async function leave(w, app) {
  app.btnLeaveRoom.click();
  await tick(10);
  const dialog = w.document.getElementById("modal-leave-room");
  if (!dialog || dialog.hidden) fail("Leave did not ask first");
  w.document.getElementById("btn-leave-room-confirm").click();
  await tick(20);
}

(async () => {
  // 0. Leaving asks in the app; Escape and Stay keep you in the room.
  {
    const { w, app } = await boot("https://abc.trycloudflare.com/?room=DUB-AB12");
    app.roomState = fakeRoom("someone-else");
    app.btnLeaveRoom.style.display = "inline-flex";
    app.btnLeaveRoom.focus();
    app.btnLeaveRoom.click();
    await tick(10);
    const dialog = w.document.getElementById("modal-leave-room");
    if (!dialog || dialog.hidden || !dialog.classList.contains("is-open")) fail("no in-app leave dialog");
    if (!/Leave the room\?/.test(dialog.textContent)) fail(`dialog text: ${dialog.textContent}`);
    key(w, "Escape");
    await tick(10);
    if (!dialog.hidden || !app.roomState || app.currentView === "left") fail("Escape left the room");
    if (w.document.activeElement !== app.btnLeaveRoom) fail(`focus did not return to Leave: ${w.document.activeElement.id}`);
    app.btnLeaveRoom.click();
    await tick(10);
    w.document.getElementById("btn-leave-room-cancel").click();
    await tick(10);
    if (!app.roomState || !dialog.hidden) fail("Stay left the room");
    console.log("PASS: Leave asks in an in-app dialog; Escape and Stay keep you in the room");
  }

  // 1. A browser guest on the host's tunnel leaves and sees the "You left" view.
  {
    const { w, app, fetches, navigations } = await boot("https://abc.trycloudflare.com/?room=DUB-AB12");
    app.roomState = fakeRoom("someone-else");
    const before = fetches.length;
    await leave(w, app);
    const $ = (id) => w.document.getElementById(id);
    if (navigations.length) fail(`guest leave navigated: ${JSON.stringify(navigations)}`);
    if (app.currentView !== "left" || !isActive(w, "view-left")) fail(`guest did not see the left view (${app.currentView})`);
    if (isActive(w, "view-landing")) fail("guest still sees the host's home screen");
    if (fetches.slice(before).some((u) => u.startsWith("/api/packs"))) fail("guest leave fetched the host's packs");
    if ($("left-title").textContent !== "You left Host Pack") fail(`left heading: ${$("left-title").textContent}`);
    if (!/The room is still open\. Your takes stay in it\./.test($("view-left").textContent)) fail("left view does not say the room is open");
    const rejoin = $("btn-rejoin-room");
    if (!rejoin.classList.contains("btn-primary") || rejoin.textContent.trim() !== "Rejoin DUB-AB12") fail(`rejoin button: ${rejoin.textContent}`);
    if (w.document.activeElement !== rejoin) fail("focus is not on Rejoin");
    if (w.location.search !== "?left=DUB-AB12") fail(`address not /?left=: ${w.location.href}`);
    if ($("input-left-room-code").value !== "DUB-AB12") fail("the code field is not prefilled");
    if (!w.document.body.classList.contains("no-home-chrome")) fail("the header still offers Audio, ? and the logo menu");
    if (!$("logo-dropdown-container").hasAttribute("inert")) fail("the logo menu still works");
    if (w.document.querySelectorAll("#view-left .btn-primary").length !== 1) fail("the left view has more than one amber");
    console.log("PASS: P22 a browser guest who leaves sees 'You left <scene>' with Rejoin, at /?left=CODE");

    // Rejoin when the room has closed meanwhile: inline, no card.
    rejoin.click();
    await tick(60);
    const err = $("btn-rejoin-room-error");
    if (app.currentView !== "left" || !visible(err) || !/isn't open/.test(err.textContent)) fail(`failed rejoin: ${app.currentView} ${err && err.textContent}`);
    if (isActive(w, "view-join")) fail("rejoin showed the join card");
    console.log("PASS: P22 a failed rejoin stays on the left view with an inline error");

    // The other field: a wrong code stays inline too, with its text.
    $("input-left-room-code").value = "dub-zz9";
    $("form-left-join").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await tick(60);
    const err2 = $("input-left-room-code-error");
    if (app.currentView !== "left" || !visible(err2) || !/No room DUB-ZZ9/.test(err2.textContent)) fail(`left form error: ${err2 && err2.textContent}`);
    if ($("input-left-room-code").value !== "dub-zz9") fail("the typed code was lost");
    console.log("PASS: P22 Join a different room shows its errors inline and keeps the text");

    // A failed joinRoom from elsewhere stays on the left view instead of the host's home screen.
    await app.joinRoom("GONE01");
    if (app.currentView !== "left" || isActive(w, "view-landing")) fail(`failed rejoin showed ${app.currentView}`);
    console.log("PASS: P22 a failed join keeps the guest on the left view");
  }

  // 1b. Rejoin goes back in with one click when the room is open.
  {
    const room = fakeRoom("someone-else");
    const { w, app } = await boot("https://abc.trycloudflare.com/?room=DUB-AB12", { rooms: { "DUB-AB12": room } });
    await tick(60);
    app.roomState = room;
    await leave(w, app);
    w.document.getElementById("btn-rejoin-room").click();
    await tick(80);
    if (app.currentView !== "lobby") fail(`rejoin did not go back in: ${app.currentView}`);
    console.log("PASS: Rejoin goes straight back in with one click");
  }

  // 1c. A reload on /?left=CODE shows the left view again, and says when the room closed.
  {
    const { w, app } = await boot("https://abc.trycloudflare.com/?left=DUB-AB12", { rooms: { "DUB-AB12": fakeRoom("someone-else") } });
    await tick(40);
    if (app.currentView !== "left" || w.document.getElementById("left-title").textContent !== "You left Host Pack") fail(`reload on ?left=: ${app.currentView}`);
    const closed = await boot("https://abc.trycloudflare.com/?left=GONE01");
    await tick(40);
    if (closed.app.currentView !== "left" || !/has closed/.test(closed.w.document.getElementById("view-left").textContent)) fail("a closed room's left view does not say so");
    if (visible(closed.w.document.getElementById("btn-rejoin-room"))) fail("Rejoin offered for a closed room");
    console.log("PASS: a reload on /?left=CODE shows the left view, and says when the room has closed");
  }

  // 2. A host leaves and sees the home screen as before (own engine, and a LAN address).
  for (const origin of ["http://127.0.0.1:8123", "http://192.168.1.20:8000"]) {
    const { w, app, navigations } = await boot(`${origin}/`);
    app.roomState = fakeRoom(app.user.id);
    await leave(w, app);
    if (navigations.length) fail(`host leave navigated at ${origin}: ${JSON.stringify(navigations)}`);
    if (app.currentView !== "landing" || !isActive(w, "view-landing")) fail(`host at ${origin} saw ${app.currentView}`);
    if (isActive(w, "view-left")) fail(`host at ${origin} saw the left view`);
  }
  console.log("PASS: P22 a host who leaves sees the home screen as before");

  // 3. Copy invite in a continued session copies the direct link.
  {
    const { w, app } = await boot("http://127.0.0.1:8123/");
    app.roomState = fakeRoom(app.user.id);
    const direct = "https://abc.trycloudflare.com?room=DUB-AB12";
    let share = { room_id: "DUB-AB12", code_is_live: false, join_url: "", direct_url: direct,
      state: "not_published", message: "Room codes stop working when DubMate closes. Copy invite gives a link that works now." };
    w.fetch = (input) => Promise.resolve({ ok: /\/share$/.test(String(input)), status: 200, json: () => Promise.resolve(share) });
    let copied = null;
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { copied = t; } } });
    const toasts = [];
    app.showToast = (msg) => toasts.push(msg);
    await app.copyRoomLink();
    if (copied !== direct) fail(`not_published copied ${copied}`);
    if (toasts[toasts.length - 1] !== "Invite link copied.") fail(`not_published toast: ${toasts[toasts.length - 1]}`);
    if (!String(app.headerRoomBadge?.dataset.tip || "").startsWith(share.message)) fail("badge tooltip does not explain the code");

    share = { ...share, state: "waiting", message: "Getting your room code ready." };
    await app.copyRoomLink();
    if (copied !== direct || toasts[toasts.length - 1] !== "Invite link copied.") {
      fail(`waiting: copied ${copied}, toast ${toasts[toasts.length - 1]}`);
    }

    // Copy invite link is always a link: the public one once the code works...
    share = { ...share, code_is_live: true, state: "registered", join_url: "https://dubmate.bkaproductions.com/join/DUB-AB12" };
    await app.copyRoomLink();
    if (copied !== share.join_url || toasts[toasts.length - 1] !== "Invite link copied.") fail(`live code copied ${copied}`);
    if (app.headerRoomBadge.dataset.tip !== "Copy invite link") fail(`live badge tooltip: ${app.headerRoomBadge.dataset.tip}`);
    // ...and this page's link, for this network only, when there is no other.
    share = { ...share, code_is_live: false, join_url: "", direct_url: "", state: "tunnel_unavailable" };
    await app.copyRoomLink();
    if (copied !== "http://127.0.0.1:8123/?room=DUB-AB12") fail(`no tunnel copied ${copied}`);
    if (toasts[toasts.length - 1] !== "Invite link copied. It works on your network only for now.") fail(`no tunnel toast: ${toasts[toasts.length - 1]}`);

    // In the lobby the pill only shows the code (the title row copies); elsewhere it copies.
    const badge = app.headerRoomBadge;
    app.showView("lobby");
    if (!badge.classList.contains("is-code-only") || badge.hasAttribute("role") || badge.hasAttribute("tabindex") || badge.dataset.tip) {
      fail("the lobby's room pill is still a control");
    }
    copied = null;
    badge.click();
    await tick(10);
    if (copied !== null) fail("the lobby's room pill copied");
    app.showView("booth");
    if (badge.classList.contains("is-code-only") || badge.getAttribute("role") !== "button" || badge.getAttribute("aria-label") !== "Copy invite link") {
      fail("the booth's room pill is not the copy control");
    }
    badge.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(10);
    if (copied !== "http://127.0.0.1:8123/?room=DUB-AB12") fail(`Enter on the pill copied ${copied}`);
  }
  console.log("PASS: Copy invite link always copies a link; the lobby's room pill only shows the code");

  console.log("ALL P22 LEFT ROOM TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
