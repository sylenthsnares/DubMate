/**
 * studio_dom.js
 *
 * Builds a module-scoped bundle of the studio's ES modules for the JSDOM suites.
 * Each module runs in its own function scope and only sees the names it actually
 * imports, so a missing import fails the suite with a ReferenceError instead of
 * being masked by one shared concatenated scope.
 *
 * buildStudioBundle() only returns a JS source string. Each suite still creates
 * its own JSDOM, installs its own stubs and decides when to evaluate it.
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const ENTRY = path.join(PROJECT_ROOT, "static", "js", "app.js");

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"];?\s*$/;
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:class|function|const|let)\s+(\w+)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/");
}

function splitNames(list, file) {
  const names = list.split(",").map(s => s.trim()).filter(Boolean);
  for (const n of names) {
    if (/\sas\s/.test(n)) throw new Error(`studio_dom: 'as' rename not supported in ${rel(file)}: ${n}`);
  }
  return names;
}

function buildStudioBundle() {
  const visited = new Set();
  const chunks = [];

  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const code = fs.readFileSync(file, "utf8");
    if (/^\s*import\s*\*\s*as\b/m.test(code)) throw new Error(`studio_dom: 'import * as' not supported in ${rel(file)}`);
    if (/^\s*export\s+default\b/m.test(code)) throw new Error(`studio_dom: 'export default' not supported in ${rel(file)}`);

    const out = [];
    for (const line of code.split("\n")) {
      if (!/^\s*import[\s{*'"]/.test(line)) { out.push(line); continue; }
      const m = line.replace(/\r$/, "").match(IMPORT_RE);
      if (!m) throw new Error(`studio_dom: unsupported (multi-line or non-named) import in ${rel(file)}: ${line.trim()}`);
      const names = splitNames(m[1], file);
      const dep = path.resolve(path.dirname(file), m[2]);
      visit(dep);
      out.push(`const { ${names.join(", ")} } = __mods['${rel(dep)}'];`);
    }

    let body = out.join("\n");
    const exported = [];
    for (const m of body.matchAll(EXPORT_DECL_RE)) exported.push(m[1]);
    for (const m of body.matchAll(EXPORT_LIST_RE)) exported.push(...splitNames(m[1], file));
    body = body
      .replace(EXPORT_LIST_RE, "")
      .replace(/^export\s+/gm, "");

    chunks.push(`__mods['${rel(file)}'] = (function(){\n${body}\n return { ${exported.join(", ")} }; })();`);
  }

  visit(ENTRY);
  return `(function() {\nconst __mods = {};\n${chunks.join("\n")}\n})();\n`;
}

module.exports = { buildStudioBundle };
