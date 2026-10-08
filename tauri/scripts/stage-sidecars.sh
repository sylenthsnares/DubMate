#!/usr/bin/env bash
# stage-sidecars.sh - Stages Python, FFmpeg, DeepFilterNet and cloudflared sidecars for macOS Universal build
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../src-tauri/sidecar"
RESOURCE_DIR="$SCRIPT_DIR/../src-tauri/resources"

mkdir -p "$SIDECAR_DIR"
mkdir -p "$RESOURCE_DIR"

echo "========================================================="
echo "  🎙️ Staging DubMate Desktop Sidecars (macOS Universal)"
echo "========================================================="

for TRIPLE in "aarch64-apple-darwin" "x86_64-apple-darwin"; do
  echo "--- Processing architecture target: $TRIPLE ---"
  
  # 1. Standalone Python Runtime (indygreg / python-build-standalone)
  PY_RUNTIME_DIR="$SIDECAR_DIR/python-runtime"
  mkdir -p "$PY_RUNTIME_DIR"
  PY_STAGED="$PY_RUNTIME_DIR/.staged-$TRIPLE"
  if [ ! -f "$PY_STAGED" ]; then
    echo "[1/5] Downloading Standalone Python 3.12 for $TRIPLE..."
    PY_TAR="/tmp/python-$TRIPLE.tar.gz"
    curl -fsSL "https://github.com/indygreg/python-build-standalone/releases/download/20240713/cpython-3.12.4+20240713-${TRIPLE}-install_only.tar.gz" -o "$PY_TAR"
    mkdir -p "/tmp/py-$TRIPLE"
    tar -xzf "$PY_TAR" -C "/tmp/py-$TRIPLE"

    # Install dependencies into standalone Python runtime
    "/tmp/py-$TRIPLE/python/bin/python3" -m pip install -r "$PROJECT_ROOT/requirements.txt" --no-warn-script-location -q || true
    # Build backends for sdist-only AI packages (openai-whisper, demucs).
    "/tmp/py-$TRIPLE/python/bin/python3" -m pip install setuptools wheel --no-warn-script-location -q || true

    # Copy full standalone runtime into resources
    mkdir -p "$RESOURCE_DIR/python-runtime"
    cp -r "/tmp/py-$TRIPLE/python/"* "$RESOURCE_DIR/python-runtime/" || true
    touch "$PY_STAGED"
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

  # 3. DeepFilterNet (noise cleanup). The official standalone binary; its model is built in.
  # Pinned by SHA-256 per architecture and checked before use, including a copy
  # left from an earlier run. Never relax a hash to make a download pass.
  case "$TRIPLE" in
    aarch64-apple-darwin) DF_SHA256="4601e7f4e4c03e59a4c5b5000216ef3add3e808799cfccd95e14e83ea4611081" ;;
    x86_64-apple-darwin) DF_SHA256="d3be84003acb7c23e738ad7f70a158ec779a8d233a82e7fa3e717d112eb5b50f" ;;
  esac
  DF_TARGET="$SIDECAR_DIR/deep-filter-$TRIPLE"
  if [ ! -f "$DF_TARGET" ] || [ "$(shasum -a 256 "$DF_TARGET" | cut -d' ' -f1)" != "$DF_SHA256" ]; then
    DF_URL="https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-$TRIPLE"
    DF_TMP="/tmp/dubmate-deep-filter-$TRIPLE"
    echo "[3/5] Downloading DeepFilterNet for $TRIPLE..."
    curl -fsSL "$DF_URL" -o "$DF_TMP"
    DF_ACTUAL="$(shasum -a 256 "$DF_TMP" | cut -d' ' -f1)"
    if [ "$DF_ACTUAL" != "$DF_SHA256" ]; then
      rm -f "$DF_TMP"
      echo "DeepFilterNet SHA-256 mismatch, not staging it." >&2
      echo "  url     : $DF_URL" >&2
      echo "  expected: $DF_SHA256" >&2
      echo "  actual  : $DF_ACTUAL" >&2
      exit 1
    fi
    cp "$DF_TMP" "$DF_TARGET"
    chmod +x "$DF_TARGET"
  fi

  # 4. cloudflared Darwin Binary (.tgz archive)
  CF_TARGET="$SIDECAR_DIR/cloudflared-$TRIPLE"
  if [ ! -f "$CF_TARGET" ]; then
    ARCH=$(echo "$TRIPLE" | cut -d'-' -f1)
    if [ "$ARCH" = "x86_64" ]; then
      CF_ARCH="amd64"
    else
      CF_ARCH="arm64"
    fi
    echo "[4/5] Downloading cloudflared binary for $CF_ARCH..."
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz" -o "/tmp/cf-${CF_ARCH}.tgz"
    tar -xzf "/tmp/cf-${CF_ARCH}.tgz" -C "/tmp"
    cp "/tmp/cloudflared" "$CF_TARGET"
    chmod +x "$CF_TARGET"
  fi
done

# 5. Application Resources (app.py, audio_processor, pack_loader, static, VERSION)
RESOURCE_DIR="$SCRIPT_DIR/../src-tauri/resources"
mkdir -p "$RESOURCE_DIR"
echo "[5/5] Staging application Python files and static assets into resources..."
for file in app.py audio_processor.py pack_loader.py pack_builder.py VERSION requirements.txt requirements_builder.txt LICENSE THIRD_PARTY_NOTICES.md; do
  if [ -f "$PROJECT_ROOT/$file" ]; then
    cp "$PROJECT_ROOT/$file" "$RESOURCE_DIR/$file"
  fi
done
if [ -d "$PROJECT_ROOT/static" ]; then
  rm -rf "$RESOURCE_DIR/static"
  cp -r "$PROJECT_ROOT/static" "$RESOURCE_DIR/static"
fi
rm -rf "$RESOURCE_DIR/dubmate" && cp -r "$PROJECT_ROOT/dubmate" "$RESOURCE_DIR/dubmate" && find "$RESOURCE_DIR/dubmate" -name __pycache__ -prune -exec rm -rf {} +

echo "========================================================="
echo "  ✅ macOS Sidecars & Resources Staged Successfully!"
echo "========================================================="
