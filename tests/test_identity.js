/**
 * test_identity.js
 *
 * One identity (2.0 join flow, G1), from static/js/identity.js:
 *  - the 8 person colours (Palette B) in a fixed order, the table that maps the old
 *    colours onto them, normalizeColor, NAME_MAX = 24 and cleanName,
 *  - the colour picker: native radios in a fieldset (one tab stop, arrow keys), each
 *    hue named, your initial on your swatch, a hue someone holds disabled with their
 *    initial and "Coral, taken by Tani",
 *  - loadUser maps an old saved colour once and keeps everything else; a new user
 *    starts with no name (no random "Actor 393") and the first colour,
 *  - every name field stops at 24 characters,
 *  - joining a room where your colour is taken says so, keeps your saved colour,
 *    shows the room's colour, and keeps the auto-cast character for the lobby notice.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const moduleBundle = buildStudioBundle("static/js/identity.js")
  .replace("const __mods = {};", "const __mods = window.__mods = {};");
const appBundle = buildStudioBundle();
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

const CORAL = "#f08a6c", LIME = "#b5cf5a", MINT = "#6fd3a8", CORNFLOWER = "#7d9cf0";
const ORCHID = "#d987d9", PINK = "#ec4899", CYAN = "#06b6d4", BLUSH = "#e9a3b8";

function moduleWindow() {
  const dom = new JSDOM("<!doctype html><body><div id='pick'></div></body>", { url: "http://localhost:8000/", runScripts: "dangerously" });
  dom.window.eval(moduleBundle);
  return { w: dom.window, id: dom.window.__mods["static/js/identity.js"] };
}

async function boot({ storage = {} } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, {
    url: "http://localhost:8000/",
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
  w.eval(appBundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail("the studio did not boot");
  const toasts = [];
  app.showToast = (m) => toasts.push(m);
  app.socket.send = () => true;
  return { w, doc: w.document, app, toasts };
}

(async () => {
  // The module: the palette, the old colours, the name rule.
  {
    const { id } = moduleWindow();
    check(JSON.stringify(id.IDENTITY_COLORS.map((c) => c.name)) === JSON.stringify(["Coral", "Lime", "Mint", "Cornflower", "Orchid", "Pink", "Cyan", "Blush"]),
      "eight hues in palette order", id.IDENTITY_COLORS);
    check(JSON.stringify(id.IDENTITY_COLORS.map((c) => c.hex)) === JSON.stringify([CORAL, LIME, MINT, CORNFLOWER, ORCHID, PINK, CYAN, BLUSH]),
      "the Palette B hexes");
    const legacy = {
      "#d97706": "Coral", "#dc2626": "Coral", "#b45309": "Coral", "#f59e0b": "Coral", "#cca458": "Lime",
      "#16a34a": "Mint", "#25d3a4": "Mint", "#7c5cff": "Cornflower", "#8a6eff": "Cornflower",
      "#8b5cf6": "Orchid", "#ec4899": "Pink", "#06b6d4": "Cyan",
    };
    check(JSON.stringify(id.LEGACY_COLORS) === JSON.stringify(legacy), "the old colours map onto the new hues", id.LEGACY_COLORS);
    check(id.normalizeColor("#D97706") === CORAL && id.normalizeColor("#7c5cff") === CORNFLOWER && id.normalizeColor("#8b5cf6") === ORCHID,
      "an old colour becomes its new hue");
    check(id.normalizeColor(MINT) === MINT && id.normalizeColor(" #B5CF5A ") === LIME, "a palette colour stays");
    check(id.normalizeColor("#123abc") === CORAL && id.normalizeColor("#abc") === CORAL, "any other colour becomes Coral");
    check(["red", "", null, undefined, 7, "#12", "url(x)"].every((v) => id.normalizeColor(v) === ""), "junk is no colour");
    check(id.colorName(LIME) === "Lime" && id.colorName("#000000") === "", "a hue's name");
    check(id.NAME_MAX === 24, "names stop at 24 characters");
    check(id.cleanName("  Tani \t  Ra \n") === "Tani Ra", "a name is trimmed and its spaces collapsed");
    check(id.cleanName("x".repeat(30)) === "x".repeat(24) && id.cleanName("a".repeat(23) + " bcd") === "a".repeat(23),
      "a long name is cut to 24 characters");
    check(id.cleanName(null) === "" && id.cleanName(42) === "", "a missing name is empty");
  }

  // The picker.
  {
    const { w, id } = moduleWindow();
    const box = w.document.getElementById("pick");
    const picked = [];
    id.renderColorPicker(box, {
      selected: MINT, taken: new Map([[CORAL, { name: "Tani" }], [CYAN, { name: "mika" }]]),
      label: "Your colour", name: "Sam", onChange: (hex) => picked.push(hex),
    });
    const fieldset = box.querySelector("fieldset");
    check(!!fieldset && fieldset.querySelector("legend")?.textContent === "Your colour", "a fieldset with its legend");
    const radios = Array.from(box.querySelectorAll("input[type=radio]"));
    check(radios.length === 8, "eight radios", radios.length);
    check(new Set(radios.map((r) => r.name)).size === 1 && radios[0].name, "one radio group, so one tab stop and arrow keys");
    check(radios.every((r) => !r.hasAttribute("tabindex")), "no tabindex overrides the native group");
    const label = (r) => r.getAttribute("aria-label") || r.closest("label")?.textContent.trim();
    check(label(radios[1]) === "Lime" && label(radios[7]) === "Blush", "each swatch is named after its hue", label(radios[1]));
    const dot = (r) => r.closest("label").querySelector(".id-swatch-dot");
    check(radios[2].checked && dot(radios[2]).textContent === "S", "your swatch is checked and shows your initial");
    check(radios.filter((r) => r.checked).length === 1, "one swatch checked");
    check(radios[0].disabled && label(radios[0]) === "Coral, taken by Tani" && dot(radios[0]).textContent === "T",
      "a taken hue is disabled, named with its holder and shows their initial");
    check(radios[6].disabled && dot(radios[6]).textContent === "M", "the holder's initial is upper case");
    check(dot(radios[0]).style.background.length > 0 && dot(radios[3]).textContent === "", "free swatches carry only their colour");

    radios[3].click();
    check(picked[0] === CORNFLOWER, "choosing a hue reports it", picked);
    check(dot(radios[3]).textContent === "S" && dot(radios[2]).textContent === "", "your initial moves with your choice");

    radios[0].click();
    check(picked.length === 1 && !radios[0].checked, "a taken hue can't be chosen");

    // Drawn again (a new name, the room changed): one fieldset, the new state.
    id.renderColorPicker(box, { selected: CORAL, taken: new Map(), label: "Your colour", name: "bea" });
    check(box.querySelectorAll("fieldset").length === 1, "drawing again replaces the picker");
    const again = Array.from(box.querySelectorAll("input[type=radio]"));
    check(again[0].checked && !again[0].disabled && dot(again[0]).textContent === "B", "the new state shows");
  }

  // A saved colour from an older version is mapped once; nothing else changes.
  {
    const saved = { id: "u_old", name: "Tani", color: "#7c5cff", extra: "kept" };
    const { app, w } = await boot({ storage: { dubmate_user: JSON.stringify(saved) } });
    check(app.user.color === CORNFLOWER, "an old Violet loads as Cornflower", app.user.color);
    const stored = JSON.parse(w.localStorage.getItem("dubmate_user"));
    check(stored.color === CORNFLOWER && stored.id === "u_old" && stored.name === "Tani" && stored.extra === "kept",
      "the mapped colour is saved back with everything else unchanged", stored);
  }
  {
    const { app, w } = await boot({ storage: { dubmate_user: JSON.stringify({ id: "u_x", name: "Odd", color: "#123abc" }) } });
    check(app.user.color === CORAL && JSON.parse(w.localStorage.getItem("dubmate_user")).color === CORAL, "an unknown saved colour becomes Coral");
  }
  {
    const raw = JSON.stringify({ id: "u_new", name: "Bea", color: PINK });
    const { app, w } = await boot({ storage: { dubmate_user: raw } });
    check(app.user.color === PINK && w.localStorage.getItem("dubmate_user") === raw, "a palette colour is left as it is");
  }

  // A first run: no name yet, the first colour, nothing random.
  {
    const { app, doc } = await boot();
    check(app.user.name === "" && app.user.color === CORAL, "a new user has no name and the first colour", app.user);
    const input = doc.getElementById("input-user-name");
    input.dispatchEvent(new doc.defaultView.Event("focus"));
    input.dispatchEvent(new doc.defaultView.Event("blur"));
    check(input.value === "" && app.user.name === "", "leaving the name empty keeps it empty", input.value);
    const lobbySrc = fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "studio", "lobby.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "app.js"), "utf8");
    check(!/'Actor '\s*\+/.test(lobbySrc + appSrc), "no random 'Actor NNN' names anywhere");

    const radios = Array.from(doc.querySelectorAll("#color-palette input[type=radio]"));
    check(radios.length === 8 && radios[0].checked, "the landing picker has the 8 hues with yours checked", radios.length);
    radios[4].click();
    check(app.user.color === ORCHID && JSON.parse(doc.defaultView.localStorage.getItem("dubmate_user")).color === ORCHID,
      "choosing a hue on the landing saves it");
  }

  // Every name field stops at 24 characters.
  {
    const doc = new JSDOM(html).window.document;
    const fields = ["input-user-name", "input-join-name"].map((idv) => doc.getElementById(idv)).filter(Boolean);
    check(fields.length === 2 && fields.every((f) => f.getAttribute("maxlength") === "24"), "name fields have maxlength 24",
      fields.map((f) => `${f.id}=${f.getAttribute("maxlength")}`));
    check(!doc.querySelector(".color-option[data-color]"), "no old colour swatches left in the markup");
  }

  // The join card won't send an empty name.
  {
    const { app, doc } = await boot();
    let joined = null;
    app.joinRoom = async (code) => { joined = code; };
    app.joinCardCode = "ABC123";
    doc.getElementById("input-join-name").value = "   ";
    await app.submitJoinCard();
    check(joined === null && app.user.name === "", "an empty name doesn't join");
    doc.getElementById("input-join-name").value = "  Sam   Lee ";
    await app.submitJoinCard();
    check(joined === "ABC123" && app.user.name === "Sam Lee", "a name joins, cleaned", app.user.name);
  }

  // Joining where your colour is taken.
  {
    const { app, toasts, doc, w } = await boot({ storage: { dubmate_user: JSON.stringify({ id: "u_me", name: "Sam", color: CORAL }) } });
    const me = app.user.id;
    const state = (myColor) => ({
      state_version: 3, room_id: "ROOM01", host_id: "tani", status: "lobby",
      pack: { id: "P", name: "Rooftop", characters: ["Old Man"], lines: [] },
      users: {
        tani: { id: "tani", name: "Tani", color: CORAL, is_online: true },
        [me]: { id: me, name: "Sam", color: myColor, is_online: true },
      },
      role_assignments: { "Old Man": [me] }, takes: {},
    });
    app.roomState = state(CORAL);
    app.socket.emit("user_joined", { type: "user_joined", payload: { user_id: me, color: LIME, wanted_color: CORAL, wanted_taken_by: "Tani", cast: "Old Man" }, state: state(LIME) });
    check(toasts.includes("Coral is taken here, so you're Lime in this room."), "the taken colour is explained", toasts);
    check(app.user.color === CORAL && JSON.parse(w.localStorage.getItem("dubmate_user")).color === CORAL, "your saved colour doesn't change");
    const avatar = doc.getElementById("header-user-avatar");
    check(avatar.style.background.includes("181, 207, 90") || avatar.style.backgroundColor === "rgb(181, 207, 90)", "the header shows the room's colour", avatar.style.cssText);
    check(app.autoCastNotice === "Old Man", "the auto-cast character is kept for the lobby notice", app.autoCastNotice);

    toasts.length = 0;
    app.socket.emit("user_joined", { type: "user_joined", payload: { user_id: me, color: LIME, wanted_color: CORAL, cast: null }, state: state(LIME) });
    check(toasts.length === 0, "a reconnect doesn't repeat it", toasts);
    app.socket.emit("user_joined", { type: "user_joined", payload: { user_id: "tani", color: CORAL, wanted_color: LIME, cast: null }, state: state(LIME) });
    check(toasts.length === 0 && app.autoCastNotice === "Old Man", "someone else's join says nothing to you");
  }

  // Rejoining with another colour wanted: the room kept yours, and nobody holds the one you asked for.
  {
    const { app, toasts } = await boot({ storage: { dubmate_user: JSON.stringify({ id: "u_me", name: "Tani", color: MINT }) } });
    const me = app.user.id;
    const state = {
      state_version: 3, room_id: "ROOM02", host_id: me, status: "lobby",
      pack: { id: "P", name: "Rooftop", characters: ["Old Man"], lines: [] },
      users: { [me]: { id: me, name: "Tani", color: CORAL, is_online: true } },
      role_assignments: { "Old Man": [me] }, takes: {},
    };
    app.roomState = state;
    app.socket.emit("user_joined", { type: "user_joined", payload: { user_id: me, color: CORAL, wanted_color: MINT, wanted_taken_by: "", cast: null }, state });
    check(!toasts.some((t) => t.includes("taken")), "a rejoin that kept your room colour doesn't say your colour is taken", toasts);
  }

  console.log("\nALL IDENTITY TESTS PASSED");
  process.exit(0);
})().catch((e) => fail(e && e.stack || String(e)));
