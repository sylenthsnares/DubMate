#!/bin/bash
cd "$(dirname "$0")"

echo "====================================================================="
echo "         🎙️  DubMate Studio Pro — Repository Updater (macOS) 🚀"
echo "====================================================================="
echo ""
echo "Checking for the latest updates from GitHub (sylenthsnares/DubMate)..."
echo ""

# 1. Verify Git
if ! command -v git &> /dev/null; then
    echo "[ERROR] Git is not installed or not in PATH."
    echo "Please install Git via Homebrew: brew install git"
    exit 1
fi

# 2. Check Git repo
if [ ! -d ".git" ]; then
    echo "[SETUP] Git repository metadata not found. Initializing remote..."
    git init
    git remote add origin https://github.com/sylenthsnares/DubMate.git
fi

# 3. Pull latest updates
echo "[1/3] Pulling latest code and features from origin/main..."
git fetch origin main
git pull origin main || {
    echo "[WARNING] Pull had conflicts, stashing local changes..."
    git stash
    git pull origin main
}

# 4. Update Isolated Python Dependencies
echo ""
echo "[2/3] Updating Python dependencies in .venv/..."
if [ -f ".venv/bin/python3" ]; then
    ./.venv/bin/python3 -m pip install --upgrade -r requirements.txt
elif [ -f "venv/bin/python3" ]; then
    ./venv/bin/python3 -m pip install --upgrade -r requirements.txt
else
    echo "[SETUP] .venv not found. Running setup script..."
    chmod +x setup_dubmate_mac.sh
    ./setup_dubmate_mac.sh
fi

# 5. Check Local Tools
echo ""
echo "[3/3] Checking project-local tools (tools/)..."
mkdir -p tools
if [ ! -x "tools/ffmpeg" ] || [ ! -x "tools/ffprobe" ]; then
    echo "[NOTICE] Local FFmpeg binaries missing. Running setup script..."
    chmod +x setup_dubmate_mac.sh
    ./setup_dubmate_mac.sh
fi

echo ""
echo "====================================================================="
echo "  ✅ DubMate Studio Pro is completely updated and ready to play!"
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
