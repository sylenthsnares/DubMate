/**
 * test_css_floors.js
 *
 * The readability floor for the studio and Pack Builder (UI pass U1):
 *  - no font-size under 11px in style.css, builder.css, or the inline styles and
 *    <style> blocks of index.html and builder.html,
 *  - text meta (a class name containing meta, hint, caption, desc, path or legend)
 *    never uses --foreground-dim, which is about 3.3:1 on cards. --foreground-dim
 *    is for dividers, borders and decoration only.
 *  - one keyboard focus style (2px solid --accent-brass outline, offset 2px),
 *  - the looping pulses stop under prefers-reduced-motion,
 *  - .btn:disabled looks disabled, and .btn-danger exists and is used by the
 *    Remove Pack Builder confirm.
 *
 * Anything that stays small is named in EXEMPT with its reason.
 */
const fs = require("fs");
const path = require("path");

const STATIC = path.join(__dirname, "..", "static");
const FLOOR_PX = 11;

// Selectors allowed under the floor, one by one.
const EXEMPT = [
  // Pack Builder timeline internals sit inside fixed timeline geometry (ruler
  // spacing, segment block height). They are resized with the timeline in step 40h.
  { selector: ".ruler-tick", reason: "fixed timeline geometry, step 40h" },
  { selector: ".segment-block-label", reason: "fixed timeline geometry, step 40h" },
  { selector: ".segment-inline-delete-btn", reason: "fixed timeline geometry, step 40h" },
];

const META_CLASS = /meta|hint|caption|desc|path|legend/;

const failures = [];
function fail(msg) { failures.push(msg); }

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** Every innermost declaration block as { selector, body, line }. */
function cssBlocks(css) {
  const text = stripComments(css);
  const blocks = [];
  const stack = [];
  const re = /([^{}]*)\{|\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === "}") {
      const b = stack.pop();
      if (b) { b.body = text.slice(b.start, m.index); blocks.push(b); }
      continue;
    }
    stack.push({
      selector: m[1].trim().replace(/\s+/g, " "),
      start: m.index + m[0].length,
      line: text.slice(0, m.index + m[1].length).split("\n").length,
    });
  }
  // At-rule wrappers (@media, @supports) hold blocks, not declarations.
  return blocks.filter((b) => !b.selector.startsWith("@"));
}

function pxSizes(body) {
  return [...body.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));
}

function usesDimText(body) {
  return /(^|[^-\w])color\s*:\s*var\(--foreground-dim\)/.test(body);
}

function isMetaSelector(selector) {
  return [...selector.matchAll(/\.([\w-]+)/g)].some((m) => META_CLASS.test(m[1]));
}

const usedExemptions = new Set();
let checkedSizes = 0;

function checkCss(file, css, lineOffset = 0) {
  for (const b of cssBlocks(css)) {
    const where = `${file}:${b.line + lineOffset} ${b.selector}`;
    for (const px of pxSizes(b.body)) {
      checkedSizes += 1;
      if (px >= FLOOR_PX) continue;
      const ex = EXEMPT.find((e) => e.selector === b.selector);
      if (ex) { usedExemptions.add(ex.selector); continue; }
      fail(`${where}: font-size ${px}px is under ${FLOOR_PX}px`);
    }
    if (isMetaSelector(b.selector) && usesDimText(b.body)) {
      fail(`${where}: text meta uses --foreground-dim; use --foreground-muted`);
    }
  }
}

function checkHtml(file, html) {
  // <style> blocks
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const offset = html.slice(0, m.index).split("\n").length - 1;
    checkCss(file, m[1], offset);
  }
  // Inline style attributes
  for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*?)\sstyle\s*=\s*"([^"]*)"/gi)) {
    const line = html.slice(0, m.index).split("\n").length;
    const attrs = m[2];
    const id = (attrs.match(/\sid\s*=\s*"([^"]*)"/) || [])[1];
    const cls = (attrs.match(/\sclass\s*=\s*"([^"]*)"/) || [])[1] || "";
    const where = `${file}:${line} <${m[1]}${id ? "#" + id : ""}>`;
    for (const px of pxSizes(m[3])) {
      checkedSizes += 1;
      if (px < FLOOR_PX) fail(`${where}: inline font-size ${px}px is under ${FLOOR_PX}px`);
    }
    if (cls.split(/\s+/).some((c) => META_CLASS.test(c)) && usesDimText(m[3])) {
      fail(`${where}: text meta uses --foreground-dim inline; use --foreground-muted`);
    }
  }
}

for (const name of ["style.css", "builder.css"]) {
  checkCss(`static/css/${name}`, fs.readFileSync(path.join(STATIC, "css", name), "utf8"));
}
for (const name of ["index.html", "builder.html"]) {
  checkHtml(`static/${name}`, fs.readFileSync(path.join(STATIC, name), "utf8"));
}

// ---- Shared states (step 3): focus ring, reduced motion, disabled, danger ----

const styleCss = fs.readFileSync(path.join(STATIC, "css", "style.css"), "utf8");
const builderCss = fs.readFileSync(path.join(STATIC, "css", "builder.css"), "utf8");
const styleBlocks = cssBlocks(styleCss);
const builderBlocks = cssBlocks(builderCss);
const selectorList = (b) => b.selector.split(",").map((s) => s.trim());

// One focus style: every :focus-visible rule draws a 2px solid brass outline.
// .btn-danger keeps that outline and only recolours it against its red fill.
const FOCUS_REQUIRED = [".btn", ".btn-big-record", ".pack-card", ".color-option", ".chip-item"];
const FOCUS_RECOLOURED = [".btn-danger:focus-visible"];
let focusRules = 0;
for (const [file, blocks] of [["static/css/style.css", styleBlocks], ["static/css/builder.css", builderBlocks]]) {
  for (const b of blocks) {
    if (!b.selector.includes(":focus-visible")) continue;
    focusRules += 1;
    if (FOCUS_RECOLOURED.includes(b.selector)) {
      if (!/outline-color\s*:/.test(b.body)) fail(`${file}:${b.line} ${b.selector}: expected an outline-color`);
      continue;
    }
    if (!/outline\s*:\s*2px solid var\(--accent-brass\)/.test(b.body) || !/outline-offset\s*:\s*2px/.test(b.body)) {
      fail(`${file}:${b.line} ${b.selector}: focus must be outline: 2px solid var(--accent-brass) with outline-offset: 2px`);
    }
    if (/box-shadow\s*:[^;]*--ring/.test(b.body)) fail(`${file}:${b.line} ${b.selector}: focus uses the --ring glow; use the brass outline`);
  }
}
for (const sel of FOCUS_REQUIRED) {
  const want = `${sel}:focus-visible`;
  if (!styleBlocks.some((b) => selectorList(b).includes(want))) fail(`style.css has no ${want} rule`);
}

/** Selectors that set animation: none inside a prefers-reduced-motion block. */
function reducedMotionSelectors(css) {
  const text = stripComments(css);
  const out = new Set();
  for (const m of text.matchAll(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g)) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (depth && i < text.length) { if (text[i] === "{") depth += 1; else if (text[i] === "}") depth -= 1; i += 1; }
    for (const b of cssBlocks(text.slice(start, i - 1))) {
      if (/animation\s*:\s*none/.test(b.body)) selectorList(b).forEach((s) => out.add(s));
    }
  }
  return out;
}

// Every rule that runs one of these looping keyframes must stop under reduced motion.
function checkReducedMotion(file, blocks, css, names) {
  const stopped = reducedMotionSelectors(css);
  for (const name of names) {
    const users = blocks.filter((b) => new RegExp(`animation\\s*:[^;]*\\b${name}\\b`).test(b.body));
    if (!users.length) fail(`${file}: no rule runs @keyframes ${name}; update this list`);
    for (const b of users) {
      for (const sel of selectorList(b)) {
        if (!stopped.has(sel)) fail(`${file}:${b.line} ${sel} runs ${name} but has no animation: none under prefers-reduced-motion`);
      }
    }
  }
}
checkReducedMotion("static/css/style.css", styleBlocks, styleCss,
  ["pulse-halo", "pulse-recording", "connection-pulse", "spinFilmReel", "pulseReelRing"]);
checkReducedMotion("static/css/builder.css", builderBlocks, builderCss, ["pulse-halo"]);

// Disabled buttons and the danger variant.
const disabled = styleBlocks.find((b) => selectorList(b).includes(".btn:disabled"));
if (!disabled) fail("style.css has no .btn:disabled rule");
else {
  for (const sel of [".btn:disabled:hover", '.btn[aria-disabled="true"]', '.btn[aria-disabled="true"]:hover']) {
    if (!selectorList(disabled).includes(sel)) fail(`.btn:disabled rule should also cover ${sel}`);
  }
  for (const decl of [/cursor\s*:\s*not-allowed/, /box-shadow\s*:\s*none/, /transform\s*:\s*none/, /(^|[^-\w])color\s*:\s*var\(--foreground-dim\)/]) {
    if (!decl.test(disabled.body)) fail(`.btn:disabled is missing ${decl}`);
  }
}
const danger = styleBlocks.find((b) => b.selector === ".btn-danger");
if (!danger || !/background\s*:\s*var\(--accent-red\)/.test(danger.body)) fail("style.css needs .btn-danger on var(--accent-red)");
if (!styleBlocks.some((b) => b.selector === ".btn-danger:hover")) fail("style.css needs a .btn-danger:hover");

const indexHtml = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
const removeBtn = indexHtml.match(/<button[^>]*id="btn-confirm-remove-packbuilder"[^>]*>/);
if (!removeBtn || !/class="[^"]*\bbtn-danger\b/.test(removeBtn[0])) fail("#btn-confirm-remove-packbuilder should be a .btn-danger");

// The header's Leave stays in the window at 960px (measured in Chromium for the PR):
// the two sides never shrink, only the pill's sentence does; while the pill asks for
// attention the invite code and name step aside; in a room below 1280px the logo is
// its icon.
const bodiesFor = (sel) => styleBlocks.filter((b) => selectorList(b).includes(sel)).map((b) => b.body).join(" ");
for (const sel of [".header-left", ".header-status"]) {
  if (!/flex-shrink\s*:\s*0/.test(bodiesFor(sel))) fail(`${sel} needs flex-shrink: 0 so the header's Leave is never pushed out`);
}
if (!/min-width\s*:\s*0/.test(bodiesFor(".connection-banner #connection-banner-text"))) {
  fail("the pill's sentence needs min-width: 0 so it can give way with an ellipsis");
}
const pillShowing = '.app-header:has(> .connection-banner:not([style*="none"]):not(.is-recovered))';
for (const id of ["#header-room-badge", "#header-user-pill"]) {
  if (!/display\s*:\s*none/.test(bodiesFor(`${pillShowing} ${id}`))) fail(`${id} should step aside while the pill shows`);
}
if (!/@media \(max-width: 1279px\) \{\s*\.app-header\.in-room \.logo-title,\s*\.app-header\.in-room \.logo-badge \{\s*display: none;/.test(styleCss)) {
  fail("in a room below 1280px the logo should drop to its icon");
}

// Sideways scrollers keep the studio's scrollbar. In Chromium/WebView2 a scrollbar-width or
// scrollbar-color on an element switches ::-webkit-scrollbar off and brings back the default
// grey bar (the line chips under the takes had it), so those two only appear in the
// Firefox-only @supports not selector(::-webkit-scrollbar) block.
const FIREFOX_ONLY = /@supports\s+not\s+selector\(::-webkit-scrollbar\)\s*\{/g;
function firefoxOnlySelectors(css) {
  const text = stripComments(css);
  const out = new Set();
  let outside = text;
  for (const m of text.matchAll(FIREFOX_ONLY)) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (depth && i < text.length) { if (text[i] === "{") depth += 1; else if (text[i] === "}") depth -= 1; i += 1; }
    for (const b of cssBlocks(text.slice(start, i - 1))) {
      if (/scrollbar-color\s*:\s*var\(--panel-raised\) var\(--background-darker\)/.test(b.body)) selectorList(b).forEach((s) => out.add(s));
    }
    outside = outside.slice(0, m.index) + " ".repeat(i - m.index) + outside.slice(i);
  }
  return { out, outside };
}
if (!/::-webkit-scrollbar\s*\{[^}]*height\s*:\s*8px/.test(stripComments(styleCss))) fail("style.css lost its shared ::-webkit-scrollbar rule");
const firefoxOnly = firefoxOnlySelectors(styleCss);
for (const b of cssBlocks(firefoxOnly.outside)) {
  if (!/overflow(-x)?\s*:\s*(auto|scroll)/.test(b.body)) continue;
  if (/scrollbar-(width|color)\s*:/.test(b.body)) {
    fail(`style.css:${b.line} ${b.selector}: a sideways scroller sets scrollbar-width/color outside the Firefox-only block; Chromium then draws the default bar`);
  }
}
for (const sel of [".timeline-chips-box", ".cast-activity-list"]) {
  if (!firefoxOnly.out.has(sel)) fail(`${sel} needs the studio scrollbar colours in the Firefox-only @supports block`);
}

// The parser must actually be reading the files, and exemptions must not go stale.
if (focusRules < 8) fail(`only ${focusRules} :focus-visible rules found; the CSS parser is probably broken`);
if (checkedSizes < 150) fail(`only ${checkedSizes} px font sizes found; the CSS parser is probably broken`);
for (const ex of EXEMPT) {
  if (!usedExemptions.has(ex.selector)) {
    fail(`EXEMPT entry ${ex.selector} is no longer under the floor; remove it from the list`);
  }
}

if (failures.length) {
  for (const f of failures) console.error("FAIL: " + f);
  process.exit(1);
}
console.log(`PASS: ${checkedSizes} font sizes at or above ${FLOOR_PX}px (${EXEMPT.length} exempt), no text meta on --foreground-dim`);
console.log(`PASS: ${focusRules} :focus-visible rules on the brass outline, looping pulses stop under reduced motion, disabled and danger buttons styled, sideways scrollers on the studio scrollbar`);
