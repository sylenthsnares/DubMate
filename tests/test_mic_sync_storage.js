/**
 * test_mic_sync_storage.js
 *
 * Mic sync storage (static/js/studio/mic_sync.js) and the starting offset of a new
 * take: a synced microphone and output pair starts the take its measured delay
 * earlier, an unsynced one keeps the slider value; the host's engine config backs up
 * the browser's copy; the "please sync" toast shows once per pair per tab session on
 * the host's computer and never for a guest.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const HOST = "http://127.0.0.1:8000/";
const GUEST = "https://abc.trycloudflare.com/";
const PAIR = "Microphone (Yeti X)|Headphones (Realtek)";
// The booth's inline mic-sync hint; record() notes it in the toast list when it shows.
const SYNC_HINT = "hint: Sync your mic so takes line up on their own.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Microphone (Yeti X)" },
  { kind: "audioinput", deviceId: "usb2", label: "USB Headset Mic" },
  { kind: "audiooutput", deviceId: "default", label: "Headphones (Realtek)" },
];

/** Boots the studio at `url` with stubbed devices and fetch. `engineMicSync` is what GET /api/config returns. */
async function boot(url, { engineMicSync = {}, stored = null } = {}) {
  const virtualConsole = new VirtualConsole();
  const warnings = [];
  virtualConsole.on("warn", (...args) => warnings.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  if (stored !== null) w.localStorage.setItem("dubmate_mic_sync", stored);
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
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => DEVICES,
      addEventListener: () => {},
    },
  });

  const calls = [];
  const json = (body) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.startsWith("/api/packs")) return json([]);
    if (u.startsWith("/api/config")) return json({ mic_sync: engineMicSync });
    if (/\/takes$/.test(u)) {
      return json({ take: { take_id: "k1", url: "/x.wav" }, line: { picked: "k1", next_number: 2, takes: [] } });
    }
    return json({});
  };

  if (w.document.readyState !== "complete") {
    await new Promise((resolve) => w.addEventListener("load", () => resolve()));
  }
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);

  const toasts = [];
  app.showToast = (msg) => toasts.push(msg);
  app.loadBoothLine = async () => {};
  app.user = { id: "u1", name: "Ana" };
  app.roomState = {
    room_id: "DUB-AB12", host_id: "u1",
    pack: { id: "P", lines: [{ line_id: "t1000", character: "Ana" }], characters: ["Ana"] },
    takes: {}, users: {},
  };
  app.sliderNudge.value = "35";
  return { w, app, calls, toasts, warnings };
}

/** Records one take; returns the offset_ms the upload sent. */
async function record(env) {
  const before = env.calls.length;
  await env.app.uploadTake(0, new env.w.Blob(["x"], { type: "audio/webm" }));
  const upload = env.calls.slice(before).find((c) => /\/takes$/.test(c.url));
  if (!upload) fail("no take upload");
  const hint = env.w.document.getElementById("mic-sync-hint");
  if (!hint.hidden) {
    env.toasts.push(`hint: ${hint.querySelector(".mic-sync-hint-text").textContent}`);
    hint.hidden = true;
  }
  return upload.body.get("offset_ms");
}

const entry = (ms, method = "clicks") => ({ latency_ms: ms, method, measured_at: 1790000000000 });

(async () => {
  // 1. A synced pair starts the take its delay earlier, and never asks to sync.
  {
    const env = await boot(HOST, { stored: JSON.stringify({ [PAIR]: entry(140) }) });
    // Devices aren't listed at boot (Audio settings was never opened); the upload lists them.
    const offset = await record(env);
    if (offset !== "-140") fail(`synced take sent offset_ms ${offset}`);
    if (env.app.currentDevicePairKey() !== PAIR) fail(`pair key ${env.app.currentDevicePairKey()}`);
    if (env.toasts.join() !== "Take saved") fail(`toasts: ${JSON.stringify(env.toasts)}`);
    console.log("PASS: a synced pair sends offset_ms = -140 and only says 'Take saved'");
  }

  // 2. Unsynced: the slider value as before; the toast asks once per pair per session.
  {
    const env = await boot(HOST);
    const offset = await record(env);
    if (offset !== "35") fail(`unsynced take sent offset_ms ${offset}`);
    await record(env);
    if (JSON.stringify(env.toasts) !== JSON.stringify(["Take saved", SYNC_HINT, "Take saved"])) {
      fail(`host toasts: ${JSON.stringify(env.toasts)}`);
    }
    if (env.w.sessionStorage.getItem(`dubmate_mic_sync_asked:${PAIR}`) !== "1") fail("asked flag not kept for the tab session");
    env.app.audioSetup.inputId = "usb2";
    await record(env);
    if (env.toasts[4] !== SYNC_HINT) fail(`a new pair was not asked: ${JSON.stringify(env.toasts)}`);
    console.log("PASS: unsynced takes keep the slider value; the sync hint shows once per pair per session");
  }

  // 3. The host's engine config fills an empty browser store, which then keeps a copy.
  {
    const env = await boot(HOST, { engineMicSync: { [PAIR]: entry(140) } });
    if (!env.calls.some((c) => c.url === "/api/config" && c.method === "GET")) fail("host did not read the engine config");
    const offset = await record(env);
    if (offset !== "-140") fail(`engine fallback sent offset_ms ${offset}`);
    const kept = JSON.parse(env.w.localStorage.getItem("dubmate_mic_sync") || "{}");
    if (!kept[PAIR] || kept[PAIR].latency_ms !== 140) fail(`not copied to localStorage: ${JSON.stringify(kept)}`);
    if (env.toasts.join() !== "Take saved") fail(`toasts: ${JSON.stringify(env.toasts)}`);
    console.log("PASS: the host's engine config is used when the browser has no sync, and copied into it");
  }

  // 4. A guest never uses the host's engine config and never gets the toast.
  {
    const env = await boot(GUEST, { engineMicSync: { [PAIR]: entry(140) } });
    if (env.app.engineMicSync) fail("guest picked up the host's engine config");
    const offset = await record(env);
    if (offset !== "35") fail(`guest take sent offset_ms ${offset}`);
    await record(env);
    if (env.toasts.some((t) => t === SYNC_HINT)) fail(`guest got the sync hint: ${JSON.stringify(env.toasts)}`);
    console.log("PASS: a guest keeps the slider value and never sees the sync hint");
  }

  // 5. An unreadable stored value counts as not synced.
  for (const stored of ["{not json", "[1,2]", JSON.stringify({ [PAIR]: { latency_ms: "140", method: "clicks" } }),
    JSON.stringify({ [PAIR]: entry(900) })]) {
    const env = await boot(HOST, { stored });
    const offset = await record(env);
    if (offset !== "35") fail(`unreadable value ${stored} sent offset_ms ${offset}`);
    if (env.toasts[1] !== SYNC_HINT) fail(`unreadable value ${stored} was not treated as unsynced`);
  }
  console.log("PASS: an unreadable stored value counts as not synced");

  // 6. Saving a sync: snapped, kept in the browser, and on the host also in the engine config.
  {
    const env = await boot(HOST);
    await env.app.updateAudioDeviceList();
    const before = env.calls.length;
    const saved = await env.app.saveMicSync(137, "claps");
    if (saved.latency_ms !== 135 || saved.method !== "claps" || typeof saved.measured_at !== "number") {
      fail(`saved entry ${JSON.stringify(saved)}`);
    }
    const kept = JSON.parse(env.w.localStorage.getItem("dubmate_mic_sync"));
    if (kept[PAIR].latency_ms !== 135) fail(`localStorage: ${JSON.stringify(kept)}`);
    const post = env.calls.slice(before).find((c) => c.url === "/api/config" && c.method === "POST");
    if (!post) fail("host sync not sent to the engine config");
    const body = JSON.parse(post.body);
    if (JSON.stringify(Object.keys(body)) !== '["mic_sync"]' || body.mic_sync[PAIR].latency_ms !== 135) {
      fail(`POST body ${post.body}`);
    }
    if (env.app.currentLatencyMs() !== 135) fail(`currentLatencyMs ${env.app.currentLatencyMs()}`);
    const offset = await record(env);
    if (offset !== "-135") fail(`take after sync sent offset_ms ${offset}`);

    // A failing engine only warns.
    env.w.fetch = () => Promise.reject(new Error("offline"));
    const again = await env.app.saveMicSync(2000, "clicks");
    if (again.latency_ms !== 800) fail(`not capped at 800: ${again.latency_ms}`);
    if (!env.warnings.some((m) => /mic sync/.test(m))) fail("engine failure not warned");

    const guest = await boot(GUEST);
    await guest.app.updateAudioDeviceList();
    const guestBefore = guest.calls.length;
    await guest.app.saveMicSync(140, "clicks");
    if (guest.calls.slice(guestBefore).some((c) => c.url.startsWith("/api/config"))) fail("guest wrote the engine config");
    if (guest.app.currentLatencyMs() !== 140) fail("guest sync not kept in the browser");
    console.log("PASS: a sync is snapped and kept; the host also keeps it in the engine config");
  }

  console.log("ALL MIC SYNC STORAGE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
