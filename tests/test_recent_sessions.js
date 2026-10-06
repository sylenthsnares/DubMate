/**
 * test_recent_sessions.js
 *
 * "Continue where you left off" on the landing page: the recent sessions card
 * (rows, missing scene, unreadable session, own computer only), Continue, Remove,
 * and joinRoom reopening the line the host was on.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

async function boot(url, routes) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
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

  const calls = [];
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
  w.fetch = (input, opts = {}) => {
    const u = String(input || "");
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ url: u, method });
    for (const [re, handler] of routes) {
      if (re.test(u)) {
        const [status, body] = handler(method, u);
        return json(status, body);
      }
    }
    if (u.startsWith("/api/packs")) return json(200, []);
    return json(200, {});
  };

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick(100);
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  const toasts = [];
  app.showToast = (msg) => toasts.push(msg);
  return { w, app, calls, toasts };
}

const LOCAL = "http://127.0.0.1:8123/";

function session(over = {}) {
  return {
    room_id: "DUB-AB12", pack_id: "Scene1", pack_name: "The <Scene>", pack_found: true,
    recorded_lines: 12, total_lines: 30, last_active_at: now() - 2 * 3600, status: "recording",
    readable: true, ...over,
  };
}

const rows = (w) => [...w.document.querySelectorAll("#recent-sessions-list .recent-session-row")];

(async () => {
  // 1. Rows render with counts, relative time and an exact-time tooltip.
  {
    const list = [session(), session({ room_id: "DUB-CD34", pack_name: "Other", recorded_lines: 1, total_lines: 4, last_active_at: now() - 5 * 60 })];
    const { w, calls } = await boot(LOCAL, [[/^\/api\/sessions$/, () => [200, { sessions: list }]]]);
    if (!calls.some((c) => c.url === "/api/sessions")) fail("landing on the own computer did not load sessions");
    const section = w.document.getElementById("recent-sessions");
    if (section.hidden) fail("section hidden with sessions");
    if (!/Continue where you left off/.test(section.textContent)) fail("heading missing");
    const r = rows(w);
    if (r.length !== 2) fail(`expected 2 rows, got ${r.length}`);
    const title = r[0].querySelector(".recent-session-title");
    if (title.textContent !== "The <Scene>" || title.querySelector("*")) fail(`title not escaped: ${title.innerHTML}`);
    const meta = r[0].querySelector(".recent-session-meta").textContent;
    if (!/^12 of 30 lines recorded · 2 hours ago$/.test(meta.trim())) fail(`meta: ${meta}`);
    if (!/5 minutes ago/.test(r[1].textContent)) fail(`second row time: ${r[1].textContent}`);
    if (!r[0].querySelector(".recent-session-meta [data-tip]").getAttribute("data-tip")) fail("exact time tooltip missing");
    const remove = r[0].querySelector(".btn-session-remove");
    if (remove.getAttribute("aria-label") !== "Remove The <Scene>") fail(`remove label: ${remove.getAttribute("aria-label")}`);
    if (remove.getAttribute("data-tip") !== "Remove this session") fail("remove tooltip");
    const cont = r[0].querySelector(".btn-session-continue");
    if (!cont || cont.disabled || cont.textContent.trim() !== "Continue") fail("Continue button");
    console.log("PASS: rows show title, counts, relative time and actions");
  }

  // relativeTime wording.
  {
    const { app } = await boot(LOCAL, [[/^\/api\/sessions$/, () => [200, { sessions: [] }]]]);
    const cases = [[10, "just now"], [60, "1 minute ago"], [45 * 60, "45 minutes ago"], [3600, "1 hour ago"],
      [5 * 3600, "5 hours ago"], [26 * 3600, "yesterday"], [3 * 86400, "3 days ago"]];
    for (const [ago, want] of cases) {
      const got = app.relativeTime(now() - ago);
      if (got !== want) fail(`relativeTime(${ago}s ago) = ${got}, want ${want}`);
    }
    const old = app.relativeTime(now() - 30 * 86400);
    if (/ago|yesterday|just now/.test(old) || !old) fail(`old date: ${old}`);
    console.log("PASS: relativeTime wording");
  }

  // 2. Empty list and not the own computer keep the section hidden.
  {
    const { w } = await boot(LOCAL, [[/^\/api\/sessions$/, () => [200, { sessions: [] }]]]);
    if (!w.document.getElementById("recent-sessions").hidden) fail("section shown for an empty list");
    const remote = await boot("https://abc.trycloudflare.com/", [[/^\/api\/sessions$/, () => [200, { sessions: [session()] }]]]);
    if (remote.calls.some((c) => c.url === "/api/sessions")) fail("sessions loaded away from the own computer");
    if (!remote.w.document.getElementById("recent-sessions").hidden) fail("section shown away from the own computer");
    console.log("PASS: section stays hidden when empty or not on the own computer");
  }

  // 3. A missing scene disables Continue; 4. an unreadable session shows only Remove.
  {
    const list = [session({ pack_found: false }), session({ room_id: "BAD1", readable: false, pack_name: null })];
    const { w } = await boot(LOCAL, [[/^\/api\/sessions$/, () => [200, { sessions: list }]]]);
    const [missing, bad] = rows(w);
    if (!/This scene isn't in your library/.test(missing.textContent)) fail("missing scene text");
    const cont = missing.querySelector(".btn-session-continue");
    if (!cont.disabled || cont.getAttribute("data-tip") !== "Add the scene again to continue") fail("missing scene Continue not disabled");
    if (!missing.querySelector(".btn-session-remove")) fail("missing scene has no remove");
    console.log("PASS: a missing scene disables Continue");
    if (!/A session that couldn't be opened/.test(bad.textContent)) fail("unreadable title");
    if (bad.querySelector(".btn-session-continue")) fail("unreadable row has Continue");
    if (bad.querySelectorAll("button").length !== 1 || !bad.querySelector(".btn-session-remove")) fail("unreadable row should only have Remove");
    if (!/ago/.test(bad.querySelector(".recent-session-meta").textContent)) fail("unreadable row has no date");
    console.log("PASS: an unreadable session shows only Remove");
  }

  // 5. Continue sets the user id, saves it and joins the room.
  {
    const { w, app, calls } = await boot(LOCAL, [
      [/^\/api\/sessions$/, () => [200, { sessions: [session()] }]],
      [/^\/api\/sessions\/DUB-AB12\/open$/, () => [200, { room_id: "DUB-AB12", user_id: "u_host1", state: {} }]],
    ]);
    const joined = [];
    app.joinRoom = async (id) => { joined.push(id); };
    rows(w)[0].querySelector(".btn-session-continue").click();
    await tick();
    if (!calls.some((c) => c.url === "/api/sessions/DUB-AB12/open" && c.method === "POST")) fail("Continue did not POST open");
    if (app.user.id !== "u_host1") fail(`user id not set: ${app.user.id}`);
    if (JSON.parse(w.localStorage.getItem("dubmate_user")).id !== "u_host1") fail("user not saved");
    if (joined.join() !== "DUB-AB12") fail(`joinRoom calls: ${joined}`);
    console.log("PASS: Continue sets the user id, saves it and joins the room");
  }

  // Continue failure shows the server's message and reloads the list.
  {
    const { w, app, calls, toasts } = await boot(LOCAL, [
      [/^\/api\/sessions$/, () => [200, { sessions: [session()] }]],
      [/\/open$/, () => [409, { detail: "This scene isn't in your library anymore." }]],
    ]);
    const before = app.user.id;
    app.joinRoom = async () => fail("joined on a failed open");
    const loads = calls.filter((c) => c.url === "/api/sessions").length;
    await app.continueSession("DUB-AB12");
    await tick();
    if (toasts.pop() !== "This scene isn't in your library anymore.") fail("failed open toast");
    if (app.user.id !== before) fail("user id changed on a failed open");
    if (calls.filter((c) => c.url === "/api/sessions").length !== loads + 1) fail("list not reloaded after a failed open");
    if (!rows(w).length) fail("rows gone after reload");
    console.log("PASS: a failed Continue shows the reason and reloads the list");
  }

  // 6. Remove confirms, sends DELETE and drops the row; a 409 shows a toast.
  {
    let status = 200;
    const { w, app, calls, toasts } = await boot(LOCAL, [
      [/^\/api\/sessions$/, () => [200, { sessions: [session(), session({ room_id: "DUB-CD34" })] }]],
      [/^\/api\/sessions\/[^/]+$/, () => [status, status === 200 ? { status: "ok" } : { detail: "x" }]],
    ]);
    const asked = [];
    w.confirm = (msg) => { asked.push(msg); return false; };
    rows(w)[0].querySelector(".btn-session-remove").click();
    await tick();
    if (asked[0] !== "Remove this session? Its takes are deleted. Videos you saved stay in your export folder.") fail(`confirm text: ${asked[0]}`);
    if (calls.some((c) => c.method === "DELETE")) fail("DELETE sent after cancel");

    w.confirm = () => true;
    status = 409;
    await app.removeSession("DUB-AB12");
    if (toasts.pop() !== "Someone is still in this session.") fail("409 toast");
    if (rows(w).length !== 2) fail("row removed on 409");
    status = 500;
    await app.removeSession("DUB-AB12");
    if (toasts.pop() !== "Couldn't remove that session. Try again.") fail("500 toast");

    status = 200;
    rows(w)[0].querySelector(".btn-session-remove").click();
    await tick();
    if (!calls.some((c) => c.url === "/api/sessions/DUB-AB12" && c.method === "DELETE")) fail("DELETE not sent");
    if (rows(w).map((r) => r.dataset.roomId).join() !== "DUB-CD34") fail("row not dropped");
    if (w.document.getElementById("recent-sessions").hidden) fail("section hidden with a row left");
    await app.removeSession("DUB-CD34");
    if (rows(w).length || !w.document.getElementById("recent-sessions").hidden) fail("section not hidden when empty");
    console.log("PASS: Remove confirms, deletes and drops the row; failures toast");
  }

  // 7. savedLineIndex and joinRoom reopening the saved line.
  {
    const { app } = await boot(LOCAL, [[/^\/api\/sessions$/, () => [200, { sessions: [] }]]]);
    const lines = Array.from({ length: 10 }, (_, i) => ({ index: i, character: "A" }));
    const withUser = (u) => ({ room_id: "DUB-AB12", host_id: app.user.id, status: "recording",
      pack: { lines, characters: ["A"] }, takes: {}, users: { [app.user.id]: u } });
    const cases = [
      [{ current_line: 0, location: "lobby" }, null],
      [{ current_line: 0, location: "booth" }, 0],
      [{ current_line: 5, location: "lobby" }, 5],
      [{ current_line: 10, location: "booth" }, null],
      [{ current_line: -1, location: "booth" }, null],
      [{ current_line: "3", location: "booth" }, null],
      [{}, null],
    ];
    for (const [u, want] of cases) {
      app.roomState = withUser(u);
      const got = app.savedLineIndex();
      if (got !== want) fail(`savedLineIndex(${JSON.stringify(u)}) = ${got}, want ${want}`);
    }
    app.roomState = { pack: { lines }, users: {} };
    if (app.savedLineIndex() !== null) fail("savedLineIndex without a user entry");
    console.log("PASS: savedLineIndex cases");

    const room = withUser({ current_line: 5, location: "booth" });
    const roomRoute = [[/^\/api\/rooms\/DUB-AB12$/, () => [200, room]]];
    const b = await boot(LOCAL, roomRoute);
    room.host_id = b.app.user.id;
    room.users = { [b.app.user.id]: { current_line: 5, location: "booth" } };
    const order = [];
    b.app.socket.connect = () => {
      order.push("connect");
      // The socket join wipes the saved status, as the server does.
      b.app.roomState.users[b.app.user.id] = { id: b.app.user.id };
    };
    b.app.loadBoothLine = (i) => order.push(`line:${i}`);
    b.app.broadcastMyStatus = () => {};
    b.app.startShareWatch = () => {};
    await b.app.joinRoom("DUB-AB12");
    if (order.join() !== "connect,line:5") fail(`joinRoom opened ${order.join()}`);
    if (b.app.currentView !== "booth") fail(`joinRoom view ${b.app.currentView}`);

    room.users = { [b.app.user.id]: { current_line: 0, location: "lobby" } };
    order.length = 0;
    b.app.findFirstAssignedLine = () => 2;
    await b.app.joinRoom("DUB-AB12");
    if (order.join() !== "connect,line:2") fail(`joinRoom without a saved line opened ${order.join()}`);
    console.log("PASS: joinRoom opens the saved line in a recording room");
  }

  console.log("ALL RECENT SESSIONS TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
