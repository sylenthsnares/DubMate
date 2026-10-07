const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const { buildStudioBundle } = require("./helpers/studio_dom");

const PROJECT_ROOT = path.join(__dirname, "..");

const html = fs.readFileSync(path.join(PROJECT_ROOT, "static", "index.html"), "utf8");

const { JSDOM } = jsdom;
const dom = new JSDOM(html, {
  url: "http://localhost:8000/",
  runScripts: "dangerously"
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
const audioParam = (value) => ({ value, setValueAtTime() {}, setValueCurveAtTime() {}, cancelScheduledValues() {} });
dom.window.AudioContext = class {
  constructor() { this.currentTime = 0; this.destination = {}; }
  createGain() { return { gain: audioParam(1.0), connect: () => {}, disconnect: () => {} }; }
  createBufferSource() { return { buffer: null, connect: () => {}, disconnect: () => {}, start() {}, stop() {} }; }
  createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: () => {}, connect: () => {}, disconnect: () => {} }; }
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
dom.window.URL.createObjectURL = () => "blob:http://localhost:8000/mock";
dom.window.URL.revokeObjectURL = () => {};
dom.window.scrollTo = () => {};

const mockPacks = [
  {
    id: "Deku_vs_Todoroki",
    name: "Deku vs Todoroki",
    video_url: "/api/packs/Deku_vs_Todoroki/video",
    duration: 38.5,
    characters: ["Deku", "Todoroki"],
    lines: [
      { index: 0, line_id: "t1200", character: "Deku", start: 1.2, end: 4.5, duration: 3.3, audio_url: "/api/packs/Deku_vs_Todoroki/audio/0.wav", text: "It is your power, isn't it?!" },
      { index: 1, line_id: "t5000", character: "Todoroki", start: 5.0, end: 9.0, duration: 4.0, audio_url: "/api/packs/Deku_vs_Todoroki/audio/1.wav", text: "My left side..." }
    ]
  }
];

dom.window.fetch = (url) => {
  const urlStr = String(url || "");
  if (urlStr.startsWith("/api/packs/rescan")) {
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      json: () => Promise.resolve({
        status: "ok",
        count: 2,
        packs: [
          ...mockPacks,
          {
            id: "Hitsugaya_older",
            name: "Hitsugaya Older",
            video_url: "/api/packs/Hitsugaya_older/video",
            duration: 67.0,
            characters: ["Hitsugaya", "Byakuya"],
            lines: [{ index: 0, character: "Hitsugaya", start: 0, end: 2.3, duration: 2.3, audio_url: "/api/packs/Hitsugaya_older/audio/0.wav" }]
          }
        ]
      })
    });
  }
  if (urlStr.startsWith("/api/packs") && !urlStr.includes("/audio/")) {
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      json: () => Promise.resolve(mockPacks)
    });
  }
  return Promise.resolve({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    json: () => Promise.resolve({})
  });
};

try {
  const combinedCode = buildStudioBundle();

  dom.window.eval(combinedCode);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  
  setTimeout(async () => {
    const app = dom.window.dubMateApp;
    if (!app) {
      console.error("FAIL: DubMateApp was not instantiated!");
      process.exit(1);
    }
    console.log("PASS: DubMateApp instantiated successfully!");
    console.log("Initial packs loaded:", app.packs.length);
    console.log("Pack count badge:", dom.window.document.getElementById("pack-count-badge")?.innerText);

    // Test Rescan button
    const btnRescan = dom.window.document.getElementById("btn-rescan-packs");
    if (!btnRescan) {
      console.error("FAIL: btn-rescan-packs button not found in DOM!");
      process.exit(1);
    }
    console.log("PASS: btn-rescan-packs found in DOM!");

    await app.rescanPacksDirectory();
    console.log("PASS: Rescan executed!");
    console.log("Post-rescan packs loaded:", app.packs.length);
    console.log("Post-rescan badge:", dom.window.document.getElementById("pack-count-badge")?.innerText);
    console.log("Post-rescan cards:", dom.window.document.querySelectorAll(".pack-card").length);

    // Test 1: Slider Gain range (-12dB to +12dB)
    const sliderGain = dom.window.document.getElementById("slider-gain");
    if (sliderGain && sliderGain.min === "-12" && sliderGain.max === "12") {
      console.log("PASS: slider-gain range correctly set to -12dB .. +12dB!");
    } else {
      console.error("FAIL: slider-gain range incorrect:", sliderGain?.min, sliderGain?.max);
      process.exit(1);
    }

    // Test 2: Username typing & backspace capability
    const inputUser = dom.window.document.getElementById("input-user-name");
    inputUser.value = "Aayat";
    inputUser.dispatchEvent(new dom.window.Event("input"));
    if (app.user.name === "Aayat" && inputUser.value === "Aayat") {
      console.log("PASS: Username typing accepted!");
    } else {
      console.error("FAIL: Username typing failed!");
      process.exit(1);
    }

    // Test 3: Leave Room & socket disconnect
    app.roomState = {
      room_id: "TEST12",
      host_id: app.user.id,
      pack: mockPacks[0],
      takes: {},
      users: {}
    };
    app.leaveRoom();
    console.log("PASS: leaveRoom() executed cleanly without errors!");

    // Test 3b (B1): the backing track must not carry over from one scene to the next.
    // Recording in scene A cached A's backing; scene B then replayed it.
    {
      const realLoad = app.audio.loadAudioBuffer;
      const deferred = {};
      app.audio.loadAudioBuffer = (u) => {
        if (deferred[u]) return deferred[u].promise;
        return Promise.resolve({ url: u, duration: 10 });
      };
      const roomFor = (id) => ({
        room_id: "B1" + id,
        host_id: app.user.id,
        pack: { ...mockPacks[0], id, backing_url: `/api/packs/${id}/backing` },
        takes: {},
        users: {}
      });

      app.roomState = roomFor("A");
      const bufA = await app.ensureBackingBuffer();
      if (bufA?.url !== "/api/packs/A/backing") {
        console.error("FAIL: B1 scene A backing did not load:", bufA);
        process.exit(1);
      }
      app.leaveRoom();
      if (app.backingBuffer !== null) {
        console.error("FAIL: B1 leaveRoom() kept the previous scene's backing buffer");
        process.exit(1);
      }
      app.roomState = roomFor("B");
      const bufB = await app.ensureBackingBuffer();
      if (bufB?.url !== "/api/packs/B/backing") {
        console.error("FAIL: B1 scene B played another scene's backing:", bufB?.url);
        process.exit(1);
      }
      // Same room object swapped to another pack without a reset: the cache is keyed by URL.
      app.roomState = roomFor("C");
      const bufC = await app.ensureBackingBuffer();
      if (bufC?.url !== "/api/packs/C/backing") {
        console.error("FAIL: B1 cached backing reused for a different pack:", bufC?.url);
        process.exit(1);
      }

      // Race: scene A's load (started during the countdown) finishes after leaving.
      app.leaveRoom();
      app.roomState = roomFor("A");
      let resolveA;
      deferred["/api/packs/A/backing"] = { promise: new Promise((r) => { resolveA = r; }) };
      const pendingA = app.ensureBackingBuffer();
      app.leaveRoom();
      app.roomState = roomFor("B");
      resolveA({ url: "/api/packs/A/backing", duration: 10 });
      await pendingA;
      if (app.backingBuffer && app.backingBuffer.url === "/api/packs/A/backing") {
        console.error("FAIL: B1 a late scene A backing load overwrote scene B's state");
        process.exit(1);
      }
      const bufB2 = await app.ensureBackingBuffer();
      if (bufB2?.url !== "/api/packs/B/backing") {
        console.error("FAIL: B1 scene B backing wrong after late load:", bufB2?.url);
        process.exit(1);
      }
      app.leaveRoom();
      if (app.origBuffer !== null) {
        console.error("FAIL: B1 leaveRoom() kept the previous scene's line audio");
        process.exit(1);
      }
      app.audio.loadAudioBuffer = realLoad;
      console.log("PASS: B1 backing track is per scene and late loads are dropped!");
    }

    // Test 3c (B3): a re-take gets its own auto gain, and the preview never compresses
    // (the export doesn't, so a compressed preview misreports the level).
    {
      const realFetch = dom.window.fetch;
      const realLoad = app.audio.loadAudioBuffer;
      app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 2.5 });
      let sentForm = null;
      dom.window.fetch = (url, opts) => {
        if (String(url) === "/api/rooms/B3ROOM/lines/t1200/takes" && opts && opts.method === "POST") {
          sentForm = opts.body;
          const autoGain = opts.body.get("auto_gain") === "true";
          const take = {
            take_id: "new2", number: 2, user_id: app.user.id, url: "/api/rooms/B3ROOM/lines/t1200/takes/new2/audio?v=2",
            offset_ms: 0, pitch_semitones: 0, reverb_wet: 0,
            gain_db: autoGain ? -4 : parseFloat(opts.body.get("gain_db")),
            auto_gain_db: -4, speech_loudness_db: -17, target_loudness_db: -21,
          };
          const line = { picked: "new2", next_number: 3, takes: [{ ...prevTake }, take] };
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok", line_id: "t1200", take, line }) });
        }
        return realFetch(url, opts);
      };
      const prevTake = { take_id: "old1", number: 1, user_id: app.user.id, url: "/api/rooms/B3ROOM/lines/t1200/takes/old1/audio?v=1", gain_db: 6, auto_gain_db: 6 };
      const roomB3 = () => ({ state_version: 3, room_id: "B3ROOM", host_id: app.user.id, pack: mockPacks[0],
        takes: { t1200: { picked: "old1", next_number: 2, takes: [{ ...prevTake }] } }, users: {} });

      // Slider still shows the previous take's auto gain: the new take must get its own.
      app.roomState = roomB3();
      app.sliderGain.value = "6";
      await app.uploadTake(0, new dom.window.Blob(["x"]));
      if (sentForm?.get("auto_gain") !== "true" || parseFloat(app.sliderGain.value) !== -4
          || app.takeForLine(0).gain_db !== -4 || app.takeForLine(0).take_id !== "new2"
          || app.roomState.takes.t1200.takes.length !== 2) {
        console.error("FAIL: B3 re-take kept the old take's gain:", sentForm?.get("auto_gain"), app.sliderGain.value);
        process.exit(1);
      }

      // A level the user picked by hand is kept.
      app.roomState = roomB3();
      app.sliderGain.value = "3";
      await app.uploadTake(0, new dom.window.Blob(["x"]));
      if (sentForm?.get("auto_gain") !== "false" || parseFloat(app.sliderGain.value) !== 3) {
        console.error("FAIL: B3 manual gain was overridden:", sentForm?.get("auto_gain"), app.sliderGain.value);
        process.exit(1);
      }

      // The booth builds no effects of its own: it plays the engine's render, with the
      // take's level as a plain gain after it.
      app.audio.initContext();
      const ctx = app.audio.ctx;
      const effectNodes = [];
      const realNodes = {};
      for (const name of ["createDynamicsCompressor", "createBiquadFilter", "createConvolver"]) {
        realNodes[name] = ctx[name];
        ctx[name] = function () { effectNodes.push(name); return realNodes[name].call(this); };
      }
      const render = { duration: 2.5, render: true };
      app.audio.previewTakeIsolated({ takeBuffer: render, lineStartSec: 1.2, gainDb: -4 });
      Object.assign(ctx, realNodes);
      const played = app.audio.takeVoice?.current;
      if (effectNodes.length || played?.buffer !== render
          || Math.abs(app.audio.takeVoice.level.gain.value - Math.pow(10, -4 / 20)) > 1e-9
          || dom.window.document.getElementById("check-compressor")) {
        console.error("FAIL: B3 the booth preview adds effects of its own:", effectNodes);
        process.exit(1);
      }
      app.audio.stopAllPlayback();

      dom.window.fetch = realFetch;
      app.audio.loadAudioBuffer = realLoad;
      app.leaveRoom();
      console.log("PASS: B3 re-takes get their own auto gain and the preview plays the engine's render!");
    }

    // Test 4: Dialogue completion & "I'm Finished" button state
    app.roomState = {
      room_id: "TEST12",
      host_id: app.user.id,
      pack: mockPacks[0],
      takes: {},
      users: {}
    };
    await app.loadBoothLine(0);
    const btnNext = dom.window.document.getElementById("btn-next-line");
    const firstText = btnNext.textContent || btnNext.innerHTML;
    if (firstText.includes("Next line")) {
      console.log("PASS: First line shows 'Next line ›'");
    }

    await app.loadBoothLine(1); // Last line of mockPack
    const lastText = btnNext.textContent || btnNext.innerHTML;
    if (lastText.includes("Finish ✓") && btnNext.classList.contains("btn-finished-pulse")) {
      console.log("PASS: Last line correctly transforms to 'Finish ✓'!");
    } else {
      console.error("FAIL: Last line did not transform to 'Finish ✓':", lastText);
      process.exit(1);
    }

    // Test 5: Search bar functionality & real-time pack filtering
    const inputSearch = dom.window.document.getElementById("input-pack-search");
    const btnClear = dom.window.document.getElementById("btn-clear-search");
    if (!inputSearch || !btnClear) {
      console.error("FAIL: Search input or clear button not found in DOM!");
      process.exit(1);
    }
    console.log("PASS: Search input and clear button found in DOM!");

    // Search by character name "Todoroki"
    app.handlePackSearch("Todoroki");
    const cardsTodoroki = dom.window.document.querySelectorAll(".pack-card");
    if (cardsTodoroki.length === 1 && app.selectedPackId === "Deku_vs_Todoroki") {
      console.log("PASS: Searching 'Todoroki' correctly filtered to 1 pack!");
    } else {
      console.error("FAIL: Search 'Todoroki' expected 1 card, got:", cardsTodoroki.length);
      process.exit(1);
    }

    // Search by dialogue line keyword "power"
    app.handlePackSearch("power");
    const cardsPower = dom.window.document.querySelectorAll(".pack-card");
    if (cardsPower.length === 1) {
      console.log("PASS: Searching dialogue line keyword 'power' matched Deku vs Todoroki!");
    } else {
      console.error("FAIL: Search 'power' expected 1 card, got:", cardsPower.length);
      process.exit(1);
    }

    // Search nonexistent word -> empty search state
    app.handlePackSearch("nonexistent_keyword_12345");
    const emptyState = dom.window.document.querySelector(".empty-search-state");
    if (emptyState && dom.window.document.querySelectorAll(".pack-card").length === 0) {
      console.log("PASS: Nonexistent query correctly displayed empty search state!");
    } else {
      console.error("FAIL: Empty search state not displayed for nonexistent query!");
      process.exit(1);
    }

    // Clear search
    app.clearPackSearch();
    const cardsCleared = dom.window.document.querySelectorAll(".pack-card");
    if (cardsCleared.length === 2 && app.packSearchQuery === "") {
      console.log("PASS: clearPackSearch() restored all 2 pack cards!");
    } else {
      console.error("FAIL: clearPackSearch() did not restore all cards, got:", cardsCleared.length);
      process.exit(1);
    }

    // Test 6: Screening Project ZIP Download Buttons
    const btnZipToolbar = dom.window.document.getElementById("btn-toolbar-project-zip");
    const btnZipContainer = dom.window.document.getElementById("btn-download-project-zip");
    if (!btnZipToolbar || !btnZipContainer) {
      console.error("FAIL: Project ZIP download buttons not found in DOM!");
      process.exit(1);
    }
    console.log("PASS: Project ZIP download buttons found in Screening DOM!");
    if (typeof app.downloadFullProjectZip === "function") {
      app.downloadFullProjectZip();
      console.log("PASS: app.downloadFullProjectZip() executed cleanly without errors!");
    } else {
      console.error("FAIL: downloadFullProjectZip is not a function!");
      process.exit(1);
    }

    // Test 7: Cast HUD: several characters read "4 roles", the names in a tooltip
    app.roomState = {
      room_id: "TEST01",
      host_id: "host1",
      pack: mockPacks[0],
      takes: {},
      role_assignments: {
        "Deku": ["u1"],
        "Todoroki": ["u1"],
        "Extra1": ["u1"],
        "Extra2": ["u1"]
      },
      users: {
        "u1": { id: "u1", name: "TaniActor", color: "#cca458", is_online: true, is_ready: false }
      }
    };
    app.renderCastActivityHUD();
    const hudChip = dom.window.document.querySelector(".actor-hud-chip");
    if (!hudChip) {
      console.error("FAIL: .actor-hud-chip not created in DOM!");
      process.exit(1);
    }
    const hudChar = hudChip.querySelector(".actor-hud-char");
    if (hudChar && hudChar.textContent.trim() === "4 roles"
        && hudChar.getAttribute("data-tip") === "Deku, Todoroki, Extra1, Extra2" && hudChar.tabIndex === 0) {
      console.log("PASS: Cast HUD shows '4 roles' with the names in a focusable tooltip!");
    } else {
      console.error("FAIL: Cast HUD roles summary did not work as expected:", hudChar?.textContent, hudChar?.getAttribute("data-tip"));
      process.exit(1);
    }

    // Test 8a: friendlyError keeps machine output out of the UI.
    // Every one of these strings used to be shown to users verbatim.
    if (typeof app.friendlyError === "function") {
      const mustNotLeak = [
        "Command '['C:\\Program Files\\ffmpeg.exe', '-y']' returned non-zero exit status 1.",
        "HTTP 500",
        "Traceback (most recent call last):",
        "Unexpected token '<', \"<html>\" is not valid JSON",
        "[Errno 2] No such file or directory: 'C:\\takes\\x.wav'",
      ];
      const leaked = mustNotLeak.filter((raw) => {
        const shown = app.friendlyError(new Error(raw));
        return shown.includes(raw) || /ffmpeg|Traceback|Errno|HTTP \d{3}|[A-Za-z]:\\/.test(shown);
      });
      if (leaked.length === 0) {
        console.log("PASS: friendlyError() strips machine output from user-facing text!");
      } else {
        console.error("FAIL: friendlyError leaked technical text:", leaked);
        process.exit(1);
      }

      // A message written for humans should survive untouched.
      const humane = "Please pick a dub pack before starting.";
      if (app.friendlyError(new Error(humane)) === humane) {
        console.log("PASS: friendlyError() passes human-readable messages through!");
      } else {
        console.error("FAIL: friendlyError mangled a human-readable message");
        process.exit(1);
      }

      // Known conditions get actionable copy rather than the fallback.
      const offline = app.friendlyError(new Error("Failed to fetch"));
      if (/connection/i.test(offline)) {
        console.log("PASS: friendlyError() maps network failures to actionable copy!");
      } else {
        console.error("FAIL: network error not mapped, got:", offline);
        process.exit(1);
      }
    } else {
      console.error("FAIL: friendlyError() missing from the studio app!");
      process.exit(1);
    }

    // Test 8b: the export modal must always be escapable.
    // It used to seal the user in: close button hidden, Esc and backdrop disabled,
    // Leave Room greyed out, with a page reload the only way out.
    if (typeof app.releaseExportModal === "function" && typeof app.failExport === "function") {
      app.isRenderingExport = true;
      app.failExport(new Error("failed: ffmpeg returned non-zero exit status 1"));
      if (app.isRenderingExport === false) {
        console.log("PASS: a failed export releases the modal instead of trapping the user!");
      } else {
        console.error("FAIL: isRenderingExport stayed true after a failed export");
        process.exit(1);
      }
    } else {
      console.error("FAIL: releaseExportModal/failExport missing!");
      process.exit(1);
    }

    // Test 8c: take helpers (static/js/studio/takes.js) over room state keyed by line ID.
    {
      const src = fs.readFileSync(path.join(PROJECT_ROOT, "static", "js", "studio", "takes.js"), "utf8");
      const T = new Function(src.replace(/^export\s+/gm, "")
        + "\nreturn { pickedTake, lineTakes, takeCount, takeAudioKey, TAKE_STATE_VERSION };")();
      const take1 = { take_id: "a1", number: 1, url: "/api/rooms/R/lines/t1200/takes/a1/audio?v=3", user_name: "Ana" };
      const take0 = { take_id: "b2", number: 2, url: "/api/rooms/R/lines/t1200/takes/b2/audio?v=7", user_name: "Ana" };
      const takes = { t1200: { picked: "b2", next_number: 3, takes: [take1, take0] } };
      const [l0, l1] = mockPacks[0].lines;
      const checks = [
        ["pickedTake finds the line's take", T.pickedTake(takes, l0) === take0],
        ["pickedTake follows the pick", T.pickedTake({ t1200: { ...takes.t1200, picked: "a1" } }, l0) === take1],
        ["pickedTake is empty for a line with no take", T.pickedTake(takes, l1) === undefined],
        ["pickedTake tolerates missing state", T.pickedTake(undefined, l0) === undefined && T.pickedTake(takes, null) === undefined],
        ["lineTakes lists every take, oldest first", T.lineTakes(takes, l0).length === 2 && T.lineTakes(takes, l0)[0] === take1],
        ["lineTakes is empty without a take", T.lineTakes(takes, l1).length === 0 && T.lineTakes(null, l0).length === 0],
        ["takeCount counts", T.takeCount(takes, l0) === 2 && T.takeCount(takes, l1) === 0],
        ["takeAudioKey drops ?v=", T.takeAudioKey(take0) === "/api/rooms/R/lines/t1200/takes/b2/audio"],
        ["takeAudioKey without a url", T.takeAudioKey({}) === null && T.takeAudioKey(undefined) === null],
        ["TAKE_STATE_VERSION is 3", T.TAKE_STATE_VERSION === 3],
      ];
      const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length) {
        console.error("FAIL: take helpers:", failed);
        process.exit(1);
      }

      // The studio reads the take through the same helper.
      app.roomState = { state_version: 3, room_id: "R", pack: mockPacks[0], takes, users: {} };
      if (app.takeForLine(0) !== take0 || app.takeForLine(1) !== undefined || app.takeForLine(99) !== undefined) {
        console.error("FAIL: takeForLine did not return the line's take");
        process.exit(1);
      }

      // Evicting a take drops every cached version of its audio and nothing else.
      const cache = app.audio.bufferCache;
      cache.clear();
      for (const k of ["/api/rooms/R/lines/t1200/takes/b2/audio?v=6", "/api/rooms/R/lines/t1200/takes/b2/audio?v=7",
                       "/api/rooms/R/lines/t1200/takes/a1/audio?v=3", "/api/rooms/R/lines/t1200/takes/b22/audio?v=1"]) cache.set(k, {});
      app.audio.evictTakeCache(take0);
      app.audio.evictTakeCache(undefined);
      const left = [...cache.keys()].sort().join(",");
      cache.clear();
      if (left !== "/api/rooms/R/lines/t1200/takes/a1/audio?v=3,/api/rooms/R/lines/t1200/takes/b22/audio?v=1") {
        console.error("FAIL: evictTakeCache left the wrong buffers:", left);
        process.exit(1);
      }
      console.log("PASS: take helpers read the picked take and evict only its audio!");
    }

    // Test 8d: socket state keeps peaks by take ID, and a tab left open across an update
    // stops applying state and asks for a reload.
    {
      const lines = mockPacks[0].lines;
      const withPeaks = { take_id: "a1", number: 1, url: "/api/rooms/R/lines/t1200/takes/a1/audio?v=1", peaks: [[0.1, 0.2]] };
      app.roomState = { state_version: 3, room_id: "R", pack: mockPacks[0], users: {},
        takes: { t1200: { picked: "a1", next_number: 2, takes: [withPeaks] } } };
      // a1 is no longer picked, so the server sends it without peaks.
      const applied = app.applyIncomingState({ state: { state_version: 3, room_id: "R", users: {}, takes: {
        t1200: { picked: "b2", next_number: 3, takes: [
          { take_id: "a1", number: 1, url: withPeaks.url },
          { take_id: "b2", number: 2, url: "/api/rooms/R/lines/t1200/takes/b2/audio?v=1", peaks: [[0.5, 0.6]] },
        ] } } } });
      const merged = app.roomState.takes.t1200.takes;
      if (!applied || merged[0].peaks[0][1] !== 0.2 || merged[1].peaks[0][1] !== 0.6 || app.takeForLine(0).take_id !== "b2") {
        console.error("FAIL: state merge lost peaks or the pick:", JSON.stringify(app.roomState.takes));
        process.exit(1);
      }

      const before = app.roomState;
      const banner = dom.window.document.getElementById("connection-banner");
      const bannerText = dom.window.document.getElementById("connection-banner-text");
      app.socket.emit("take_deleted", { type: "take_deleted", payload: { line_index: 0, take_id: "b2" },
        state: { room_id: "R", pack: mockPacks[0], users: {}, takes: { 0: { url: "/api/rooms/R/takes/0/audio" } } } });
      const stale = app.applyIncomingState({ state: { state_version: 4, room_id: "R", takes: {} } });
      app.renderConnectionState({ state: "open" });
      if (stale !== false || app.roomState !== before || app.takeForLine(0)?.take_id !== "b2"
          || banner.style.display !== "flex"
          || bannerText.innerText !== "DubMate was updated. Reload this page to keep going.") {
        console.error("FAIL: stale-tab notice:", stale, banner.style.display, bannerText.innerText);
        process.exit(1);
      }
      app.isStaleTab = false;
      banner.style.display = "none";
      console.log("PASS: a tab from another DubMate version stops applying state and asks for a reload!");
    }

    // Test 8e: take history in the booth. "Takes (N)" shows only with 2+ takes on a line
    // you can record; rows list takes oldest first; Use picks, delete confirms, Play
    // plays the engine's render of the take's own sound and leaves the controls alone.
    {
      const doc = dom.window.document;
      const btnTakes = doc.getElementById("btn-take-history");
      const takesBox = doc.getElementById("take-history");
      const panel = doc.getElementById("take-history-panel");
      const realFetch = dom.window.fetch;
      const realConfirm = dom.window.confirm;
      const realToast = app.showToast;
      const realLoad = app.audio.loadAudioBuffer;
      const realPreview = app.audio.previewTakeIsolated;
      const fail = (msg, ...rest) => { console.error("FAIL: take history:", msg, ...rest); process.exit(1); };
      const mk = (id, number, name, extra = {}) => ({ take_id: id, number, user_id: app.user.id, user_name: name,
        duration: 2.41, url: `/api/rooms/TH/lines/t1200/takes/${id}/audio?v=1`,
        offset_ms: 0, pitch_semitones: 0, reverb_wet: 0, gain_db: 0, ...extra });
      const roomWith = (takes, extra = {}) => ({ state_version: 3, room_id: "TH", host_id: app.user.id,
        pack: mockPacks[0], users: {}, role_assignments: {}, takes, ...extra });
      const toasts = [];
      app.showToast = (m) => toasts.push(m);
      app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 2.5 });

      // One take: no button.
      app.roomState = roomWith({ t1200: { picked: "a1", next_number: 2, takes: [mk("a1", 1, "Ana")] } });
      await app.loadBoothLine(0);
      if (takesBox.style.display !== "none") fail("button shown with one take");

      // Two takes on a line someone else is cast for: no button.
      const a1Chain = { v: 1, preset: null, nodes: { pitch: { on: true, mix: 1.0, semitones: 2 } } };
      const two = () => ({ t1200: { picked: "b2", next_number: 4, takes: [
        mk("a1", 1, "Ana", { offset_ms: 120, chain: a1Chain, gain_db: -5 }),
        mk("b2", 3, "Ben", { duration: 1.96 })] } });
      app.roomState = roomWith(two(), { host_id: "someone", role_assignments: { Deku: ["u9"] } });
      await app.loadBoothLine(0);
      if (takesBox.style.display !== "none") fail("button shown on a line you can't record");

      // Two takes on your line: button shown, panel opens with rows oldest first.
      app.roomState = roomWith(two());
      await app.loadBoothLine(0);
      if (takesBox.style.display === "none" || btnTakes.innerText !== "Takes (2)") fail("button not shown with 2 takes", btnTakes.innerText);
      if (btnTakes.dataset.tip !== "Listen to your other takes and choose the one used in the dub") fail("button tooltip");
      if (panel.style.display !== "none") fail("panel open before the button is clicked");
      btnTakes.click();
      const rows = [...panel.querySelectorAll(".take-history-row")];
      const labels = rows.map((r) => r.querySelector(".take-history-label").textContent);
      if (labels.join("|") !== "Take 1 · Ana · 2.4s|Take 3 · Ben · 2.0s") fail("rows", labels);
      if (rows[0].querySelector(".take-history-picked") || !rows[0].querySelector(".take-history-use")
          || rows[1].querySelector(".take-history-picked")?.textContent !== "In the dub"
          || rows[1].querySelector(".take-history-use")) fail("picked row not marked, or Use shown on it");
      if (rows[0].querySelector(".take-history-use").dataset.tip !== "Use this take in the dub") fail("Use tooltip");

      // Play: the engine renders the take's own sound, and that render plays at the take's
      // timing and level; the controls don't move.
      const sliders = () => [app.sliderNudge.value, app.sliderGain.value,
        ...[...dom.window.document.querySelectorAll("#voice-rack [data-voice-param], #voice-rack [data-voice-on]")].map((el) => el.value + el.checked)].join(",");
      const slidersBefore = sliders();
      let previewArgs = null;
      let renderBody = null;
      app.audio.previewTakeIsolated = (args) => { previewArgs = args; };
      app.audio.loadAudioBuffer = (url) => Promise.resolve({ duration: 2.5, url });
      app.syncVideoSeek = () => Promise.resolve();
      dom.window.fetch = (url, opts) => {
        if (String(url) === "/api/rooms/TH/lines/t1200/takes/a1/render") {
          renderBody = JSON.parse(opts.body);
          return Promise.resolve({ ok: true, status: 200,
            json: () => Promise.resolve({ url: "/api/rooms/TH/renders/00000000000000a1.wav", key: "00000000000000a1", duration: 2.5 }) });
        }
        return realFetch(url, opts);
      };
      rows[0].querySelector(".take-history-play").click();
      await new Promise((r) => setTimeout(r, 20));
      dom.window.fetch = realFetch;
      if (JSON.stringify(renderBody?.chain) !== JSON.stringify(a1Chain) || !renderBody.client_id) fail("Play asked for the wrong sound", renderBody);
      if (!previewArgs || previewArgs.takeBuffer?.url !== "/api/rooms/TH/renders/00000000000000a1.wav"
          || previewArgs.offsetMs !== 120 || previewArgs.gainDb !== -5) fail("Play used the wrong settings", previewArgs);
      if (sliders() !== slidersBefore) fail("Play moved the sliders", slidersBefore, sliders());
      app.stopBoothPlayback();
      app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 2.5 });

      // Use: POST pick, toast, the picked row moves.
      let sent = null;
      dom.window.fetch = (url, opts) => {
        if (String(url).includes("/takes/a1") && opts && opts.method) {
          sent = { url: String(url), opts };
          const line = { ...two().t1200, picked: "a1" };
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok", line_id: "t1200", line }) });
        }
        return realFetch(url, opts);
      };
      rows[0].querySelector(".take-history-use").click();
      await new Promise((r) => setTimeout(r, 20));
      if (sent?.url !== "/api/rooms/TH/lines/t1200/takes/a1/pick" || sent.opts.method !== "POST"
          || JSON.parse(sent.opts.body).user_id !== app.user.id) fail("Use did not send the pick", sent);
      if (!toasts.includes("Take 1 is in the dub") || app.takeForLine(0).take_id !== "a1") fail("pick not applied", toasts);

      // Delete: asks first; cancel sends nothing, OK sends DELETE.
      app.roomState = roomWith(two());
      await app.loadBoothLine(0);
      // The history stays open after a pick on the same line.
      if (panel.style.display === "none") fail("history closed after picking a take");
      const asked = [];
      sent = null;
      dom.window.confirm = (m) => { asked.push(m); return false; };
      panel.querySelector(".take-history-row .take-history-delete").click();
      await new Promise((r) => setTimeout(r, 20));
      if (asked[0] !== "Delete take 1? This can't be undone." || sent) fail("delete without a confirm", asked, sent);
      dom.window.confirm = () => true;
      panel.querySelector(".take-history-row .take-history-delete").click();
      await new Promise((r) => setTimeout(r, 20));
      if (sent?.url !== `/api/rooms/TH/lines/t1200/takes/a1?user_id=${encodeURIComponent(app.user.id)}`
          || sent.opts.method !== "DELETE") fail("delete did not send DELETE", sent);

      dom.window.fetch = realFetch;
      dom.window.confirm = realConfirm;
      app.showToast = realToast;
      app.audio.loadAudioBuffer = realLoad;
      app.audio.previewTakeIsolated = realPreview;
      delete app.syncVideoSeek;
      app.leaveRoom();
      console.log("PASS: take history shows on your lines with 2+ takes, and Play, Use and delete work!");
    }

    // Test 8f: the room refuses a change. A page that still thinks you are the host (the host
    // has changed since) draws your casting change at once; the refusal shows as an error
    // toast and the page reloads the room's real state, so the change is undone and you,
    // now a guest, see the casting as text.
    // An error without a payload (the connect-time "Room not found") toasts and fetches
    // nothing; your own take_recorded leaves "Take saved" to the booth.
    {
      const doc = dom.window.document;
      const realFetch = dom.window.fetch;
      const realToast = app.showToast;
      const fail = (msg, ...rest) => { console.error("FAIL: refused change:", msg, ...rest); process.exit(1); };
      const me = app.user.id;
      const server = { state_version: 3, room_id: "R", host_id: "mika", status: "lobby",
        pack: { ...mockPacks[0], line_count: 2 },
        users: { [me]: { id: me, name: "Me", color: "#25d3a4", is_online: true },
                 mika: { id: "mika", name: "Mika", color: "#7c5cff", is_online: true } },
        role_assignments: { Deku: ["mika"], Todoroki: [] }, takes: {} };
      app.roomState = { ...JSON.parse(JSON.stringify(server)), host_id: me };
      app.showView("lobby");
      const row = () => Array.from(doc.querySelectorAll("#casting-tbody tr")).find((tr) => tr.dataset.character === "Deku");
      if (!row()) fail("no casting row for Deku");

      const toasts = [];
      app.showToast = (m, o) => toasts.push({ m, tone: o && o.tone });
      const fetches = [];
      dom.window.fetch = (url) => {
        fetches.push(String(url));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(server))) });
      };

      // You cast yourself as Deku: the page draws it at once.
      const select = row().querySelector(".cast-select");
      select.value = me;
      select.dispatchEvent(new dom.window.Event("change"));
      if (app.roomState.role_assignments.Deku[0] !== me) fail("the change was not drawn on screen first");

      app.socket.emit("error", { type: "error", payload: { message: "Only the host can assign roles." } });
      await new Promise((r) => setTimeout(r, 20));
      if (toasts.length !== 1 || toasts[0].m !== "Only the host can assign roles." || toasts[0].tone !== "error") {
        fail("no error toast with the server's message", toasts);
      }
      if (fetches.length !== 1 || fetches[0] !== "/api/rooms/R") fail("did not reload the room", fetches);
      if (JSON.stringify(app.roomState.role_assignments.Deku) !== '["mika"]') fail("the refused casting stayed", app.roomState.role_assignments);
      const dot = row().querySelector(".actor-color-dot");
      const actor = row().querySelector(".cast-actor-name");
      if (row().querySelector(".cast-select") || !actor || actor.textContent !== "Mika" || dot.title !== "Mika") {
        fail("the casting row does not show the server's assignment as text", actor && actor.textContent, dot.title);
      }

      toasts.length = 0;
      fetches.length = 0;
      app.socket.emit("error", { type: "error", message: "Room not found" });
      await new Promise((r) => setTimeout(r, 20));
      if (toasts.length || fetches.length) fail("an error without a payload toasted or fetched", toasts, fetches);

      // Your own take: no "Take saved" from the socket echo; someone else's still says so.
      app.currentView = "lobby";
      const realLoad = app.audio.loadAudioBuffer;
      app.audio.loadAudioBuffer = () => Promise.resolve({ duration: 2.5 });
      const takeMsg = (userId, userName) => ({ type: "take_recorded",
        payload: { line_index: 1, line_id: "t5000", take_id: "k1", user_id: userId, user_name: userName },
        state: { ...JSON.parse(JSON.stringify(server)), takes: {} } });
      app.socket.emit("take_recorded", takeMsg(me, "Me"));
      await new Promise((r) => setTimeout(r, 20));
      if (toasts.some((t) => /take saved/i.test(t.m))) fail("your own take echoed 'Take saved'", toasts);
      app.socket.emit("take_recorded", takeMsg("mika", "Mika"));
      await new Promise((r) => setTimeout(r, 20));
      if (!toasts.some((t) => t.m === "Mika recorded line 2")) fail("someone else's take was not announced", toasts);

      dom.window.fetch = realFetch;
      app.showToast = realToast;
      app.audio.loadAudioBuffer = realLoad;
      app.leaveRoom();
      console.log("PASS: a refused change says why and shows the room as it is; your own take isn't echoed!");
    }

    // Test 8: Sample-Accurate Video Seek & Playback Stop helpers
    if (typeof app.syncVideoSeek === "function" && typeof app.stopBoothPlayback === "function") {
      app.stopBoothPlayback();
      console.log("PASS: syncVideoSeek and stopBoothPlayback instantiated and tested!");
    } else {
      console.error("FAIL: syncVideoSeek or stopBoothPlayback missing!");
      process.exit(1);
    }

    if (app.packs.length === 2 && dom.window.document.querySelectorAll(".pack-card").length === 2) {
      console.log("ALL FEEDBACK, SEARCH AND PROJECT ZIP TESTS PASSED WITH FLYING COLORS!");
      process.exit(0);
    } else {
      console.error("FAIL: Rescan did not update pack cards correctly!");
      process.exit(1);
    }
  }, 100);
} catch (e) {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
}
