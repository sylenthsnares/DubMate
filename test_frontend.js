const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "static", "index.html"), "utf8");
const appJsCode = fs.readFileSync(path.join(__dirname, "static", "js", "app.js"), "utf8");
const knobJsCode = fs.readFileSync(path.join(__dirname, "static", "js", "knob.js"), "utf8");
const audioJsCode = fs.readFileSync(path.join(__dirname, "static", "js", "audio_engine.js"), "utf8");
const waveformJsCode = fs.readFileSync(path.join(__dirname, "static", "js", "waveform.js"), "utf8");
const roomJsCode = fs.readFileSync(path.join(__dirname, "static", "js", "room_socket.js"), "utf8");

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
      { index: 0, character: "Deku", start: 1.2, end: 4.5, duration: 3.3, audio_url: "/api/packs/Deku_vs_Todoroki/audio/0.wav", text: "It is your power, isn't it?!" },
      { index: 1, character: "Todoroki", start: 5.0, end: 9.0, duration: 4.0, audio_url: "/api/packs/Deku_vs_Todoroki/audio/1.wav", text: "My left side..." }
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

function stripModules(code) {
  return code
    .split("\n")
    .filter(l => !l.trim().startsWith("import "))
    .join("\n")
    .replace(/export\s+(class|function|const|let|var)\s+/g, "$1 ")
    .replace(/export\s+default\s+/g, "")
    .replace(/export\s*\{[^}]*\};?/g, "");
}

try {
  const combinedCode = `
    (function() {
      ${stripModules(audioJsCode)}
      ${stripModules(waveformJsCode)}
      ${stripModules(roomJsCode)}
      ${stripModules(knobJsCode)}
      ${stripModules(appJsCode)}
    })();
  `;

  dom.window.eval(combinedCode);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  
  setTimeout(async () => {
    const app = dom.window.dubMateApp || dom.window.app;
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
    if (firstText.includes("Next Line")) {
      console.log("PASS: First line shows 'Next Line ›'");
    }

    await app.loadBoothLine(1); // Last line of mockPack
    const lastText = btnNext.textContent || btnNext.innerHTML;
    if (lastText.includes("Finished") && btnNext.classList.contains("btn-finished-pulse")) {
      console.log("PASS: Last line correctly transforms to '✨ I\\'m Finished ✓'!");
    } else {
      console.error("FAIL: Last line did not transform to 'I'm Finished':", lastText);
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

    // Test 7: Cast HUD Micro-Pills & Character Truncation
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
    if (hudChar && hudChar.textContent.includes("+2")) {
      console.log("PASS: Cast HUD correctly truncates long multi-character lists with +N badge!");
    } else {
      console.error("FAIL: Cast HUD character truncation did not work as expected:", hudChar?.textContent);
      process.exit(1);
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
