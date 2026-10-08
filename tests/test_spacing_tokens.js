/**
 * test_spacing_tokens.js
 *
 * One spacing scale for the booth (2.0 layout pass, documentation/design/v2-booth-layout.md):
 *  - :root defines --space-1..5 as 4/8/12/16/24, numbered with no gaps,
 *  - the booth's containers (the bar, both columns, every card's inner gutter, the
 *    prompter, the waveform panel) set gap, padding and margin only from those tokens
 *    or 0, in every block that names them (media queries included),
 *  - the mic-sync hint is one unboxed line: no frame, no background.
 * Component insides (button, chip and badge padding) belong to the look and aren't checked.
 */
const fs = require("fs");
const path = require("path");

const css = fs.readFileSync(path.join(__dirname, "..", "static", "css", "style.css"), "utf8");
const failures = [];
const fail = (msg) => failures.push(msg);

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** Every innermost declaration block as { selectors, body, line }. */
function cssBlocks(text) {
  const src = stripComments(text);
  const blocks = [];
  const stack = [];
  const re = /([^{}]*)\{|\}/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === "}") {
      const b = stack.pop();
      if (b && !b.selector.startsWith("@")) {
        b.body = src.slice(b.start, m.index);
        b.selectors = b.selector.split(",").map((s) => s.trim().replace(/\s+/g, " "));
        blocks.push(b);
      }
      continue;
    }
    stack.push({
      selector: m[1].trim().replace(/\s+/g, " "),
      start: m.index + m[0].length,
      line: src.slice(0, m.index + m[1].length).split("\n").length,
    });
  }
  return blocks;
}

function decls(body) {
  const out = [];
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    out.push({ prop: part.slice(0, i).trim().toLowerCase(), value: part.slice(i + 1).trim() });
  }
  return out;
}

const blocks = cssBlocks(css);

// 1. The tokens.
const root = blocks.filter((b) => b.selectors.includes(":root"));
const tokens = {};
for (const b of root) for (const d of decls(b.body)) if (/^--space-/.test(d.prop)) tokens[d.prop] = d.value;
const WANT = { "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "24px" };
for (const [k, v] of Object.entries(WANT)) {
  if (tokens[k] !== v) fail(`:root ${k} is ${tokens[k] || "missing"}, want ${v}`);
}
for (const k of Object.keys(tokens)) {
  if (!(k in WANT)) fail(`:root defines ${k}; the scale is --space-1..5 with no gaps`);
}

// 2. The booth's containers use only the scale (or 0).
const BOOTH_CONTAINERS = [
  ".stage-top-bar", ".stage-info-group", ".stage-action-group", ".timeline-chips-box",
  ".booth-layout", ".stage-main-col", ".caption-card", ".waveform-panel", ".waveform-legend",
  ".legend-group", ".nudge-preset-bar",
  ".booth-controls", ".booth-column-scroll", ".booth-controls .panel-header-sm",
  ".record-deck-body", ".record-deck-main", ".record-track-tag", ".mic-sync-hint",
  ".takes-card-body", ".takes-list", ".voice-main", ".voice-presets", ".voice-row", ".voice-fx",
  ".monitor-strip", ".monitor-row", ".booth-nav-group", ".booth-done-ask",
];
const SPACING = /^(gap|row-gap|column-gap|padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?|margin(-(top|right|bottom|left|inline|block)(-(start|end))?)?)$/;
const ON_SCALE = /^(0|auto|var\(--space-[1-5]\))$/;
let checked = 0;
for (const sel of BOOTH_CONTAINERS) {
  const mine = blocks.filter((b) => b.selectors.includes(sel));
  if (!mine.length) { fail(`no rule for ${sel}`); continue; }
  for (const b of mine) {
    for (const d of decls(b.body)) {
      if (!SPACING.test(d.prop)) continue;
      checked++;
      const parts = d.value.replace(/\s*!important$/, "").split(/\s+/);
      const off = parts.filter((p) => !ON_SCALE.test(p));
      if (off.length) fail(`style.css:${b.line} ${b.selector} { ${d.prop}: ${d.value} } is off the --space-* scale`);
    }
  }
}
if (checked < 30) fail(`only ${checked} spacing declarations checked; the parser is probably broken`);

// 3. The mic-sync hint is one unboxed line.
for (const b of blocks.filter((x) => x.selectors.includes(".mic-sync-hint"))) {
  for (const d of decls(b.body)) {
    if (d.prop === "border" && !/^(0|none)$/.test(d.value)) fail(`.mic-sync-hint has a frame: ${d.value}`);
    if (/^background(-color)?$/.test(d.prop) && !/^(none|transparent)$/.test(d.value)) fail(`.mic-sync-hint has a background: ${d.value}`);
  }
}

if (failures.length) {
  for (const f of failures) console.error("FAIL: " + f);
  process.exit(1);
}
console.log(`PASS: --space-1..5 = 4/8/12/16/24; ${BOOTH_CONTAINERS.length} booth containers (${checked} declarations) use only the scale; the mic-sync hint is unboxed`);
