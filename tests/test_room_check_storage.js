/**
 * test_room_check_storage.js
 *
 * The room check's pure functions (static/js/studio/room_check.js): the one stored check
 * in localStorage (malformed values rejected), whether it belongs to the microphone in
 * use (chosen like mic sync: selected, else 'default', else the first; label, else
 * deviceId), the check id a new take is sent, and the report card's words per verdict,
 * advice line and unusable case, the loudest-line advice and the count of older takes.
 */
const path = require("path");
const { pathToFileURL } = require("url");

const PROJECT_ROOT = path.join(__dirname, "..");
const modulePath = pathToFileURL(path.join(PROJECT_ROOT, "static", "js", "studio", "room_check.js")).href;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const KEY = "dubmate_room_check";
const CHECK = {
  profile_id: "3fa9c01b7d2e", verdict: "ok", device_label: "Microphone (Yeti X)",
  device_id: "default", measured_at: 1790000000000,
};
const OLD = "0123456789ab";
const NEW = CHECK.profile_id;
const INPUTS = [
  { deviceId: "default", label: "Microphone (Yeti X)" },
  { deviceId: "usb2", label: "USB Headset Mic" },
];

const HUM = "Mains hum at 50 Hz: check cables, USB hub or ground loop. Cleanup removes most of it.";
const WHINE = "A steady whine, like a fan or a computer. Cleanup removes it; moving away from it helps too.";
const HISS = "Your mic hisses. Turn up the gain on the mic or interface, and turn down the level in your computer's sound settings.";
const UNSTABLE = "The noise kept changing. Check again in a quiet moment.";
const SILENT = "Your mic sounds completely silent, so something is already removing noise. Turn off Windows mic enhancements, or noise removal in your mic's app, then check again.";
const LOUD = "Something was very loud while DubMate listened. Check again in a quiet moment.";

function report(extra = {}) {
  return {
    verdict: "ok", speech_floor_db: -52.4, rumble_share: 0.2, hum_hz: null, tones_hz: [],
    hiss: false, unstable: false, suppressed: false, clipped: false, ...extra,
  };
}

(async () => {
  const rc = await import(modulePath);

  // 1. Storage: one entry, written and read back; malformed values read as no check.
  {
    const store = memoryStore();
    eq(rc.readRoomCheck(store), null, "empty store");
    if (!rc.writeRoomCheck(store, { ...CHECK, extra: "dropped" })) fail("valid check not written");
    eq(rc.readRoomCheck(store), CHECK, "read back");
    eq(JSON.parse(store.getItem(KEY)), CHECK, "stored shape");
    rc.clearRoomCheck(store);
    eq(rc.readRoomCheck(store), null, "after clear");

    const bad = [
      "{not json", "[1,2]", "null", "42",
      JSON.stringify({ ...CHECK, profile_id: "3FA9C01B7D2E" }),
      JSON.stringify({ ...CHECK, profile_id: "../../etc" }),
      JSON.stringify({ ...CHECK, verdict: "great" }),
      JSON.stringify({ ...CHECK, device_label: 7 }),
      JSON.stringify({ ...CHECK, device_id: null }),
      JSON.stringify({ ...CHECK, measured_at: "yesterday" }),
    ];
    for (const value of bad) {
      store.setItem(KEY, value);
      eq(rc.readRoomCheck(store), null, `malformed ${value}`);
    }
    store.removeItem(KEY);
    for (const value of [null, { ...CHECK, verdict: "" }, { ...CHECK, profile_id: "abc" }]) {
      if (rc.writeRoomCheck(store, value)) fail(`malformed check written: ${JSON.stringify(value)}`);
    }
    if (store.map.size) fail("a malformed check reached storage");

    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    eq(rc.readRoomCheck(throwing), null, "blocked storage read");
    rc.writeRoomCheck(throwing, CHECK);
    rc.clearRoomCheck(throwing);
    eq(rc.readRoomCheck(null), null, "no storage");
    console.log("PASS: one check is stored and read back; malformed or blocked storage reads as no check");
  }

  // 2. Matching the microphone in use, chosen like mic sync.
  {
    if (!rc.checkMatchesMic(CHECK, INPUTS, "")) fail("system default should be the 'default' device");
    if (!rc.checkMatchesMic(CHECK, INPUTS, "default")) fail("selected default device");
    if (rc.checkMatchesMic(CHECK, INPUTS, "usb2")) fail("another mic matched");
    if (!rc.checkMatchesMic(CHECK, INPUTS, "gone")) fail("an unplugged selection falls back to 'default'");
    // No 'default' entry (Firefox): the first one listed.
    const noDefault = [{ deviceId: "a1", label: "USB Headset Mic" }, { deviceId: "a2", label: "Microphone (Yeti X)" }];
    if (rc.checkMatchesMic(CHECK, noDefault, "")) fail("first device is not the checked one");
    if (!rc.checkMatchesMic({ ...CHECK, device_label: "USB Headset Mic" }, noDefault, "")) fail("first device not chosen");
    // Matching is by label, so a deviceId that changed (new session, new origin) still matches.
    if (!rc.checkMatchesMic({ ...CHECK, device_id: "old-id" }, INPUTS, "")) fail("label match ignored a deviceId change");
    // Without labels, the deviceId.
    const unlabelled = [{ deviceId: "default", label: "" }, { deviceId: "usb2", label: "" }];
    const idCheck = { ...CHECK, device_label: "", device_id: "usb2" };
    if (!rc.checkMatchesMic(idCheck, unlabelled, "usb2")) fail("deviceId match without labels");
    if (rc.checkMatchesMic(idCheck, unlabelled, "")) fail("deviceId mismatch matched");
    if (rc.checkMatchesMic(null, INPUTS, "")) fail("no check matched");

    eq(rc.currentProfileId(CHECK, INPUTS, ""), "3fa9c01b7d2e", "id for the checked mic");
    eq(rc.currentProfileId(CHECK, INPUTS, "usb2"), null, "id for another mic");
    eq(rc.currentProfileId(null, INPUTS, ""), null, "id with no check");
    eq(rc.currentProfileId({ ...CHECK, profile_id: "nope" }, INPUTS, ""), null, "id of a malformed check");
    console.log("PASS: a check belongs to the mic it was made with (label, else deviceId); other mics get no id");
  }

  // 3. The card per verdict, with the number only in the tooltip.
  {
    eq(rc.roomCardModel(report({ verdict: "good", speech_floor_db: -66.2 })), {
      light: "good", word: "Quiet", sentence: "Your room is quiet. Good to record.",
      tooltip: "Background noise: −66 dB.", advice: [], unusable: null,
    }, "good");
    eq(rc.roomCardModel(report()), {
      light: "ok", word: "Some noise", sentence: "Some background noise. Cleanup will handle it.",
      tooltip: "Background noise: −52 dB.", advice: [], unusable: null,
    }, "ok");
    const noisy = rc.roomCardModel(report({ verdict: "noisy", speech_floor_db: -38.6, rumble_share: 0.71 }));
    eq([noisy.light, noisy.word, noisy.sentence, noisy.tooltip], ["noisy", "Noisy",
      "Your room is noisy. Cleanup will help, but a quieter spot will sound better.",
      "Background noise: −39 dB. Low rumble is removed automatically."], "noisy");
    for (const m of [noisy, rc.roomCardModel(report())]) {
      if (/dB/.test(m.word + m.sentence + m.advice.join(" "))) fail("dB outside the tooltip");
      if (/dBFS|spectr|gate|notch|DeepFilter/i.test(JSON.stringify(m))) fail("jargon in the card");
    }
    console.log("PASS: each verdict has its light, word and sentence; the level is only in the tooltip");
  }

  // 4. Advice lines: only those that apply, in the doc's order.
  {
    const all = rc.roomCardModel(report({ hum_hz: 50, tones_hz: [50.0, 150.0, 2412.5], hiss: true, unstable: true }));
    eq(all.advice, [HUM, WHINE, HISS, UNSTABLE], "all advice, in order");
    eq(rc.roomCardModel(report({ hum_hz: 50, tones_hz: [50.0, 100.2, 151.5] })).advice, [HUM], "hum harmonics are not a whine");
    eq(rc.roomCardModel(report({ hum_hz: 60, tones_hz: [60.0, 180.0] })).advice,
      ["Mains hum at 60 Hz: check cables, USB hub or ground loop. Cleanup removes most of it."], "60 Hz hum");
    eq(rc.roomCardModel(report({ tones_hz: [2412.5] })).advice, [WHINE], "whine only");
    eq(rc.roomCardModel(report({ hiss: true })).advice, [HISS], "hiss only");
    eq(rc.roomCardModel(report({ unstable: true })).advice, [UNSTABLE], "changing noise only");
    console.log("PASS: advice lines appear only when they apply, hum, whine, hiss, changing noise");
  }

  // 5. Unusable checks say why; unreadable reports give no card.
  {
    eq(rc.roomCardModel(report({ verdict: "good", suppressed: true })).unusable, SILENT, "silent");
    eq(rc.roomCardModel(report({ verdict: "noisy", clipped: true })).unusable, LOUD, "clipped");
    eq(rc.roomCardModel(report({ verdict: "bogus", suppressed: true })).unusable, SILENT, "silent without a verdict");
    eq(rc.roomCardModel(report({ verdict: "bogus" })), null, "unknown verdict");
    eq(rc.roomCardModel(null), null, "no report");
    eq(rc.roomCardModel("ok"), null, "string report");
    eq(rc.roomCardModel(report({ speech_floor_db: null })).tooltip, "", "no level, no tooltip");
    console.log("PASS: silent and clipped checks carry the reason; unreadable reports give no card");
  }

  // 6. Loudest-line advice: a shout should peak around -10 to -6, so Good is -10 to -6,
  // advice aims at -8 and an "up" never lands above -6.
  {
    const UNHEARD = { text: "DubMate couldn't hear you. Try again, a bit louder.", snrText: "" };
    eq(rc.loudLineAdvice(-8, -20, -58), { text: "Good level.", snrText: "Your voice is about 38 dB louder than the room." }, "good");
    eq(rc.loudLineAdvice(-10, -22, -60).text, "Good level.", "good, low edge");
    eq(rc.loudLineAdvice(-6, -18, -60).text, "Good level.", "good, high edge");
    eq(rc.loudLineAdvice(-5.6, -18, -60).text, "Turn your mic down by about 2 dB.", "just above Good");
    eq(rc.loudLineAdvice(-4, -16, -60).text, "Turn your mic down by about 4 dB.", "down from -4");
    eq(rc.loudLineAdvice(-2.6, -14, -60).text, "Turn your mic down by about 5 dB.", "down");
    eq(rc.loudLineAdvice(-10.4, -22, -60).text, "Turn your mic up by about 2 dB.", "just below Good");
    eq(rc.loudLineAdvice(-12, -24, -60).text, "Turn your mic up by about 4 dB.", "up from -12");
    eq(rc.loudLineAdvice(-12.4, -24, -60).text, "Turn your mic up by about 4 dB.", "up");
    for (let peak = -44.9; peak < -10; peak += 0.1) {
      const m = /up by about (\d+) dB/.exec(rc.loudLineAdvice(peak, peak - 12, -70).text);
      if (!m) fail(`no up advice at ${peak}`);
      const up = Number(m[1]);
      if (up < 1 || peak + up > -6) fail(`up ${up} dB from ${peak} lands above -6`);
    }
    eq(rc.loudLineAdvice(0, -10, -50), { text: "Your loudest line clips. Turn your mic down by about 8 dB.", snrText: "Your voice is about 40 dB louder than the room." }, "clip");
    eq(rc.loudLineAdvice(-0.1, -10, -50).text, "Your loudest line clips. Turn your mic down by about 8 dB.", "clip edge");
    eq(rc.loudLineAdvice(-0.3, -10, -50).text, "Turn your mic down by about 8 dB.", "just below clipping");
    eq(rc.loudLineAdvice(-60, -70, -62), UNHEARD, "too quiet");
    eq(rc.loudLineAdvice(-30, -55, -58), UNHEARD, "no louder than the room");
    eq(rc.loudLineAdvice(-Infinity, -Infinity, -58), UNHEARD, "silence");
    eq(rc.loudLineAdvice(NaN, NaN, null), UNHEARD, "nothing measured");
    eq(rc.loudLineAdvice(-8, -20, null), { text: "Good level.", snrText: "" }, "no room level, no comparison");

    // The levels a recording gives: a -6 dB peak tone with a quiet pause.
    const rate = 8000;
    const samples = new Float32Array(rate * 2);
    for (let i = 0; i < rate; i++) samples[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / rate);
    const levels = rc.clipLevels(samples, rate);
    if (Math.abs(levels.peakDb - (-6.02)) > 0.1) fail(`peak ${levels.peakDb}`);
    // A sine's RMS is 3 dB under its peak; the silent second doesn't pull it down.
    if (Math.abs(levels.voiceDb - (-9.03)) > 0.2) fail(`speech level ${levels.voiceDb}`);
    eq(rc.clipLevels(new Float32Array(rate), rate).peakDb, -Infinity, "silent clip");
    console.log("PASS: loudest-line advice: good, down, up capped at -6, clipping, too quiet; levels measured from samples");
  }

  // 7. Older takes: mine, noise reduction on, cleaned with another check than the current one.
  {
    const takes = {
      t1: { picked: "a", takes: [
        { take_id: "a", user_id: "u1", noise_reduction: true, nr_settings: { profile_id: OLD } },
        { take_id: "b", user_id: "u1", noise_reduction: true, nr_settings: { profile_id: NEW } },
        { take_id: "c", user_id: "u1", noise_reduction: false, nr_settings: { profile_id: OLD } },
        { take_id: "d", user_id: "u2", noise_reduction: true, nr_settings: { profile_id: OLD } },
      ] },
      t2: { picked: "e", takes: [
        { take_id: "e", user_id: "u1", noise_reduction: true },
        { take_id: "f", user_id: "u1", noise_reduction: true, nr_settings: null },
      ] },
    };
    eq(rc.olderTakeCount(takes, "u1", NEW), 3, "older than the current check (standard ones included)");
    eq(rc.olderTakeCount(takes, "u1", OLD), 3, "against the old check");
    eq(rc.olderTakeCount(takes, "u1", null), 2, "with standard cleanup, the tuned ones");
    eq(rc.olderTakeCount(takes, "u2", null), 1, "another person");
    eq(rc.olderTakeCount(takes, "u3", NEW), 0, "nobody's takes");
    eq(rc.olderTakeCount(null, "u1", NEW), 0, "no room");
    eq(rc.olderTakeCount(takes, null, NEW), 0, "no user");
    console.log("PASS: older takes are my cleaned takes whose check differs from the current one");
  }

  console.log("ALL ROOM CHECK STORAGE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
