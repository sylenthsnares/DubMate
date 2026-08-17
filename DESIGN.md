---
name: DubMate Studio Pro
description: Warm Wood & Minimalist Analog Guitar Amp Studio DAW
colors:
  bg-darkest: "#12100e"
  bg-surface-0: "#15120f"
  bg-surface-1: "#1a1714"
  bg-surface-2: "#221e19"
  bg-surface-3: "#28221b"
  bg-input: "#15120f"
  wood-dark: "#3d2b1f"
  wood-mid: "#352c23"
  wood-border: "#443428"
  wood-tick: "#614f3f"
  border-subtle: "rgba(244, 237, 228, 0.07)"
  border-wood: "#443428"
  border-active: "#d97706"
  text-primary: "#f4ede4"
  text-muted: "#a89f95"
  text-dim: "#73685e"
  accent-amber: "#d97706"
  accent-amber-light: "#f59e0b"
  accent-amber-glow: "rgba(217, 119, 6, 0.35)"
  accent-brass: "#cca458"
  accent-red: "#dc2626"
  accent-red-glow: "rgba(220, 38, 38, 0.4)"
  accent-teal: "#16a34a"
  accent-teal-glow: "rgba(22, 163, 74, 0.35)"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(2rem, 4vw, 2.75rem)"
    fontWeight: 800
  title-lg:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "22px"
    fontWeight: 800
  h2:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 800
  h3:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 700
  body:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  body-sm:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  prompter:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "19px"
    fontWeight: 500
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "11px"
    fontWeight: 700
  mono-sm:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "10px"
    fontWeight: 700
rounded:
  micro: "1px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
---

# Design System: DubMate Studio Pro (Warm Wood & Analog Studio Overhaul)

## Overview

DubMate Studio Pro features a warm wood tone, minimalist studio aesthetic combining ShadCN / Radix UI component ergonomics with vintage analog audio hardware (walnut rack cheeks, brushed brass accents, and authentic guitar amp rotary dials for voice DSP modulation).

## Color Hierarchy

- **Canvas (`--background`)**: `#12100e` — Dark espresso darkroom base with subtle warm radial undertones.
- **Card Surface (`--card`)**: `#1a1714` — Warm dark walnut slate elevation for panels and dialogs.
- **Card Header (`--card-header`)**: `#201c18` — Subtle elevated section dividers.
- **Primary Accent (`--primary`)**: `#d97706` — Vintage tube amber for dials, active playhead, and primary CTAs.
- **Hardware Brass (`--accent-brass`)**: `#cca458` — Brushed brass labels and channel meters.
- **Pilot Lamp Red (`--accent-red`)**: `#dc2626` — Vintage pilot jewel tally on recording trigger.
- **Confirmed Take Green (`--accent-teal`)**: `#16a34a` — Studio take confirmed status.
- **Typography (`--foreground`)**: `#f4ede4` — Warm ivory text with zero harsh neon glare.

## Key UI Components

1. **Analog Guitar Amp Dials (`AnalogKnob`)**:
   - 270° sweep with calibrated tick rings, knurled dial skirts, and white/amber indicator notches.
   - Supports vertical mouse drag (standard DAW/VST feel), scroll wheel, and keyboard navigation.
   - Fully synchronized with the Web Audio DSP graph.
2. **ShadCN Segmented Controls & Buttons**:
   - Segmented capsule tabs (`Create Room` vs `Join Code`, `16:9 Cinema` vs `9:16 Shorts`).
   - Hairline borders (`1px solid #2d251e`) with clean button variants.
3. **Studio Hardware Racks (`.rack-wood-frame`)**:
   - Walnut wood side cheeks (`#3d2b1f`) with inset console shadows.
4. **Header Navigation & Exit Control**:
   - Dedicated "Leave Room / Exit Session" action and back navigation to scene explorer.
