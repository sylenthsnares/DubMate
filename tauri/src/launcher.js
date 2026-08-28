// launcher.js - Bridges Tauri desktop window directly into DubMate Studio Pro (http://127.0.0.1:8000)

const isTauri = typeof window.__TAURI__ !== "undefined";

const splash = document.getElementById("splash");
const updaterBox = document.getElementById("updater-box");
const progressFill = document.getElementById("progress-fill");
const progressPercent = document.getElementById("progress-percent");
const progressText = document.getElementById("progress-text");
const updaterMsg = document.getElementById("updater-msg");
const statusText = document.getElementById("status-text");

let isUpdating = false;

async function init() {
  if (isTauri) {
    const { listen } = window.__TAURI__.event;
    const { invoke } = window.__TAURI__.core;

    // Listen for OTA update check result
    listen("update-status", async (event) => {
      const payload = event.payload;
      if (payload?.status === "UpdateAvailable" && payload.data) {
        isUpdating = true;
        if (splash) splash.style.display = "none";
        if (updaterBox) updaterBox.style.display = "block";
        if (updaterMsg) {
          updaterMsg.innerText = payload.data.changelog || "Downloading core update bundle...";
        }

        try {
          await invoke("apply_update", { downloadUrl: payload.data.download_url });
        } catch (e) {
          console.error("[Updater] Update failed:", e);
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

    // Listen for server readiness from Rust
    listen("server-ready", () => {
      if (!isUpdating) {
        enterStudio();
      }
    });
  }

  // Active polling to transition into the studio the instant port 8000 is ready
  pollAndEnterStudio();
}

async function pollAndEnterStudio() {
  for (let i = 0; i < 60; i++) {
    if (isUpdating) return;
    try {
      const resp = await fetch("http://127.0.0.1:8000/health");
      if (resp.ok) {
        enterStudio();
        return;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }

  if (statusText && !isUpdating) {
    statusText.innerText = "Connecting to studio engine...";
  }
}

function enterStudio() {
  if (isUpdating) return;
  // Seamlessly load the full DubMate Studio Pro interface into the native window
  window.location.replace("http://127.0.0.1:8000");
}

init();
