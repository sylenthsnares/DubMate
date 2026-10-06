/**
 * test_left_room.js
 *
 * P22: a guest who joined from a plain browser link (no ?home=, page on the
 * host's tunnel) has no DubMate of their own to go back to. Leaving the room
 * shows a small "You left the room" view with a room-code box, never the host's
 * home screen and pack library. Hosts still land on the home screen as before.
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

async function boot(url) {
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
  w.confirm = () => true;

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
    if (u.startsWith("/api/rooms/")) return json(404, { detail: "Room not found" });
    if (u.startsWith("/api/packs")) return json(200, [{ id: "HostPack", name: "Host Pack", lines: [], characters: [] }]);
    return json(200, {});
  };

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  const navigations = [];
  app.navigateTo = (target) => navigations.push(target);
  app.showToast = () => {};
  return { w, app, fetches, navigations };
}

function fakeRoom(hostId) {
  return { room_id: "DUB-AB12", host_id: hostId, pack: { id: "HostPack", lines: [], characters: [] }, takes: {}, users: {} };
}

const isActive = (w, id) => w.document.getElementById(id).classList.contains("active");

(async () => {
  // 1. A browser guest on the host's tunnel leaves and sees the "You left" view.
  {
    const { w, app, fetches, navigations } = await boot("https://abc.trycloudflare.com/");
    app.roomState = fakeRoom("someone-else");
    const before = fetches.length;
    app.btnLeaveRoom.click();
    await tick(20);
    if (navigations.length) fail(`guest leave navigated: ${JSON.stringify(navigations)}`);
    if (app.currentView !== "left" || !isActive(w, "view-left")) fail(`guest did not see the left view (${app.currentView})`);
    if (isActive(w, "view-landing")) fail("guest still sees the host's home screen");
    if (fetches.slice(before).some((u) => u.startsWith("/api/packs"))) fail("guest leave fetched the host's packs");
    const view = w.document.getElementById("view-left");
    if (!/You left the room/.test(view.textContent)) fail("left view is missing its heading");
    console.log("PASS: P22 a browser guest who leaves sees the 'You left the room' view");

    // Its Join button reuses the normal join flow (the name prompt).
    w.document.getElementById("input-left-room-code").value = "dub-zz9";
    w.document.getElementById("btn-left-join-room").click();
    if (app.pendingJoinRoomId !== "DUB-ZZ9") fail(`left-view Join did not start a join: ${app.pendingJoinRoomId}`);
    if (w.document.getElementById("modal-join-room").style.display !== "flex") fail("join prompt did not open");
    console.log("PASS: P22 the left view's Join button opens the normal join prompt");

    // A failed rejoin stays on the left view instead of the host's home screen.
    await app.joinRoom("GONE01");
    if (app.currentView !== "left" || isActive(w, "view-landing")) fail(`failed rejoin showed ${app.currentView}`);
    console.log("PASS: P22 a failed rejoin keeps the guest on the left view");
  }

  // 2. A host leaves and sees the home screen as before (own engine, and a LAN address).
  for (const origin of ["http://127.0.0.1:8123", "http://192.168.1.20:8000"]) {
    const { w, app, navigations } = await boot(`${origin}/`);
    app.roomState = fakeRoom(app.user.id);
    app.btnLeaveRoom.click();
    await tick(20);
    if (navigations.length) fail(`host leave navigated at ${origin}: ${JSON.stringify(navigations)}`);
    if (app.currentView !== "landing" || !isActive(w, "view-landing")) fail(`host at ${origin} saw ${app.currentView}`);
    if (isActive(w, "view-left")) fail(`host at ${origin} saw the left view`);
  }
  console.log("PASS: P22 a host who leaves sees the home screen as before");

  console.log("ALL P22 LEFT ROOM TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
