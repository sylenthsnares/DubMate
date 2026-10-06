/**
 * test_voice_preview.js
 *
 * The booth plays the engine's renders (documentation/design/effects-rack.md, "Optimistic
 * preview"): static/js/studio/voice.js (resolveChain against the shared fixture, the
 * preset label, the Tone curve, the level gain and the render scheduler's debounce,
 * stale drop, 409, 503 and playhead-first with fake timers), AudioEngine.crossfadeTo
 * (equal-power ramps, the prefix hand-back) on a recorded mock AudioContext, and the
 * booth: Preview waits for the take's render and plays it, and without voice effects
 * plays the take as recorded with the effect controls off and the message shown.
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

/** The studio's modules (no DOM needed for voice.js and the AudioEngine class). */
function loadModules(entry) {
  const code = buildStudioBundle(entry).replace(/\}\)\(\);\s*$/, "return __mods;\n})();");
  return new Function("return " + code)();
}
const mods = loadModules("static/js/audio_engine.js");
const V = mods["static/js/studio/voice.js"];
const { AudioEngine } = mods["static/js/audio_engine.js"];

// --- Fake timers and clock for the scheduler ---
function fakeClock() {
  const clock = { t: 0, timers: new Map(), next: 1 };
  clock.now = () => clock.t;
  clock.setTimer = (fn, ms) => { const id = clock.next++; clock.timers.set(id, { fn, at: clock.t + ms }); return id; };
  clock.clearTimer = (id) => clock.timers.delete(id);
  clock.advance = async (ms) => {
    clock.t += ms;
    for (const [id, timer] of [...clock.timers]) {
      if (timer.at <= clock.t) { clock.timers.delete(id); timer.fn(); }
    }
    await tick();
  };
  return clock;
}

/** A scheduler whose requests wait until the test answers them. */
function harness(options = {}) {
  const clock = fakeClock();
  const requests = [];
  const ready = [];
  const states = [];
  const scheduler = V.createRenderScheduler({
    request: (chain, { untilS }) => new Promise((resolve, reject) => requests.push({ chain, untilS, resolve, reject })),
    onReady: (render) => ready.push(render),
    onState: (state) => states.push(state),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...options,
  });
  return { clock, requests, ready, states, scheduler };
}

const chainA = { v: 1, preset: null, nodes: { pitch: { on: true, mix: 1, semitones: 2 } } };
const chainB = { v: 1, preset: null, nodes: { pitch: { on: true, mix: 1, semitones: 5 } } };

(async () => {
  // 1. resolveChain against the fixture shared with the engine's resolve_chain.
  {
    const P = FIXTURE.presets;
    const chain = (value) => (typeof value === "string" ? P[value] : value);
    if (!same(V.CLEAN_CHAIN, P.clean)) fail("voice.js CLEAN_CHAIN is not the engine's Clean");
    for (const c of FIXTURE.cases) {
      let voice = c.voice;
      if (voice) {
        voice = { session: chain(voice.session), characters: Object.fromEntries(Object.entries(voice.characters).map(([k, v]) => [k, chain(v)])) };
      }
      const take = c.take && "chain" in c.take ? { ...c.take, chain: chain(c.take.chain) } : c.take;
      const got = V.resolveChain(voice, c.character, take);
      if (!same(got, chain(c.expect))) fail(`resolveChain: ${c.name}: ${JSON.stringify(got)}`);
    }
    const voice = { session: P.radio, characters: {} };
    V.resolveChain(voice, null, null).nodes.lowcut.hz = 41;
    if (P.radio.nodes.lowcut.hz !== 300) fail("resolveChain returned the room's chain itself, not a copy");
    console.log(`PASS: resolveChain matches the engine on all ${FIXTURE.cases.length} fixture cases`);
  }

  // 2. Label, edit, level and the Tone curve.
  {
    const presets = Object.entries(FIXTURE.presets).map(([id, c]) => ({ id, name: id[0].toUpperCase() + id.slice(1), chain: c }));
    if (V.presetLabel(FIXTURE.presets.warm, presets) !== "Warm") fail("presetLabel of Warm");
    if (V.presetLabel(chainA, presets) !== "Custom" || V.presetLabel(null, presets) !== "Custom") fail("presetLabel of a custom chain");
    const edited = V.editChain(FIXTURE.presets.warm, "pitch", { on: true, semitones: 3 });
    if (edited.preset !== null || edited.nodes.pitch.semitones !== 3 || edited.nodes.pitch.mix !== 1
        || FIXTURE.presets.warm.nodes.pitch.on !== false || edited.nodes.reverb.mix !== 0.12) fail(`editChain: ${JSON.stringify(edited)}`);
    if (!same(V.editChain(chainA, "lowcut", { on: false }).nodes.lowcut, { on: false, mix: 1, hz: 80 })) fail("editChain fills a missing node from Clean");

    const close = (a, b, tol) => Math.abs(a - b) <= tol;
    if (!close(V.levelGain(-6), Math.pow(10, -6 / 20), 1e-12) || V.levelGain(0) !== 1) fail("levelGain");
    if (!close(V.levelGain(40), Math.pow(10, 24 / 20), 1e-9) || !close(V.levelGain(-90), Math.pow(10, -60 / 20), 1e-12)) fail("levelGain clamp");
    if (V.levelGain("x") !== 1 || V.levelGain(NaN) !== 1) fail("levelGain of junk");

    const freqs = [20, 150, 1000, 1500, 6000, 18000];
    if (!V.eqCurveDb({ on: false, low_db: 6 }, freqs).every((d) => d === 0)) fail("eqCurveDb with Tone off");
    const flat = V.eqCurveDb({ on: true, mix: 1, low_db: 0, mid_db: 0, mid_hz: 1500, high_db: 0 }, freqs);
    if (!flat.every((d) => close(d, 0, 1e-9))) fail(`flat Tone: ${flat}`);
    const [lo20, , lo1k] = V.eqCurveDb({ on: true, mix: 1, low_db: 6, mid_db: 0, mid_hz: 1500, high_db: 0 }, freqs);
    if (!close(lo20, 6, 0.2) || !close(lo1k, 0, 0.3)) fail(`low shelf: ${lo20} ${lo1k}`);
    const lowAtCorner = V.eqCurveDb({ on: true, mix: 1, low_db: 6, mid_db: 0, mid_hz: 1500, high_db: 0 }, [150])[0];
    if (!close(lowAtCorner, 3, 0.2)) fail(`low shelf at 150 Hz: ${lowAtCorner}`);
    const mid = V.eqCurveDb({ on: true, mix: 1, low_db: 0, mid_db: 5, mid_hz: 1800, high_db: 0 }, [1800, 20]);
    if (!close(mid[0], 5, 1e-6) || !close(mid[1], 0, 0.05)) fail(`mid peak: ${mid}`);
    const high = V.eqCurveDb({ on: true, mix: 1, low_db: 0, mid_db: 0, mid_hz: 1500, high_db: -10 }, [18000, 200]);
    if (!close(high[0], -10, 0.6) || !close(high[1], 0, 0.1)) fail(`high shelf: ${high}`);
    const half = V.eqCurveDb({ on: true, mix: 0.5, low_db: 0, mid_db: 6, mid_hz: 1000, high_db: 0 }, [1000])[0];
    if (!close(half, 20 * Math.log10(1 + 0.5 * (Math.pow(10, 6 / 20) - 1)), 1e-6)) fail(`Tone at half mix: ${half}`);
    console.log("PASS: preset label, chain edit, level gain clamp and the Tone curve");
  }

  // 3. Scheduler: debounce, then one request with the newest chain.
  {
    const h = harness();
    h.scheduler.want(chainA, {});
    await h.clock.advance(60);
    h.scheduler.want(chainB, {});
    await h.clock.advance(100);
    if (h.requests.length !== 0 || h.scheduler.state !== "waiting") fail(`debounce: ${h.requests.length} requests, ${h.scheduler.state}`);
    await h.clock.advance(20);
    if (h.requests.length !== 1 || !same(h.requests[0].chain, chainB) || h.requests[0].untilS !== null) fail("debounce did not request the newest chain once");
    if (h.scheduler.state !== "rendering") fail(`state while rendering: ${h.scheduler.state}`);
    h.requests[0].resolve({ status: 200, url: "/r/b.wav", buffer: "B" });
    await tick();
    if (h.ready.length !== 1 || h.ready[0].buffer !== "B" || h.ready[0].partial !== false || !same(h.ready[0].chain, chainB)) fail(`ready: ${JSON.stringify(h.ready)}`);
    if (!same(h.states, ["waiting", "rendering", "current"])) fail(`states: ${h.states}`);
    console.log("PASS: scheduler debounces knob moves into one render of the newest chain");
  }

  // 4. Scheduler: a response for an older want is dropped, in either order.
  {
    for (const order of ["old-first", "new-first"]) {
      const h = harness();
      h.scheduler.want(chainA, {});
      await h.clock.advance(120);
      h.scheduler.want(chainB, {});
      await h.clock.advance(120);
      if (h.requests.length !== 2) fail(`stale: ${h.requests.length} requests`);
      const [a, b] = h.requests;
      if (order === "old-first") { a.resolve({ status: 200, buffer: "A" }); await tick(); }
      if (h.ready.length !== 0) fail(`stale (${order}): an old render was used`);
      b.resolve({ status: 200, buffer: "B" });
      await tick();
      if (order === "new-first") { a.resolve({ status: 200, buffer: "A" }); await tick(); }
      if (h.ready.length !== 1 || h.ready[0].buffer !== "B" || h.scheduler.state !== "current") fail(`stale (${order}): ${JSON.stringify(h.ready)} ${h.scheduler.state}`);
    }
    console.log("PASS: scheduler drops responses for superseded chains");
  }

  // 5. Scheduler: 409 is ignored, a failure ends the wait, 503 is unavailable, dispose stops it.
  {
    let h = harness();
    h.scheduler.want(chainA, {});
    await h.clock.advance(120);
    h.requests[0].resolve({ status: 409, superseded: true });
    await tick();
    if (h.ready.length || h.scheduler.state !== "current") fail(`409: ${h.ready.length} ${h.scheduler.state}`);

    h = harness();
    h.scheduler.want(chainA, {});
    await h.clock.advance(120);
    h.requests[0].reject(new Error("offline"));
    await tick();
    if (h.ready.length || h.scheduler.state !== "current") fail(`failure: ${h.scheduler.state}`);

    h = harness();
    h.scheduler.want(chainA, {});
    await h.clock.advance(120);
    h.requests[0].resolve({ status: 503, message: "Download and install the latest DubMate to use voice effects." });
    await tick();
    if (h.ready.length || h.scheduler.state !== "unavailable") fail(`503: ${h.scheduler.state}`);
    h.scheduler.want(chainB, {});   // effects may have arrived since: it asks again
    await h.clock.advance(120);
    h.requests[1].resolve({ status: 200, buffer: "B" });
    await tick();
    if (h.ready.length !== 1 || h.scheduler.state !== "current") fail(`after 503: ${h.scheduler.state}`);

    h = harness();
    h.scheduler.want(chainA, {});
    h.scheduler.dispose();
    await h.clock.advance(500);
    if (h.requests.length) fail("a disposed scheduler still requested a render");
    h = harness();
    h.scheduler.want(chainA, {});
    await h.clock.advance(120);
    h.scheduler.dispose();
    h.requests[0].resolve({ status: 200, buffer: "A" });
    await tick();
    if (h.ready.length) fail("a disposed scheduler handed over a render");
    console.log("PASS: scheduler ignores 409, recovers from failures, goes unavailable on 503, and stops when disposed");
  }

  // 6. Scheduler: playhead first while playing a take over 4 s, then the whole take.
  {
    const h = harness();
    h.scheduler.want(chainA, { playing: true, playheadS: 3.0, takeDuration: 10 });
    await h.clock.advance(120);
    if (h.requests.length !== 1 || h.requests[0].untilS !== 5.12) fail(`prefix request: ${h.requests.map((r) => r.untilS)}`);
    h.requests[0].resolve({ status: 200, buffer: "prefix" });
    await tick();
    if (h.ready.length !== 1 || h.ready[0].partial !== true || h.ready[0].untilS !== 5.12) fail(`prefix ready: ${JSON.stringify(h.ready)}`);
    if (h.scheduler.state !== "rendering" || h.requests.length !== 2 || h.requests[1].untilS !== null) fail("the whole take wasn't asked for after the prefix");
    h.requests[1].resolve({ status: 200, buffer: "full" });
    await tick();
    if (h.ready.length !== 2 || h.ready[1].partial !== false || h.scheduler.state !== "current") fail("whole render after the prefix");

    // A newer want while the prefix renders: neither stale render is used and no full render follows it.
    const s = harness();
    s.scheduler.want(chainA, { playing: true, playheadS: 1, takeDuration: 8 });
    await s.clock.advance(120);
    s.scheduler.want(chainB, { playing: true, playheadS: 1.2, takeDuration: 8 });
    s.requests[0].resolve({ status: 200, buffer: "old prefix" });
    await s.clock.advance(120);
    if (s.ready.length || s.requests.length !== 2 || !same(s.requests[1].chain, chainB)) fail("stale prefix handled wrong");

    for (const [opts, why] of [
      [{ playing: false, playheadS: 3, takeDuration: 10 }, "not playing"],
      [{ playing: true, playheadS: 1, takeDuration: 4 }, "a 4 s take"],
      [{ playing: true, playheadS: 8.5, takeDuration: 10 }, "the playhead near the end"],
    ]) {
      const n = harness();
      n.scheduler.want(chainA, opts);
      await n.clock.advance(120);
      if (n.requests.length !== 1 || n.requests[0].untilS !== null) fail(`whole render only with ${why}: ${n.requests.map((r) => r.untilS)}`);
    }
    console.log("PASS: scheduler renders the 2 s after the playhead first while playing, then the whole take");
  }

  // 7. AudioEngine.crossfadeTo on a recorded AudioContext.
  {
    const events = [];
    const param = (name, value) => ({
      value,
      setValueAtTime(v, t) { events.push({ name, type: "set", v, t }); },
      setValueCurveAtTime(curve, t, d) { events.push({ name, type: "curve", curve: Array.from(curve), t, d }); },
      cancelScheduledValues(t) { events.push({ name, type: "cancel", t }); },
    });
    let nodeId = 0;
    const sources = [];
    const ctx = {
      currentTime: 0,
      destination: {},
      createGain() { const id = `g${++nodeId}`; return { id, gain: param(id, 1), connect() {}, disconnect() {} }; },
      createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {} }; },
      createBufferSource() {
        const src = { buffer: null, starts: [], stops: [], onended: null, connect() {}, disconnect() {},
          start(when, offset) { this.starts.push([when, offset]); }, stop(when) { this.stops.push(when); } };
        sources.push(src);
        return src;
      },
    };
    const audio = new AudioEngine();
    audio.ctx = ctx;
    const buf = (name, duration) => ({ name, duration });
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    const full1 = buf("full1", 10);
    audio.previewTakeIsolated({ takeBuffer: full1, lineStartSec: 0, offsetMs: 0, gainDb: -6 });
    const tv = audio.takeVoice;
    if (!tv || !close(tv.origin, 0.005) || tv.current.buffer !== full1) fail("preview did not start the render");
    if (!close(tv.level.gain.value, Math.pow(10, -6 / 20))) fail(`level gain ${tv.level.gain.value}`);

    // Whole render arrives at 2.0 s: starts at the take position, 30 ms equal-power ramps, old one stops.
    ctx.currentTime = 2.0;
    const first = tv.current;
    const full2 = buf("full2", 10);
    if (!audio.crossfadeTo(full2)) fail("crossfadeTo did not switch");
    const second = tv.current;
    if (second.buffer !== full2 || !close(second.source.starts[0][0], 2.0) || !close(second.source.starts[0][1], 1.995)) {
      fail(`new render start ${JSON.stringify(second.source.starts)}`);
    }
    const rise = events.find((e) => e.name === second.fade.id && e.type === "curve");
    const fall = events.find((e) => e.name === first.fade.id && e.type === "curve");
    if (!rise || !fall || !close(rise.t, 2.0) || !close(rise.d, 0.03) || !close(fall.t, 2.0) || !close(fall.d, 0.03)) fail("crossfade ramps not at 2.0 s for 30 ms");
    if (rise.curve[0] !== 0 || !close(rise.curve[rise.curve.length - 1], 1) || !close(fall.curve[0], 1)) fail("ramp ends");
    if (!rise.curve.every((v, i) => Math.abs(v * v + fall.curve[i] * fall.curve[i] - 1) < 1e-6)) fail("ramps are not equal-power");
    if (!close(first.source.stops[0], 2.03)) fail(`old render stop ${first.source.stops}`);

    // A prefix (until 5 s) at 3.0 s: plays now and hands back to full2 50 ms before it runs out.
    ctx.currentTime = 3.0;
    const prefix = buf("prefix", 5);
    if (!audio.crossfadeTo(prefix, { prefix: true })) fail("prefix not played");
    const pre = tv.current;
    const back = tv.handback;
    if (pre.buffer !== prefix || !back || back.to.buffer !== full2 || !close(back.at, 4.955)) fail(`hand-back ${JSON.stringify(back && back.at)}`);
    if (!close(back.to.source.starts[0][0], 4.955) || !close(back.to.source.starts[0][1], 4.95)) fail(`hand-back start ${JSON.stringify(back.to.source.starts)}`);
    if (!close(pre.source.stops[pre.source.stops.length - 1], 4.985)) fail(`prefix stop ${pre.source.stops}`);
    if (!events.some((e) => e.name === back.to.fade.id && e.type === "curve" && close(e.t, 4.955))) fail("hand-back ramp missing");

    // The whole render arrives at 4.0 s, before the hand-back: the hand-back is called off.
    ctx.currentTime = 4.0;
    const full3 = buf("full3", 10);
    audio.crossfadeTo(full3);
    if (tv.current.buffer !== full3 || tv.handback || back.to.source.stops.length !== 1 || back.to.source.onended !== null) fail("hand-back not called off");
    if (!events.some((e) => e.name === pre.fade.id && e.type === "curve" && close(e.t, 4.0))) fail("prefix not faded out at 4.0 s");
    if (!close(tv.current.source.starts[0][1], 3.995) || tv.fullBuffer !== full3) fail("whole render after a prefix");

    // A prefix with no whole render in time: once it stops, the earlier whole render plays.
    ctx.currentTime = 5.0;
    audio.crossfadeTo(buf("prefix2", 7), { prefix: true });
    const pre2 = tv.current;
    const back2 = tv.handback;
    pre2.source.onended();
    if (tv.current !== back2.to || tv.current.buffer !== full3 || tv.handback) fail("the earlier whole render did not take over");
    ctx.currentTime = 7.5;
    audio.crossfadeTo(buf("full4", 10));
    if (tv.current.buffer.name !== "full4" || !close(tv.current.source.starts[0][1], 7.495)) fail("switch after a hand-back");

    // A prefix that would run out before it's heard is not played; nothing plays without a take.
    if (audio.crossfadeTo(buf("short", 7.52), { prefix: true }) !== false || tv.current.buffer.name !== "full4") fail("a too-short prefix was played");
    let ended = 0;
    tv.onEnded = () => { ended++; };
    first.source.onended();
    if (ended) fail("a replaced render's end ended the preview");
    tv.current.source.onended();
    if (ended !== 1) fail("the playing render's end did not end the preview");
    audio.stopAllPlayback();
    if (audio.takeVoice !== null || audio.crossfadeTo(full1) !== false) fail("crossfadeTo after stop");
    console.log("PASS: crossfadeTo switches renders at the take position with 30 ms equal-power ramps and hands a prefix back");
  }

  // 8. Booth: Preview waits for the take's render, then plays it; without voice effects it
  //    plays the take as recorded, with the effect controls off and the message shown.
  {
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

    const calls = [];
    let renderReply = null;   // (body) => Promise<response>
    w.fetch = (input, opts = {}) => {
      const u = String(input || "");
      calls.push({ url: u, method: opts.method || "GET", body: opts.body });
      if (/\/render$/.test(u) && renderReply) return renderReply(JSON.parse(opts.body));
      if (/\/noise_reduction$/.test(u)) {
        const swapped = { ...take, url: "/api/rooms/R1/lines/t1000/takes/k1/audio?v=2", noise_reduction: JSON.parse(opts.body).noise_reduction };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ take: swapped }) });
      }
      const body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
    w.eval(buildStudioBundle());
    await tick(20);
    const app = w.dubMateApp;
    if (!app) fail("studio did not boot");
    // The Voice panel's rack: an effect's dial and its on/off switch.
    const pitchDial = w.document.querySelector('#voice-rack [data-node="pitch"] [data-voice-param="semitones"]');
    const pitchReadout = pitchDial.closest(".dsp-dial-channel").querySelector("[data-readout]");
    const lowcutSwitch = w.document.querySelector('#voice-rack [data-node="lowcut"] [data-voice-on]');
    app.showToast = () => {};
    app.user = { id: "u1", name: "Ana" };
    app.socket.send = () => {};
    app.socket.updateTakeParams = () => {};
    app.syncVideoSeek = () => Promise.resolve();
    app.stageVideo.play = () => Promise.resolve();
    app.stageVideo.pause = () => {};
    app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
    const played = [];
    app.audio.previewTakeIsolated = (args) => { played.push(args); };

    const line = { line_id: "t1000", index: 0, character: "Ana", start: 1, end: 3, duration: 2, peaks: [], audio_url: "/orig0.wav", text: "Hi" };
    const take = { take_id: "k1", number: 1, user_id: "u1", user_name: "Ana", duration: 2, peaks: [],
      url: "/api/rooms/R1/lines/t1000/takes/k1/audio?v=1", offset_ms: -40, gain_db: -3,
      chain: FIXTURE.presets.radio };
    app.roomState = {
      state_version: 3, room_id: "R1", host_id: "u1", users: {}, role_assignments: {},
      voice: { session: null, characters: { Ana: FIXTURE.presets.monster } },
      pack: { id: "P", lines: [line], characters: ["Ana"], video_url: "/v.mp4" },
      takes: { t1000: { picked: "k1", next_number: 2, takes: [take] } },
    };

    let answer;
    renderReply = () => new Promise((resolve) => { answer = resolve; });
    await app.loadBoothLine(0);
    const btn = app.btnPreviewTake;
    btn.click();
    await tick(10);
    if (!btn.classList.contains("is-waiting-sound") || played.length) fail("Preview didn't wait for the take's render");
    await tick(150);   // debounce
    const req = calls.filter((c) => /\/render$/.test(c.url));
    if (req.length !== 1 || req[0].url !== "/api/rooms/R1/lines/t1000/takes/k1/render") fail(`render requests: ${JSON.stringify(req)}`);
    const body = JSON.parse(req[0].body);
    if (!same(body.chain, FIXTURE.presets.radio) || !body.client_id || "until_s" in body) fail(`render body: ${req[0].body}`);
    if (app.voiceStatusDot.style.display === "none") fail("no pulse while the sound catches up");
    answer({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/0123456789abcdef.wav", key: "0123456789abcdef", duration: 2 }) });
    await tick(20);
    if (played.length !== 1 || played[0].takeBuffer?.url !== "/api/rooms/R1/renders/0123456789abcdef.wav"
        || played[0].offsetMs !== -40 || played[0].gainDb !== -3) fail(`Preview played ${JSON.stringify(played)}`);
    if (btn.classList.contains("is-waiting-sound") || app.voiceStatusDot.style.display !== "none") fail("pulse left on");
    if (pitchDial.disabled || app.voiceEffectsNote.style.display !== "none") fail("effect controls off with effects installed");
    app.stopBoothPlayback();

    // A knob moved while the take plays: the 2 s after the playhead render first, then the
    // whole take; each crossfades in, and letting go saves the take's sound.
    {
      const fades = [];
      const realFade = app.audio.crossfadeTo;
      const realPos = app.audio.takePositionS;
      app.audio.crossfadeTo = (buffer, opts) => { fades.push({ url: buffer.url, prefix: !!(opts && opts.prefix) }); return true; };
      app.audio.takePositionS = () => 3;
      app.currentTakeBuffer = { duration: 10 };
      app.isPlayingTake = true;
      let n = 0;
      renderReply = (b) => Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve({ url: `/api/rooms/R1/renders/${String(++n).padStart(16, "0")}.wav`, until: b.until_s }) });
      const before = calls.length;
      pitchDial.value = "-4";
      pitchDial.dispatchEvent(new w.Event("input"));
      if (pitchReadout.textContent !== "-4 st" || take.chain.preset !== null || take.chain.nodes.pitch.semitones !== -4) fail("the dial and the take's chain didn't change at once");
      await tick(250);
      const renders = calls.slice(before).filter((c) => /\/render$/.test(c.url)).map((c) => JSON.parse(c.body));
      if (renders.length !== 2 || !(renders[0].until_s > 5 && renders[0].until_s < 5.5) || "until_s" in renders[1]
          || renders[1].chain.nodes.pitch.semitones !== -4 || renders[1].chain.nodes.lowcut.hz !== 300) fail(`renders while playing: ${JSON.stringify(renders)}`);
      if (!same(fades, [{ url: "/api/rooms/R1/renders/0000000000000001.wav", prefix: true }, { url: "/api/rooms/R1/renders/0000000000000002.wav", prefix: false }])) fail(`crossfades: ${JSON.stringify(fades)}`);
      if (calls.slice(before).some((c) => c.method === "PUT")) fail("saved before the dial was let go or went quiet");
      pitchDial.dispatchEvent(new w.Event("change"));
      await tick(10);
      const put = calls.slice(before).find((c) => c.method === "PUT");
      if (!put || put.url !== "/api/rooms/R1/lines/t1000/takes/k1/chain" || JSON.parse(put.body).chain.nodes.pitch.semitones !== -4) fail(`save: ${JSON.stringify(put)}`);
      app.audio.crossfadeTo = realFade;
      app.audio.takePositionS = realPos;
      app.isPlayingTake = false;
      take.chain = FIXTURE.presets.radio;
      renderReply = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/0123456789abcdef.wav" }) });
      await app.loadBoothLine(0);
      await tick(200);
    }

    // A second Preview plays the same render at once.
    played.length = 0;
    btn.click();
    await tick(10);
    if (played.length !== 1 || played[0].takeBuffer?.url !== "/api/rooms/R1/renders/0123456789abcdef.wav") fail("second Preview did not reuse the render");
    app.stopBoothPlayback();

    // Voice effects not installed: 503, the raw take plays, controls off, message shown.
    const message = "Download and install the latest DubMate to use voice effects.";
    renderReply = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ effects_unavailable: true, message }) });
    played.length = 0;
    await app.loadBoothLine(0);
    btn.click();
    await tick(200);
    if (played.length !== 1 || played[0].takeBuffer?.url !== take.url) fail(`unavailable Preview played ${JSON.stringify(played)}`);
    if (!pitchDial.disabled || !lowcutSwitch.disabled
        || !pitchDial.closest(".dsp-dial-channel").classList.contains("ui-interaction-locked")) fail("effect controls still on");
    if (app.sliderGain.disabled) fail("Level turned off with the effects");
    if (app.voiceEffectsNote.style.display === "none" || app.voiceEffectsNote.textContent !== message) fail(`note: ${app.voiceEffectsNote.textContent}`);
    app.stopBoothPlayback();

    // Effects arrive: the next line load renders again and the controls come back.
    renderReply = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/fedcba9876543210.wav", key: "fedcba9876543210", duration: 2 }) });
    await app.loadBoothLine(0);
    await tick(200);
    if (pitchDial.disabled || app.voiceEffectsNote.style.display !== "none") fail("controls not back once effects are installed");

    // Noise reduction swaps the take's audio: the old render is dropped, a new one is
    // asked for, and Preview plays it (never the render of the audio before the swap).
    {
      const before = calls.length;
      renderReply = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/00000000000000d2.wav", key: "00000000000000d2", duration: 2 }) });
      await app.toggleTakeNoiseReduction(0, true);
      if (app.voiceRender && app.voiceRender.url === "/api/rooms/R1/renders/fedcba9876543210.wav") fail("the render of the old audio was kept");
      await tick(200);
      const renders = calls.slice(before).filter((c) => /\/render$/.test(c.url));
      if (renders.length !== 1 || renders[0].url !== "/api/rooms/R1/lines/t1000/takes/k1/render") fail(`renders after noise reduction: ${JSON.stringify(renders)}`);
      played.length = 0;
      btn.click();
      await tick(20);
      if (played.length !== 1 || played[0].takeBuffer?.url !== "/api/rooms/R1/renders/00000000000000d2.wav") fail(`Preview after noise reduction played ${JSON.stringify(played)}`);
      app.stopBoothPlayback();
    }

    if (errors.length) fail(`console errors: ${errors.join("\n")}`);
    console.log("PASS: Preview waits for the take's render and plays it; without voice effects it plays the take as recorded");
  }

  console.log("ALL VOICE PREVIEW TESTS PASSED");
  process.exit(0);
})();
