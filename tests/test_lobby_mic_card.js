/**
 * test_lobby_mic_card.js
 *
 * First-run mic setup lives in the lobby ("Check your mic", studio/mic_card.js), not in a
 * dialog at launch:
 *  - booting the studio opens no Audio settings dialog, and nothing opens the mic,
 *  - the card shows in the lobby for anyone not set up or not synced: "Allow microphone"
 *    (amber for a friend, secondary for the host), then the devices, the level meter and
 *    the sync step,
 *  - the sync step says "take your earbuds out" before "Play clicks", and follows the run
 *    through the one hook in showMicSyncPanel (failures, Try again, Clap instead),
 *  - a blocked mic shows why and "Open Audio settings",
 *  - a run that syncs collapses the card to "Mic set · <mic> · Change"; Skip sync to
 *    "Mic set · not synced", and the booth's mic-sync hint is still offered after a take,
 *  - a member who brought their setup and sync from their own DubMate sees only the line.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const HOST_URL = "http://127.0.0.1:8123/";
const TUNNEL_URL = "https://abc.trycloudflare.com/?room=MIC123&home=http%3A%2F%2F127.0.0.1%3A9000";
const PAIR = "Mic X|Phones";
const LABELLED = [
  { kind: "audioinput", deviceId: "default", label: "Default", groupId: "a" },
  { kind: "audioinput", deviceId: "in-2", label: "Mic X", groupId: "b" },
  { kind: "audiooutput", deviceId: "out-2", label: "Phones", groupId: "b" },
];
const UNLABELLED = LABELLED.map((d) => ({ ...d, label: "" }));
const CLICKS_COPY = "The clicks are loud. Take out your earbuds or headphones and hold them right next to the mic.";
const CLICKS_FAILED_COPY = "DubMate couldn't hear the clicks. Turn your computer's volume up, hold your earbuds closer to the mic and try again.";
const CLAP_COPY = "Put your headphones back on, then clap on each beat you hear.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function pass(msg) {
  console.log("PASS: " + msg);
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function boot({ url = HOST_URL, storage = {}, env }) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    },
  });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.HTMLMediaElement.prototype.setSinkId = async function (id) { this._sink = id; };
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  w.AudioContext = class {
    constructor() { this.state = "running"; this.currentTime = 0; }
    setSinkId() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
    createAnalyser() {
      return {
        fftSize: 2048, connect: () => {}, disconnect: () => {},
        getByteTimeDomainData: () => {},
        getFloatTimeDomainData: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = 0.2 * Math.sin(i / 3); },
      };
    }
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
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => env.devices,
      getUserMedia: async (constraints) => {
        gumCalls.push(constraints);
        if (env.gum) env.gum();
        const track = { readyState: "live", stop() { this.readyState = "ended"; }, getSettings: () => ({}) };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
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
    if (u.startsWith("/api/rooms/MIC123")) return json(200, env.room || {});
    if (u.startsWith("/api/config")) return json(200, {});
    return json(200, {});
  };
  w.eval(bundle);
  await tick(150);
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  const toasts = [];
  app.showToast = (m) => toasts.push(m);
  app.socket.send = () => true;
  app.socket.connect = () => {};
  return { w, doc: w.document, app, gumCalls, toasts };
}

function room(app, { host = false, status = "lobby" } = {}) {
  const me = app.user.id;
  return {
    state_version: 1, room_id: "MIC123", host_id: host ? me : "tani", status,
    pack: {
      id: "P", name: "Rooftop", line_count: 2, characters: ["Mika", "Ren"], duration: 6,
      video_url: "/api/packs/P/video",
      lines: [
        { index: 0, line_id: "a", character: "Mika", start: 1, end: 2.5, caption: "Hello there." },
        { index: 1, line_id: "b", character: "Ren", start: 3, end: 4, caption: "Hi." },
      ],
    },
    users: {
      tani: { id: "tani", name: "Tani", color: "#f08a6c", is_online: true },
      [me]: { id: me, name: "Sam", color: "#b5cf5a", is_online: true },
    },
    role_assignments: { Mika: ["tani"], Ren: [me] },
    takes: {},
  };
}

const $ = (doc, id) => doc.getElementById(id);
// Hidden by its own [hidden] or by a hidden ancestor up to the card.
const visible = (el) => {
  for (let n = el; n; n = n.parentElement) {
    if (n.hidden || (n.style && n.style.display === "none")) return false;
    if (n.id === "view-lobby") break;
  }
  return !!el;
};
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

function enterLobby(app, opts) {
  app.roomState = room(app, opts);
  app.showView("lobby");
}

(async () => {
  // 1. Booting the studio opens no dialog and no mic; the lobby shows the card.
  {
    const env = { permission: "prompt", devices: UNLABELLED };
    const { doc, app, gumCalls } = await boot({ env });
    const modal = $(doc, "modal-audio-settings");
    if (modal.style.display === "flex") fail("Audio settings opened at launch");
    if (app.audioSetup.firstRunMode) fail("first-run mode set at launch");
    if (gumCalls.length) fail("the mic was opened at launch");
    pass("launch opens no Audio settings dialog and no microphone");

    enterLobby(app);
    const card = $(doc, "mic-card");
    if (!card || !visible(card)) fail("no mic card in the lobby");
    if (!card.closest(".lobby-rail")) fail("the mic card is not in the lobby's rail");
    if (text(card.querySelector(".mic-card-title")) !== "Check your mic") fail(`title: ${text(card.querySelector(".mic-card-title"))}`);
    if (text(card.querySelector(".mic-card-lede")) !== "About a minute. Friends can't hear it.") fail(`lede: ${text(card.querySelector(".mic-card-lede"))}`);
    const allow = $(doc, "btn-mic-card-allow");
    if (!visible(allow) || text(allow) !== "Allow microphone") fail("no Allow microphone");
    if (!allow.classList.contains("btn-primary")) fail("a friend's mic card button is not amber");
    if (visible($(doc, "mic-card-done"))) fail("the done line shows before setup");
    if (gumCalls.length) fail("showing the card opened the mic");
    pass("a friend's lobby shows Check your mic with an amber Allow microphone");

    // The host's button is secondary (Start recording is the host's amber).
    app.roomState.host_id = app.user.id;
    app.renderLobbyState();
    if (allow.classList.contains("btn-primary") || !allow.classList.contains("btn-secondary")) fail("the host's mic card button is amber");
    pass("the host's mic card button is secondary");
  }

  // 2. Allow, devices, level, sync; Play clicks; a failure; Clap instead; success.
  {
    const env = { permission: "prompt", devices: UNLABELLED };
    env.gum = () => { env.permission = "granted"; env.devices = LABELLED; };
    const { doc, app, gumCalls } = await boot({ env });
    enterLobby(app);
    $(doc, "btn-mic-card-allow").click();
    await tick(150);
    if (gumCalls.length !== 1) fail(`Allow microphone opened the mic ${gumCalls.length} times`);
    if (app.audioSetup.permission !== "granted" || !app.audioSetup.setupComplete) fail("permission not recorded");
    if (doc.defaultView.localStorage.getItem("dubmate_audio_setup_done") !== "1") fail("setup not remembered");
    if ($(doc, "modal-audio-settings").style.display === "flex") fail("Allow opened the Audio settings dialog");
    const input = $(doc, "mic-card-input");
    if (!visible(input) || !Array.from(input.options).some((o) => o.textContent === "Mic X")) fail("the microphone list is not shown");
    if (visible($(doc, "btn-mic-card-allow"))) fail("Allow stays after the mic is allowed");
    pass("Allow microphone asks once, records the permission and lists the devices");

    input.value = "in-2";
    input.dispatchEvent(new doc.defaultView.Event("change"));
    await tick(30);
    if (app.audioSetup.inputId !== "in-2") fail("choosing a microphone did not apply it");
    pass("choosing a microphone in the card applies it");

    $(doc, "btn-mic-card-devices-next").click();
    await tick(150);
    if (!visible($(doc, "mic-card-meter"))) fail("no level meter");
    // The meter's bands are grey (too quiet), green (good) and red (too loud): no amber zone.
    if (text($(doc, "mic-card-level-hint")) !== "Say your loudest line. Aim for the green band.") fail(`level hint: ${text($(doc, "mic-card-level-hint"))}`);
    if (!app.audio.monitorAnalyser) fail("the card's meter did not open the mic");
    const meterTrack = $(doc, "mic-card-meter");
    const fill = meterTrack.querySelector(".level-meter-fill");
    if (!fill) fail("the card's meter has no bar (.level-meter-fill, styled with Audio settings' meter)");
    await tick(100);
    const width = parseFloat(fill.style.width);
    if (!(width > 0 && width <= 100)) fail(`the meter does not move: ${fill.style.width}`);
    const zones = ["is-quiet", "is-good", "is-loud"].filter((z) => meterTrack.classList.contains(z));
    if (zones.length !== 1) fail(`the meter shows no single zone: ${meterTrack.className}`);
    // The bar is drawn: Audio settings' fill rule positions it inside the track.
    const css = require("fs").readFileSync(require("path").join(__dirname, "..", "static", "css", "style.css"), "utf8");
    const rule = /\.level-meter-fill\s*\{([^}]*)\}/.exec(css);
    if (!rule || !/position:\s*absolute/.test(rule[1]) || !/bottom:\s*0/.test(rule[1])) fail("no drawn .level-meter-fill rule in style.css");
    for (const cls of meterTrack.innerHTML.match(/class="([^"]+)"/g) || []) {
      for (const c of cls.slice(7, -1).split(/\s+/)) {
        if (!new RegExp(`\\.${c}[\\s{.:,]`).test(css)) fail(`the card's meter uses .${c}, which style.css never styles`);
      }
    }
    pass("the level step runs its own meter, drawn in the meter's zones");

    $(doc, "btn-mic-card-level-next").click();
    await tick(30);
    const copy = $(doc, "mic-card-sync-copy");
    const clicks = $(doc, "btn-mic-card-clicks");
    if (!visible(copy) || text(copy) !== CLICKS_COPY) fail(`earbuds copy: ${text(copy)}`);
    if (!visible(clicks) || text(clicks) !== "Play clicks") fail("no Play clicks");
    if (!(copy.compareDocumentPosition(clicks) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)) fail("Play clicks comes before the earbuds copy");
    const skip = $(doc, "btn-mic-card-skip");
    if (!visible(skip) || !skip.classList.contains("btn-link-sm")) fail("Skip sync is not a quiet link");
    pass("the sync step says to take the earbuds out before Play clicks");

    // A run that can't hear the clicks: the card follows mic_sync.js's steps.
    let runs = 0;
    app.runMicSync = async () => {
      runs += 1;
      app.micSyncBusy = true;
      app.showMicSyncPanel("listening");
      if (text(clicks) !== "Listening…" || !clicks.disabled) fail("the card does not show the run");
      app.showMicSyncPanel("clicksFailed");
      // As mic_sync.js does: focus goes to Audio settings' own button, in the closed dialog.
      app.btnStartMicSync?.focus();
      app.micSyncBusy = false;
    };
    clicks.click();
    await tick(30);
    if (runs !== 1) fail("Play clicks did not start a run");
    if (doc.activeElement !== clicks) fail(`focus after a failed run is on ${doc.activeElement?.id || doc.activeElement?.tagName}, not the card's Try again`);
    if (text(copy) !== CLICKS_FAILED_COPY) fail(`failure copy: ${text(copy)}`);
    if (text(clicks) !== "Try again" || clicks.disabled) fail("no Try again after a failed run");
    if (!visible($(doc, "btn-mic-card-clap-instead"))) fail("no Clap instead after a failed run");
    if (!app.audio.monitorAnalyser) fail("the card's meter was not reopened after the run");
    pass("a failed run shows mic_sync's advice, Try again and Clap instead, and reopens the meter");

    $(doc, "btn-mic-card-clap-instead").click();
    await tick(30);
    if (text(copy) !== CLAP_COPY || !visible($(doc, "btn-mic-card-clapping")) || visible(clicks)) fail("Clap instead did not show the clap step");
    pass("Clap instead shows the clap step");

    // A run that syncs: the card collapses to its line.
    app.runClapSync = async () => {
      await app.saveMicSync(80, "claps");
      app.showMicSyncPanel(null);
    };
    $(doc, "btn-mic-card-clapping").click();
    await tick(50);
    const done = $(doc, "mic-card-done");
    if (!visible(done) || visible($(doc, "mic-card-steps"))) fail("the card did not collapse after syncing");
    if (!/^Mic set · Mic X · Change$/.test(text(done))) fail(`done line: ${text(done)}`);
    if (app.audio.monitorAnalyser) fail("the card's meter kept the mic open after it collapsed");
    $(doc, "btn-mic-card-change").click();
    await tick(50);
    if ($(doc, "modal-audio-settings").style.display !== "flex") fail("Change did not open Audio settings");
    pass("a synced mic collapses to 'Mic set · Mic X · Change', and Change opens Audio settings");
  }

  // 3. Skip sync: "Mic set · not synced", and the booth still offers to sync after a take.
  {
    const env = { permission: "granted", devices: LABELLED };
    const { doc, app } = await boot({ env });
    enterLobby(app, { host: true });
    if (visible($(doc, "btn-mic-card-allow"))) fail("Allow shows with the mic already allowed");
    if (!visible($(doc, "mic-card-input"))) fail("an allowed but unsynced mic does not start at the devices");
    $(doc, "btn-mic-card-devices-next").click();
    await tick(30);
    $(doc, "btn-mic-card-level-next").click();
    await tick(30);
    $(doc, "btn-mic-card-skip").click();
    await tick(30);
    if (text($(doc, "mic-card-done")) !== "Mic set · not synced · Change") fail(`skipped line: ${text($(doc, "mic-card-done"))}`);
    if (app.audio.monitorAnalyser) fail("skipping kept the mic open");
    if (!app.shouldOfferMicSync()) fail("the booth no longer offers to sync after skipping");
    app.showMicSyncHint();
    if ($(doc, "mic-sync-hint").hidden) fail("the booth's mic-sync hint does not show");
    pass("Skip sync collapses to 'Mic set · not synced' and the booth's hint still shows after a take");

    // Leaving the lobby stops nothing it didn't start; a new lobby visit keeps the line.
    app.showView("booth");
    app.showView("lobby");
    if (text($(doc, "mic-card-done")) !== "Mic set · not synced · Change") fail("the skipped state was forgotten");
    pass("the skipped state holds for this visit");
  }

  // 4. Blocked: the reason and Open Audio settings.
  {
    const env = { permission: "prompt", devices: UNLABELLED };
    env.gum = () => { const e = new Error("no"); e.name = "NotAllowedError"; throw e; };
    const { doc, app } = await boot({ env });
    enterLobby(app);
    $(doc, "btn-mic-card-allow").click();
    await tick(100);
    const err = $(doc, "mic-card-error");
    if (!visible(err) || text(err) !== "DubMate isn't allowed to use your microphone. Allow it, then try again.") fail(`blocked text: ${text(err)}`);
    const open = $(doc, "btn-mic-card-settings");
    if (!visible(open) || text(open) !== "Open Audio settings") fail("no Open Audio settings");
    if (app.audioSetup.permission !== "denied") fail(`permission: ${app.audioSetup.permission}`);
    open.click();
    await tick(50);
    if ($(doc, "modal-audio-settings").style.display !== "flex") fail("Open Audio settings did not open it");
    pass("a blocked mic says why and offers Open Audio settings");
  }

  // 5. A member who brought setup and sync from their own DubMate sees only the line.
  {
    const env = { permission: "granted", devices: LABELLED };
    const storage = {
      dubmate_user: JSON.stringify({ id: "u_m", name: "Ana", color: "#7d9cf0" }),
      dubmate_audio_setup_done: "1",
      dubmate_audio_input_device: "in-2",
      dubmate_audio_output_device: "out-2",
      dubmate_mic_sync: JSON.stringify({ [PAIR]: { latency_ms: 85, method: "clicks", measured_at: 1000 } }),
    };
    const { doc, app, gumCalls } = await boot({ url: TUNNEL_URL, storage, env });
    enterLobby(app);
    await tick(50);
    if (visible($(doc, "mic-card-steps"))) fail("a synced member sees the setup steps");
    if (text($(doc, "mic-card-done")) !== "Mic set · Mic X · Change") fail(`member line: ${text($(doc, "mic-card-done"))}`);
    if (gumCalls.length) fail("the member's mic was opened");
    pass("a member with setup and sync from their own DubMate sees only 'Mic set · Mic X · Change'");
  }

  // 6. Setup done, but the browser can't say whether the mic is allowed (Firefox, some WebViews).
  {
    const env = { permission: "unknown", devices: LABELLED };
    const { doc, app } = await boot({ storage: { dubmate_audio_setup_done: "1" }, env });
    enterLobby(app);
    await tick(50);
    if (visible($(doc, "btn-mic-card-allow"))) fail("a finished setup asks to Allow microphone again");
    if (!visible($(doc, "mic-card-input"))) fail("a finished but unsynced setup does not start at the devices");
    pass("a finished setup with an unknown permission goes on to the devices, not Allow microphone");
  }

  console.log("ALL LOBBY MIC CARD TESTS PASSED");
  process.exit(0);
})().catch((e) => fail(e && e.stack || String(e)));
