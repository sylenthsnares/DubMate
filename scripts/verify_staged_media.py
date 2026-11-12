"""Check the staged engine can measure a video without a system FFprobe install."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

import pack_loader


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    args = parser.parse_args()
    expected = Path(pack_loader.BASE_DIR) / "tools" / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    actual = Path(pack_loader.get_ffprobe_path())
    if not expected.is_file() or actual.resolve() != expected.resolve():
        raise RuntimeError(f"The staged engine must use its packaged FFprobe at {expected}; found {actual}")
    ffmpeg = args.ffmpeg.resolve()
    if not ffmpeg.is_file():
        raise RuntimeError(f"The staged FFmpeg sidecar is missing: {ffmpeg}")
    with tempfile.TemporaryDirectory(prefix="dubmate_staged_media_") as folder:
        video = Path(folder) / "probe.mp4"
        subprocess.run([str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                        "-i", "color=c=black:s=64x64:r=10", "-t", "1", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", str(video)], check=True, timeout=30)
        duration = pack_loader.probe_duration(str(video))
        if not 0.9 <= duration <= 1.1:
            raise RuntimeError(f"The staged engine measured a one-second video as {duration}s")
    print(f"[PASS] packaged FFprobe measured a one-second video as {duration}s")


if __name__ == "__main__":
    main()
