/**
 * test_home_origin.js
 *
 * B2: a party member who joins a room hosted elsewhere is moved onto the host's
 * tunnel page, so the home screen there lists the host's packs. The member's own
 * engine (a loopback origin) must travel along as ?home= and every way back to
 * the home screen must navigate to it instead of rendering the host's packs.
 *
 * Navigation is observed through app.navigateTo(), which the suite replaces.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const HOME = "http://127.0.0.1:8123";
const KEY = "dubmate_home_origin";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Boots the studio at `url`; `remoteRooms` maps room code -> tunnel_url for the registry stub. */
async function boot(url, remoteRooms = {}) {
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
    const resolve = u.match(/\/rooms\/([^/]+)\/resolve$/);
    if (resolve) {
      const code = decodeURIComponent(resolve[1]);
      return remoteRooms[code] ? json(200, { tunnel_url: remoteRooms[code] }) : json(404, {});
    }
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

function fakeRoom(app) {
  return { room_id: "DUB-AB12", host_id: "host", pack: { id: "HostPack", lines: [], characters: [] }, takes: {}, users: {} };
}

(async () => {
  // 1. Arriving on a host's tunnel with ?home= remembers the member's own engine.
  {
    const tunnel = "https://abc.trycloudflare.com";
    const { w, app, fetches, navigations } = await boot(
      `${tunnel}/?room=DUB-AB12&home=${encodeURIComponent(HOME)}`,
      { "DUB-ZZ99": "https://h2.trycloudflare.com" },
    );
    if (w.sessionStorage.getItem(KEY) !== HOME) fail(`home origin not stored: ${w.sessionStorage.getItem(KEY)}`);
    const params = new w.URLSearchParams(w.location.search);
    if (params.has("home")) fail("?home= left in the address bar");
    if (params.get("room") !== "DUB-AB12") fail("?room= lost while dropping ?home=");
    console.log("PASS: B2 ?home= is stored for the tunnel origin and removed from the URL");

    const href = (id) => w.document.getElementById(id)?.getAttribute("href");
    if (href("mode-opt-studio") !== `${HOME}/`) fail(`Studio link not pointed home: ${href("mode-opt-studio")}`);
    if (href("mode-opt-builder") !== `${HOME}/builder.html`) fail(`Builder menu link: ${href("mode-opt-builder")}`);
    if (href("btn-open-builder") !== `${HOME}/builder.html`) fail(`Open builder button: ${href("btn-open-builder")}`);
    console.log("PASS: B2 Studio and Pack Builder links open the member's own engine");

    // Leaving the host's room goes home instead of listing the host's packs.
    app.roomState = fakeRoom(app);
    const before = fetches.length;
    app.leaveRoom();
    await tick(20);
    if (navigations.length !== 1 || navigations[0] !== `${HOME}/`) fail(`leaveRoom did not go home: ${JSON.stringify(navigations)}`);
    if (fetches.slice(before).some((u) => u.startsWith("/api/packs"))) fail("leaveRoom fetched the host's packs");
    if (app.currentView === "landing") fail("leaveRoom rendered the host's home screen");
    console.log("PASS: B2 leaving a host's room navigates to the member's own engine");

    // Hopping to another host's room keeps the original home.
    navigations.length = 0;
    await app.joinRoom("DUB-ZZ99");
    const hop = navigations[0] && new URL(navigations[0]);
    if (!hop || hop.origin !== "https://h2.trycloudflare.com" || hop.searchParams.get("room") !== "DUB-ZZ99"
        || hop.searchParams.get("home") !== HOME) fail(`hop lost the home origin: ${navigations[0]}`);
    console.log("PASS: B2 joining another host's room carries the original home along");

    // A room that is gone sends the member home, not to the host's home screen.
    navigations.length = 0;
    await app.joinRoom("GONE01");
    if (navigations[0] !== `${HOME}/`) fail(`missing room did not go home: ${JSON.stringify(navigations)}`);
    console.log("PASS: B2 a missing room on a host's page falls back to the member's own engine");

    // Declining the join prompt on a host's page goes home too.
    navigations.length = 0;
    w.history.replaceState({}, "", "/?room=DUB-AB12");
    app.closeJoinModal();
    if (navigations[0] !== `${HOME}/`) fail(`declining the join prompt stayed on the host: ${JSON.stringify(navigations)}`);
    console.log("PASS: B2 declining a host's join prompt returns to the member's own engine");
  }

  // 2. On the member's own engine, joining a remote room passes that engine along,
  //    and leaving a local room stays put.
  {
    const { app, navigations } = await boot(`${HOME}/`, { "DUB-ZZ99": "https://h.trycloudflare.com" });
    await app.joinRoom("DUB-ZZ99");
    const expected = `https://h.trycloudflare.com/?room=DUB-ZZ99&home=${encodeURIComponent(HOME)}`;
    if (navigations[0] !== expected) fail(`remote join URL: ${navigations[0]} (expected ${expected})`);
    console.log("PASS: B2 a remote join carries ?home= with the member's own engine");

    navigations.length = 0;
    app.roomState = fakeRoom(app);
    app.leaveRoom();
    if (navigations.length) fail(`leaving a local room navigated: ${JSON.stringify(navigations)}`);
    if (app.currentView !== "landing") fail("leaving a local room did not show the home screen");
    console.log("PASS: B2 leaving on the member's own engine keeps today's behaviour");
  }

  // 3. Anything other than a bare loopback http origin is ignored; with no home
  //    (a browser-only guest) leaving keeps today's behaviour.
  for (const bad of [null, "https://evil.test", `${HOME}/x?y`, "javascript:alert(1)", "http://user:pw@127.0.0.1:8123", "http://10.0.0.5:8000"]) {
    const q = bad === null ? "" : `&home=${encodeURIComponent(bad)}`;
    const { w, app, navigations } = await boot(`https://abc.trycloudflare.com/?room=DUB-AB12${q}`);
    if (w.sessionStorage.getItem(KEY) !== null) fail(`accepted home=${bad}`);
    if (new w.URLSearchParams(w.location.search).has("home")) fail(`left home=${bad} in the URL`);
    if (w.document.getElementById("mode-opt-studio").getAttribute("href") !== "/") fail(`rewrote links for home=${bad}`);
    app.roomState = fakeRoom(app);
    app.leaveRoom();
    if (navigations.length) fail(`navigated for home=${bad}: ${JSON.stringify(navigations)}`);
    if (app.currentView !== "landing") fail(`no home screen for home=${bad}`);
  }
  console.log("PASS: B2 invalid or missing ?home= values are ignored");

  console.log("ALL B2 HOME ORIGIN TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
