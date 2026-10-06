/**
 * test_room_check_panel.js
 *
 * The Room row in Audio settings (static/js/studio/room_check.js): "Check your room"
 * opens the panel, Start records 3.3 s of room tone and the engine's report becomes the
 * card (light, word, sentence, advice) and the row's text. A silent check stores nothing;
 * a different microphone asks for a new check and its takes are sent with no check id; a
 * stored check the engine no longer has is dropped when Audio settings opens; mic sync
 * and the check wait for each other. The audio engine's recordClip and the engine routes
 * are stubbed; recordClip itself is checked against a stub MediaRecorder.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const HOST = "http://127.0.0.1:8000/";
const GUEST = "https://abc.trycloudflare.com/";
const KEY = "dubmate_room_check";
const NEW_ID = "3fa9c01b7d2e";
const OLD_ID = "0123456789ab";
const READY = "Stay quiet for 3 seconds while DubMate listens to your room.";
const LISTENING = "Listening… stay quiet.";
const OK_ROW = "Some background noise. Cleanup is tuned to it.";
const NEW_MIC = "New microphone. Check your room so cleanup fits it.";
const SILENT = "Your mic sounds completely silent, so something is already removing noise. Turn off Windows mic enhancements, or noise removal in your mic's app, then check again.";
const HUM = "Mains hum at 50 Hz: check cables, USB hub or ground loop. Cleanup removes most of it.";
const UNSTABLE = "The noise kept changing. Check again in a quiet moment.";
const GUEST_TIP = "Your browser keeps this until the host restarts DubMate.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function until(cond, what, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) fail(`timed out waiting for ${what}`);
    await tick(10);
  }
}

const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Microphone (Yeti X)" },
  { kind: "audioinput", deviceId: "usb2", label: "USB Headset Mic" },
  { kind: "audiooutput", deviceId: "default", label: "Headphones (Realtek)" },
];

const OK_REPORT = {
  verdict: "ok", speech_floor_db: -52.4, rumble_share: 0.71, hum_hz: 50, tones_hz: [50.0, 150.0],
  hiss: false, unstable: true, suppressed: false, clipped: false,
};

const storedCheck = (extra = {}) => JSON.stringify({
  profile_id: OLD_ID, verdict: "good", device_label: "Microphone (Yeti X)", device_id: "default",
  measured_at: 1790000000000, ...extra,
});

/** Boots the studio with Audio settings open on the devices step, a stubbed recordClip and engine routes. */
async function boot(url, { stored = null, profileStatus = 200, post = { profile_id: NEW_ID, report: OK_REPORT } } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  if (stored !== null) w.localStorage.setItem(KEY, stored);
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
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
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => DEVICES, addEventListener: () => {} },
  });

  const env = { w, errors, calls: [], toasts: [], post, profileStatus, log: { clips: [], cancels: 0, meterOn: 0, meterOff: 0 } };
  const respond = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
  });
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    const method = opts.method || "GET";
    env.calls.push({ url: u, method, body: opts.body });
    if (u.startsWith("/api/packs")) return respond(200, []);
    if (u.startsWith("/api/config")) return respond(200, { mic_sync: {} });
    if (u === "/api/noise_profiles" && method === "POST") {
      return env.post.status ? respond(env.post.status, env.post.body) : respond(200, env.post);
    }
    if (u.startsWith("/api/noise_profiles/") && method === "GET") return respond(env.profileStatus, env.profileStatus === 200 ? { verdict: "good" } : { detail: "gone" });
    if (u.startsWith("/api/noise_profiles/") && method === "DELETE") return respond(200, { status: "ok", deleted: true });
    if (/\/takes$/.test(u)) {
      return respond(200, { take: { take_id: "k1", url: "/x.wav" }, line: { picked: "k1", next_number: 2, takes: [] } });
    }
    return respond(200, {});
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
  app.loadBoothLine = async () => {};

  // Stubbed engine: recordClip waits until the test lets it finish (or Cancel rejects it).
  const audio = app.audio;
  audio.initContext = () => {};
  audio.getMicPermissionState = async () => "granted";
  audio.supportsOutputRouting = () => true;
  audio.setPreferredOutputDevice = async () => ({ ok: true });
  audio.startInputMonitor = async () => { env.log.meterOn++; return {}; };
  audio.stopInputMonitor = () => { env.log.meterOff++; };
  audio.readInputLevel = () => ({ rmsDb: -60, peakDb: -60 });
  audio.recordClip = (ms, onProgress) => new Promise((resolve, reject) => {
    onProgress(0, ms);
    onProgress(ms / 2, ms);
    env.log.clips.push(ms);
    env.clip = {
      finish: () => { onProgress(ms, ms); resolve(new w.Blob(["room"], { type: "audio/webm" })); },
      reject,
    };
  });
  audio.cancelClip = () => {
    env.log.cancels++;
    if (env.clip) env.clip.reject(new Error("Recording cancelled"));
  };

  await app.openAudioSettings();
  await tick(50);
  return env;
}

const $ = (env, id) => env.w.document.getElementById(id);
const shown = (el) => !!el && el.style.display !== "none";
const text = (el) => (el.textContent || "").trim();
const stored = (env) => JSON.parse(env.w.localStorage.getItem(KEY) || "null");

/** Clicks Check your room, Start, and lets the recording finish; returns the POST call. */
async function runCheck(env) {
  env.clip = null;
  $(env, "btn-room-check").click();
  $(env, "btn-start-room-check").click();
  await until(() => env.clip, "the recording");
  env.clip.finish();
  await until(() => !env.app.roomCheckBusy, "the check");
  return env.calls.find((c) => c.url === "/api/noise_profiles" && c.method === "POST");
}

/** Records one take; returns the form the upload sent. */
async function upload(env) {
  env.app.user = { id: "u1", name: "Ana" };
  env.app.roomState = {
    room_id: "DUB-AB12", host_id: "u1",
    pack: { id: "P", lines: [{ line_id: "t1000", character: "Ana" }], characters: ["Ana"] },
    takes: {}, users: {},
  };
  const before = env.calls.length;
  await env.app.uploadTake(0, new env.w.Blob(["x"], { type: "audio/webm" }));
  const call = env.calls.slice(before).find((c) => /\/takes$/.test(c.url));
  if (!call) fail("no take upload");
  return call.body;
}

(async () => {
  // 1. The row, the panel, a check and its card.
  {
    const env = await boot(HOST);
    const status = $(env, "room-check-status");
    const btn = $(env, "btn-room-check");
    if (!shown($(env, "room-check-row"))) fail("Room row hidden");
    if (text(status) !== "Not checked yet") fail(`status: ${text(status)}`);
    if (text(btn) !== "Check your room") fail(`button: ${text(btn)}`);
    if (shown($(env, "room-check-panel")) || shown($(env, "room-check-card"))) fail("panel or card visible before a check");
    if (status.hasAttribute("data-tip")) fail("host status has the guest tooltip");
    if (env.calls.some((c) => c.url.startsWith("/api/noise_profiles/"))) fail("looked up a check that isn't stored");

    btn.click();
    if (!shown($(env, "room-check-panel"))) fail("panel did not open");
    if (text($(env, "room-check-message")) !== READY) fail(`instruction: ${text($(env, "room-check-message"))}`);
    if (env.w.document.activeElement !== $(env, "btn-start-room-check")) fail("Start not focused");
    if (env.log.clips.length) fail("opening the panel started recording");

    const meterOff = env.log.meterOff;
    const meterOn = env.log.meterOn;
    $(env, "btn-start-room-check").click();
    await until(() => env.clip, "the recording");
    if (env.log.meterOff <= meterOff) fail("input meter not stopped for the check");
    if (text($(env, "room-check-message")) !== LISTENING) fail(`listening copy: ${text($(env, "room-check-message"))}`);
    if (!shown($(env, "room-check-progress"))) fail("no progress while listening");
    if ($(env, "room-check-progress-fill").style.width !== "50%") fail(`progress ${$(env, "room-check-progress-fill").style.width}`);
    if (!$(env, "btn-start-room-check").disabled || !btn.disabled) fail("buttons stay enabled while listening");
    if (env.log.clips[0] !== 3300) fail(`recorded ${env.log.clips[0]} ms`);
    env.clip.finish();
    await until(() => !env.app.roomCheckBusy, "the check");

    const post = env.calls.find((c) => c.url === "/api/noise_profiles" && c.method === "POST");
    if (!post) fail("check not sent to the engine");
    if (post.body.get("device_id") !== "default" || post.body.get("device_label") !== "Microphone (Yeti X)") {
      fail(`device fields: ${post.body.get("device_id")} / ${post.body.get("device_label")}`);
    }
    if (!post.body.get("file")) fail("no recording in the upload");

    const card = $(env, "room-check-card");
    if (shown($(env, "room-check-panel"))) fail("panel still open after the check");
    if (!shown(card)) fail("no card after the check");
    const light = $(env, "room-check-light");
    if (!light.classList.contains("is-ok")) fail(`light: ${light.className}`);
    if (light.getAttribute("data-tip") !== "Background noise: −52 dB. Low rumble is removed automatically.") {
      fail(`light tooltip: ${light.getAttribute("data-tip")}`);
    }
    if (light.tabIndex < 0) fail("light tooltip not reachable by keyboard");
    if (text($(env, "room-check-word")) !== "Some noise") fail(`word: ${text($(env, "room-check-word"))}`);
    if (text($(env, "room-check-sentence")) !== "Some background noise. Cleanup will handle it.") fail("card sentence");
    const advice = [...$(env, "room-check-advice").querySelectorAll("li")].map(text);
    if (JSON.stringify(advice) !== JSON.stringify([HUM, UNSTABLE])) fail(`advice: ${JSON.stringify(advice)}`);

    const entry = stored(env);
    if (!entry || entry.profile_id !== NEW_ID || entry.verdict !== "ok" || entry.device_label !== "Microphone (Yeti X)"
      || entry.device_id !== "default" || typeof entry.measured_at !== "number") fail(`stored: ${JSON.stringify(entry)}`);
    if (text(status) !== OK_ROW) fail(`row after check: ${text(status)}`);
    if (text(btn) !== "Check again" || btn.disabled) fail(`button after check: ${text(btn)}`);
    if (env.log.meterOn <= meterOn) fail("input meter not restored after the check");
    if (env.calls.some((c) => c.method === "DELETE")) fail("deleted something with no previous check");
    if (/dBFS|spectr|gate|notch|DeepFilter/i.test(text($(env, "room-check-row")))) fail("jargon on screen");

    // The upload carries the check's id for this microphone.
    const form = await upload(env);
    if (form.get("noise_profile_id") !== NEW_ID) fail(`upload noise_profile_id ${form.get("noise_profile_id")}`);
    if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
    console.log("PASS: Check your room records 3.3 s, shows the card with light and advice, and the row reads 'Some background noise' / 'Check again'");

    // Closing Audio settings hides the card; reopening shows the row only.
    env.app.closeAudioSettings();
    if (shown(card)) fail("card still shown after closing Audio settings");
  }

  // 2. A new check replaces the stored one and removes the previous one from the engine.
  {
    const env = await boot(HOST, { stored: storedCheck() });
    if (!env.calls.some((c) => c.url === `/api/noise_profiles/${OLD_ID}` && c.method === "GET")) fail("stored check not verified on open");
    if (text($(env, "room-check-status")) !== "Quiet room. Cleanup is tuned to it.") fail(`stored row: ${text($(env, "room-check-status"))}`);
    if (text($(env, "btn-room-check")) !== "Check again") fail("stored row button");
    await runCheck(env);
    if (stored(env).profile_id !== NEW_ID) fail("new check not stored");
    await tick(20);
    const del = env.calls.filter((c) => c.method === "DELETE");
    if (del.length !== 1 || del[0].url !== `/api/noise_profiles/${OLD_ID}`) fail(`deletes: ${JSON.stringify(del.map((c) => c.url))}`);
    console.log("PASS: a new check replaces the stored one and the previous one is removed from the engine");
  }

  // 3. A silent check shows why, stores nothing and keeps the previous check.
  {
    const env = await boot(HOST, { post: { profile_id: null, report: { ...OK_REPORT, suppressed: true } } });
    await runCheck(env);
    const card = $(env, "room-check-card");
    if (!shown(card) || !card.classList.contains("is-error")) fail("silent check not shown as a problem");
    if (text($(env, "room-check-sentence")) !== SILENT) fail(`silent copy: ${text($(env, "room-check-sentence"))}`);
    if (shown($(env, "room-check-verdict")) || shown($(env, "room-check-advice"))) fail("silent card shows a light or advice");
    if (env.w.localStorage.getItem(KEY) !== null) fail("a silent check was stored");
    if (text($(env, "room-check-status")) !== "Not checked yet") fail(`row after a silent check: ${text($(env, "room-check-status"))}`);
    if (text($(env, "btn-room-check")) !== "Check your room") fail("button after a silent check");

    const kept = await boot(HOST, { stored: storedCheck(), post: { profile_id: null, report: { ...OK_REPORT, clipped: true } } });
    await runCheck(kept);
    if (text($(kept, "room-check-sentence")) !== "Something was very loud while DubMate listened. Check again in a quiet moment.") fail("clipped copy");
    if (kept.w.localStorage.getItem(KEY) !== storedCheck()) fail("an unusable check changed the stored one");
    if (kept.calls.some((c) => c.method === "DELETE")) fail("an unusable check deleted the stored one");
    console.log("PASS: a silent or clipped check says why and stores nothing");
  }

  // 4. A different microphone asks for a new check and its takes get standard cleanup.
  {
    const env = await boot(HOST, { stored: storedCheck() });
    const input = $(env, "select-audio-input");
    input.value = "usb2";
    input.dispatchEvent(new env.w.Event("change"));
    await tick(50);
    if (text($(env, "room-check-status")) !== NEW_MIC) fail(`new mic row: ${text($(env, "room-check-status"))}`);
    if (text($(env, "btn-room-check")) !== "Check your room") fail(`new mic button: ${text($(env, "btn-room-check"))}`);
    const form = await upload(env);
    if (form.get("noise_profile_id") !== "") fail(`new mic upload sent ${form.get("noise_profile_id")}`);
    if (!stored(env)) fail("switching mics dropped the check");

    input.value = "";
    input.dispatchEvent(new env.w.Event("change"));
    await tick(50);
    if (text($(env, "room-check-status")) !== "Quiet room. Cleanup is tuned to it.") fail("back on the checked mic");
    if ((await upload(env)).get("noise_profile_id") !== OLD_ID) fail("checked mic upload lost its id");
    console.log("PASS: a different mic shows 'New microphone...' and its takes are sent with no check id");
  }

  // 5. A stored check the engine no longer has is dropped when Audio settings opens.
  {
    const env = await boot(HOST, { stored: storedCheck(), profileStatus: 404 });
    await until(() => env.w.localStorage.getItem(KEY) === null, "the stale check to drop");
    if (text($(env, "room-check-status")) !== "Not checked yet") fail(`row after 404: ${text($(env, "room-check-status"))}`);
    if ((await upload(env)).get("noise_profile_id") !== "") fail("dropped check still sent");

    const offline = await boot(HOST, { stored: storedCheck(), profileStatus: 500 });
    await tick(50);
    if (offline.w.localStorage.getItem(KEY) !== storedCheck()) fail("a failed lookup dropped the check");
    console.log("PASS: a stored check the engine answers 404 for is dropped on open; other failures keep it");
  }

  // 6. Cancel, engine errors and refusals.
  {
    const env = await boot(HOST);
    $(env, "btn-room-check").click();
    $(env, "btn-start-room-check").click();
    await until(() => env.clip, "the recording");
    const meterOn = env.log.meterOn;
    $(env, "btn-cancel-room-check").click();
    await tick(50);
    if (env.log.cancels !== 1) fail("Cancel did not stop the recording");
    if (shown($(env, "room-check-panel")) || env.app.roomCheckBusy) fail("still listening after Cancel");
    if (env.log.meterOn <= meterOn) fail("input meter not restored after Cancel");
    if (env.calls.some((c) => c.url === "/api/noise_profiles")) fail("a cancelled check was sent");
    if (env.w.localStorage.getItem(KEY) !== null || env.toasts.length) fail("a cancelled check stored or toasted");

    env.post = { status: 400, body: { detail: "That was too short. Try again." } };
    await runCheck(env);
    if (!shown($(env, "room-check-panel")) || !$(env, "room-check-panel").classList.contains("is-error")) fail("engine error not shown");
    if (text($(env, "room-check-message")) !== "That was too short. Try again.") fail(`error copy: ${text($(env, "room-check-message"))}`);
    if ($(env, "btn-start-room-check").disabled) fail("cannot try again after an error");
    if (env.w.localStorage.getItem(KEY) !== null) fail("a failed check stored something");

    for (const state of ["countdown", "recording"]) {
      const before = env.log.clips.length;
      env.app.recordState = state;
      env.toasts.length = 0;
      await env.app.runRoomCheck();
      if (env.log.clips.length !== before || !env.toasts.length) fail(`check not refused during ${state}`);
    }
    env.app.recordState = "idle";
    console.log("PASS: Cancel stops the check, engine errors show in the panel, and a take in progress refuses it");
  }

  // 7. Mic sync and the room check share the microphone: each waits for the other.
  {
    const env = await boot(HOST);
    let syncRecordings = 0;
    env.app.audio.startRecording = async () => { syncRecordings++; };
    $(env, "btn-room-check").click();
    $(env, "btn-start-room-check").click();
    await until(() => env.clip, "the recording");
    if (!$(env, "btn-mic-sync").disabled) fail("Sync your mic enabled during the room check");
    env.toasts.length = 0;
    env.app.openMicSyncPanel();
    if (shown($(env, "mic-sync-panel"))) fail("mic sync panel opened during the room check");
    await env.app.runMicSync();
    await env.app.runClapSync();
    if (syncRecordings || env.app.micSyncBusy) fail("mic sync recorded during the room check");
    if (env.toasts.length !== 3 || !/room check/.test(env.toasts[0])) fail(`toasts: ${JSON.stringify(env.toasts)}`);
    env.clip.finish();
    await until(() => !env.app.roomCheckBusy, "the check");
    if ($(env, "btn-mic-sync").disabled) fail("Sync your mic still disabled after the room check");

    // The other way round: the room check waits while mic sync listens.
    $(env, "btn-room-check").click();
    env.app.micSyncBusy = true;
    env.app.renderRoomCheckRow();
    if (!$(env, "btn-room-check").disabled) fail("Check your room enabled during mic sync");
    const clips = env.log.clips.length;
    env.toasts.length = 0;
    $(env, "btn-start-room-check").click();
    await tick(20);
    if (env.log.clips.length !== clips || env.app.roomCheckBusy) fail("room check recorded during mic sync");
    if (env.toasts.length !== 1 || !/mic sync/.test(env.toasts[0])) fail(`toasts: ${JSON.stringify(env.toasts)}`);
    env.app.cancelRoomCheck();
    env.app.openRoomCheckPanel();
    if (shown($(env, "room-check-panel"))) fail("room check panel opened during mic sync");
    env.app.micSyncBusy = false;
    if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
    console.log("PASS: mic sync and the room check refuse to start while the other is listening");
  }

  // 8. recordClip keeps the microphone open when a take or mic sync is still recording.
  {
    const { AudioEngine } = await import(pathToFileURL(path.join(PROJECT_ROOT, "static", "js", "audio_engine.js")).href);
    globalThis.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        setTimeout(() => { this.ondataavailable({ data: { size: 1 } }); this.onstop(); }, 0);
      }
    };
    globalThis.Blob = globalThis.Blob || require("buffer").Blob;
    const clipWith = async (isRecording) => {
      const engine = new AudioEngine();
      let stopped = 0;
      const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
      engine.initContext = () => {};
      engine.requestMicrophone = async () => { engine.stream = stream; return stream; };
      engine.isRecording = isRecording;
      await engine.recordClip(60);
      return { stopped, kept: engine.stream === stream };
    };
    const busy = await clipWith(true);
    if (busy.stopped || !busy.kept) fail("recordClip released the mic another recording uses");
    const idle = await clipWith(false);
    if (idle.stopped !== 1 || idle.kept) fail("recordClip kept the mic when nothing else records");
    console.log("PASS: recordClip releases the microphone only when nothing else is recording from it");
  }

  // 9. Guests see the row with the tooltip; every button is a named, focusable button.
  {
    const env = await boot(GUEST);
    const status = $(env, "room-check-status");
    if (status.getAttribute("data-tip") !== GUEST_TIP || status.getAttribute("tabindex") !== "0") fail("guest tooltip");
    for (const id of ["btn-room-check", "btn-start-room-check", "btn-cancel-room-check"]) {
      const b = $(env, id);
      if (!b || b.tagName !== "BUTTON" || b.getAttribute("type") !== "button" || b.tabIndex < 0 || !text(b)) fail(`${id} is not a named button`);
    }
    if ($(env, "modal-mic-calibration") || $(env, "btn-calibrate-mic")) fail("the old calibration dialog is still there");
    console.log("PASS: guests see the row with the tooltip; buttons are focusable and named; the old dialog is gone");
  }

  console.log("ALL ROOM CHECK PANEL TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
