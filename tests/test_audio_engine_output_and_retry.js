/**
 * test_audio_engine_output_and_retry.js
 *
 * AudioEngine (static/js/audio_engine.js) without a browser:
 * - a new AudioContext is pointed at the chosen output once, and not at all
 *   when no output is chosen;
 * - opening the mic tries again once, after a short wait, when the device is
 *   still closing (NotReadableError / AbortError), and never on a permission refusal.
 */
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS: ${name}`);
}

const sinkCalls = [];
class FakeAudioContext {
  constructor() { this.state = "running"; }
  setSinkId(id) { sinkCalls.push(id); return Promise.resolve(); }
}

let gumCalls = [];
let gumPlan = [];
function setNavigator() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          gumCalls.push({ constraints, at: Date.now() });
          const next = gumPlan.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  });
}

const named = (name) => Object.assign(new Error(`${name} from the test`), { name });
const fakeStream = () => ({ getAudioTracks: () => [{ readyState: "live" }], getTracks: () => [] });

(async () => {
  globalThis.window = { AudioContext: FakeAudioContext };
  setNavigator();
  const { AudioEngine } = await import(pathToFileURL(path.join(__dirname, "..", "static", "js", "audio_engine.js")).href);

  await check("initContext points a new context at the chosen output, once", async () => {
    sinkCalls.length = 0;
    const engine = new AudioEngine();
    engine.preferredOutputId = "ab0c69f1";
    engine.initContext();
    engine.initContext();
    assert.deepStrictEqual(sinkCalls, ["ab0c69f1"]);
  });

  await check("initContext leaves the default output alone when none is chosen", async () => {
    sinkCalls.length = 0;
    const engine = new AudioEngine();
    engine.initContext();
    assert.ok(engine.ctx, "context created");
    assert.deepStrictEqual(sinkCalls, []);
  });

  await check("initContext ignores a refused output", async () => {
    const engine = new AudioEngine();
    engine.preferredOutputId = "gone";
    const prev = FakeAudioContext.prototype.setSinkId;
    FakeAudioContext.prototype.setSinkId = () => Promise.reject(named("NotFoundError"));
    try {
      engine.initContext();
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(engine.ctx);
    } finally {
      FakeAudioContext.prototype.setSinkId = prev;
    }
  });

  await check("requestMicrophone tries once more after NotReadableError and gets the stream", async () => {
    const engine = new AudioEngine();
    engine.preferredInputId = "usb-mic";
    const stream = fakeStream();
    gumCalls = [];
    gumPlan = [named("NotReadableError"), stream];
    const got = await engine.requestMicrophone();
    assert.strictEqual(got, stream);
    assert.strictEqual(gumCalls.length, 2);
    assert.deepStrictEqual(gumCalls[1].constraints, gumCalls[0].constraints, "same attempt retried");
    assert.ok(gumCalls[1].at - gumCalls[0].at >= 250, `waited ${gumCalls[1].at - gumCalls[0].at} ms`);
    assert.strictEqual(engine.activeInputDeviceId, "usb-mic");
  });

  await check("requestMicrophone does not retry a permission refusal", async () => {
    const engine = new AudioEngine();
    engine.preferredInputId = "usb-mic";
    gumCalls = [];
    gumPlan = [named("NotAllowedError"), fakeStream()];
    await assert.rejects(engine.requestMicrophone(), { name: "NotAllowedError" });
    assert.strictEqual(gumCalls.length, 1);
  });

  console.log(`ALL ${passed} AUDIO ENGINE OUTPUT AND RETRY CHECKS PASSED`);
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e && e.stack || e);
  process.exit(1);
});
