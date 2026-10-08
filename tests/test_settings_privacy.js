/**
 * test_settings_privacy.js
 *
 * First-test fix 3: a member on a host's page saw the host's export folder in
 * Settings. Folders belong to the engine's own computer, so off it the studio:
 *   - keeps the export folder row hidden, even if an old engine still reports it;
 *   - hides the Packs folder button and the empty-state "Choose folder" button;
 *   - never opens the packs folder dialog;
 *   - never shows Remove Pack Builder.
 * On the engine's own computer (127.0.0.1) they all still show.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, extra) {
  console.error("FAIL: " + message, extra === undefined ? "" : extra);
  process.exit(1);
}

function pass(message) {
  console.log("PASS: " + message);
}

// What an engine from before this fix answers to anyone.
const HOST_CONFIG = {
  status: "ok",
  packs_dir: "/home/host/DubMate/Packs",
  exports_dir: "/home/host/DubMate/exports",
  pack_count: 0,
  packs: [],
};

/** Boots the studio at `url` inside a desktop app with Pack Builder installed. */
async function boot(url, { packsFail = false } = {}) {
  const virtualConsole = new VirtualConsole();
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
    createDynamicsCompressor() {
      return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} };
    }
    createConvolver() { return { connect: () => {} }; }
  };
  w.scrollTo = () => {};
  const json = (body) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input) => {
    const u = String(input);
    if (u.startsWith("/api/config")) return json(HOST_CONFIG);
    if (u.startsWith("/api/packs/rescan")) return json({ status: "ok", count: 0, packs: [], scanned_paths: [] });
    if (u.startsWith("/api/packs")) return packsFail ? Promise.reject(new TypeError("Failed to fetch")) : json([]);
    return json([]);
  };
  // Pack Builder is installed: only the engine's own computer may offer to remove it.
  w.__TAURI__ = {
    core: {
      invoke: (cmd) => cmd === "get_packbuilder_status"
        ? Promise.resolve({ opted_in: true, installed: true, target_dir: "/opt/x", size_bytes: 1024 })
        : Promise.reject(`Command ${cmd} not allowed by ACL`),
    },
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", resolve));
  }
  w.eval(bundle);
  await settle(150);
  const app = w.dubMateApp;
  if (!app) fail(`the studio did not start at ${url}`);
  app.showToast = () => {};
  app.audioSetup.permission = "granted";
  app.refreshAudioDevices = async () => {};
  app.startInputMeter = async () => {};
  return { w, app };
}

const byId = (w, id) => w.document.getElementById(id);
const isShown = (w, id) => byId(w, id).style.display !== "none";

/** Checks every folder control; `local` says whether they should show. */
async function checkFolders(url, local) {
  const where = local ? "on the engine's computer" : `at ${url}`;
  const { w, app } = await boot(url);

  const grid = byId(w, "pack-grid").innerHTML;
  if (!grid.includes("No scene packs yet")) fail(`the empty pack list did not render ${where}`, grid);
  if (grid.includes("openPackConfigModal") !== local) fail(`Choose folder ${local ? "missing" : "showed"} ${where}`);
  if (isShown(w, "btn-open-pack-folder") !== local) fail(`the Packs folder button ${local ? "was hidden" : "showed"} ${where}`);

  await app.openAudioSettings();
  await settle();
  if (!isShown(w, "audio-setup-step-devices")) fail(`the settings step did not open ${where}`);
  if (isShown(w, "audio-exports-row") !== local) fail(`the export folder row ${local ? "was hidden" : "showed"} ${where}`);
  if (!local && byId(w, "audio-exports-row").textContent.includes("/home/host")) fail("the host's export folder reached the page");
  if (isShown(w, "packbuilder-row") !== local) fail(`Remove Pack Builder ${local ? "was hidden" : "showed"} ${where}`);
  app.closeAudioSettings();

  await app.openPackConfigModal();
  await settle();
  if (!byId(w, "modal-pack-config").hidden !== local) fail(`the packs folder dialog ${local ? "did not open" : "opened"} ${where}`);

  const dir = await app.fetchExportsDir();
  if (local ? dir !== HOST_CONFIG.exports_dir : dir !== null) fail(`fetchExportsDir gave ${dir} ${where}`);
}

(async () => {
  await checkFolders("https://abc.trycloudflare.com/", false);
  pass("a member on the host's tunnel sees none of the host's folders");

  await checkFolders("http://192.168.1.5:8000/", false);
  pass("a LAN member sees none of the host's folders");

  await checkFolders("http://127.0.0.1:8000/", true);
  pass("the engine's own computer still sees its folders");

  // The "Can't reach DubMate" card offers Packs folder only on the engine's computer.
  for (const [url, local] of [["https://abc.trycloudflare.com/", false], ["http://127.0.0.1:8000/", true]]) {
    const { w } = await boot(url, { packsFail: true });
    const grid = byId(w, "pack-grid").innerHTML;
    if (!grid.includes("Can't reach DubMate")) fail(`the error card did not render at ${url}`, grid);
    if (grid.includes("openPackConfigModal") !== local) fail(`the error card's Packs folder button was wrong at ${url}`);
  }
  pass("the error card offers Packs folder only on the engine's computer");

  process.exit(0);
})().catch((err) => fail("unexpected error", err && err.stack || err));
