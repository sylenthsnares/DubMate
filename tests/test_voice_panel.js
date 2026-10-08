/**
 * test_voice_panel.js
 *
 * The booth's Voice card (static/js/studio/voice_rack.js, documentation/design/ui-u2-booth.md
 * "VOICE card" and "All effects: the rack as the column's page"; effects-rack.md): presets,
 * "For" and Level by default, no meter; "All effects › · N on" opens the rack as the column's
 * page (Back, Esc and E), with plain dial labels and no Mix on Low cut and Gate; the card shows
 * on every line you can record, before the first take too, and is hidden on other people's;
 * "For" starts where the sound comes from and sends edits there (the take's PUT …/chain, or
 * PUT /voice after 400 ms of quiet and on release); widening asks inline (no confirm()),
 * narrowing copies the sound onto the take; "Every line" is the host's; before the first take
 * a preset is kept for the next take and sent with its upload; a dial on an off effect
 * doesn't switch it on; the pulse follows the scheduler; voice_updated re-resolves the sound.
 * Socket and fetch are stubbed.
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

  const scope = $("voice-scope");
  const scopeOption = (value) => scope.querySelector(`option[value="${value}"]`);
  const ask = $("voice-scope-ask");
  const askText = $("voice-scope-ask-text");
  const askYes = $("btn-voice-scope-yes");
  const askCancel = $("btn-voice-scope-cancel");
  const status = $("voice-scope-status");
  const columnPanel = $("booth-controls-panel");
  const back = $("btn-voice-back");
  const summary = $("voice-page-summary");
  const title = (node, param) => dial(node, param).closest(".dsp-dial-channel").querySelector(".dsp-channel-title").textContent;
  const puts = (from, re) => env.calls.slice(from).filter((c) => c.method === "PUT" && re.test(c.url));
  const pickScope = (value) => { scope.value = value; scope.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const press = (key, target) => {
    const ev = new w.KeyboardEvent("keydown", { key, code: key === "Escape" ? "Escape" : `Key${key.toUpperCase()}`, bubbles: true, cancelable: true });
    (target || w.document.body).dispatchEvent(ev);
  };
  // Nothing in the Voice card may ask with the browser's confirm().
  w.confirm = (text) => fail(`window.confirm used: ${text}`);
  if (/\bconfirm\(/.test(fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "studio", "voice_rack.js"), "utf8"))) fail("confirm() left in voice_rack.js");

  // 1. Default: presets, For and Level; no meter; the rack is closed. No implementation names.
  {
    await showLine(env, { takes: [mkTake({ chain: P.warm })] });
    if (!shown(panel)) fail("Voice panel hidden on your own line with a take");
    const names = chips().map((c) => c.textContent).join(",");
    if (names !== "Clean,Warm,Radio,Monster") fail(`chips: ${names}`);
    const tips = chips().map((c) => c.dataset.tip);
    if (!same(tips, ["Your voice, with low rumble removed", "Fuller and smoother, with a little room",
      "Thin and boxy, like a speaker or a phone", "Lower and bigger"])) fail(`chip tips: ${JSON.stringify(tips)}`);
    if (!same(activeChips(), ["Warm"]) || shown(custom)) fail(`active chip: ${activeChips()} custom ${shown(custom)}`);
    if (!$("slider-gain") || !$("val-gain")) fail("Level missing");
    if ($("voice-meter-fill") || panel.querySelector(".voice-meter")) fail("the unlabelled meter is still there");
    if (typeof app.startVoiceMeter === "function") fail("startVoiceMeter is still there");
    const levelTip = $("slider-gain").closest("[data-tip]")?.dataset.tip;
    if (levelTip !== "How loud this take sits in the dub") fail(`Level tooltip: ${levelTip}`);
    const label = w.document.querySelector('label[for="voice-scope"]');
    if (!label || label.textContent.trim() !== "For" || scope.tagName !== "SELECT") fail("For is not a labelled native select");
    const head = panel.querySelector(".amp-faceplate").textContent;
    if (!/VOICE/.test(head) || /EFFECTS|BOOST/.test(panel.querySelector(".voice-main").textContent)) fail(`panel header/labels: ${head}`);
    if (!toggle.classList.contains("btn") || !toggle.classList.contains("btn-secondary")) fail(`All effects isn't a bordered secondary button: ${toggle.className}`);
    if (toggle.textContent.replace(/\s+/g, " ").trim() !== "All effects › · 5 on") fail(`All effects label: ${toggle.textContent}`);
    if (rack.classList.contains("open") || toggle.getAttribute("aria-expanded") !== "false" || columnPanel.classList.contains("rack-open")) fail("rack open by default");
    if (!back.hidden || !summary.hidden) fail("Back or the page summary shows with the rack closed");
    if (/pedalboard|rubber band|lufs|bs\.?1770/i.test(panel.textContent)) fail("implementation names on screen");
    for (const id of ["slider-pitch", "slider-reverb", "check-lowcut", "btn-toggle-advanced-rack", "advanced-vocal-rack",
      "btn-voice-use-character", "btn-voice-use-session"]) {
      if ($(id)) fail(`old control still there: #${id}`);
    }
    console.log("PASS: default shows the four presets, For and Level, no meter; All effects is a secondary button with a count");
  }

  // 2. All effects opens the rack as the column's page; Back, Esc and E close it.
  {
    for (const [k, el] of Object.entries(app.views)) el.classList.toggle("active", k === "booth");
    if (app.isAudioSettingsOpen()) app.closeAudioSettings();
    toggle.focus();
    toggle.click();
    if (!rack.classList.contains("open") || !columnPanel.classList.contains("rack-open")) fail("All effects did not open the rack page");
    if (back.hidden || summary.hidden || summary.textContent !== "Warm · 5 on" || !toggle.hidden) fail(`page header: back ${back.hidden} summary "${summary.textContent}"`);
    if (w.document.activeElement !== back) fail("focus didn't move to Back");
    const order = [...rack.querySelectorAll("[data-node]")].map((el) => el.dataset.node).join(",");
    if (order !== "lowcut,gate,eq,deess,comp,pitch,reverb") fail(`rack order: ${order}`);
    for (const el of rack.querySelectorAll("[data-node]")) {
      const mixes = el.querySelectorAll('[data-voice-param="mix"]').length;
      const want = ["lowcut", "gate"].includes(el.dataset.node) ? 0 : 1;
      if (!el.querySelector("[data-voice-on]") || mixes !== want) fail(`${el.dataset.node}: switch or Mix dials (${mixes})`);
    }
    const heads = [...rack.querySelectorAll(".voice-fx-head")].map((h) => h.textContent.trim());
    if (heads.join("|") !== "Low cut|Gate|Tone|De-ess|Compress|Pitch|Reverb|Clean up noise") fail(`effect names: ${heads.join("|")}`);
    const tip = (node) => fx(node).querySelector(".voice-fx-head").dataset.tip;
    if (tip("gate") !== "Silences the gaps between words" || tip("eq") !== "Shape the low, middle and high end"
        || tip("deess") !== "Softens harsh S sounds" || tip("comp") !== "Evens out loud and quiet words"
        || tip("pitch") !== "Raise or lower your voice" || tip("reverb") !== "Puts your voice in a room") fail("effect tooltips");
    const labels = [title("lowcut", "hz"), title("gate", "threshold_db"), title("deess", "threshold_db"),
      title("comp", "makeup_db"), title("reverb", "predelay_ms"), title("reverb", "decay_s")];
    if (labels.join("|") !== "Cut below|Silence below|Tame S above|Boost after|Delay before|Room size") fail(`dial labels: ${labels.join("|")}`);
    const sizes = [...rack.querySelectorAll("[data-voice-param]")].map((d) => Number(d.dataset.knobSize));
    if (!sizes.every((n) => n >= 36 && n <= 40)) fail(`knob sizes: ${sizes}`);
    const mixTips = [...rack.querySelectorAll('[data-voice-param="mix"]')].map((d) => d.closest("[data-tip]")?.dataset.tip);
    if (!mixTips.every((t) => t === "How much of this effect you hear")) fail(`Mix tooltips: ${mixTips}`);
    if (fx("reverb").querySelectorAll("[data-voice-param]").length !== 3 || !dial("reverb", "decay_s") || !dial("reverb", "predelay_ms")) fail("Reverb dials");
    if (dial("reverb", "decay_s").min !== "0.2" || dial("reverb", "decay_s").max !== "4.0" || dial("reverb", "predelay_ms").max !== "60") fail("Reverb ranges");
    // Warm on the controls: Tone on, its curve drawn, reverb 12%; off effects are marked off.
    if (!sw("eq").checked || sw("pitch").checked || readout("reverb", "mix") !== "12%" || readout("eq", "mid_hz") !== "400 Hz") fail("Warm not shown on the rack");
    if (!fx("pitch").classList.contains("is-off") || !fx("gate").classList.contains("is-off") || fx("eq").classList.contains("is-off")) fail("off effects not marked");
    if (!env.drawn.some((d) => d.canvas.id === "voice-tone-curve" && d.name === "lineTo")) fail("Tone curve not drawn");
    // Back closes it and gives focus back to All effects.
    back.click();
    if (rack.classList.contains("open") || columnPanel.classList.contains("rack-open") || toggle.hidden || !back.hidden) fail("Back did not close the rack");
    if (w.document.activeElement !== toggle || toggle.getAttribute("aria-expanded") !== "false") fail("focus not back on All effects");
    // E opens it, Esc closes it (also from a focused dial).
    toggle.blur();
    press("e");
    if (!columnPanel.classList.contains("rack-open")) fail("E did not open All effects");
    press("Escape", dial("eq", "low_db").closest(".analog-dial-wrapper") || dial("eq", "low_db"));
    if (columnPanel.classList.contains("rack-open") || w.document.activeElement !== toggle) fail("Esc did not close All effects");
    press("e");
    press("e");
    if (columnPanel.classList.contains("rack-open")) fail("E did not close All effects");
    console.log("PASS: All effects is the column's page: plain labels, no Mix on Low cut and Gate; Back, Esc and E close it");
  }

  // 3. Other people's lines: no Voice card. Your line without a take: the card, with the note.
  {
    await showLine(env, { host: "h9", roles: { Ana: ["u9"] } });
    if (shown(panel)) fail("panel shown on another actor's line");
    await showLine(env, { host: "h9", roles: { Ogre: ["u1"] } });
    if (shown(panel)) fail("panel shown to an actor on a character they don't play");
    await showLine(env, { takes: [] });
    if (!shown(panel)) fail("panel hidden on your line before its first take");
    if (!$("voice-level-take").hidden || $("voice-level-note").hidden
        || $("voice-level-note").textContent !== "Level is matched to the scene when you record.") fail("Level row without a take");
    if (scope.value !== "take" || scopeOption("take").textContent !== "Your next take") fail(`For without a take: ${scope.value} "${scopeOption("take").textContent}"`);
    await showLine(env, { takes: [mkTake()] });
    if ($("voice-level-take").hidden || !$("voice-level-note").hidden) fail("Level row with a take");
    if (scopeOption("take").textContent !== "This take" || scopeOption("character").textContent !== "All of Ana's lines") fail("For option texts");
    console.log("PASS: the card is hidden on other people's lines and shows on yours before the first take");
  }

  // 4. "Every line" is the host's.
  {
    await showLine(env, { host: "h9", roles: { Ana: ["u1"] } });
    if (!shown(panel)) fail("panel hidden for Ana's actor");
    if (!scopeOption("session").hidden || !scopeOption("session").disabled || scopeOption("character").hidden) fail("a guest can choose Every line");
    await showLine(env, { takes: [mkTake()] });
    if (scopeOption("session").hidden || scopeOption("session").disabled) fail("the host can't choose Every line");
    console.log("PASS: Every line is the host's");
  }

  // 5. A preset chip changes the chip and the rack at once and asks for that chain; it's saved.
  {
    await showLine(env, { takes: [mkTake()] });
    if (!same(activeChips(), ["Clean"]) || scope.value !== "take") fail(`take without its own sound: ${activeChips()} ${scope.value}`);
    const wanted = [];
    const realWant = app.voiceScheduler.want.bind(app.voiceScheduler);
    app.voiceScheduler.want = (chain, opts) => { wanted.push(chain); return realWant(chain, opts); };
    const before = env.calls.length;
    chips().find((c) => c.dataset.preset === "radio").click();
    if (!same(activeChips(), ["Radio"]) || chips().find((c) => c.dataset.preset === "radio").getAttribute("aria-pressed") !== "true") fail("Radio chip not active at once");
    if (wanted.length !== 1 || !same(wanted[0], P.radio)) fail(`want: ${JSON.stringify(wanted)}`);
    if (readout("lowcut", "hz") !== "300 Hz" || !sw("comp").checked) fail("rack doesn't show Radio");
    if (!same(app.takeForLine(0).chain, P.radio)) fail("the take's chain isn't Radio");
    if (toggle.textContent.replace(/\s+/g, " ").trim() !== "All effects › · 3 on") fail(`count after Radio: ${toggle.textContent}`);
    await tick();
    const put = env.calls.slice(before).find((c) => c.method === "PUT");
    if (!put || put.url !== "/api/rooms/R1/lines/t1000/takes/k1/chain" || !same(JSON.parse(put.body).chain, P.radio)) fail(`preset save: ${JSON.stringify(put)}`);
    console.log("PASS: a preset chip updates at once, asks for that preset's render and saves it");

    // 6. A dial shows Custom at once; a dial on an off effect leaves it off; Tone redraws.
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
    if (sw("pitch").checked || wanted[1].nodes.pitch.on !== false || wanted[1].nodes.pitch.semitones !== -3
        || !fx("pitch").classList.contains("is-off")) fail("turning Pitch's dial switched it on");
    sw("pitch").checked = true;
    sw("pitch").dispatchEvent(new w.Event("change"));
    if (wanted[2].nodes.pitch.on !== true || fx("pitch").classList.contains("is-off") || readout("pitch", "semitones") !== "-3 st") fail("Pitch switch on");
    const mix = dial("comp", "mix");
    mix.value = "40";
    mix.dispatchEvent(new w.Event("input"));
    if (wanted[3].nodes.comp.mix !== 0.4 || readout("comp", "mix") !== "40%") fail("Mix dial");
    // Choosing a preset again replaces the custom sound.
    chips().find((c) => c.dataset.preset === "monster").click();
    if (shown(custom) || !same(activeChips(), ["Monster"]) || !same(wanted[4], P.monster)) fail("preset after Custom");
    await tick();
    console.log("PASS: editing a dial shows Custom at once; a dial on an off effect doesn't switch it on");
  }

  // 7. "For" starts where the sound comes from.
  {
    await showLine(env, { takes: [mkTake({ chain: P.radio })], voice: { characters: { Ana: P.warm }, session: P.monster } });
    if (scope.value !== "take") fail(`take's own sound: ${scope.value}`);
    await showLine(env, { takes: [mkTake()], voice: { characters: { Ana: P.warm }, session: P.monster } });
    if (scope.value !== "character" || !same(activeChips(), ["Warm"])) fail(`character's sound: ${scope.value}`);
    await showLine(env, { takes: [mkTake()], voice: { session: P.monster } });
    if (scope.value !== "session" || !same(activeChips(), ["Monster"])) fail(`room's sound: ${scope.value}`);
    await showLine(env, { takes: [mkTake()] });
    if (scope.value !== "take") fail(`no sound set: ${scope.value}`);
    console.log("PASS: For starts on the take, the character or every line, wherever the sound comes from");
  }

  // 8. Widening asks inline; Cancel puts the select back; yes sets the character's sound.
  {
    await showLine(env, { takes: [mkTake({ chain: P.monster })] });
    let before = env.calls.length;
    pickScope("character");
    if (ask.hidden || askText.textContent !== "Use Monster on all of Ana's lines? Lines with their own sound switch too."
        || askYes.textContent !== "Use on all their lines" || askCancel.textContent !== "Cancel") fail(`character ask: "${askText.textContent}" [${askYes.textContent}]`);
    if (w.document.activeElement !== askYes) fail("focus not on the ask's yes");
    if (puts(before, /./).length) fail("applied before a yes");
    askCancel.click();
    if (!ask.hidden || scope.value !== "take" || app.voiceScope !== "take" || w.document.activeElement !== scope) fail("Cancel didn't restore the select");
    await tick();
    if (puts(before, /./).length) fail("Cancel still applied the sound");

    pickScope("character");
    askYes.click();
    await tick();
    const put = puts(before, /\/voice$/);
    const body = put[0] && JSON.parse(put[0].body);
    if (put.length !== 1 || put[0].url !== "/api/rooms/R1/voice" || body.scope !== "character" || body.character !== "Ana"
        || body.user_id !== "u1" || !same(body.chain, P.monster)) fail(`character PUT: ${JSON.stringify(put)}`);
    if (!ask.hidden || scope.value !== "character" || status.hidden || status.getAttribute("role") !== "status"
        || status.textContent !== "✓ All of Ana's lines use Monster") fail(`after yes: ${scope.value} "${status.textContent}"`);
    if (!same(app.roomState.voice.characters.Ana, P.monster) || "chain" in app.takeForLine(0)) fail("the room's sounds weren't updated here");

    // Edits now go to Ana's sound: after 400 ms of quiet, and at once on release.
    before = env.calls.length;
    const low = dial("eq", "low_db");
    low.value = "5";
    low.dispatchEvent(new w.Event("input"));
    await tick(100);
    if (puts(before, /./).length) fail("saved before 400 ms of quiet");
    await tick(450);
    let voicePuts = puts(before, /\/voice$/);
    if (voicePuts.length !== 1 || JSON.parse(voicePuts[0].body).chain.nodes.eq.low_db !== 5 || puts(before, /\/chain$/).length) fail(`quiet save: ${JSON.stringify(env.calls.slice(before))}`);
    low.value = "6";
    low.dispatchEvent(new w.Event("input"));
    low.dispatchEvent(new w.Event("change"));
    await tick();
    voicePuts = puts(before, /\/voice$/);
    if (voicePuts.length !== 2 || JSON.parse(voicePuts[1].body).chain.nodes.eq.low_db !== 6) fail("release didn't save Ana's sound");
    chips().find((c) => c.dataset.preset === "radio").click();
    await tick();
    voicePuts = puts(before, /\/voice$/);
    if (voicePuts.length !== 3 || !same(JSON.parse(voicePuts[2].body).chain, P.radio) || JSON.parse(voicePuts[2].body).scope !== "character") fail("preset didn't go to Ana's sound");

    // The ✓ line stays until the next line loads.
    await showLine(env, { takes: [mkTake()], voice: { characters: { Ana: P.radio } } });
    if (!status.hidden) fail("the ✓ line outlived the line");
    if (scope.value !== "character") fail("For lost the character's sound");
    console.log("PASS: widening to the character asks inline; Cancel restores; yes and later edits set Ana's sound");
  }

  // 9. Every line: asked with the room's words; a custom sound is "this sound". Narrowing copies onto the take.
  {
    let before = env.calls.length;
    dial("eq", "low_db").value = "3";
    dial("eq", "low_db").dispatchEvent(new w.Event("input"));
    dial("eq", "low_db").dispatchEvent(new w.Event("change"));
    await tick();
    pickScope("session");
    if (askText.textContent !== "Use this sound on every line? Lines and characters with their own sound switch too."
        || askYes.textContent !== "Use on every line") fail(`every-line ask: "${askText.textContent}" [${askYes.textContent}]`);
    askYes.click();
    await tick();
    const put = puts(before, /\/voice$/).pop();
    const body = put && JSON.parse(put.body);
    if (!body || body.scope !== "session" || "character" in body || body.chain.nodes.eq.low_db !== 3) fail(`session PUT: ${put && put.body}`);
    if (status.textContent !== "✓ Every line uses this sound") fail(`every-line status: ${status.textContent}`);

    before = env.calls.length;
    pickScope("take");
    if (!ask.hidden) fail("narrowing asked");
    await tick();
    const chainPut = puts(before, /\/chain$/);
    if (chainPut.length !== 1 || chainPut[0].url !== "/api/rooms/R1/lines/t1000/takes/k1/chain"
        || JSON.parse(chainPut[0].body).chain.nodes.eq.low_db !== 3 || puts(before, /\/voice$/).length) fail(`narrowing: ${JSON.stringify(env.calls.slice(before))}`);
    if (app.voiceScope !== "take" || app.takeForLine(0).chain.nodes.eq.low_db !== 3) fail("the take didn't get the sound");
    console.log("PASS: Every line asks with its own words; narrowing copies the sound onto the take without asking");
  }

  // 10. Before the first take: a preset is kept for the next take and sent with its upload.
  {
    await showLine(env, { takes: [] });
    const before = env.calls.length;
    chips().find((c) => c.dataset.preset === "radio").click();
    await tick(450);
    if (!same(activeChips(), ["Radio"]) || puts(before, /./).length) fail("a preset before the first take was saved or not shown");
    if (!same(app.pendingNextTakeChain.t1000, P.radio)) fail("the next take's sound isn't kept");
    await app.loadBoothLine(0);
    if (!same(activeChips(), ["Radio"]) || scope.value !== "take") fail("the next take's sound was lost on reload");

    // Sent as `chain` with the upload, as it was when recording stopped.
    const uploads = [];
    const realFetch = w.fetch;
    w.fetch = (input, opts = {}) => {
      if (/\/takes$/.test(String(input)) && opts.method === "POST") uploads.push(opts.body);
      return realFetch(input, opts);
    };
    app.stageVideo.pause = () => {};
    app.audio.stopAllPlayback = () => {};
    const blob = () => ({ blob: new w.Blob(["take"], { type: "audio/webm" }), audioBuffer: null });
    app.audio.stopRecording = async () => blob();
    app.recordState = "recording";
    await app.finishRecording();
    if (uploads.length !== 1 || !same(JSON.parse(uploads[0].get("chain")), P.radio)) fail(`upload chain: ${uploads[0] && uploads[0].get("chain")}`);
    if ("t1000" in app.pendingNextTakeChain) fail("the kept sound wasn't cleared after its upload");
    // The sound as it was when recording stopped, even if it changes while the take saves.
    app.pendingNextTakeChain.t1000 = P.radio;
    app.audio.stopRecording = async () => { app.pendingNextTakeChain.t1000 = P.warm; return blob(); };
    app.recordState = "recording";
    await app.finishRecording();
    if (uploads.length !== 2 || !same(JSON.parse(uploads[1].get("chain")), P.radio)) fail("the upload didn't send the sound kept when recording stopped");
    if (!same(app.pendingNextTakeChain.t1000, P.warm)) fail("a sound picked during the save was dropped");
    // Nothing kept: no chain field, and the engine keeps today's behaviour.
    app.pendingNextTakeChain = {};
    app.audio.stopRecording = async () => blob();
    app.recordState = "recording";
    await app.finishRecording();
    if (uploads.length !== 3 || uploads[2].get("chain") !== null) fail("an upload without a kept sound sent chain");
    w.fetch = realFetch;
    console.log("PASS: before the first take a preset is kept for the next take and sent with its upload");
  }

  // 11. The pulse follows the scheduler: waiting and rendering pulse, current doesn't;
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
        || !scope.disabled) fail("effect controls on without voice effects");
    const knobWrap = dial("eq", "low_db").closest(".analog-dial-wrapper");
    if (!knobWrap || knobWrap.getAttribute("aria-disabled") !== "true" || knobWrap.tabIndex !== -1) fail("a locked dial is still in the tab order");
    if ($("slider-gain").disabled || $("check-noise-reduction").disabled) fail("Level or Clean up noise turned off with the effects");
    // An engine that sends no message still gets the plain one, never a download promise.
    app.voiceEffectsMessage = "";
    app.refreshVoiceControls();
    if (note.textContent !== "Download and install the latest DubMate to use voice effects.") fail(`fallback note: ${note.textContent}`);
    env.renderReply = null;
    app.voiceUnavailable = false;
    console.log("PASS: the pulse follows the scheduler (still under reduced motion); unavailable turns effects off with the message");
  }

  // 12. voice_updated: someone gave Ana Monster; a take without its own sound follows it.
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
