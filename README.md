# 🎙️ DubMate Studio Pro — Collaborative Multiplayer Voice Dubbing DAW

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Python: 3.10+](https://img.shields.io/badge/Python-3.10+-brightgreen.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Modern%20Async%20Backend-009688.svg)](https://fastapi.tiangolo.com/)
[![Web Audio API](https://img.shields.io/badge/Web%20Audio%20API-Hardware--Calibrated%20DSP-orange.svg)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-Hardware%20Accelerated-555555.svg)](https://ffmpeg.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()

**DubMate Studio Pro** is a high-performance, browser-native Digital Audio Workstation (DAW) and real-time multiplayer scene dubbing suite. It allows voice actors, streamers, content creators, and friends to jump into shared online rooms, claim character roles on an interactive casting board, record lines with instant dual-waveform visual alignment, sculpt takes using vintage analog DSP hardware controls, screen the mastered scene live in the Premiere Theater, and export multi-format master videos or full NLE-ready DAW project bundles.

---

## 📑 Table of Contents

- [✨ Key Features](#-key-features)
- [🏗️ System Architecture](#️-system-architecture)
- [🚀 Quick Start](#-quick-start)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Launching the Studio (Windows)](#launching-the-studio-windows)
  - [Launching the Studio (macOS)](#launching-the-studio-macos)
  - [Launching on Linux / Manual](#launching-on-linux--manual)
- [📦 Scene Packs Guide](#-scene-packs-guide)
  - [Downloading & Installing Packs](#downloading--installing-packs)
  - [Supported Pack Formats](#supported-pack-formats)
- [⌨️ Keyboard Shortcuts](#️-keyboard-shortcuts)
- [📁 Project ZIP Export Structure](#-project-zip-export-structure)
- [🧪 Automated Testing & QA](#-automated-testing--qa)
- [📜 Licensing & Attribution](#-licensing--attribution)
- [⚖️ Fair Use & Media Disclaimer](#️-fair-use--media-disclaimer)

---

## ✨ Key Features

### 🌐 Real-Time Multiplayer Rooms & Live Casting Board
- **Instant Room Creation**: Host private sessions with 6-character room codes or shareable one-click links.
- **Zero-Config Internet Play**: Launch public rooms across the web without port forwarding using built-in Cloudflare Tunnels (`run_cloudflare.bat`).
- **Interactive Character Casting**: Assign actors to specific characters; support for multi-character casting and solo workflows.
- **Live Cast Activity HUD**: Monitor online presence, line completion progress, and actor readiness status in real time.
- **Flexible Workflow Modes**:
  - **Solo Recording Booth**: Record your assigned lines self-paced without waiting on others.
  - **Synced Studio Prompter**: Step through dialogue chronologically as a group.

### 🎛️ Virtual Voice Booth & Analog DSP Deck
- **Tactile Rotary Amp Dials**: Authentic 270° sweep knobs with vertical drag, scroll wheel, and keyboard controls.
- **Studio DSP Effects Chain**:
  - **Time-Invariant Pitch Shifter**: Pitch shift voices from `-12 st` to `+12 st` while preserving exact dialogue duration.
  - **Acoustic Room Convolution Reverb**: Wet/Dry mix dial, adjustable decay (0.2s–4.0s), and pre-delay (0ms–60ms).
  - **Vocal Boost Gain**: Calibrated `-12 dB` to `+12 dB` linear boost.
  - **80Hz Low-Cut Filter**: Eliminates low-frequency desk rumble, HVAC hum, and mic plosives.
  - **Studio Dynamics Compressor & Soft-Knee Limiter**: Transparent mastering limiter preventing digital clipping.
- **Dual-Waveform Sample Alignment**:
  - Visual overlay comparing the original Japanese/English reference waveform against the actor's take.
  - Interactive canvas scrub and click-and-drag offset shifting.
  - Fine-tuning nudge controls (`[-800ms, +800ms]` range with `±25ms` and `±100ms` quick steps).
- **Fast Punch-In Workflow**: Spacebar instant recording, audible count-in click metronome, in-headphone guide voice, and instant A/B reference switching.

### 🍿 Finale Screening Theater & Stem Balance Mixer
- **Synchronized Premiere Screening**: Watch the complete dubbed video together in real-time with synchronized actor tracks and background audio.
- **Host Transport Controls**: Shared play, pause, and seek commands synchronized across all connected cast members.
- **Master Stem Balance**: Live slider blending between the background M&E (Music & Effects) stem and recorded vocal takes.

### 🎬 Multi-Format Master Video & DAW Project Export
- **Dual Video Aspect Ratios**:
  - **16:9 Cinema Widescreen**: Standard high-definition video master.
  - **9:16 Vertical Letterbox**: Formatted for TikTok, YouTube Shorts, and Instagram Reels without cropped dialogue.
- **Hardware-Accelerated Encoding**: Auto-detects NVIDIA NVENC, AMD AMF, Intel QuickSync, Apple Silicon VideoToolbox, or optimized multi-core CPU encoding.
- **NLE-Ready Multi-Track Project Bundle (.zip)**: Export isolated continuous character stems, raw takes, clean video, backing music, cuesheet, and JSON timeline markers.

### 📦 Dual-Engine Scene Pack Compatibility
- **100% Native Support**: Seamlessly loads both **DubStage** packs and **Choicer Voicer** packs.
- **In-Browser Scene Search**: Instant search filtering across scene titles, authors, characters, and dialogue line keywords (press `/` to focus).
- **Drag-and-Drop .ZIP Importer**: Drop any GameBanana scene pack zip directly onto the web interface to unpack and index automatically.
- **Live Rescan**: Reload newly placed packs instantly without restarting the server.

---

## 🏗️ System Architecture

```
DubMate Studio Pro
├── Backend (FastAPI + WebSockets + Uvicorn)
│   ├── app.py                # REST API, WebSocket room coordinator & cache pruner
│   ├── pack_loader.py         # Dual-engine scene pack parser (DubStage & Choicer Voicer)
│   ├── audio_processor.py     # NumPy/SciPy DSP, FFT convolution reverb, FFmpeg mastering
│   └── requirements.txt       # Minimal, zero-bloat dependencies
├── Frontend (Modern Vanilla JS + CSS3 + Web Audio API)
│   ├── static/index.html      # Responsive Studio DAW interface & semantic DOM
│   ├── static/css/style.css   # Warm Wood & Analog Hardware Studio design system
│   ├── static/js/app.js       # Core application controller & stage state machine
│   ├── static/js/audio_engine.js # Web Audio API DSP graph (Gain, Filter, Compressor, Reverb)
│   ├── static/js/knob.js      # Tactile 270° rotary guitar amp dial components
│   ├── static/js/waveform.js  # Dual-waveform visual alignment & canvas renderer
│   └── static/js/room_socket.js # Real-time WebSocket synchronization client
├── Scene Packs & Storage
│   ├── Packs/                 # Scene pack library directory
│   ├── tools/                 # Project-local portable binaries (FFmpeg, FFprobe, Cloudflared)
│   ├── .venv/                 # Project-local isolated Python virtual environment
│   └── .cache/                # Automated lightweight transcode & single-session storage
└── Launchers & Tooling
    ├── setup_dubmate_win.bat  # Windows 1-click isolated dependency installer
    ├── setup_dubmate_mac.sh   # macOS/Linux 1-click isolated dependency installer
    ├── run_web_studio.bat     # Windows self-healing local launcher
    ├── run_cloudflare.bat     # Windows self-healing internet multiplayer launcher
    ├── update_dubmate.bat     # Windows 1-click repository & dependencies updater
    ├── run_mac.sh             # macOS self-healing launcher script
    ├── update_mac.sh          # macOS 1-click repository & dependencies updater
    └── README_MAC.md          # Dedicated macOS setup guide
```

---

## 🚀 Quick Start (Zero Global Pollution)

DubMate Studio Pro installs all Python packages and portable media tools **strictly inside the project folder** (`.venv/` and `tools/`). **No packages or binaries are installed globally on your system, and your system PATH is never modified.**

### 1-Click Installation & Setup

1. **Clone or download this repository**:
   ```bash
   git clone https://github.com/sylenthsnares/DubMate.git
   cd DubMate
   ```

2. **Run the 1-Click Dependency Installer**:
   - **Windows**: Double-click **`setup_dubmate_win.bat`**
   - **macOS / Linux**: Run `./setup_dubmate_mac.sh`

   *The installer automatically provisions a local virtual environment (`.venv`), installs required DSP and web packages, and downloads portable static builds of **FFmpeg**, **FFprobe**, and **Cloudflared** directly into `tools/`.*

---

### Launching the Studio (Windows)

#### Option A: Local Network (LAN / Same Wi-Fi)
Double-click **`run_web_studio.bat`**.
- The studio will automatically open in your default browser at **`http://localhost:8000`**.
- Other computers/tablets on the same network can join via your local IP address (e.g., `http://192.168.1.50:8000`).
- *Self-Healing*: If you haven't run setup yet, `run_web_studio.bat` will automatically set up local dependencies first!

#### Option B: Internet Multiplayer (Cloudflare Tunnel)
Double-click **`run_cloudflare.bat`**.
- Automatically launches the backend and spins up a secure public Cloudflare tunnel.
- Copy the generated `https://xxxx.trycloudflare.com` URL and send it to your voice cast anywhere in the world!

---

### 🔄 Updating DubMate to the Latest Version

Whenever a new version of DubMate is released on GitHub, update your system in one click:
- **Windows**: Double-click **`update_dubmate.bat`**.
- **macOS / Linux**: Run `./update_mac.sh`.

*The updater automatically pulls the latest code, stashes any local conflicts, updates Python dependencies inside `.venv/`, verifies local `tools/` binaries, and prompts you to launch the studio immediately.*

---

### Launching the Studio (macOS / Linux)

See the dedicated [macOS Setup & Quick Start Guide (README_MAC.md)](README_MAC.md) for full instructions:

```bash
# 1. 1-Click Setup
chmod +x setup_dubmate_mac.sh run_mac.sh update_mac.sh
./setup_dubmate_mac.sh

# 2. Launch
./run_mac.sh
./run_mac.sh
```

---

### Launching on Linux / Manual

```bash
python app.py
```
Open `http://localhost:8000` in Google Chrome, Brave, Edge, Firefox, or Safari.

---

## 📦 Scene Packs Guide

### Downloading & Installing Packs

1. **Download Scene Packs**:
   - Browse community packs on [GameBanana Choicer Voicer Mods](https://gamebanana.com/mods/cats/44064) or extract existing DubStage packs.
2. **Install into DubMate**:
   - **Method A (Web Drag & Drop)**: Drop the downloaded `.zip` file directly onto the DubMate home screen or click **Import .ZIP**.
   - **Method B (Manual Folder)**: Extract the pack folder directly into the `Packs/` directory.
3. **Rescan**:
   - Click **↺ Rescan** in the top-right corner of the scene browser to refresh the library instantly without server restarts.

### Supported Pack Formats

DubMate natively reads and converts both major scene pack formats:

#### 1. DubStage Format
```
Packs/Scene_Name/
├── dub_video.mp4 (or .ogv / .mkv / .webm)
├── _backing_track.wav (Music & SFX)
├── _captions.json (Optional subtitle & character mappings)
├── _TIMESTAMPS.txt (Optional timestamp references)
├── 01_Levi_0-120.wav (Dialogue audio with embedded timestamp)
└── cover.png (Cover art)
```

#### 2. Choicer Voicer Format
```
Packs/Scene_Name/
├── dub_video.mp4
├── _pack_info.ini (Metadata: title, subtitle, author, icon)
├── _backing_track.wav
├── line_1.ini (Caption, timestamps, character metadata)
├── line_1.wav (Audio reference take)
└── icon.png
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Space` | Recording Booth | **Punch-In Record** / Stop Recording |
| `[` | Recording Booth | Nudge take **-25ms earlier** |
| `]` | Recording Booth | Nudge take **+25ms later** |
| `Shift + [` | Recording Booth | Nudge take **-100ms earlier** |
| `Shift + ]` | Recording Booth | Nudge take **+100ms later** |
| `0` | Recording Booth | Reset timing offset to `0 ms` |
| `A` | Recording Booth | Toggle **A/B Audio Comparison** (Dub vs Original) |
| `P` | Recording Booth | **Preview Take** with Backing Track |
| `O` | Recording Booth | Play Original Reference Clip |
| `←` / `→` | Recording Booth | Step to Previous / Next Dialogue Line |
| `/` | Scene Browser | Focus instant pack search bar |
| `Esc` | Anywhere | Clear search input / close active dialogs |

---

## 📁 Project ZIP Export Structure

When you click **📦 Download Full Project (.zip)** in the Premiere Theater, DubMate bundles a complete, non-destructive NLE project archive ready for import into **Adobe Premiere Pro**, **DaVinci Resolve**, **Reaper**, **Final Cut Pro**, or **Audacity**:

```
DubMate_Project_[SceneName]_[RoomID]/
├── Video/
│   └── [SceneName]_Clean_Video.mp4           # Pristine scene video without burnt-in vocals
├── Audio_Stems/
│   ├── Backing_Music_SFX.mp3                 # Isolated M&E (Music & Effects) backing stem
│   ├── Master_Vocal_Mix.mp3                  # Master blended vocal track (all actors combined)
│   └── Character_Stems/
│       ├── [Character1]_[ActorName].mp3      # Continuous timeline-padded stem from t=0
│       └── [Character2]_[ActorName].mp3      # Continuous timeline-padded stem from t=0
├── Raw_Takes/
│   ├── Line_01_[Character]_[Actor] [00.00-00.03].mp3 # Individual dialogue takes with timestamps
│   └── Line_02_[Character]_[Actor] [00.05-00.09].mp3
├── Timeline_Cues.txt                         # Formatted cuesheet with DSP settings & dialogue
└── project_manifest.json                     # Machine-readable JSON metadata & timeline markers
```

---

## 🧪 Automated Testing & QA

DubMate includes comprehensive automated backend and frontend test suites to ensure 100% stability across all engines:

### Run Backend & Audio DSP Test Suite
```bash
python test_systematic.py
```
*Validates pack loader parsing, character bracket extraction, time-invariant pitch shifting, convolution reverb, soft limiter dynamics, REST endpoints, room lifecycles, and project ZIP bundling.*

### Run Frontend & DOM Test Suite
```bash
node test_frontend.js
```
*Validates DOM state machines, live pack search filtering, rotary knob ranges, WebSocket reconnection handlers, and project ZIP triggers via JSDOM.*

---

## 📜 Licensing & Attribution

DubMate is open-source software licensed under the **[GNU General Public License v3.0 (GPLv3)](LICENSE)**.

### Attribution
- DubMate was inspired by and maintains 100% interoperability with the pack format established by **[DubStage by xmrius](https://github.com/xmrius/dubstage)** (licensed under GPL-3.0).

---

## ⚖️ Fair Use & Media Disclaimer

All anime video clips, character voice tracks, background music, sound effects, and visual assets included in third-party scene packs remain the sole intellectual property of their respective creators, animation studios, and copyright holders.

DubMate is an open-source voice-acting, educational, and accessibility practice tool designed for transformative dubbing practice, commentary, parody, and vocal training under **Fair Use** principles (17 U.S.C. § 107). DubMate does not sell, license, or claim ownership over any third-party media assets.
