# -*- coding: utf-8 -*-
"""
make_test_packs.py
Generates synthetic DubMate scene packs into Packs/ so the test suites that
expect a populated pack library can run on a clean checkout or in CI.

Packs/ is git-ignored, so these fixtures never enter version control.

Usage:
    python scripts/make_test_packs.py [count]      # default 15
    python scripts/make_test_packs.py --clean      # remove generated fixtures
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import wave

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS_DIR = os.path.join(PROJECT_ROOT, "Packs")
PREFIX = "ZZ_Fixture_"
SAMPLE_RATE = 44100

CHARACTERS = ["Alice", "Bob", "Carol", "Dave", "Erin"]
CAPTIONS = [
    "We need to move, now.",
    "I never agreed to this plan.",
    "Behind you!",
    "It was always going to end here.",
    "Give me one more shot at it.",
]


def write_wav(path: str, seconds: float, freq: float) -> None:
    n = int(SAMPLE_RATE * seconds)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for i in range(n):
            # Simple decaying sine so the DSP suites get non-trivial signal.
            env = 1.0 - (i / n)
            val = int(12000 * env * math.sin(2 * math.pi * freq * i / SAMPLE_RATE))
            frames += struct.pack("<h", max(-32768, min(32767, val)))
        w.writeframes(bytes(frames))


def write_video(path: str, seconds: int) -> bool:
    """Renders a real, decodable H.264 mp4 (ffmpeg is required)."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        "-movflags", "+faststart", path,
    ]
    return subprocess.run(cmd, capture_output=True).returncode == 0


def make_pack(index: int) -> str:
    name = f"{PREFIX}{index:02d}"
    folder = os.path.join(PACKS_DIR, name)
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder, exist_ok=True)

    duration = 20
    if not write_video(os.path.join(folder, "dub_video.mp4"), duration):
        shutil.rmtree(folder, ignore_errors=True)
        raise RuntimeError("ffmpeg failed to render fixture video")

    write_wav(os.path.join(folder, "_backing_track.wav"), duration, 110.0)

    captions = {}
    # 4 dialogue lines at 2.0s, 6.0s, 10.0s, 14.0s -> encoded as <whole>-<frac>
    for line_no, start in enumerate([2.0, 6.0, 10.0, 14.0], start=1):
        char = CHARACTERS[(index + line_no) % len(CHARACTERS)]
        whole, frac = str(start).split(".")
        fname = f"{line_no:02d}_{char}_{whole}-{frac.ljust(3, '0')}.wav"
        write_wav(os.path.join(folder, fname), 1.5, 300.0 + 40 * line_no)
        captions[fname] = f"[{char}] {CAPTIONS[(index + line_no) % len(CAPTIONS)]}"

    with open(os.path.join(folder, "_captions.json"), "w", encoding="utf-8") as f:
        json.dump(captions, f, ensure_ascii=False, indent=2)

    return name


def clean() -> int:
    removed = 0
    if os.path.isdir(PACKS_DIR):
        for entry in sorted(os.listdir(PACKS_DIR)):
            if entry.startswith(PREFIX):
                shutil.rmtree(os.path.join(PACKS_DIR, entry), ignore_errors=True)
                removed += 1
    print(f"Removed {removed} fixture pack(s) from {PACKS_DIR}")
    return removed


def main() -> None:
    if "--clean" in sys.argv:
        clean()
        return

    count = 15
    for a in sys.argv[1:]:
        if a.isdigit():
            count = int(a)

    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH. Install it, then re-run.")

    os.makedirs(PACKS_DIR, exist_ok=True)
    print(f"Generating {count} fixture scene pack(s) into {PACKS_DIR} ...")
    for i in range(1, count + 1):
        name = make_pack(i)
        print(f"  [OK] {name}")
    print(f"\nDone. Remove them anytime with: python scripts/make_test_packs.py --clean")


if __name__ == "__main__":
    main()
