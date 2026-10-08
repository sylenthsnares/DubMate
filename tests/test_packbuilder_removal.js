/**
 * test_packbuilder_removal.js
 *
 * P40: "Remove Pack Builder" in the studio's settings.
 *   - shown only inside the desktop app (window.__TAURI__ on this computer's own
 *     engine) and only once Pack Builder is installed;
 *   - says how much space removing it frees;
 *   - asks first, and Cancel removes nothing;
 *   - a successful removal reopens the studio on the restarted engine;
 *   - a failed one says so in plain words and can be tried again.
 *
 * The desktop app is faked as a map of command name to handler. A command missing
 * from the map is refused the way Tauri refuses one its capabilities don't allow.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const GB = 1024 * 1024 * 1024;
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, extra) {
  console.error("FAIL: " + message, extra === undefined ? "" : extra);
  process.exit(1);
}

function pass(message) {
  console.log("PASS: " + message);
}

/** Boots the studio at `url`, inside a fake desktop app when `desktop` is given. */
async function boot(url, desktop) {
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
  w.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve([]),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });

  const calls = [];
  if (desktop) {
    w.__TAURI__ = {
      core: {
        invoke: (cmd, args) => {
          calls.push({ cmd, args });
          const handler = desktop[cmd];
          if (!handler) return Promise.reject(`Command ${cmd} not allowed by ACL`);
          return Promise.resolve().then(() => handler(args));
        },
      },
    };
  }

  // Evaluate once jsdom has finished loading. Dispatching DOMContentLoaded by hand
  // as well would build two studios on the same buttons.
  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", resolve));
  }
  w.eval(bundle);
  await settle(120);
  const app = w.dubMateApp;
  if (!app) fail(`the studio did not start at ${url}`);

  const navigations = [];
  app.navigateTo = (target) => navigations.push(target);
  app.showToast = () => {};
  // Open straight onto the devices step, where the settings rows live.
  app.audioSetup.permission = "granted";
  app.refreshAudioDevices = async () => {};
  app.startInputMeter = async () => {};
  return { w, app, calls, navigations };
}

const byId = (w, id) => w.document.getElementById(id);
const isShown = (w, id) => byId(w, id).style.display !== "none";

const installedApp = (sizeBytes, extra = {}) => ({
  get_packbuilder_status: () => ({
    opted_in: true,
    installed: true,
    target_dir: "/opt/DubMate/ai-packages",
    size_bytes: sizeBytes,
  }),
  get_engine_port: () => 8124,
  ...extra,
});

async function openSettings(app) {
  await app.openAudioSettings();
  await settle();
}

(async () => {
  // 1. A plain browser: no button, and nothing asks for a desktop app.
  {
    const { w, app, calls } = await boot("http://127.0.0.1:8123/", null);
    await openSettings(app);
    if (!isShown(w, "audio-setup-step-devices")) fail("the settings step did not open");
    if (isShown(w, "packbuilder-row")) fail("the button showed in a plain browser");
    if (calls.length) fail("a plain browser tried to reach the desktop app", calls);
  }
  pass("P40 a plain browser never sees Remove Pack Builder");

  // 2. Desktop app with Pack Builder installed: shown, with the space it frees.
  {
    const { w, app, calls } = await boot("http://127.0.0.1:8123/", installedApp(2.04 * GB));
    await openSettings(app);
    if (!isShown(w, "packbuilder-row")) fail("the button stayed hidden with Pack Builder installed");
    const statusCall = calls.find((c) => c.cmd === "get_packbuilder_status");
    if (!statusCall || !statusCall.args || statusCall.args.withSize !== true) {
      fail("the status was not asked for with its size", calls);
    }
    const noteEl = byId(w, "packbuilder-size-note");
    const note = noteEl.textContent;
    if (note !== "Removing it frees 2.0 GB.") fail(`the size note reads "${note}"`);
    if (!noteEl.classList.contains("status-text") || !noteEl.classList.contains("is-pending")) fail(`the size note is styled ${noteEl.className}`);
    if (isShown(w, "packbuilder-remove-confirm")) fail("the confirm step showed before any click");
    // Removing it can't be undone from the studio, so it is a danger button.
    const removeBtn = byId(w, "btn-remove-packbuilder");
    if (!removeBtn.classList.contains("btn-danger")) fail(`Remove Pack Builder is ${removeBtn.className}`);
  }
  pass("P40 the desktop app shows Remove Pack Builder, as a danger button, and the space it frees");

  // 3. Desktop app without Pack Builder: hidden.
  {
    const notInstalled = {
      get_packbuilder_status: () => ({ opted_in: false, installed: false, target_dir: "", size_bytes: null }),
    };
    const { w, app } = await boot("http://127.0.0.1:8123/", notInstalled);
    await openSettings(app);
    if (isShown(w, "packbuilder-row")) fail("the button showed while Pack Builder is not installed");
  }
  pass("P40 hidden when Pack Builder is not installed");

  // 4. Desktop app on a host's room page: hidden, and nothing is asked.
  {
    const { w, app, calls } = await boot("https://abc.trycloudflare.com/", installedApp(2 * GB));
    await openSettings(app);
    if (isShown(w, "packbuilder-row")) fail("the button showed on a host's page");
    if (calls.length) fail("a host's page tried to reach the desktop app", calls);
  }
  pass("P40 a host's room page never offers to remove this computer's Pack Builder");

  // 5. An older desktop app that refuses the status call: hidden.
  {
    const { w, app } = await boot("http://127.0.0.1:8123/", {});
    await openSettings(app);
    if (isShown(w, "packbuilder-row")) fail("the button showed when the status call was refused");
  }
  pass("P40 hidden when the desktop app can't report a status");

  // 6. Asks first; Cancel removes nothing; Remove removes and reopens the studio.
  {
    let removed = 0;
    const desktop = installedApp(2 * GB, { remove_packbuilder: () => { removed += 1; } });
    const { w, app, calls, navigations } = await boot("http://127.0.0.1:8123/", desktop);
    await openSettings(app);

    byId(w, "btn-remove-packbuilder").click();
    if (!isShown(w, "packbuilder-remove-confirm")) fail("Remove Pack Builder did not ask first");
    if (!/DubMate restarts/.test(byId(w, "packbuilder-remove-confirm").textContent)) {
      fail("the confirm step does not say DubMate restarts");
    }
    byId(w, "btn-cancel-remove-packbuilder").click();
    await settle();
    if (isShown(w, "packbuilder-remove-confirm")) fail("Cancel left the confirm step open");
    if (removed || calls.some((c) => c.cmd === "remove_packbuilder")) fail("Cancel removed Pack Builder");

    byId(w, "btn-remove-packbuilder").click();
    byId(w, "btn-confirm-remove-packbuilder").click();
    await settle();
    if (removed !== 1) fail(`remove_packbuilder ran ${removed} times`);
    if (navigations.length !== 1 || navigations[0] !== "http://127.0.0.1:8124/") {
      fail("the studio did not reopen on the restarted engine", navigations);
    }
  }
  pass("P40 removal asks first, then reopens the studio on the restarted engine");

  // 7. A failed removal says so plainly and can be tried again.
  {
    const desktop = installedApp(2 * GB, {
      remove_packbuilder: () => { throw "Could not remove /opt/DubMate/ai-packages: busy"; },
    });
    const { w, app, navigations } = await boot("http://127.0.0.1:8123/", desktop);
    await openSettings(app);
    byId(w, "btn-remove-packbuilder").click();
    byId(w, "btn-confirm-remove-packbuilder").click();
    await settle();
    if (navigations.length) fail("a failed removal reloaded the studio", navigations);
    if (!isShown(w, "packbuilder-remove-feedback")) fail("a failed removal showed no message");
    const feedback = byId(w, "packbuilder-remove-feedback").innerText;
    if (/ai-packages/.test(feedback)) fail(`the raw error reached the user: ${feedback}`);
    if (byId(w, "btn-remove-packbuilder").disabled) fail("the button stayed disabled after a failure");
  }
  pass("P40 a failed removal says so and can be tried again");

  console.log("ALL P40 PACK BUILDER REMOVAL TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
