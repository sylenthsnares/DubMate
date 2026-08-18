#!/bin/bash
cd "$(dirname "$0")"

# 1. Self-Healing Check
if [ ! -d ".venv" ] && [ ! -d "venv" ]; then
    echo "[SETUP] Project-local virtual environment not found."
    echo "Running 1-click setup installer..."
    chmod +x setup_dubmate_mac.sh
    ./setup_dubmate_mac.sh
fi

# 2. Add local tools/ directory to runtime PATH
if [ -d "tools" ]; then
    export PATH="$PWD/tools:$PATH"
fi

# 3. Resolve Python binary
PY_BIN="python3"
if [ -f ".venv/bin/python3" ]; then
    PY_BIN=".venv/bin/python3"
elif [ -f "venv/bin/python3" ]; then
    PY_BIN="venv/bin/python3"
fi

echo "======================================================"
echo "    🎙️ Starting DubMate Multiplayer Studio on macOS"
echo "======================================================"
echo ""
echo "Studio will be available at: http://localhost:8000"
echo ""

$PY_BIN app.py
