# -*- coding: utf-8 -*-
"""
make_v113_room.py
Writes tests/fixtures/v113_room/: a room folder saved by the real DubMate 1.1.3 code,
for the migration tests (tests/test_v1_migration.py). The output is committed, so CI
needs neither the v1.1.3 tag nor this script. Run it by hand to regenerate:

    python tests/fixtures/make_v113_room.py [--python <interpreter>]

It extracts app.py, audio_processor.py, pack_loader.py and pack_builder.py with
`git show v1.1.3:<file>` into a temp dir and runs them in a subprocess, with
DUBMATE_CACHE_DIR, DUBMATE_EXPORTS_DIR and HOME/USERPROFILE pointed into that dir
(v1.1.3 pack_loader reads its cache from DUBMATE_CACHE_DIR, then config.json under
the home folder). Through fastapi's TestClient it creates a room on a 3-line fixture
pack (timestamped line filenames), uploads two takes (line 1 with noise reduction on,
line 3 with it off) and calls Room.save_to_disk(). The room's room_state.json and
take_line_*.wav files are copied out unchanged. --python picks the interpreter, for
example the 1.1.3 desktop app's python-runtime\\python.exe; it needs fastapi, httpx
and numpy. No network: the room is never published (there's no tunnel).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(HERE, "v113_room")
TAG = "v1.1.3"
SOURCES = ("app.py", "audio_processor.py", "pack_loader.py", "pack_builder.py")
PACK_ID = "V113_Fixture_Pack"
# (filename, character, caption): starts 1.000 s, 3.250 s and 5.500 s.
LINES = (("01_Ana_1-000.wav", "Ana", "First line"),
         ("02_Ben_3-250.wav", "Ben", "Second line"),
         ("03_Ana_5-500.wav", "Ana", "Third line"))
SR = 16000

DRIVER = r'''
import json, os, sys
src = os.path.abspath(sys.argv[1])
sys.path.insert(0, src)
import app, audio_processor, pack_loader
for mod in (app, audio_processor, pack_loader):  # the 1.1.3 files, not an installed DubMate
    assert os.path.normcase(os.path.dirname(os.path.abspath(mod.__file__))) == os.path.normcase(src), mod.__file__
from fastapi.testclient import TestClient
client = TestClient(app.app)
packs = client.get("/api/packs").json()
r = client.post("/api/rooms", json={"pack_id": sys.argv[2], "host_name": "Host",
                                    "host_color": "#7c5cff", "app_version": "1.1.3"})
r.raise_for_status()
room_id, user_id = r.json()["room_id"], r.json()["user_id"]
for index, path, nr in ((0, sys.argv[3], True), (2, sys.argv[4], False)):
    with open(path, "rb") as f:
        up = client.post(f"/api/rooms/{room_id}/takes/{index}",
                         files={"file": ("take.wav", f.read(), "audio/wav")},
                         data={"user_id": user_id, "user_name": "Host", "offset_ms": "40",
                               "noise_reduction": "true" if nr else "false"})
    up.raise_for_status()
app.ROOMS[room_id].save_to_disk()
print(json.dumps({"room_dir": audio_processor.get_room_cache_dir(room_id)}))
'''


def _write_wav(path, freq, seconds, noise=0.0):
    t = np.arange(int(SR * seconds)) / SR
    rng = np.random.default_rng(int(freq))
    audio = 0.25 * np.sin(2 * np.pi * freq * t) + noise * rng.standard_normal(t.size)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def _make_pack(packs_dir, ffmpeg):
    folder = os.path.join(packs_dir, PACK_ID)
    os.makedirs(folder)
    for n, (fname, _, _) in enumerate(LINES):
        _write_wav(os.path.join(folder, fname), 200 + 40 * n, 0.4)
    captions = {fname: f"[{char}] {caption}" for fname, char, caption in LINES}
    with open(os.path.join(folder, "_captions.json"), "w", encoding="utf-8") as f:
        json.dump(captions, f, indent=2)
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "color=c=black:s=160x90:d=7", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    os.path.join(folder, "dub_video.mp4")], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--python", default=sys.executable, help="interpreter that runs the 1.1.3 code")
    args = parser.parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        sys.exit("ffmpeg is needed on PATH to make the fixture pack's video.")

    work = tempfile.mkdtemp(prefix="dm_v113_room_")
    try:
        src = os.path.join(work, "src")
        os.makedirs(src)
        for name in SOURCES:
            blob = subprocess.run(["git", "show", f"{TAG}:{name}"], cwd=REPO, check=True,
                                  capture_output=True).stdout
            with open(os.path.join(src, name), "wb") as f:
                f.write(blob)
        _make_pack(os.path.join(src, "Packs"), ffmpeg)
        take_a, take_b = os.path.join(work, "take_a.wav"), os.path.join(work, "take_b.wav")
        _write_wav(take_a, 330, 0.3, noise=0.02)
        _write_wav(take_b, 440, 0.3)
        driver = os.path.join(work, "driver.py")
        with open(driver, "w", encoding="utf-8") as f:
            f.write(DRIVER)

        home = os.path.join(work, "home")
        os.makedirs(home)
        env = dict(os.environ, HOME=home, USERPROFILE=home,
                   DUBMATE_CACHE_DIR=os.path.join(work, "cache"),
                   DUBMATE_EXPORTS_DIR=os.path.join(work, "exports"))
        env.pop("PYTHONPATH", None)
        result = subprocess.run([args.python, "-B", driver, src, PACK_ID, take_a, take_b],
                                cwd=src, env=env, check=True, capture_output=True, text=True)
        room_dir = json.loads([l for l in result.stdout.splitlines() if l.startswith('{"room_dir"')][-1])["room_dir"]

        shutil.rmtree(OUT_DIR, ignore_errors=True)
        os.makedirs(OUT_DIR)
        names = sorted(n for n in os.listdir(room_dir)
                       if n == "room_state.json" or (n.startswith("take_line_") and n.endswith(".wav")))
        for name in names:
            shutil.copyfile(os.path.join(room_dir, name), os.path.join(OUT_DIR, name))
        print(f"Wrote {OUT_DIR}: {', '.join(names)}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
