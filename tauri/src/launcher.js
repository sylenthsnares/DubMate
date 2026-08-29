// launcher.js - Bridges the Tauri desktop window into DubMate Studio Pro.
// The engine port is chosen at runtime (8000 unless taken), so never hardcode it.

const splash = document.getElementById("splash");
const updaterBox = document.getElementById("updater-box");
const errorBox = document.getElementById("error-box");
const progressFill = document.getElementById("progress-fill");
const progressPercent = document.getElementById("progress-percent");
const progressText = document.getElementById("progress-text");
const updaterMsg = document.getElementById("updater-msg");
const statusText = document.getElementById("status-text");
const detailText = document.getElementById("detail-text");
const errorMsg = document.getElementById("error-msg");
const errorTitle = document.getElementById("error-title");
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

function showError(msg, title) {
  if (isEntering || isUpdating || isInstallingBuilder) return;
  if (splash) splash.style.display = "none";
  if (updaterBox) updaterBox.style.display = "none";
  if (errorBox) errorBox.style.display = "block";
  if (errorTitle && title) errorTitle.innerText = title;
  if (errorMsg) errorMsg.innerText = msg || "Studio engine is taking longer than expected to start.";
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
      updateStatus("Restarting Studio Engine...", "Re-initializing processes...");
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
            updaterMsg.innerText = payload.data.changelog || "Downloading core update bundle...";
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
              `${e}

DubMate could not apply update ${payload.data.latest_version}. ` +
              `It is still running version ${payload.data.current_version}. ` +
              `Click Retry to start the studio with the current version.`,
              "Update Failed"
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

      // Stream pip output during the Pack Builder download
      listen("packbuilder-progress", (event) => {
        if (progressText && event.payload) {
          progressText.innerText = String(event.payload).slice(0, 120);
        }
      });

      // Listen for download progress
      listen("update-progress", (event) => {
        const p = event.payload;
        if (p) {
          if (progressFill) progressFill.style.width = `${p.percentage}%`;
          if (progressPercent) progressPercent.innerText = `${p.percentage}%`;
          if (progressText) {
            progressText.innerText = `${(p.received / (1024 * 1024)).toFixed(1)} MB / ${(p.total / (1024 * 1024)).toFixed(1)} MB`;
          }
        }
      });

      // Listen for update completion
      listen("update-complete", () => {
        if (progressText) progressText.innerText = "Restarting Studio...";
        setTimeout(() => {
          window.location.reload();
        }, 500);
      });

      // Listen for startup progress events from Rust
      listen("startup-progress", (event) => {
        if (!isUpdating && !isEntering && event.payload) {
          updateStatus("Starting Studio Engine...", event.payload);
        }
      });

      // Listen for server error events from Rust
      listen("server-error", (event) => {
        if (!isUpdating && !isEntering) {
          showError(event.payload || "Failed to initialize studio engine.");
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
    updaterMsg.innerText =
      "Installing the Pack Builder AI pipeline (PyTorch + Demucs + Whisper). " +
      "One-time download of roughly 2 GB into " + status.target_dir + ".";
  }
  if (progressFill) progressFill.style.width = "100%";
  if (progressPercent) progressPercent.innerText = "";
  if (progressText) progressText.innerText = "Resolving packages...";

  try {
    await invoke("install_packbuilder");
    isInstallingBuilder = false;
    return true;
  } catch (e) {
    console.error("[PackBuilder] Install failed:", e);
    isInstallingBuilder = false;
    showError(
      `${e}

DubMate Studio itself is unaffected and runs normally without the AI ` +
      `pack builder. Click Retry to continue into the studio.`,
      "Pack Builder Install Failed"
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
      updateStatus("Starting Studio Engine...", `Connecting to local engine (${i}/${maxAttempts})...`);
    } else if (i <= 15) {
      updateStatus("Starting Studio Engine...", `Launching Python runtime (${i}/${maxAttempts})...`);
    } else if (i <= 25) {
      updateStatus("Connecting to Studio Engine...", `Warming up audio engines & packs (${i}/${maxAttempts})...`);
    } else {
      updateStatus("Connecting to Studio Engine...", `Awaiting port ${enginePort} response (${i}/${maxAttempts})...`);
    }

    // After 25 attempts (12.5s), show error recovery if taking unusually long
    if (i === 30 && !isEntering && !isUpdating) {
      showError(`Studio engine is taking longer than expected. Port ${enginePort} has not responded yet.`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  pollingActive = false;
  if (!isUpdating && !isEntering) {
    showError(`Studio engine did not respond on ${engineUrl()} within 60 seconds. Click Retry to restart it.`);
  }
}

function enterStudio() {
  if (isUpdating || isEntering || isInstallingBuilder || builderCheckPending) return;
  isEntering = true;
  updateStatus("Loading Studio Interface...", "Redirecting to local DAW workspace...");
  // Seamlessly load the full DubMate Studio Pro interface into the native window
  window.location.replace(engineUrl());
}

window.addEventListener("DOMContentLoaded", init);
if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
}
