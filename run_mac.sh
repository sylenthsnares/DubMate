#!/bin/bash
cd "$(dirname "$0")"

# Activate virtual environment if it exists
if [ -d "venv" ]; then
    source venv/bin/activate
fi

echo "======================================================"
echo "    🎙️ Starting DubMate Multiplayer Studio on macOS"
echo "======================================================"
echo ""
echo "Studio will be available at: http://localhost:8000"
echo ""

python3 app.py
