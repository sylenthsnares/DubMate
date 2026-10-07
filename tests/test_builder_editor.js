/**
 * test_builder_editor.js
 *
 * Pack Builder editor: "Voices only" must change what you hear, not only the
 * waveform. In voices mode the video is muted and the separated voice track
 * plays beside it; in full mode the video's own sound plays. When the voice
 * track can't play (load error, or the browser refuses play()), the editor
 * switches to full audio and says so once.
 *
 * The timeline takes mouse, touch and pen through one Pointer Events path:
 * line drags, handle trims, pan/seek and the splitter.
 *
 * Lines without words show a badge (until they get text), a cue placeholder
 * and a "(no words)" timeline label; the server's warning shows above the line
 * list, and a result toast counts the lines.
 *
 * Without separated voices there is no voice track to request or switch to,
 * and a fallback to full audio never carries over to the next session.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "builder.html"), "utf8");
const BOOT = "new PackBuilderApp();";
const builderSource = fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "pack_builder.js"), "utf8");
// Expose the app instance so the timeline checks can set segments and zoom.
const bundle = buildStudioBundle("static/js/pack_builder.js").replace(BOOT, "window.__builderApp = " + BOOT);
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

/**
 * Boots builder.html, runs a fake upload + processing, and waits for the editor.
 * beforeDone(w, send) runs before the final 'transcribed' message, to check stages.
 */
async function bootEditor(transcribed = { segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] }, beforeDone = null) {
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
  w.Element.prototype.scrollIntoView = () => {};
  // jsdom has no pointer capture; record what the app asks for.
  const captures = [];
  w.Element.prototype.setPointerCapture = function (id) { captures.push(["set", this.id, id]); this._capturedId = id; };
  w.Element.prototype.hasPointerCapture = function (id) { return this._capturedId === id; };
  w.Element.prototype.releasePointerCapture = function (id) { captures.push(["release", this.id, id]); this._capturedId = undefined; };

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
  // Every toast as it is added, so the cap of 3 on screen can't hide one that was shown.
  // The app writes innerText, which older jsdom keeps as a plain property.
  const text = (el) => (typeof el.innerText === "string" ? el.innerText : el.textContent);
  const shown = [];
  new w.MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.classList && node.classList.contains("toast")) shown.push(text(node));
      }
    }
  }).observe(w.document.getElementById("toast-container"), { childList: true });
  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));

  const drop = new w.Event("drop");
  drop.dataTransfer = { files: [new w.File(["x"], "clip.mp4", { type: "video/mp4" })] };
  w.document.getElementById("video-dropzone").dispatchEvent(drop);
  w.document.getElementById("btn-start-process").click();
  await tick(50);
  if (!sources.length) fail("processing never opened the progress stream");
  if (beforeDone) beforeDone(w, (msg) => sources[0].onmessage({ data: JSON.stringify(msg) }));
  sources[0].onmessage({ data: JSON.stringify({ status: "transcribed", progress: 1, ...transcribed }) });
  await tick(700);

  const doc = w.document;
  const video = doc.getElementById("editor-video");
  const audio = doc.getElementById("editor-stem-audio");
  if (!audio) fail("#editor-stem-audio is missing from builder.html");
  const toasts = () => shown.slice();
  return {
    w, doc, video, audio, media, toasts, captures, app: w.__builderApp,
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

  // (e) timeline drags with Pointer Events (jsdom 25 has no PointerEvent).
  {
    check(!/addEventListener\(\s*['"]mouse(down|move|up)['"]/.test(builderSource), "pack_builder.js has no mousedown/mousemove/mouseup listeners left");

    const ed = await bootEditor();
    const { w, doc, app, captures } = ed;
    check(!!app, "the test can reach the builder app");
    const wrap = doc.getElementById("timeline-scroll-wrap");
    const pointer = (target, type, x, y = 50, opts = {}) => {
      const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, "pointerId", { value: opts.id ?? 1 });
      Object.defineProperty(ev, "pointerType", { value: opts.type ?? "mouse" });
      Object.defineProperty(ev, "isPrimary", { value: opts.primary ?? true });
      target.dispatchEvent(ev);
    };
    const reset = () => {
      app.duration = 10;
      app.pixelsPerSecond = 100;
      app.segments = [{ start: 2, end: 4, text: "Hi", character: "Speaker 1" }];
      app.renderTimelineSegments();
      captures.length = 0;
    };
    const block = () => doc.querySelector("#timeline-segments-overlay .builder-segment-block");
    const seg = () => app.segments[0];

    // Body drag moves the line by dx / pixelsPerSecond, capture on the scroll wrap.
    reset();
    pointer(block(), "pointerdown", 300);
    check(app.isDragging && app.dragType === "move", "pressing a line's body starts a move");
    check(captures.some(([k, id]) => k === "set" && id === "timeline-scroll-wrap"), "a line drag captures the pointer on the scroll wrap");
    pointer(wrap, "pointermove", 350);
    check(seg().start === 2.5 && seg().end === 4.5, "dragging a line 50 px at 100 px/s moves it by 0.5 s");
    pointer(wrap, "pointerup", 350);
    check(!app.isDragging, "pointerup ends the drag");
    check(captures.some(([k, id]) => k === "release" && id === "timeline-scroll-wrap"), "pointerup releases the capture");

    // End handle trims only the end.
    reset();
    pointer(block().querySelector(".handle-right"), "pointerdown", 400);
    pointer(wrap, "pointermove", 450);
    pointer(wrap, "pointerup", 450);
    check(seg().start === 2 && seg().end === 4.5, "dragging the end handle changes only the end");

    // A finger drags the same way.
    reset();
    pointer(block(), "pointerdown", 300, 50, { id: 7, type: "touch" });
    pointer(wrap, "pointermove", 250, 50, { id: 7, type: "touch" });
    pointer(wrap, "pointerup", 250, 50, { id: 7, type: "touch" });
    check(seg().start === 1.5 && seg().end === 3.5 && !app.isDragging, "a touch drag moves the line the same way");

    // A second finger is ignored, both as a new press and mid-drag.
    reset();
    pointer(block(), "pointerdown", 300, 50, { id: 8, type: "touch", primary: false });
    check(!app.isDragging && !app.isPanning, "a non-primary pointer does not start a drag");
    pointer(block(), "pointerdown", 300, 50, { id: 7, type: "touch" });
    pointer(wrap, "pointermove", 500, 50, { id: 8, type: "touch", primary: false });
    pointer(wrap, "pointerup", 500, 50, { id: 8, type: "touch", primary: false });
    check(app.isDragging && seg().start === 2, "a second finger neither moves nor ends the drag");
    pointer(wrap, "pointerup", 300, 50, { id: 7, type: "touch" });
    check(!app.isDragging, "the first finger still ends the drag");

    // pointercancel ends a drag or pan without seeking or selecting.
    reset();
    app.selectedSegmentIndex = null;
    ed.video.currentTime = 7;
    pointer(block(), "pointerdown", 300);
    app.selectedSegmentIndex = null;
    pointer(wrap, "pointercancel", 300);
    check(!app.isDragging && ed.video.currentTime === 7 && app.selectedSegmentIndex === null, "pointercancel ends a line drag without seeking or selecting");
    check(captures.some(([k]) => k === "release"), "pointercancel releases the capture");
    pointer(wrap, "pointerdown", 500);
    check(app.isPanning, "pressing empty timeline starts a pan");
    pointer(wrap, "pointercancel", 500);
    check(!app.isPanning && ed.video.currentTime === 7, "pointercancel ends a pan without seeking");

    // A plain click on empty timeline still seeks (mouse behaviour unchanged).
    pointer(wrap, "pointerdown", 500);
    pointer(wrap, "pointerup", 500);
    check(ed.video.currentTime === 5, "clicking empty timeline seeks to that point");

    // The splitter changes the timeline's height.
    const splitter = doc.getElementById("timeline-splitter-handle");
    const panel = doc.querySelector(".editor-bottom-timeline-panel");
    captures.length = 0;
    pointer(splitter, "pointerdown", 0, 500);
    check(app.isResizingTimeline, "pressing the splitter starts a resize");
    check(captures.some(([k, id]) => k === "set" && id === "timeline-splitter-handle"), "the splitter captures the pointer on itself");
    pointer(splitter, "pointermove", 0, 400);
    check(panel.style.height === "340px", "dragging the splitter up 100 px makes the timeline 100 px taller");
    pointer(splitter, "pointerup", 0, 400);
    check(!app.isResizingTimeline, "pointerup ends the resize");
    await tick(100); // let the resize re-render run before the window closes
    w.close();
  }

  // (f) lines without words, the notice and the result toast.
  {
    const ed = await bootEditor({
      warning: "X",
      segments: [
        { start: 1, end: 2, text: "Hi", character: "Speaker 1" },
        { start: 3, end: 3.5, text: "", character: "Speaker 2", nonverbal: true },
        { start: 4, end: 5, text: "Bye", character: "Speaker 1" },
      ],
    });
    const { doc } = ed;
    const notice = doc.getElementById("editor-notice");
    check(!!notice && notice.hidden === false && notice.textContent === "X", "the server warning shows in #editor-notice");
    check(ed.toasts().includes("Found 3 lines, 1 without words"), "the result toast counts lines and lines without words");

    const cards = doc.querySelectorAll("#segments-list-container .builder-cue-card");
    const badge = cards[1].querySelector(".cue-nonverbal-badge");
    check(!!badge && badge.textContent === "No words", "a line without words shows the 'No words' badge");
    check(badge.getAttribute("data-tip") === "A grunt, laugh or other sound without words. Record it like any other line.", "the badge explains itself in a tooltip");
    check(!cards[0].querySelector(".cue-nonverbal-badge"), "a line with words has no badge");
    check(cards[1].querySelector(".cue-text-input").getAttribute("placeholder") === "No words. Type a cue like (laughs) if you want.", "a line without words gets the cue placeholder");
    check(cards[0].querySelector(".cue-text-input").getAttribute("placeholder") === "Line text", "a line with words keeps the plain placeholder");

    const labels = Array.from(doc.querySelectorAll("#timeline-segments-overlay .segment-block-label"))
      .map((el) => (typeof el.innerText === "string" ? el.innerText : el.textContent));
    check(labels.includes("[Speaker 2] (no words)"), "the timeline labels a line without words '(no words)'");

    let putBody = null;
    ed.w.fetch = (url, opts) => {
      if (opts && opts.method === "PUT") putBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    const box = cards[1].querySelector(".cue-text-input");
    box.value = "(laughs)";
    box.dispatchEvent(new ed.w.Event("input"));
    await ed.app.syncSegmentsToServer();
    check(putBody && putBody.segments[1].nonverbal === true && putBody.segments[1].text === "(laughs)", "typing a cue keeps the flag, and the saved lines carry it");
    const badgeNow = () => doc.querySelectorAll("#segments-list-container .builder-cue-card")[1].querySelector(".cue-nonverbal-badge");
    check(badgeNow().hidden === true, "typing text clears the 'No words' badge");
    box.value = "  ";
    box.dispatchEvent(new ed.w.Event("input"));
    check(badgeNow().hidden === false, "clearing the text brings the badge back");

    // Transcribing the line fills it in and clears the badge too.
    ed.w.fetch = (url) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
      String(url).includes("/transcribe_segment") ? { text: "Argh" } : {}) });
    await ed.app.transcribeSingleSegment(1, null, box);
    check(ed.app.segments[1].text === "Argh" && badgeNow().hidden === true, "a transcribed line loses the 'No words' badge");

    // A re-render keeps the badge hidden for a line with text.
    ed.app.renderSegmentsList();
    check(badgeNow().hidden === true, "a line with text renders without a visible badge");
    ed.w.close();
  }
  {
    const ed = await bootEditor({ warning: "", segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] });
    check(ed.doc.getElementById("editor-notice").hidden === true, "an empty warning keeps the notice hidden");
    check(ed.toasts().includes("Found 1 line"), "one line says 'Found 1 line'");
    ed.w.close();
  }

  // (g) the speaker detection stage, and its notice after the separation notice.
  {
    const notice = "Speaker detection isn't installed, so speakers were guessed from pauses. To add it, remove Pack Builder in Audio settings, then run the DubMate installer again and tick Pack Builder.";
    const ed = await bootEditor({ warning: "Basic separation. " + notice, segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] },
      (w, send) => {
        const stage = (id) => w.document.getElementById(id).classList.contains("active");
        send({ status: "transcribing", progress: 0.7, message: "Writing out the dialogue" });
        check(stage("stage-whisper") && !stage("stage-speakers"), "transcribing lights the transcription stage only");
        send({ status: "detecting_speakers", progress: 0.88, message: "Detecting who speaks", stage: "speakers" });
        check(stage("stage-speakers") && !stage("stage-whisper"), "'detecting_speakers' activates #stage-speakers");
        const el = w.document.getElementById("process-stage-text");
        check((typeof el.innerText === "string" ? el.innerText : el.textContent) === "Detecting who speaks", "the stage message shows while detecting");
      });
    check(ed.doc.getElementById("editor-notice").textContent === "Basic separation. " + notice, "the speaker notice shows in #editor-notice");
    ed.w.close();
  }

  // (h) no voice track (basic filter): nothing to request, nothing to switch.
  {
    const ed = await bootEditor({ voices_separated: false, segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] });
    const btn = ed.doc.getElementById("btn-toggle-audio-track");
    check(!ed.audio.hasAttribute("src"), "without separated voices the voice track is never requested");
    check(ed.label() === "Full audio" && ed.video.muted === false, "without separated voices the editor plays the full audio");
    check(btn.getAttribute("aria-disabled") === "true", "the Voices only / Full audio switch is marked unavailable");
    check(btn.getAttribute("data-tip") === "Voices weren't separated for this video, so only the full audio can play.", "the switch's tooltip says why");
    ed.toggle();
    await tick();
    check(ed.label() === "Full audio" && ed.toasts().every((t) => !/^Playing /.test(t)), "clicking the unavailable switch changes nothing");
    ed.play();
    await tick();
    check(!ed.media.calls.includes("play:editor-stem-audio") && ed.video.paused === false, "play runs the video with its own sound only");
    check(!ed.toasts().includes(FALLBACK_TOAST), "no fallback toast when there was never a voice track");
    ed.w.close();
  }

  // (i) a fallback or a missing voice track doesn't stick to the next session in the tab.
  {
    const ed = await bootEditor();
    const { app, doc } = ed;
    const btn = doc.getElementById("btn-toggle-audio-track");
    const nextSession = async (id, extra = {}) => {
      app.pauseMedia();
      app.sessionId = id;
      app.openEditor({ status: "transcribed", segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }], ...extra });
      await tick(50);
    };
    ed.audio.dispatchEvent(new ed.w.Event("error"));
    await tick();
    check(ed.label() === "Full audio", "session 1 fell back to full audio");

    await nextSession("sess2", { voices_separated: true });
    check(ed.label() === "Voices only" && ed.video.muted === true, "the next session starts on voices only again");
    check(ed.audio.getAttribute("src") === "/api/builder/sess2/audio/vocals", "the next session loads its own voice track");
    check(!btn.hasAttribute("aria-disabled") && btn.getAttribute("data-tip") === "Hear and see voices only, or the full audio", "the switch is available again");
    ed.audio.dispatchEvent(new ed.w.Event("error"));
    await tick();
    check(ed.toasts().filter((t) => t === FALLBACK_TOAST).length === 2, "a fallback in the next session says so again");

    await nextSession("sess3", { voices_separated: false });
    check(ed.label() === "Full audio" && !ed.audio.hasAttribute("src"), "a session without voices plays full audio");
    await nextSession("sess4", { voices_separated: true });
    check(ed.label() === "Voices only" && !btn.hasAttribute("aria-disabled"), "a session without voices doesn't stick either");

    // A choice the user made does carry over.
    ed.toggle();
    await tick();
    await nextSession("sess5", { voices_separated: true });
    check(ed.label() === "Full audio", "choosing Full audio yourself carries over to the next session");
    ed.w.close();
  }

  console.log("All Pack Builder editor playback and timeline checks passed.");
  process.exit(0);
})().catch((err) => fail(err && err.stack || err));
