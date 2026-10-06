# Product

<!-- impeccable:product-schema 1 -->

## Platform

Web app served by a local engine, wrapped in a desktop app (Windows, macOS). Friends join a room from their own DubMate or from a browser link.

## Users

Hobbyist voice actors and groups of friends who dub anime and film scenes for fun, for social media, or for a portfolio. Most are not audio engineers. A smaller group wants real control over their sound and would otherwise open a separate editor to fix it.

## Product Purpose

Dub a scene without editing software. Pick a scene, cast the characters, record your lines against the video, and watch the finished dub together. DubMate handles the tedious parts: removing the original voices, lining up and levelling takes, cleaning up room noise, and rendering the video.

The Pack Builder turns any video into a scene that can be dubbed.

## Positioning

Simple by default, deep on request. A friend who opens an invite link can record a line in a minute. Someone who cares about their sound has an effects chain, take history and exact timing a click away, and never needs to export the takes and finish them elsewhere.

## Operating Context

Recording at a desk with headphones and a USB or XLR mic, often in an untreated room. Sessions are social: people record on their own, then watch the dub together. Recording relies on the keyboard (Space to record or stop, `[` and `]` to nudge timing by 25 ms, Shift with `[` or `]` for 100 ms; `?` shows every shortcut).

## Capabilities and Constraints

- Two surfaces: the studio, where you record and watch dubs, and the Pack Builder, where you make scenes.
- What you hear while editing is what you export. Effects are rendered by the engine for both preview and export. Controls react instantly while the audio catches up.
- Takes are levelled automatically. Nobody gets instructions about input levels except during mic setup.
- Recording, effects and rendering run on the user's machine. The only things that go online are room codes, the connection for remote friends, and updates.
- Advanced controls stay hidden until someone asks for them.

## Brand Commitments

- **Name:** DubMate. "Studio" and "Pack Builder" label the two surfaces and are not part of the name.
- **Look:** a warm, dark analog studio with tactile controls that stay readable at a glance. The look should never get in the way of recording.
- **Voice:** plain and short. Text says what something does for the user, not how it works. There is no hype, no technical names unless the user must act on them, and no lines that only show off effort. Secondary explanations go in tooltips.

## Evidence on Hand

- A working studio, Pack Builder, multiplayer rooms and video export.
- Scene packs in `Packs/`, with separated voice and background tracks.

## Product Principles

1. **The video and the line come first.** The prompter, the video and the record button own the screen. Everything else waits until it's needed.
2. **Automate what needs no creative judgement.** Timing, levels, noise and casting should be handled for the user, with a way to override each one.
3. **Never fake it.** A preview never sounds different from the export, and no UI text claims something the app doesn't do.
4. **Hide depth, don't remove it.** Presets first, the full rack one click away. A guest never sees a control they don't understand.
5. **Respond instantly.** Keys and controls react immediately. Slow work happens behind the scenes, without blocking the screen.

## Accessibility & Inclusion

- WCAG 2.1 AA contrast on every dark surface.
- Full keyboard use with visible focus rings. Tooltips open on focus as well as on hover.
- Every slider and control has an accessible name and value.
- Respects `prefers-reduced-motion`.
