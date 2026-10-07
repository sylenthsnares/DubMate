/**
 * test_toasts.js
 *
 * showToast (static/js/ui_common.js): a plain toast goes away by itself; an error toast
 * is announced at once (role=alert), has a Close button and stays until it is pressed;
 * at most 3 toasts show, the oldest goes first. #toast-container reads each toast on
 * its own (no aria-atomic), in the studio and in Pack Builder.
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
  w.setTimeout = (fn, ms = 0) => { timers.push({ at: now + ms, fn }); return timers.length; };
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

console.log("All toast checks passed.");
