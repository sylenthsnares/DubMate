# Usage: python scripts/headless_mic_check.py   (set DUBMATE_CHROMIUM=<path to chrome> to pick a browser)
# Dev check, not part of tests/run_all_tests.py: fake mic playing clicks, on a loopback and a non-loopback origin,
# then a fake mic playing only room noise (hiss, knocks, talking-like swells), which must not pass as claps.
"""
headless_mic_check.py
Drives static/js/audio_engine.js in headless Chromium with fake media devices: output routing
at context start, meter -> stop -> record straight away, the record analyser, decoding, clap
detection on the recording, and the meter opening again afterwards. Runs once on
http://127.0.0.1 and once on http://dubmate-host.test (a stand-in for a host's tunnel origin).
Then once more on http://127.0.0.1 with a room-noise WAV and nobody clapping: clap sync must refuse it.
Stdlib only, no network. Exits 0 with "SKIP" when no Chromium is found.
"""

import glob
import json
import math
import os
import random
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
HOST_NAME = "dubmate-host.test"
TIMEOUT_S = 120
RATE = 48000
# A click every 0.3 s: whatever the offset between the looping file and the recording,
# each clap beat (0.6 s apart) has a click within -150..+150 ms.
CLICK_EVERY_S = 0.3
LOOP_S = 3.0
RECORD_MS = 4800
# A clap run: the beat starts 0.8 s in (mic_sync.js CLAP_LEAD_SEC), 4.2 s of beats, then a tail.
CLAP_LEAD_S = 0.8
NOISE_RECORD_MS = 5600

SCENARIO = """<!doctype html>
<meta charset="utf-8">
<title>mic check</title>
<script type="module">
import { AudioEngine } from '/js/audio_engine.js';
import { findClapLag, judgeClaps, CLAP_BEAT_SEC } from '/js/studio/timing.js';

const MODE = '__MODE__';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (body) => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ origin: location.origin, ...body }) });
const report = (check, ok, detail) => post({ check, ok: !!ok, detail: String(detail) });
// The clicks are 4 ms every 300 ms, so take the loudest of several meter frames.
async function loudest(engine, ms) {
  let best = null;
  for (const end = performance.now() + ms; performance.now() < end; await sleep(25)) {
    const l = engine.readInputLevel();
    if (l && (!best || l.peak > best.peak)) best = l;
  }
  return best;
}
const errText = (e) => (e && (e.name || '') + ': ' + (e.message || e)) || String(e);

// Nobody clapping, only room noise: a clap run on it must not be saved.
async function runNoise() {
  const engine = new AudioEngine();
  await engine.startRecording();
  await sleep(__NOISE_RECORD_MS__);
  const rec = await engine.stopRecording();
  const buf = rec && rec.audioBuffer;
  if (!buf) {
    await report('room noise is not saved as claps', false, 'no audio buffer');
    return;
  }
  const beats = CLAP_BEAT_SEC.map((t) => t + __CLAP_LEAD_S__);
  const found = findClapLag(buf.getChannelData(0), buf.sampleRate, beats);
  const verdict = judgeClaps(found);
  await report('room noise is not saved as claps', verdict !== 'ok',
    verdict + (found ? ', ' + found.hits + ' hits, ' + found.inWindow + ' agree, ' + found.strays + ' strays' : ''));
}

async function run() {
  if (MODE === 'noise') return runNoise();
  const engine = new AudioEngine();

  // The studio sets preferredOutputId from its saved setup before the context exists.
  let outputId = '';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    const devices = await engine.enumerateAudioDevices();
    const pick = devices.outputs.find((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    outputId = pick ? pick.deviceId : '';
  } catch (e) {}
  if (!outputId) {
    await report('initContext applies ctx.sinkId', false, 'no non-default fake output to choose');
  } else {
    engine.preferredOutputId = outputId;
    engine.initContext();
    let sink = engine.ctx && engine.ctx.sinkId;
    for (let i = 0; i < 40 && sink !== outputId; i++) { await sleep(50); sink = engine.ctx.sinkId; }
    await report('initContext applies ctx.sinkId', sink === outputId,
      'wanted ' + outputId.slice(0, 8) + ', got ' + JSON.stringify(typeof sink === 'string' ? sink.slice(0, 8) : sink));
  }

  try {
    const mon = await engine.startInputMonitor();
    const level = await loudest(engine, 700);
    engine.stopInputMonitor();
    await engine.startRecording();
    await report('meter, stop, record straight away', !!mon && engine.isRecording,
      'monitor ' + (mon ? (mon.label || 'open') : 'null') + ', meter level ' + (level ? level.peakDb.toFixed(1) + ' dBFS' : 'null'));
  } catch (e) {
    await report('meter, stop, record straight away', false, errText(e));
    return;
  }

  let reads = 0, nulls = 0, peak = 0;
  const started = performance.now();
  while (performance.now() - started < __RECORD_MS__) {
    const l = engine.readInputLevel();
    reads++;
    if (!l) nulls++; else peak = Math.max(peak, l.peak);
    await sleep(100);
  }
  await report('meter reads the recording', nulls === 0 && peak > 0.05,
    reads + ' reads, ' + nulls + ' empty, peak ' + peak.toFixed(2));

  const rec = await engine.stopRecording();
  const buf = rec && rec.audioBuffer;
  await report('recording decodes', !!buf && buf.duration > 4,
    buf ? buf.duration.toFixed(2) + ' s at ' + buf.sampleRate + ' Hz' : 'no audio buffer');
  if (buf) {
    const hit = findClapLag(buf.getChannelData(0), buf.sampleRate, CLAP_BEAT_SEC);
    await report('claps found on the recording', !!hit && hit.hits >= 4,
      hit ? hit.hits + ' hits, lag ' + hit.lagMs.toFixed(0) + ' ms, spread ' + hit.spreadMs.toFixed(0) + ' ms' : 'none found');
    // The clicks come twice per beat, so half of them land between the beats.
    await report('a tick between the beats is not saved as claps', judgeClaps(hit) !== 'ok',
      judgeClaps(hit) + (hit ? ', ' + hit.strays + ' strays' : ''));
  }

  try {
    const again = await engine.startInputMonitor();
    const level = await loudest(engine, 700);
    engine.stopInputMonitor();
    await report('meter opens again after', !!again && !!level && level.peak > 0.05,
      level ? 'peak ' + level.peakDb.toFixed(1) + ' dBFS' : 'no level');
  } catch (e) {
    await report('meter opens again after', false, errText(e));
  }
}

run().catch((e) => report('scenario', false, errText(e))).finally(() => post({ done: true }));
</script>
"""


def write_clicks_wav(path):
    """48 kHz mono 16-bit: a 4 ms decaying 2 kHz click every CLICK_EVERY_S, LOOP_S long."""
    total = int(RATE * LOOP_S)
    samples = [0] * total
    click_len = int(RATE * 0.004)
    t = 0.0
    while t < LOOP_S - 0.01:
        start = int(t * RATE)
        for i in range(click_len):
            if start + i < total:
                env = math.exp(-i / (click_len / 4))
                samples[start + i] = int(26000 * env * math.sin(2 * math.pi * 2000 * i / RATE))
        t += CLICK_EVERY_S
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(struct.pack("<%dh" % total, *samples))


def write_noise_wav(path):
    """48 kHz mono 16-bit, nobody clapping: hiss, random knocks and talking-like swells, LOOP_S long."""
    rnd = random.Random(7)
    total = int(RATE * LOOP_S)
    samples = [rnd.gauss(0.0, 0.003) for _ in range(total)]
    for _ in range(int(3 * LOOP_S)):  # knocks: typing, a desk, a mouse
        start = int(rnd.uniform(0, LOOP_S - 0.02) * RATE)
        amp, tau = rnd.uniform(0.05, 0.3), rnd.uniform(0.002, 0.008)
        for i in range(int(0.02 * RATE)):
            samples[start + i] += amp * math.exp(-i / (tau * RATE)) * rnd.uniform(-1, 1)
    for _ in range(int(2 * LOOP_S)):  # swells that rise like speech
        dur, rise = rnd.uniform(0.1, 0.25), rnd.uniform(0.03, 0.06)
        start = int(rnd.uniform(0, LOOP_S - dur) * RATE)
        amp = rnd.uniform(0.05, 0.2)
        for i in range(int(dur * RATE)):
            t = i / RATE
            env = 0.5 - 0.5 * math.cos(math.pi * t / rise) if t < rise else math.exp(-(t - rise) / 0.08)
            samples[start + i] += amp * env * rnd.uniform(-1, 1)
    ints = [max(-32767, min(32767, int(v * 32767))) for v in samples]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(struct.pack("<%dh" % total, *ints))


def find_chromium():
    env = os.environ.get("DUBMATE_CHROMIUM")
    if env:
        return env if os.path.isfile(env) else None
    home = os.path.expanduser("~")
    local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
    patterns = [
        os.path.join(local, "ms-playwright", "chromium-*", "chrome-win*", "chrome.exe"),
        os.path.join(home, ".cache", "ms-playwright", "chromium-*", "chrome-linux*", "chrome"),
        os.path.join(home, "Library", "Caches", "ms-playwright", "chromium-*", "chrome-mac*",
                     "*.app", "Contents", "MacOS", "*"),
    ]
    found = []
    for pattern in patterns:
        found.extend(p for p in glob.glob(pattern) if os.path.isfile(p))
    return sorted(found)[-1] if found else None


class Handler(SimpleHTTPRequestHandler):
    results = None  # list shared with the main thread
    done = None     # threading.Event
    state = None    # {"mode": "clicks" | "noise"}, set by the main thread

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/scenario.html"):
            body = (SCENARIO.replace("__RECORD_MS__", str(RECORD_MS))
                    .replace("__NOISE_RECORD_MS__", str(NOISE_RECORD_MS))
                    .replace("__CLAP_LEAD_S__", str(CLAP_LEAD_S))
                    .replace("__MODE__", self.state["mode"])).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/result":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            data = {}
        self.send_response(204)
        self.end_headers()
        if data.get("done"):
            self.done.set()
        elif "check" in data:
            self.results.append(data)

    def guess_type(self, path):
        if str(path).endswith(".js"):
            return "text/javascript"
        return super().guess_type(path)

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_origin(chrome, url, port, wav, tmp, done, deadline):
    profile = tempfile.mkdtemp(prefix="profile-", dir=tmp)
    args = [
        chrome, "--headless=new", "--no-first-run", "--no-default-browser-check",
        "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
        "--use-file-for-fake-audio-capture=" + wav,
        "--autoplay-policy=no-user-gesture-required",
        # No calls home; and keep http:// (Chrome would try https:// first on a non-loopback host).
        "--disable-background-networking", "--disable-features=HttpsUpgrades",
        # Only this script's local pages load. Chromium's sandbox can't start from a per-user
        # folder on some Windows setups, and then no page loads at all.
        "--no-sandbox",
        "--user-data-dir=" + profile,
        "--host-resolver-rules=MAP %s 127.0.0.1" % HOST_NAME,
        "--unsafely-treat-insecure-origin-as-secure=http://%s:%d" % (HOST_NAME, port),
        url,
    ]
    done.clear()
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return done.wait(max(1.0, deadline - time.monotonic()))
    finally:
        proc.kill()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            pass


def main():
    chrome = find_chromium()
    if not chrome:
        print("SKIP: no Chromium found")
        return 0

    tmp = tempfile.mkdtemp(prefix="dm_mic_check_")
    results, done, state = [], threading.Event(), {"mode": "clicks"}
    server = None
    try:
        wav = os.path.join(tmp, "clicks.wav")
        write_clicks_wav(wav)
        noise_wav = os.path.join(tmp, "room_noise.wav")
        write_noise_wav(noise_wav)
        port = free_port()
        handler = type("BoundHandler", (Handler,), {"results": results, "done": done, "state": state})
        server = ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=STATIC_DIR))
        threading.Thread(target=server.serve_forever, daemon=True).start()

        deadline = time.monotonic() + TIMEOUT_S
        failed = False
        runs = [
            ("clicks", "http://127.0.0.1:%d/" % port, wav),
            ("clicks", "http://%s:%d/" % (HOST_NAME, port), wav),
            ("noise", "http://127.0.0.1:%d/" % port, noise_wav),
        ]
        for mode, url, mic_wav in runs:
            origin = url.rstrip("/")
            print("== %s (%s)" % (origin, "room noise, nobody clapping" if mode == "noise" else "clicks"))
            state["mode"] = mode
            before = len(results)
            finished = run_origin(chrome, url, port, mic_wav, tmp, done, deadline)
            mine = [r for r in results[before:] if r.get("origin") == origin]
            for r in mine:
                print("%s %s (%s)" % ("PASS" if r.get("ok") else "FAIL", r.get("check"), r.get("detail")))
                failed = failed or not r.get("ok")
            if not finished:
                print("FAIL scenario did not finish in time")
                failed = True
            elif not mine:
                print("FAIL no results")
                failed = True
        print("FAILED" if failed else "ALL PASSED")
        return 1 if failed else 0
    finally:
        if server:
            server.shutdown()
            server.server_close()
        for _ in range(5):
            shutil.rmtree(tmp, ignore_errors=True)
            if not os.path.exists(tmp):
                break
            time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main())
