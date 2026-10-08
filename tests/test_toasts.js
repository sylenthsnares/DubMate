/**
 * test_toasts.js
 *
 * showToast (static/js/ui_common.js): a plain toast goes away by itself; an error toast
 * is announced at once (role=alert), has a Close button and stays until it is pressed;
 * at most 3 toasts show, the oldest goes first. #toast-container reads each toast on
 * its own (no aria-atomic), in the studio and in Pack Builder.
 * An action toast ("Line 4 deleted · Undo") has a real button, stays for its own
 * duration, and waits while it is hovered or focused.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const builderHtml = fs.readFileSync(path.join(PROJECT_ROOT, "static", "builder.html"), "utf8");
const bundle = buildStudioBundle("static/js/ui_common.js")
  .replace("const __mods = {};", "const __mods = window.__mods = {};");
const { JSDOM } = jsdom;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function check(cond, msg) {
  if (!cond) fail(msg);
  console.log("PASS: " + msg);
}

function boot() {
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "dangerously" });
  const w = dom.window;
  // A clock the test moves by hand, so "after 3.2 s" doesn't take 3.2 s.
  let now = 0;
  let timers = [];
  let ids = 0;
  w.setTimeout = (fn, ms = 0) => { timers.push({ id: ++ids, at: now + ms, fn }); return ids; };
  w.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
  w.requestAnimationFrame = (fn) => w.setTimeout(fn, 16);
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  w.eval(bundle);
  const doc = w.document;
  const { showToast } = w.__mods["static/js/ui_common.js"];
  const container = doc.getElementById("toast-container");
  const text = (el) => (typeof el.innerText === "string" ? el.innerText : el.textContent);
  return { w, doc, showToast, container, advance, text, toasts: () => Array.from(container.querySelectorAll(".toast")) };
}

// The container announces each toast on its own, in both pages.
for (const [name, page] of [["the studio", html], ["Pack Builder", builderHtml]]) {
  const c = new JSDOM(page).window.document.getElementById("toast-container");
  check(c && c.getAttribute("aria-live") === "polite", `${name}'s #toast-container is a polite live region`);
  check(!c.hasAttribute("aria-atomic"), `${name}'s #toast-container has no aria-atomic`);
}

// A plain toast: the message, no alert role, gone after 3.2 s.
{
  const t = boot();
  t.showToast("Invite link copied.");
  const [toast] = t.toasts();
  check(toast && t.text(toast) === "Invite link copied.", "a plain toast shows its message");
  check(!toast.hasAttribute("role") && !toast.classList.contains("toast-error"), "a plain toast is not an alert");
  check(!toast.querySelector("button"), "a plain toast has no Close button");
  t.advance(3100);
  check(t.toasts().length === 1, "a plain toast is still there before 3.2 s");
  t.advance(400);
  check(t.toasts().length === 0, "a plain toast goes away by itself");
}

// An error toast: role=alert, the message, a Close button; stays until closed.
{
  const t = boot();
  t.showToast("Only the host can assign roles.", { tone: "error" });
  const [toast] = t.toasts();
  check(toast.getAttribute("role") === "alert" && toast.classList.contains("toast-error"), "an error toast is an alert");
  const msg = toast.querySelector(".toast-message");
  check(msg && msg.textContent === "Only the host can assign roles.", "an error toast shows its message");
  const close = toast.querySelector("button");
  check(close && close.textContent === "Close" && close.type === "button", "an error toast has a Close button");
  check(close.classList.contains("btn") && close.classList.contains("btn-ghost") && close.classList.contains("btn-xs"),
    "the Close button uses the shared small ghost button");
  t.advance(60000);
  check(t.toasts().length === 1, "an error toast is still there a minute later");
  close.click();
  check(t.toasts().length === 0, "Close removes the error toast");
}

// The cap: a 4th toast pushes out the oldest, whatever its tone.
{
  const t = boot();
  t.showToast("Stuck", { tone: "error" });
  t.showToast("Two");
  t.showToast("Three");
  check(t.toasts().length === 3, "three toasts show together");
  t.showToast("Four");
  const left = t.toasts();
  check(left.length === 3, "a 4th toast keeps it at 3");
  check(!left.some((el) => el.classList.contains("toast-error")), "the oldest toast is the one that goes");
  check(left.map(t.text).join("|") === "Two|Three|Four", "the newest three stay, in order");
}

// An action toast: a real button that runs the action and closes the toast; its own
// duration; paused while hovered or focused.
{
  const t = boot();
  let undone = 0;
  t.showToast("Line 4 deleted", { action: { label: "Undo", onClick: () => { undone++; } }, duration: 6000 });
  const [toast] = t.toasts();
  const msg = toast.querySelector(".toast-message");
  const btn = toast.querySelector("button.toast-action");
  check(msg && msg.textContent === "Line 4 deleted", "an action toast shows its message");
  check(btn && btn.type === "button" && btn.textContent === "Undo", "an action toast has a real Undo button");
  check(!toast.hasAttribute("role"), "an action toast is not an alert");
  t.advance(5900);
  check(t.toasts().length === 1, "an action toast stays for its duration (6 s)");
  t.advance(400);
  check(t.toasts().length === 0, "an action toast goes after its duration");

  t.showToast("Line 2 deleted", { action: { label: "Undo", onClick: () => { undone++; } }, duration: 6000 });
  const [hovered] = t.toasts();
  hovered.dispatchEvent(new t.w.Event("pointerenter"));
  t.advance(20000);
  check(t.toasts().length === 1, "a hovered toast waits");
  hovered.dispatchEvent(new t.w.Event("pointerleave"));
  t.advance(5900);
  check(t.toasts().length === 1, "after the pointer leaves it stays its full duration again");
  t.advance(400);
  check(t.toasts().length === 0, "then it goes");

  t.showToast("Line 3 deleted", { action: { label: "Undo", onClick: () => { undone++; } }, duration: 6000 });
  const [focused] = t.toasts();
  const undo = focused.querySelector("button.toast-action");
  undo.focus();
  t.advance(20000);
  check(t.toasts().length === 1, "a toast with focus on its button waits");
  undo.click();
  check(undone === 1 && t.toasts().length === 0, "the button runs its action once and closes the toast");
}

console.log("All toast checks passed.");
