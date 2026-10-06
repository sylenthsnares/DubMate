/**
 * test_builder_editor.js
 *
 * Pack Builder editor: "Voices only" must change what you hear, not only the
 * waveform. In voices mode the video is muted and the separated voice track
 * plays beside it; in full mode the video's own sound plays. When the voice
 * track can't play (load error, or the browser refuses play()), the editor
 * switches to full audio and says so once.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "builder.html"), "utf8");
const bundle = buildStudioBundle("static/js/pack_builder.js");
const { JSDOM, VirtualConsole } = jsdom;

const FALLBACK_TOAST = "Voices-only playback isn't available, so you're hearing the full audio.";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function check(cond, msg) {
  if (!cond) fail(msg);
  console.log("PASS: " + msg);
}

process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Boots builder.html, runs a fake upload + processing, and waits for the editor. */
async function bootEditor() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, { url: "http://localhost:8000/builder.html", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.scrollTo = () => {};

  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  w.fetch = (url) => {
    const u = String(url);
    if (u === "/api/builder/upload") return json({ session_id: "sess1", duration: 10 });
    if (u.includes("/waveform")) return json({ peaks: [[-0.5, 0.5]], duration: 10 });
    return json({});
  };
  const sources = [];
  w.EventSource = class {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
  };

  // Media stubs: jsdom implements no playback. play() returns a promise the
  // test controls per element, pause() fires 'pause' like a browser does.
  const media = { calls: [], audioPlay: () => Promise.resolve() };
  const proto = w.HTMLMediaElement.prototype;
  Object.defineProperty(proto, "paused", { configurable: true, get() { return this._paused !== false; } });
  let times = new WeakMap();
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get() { return times.get(this) || 0; },
    set(v) { times.set(this, v); },
  });
  proto.load = function () {};
  proto.play = function () {
    media.calls.push(`play:${this.id}`);
    this._paused = false;
    return this.id === "editor-stem-audio" ? media.audioPlay() : Promise.resolve();
  };
  proto.pause = function () {
    media.calls.push(`pause:${this.id}`);
    const was = this._paused === false;
    this._paused = true;
    if (was) this.dispatchEvent(new w.Event("pause"));
  };

  // Let jsdom fire its own DOMContentLoaded first, or the app would be built twice.
  if (w.document.readyState === "loading") {
    await new Promise((r) => w.document.addEventListener("DOMContentLoaded", r));
  }
  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));

  const drop = new w.Event("drop");
  drop.dataTransfer = { files: [new w.File(["x"], "clip.mp4", { type: "video/mp4" })] };
  w.document.getElementById("video-dropzone").dispatchEvent(drop);
  w.document.getElementById("btn-start-process").click();
  await tick(50);
  if (!sources.length) fail("processing never opened the progress stream");
  sources[0].onmessage({ data: JSON.stringify({ status: "transcribed", progress: 1, segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] }) });
  await tick(700);

  const doc = w.document;
  const video = doc.getElementById("editor-video");
  const audio = doc.getElementById("editor-stem-audio");
  if (!audio) fail("#editor-stem-audio is missing from builder.html");
  // The app writes innerText, which older jsdom keeps as a plain property.
  const text = (el) => (typeof el.innerText === "string" ? el.innerText : el.textContent);
  const toasts = () => Array.from(doc.querySelectorAll("#toast-container .toast")).map(text);
  return {
    w, doc, video, audio, media, toasts,
    play: () => doc.getElementById("btn-play-pause").click(),
    toggle: () => doc.getElementById("btn-toggle-audio-track").click(),
    label: () => text(doc.getElementById("label-active-track")),
  };
}

(async () => {
  // (a) voices mode: play mutes the video and plays both elements.
  {
    const ed = await bootEditor();
    check(ed.audio.getAttribute("src") === "/api/builder/sess1/audio/vocals", "the editor loads the voice track for the session");
    ed.video.currentTime = 3.5;
    ed.play();
    await tick();
    check(ed.video.muted === true, "voices mode mutes the video");
    check(ed.media.calls.includes("play:editor-video") && ed.media.calls.includes("play:editor-stem-audio"), "voices mode plays the video and the voice track");
    check(ed.audio.currentTime === 3.5, "the voice track starts where the video is");

    // (b) switching to full unmutes the video and pauses the voice track.
    ed.media.calls.length = 0;
    ed.toggle();
    await tick();
    check(ed.label() === "Full audio", "the toggle shows Full audio");
    check(ed.video.muted === false, "full mode unmutes the video");
    check(ed.media.calls.includes("pause:editor-stem-audio"), "full mode pauses the voice track");
    check(!ed.media.calls.includes("pause:editor-video"), "switching track keeps the video playing");
    check(ed.toasts().includes("Playing full audio"), "switching says 'Playing full audio'");

    ed.toggle();
    await tick();
    check(ed.video.muted === true && ed.audio.paused === false, "switching back to voices mutes the video and plays the voice track");
    check(ed.toasts().includes("Playing voices only"), "switching says 'Playing voices only'");
    ed.play();
    await tick();
    check(ed.video.paused && ed.audio.paused, "pause stops both elements");
    ed.w.close();
  }

  // (c) the browser refusing audio.play() falls back to full audio, toast once.
  {
    const ed = await bootEditor();
    ed.media.audioPlay = () => Promise.reject(new ed.w.DOMException("blocked", "NotAllowedError"));
    ed.play();
    await tick();
    check(ed.label() === "Full audio", "a refused play() switches the toggle to Full audio");
    check(ed.video.muted === false, "a refused play() unmutes the video");
    check(ed.video.paused === false, "the video keeps playing after the fallback");
    check(ed.toasts().filter((t) => t === FALLBACK_TOAST).length === 1, "a refused play() shows the fallback toast");

    ed.play(); // pause
    ed.toggle(); // back to voices
    ed.play();
    await tick();
    check(ed.label() === "Full audio" && ed.video.muted === false, "a second refusal switches back to full audio again");
    check(ed.toasts().filter((t) => t === FALLBACK_TOAST).length === 1, "the fallback toast shows only once per session");
    ed.w.close();
  }

  // (d) a load error on the voice track does the same.
  {
    const ed = await bootEditor();
    ed.play();
    await tick();
    ed.audio.dispatchEvent(new ed.w.Event("error"));
    await tick();
    check(ed.label() === "Full audio", "a voice track error switches the toggle to Full audio");
    check(ed.video.muted === false, "a voice track error unmutes the video");
    check(ed.video.paused === false, "the video keeps playing after a voice track error");
    check(ed.toasts().filter((t) => t === FALLBACK_TOAST).length === 1, "a voice track error shows the fallback toast");
    ed.audio.dispatchEvent(new ed.w.Event("error"));
    await tick();
    check(ed.toasts().filter((t) => t === FALLBACK_TOAST).length === 1, "a repeated error does not repeat the toast");
    ed.w.close();
  }

  console.log("All Pack Builder editor playback checks passed.");
  process.exit(0);
})().catch((err) => fail(err && err.stack || err));
