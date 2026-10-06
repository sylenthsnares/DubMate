/**
 * test_room_check_storage.js
 *
 * The room check's pure functions (static/js/studio/room_check.js): the one stored check
 * in localStorage (malformed values rejected), whether it belongs to the microphone in
 * use (chosen like mic sync: selected, else 'default', else the first; label, else
 * deviceId), the check id a new take is sent, and the report card's words per verdict,
 * advice line and unusable case.
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

  console.log("ALL ROOM CHECK STORAGE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR CAUGHT:", e);
  process.exit(1);
});
