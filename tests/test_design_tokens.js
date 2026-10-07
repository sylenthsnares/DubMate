/**
 * test_design_tokens.js
 *
 * documentation/DESIGN.md is written from static/css/style.css, which is the
 * source of truth for the look. This keeps the two from drifting apart again:
 *  - every colour in DESIGN.md's frontmatter exists in style.css's :root block,
 *  - no type size in the frontmatter is under the 11px floor,
 *  - the old plum/wine palette stays out of the frontmatter.
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const design = fs.readFileSync(path.join(PROJECT_ROOT, "documentation", "DESIGN.md"), "utf8");
const css = fs.readFileSync(path.join(PROJECT_ROOT, "static", "css", "style.css"), "utf8");

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const fm = design.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fm) fail("DESIGN.md has no YAML frontmatter");
const frontmatter = fm[1];

const root = css.match(/:root\s*\{([^}]*)\}/);
if (!root) fail("style.css has no :root block");
const rootBlock = root[1].toLowerCase();

// Colours: the indented entries under "colors:" up to the next top-level key.
const colorsBlock = frontmatter.match(/^colors:\r?\n((?:[ \t]+.*\r?\n?)*)/m);
if (!colorsBlock) fail("DESIGN.md frontmatter has no colors block");
const colors = [...colorsBlock[1].matchAll(/^\s+([\w-]+):\s*"(#[0-9a-fA-F]{3,8})"/gm)];
if (colors.length < 10) fail(`expected at least 10 frontmatter colours, found ${colors.length}`);
for (const [, name, hex] of colors) {
  if (!rootBlock.includes(hex.toLowerCase())) {
    fail(`DESIGN.md colour ${name} (${hex}) is not in style.css :root`);
  }
}

// Type floor: no fontSize or size token under 11px.
const sizes = [...frontmatter.matchAll(/^\s+(?:fontSize|size):\s*"?([^"\n]+)"?/gm)];
if (!sizes.length) fail("DESIGN.md frontmatter has no fontSize tokens");
for (const [, value] of sizes) {
  for (const [, num, unit] of value.matchAll(/(\d+(?:\.\d+)?)(px|rem)/g)) {
    const px = unit === "rem" ? parseFloat(num) * 16 : parseFloat(num);
    if (px < 11) fail(`DESIGN.md type token ${value.trim()} is under 11px`);
  }
}

if (/plum|wine/i.test(frontmatter)) fail("DESIGN.md frontmatter still names the plum/wine palette");

console.log(`OK: ${colors.length} DESIGN.md colours found in style.css :root, ${sizes.length} type sizes at or above 11px`);
