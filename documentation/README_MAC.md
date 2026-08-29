# 🍎 DubMate — macOS Setup & Quick Start Guide

This guide will walk you through running **DubMate** locally or over the internet on macOS (Apple Silicon M1/M2/M3/M4 or Intel).

---

## 🚀 1-Click Directory-Isolated Setup

DubMate installs all Python packages and portable tools **strictly inside the project folder** (`.venv/` and `tools/`). Nothing is installed globally.

### 1. Run the 1-Click Setup Script
Open Terminal in the DubMate project root (the folder containing `app.py`):
```bash
chmod +x setup_dubmate_mac.sh run_mac.sh update.sh
./setup_dubmate_mac.sh
```

*This automatically provisions a local Python `.venv/`, installs all required audio DSP dependencies, and configures portable FFmpeg & Cloudflare binaries in `tools/`.*

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

## 🔄 Updating DubMate on macOS

To update DubMate to the latest version from GitHub:
```bash
chmod +x update.sh
./update.sh
```

---

## 📦 Adding Scene Packs on Mac

1. Place extracted scene pack folders into the `Packs/` directory.
2. In the DubMate web interface, click **↺ Rescan Packs** on the home screen to load them immediately.
