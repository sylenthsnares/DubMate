/**
 * test_css_floors.js
 *
 * The readability floor for the studio and Pack Builder (UI pass U1):
 *  - no font-size under 11px in style.css, builder.css, or the inline styles and
 *    <style> blocks of index.html and builder.html,
 *  - text meta (a class name containing meta, hint, caption, desc, path or legend)
 *    never uses --foreground-dim, which is about 3.3:1 on cards. --foreground-dim
 *    is for dividers, borders and decoration only.
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

// The parser must actually be reading the files, and exemptions must not go stale.
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
