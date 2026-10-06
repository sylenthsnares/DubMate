/**
 * test_js_module_imports.js
 *
 * Static cross-module import check for static/js. For every file F and every name
 * declared at the top level of a DIFFERENT file, F must not use that name unless it
 * declares or imports it. Covers code paths the JSDOM suites never execute.
 * Crude by design: comments and string/template text are blanked before matching.
 */
const fs = require("fs");
const path = require("path");

const JS_DIR = path.join(__dirname, "..", "static", "js");
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\b/gm;

// Blank comments and string/template literal text (keeping newlines and ${...} code).
function strip(src) {
  let out = "", i = 0;
  const stack = []; // brace depth per open template ${
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === "'" || c === '"') { out += c; i++; while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1; out += c; if (src[i] === c) i++; continue; }
    if (c === "`" || (c === "}" && stack.length && stack[stack.length - 1] === 0)) {
      if (c === "}") stack.pop();
      out += c; i++;
      while (i < src.length && src[i] !== "`" && !(src[i] === "$" && src[i + 1] === "{")) { if (src[i] === "\\") i++; else if (src[i] === "\n") out += "\n"; i++; }
      if (src[i] === "$") { out += "${"; i += 2; stack.push(0); } else { out += "`"; i++; }
      continue;
    }
    if (stack.length && c === "{") stack[stack.length - 1]++;
    if (stack.length && c === "}") stack[stack.length - 1]--;
    out += c; i++;
  }
  return out;
}

// Includes subdirectories (static/js/studio/), reported as "studio/x.js".
function listJs(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? listJs(path.join(dir, e.name), prefix + e.name + "/")
      : e.name.endsWith(".js") ? [prefix + e.name] : []);
}
const files = listJs(JS_DIR).sort();
const info = files.map(f => {
  const code = strip(fs.readFileSync(path.join(JS_DIR, f), "utf8"));
  const declared = new Set([...code.matchAll(DECL_RE)].map(m => m[1]));
  const imported = new Set([...code.matchAll(IMPORT_RE)].flatMap(m => m[1].split(",").map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)));
  return { f, code, declared, imported };
});

const failures = [];
for (const F of info) {
  for (const other of info) {
    if (other === F) continue;
    for (const n of other.declared) {
      if (F.declared.has(n) || F.imported.has(n)) continue;
      const re = new RegExp("(?<![\\w$.])" + n.replace(/\$/g, "\\$") + "\\b");
      if (re.test(F.code)) failures.push(`${F.f}: uses ${n} without importing it`);
    }
  }
}

if (failures.length) {
  for (const msg of [...new Set(failures)]) console.error("FAIL: " + msg);
  process.exit(1);
}
console.log(`PASS: ${files.length} static/js modules import every cross-module name they use`);
