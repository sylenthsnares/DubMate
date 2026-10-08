/**
 * test_presence_stack.js
 *
 * The "who's here" avatar stack in the booth bar (2.0 layout pass, G2), from
 * static/js/studio/presence.js, drawn by renderBoothToolbar into #booth-presence:
 *  - one avatar per person online (their initial on their colour); offline people are left out,
 *  - after 5 avatars a "+N" disc,
 *  - the stack is one button named "Who's here: Tani, Mika, 1 of 2 ready",
 *  - its popover opens on focus, on hover and on click, and Esc closes it and keeps focus
 *    on the button without reaching the booth's own Esc handling,
 *  - one popover row per person: roles, where they are, their progress and Ready,
 *  - an unchanged update leaves the stack and popover alone, so an open popover survives.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

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
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
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
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("the studio did not boot");
  app.showToast = () => {};
  app.socket.send = () => true;
  return { w, doc: w.document, app };
}

function room(app) {
  const me = app.user.id;
  return {
    state_version: 3, room_id: "WHO01", host_id: "tani", status: "recording",
    pack: {
      id: "P", name: "Rooftop", line_count: 3, characters: ["Deku", "Todoroki", "Bakugo"],
      lines: [
        { index: 0, line_id: "a", character: "Deku", start: 0, end: 1 },
        { index: 1, line_id: "b", character: "Todoroki", start: 1, end: 2 },
        { index: 2, line_id: "c", character: "Bakugo", start: 2, end: 3 },
      ],
    },
    users: {
      tani: { id: "tani", name: "Tani", color: "#d97706", is_online: true, is_ready: false, location: "booth", current_line: 2 },
      [me]: { id: me, name: "Mika", color: "#7c5cff", is_online: true, is_ready: true, location: "lobby", current_line: 0 },
      sam: { id: "sam", name: "Sam <b>", color: "#16a34a", is_online: false, is_ready: false, location: "booth", current_line: 0 },
    },
    role_assignments: { Deku: ["tani"], Todoroki: ["tani"], Bakugo: [me] },
    takes: { a: { picked: "t1", next_number: 2, takes: [{ take_id: "t1", number: 1 }] } },
  };
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const key = (w, el, k) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true }));
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

(async () => {
  // The stack, its avatars and its name.
  {
    const { w, doc, app } = await boot();
    app.roomState = room(app);
    app.renderBoothToolbar();

    const slot = doc.getElementById("booth-presence");
    const btn = slot.querySelector("button.presence-stack");
    check(btn, "the booth bar's who's-here slot holds one stack button");
    check(slot.querySelectorAll("button").length === 1, "the stack is a single button");
    const avatars = Array.from(btn.querySelectorAll(".avatar"));
    check(avatars.length === 2, "one avatar per person online; the offline person is left out", avatars.length);
    check(avatars.map(text).join(",") === "T,M", "each avatar shows the person's initial", avatars.map(text));
    check(avatars[0].style.background.includes(rgb("#d97706")) || avatars[0].style.backgroundColor === rgb("#d97706"),
      "each avatar sits on the person's colour", avatars[0].getAttribute("style"));
    check(avatars[1].style.background.includes(rgb("#7c5cff")) || avatars[1].style.backgroundColor === rgb("#7c5cff"),
      "the second avatar has its own colour", avatars[1].getAttribute("style"));
    check(avatars.every((a) => a.getAttribute("aria-hidden") === "true"), "the avatars are hidden from screen readers (the button names them)");
    check(btn.getAttribute("aria-label") === "Who's here: Tani, Mika, 1 of 2 ready",
      "the button's accessible name lists who's here and how many are ready", btn.getAttribute("aria-label"));
    check(btn.getAttribute("aria-expanded") === "false", "the popover starts closed");
    const pop = doc.getElementById(btn.getAttribute("aria-controls"));
    check(pop && slot.contains(pop) && pop.hidden, "aria-controls points at the hidden popover inside the slot");
    check(!slot.textContent.includes("Sam"), "an offline person isn't in the stack or the popover");

    // Focus opens it.
    btn.focus();
    btn.dispatchEvent(new w.FocusEvent("focusin", { bubbles: true }));
    check(!pop.hidden && btn.getAttribute("aria-expanded") === "true", "focus opens the popover");

    // Rows: one per person, with roles, where they are, progress and Ready.
    const rows = Array.from(pop.querySelectorAll(".presence-row"));
    check(rows.length === 2, "one popover row per person online", rows.length);
    const tani = rows.find((r) => text(r.querySelector(".presence-name")) === "Tani");
    const mika = rows.find((r) => text(r.querySelector(".presence-name")) === "Mika (you)");
    check(tani && mika, "rows name each person, with (you) for yourself", rows.map(text));
    check(tani.querySelector(".avatar") && text(tani.querySelector(".avatar")) === "T", "each row starts with the person's avatar");
    check(text(tani).includes("2 roles: Deku, Todoroki"), "several roles read '2 roles' with their names", text(tani));
    check(text(tani).includes("Line 3"), "the row says which line they are on", text(tani));
    check(text(tani).includes("1 of 2 lines recorded"), "the row shows their progress", text(tani));
    check(!tani.querySelector(".presence-ready"), "someone not ready has no Ready tag");
    check(text(mika).includes("Bakugo") && text(mika).includes("Lobby") && text(mika).includes("0 of 1 line recorded"),
      "one role shows its name, and the lobby reads 'Lobby'", text(mika));
    check(text(mika.querySelector(".presence-ready")) === "Ready", "someone ready has a Ready tag");

    // An unchanged update leaves it alone: same nodes, still open, focus kept.
    const firstRow = rows[0];
    app.renderBoothToolbar();
    check(pop.querySelector(".presence-row") === firstRow, "an unchanged update doesn't redraw the popover");
    check(slot.querySelector("button.presence-stack") === btn && doc.activeElement === btn, "an unchanged update keeps the button and its focus");
    check(!pop.hidden, "an unchanged update keeps the popover open");

    // A real change redraws the rows but keeps the open popover and the focused button.
    app.roomState.users.tani.current_line = 1;
    app.renderBoothToolbar();
    check(text(pop).includes("Line 2"), "a real change updates the rows", text(pop));
    check(!pop.hidden && doc.activeElement === btn, "a real change keeps the popover open and focus on the button");

    // Esc closes it, keeps focus on the button, and doesn't reach the booth's Esc handling.
    let reachedWindow = false;
    w.addEventListener("keydown", (e) => { if (e.key === "Escape") reachedWindow = true; });
    key(w, btn, "Escape");
    check(pop.hidden && btn.getAttribute("aria-expanded") === "false", "Esc closes the popover");
    check(doc.activeElement === btn, "Esc returns focus to the stack button");
    check(!reachedWindow, "Esc on the open popover stops there (the booth's Esc doesn't also run)");

    // Focus leaving closes it.
    btn.click();
    check(!pop.hidden, "a click opens the popover");
    btn.click();
    check(pop.hidden, "a second click closes it");
    btn.click();
    const other = doc.getElementById("btn-toggle-ready");
    other.focus();
    btn.dispatchEvent(new w.FocusEvent("focusout", { bubbles: true, relatedTarget: other }));
    check(pop.hidden, "moving focus out of the stack closes the popover");
  }

  // Hover, +N after 5, escaping.
  {
    const { w, doc, app } = await boot();
    const state = room(app);
    for (let i = 1; i <= 5; i++) {
      state.users[`g${i}`] = { id: `g${i}`, name: `Guest${i}`, color: "#cca458", is_online: true, is_ready: false, location: "booth", current_line: 0 };
    }
    state.users.sam.is_online = true;
    app.roomState = state;
    app.renderBoothToolbar();

    const slot = doc.getElementById("booth-presence");
    const btn = slot.querySelector("button.presence-stack");
    const avatars = Array.from(btn.querySelectorAll(".avatar:not(.presence-more)"));
    const more = btn.querySelector(".presence-more");
    check(avatars.length === 5, "the stack shows 5 avatars at most", avatars.length);
    check(more && text(more) === "+3", "after 5, a '+N' disc counts the rest", text(more));
    const pop = doc.getElementById(btn.getAttribute("aria-controls"));
    check(pop.querySelectorAll(".presence-row").length === 8, "the popover still lists everyone");
    check(text(pop).includes("Sam <b>") && !pop.querySelector("b"), "names are escaped");
    check(btn.getAttribute("aria-label").startsWith("Who's here: Tani, Mika, Sam <b>, Guest1"), "the accessible name lists everyone", btn.getAttribute("aria-label"));

    // Hover opens it, leaving closes it.
    slot.querySelector(".presence").dispatchEvent(new w.MouseEvent("mouseenter", { bubbles: false }));
    check(!pop.hidden, "hovering the stack opens the popover");
    slot.querySelector(".presence").dispatchEvent(new w.MouseEvent("mouseleave", { bubbles: false }));
    check(pop.hidden, "the pointer leaving closes it");

    // Esc on a hovered popover closes it without moving focus.
    slot.querySelector(".presence").dispatchEvent(new w.MouseEvent("mouseenter", { bubbles: false }));
    const other = doc.getElementById("btn-toggle-ready");
    other.focus();
    key(w, doc.body, "Escape");
    check(pop.hidden && doc.activeElement === other, "Esc closes a hovered popover and leaves focus where it was");

    // Nobody online: the slot empties (and its :empty rule hides it).
    Object.values(app.roomState.users).forEach((u) => { u.is_online = false; });
    app.renderBoothToolbar();
    check(slot.children.length === 0, "with nobody online the slot is empty");
  }

  // The CSS: the stack uses the spacing scale, the popover the popover surface, and motion is optional.
  {
    const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8");
    const rule = (sel) => {
      const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
      return m ? m[1] : "";
    };
    check(/background:\s*var\(--popover\)/.test(rule(".presence-pop")), "the popover uses the popover surface");
    check(/var\(--space-/.test(rule(".presence-pop")), "the popover's padding is on the spacing scale");
    check(/color:\s*var\(--foreground-muted\)/.test(rule(".presence-meta")), "secondary text is muted");
    check(/prefers-reduced-motion[\s\S]*\.presence-pop/.test(css), "reduced motion turns off the popover's animation");
  }

  console.log("All presence stack checks passed.");
  process.exit(0);
})().catch((e) => fail("unexpected error", e));
