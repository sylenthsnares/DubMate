# Usage: python scripts/headless_mic_check.py   (set DUBMATE_CHROMIUM=<path to chrome> to pick a browser)
# Dev check, not part of tests/run_all_tests.py: fake mic playing clicks, on a loopback and a non-loopback origin.
"""
headless_mic_check.py
Drives static/js/audio_engine.js in headless Chromium with fake media devices: output routing
at context start, meter -> stop -> record straight away, the record analyser, decoding, clap
detection on the recording, and the meter opening again afterwards. Runs once on
http://127.0.0.1 and once on http://dubmate-host.test (a stand-in for a host's tunnel origin).
Stdlib only, no network. Exits 0 with "SKIP" when no Chromium is found.
"""

import glob
import json
import math
import os
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
TIMEOUT_S = 60
RATE = 48000
# A click every 0.3 s: whatever the offset between the looping file and the recording,
# each clap beat (0.6 s apart) has a click within -150..+150 ms.
CLICK_EVERY_S = 0.3
LOOP_S = 3.0
RECORD_MS = 4800

SCENARIO = """<!doctype html>
<meta charset="utf-8">
<title>mic check</title>
<script type="module">
import { AudioEngine } from '/js/audio_engine.js';
import { findClapLag, CLAP_BEAT_SEC } from '/js/studio/timing.js';

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

async function run() {
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

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/scenario.html"):
            body = SCENARIO.replace("__RECORD_MS__", str(RECORD_MS)).encode("utf-8")
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
    results, done = [], threading.Event()
    server = None
    try:
        wav = os.path.join(tmp, "clicks.wav")
        write_clicks_wav(wav)
        port = free_port()
        handler = type("BoundHandler", (Handler,), {"results": results, "done": done})
        server = ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=STATIC_DIR))
        threading.Thread(target=server.serve_forever, daemon=True).start()

        deadline = time.monotonic() + TIMEOUT_S
        failed = False
        for url in ("http://127.0.0.1:%d/" % port, "http://%s:%d/" % (HOST_NAME, port)):
            origin = url.rstrip("/")
            print("== %s" % origin)
            finished = run_origin(chrome, url, port, wav, tmp, done, deadline)
            mine = [r for r in results if r.get("origin") == origin]
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
