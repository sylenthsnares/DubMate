/**
 * test_select_pack.js
 *
 * After a build, Pack Builder sends the user to the studio with ?select_pack=<id>.
 * The home screen must open with that pack selected (as if its card was clicked)
 * and scrolled into view, including a pack that only shows up after a rescan, and
 * ?select_pack= must then leave the address bar. initRouter used to call a
 * selectPack() method that did not exist, so the page threw instead.
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

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const pack = (id) => ({ id, name: id, lines: [], characters: [] });

/** Boots the studio at `url`; GET /api/packs answers `listed`, the rescan answers `rescanned`. */
async function boot(url, listed, rescanned = listed) {
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
  const scrolledTo = [];
  w.Element.prototype.scrollIntoView = function () { scrolledTo.push(this.dataset.packId); };

  const fetches = [];
  const json = (body) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input) => {
    const u = String(input || "");
    fetches.push(u);
    if (u.startsWith("/api/packs/rescan")) return json({ packs: rescanned });
    if (u.startsWith("/api/packs")) return json(listed);
    return json({});
  };

  // Evaluate once parsing is done so exactly one studio instance boots.
  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  return { w, app, fetches, scrolledTo };
}

function selectedCards(w) {
  return Array.from(w.document.querySelectorAll(".pack-card.selected")).map((c) => c.dataset.packId);
}

(async () => {
  // 1. A pack that is already listed is selected, scrolled to, and the param dropped.
  {
    const { w, app, fetches, scrolledTo } = await boot(
      "http://localhost:8000/?select_pack=Second&foo=1",
      [pack("First"), pack("Second")],
    );
    if (app.currentView !== "landing") fail(`expected the home screen, got ${app.currentView}`);
    if (app.selectedPackId !== "Second") fail(`selectedPackId is ${app.selectedPackId}`);
    const sel = selectedCards(w);
    if (sel.length !== 1 || sel[0] !== "Second") fail(`selected cards: ${JSON.stringify(sel)}`);
    if (!scrolledTo.includes("Second")) fail(`card not scrolled into view: ${JSON.stringify(scrolledTo)}`);
    if (fetches.some((u) => u.startsWith("/api/packs/rescan"))) fail("rescanned although the pack was listed");
    const params = new w.URLSearchParams(w.location.search);
    if (params.has("select_pack")) fail("?select_pack= left in the address bar");
    if (params.get("foo") !== "1") fail("other query params lost while dropping ?select_pack=");
    console.log("PASS: ?select_pack= selects and scrolls to a listed pack, then leaves the URL");
  }

  // 2. A freshly built pack missing from the first listing is found by one rescan.
  {
    const { w, app, fetches, scrolledTo } = await boot(
      "http://localhost:8000/?select_pack=Fresh_Pack",
      [pack("Old")],
      [pack("Old"), pack("Fresh_Pack")],
    );
    if (fetches.filter((u) => u.startsWith("/api/packs/rescan")).length !== 1) fail(`expected exactly one rescan: ${JSON.stringify(fetches)}`);
    if (app.selectedPackId !== "Fresh_Pack") fail(`selectedPackId is ${app.selectedPackId}`);
    const sel = selectedCards(w);
    if (sel.length !== 1 || sel[0] !== "Fresh_Pack") fail(`selected cards: ${JSON.stringify(sel)}`);
    if (!scrolledTo.includes("Fresh_Pack")) fail("fresh pack not scrolled into view");
    if (new w.URLSearchParams(w.location.search).has("select_pack")) fail("?select_pack= left in the URL");
    console.log("PASS: a freshly built pack is selected once the rescan lists it");
  }

  // 3. An unknown pack id chooses nothing and still cleans the URL.
  {
    const { w, app, scrolledTo } = await boot(
      "http://localhost:8000/?select_pack=Nope",
      [pack("First"), pack("Second")],
    );
    if (app.selectedPackId !== null || selectedCards(w).length) fail(`an unknown pack chose a scene: ${app.selectedPackId}`);
    if (scrolledTo.length) fail(`scrolled for an unknown pack: ${JSON.stringify(scrolledTo)}`);
    if (new w.URLSearchParams(w.location.search).has("select_pack")) fail("?select_pack= left in the URL");
    console.log("PASS: an unknown ?select_pack= chooses nothing (there is no default scene)");
  }

  console.log("ALL SELECT PACK TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
