// launcher.js - The desktop window's front door: the splash while the engine starts,
// the update card, and the error card for real failures.
//
// Rust owns what the splash says (`startup-progress`); this file only adds how long it
// has been waiting. The red card is for failures Rust reports (`server-error`), or for
// no answer at all after 3 minutes. The engine port is chosen at runtime (8000 unless
// taken), so never hardcode it.

const splash = document.getElementById("splash");
const statusText = document.getElementById("status-text");
const detailText = document.getElementById("detail-text");
const btnRestartSlow = document.getElementById("btn-restart-slow");
const updaterBox = document.getElementById("updater-box");
const updaterTitle = document.getElementById("updater-title");
const updaterMsg = document.getElementById("updater-msg");
const progressHeadline = document.getElementById("progress-headline");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const progressMeta = document.getElementById("progress-meta");
const btnSkipUpdate = document.getElementById("btn-skip-update");
const errorBox = document.getElementById("error-box");
const errorTitle = document.getElementById("error-title");
const errorMsg = document.getElementById("error-msg");
const errorRaw = document.getElementById("error-raw");
const btnRetry = document.getElementById("btn-retry");
const btnErrorSecondary = document.getElementById("btn-error-secondary");
const btnErrorDetails = document.getElementById("btn-error-details");
const btnOpenBrowser = document.getElementById("btn-open-browser");

/** From here the splash shows how long it has been waiting. */
const SLOW_AFTER_MS = 8 * 1000;
/** From here it says so and offers a restart, still on the neutral splash. */
const VERY_SLOW_AFTER_MS = 25 * 1000;
/** Rust reports a hung engine after 3 minutes; this only covers Rust never answering. */
const NO_ANSWER_AFTER_MS = 3 * 60 * 1000;
/** Entry waits for the update check, but never longer than this. */
const UPDATE_CHECK_CAP_MS = 20 * 1000;
const HEALTH_POLL_MS = 500;

// Resolved from Rust once the engine has bound. 8000 is only the starting guess.
let enginePort = 8000;
let startedAt = Date.now();
let engineHealthy = false;
// Inside the desktop app, entry waits for `update-status` so a pending update is never
// skipped by accident.
let updateCheckPending = false;
let isUpdating = false;
let isEntering = false;
let failureShown = false;
let pollingActive = false;
// What the error card's buttons do; set by each failure.
let primaryAction = null;
let secondaryAction = null;
// Bumped per card, so a slow /health answer only reveals Open in browser on its own card.
let failureSeq = 0;

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || null;
}

function engineUrl(path = "") {
  return `http://127.0.0.1:${enginePort}${path}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Leaves the launcher for the studio. Its own function so tests can watch it. */
function navigate(url) {
  window.location.replace(url);
}

function showView(view) {
  splash.hidden = view !== "splash";
  updaterBox.hidden = view !== "update";
  errorBox.hidden = view !== "error";
}

async function engineAnswers() {
  try {
    const resp = await fetch(engineUrl("/health"), { cache: "no-store" });
    return !!resp.ok;
  } catch (_) {
    return false;
  }
}

// --- Splash -----------------------------------------------------------------

/** Runs every second: the elapsed line, Restart from 25 s, and the 3 minute safety. */
function renderElapsed() {
  if (isEntering || isUpdating || failureShown) return;
  const elapsed = Date.now() - startedAt;
  const waiting = !engineHealthy;
  if (waiting && elapsed >= NO_ANSWER_AFTER_MS) {
    showEngineFailure({
      title: "DubMate didn't start",
      message: "It didn't answer for 3 minutes. Press Restart DubMate.",
      detail: `Address: ${engineUrl()}`,
    });
    return;
  }
  const secs = Math.floor(elapsed / 1000);
  let line = "";
  if (waiting && elapsed >= VERY_SLOW_AFTER_MS) line = `Taking longer than usual · ${secs} s`;
  else if (waiting && elapsed >= SLOW_AFTER_MS) line = `Still starting · ${secs} s`;
  detailText.textContent = line;
  btnRestartSlow.hidden = !(waiting && elapsed >= VERY_SLOW_AFTER_MS);
}

/** Back to the splash, counting from now. */
function restartWait() {
  failureShown = false;
  engineHealthy = false;
  startedAt = Date.now();
  detailText.textContent = "";
  btnRestartSlow.hidden = true;
  showView("splash");
  pollHealth();
}

/** Restart DubMate: Rust stops and starts the engine and reports its stages. */
function restartEngine() {
  restartWait();
  const invoke = tauriInvoke();
  if (invoke) {
    // It resolves only once the engine answers, so don't wait for it.
    invoke("trigger_start_sidecars").catch((e) => console.warn("[Launcher] Restart failed:", e));
  }
}

/** Watches /health until the engine answers. It never writes text. */
async function pollHealth() {
  if (pollingActive) return;
  pollingActive = true;
  while (!engineHealthy && !isEntering && !isUpdating && !failureShown) {
    if (await engineAnswers()) {
      engineHealthy = true;
      break;
    }
    await sleep(HEALTH_POLL_MS);
  }
  pollingActive = false;
  if (engineHealthy) {
    renderElapsed();
    tryEnter();
  }
}

function tryEnter() {
  if (isEntering || isUpdating || failureShown || !engineHealthy || updateCheckPending) return;
  isEntering = true;
  navigate(engineUrl());
}

// --- Error card ---------------------------------------------------------------

/**
 * Shows the error card. The title is the cause, the message the action, and the
 * detail (the log) sits behind Show details. `primary` and `secondary` are
 * [label, action] pairs; a null secondary hides that button.
 */
function showFailure({ title, message, detail, primary, secondary }) {
  failureShown = true;
  const seq = ++failureSeq;
  showView("error");
  errorTitle.textContent = title;
  errorMsg.textContent = message;
  errorRaw.textContent = detail || "";
  setDetailsOpen(false);
  btnErrorDetails.hidden = !detail;
  [btnRetry.textContent, primaryAction] = primary;
  btnErrorSecondary.hidden = !secondary;
  if (secondary) [btnErrorSecondary.textContent, secondaryAction] = secondary;
  btnOpenBrowser.hidden = true;
  btnRetry.focus();
  // Open in browser only helps if the engine answers; checked once, as the card opens.
  if (tauriInvoke()) {
    engineAnswers().then((up) => {
      if (up && failureShown && seq === failureSeq) btnOpenBrowser.hidden = false;
    });
  }
}

function setDetailsOpen(open) {
  errorRaw.hidden = !open;
  btnErrorDetails.textContent = open ? "Hide details" : "Show details";
  btnErrorDetails.setAttribute("aria-expanded", String(open));
}

async function copyDetails() {
  const text = errorRaw.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btnErrorSecondary.textContent = "Copied";
    setTimeout(() => {
      if (secondaryAction === copyDetails) btnErrorSecondary.textContent = "Copy details";
    }, 2000);
  } catch (_) {
    // No clipboard: show the log selected, ready to copy by hand.
    setDetailsOpen(true);
    window.getSelection?.()?.selectAllChildren(errorRaw);
  }
}

/** An engine failure from Rust ({kind, title, message, detail}). */
function showEngineFailure(failure) {
  showFailure({
    title: failure.title || "DubMate didn't start",
    message: failure.message || "Press Restart DubMate to try again.",
    detail: failure.detail,
    primary: ["Restart DubMate", restartEngine],
    secondary: failure.detail ? ["Copy details", copyDetails] : null,
  });
}

/**
 * Rust puts the plain reason first and the technical part after "\n\nDetails: ".
 * Without the marker the whole text is technical.
 */
function splitDetails(error) {
  const text = String(error ?? "");
  const marker = "\n\nDetails: ";
  const cut = text.indexOf(marker);
  if (cut < 0) return { reason: "", detail: text };
  return { reason: text.slice(0, cut).trim(), detail: text.slice(cut + marker.length) };
}

/** `server-error` is a struct; an older payload was a string with the details appended. */
function failureFromPayload(payload) {
  if (payload && typeof payload === "object") return payload;
  const { reason, detail } = splitDetails(payload || "DubMate couldn't start.");
  return reason
    ? { title: "DubMate didn't start", message: reason, detail }
    : { title: "DubMate didn't start", message: detail, detail: "" };
}

// --- Update card --------------------------------------------------------------

function etaText(secs) {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return "";
  if (secs < 60) return "less than a minute left";
  return `about ${Math.round(secs / 60)} min left`;
}

function megabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function setProgressText(text) {
  progressMeta.textContent = text;
  progressBar.setAttribute("aria-valuetext", text);
}

function showUpdateCard(update) {
  const first = !!update.first_download;
  updaterTitle.textContent = first ? "Downloading DubMate" : `Updating to DubMate ${update.latest_version}`;
  updaterMsg.textContent = first ? "This happens once." : "DubMate restarts when it's done.";
  progressHeadline.textContent = first ? "" : "Downloading the update";
  progressBar.classList.add("is-idle");
  progressFill.style.width = "0%";
  progressBar.setAttribute("aria-valuenow", "0");
  setProgressText("");
  btnSkipUpdate.hidden = first;
  btnSkipUpdate.disabled = false;
  btnSkipUpdate.textContent = "Skip this time";
  showView("update");
}

/** An `update-progress` payload: {received, total, percentage, eta_secs}. */
function renderUpdateProgress(p) {
  if (!p) return;
  progressBar.classList.remove("is-idle");
  if (p.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(p.percentage)));
    progressFill.style.width = `${pct}%`;
    progressBar.setAttribute("aria-valuenow", String(pct));
    const parts = [`${pct}%`, `${megabytes(p.received)} of ${megabytes(p.total)}`];
    const eta = etaText(p.eta_secs);
    if (eta) parts.push(eta);
    setProgressText(parts.join(" · "));
  } else {
    // Size unknown: a full bar with the moving sheen, and just the amount so far.
    progressFill.style.width = "100%";
    progressBar.removeAttribute("aria-valuenow");
    setProgressText(megabytes(p.received));
  }
}

/**
 * An `update-stage` payload: a step with no byte count, such as installing what the
 * new version needs. The engine may be stopped from here, so Skip goes.
 */
function renderUpdateStage(payload) {
  if (!payload) return;
  btnSkipUpdate.hidden = true;
  progressHeadline.textContent = payload.headline || "Finishing the update";
  progressBar.classList.remove("is-idle");
  progressFill.style.width = "100%";
  progressBar.removeAttribute("aria-valuenow");
  setProgressText(payload.detail || "");
}

async function runUpdate(update) {
  const invoke = tauriInvoke();
  isUpdating = true;
  failureShown = false;
  showUpdateCard(update);
  try {
    await invoke("apply_update", { downloadUrl: update.download_url });
    // Success: `update-complete` follows and opens the studio.
  } catch (e) {
    isUpdating = false;
    if (String(e) === "skipped") {
      openStudioWithoutUpdate();
      return;
    }
    console.error("[Updater] Update failed:", e);
    showUpdateFailure(update, e);
  }
}

/** Skip, or Open DubMate after a failed update: wait for the engine, don't restart it. */
function openStudioWithoutUpdate() {
  isUpdating = false;
  updateCheckPending = false;
  restartWait();
}

function showUpdateFailure(update, error) {
  const { reason, detail } = splitDetails(error);
  if (update.first_download) {
    // There is nothing to open yet.
    showFailure({
      title: "DubMate didn't download",
      message: reason ? `${reason} Press Try again.` : "Check your internet connection, then press Try again.",
      detail,
      primary: ["Try again", () => runUpdate(update)],
      secondary: detail ? ["Copy details", copyDetails] : null,
    });
    return;
  }
  showFailure({
    title: "The update didn't install",
    message: `The update to DubMate ${update.latest_version} didn't install. `
      + `${reason ? `${reason} ` : ""}You're still on ${update.current_version}.`,
    detail,
    primary: ["Open DubMate", openStudioWithoutUpdate],
    secondary: ["Try the update again", () => runUpdate(update)],
  });
}

// --- Pack Builder ---------------------------------------------------------------

/**
 * Starts the Pack Builder download when the installer recorded an opt-in. The command
 * returns at once and the install runs in the background; the studio shows it.
 */
async function startPackBuilderIfWanted(invoke) {
  try {
    const status = await invoke("get_packbuilder_status");
    if (status?.opted_in && !status.installed) {
      invoke("start_packbuilder_install").catch((e) => console.warn("[PackBuilder] Install didn't start:", e));
    }
  } catch (e) {
    console.warn("[PackBuilder] Status unavailable:", e);
  }
}

// --- Wiring -----------------------------------------------------------------------

async function listenToRust() {
  const { listen } = window.__TAURI__.event;
  const invoke = tauriInvoke();

  try {
    const p = await invoke("get_engine_port");
    if (Number.isInteger(p) && p > 0) enginePort = p;
  } catch (e) {
    console.warn("[Launcher] Could not resolve engine port, using", enginePort, e);
  }

  listen("startup-progress", (event) => {
    if (!isEntering && typeof event.payload === "string") statusText.textContent = event.payload;
  });

  listen("server-ready", (event) => {
    // Rust sends the port it actually bound to.
    if (Number.isInteger(event?.payload) && event.payload > 0) enginePort = event.payload;
    engineHealthy = true;
    if (updateCheckPending && !isUpdating) statusText.textContent = "Checking for updates";
    renderElapsed();
    tryEnter();
  });

  listen("server-error", (event) => {
    if (isUpdating || isEntering) return;
    showEngineFailure(failureFromPayload(event.payload));
  });

  listen("update-status", async (event) => {
    const payload = event.payload;
    if (payload?.status === "UpdateAvailable" && payload.data) {
      updateCheckPending = false;
      runUpdate(payload.data);
      return;
    }
    // Up to date or offline.
    await startPackBuilderIfWanted(invoke);
    updateCheckPending = false;
    tryEnter();
  });

  listen("update-progress", (event) => renderUpdateProgress(event.payload));
  listen("update-stage", (event) => renderUpdateStage(event.payload));

  // Rust restarted the engine on the new files before sending this.
  listen("update-complete", () => {
    setProgressText("Restarting");
    openStudioWithoutUpdate();
  });
}

let initialised = false;

async function init() {
  if (initialised) return;
  initialised = true;

  btnRestartSlow.addEventListener("click", restartEngine);
  btnRetry.addEventListener("click", () => primaryAction?.());
  btnErrorSecondary.addEventListener("click", () => secondaryAction?.());
  btnErrorDetails.addEventListener("click", () => setDetailsOpen(errorRaw.hidden));
  btnOpenBrowser.addEventListener("click", () => {
    tauriInvoke()?.("open_studio_in_browser").catch((e) => console.warn("[Launcher] Open in browser:", e));
  });
  btnSkipUpdate.addEventListener("click", () => {
    btnSkipUpdate.disabled = true;
    btnSkipUpdate.textContent = "Skipping…";
    // apply_update then fails with "skipped", and runUpdate opens the studio.
    tauriInvoke()("cancel_update").catch((e) => {
      console.warn("[Updater] Skip failed:", e);
      btnSkipUpdate.disabled = false;
      btnSkipUpdate.textContent = "Skip this time";
    });
  });

  startedAt = Date.now();
  setInterval(renderElapsed, 1000);

  if (window.__TAURI__?.event && tauriInvoke()) {
    updateCheckPending = true;
    setTimeout(() => {
      if (updateCheckPending) {
        updateCheckPending = false;
        tryEnter();
      }
    }, UPDATE_CHECK_CAP_MS);
    await listenToRust();
  }

  pollHealth();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
