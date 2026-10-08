/**
 * test_join_card.js
 *
 * The join card (2.0 join flow, G2): a friend who opens an invite link in a plain
 * browser (?room=CODE, no handoff) gets one view, not a modal:
 *  - the code is checked first ("Finding room…", GET /api/rooms/CODE), then the card
 *    fills in: "Join Tani's room", the scene with its lines and characters, who's here,
 *  - a name (empty on a first visit, else the saved one) and a colour (hues other people
 *    in the room hold are disabled; preselected: your saved colour if free, else the
 *    first free hue), and the amber "Join as Sam ›" ("Join ›" without a name, which says
 *    "Type your name first"); a network error stays on the card,
 *  - Enter submits (a form); focus starts in the name field; the identity is saved,
 *  - a room that isn't open says so, with the same code-or-link form,
 *  - someone the room already knows (a reload) goes straight in,
 *  - no modal is open on arrival or after joining, and the join modal is gone.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const TUNNEL = "https://abc.trycloudflare.com";
const CODE = "9UK6PQ";
const CORAL = "#f08a6c", LIME = "#b5cf5a", MINT = "#6fd3a8", CORNFLOWER = "#7d9cf0", PINK = "#ec4899";

function fail(msg, ...rest) {
  console.error("FAIL: " + msg, ...rest);
  process.exit(1);
}

function check(cond, msg, ...rest) {
  if (!cond) fail(msg, ...rest);
  console.log("PASS: " + msg);
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function room({ users } = {}) {
  return {
    state_version: 3, room_id: CODE, host_id: "u_tani", status: "lobby",
    pack: {
      id: "Rooftop", name: "Rooftop Standoff", characters: ["Mika", "Old Man"], has_icon: false, icon_url: null,
      video_url: "/api/packs/Rooftop/video",
      lines: [
        { line_id: "a", character: "Mika", start: 2.5, end: 4, caption: "Hi" },
        { line_id: "b", character: "Old Man", start: 5, end: 6, caption: "Both of you, stop this." },
        { line_id: "c", character: "Mika", start: 7, end: 8, caption: "No." },
      ],
    },
    users: users || {
      u_tani: { id: "u_tani", name: "Tani", color: CORAL, is_online: true },
      u_mika: { id: "u_mika", name: "Mika", color: CORNFLOWER, is_online: true },
      u_bob: { id: "u_bob", name: "Bob", color: MINT, is_online: false },
    },
    role_assignments: {}, takes: {},
  };
}

/** Boots at `url`; `gate` (a promise) holds back the first room lookup until it resolves. */
async function boot(url, { storage = {}, state = room(), gate = null, remote = {} } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, {
    url, runScripts: "dangerously", virtualConsole,
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    },
  });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) });
  w.AudioContext = class {
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 0 }, connect: () => {} }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: () => {} }; }
    createConvolver() { return { connect: () => {} }; }
  };
  w.scrollTo = () => {};
  w.HTMLMediaElement.prototype.load = function () {};
  const sockets = [];
  w.WebSocket = class { constructor(u) { this.url = u; this.readyState = 0; sockets.push(this); } send() {} close() {} };
  Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [] } });

  const fetches = [];
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input) => {
    const u = String(input || "");
    fetches.push(u);
    const resolve = u.match(/\/rooms\/([^/]+)\/resolve$/);
    if (resolve) return remote[decodeURIComponent(resolve[1])] ? json(200, { tunnel_url: remote[decodeURIComponent(resolve[1])] }) : json(404, {});
    if (u === `/api/rooms/${CODE}`) {
      if (!state) return gate ? gate.then(() => json(404, { detail: "Room not found" })) : json(404, { detail: "Room not found" });
      if (gate) return gate.then(() => json(200, state));
      return json(200, state);
    }
    if (u.startsWith("/api/rooms/")) return json(404, { detail: "Room not found" });
    if (u.startsWith("/api/packs")) return json(200, []);
    return json(200, {});
  };

  w.eval(bundle);
  await tick(120);
  const app = w.dubMateApp;
  if (!app) fail(`the studio did not boot at ${url}`);
  const toasts = [];
  app.showToast = (msg) => toasts.push(msg);
  const navigations = [];
  app.navigateTo = (t) => navigations.push(t);
  const doc = w.document;
  return { w, doc, app, fetches, sockets, toasts, navigations, $: (id) => doc.getElementById(id) };
}

const visible = (el) => !!el && !el.hidden && !el.closest("[hidden]") && el.style.display !== "none";
const openOverlays = (doc) => Array.from(doc.querySelectorAll(".studio-modal-overlay"))
  .filter((o) => !o.hidden && o.style.display !== "none" && (o.style.display !== "" || o.classList.contains("is-open")))
  .map((o) => o.id);

(async () => {
  const GUEST = `${TUNNEL}/?room=${CODE}`;

  // 1. The code first, then the card.
  {
    let open;
    const gate = new Promise((r) => { open = r; });
    const { w, doc, app, $, fetches } = await boot(GUEST, { gate });
    check(!$("modal-join-room"), "the join modal is gone");
    check(app.currentView === "join" && $("view-join").classList.contains("active") && !$("view-landing").classList.contains("active"), "a link guest sees the join card view", app.currentView, $("view-join").className);
    check(visible($("join-finding")) && /Finding room…/.test($("join-finding").textContent) && !visible($("join-form")) && !visible($("join-missing")),
      "it opens in Finding room… with nothing to fill in yet");
    check(fetches.includes(`/api/rooms/${CODE}`), "and looks the code up first");
    check(openOverlays(doc).length === 0, "no modal is open on arrival", openOverlays(doc));
    open();
    await tick(120);
    check(!visible($("join-finding")) && visible($("join-form")), "then the card fills in");
    check($("join-title").textContent === "Join Tani's room", "it names the host's room", $("join-title").textContent);
    check($("join-meta").textContent === "Rooftop Standoff · 3 lines · 2 characters", "with the scene, its lines and characters", $("join-meta").textContent);
    const here = $("join-here");
    const names = Array.from(here.querySelectorAll(".join-here-name")).map((n) => n.textContent);
    check(/Here now/.test(here.textContent) && names.join(",") === "Tani,Mika", "Here now lists who is online", names);
    check(here.querySelectorAll(".avatar").length === 2 && here.querySelector(".avatar").style.getPropertyValue("--avatar-size").trim() === "20px", "with 20px avatars");
    const poster = $("join-poster");
    const video = poster.querySelector("video");
    check(video && video.getAttribute("preload") === "metadata" && video.getAttribute("src") === "/api/packs/Rooftop/video#t=2.5" && video.muted,
      "with no scene icon, the poster is the video at the first line", video?.getAttribute("src"));

    // Name and colour.
    const name = $("input-join-name");
    check(name.value === "" && doc.activeElement === name && name.getAttribute("maxlength") === "24", "a first visit starts in an empty name field (24 max)");
    const btn = $("btn-join-card");
    check(btn.classList.contains("btn-primary") && !btn.disabled && btn.textContent.trim() === "Join ›", "Join › reads plainly without a name");
    // Enter in the empty field submits (implicit submission needs an enabled submit button) and says why not.
    $("join-form").requestSubmit();
    await tick(30);
    check(app.currentView === "join" && $("input-join-name-error").textContent === "Type your name first"
      && name.getAttribute("aria-invalid") === "true" && doc.activeElement === name, "an empty name says Type your name first, in place");
    const radios = Array.from($("join-color-palette").querySelectorAll("input[type=radio]"));
    const byHex = (hex) => radios.find((r) => r.value === hex);
    check(radios.length === 8 && byHex(CORAL).disabled && byHex(CORNFLOWER).disabled && byHex(MINT).disabled, "hues other people hold are taken (offline too)");
    check(/taken by Tani/.test(byHex(CORAL).getAttribute("aria-label")), "and say by whom", byHex(CORAL).getAttribute("aria-label"));
    check(byHex(LIME).checked, "the first free hue is preselected");
    name.value = "  Sam ";
    name.dispatchEvent(new w.Event("input", { bubbles: true }));
    check(!btn.disabled && btn.textContent.trim() === "Join as Sam ›", "typing a name makes it Join as Sam ›", btn.textContent);
    check(/You'll check your mic in the room while friends join\./.test($("view-join").textContent), "a muted line says the mic comes later");
    // The picker redraws with the initial as the name changes: find the swatch again.
    const pink = Array.from($("join-color-palette").querySelectorAll("input[type=radio]")).find((r) => r.value === PINK);
    check(pink.nextElementSibling.textContent === "" && Array.from($("join-color-palette").querySelectorAll("input")).find((r) => r.checked).nextElementSibling.textContent === "S", "your initial sits on your colour");
    pink.click();

    // Enter submits: the name field is inside the form with its submit button.
    const form = $("join-form");
    check(form.tagName === "FORM" && form.contains(name) && btn.type === "submit" && form.contains(btn), "Enter submits (a form with a submit button)");
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await tick(150);
    check(app.currentView === "lobby", "joining goes to the lobby", app.currentView);
    const saved = JSON.parse(w.localStorage.getItem("dubmate_user"));
    check(saved.name === "Sam" && saved.color === PINK, "the name and colour are saved on this origin", saved);
    check(openOverlays(doc).length === 0, "no modal is open after joining", openOverlays(doc));
    check(w.localStorage.getItem("dubmate_first_room_done") === "1", "joining counts as the first room");
  }

  // 1b. A network error on Join keeps the guest on the card, with the reason under the button.
  {
    const { w, app, $, toasts } = await boot(GUEST);
    $("input-join-name").value = "Sam";
    $("input-join-name").dispatchEvent(new w.Event("input", { bubbles: true }));
    const fetchBefore = w.fetch;
    w.fetch = (input) => String(input).startsWith("/api/rooms/") ? Promise.reject(new TypeError("Failed to fetch")) : fetchBefore(input);
    $("join-form").requestSubmit();
    await tick(120);
    check(app.currentView === "join" && $("view-join").classList.contains("active") && !$("view-landing").classList.contains("active"),
      "a network error doesn't drop a link guest on the host's home screen", app.currentView);
    const error = $("btn-join-card-error");
    check(visible($("join-form")) && error && !error.hidden && error.textContent.length > 0 && toasts.length === 0, "it says so on the card", error?.textContent, toasts);
    check(!$("btn-join-card").disabled && $("btn-join-card").textContent.trim() === "Join as Sam ›", "and Join can be pressed again");
    check(new URL(w.location.href).searchParams.get("room") === CODE, "the link still names the room, so a reload tries again");
  }

  // 1c. A restored room: someone offline still holds an older version's colour.
  {
    const state = room();
    state.users.u_tani.color = "#d97706";
    state.users.u_tani.is_online = false;
    const { $ } = await boot(GUEST, { state });
    const coral = Array.from($("join-color-palette").querySelectorAll("input")).find((r) => r.value === CORAL);
    check(coral.disabled && /taken by Tani/.test(coral.getAttribute("aria-label")), "an old colour counts as its hue, as the server counts it");
  }

  // 2. A returning guest: their name, their colour when free; the chrome stays out of the way.
  {
    const { doc, $ } = await boot(GUEST, { storage: { dubmate_user: JSON.stringify({ id: "u_sam", name: "Sam", color: PINK }) } });
    check($("input-join-name").value === "Sam" && $("btn-join-card").textContent.trim() === "Join as Sam ›", "a returning guest finds their name");
    const pink = Array.from($("join-color-palette").querySelectorAll("input")).find((r) => r.value === PINK);
    check(pink.checked, "and their colour, when nobody holds it");
    check(!visible($("btn-audio-settings")) || doc.body.classList.contains("no-home-chrome"), "a browser guest's header hides Audio");
    check(doc.body.classList.contains("no-home-chrome"), "the header has no home controls on a host's page without a home engine");
  }
  {
    const { $ } = await boot(GUEST, { storage: { dubmate_user: JSON.stringify({ id: "u_sam", name: "Sam", color: CORAL }) } });
    const checked = Array.from($("join-color-palette").querySelectorAll("input")).find((r) => r.checked);
    check(checked && checked.value === LIME, "a saved colour someone holds gives way to the first free hue", checked?.value);
  }

  // 3. A room that isn't open.
  {
    const { app, $, toasts } = await boot(GUEST, { state: null });
    check(app.currentView === "join" && visible($("join-missing")) && !visible($("join-form")), "a closed room shows the missing state");
    check($("join-missing-title").textContent === `Room ${CODE} isn't open.` && /Ask the host for a new link\./.test($("join-missing").textContent),
      "it says the room isn't open and what to do");
    const form = $("join-missing-form");
    check(form && form.tagName === "FORM" && form.querySelector("input#input-join-code") && form.querySelector("button[type=submit]"), "with the code-or-link form");
    check(toasts.length === 0, "and no toast", toasts);
  }
  {
    // The registry knows a newer page for the code: go there.
    let open;
    const gate = new Promise((r) => { open = r; });
    const { navigations } = await boot(GUEST, { state: null, gate, remote: { [CODE]: "https://new.trycloudflare.com" } });
    open();
    await tick(80);
    const to = navigations[0] && new URL(navigations[0]);
    check(to && to.origin === "https://new.trycloudflare.com" && to.searchParams.get("room") === CODE && !to.hash, "a code the registry moved is followed, without a handoff");
  }

  // 4. Someone the room already knows goes straight in (a reload).
  {
    const state = room();
    state.users.u_sam = { id: "u_sam", name: "Sam", color: LIME, is_online: false };
    const { app, sockets, $ } = await boot(GUEST, { state, storage: { dubmate_user: JSON.stringify({ id: "u_sam", name: "Sam", color: LIME }) } });
    check(app.currentView === "lobby" && sockets.length === 1 && !$("view-join").classList.contains("active"), "a known member reloading goes straight back in", app.currentView);
  }

  // 5. A member arriving without a handoff gets the card, and the version check is a toast.
  {
    const HOME = "http://127.0.0.1:8123";
    const { app, $, doc } = await boot(`${TUNNEL}/?room=${CODE}&home=${encodeURIComponent(HOME)}`);
    check(app.currentView === "join" && visible($("join-form")), "a member without a handoff gets the join card");
    check(!doc.body.classList.contains("no-home-chrome"), "a member keeps the home controls");
  }

  console.log("ALL JOIN CARD TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
