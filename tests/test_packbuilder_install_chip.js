/**
 * test_packbuilder_install_chip.js
 *
 * U5b step 39b, the studio side: Pack Builder installs in the background while the
 * studio is open, and the header shows where it is.
 *   - only inside the desktop app on this computer's engine; a plain browser and a
 *     member on a host's page never see it, and an older desktop app that refuses
 *     get_packbuilder_install leaves it hidden;
 *   - running: a mini bar, "Pack Builder 42%" (not a live region: it changes every
 *     second) and a focusable tooltip with the step, the headline, the detail and
 *     the time left;
 *   - failed: "Pack Builder didn't install" with Try again, and a plain next step in
 *     the tooltip (the raw error goes to the log);
 *   - done: "Restart to finish Pack Builder", which asks first in a room, then
 *     restarts the engine and reopens the studio on its port;
 *   - the Pack Builder line in the mode menu follows the same state;
 *   - it polls every second while running and stops on done, failed or idle.
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

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const ORIGINAL_DESC = "Turn a video into a scene pack";

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
  const errors = [];
  // jsdom has no media playback; anything else reported here is a real error.
  virtualConsole.on("jsdomError", (e) => {
    const msg = String(e && e.message);
    if (!msg.startsWith("Not implemented")) errors.push(msg);
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

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", resolve));
  }
  // Navigation is replaced before the studio starts, so a restart is recorded, not followed.
  const navigations = [];
  w.eval(bundle);
  const app = w.dubMateApp;
  if (!app) fail(`the studio did not start at ${url}`);
  app.navigateTo = (target) => navigations.push(target);
  app.showToast = () => {};
  await settle(120);
  return { w, app, calls, navigations, errors };
}

const byId = (w, id) => w.document.getElementById(id);
const count = (calls, cmd) => calls.filter((c) => c.cmd === cmd).length;
const chip = (w) => byId(w, "packbuilder-install-chip");
const menuDesc = (w) => w.document.querySelector("#mode-opt-builder .mode-item-desc").textContent.trim();
/** Hidden by the hidden attribute on itself or an ancestor inside the chip. */
function shown(el) {
  for (let node = el; node; node = node.parentElement) {
    if (node.hidden) return false;
    if (node.id === "packbuilder-install-chip") break;
  }
  return true;
}

const RUNNING = {
  state: "running",
  progress: {
    phase: "downloading",
    headline: "Downloading the speech recognition engine",
    detail: "612 MB of ~2.0 GB",
    percent: 42.4,
    done_bytes: 612e6,
    total_bytes: 2e9,
    eta_secs: 360,
    raw: "Downloading torch-2.3.0.whl (612 MB)",
  },
  error: null,
};
const DONE = { state: "done", progress: null, error: null };
const FAILED = {
  state: "failed",
  progress: null,
  error: "pip couldn't reach the package index.\nTraceback (most recent call last):\n  ...",
};
const IDLE = { state: "idle", progress: null, error: null };
const FAILED_TIP = "Check your internet connection and free disk space, then press Try again.";

/** A fake desktop app whose install state the test moves along. */
function desktopApp(initial, extra = {}) {
  const box = { install: initial };
  const app = {
    get_packbuilder_install: () => box.install,
    get_engine_port: () => 8124,
    ...extra,
  };
  return { box, app };
}

(async () => {
  // 1. A plain browser: no chip, and nothing asks for a desktop app.
  {
    const { w, calls, errors } = await boot("http://127.0.0.1:8123/", null);
    if (!chip(w)) fail("#packbuilder-install-chip is missing from the header");
    if (shown(chip(w))) fail("the chip showed in a plain browser");
    if (calls.length) fail("a plain browser tried to reach the desktop app", calls);
    if (menuDesc(w) !== ORIGINAL_DESC) fail(`the menu line reads "${menuDesc(w)}" in a browser`);
    if (errors.length) fail("console errors", errors);
  }
  pass("39b a plain browser never sees the install chip");

  // 2. A member on a host's page, inside their own desktop app: hidden, nothing asked.
  {
    const { app } = desktopApp(RUNNING);
    const { w, calls } = await boot("https://abc.trycloudflare.com/", app);
    if (shown(chip(w))) fail("the chip showed on a host's page");
    if (count(calls, "get_packbuilder_install")) fail("a host's page asked for the install state", calls);
    if (menuDesc(w) !== ORIGINAL_DESC) fail(`the menu line reads "${menuDesc(w)}" on a host's page`);
  }
  pass("39b a member on a host's page never sees this computer's install");

  // 3. An older desktop app refuses the command: hidden, no retry loop.
  {
    const { w, calls } = await boot("http://127.0.0.1:8123/", { get_engine_port: () => 8124 });
    if (shown(chip(w))) fail("the chip showed when the command was refused");
    if (menuDesc(w) !== ORIGINAL_DESC) fail(`the menu line reads "${menuDesc(w)}" on an old app`);
    await settle(1200);
    if (count(calls, "get_packbuilder_install") !== 1) fail("a refused command was asked again", calls);
  }
  pass("39b an older desktop app that refuses the command keeps the chip hidden");

  // 4. Idle: hidden, and it stops asking.
  {
    const { app } = desktopApp(IDLE);
    const { w, calls } = await boot("http://127.0.0.1:8123/", app);
    if (shown(chip(w))) fail("the chip showed while idle");
    await settle(1200);
    if (count(calls, "get_packbuilder_install") !== 1) fail("idle kept polling", calls);
    if (menuDesc(w) !== ORIGINAL_DESC) fail(`the menu line reads "${menuDesc(w)}" while idle`);
  }
  pass("39b idle hides the chip and stops polling");

  // 4b. The launcher starts the install without waiting: a first answer can still be
  // idle. One more look a few seconds later catches it.
  {
    const { box, app } = desktopApp(IDLE);
    const { w, calls } = await boot("http://127.0.0.1:8123/", app);
    box.install = RUNNING;
    await settle(3200);
    if (!shown(chip(w))) fail("an install that began just after the first look was missed");
    box.install = IDLE;
    await settle(1100);
    const polls = count(calls, "get_packbuilder_install");
    await settle(3300);
    if (count(calls, "get_packbuilder_install") !== polls) fail("idle after an install kept polling", calls);
  }
  pass("39b a second look catches an install that began just after the studio opened");

  // 5. Running: bar, percent, status role, tooltip, menu line; then done, and polling stops.
  {
    const { box, app } = desktopApp(RUNNING);
    const { w, calls, errors } = await boot("http://127.0.0.1:8123/", app);
    const c = chip(w);
    if (!shown(c)) fail("the chip stayed hidden while installing");
    const running = byId(w, "packbuilder-install-running");
    if (!shown(running)) fail("the running state is hidden");
    if (shown(byId(w, "packbuilder-install-failed"))) fail("the failed state showed while running");
    if (shown(byId(w, "btn-packbuilder-restart"))) fail("the restart button showed while running");
    if (running.getAttribute("role") === "status" || running.hasAttribute("aria-live")) {
      fail("the running percent is a live region: a screen reader would read every percent");
    }
    if (running.getAttribute("tabindex") !== "0") fail("the running state's tooltip is not focusable");
    const text = running.textContent.replace(/\s+/g, " ").trim();
    if (text !== "Pack Builder 42%") fail(`the running text reads "${text}"`);
    const tip = running.getAttribute("data-tip");
    const wantTip = "Step 2 of 4: Download · Downloading the speech recognition engine · 612 MB of ~2.0 GB · about 6 min left";
    if (tip !== wantTip) fail(`the tooltip reads "${tip}"`);
    const fill = c.querySelector(".pb-install-fill");
    if (!fill || fill.style.width !== "42.4%") fail(`the bar fill is ${fill && fill.style.width}`);
    if (menuDesc(w) !== "Installing its tools · 42%") fail(`the menu line reads "${menuDesc(w)}"`);

    // Another step with no time left yet leaves the empty parts out.
    box.install = {
      state: "running",
      progress: { ...RUNNING.progress, phase: "installing", headline: "Installing", detail: "Almost there", percent: 88, eta_secs: null },
      error: null,
    };
    await settle(1100);
    const tip2 = running.getAttribute("data-tip");
    if (tip2 !== "Step 3 of 4: Install · Installing · Almost there") fail(`the install-step tooltip reads "${tip2}"`);
    if (menuDesc(w) !== "Installing its tools · 88%") fail(`the menu line reads "${menuDesc(w)}"`);

    box.install = DONE;
    await settle(1100);
    if (!shown(byId(w, "btn-packbuilder-restart"))) fail("done did not show Restart to finish");
    if (byId(w, "btn-packbuilder-restart").textContent.trim() !== "Restart to finish Pack Builder") {
      fail(`the restart button reads "${byId(w, "btn-packbuilder-restart").textContent.trim()}"`);
    }
    if (!byId(w, "btn-packbuilder-restart").classList.contains("btn-secondary")) fail("Restart to finish is not a secondary button");
    if (shown(running)) fail("the running state stayed after done");
    if (menuDesc(w) !== "Restart DubMate to finish installing") fail(`the menu line reads "${menuDesc(w)}" when done`);
    const polls = count(calls, "get_packbuilder_install");
    await settle(1300);
    if (count(calls, "get_packbuilder_install") !== polls) fail("polling went on after done");
    if (errors.length) fail("console errors", errors);
  }
  pass("39b running shows the bar, percent and step tooltip; done stops polling");

  // 6. Failed: plain line, error's first line in the tooltip, polling stops, Try again restarts it.
  {
    let starts = 0;
    const { box, app } = desktopApp(FAILED, {
      start_packbuilder_install: () => { starts += 1; box.install = RUNNING; },
    });
    const { w, calls } = await boot("http://127.0.0.1:8123/", app);
    const failed = byId(w, "packbuilder-install-failed");
    if (!shown(failed)) fail("the failed state is hidden");
    if (shown(byId(w, "packbuilder-install-running"))) fail("the running state showed after a failure");
    const label = failed.querySelector(".pb-install-label").textContent.trim();
    if (label !== "Pack Builder didn't install") fail(`the failed line reads "${label}"`);
    const tipEl = failed.querySelector("[data-tip]");
    if (!tipEl || tipEl.getAttribute("data-tip") !== FAILED_TIP) {
      fail(`the failed tooltip reads "${tipEl && tipEl.getAttribute("data-tip")}"`);
    }
    if (tipEl.getAttribute("tabindex") !== "0" && tipEl.tagName !== "BUTTON") fail("the failed tooltip is not focusable");
    if (menuDesc(w) !== "Its tools didn't install") fail(`the menu line reads "${menuDesc(w)}" when failed`);
    await settle(1200);
    if (count(calls, "get_packbuilder_install") !== 1) fail("polling went on after a failure", calls);

    const retry = byId(w, "btn-packbuilder-install-retry");
    if (retry.textContent.trim() !== "Try again") fail(`the retry button reads "${retry.textContent.trim()}"`);
    retry.click();
    await settle(80);
    if (starts !== 1) fail(`Try again started the install ${starts} times`);
    if (!shown(byId(w, "packbuilder-install-running"))) fail("Try again did not show the install running");
    const before = count(calls, "get_packbuilder_install");
    await settle(1100);
    if (count(calls, "get_packbuilder_install") <= before) fail("Try again did not resume polling");
  }
  pass("39b a failed install says so, and Try again starts it and polls again");

  // 7. A Try again the app refuses keeps the failed state with the new reason.
  {
    const { app } = desktopApp(FAILED, {
      start_packbuilder_install: () => { throw "DubMate can't write to its install folder."; },
    });
    const { w } = await boot("http://127.0.0.1:8123/", app);
    byId(w, "btn-packbuilder-install-retry").click();
    await settle(80);
    const failed = byId(w, "packbuilder-install-failed");
    if (!shown(failed)) fail("a refused Try again left the failed state");
    const tip = failed.querySelector("[data-tip]").getAttribute("data-tip");
    if (tip !== FAILED_TIP) fail(`the refused retry tooltip reads "${tip}"`);
  }
  pass("39b a refused Try again keeps the failed line and its plain next step");

  // 8. Done outside a room: restarts at once, then reopens on the engine's port.
  {
    const { app } = desktopApp(DONE, { trigger_start_sidecars: () => null });
    const { w, calls, navigations } = await boot("http://127.0.0.1:8123/", app);
    byId(w, "btn-packbuilder-restart").click();
    await settle(80);
    if (shown(byId(w, "packbuilder-restart-confirm"))) fail("the confirm showed outside a room");
    const order = calls.map((c) => c.cmd).filter((c) => c === "trigger_start_sidecars" || c === "get_engine_port");
    if (order.join(",") !== "trigger_start_sidecars,get_engine_port") fail("restart order", order);
    if (navigations.length !== 1 || navigations[0] !== "http://127.0.0.1:8124/") fail("did not reopen on the new port", navigations);
  }
  pass("39b Restart to finish outside a room restarts and reopens the studio");

  // 9. Done in a room: asks first; Cancel does nothing; Restart restarts.
  {
    const { app } = desktopApp(DONE, { trigger_start_sidecars: () => null });
    const { w, app: studio, calls, navigations } = await boot("http://127.0.0.1:8123/", app);
    studio.roomState = { id: "ROOM01", host_id: studio.user.id, status: "lobby", participants: {} };
    byId(w, "btn-packbuilder-restart").click();
    await settle();
    const confirm = byId(w, "packbuilder-restart-confirm");
    if (!shown(confirm)) fail("no confirm in a room");
    const confirmText = confirm.textContent.replace(/\s+/g, " ");
    if (!confirmText.includes("DubMate restarts, so anyone in your room is disconnected.")) fail(`the confirm reads "${confirmText}"`);
    if (count(calls, "trigger_start_sidecars")) fail("restarted before the confirm");
    if (w.document.activeElement !== byId(w, "btn-cancel-packbuilder-restart")) fail("focus did not move to Cancel");

    byId(w, "btn-cancel-packbuilder-restart").click();
    await settle();
    if (shown(confirm)) fail("Cancel left the confirm open");
    if (count(calls, "trigger_start_sidecars") || navigations.length) fail("Cancel restarted");

    byId(w, "btn-packbuilder-restart").click();
    byId(w, "btn-confirm-packbuilder-restart").click();
    await settle(80);
    const order = calls.map((c) => c.cmd).filter((c) => c === "trigger_start_sidecars" || c === "get_engine_port");
    if (order.join(",") !== "trigger_start_sidecars,get_engine_port") fail("restart order in a room", order);
    if (navigations[0] !== "http://127.0.0.1:8124/") fail("did not reopen on the new port", navigations);
  }
  pass("39b in a room, Restart to finish asks first, and Cancel keeps everyone connected");

  console.log("ALL 39b PACK BUILDER INSTALL CHIP TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
