# CVConvert — Choicer Voicer packs to DubStage packs

Converts dub packs made for The Choicer Voicer (GameBanana) into a format
DubStage can load, so you can dub them yourself with friends.

## Setup (once)

1. Put this whole folder somewhere normal, e.g. `F:\CVConvert`
   (best right next to your `F:\DubForge` folder — see step 2).
2. If you already have DubForge set up, it already has `ffmpeg.exe` in its
   `tools` folder — CVConvert will find and reuse it automatically as long
   as CVConvert's folder sits next to DubForge's. Otherwise run
   `Setup.bat` once, it'll tell you what's missing.

## Converting packs

**Option A — drag and drop**
Drag one or more Choicer Voicer pack `.zip` files (as downloaded from
GameBanana, no need to extract) straight onto `Convert.bat`.

**Option B — input folder**
Drop the `.zip` files (or extracted pack folders) into the `input` folder
next to this script, then double-click `Convert.bat`.

Either way, converted packs appear in the `output` folder: one subfolder
per pack (ready to use) plus a matching `.zip` (handy for sharing).

## Using the result

Copy the converted pack folder from `output` into DubStage's `packs`
folder, or use **Add folder** in DubStage's pack picker to point it
straight at `output`.

Each converted pack keeps the character name and original line as the
subtitle (e.g. `[todoroki] "I refuse... to use my left side"`), shown in
large text while you record, so whoever's on the mic knows who they're
voicing and what to say.

## Notes

- Video is carried over as-is when possible (Choicer Voicer packs already
  ship `.ogv`, which DubStage reads natively) — no re-encode needed there.
- Audio clips are converted to `.wav` to match DubStage's own convention.
- Clips are renumbered in actual scene order (by timestamp), not by the
  original pack's character-grouped numbering, so playback flows correctly.
- You are responsible for only using packs/material you're entitled to use.
