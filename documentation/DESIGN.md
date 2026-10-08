---
name: DubMate
description: A warm wood and brass dubbing studio, built like analog studio hardware
colors:
  espresso: "#12100e"
  espresso-deep: "#0c0a09"
  walnut: "#1a1714"
  walnut-header: "#201c18"
  walnut-popover: "#1f1b17"
  walnut-control: "#25201a"
  walnut-control-hover: "#302922"
  walnut-muted: "#221c17"
  input: "#15120f"
  input-border: "#352c24"
  border: "#2d251e"
  border-wood: "#443428"
  border-panel: "#3d2c1c"
  panel-deep: "#120e0b"
  panel-raised: "#2a221b"
  ivory: "#f4ede4"
  ivory-warm: "#f7eedd"
  ivory-muted: "#a89f95"
  ivory-dim: "#73685e"
  brass: "#cca458"
  amber: "#d97706"
  amber-hover: "#f59e0b"
  pilot-red: "#dc2626"
  pilot-red-bright: "#ef4444"
  pilot-red-soft: "#fca5a5"
  take-green: "#16a34a"
  take-green-light: "#4ade80"
  take-green-bright: "#22c55e"
  take-green-deep: "#15803d"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2rem, 4vw, 2.75rem)"
    fontWeight: 800
    letterSpacing: "-0.5px"
  headline:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 800
  title:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 700
  body:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  body-sm:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
  caption:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.3
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "11px"
    fontWeight: 700
  mono-code:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "16px"
    fontWeight: 700
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.espresso}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.amber-hover}"
  button-secondary:
    backgroundColor: "{colors.walnut-control}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.walnut-control-hover}"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
---

# Design System: DubMate

`static/css/style.css` is the source of truth. The colours above are copied from its `:root` block, and `tests/test_design_tokens.js` fails if one of them goes missing there. When the two disagree, fix this file.

## Overview

**Creative North Star: "The studio after dark"**

DubMate looks like a small recording studio at night: dark espresso walls, walnut panels with brass trim, ivory labels, an amber tube glow on the controls that matter and a red pilot lamp when you're on air. Controls borrow from analog hardware (rotary dials, racks, meters) and from ShadCN / Radix ergonomics (hairline borders, segmented tabs, plain button variants).

Every screen is a working surface. People are reading a line, watching a meter or waiting for a friend, so the look stays calm and the warm accents are spent on state: what is live, what is recording, what is done.

**Key Characteristics:**
- Warm darks only. No cool greys, no pure black surfaces.
- Brass outlines and a soft gold glow mark panels; amber marks the one action that matters.
- Red means on air, an error or something you can't undo. Green means done.
- Dense but readable: nothing under 11px.

## Colors

A warm darkroom palette: espresso and walnut surfaces, ivory text, brass trim, amber for action, and two signal lamps.

### Primary
- **Tube Amber** (#d97706, `--primary` / `--accent-amber`): the primary action, the active playhead, dial indicators and VU peaks. Hover lifts to **Amber Hover** (#f59e0b, `--primary-hover`). Text on amber is espresso (#12100e, 6.0:1).

### Secondary
- **Studio Brass** (#cca458, `--accent-brass` / `--border-gold`): panel trim, labels, badges and meters. It is 7.7:1 on walnut, so it also carries the focus ring.

### Signal lamps
- **Pilot Red** (#dc2626, `--accent-red`): the recording lamp and the record button. **Bright Red** (#ef4444, `--accent-red-bright`) and **Soft Red** (#fca5a5, `--accent-red-soft`) are for error text on dark surfaces, where pilot red is too dark to read.
- **Take Green** (#16a34a, `--accent-teal`): a take is saved, a check passed. **Light Green** (#4ade80), **Bright Green** (#22c55e) and **Deep Green** (#15803d) are its text, meter and hover shades.

### Neutral
- **Espresso** (#12100e, `--background`): the page canvas, with faint warm radial washes and a foam-tile pattern. **Espresso Deep** (#0c0a09, `--background-darker`) for the darkest wells.
- **Walnut** (#1a1714, `--card`): panels, cards and dialogs. **Walnut Header** (#201c18, `--card-header`) for section heads, **Walnut Popover** (#1f1b17, `--popover`) for menus.
- **Walnut Control** (#25201a, `--secondary`): secondary buttons, toasts and active tabs; hover #302922 (`--secondary-hover`). **Walnut Muted** (#221c17, `--muted`).
- **Input** (#15120f, `--input`) with **Input Border** (#352c24, `--input-border`).
- **Hardware panels** (`--panel-deep` #120e0b up to `--panel-raised` #2a221b): rack faces, dial skirts and decks.
- **Borders:** **Border** (#2d251e, `--border`) is the hairline; **Border Wood** (#443428, `--border-wood`) edges controls; **Border Panel** (#3d2c1c, `--border-panel`) edges hardware panels.
- **Ivory** (#f4ede4, `--foreground`): text, 15.4:1 on walnut. **Ivory Warm** (#f7eedd, `--foreground-ivory`) for text on the stage.
- **Ivory Muted** (#a89f95, `--foreground-muted`): meta lines, hints and captions under controls. 6.9:1 on walnut.
- **Ivory Dim** (#73685e, `--foreground-dim`): dividers and decoration. 3.3:1 on walnut, too low for anything someone has to read.

### Named Rules
**The One Amber Rule.** Each view has one primary (amber) action. Everything else is secondary, ghost or a link.

**The Signal Lamp Rule.** Green only for done or OK. Red only for recording, errors and irreversible actions. Neither colour decorates.

**The Dim Is Decoration Rule.** `--foreground-dim` is for dividers, rules and decoration only. Meta text, hints and secondary labels use `--foreground-muted`.

## Typography

**Body Font:** Plus Jakarta Sans (with -apple-system, Segoe UI, Roboto, sans-serif)
**Caption Font:** Newsreader (with Georgia, serif)
**Mono Font:** JetBrains Mono (with monospace)

**Character:** a friendly geometric sans for the interface, a book serif for the dialogue on screen, and a mono for numbers that change: timecodes, offsets, room codes, counts.

### Hierarchy
- **Display** (800, clamp(2rem, 4vw, 2.75rem), -0.5px): the landing hero only.
- **Headline** (800, 20px): screen titles such as the pack name in the lobby.
- **Title** (700, 14px): panel titles.
- **Body** (500 to 600, 13px): buttons, toasts and most interface text. Form inputs use 14px.
- **Body Small** (500, 12px): sentences, meta lines and hints.
- **Label** (700, 11px, often uppercase with 0.5 to 1.2px tracking, in brass): section labels and badges.
- **Caption** (Newsreader 500, 15px, line-height 1.3): the subtitle line on the video stage.
- **Mono** (700, 11px): timecodes, readouts and badges with numbers. Room codes use 16px.

### Named Rules
**The Type Floor Rule.** No text under 11px, anywhere: labels, badges and mono readouts included. Anything that is a sentence, a meta line or a hint is at least 12px.

## Layout

The studio is one page of screens (choose a scene, lobby, booth, premiere) under a fixed header. Panels sit on an 8px rhythm with 16 to 20px of padding (`.panel-header` is 16px 20px). Every screen works from 1440x900 down to 960x680, the desktop window minimum. When space runs short, a panel scrolls inside itself rather than pushing controls off screen.

## Elevation & Depth

Depth comes from layered warm darks, soft shadows and a faint brass glow, like lit hardware in a dark room. Panels carry a long dark drop shadow, a low brass halo and a 1px highlight on the top edge.

### Shadow Vocabulary
- **Small** (`--shadow-sm`: `0 1px 2px 0 rgba(0, 0, 0, 0.4)`): buttons and tabs.
- **Card** (`--shadow-card`): drop shadow, faint brass glow and a top inset highlight, for cards and panels.
- **Amber glow** (`--shadow-glow-amber`: `0 0 18px` amber at 35%): primary button hover and live amber states.
- **Red glow** (`--shadow-glow-red`: `0 0 20px` red at 40%): the recording state.
- **Toast** (`0 10px 24px rgba(0, 0, 0, 0.45)`).

### Named Rules
**The Glow Means Live Rule.** Amber and red glows show a live state (hover on the primary action, recording). Resting controls don't glow.

## Shapes

Rounded rectangles on the ShadCN scale: 6px (`--radius-sm`) for small buttons, tabs and badges; 8px (`--radius-md`) for buttons, inputs and the waveform; 12px (`--radius-lg`) for cards and racks; 16px (`--radius-xl`) for large dialogs; full for pills and dots. Dials are circles. Borders are 1px hairlines, and 1.5px brass on cards and racks.

## Components

### Buttons
- **Shape:** 8px radius, 8px 16px padding, 13px 600 text. Sizes: extra small (24px minimum height, 11px), small (32px, 12px), large (44px, 14px 700).
- **Primary:** amber with espresso text and an inset top highlight. Hover goes to #f59e0b with the amber glow.
- **Secondary:** walnut control (#25201a) with a wood border. Hover lightens it and the border turns amber.
- **Ghost:** transparent with muted ivory text. Hover fills it with walnut control.
- **Success:** take green with white text, for a done state.
- **Pressed:** scales to 0.97 over 140ms.
- **Disabled:** muted surface, dim text, no glow, a not-allowed cursor.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** walnut (#1a1714).
- **Border:** 1.5px brass at about 42 to 45% opacity, with a brass hairline gradient along the top.
- **Shadow Strategy:** the Card shadow (see Elevation & Depth).
- **Rack frame (`.rack-wood-frame`):** the same walnut card with a stronger brass edge and inset console shadows, for the voice rack.

### Inputs / Fields
- **Style:** 40px high, input background (#15120f), 1px input border, 8px radius, 14px text.
- **Focus:** the border turns amber with a 2px `--ring` glow (brass at 40%).

### Segmented Tabs
- **`.tab-pill-group`:** an input-coloured track with 4px padding. The active pill is walnut control with a wood border and the small shadow. Used for "Create Room" vs "Join Code" and "16:9 Cinema" vs "9:16 Shorts".

### Toasts
- Walnut control background, wood border, 8px radius, 13px 600 text and a slight backdrop blur.

### Analog Dials (`AnalogKnob`)
- A 270° sweep with a calibrated tick ring, a knurled skirt and an ivory indicator notch.
- Vertical mouse drag (the usual DAW feel), the scroll wheel and the keyboard all adjust it, and it stays in sync with the live voice effects.

### Header
- Room screens keep a "Leave room" action and a way back to choosing a scene in the header.

## Do's and Don'ts

### Do:
- **Do** take every colour from a `style.css` `:root` token.
- **Do** keep all text at 11px or more, and sentences, meta lines and hints at 12px or more.
- **Do** put meta text on `--foreground-muted` (#a89f95).
- **Do** give every focusable control the same focus ring on `:focus-visible`: `outline: 2px solid var(--accent-brass)` with `outline-offset: 2px`.
- **Do** honour reduced motion. Under `prefers-reduced-motion: reduce`, pulses, halos, spinners and reels stop, and the state they show stays visible through colour, ring and text.
- **Do** use the motion tokens: `--ease-out` (cubic-bezier(0.23, 1, 0.32, 1)), `--duration-fast` (140ms) for small feedback and `--duration-normal` (200ms) for larger changes.

### Don't:
- **Don't** put more than one amber primary action in a view.
- **Don't** use green for anything but done or OK, or red for anything but recording, errors and irreversible actions.
- **Don't** use `--foreground-dim` (#73685e) for text someone has to read.
- **Don't** bring in cool greys or pure black panels; this is a warm wood world.
- **Don't** glow resting controls; glow means live.
