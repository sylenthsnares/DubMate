// launcher.js - Bridges Tauri desktop window directly into DubMate Studio Pro (http://127.0.0.1:8000)

const isTauri = typeof window.__TAURI__ !== "undefined";

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
const btnRetry = document.getElementById("btn-retry");
const btnOpenBrowser = document.getElementById("btn-open-browser");

let isUpdating = false;
let isEntering = false;
let pollingActive = false;

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

function showError(msg) {
  if (isEntering || isUpdating) return;
  if (splash) splash.style.display = "none";
  if (updaterBox) updaterBox.style.display = "none";
  if (errorBox) errorBox.style.display = "block";
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
      if (isTauri && window.__TAURI__?.core?.invoke) {
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
      window.open("http://127.0.0.1:8000", "_blank");
    });
  }

  if (isTauri) {
    const { listen } = window.__TAURI__.event;
    const { invoke } = window.__TAURI__.core;

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
          console.error("[Updater] Update failed:", e);
          isUpdating = false;
          showSplash();
          enterStudio();
        }
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
    listen("server-ready", () => {
      if (!isUpdating) {
        enterStudio();
      }
    });
  }

  // Active polling to transition into the studio the instant port 8000 responds
  pollAndEnterStudio();
}

async function pollAndEnterStudio() {
  if (pollingActive) return;
  pollingActive = true;

  const maxAttempts = 120; // 60 seconds of polling
  for (let i = 1; i <= maxAttempts; i++) {
    if (isUpdating || isEntering) {
      pollingActive = false;
      return;
    }

    try {
      const resp = await fetch("http://127.0.0.1:8000/health", {
        headers: { "Cache-Control": "no-cache" }
      });
      if (resp.ok) {
        pollingActive = false;
        enterStudio();
        return;
      }
    } catch (_) {}

    // Progressive status updates
    if (i === 15) {
      updateStatus("Starting Studio Engine...", "Starting Python background service...");
    } else if (i === 35) {
      updateStatus("Connecting to Studio Engine...", "Warming up audio engines & packs...");
    } else if (i === 60) {
      updateStatus("Waiting for Studio Engine...", "Verifying port 8000 response...");
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  pollingActive = false;
  if (!isUpdating && !isEntering) {
    showError("Studio engine did not respond on http://127.0.0.1:8000 within 60 seconds. Check if another process is using port 8000 or click Retry.");
  }
}

function enterStudio() {
  if (isUpdating || isEntering) return;
  isEntering = true;
  updateStatus("Loading Studio Interface...", "Redirecting to local DAW workspace...");
  // Seamlessly load the full DubMate Studio Pro interface into the native window
  window.location.replace("http://127.0.0.1:8000");
}

init();
