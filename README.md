# 🎙️ DubMate — Multiplayer Anime & Video Dubbing Studio

DubMate is a real-time, browser-based collaborative voice dubbing DAW and party studio. Friends can jump into a shared room, claim character roles, record lines in a virtual voice booth with instant waveform visual alignment, tweak studio DSP effects, and screen the final mastered dubbed scene together in the Premiere Theater.

---

## ✨ Features

- 🌐 **Real-time Multiplayer Rooms**: Host or join dubbing sessions with room codes and instant link sharing.
- 🎙️ **Virtual Recording Booth**:
  - Sample-accurate waveform visualization with instant A/B reference switching.
  - Time-invariant SOLA pitch shifter (`-6 st` to `+6 st`).
  - Studio acoustic room convolution reverb and 80Hz de-hum filter.
  - Vocal boost gain dial (`-12 dB` to `+12 dB`) with transparent soft-knee mastering limiter.
- ⚡ **Ultra-Lightweight Voice Streaming**: Records microphone takes in WebM Opus (<40 KB per take), synchronizing across actors in milliseconds.
- 🍿 **Group Premiere Screening Room**: Watch the combined scene in real-time with synchronized video and actor voice tracks.
- 🎬 **Multi-Format Master Dub Export**: Export high-definition `.mp4` video in standard **16:9 widescreen** or **9:16 vertical letterbox** (TikTok, YouTube Shorts, Instagram Reels).
- 📦 **Scene Pack Engine**: 100% compatible with existing **DubStage** and **Choicer Voicer** scene packs.

---

## 🚀 Quick Start

### 1. Prerequisites
- **Python 3.10+** installed
- **FFmpeg** installed and available in your system `PATH`

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Launch Studio

#### Option A: Local Network / Same WiFi
Double-click **`run_web_studio.bat`** (or run `python app.py`).
Open your browser at **`http://localhost:8000`**.

#### Option B: Internet Multiplayer (Cloudflare Tunnel)
Double-click **`run_cloudflare.bat`**.
Share the generated `https://xxxx.trycloudflare.com` public room link with your friends!

---

## 📁 Scene Packs

Scene packs are placed in the `Packs/` folder.

1. **Download Dub Packs**:
   Visit [GameBanana Choicer Voicer Mods](https://gamebanana.com/mods/cats/44064) and download any scene pack (`.zip`).
2. **Convert with CVConvert**:
   Drag the `.zip` file onto `CVConvert/Convert.bat`.
3. **Load into DubMate**:
   Move the converted pack folder from `CVConvert/output/` into `Packs/` and click **Rescan Packs** in the web interface.

---

## 📜 Licensing & Open Source Attribution

DubMate is released under the **[GNU General Public License v3.0 (GPLv3)](LICENSE)**.

### Attribution
DubMate is inspired by and compatible with the scene pack format from **[DubStage by xmrius](https://github.com/xmrius/dubstage)** (licensed under GPL-3.0).

---

## ⚖️ Fair Use & Media Disclaimer

All anime video excerpts, background soundtracks, and original character voice clips included in third-party scene packs are the intellectual property of their respective creators, animation studios, and copyright holders. 

DubMate is an open-source voice-acting and educational tool designed for transformative dubbing practice, parody, education, and commentary under **Fair Use** guidelines. DubMate does not claim ownership of any third-party media assets.
