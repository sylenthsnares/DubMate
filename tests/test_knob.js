/**
 * test_knob.js
 *
 * The analog dial (static/js/knob.js, documentation/design/ui-u2-booth.md "Knobs"):
 * the mouse wheel turns a dial only while it has focus, otherwise the page scrolls;
 * wheel and arrow-key steps send 'input' each and one 'change' 400 ms after the last
 * step (so saves and renders wait like a drag's); a locked dial (its input disabled)
 * is aria-disabled, out of the tab order, and ignores the wheel, keys and dragging.
 */
const jsdom = require("jsdom");

const { buildStudioBundle } = require("./helpers/studio_dom");

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
process.on("unhandledRejection", (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const EXPOSE = ["const __mods = {};", "const __mods = window.__mods = {};"];

(async () => {
  const dom = new jsdom.JSDOM(`<!DOCTYPE html><body>
    <button id="elsewhere">Elsewhere</button>
    <div class="dsp-dial-channel"><input type="range" id="dial" min="0" max="10" step="1" value="5" aria-label="Cut below"></div>
  </body>`, { url: "http://127.0.0.1:8000/", runScripts: "dangerously" });
  const w = dom.window;
  const doc = w.document;
  w.eval(buildStudioBundle("static/js/knob.js").replace(EXPOSE[0], EXPOSE[1]));
  const { AnalogKnob } = w.__mods["static/js/knob.js"];

  const input = doc.getElementById("dial");
  const knob = new AnalogKnob(input, { size: 36 });
  const wrap = knob.container;
  const events = [];
  input.addEventListener("input", () => events.push(`input:${input.value}`));
  input.addEventListener("change", () => events.push(`change:${input.value}`));
  const wheel = (deltaY) => {
    const ev = new w.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    wrap.dispatchEvent(ev);
    return ev;
  };
  const key = (k) => {
    const ev = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    wrap.dispatchEvent(ev);
    return ev;
  };
  const drag = (fromY, toY) => {
    wrap.dispatchEvent(new w.MouseEvent("mousedown", { clientY: fromY, bubbles: true, cancelable: true }));
    w.dispatchEvent(new w.MouseEvent("mousemove", { clientY: toY, bubbles: true }));
    w.dispatchEvent(new w.MouseEvent("mouseup", { clientY: toY, bubbles: true }));
  };

  // 1. Without focus the wheel leaves the dial alone and the page scrolls.
  {
    doc.getElementById("elsewhere").focus();
    const ev = wheel(-100);
    if (ev.defaultPrevented) fail("an unfocused dial stopped the page from scrolling");
    if (input.value !== "5" || events.length) fail(`an unfocused dial turned: ${input.value} ${events}`);
    console.log("PASS: the wheel over an unfocused dial scrolls the page and leaves the dial alone");
  }

  // 2. With focus the wheel turns it: one 'input' per step, one 'change' after 400 ms of quiet.
  {
    wrap.focus();
    if (doc.activeElement !== wrap) fail("the dial can't take focus");
    const first = wheel(-100);
    const second = wheel(-100);
    if (!first.defaultPrevented || !second.defaultPrevented) fail("a focused dial let the page scroll");
    if (input.value !== "7" || events.join(",") !== "input:6,input:7") fail(`wheel steps: ${input.value} ${events}`);
    await tick(250);
    wheel(100);
    await tick(250);
    if (events.some((e) => e.startsWith("change"))) fail(`change before 400 ms of quiet: ${events}`);
    await tick(250);
    if (events.join(",") !== "input:6,input:7,input:6,change:6") fail(`one change after the last wheel step: ${events}`);
    console.log("PASS: a focused dial turns with the wheel; one change 400 ms after the last step");
  }

  // 3. Arrow keys: the same, one 'change' after the last step.
  {
    events.length = 0;
    if (!key("ArrowUp").defaultPrevented) fail("ArrowUp not handled");
    key("ArrowUp");
    key("ArrowDown");
    if (events.join(",") !== "input:7,input:8,input:7") fail(`arrow steps: ${events}`);
    await tick(450);
    if (events.join(",") !== "input:7,input:8,input:7,change:7") fail(`arrow change: ${events}`);
    // A step past the end changes nothing and sends nothing.
    events.length = 0;
    key("End");
    await tick(450);
    key("ArrowUp");
    await tick(450);
    if (events.join(",") !== "input:10,change:10") fail(`past the end: ${events}`);
    console.log("PASS: arrow keys step the dial; one change after the last step");
  }

  // 4. A drag still sends its change when let go.
  {
    events.length = 0;
    drag(100, 132);   // 32 px down = a fifth of the 160 px sweep = 2 steps
    if (input.value !== "8" || events[events.length - 1] !== "change:8") fail(`drag: ${input.value} ${events}`);
    console.log("PASS: dragging turns the dial and sends change on release");
  }

  // 5. Locked: aria-disabled, out of the tab order, and every way of turning it is ignored.
  {
    input.disabled = true;
    knob.updateVisuals();
    if (wrap.getAttribute("aria-disabled") !== "true" || wrap.tabIndex !== -1) fail(`locked dial: aria-disabled ${wrap.getAttribute("aria-disabled")} tabIndex ${wrap.tabIndex}`);
    events.length = 0;
    wrap.focus();
    const ev = wheel(-100);
    key("ArrowUp");
    key("Home");
    drag(100, 20);
    wrap.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await tick(450);
    if (input.value !== "8" || events.length) fail(`a locked dial turned: ${input.value} ${events}`);
    if (ev.defaultPrevented) fail("a locked dial stopped the page from scrolling");
    if (wrap.classList.contains("dial-active")) fail("a locked dial started a drag");

    input.disabled = false;
    knob.updateVisuals();
    if (wrap.hasAttribute("aria-disabled") || wrap.tabIndex !== 0) fail("the dial stayed locked");
    wrap.focus();
    key("ArrowDown");
    if (input.value !== "7") fail("an unlocked dial doesn't turn");
    await tick(450);
    console.log("PASS: a locked dial is aria-disabled, out of the tab order and ignores wheel, keys and drag");
  }

  console.log("ALL KNOB TESTS PASSED");
  process.exit(0);
})();
