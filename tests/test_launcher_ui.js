/**
 * test_launcher_ui.js
 * JSDOM coverage for the desktop launcher (tauri/src): the splash, the error card and
 * the update card (UI pass U5b, steps 39a and 39b).
 *
 * The launcher only says what Rust knows. The text comes from `startup-progress`;
 * a slow start stays on the neutral splash with the time it has been waiting; the
 * red card is for real failures from Rust (or no answer at all for 3 minutes); and
 * Pack Builder installs in the background while the studio opens.
 *
 * `window.__TAURI__` is a stub that records `invoke` calls and lets the test fire
 * events. Time is a fake clock, so the 8 s, 25 s and 3 minute marks are exact.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC_DIR = path.join(__dirname, "..", "tauri", "src");
const html = fs.readFileSync(path.join(SRC_DIR, "index.html"), "utf8");
const launcherJs = fs.readFileSync(path.join(SRC_DIR, "launcher.js"), "utf8");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`         PASS: ${label}`);
    passed += 1;
  } else {
    console.log(`         FAIL: ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
    failed += 1;
  }
}

/** Lets promises inside the page settle. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

/** A fake clock for the page: setTimeout, setInterval and Date.now. */
function installClock(window) {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map();
  window.Date.now = () => now;
  window.setTimeout = (fn, ms = 0) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + Math.max(0, ms), every: null });
    return id;
  };
  window.setInterval = (fn, ms = 0) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + Math.max(1, ms), every: Math.max(1, ms) });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);
  return {
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

/**
 * Boots the launcher. `health` says whether the engine answers /health; `handlers`
 * replaces what an `invoke` command returns.
 */
async function boot({ tauri = true, health = false, handlers = {}, clipboard = null } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const { window } = dom;
  const clock = installClock(window);
  const state = { health };
  window.fetch = () => Promise.resolve({ ok: !!state.health });
  if (clipboard) {
    Object.defineProperty(window.navigator, "clipboard", { value: clipboard, configurable: true });
  }

  const calls = [];
  const listeners = {};
  const defaults = {
    get_engine_port: 8123,
    get_packbuilder_status: { opted_in: false, installed: false, writable: true },
  };
  if (tauri) {
    window.__TAURI__ = {
      core: {
        invoke: (cmd, args) => {
          calls.push({ cmd, args });
          if (handlers[cmd]) return Promise.resolve().then(() => handlers[cmd](args));
          return Promise.resolve(defaults[cmd] ?? null);
        },
      },
      event: {
        listen: (name, cb) => {
          (listeners[name] = listeners[name] || []).push(cb);
          return Promise.resolve(() => {});
        },
      },
    };
  }
  const opened = [];
  window.open = (url) => opened.push(url);

  window.eval(launcherJs);
  const entered = [];
  window.navigate = (url) => entered.push(url);
  await flush();

  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  return {
    window, doc, $, clock, calls, entered, opened, state,
    invoked: (cmd) => calls.filter((c) => c.cmd === cmd),
    async emit(name, payload) {
      for (const cb of listeners[name] || []) cb({ payload });
      await flush();
    },
    visible: (id) => !$(id).hidden,
    text: (id) => $(id).textContent.trim(),
    async click(id) {
      $(id).click();
      await flush();
    },
    close: () => window.close(),
  };
}

const MOVING_DETAIL = "This happens once and can take a few minutes";
const NOT_MOVED = "Your files stayed in their old folder and still work";

const UPDATE = {
  current_version: "1.1.3",
  latest_version: "1.2.0",
  changelog: "## What's new\n\n- **Audio settings**: louder sync clicks",
  download_url: "https://github.com/sylenthsnares/DubMate/releases/download/v1.2.0/bundle.zip",
  first_download: false,
};

/** An apply_update the test settles by hand. */
function deferredUpdate() {
  const d = {};
  d.handler = () => new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

(async () => {
  console.log("\n  [+] Launcher: the splash only says what Rust knows");
  {
    const t = await boot();
    const status = t.$("status-text");
    check("the status line is a polite live region",
      status.getAttribute("role") === "status" && status.getAttribute("aria-live") === "polite");
    const initial = t.text("status-text");
    await t.clock.advance(6000);
    check("the health poll writes no text", t.text("status-text") === initial, t.text("status-text"));
    await t.emit("startup-progress", "Starting the engine");
    check("startup-progress sets the status", t.text("status-text") === "Starting the engine");
    await t.clock.advance(1500);
    check("and the poll leaves it alone", t.text("status-text") === "Starting the engine");
    await t.emit("startup-progress", "Loading your scenes");
    check("the next stage replaces it", t.text("status-text") === "Loading your scenes");
    t.close();
  }

  {
    const t = await boot();
    const logo = t.doc.querySelector(".logo");
    // An image with a name: the cards below it have their own h1.
    check("the wordmark is named DubMate", logo.getAttribute("role") === "img"
      && logo.getAttribute("aria-label") === "DubMate", logo.outerHTML.slice(0, 60));
    t.close();
  }

  console.log("\n  [+] Launcher: a slow start stays neutral");
  {
    const t = await boot();
    await t.clock.advance(7000);
    check("nothing extra before 8 s", t.text("detail-text") === "", t.text("detail-text"));
    await t.clock.advance(1000);
    check("from 8 s it counts", t.text("detail-text") === "Still starting · 8 s", t.text("detail-text"));
    await t.clock.advance(4000);
    check("ticking each second", t.text("detail-text") === "Still starting · 12 s", t.text("detail-text"));
    check("no Restart before 25 s", !t.visible("btn-restart-slow"));
    await t.clock.advance(13000);
    check("from 25 s it says so", t.text("detail-text") === "Taking longer than usual · 25 s", t.text("detail-text"));
    check("and offers Restart DubMate", t.visible("btn-restart-slow")
      && t.text("btn-restart-slow") === "Restart DubMate");
    await t.clock.advance(6000);
    check("still counting", t.text("detail-text") === "Taking longer than usual · 31 s", t.text("detail-text"));
    const mono = t.$("detail-text").querySelector(".mono");
    check("only the number is mono", !t.$("detail-text").classList.contains("mono")
      && mono && mono.textContent === "31", t.$("detail-text").innerHTML);
    check("the splash stays up", t.visible("splash") && !t.visible("error-box"));

    await t.click("btn-restart-slow");
    check("Restart DubMate restarts the engine", t.invoked("trigger_start_sidecars").length === 1);
    check("and starts the count again", t.text("detail-text") === "" && !t.visible("btn-restart-slow"));
    await t.clock.advance(8000);
    check("from its own start", t.text("detail-text") === "Still starting · 8 s", t.text("detail-text"));
    t.close();
  }

  {
    const t = await boot();
    await t.clock.advance(170 * 1000);
    check("no red card on a slow start", !t.visible("error-box") && t.visible("splash"));
    await t.clock.advance(11 * 1000);
    check("after 3 minutes with no answer from Rust, the card", t.visible("error-box")
      && t.text("error-title") === "DubMate didn't start", t.text("error-title"));
    t.close();
  }

  console.log("\n  [+] Launcher: moving files out of a 1.x install folder isn't a slow start");
  {
    const t = await boot();
    await t.emit("startup-progress", "Moving your DubMate files to their new folder");
    await t.emit("moving-files", true);
    check("it says what is happening",
      t.text("status-text") === "Moving your DubMate files to their new folder", t.text("status-text"));
    check("and that it happens once", t.text("detail-text") === MOVING_DETAIL, t.text("detail-text"));
    await t.clock.advance(30 * 1000);
    check("counting from 8 s, without calling it slow",
      t.text("detail-text") === `${MOVING_DETAIL} · 30 s`, t.text("detail-text"));
    check("no Restart while files move", !t.visible("btn-restart-slow"));
    await t.clock.advance(200 * 1000);
    check("no red card however long the copy takes", !t.visible("error-box") && t.visible("splash"));

    await t.emit("moving-files", false);
    await t.emit("startup-progress", "Starting the engine");
    check("the engine's start counts from the end of the move", t.text("detail-text") === "", t.text("detail-text"));
    await t.clock.advance(8000);
    check("with the usual marks", t.text("detail-text") === "Still starting · 8 s", t.text("detail-text"));
    await t.clock.advance(17 * 1000);
    check("and Restart from 25 s again", t.visible("btn-restart-slow"));
    t.close();
  }
  {
    // Rust starts the move from setup, before this page listens: the launcher asks.
    const t = await boot({ handlers: { get_file_move: () => ({ moving: true, failed: false }) } });
    check("a move that began before the launcher listened is shown",
      t.text("status-text") === "Moving your DubMate files to their new folder", t.text("status-text"));
    check("as happening once", t.text("detail-text") === MOVING_DETAIL, t.text("detail-text"));
    await t.clock.advance(200 * 1000);
    check("with no Restart and no red card", !t.visible("btn-restart-slow")
      && !t.visible("error-box") && t.visible("splash"));
    await t.emit("moving-files", false);
    await t.clock.advance(8000);
    check("then the usual marks", t.text("detail-text") === "Still starting · 8 s", t.text("detail-text"));
    t.close();
  }
  {
    const t = await boot({ handlers: { get_file_move: () => ({ moving: false, failed: false }) } });
    check("no move: the splash is as usual", t.text("detail-text") === "" && t.text("status-text") !== "Moving your DubMate files to their new folder");
    await t.clock.advance(25 * 1000);
    check("and slow marks still apply", t.visible("btn-restart-slow"));
    t.close();
  }
  {
    const t = await boot();
    await t.emit("moving-files", true);
    await t.emit("files-not-moved");
    await t.emit("moving-files", false);
    check("a move that failed says the files still work where they were",
      t.text("detail-text") === NOT_MOVED, t.text("detail-text"));
    await t.clock.advance(8000);
    check("until the start is slow", t.text("detail-text") === "Still starting · 8 s", t.text("detail-text"));
    t.close();
  }
  {
    const t = await boot({ handlers: { get_file_move: () => ({ moving: false, failed: true }) } });
    check("a failed move before the launcher listened is noted too", t.text("detail-text") === NOT_MOVED,
      t.text("detail-text"));
    t.close();
  }

  console.log("\n  [+] Launcher: real failures from Rust");
  const KINDS = [
    { kind: "port_in_use", title: "Another app is using DubMate's port",
      message: "Close any other copy of DubMate, or restart your computer, then press Restart DubMate.",
      detail: "OSError: [WinError 10048] Only one usage of each socket address" },
    { kind: "damaged", title: "Some of DubMate's files are damaged", message: "Reinstall DubMate to fix this.",
      detail: "ModuleNotFoundError: No module named 'numpy'" },
    { kind: "crashed", title: "DubMate stopped while starting", message: "Press Restart DubMate to try again.",
      detail: "Traceback (most recent call last):" },
    { kind: "missing_files", title: "Some of DubMate's files are missing",
      message: "Connect to the internet and restart DubMate to download them, or reinstall it.",
      detail: "app.py was not found." },
    { kind: "no_runtime", title: "DubMate couldn't start", message: "Reinstall DubMate to fix this.", detail: "" },
    { kind: "timeout", title: "DubMate didn't start", message: "It didn't answer for 3 minutes. Press Restart DubMate.",
      detail: "Address: http://127.0.0.1:8123" },
  ];
  for (const failure of KINDS) {
    const t = await boot();
    await t.emit("server-error", failure);
    check(`${failure.kind}: the title is the cause`, t.text("error-title") === failure.title, t.text("error-title"));
    check(`${failure.kind}: the body is the action`, t.text("error-msg") === failure.message, t.text("error-msg"));
    check(`${failure.kind}: Restart DubMate is the primary`, t.text("btn-retry") === "Restart DubMate"
      && t.$("btn-retry").classList.contains("btn-primary"));
    check(`${failure.kind}: Copy details only with details`,
      t.visible("btn-error-secondary") === !!failure.detail
        && (!failure.detail || t.text("btn-error-secondary") === "Copy details"));
    check(`${failure.kind}: the title is an h1`, t.$("error-title").tagName === "H1");
    t.close();
  }

  {
    // Rust can fail before the launcher listens; it asks for the failure once it does.
    const t = await boot({ handlers: { get_last_failure: () => KINDS[4] } });
    check("a failure sent before the launcher listened still shows", t.visible("error-box")
      && t.text("error-title") === KINDS[4].title, t.text("error-title"));
    t.close();
  }
  {
    const t = await boot();
    check("no stored failure: the splash stays", t.visible("splash") && !t.visible("error-box"));
    t.close();
  }

  {
    const t = await boot();
    await t.emit("server-error", KINDS[0]);
    check("the card is an alert", t.$("error-box").getAttribute("role") === "alert");
    check("focus moves to its primary", t.doc.activeElement === t.$("btn-retry"));
    check("the splash is gone", !t.visible("splash"));
    check("the details start hidden", t.$("error-raw").hidden
      && t.text("btn-error-details") === "Show details"
      && t.$("btn-error-details").getAttribute("aria-expanded") === "false");
    await t.click("btn-error-details");
    check("Show details shows them and becomes Hide details", !t.$("error-raw").hidden
      && t.text("btn-error-details") === "Hide details"
      && t.$("btn-error-details").getAttribute("aria-expanded") === "true");
    check("the log holds the detail", t.text("error-raw") === KINDS[0].detail);
    await t.click("btn-error-details");
    check("Hide details hides them again", t.$("error-raw").hidden
      && t.text("btn-error-details") === "Show details"
      && t.$("btn-error-details").getAttribute("aria-expanded") === "false");

    await t.click("btn-error-secondary");
    check("Copy details without a clipboard shows the log to select", !t.$("error-raw").hidden);

    await t.click("btn-retry");
    check("Restart DubMate restarts the engine", t.invoked("trigger_start_sidecars").length === 1);
    check("and goes back to the splash", t.visible("splash") && !t.visible("error-box"));
    t.close();
  }

  {
    const copied = [];
    const t = await boot({ clipboard: { writeText: (s) => { copied.push(s); return Promise.resolve(); } } });
    await t.emit("server-error", KINDS[2]);
    await t.click("btn-error-secondary");
    check("Copy details copies the detail", copied.length === 1 && copied[0] === KINDS[2].detail, JSON.stringify(copied));
    t.close();
  }

  {
    const t = await boot();
    await t.emit("server-error", "DubMate stopped while starting.\n\nDetails: Traceback: boom");
    check("the old string payload still shows a card", t.visible("error-box")
      && t.text("error-title") === "DubMate didn't start"
      && t.text("error-msg") === "DubMate stopped while starting.", `${t.text("error-title")} / ${t.text("error-msg")}`);
    check("with its details behind the toggle", t.text("error-raw") === "Traceback: boom"
      && t.visible("btn-error-details"));
    check("and the engine buttons", t.text("btn-retry") === "Restart DubMate");
    t.close();
  }

  console.log("\n  [+] Launcher: Open in browser only once the engine answers");
  {
    const t = await boot();
    await t.emit("server-error", KINDS[2]);
    check("hidden while /health doesn't answer", !t.visible("btn-open-browser"));
    t.close();
  }
  {
    const t = await boot();
    t.state.health = false;
    await t.emit("server-error", KINDS[0]);
    t.state.health = true;
    await t.clock.advance(5000);
    check("the check is made when the card opens, not polled", !t.visible("btn-open-browser"));
    t.close();
  }
  {
    const t = await boot({ health: false });
    t.state.health = true;
    await t.emit("server-error", KINDS[0]);
    check("shown when /health answers", t.visible("btn-open-browser"));
    await t.click("btn-open-browser");
    check("it opens through Rust, not window.open",
      t.invoked("open_studio_in_browser").length === 1 && t.opened.length === 0);
    t.close();
  }

  console.log("\n  [+] Launcher: the update card");
  {
    const d = deferredUpdate();
    const t = await boot({ handlers: { apply_update: d.handler } });
    await t.emit("update-status", { status: "UpdateAvailable", data: UPDATE });
    check("the update card shows", t.visible("updater-box") && !t.visible("splash"));
    check("its title names the version", t.text("updater-title") === "Updating to DubMate 1.2.0", t.text("updater-title"));
    check("and says what happens", t.text("updater-msg") === "DubMate restarts when it's done.");
    check("no release notes", !t.$("updater-box").textContent.includes("What's new"));
    check("it applies the update", t.invoked("apply_update").length === 1
      && t.invoked("apply_update")[0].args.downloadUrl === UPDATE.download_url);
    const bar = t.$("progress-bar");
    check("the bar is a progressbar", bar.getAttribute("role") === "progressbar"
      && bar.getAttribute("aria-valuemin") === "0" && bar.getAttribute("aria-valuemax") === "100");
    check("Skip this time is offered", t.visible("btn-skip-update") && t.text("btn-skip-update") === "Skip this time");

    const MB = 1024 * 1024;
    await t.emit("update-progress", { received: 21.3 * MB, total: 50.7 * MB, percentage: 42, eta_secs: null });
    check("no time left until the speed settles", t.text("progress-meta") === "42% · 21 MB of 51 MB", t.text("progress-meta"));
    check("aria-valuenow and valuetext follow", bar.getAttribute("aria-valuenow") === "42"
      && bar.getAttribute("aria-valuetext") === "42% · 21 MB of 51 MB");
    await t.emit("update-progress", { received: 21.3 * MB, total: 50.7 * MB, percentage: 42, eta_secs: 75 });
    check("about N min left", t.text("progress-meta") === "42% · 21 MB of 51 MB · about 1 min left", t.text("progress-meta"));
    await t.emit("update-progress", { received: 40 * MB, total: 50.7 * MB, percentage: 79, eta_secs: 25 });
    check("less than a minute left", t.text("progress-meta") === "79% · 40 MB of 51 MB · less than a minute left", t.text("progress-meta"));
    await t.emit("update-progress", { received: 5 * MB, total: 0, percentage: 0, eta_secs: null });
    check("an unknown size shows the amount so far", t.text("progress-meta") === "5 MB", t.text("progress-meta"));
    check("Skip stays while it downloads", t.visible("btn-skip-update"));
    await t.emit("update-progress", { received: 50.7 * MB, total: 50.7 * MB, percentage: 100, eta_secs: 0 });
    check("Skip hides once the download is complete", !t.visible("btn-skip-update"));

    await t.emit("update-stage", { headline: "Installing the update", detail: "Downloading the parts it needs" });
    check("update-stage keeps its copy", t.text("progress-headline") === "Installing the update"
      && t.text("progress-meta") === "Downloading the parts it needs");
    check("Skip hides once installing starts", !t.visible("btn-skip-update"));
    t.close();
  }

  {
    const d = deferredUpdate();
    const t = await boot({ handlers: { apply_update: d.handler } });
    await t.emit("update-status", { status: "UpdateAvailable", data: { ...UPDATE, first_download: true } });
    check("a first download says so", t.text("updater-title") === "Downloading DubMate"
      && t.text("updater-msg") === "This happens once.");
    check("and can't be skipped", !t.visible("btn-skip-update"));
    t.close();
  }

  {
    const d = deferredUpdate();
    const t = await boot({
      health: true,
      handlers: { apply_update: d.handler, cancel_update: () => { d.reject("skipped"); return null; } },
    });
    await t.emit("server-ready", 8123);
    await t.emit("update-status", { status: "UpdateAvailable", data: UPDATE });
    check("no entry while the update runs", t.entered.length === 0);
    t.$("btn-skip-update").click();
    check("Skip disables itself", t.$("btn-skip-update").disabled && t.text("btn-skip-update") === "Skipping…");
    await flush();
    await t.clock.advance(600);
    check("Skip cancels the download", t.invoked("cancel_update").length === 1);
    check("and enters the studio on skipped", t.entered.length === 1 && t.entered[0] === "http://127.0.0.1:8123",
      JSON.stringify(t.entered));
    check("without an error card", !t.visible("error-box"));
    t.close();
  }
  {
    const d = deferredUpdate();
    const t = await boot({
      health: true,
      handlers: {
        apply_update: d.handler,
        cancel_update: () => { d.reject("skipped"); return null; },
        get_packbuilder_status: () => ({ opted_in: true, installed: false, writable: true }),
      },
    });
    await t.emit("server-ready", 8123);
    await t.emit("update-status", { status: "UpdateAvailable", data: UPDATE });
    await t.click("btn-skip-update");
    await t.clock.advance(600);
    check("after Skip, an opted-in Pack Builder still starts installing",
      t.invoked("start_packbuilder_install").length === 1);
    check("and the studio opens", t.entered.length === 1);
    t.close();
  }

  {
    const d = deferredUpdate();
    const t = await boot({ handlers: { apply_update: d.handler } });
    await t.emit("update-status", { status: "UpdateAvailable", data: UPDATE });
    d.reject("DubMate couldn't download the parts this update needs. Check your internet connection."
      + "\n\nDetails: pip exited with 1");
    await flush();
    check("a failed update shows the card", t.visible("error-box"));
    check("its copy says what happened and where you are", t.text("error-msg")
      === "The update to DubMate 1.2.0 didn't install. DubMate couldn't download the parts this update needs. "
        + "Check your internet connection. You're still on 1.1.3.", t.text("error-msg"));
    check("the technical part stays behind details", t.text("error-raw") === "pip exited with 1");
    check("Open DubMate is the primary", t.text("btn-retry") === "Open DubMate");
    check("Try the update again is the secondary", t.text("btn-error-secondary") === "Try the update again");

    const again = deferredUpdate();
    t.window.__TAURI__.core.invoke = ((orig) => (cmd, args) => {
      if (cmd === "apply_update") { t.calls.push({ cmd, args }); return again.handler(); }
      return orig(cmd, args);
    })(t.window.__TAURI__.core.invoke);
    await t.click("btn-error-secondary");
    check("Try the update again applies the same URL", t.invoked("apply_update").length === 2
      && t.invoked("apply_update")[1].args.downloadUrl === UPDATE.download_url);
    check("back on the update card", t.visible("updater-box") && !t.visible("error-box"));

    again.reject("Corrupt zip archive: bad");
    await flush();
    check("without a plain reason the copy still reads", t.text("error-msg")
      === "The update to DubMate 1.2.0 didn't install. You're still on 1.1.3.", t.text("error-msg"));
    t.state.health = true;
    await t.click("btn-retry");
    await t.clock.advance(600);
    check("Open DubMate enters once the engine answers", t.entered.length === 1);
    check("without restarting it", t.invoked("trigger_start_sidecars").length === 0);
    t.close();
  }

  {
    const d = deferredUpdate();
    const t = await boot({ handlers: { apply_update: d.handler } });
    await t.emit("update-status", { status: "UpdateAvailable", data: { ...UPDATE, first_download: true } });
    d.reject("error sending request for url");
    await flush();
    check("a failed first download: Try again", t.text("btn-retry") === "Try again");
    check("with Copy details", t.text("btn-error-secondary") === "Copy details");
    check("and no Open DubMate (there is nothing to open)", !t.$("error-box").textContent.includes("Open DubMate"));
    t.close();
  }

  {
    const t = await boot({ health: true });
    await t.emit("update-status", { status: "UpdateAvailable", data: UPDATE });
    await t.emit("update-complete", null);
    await t.clock.advance(600);
    check("a finished update opens the studio", t.entered.length === 1, JSON.stringify(t.entered));
    t.close();
  }
  {
    const t = await boot({
      health: true,
      handlers: { get_packbuilder_status: () => ({ opted_in: true, installed: false, writable: true }) },
    });
    await t.emit("update-status", { status: "UpdateAvailable", data: { ...UPDATE, first_download: true } });
    await t.emit("update-complete", null);
    await t.clock.advance(600);
    check("after the first download, an opted-in Pack Builder starts installing",
      t.invoked("start_packbuilder_install").length === 1);
    check("and the studio still opens", t.entered.length === 1);
    t.close();
  }

  console.log("\n  [+] Launcher: entering the studio, and Pack Builder in the background");
  {
    const t = await boot({ health: true });
    await t.emit("server-ready", 8123);
    check("after server-ready it checks for updates", t.text("status-text") === "Checking for updates");
    check("and waits for the answer", t.entered.length === 0);
    await t.emit("update-status", { status: "UpToDate" });
    check("up to date: enters", t.entered.length === 1);
    check("no Pack Builder install when not opted in", t.invoked("start_packbuilder_install").length === 0);
    t.close();
  }
  {
    let installStarted = false;
    const t = await boot({
      health: true,
      handlers: {
        get_packbuilder_status: () => ({ opted_in: true, installed: false, writable: true }),
        // The install runs for minutes; the command itself returns at once.
        start_packbuilder_install: () => { installStarted = true; return null; },
      },
    });
    await t.emit("server-ready", 8123);
    await t.emit("update-status", { status: "NoInternet", data: { message: "offline" } });
    check("opted in and not installed: the install starts", installStarted);
    check("and the studio opens at once", t.entered.length === 1);
    check("no Pack Builder card", !t.doc.getElementById("builder-stages") && !t.doc.getElementById("tech-log"));
    t.close();
  }
  {
    const t = await boot({
      health: true,
      handlers: { get_packbuilder_status: () => ({ opted_in: true, installed: true, writable: true }) },
    });
    await t.emit("update-status", { status: "UpToDate" });
    await t.clock.advance(600);
    check("already installed: no install", t.invoked("start_packbuilder_install").length === 0);
    check("enters as soon as the engine answers", t.entered.length === 1);
    t.close();
  }
  {
    const t = await boot({ health: true });
    await t.clock.advance(19000);
    check("without update-status it waits", t.entered.length === 0);
    await t.clock.advance(1000);
    check("but never more than 20 s", t.entered.length === 1);
    t.close();
  }
  {
    const t = await boot({
      health: true,
      handlers: { get_packbuilder_status: () => ({ opted_in: true, installed: false, writable: true }) },
    });
    await t.clock.advance(20000);
    check("entering at the 20 s cap still starts an opted-in Pack Builder",
      t.invoked("start_packbuilder_install").length === 1 && t.entered.length === 1);
    t.close();
  }
  {
    const t = await boot({ tauri: false, health: true });
    await t.clock.advance(600);
    check("in a plain browser it enters when the engine answers", t.entered.length === 1);
    t.close();
  }

  console.log(`\n  Launcher UI: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
