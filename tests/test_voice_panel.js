/**
 * test_voice_panel.js
 *
 * The booth's Voice panel (static/js/studio/voice_rack.js, documentation/design/effects-rack.md
 * "What changes for the user"): by default only the preset chips, Level and the meter; All
 * effects opens the full rack; the panel is hidden on lines you can't record and on lines
 * without a take; Use on every line is the host's; a preset chip or a dial changes the chip,
 * the readouts and the scheduler's wanted chain at once; the confirm texts; the pulse follows
 * the scheduler's states and stays still under reduced motion; a voice_updated broadcast
 * re-resolves the take's sound. Socket and fetch are stubbed.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "chain_resolution.json"), "utf8"));
const P = FIXTURE.presets;
const PRESETS = ["clean", "warm", "radio", "monster"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), chain: P[id] }));
const { JSDOM, VirtualConsole } = jsdom;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shown = (el) => !!el && el.style.display !== "none";

const LINE = { line_id: "t1000", index: 0, character: "Ana", start: 1, end: 3, duration: 2,
  peaks: [], audio_url: "/orig0.wav", text: "Hello" };
const mkTake = (extra = {}) => ({ take_id: "k1", number: 1, user_id: "u1", user_name: "Ana", duration: 2, peaks: [],
  url: "/api/rooms/R1/lines/t1000/takes/k1/audio?v=1", offset_ms: 0, gain_db: 0, ...extra });

async function boot() {
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
  const drawn = [];
  w.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    return new Proxy({}, { get: (_, name) => (...args) => { drawn.push({ canvas, name, args }); return { addColorStop: () => {} }; } });
  };
  w.scrollTo = () => {};
  Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [], addEventListener: () => {} } });

  const calls = [];
  const env = { w, calls, errors, drawn, renderReply: null };
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (/\/render$/.test(u)) {
      if (env.renderReply) return env.renderReply(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/0123456789abcdef.wav" }) });
    }
    const body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  env.app = app;
  env.toasts = [];
  app.showToast = (msg) => env.toasts.push(msg);
  app.user = { id: "u1", name: "Ana" };
  app.socket.send = () => {};
  app.socket.updateTakeParams = () => {};
  app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
  app.currentView = "booth";
  return env;
}

/** Opens the room's only line in the booth as `user` with these takes and room settings. */
async function showLine(env, { takes = [mkTake()], host = "u1", roles = {}, voice = {} } = {}) {
  env.app.roomState = {
    state_version: 3, room_id: "R1", host_id: host, users: {}, role_assignments: roles,
    voice: { session: null, characters: {}, presets: PRESETS, ...voice },
    pack: { id: "P", lines: [LINE], characters: ["Ana", "Ogre"], video_url: "/v.mp4" },
    takes: takes.length ? { t1000: { picked: takes[0].take_id, next_number: takes.length + 1, takes } } : {},
  };
  await env.app.loadBoothLine(0);
  await tick(200);   // the first render
}

(async () => {
  const env = await boot();
  const { w, app } = env;
  const $ = (id) => w.document.getElementById(id);
  const panel = $("card-voice-dsp");
  const rack = $("voice-rack");
  const toggle = $("btn-voice-all-effects");
  const custom = $("voice-preset-custom");
  const chips = () => [...w.document.querySelectorAll("#voice-presets [data-preset]")];
  const activeChips = () => chips().filter((c) => c.classList.contains("is-active")).map((c) => c.textContent);
  const fx = (node) => rack.querySelector(`[data-node="${node}"]`);
  const dial = (node, param) => fx(node).querySelector(`[data-voice-param="${param}"]`);
  const readout = (node, param) => dial(node, param).closest(".dsp-dial-channel").querySelector("[data-readout]").textContent;
  const sw = (node) => fx(node).querySelector("[data-voice-on]");

  // 1. Default: presets, Level and the meter; the rack is closed. No implementation names.
  {
    await showLine(env, { takes: [mkTake({ chain: P.warm })] });
    if (!shown(panel)) fail("Voice panel hidden on your own line with a take");
    const names = chips().map((c) => c.textContent).join(",");
    if (names !== "Clean,Warm,Radio,Monster") fail(`chips: ${names}`);
    const tips = chips().map((c) => c.dataset.tip);
    if (!same(tips, ["Your voice, with low rumble removed", "Fuller and smoother, with a little room",
      "Thin and boxy, like a speaker or a phone", "Lower and bigger"])) fail(`chip tips: ${JSON.stringify(tips)}`);
    if (!same(activeChips(), ["Warm"]) || shown(custom)) fail(`active chip: ${activeChips()} custom ${shown(custom)}`);
    if (!$("slider-gain") || !$("voice-meter-fill") || !$("val-gain")) fail("Level or the meter missing");
    const levelTip = $("slider-gain").closest("[data-tip]")?.dataset.tip;
    if (levelTip !== "How loud this take sits in the dub") fail(`Level tooltip: ${levelTip}`);
    const title = panel.querySelector(".amp-faceplate").textContent;
    if (!/VOICE/.test(title) || /EFFECTS|BOOST/.test(panel.querySelector(".voice-main").textContent)) fail(`panel header/labels: ${title}`);
    if (rack.classList.contains("open") || toggle.getAttribute("aria-expanded") !== "false") fail("rack open by default");
    if (/pedalboard|rubber band|lufs|bs\.?1770/i.test(panel.textContent)) fail("implementation names on screen");
    for (const id of ["slider-pitch", "slider-reverb", "check-lowcut", "btn-toggle-advanced-rack", "advanced-vocal-rack"]) {
      if ($(id)) fail(`old control still there: #${id}`);
    }
    console.log("PASS: default shows the four presets, Level and the meter; the rack starts closed");
  }

  // 2. All effects opens the full rack: every effect in order, each with a switch and a Mix dial.
  {
    toggle.click();
    if (!rack.classList.contains("open") || toggle.getAttribute("aria-expanded") !== "true") fail("All effects did not open the rack");
    const order = [...rack.querySelectorAll("[data-node]")].map((el) => el.dataset.node).join(",");
    if (order !== "lowcut,gate,eq,deess,comp,pitch,reverb") fail(`rack order: ${order}`);
    for (const el of rack.querySelectorAll("[data-node]")) {
      if (!el.querySelector("[data-voice-on]") || el.querySelectorAll('[data-voice-param="mix"]').length !== 1) fail(`${el.dataset.node}: switch or Mix dial missing`);
    }
    const heads = [...rack.querySelectorAll(".voice-fx-head")].map((h) => h.textContent.trim());
    if (heads.join("|") !== "Low cut|Gate|Tone|De-ess|Compress|Pitch|Reverb|Clean up noise") fail(`effect names: ${heads.join("|")}`);
    const tip = (node) => fx(node).querySelector(".voice-fx-head").dataset.tip;
    if (tip("gate") !== "Silences the gaps between words" || tip("eq") !== "Shape the low, middle and high end"
        || tip("deess") !== "Softens harsh S sounds" || tip("comp") !== "Evens out loud and quiet words") fail("effect tooltips");
    const mixTips = [...rack.querySelectorAll('[data-voice-param="mix"]')].map((d) => d.closest("[data-tip]")?.dataset.tip);
    if (!mixTips.every((t) => t === "How much of this effect you hear")) fail(`Mix tooltips: ${mixTips}`);
    if (fx("reverb").querySelectorAll("[data-voice-param]").length !== 3 || !dial("reverb", "decay_s") || !dial("reverb", "predelay_ms")) fail("Reverb dials");
    if (dial("reverb", "decay_s").min !== "0.2" || dial("reverb", "decay_s").max !== "4.0" || dial("reverb", "predelay_ms").max !== "60") fail("Reverb ranges");
    // Warm on the controls: Tone on, its curve drawn, reverb 12%.
    if (!sw("eq").checked || sw("pitch").checked || readout("reverb", "mix") !== "12%" || readout("eq", "mid_hz") !== "400 Hz") fail("Warm not shown on the rack");
    if (!env.drawn.some((d) => d.canvas.id === "voice-tone-curve" && d.name === "lineTo")) fail("Tone curve not drawn");
    if (!shown($("btn-voice-use-character")) || $("btn-voice-use-character").textContent !== "Use on all of Ana's lines") fail("character button");
    if (!shown($("btn-voice-use-session"))) fail("host can't see Use on every line");
    toggle.click();
    if (rack.classList.contains("open") || toggle.getAttribute("aria-expanded") !== "false") fail("All effects did not close the rack");
    console.log("PASS: All effects opens the full rack: every effect in order with a switch and a Mix dial");
  }

  // 3. A line someone else records, or a line without a take: no Voice panel.
  {
    await showLine(env, { host: "h9", roles: { Ana: ["u9"] } });
    if (shown(panel)) fail("panel shown on another actor's line");
    await showLine(env, { host: "h9", roles: { Ogre: ["u1"] } });
    if (shown(panel)) fail("panel shown to an actor on a character they don't play");
    await showLine(env, { takes: [] });
    if (shown(panel)) fail("panel shown on a line without a take");
    console.log("PASS: the panel is hidden on lines you can't record and on lines without a take");
  }

  // 4. An actor (not the host) sees Use on all of Ana's lines, not Use on every line.
  {
    await showLine(env, { host: "h9", roles: { Ana: ["u1"] } });
    if (!shown(panel)) fail("panel hidden for Ana's actor");
    if (!shown($("btn-voice-use-character")) || shown($("btn-voice-use-session"))) fail("non-host apply buttons");
    console.log("PASS: Use on every line is the host's");
  }

  // 5. A preset chip changes the chip and the rack at once and asks for that chain; it's saved.
  {
    await showLine(env, { takes: [mkTake()] });
    if (!same(activeChips(), ["Clean"])) fail(`take without its own sound: ${activeChips()}`);
    const wanted = [];
    const realWant = app.voiceScheduler.want.bind(app.voiceScheduler);
    app.voiceScheduler.want = (chain, opts) => { wanted.push(chain); return realWant(chain, opts); };
    const before = env.calls.length;
    chips().find((c) => c.dataset.preset === "radio").click();
    if (!same(activeChips(), ["Radio"]) || chips().find((c) => c.dataset.preset === "radio").getAttribute("aria-pressed") !== "true") fail("Radio chip not active at once");
    if (wanted.length !== 1 || !same(wanted[0], P.radio)) fail(`want: ${JSON.stringify(wanted)}`);
    if (readout("lowcut", "hz") !== "300 Hz" || !sw("comp").checked) fail("rack doesn't show Radio");
    if (!same(app.takeForLine(0).chain, P.radio)) fail("the take's chain isn't Radio");
    await tick();
    const put = env.calls.slice(before).find((c) => c.method === "PUT");
    if (!put || put.url !== "/api/rooms/R1/lines/t1000/takes/k1/chain" || !same(JSON.parse(put.body).chain, P.radio)) fail(`preset save: ${JSON.stringify(put)}`);
    console.log("PASS: a preset chip updates at once, asks for that preset's render and saves it");

    // 6. A dial shows Custom at once; the effect switches on; Tone redraws.
    wanted.length = 0;
    const drawnBefore = env.drawn.length;
    const low = dial("eq", "low_db");
    low.value = "4";
    low.dispatchEvent(new w.Event("input"));
    if (!shown(custom) || activeChips().length !== 0) fail("Custom not shown after a dial edit");
    if (readout("eq", "low_db") !== "+4 dB" || wanted.length !== 1 || wanted[0].preset !== null || wanted[0].nodes.eq.low_db !== 4) fail("dial edit");
    if (!env.drawn.slice(drawnBefore).some((d) => d.canvas.id === "voice-tone-curve")) fail("Tone curve not redrawn");
    const pitch = dial("pitch", "semitones");
    pitch.value = "-3";
    pitch.dispatchEvent(new w.Event("input"));
    if (!sw("pitch").checked || readout("pitch", "semitones") !== "-3 st" || !wanted[1].nodes.pitch.on) fail("turning Pitch didn't switch it on");
    sw("pitch").checked = false;
    sw("pitch").dispatchEvent(new w.Event("change"));
    if (wanted[2].nodes.pitch.on !== false || !fx("pitch").classList.contains("is-off")) fail("Pitch switch off");
    const mix = dial("comp", "mix");
    mix.value = "40";
    mix.dispatchEvent(new w.Event("input"));
    if (wanted[3].nodes.comp.mix !== 0.4 || readout("comp", "mix") !== "40%") fail("Mix dial");
    // Choosing a preset again replaces the custom sound.
    chips().find((c) => c.dataset.preset === "monster").click();
    if (shown(custom) || !same(activeChips(), ["Monster"]) || !same(wanted[4], P.monster)) fail("preset after Custom");
    await tick();
    console.log("PASS: editing a dial shows Custom at once and asks for the edited chain");
  }

  // 7. Use on all of NAME's lines / Use on every line ask first, then PUT /voice.
  {
    const asked = [];
    let answer = false;
    w.confirm = (text) => { asked.push(text); return answer; };
    const before = env.calls.length;
    $("btn-voice-use-character").click();
    await tick();
    if (asked[0] !== "Use this sound on all of Ana's lines? Lines you changed by hand will switch too.") fail(`character confirm: ${asked[0]}`);
    if (env.calls.slice(before).some((c) => /\/voice$/.test(c.url))) fail("applied without a yes");
    answer = true;
    $("btn-voice-use-character").click();
    await tick();
    const put = env.calls.slice(before).find((c) => c.method === "PUT" && c.url === "/api/rooms/R1/voice");
    const body = put && JSON.parse(put.body);
    if (!body || body.scope !== "character" || body.character !== "Ana" || body.user_id !== "u1" || !same(body.chain, P.monster)) fail(`character PUT: ${put && put.body}`);
    $("btn-voice-use-session").click();
    await tick();
    if (asked[2] !== "Use this sound on every line? Lines and characters with their own sound will switch too.") fail(`every-line confirm: ${asked[2]}`);
    const put2 = env.calls.slice(before).filter((c) => c.url === "/api/rooms/R1/voice")[1];
    const body2 = put2 && JSON.parse(put2.body);
    if (!body2 || body2.scope !== "session" || "character" in body2) fail(`session PUT: ${put2 && put2.body}`);
    console.log("PASS: both apply buttons ask with the design's text, then set the room's sound");
  }

  // 8. The pulse follows the scheduler: waiting and rendering pulse, current doesn't;
  //    without voice effects the controls go off and the message shows.
  {
    const dot = $("voice-status-dot");
    let answer;
    env.renderReply = () => new Promise((resolve) => { answer = resolve; });
    await showLine(env, { takes: [mkTake()] });
    if (app.voiceScheduler.state !== "rendering" || !shown(dot)) fail(`pulse while rendering: ${app.voiceScheduler.state}`);
    answer({ ok: true, status: 200, json: () => Promise.resolve({ url: "/api/rooms/R1/renders/00000000000000aa.wav" }) });
    await tick();
    if (app.voiceScheduler.state !== "current" || shown(dot)) fail("pulse after the render arrived");
    chips().find((c) => c.dataset.preset === "warm").click();
    if (app.voiceScheduler.state !== "waiting" || !shown(dot)) fail("no pulse while waiting");
    if (dot.dataset.tip !== "Your sound is updating") fail("pulse tooltip");
    if (dot.classList.contains("is-still")) fail("still dot without reduced motion");
    w.matchMedia = (q) => ({ matches: q === "(prefers-reduced-motion: reduce)", addEventListener: () => {} });
    app.refreshVoiceControls();
    if (!dot.classList.contains("is-still") || !shown(dot)) fail("reduced motion: the dot isn't still");
    delete w.matchMedia;
    await tick(200);
    answer({ ok: false, status: 503, json: () => Promise.resolve({ effects_unavailable: true, message: "Download and install the latest DubMate to use voice effects." }) });
    await tick();
    if (app.voiceScheduler.state !== "unavailable" || shown(dot)) fail("pulse when effects are unavailable");
    const note = $("voice-effects-note");
    if (!shown(note) || note.textContent !== "Download and install the latest DubMate to use voice effects.") fail(`note: ${note.textContent}`);
    if (!chips().every((c) => c.disabled) || !sw("gate").disabled || !dial("eq", "low_db").disabled
        || !$("btn-voice-use-character").disabled) fail("effect controls on without voice effects");
    if ($("slider-gain").disabled || $("check-noise-reduction").disabled) fail("Level or Clean up noise turned off with the effects");
    // An engine that sends no message still gets the plain one, never a download promise.
    app.voiceEffectsMessage = "";
    app.refreshVoiceControls();
    if (note.textContent !== "Download and install the latest DubMate to use voice effects.") fail(`fallback note: ${note.textContent}`);
    env.renderReply = null;
    app.voiceUnavailable = false;
    console.log("PASS: the pulse follows the scheduler (still under reduced motion); unavailable turns effects off with the message");
  }

  // 9. voice_updated: someone gave Ana Monster; a take without its own sound follows it.
  {
    await showLine(env, { takes: [mkTake()] });
    const wanted = [];
    const realWant = app.voiceScheduler.want.bind(app.voiceScheduler);
    app.voiceScheduler.want = (chain, opts) => { wanted.push(chain); return realWant(chain, opts); };
    const state = JSON.parse(JSON.stringify(app.roomState));
    state.voice.characters = { Ana: P.monster };
    app.socket.emit("voice_updated", { type: "voice_updated", state, payload: { scope: "character", character: "Ana" } });
    if (!same(activeChips(), ["Monster"]) || wanted.length !== 1 || !same(wanted[0], P.monster)) fail(`voice_updated: ${activeChips()} ${wanted.length}`);
    // The same sound again (e.g. this tab's own change coming back) asks for nothing.
    app.socket.emit("take_params_updated", { type: "take_params_updated", state: JSON.parse(JSON.stringify(state)), payload: { line_id: "t1000", take_id: "k1" } });
    if (wanted.length !== 1) fail("an unchanged sound asked for another render");
    console.log("PASS: voice_updated re-resolves the take's sound; an unchanged one asks for nothing");
  }

  if (env.errors.length) fail(`console errors: ${env.errors.join("\n")}`);
  console.log("ALL VOICE PANEL TESTS PASSED");
  process.exit(0);
})();
