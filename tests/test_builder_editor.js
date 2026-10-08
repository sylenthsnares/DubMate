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
async function bootEditor(transcribed = { segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] }, beforeDone = null, opts = {}) {
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
    // opts.fetch(url, json) answers a request first when it returns a promise.
    const own = opts.fetch && opts.fetch(u, json);
    if (own) return own;
    if (u.includes("/waveform")) return json({ peaks: [[-0.5, 0.5]], duration: 10 });
    return json({});
  };
  // The video uploads through XMLHttpRequest (for its progress); this one answers at once.
  w.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open(method, url) { this.url = url; }
    send() {
      setTimeout(() => {
        this.status = 200;
        this.responseText = JSON.stringify({ session_id: "sess1", duration: 10 });
        this.onload();
      }, 0);
    }
    abort() {}
  };
  const sources = [];
  w.EventSource = class {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
  };

  // Media stubs: jsdom implements no playback. play() returns a promise the
  // test controls per element, pause() fires 'pause' like a browser does.
  // readyState and seeking are plain fields the test sets (a ready element by default).
  // Every currentTime write by the app is a seek, so media.writes counts them, while
  // media.clock() moves an element's clock the way playback would, without a write.
  const media = { calls: [], writes: [], audioPlay: () => Promise.resolve() };
  const proto = w.HTMLMediaElement.prototype;
  Object.defineProperty(proto, "paused", { configurable: true, get() { return this._paused !== false; } });
  Object.defineProperty(proto, "readyState", { configurable: true, get() { return this._readyState ?? 4; }, set(v) { this._readyState = v; } });
  Object.defineProperty(proto, "seeking", { configurable: true, get() { return !!this._seeking; }, set(v) { this._seeking = v; } });
  let times = new WeakMap();
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get() { return times.get(this) || 0; },
    set(v) { media.writes.push([this.id, v]); times.set(this, v); },
  });
  media.clock = (el, v) => times.set(el, v);
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

    const cards = doc.querySelectorAll("#segments-list-container .builder-line-row");
    const badge = cards[1].querySelector(".cue-nonverbal-badge");
    check(!!badge && badge.textContent === "No words", "a line without words shows the 'No words' badge");
    check(badge.getAttribute("data-tip") === "A grunt, laugh or other sound without words. Record it like any other line.", "the badge explains itself in a tooltip");
    check(!cards[0].querySelector(".cue-nonverbal-badge"), "a line with words has no badge");
    check(cards[1].querySelector(".cue-text-input").getAttribute("placeholder") === "No words. Type a cue like (laughs) if you want.", "a line without words gets the cue placeholder");
    check(cards[0].querySelector(".cue-text-input").getAttribute("placeholder") === "Line text", "a line with words keeps the plain placeholder");

    const labels = Array.from(doc.querySelectorAll("#timeline-segments-overlay .segment-block-label"))
      .map((el) => (typeof el.innerText === "string" ? el.innerText : el.textContent));
    check(labels.includes("(no words)"), "the timeline labels a line without words '(no words)'");
    check(labels.every((l) => !l.includes("[")), "timeline labels show only the text, with no [character] prefix");

    let putBody = null;
    ed.w.fetch = (url, opts) => {
      if (opts && opts.method === "PUT") putBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    const box = cards[1].querySelector(".cue-text-input");
    box.value = "(laughs)";
    box.dispatchEvent(new ed.w.Event("input", { bubbles: true })); // as a browser sends it
    await ed.app.syncSegmentsToServer();
    check(putBody && putBody.segments[1].nonverbal === true && putBody.segments[1].text === "(laughs)", "typing a cue keeps the flag, and the saved lines carry it");
    const badgeNow = () => doc.querySelectorAll("#segments-list-container .builder-line-row")[1].querySelector(".cue-nonverbal-badge");
    check(badgeNow().hidden === true, "typing text clears the 'No words' badge");
    box.value = "  ";
    box.dispatchEvent(new ed.w.Event("input", { bubbles: true })); // as a browser sends it
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

  // (j) tracks follow overlapping lines, and the timeline scrolls vertically.
  {
    const TIP = "Lines that overlap get their own track. A line's character decides who voices it.";
    const textOf = (el) => (typeof el.innerText === "string" ? el.innerText : el.textContent);
    const ed = await bootEditor({ segments: [
      { start: 1, end: 3, text: "A", character: "Speaker 1" },
      { start: 1.2, end: 2.8, text: "B", character: "Speaker 2" },
      { start: 1.4, end: 3.5, text: "C", character: "Speaker 3" },
      { start: 5, end: 6, text: "D", character: "Speaker 1" },
    ] });
    const { w, doc, app } = ed;
    const pointer = (target, type, x, y = 50) => {
      const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      Object.defineProperty(ev, "isPrimary", { value: true });
      target.dispatchEvent(ev);
    };
    const blocks = () => Array.from(doc.querySelectorAll("#timeline-segments-overlay .builder-segment-block"));
    const tops = () => blocks().map((b) => b.style.top);
    const badge = doc.getElementById("label-daw-channel-count");
    const headers = () => Array.from(doc.querySelectorAll("#daw-channel-strips .daw-channel-header"));
    const column = doc.getElementById("daw-channel-column");

    check(!doc.getElementById("btn-add-audio-track"), "there is no Add track button");
    check(textOf(badge) === "3 tracks", "three lines at once make the badge read '3 tracks'");
    check(badge.getAttribute("data-tip") === TIP, "the track badge explains automatic tracks in a tooltip");
    check(!!column && !column.hasAttribute("data-tip"), "the track column has no tooltip of its own, so scrolling over it stays quiet");
    check(new Set(tops().slice(0, 3)).size === 3, "three overlapping lines sit in three different tracks");
    check(tops()[3] === tops()[0], "a later line that overlaps nothing goes back to the first track");
    check(headers().map(textOf).join(",") === "A1,A2,A3", "the track column shows A1 to A3");
    check(!doc.querySelector("#daw-channel-strips input, #daw-channel-strips button, #daw-channel-strips .channel-indicator"),
      "tracks have no name field, delete button or activity dot");
    check(!("tracks" in app) && typeof app.addAudioTrack === "undefined" && typeof app.deleteAudioTrack === "undefined",
      "the app keeps no manual track list");

    app.segments = [{ start: 1, end: 2, text: "Solo", character: "Speaker 1" }];
    app.renderTimelineSegments();
    check(textOf(badge) === "1 track" && headers().length === 1, "a single line shows '1 track'");
    const headerNode = headers()[0];
    app.renderTimelineSegments();
    check(headers()[0] === headerNode, "the track column isn't rebuilt when the track count stays the same");

    // A drag keeps the other lines in their tracks; the drop packs again.
    app.duration = 10;
    app.pixelsPerSecond = 100;
    app.segments = [
      { start: 0, end: 2, text: "A", character: "Speaker 1" },
      { start: 3, end: 5, text: "B", character: "Speaker 2" },
      { start: 3.5, end: 4.5, text: "C", character: "Speaker 3" },
    ];
    app.renderTimelineSegments();
    const wrap = doc.getElementById("timeline-scroll-wrap");
    const start = tops();
    check(start[0] === start[1] && start[2] !== start[1], "before the drag, C sits in its own track");
    pointer(blocks()[1], "pointerdown", 400);
    pointer(wrap, "pointermove", 150); // B moves to 0.5 s, over A
    await tick(20); // blocks move on the next frame
    const mid = tops();
    check(app.segments[1].start === 0.5, "the drag moved B to 0.5 s");
    check(mid[0] === start[0] && mid[2] === start[2], "while dragging, the other lines keep their tracks");
    check(mid[1] !== mid[0] && mid[1] === start[2], "the dragged line takes the lowest track free at its time");
    pointer(wrap, "pointerup", 150);
    const end = tops();
    check(end[0] !== end[1] && end[2] === end[0], "dropping packs the lines again");

    // A drag over a full stack opens a new track.
    app.segments = [
      { start: 1, end: 3, text: "A", character: "Speaker 1" },
      { start: 1.2, end: 2.8, text: "B", character: "Speaker 2" },
      { start: 5, end: 6, text: "D", character: "Speaker 3" },
    ];
    app.renderTimelineSegments();
    check(textOf(badge) === "2 tracks", "two lines at once make two tracks");
    pointer(blocks()[2], "pointerdown", 550);
    pointer(wrap, "pointermove", 200); // D to 1.5 s
    await tick(20);
    check(textOf(badge) === "3 tracks" && new Set(tops()).size === 3, "dragging a line over two others opens a third track");
    pointer(wrap, "pointerup", 200);

    // The track column follows the timeline's vertical scroll.
    const list = doc.getElementById("daw-channel-strips");
    wrap.scrollTop = 40;
    wrap.dispatchEvent(new w.Event("scroll"));
    check(list.scrollTop === 40, "the track column scrolls with the timeline");

    // Wheel over the track column scrolls the timeline up and down.
    Object.defineProperty(wrap, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(wrap, "clientHeight", { configurable: true, value: 150 });
    const wheel = (target, opts) => {
      const ev = new w.WheelEvent("wheel", { bubbles: true, cancelable: true, ...opts });
      target.dispatchEvent(ev);
      return ev;
    };
    wrap.scrollTop = 0;
    let ev = wheel(headers()[0], { deltaY: 60 });
    check(wrap.scrollTop === 60 && ev.defaultPrevented, "a wheel over the track column scrolls the timeline down");
    wrap.scrollTop = 150;
    ev = wheel(column, { deltaY: 60 });
    check(wrap.scrollTop === 150 && !ev.defaultPrevented, "at the bottom the wheel is left to the page");
    wrap.scrollTop = 0;
    ev = wheel(column, { deltaY: -60 });
    check(wrap.scrollTop === 0 && !ev.defaultPrevented, "at the top a wheel up is left to the page");

    // Wheel over the tracks still pans sideways or zooms.
    wrap.scrollTop = 20;
    wrap.scrollLeft = 0;
    wheel(wrap, { deltaY: 50 });
    check(wrap.scrollLeft === 50 && wrap.scrollTop === 20, "a plain wheel over the tracks pans sideways");
    wheel(wrap, { deltaX: 30, deltaY: 5 });
    check(wrap.scrollLeft === 80, "a sideways trackpad swipe pans by its sideways distance");
    const pps = app.pixelsPerSecond;
    wheel(wrap, { deltaY: -50, ctrlKey: true });
    check(app.pixelsPerSecond > pps, "Ctrl + wheel still zooms");
    app.pixelsPerSecond = 100;

    // Dragging empty timeline pans both ways; a click still seeks.
    wrap.scrollLeft = 100;
    wrap.scrollTop = 50;
    ed.video.currentTime = 7;
    pointer(wrap, "pointerdown", 500, 100);
    pointer(wrap, "pointermove", 480, 70);
    check(wrap.scrollLeft === 120 && wrap.scrollTop === 80, "dragging empty timeline pans sideways and up and down");
    pointer(wrap, "pointerup", 480, 70);
    check(ed.video.currentTime === 7, "a pan doesn't seek");
    pointer(wrap, "pointerdown", 500, 100);
    pointer(wrap, "pointermove", 500, 90);
    pointer(wrap, "pointerup", 500, 90);
    check(ed.video.currentTime === 7, "an up-and-down pan doesn't seek either");
    pointer(wrap, "pointerdown", 500, 100);
    pointer(wrap, "pointermove", 502, 102);
    pointer(wrap, "pointerup", 502, 102);
    check(Math.abs(ed.video.currentTime - 5.02) < 1e-9, "a click with a tiny wobble still seeks");

    // Pressing the timeline's scrollbars scrolls; it neither pans nor seeks.
    Object.defineProperty(wrap, "offsetWidth", { configurable: true, value: 808 });
    Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(wrap, "offsetHeight", { configurable: true, value: 158 });
    pointer(wrap, "pointerdown", 804, 60);
    check(!app.isPanning, "pressing the up-and-down scrollbar doesn't start a pan");
    pointer(wrap, "pointerup", 804, 60);
    check(Math.abs(ed.video.currentTime - 5.02) < 1e-9, "releasing the scrollbar doesn't seek");
    pointer(wrap, "pointerdown", 300, 154);
    check(!app.isPanning, "pressing the sideways scrollbar doesn't start a pan");
    pointer(wrap, "pointerup", 300, 154);
    pointer(wrap, "pointerdown", 300, 60);
    pointer(wrap, "pointerup", 300, 60);
    check(Math.abs(ed.video.currentTime - 3) < 1e-9, "a click inside the tracks still seeks with scrollbars showing");

    // A line dragged into a track below the visible ones scrolls into view.
    app.segments = [
      { start: 1, end: 3, text: "A", character: "Speaker 1" },
      { start: 1.1, end: 3, text: "B", character: "Speaker 2" },
      { start: 1.2, end: 3, text: "C", character: "Speaker 3" },
      { start: 1.3, end: 3, text: "D", character: "Speaker 1" },
      { start: 5, end: 6, text: "E", character: "Speaker 2" },
    ];
    app.renderTimelineSegments();
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
    pointer(blocks()[4], "pointerdown", 550, 60);
    pointer(wrap, "pointermove", 400, 60); // E to 3.5 s: still track 1
    await tick(20);
    check(wrap.scrollTop === 0, "a drag within the visible tracks doesn't scroll");
    pointer(wrap, "pointermove", 200, 60); // E to 1.5 s: a fifth track, below the fold
    await tick(20);
    const dragged = blocks()[4];
    const bottom = 24 + parseFloat(dragged.style.top) + parseFloat(dragged.style.height);
    check(textOf(badge) === "5 tracks" && bottom <= wrap.scrollTop + 150 && wrap.scrollTop > 0, "the dragged line's new track scrolls into view");
    pointer(wrap, "pointerup", 200, 60);
    await tick(50);
    w.close();
  }

  // (k) the Cast row scrolls by wheel, drag and keyboard, and shows which edge has more.
  {
    const ed = await bootEditor({ segments: Array.from({ length: 12 }, (_, i) => (
      { start: i, end: i + 0.5, text: "L" + i, character: "Character " + (i + 1) })) });
    const { w, doc, app } = ed;
    const list = doc.getElementById("character-chips-list");
    // jsdom has no layout: give the list a width, a content width and a clamped scrollLeft.
    let contentWidth = 1820;
    const boxWidth = 853;
    let left = 0;
    Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => contentWidth });
    Object.defineProperty(list, "clientWidth", { configurable: true, get: () => boxWidth });
    Object.defineProperty(list, "scrollLeft", {
      configurable: true,
      get: () => left,
      set: (v) => { left = Math.max(0, Math.min(Math.max(0, contentWidth - boxWidth), v)); },
    });
    const max = contentWidth - boxWidth;
    const wheel = (opts) => {
      const ev = new w.WheelEvent("wheel", { bubbles: true, cancelable: true, ...opts });
      list.firstElementChild.dispatchEvent(ev);
      return ev;
    };
    const key = (k) => {
      const ev = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      list.dispatchEvent(ev);
      return ev;
    };
    const pointer = (target, type, x, opts = {}) => {
      const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 20, buttons: opts.buttons ?? 0 });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      Object.defineProperty(ev, "pointerType", { value: opts.type ?? "mouse" });
      Object.defineProperty(ev, "isPrimary", { value: true });
      target.dispatchEvent(ev);
    };
    const has = (c) => list.classList.contains(c);

    app.renderCharacterChips();
    check(list.querySelectorAll(".char-color-chip").length === 12, "twelve characters make twelve chips");
    check(list.getAttribute("tabindex") === "0" && list.getAttribute("aria-label") === "Cast" && list.getAttribute("role") === "group",
      "an overflowing Cast row is a focusable group labelled 'Cast'");
    check(has("has-more-end") && !has("has-more-start"), "at the start only the end edge shows more");

    // A vertical mouse wheel scrolls the row sideways.
    let ev = wheel({ deltaY: 100 });
    check(left === 100 && ev.defaultPrevented, "a vertical wheel scrolls the Cast row sideways");
    list.dispatchEvent(new w.Event("scroll"));
    check(has("has-more-start") && has("has-more-end"), "in the middle both edges show more");
    ev = wheel({ deltaY: 3, deltaMode: 1 });
    check(left === 148, "a line-mode wheel scrolls 16 px per line");
    ev = wheel({ deltaY: 100, ctrlKey: true });
    check(left === 148 && !ev.defaultPrevented, "Ctrl + wheel is left to the browser");
    ev = wheel({ deltaX: 40, deltaY: 5 });
    check(left === 148 && !ev.defaultPrevented, "a sideways trackpad swipe is left to native scrolling");
    left = max;
    list.dispatchEvent(new w.Event("scroll"));
    check(has("has-more-start") && !has("has-more-end"), "at the end only the start edge shows more");
    ev = wheel({ deltaY: 100 });
    check(left === max && !ev.defaultPrevented, "at the end the wheel is left to the page");

    // A mouse drag past 5 px scrolls, and the click that follows doesn't rename.
    let prompts = 0;
    w.prompt = () => { prompts++; return null; };
    const name = list.querySelector(".chip-name");
    left = 200;
    pointer(name, "pointerdown", 300, { buttons: 1 });
    pointer(list, "pointermove", 297, { buttons: 1 });
    check(left === 200, "a wobble under 5 px doesn't scroll");
    pointer(list, "pointermove", 250, { buttons: 1 });
    check(left === 250, "dragging the row 50 px left scrolls it 50 px");
    pointer(list, "pointerup", 250);
    name.click();
    check(prompts === 0, "the click after a drag doesn't rename the character");
    name.click();
    check(prompts === 1, "a plain click still renames");
    left = 200;
    pointer(name, "pointerdown", 300, { buttons: 1, type: "touch" });
    pointer(list, "pointermove", 250, { buttons: 1, type: "touch" });
    pointer(list, "pointerup", 250, { type: "touch" });
    check(left === 200, "touch is left to native scrolling");
    pointer(list, "pointermove", 100);
    check(left === 200, "moving the mouse without a button pressed doesn't scroll");

    // Keyboard: arrows scroll 120 px, Home and End go to the ends.
    left = 0;
    ev = key("ArrowRight");
    check(left === 120 && ev.defaultPrevented, "ArrowRight scrolls the row 120 px");
    key("ArrowLeft");
    check(left === 0, "ArrowLeft scrolls back");
    key("End");
    check(left === max, "End goes to the last chip");
    key("Home");
    check(left === 0, "Home goes to the first chip");
    // The arrows scroll the row only: the editor's own arrow shortcuts don't also move the video.
    ed.video.currentTime = 3;
    key("ArrowRight");
    check(left === 120 && ed.video.currentTime === 3, "ArrowRight on the Cast row doesn't move the video");
    const shiftLeft = new w.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true });
    list.dispatchEvent(shiftLeft);
    check(left === 0 && ed.video.currentTime === 3, "Shift+ArrowLeft on the Cast row doesn't move the video");

    // Adding a character scrolls its chip into view.
    const seen = [];
    w.Element.prototype.scrollIntoView = function (opts) { seen.push([this, opts]); };
    w.prompt = () => "Narrator";
    app.promptAddCharacter();
    const added = seen.find(([el]) => el.classList && el.classList.contains("char-color-chip"));
    check(!!added && added[0].querySelector(".chip-name").textContent === "Narrator" && added[1] && added[1].inline === "nearest",
      "a new character's chip scrolls into view");

    // When everything fits: not focusable, no fades, the wheel goes to the page.
    contentWidth = boxWidth;
    left = 0;
    app.renderCharacterChips();
    check(!list.hasAttribute("tabindex") && !has("has-more-start") && !has("has-more-end"),
      "a Cast row that fits isn't focusable and shows no fades");
    ev = wheel({ deltaY: 100 });
    check(!ev.defaultPrevented, "a wheel over a Cast row that fits is left to the page");
    contentWidth = 1820;
    w.dispatchEvent(new w.Event("resize"));
    check(list.getAttribute("tabindex") === "0" && has("has-more-end"), "a window resize updates the Cast row");
    await tick(100);
    w.close();
  }

  // (l) the video leads and the voice waits: no replayed start while the video seeks.
  {
    const ed = await bootEditor();
    const { w, doc, video, audio, media } = ed;
    const voiceWrites = () => media.writes.filter(([id]) => id === "editor-stem-audio").length;
    const voicePlays = () => media.calls.filter((c) => c === "play:editor-stem-audio").length;
    const label = () => { const el = doc.getElementById("label-play-btn"); return typeof el.innerText === "string" ? el.innerText : el.textContent; };
    // n animation frames; a playing element's clock moves 20 ms per frame unless held still.
    const frames = async (n, { videoMoves = true } = {}) => {
      for (let i = 0; i < n; i++) {
        if (!audio.paused) media.clock(audio, audio.currentTime + 0.02);
        if (videoMoves && !video.paused) media.clock(video, video.currentTime + 0.02);
        await tick(17);
      }
    };

    // Play while the video is still seeking: the voice is played in the click, then waits.
    media.clock(video, 12);
    media.clock(audio, 12);
    video.readyState = 1;
    media.writes.length = 0;
    media.calls.length = 0;
    ed.play();
    check(media.calls.includes("play:editor-video") && media.calls.includes("play:editor-stem-audio"),
      "Play calls play() on the video and the voice inside the click");
    check(label() === "Pause", "the Play button shows Pause as soon as it is clicked");
    await frames(30, { videoMoves: false });
    check(voiceWrites() === 0, "while the video isn't ready, the voice is never sent back to its start");
    check(audio.paused, "while the video isn't ready, the voice waits");

    // The video starts: the voice resumes once, from the video's time.
    media.clock(audio, 12.08);
    video.readyState = 4;
    media.calls.length = 0;
    video.dispatchEvent(new w.Event("playing"));
    check(!audio.paused && voicePlays() === 1, "when the video starts playing, the voice resumes once");
    check(audio.currentTime === 12 && voiceWrites() === 1, "the voice resumes from the video's time");
    await frames(20);
    video.dispatchEvent(new w.Event("playing"));
    check(voicePlays() === 1 && voiceWrites() === 1, "a voice that is already following isn't restarted or re-seeked");

    // Real drift is still corrected, once, and not again for the next 750 ms.
    media.clock(audio, video.currentTime + 0.5);
    await frames(2);
    check(voiceWrites() === 2 && Math.abs(audio.currentTime - video.currentTime) < 0.05, "a voice 0.5 s off is brought back to the video");
    media.clock(audio, video.currentTime + 0.5);
    await frames(10);
    check(voiceWrites() === 2, "a second correction waits at least 750 ms");

    // A seek while playing: the voice waits until the video has seeked.
    media.clock(video, 20);
    video.seeking = true;
    video.readyState = 1;
    video.dispatchEvent(new w.Event("seeking"));
    check(audio.paused && audio.currentTime === 20, "a seek while playing moves the voice and holds it");
    await frames(10, { videoMoves: false });
    check(audio.paused && voiceWrites() === 3, "the voice stays put while the video seeks");
    video.seeking = false;
    video.readyState = 4;
    video.dispatchEvent(new w.Event("seeked"));
    check(!audio.paused, "the voice resumes when the seek is done");

    // Play when the voice is already where the video is: no seek at all.
    ed.play();
    check(video.paused && audio.paused && label() === "Play", "Pause stops both and shows Play");
    media.clock(video, 5);
    media.clock(audio, 5.01);
    media.writes.length = 0;
    ed.play();
    check(!video.paused && !audio.paused && voiceWrites() === 0, "Play with the voice already in place doesn't seek it");
    ed.play();
    w.close();
  }

  // (m) a line's Play stops at the line's end by the video's clock, even when the video starts late.
  {
    const ed = await bootEditor({ segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] });
    const { w, doc, video, audio, media } = ed;
    const preview = () => doc.querySelector("#cue-card-0 .btn-preview-cue").click();
    const frames = async (n, step) => {
      for (let i = 0; i < n; i++) {
        if (!video.paused) media.clock(video, video.currentTime + step);
        if (!audio.paused) media.clock(audio, audio.currentTime + step);
        await tick(17);
      }
    };
    video.readyState = 1;
    preview();
    check(video.currentTime === 1 && !video.paused, "a line's Play seeks to the line and plays");
    await frames(60, 0); // about 1 s with the video stuck
    check(!video.paused, "a video that starts late keeps playing");
    video.readyState = 4;
    video.dispatchEvent(new w.Event("playing"));
    await frames(40, 0.05);
    check(video.paused && audio.paused, "a line's Play stops at the line's end even when the video started late");
    check(video.currentTime >= 2 && video.currentTime < 2.2, "it stops right at the end, not later");

    // A manual seek during a line's Play cancels the stop.
    preview();
    await frames(3, 0.05);
    ed.app.seekTo(0.2);
    await frames(40, 0.05);
    check(!video.paused, "seeking during a line's Play cancels its stop");
    ed.play();
    w.close();
  }

  // (n) snappiness: blocks before the waveform, selection without a rebuild, drags once per
  // frame, a text edit touches one label, and each track's waveform is fetched once.
  {
    let release = null;
    const waveformCalls = [];
    const ed = await bootEditor({ segments: [
      { start: 1, end: 2, text: "A", character: "Speaker 1" },
      { start: 3, end: 4, text: "B", character: "Speaker 2" },
      { start: 5, end: 6, text: "C", character: "Speaker 1" },
    ] }, null, { fetch: (u, json) => {
      if (!u.includes("/waveform")) return null;
      waveformCalls.push(u);
      if (waveformCalls.length > 1) return json({ peaks: [[-0.2, 0.2]], duration: 10 });
      // The first waveform request hangs until the test lets it answer.
      return new Promise((r) => { release = () => r({ ok: true, status: 200, json: () => Promise.resolve({ peaks: [[-0.5, 0.5]], duration: 10 }) }); });
    } });
    const { w, doc, app } = ed;
    const textOf = (el) => (typeof el.innerText === "string" ? el.innerText : el.textContent);
    const blocks = () => Array.from(doc.querySelectorAll("#timeline-segments-overlay .builder-segment-block"));
    const card = (i) => doc.getElementById(`cue-card-${i}`);
    const timecode = (i) => textOf(card(i).querySelector(".cue-timecode-badge"));

    check(typeof release === "function" && blocks().length === 3 && !!card(2), "the editor draws its lines while the waveform is still loading");
    let waveDraws = 0;
    const drawWave = app.renderWaveformCanvas;
    app.renderWaveformCanvas = function (...args) { waveDraws++; return drawWave.apply(this, args); };
    release();
    await tick();
    check(app.waveformPeaks.length === 1 && app.waveformPeaks[0][1] === 0.5 && waveDraws > 0, "the waveform is drawn when it arrives");

    // Selecting a line moves the highlight; the timeline blocks stay the same nodes.
    let fullRenders = 0;
    const renderAll = app.renderTimelineSegments;
    app.renderTimelineSegments = function (...args) { fullRenders++; return renderAll.apply(this, args); };
    const first = blocks();
    card(1).querySelector(".cue-number").click();
    check(blocks().every((b, i) => b === first[i]) && fullRenders === 0, "selecting a line doesn't rebuild the timeline");
    check(first[1].classList.contains("selected") && card(1).classList.contains("selected"), "the selected line's block and card are highlighted");
    card(2).querySelector(".cue-number").click();
    check(!first[1].classList.contains("selected") && !card(1).classList.contains("selected")
      && first[2].classList.contains("selected") && card(2).classList.contains("selected"), "selecting another line moves the highlight");

    // A text edit updates that line's block label only.
    const ta = card(1).querySelector(".cue-text-input");
    ta.value = "Bee";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    ta.dispatchEvent(new w.Event("change", { bubbles: true }));
    check(fullRenders === 0 && blocks()[1] === first[1] && textOf(first[1].querySelector(".segment-block-label")) === "Bee",
      "a text edit updates its block's label without rebuilding the timeline");

    // A drag moves the line's time at once, and its block once per frame.
    const wrap = doc.getElementById("timeline-scroll-wrap");
    const pointer = (target, type, x, y = 50) => {
      const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      Object.defineProperty(ev, "isPrimary", { value: true });
      target.dispatchEvent(ev);
    };
    app.duration = 10;
    app.pixelsPerSecond = 100;
    renderAll.call(app);
    const b0 = blocks()[0];
    pointer(b0, "pointerdown", 150);
    const code0 = timecode(0); // pressing the block selects its line, which shows start – end
    pointer(wrap, "pointermove", 200);
    check(app.segments[0].start === 1.5, "the dragged line's time follows the pointer at once");
    check(b0.style.left === "100px" && timecode(0) === code0, "the block and its card wait for the next frame");
    pointer(wrap, "pointermove", 220);
    pointer(wrap, "pointermove", 250);
    await tick(20);
    check(blocks()[0] === b0 && b0.style.left === "200px", "the next frame moves the same block to the latest position");
    check(timecode(0) === `${app.formatTime(2)} – ${app.formatTime(3)}`, "the selected row's timecode follows in the same frame");
    check(fullRenders === 0, "a drag doesn't rebuild the timeline while it moves");
    pointer(wrap, "pointerup", 250);
    check(fullRenders === 1 && !app.isDragging, "the drop packs the tracks once");

    // Each track's waveform is fetched once; switching back is instant.
    ed.toggle();
    await tick();
    check(waveformCalls.length === 2 && app.waveformPeaks[0][1] === 0.2, "switching to Full audio fetches its waveform");
    ed.toggle();
    check(app.waveformPeaks[0][1] === 0.5, "switching back shows the voice waveform at once");
    await tick();
    check(waveformCalls.length === 2, "switching back doesn't fetch the waveform again");
    w.close();
  }

  // (o) a drop that reorders other lines rebuilds the line list, so each card edits its own line.
  {
    const ed = await bootEditor();
    const { w, doc, app } = ed;
    const pointer = (target, type, x, y = 50) => {
      const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      Object.defineProperty(ev, "isPrimary", { value: true });
      target.dispatchEvent(ev);
    };
    app.duration = 10;
    app.pixelsPerSecond = 100;
    // Mark In can leave the list out of order: A's neighbour C now starts first.
    app.segments = [
      { start: 1, end: 2, text: "A", character: "Speaker 1" },
      { start: 0.2, end: 0.8, text: "C", character: "Speaker 1" },
      { start: 3, end: 4, text: "B", character: "Speaker 1" },
    ];
    app.renderTimelineSegments();
    app.renderSegmentsList();
    const blockB = doc.querySelectorAll("#timeline-segments-overlay .builder-segment-block")[2];
    const wrap = doc.getElementById("timeline-scroll-wrap");
    pointer(blockB, "pointerdown", 350);
    pointer(wrap, "pointermove", 360);
    pointer(wrap, "pointerup", 360);
    check(app.segments.map((s) => s.text).join(",") === "C,A,B" && app.segments[2].start === 3.1, "the drop sorts the lines by time");
    const ta = doc.getElementById("cue-card-0").querySelector(".cue-text-input");
    check(ta.value === "C", "the first card shows the line that now comes first");
    ta.value = "edited";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    check(app.segments.map((s) => s.text).join(",") === "edited,A,B", "editing a card changes its own line");
    w.close();
  }

  // (p) processing the same session again shows the new waveform, not the kept one.
  {
    let peak = 0.5;
    const ed = await bootEditor(undefined, null, { fetch: (u, json) => (
      u.includes("/waveform") ? json({ peaks: [[-peak, peak]], duration: 10 }) : null) });
    const { app } = ed;
    check(app.waveformPeaks[0][1] === 0.5, "the editor shows the session's waveform");
    peak = 0.3;
    app.openEditor({ segments: [{ start: 1, end: 2, text: "Hi", character: "Speaker 1" }] });
    await tick(50);
    check(app.waveformPeaks[0][1] === 0.3, "after processing again the editor fetches the new waveform");
    ed.w.close();
  }

  // (q) the Lines column: compact rows in a list, the keyboard moves between them, and
  // selecting or recasting a line rebuilds neither the list nor the timeline.
  {
    const ed = await bootEditor({ segments: [
      { start: 1, end: 2, text: "A", character: "Speaker 1" },
      { start: 3, end: 4, text: "B", character: "Speaker 2" },
      { start: 5, end: 6, text: "C", character: "Speaker 1" },
    ] });
    const { w, doc, app } = ed;
    const textOf = (el) => (typeof el.innerText === "string" ? el.innerText : el.textContent).trim();
    const list = doc.getElementById("segments-list-container");
    const rows = () => Array.from(list.querySelectorAll('[role="listitem"]'));
    const blocks = () => Array.from(doc.querySelectorAll("#timeline-segments-overlay .builder-segment-block"));
    const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    // jsdom normalises colours; compare through the same parser.
    const colour = (c) => { const d = doc.createElement("div"); d.style.borderColor = c; return d.style.borderColor; };

    // The deck has one primary, Continue.
    const primaries = Array.from(doc.querySelectorAll("#view-step-editor .btn-primary"));
    check(primaries.length === 1 && primaries[0].id === "btn-proceed-to-compile", "the editor's only primary button is Continue");
    check(["btn-play-pause", "btn-add-line-at-playhead", "btn-transcribe-line"].every((id) => doc.getElementById(id).classList.contains("btn-secondary")),
      "Play, Add line and Transcribe are secondary buttons");

    // List semantics and the roving tabindex.
    check(list.getAttribute("role") === "list" && list.getAttribute("aria-label") === "Lines", "the Lines column is a list named 'Lines'");
    check(rows().length === 3 && rows().every((r) => r.classList.contains("builder-line-row")), "each line is a row of the list");
    check(rows()[1].getAttribute("aria-label") === `Line 2, Speaker 2, ${app.formatTime(3)}`, "a row is named by its number, character and start");
    check(rows()[0].tabIndex === 0 && rows()[1].tabIndex === -1 && rows()[2].tabIndex === -1, "with nothing selected the first row takes Tab");
    check(rows().every((r) => !r.hasAttribute("aria-current")), "no row is current before a selection");

    // Start and End with nothing selected say so instead of adding a line.
    const markIn = doc.getElementById("btn-mark-in");
    const markOut = doc.getElementById("btn-mark-out");
    check(markIn.getAttribute("aria-disabled") === "true" && markIn.dataset.tip === "Select a line first"
      && markOut.getAttribute("aria-disabled") === "true" && markOut.dataset.tip === "Select a line first",
      "Start and End are unavailable with nothing selected, and say why");
    const toastsBefore = ed.toasts().length;
    markIn.click();
    markOut.click();
    for (const k of ["i", "o", "[", "]"]) key(doc.body, k);
    check(app.segments.length === 3 && rows().length === 3, "Start, End, I, O, [ and ] with nothing selected add no line");
    await tick(0); // the toast log is a MutationObserver
    const said = ed.toasts().slice(toastsBefore);
    check(said.length === 6 && said.every((t) => t === "Select a line first"), "each of them shows 'Select a line first'");

    // Selecting a row: a class toggle, the same nodes, and the seek.
    let listRenders = 0, timelineRenders = 0;
    const renderList = app.renderSegmentsList, renderTimeline = app.renderTimelineSegments;
    app.renderSegmentsList = function (...a) { listRenders++; return renderList.apply(this, a); };
    app.renderTimelineSegments = function (...a) { timelineRenders++; return renderTimeline.apply(this, a); };
    const seeks = [];
    const seekTo = app.seekTo;
    app.seekTo = function (t) { seeks.push(t); return seekTo.call(this, t); };
    const firstRows = rows();
    const firstBlocks = blocks();
    const same = () => rows().every((r, i) => r === firstRows[i]) && blocks().every((b, i) => b === firstBlocks[i]);

    firstRows[1].querySelector(".cue-number").click();
    check(app.selectedSegmentIndex === 1 && seeks[seeks.length - 1] === 3, "clicking a row selects its line and seeks to it");
    check(firstRows[1].classList.contains("selected") && firstRows[1].getAttribute("aria-current") === "true" && firstRows[1].tabIndex === 0,
      "the selected row is current and takes Tab");
    check(firstRows.filter((r, i) => i !== 1).every((r) => r.tabIndex === -1 && !r.hasAttribute("aria-current")), "the other rows leave the Tab order");
    check(textOf(firstRows[1].querySelector(".cue-timecode-badge")) === `${app.formatTime(3)} – ${app.formatTime(4)}`
      && textOf(firstRows[0].querySelector(".cue-timecode-badge")) === app.formatTime(1), "the selected row shows start – end, the others their start");
    check(same() && listRenders === 0 && timelineRenders === 0, "selecting keeps the same row and block nodes");
    check(!markIn.hasAttribute("aria-disabled") && markIn.dataset.tip !== "Select a line first", "Start is available once a line is selected");

    // Up and Down move the selection and the focus, and seek like a click.
    firstRows[1].focus();
    key(firstRows[1], "ArrowDown");
    check(app.selectedSegmentIndex === 2 && doc.activeElement === firstRows[2] && seeks[seeks.length - 1] === 5, "ArrowDown selects the next line, focuses it and seeks");
    key(firstRows[2], "ArrowDown");
    check(app.selectedSegmentIndex === 2 && doc.activeElement === firstRows[2], "ArrowDown on the last line stays there");
    key(firstRows[2], "ArrowUp");
    key(firstRows[1], "ArrowUp");
    check(app.selectedSegmentIndex === 0 && doc.activeElement === firstRows[0] && seeks[seeks.length - 1] === 1, "ArrowUp moves back up to the first line");
    check(firstRows[0].tabIndex === 0 && firstRows[2].tabIndex === -1, "the roving tabindex follows the selection");

    // Enter edits the text, Esc returns to the row.
    key(firstRows[0], "Enter");
    const text0 = firstRows[0].querySelector(".cue-text-input");
    check(doc.activeElement === text0, "Enter on a row focuses its text");
    key(text0, "Escape");
    check(doc.activeElement === firstRows[0], "Esc in the text returns to the row");

    // Focusing another row's field selects that line without seeking.
    const seekCount = seeks.length;
    firstRows[2].querySelector(".cue-text-input").focus();
    check(app.selectedSegmentIndex === 2 && firstRows[2].classList.contains("selected") && seeks.length === seekCount,
      "focusing a line's text selects it without seeking");

    // The character select holds its own option until it is opened.
    const sel = firstRows[0].querySelector(".cue-char-select");
    check(sel.options.length === 1 && sel.value === "Speaker 1", "a row's character select holds only its current option");
    sel.focus();
    const names = Array.from(sel.options).map((o) => o.value);
    check(names.includes("Speaker 1") && names.includes("Speaker 2") && names.includes("__ADD_NEW__"), "focusing the select fills in the cast");
    check(app.selectedSegmentIndex === 0 && seeks.length === seekCount, "focusing a line's select selects it without seeking");
    sel.value = "Speaker 2";
    sel.dispatchEvent(new w.Event("change", { bubbles: true }));
    check(app.segments[0].character === "Speaker 2", "changing the select recasts the line");
    check(same() && listRenders === 0 && timelineRenders === 0, "recasting keeps the same row and block nodes");
    const want = colour(app.getCharacterColor("Speaker 2"));
    check(colour(firstRows[0].querySelector(".cue-dot").style.background) === want && firstBlocks[0].style.borderColor === want,
      "the row's dot and its timeline block take the new character's colour");
    check(firstBlocks[0].getAttribute("aria-label") === "Speaker 2: A" && firstBlocks[0].dataset.tip === "Speaker 2: A", "the block's name says the new character");
    check(firstRows[0].getAttribute("aria-label") === `Line 1, Speaker 2, ${app.formatTime(1)}`, "the row's name says the new character");
    const chip = Array.from(doc.querySelectorAll("#character-chips-list .char-color-chip"))
      .find((c) => textOf(c.querySelector(".chip-name")) === "Speaker 2");
    check(!!chip && textOf(chip.querySelector(".chip-count-badge")) === "(2)", "the Cast row counts the recast line");

    // Timeline blocks show the text only and name the character in their tip.
    check(textOf(firstBlocks[1].querySelector(".segment-block-label")) === "B" && firstBlocks[1].dataset.tip === "Speaker 2: B",
      "a timeline block shows the line's text, and its tip names the character");

    // The palette leaves out recording red and confirmed-take green.
    app.characterColors.clear();
    const palette = Array.from({ length: 8 }, (_, i) => colour(app.getCharacterColor(`Cast ${i}`)));
    check(new Set(palette).size === 8, "eight characters get eight different colours");
    check(!palette.includes(colour("#dc2626")) && !palette.includes(colour("#16a34a")), "no character is red or green");
    check(palette[0] === colour("#d97706") && palette[1] === colour("#06b6d4"), "the palette starts amber, then cyan");
    w.close();
  }

  console.log("All Pack Builder editor playback and timeline checks passed.");
  process.exit(0);
})().catch((err) => fail(err && err.stack || err));
