// launcher.js - Bridges the Tauri desktop window into DubMate.
// The engine port is chosen at runtime (8000 unless taken), so never hardcode it.

const splash = document.getElementById("splash");
const updaterBox = document.getElementById("updater-box");
const errorBox = document.getElementById("error-box");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const progressPercent = document.getElementById("progress-percent");
const progressText = document.getElementById("progress-text");
const progressHeadline = document.getElementById("progress-headline");
const builderStages = document.getElementById("builder-stages");
const techDetails = document.getElementById("tech-details");
const techLog = document.getElementById("tech-log");
const updaterMsg = document.getElementById("updater-msg");
const statusText = document.getElementById("status-text");
const detailText = document.getElementById("detail-text");
const errorMsg = document.getElementById("error-msg");
const errorTitle = document.getElementById("error-title");
const errorDetails = document.getElementById("error-details");
const errorRaw = document.getElementById("error-raw");
const updaterTitle = document.getElementById("updater-title");
const btnRetry = document.getElementById("btn-retry");
const btnOpenBrowser = document.getElementById("btn-open-browser");

let isUpdating = false;
let isEntering = false;
let pollingActive = false;
let isInstallingBuilder = false;
// Blocks entry into the studio until we know whether a first-run Pack Builder
// download is required. Cleared by the update-status handler or the safety timer.
let builderCheckPending = false;
// Resolved from Rust once the engine has bound. 8000 is only the starting guess.
let enginePort = 8000;

function engineUrl(path = "") {
  return `http://127.0.0.1:${enginePort}${path}`;
}

async function refreshEnginePort(invoke) {
  try {
    const p = await invoke("get_engine_port");
    if (Number.isInteger(p) && p > 0) enginePort = p;
  } catch (e) {
    console.warn("[Launcher] Could not resolve engine port, using", enginePort, e);
  }
}

function showSplash() {
  if (splash) splash.style.display = "flex";
  if (updaterBox) updaterBox.style.display = "none";
  if (errorBox) errorBox.style.display = "none";
}

function showUpdater() {
  if (splash) splash.style.display = "none";
  if (updaterBox) updaterBox.style.display = "block";
  if (errorBox) errorBox.style.display = "none";
}

// `detail` is the raw error text. It sits behind "Show details" so the message
// stays plain, and stays selectable for bug reports.
function showError(msg, title, detail) {
  if (isEntering || isUpdating || isInstallingBuilder) return;
  if (splash) splash.style.display = "none";
  if (updaterBox) updaterBox.style.display = "none";
  if (errorBox) errorBox.style.display = "block";
  if (errorTitle && title) errorTitle.innerText = title;
  if (errorMsg) errorMsg.innerText = msg || "DubMate is taking longer than usual to start. Click Try again.";
  if (errorDetails && errorRaw) {
    const raw = detail ? String(detail) : "";
    errorRaw.innerText = raw;
    errorDetails.open = false;
    errorDetails.style.display = raw ? "block" : "none";
  }
}

function updateStatus(mainMsg, subMsg) {
  if (statusText && mainMsg) statusText.innerText = mainMsg;
  if (detailText && subMsg !== undefined) detailText.innerText = subMsg;
}

async function init() {
  // Wire action buttons
  if (btnRetry) {
    btnRetry.addEventListener("click", async () => {
      showSplash();
      updateStatus("Restarting DubMate", "");
      if (window.__TAURI__?.core?.invoke) {
        try {
          await window.__TAURI__.core.invoke("trigger_start_sidecars");
        } catch (e) {
          console.warn("[Launcher] trigger_start_sidecars error:", e);
        }
      }
      pollAndEnterStudio();
    });
  }

  if (btnOpenBrowser) {
    btnOpenBrowser.addEventListener("click", () => {
      window.open(engineUrl(), "_blank");
    });
  }

  // Setup Tauri event listeners if running inside Tauri
  const setupTauri = async () => {
    if (typeof window.__TAURI__ !== "undefined" && window.__TAURI__.event) {
      const { listen } = window.__TAURI__.event;
      const { invoke } = window.__TAURI__.core;

      await refreshEnginePort(invoke);

      // Hold studio entry until update-status tells us whether a first-run Pack
      // Builder download is needed. Never hold longer than 20s.
      builderCheckPending = true;
      setTimeout(() => {
        if (builderCheckPending) {
          builderCheckPending = false;
          pollAndEnterStudio();
        }
      }, 20000);

      // Listen for OTA update check result
      listen("update-status", async (event) => {
        const payload = event.payload;
        if (payload?.status === "UpdateAvailable" && payload.data) {
          isUpdating = true;
          showUpdater();
          if (updaterMsg) {
            updaterMsg.innerText = payload.data.changelog || "Downloading the update";
          }

          try {
            await invoke("apply_update", { downloadUrl: payload.data.download_url });
          } catch (e) {
            // Previously this fell through to enterStudio() silently, so a failed
            // update was indistinguishable from a successful one and users kept
            // running the old code believing the fix had shipped.
            console.error("[Updater] Update failed:", e);
            isUpdating = false;
            builderCheckPending = false;
            showError(
              `The update to version ${payload.data.latest_version} didn't install. ` +
              `DubMate is still on version ${payload.data.current_version}. ` +
              `Click Try again to open it.`,
              "Update failed",
              e
            );
          }
        } else {
          // No update pending, so this is the right moment to settle the optional
          // Pack Builder download before the window navigates into the studio.
          if (await maybeInstallPackBuilder(invoke)) {
            pollAndEnterStudio();
          }
        }
      });

      // Structured install progress during the Pack Builder download
      listen("packbuilder-progress", (event) => {
        renderBuilderProgress(event.payload);
      });

      // Listen for download progress
      listen("update-progress", (event) => {
        const p = event.payload;
        if (p) {
          // The updater shares this card with the Pack Builder install; keep the
          // builder-only chrome out of the way.
          if (builderStages) builderStages.style.display = "none";
          if (techDetails) techDetails.style.display = "none";
          if (progressBar) progressBar.classList.remove("is-idle");
          if (progressHeadline) progressHeadline.innerText = "Downloading the update";
          const receivedMb = (p.received / (1024 * 1024)).toFixed(1);
          if (p.total > 0) {
            if (progressFill) progressFill.style.width = `${p.percentage}%`;
            if (progressPercent) progressPercent.innerText = `${p.percentage}%`;
            if (progressText) {
              progressText.innerText = `${receivedMb} MB / ${(p.total / (1024 * 1024)).toFixed(1)} MB`;
            }
          } else {
            // Size unknown: a full bar with the moving sheen, and just the amount so far.
            if (progressFill) progressFill.style.width = "100%";
            if (progressPercent) progressPercent.innerText = "";
            if (progressText) progressText.innerText = `${receivedMb} MB`;
          }
        }
      });

      // Listen for update completion
      listen("update-complete", () => {
        if (progressText) progressText.innerText = "Restarting";
        setTimeout(() => {
          window.location.reload();
        }, 500);
      });

      // Listen for startup progress events from Rust
      listen("startup-progress", (event) => {
        if (!isUpdating && !isEntering && event.payload) {
          updateStatus("Starting DubMate", event.payload);
        }
      });

      // Listen for server error events from Rust
      listen("server-error", (event) => {
        if (!isUpdating && !isEntering) {
          // Rust appends the raw error as "\n\nDetails: ..."; keep it behind Show details.
          const text = String(event.payload || "DubMate couldn't start. Click Try again.");
          const marker = "\n\nDetails: ";
          const cut = text.indexOf(marker);
          if (cut >= 0) {
            showError(text.slice(0, cut), "DubMate didn't start", text.slice(cut + marker.length));
          } else {
            showError(text, "DubMate didn't start");
          }
        }
      });

      // Listen for server readiness from Rust
      listen("server-ready", (event) => {
        // Rust sends the port it actually bound to.
        if (Number.isInteger(event?.payload) && event.payload > 0) {
          enginePort = event.payload;
        }
        if (!isUpdating) {
          enterStudio();
        }
      });
    }
  };

  await setupTauri();

  // Active polling to transition into the studio the instant the engine responds
  pollAndEnterStudio();
}

const BUILDER_STAGE_ORDER = ["preparing", "downloading", "installing", "finalizing"];

/**
 * Renders a `PackBuilderProgress` from Rust: stage indicator, bar, plain-language
 * headline, and the raw pip line tucked into a collapsed details pane.
 *
 * Tolerates a bare string payload so an older Rust build (or the engine-restart
 * notice) still shows something sensible rather than "[object Object]".
 */
function renderBuilderProgress(payload) {
  if (!payload) return;
  const p = typeof payload === "string"
    ? { phase: "", headline: payload.slice(0, 120), detail: "", percent: null, raw: payload }
    : payload;

  if (progressHeadline && p.headline) progressHeadline.innerText = p.headline;
  if (progressText) progressText.innerText = p.detail || "";

  if (typeof p.percent === "number" && Number.isFinite(p.percent)) {
    const pct = Math.max(0, Math.min(100, p.percent));
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressPercent) progressPercent.innerText = `${Math.round(pct)}%`;
  }

  // Highlight the current stage and mark earlier ones done.
  if (builderStages && p.phase) {
    const current = BUILDER_STAGE_ORDER.indexOf(p.phase);
    builderStages.querySelectorAll(".stage").forEach((el) => {
      const index = BUILDER_STAGE_ORDER.indexOf(el.dataset.stage);
      el.classList.toggle("is-active", index === current);
      el.classList.toggle("is-done", current >= 0 && index < current);
    });
  }

  if (techLog && p.raw) {
    techLog.innerText = p.raw;
  }
}

/**
 * Runs the one-time Pack Builder AI download when the installer recorded an opt-in.
 * Returns false only when the install failed and an error card is now on screen,
 * so the caller knows not to navigate away from it.
 */
async function maybeInstallPackBuilder(invoke) {
  let status = null;
  try {
    status = await invoke("get_packbuilder_status");
  } catch (e) {
    console.warn("[PackBuilder] Status unavailable:", e);
  }

  if (!status || !status.opted_in || status.installed) {
    builderCheckPending = false;
    return true;
  }

  isInstallingBuilder = true;
  builderCheckPending = false;
  showUpdater();
  if (updaterTitle) updaterTitle.innerText = "PACK BUILDER";
  if (updaterMsg) {
    // Say what it does, not what it is called. Package names mean nothing to
    // someone who just wants to turn a video into a dubbing scene.
    updaterMsg.innerText =
      "Downloading Pack Builder, about 2 GB. This happens once.";
  }
  if (builderStages) builderStages.style.display = "flex";
  if (techDetails) techDetails.style.display = "block";
  if (progressBar) progressBar.classList.remove("is-idle");
  if (progressFill) progressFill.style.width = "2%";
  if (progressPercent) progressPercent.innerText = "0%";
  if (progressHeadline) progressHeadline.innerText = "Getting ready";
  if (progressText) progressText.innerText = "";

  try {
    await invoke("install_packbuilder");
    isInstallingBuilder = false;
    return true;
  } catch (e) {
    console.error("[PackBuilder] Install failed:", e);
    isInstallingBuilder = false;
    showError(
      `Pack Builder didn't install. Everything else works. ` +
      `Click Try again to open DubMate. Pack Builder will install the next time you start it.`,
      "Pack Builder didn't install",
      e
    );
    return false;
  }
}

async function pollAndEnterStudio() {
  if (pollingActive) return;
  pollingActive = true;

  const maxAttempts = 120; // Up to 60 seconds
  for (let i = 1; i <= maxAttempts; i++) {
    if (isUpdating || isEntering || isInstallingBuilder || builderCheckPending) {
      pollingActive = false;
      return;
    }

    try {
      const resp = await fetch(engineUrl("/health"), {
        headers: { "Cache-Control": "no-cache" }
      });
      if (resp.ok) {
        pollingActive = false;
        enterStudio();
        return;
      }
    } catch (_) {}

    // Live continuous status updates
    if (i <= 5) {
      updateStatus("Starting DubMate", "");
    } else if (i <= 15) {
      updateStatus("Starting DubMate", "");
    } else if (i <= 25) {
      updateStatus("Starting DubMate", "");
    } else {
      updateStatus("Still starting", "");
    }

    // After 25 attempts (12.5s), show error recovery if taking unusually long
    if (i === 30 && !isEntering && !isUpdating) {
      showError("DubMate is taking longer than usual to start. Click Try again, or open it in your browser.", "Still starting");
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  pollingActive = false;
  if (!isUpdating && !isEntering) {
    showError(
      "DubMate didn't start within a minute. Click Try again to restart it.",
      "DubMate didn't start",
      `Address: ${engineUrl()}`
    );
  }
}

function enterStudio() {
  if (isUpdating || isEntering || isInstallingBuilder || builderCheckPending) return;
  isEntering = true;
  updateStatus("Opening DubMate", "");
  // Seamlessly load the full DubMate interface into the native window
  window.location.replace(engineUrl());
}

window.addEventListener("DOMContentLoaded", init);
if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
}
