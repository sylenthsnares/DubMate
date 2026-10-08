/**
 * test_premiere_renders.js
 *
 * The live premiere plays the engine's renders (documentation/design/effects-rack.md,
 * "Export, render, premiere and project ZIP"): before the exported video is ready, each
 * picked take is fetched once through POST .../render with its resolved chain and scheduled
 * at its offset with its level plus dialogue presence (clamped like the export's). A take
 * with no render (503) plays as recorded, a line without a take plays its original voice,
 * and no browser effect node is ever created.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "chain_resolution.json"), "utf8"));

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b) => Math.abs(a - b) < 1e-9;
const db = (x) => Math.pow(10, x / 20);

(async () => {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
  const { JSDOM, VirtualConsole } = jsdom;
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.scrollTo = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [], addEventListener: () => {} } });

  // A recorded AudioContext: every node it makes, and any effect node it is asked for.
  const created = [];
  const effectNodes = [];
  class MockAudioContext {
    constructor() {
      this.currentTime = 10;
      this.sampleRate = 48000;
      this.state = "running";
      this.destination = { kind: "destination" };
    }
    resume() { return Promise.resolve(); }
    createGain() {
      const node = { kind: "gain", out: [], connect(n) { this.out.push(n); }, disconnect() {},
        gain: { value: 1, setValueAtTime(v) { this.value = v; } } };
      created.push(node);
      return node;
    }
    createBufferSource() {
      const node = { kind: "source", buffer: null, out: [], starts: [], connect(n) { this.out.push(n); },
        disconnect() {}, start(when, offset) { this.starts.push([when, offset]); }, stop() {} };
      created.push(node);
      return node;
    }
    createConvolver() { effectNodes.push("ConvolverNode"); return { connect() {}, disconnect() {} }; }
    createBiquadFilter() { effectNodes.push("BiquadFilterNode"); return { frequency: {}, Q: {}, connect() {}, disconnect() {} }; }
    createDynamicsCompressor() { effectNodes.push("DynamicsCompressorNode"); return { connect() {}, disconnect() {} }; }
    createWaveShaper() { effectNodes.push("WaveShaperNode"); return { connect() {}, disconnect() {} }; }
  }
  w.AudioContext = MockAudioContext;

  const calls = [];
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u === "/api/rooms/R1/lines/t1000/takes/k1/render") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/00000000000000a1.wav", key: "00000000000000a1", duration: 2 }) });
    }
    if (u === "/api/rooms/R1/lines/t4000/takes/k2/render") {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ effects_unavailable: true, message: "Download and install the latest DubMate to use voice effects." }) });
    }
    if (u.startsWith("/api/rooms/R1/export?")) {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "held for the test" }) });
    }
    const body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(buildStudioBundle());
  await tick(20);
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  app.showToast = () => {};
  app.user = { id: "u1", name: "Ana" };
  const sent = [];
  app.socket.send = (type, payload) => sent.push({ type, payload });
  app.screeningVideo.play = () => Promise.resolve();
  app.screeningVideo.pause = () => {};
  const loaded = [];
  app.audio.loadAudioBuffer = (url) => { loaded.push(url); return Promise.resolve({ duration: 2, url }); };

  const lines = [
    { line_id: "t1000", index: 0, character: "Ana", start: 1, end: 3, duration: 2, peaks: [], audio_url: "/orig0.wav", text: "Hi" },
    { line_id: "t4000", index: 1, character: "Ben", start: 4, end: 6, duration: 2, peaks: [], audio_url: "/orig1.wav", text: "Yo" },
    { line_id: "t6000", index: 2, character: "Ana", start: 6, end: 8, duration: 2, peaks: [], audio_url: "/orig2.wav", text: "Bye" },
  ];
  const take1 = { take_id: "k1", number: 1, user_id: "u1", duration: 2, peaks: [], url: "/api/rooms/R1/lines/t1000/takes/k1/audio?v=1",
    offset_ms: -40, gain_db: 30, chain: FIXTURE.presets.radio };
  const take2 = { take_id: "k2", number: 1, user_id: "u1", duration: 2, peaks: [], url: "/api/rooms/R1/lines/t4000/takes/k2/audio?v=1",
    offset_ms: 100, gain_db: -6 };
  app.roomState = {
    state_version: 3, room_id: "R1", host_id: "u1", users: {}, role_assignments: {},
    voice: { session: null, characters: { Ben: FIXTURE.presets.monster } },
    pack: { id: "P", lines, characters: ["Ana", "Ben"], video_url: "/v.mp4" },
    takes: {
      t1000: { picked: "k1", next_number: 2, takes: [take1] },
      t4000: { picked: "k2", next_number: 2, takes: [take2] },
    },
    master_dialogue_presence_db: 3,
  };
  app.masterDialoguePresence = 3;
  app.isUsingExportedVideo = false;

  await app.startScreeningPlayback(0.5);
  await tick(10);

  // One render request per picked take, each with its resolved chain.
  const renders = calls.filter((c) => /\/render$/.test(c.url));
  if (renders.length !== 2) fail(`render requests: ${JSON.stringify(renders.map((r) => r.url))}`);
  const byUrl = Object.fromEntries(renders.map((r) => [r.url, JSON.parse(r.body)]));
  const b1 = byUrl["/api/rooms/R1/lines/t1000/takes/k1/render"];
  const b2 = byUrl["/api/rooms/R1/lines/t4000/takes/k2/render"];
  if (!b1 || !same(b1.chain, FIXTURE.presets.radio) || !b1.client_id) fail(`take's own chain: ${JSON.stringify(b1)}`);
  if (!b2 || !same(b2.chain, FIXTURE.presets.monster)) fail(`character's chain: ${JSON.stringify(b2)}`);
  if (loaded.includes(take1.url)) fail("the raw take was loaded although its render arrived");
  console.log("PASS: the premiere asks for one render per picked take with its resolved chain");

  // Scheduled at their offsets, each through its own clamped level into the vocal bus.
  const sources = created.filter((n) => n.kind === "source");
  const playing = (url) => sources.find((s) => s.buffer && s.buffer.url === url);
  const start = 10.005;
  const expect = [
    ["/api/rooms/R1/renders/00000000000000a1.wav", start + (1 - 0.04 - 0.5), db(24)],   // 30 + 3 dB clamps to +24
    [take2.url, start + (4 + 0.1 - 0.5), db(-6 + 3)],                                   // 503: as recorded
    ["/orig2.wav", start + (6 - 0.5), db(3)],                                           // no take: original voice
  ];
  for (const [url, when, gain] of expect) {
    const src = playing(url);
    if (!src || src.starts.length !== 1 || !close(src.starts[0][0], when) || src.starts[0][1] !== 0) fail(`${url} start: ${JSON.stringify(src && src.starts)}`);
    const level = src.out[0];
    if (!level || level.kind !== "gain" || !close(level.gain.value, gain)) fail(`${url} level: ${level && level.gain.value}`);
    if (level.out[0] !== app.screeningVocalGainNode) fail(`${url} not on the vocal bus`);
  }
  if (sources.length !== 3) fail(`${sources.length} sources played`);
  if (!close(app.screeningVocalGainNode.gain.value, 0.95)) fail(`vocal bus ${app.screeningVocalGainNode.gain.value} (presence belongs to each line)`);
  if (effectNodes.length) fail(`browser effect nodes created: ${effectNodes}`);
  console.log("PASS: renders play at their offsets with the clamped level; no browser effect nodes");

  // Presence moved while it plays: each line's level follows, still clamped.
  app.setMasterDialoguePresence(0);
  const lvl = (url) => playing(url).out[0].gain.value;
  if (!close(lvl("/api/rooms/R1/renders/00000000000000a1.wav"), db(24)) || !close(lvl(take2.url), db(-6)) || !close(lvl("/orig2.wav"), 1)) {
    fail("levels after presence change");
  }
  if (!sent.some((m) => m.type === "set_dialogue_presence")) fail("presence not sent");

  // Playing again reuses the render; the unavailable one is asked for again.
  app.audio.stopAllPlayback();
  const before = calls.length;
  await app.startScreeningPlayback(0);
  await tick(10);
  const again = calls.slice(before).filter((c) => /\/render$/.test(c.url)).map((c) => c.url);
  if (!same(again, ["/api/rooms/R1/lines/t4000/takes/k2/render"])) fail(`renders on replay: ${JSON.stringify(again)}`);
  if (effectNodes.length) fail(`browser effect nodes created: ${effectNodes}`);
  console.log("PASS: presence follows live; a replay reuses renders and retries the unavailable one");

  // A member's presence and Start stay on their own page: the engine refuses them anyway.
  app.user = { id: "u2", name: "Ben" };
  sent.length = 0;
  app.setMasterDialoguePresence(-3);
  app.btnStartSession.click();
  if (sent.some((m) => m.type === "set_dialogue_presence" || m.type === "set_status")) {
    fail(`a member sent host-only messages: ${JSON.stringify(sent)}`);
  }
  app.user = { id: "u1", name: "Ana" };
  sent.length = 0;
  app.showView("lobby");
  app.btnStartSession.click();
  if (!sent.some((m) => m.type === "set_status" && m.payload.status === "recording")) fail("the host's Start did not move the room");
  console.log("PASS: a member's presence and Start are not sent to the room; the host's are");

  // The Mix slider is the room's: the host's change drops the stale final video for the live
  // mix, reaches the room, and the export asks for the same balance.
  app.showView("screening");
  app.isUsingExportedVideo = true;
  app.roomState.has_export = true;
  sent.length = 0;
  const slider = app.sliderScreeningBalance;
  slider.value = "80";
  slider.dispatchEvent(new w.Event("input", { bubbles: true }));
  if (!sent.some((m) => m.type === "set_mix_balance" && m.payload.balance === 80)) fail(`mix not sent: ${JSON.stringify(sent)}`);
  if (app.isUsingExportedVideo || app.roomState.has_export) fail("the old final video still plays after the mix changed");
  if (!app.screeningVideo.muted) fail("the theater did not switch to the live mix");
  const failures = [];
  app.failExport = (e) => failures.push(e);
  const before2 = calls.length;
  await app.exportFinalVideo("16:9");
  const exportCall = calls.slice(before2).find((c) => c.url.startsWith("/api/rooms/R1/export?"));
  if (!exportCall) fail("no export request");
  const params = new w.URL(exportCall.url, "http://x").searchParams;
  if (params.get("balance") !== "80" || params.get("user_id") !== "u1") fail(`export request: ${exportCall.url}`);

  // Another client's change (or the room's state on arrival) moves this slider, sends nothing.
  sent.length = 0;
  app.isUsingExportedVideo = true;
  app.socket.emit("mix_balance_sync", { type: "mix_balance_sync", payload: { balance: 20 } });
  if (app.screeningBalance !== 20 || slider.value !== "20") fail(`synced balance: ${app.screeningBalance} / ${slider.value}`);
  if (app.isUsingExportedVideo) fail("a synced mix change kept the old final video");
  if (sent.length) fail(`a synced change was sent back: ${JSON.stringify(sent)}`);
  app.roomState.master_mix_balance = 35;
  await app.setupScreeningView();
  if (app.screeningBalance !== 35) fail(`arrival balance: ${app.screeningBalance}`);
  console.log("PASS: the Mix slider is the room's, drops the stale final video and reaches the export");

  if (errors.length) fail(`console errors: ${errors.join("\n")}`);
  console.log("ALL PREMIERE RENDER TESTS PASSED");
  process.exit(0);
})();
