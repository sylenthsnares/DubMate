/**
 * test_launcher_ui.js
 * JSDOM coverage for the desktop launcher's Pack Builder install card.
 *
 * The regression this guards: the install used to show raw pip output ("Collecting
 * nvidia-cublas-cu12==12.4.5.8") against a bar pinned at 100%, which reads as either
 * "finished" or "frozen" to anyone who does not know what a wheel is. The launcher
 * now renders a structured PackBuilderProgress from Rust; these tests assert it
 * actually reaches the DOM.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC_DIR = path.join(__dirname, "..", "tauri", "src");
const html = fs.readFileSync(path.join(SRC_DIR, "index.html"), "utf8");
const launcherJs = fs.readFileSync(path.join(SRC_DIR, "launcher.js"), "utf8");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`         PASS: ${label}`);
    passed += 1;
  } else {
    console.log(`         FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
    failed += 1;
  }
}

/**
 * Boots the launcher DOM without Tauri present, then hands back the pieces under
 * test. `window.__TAURI__` is deliberately undefined so init() wires nothing and
 * the render function can be exercised in isolation.
 */
function bootLauncher() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const { window } = dom;
  // The launcher polls the engine on load; stub it so nothing hangs.
  window.fetch = () => Promise.resolve({ ok: false, status: 503 });

  // Evaluate the launcher, then expose the internals the tests drive.
  window.eval(`${launcherJs}
    window.__test = {
      renderBuilderProgress,
      BUILDER_STAGE_ORDER,
    };
  `);
  return { dom, window, doc: window.document, api: window.__test };
}

console.log("\n  [+] Launcher: Pack Builder install card");

// --- Structured payload rendering -----------------------------------------
{
  const { dom, doc, api } = bootLauncher();

  api.renderBuilderProgress({
    phase: "downloading",
    headline: "Downloading the neural network engine",
    detail: "412 MB of ~2.0 GB",
    percent: 37.5,
    raw: "Downloading torch-2.4.0-cp311-win_amd64.whl (197.8 MB)",
  });

  check(
    "headline shows plain language, not a package name",
    doc.getElementById("progress-headline").innerText === "Downloading the neural network engine"
  );
  check(
    "detail shows human byte counts",
    doc.getElementById("progress-text").innerText === "412 MB of ~2.0 GB"
  );
  check(
    "bar reflects real percentage",
    doc.getElementById("progress-fill").style.width === "37.5%",
    doc.getElementById("progress-fill").style.width
  );
  check(
    "percent label is rounded for readability",
    doc.getElementById("progress-percent").innerText === "38%",
    doc.getElementById("progress-percent").innerText
  );
  check(
    "raw pip line is kept out of the way in the details pane",
    doc.getElementById("tech-log").innerText.includes("torch-2.4.0")
  );
  check(
    "technical details start collapsed",
    doc.getElementById("tech-details").hasAttribute("open") === false
  );
  dom.window.close();
}

// --- Stage indicator ------------------------------------------------------
{
  const { dom, doc, api } = bootLauncher();
  api.renderBuilderProgress({
    phase: "installing",
    headline: "Unpacking and installing",
    detail: "42 components",
    percent: 88,
    raw: "Installing collected packages: torch, demucs",
  });

  const stage = (name) => doc.querySelector(`.stage[data-stage="${name}"]`);
  check("current stage is marked active", stage("installing").classList.contains("is-active"));
  check("earlier stages are marked done", stage("preparing").classList.contains("is-done")
    && stage("downloading").classList.contains("is-done"));
  check("later stages are neither", !stage("finalizing").classList.contains("is-active")
    && !stage("finalizing").classList.contains("is-done"));
  dom.window.close();
}

// --- Robustness -----------------------------------------------------------
{
  const { dom, doc, api } = bootLauncher();

  // A bare string (older Rust build, or any stray emit) must not render as
  // "[object Object]" or blow up.
  api.renderBuilderProgress("Restarting Studio Engine...");
  check(
    "a plain string payload still renders readable text",
    doc.getElementById("progress-headline").innerText === "Restarting Studio Engine...",
    doc.getElementById("progress-headline").innerText
  );

  const before = doc.getElementById("progress-fill").style.width;
  api.renderBuilderProgress(null);
  check("a null payload is ignored rather than clearing the bar",
    doc.getElementById("progress-fill").style.width === before);

  api.renderBuilderProgress({ phase: "downloading", headline: "x", detail: "", percent: 999, raw: "" });
  check("an out-of-range percent is clamped to 100%",
    doc.getElementById("progress-fill").style.width === "100%",
    doc.getElementById("progress-fill").style.width);

  api.renderBuilderProgress({ phase: "downloading", headline: "y", detail: "", percent: -5, raw: "" });
  check("a negative percent is clamped to 0%",
    doc.getElementById("progress-fill").style.width === "0%",
    doc.getElementById("progress-fill").style.width);
  dom.window.close();
}

// --- The updater shares this card ------------------------------------------
{
  const { dom, doc } = bootLauncher();
  check(
    "builder-only chrome is hidden until a Pack Builder install starts",
    doc.getElementById("builder-stages").style.display === "none"
      && doc.getElementById("tech-details").style.display === "none"
  );
  dom.window.close();
}

console.log(`\n  Launcher UI: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
