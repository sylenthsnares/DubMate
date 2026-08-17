# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Semi-pro voice actors, streamers, anime content creators, and collaborative ADR dubbing groups producing polished scene dubs for social media, YouTube, and portfolio showcases.

## Product Purpose

DubMate Studio Pro is a high-performance web Digital Audio Workstation (DAW) and multiplayer scene dubbing suite. It enables actors to cast character roles, record voice lines with visual waveform alignment against original dialogue, shape voice tracks with studio-grade DSP (time-invariant pitch shifting, acoustic reverb, dynamic compression, de-hum low-cut), and screen the synchronized dubbed scene together live before exporting a master MP4 video.

## Positioning

The only browser-native ADR voice dubbing studio combining sub-millisecond visual waveform sync, hardware-calibrated Web Audio DSP, and synchronized multiplayer premiere theater without requiring heavy desktop software installation.

## Operating Context

Desktop studio workstations and creator setups using headphones and dedicated USB/XLR microphones. Fast keyboard-driven workflow (`Space` for instant punch-in recording, `[` / `]` for micro-nudge sync adjustments, quick line stepping) in low-light studio environments.

## Capabilities and Constraints

- **Audio Engine**: Real-time Web Audio API with non-destructive DSP graph (gain boost, pitch shift, convolution reverb, biquad low-cut filter, dynamics compressor).
- **Dual-Waveform Sync**: Interactive canvas with millisecond visual envelope matching, mouse/touch drag scrubbing, and fine-tuning nudges (-800ms to +800ms).
- **Collaboration**: Real-time WebSocket room synchronization for casting assignments, actor readiness HUD, and synchronized host premiere playback.
- **Master Export**: Server-side FFmpeg pipeline merging multi-track actor audio takes with background M&E (Music & Effects) stems into high-bitrate MP4 video.
- **Performance**: Zero layout-thrashing animations, GPU-accelerated transforms, sub-160ms micro-interactions.

## Brand Commitments

- **Name**: DubMate Studio Pro
- **Aesthetic**: Pro-Audio DAW & Broadcast Hardware Suite (Obsidian dark surfaces, precision faders, on-air tally lights, VU amber meters, hardware-style tactile controls).
- **Tone**: Professional, focused, precision-engineered, zero generic AI slop.

## Evidence on Hand

- Fully functional FastAPI + WebSocket backend (`app.py`, `pack_loader.py`, `audio_processor.py`).
- Complete client-side audio engine (`audio_engine.js`, `waveform.js`, `room_socket.js`).
- Shipped scene packs with split vocal and backing audio tracks in `Packs/`.

## Product Principles

1. **Precision Hardware Tactility**: Every fader, knob, toggle, and record trigger must evoke high-end studio rack equipment.
2. **Speed & Zero Friction**: Keyboard-driven actions (`Space`, `[`, `]`, `Enter`) must respond instantaneously without animation lag or layout thrash.
3. **Hierarchy of Focus**: Video viewport, dialogue prompter, and dual waveform alignment command the center of visual attention; controls remain crisp and uncluttered.
4. **Frictionless Collaboration**: Casting assignments, live actor status, and the transition from booth recording to group premiere theater are transparent and seamless.

## Accessibility & Inclusion

- WCAG 2.1 AA compliant text contrast across all dark surfaces (minimum 4.8:1 for secondary copy, 7:1+ for dialogue).
- Full keyboard navigation with distinct `:focus-visible` studio rings.
- Explicit ARIA names, ranges, and live value text for all DSP sliders and nudge controls.
- `prefers-reduced-motion` compliance providing intentional non-moving state changes.
