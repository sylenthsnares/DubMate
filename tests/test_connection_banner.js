/**
 * test_connection_banner.js
 *
 * The connection pill in the studio header (UI pass U1, step 7):
 *  - amber "Lost the room. Reconnecting…" with Retry now while it retries,
 *  - red "Can't reach the room. The host may have closed it." with Try again and
 *    Leave room once it has given up,
 *  - "Some changes from the last minute didn't reach the room." after the offline
 *    queue overflowed, and the same line as a toast once the room is back,
 *  - screen readers hear lost, back and gave up once each, not every rewrite,
 *  - the stale-tab notice has a Reload button.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const LOST = "Lost the room. Reconnecting…";
const FAILED = "Can't reach the room. The host may have closed it.";
const OVERFLOW = "Some changes from the last minute didn't reach the room.";
const LOST_TIP = "Casting and ready changes are sent when it's back. Wait for it before you record.";
const FAILED_TIP = "Changes you made since it dropped are sent if Try again reconnects.";
const STALE = "DubMate was updated. Reload this page to keep going.";

function fail(msg, ...rest) {
  console.error("FAIL: " + msg, ...rest);
  process.exit(1);
}

function check(cond, msg, ...rest) {
  if (!cond) fail(msg, ...rest);
  console.log("PASS: " + msg);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    const msg = String(err && err.message);
    if (/navigation/i.test(msg)) navigations.push(msg);
    else if (!/not implemented/i.test(msg)) console.error(err);
  });
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => ({ addColorStop: () => {} }),
  });
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} }; }
    createConvolver() { return { connect: () => {} }; }
  };
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("the studio did not boot");
  const toasts = [];
  app.showToast = (message, options) => toasts.push({ message, tone: options?.tone });
  app.socket.send = () => true;
  return { w, doc: w.document, app, toasts, navigations };
}

(async () => {
  const { w, doc, app, toasts, navigations } = await boot();
  const banner = doc.getElementById("connection-banner");
  const text = doc.getElementById("connection-banner-text");
  const short = banner.querySelector(".connection-banner-short");
  const action = doc.getElementById("btn-connection-action");
  const leave = doc.getElementById("btn-connection-leave");
  const shown = (el) => el && !el.hidden;

  // Markup: the buttons sit beside the text span, never in it; the pill is not a live region.
  check(action && leave && text && short, "the pill has its text, short form and two buttons");
  check(!text.contains(action) && !text.contains(leave) && !text.contains(short), "the buttons and short form sit outside #connection-banner-text");
  check(!banner.hasAttribute("aria-live"), "the pill is not a live region; announcements go through #sr-announcer");
  check(leave.hidden, "Leave room is hidden by default");

  const said = [];
  const sr = doc.getElementById("sr-announcer");
  new w.MutationObserver(() => { if (sr.textContent) said.push(sr.textContent); })
    .observe(sr, { childList: true, characterData: true, subtree: true });

  const setState = (state, extra = {}) => {
    app.socket.connectionState = state;
    app.socket.emit("connection_state", { type: "connection_state", payload: { state, ...extra } });
  };
  let retries = 0;
  app.socket.retryNow = () => { retries += 1; };
  let leaves = 0;
  app.leaveRoom = () => { leaves += 1; };

  // The first handshake: a plain "Connecting…", nothing to press, nothing read out.
  setState("connecting");
  await tick(20);
  check(banner.style.display === "flex" && text.innerText === "Connecting…", "the first connect reads 'Connecting…'", text.innerText);
  check(!shown(action) && !shown(leave), "the first connect shows no buttons");
  check(said.length === 0, "the first connect is not read out", said);
  setState("open");

  // Lost: amber, Retry now, the tip, the short form.
  setState("reconnecting", { retryInMs: 4000, attempt: 1 });
  await tick(20);
  check(text.innerText === LOST, "a drop reads 'Lost the room. Reconnecting…'", text.innerText);
  check(!/\d/.test(text.innerText), "no countdown number");
  check(!banner.classList.contains("is-failed") && !banner.classList.contains("is-recovered"), "a drop is amber, not red");
  check(shown(action) && action.textContent === "Retry now" && !shown(leave), "a drop offers Retry now only", action.textContent);
  check(banner.getAttribute("data-tip") === LOST_TIP, "the tip says which changes wait", banner.getAttribute("data-tip"));
  check(banner.classList.contains("has-short") && short.textContent === "Reconnecting…"
    && short.getAttribute("data-tip") === `${LOST} ${LOST_TIP}`, "narrow windows get 'Reconnecting…' with the full sentence in its tip", short.getAttribute("data-tip"));
  check(said.length === 1 && said[0] === LOST, "the drop is read out once", said);

  action.click();
  check(retries === 1, "Retry now calls retryNow()");

  // Each retry passes through 'connecting'; the pill and the reader stay put.
  setState("connecting");
  setState("reconnecting", { retryInMs: 8000, attempt: 2 });
  await tick(20);
  check(text.innerText === LOST && shown(action), "a retry mid-outage keeps the reconnecting pill", text.innerText);
  check(said.length === 1, "retries are not read out again", said);

  // Gave up: red, Try again and Leave room.
  setState("failed", { attempt: 5 });
  await tick(20);
  check(text.innerText === FAILED, "giving up reads 'Can't reach the room. The host may have closed it.'", text.innerText);
  check(banner.classList.contains("is-failed"), "giving up is red");
  check(shown(action) && action.textContent === "Try again", "giving up offers Try again", action.textContent);
  check(shown(leave) && leave.textContent === "Leave room", "and Leave room");
  check(banner.getAttribute("data-tip") === FAILED_TIP, "the red tip says what Try again sends", banner.getAttribute("data-tip"));
  check(short.textContent === "Can't reach the room.", "narrow windows get the short form", short.textContent);
  check(said.length === 2 && said[1] === FAILED, "giving up is read out once", said);

  action.click();
  check(retries === 2, "Try again calls retryNow()");
  leave.click();
  check(leaves === 1, "Leave room takes the header's leave path");

  // Try again goes amber while it tries, then back online.
  setState("connecting");
  await tick(20);
  check(text.innerText === LOST && !banner.classList.contains("is-failed") && !shown(leave), "Try again shows the amber pill while it tries", text.innerText);
  check(said.length === 2, "trying again is not read out", said);
  setState("open");
  await tick(20);
  check(text.innerText === "Back online" && banner.classList.contains("is-recovered"), "back reads 'Back online'", text.innerText);
  check(!shown(action) && !shown(leave) && !banner.hasAttribute("data-tip"), "back hides the buttons and the tip");
  check(said.length === 3 && said[2] === "Back online", "back is read out once", said);

  // The queue overflowed: the pill says so, and the toast stays after recovery.
  setState("reconnecting", { retryInMs: 2000, attempt: 1 });
  app.socket.emit("queue_overflow", { type: "queue_overflow", payload: {} });
  await tick(20);
  check(text.innerText === OVERFLOW, "an overflow reads 'Some changes from the last minute didn't reach the room.'", text.innerText);
  check(shown(action) && action.textContent === "Retry now", "an overflow keeps Retry now");
  check(banner.classList.contains("is-long"), "the long sentence gives way earlier on narrow windows");
  check(toasts.length === 0, "no toast while it is still away", toasts);
  setState("open");
  app.socket.emit("queue_overflow", { type: "queue_overflow", payload: { recovered: true } });
  check(toasts.length === 1 && toasts[0].message === OVERFLOW && toasts[0].tone === "error",
    "once back, the same line stays as an error toast", toasts);
  setState("reconnecting", { retryInMs: 2000, attempt: 1 });
  check(text.innerText === LOST, "the next outage starts without the overflow line", text.innerText);
  setState("open");

  // The stale-tab notice: Reload, no Leave.
  app.showStaleTabNotice();
  check(text.innerText === STALE, "the stale-tab notice text is unchanged", text.innerText);
  check(shown(action) && action.textContent === "Reload" && !shown(leave), "the stale-tab notice offers Reload only", action.textContent);
  action.click();
  check(retries === 2 && navigations.length === 1, "Reload reloads the page instead of retrying", navigations);
  setState("reconnecting", { retryInMs: 2000, attempt: 1 });
  check(text.innerText === STALE, "the stale-tab notice stays up through connection changes");

  console.log("PASS: test_connection_banner.js");
  process.exit(0);
})().catch((e) => fail(e && e.stack || e));
