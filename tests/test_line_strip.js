/**
 * test_line_strip.js
 *
 * The booth bar's line strip (#timeline-chips), with 40 lines in a narrow bar: chips of
 * one fixed width whose label ("6 ✓ 3") doesn't grow with the take count, your lines
 * filled and everyone else's hollow, the current chip centred on the strip itself (on a
 * line change, the My lines toggle and a resize, never with scrollIntoView, which would
 * move the page too) and left alone on a redraw, one tab stop with the arrows, Home and
 * End inside, focus kept across a redraw, a vertical wheel that scrolls the strip only
 * when it can move, a mouse drag, edge fades instead of a scrollbar, and a "Line N of M"
 * badge that keeps its width. JSDOM has no layout, so the strip's geometry is stubbed:
 * 64 px chips 4 px apart inside 8 px of padding.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const N = 40;
const LINES = Array.from({ length: N }, (_, i) => ({
  line_id: `t${1000 + i}`, index: i, character: i % 2 ? "Ben" : "Ana", start: i * 2, end: i * 2 + 1,
  duration: 1, peaks: [], audio_url: `/o${i}.wav`, text: `Line ${i}`,
}));
const mk = (lineId, n) => ({
  picked: `${lineId}k1`, next_number: n + 1,
  takes: Array.from({ length: n }, (_, k) => ({ take_id: `${lineId}k${k + 1}`, number: k + 1, user_id: "u1",
    user_name: "Ana", duration: 0.8, url: `/a/${lineId}/${k}`, peaks: [], offset_ms: 0, gain_db: 0 })),
});
const TAKES = { t1000: mk("t1000", 1), t1002: mk("t1002", 12), t1003: mk("t1003", 3) };

const CHIP = 64, GAP = 4, PAD = 8;

async function boot() {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) errors.push(String(err && err.stack || err));
  });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  const observers = [];
  w.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
    observe(t) { this.targets.push(t); }
    unobserve() {}
    disconnect() { this.targets = []; }
  };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
  };
  w.scrollTo = () => {};
  const intoView = [];
  w.Element.prototype.scrollIntoView = function () { intoView.push(this); };
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true, value: { enumerateDevices: async () => [], addEventListener: () => {} },
  });
  w.fetch = (input) => {
    const u = String(input || "");
    const body = u.startsWith("/api/packs") ? [] : u.startsWith("/api/config") ? { mic_sync: {} } : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  // Geometry: each chip is CHIP px wide, GAP apart, after PAD px of the strip's padding.
  const chipIndex = (el) => [...el.parentElement.children].indexOf(el);
  for (const prop of ["offsetLeft", "offsetWidth"]) {
    const real = Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, prop);
    Object.defineProperty(w.HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        if (this.classList.contains("chip-item") && this.parentElement) {
          return prop === "offsetWidth" ? CHIP : PAD + chipIndex(this) * (CHIP + GAP);
        }
        return real.get.call(this);
      },
    });
  }

  if (w.document.readyState !== "complete") await new Promise((r) => w.addEventListener("load", () => r()));
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("studio did not boot");
  app.showToast = () => {};
  app.user = { id: "u1", name: "Ana" };
  app.socket.send = () => {};
  app.socket.connectionState = "open";
  app.audioSetup.permission = "granted";
  app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2, url });
  app.currentView = "booth";

  // The strip: a settable scrollLeft clamped to its range, and scrollTo calls on record.
  const strip = w.document.getElementById("timeline-chips");
  const geo = { width: 300, left: 0, scrollTo: [] };
  Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => geo.width });
  Object.defineProperty(strip, "scrollWidth", {
    configurable: true,
    get: () => Math.max(geo.width, 2 * PAD + strip.children.length * (CHIP + GAP) - GAP),
  });
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true,
    get: () => geo.left,
    set: (v) => { geo.left = Math.max(0, Math.min(strip.scrollWidth - geo.width, Math.round(v))); },
  });
  strip.scrollTo = (opts) => { geo.scrollTo.push(opts); strip.scrollLeft = opts.left; };
  return { w, app, errors, strip, geo, observers, intoView };
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
function room() {
  return {
    state_version: 3, room_id: "R1", host_id: "u1", status: "recording",
    users: {
      u1: { id: "u1", name: "Ana", is_online: true, is_ready: false, color: "#d97706" },
      u9: { id: "u9", name: "Mika", is_online: true, is_ready: false, color: "#16a34a" },
    },
    role_assignments: { Ana: ["u1"], Ben: ["u9"] },
    pack: { id: "P", name: "Scene", lines: LINES, characters: ["Ana", "Ben"], video_url: "/v.mp4", line_count: N },
    takes: JSON.parse(JSON.stringify(TAKES)),
  };
}
const centre = (i, width) => Math.max(0, Math.min(2 * PAD + N * (CHIP + GAP) - GAP - width,
  Math.round(PAD + i * (CHIP + GAP) - (width - CHIP) / 2)));

(async () => {
  const env = await boot();
  const { w, app, strip, geo } = env;
  const doc = w.document;
  const chips = () => [...strip.querySelectorAll(".chip-item")];
  const chipFor = (n) => chips().find((c) => text(c.querySelector(".chip-num")) === String(n));
  const show = async (index) => { await app.loadBoothLine(index); await tick(); };
  const key = (el, k) => {
    const ev = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };
  app.roomState = room();
  app.filterMyLinesOnly = false;

  // 1. One fixed width: the label is "3 ✓ 12", not "3 ✓ 12 takes"; the words stay in the name.
  {
    await show(0);
    if (chips().length !== N) fail(`${chips().length} chips for ${N} lines`);
    const c3 = chipFor(3);
    if (text(c3.querySelector(".chip-count")) !== "12") fail(`visible count on line 3: ${text(c3.querySelector(".chip-count"))}`);
    if (text(c3.querySelector(".chip-tick")) !== "✓") fail("no tick on a recorded line");
    if (c3.getAttribute("aria-label") !== "Line 3, Ana, recorded, 12 takes") fail(`line 3 name: ${c3.getAttribute("aria-label")}`);
    if (text(chipFor(2)) !== "2") fail(`an empty line's chip reads ${text(chipFor(2))}`);
    const rule = (css.match(/\n\.chip-item\s*\{([^}]*)\}/) || [])[1] || "";
    if (!/(^|;)\s*width:\s*\d+px/.test(rule)) fail("a chip has no fixed width, so a new take makes it grow");
    if (/min-width/.test(rule)) fail("a chip still sizes to its label (min-width)");
    if (!/flex:\s*0 0 auto/.test(rule)) fail("a chip can shrink or grow in the strip");
    console.log("PASS: chips have one fixed width and read '3 ✓ 12'; the take words stay in the spoken name");
  }

  // 2. Your lines are filled, everyone else's hollow; the toggle says which is on.
  {
    const toggle = doc.getElementById("btn-toggle-filter-lines");
    if (!chipFor(2).classList.contains("is-other") || chipFor(1).classList.contains("is-other")) fail("other people's lines aren't marked");
    if (!/\.chip-item\.is-other[^{]*\{[^}]*background:\s*(transparent|none)/.test(css)) fail("other people's chips look like yours");
    if (toggle.getAttribute("aria-pressed") !== "false") fail(`All lines: aria-pressed ${toggle.getAttribute("aria-pressed")}`);
    app.toggleFilterLines();
    if (toggle.getAttribute("aria-pressed") !== "true") fail(`My lines: aria-pressed ${toggle.getAttribute("aria-pressed")}`);
    if (!/your lines/i.test(toggle.dataset.tip)) fail(`My lines tip: ${toggle.dataset.tip}`);
    app.toggleFilterLines();
    if (!/everyone/i.test(toggle.dataset.tip)) fail(`All lines tip: ${toggle.dataset.tip}`);
    console.log("PASS: other people's chips are hollow, and the toggle is pressed with My lines on");
  }

  // 3. The current chip is centred on the strip itself, jumping when it's far, on a line
  //    change, the toggle and a resize; a redraw leaves a scrolled strip alone.
  {
    geo.scrollTo.length = 0;
    await show(30);
    await tick();
    const last = geo.scrollTo[geo.scrollTo.length - 1];
    if (!last || last.left !== centre(30, 300)) fail(`line 31 not centred: ${JSON.stringify(geo.scrollTo)}`);
    if (last.behavior !== "auto") fail(`a far jump animates: ${last.behavior}`);
    if (env.intoView.length) fail("the strip uses scrollIntoView, which scrolls the page too");
    await show(31);
    await tick();
    const near = geo.scrollTo[geo.scrollTo.length - 1];
    if (near.left !== centre(31, 300) || near.behavior !== "smooth") fail(`a near step: ${JSON.stringify(near)}`);

    geo.scrollTo.length = 0;
    strip.scrollLeft = 500;
    app.renderTimelineChips();
    await tick();
    if (geo.scrollTo.length || strip.scrollLeft !== 500) fail(`a redraw moved the strip: ${strip.scrollLeft}`);

    // Two redraws before the next frame: the centring uses the chip drawn last, not a
    // detached one (which would scroll the strip back to the start).
    geo.scrollTo.length = 0;
    app.chipsScrolledLine = null;
    app.renderTimelineChips();
    app.renderTimelineChips();
    await tick();
    const again = geo.scrollTo[geo.scrollTo.length - 1];
    if (!again || again.left !== centre(31, 300)) fail(`centred on a replaced chip: ${JSON.stringify(geo.scrollTo)}`);

    strip.scrollLeft = 0;
    app.toggleFilterLines();
    await tick();
    if (!geo.scrollTo.length) fail("the toggle didn't bring the current chip back");
    app.toggleFilterLines();
    await tick();

    const ro = env.observers.find((o) => o.targets.includes(strip));
    if (!ro) fail("nothing watches the strip's size");
    geo.scrollTo.length = 0;
    strip.scrollLeft = centre(31, 300);
    ro.cb([{ target: strip }]);
    if (geo.scrollTo.length) fail("a resize moved a strip whose current chip shows");
    geo.width = 160;
    strip.scrollLeft = 0;
    ro.cb([{ target: strip }]);
    const r = geo.scrollTo[geo.scrollTo.length - 1];
    if (!r || r.left !== centre(31, 160)) fail(`a resize lost the current chip: ${JSON.stringify(geo.scrollTo)}`);
    geo.width = 300;
    console.log("PASS: the current chip is centred on the strip (jump when far), on line change, toggle and resize; redraws keep the scroll");
  }

  // 4. One tab stop; the arrows, Home and End move along the chips; focus survives a redraw.
  {
    await show(4);
    const stops = chips().filter((c) => c.tabIndex === 0);
    if (stops.length !== 1 || stops[0].getAttribute("aria-current") !== "step") fail(`${stops.length} tab stops, not just the current chip`);
    if (chips().some((c) => c !== stops[0] && c.tabIndex !== -1)) fail("other chips are tab stops");
    stops[0].focus();
    let ev = key(doc.activeElement, "ArrowRight");
    if (!ev.defaultPrevented || text(doc.activeElement.querySelector(".chip-num")) !== "6") fail(`ArrowRight went to ${text(doc.activeElement)}`);
    if (doc.activeElement.tabIndex !== 0 || chipFor(5).tabIndex !== -1) fail("the tab stop didn't follow focus");
    key(doc.activeElement, "ArrowLeft");
    key(doc.activeElement, "ArrowLeft");
    if (text(doc.activeElement.querySelector(".chip-num")) !== "4") fail(`ArrowLeft went to ${text(doc.activeElement)}`);
    key(doc.activeElement, "End");
    if (text(doc.activeElement.querySelector(".chip-num")) !== String(N)) fail(`End went to ${text(doc.activeElement)}`);
    if (strip.scrollLeft !== strip.scrollWidth - strip.clientWidth) fail(`End didn't scroll to the last chip: ${strip.scrollLeft}`);
    key(doc.activeElement, "Home");
    if (text(doc.activeElement.querySelector(".chip-num")) !== "1" || strip.scrollLeft !== 0) fail(`Home: ${text(doc.activeElement)} at ${strip.scrollLeft}`);
    key(doc.activeElement, "ArrowLeft");
    if (text(doc.activeElement.querySelector(".chip-num")) !== "1") fail("ArrowLeft wrapped past the first chip");
    if (app.currentLineIndex !== 4) fail("moving focus changed the line");
    chipFor(8).focus();
    chipFor(8).click();
    await tick();
    const now = doc.activeElement;
    if (!strip.contains(now) || text(now.querySelector(".chip-num")) !== "8" || now.getAttribute("aria-current") !== "step") {
      fail(`focus after picking a chip: ${now && now.tagName} ${text(now)}`);
    }
    now.blur();
    console.log("PASS: one tab stop; arrows, Home and End move along the strip; focus stays on the chip you picked");
  }

  // 5. A vertical wheel scrolls the strip sideways, only while it can move.
  {
    await show(0);
    await tick();
    strip.scrollLeft = 0;
    const wheel = (deltaY, extra = {}) => {
      const ev = new w.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...extra });
      chipFor(2).dispatchEvent(ev);
      return ev;
    };
    let ev = wheel(120);
    if (!ev.defaultPrevented || strip.scrollLeft !== 120) fail(`wheel down: prevented ${ev.defaultPrevented}, at ${strip.scrollLeft}`);
    ev = wheel(-500);
    if (!ev.defaultPrevented || strip.scrollLeft !== 0) fail(`wheel up: at ${strip.scrollLeft}`);
    ev = wheel(-100);
    if (ev.defaultPrevented) fail("the wheel was taken at the start, where the strip can't move");
    strip.scrollLeft = strip.scrollWidth;
    ev = wheel(100);
    if (ev.defaultPrevented) fail("the wheel was taken at the end");
    strip.scrollLeft = 100;
    ev = wheel(3, { deltaMode: 1 });
    if (strip.scrollLeft <= 103) fail(`a line-mode wheel moved ${strip.scrollLeft - 100}px`);
    strip.scrollLeft = 100;
    if (wheel(10, { deltaX: 80 }).defaultPrevented) fail("a sideways wheel was taken over");
    if (wheel(100, { ctrlKey: true }).defaultPrevented) fail("Ctrl+wheel (zoom) was taken");
    geo.width = 5000;
    strip.scrollLeft = 0;
    if (wheel(100).defaultPrevented) fail("the wheel was taken when nothing overflows");
    geo.width = 300;
    console.log("PASS: a vertical wheel scrolls the strip sideways, and passes on at the ends or when it all fits");
  }

  // 6. A mouse drag scrolls the strip, and doesn't also pick the chip under it.
  {
    await show(0);
    strip.scrollLeft = 200;
    const ptr = (type, el, x) => {
      const ev = new w.MouseEvent(type, { clientX: x, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      el.dispatchEvent(ev);
    };
    const c = chipFor(6);
    ptr("pointerdown", c, 300);
    ptr("pointermove", c, 296);
    if (strip.scrollLeft !== 200) fail("a 4px wobble scrolled the strip");
    ptr("pointermove", c, 180);
    if (strip.scrollLeft !== 320) fail(`dragging 120px left: at ${strip.scrollLeft}`);
    ptr("pointerup", c, 180);
    c.click();
    await tick();
    if (app.currentLineIndex !== 0) fail("the click ending a drag picked a line");
    chipFor(6).click();
    await tick();
    if (app.currentLineIndex !== 5) fail("a plain click after a drag didn't pick the line");
    console.log("PASS: a mouse drag scrolls the strip without picking the chip it ends on");
  }

  // 7. Edge fades say there's more, in place of a scrollbar that would eat the bar's height.
  {
    await show(0);
    await tick();
    const scroll = (x) => { strip.scrollLeft = x; strip.dispatchEvent(new w.Event("scroll")); };
    scroll(0);
    if (strip.classList.contains("fade-start") || !strip.classList.contains("fade-end")) fail(`at the start: ${strip.className}`);
    scroll(400);
    if (!strip.classList.contains("fade-start") || !strip.classList.contains("fade-end")) fail(`in the middle: ${strip.className}`);
    scroll(strip.scrollWidth);
    if (!strip.classList.contains("fade-start") || strip.classList.contains("fade-end")) fail(`at the end: ${strip.className}`);
    geo.width = 5000;
    scroll(0);
    if (strip.classList.contains("fade-start") || strip.classList.contains("fade-end")) fail(`nothing to scroll: ${strip.className}`);
    geo.width = 300;
    if (!/\.timeline-chips-box::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(css)) fail("the strip still draws a WebKit scrollbar in the 44px bar");
    const ff = css.match(/@supports\s+not\s+selector\(::-webkit-scrollbar\)\s*\{([\s\S]*?)\n\}/);
    if (!ff || !/\.timeline-chips-box\s*\{[^}]*scrollbar-width:\s*none/.test(ff[1])) fail("Firefox still draws the strip's scrollbar");
    if (!/\.timeline-chips-box\.fade-(start|end)[^{]*\{[^}]*mask-image/.test(css) && !/\n\.timeline-chips-box\s*\{[^}]*mask-image/.test(css)) fail("no edge fade on the strip");
    console.log("PASS: edge fades follow the scroll position; the strip draws no scrollbar in the bar");
  }

  // 8. "Line 9 of 40" keeps one width, so the strip doesn't twitch as the number grows.
  {
    await show(8);
    const ind = doc.getElementById("booth-line-indicator");
    if (ind.style.minWidth !== `${`Line ${N} of ${N}`.length}ch`) fail(`indicator min-width: ${ind.style.minWidth}`);
    console.log("PASS: the 'Line N of M' badge is as wide as its longest text");
  }

  if (env.errors.length) fail(`console errors: ${env.errors.join(" | ")}`);
  console.log("PASS: test_line_strip.js");
  process.exit(0);
})();
