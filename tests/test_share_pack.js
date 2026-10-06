/**
 * test_share_pack.js
 *
 * Share a scene and Get this scene:
 *   - on the engine's own computer, a pack card's Share saves the file on the engine
 *     and opens "Ready to send" with the full path; Copy writes that path;
 *   - elsewhere, Share downloads the file with "Send the file to a friend.";
 *   - #btn-get-scene shows only for a member who came from their own DubMate
 *     (a home origin that isn't this page) and downloads with the Import pack toast.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");
const bundle = buildStudioBundle();
const { JSDOM, VirtualConsole } = jsdom;

const EXPORTS_DIR = "/home/tani/DubMate Renders";
const SAVED_NAME = "DubMate_Pack_Host_Pack_HostPack.zip";
const PACK = {
  id: "HostPack",
  name: "Host Pack",
  lines: [],
  characters: [],
  export_url: "/api/packs/HostPack/export",
};

function fail(msg, extra) {
  console.error("FAIL: " + msg, extra === undefined ? "" : extra);
  process.exit(1);
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function boot(url, { home = null } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (!/not implemented/i.test(String(err && err.message))) console.error(err);
  });
  const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole });
  const w = dom.window;
  if (home) w.sessionStorage.setItem("dubmate_home_origin", home);
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
  w.URL.createObjectURL = () => "blob:mock";
  w.URL.revokeObjectURL = () => {};

  // The browser save is a.click() on a throwaway anchor; record it instead.
  const saved = [];
  w.HTMLAnchorElement.prototype.click = function () {
    saved.push({ href: this.getAttribute("href"), download: this.getAttribute("download") });
  };

  const fetches = [];
  w.fetch = (input) => {
    const u = String(input || "");
    fetches.push(u);
    if (u.startsWith("/api/config")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ exports_dir: EXPORTS_DIR }) });
    }
    if (/^\/api\/packs\/[^/]+\/export/.test(u)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === "x-dubmate-file" ? SAVED_NAME : null) },
        body: { cancel: () => Promise.resolve() },
        blob: () => Promise.resolve(new w.Blob(["zip"])),
        json: () => Promise.reject(new Error("not JSON")),
      });
    }
    if (u.startsWith("/api/packs")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([PACK]), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  };

  w.eval(bundle);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await tick();
  const app = w.dubMateApp;
  if (!app) fail(`studio did not boot at ${url}`);
  const toasts = [];
  app.showToast = (msg) => toasts.push(String(msg));
  return { w, app, fetches, saved, toasts };
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));

(async () => {
  // 1. On the engine's own computer, Share opens "Ready to send" with the full path.
  {
    const { w, app, saved, toasts, fetches } = await boot("http://127.0.0.1:8123/");
    await tick(20);
    const chip = w.document.querySelector(".btn-pack-download-icon");
    if (!chip) fail("pack card has no Share chip");
    if (chip.textContent.trim() !== "Share") fail(`chip label is "${chip.textContent.trim()}"`);
    if (chip.getAttribute("aria-label") !== "Share Host Pack") fail(`chip aria-label: ${chip.getAttribute("aria-label")}`);
    if (chip.dataset.tip !== "Save this scene as a file to send to a friend") fail(`chip tip: ${chip.dataset.tip}`);

    chip.focus();
    click(w, chip);
    await tick(50);
    if (!fetches.some((u) => u.startsWith("/api/packs/HostPack/export"))) fail("Share did not ask the engine for the file");
    if (saved.length) fail("Share saved a second copy on the engine's own computer", saved);
    const modal = w.document.getElementById("modal-share-pack");
    if (!modal || modal.hidden) fail("Ready to send did not open");
    if (modal.getAttribute("role") !== "dialog" || modal.getAttribute("aria-modal") !== "true") fail("share window is not a modal dialog");
    const title = w.document.getElementById(modal.getAttribute("aria-labelledby"));
    if (!title || title.textContent.trim() !== "Ready to send") fail("share window title is wrong");
    if (!modal.textContent.includes("Send this file to a friend. They add it with Import pack in DubMate.")) fail("share window text is wrong");
    const input = w.document.getElementById("share-pack-path");
    const expected = `${EXPORTS_DIR}/packs/${SAVED_NAME}`;
    if (input.value !== expected) fail(`share path: ${input.value}`);
    if (!input.readOnly) fail("the path is editable");
    if (toasts.some((t) => t.startsWith("Saved to"))) fail("Share also showed the folder toast", toasts);
    console.log("PASS: on the engine's computer, Share opens Ready to send with the full path");

    let copied = null;
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { copied = t; } } });
    w.document.getElementById("btn-share-pack-copy").click();
    await tick(20);
    if (copied !== expected) fail(`Copy wrote ${copied}`);
    if (toasts[toasts.length - 1] !== "Copied.") fail(`Copy toast: ${toasts[toasts.length - 1]}`);

    // No clipboard: the path is selected so it can be copied by hand.
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: undefined });
    let selected = false;
    input.select = () => { selected = true; };
    w.document.getElementById("btn-share-pack-copy").click();
    await tick(20);
    if (!selected) fail("without a clipboard, Copy did not select the path");
    console.log("PASS: Copy writes the path, or selects it when there is no clipboard");

    w.document.getElementById("btn-share-pack-done").click();
    if (!modal.hidden) fail("Done did not close the share window");
    if (w.document.activeElement !== chip) fail("focus did not return to the Share chip");
    console.log("PASS: Done closes the window and returns focus to Share");

    // The path uses one separator throughout, whatever the export folder was saved with.
    const paths = [
      ["C:/Users/tani/DubMate Renders", `C:\\Users\\tani\\DubMate Renders\\packs\\${SAVED_NAME}`],
      ["C:\\Users/tani\\DubMate Renders\\", `C:\\Users\\tani\\DubMate Renders\\packs\\${SAVED_NAME}`],
      ["\\\\nas\\share/renders", `\\\\nas\\share\\renders\\packs\\${SAVED_NAME}`],
      ["/home/tani/renders/", `/home/tani/renders/packs/${SAVED_NAME}`],
    ];
    for (const [dir, want] of paths) {
      app.openSharePack(SAVED_NAME, dir, chip);
      if (input.value !== want) fail(`share path for ${dir}: ${input.value}`);
      w.document.getElementById("btn-share-pack-done").click();
    }
    console.log("PASS: the shared file's path uses the folder's own separator throughout");
  }

  // 2. Off the engine's computer, Share downloads with the send-to-a-friend toast.
  {
    const { w, app, saved, toasts } = await boot("https://abc.trycloudflare.com/");
    await tick(20);
    const chip = w.document.querySelector(".btn-pack-download-icon");
    if (!chip) fail("remote pack card has no Share chip");
    click(w, chip);
    await tick(50);
    if (saved.length !== 1 || saved[0].download !== "Host_Pack.zip") fail("remote Share did not download the file", saved);
    if (!w.document.getElementById("modal-share-pack").hidden) fail("remote Share opened the path window");
    if (!toasts.includes('Downloaded "Host Pack". Send the file to a friend.')) fail("remote Share toast", toasts);
    console.log("PASS: off the engine's computer, Share downloads and says to send the file");
  }

  // 3. Get this scene: only for members who came from their own DubMate.
  const room = (hostId) => ({ room_id: "DUB-AB12", host_id: hostId, pack: { ...PACK, line_count: 0 }, takes: {}, users: {}, role_assignments: {} });
  {
    const { app } = await boot("http://127.0.0.1:8123/");
    app.roomState = room(app.user.id);
    app.renderLobbyState();
    if (!app.btnGetScene.hidden) fail("the host sees Get this scene");
  }
  {
    const { app } = await boot("https://abc.trycloudflare.com/");
    app.roomState = room("someone-else");
    app.renderLobbyState();
    if (!app.btnGetScene.hidden) fail("a browser guest with no DubMate of their own sees Get this scene");
  }
  {
    const { app } = await boot("https://abc.trycloudflare.com/", { home: "http://127.0.0.1:8123" });
    app.roomState = room(app.user.id);
    app.renderLobbyState();
    if (!app.btnGetScene.hidden) fail("a host on their own tunnel sees Get this scene");
  }
  {
    const { w, app, saved, toasts, fetches } = await boot("https://abc.trycloudflare.com/", { home: "http://127.0.0.1:8123" });
    app.roomState = room("someone-else");
    app.renderLobbyState();
    const btn = w.document.getElementById("btn-get-scene");
    if (btn.hidden) fail("a member from their own DubMate does not see Get this scene");
    if (btn.textContent.trim() !== "Get this scene") fail(`button label: ${btn.textContent.trim()}`);
    if (btn.dataset.tip !== "Download this scene to add to your own DubMate") fail(`button tip: ${btn.dataset.tip}`);
    btn.click();
    await tick(50);
    if (!fetches.some((u) => u.startsWith("/api/packs/HostPack/export"))) fail("Get this scene did not fetch the scene", fetches);
    if (saved.length !== 1 || saved[0].download !== "Host_Pack.zip") fail("Get this scene did not download", saved);
    if (!toasts.includes('Downloaded "Host Pack". Add it with Import pack in your DubMate.')) fail("Get this scene toast", toasts);
    if (btn.disabled || btn.hasAttribute("aria-busy")) fail("Get this scene stayed busy");
  }
  console.log("PASS: Get this scene shows only for members from their own DubMate and downloads with the import toast");

  console.log("ALL SHARE PACK TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
