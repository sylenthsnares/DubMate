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
  PY_RUNTIME_DIR="$SIDECAR_DIR/python-runtime"
  mkdir -p "$PY_RUNTIME_DIR"
  PY_TARGET="$PY_RUNTIME_DIR/python-$TRIPLE"
  if [ ! -f "$PY_TARGET" ]; then
    echo "[1/3] Downloading Standalone Python 3.12 for $TRIPLE..."
    PY_TAR="/tmp/python-$TRIPLE.tar.gz"
    curl -fsSL "https://github.com/indygreg/python-build-standalone/releases/download/20240713/cpython-3.12.4+20240713-${TRIPLE}-install_only.tar.gz" -o "$PY_TAR"
    mkdir -p "/tmp/py-$TRIPLE"
    tar -xzf "$PY_TAR" -C "/tmp/py-$TRIPLE"
    cp "/tmp/py-$TRIPLE/python/bin/python3" "$PY_TARGET"
    chmod +x "$PY_TARGET"

    # Install dependencies into standalone Python runtime
    "/tmp/py-$TRIPLE/python/bin/python3" -m pip install -r "$PROJECT_ROOT/requirements.txt" --no-warn-script-location -q || true

    # Copy full standalone runtime into resources
    mkdir -p "$RESOURCE_DIR/python-runtime"
    cp -r "/tmp/py-$TRIPLE/python/"* "$RESOURCE_DIR/python-runtime/" || true
  fi

  # 2. FFmpeg Static Binary
  FFMPEG_TARGET="$SIDECAR_DIR/ffmpeg-$TRIPLE"
  if [ ! -f "$FFMPEG_TARGET" ]; then
    if ! command -v ffmpeg &> /dev/null; then
      brew install ffmpeg
    fi
    cp "$(command -v ffmpeg)" "$FFMPEG_TARGET"
    chmod +x "$FFMPEG_TARGET"
  fi

  # 3. cloudflared Darwin Binary (.tgz archive)
  CF_TARGET="$SIDECAR_DIR/cloudflared-$TRIPLE"
  if [ ! -f "$CF_TARGET" ]; then
    ARCH=$(echo "$TRIPLE" | cut -d'-' -f1)
    if [ "$ARCH" = "x86_64" ]; then
      CF_ARCH="amd64"
    else
      CF_ARCH="arm64"
    fi
    echo "[3/3] Downloading cloudflared binary for $CF_ARCH..."
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz" -o "/tmp/cf-${CF_ARCH}.tgz"
    tar -xzf "/tmp/cf-${CF_ARCH}.tgz" -C "/tmp"
    cp "/tmp/cloudflared" "$CF_TARGET"
    chmod +x "$CF_TARGET"
  fi
done

# 4. Application Resources (app.py, audio_processor, pack_loader, static, VERSION)
RESOURCE_DIR="$SCRIPT_DIR/../src-tauri/resources"
mkdir -p "$RESOURCE_DIR"
echo "[4/4] Staging application Python files and static assets into resources..."
for file in app.py audio_processor.py pack_loader.py pack_builder.py VERSION requirements.txt; do
  if [ -f "$PROJECT_ROOT/$file" ]; then
    cp "$PROJECT_ROOT/$file" "$RESOURCE_DIR/$file"
  fi
done
if [ -d "$PROJECT_ROOT/static" ]; then
  cp -r "$PROJECT_ROOT/static" "$RESOURCE_DIR/"
fi

echo "========================================================="
echo "  ✅ macOS Sidecars & Resources Staged Successfully!"
echo "========================================================="
