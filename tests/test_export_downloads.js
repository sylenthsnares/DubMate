/**
 * test_export_downloads.js
 *
 * Covers the export/download feedback fixes:
 *   - the premiere's Save (its main part and its menu's video rows), the export
 *     modal's two anchors and the pack ZIP anchor must fetch a blob, never navigate
 *     (a JSON error body used to replace the whole studio);
 *   - every download shows it is under way (the row reads Preparing…) and says
 *     when it finished;
 *   - a failed download must produce a toast, not a page;
 *   - a successful render must name the folder it was written to;
 *   - on the engine's own computer (loopback origin) nothing saves a second copy:
 *     the render is already in the export folder (bug B4), so Save shows it in its
 *     folder; the separate tracks and editing project rows say "saved · Show in
 *     folder" instead (P23), and the pack ZIP opens its Share.
 *
 * Navigation detection note: jsdom cannot have `location.assign` patched (it is an
 * unforgeable own property), but every navigation route it could take --
 * `location.assign()`, `location.href = ...`, and an un-prevented anchor default
 * action -- surfaces as the same jsdomError, "Not implemented: navigation".
 * Asserting zero of those during a download therefore proves no navigation of any
 * kind happened, `location.assign` included.
 */
const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");
const EXPORTS_DIR = "X:\\Users\\Tani\\Videos\\DubMate Renders";

const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");

const { JSDOM, VirtualConsole } = jsdom;

const navigationAttempts = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (err) => {
  if (/not implemented: navigation/i.test(String(err && err.message))) {
    navigationAttempts.push(String(err.message).split("\n")[0]);
  }
});

const dom = new JSDOM(html, {
  url: "http://localhost:8000/",
  runScripts: "dangerously",
  virtualConsole,
});

// Mock browser APIs missing in JSDOM
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  clearRect: () => {},
  fillRect: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  fill: () => {},
  arc: () => {},
  save: () => {},
  restore: () => {},
  translate: () => {},
  rotate: () => {},
  createLinearGradient: () => ({ addColorStop: () => {} }),
});
dom.window.AudioContext = class {
  createGain() { return { gain: { value: 1.0 }, connect: () => {} }; }
  createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {} }; }
  createBiquadFilter() { return { type: 'highpass', frequency: { value: 80 }, Q: { value: 0.707 }, connect: () => {} }; }
  createDynamicsCompressor() { return { threshold: { value: -20 }, knee: { value: 10 }, ratio: { value: 3 }, attack: { value: 0.01 }, release: { value: 0.1 }, connect: () => {} }; }
  createConvolver() { return { buffer: null, connect: () => {} }; }
  createBuffer(channels, length, sampleRate) {
    const arr = new Float32Array(length || 100);
    return {
      numberOfChannels: channels || 2,
      length: length || 100,
      sampleRate: sampleRate || 44100,
      duration: (length || 100) / (sampleRate || 44100),
      getChannelData: () => arr
    };
  }
  decodeAudioData() {
    const arr = new Float32Array(100);
    return Promise.resolve({
      numberOfChannels: 1,
      length: 100,
      sampleRate: 44100,
      duration: 2.5,
      getChannelData: () => arr
    });
  }
};
dom.window.scrollTo = () => {};

const objectUrls = { created: 0, revoked: 0 };
dom.window.URL.createObjectURL = () => { objectUrls.created += 1; return "blob:http://localhost:8000/mock"; };
dom.window.URL.revokeObjectURL = () => { objectUrls.revoked += 1; };

// The save itself is `a.click()` on a throwaway anchor. Recording it here (rather
// than calling through) keeps jsdom from logging a navigation for the blob: URL,
// which would be indistinguishable from the bug we are testing for.
const savedFiles = [];
dom.window.HTMLAnchorElement.prototype.click = function () {
  savedFiles.push({ href: this.getAttribute("href"), download: this.getAttribute("download") });
};

const mockPacks = [
  {
    id: "Deku_vs_Todoroki",
    name: "Deku vs Todoroki",
    video_url: "/api/packs/Deku_vs_Todoroki/video",
    duration: 38.5,
    characters: ["Deku", "Todoroki"],
    lines: [
      { index: 0, character: "Deku", start: 1.2, end: 4.5, duration: 3.3, audio_url: "/api/packs/Deku_vs_Todoroki/audio/0.wav", text: "It is your power, isn't it?!" },
      { index: 1, character: "Todoroki", start: 5.0, end: 9.0, duration: 4.0, audio_url: "/api/packs/Deku_vs_Todoroki/audio/1.wav", text: "My left side..." }
    ]
  }
];

const fetchLog = [];
let exportDownloadGate = null;   // set to a promise to hold the response open
let exportDownloadFails = false;
let configHasExportsDir = true;
let exportStatusReady = true;    // what /export/status reports for the host path
let exportRefusal = null;        // a {detail} the render route answers 409 with
let stemsGate = null;            // set to a promise to hold the stems response open
let stemsFailure = null;         // a non-ok response the stems route answers with

let bodiesCancelled = 0;
function blobResponse() {
  return {
    ok: true,
    status: 200,
    body: { cancel: () => { bodiesCancelled += 1; return Promise.resolve(); } },
    headers: { get: (name) => (String(name).toLowerCase() === "x-dubmate-file" ? "DubMate_Pack_Deku_vs_Todoroki.zip" : null) },
    blob: () => Promise.resolve(new dom.window.Blob(["dubmate-bytes"], { type: "application/octet-stream" })),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
    json: () => Promise.reject(new Error("Unexpected token, not valid JSON")),
  };
}

const methodLog = [];
dom.window.fetch = async (url, opts) => {
  const u = String(url || "");
  fetchLog.push(u);
  methodLog.push(`${(opts && opts.method) || "GET"} ${u}`);

  if (u.startsWith("/api/config")) {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(configHasExportsDir ? { exports_dir: EXPORTS_DIR } : {}),
    };
  }
  if (u.includes("/export/download")) {
    if (exportDownloadGate) await exportDownloadGate;
    if (exportDownloadFails) {
      return {
        ok: false,
        status: 500,
        // A real ffmpeg failure. It must never reach the user verbatim.
        json: () => Promise.resolve({ detail: "Command '['C:\\ffmpeg.exe', '-y']' returned non-zero exit status 1." }),
      };
    }
    return blobResponse();
  }
  if (u.startsWith("/api/packs/") && u.includes("/export")) {
    return blobResponse();
  }
  if (u.startsWith("/api/rooms/TEST12/export/project_zip")) {
    return blobResponse();
  }
  if (u.startsWith("/api/rooms/TEST12/export/stems")) {
    if (stemsGate) await stemsGate;
    if (stemsFailure) return stemsFailure;
    return blobResponse();
  }
  if (u.startsWith("/api/rooms/TEST12/export/status")) {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ status: exportStatusReady ? "ready" : "idle" }),
    };
  }
  if (u.startsWith("/api/rooms/TEST12/export?") && exportRefusal) {
    return { ok: false, status: 409, json: () => Promise.resolve(exportRefusal) };
  }
  if (u.startsWith("/api/rooms/TEST12/export?")) {
    const aspect = /aspect_ratio=([^&]+)/.exec(u)[1];
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        status: "ok",
        aspect_ratio: aspect,
        export_video_url: `/api/rooms/TEST12/export/video?aspect_ratio=${aspect}`,
        download_url_16_9: "/api/rooms/TEST12/export/download?aspect_ratio=16:9",
        download_url_9_16: "/api/rooms/TEST12/export/download?aspect_ratio=9:16",
      }),
    };
  }
  if (u.startsWith("/api/packs") && !u.includes("/audio/")) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      json: () => Promise.resolve(mockPacks),
    };
  }
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    json: () => Promise.resolve({}),
  };
};

function fail(message, extra) {
  console.error("FAIL: " + message, extra === undefined ? "" : extra);
  process.exit(1);
}

function pass(message) {
  console.log("PASS: " + message);
}

const clickUi = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

try {
  const combinedCode = buildStudioBundle();

  // Evaluate the bundle only once jsdom has finished parsing. Dispatching
  // DOMContentLoaded by hand races jsdom's own event, which constructs the studio
  // twice: window.dubMateApp then points at an instance that owns none of the click
  // handlers, and every assertion about them silently measures the wrong object.
  const domReady = dom.window.document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => dom.window.addEventListener("load", () => resolve()));

  domReady.then(() => {
    dom.window.eval(combinedCode);
    setTimeout(runSuite, 150);
  });

  async function runSuite() {
    const doc = dom.window.document;
    const app = dom.window.dubMateApp;
    if (!app) fail("DubMateApp was not instantiated");

    const toasts = [];
    const realToast = app.showToast.bind(app);
    app.showToast = (message) => { toasts.push(String(message)); realToast(message); };
    const toastsMatching = (re) => toasts.filter(t => re.test(t));

    app.roomState = {
      room_id: "TEST12",
      host_id: app.user.id,
      pack: mockPacks[0],
      takes: {},
      users: {},
    };

    // Give the modal anchors the real hrefs a finished render puts on them. With the
    // placeholder "#" still in place jsdom treats a click as a hash change, which
    // would hide exactly the navigation this suite is here to catch.
    app.handleExportSuccess({
      aspect_ratio: "16:9",
      export_video_url: "/api/rooms/TEST12/export/video",
      download_url_16_9: "/api/rooms/TEST12/export/download?aspect_ratio=16:9",
      download_url_9_16: "/api/rooms/TEST12/export/download?aspect_ratio=9:16",
    });
    app.roomState.exports = { "16:9": "ready", "9:16": "ready" };
    app.updateScreeningControls();
    await settle();
    for (const id of ["btn-modal-download-169", "btn-modal-download-916"]) {
      const href = doc.getElementById(id)?.getAttribute("href");
      if (!href || href === "#") fail(`#${id} never received a real download href`, href);
    }
    pass("a finished render puts real download hrefs on the modal's anchors");

    // Tests 1-3 are a remote host: their page is on a tunnel, the render lives on
    // the engine's disk, so they need a real browser download.
    app.isEngineLocal = () => false;
    app.updateScreeningControls();

    // --- Test 1: every video download is wired to the fetch/blob path --------
    // The Save menu's two video rows, Save's main part once saved, and the modal's anchors.
    const videoControls = ["save-menu-video-169", "save-menu-video-916", "btn-export-video",
      "btn-modal-download-169", "btn-modal-download-916"].map((id) => {
      const el = doc.getElementById(id);
      if (!el) fail(`#${id} missing from the export DOM`);
      return el;
    });
    pass("the Save menu's video rows, Save and the modal's anchors are in the DOM");
    for (const id of ["btn-download-link", "btn-download-link-9-16", "btn-toolbar-project-zip", "btn-download-project-zip",
      "btn-toolbar-stems", "btn-download-stems", "export-progress-box"]) {
      if (doc.getElementById(id)) fail(`#${id} is still on the premiere`);
    }

    for (const control of videoControls) {
      const navBefore = navigationAttempts.length;
      const savesBefore = savedFiles.length;
      const fetchesBefore = fetchLog.length;
      toasts.length = 0;

      clickUi(control);
      await settle();

      if (navigationAttempts.length !== navBefore) {
        fail(`clicking #${control.id} navigated the page instead of downloading`, navigationAttempts.slice(navBefore));
      }
      const requested = fetchLog.slice(fetchesBefore).filter(u => u.includes("/export/download"));
      if (requested.length !== 1) {
        fail(`#${control.id} did not fetch the export exactly once`, requested);
      }
      if (savedFiles.length !== savesBefore + 1) {
        fail(`#${control.id} never handed a blob to the browser`);
      }
      const saved = savedFiles[savedFiles.length - 1];
      if (!saved.href.startsWith("blob:") || !/^DubMate_.+\.mp4$/.test(saved.download || "")) {
        fail(`#${control.id} saved with a bad href/filename`, saved);
      }
      if (toastsMatching(/downloaded/i).length === 0) {
        fail(`#${control.id} did not say the download finished`, toasts);
      }
      if (control.hasAttribute("aria-busy") || control.getAttribute("aria-disabled") === "true" || control.disabled) {
        fail(`#${control.id} was left in its busy state after the download finished`);
      }
    }
    pass("each video download fetches a blob, saves it, says it finished, and never navigates");

    const aspectsRequested = fetchLog.filter(u => u.includes("/export/download"));
    if (!aspectsRequested.some(u => u.includes("16%3A9") || u.includes("16:9")) ||
        !aspectsRequested.some(u => u.includes("9%3A16") || u.includes("9:16"))) {
      fail("the 16:9 and 9:16 rows did not request different aspect ratios", aspectsRequested);
    }
    pass("16:9 and 9:16 request their own aspect ratio");

    // --- Test 2: a second click while one is in flight is ignored -----------
    let releaseGate;
    exportDownloadGate = new Promise((resolve) => { releaseGate = resolve; });
    const doubleClickTarget = videoControls[0];
    const beforeDouble = fetchLog.length;
    clickUi(doubleClickTarget);
    await settle();
    if (doubleClickTarget.getAttribute("aria-busy") !== "true") {
      fail("an in-flight download did not mark its row busy");
    }
    if (doubleClickTarget.querySelector(".save-menu-label").textContent !== "Preparing…") {
      fail("an in-flight download did not read Preparing… on its row", doubleClickTarget.textContent);
    }
    if (doubleClickTarget.disabled) {
      fail("an in-flight download disabled its row, which drops the keyboard focus");
    }
    clickUi(doubleClickTarget);
    clickUi(doubleClickTarget);
    await settle();
    const inFlight = fetchLog.slice(beforeDouble).filter(u => u.includes("/export/download"));
    if (inFlight.length !== 1) {
      fail("double-clicking a download row started more than one download", inFlight);
    }
    releaseGate();
    exportDownloadGate = null;
    await settle();
    if (doubleClickTarget.querySelector(".save-menu-label").textContent !== "Video 16:9") {
      fail("the row did not get its label back", doubleClickTarget.textContent);
    }
    pass("double-clicking a download row only ever starts one download, reading Preparing… meanwhile");

    // --- Test 3: a failing response toasts, it does not become a page -------
    exportDownloadFails = true;
    toasts.length = 0;
    const navBeforeFailure = navigationAttempts.length;
    const savesBeforeFailure = savedFiles.length;
    clickUi(videoControls[0]);
    await settle();
    exportDownloadFails = false;

    if (navigationAttempts.length !== navBeforeFailure) {
      fail("a failed download navigated the page (the JSON error body became a page)");
    }
    if (savedFiles.length !== savesBeforeFailure) {
      fail("a failed download still tried to save a file");
    }
    const errorToasts = toastsMatching(/couldn't|could not/i);
    if (errorToasts.length === 0) {
      fail("a failed download produced no error toast", toasts);
    }
    if (errorToasts.some(t => /ffmpeg|non-zero exit|[A-Za-z]:\\/.test(t))) {
      fail("the failure toast leaked raw ffmpeg output", errorToasts);
    }
    if (videoControls[0].hasAttribute("aria-busy")) {
      fail("a failed download left the row stuck in its busy state");
    }
    pass("a failed download toasts a plain-language error, saves nothing, and never navigates");

    // --- Test 4: the pack ZIP anchor gets the same treatment ---------------
    const packZip = doc.querySelector(".btn-pack-download-icon");
    if (!packZip) fail(".btn-pack-download-icon not rendered in the pack grid");
    if (packZip.getAttribute("onclick")) {
      fail("the pack ZIP link still relies on an inline onclick handler");
    }
    const navBeforePack = navigationAttempts.length;
    const savesBeforePack = savedFiles.length;
    const selectedBeforePack = app.selectedPackId;
    toasts.length = 0;

    clickUi(packZip);
    await settle();

    if (navigationAttempts.length !== navBeforePack) {
      fail("clicking the pack ZIP link navigated the page");
    }
    if (savedFiles.length !== savesBeforePack + 1) {
      fail("the pack ZIP link never handed a blob to the browser");
    }
    if (!/\.zip$/.test(savedFiles[savedFiles.length - 1].download || "")) {
      fail("the pack ZIP saved under the wrong filename", savedFiles[savedFiles.length - 1]);
    }
    if (toastsMatching(/preparing/i).length === 0 || toastsMatching(/downloaded/i).length === 0) {
      fail("the pack ZIP download did not toast start + completion", toasts);
    }
    if (app.selectedPackId !== selectedBeforePack) {
      fail("downloading a pack ZIP also selected the card behind it");
    }
    pass("the pack ZIP link downloads via fetch, toasts, and does not select the card behind it");

    // --- Test 5: a finished render says where it was written ---------------
    const savedPathEl = doc.getElementById("export-saved-path");
    if (!savedPathEl) fail("#export-saved-path missing from the export modal");

    // A remote member must not be shown the host's disk path as "Saved to".
    app.exportsDirCache = undefined;
    await app.showExportSavedPath();
    if (savedPathEl.classList.contains("is-visible")) {
      fail("a remote member was told the render is saved to the host's folder", savedPathEl.innerText);
    }
    pass("a remote member is not shown the host's Render & Export folder");

    // From here on the page is on the engine's own computer (the real loopback
    // origin this jsdom runs at).
    delete app.isEngineLocal;
    if (app.isEngineLocal() !== true) fail("http://localhost:8000 was not detected as a local engine");

    app.exportsDirCache = undefined;
    app.handleExportSuccess({
      aspect_ratio: "16:9",
      export_video_url: "/api/rooms/TEST12/export/video",
      download_url_16_9: "/api/rooms/TEST12/export/download?aspect_ratio=16:9",
      download_url_9_16: "/api/rooms/TEST12/export/download?aspect_ratio=9:16",
    });
    await settle();

    if (!savedPathEl.classList.contains("is-visible")) {
      fail("the export modal never revealed where the render was saved");
    }
    if (!String(savedPathEl.innerText || "").includes(EXPORTS_DIR)) {
      fail("the saved-path line does not show the configured exports_dir", savedPathEl.innerText);
    }
    if (savedPathEl.getAttribute("title") !== EXPORTS_DIR) {
      fail("the full path is not available in the title attribute", savedPathEl.getAttribute("title"));
    }
    pass("a finished render names the configured Render & Export folder, full path in title");

    // Starting another render must not leave the previous path under the bar.
    app.openExportModal();
    if (savedPathEl.classList.contains("is-visible")) {
      fail("a new render kept the previous 'Saved to ...' line visible");
    }
    app.closeExportModal();
    pass("a new render hides the previous saved-path line");

    // --- Test 6: no folder reported -> say nothing rather than guess -------
    configHasExportsDir = false;
    app.exportsDirCache = undefined;
    await app.showExportSavedPath();
    if (savedPathEl.classList.contains("is-visible")) {
      fail("a backend without exports_dir still showed a fabricated save path");
    }
    configHasExportsDir = true;
    pass("no exports_dir from the backend means no invented path");

    // --- Test 7: the settings copy explains the two locations --------------
    const exportsRow = doc.getElementById("audio-exports-row");
    const rowText = exportsRow ? exportsRow.textContent.replace(/\s+/g, " ") : "";
    if (!/browser/i.test(rowText) || !/saved here|saves .*here/i.test(rowText)) {
      fail("the Render & Export Folder setting does not explain where downloads go", rowText);
    }
    if (/extra copy/i.test(rowText)) {
      fail("the Render & Export Folder setting still promises a second copy", rowText);
    }
    pass("the Render & Export Folder setting explains renders vs downloaded copies");

    // --- Test 8 (B4): on the engine's computer, nothing saves a second copy
    // Save's main part and the menu's video rows show the file in its folder.
    app.roomState.exports = { "16:9": "ready", "9:16": "ready" };
    app.updateScreeningControls();
    const createdBeforeHost = objectUrls.created;
    for (const [id, aspect] of [["btn-export-video", "16:9"], ["save-menu-video-169", "16:9"], ["save-menu-video-916", "9:16"]]) {
      const el = doc.getElementById(id);
      const savesBefore = savedFiles.length;
      const methodsBefore = methodLog.length;
      if (id !== "btn-export-video" && el.querySelector(".save-menu-state").textContent !== "saved · Show in folder") {
        fail(`#${id} does not read saved · Show in folder on the engine's computer`, el.textContent);
      }
      clickUi(el);
      await settle();
      const calls = methodLog.slice(methodsBefore);
      if (calls.some(c => c.includes("/export/download")) || savedFiles.length !== savesBefore) {
        fail(`#${id} pulled the render through the browser on the host's own computer`, calls);
      }
      if (!calls.includes("POST /api/rooms/TEST12/export/reveal")) fail(`#${id} did not show the video in its folder`, calls);
    }
    // The modal's anchors name the folder the render is already in.
    for (const id of ["btn-modal-download-169", "btn-modal-download-916"]) {
      const anchor = doc.getElementById(id);
      const savesBefore = savedFiles.length;
      const fetchesBefore = fetchLog.length;
      toasts.length = 0;
      app.exportsDirCache = undefined;
      savedPathEl.classList.remove("is-visible");

      clickUi(anchor);
      await settle();

      const requested = fetchLog.slice(fetchesBefore);
      if (requested.some(u => u.includes("/export/download"))) {
        fail(`#${id} pulled the render through the browser on the host's own computer`, requested);
      }
      if (savedFiles.length !== savesBefore) {
        fail(`#${id} saved a second copy of the render on the host's own computer`);
      }
      if (!toasts.some(t => t.includes(EXPORTS_DIR))) {
        fail(`#${id} did not say which folder the render is already in`, toasts);
      }
      if (!savedPathEl.classList.contains("is-visible")) {
        fail(`#${id} did not reveal the saved-path line`);
      }
    }
    if (objectUrls.created !== createdBeforeHost) {
      fail("the host path still created a blob URL for a download");
    }
    pass("on the engine's own computer, Save shows the video in its folder and saves no copy");

    // An aspect that was never rendered is rendered into the export folder, once,
    // through the normal render route -- still no browser copy.
    exportStatusReady = false;
    const savesBeforeRender = savedFiles.length;
    const methodsBefore = methodLog.length;
    clickUi(doc.getElementById("btn-modal-download-916"));
    await settle();
    exportStatusReady = true;
    const calls = methodLog.slice(methodsBefore);
    if (!calls.some(c => c.startsWith("POST /api/rooms/TEST12/export?aspect_ratio=9:16"))) {
      fail("an unrendered aspect was not rendered into the export folder", calls);
    }
    if (calls.some(c => c.includes("/export/download")) || savedFiles.length !== savesBeforeRender) {
      fail("rendering a missing aspect on the host also saved a browser copy", calls);
    }
    if (!savedPathEl.classList.contains("is-visible")) {
      fail("rendering a missing aspect did not end on the 'Saved to' line");
    }
    app.closeExportModal();
    pass("an unrendered aspect on the host renders once into the export folder, no browser copy");

    // --- Test 9 (P23): ZIPs are written to the export folder by the server,
    // so on the engine's computer they are not saved a second time either.
    const projectRow = doc.getElementById("save-menu-project");
    const stemsRow = doc.getElementById("save-menu-stems");
    if (!projectRow || !stemsRow) fail("the Save menu has no Separate tracks or Editing project row");
    const createdBeforeZips = objectUrls.created;
    for (const { el, route } of [
      { el: projectRow, route: "/export/project_zip" },
      { el: doc.querySelector(".btn-pack-download-icon"), route: "/api/packs/", sharePath: `${EXPORTS_DIR}\\packs\\DubMate_Pack_Deku_vs_Todoroki.zip` },
    ]) {
      const savesBefore = savedFiles.length;
      const fetchesBefore = fetchLog.length;
      toasts.length = 0;
      app.exportsDirCache = undefined;

      clickUi(el);
      await settle();

      const requested = fetchLog.slice(fetchesBefore).filter(u => u.includes(route) && !u.startsWith("/api/config"));
      if (requested.length !== 1) {
        fail(`${el.id || el.className} did not ask the engine to write the ZIP exactly once`, requested);
      }
      if (savedFiles.length !== savesBefore) {
        fail(`${el.id || el.className} saved a second copy of the ZIP on the host's own computer`);
      }
      if (el === projectRow) {
        // The row says so itself; no toast.
        if (el.querySelector(".save-menu-label").textContent !== "Editing project" ||
            el.querySelector(".save-menu-state").textContent !== "saved · Show in folder") {
          fail("the Editing project row did not say it was saved", el.textContent);
        }
        if (toasts.length) fail("the Editing project row also toasted", toasts);
      } else {
        // The pack's Share opens "Ready to send" with the file's full path instead.
        const pathInput = doc.getElementById("share-pack-path");
        if (doc.getElementById("modal-share-pack").hidden || pathInput.value !== `${EXPORTS_DIR}\\packs\\DubMate_Pack_Deku_vs_Todoroki.zip`) {
          fail("the pack Share did not show where the file was saved", pathInput.value);
        }
        doc.getElementById("btn-share-pack-done").click();
      }
      if (el.hasAttribute("aria-busy")) {
        fail(`${el.id || el.className} was left busy after saving`);
      }
    }
    if (objectUrls.created !== createdBeforeZips) {
      fail("a ZIP on the host path still created a blob URL");
    }
    // Saved: the row now shows the file in its folder instead of building it again.
    const methodsBeforeReveal = methodLog.length;
    clickUi(projectRow);
    await settle();
    const revealCalls = methodLog.slice(methodsBeforeReveal);
    if (revealCalls.join() !== "POST /api/rooms/TEST12/export/reveal") fail("a saved Editing project did not show in its folder", revealCalls);
    pass("on the engine's own computer, Editing project and pack ZIP save no copy; the row reads saved · Show in folder");

    // A remote host still gets the project ZIP as a normal download.
    app.isEngineLocal = () => false;
    app.updateScreeningControls();
    const savesBeforeRemoteZip = savedFiles.length;
    toasts.length = 0;
    clickUi(projectRow);
    await settle();
    if (savedFiles.length !== savesBeforeRemoteZip + 1 || !/\.zip$/.test(savedFiles[savedFiles.length - 1].download || "")) {
      fail("a remote host did not get the project ZIP as a download");
    }
    if (toasts.some(t => t.includes(EXPORTS_DIR))) {
      fail("a remote host was shown the engine's folder for the project ZIP", toasts);
    }
    pass("a remote host still downloads the project ZIP");

    if (objectUrls.created === 0) {
      fail("no object URL was ever created; the blob path did not run");
    }

    // A render the engine refuses says why (older takes are being refreshed).
    const REFRESHING = "Older takes are being refreshed. Try again in a moment.";
    exportRefusal = { detail: REFRESHING };
    toasts.length = 0;
    await app.exportFinalVideo("16:9");
    exportRefusal = null;
    if (!toasts.includes(REFRESHING)) fail("a refused render did not say why", toasts);
    app.closeExportModal();
    pass("a render refused during a refresh shows the engine's reason");

    // --- Separate tracks -----------------------------------------------------
    const STEMS_TIP = "Separate WAV files for the voices and for the music and effects, plus one per character, to finish the mix in another editor. They all start with the scene.";
    if (stemsRow.tagName !== "BUTTON" || stemsRow.getAttribute("role") !== "menuitem") fail("Separate tracks is not a menu row");
    if (stemsRow.querySelector(".save-menu-label").textContent !== "Separate tracks (WAV)") fail("the row is not labelled Separate tracks (WAV)");
    if (stemsRow.getAttribute("data-tip") !== STEMS_TIP) fail("Separate tracks has the wrong tooltip", stemsRow.getAttribute("data-tip"));
    if (stemsRow.nextElementSibling !== projectRow) fail("Separate tracks does not sit right before Editing project");
    pass("Separate tracks sits before Editing project in the menu, with the tooltip");

    const stemsFetches = (from) => fetchLog.slice(from).filter(u => u.includes("/export/stems"));

    // A remote host gets a normal download.
    {
      const savesBefore = savedFiles.length;
      const fetchesBefore = fetchLog.length;
      toasts.length = 0;
      clickUi(stemsRow);
      await settle();
      const requested = stemsFetches(fetchesBefore);
      if (requested.length !== 1 || !/^\/api\/rooms\/TEST12\/export\/stems\?user_id=[^&]+&v=\d+$/.test(requested[0])) {
        fail("Separate tracks did not fetch the stems route once", requested);
      }
      if (savedFiles.length !== savesBefore + 1) fail("Separate tracks did not hand the ZIP to the browser");
      const saved = savedFiles[savedFiles.length - 1];
      if (!saved.href.startsWith("blob:") || saved.download !== "DubMate_Stems_Deku_vs_Todoroki_TEST12.zip") {
        fail("Separate tracks saved under the wrong name", saved);
      }
      if (toasts.join("|") !== "Separate tracks downloaded") fail("Separate tracks did not say only that it finished", toasts);
      if (stemsRow.hasAttribute("aria-busy") || stemsRow.getAttribute("aria-disabled") === "true") fail("Separate tracks was left busy");
    }
    pass("a remote host downloads the separate tracks, told once it finished");

    // While the tracks are made the row says so and a second click does nothing.
    let releaseStems;
    stemsGate = new Promise((resolve) => { releaseStems = resolve; });
    const beforeBusy = fetchLog.length;
    clickUi(stemsRow);
    await settle();
    if (stemsRow.querySelector(".save-menu-label").textContent !== "Preparing…") {
      fail("the row did not read Preparing… while the tracks were made", stemsRow.textContent);
    }
    clickUi(stemsRow);
    await app.downloadStems(stemsRow);
    await settle();
    if (stemsFetches(beforeBusy).length !== 1) fail("a second click fetched the stems again", stemsFetches(beforeBusy));
    releaseStems();
    stemsGate = null;
    await settle();
    if (stemsRow.querySelector(".save-menu-label").textContent !== "Separate tracks (WAV)" || stemsRow.getAttribute("aria-disabled") === "true") {
      fail("the row stayed busy after the tracks arrived", stemsRow.textContent);
    }
    pass("a second click while the tracks are made does nothing; the row reads Preparing…");

    // Refusals and failures.
    const BUSY = "Someone is already getting the stems. Try again in a moment.";
    stemsFailure = { ok: false, status: 409, json: () => Promise.resolve({ detail: BUSY }) };
    toasts.length = 0;
    clickUi(stemsRow);
    await settle();
    if (toasts[toasts.length - 1] !== BUSY) fail("a 409 did not show the engine's reason", toasts);
    stemsFailure = { ok: false, status: 500, json: () => Promise.reject(new Error("not JSON")) };
    toasts.length = 0;
    const savesBeforeFail = savedFiles.length;
    clickUi(stemsRow);
    await settle();
    stemsFailure = null;
    if (toasts[toasts.length - 1] !== "Couldn't get the separate tracks. Try again.") fail("a 500 did not toast the error", toasts);
    if (savedFiles.length !== savesBeforeFail) fail("a failed stems request still saved a file");

    // A download the browser couldn't hold: the body read fails with the
    // browser's own words, which must never reach the user.
    stemsFailure = { ...blobResponse(), blob: () => Promise.reject(new dom.window.TypeError("network error")) };
    toasts.length = 0;
    const savesBeforeBlobFail = savedFiles.length;
    const urlsBeforeBlobFail = objectUrls.created;
    clickUi(stemsRow);
    await settle();
    stemsFailure = null;
    if (toasts[toasts.length - 1] !== "Couldn't get the separate tracks. Try again.") fail("a failed body read did not toast the error", toasts);
    if (toasts.some(t => /network error/i.test(t))) fail("the browser's own error text reached the user", toasts);
    if (savedFiles.length !== savesBeforeBlobFail || objectUrls.created !== urlsBeforeBlobFail) {
      fail("a failed body read still saved a file");
    }
    if (stemsRow.getAttribute("aria-disabled") === "true" || stemsRow.hasAttribute("aria-busy") || stemsRow.dataset.downloading) {
      fail("the row stayed busy after a failed body read");
    }
    if (stemsRow.querySelector(".save-menu-label").textContent !== "Separate tracks (WAV)") {
      fail("the row did not get its label back after a failed body read", stemsRow.textContent);
    }
    pass("a busy refusal shows its reason and any other failure says Couldn't get the separate tracks");
    delete app.isEngineLocal;
    app.updateScreeningControls();

    // On the engine's computer the ZIP is already in the export folder.
    {
      const savesBefore = savedFiles.length;
      const cancelledBefore = bodiesCancelled;
      const fetchesBefore = fetchLog.length;
      toasts.length = 0;
      app.exportsDirCache = undefined;
      clickUi(stemsRow);
      await settle();
      if (stemsFetches(fetchesBefore).length !== 1) fail("Separate tracks did not ask the engine for the stems once");
      if (bodiesCancelled !== cancelledBefore + 1) fail("Separate tracks did not cancel the body on the host");
      if (savedFiles.length !== savesBefore) fail("Separate tracks saved a second copy on the host");
      if (stemsRow.querySelector(".save-menu-state").textContent !== "saved · Show in folder" || toasts.length) {
        fail("Separate tracks did not say inline that it was saved", [stemsRow.textContent, toasts]);
      }
    }
    pass("on the engine's own computer, Separate tracks saves no copy and reads saved · Show in folder");

    app.lockScreeningUI(true);
    if (!doc.getElementById("btn-save-menu").disabled || !doc.getElementById("btn-export-video").disabled) {
      fail("locking the theater left Save enabled");
    }
    app.lockScreeningUI(false);
    if (doc.getElementById("btn-save-menu").disabled || doc.getElementById("btn-export-video").disabled) {
      fail("unlocking the theater left Save disabled");
    }
    pass("locking the theater disables Save and its menu");

    console.log("ALL EXPORT & DOWNLOAD FEEDBACK TESTS PASSED!");
    process.exit(0);
  }
} catch (e) {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
}

// An assertion that throws inside runSuite() would otherwise be an unhandled
// rejection, which node reports without failing the suite.
process.on("unhandledRejection", (err) => {
  console.error("ERROR CAUGHT (async):", err);
  process.exit(1);
});
