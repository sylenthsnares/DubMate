/**
 * test_version_check.js
 *
 * P21: a member who reaches a host's room from their own DubMate (?home=) sees a
 * note in the join prompt when the two engines' major.minor versions differ,
 * saying which side should update. Browser-only guests are not checked, and the
 * check never blocks joining.
 *
 * Both engines' /health responses are stubbed through window.fetch.
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
const TUNNEL = "https://abc.trycloudflare.com";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/**
 * Boots the studio at `url`. `hostVersion` / `homeVersion` are what each engine's
 * /health reports; a value of Error makes that request fail.
 */
async function boot(url, { hostVersion, homeVersion }) {
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
  const health = (version) => (version === Error
    ? Promise.reject(new TypeError("Failed to fetch"))
    : json(200, { status: "ok", version }));
  w.fetch = (input) => {
    const u = String(input || "");
    fetches.push(u);
    if (u === "/health") return health(hostVersion);
    if (u === `${HOME}/health`) return health(homeVersion);
    if (u.startsWith("/api/packs")) return json(200, []);
    return json(200, {});
  };

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  const note = w.document.getElementById("join-modal-version-note");
  if (!note) fail("join prompt has no version note element");
  const modal = w.document.getElementById("modal-join-room");
  return { w, app, fetches, note, modal };
}

const memberUrl = `${TUNNEL}/?room=DUB-AB12&home=${encodeURIComponent(HOME)}`;

(async () => {
  // 1. Member older than the host: the member is told to update.
  {
    const { note, modal } = await boot(memberUrl, { hostVersion: "1.2.0", homeVersion: "1.1.3" });
    if (modal.style.display !== "flex") fail("join prompt not shown");
    if (note.hidden) fail("no note for an older member");
    if (!/host has DubMate 1\.2\.0 and you have 1\.1\.3/.test(note.textContent)) fail(`versions missing: ${note.textContent}`);
    if (!/Update yours/.test(note.textContent)) fail(`older member not told to update: ${note.textContent}`);
    console.log("PASS: P21 an older member is told to update");
  }

  // 2. Host older than the member: the member is told to ask the host.
  {
    const { note } = await boot(memberUrl, { hostVersion: "1.1.9", homeVersion: "2.0.0" });
    if (note.hidden) fail("no note for an older host");
    if (!/Ask the host to update/.test(note.textContent)) fail(`older host not named: ${note.textContent}`);
    console.log("PASS: P21 an older host is named as the side to update");
  }

  // 3. Same major.minor (patch differs): no note.
  {
    const { note, fetches } = await boot(memberUrl, { hostVersion: "1.1.0", homeVersion: "1.1.7" });
    if (!fetches.includes(`${HOME}/health`)) fail("member's own engine was not asked for its version");
    if (!note.hidden || note.textContent) fail(`note shown for a patch difference: ${note.textContent}`);
    console.log("PASS: P21 a patch-level difference shows nothing");
  }

  // 4. The member's engine can't be reached: no note, and joining still works.
  {
    const { app, note, modal } = await boot(memberUrl, { hostVersion: "1.2.0", homeVersion: Error });
    if (!note.hidden) fail("note shown when the member's version is unknown");
    let joined = null;
    app.joinRoom = (code) => { joined = code; };
    app.confirmJoinModal();
    if (joined !== "DUB-AB12") fail(`joining was blocked: ${joined}`);
    if (modal.style.display !== "none") fail("join prompt stayed open");
    console.log("PASS: P21 an unreachable engine skips the check and never blocks joining");
  }

  // 5. Browser-only guest (no ?home=): no check at all.
  {
    const { note, fetches } = await boot(`${TUNNEL}/?room=DUB-AB12`, { hostVersion: "1.2.0", homeVersion: "1.0.0" });
    if (fetches.some((u) => u.endsWith("/health"))) fail(`guest was checked: ${fetches.filter((u) => u.endsWith("/health"))}`);
    if (!note.hidden) fail("note shown to a browser-only guest");
    console.log("PASS: P21 browser-only guests are not checked");
  }

  // 6. Joining a room on the member's own engine: nothing to compare.
  {
    const { app, note, fetches } = await boot(`${HOME}/`, { hostVersion: "1.2.0", homeVersion: "1.0.0" });
    app.promptJoinRoom("DUB-AB12");
    await tick(20);
    if (fetches.some((u) => u.endsWith("/health"))) fail("own-engine join was checked");
    if (!note.hidden) fail("note shown on the member's own engine");
    console.log("PASS: P21 joining on the member's own engine is not checked");
  }

  console.log("ALL P21 VERSION CHECK TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
