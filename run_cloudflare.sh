#!/bin/bash
# macOS counterpart of run_cloudflare.bat: starts DubMate and opens a public
# Cloudflare tunnel so friends can join over the internet.
cd "$(dirname "$0")" || exit 1

PORT=8000

echo "======================================================"
echo "    DubMate (with room codes)"
echo "======================================================"
echo ""

# 1. Self-Healing: run setup first if the project-local environment is missing
if [ ! -d ".venv" ] && [ ! -d "venv" ]; then
    echo "[SETUP] Project-local virtual environment not found."
    echo "Running 1-click setup installer..."
    echo ""
    chmod +x setup_dubmate_mac.sh
    ./setup_dubmate_mac.sh
    if [ ! -d ".venv" ] && [ ! -d "venv" ]; then
        echo "[ERROR] Setup could not be completed."
        exit 1
    fi
fi

# Resolve Python binary the same way run_mac.sh does
PY_BIN="python3"
if [ -f ".venv/bin/python3" ]; then
    PY_BIN=".venv/bin/python3"
elif [ -f "venv/bin/python3" ]; then
    PY_BIN="venv/bin/python3"
fi

# 2. Free the port from any lingering engine
free_port() {
    PIDS=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
    if [ -n "$PIDS" ]; then
        # shellcheck disable=SC2086
        kill $PIDS 2>/dev/null
    fi
}
free_port

# 3. Find or download cloudflared into tools/
mkdir -p tools
CF_BIN="tools/cloudflared"
if [ ! -x "$CF_BIN" ]; then
    echo "[SETUP] cloudflared not found in tools/"
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
        echo "Downloading cloudflared for $OS_TYPE ($ARCH) into tools/..."
        curl -fsSL "$CF_URL" -o "$CF_BIN" || rm -f "$CF_BIN"
        chmod +x "$CF_BIN" 2>/dev/null
    fi

    if [ ! -x "$CF_BIN" ]; then
        echo "[ERROR] Could not download cloudflared. Please run ./setup_dubmate_mac.sh."
        exit 1
    fi
    echo "[SETUP] cloudflared installed in tools/"
fi

# 4. Start the engine in the background through run_mac.sh
echo "[1/2] Starting DubMate on port $PORT..."
chmod +x run_mac.sh
./run_mac.sh > /dev/null 2>&1 &

# Stop the engine when the tunnel closes or the window is interrupted
trap 'echo ""; echo "Tunnel closed. Stopping server..."; free_port' EXIT

# Give the server a moment to bind to the port
sleep 3

# 5. Start the Cloudflare tunnel and show the public URL.
#    Routed through run_tunnel.py so the engine is told its own public URL;
#    otherwise room codes never reach the public registry.
echo "[2/2] Starting Cloudflare Public Tunnel..."
echo ""
echo "======================================================"
echo "  Look for your public URL below:"
echo "  https://xxxx-xxxx-xxxx.trycloudflare.com"
echo "======================================================"
echo ""

"$PY_BIN" scripts/run_tunnel.py --cloudflared "$CF_BIN" --port "$PORT"
