# DubMate Studio DSP & Architecture Redesign Specification

**Date:** 2026-08-17  
**Status:** Approved  
**Topic:** Professional Voice DSP Pipeline, Audio Routing Isolation, Live Cast HUD, Solo Booth Role Track & Group Screening Readiness Gate

---

## 1. Overview & Problem Statement

The studio addresses multi-actor collaboration and audio fidelity:
1. **Audio Doubling & Bleed**: Muted `<video>` stage with isolated Web Audio sub-busses.
2. **Pitch Shift Speed Distortion**: Granular SOLA pitch shifter preserves 100% time-invariance across $\pm 12$ semitones.
3. **Take Re-recording Audio Cache Bug**: Dynamic URL versioning (`?v=...`) and explicit `bufferCache` eviction prevent replaying stale takes.
4. **Cast HUD & Actor Visibility**: Real-time awareness showing each actor's current line, % progress, and location.
5. **Solo Booth Role Isolation**: Actors are focused on their own assigned characters without crossover.
6. **Group Premiere Gate**: "Ready for Screening" consensus gate and synchronized group warp into the Finale Screening Room.

---

## 2. Audio Engine & DSP Architecture

### 2.1 Time-Invariant Granular Pitch Shifter
- **Engine**: Granular Overlap-Add (SOLA) processor implemented in Web Audio.
- **Pitch Range**: $-12$ to $+12$ semitones.
- **Time Invariance**: Preserves exact sample duration, syllable pacing, and video cue alignment regardless of pitch shifting amount.
- **Performance**: High-speed grain processing ($1024/256$) with zero main-thread CPU blocking.

### 2.2 Acoustic Room Reverb Engine
- **Algorithmic Impulse Generator**: Generates realistic room reflections across spatial dimensions:
  - **Decay Time**: $0.2\text{s}$ (Dry Studio Booth) to $4.0\text{s}$ (Cathedral/Cavern).
  - **Room Size**: Adjusts stereo diffusion and reflection density.
  - **Pre-Delay**: $0\text{ms}$ to $60\text{ms}$ to preserve vocal transients before reverberation kicks in.
  - **Wet/Dry Mix**: $0\%$ to $100\%$ slider.

### 2.3 Advanced Studio Vocal Rack
- **$80\text{Hz}$ High-Pass Filter**: Second-order Butterworth filter ($12\text{dB}/\text{octave}$) removing low-frequency desk rumbles, fan hum, and plosive thumps.
- **Studio Vocal Compressor**:
  - Threshold: $-24\text{dB}$, Ratio: $3:1$, Attack: $15\text{ms}$, Release: $150\text{ms}$.
  - Levels speech dynamics so loud shouts don't clip and soft whispers remain audible.
- **Volume Gain**: $-12\text{dB}$ to $+12\text{dB}$ master vocal trim.

---

## 3. Isolated Audio Bus Routing & Monitoring

### 3.1 Zero-Bleed Video Stage
- The HTML5 `<video>` element is permanently muted (`video.muted = true`, `video.volume = 0`). The video player acts exclusively as a visual frame display driven by the Web Audio clock.

### 3.2 Four Isolated Mix Sub-Busses
```
Master Audio Destination
├── [1] Backing Track Sub-Bus (Independent volume slider: 0%–100%)
├── [2] Vocal Take Sub-Bus    (Your take + Nudge + Time-Invariant Pitch + Reverb + Compressor)
├── [3] Reference Sub-Bus     (Original character audio clip, isolated)
└── [4] Metronome Sub-Bus     (Gentle smoothed cosine envelope at -14dB)
```

### 3.3 Monitoring Modes & A/B Comparison
- **Take Preview**: Plays **only** the Backing Track and Your Take with applied effects and millisecond offset.
- **Original Reference Listen**: Plays the Backing Track and the original character clip.
- **Instant A/B Switch**: A one-click toggle `[ A: Your Dub ] ⇄ [ B: Original ]` during playback enables real-time A/B switching between the actor's dub and the original voice.
- **🎧 Guide Voice in Headphones**: Option to hear the reference voice in headphones during recording.

---

## 4. Cast HUD, Role Isolation & Group Premiere Gate

### 4.1 Live Cast Activity & Progress HUD
- Real-time Cast drawer visible across Lobby and Studio:
  - Actor Name + Avatar + Assigned Character(s).
  - Live progress: e.g. `Tani (Deku): Line 5/9 (55%) • Recording Line 5`.
  - Current location: `🎙️ In Booth` / `🍿 In Screening Room` / `🏠 In Lobby`.

### 4.2 Solo Booth Role Track Isolation
- In Solo Booth mode, timeline chips and navigation strictly cycle through your assigned character's lines.
- Prevents accidental overwrites or distractions from other cast members' assigned lines.

### 4.3 Group Premiere Ready Gate & Synchronized Warp
- **Actor Readiness**: Each actor clicks **`✅ Mark Ready for Screening`** when they finish their takes.
- **Host Launch Premiere**: Once cast is ready (or with group agreement), the Host clicks **`🎬 Launch Group Premiere`**.
- **Synchronized Warp**: Server broadcasts `warp_to_screening`—all connected actors' browsers transition to the Finale Screening Room simultaneously.

---

## 5. Backend Matching Export Pipeline

`audio_processor.py` runs an equivalent DSP filter chain in `ffmpeg` on export:
- **Millisecond Latency Offset**: Sample-accurate position shifting ($t = \text{start} + \frac{\text{offset\_ms}}{1000}$).
- **Pitch Shift with Speed Lock**: Chained `asetrate` + `atempo` or `rubberband` preserving exact duration.
- **High-Pass Filter**: `highpass=f=80`.
- **Vocal Compression**: `compand=attacks=0.015:decays=0.15:points=-80/-80|-24/-24|0/-6`.
- **Acoustic Reverb**: Matched wet/dry and decay time.
- **Unassigned Lines**: Original character dialogue automatically filled into the mix.
- **Final Video**: Chained with H.264/AAC MP4 export (`-preset veryfast -crf 20 -c:a aac -b:a 192k`).
