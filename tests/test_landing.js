/**
 * test_landing.js
 *
 * The landing of the 2.0 join flow (G2): who you are on the left, the scenes on the right.
 *  - no New/Join tabs: the "You" card holds the name, the colour and one
 *    "Join a friend's room" form (a code or an invite link, no maxlength),
 *  - no preselected scene, ever; the scene cards are a radiogroup with a roving tabindex
 *    (arrows move and select, Space selects, Enter on a focused card starts the room),
 *  - a pinned bar names the chosen scene and holds the view's one amber, "Start a room ›",
 *    disabled as "Pick a scene" until one is chosen, "(hidden by search)" when filtered out,
 *  - a code, a /join/CODE link and a ?room=CODE link all join; a direct link to another
 *    origin goes straight there with the member's home and handoff, without the registry,
 *  - a wrong code shows an inline error under the field and keeps the text (no toast,
 *    no view change), and an empty name blocks Start and Join with an inline error,
 *  - "Make a scene" is secondary; Import, Packs folder and Rescan live in a "⋯" menu,
 *  - the hero shows until the first room, and the header shows who you are.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const ORIGIN = "http://localhost:8000";

function fail(msg, ...rest) {
  console.error("FAIL: " + msg, ...rest);
  process.exit(1);
}

function check(cond, msg, ...rest) {
  if (!cond) fail(msg, ...rest);
  console.log("PASS: " + msg);
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function pack(id, { lines = 2, characters = ["Mika"], duration = 19 } = {}) {
  return {
    id, name: id.replace(/_/g, " "), characters, duration, line_count: lines,
    lines: Array.from({ length: lines }, (_, i) => ({ line_id: `l${i}`, character: characters[i % characters.length], start: i, end: i + 1, caption: `Line ${i}` })),
  };
}

const PACKS = [pack("Rooftop_Standoff", { lines: 8, characters: ["Mika", "Ren", "Sergeant", "Old Man", "Courier"], duration: 19 }), pack("Quiet_Night"), pack("Third_Take")];

async function boot({ storage = {}, rooms = {}, remote = {} } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, {
    url: `${ORIGIN}/`,
    runScripts: "dangerously",
    virtualConsole,
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
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.WebSocket = class { constructor(u) { this.url = u; this.readyState = 0; } send() {} close() {} };
  Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [] } });

  const fetches = [];
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input, init = {}) => {
    const u = String(input || "");
    fetches.push({ url: u, method: init.method || "GET", body: init.body });
    const resolve = u.match(/\/rooms\/([^/]+)\/resolve$/);
    if (resolve) {
      const code = decodeURIComponent(resolve[1]);
      return remote[code] ? json(200, { tunnel_url: remote[code] }) : json(404, {});
    }
    if (u === "/api/rooms" && init.method === "POST") {
      const sent = JSON.parse(init.body);
      return json(200, { room_id: "NEW123", user_id: "u_host", pack_id: sent.pack_id });
    }
    const room = u.match(/^\/api\/rooms\/([^/?]+)$/);
    if (room) {
      const code = decodeURIComponent(room[1]);
      if (rooms[code]) return json(200, rooms[code]);
      if (code === "NEW123") return json(200, fakeRoom("NEW123", "u_host"));
      return json(404, { detail: "Room not found" });
    }
    if (u.startsWith("/api/packs/rescan")) return json(200, { packs: PACKS });
    if (u.startsWith("/api/packs")) return json(200, PACKS);
    return json(200, {});
  };

  w.eval(bundle);
  await tick(120);
  const app = w.dubMateApp;
  if (!app) fail("the studio did not boot");
  const navigations = [];
  app.navigateTo = (target) => navigations.push(target);
  const toasts = [];
  app.showToast = (msg) => toasts.push(msg);
  const doc = w.document;
  return { w, doc, app, fetches, navigations, toasts, $: (id) => doc.getElementById(id) };
}

function fakeRoom(code, hostId) {
  return {
    state_version: 3, room_id: code, host_id: hostId, status: "lobby",
    pack: { id: "Quiet_Night", name: "Quiet Night", lines: [], characters: [] },
    users: { [hostId]: { id: hostId, name: "Tani", color: "#f08a6c", is_online: true } },
    role_assignments: {}, takes: {},
  };
}

const key = (w, el, k) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
const roomFetches = (fetches) => fetches.filter((f) => /^\/api\/rooms\/[^/]+$/.test(f.url)).map((f) => f.url);
const visible = (el) => !!el && !el.hidden && !el.closest("[hidden]") && el.style.display !== "none";

(async () => {
  // 1. The markup: no tabs, one form, Make a scene, the menu, one amber.
  {
    const { doc, $ } = await boot({ storage: { dubmate_user: JSON.stringify({ id: "u_t", name: "Tani", color: "#f08a6c" }) } });
    for (const id of ["tab-btn-create", "tab-btn-join", "panel-create-room", "panel-join-room", "modal-join-room"]) {
      check(!$(id), `#${id} is gone`);
    }
    check(!doc.querySelector("#view-landing .tab-pill-group, #view-landing [role=tablist]"), "the landing has no tabs");
    const form = $("form-join-room");
    check(form && form.tagName === "FORM" && form.contains($("input-room-code")) && form.contains($("btn-join-room")), "Join a friend's room is one <form>");
    const code = $("input-room-code");
    check(!code.hasAttribute("maxlength") && code.getAttribute("placeholder") === "Room code or invite link" && !code.classList.contains("code-input"),
      "the field takes a code or a link, with no maxlength and a normal placeholder");
    check($("btn-join-room").type === "submit" && $("btn-join-room").classList.contains("btn-secondary"), "Join is a secondary submit button");
    check(/Join a friend's room/.test(form.textContent), "the form is labelled \"Join a friend's room\"");
    const you = doc.querySelector("#view-landing .landing-you");
    check(you && /\bYou\b/.test(you.querySelector("h2")?.textContent || "") && !/Profile/.test(you.textContent), "the card is called You, not Profile");
    check(/Friends see this name and colour in every room\./.test(you.textContent), "it says who sees the name and colour");
    check(you.querySelector(".avatar") && getComputedStyleSize(you.querySelector(".avatar")) === "44px", "a 44px avatar sits by the name");
    const make = $("btn-open-builder");
    check(make && /Make a scene/.test(make.textContent) && make.classList.contains("btn-secondary") && make.getAttribute("href") === "/builder.html",
      "Make a scene is secondary with the same link");
    check(doc.querySelector("#view-landing h2#scenes-title")?.textContent.trim() === "Choose a scene", "Choose a scene is an h2");
    check(/^3 scenes$/.test($("pack-count-badge").textContent.trim()), "a neutral scene count", $("pack-count-badge").textContent);
    const ambers = Array.from(doc.querySelectorAll("#view-landing .btn-primary"));
    check(ambers.length === 1 && ambers[0].id === "btn-create-room", "the landing has one amber: Start a room", ambers.map((b) => b.id || b.textContent));
    check(visible($("header-user-pill")) && $("header-user-name").textContent === "Tani", "the header shows who you are on the landing");
  }

  // 2. The "⋯" menu holds Import, Packs folder and Rescan.
  {
    const { w, doc, $, fetches } = await boot();
    const btn = $("btn-scene-menu");
    const menu = $("scene-menu");
    check(btn && btn.getAttribute("aria-haspopup") === "menu" && btn.getAttribute("aria-expanded") === "false" && menu.hidden,
      "the ⋯ button is a closed menu button");
    check(["btn-import-pack", "btn-open-pack-folder", "btn-rescan-packs"].every((id) => menu.contains($(id)) && $(id).getAttribute("role") === "menuitem"),
      "Import, Packs folder and Rescan are its items, with their ids");
    btn.click();
    check(!menu.hidden && btn.getAttribute("aria-expanded") === "true" && doc.activeElement === $("btn-import-pack"), "it opens on the first item");
    key(w, doc.activeElement, "ArrowDown");
    check(doc.activeElement === $("btn-open-pack-folder"), "arrows move through the items");
    key(w, doc.activeElement, "Escape");
    check(menu.hidden && doc.activeElement === btn, "Escape closes it and focus goes back");
    btn.click();
    const before = fetches.length;
    $("btn-rescan-packs").click();
    await tick();
    check(menu.hidden && fetches.slice(before).some((f) => f.url.startsWith("/api/packs/rescan")), "Rescan still rescans, and the menu closes");
  }

  // 3. No preselection; the bar waits for a choice.
  const named = { dubmate_user: JSON.stringify({ id: "u_t", name: "Tani", color: "#f08a6c" }) };
  {
    const { doc, app, $ } = await boot({ storage: named });
    check(app.selectedPackId === null && !doc.querySelector(".pack-card.selected"), "no scene is chosen on arrival");
    const grid = $("pack-grid");
    const cards = Array.from(grid.querySelectorAll(".pack-card"));
    check(grid.getAttribute("role") === "radiogroup" && cards.length === 3 && cards.every((c) => c.getAttribute("role") === "radio" && c.getAttribute("aria-checked") === "false"),
      "the cards are an unchecked radiogroup");
    check(cards.filter((c) => c.tabIndex === 0).length === 1 && cards[0].tabIndex === 0, "one tab stop: the first card");
    const start = $("btn-create-room");
    check(start.disabled && start.textContent.trim() === "Pick a scene", "Start is disabled and says Pick a scene", start.textContent);

    // A click chooses; the bar names it.
    cards[1].click();
    check(app.selectedPackId === "Quiet_Night" && cards[1].getAttribute("aria-checked") === "true" && cards[1].tabIndex === 0 && cards[0].tabIndex === -1,
      "a click chooses the scene and moves the tab stop");
    check(!start.disabled && start.textContent.trim() === "Start a room ›" && start.getAttribute("aria-label") === "Start a room with Quiet Night",
      "Start names the scene", start.getAttribute("aria-label"));
    check($("scene-bar-name").textContent === "Quiet Night" && $("scene-bar-meta").textContent === "2 lines · 1 character · 19 s",
      "the bar shows the scene and its lines, characters and length", $("scene-bar-meta").textContent);

    // Search hides it: still chosen, and the bar says so. renderPacks never picks one.
    app.handlePackSearch("rooftop");
    check(app.selectedPackId === "Quiet_Night" && /\(hidden by search\)/.test($("scene-bar").textContent), "a scene hidden by search stays chosen and says so");
    app.handlePackSearch("zzzz");
    check(app.selectedPackId === "Quiet_Night", "an empty search keeps the choice");
    app.handlePackSearch("");
    check(!/\(hidden by search\)/.test($("scene-bar").textContent), "the note goes when it shows again");
  }

  // 4. The keyboard: arrows move and select, Space selects, Enter starts.
  {
    const { w, doc, app, $, fetches } = await boot({ storage: named });
    const cards = () => Array.from($("pack-grid").querySelectorAll(".pack-card"));
    cards()[0].focus();
    key(w, cards()[0], "ArrowRight");
    check(doc.activeElement === cards()[1] && app.selectedPackId === "Quiet_Night", "ArrowRight moves to the next card and chooses it");
    key(w, doc.activeElement, "ArrowDown");
    check(doc.activeElement === cards()[2] && app.selectedPackId === "Third_Take", "ArrowDown moves on too");
    key(w, doc.activeElement, "ArrowRight");
    check(doc.activeElement === cards()[0] && app.selectedPackId === "Rooftop_Standoff", "it wraps around");
    key(w, doc.activeElement, "ArrowLeft");
    check(doc.activeElement === cards()[2], "ArrowLeft goes back");
    key(w, doc.activeElement, "Home");
    check(doc.activeElement === cards()[0], "Home goes to the first card");
    app.selectedPackId = null;
    app.renderPacks();
    cards()[1].focus();
    key(w, cards()[1], " ");
    check(app.selectedPackId === "Quiet_Night", "Space chooses the focused card");
    const before = fetches.length;
    key(w, cards()[1], "Enter");
    await tick();
    const post = fetches.slice(before).find((f) => f.url === "/api/rooms" && f.method === "POST");
    check(post && JSON.parse(post.body).pack_id === "Quiet_Night", "Enter on a focused card starts the room with it");
    await tick();
    check(app.currentView === "lobby", "and you are in the lobby", app.currentView);
  }

  // 5. A name first.
  {
    const { w, doc, app, $, fetches, toasts } = await boot();
    check(app.user.name === "" && !visible($("input-user-name-error")), "a first run has no name and no error yet");
    $("pack-grid").querySelector(".pack-card").click();
    $("btn-create-room").click();
    await tick();
    const name = $("input-user-name");
    check(!fetches.some((f) => f.url === "/api/rooms"), "Start without a name creates nothing");
    check(name.getAttribute("aria-invalid") === "true" && visible($("input-user-name-error"))
      && $("input-user-name-error").textContent === "Type your name first" && (name.getAttribute("aria-describedby") || "").includes("input-user-name-error"),
      "an inline error says to type your name");
    check(doc.activeElement === name && toasts.length === 0, "focus goes to the name field, with no toast");
    $("input-room-code").value = "ABC123";
    submit(w, $("form-join-room"));
    await tick();
    check(roomFetches(fetches).length === 0 && doc.activeElement === name, "Join without a name looks nothing up either");
    name.value = "Sam";
    name.dispatchEvent(new w.Event("input", { bubbles: true }));
    check(name.getAttribute("aria-invalid") !== "true" && !visible($("input-user-name-error")), "typing a name clears the error");
  }

  // 6. A code or a link joins; a wrong one stays inline.
  {
    const rooms = { "9UK6PX": fakeRoom("9UK6PX", "u_host"), ABC123: fakeRoom("ABC123", "u_host"), XYZ789: fakeRoom("XYZ789", "u_host") };
    for (const [typed, code] of [
      ["9uk6px", "9UK6PX"],
      ["  https://dubmate.bkaproductions.com/join/ABC123 ", "ABC123"],
      [`${ORIGIN}/?room=xyz789`, "XYZ789"],
    ]) {
      const { w, app, $, fetches } = await boot({ storage: named, rooms });
      $("input-room-code").value = typed;
      submit(w, $("form-join-room"));
      await tick(120);
      check(roomFetches(fetches)[0] === `/api/rooms/${code}` && app.currentView === "lobby", `"${typed.trim()}" joins room ${code}`, roomFetches(fetches));
    }

    // A direct link to a host's page: straight there, with home and the handoff, no registry.
    {
      const { w, $, fetches, navigations } = await boot({ storage: named });
      $("input-room-code").value = "https://abc.trycloudflare.com/?room=qq1234";
      submit(w, $("form-join-room"));
      await tick(120);
      const target = navigations[0] && new URL(navigations[0]);
      check(target && target.origin === "https://abc.trycloudflare.com" && target.searchParams.get("room") === "QQ1234"
        && target.searchParams.get("home") === ORIGIN && target.hash.startsWith("#dm="), "a direct link goes to the host's page with home and the handoff", navigations[0]);
      check(!fetches.some((f) => /resolve$/.test(f.url)) && roomFetches(fetches).length === 0, "without asking the registry or this engine");
    }

    // A wrong code: inline, text kept, no toast, same view. "Finding room…" while it looks.
    {
      const { w, doc, app, $, fetches, toasts } = await boot({ storage: named });
      const input = $("input-room-code");
      const btn = $("btn-join-room");
      input.value = "nope12";
      submit(w, $("form-join-room"));
      check(btn.disabled && btn.textContent.trim() === "Finding room…", "Join shows Finding room… while it looks", btn.textContent);
      await tick(120);
      const err = $("input-room-code-error");
      check(fetches.some((f) => /\/rooms\/NOPE12\/resolve$/.test(f.url)), "the registry is asked for a code this engine doesn't have");
      check(input.getAttribute("aria-invalid") === "true" && (input.getAttribute("aria-describedby") || "").includes("input-room-code-error") && visible(err)
        && err.textContent === "No room NOPE12. Check the code, or ask the host for a new link.", "a wrong code shows an inline error", err?.textContent);
      check(input.value === "nope12" && toasts.length === 0 && app.currentView === "landing", "the text stays, with no toast and no view change", toasts);
      check(!btn.disabled && btn.textContent.trim() === "Join", "Join is back");
      input.value = "not a link at all";
      submit(w, $("form-join-room"));
      await tick();
      check(err.textContent === "That isn't a room code or invite link." && input.value === "not a link at all", "something that isn't a code says so");
      input.value = "";
      submit(w, $("form-join-room"));
      await tick();
      check(err.textContent === "Type a room code or paste an invite link.", "an empty field says what to type");
      input.value = "ABC";
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      check(!visible(err) && input.getAttribute("aria-invalid") !== "true", "typing clears the error");
      void doc;
    }
  }

  // 7. The hero shows until the first room.
  {
    const first = await boot();
    check(visible(first.doc.querySelector("#view-landing .hero-banner")), "a first run shows the hero");
    const later = await boot({ storage: { ...named, dubmate_first_room_done: "1" } });
    check(!visible(later.doc.querySelector("#view-landing .hero-banner")), "after the first room the hero is gone");
    const { w, app, $ } = first;
    $("input-user-name").value = "Tani";
    $("input-user-name").dispatchEvent(new w.Event("input", { bubbles: true }));
    $("pack-grid").querySelector(".pack-card").click();
    $("btn-create-room").click();
    await tick(150);
    check(app.currentView === "lobby" && w.localStorage.getItem("dubmate_first_room_done") === "1", "starting a room marks the hero as seen");
  }

  // 8. The Packs folder dialog opens through openDialog.
  {
    const { w, doc, $ } = await boot();
    $("btn-scene-menu").click();
    $("btn-open-pack-folder").click();
    await tick();
    const modal = $("modal-pack-config");
    check(!modal.hidden && modal.classList.contains("is-open"), "Packs folder opens its dialog");
    key(w, doc.activeElement, "Escape");
    check(modal.hidden && doc.activeElement === $("btn-scene-menu"), "Escape closes it and focus goes back to the menu button", doc.activeElement?.id);
  }

  console.log("ALL LANDING TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});

function getComputedStyleSize(el) {
  return el.style.getPropertyValue("--avatar-size").trim();
}
