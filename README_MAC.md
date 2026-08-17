# 🍎 DubMate — macOS Setup & Quick Start Guide

This guide will walk you through running **DubMate** locally or over the internet on macOS (Apple Silicon M1/M2/M3/M4 or Intel).

---

## 📋 Prerequisites

Open **Terminal** on your Mac (`Cmd + Space`, type `Terminal`, and press `Enter`).

### 1. Install Homebrew (if not already installed)
Homebrew is the standard package manager for macOS:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Install Python 3 & FFmpeg
DubMate uses Python for the backend server and FFmpeg for video rendering and audio mastering:
```bash
brew install python ffmpeg
```

---

## 🚀 Installation & Setup

### 1. Clone or Open the Repository
Navigate to the directory where DubMate is located:
```bash
cd path/to/DubMate
```

### 2. Set Up a Virtual Environment (Recommended)
```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

---

## 🎙️ Running DubMate

### Option A: Local Studio / Same Wi-Fi Network
Start the studio server:
```bash
python3 app.py
```
*(Or run `./run_mac.sh` after making it executable with `chmod +x run_mac.sh`)*

1. Open your browser (**Google Chrome**, **Brave**, **Safari**, or **Firefox**).
2. Go to: **`http://localhost:8000`**
3. When prompted, allow **Microphone Access** in the browser.

---

### Option B: Internet Multiplayer with Friends (Free Cloudflare Tunnel)
Host an online room without port-forwarding:

1. In a new Terminal tab, install `cloudflared`:
   ```bash
   brew install cloudflared
   ```
2. Start the DubMate server in tab 1:
   ```bash
   python3 app.py
   ```
3. Start the tunnel in tab 2:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
4. Copy the generated `https://xxxx.trycloudflare.com` public link and send it to your friends!

---

## 🔒 macOS Microphone Permissions Troubleshooting

If the browser does not capture microphone audio:
1. Open **System Settings** on macOS.
2. Go to **Privacy & Security** → **Microphone**.
3. Ensure the toggle is **ON** for your web browser (e.g., Google Chrome, Safari, Brave).
4. Restart your browser and reload `http://localhost:8000`.

---

## 📦 Adding Scene Packs on Mac

1. Place extracted scene pack folders into the `Packs/` directory.
2. In the DubMate web interface, click **↺ Rescan Packs** on the home screen to load them immediately.
