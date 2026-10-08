/**
 * test_audio_settings_layout.js
 *
 * Audio settings after UI pass U5b (documentation/design/ui-u5b-settings-launcher.md, A):
 *  - one level target (level_target.js) for the meter, its hint and the loudest-line check;
 *  - the meter shows peak in a zone band, the hint follows the loudest peak of the last
 *    2.5 s and goes back to neutral, and the numbers live in a throttled tooltip;
 *  - status lines and the mic pill use the status-text classes;
 *  - the denied step shows one recovery list for this computer, the rest behind
 *    "Using something else?", and no list for errors that aren't about permission;
 *  - first run says "Set up your mic" and a privacy line that is true where it shows;
 *  - "Check again" on the room check's failed panel and its unusable card;
 *  - no emoji anywhere in the modal.
 * The audio engine is stubbed; animation frames and the clock are driven by the test.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const studioUrl = (name) => pathToFileURL(path.join(PROJECT_ROOT, "static", "js", "studio", name)).href;
const { JSDOM, VirtualConsole } = jsdom;

const HOST = "http://127.0.0.1:8000/";
const GUEST = "https://abc.trycloudflare.com/";
const PAIR = "Microphone (Yeti X)|Headphones (Realtek)";
const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Microphone (Yeti X)" },
  { kind: "audiooutput", deviceId: "default", label: "Headphones (Realtek)" },
];

const HINT = {
  neutral: "Say your loudest line. Aim for the green band.",
  attention: "A bit quiet. Move closer or turn the mic up.",
  done: "Good level.",
  error: "Too loud. Move back from the mic or turn down its input level.",
};
const FALLBACK = "Your saved microphone isn't connected. Showing the system default.";

const STEPS = {
  "desktop-windows": [
    "Open Windows microphone settings.",
    "Turn on Microphone access and Let desktop apps access your microphone.",
    "Come back and press Try again. If it still doesn't work, restart DubMate.",
  ],
  "desktop-mac": ["Open macOS microphone settings.", "Turn on DubMate.", "Restart DubMate."],
  browser: ["Click the icon at the left of the address bar.", "Set Microphone to Allow.", "Press Try again."],
};
const STILL_BLOCKED = {
  windows: "Still blocked? In Windows Settings → Privacy & security → Microphone, turn on Let desktop apps access your microphone.",
  mac: "Still blocked? In System Settings → Privacy & Security → Microphone, turn on your browser.",
};
const EMOJI = /\p{Extended_Pictographic}/u;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
function check(cond, msg) {
  if (!cond) fail(msg);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * Boots the studio. `permission` is what the browser reports, `platform` the OS the page
 * sees, `desktop` a map of desktop-app commands (window.__TAURI__) or null for a browser.
 */
async function boot(url, { permission = "granted", platform = "Windows", desktop = null, monitor = {} } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  const env = { w, errors, now: 0, frameCb: null, level: { rmsDb: -60, peakDb: -60 }, invokes: [], toasts: [] };

  w.requestAnimationFrame = (cb) => { env.frameCb = cb; return 1; };
  w.cancelAnimationFrame = () => { env.frameCb = null; };
  Object.defineProperty(w.performance, "now", { configurable: true, value: () => env.now });
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
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => DEVICES, addEventListener: () => {} },
  });
  Object.defineProperty(w.navigator, "userAgentData", { configurable: true, value: { platform } });
  if (desktop) {
    w.__TAURI__ = {
      core: {
        invoke: (cmd, args) => {
          env.invokes.push(cmd);
          const handler = desktop[cmd];
          if (!handler) return Promise.reject(`Command ${cmd} not allowed by ACL`);
          return Promise.resolve().then(() => handler(args));
        },
      },
    };
  }
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  w.fetch = (input) => {
    const u = String(input || "");
    if (u.startsWith("/api/packs")) return json([]);
    if (u.startsWith("/api/config")) return json({ mic_sync: {} });
    return json({});
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  env.app = app;
  app.showToast = (msg) => env.toasts.push(msg);
  app.closeAudioSettings();

  const audio = app.audio;
  audio.initContext = () => {};
  audio.getMicPermissionState = async () => permission;
  audio.supportsOutputRouting = () => true;
  audio.setPreferredOutputDevice = async () => ({ ok: true });
  audio.startInputMonitor = async () => monitor;
  audio.stopInputMonitor = () => {};
  audio.readInputLevel = () => env.level;
  app.audioSetup.permission = permission === "granted" ? "granted" : "unknown";
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const shown = (el) => !!el && el.style.display !== "none" && !el.hidden;
const classes = (el) => (el ? el.className : "(missing)");

/** Runs one meter frame at time `t` (ms) with this peak. */
function frame(env, t, peakDb) {
  env.now = t;
  env.level = { rmsDb: peakDb - 3, peakDb };
  const cb = env.frameCb;
  if (!cb) fail(`no meter frame pending at ${t} ms`);
  env.frameCb = null;
  cb();
}

function done(env) {
  if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  env.w.close();
}

(async () => {
  const target = await import(studioUrl("level_target.js"));

  // 1. The shared target and its edges.
  {
    check(target.LEVEL_GOOD_MIN_DB === -10 && target.LEVEL_GOOD_MAX_DB === -6 && target.LEVEL_QUIET_PEAK_DB === -45,
      "level target constants");
    const zones = [[-Infinity, "quiet"], [NaN, "quiet"], [-10.01, "quiet"], [-10, "good"], [-8, "good"], [-6, "good"], [-5.99, "loud"], [0, "loud"]];
    for (const [db, want] of zones) check(target.levelZone(db) === want, `levelZone(${db}) = ${target.levelZone(db)}, want ${want}`);
    const hints = [[-Infinity, "neutral"], [undefined, "neutral"], [-45.01, "neutral"], [-45, "attention"], [-10.01, "attention"],
      [-10, "done"], [-6, "done"], [-5.99, "error"], [0, "error"]];
    for (const [db, tone] of hints) {
      const got = target.levelHint(db);
      check(got.tone === tone && got.text === HINT[tone], `levelHint(${db}) = ${JSON.stringify(got)}, want ${tone}`);
    }
    const roomCheck = fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "studio", "room_check.js"), "utf8");
    check(/from '\.\/level_target\.js'/.test(roomCheck), "room_check.js does not import level_target.js");
    check(!/LOUD_GOOD_(MIN|MAX)_DB\s*=/.test(roomCheck), "room_check.js still has its own good range");
    const rc = await import(studioUrl("room_check.js"));
    check(rc.loudLineAdvice(-8, -20, -60).text === "Good level.", "loudest line at -8 dB");
    check(rc.loudLineAdvice(-5, -20, -60).text === "Turn your mic down by about 3 dB.", "loudest line at -5 dB");
    check(rc.loudLineAdvice(-12, -24, -60).text === "Turn your mic up by about 4 dB.", "loudest line at -12 dB");
    console.log("PASS: one level target: levelZone and levelHint edges, shared with the loudest-line check");
  }

  // 2. The meter: peak in a zone band, a hint over the last 2.5 s, numbers in a throttled tooltip.
  {
    const env = await boot(HOST);
    await env.app.openAudioSettings();
    await tick();
    const track = $(env, "level-meter-track");
    const hint = $(env, "level-meter-hint");
    const fill = $(env, "level-meter-fill");
    check(!$(env, "level-meter-rms") && !$(env, "level-meter-peak-readout"), "the number readouts are still on the meter");
    check(!!fill, "no #level-meter-fill");
    check(track.getAttribute("tabindex") === "0", "the meter is not focusable for its tooltip");
    check(text(hint) === HINT.neutral && /\bis-pending\b/.test(classes(hint)) && /\bstatus-text\b/.test(classes(hint)),
      `opening hint: ${text(hint)} [${classes(hint)}]`);
    const legend = Array.from(env.w.document.querySelectorAll(".level-meter-legend .level-zone-key")).map(text);
    check(JSON.stringify(legend) === JSON.stringify(["Too quiet", "Good", "Too loud"]), `legend: ${JSON.stringify(legend)}`);

    frame(env, 1000, -30);
    check(track.classList.contains("is-quiet"), `zone at -30: ${classes(track)}`);
    check(Math.abs(parseFloat(fill.style.width) - 50) < 0.2, `fill at -30 dB: ${fill.style.width}`);
    check(text(hint) === HINT.attention && hint.classList.contains("is-attention"), `hint at -30: ${text(hint)} [${classes(hint)}]`);
    check(track.getAttribute("data-tip") === "Peak -30 dB", `tooltip at -30: ${track.getAttribute("data-tip")}`);
    check(track.getAttribute("aria-valuetext") === "Peak -30 dB", `aria-valuetext: ${track.getAttribute("aria-valuetext")}`);

    // The peak rises 50 ms later: the bar follows at once, the tooltip waits (4 Hz).
    frame(env, 1050, -8);
    check(track.classList.contains("is-good"), `zone at -8: ${classes(track)}`);
    check(text(hint) === HINT.done && hint.classList.contains("is-done"), `hint at -8: ${text(hint)}`);
    check(track.getAttribute("data-tip") === "Peak -30 dB", `tooltip updated faster than 4 Hz: ${track.getAttribute("data-tip")}`);
    frame(env, 1300, -8);
    check(track.getAttribute("data-tip") === "Peak -8 dB", `tooltip after 250 ms: ${track.getAttribute("data-tip")}`);

    frame(env, 1400, -3);
    check(track.classList.contains("is-loud"), `zone at -3: ${classes(track)}`);
    check(text(hint) === HINT.error && hint.classList.contains("is-error"), `hint at -3: ${text(hint)}`);

    // Quiet afterwards: the loudest peak of the last 2.5 s still decides, then the hint resets.
    frame(env, 2000, -90);
    check(text(hint) === HINT.error, `hint 0.6 s after the loud peak: ${text(hint)}`);
    frame(env, 3800, -90);
    check(text(hint) === HINT.error, `hint 2.4 s after the loud peak: ${text(hint)}`);
    frame(env, 4000, -90);
    check(text(hint) === HINT.neutral && hint.classList.contains("is-pending"), `hint 2.6 s after the loud peak: ${text(hint)}`);
    for (let t = 4016; t < 12000; t += 16) frame(env, t, -90);
    check(track.classList.contains("is-quiet") && parseFloat(fill.style.width) < 1, `bar after quiet: ${fill.style.width}`);
    done(env);

    // A fallback microphone line stays put while the meter runs.
    const fb = await boot(HOST, { monitor: { didFallBack: true } });
    await fb.app.openAudioSettings();
    await tick();
    frame(fb, 1000, -8);
    frame(fb, 1300, -3);
    check(text($(fb, "level-meter-hint")) === FALLBACK, `fallback hint replaced by: ${text($(fb, "level-meter-hint"))}`);
    done(fb);
    console.log("PASS: the meter shows peak in a zone band, the hint follows the last 2.5 s and the numbers live in a 4 Hz tooltip");
  }

  // 3. Status classes on the Timing and Room rows, device notes and the mic pill.
  {
    const env = await boot(HOST);
    await env.app.openAudioSettings();
    await tick();
    const pill = $(env, "audio-setup-status-pill");
    check(text(pill) === "Mic ready" && /\bstatus-text\b/.test(classes(pill)) && pill.classList.contains("is-done"), `pill on devices: ${text(pill)} [${classes(pill)}]`);
    const sync = $(env, "mic-sync-status");
    check(/\bstatus-text\b/.test(classes(sync)) && sync.classList.contains("is-pending"), `unsynced: ${classes(sync)}`);
    env.w.localStorage.setItem("dubmate_mic_sync", JSON.stringify({ [PAIR]: { latency_ms: 140, method: "clicks", measured_at: 1 } }));
    env.app.renderMicSyncRow();
    check(sync.classList.contains("is-done") && !sync.classList.contains("is-pending"), `synced: ${classes(sync)}`);

    const room = $(env, "room-check-status");
    check(/\bstatus-text\b/.test(classes(room)) && room.classList.contains("is-pending"), `not checked: ${classes(room)}`);
    const stored = (verdict, label = "Microphone (Yeti X)") => env.w.localStorage.setItem("dubmate_room_check", JSON.stringify({
      profile_id: "0123456789ab", verdict, device_label: label, device_id: "default", measured_at: 1,
    }));
    for (const [verdict, cls] of [["good", "is-done"], ["ok", "is-done"], ["noisy", "is-attention"]]) {
      stored(verdict);
      env.app.renderRoomCheckRow();
      check(room.classList.contains(cls) && room.className.split(/\s+/).filter((c) => c.startsWith("is-")).length === 1,
        `${verdict} room: ${classes(room)}`);
    }
    stored("good", "Another mic");
    env.app.renderRoomCheckRow();
    check(text(room).startsWith("New microphone") && room.classList.contains("is-attention"), `new mic: ${text(room)} [${classes(room)}]`);
    stored("good");
    env.app.user = { id: "u1" };
    env.app.roomState = { room_id: "r1", takes: { l1: { takes: [{ user_id: "u1", noise_reduction: true, nr_settings: { profile_id: "ffffffffffff" } }] } } };
    env.app.renderRoomCheckRow();
    const refresh = $(env, "room-check-refresh-text");
    check(shown($(env, "room-check-refresh")) && /\bstatus-text\b/.test(classes(refresh)) && refresh.classList.contains("is-attention"),
      `refresh line: ${classes(refresh)}`);

    const note = $(env, "audio-input-note");
    env.app.renderDeviceNote(note, { count: 0, missing: false }, { supported: true, labelled: true }, "microphone");
    check(/\bstatus-text\b/.test(classes(note)) && note.classList.contains("is-attention"), `no device: ${classes(note)}`);
    env.app.renderDeviceNote(note, { count: 1, missing: true }, { supported: true, labelled: true }, "microphone");
    check(note.classList.contains("is-attention"), `saved device missing: ${classes(note)}`);
    env.app.renderDeviceNote(note, { count: 0 }, { supported: false }, "microphone");
    check(note.classList.contains("is-error"), `unsupported: ${classes(note)}`);
    check(!/is-warning/.test(classes(note)), "device notes still use is-warning");
    await env.app.applyOutputDevice("default");
    const out = $(env, "audio-output-note");
    check(out.classList.contains("is-done") && text(out) === "Using this output.", `output note: ${text(out)} [${classes(out)}]`);
    done(env);

    const denied = await boot(HOST, { permission: "denied" });
    await denied.app.openAudioSettings();
    const dpill = $(denied, "audio-setup-status-pill");
    check(text(dpill) === "Mic blocked" && dpill.classList.contains("is-error"), `pill when denied: ${text(dpill)} [${classes(dpill)}]`);
    done(denied);
    const intro = await boot(HOST, { permission: "prompt" });
    await intro.app.openAudioSettings({ firstRun: true });
    const ipill = $(intro, "audio-setup-status-pill");
    check(text(ipill) === "No mic yet" && ipill.classList.contains("is-pending"), `pill before permission: ${text(ipill)} [${classes(ipill)}]`);
    done(intro);
    console.log("PASS: Timing, Room, refresh and device lines and the mic pill use the status classes");
  }

  // 4. The denied step: one list for this computer, the rest behind "Using something else?".
  {
    const lis = (el) => Array.from(el.querySelectorAll("li")).map(text);
    const cases = [
      { name: "desktop app on Windows", url: HOST, platform: "Windows", desktop: true, list: "desktop-windows", button: "Open Windows microphone settings", others: ["desktop-mac", "browser"] },
      { name: "desktop app on a Mac", url: HOST, platform: "macOS", desktop: true, list: "desktop-mac", button: "Open macOS microphone settings", others: ["desktop-windows", "browser"] },
      { name: "browser on Windows", url: HOST, platform: "Windows", desktop: false, list: "browser", os: "windows", others: ["desktop-windows", "desktop-mac"] },
      { name: "browser on a Mac", url: GUEST, platform: "macOS", desktop: false, list: "browser", os: "mac", others: ["desktop-windows", "desktop-mac"] },
      { name: "browser on Linux", url: GUEST, platform: "Linux", desktop: false, list: "browser", others: ["desktop-windows", "desktop-mac"] },
      { name: "desktop app on a host's page", url: GUEST, platform: "Windows", desktop: true, list: "desktop-windows", others: ["desktop-mac", "browser"] },
    ];
    for (const c of cases) {
      const commands = { get_packbuilder_status: () => ({ installed: false }), open_mic_settings: () => null };
      const env = await boot(c.url, { permission: "denied", platform: c.platform, desktop: c.desktop ? commands : null });
      await env.app.openAudioSettings();
      await tick();
      check(shown($(env, "audio-setup-step-denied")), `${c.name}: denied step not shown`);
      check(!shown($(env, "audio-setup-subtitle")), `${c.name}: the subtitle repeats the detail`);
      check(!!env.w.document.querySelector(".audio-denied-title svg"), `${c.name}: no icon in the denied box`);
      const recovery = $(env, "audio-recovery");
      check(shown(recovery), `${c.name}: recovery hidden`);
      const steps = $(env, "audio-recovery-steps");
      check(JSON.stringify(lis(steps)) === JSON.stringify(STEPS[c.list]), `${c.name}: steps ${JSON.stringify(lis(steps))}`);
      const os = $(env, "audio-recovery-os");
      if (c.os) check(shown(os) && text(os) === STILL_BLOCKED[c.os], `${c.name}: OS line ${text(os)}`);
      else check(!shown(os), `${c.name}: an OS line showed: ${text(os)}`);
      const btn = $(env, "btn-open-mic-settings");
      if (c.button) {
        check(shown(btn) && text(btn) === c.button && btn.classList.contains("btn-secondary"), `${c.name}: settings button ${text(btn)} [${btn && btn.className}]`);
        check(steps.contains(btn), `${c.name}: the settings button is not in the list`);
      } else {
        check(!btn || !shown(btn), `${c.name}: a settings button showed without the desktop bridge`);
      }
      const more = $(env, "audio-recovery-more");
      check(more && more.tagName === "DETAILS" && !more.open, `${c.name}: "Using something else?" is not a closed details`);
      check(text(more.querySelector("summary")) === "Using something else?", `${c.name}: summary ${text(more.querySelector("summary"))}`);
      const rest = lis(more);
      for (const other of c.others) {
        for (const line of STEPS[other]) check(rest.includes(line), `${c.name}: "${line}" missing from Using something else?`);
      }
      check(!rest.includes(STEPS[c.list][0]), `${c.name}: the shown list is repeated under Using something else?`);
      done(env);
    }

    // The settings button asks the desktop app, and hides when it can't.
    {
      const commands = { get_packbuilder_status: () => ({ installed: false }), open_mic_settings: () => null };
      const env = await boot(HOST, { permission: "denied", desktop: commands });
      await env.app.openAudioSettings();
      $(env, "btn-open-mic-settings").click();
      await tick();
      check(env.invokes.includes("open_mic_settings"), "the settings button did not call open_mic_settings");
      check(shown($(env, "btn-open-mic-settings")), "the settings button hid after it worked");
      delete commands.open_mic_settings;
      $(env, "btn-open-mic-settings").click();
      await tick();
      check(!shown($(env, "btn-open-mic-settings")), "the settings button stayed after the desktop app refused");
      check(text($(env, "audio-recovery-steps").querySelector("li")) === STEPS["desktop-windows"][0], "the written step went with the button");
      done(env);
    }

    // Errors that aren't about permission show no lists.
    {
      const env = await boot(HOST, { permission: "denied", desktop: { get_packbuilder_status: () => ({ installed: false }) } });
      await env.app.openAudioSettings();
      for (const name of ["NotFoundError", "NotReadableError", "OverconstrainedError", "TypeError"]) {
        env.app.renderMicDenial({ name });
        env.app.showAudioSetupStep("denied");
        check(!shown($(env, "audio-recovery")), `${name}: the recovery lists showed`);
        check(text($(env, "audio-denied-heading")) && shown($(env, "btn-retry-mic")), `${name}: heading or Try again missing`);
      }
      env.app.renderMicDenial({ name: "NotAllowedError" });
      check(shown($(env, "audio-recovery")), "NotAllowedError: the recovery lists stayed hidden");
      done(env);
    }
    console.log("PASS: the denied step shows one list per computer, the rest behind Using something else?, none for other errors");
  }

  // 5. First run: the title, the hero line, a privacy line that is true where it shows.
  {
    const cases = [
      { url: HOST, desktop: null, privacy: "Audio stays on this computer.", ask: "Your browser will ask for permission. Choose Allow." },
      { url: GUEST, desktop: null, privacy: "Your takes are saved on the host's computer.", ask: "Your browser will ask for permission. Choose Allow." },
      { url: HOST, desktop: { get_packbuilder_status: () => ({ installed: false }) }, privacy: "Audio stays on this computer.", ask: "Your computer may ask for permission. Choose Allow." },
    ];
    for (const c of cases) {
      const env = await boot(c.url, { permission: "prompt", desktop: c.desktop });
      await env.app.openAudioSettings({ firstRun: true });
      const where = `${c.url}${c.desktop ? " (desktop app)" : ""}`;
      check(text($(env, "audio-setup-title")) === "Set up your mic", `${where}: first-run title ${text($(env, "audio-setup-title"))}`);
      check(!shown($(env, "audio-setup-subtitle")), `${where}: subtitle on the first-run step`);
      check(text(env.w.document.querySelector("#audio-setup-step-intro .audio-intro-title")) === "So you can record your lines.", `${where}: hero line`);
      check(text($(env, "audio-intro-privacy")) === c.privacy, `${where}: privacy line ${text($(env, "audio-intro-privacy"))}`);
      check(text($(env, "audio-intro-permission")) === c.ask, `${where}: permission line ${text($(env, "audio-intro-permission"))}`);
      check(!$(env, "modal-audio-settings").querySelector(".badge-studio"), `${where}: the AUDIO SETUP badge is back`);
      done(env);
    }
    const env = await boot(HOST);
    await env.app.openAudioSettings();
    check(text($(env, "audio-setup-title")) === "Audio settings", `settings title ${text($(env, "audio-setup-title"))}`);
    check(shown($(env, "audio-setup-subtitle")) && text($(env, "audio-setup-subtitle")) === "Choose your microphone and headphones.", "subtitle on the devices step");
    done(env);
    console.log("PASS: first run says Set up your mic, with a privacy line for this computer or a host's");
  }

  // 6. Check again on the room check's failed panel and on its unusable card.
  {
    const env = await boot(HOST);
    await env.app.openAudioSettings();
    env.app.showRoomCheckPanel("failed", "DubMate couldn't finish the check. Try again.");
    check(text($(env, "btn-start-room-check")) === "Check again", `failed panel primary: ${text($(env, "btn-start-room-check"))}`);
    env.app.showRoomCheckPanel("ready");
    check(text($(env, "btn-start-room-check")) === "Start", `ready panel primary: ${text($(env, "btn-start-room-check"))}`);
    env.app.showRoomCheckPanel(null);

    const again = $(env, "btn-room-check-again");
    check(!!again, "no #btn-room-check-again");
    env.app.showRoomCard({ light: "good", word: "Quiet", sentence: "Your room is quiet. Good to record.", tooltip: "", advice: [], unusable: null });
    check(!shown(again), "Check again shows on a usable card");
    env.app.showRoomCard({ light: null, word: "", sentence: "", tooltip: "", advice: [], unusable: "Something was very loud while DubMate listened. Check again in a quiet moment." });
    check(shown(again) && text(again) === "Check again", `unusable card button: ${text(again)}`);
    again.click();
    check(!shown($(env, "room-check-card")), "the card stayed after Check again");
    check(shown($(env, "room-check-panel")) && env.app.roomCheckStep === "ready", `Check again opened ${env.app.roomCheckStep}`);
    done(env);
    console.log("PASS: Check again on the failed panel and on the unusable card");
  }

  // 7. No emoji anywhere in the modal, in any step.
  {
    const env = await boot(HOST, { permission: "prompt" });
    const modal = $(env, "modal-audio-settings");
    check(!EMOJI.test(modal.innerHTML), `emoji in the modal's markup: ${(modal.innerHTML.match(new RegExp(EMOJI.source, "gu")) || []).join(" ")}`);
    await env.app.openAudioSettings({ firstRun: true });
    env.app.renderMicDenial({ name: "NotAllowedError" });
    env.app.showAudioSetupStep("denied");
    env.app.audioSetup.permission = "granted";
    env.app.showAudioSetupStep("devices");
    await env.app.refreshAudioDevices();
    check(!EMOJI.test(modal.innerHTML), "emoji in the modal after rendering every step");
    check(!!$(env, "audio-output-unsupported").querySelector("svg"), "the output box has no icon");
    check(!!env.w.document.querySelector("#audio-setup-step-intro .audio-fact-icon svg"), "the permission fact has no icon");
    done(env);
    console.log("PASS: no emoji in Audio settings");
  }

  process.exit(0);
})().catch((err) => fail(err && err.stack || String(err)));
