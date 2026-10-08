/**
 * test_handoff_devices.js
 *
 * A member who joins a host's room from their own DubMate carries the labels of
 * their microphone and headphones (dubmate_audio_handoff). Device ids differ on
 * the host's origin, so the studio picks the devices by label once the browser
 * lists labels, then forgets the pending choice. A member whose setup is done
 * but who hasn't allowed the mic on this origin is asked before the count-in,
 * and the take still opens its own fresh stream.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const PAGE_URL = "https://abc.trycloudflare.com/";
const PAIR = "Mic X|Phones";
const LABELLED = [
  { kind: "audioinput", deviceId: "default", label: "Default", groupId: "a" },
  { kind: "audioinput", deviceId: "tun-in-2", label: "Mic X", groupId: "b" },
  { kind: "audiooutput", deviceId: "tun-out-2", label: "Phones", groupId: "b" },
];
const UNLABELLED = LABELLED.map((d) => ({ ...d, label: "" }));
const HANDOFF = JSON.stringify({ input_label: "Mic X", output_label: "Phones" });

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/**
 * `env.permission` is what permissions.query reports, `env.devices` what
 * enumerateDevices lists and `env.gum` runs on each getUserMedia call; all can change mid-test.
 */
async function boot({ storage = {}, env }) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, {
    url: PAGE_URL,
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    },
  });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.HTMLMediaElement.prototype.setSinkId = async function (id) { this._sink = id; };
  const sinkCalls = [];
  w.AudioContext = class {
    constructor() { this.state = "running"; }
    setSinkId(id) { sinkCalls.push(id); return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, connect: () => {}, disconnect: () => {}, getByteTimeDomainData: () => {}, getFloatTimeDomainData: () => {} }; }
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} }; }
    createConvolver() { return { connect: () => {} }; }
  };
  w.MediaRecorder = class {
    constructor(stream) { this.stream = stream; this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
    static isTypeSupported() { return false; }
  };
  w.scrollTo = () => {};
  const gumCalls = [];
  const streams = [];
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => env.devices,
      getUserMedia: async (constraints) => {
        gumCalls.push(constraints);
        if (env.gum) env.gum();
        const track = { readyState: "live", stopped: false, stop() { this.stopped = true; this.readyState = "ended"; } };
        const stream = { getTracks: () => [track], getAudioTracks: () => [track], track };
        streams.push(stream);
        return stream;
      },
    },
  });
  Object.defineProperty(w.navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: env.permission }) },
  });
  w.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input) => {
    const u = String(input || "");
    if (u === "/health") return json(200, { status: "ok", version: "1.2.0" });
    if (u.startsWith("/api/packs")) return json(200, []);
    return json(200, {});
  };
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  const stored = (key) => w.localStorage.getItem(key);
  return { w, app, stored, sinkCalls, gumCalls, streams };
}

const memberStorage = () => ({
  dubmate_user: JSON.stringify({ id: "u_t", name: "Ana", color: "#123abc" }),
  dubmate_audio_setup_done: "1",
  dubmate_mic_sync: JSON.stringify({ [PAIR]: { latency_ms: 85, method: "clicks", measured_at: 1000 } }),
  dubmate_audio_handoff: HANDOFF,
});

(async () => {
  // 1. Mic already allowed on this origin: picked by label while the page boots.
  {
    const env = { permission: "granted", devices: LABELLED };
    const { app, stored } = await boot({ storage: memberStorage(), env });
    if (app.audioSetup.inputId !== "tun-in-2" || app.audioSetup.outputId !== "tun-out-2") fail(`devices on boot: ${app.audioSetup.inputId} / ${app.audioSetup.outputId}`);
    if (app.audio.preferredInputId !== "tun-in-2" || app.audio.preferredOutputId !== "tun-out-2") fail("engine not pointed at the chosen devices");
    if (stored("dubmate_audio_input_device") !== "tun-in-2" || stored("dubmate_audio_output_device") !== "tun-out-2") fail("choice not remembered");
    if (app.currentDevicePairKey() !== PAIR || app.currentLatencyMs() === null) fail(`carried mic sync not found: ${app.currentDevicePairKey()}`);
    if (stored("dubmate_audio_handoff") !== null) fail("pending choice kept after it was applied");
    console.log("PASS: on boot with the mic allowed, the member's mic and headphones are picked by label and the mic sync applies");
  }

  // 2. An unlabelled list keeps the choice pending; a labelled list applies it, output included.
  {
    const env = { permission: "prompt", devices: UNLABELLED };
    const { app, stored, sinkCalls } = await boot({ storage: memberStorage(), env });
    app.audio.initContext();
    await app.refreshAudioDevices();
    if (stored("dubmate_audio_handoff") !== HANDOFF) fail("pending choice dropped before labels were visible");
    if (app.audioSetup.inputId || app.audioSetup.outputId) fail("a device was chosen without labels");
    env.devices = LABELLED;
    await app.refreshAudioDevices();
    if (app.audioSetup.inputId !== "tun-in-2" || app.audioSetup.outputId !== "tun-out-2") fail("not picked after labels appeared");
    if (sinkCalls[sinkCalls.length - 1] !== "tun-out-2") fail(`playback not routed to the headphones: ${JSON.stringify(sinkCalls)}`);
    if (app.selectAudioInput && app.selectAudioInput.value !== "tun-in-2") fail(`input picker shows ${app.selectAudioInput.value}`);
    if (stored("dubmate_audio_handoff") !== null) fail("pending choice kept");
    console.log("PASS: the choice waits for device names, then picks and routes the member's devices");
  }

  // 3. No device with that name: defaults kept, choice dropped.
  {
    const env = { permission: "granted", devices: [{ kind: "audioinput", deviceId: "x", label: "Laptop mic", groupId: "c" }] };
    const { app, stored } = await boot({ storage: memberStorage(), env });
    if (app.audioSetup.inputId || app.audioSetup.outputId || app.audio.preferredInputId) fail("a device was chosen with no match");
    if (stored("dubmate_audio_handoff") !== null) fail("pending choice kept with no match");
    console.log("PASS: no matching device keeps the system default and drops the pending choice");
  }

  // 4. Setup done elsewhere, mic not yet allowed here: asked before the count-in, released, the take reopens.
  {
    const env = { permission: "prompt", devices: UNLABELLED };
    env.gum = () => { env.permission = "granted"; env.devices = LABELLED; };
    const { app, stored, gumCalls, streams } = await boot({ storage: memberStorage(), env });
    if (gumCalls.length) fail("mic opened on boot");
    const ok = await app.ensureMicReady();
    if (ok !== true) fail(`ensureMicReady returned ${ok}`);
    if (gumCalls.length !== 1) fail(`mic not asked for before the count-in: ${gumCalls.length} calls`);
    if (!streams[0].track.stopped || app.audio.stream !== null) fail("the permission stream was kept open");
    if (app.audioSetup.permission !== "granted") fail("permission not recorded");
    if (app.audioSetup.inputId !== "tun-in-2" || stored("dubmate_audio_handoff") !== null) fail("devices not picked after the mic was allowed");
    await app.audio.startRecording();
    if (gumCalls.length !== 2 || app.audio.stream !== streams[1]) fail("the take did not open its own fresh stream");
    console.log("PASS: a member is asked for the mic before the count-in and the take opens a fresh stream");
  }

  // 5. Refused: the blocked step opens and the count-in doesn't start.
  {
    const env = { permission: "prompt", devices: UNLABELLED };
    env.gum = () => { const e = new Error("no"); e.name = "NotAllowedError"; throw e; };
    const { app, w } = await boot({ storage: memberStorage(), env });
    const ok = await app.ensureMicReady();
    if (ok !== false) fail(`ensureMicReady returned ${ok} after a refusal`);
    const modal = w.document.getElementById("modal-audio-settings");
    if (modal.style.display !== "flex") fail("Audio settings not opened");
    if (app.audioStepDenied.style.display !== "block") fail("blocked step not shown");
    if (app.audioSetup.permission !== "denied") fail(`permission: ${app.audioSetup.permission}`);
    console.log("PASS: refusing the mic opens the blocked step instead of starting the count-in");
  }

  console.log("ALL HANDOFF DEVICE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
