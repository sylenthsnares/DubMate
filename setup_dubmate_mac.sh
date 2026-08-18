#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "====================================================================="
echo "      🎙️  DubMate Studio Pro — 1-Click Setup (macOS / Linux) 🚀"
echo "====================================================================="
echo ""
echo "  This script sets up all dependencies strictly inside this folder:"
echo "  - Local Python virtual environment (.venv/)"
echo "  - Local portable audio/video engine (tools/ffmpeg, tools/ffprobe)"
echo "  - Local multiplayer tunnel (tools/cloudflared)"
echo ""
echo "  [!] NO packages or binaries are installed globally on your system."
echo "====================================================================="
echo ""

# 1. Verify Python 3
echo "[1/4] Checking Python installation..."
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] python3 was not found on your system."
    echo "Please install Python 3.10+ (e.g. brew install python3 or from python.org)."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(sys.version_info.major, sys.version_info.minor)')
read -r PY_MAJ PY_MIN <<< "$PYTHON_VERSION"
if [ "$PY_MAJ" -lt 3 ] || ([ "$PY_MAJ" -eq 3 ] && [ "$PY_MIN" -lt 9 ]); then
    echo "[ERROR] Python 3.9 or higher is required. Found Python $PY_MAJ.$PY_MIN"
    exit 1
fi
echo "      Python $PY_MAJ.$PY_MIN detected."

# 2. Virtual Environment
echo ""
if [ ! -f ".venv/bin/python3" ] && [ ! -f ".venv/bin/python" ]; then
    echo "[2/4] Creating project-local virtual environment (.venv)..."
    python3 -m venv .venv
    echo "      Virtual environment created at .venv/"
else
    echo "[2/4] Virtual environment already exists (.venv/)."
fi

echo "      Installing/updating requirements into local .venv..."
./.venv/bin/python3 -m pip install --upgrade pip --quiet
./.venv/bin/python3 -m pip install -r requirements.txt
echo "      Python dependencies verified in .venv/"

# 3. Setup Tools Folder (FFmpeg & FFprobe)
echo ""
mkdir -p tools

FFOK=""
if [ -x "tools/ffmpeg" ] && [ -x "tools/ffprobe" ]; then
    FFOK="1"
fi

if [ -n "$FFOK" ]; then
    echo "[3/4] FFmpeg and FFprobe are ready in tools/"
else
    echo "[3/4] Setting up portable FFmpeg & FFprobe in tools/..."
    
    # Check if system ffmpeg is available as an immediate local link option
    SYS_FFMPEG=$(command -v ffmpeg 2>/dev/null || true)
    SYS_FFPROBE=$(command -v ffprobe 2>/dev/null || true)
    
    if [ -n "$SYS_FFMPEG" ] && [ -n "$SYS_FFPROBE" ]; then
        echo "      Found system FFmpeg ($SYS_FFMPEG). Linking into local tools/..."
        cp "$SYS_FFMPEG" "tools/ffmpeg" 2>/dev/null || ln -sf "$SYS_FFMPEG" "tools/ffmpeg"
        cp "$SYS_FFPROBE" "tools/ffprobe" 2>/dev/null || ln -sf "$SYS_FFPROBE" "tools/ffprobe"
        chmod +x tools/ffmpeg tools/ffprobe 2>/dev/null || true
        FFOK="1"
    else
        ARCH=$(uname -m)
        OS_TYPE=$(uname -s)
        
        if [ "$OS_TYPE" = "Darwin" ]; then
            echo "      Downloading portable macOS FFmpeg binary..."
            TMP_FF="$TMPDIR/dubmate_ffmpeg.zip"
            TMP_FP="$TMPDIR/dubmate_ffprobe.zip"
            
            curl -fsSL "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$TMP_FF" 2>/dev/null || true
            if [ -f "$TMP_FF" ]; then
                unzip -o "$TMP_FF" -d tools/ >/dev/null 2>&1 || true
                rm -f "$TMP_FF"
            fi
            
            curl -fsSL "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o "$TMP_FP" 2>/dev/null || true
            if [ -f "$TMP_FP" ]; then
                unzip -o "$TMP_FP" -d tools/ >/dev/null 2>&1 || true
                rm -f "$TMP_FP"
            fi
            
            chmod +x tools/ffmpeg tools/ffprobe 2>/dev/null || true
            if [ -x "tools/ffmpeg" ]; then
                FFOK="1"
            fi
        fi
    fi
    
    if [ -n "$FFOK" ]; then
        echo "      FFmpeg ready in tools/"
    else
        echo "      [NOTICE] FFmpeg could not be auto-downloaded directly."
        echo "      You can install via 'brew install ffmpeg' or place 'ffmpeg' & 'ffprobe' in tools/."
    fi
fi

# 4. Cloudflared Binary
echo ""
if [ -x "tools/cloudflared" ]; then
    echo "[4/4] Cloudflare Tunnel binary ready in tools/"
else
    echo "[4/4] Checking cloudflared binary in tools/..."
    OS_TYPE=$(uname -s)
    ARCH=$(uname -m)
    CF_URL=""
    
    if [ "$OS_TYPE" = "Darwin" ]; then
        if [ "$ARCH" = "arm64" ]; then
            CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64"
        else
            CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64"
        fi
    elif [ "$OS_TYPE" = "Linux" ]; then
        if [ "$ARCH" = "x86_64" ]; then
            CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        elif [ "$ARCH" = "aarch64" ]; then
            CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
        fi
    fi
    
    if [ -n "$CF_URL" ]; then
        echo "      Downloading cloudflared for $OS_TYPE ($ARCH)..."
        curl -fsSL "$CF_URL" -o "tools/cloudflared" 2>/dev/null || true
        chmod +x tools/cloudflared 2>/dev/null || true
    fi
    
    if [ -x "tools/cloudflared" ]; then
        echo "      cloudflared ready in tools/"
    else
        echo "      [NOTICE] cloudflared download skipped. Local studio works 100% offline."
    fi
fi

# 5. Summary & Completion
echo ""
echo "====================================================================="
echo "  ✅ DubMate Studio Pro Environment Ready!"
echo "====================================================================="
echo "  • Python Virtualenv: .venv/ (Isolated)"
echo "  • Audio/Video Engine: tools/ffmpeg, tools/ffprobe (Isolated)"
echo "  • Multiplayer Engine: tools/cloudflared (Isolated)"
echo "  • Global System State: UNTOUCHED (Zero global pollution)"
echo "====================================================================="
echo ""

read -p "Would you like to launch DubMate Studio Pro now? [Y/n]: " LAUNCH
LAUNCH=${LAUNCH:-Y}
if [[ "$LAUNCH" =~ ^[Yy]$ ]]; then
    chmod +x run_mac.sh
    ./run_mac.sh
else
    echo "You can launch the studio anytime by running ./run_mac.sh"
fi
