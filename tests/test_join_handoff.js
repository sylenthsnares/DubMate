/**
 * test_join_handoff.js
 *
 * A member who joins a host's room from their own DubMate is moved onto the
 * host's tunnel page, where localStorage is empty. Their name, colour and audio
 * setup travel along in the URL fragment (#dm=<base64url(JSON)>), which is read
 * once, checked field by field and removed. The member then joins straight in,
 * without a second name prompt or setup screen. Browser guests (no ?home=) keep
 * the join prompt, filled in with the name they last used on that host.
 *
 * Navigation is observed through app.navigateTo(), which the suite replaces.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const HOME = "http://127.0.0.1:8123";
const TUNNEL = "https://abc.trycloudflare.com";
const ROOM = "ABCD";
const MEMBER_URL = `${TUNNEL}/?room=${ROOM}&home=${encodeURIComponent(HOME)}`;
const GUEST_URL = `${TUNNEL}/?room=${ROOM}`;
const PAIR = "Mic X|Phones";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

const encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

function fakeRoom() {
  return {
    room_id: ROOM, host_id: "host", status: "lobby",
    pack: { id: "HostPack", name: "Host Pack", lines: [], characters: [] },
    takes: {}, users: {}, assignments: {},
  };
}

/**
 * Boots the studio at `url` with `storage` already in that origin's localStorage.
 * `hostVersion` / `homeVersion` are what each engine's /health reports;
 * `remoteRooms` maps room code -> tunnel_url for the registry stub; `devices`
 * is what enumerateDevices() lists.
 */
async function boot(url, { storage = {}, hostVersion = "1.2.0", homeVersion = "1.2.0", remoteRooms = {}, devices = [] } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, {
    url,
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
  Object.defineProperty(w.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => devices },
  });
  const sockets = [];
  w.WebSocket = class {
    constructor(u) { this.url = u; this.readyState = 0; sockets.push(this); }
    send() {}
    close() {}
  };

  const fetches = [];
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input) => {
    const u = String(input || "");
    fetches.push(u);
    if (u === "/health") return json(200, { status: "ok", version: hostVersion });
    if (u === `${HOME}/health`) return json(200, { status: "ok", version: homeVersion });
    const resolve = u.match(/\/rooms\/([^/]+)\/resolve$/);
    if (resolve) {
      const code = decodeURIComponent(resolve[1]);
      return remoteRooms[code] ? json(200, { tunnel_url: remoteRooms[code] }) : json(404, {});
    }
    if (u === `/api/rooms/${ROOM}` && url.startsWith(TUNNEL)) return json(200, fakeRoom());
    if (u.startsWith("/api/rooms/")) return json(404, { detail: "Room not found" });
    if (u.startsWith("/api/packs")) return json(200, []);
    return json(200, {});
  };

  // JSDOM fires DOMContentLoaded itself; a second, manual one would boot a second
  // app that no longer sees the (already removed) fragment.
  w.eval(bundle);
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  const navigations = [];
  app.navigateTo = (target) => navigations.push(target);
  const modal = w.document.getElementById("modal-join-room");
  const toasts = () => Array.from(w.document.querySelectorAll("#toast-container .toast")).map((t) => t.textContent || t.innerText || "");
  const stored = (key) => w.localStorage.getItem(key);
  const storedJson = (key) => JSON.parse(w.localStorage.getItem(key) || "null");
  return { w, app, fetches, navigations, modal, toasts, stored, storedJson, sockets };
}

const joinedDirectly = (fetches) => fetches.includes(`/api/rooms/${ROOM}`);

(async () => {
  // 1. Round trip: the member's own DubMate builds the handoff, the host's page applies it.
  let handoffUrl;
  {
    const { app, navigations } = await boot(`${HOME}/`, {
      storage: {
        dubmate_user: JSON.stringify({ id: "u_home", name: "Ana Lúcia", color: "#123abc" }),
        dubmate_audio_setup_done: "1",
        dubmate_audio_input_device: "in-1",
        dubmate_audio_output_device: "out-1",
        dubmate_noise_reduction: "false",
        dubmate_mic_sync: JSON.stringify({ [PAIR]: { latency_ms: 85, method: "clicks", measured_at: 1000 } }),
      },
      remoteRooms: { [ROOM]: TUNNEL },
      devices: [
        { kind: "audioinput", deviceId: "in-1", label: "Mic X", groupId: "g" },
        { kind: "audiooutput", deviceId: "out-1", label: "Phones", groupId: "g" },
      ],
    });
    app.engineMicSync = { "Other|Speakers": { latency_ms: 40, method: "claps", measured_at: 2000 } };
    await app.joinRoom(ROOM);
    const target = navigations[0] && new URL(navigations[0]);
    if (!target || target.origin !== TUNNEL || target.searchParams.get("home") !== HOME) fail(`member not sent to the host: ${navigations[0]}`);
    if (!target.hash.startsWith("#dm=")) fail(`no handoff in the link: ${navigations[0]}`);
    const payload = decode(target.hash.slice(4));
    if (payload.v !== 1) fail(`handoff version: ${payload.v}`);
    if (payload.user.name !== "Ana Lúcia" || payload.user.color !== "#123abc") fail(`user: ${JSON.stringify(payload.user)}`);
    if (JSON.stringify(payload).includes("u_home") || "id" in payload.user) fail("the user id travelled in the handoff");
    if (!payload.audio.setup_done || payload.audio.input_label !== "Mic X" || payload.audio.output_label !== "Phones") fail(`audio: ${JSON.stringify(payload.audio)}`);
    if (payload.mic_sync[PAIR]?.latency_ms !== 85 || payload.mic_sync["Other|Speakers"]?.latency_ms !== 40) fail(`mic sync (local + engine): ${JSON.stringify(payload.mic_sync)}`);
    if (payload.noise_reduction !== false) fail(`noise reduction: ${payload.noise_reduction}`);
    handoffUrl = navigations[0];
    console.log("PASS: joining a host from your own DubMate carries name, colour and audio setup, never the id");
  }
  {
    const { w, app, fetches, modal, stored, storedJson } = await boot(handoffUrl, {
      storage: { dubmate_user: JSON.stringify({ id: "u_tunnel", name: "Old name", color: "#000000" }) },
    });
    const user = storedJson("dubmate_user");
    if (user.id !== "u_tunnel" || user.name !== "Ana Lúcia" || user.color !== "#123abc") fail(`stored user: ${JSON.stringify(user)}`);
    if (app.user.id !== "u_tunnel" || app.user.name !== "Ana Lúcia") fail(`app user: ${JSON.stringify(app.user)}`);
    if (stored("dubmate_audio_setup_done") !== "1" || !app.audioSetup.setupComplete) fail("setup not marked done");
    const pending = storedJson("dubmate_audio_handoff");
    if (pending?.input_label !== "Mic X" || pending?.output_label !== "Phones") fail(`device choice: ${JSON.stringify(pending)}`);
    const sync = storedJson("dubmate_mic_sync");
    if (sync?.[PAIR]?.latency_ms !== 85 || sync?.["Other|Speakers"]?.latency_ms !== 40) fail(`mic sync: ${JSON.stringify(sync)}`);
    if (stored("dubmate_noise_reduction") !== "false" || app.applyNoiseReduction !== false) fail("noise reduction setting not carried");
    if (w.location.hash !== "" || w.location.href.includes("#")) fail(`fragment left in the address bar: ${w.location.href}`);
    console.log("PASS: the host's page applies the handoff, keeps its own id and removes the fragment");

    if (modal.style.display === "flex") fail("join prompt shown to a member from their own DubMate");
    if (!joinedDirectly(fetches)) fail(`room not joined directly: ${fetches}`);
    if (app.currentView !== "lobby") fail(`member not in the room: ${app.currentView}`);
    const settings = w.document.getElementById("modal-audio-settings");
    if (settings && settings.style.display !== "none" && settings.style.display !== "") fail("first-run setup opened");
    if (app.audioSetup.firstRunMode) fail("first-run setup opened");
    console.log("PASS: a member with a handoff joins straight in, without the name prompt or setup screen");

    // A reload (no fragment any more) keeps the same member id.
    const id = app.user.id;
    if (storedJson("dubmate_user").id !== id) fail("the id used on this origin was not kept");
    console.log("PASS: the id used on the host's page is kept for reloads");
  }

  // 2. No fragment: today's flow, with the join prompt and first-run setup.
  {
    const { app, fetches, modal } = await boot(MEMBER_URL);
    if (modal.style.display !== "flex") fail("join prompt not shown without a handoff");
    if (joinedDirectly(fetches)) fail("joined without the prompt and without a handoff");
    if (app.audioSetup.setupComplete) fail("setup marked done without a handoff");
    if (!app.audioSetup.firstRunMode) fail("first-run setup not opened without a handoff");
    console.log("PASS: no handoff keeps today's join prompt and first-run setup");
  }

  // 3. A fragment without ?home= is ignored (and still removed).
  {
    const { w, fetches, modal, stored } = await boot(`${GUEST_URL}#dm=${encode({ v: 1, user: { name: "Eve" }, audio: { setup_done: true } })}`);
    if (stored("dubmate_user") && JSON.parse(stored("dubmate_user")).name === "Eve") fail("handoff applied without ?home=");
    if (stored("dubmate_audio_setup_done") === "1") fail("setup marked done without ?home=");
    if (modal.style.display !== "flex" || joinedDirectly(fetches)) fail("guest without ?home= did not get the prompt");
    if (w.location.hash !== "") fail("fragment left in place");
    console.log("PASS: a handoff without ?home= is ignored and removed");
  }

  // 4. A fragment that isn't valid base64url JSON is ignored.
  {
    const { modal, fetches, stored } = await boot(`${MEMBER_URL}#dm=%%%not-base64`);
    if (stored("dubmate_audio_setup_done") || modal.style.display !== "flex" || joinedDirectly(fetches)) fail("garbage handoff was used");
    console.log("PASS: an unreadable handoff is ignored");
  }

  // 5. Invalid fields are dropped one by one.
  {
    const good = { [PAIR]: { latency_ms: 85, method: "clicks", measured_at: 1000 } };
    const { storedJson, stored } = await boot(`${MEMBER_URL}#dm=${encode({
      v: 1,
      user: { name: "Ana", color: "red" },
      audio: { setup_done: "yes", input_label: "x".repeat(201), output_label: 7 },
      mic_sync: { ...good, "Far|Away": { latency_ms: 5000, measured_at: 3000 }, ["k".repeat(201)]: { latency_ms: 10 } },
      noise_reduction: "off",
    })}`);
    const user = storedJson("dubmate_user");
    if (user.name !== "Ana") fail(`valid name dropped: ${JSON.stringify(user)}`);
    if (user.color === "red") fail("bad colour stored");
    if (stored("dubmate_audio_setup_done")) fail("non-boolean setup_done stored");
    if (stored("dubmate_audio_handoff")) fail(`bad labels stored: ${stored("dubmate_audio_handoff")}`);
    const sync = storedJson("dubmate_mic_sync");
    if (sync?.[PAIR]?.latency_ms !== 85) fail("valid mic sync entry dropped");
    if ("Far|Away" in sync || Object.keys(sync).length !== 1) fail(`invalid mic sync entries stored: ${Object.keys(sync)}`);
    if (stored("dubmate_noise_reduction")) fail("non-boolean noise reduction stored");
    console.log("PASS: bad colour, labels, out-of-range delay, long key and bad flags are dropped one by one");
  }
  {
    const { storedJson, stored } = await boot(`${MEMBER_URL}#dm=${encode({
      v: 1, user: { name: "n".repeat(500), color: "#ABCDEF" }, mic_sync: [1, 2],
    })}`);
    const user = storedJson("dubmate_user");
    if (user.name === "n".repeat(500) || user.color !== "#ABCDEF") fail(`500-char name or colour: ${JSON.stringify(user).slice(0, 80)}`);
    if (stored("dubmate_mic_sync")) fail("a non-object mic sync was stored");
    console.log("PASS: a 500-character name and a non-object mic sync are dropped");
  }
  {
    const { stored } = await boot(`${MEMBER_URL}#dm=${encode({ v: 2, user: { name: "Future" } })}`);
    if (stored("dubmate_user") && JSON.parse(stored("dubmate_user")).name === "Future") fail("unknown handoff version applied");
    console.log("PASS: an unknown handoff version is ignored");
  }

  // 6. An id inside a crafted payload is never written.
  {
    const { app, storedJson } = await boot(`${MEMBER_URL}#dm=${encode({ v: 1, user: { id: "u_victim", name: "Eve" }, id: "u_victim" })}`);
    if (JSON.stringify(storedJson("dubmate_user")).includes("u_victim") || app.user.id === "u_victim") fail("crafted id written");
    if (!/^u_/.test(app.user.id)) fail(`no id of its own: ${app.user.id}`);
    console.log("PASS: a crafted id in the handoff is never used");
  }

  // 7. A newer mic sync on the host's origin isn't overwritten by an older handoff entry.
  {
    const { storedJson } = await boot(`${MEMBER_URL}#dm=${encode({
      v: 1, user: { name: "Ana" },
      mic_sync: { [PAIR]: { latency_ms: 85, measured_at: 1000 }, "Other|Speakers": { latency_ms: 30, measured_at: 5000 } },
    })}`, {
      storage: { dubmate_mic_sync: JSON.stringify({ [PAIR]: { latency_ms: 120, method: "claps", measured_at: 9000 }, "Other|Speakers": { latency_ms: 60, measured_at: 10 } }) },
    });
    const sync = storedJson("dubmate_mic_sync");
    if (sync[PAIR].latency_ms !== 120) fail(`newer local entry overwritten: ${JSON.stringify(sync[PAIR])}`);
    if (sync["Other|Speakers"].latency_ms !== 30) fail(`newer handoff entry not taken: ${JSON.stringify(sync["Other|Speakers"])}`);
    console.log("PASS: mic sync entries merge with the newer one winning");
  }

  // 8. A version difference shows as a toast when joining straight in.
  {
    const { toasts, w } = await boot(`${MEMBER_URL}#dm=${encode({ v: 1, user: { name: "Ana" } })}`, { hostVersion: "1.3.0", homeVersion: "1.2.4" });
    await tick(50);
    const note = w.document.getElementById("join-modal-version-note");
    if (!toasts().some((t) => /host has DubMate 1\.3\.0 and you have 1\.2\.4\. Update yours/.test(t))) fail(`no version toast: ${JSON.stringify(toasts())}`);
    if (note && !note.hidden) fail("version note shown in a prompt that never opened");
    console.log("PASS: a version difference shows as a toast for a direct join");
  }

  // 9. Browser guests: the prompt is filled with the name last used on this host.
  {
    const { w, modal, fetches } = await boot(GUEST_URL, { storage: { dubmate_user: JSON.stringify({ id: "u_g", name: "Bea", color: "#0ea5e9" }) } });
    if (modal.style.display !== "flex" || joinedDirectly(fetches)) fail("browser guest did not get the prompt");
    const input = w.document.getElementById("input-join-actor-name");
    if (input.value !== "Bea") fail(`prompt not filled with the remembered name: ${input.value}`);
    console.log("PASS: a browser guest's join prompt is filled with the name they used on this host");
  }

  // 10. joinRoom adds the handoff only when there is a home origin.
  {
    const { app, navigations } = await boot(GUEST_URL, { remoteRooms: { ZZ99: "https://h2.trycloudflare.com" } });
    await app.joinRoom("ZZ99");
    const target = navigations[0] && new URL(navigations[0]);
    if (!target || target.origin !== "https://h2.trycloudflare.com") fail(`guest hop: ${navigations[0]}`);
    if (target.hash) fail(`browser guest's link carries a handoff: ${navigations[0]}`);
    console.log("PASS: a browser guest's link carries no handoff");
  }

  // 11. The Timing row's tooltip says where a member's sync is kept.
  {
    const { app, w } = await boot(MEMBER_URL);
    app.renderMicSyncRow();
    const tip = w.document.getElementById("mic-sync-status")?.getAttribute("data-tip") || app.micSyncStatus?.getAttribute("data-tip");
    if (tip !== "Sync on your own DubMate to keep it for every room.") fail(`member tooltip: ${tip}`);
    const guest = await boot(GUEST_URL);
    guest.app.renderMicSyncRow();
    const guestTip = guest.app.micSyncStatus?.getAttribute("data-tip");
    if (guestTip !== "Your browser keeps this until the host restarts DubMate.") fail(`guest tooltip: ${guestTip}`);
    console.log("PASS: the mic sync tooltip points members to their own DubMate");
  }

  // 12. The host no longer has the room but the registry still points at this
  // page: show "not found" and go back to the member's own DubMate instead of
  // reloading the same page forever.
  {
    const GONE = "WXYZ";
    const url = `${TUNNEL}/?room=${GONE}&home=${encodeURIComponent(HOME)}#dm=${encode({ v: 1, user: { name: "Ana" } })}`;
    const { w, app, navigations, toasts } = await boot(url, { remoteRooms: { [GONE]: TUNNEL } });
    await app.joinRoom(GONE);
    if (navigations.some((n) => new URL(n).origin === TUNNEL)) fail(`jumped back to the same page: ${navigations}`);
    if (JSON.stringify(navigations) !== JSON.stringify([`${HOME}/`])) fail(`member not sent home: ${navigations}`);
    if (!toasts().some((t) => t.includes(`Room ${GONE} wasn't found`))) fail(`no "not found" toast: ${JSON.stringify(toasts())}`);
    if (new URL(w.location.href).searchParams.has("room")) fail(`room code left in the address bar: ${w.location.href}`);
    console.log("PASS: a registry entry pointing back at this page shows 'not found' and goes home instead of looping");
  }
  {
    // Same case for a browser guest (no home): no jump at all, back to the home screen.
    const GONE = "WXYZ";
    const { app, navigations, toasts } = await boot(GUEST_URL, { remoteRooms: { [GONE]: TUNNEL } });
    await app.joinRoom(GONE);
    if (navigations.length) fail(`guest jumped back to the same page: ${navigations}`);
    if (!toasts().some((t) => t.includes(`Room ${GONE} wasn't found`))) fail(`no "not found" toast for a guest: ${JSON.stringify(toasts())}`);
    if (app.currentView !== "landing") fail(`guest not on the home screen: ${app.currentView}`);
    console.log("PASS: a browser guest gets 'not found' instead of a reload of the same page");
  }

  console.log("ALL JOIN HANDOFF TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
