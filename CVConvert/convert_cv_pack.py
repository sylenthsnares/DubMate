"""
CVConvert - converts The Choicer Voicer dub packs into DubStage pack format.

Usage:
    python convert_cv_pack.py <path1> [path2] [path3] ...

Each path can be:
  - a folder containing a Choicer Voicer pack (dub_video.ogv + numbered .mp3/.txt pairs)
  - a .zip file containing such a folder
  - a folder containing several such pack folders/zips (they'll all be found and converted)

Output:
    ./output/<PackName>/          <- ready to copy straight into DubStage's "packs" folder
    ./output/<PackName>.zip       <- same thing, zipped, for sharing
"""

import sys
import os
import re
import json
import glob
import shutil
import zipfile
import subprocess
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
VIDEO_OK_EXT = {".mp4", ".ogv", ".mkv", ".webm", ".mov", ".avi"}


def find_ffmpeg():
    # 1) next to this script, DubForge-style: tools\ffmpeg.exe or tools\bin\ffmpeg.exe
    candidates = [
        os.path.join(SCRIPT_DIR, "tools", "ffmpeg.exe"),
        os.path.join(SCRIPT_DIR, "tools", "bin", "ffmpeg.exe"),
        os.path.join(SCRIPT_DIR, "..", "tools", "ffmpeg.exe"),
        os.path.join(SCRIPT_DIR, "..", "tools", "bin", "ffmpeg.exe"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    # 2) on PATH (also covers ffmpeg / ffmpeg.exe on non-Windows)
    found = shutil.which("ffmpeg")
    if found:
        return found
    return None


def parse_ini_txt(path):
    data = {}
    with open(path, encoding="utf-8") as f:
        content = f.read()
    for key in ("caption", "dub_timestamps", "dub_characters"):
        m = re.search(rf'{key}\s*=\s*(.+)', content)
        if not m:
            continue
        val = m.group(1).strip()
        if key == "caption":
            data[key] = val.strip('"')
        elif key == "dub_timestamps":
            nums = re.findall(r'[\d.]+', val)
            data[key] = float(nums[0]) if nums else None
        elif key == "dub_characters":
            names = re.findall(r'"([^"]+)"', val)
            data[key] = names[0] if names else "Unknown"
    return data


def find_pack_roots(path):
    """Given a folder or zip, return a list of (pack_root_dir, pack_title, cleanup_dir_or_None)."""
    roots = []

    def scan_dir(d):
        found = []
        for dirpath, _dirnames, filenames in os.walk(d):
            if "dub_video.ogv" in filenames or any(
                f.startswith("dub_video.") for f in filenames
            ):
                found.append(dirpath)
        return found

    if path.lower().endswith(".zip"):
        tmp = tempfile.mkdtemp(prefix="cvconvert_")
        with zipfile.ZipFile(path) as z:
            z.extractall(tmp)
        title = os.path.splitext(os.path.basename(path))[0]
        for root in scan_dir(tmp):
            roots.append((root, title, tmp))
    elif os.path.isdir(path):
        pack_dirs = scan_dir(path)
        if pack_dirs:
            for root in pack_dirs:
                title = os.path.basename(root)
                roots.append((root, title, None))
        else:
            # maybe this folder contains multiple zips/pack folders inside it
            for entry in sorted(os.listdir(path)):
                full = os.path.join(path, entry)
                if entry.lower().endswith(".zip") or os.path.isdir(full):
                    roots.extend(find_pack_roots(full))
    return roots


def convert_one(src_dir, out_dir, pack_title, ffmpeg):
    os.makedirs(out_dir, exist_ok=True)
    meta_files = sorted(set(
        glob.glob(os.path.join(src_dir, "*.txt")) +
        glob.glob(os.path.join(src_dir, "*.ini"))
    ))
    clips = []
    for txt in meta_files:
        base = os.path.splitext(os.path.basename(txt))[0]
        audio_src = None
        for ext in (".mp3", ".wav", ".ogg", ".m4a", ".flac"):
            cand = os.path.join(src_dir, base + ext)
            if os.path.exists(cand):
                audio_src = cand
                break
        if not audio_src:
            continue
        meta = parse_ini_txt(txt)
        if meta.get("dub_timestamps") is None:
            continue
        clips.append({
            "src_audio": audio_src,
            "caption": meta.get("caption", ""),
            "timestamp": meta["dub_timestamps"],
            "character": meta.get("dub_characters", "Unknown"),
        })

    if not clips:
        print(f"  ! No usable clips found in {src_dir}, skipping.")
        return 0

    clips.sort(key=lambda c: c["timestamp"])

    captions = {}
    timestamp_lines = []
    for i, clip in enumerate(clips, start=1):
        ts = clip["timestamp"]
        ts_str = f"{ts:.3f}".replace(".", "-")
        char_clean = re.sub(r'[^A-Za-z0-9]+', '', clip["character"]) or "Unknown"
        new_name = f"{i:02d}_{char_clean}_{ts_str}.wav"
        out_path = os.path.join(out_dir, new_name)

        subprocess.run(
            [ffmpeg, "-y", "-i", clip["src_audio"], "-ar", "48000", out_path],
            check=True, capture_output=True
        )

        subtitle = f"[{clip['character']}] {clip['caption']}"
        captions[new_name] = subtitle
        timestamp_lines.append(f"{new_name:<40} {ts:>10.3f}s   | {subtitle}")

    # dub_video: keep as-is if already an accepted format, otherwise transcode to mp4
    src_video = None
    for f in os.listdir(src_dir):
        if f.lower().startswith("dub_video."):
            src_video = os.path.join(src_dir, f)
            break
    if src_video:
        ext = os.path.splitext(src_video)[1].lower()
        if ext in VIDEO_OK_EXT:
            shutil.copy(src_video, os.path.join(out_dir, "dub_video" + ext))
        else:
            subprocess.run(
                [ffmpeg, "-y", "-i", src_video, os.path.join(out_dir, "dub_video.mp4")],
                check=True, capture_output=True
            )

    # backing track (optional)
    for f in os.listdir(src_dir):
        if f.lower().startswith("_backing_track."):
            subprocess.run(
                [ffmpeg, "-y", "-i", os.path.join(src_dir, f), "-ar", "48000",
                 os.path.join(out_dir, "_backing_track.wav")],
                check=True, capture_output=True
            )
            break

    with open(os.path.join(out_dir, "_captions.json"), "w", encoding="utf-8") as f:
        json.dump(captions, f, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, "_TIMESTAMPS.txt"), "w", encoding="utf-8") as f:
        f.write(f"# {pack_title}\n# Converted from a Choicer Voicer pack for DubStage\n#\n")
        f.write("# File | start time (s) | subtitle\n\n")
        f.write("\n".join(timestamp_lines) + "\n")

    with open(os.path.join(out_dir, "_README.txt"), "w", encoding="utf-8") as f:
        f.write(f"{pack_title}\nConverted from a Choicer Voicer GameBanana pack into DubStage format.\n")

    return len(clips)


def zip_dir(dir_path, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _dirnames, filenames in os.walk(dir_path):
            for fname in filenames:
                full = os.path.join(dirpath, fname)
                rel = os.path.relpath(full, os.path.dirname(dir_path))
                z.write(full, rel)


def main():
    if len(sys.argv) < 2:
        print("Drag a Choicer Voicer pack (folder or .zip) onto Convert.bat,")
        print("or put packs into the 'input' folder next to it and run Convert.bat.")
        sys.exit(1)

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("ERROR: ffmpeg not found. Put ffmpeg.exe in a 'tools' folder next to this")
        print("script (same as DubForge uses), or install it and add it to PATH.")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    total = 0
    for path in sys.argv[1:]:
        path = path.strip('"')
        if not os.path.exists(path):
            print(f"  ! Not found: {path}")
            continue
        for root, title, cleanup in find_pack_roots(path):
            safe_title = re.sub(r'[^A-Za-z0-9 _-]+', '', title).strip() or "Pack"
            out_dir = os.path.join(OUTPUT_DIR, safe_title)
            if os.path.exists(out_dir):
                shutil.rmtree(out_dir)
            print(f"Converting: {title}")
            n = convert_one(root, out_dir, title, ffmpeg)
            if n:
                zip_path = os.path.join(OUTPUT_DIR, safe_title + ".zip")
                zip_dir(out_dir, zip_path)
                print(f"  -> {n} clips. Folder and zip ready in output\\{safe_title}")
                total += 1
            if cleanup:
                shutil.rmtree(cleanup, ignore_errors=True)

    print(f"\nDone. {total} pack(s) converted into: {OUTPUT_DIR}")
    print("Copy the folder(s) from 'output' into DubStage's 'packs' folder, or Add folder them.")


if __name__ == "__main__":
    main()
