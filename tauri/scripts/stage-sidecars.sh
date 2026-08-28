#!/usr/bin/env bash
# stage-sidecars.sh - Stages Python, FFmpeg, and cloudflared sidecars for macOS Universal build
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../src-tauri/sidecar"

mkdir -p "$SIDECAR_DIR"

echo "========================================================="
echo "  🎙️ Staging DubMate Desktop Sidecars (macOS Universal)"
echo "========================================================="

for TRIPLE in "aarch64-apple-darwin" "x86_64-apple-darwin"; do
  echo "--- Processing architecture target: $TRIPLE ---"
  
  # 1. Standalone Python Runtime (indygreg / python-build-standalone)
  PY_TARGET="$SIDECAR_DIR/python-runtime-$TRIPLE"
  if [ ! -f "$PY_TARGET" ]; then
    echo "[1/3] Downloading Standalone Python 3.12 for $TRIPLE..."
    PY_TAR="/tmp/python-$TRIPLE.tar.gz"
    curl -fsSL "https://github.com/indygreg/python-build-standalone/releases/download/20240713/cpython-3.12.4+20240713-${TRIPLE}-install_only.tar.gz" -o "$PY_TAR"
    mkdir -p "/tmp/py-$TRIPLE"
    tar -xzf "$PY_TAR" -C "/tmp/py-$TRIPLE"
    cp "/tmp/py-$TRIPLE/python/bin/python3" "$PY_TARGET"
    chmod +x "$PY_TARGET"
  fi

  # 2. FFmpeg Static Binary
  FFMPEG_TARGET="$SIDECAR_DIR/ffmpeg-$TRIPLE"
  if [ ! -f "$FFMPEG_TARGET" ]; then
    echo "[2/3] Downloading FFmpeg static binary for macOS..."
    curl -fsSL "https://evermeet.cx/ffmpeg/ffmpeg-7.0.zip" -o "/tmp/ffmpeg-mac.zip"
    unzip -q -o "/tmp/ffmpeg-mac.zip" -d "/tmp/ffmpeg-mac"
    cp "/tmp/ffmpeg-mac/ffmpeg" "$FFMPEG_TARGET"
    chmod +x "$FFMPEG_TARGET"
  fi

  # 3. cloudflared Darwin Binary
  CF_TARGET="$SIDECAR_DIR/cloudflared-$TRIPLE"
  if [ ! -f "$CF_TARGET" ]; then
    ARCH=$(echo "$TRIPLE" | cut -d'-' -f1)
    echo "[3/3] Downloading cloudflared binary for $ARCH..."
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$ARCH" -o "$CF_TARGET"
    chmod +x "$CF_TARGET"
  fi
done

echo "========================================================="
echo "  ✅ macOS Universal Sidecars Staged Successfully!"
echo "========================================================="
