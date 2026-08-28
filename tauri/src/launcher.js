// launcher.js - DubMate Desktop App Launcher & Auto-Updater Controller

const WORKER_REGISTRY_URL = "https://dubmate.bkaproductions.com";

let isServerReady = false;
let isTunnelReady = false;
let currentTunnelUrl = "";
let pendingUpdateInfo = null;

// DOM Elements
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const selectPack = document.getElementById("select-pack");
const inputHostName = document.getElementById("input-host-name");
const btnCreateRoom = document.getElementById("btn-create-room");
const roomCreatedBox = document.getElementById("room-created-box");
const createdRoomCode = document.getElementById("created-room-code");
const shareLinkText = document.getElementById("share-link-text");
const btnCopyCode = document.getElementById("btn-copy-code");
const btnEnterStudio = document.getElementById("btn-enter-studio");

const inputJoinCode = document.getElementById("input-join-code");
const inputGuestName = document.getElementById("input-guest-name");
const btnJoinRoom = document.getElementById("btn-join-room");

const viewLauncher = document.getElementById("view-launcher");
const viewUpdater = document.getElementById("view-updater");
const updateTargetVersion = document.getElementById("update-target-version");
const updateProgressFill = document.getElementById("update-progress-fill");
const updateProgressText = document.getElementById("update-progress-text");
const updateProgressPercent = document.getElementById("update-progress-percent");
const updateChangelogText = document.getElementById("update-changelog-text");
const btnStartUpdate = document.getElementById("btn-start-update");
const footerEngineStatus = document.getElementById("footer-engine-status");

// Pack Configuration DOM Elements
const btnOpenConfig = document.getElementById("btn-open-config");
const btnQuickConfig = document.getElementById("btn-quick-config");
const btnFixPackPath = document.getElementById("btn-fix-pack-path");
const modalConfig = document.getElementById("modal-config");
const btnCloseConfig = document.getElementById("btn-close-config");
const btnCancelConfig = document.getElementById("btn-cancel-config");
const btnSaveConfig = document.getElementById("btn-save-config");
const inputPackPath = document.getElementById("input-pack-path");
const fileFolderPicker = document.getElementById("file-folder-picker");
const activePathText = document.getElementById("active-path-text");
const configFeedback = document.getElementById("config-feedback");
const boxPackWarning = document.getElementById("box-pack-warning");
const saveConfigSpinner = document.getElementById("save-config-spinner");
const saveConfigText = document.getElementById("save-config-text");

// Load stored preferences
const savedName = localStorage.getItem("dubmate_actor_name");
if (savedName) {
  if (inputHostName) inputHostName.value = savedName;
  if (inputGuestName) inputGuestName.value = savedName;
}

// Check Tauri environment
const isTauri = typeof window.__TAURI__ !== "undefined";

async function init() {
  if (isTauri) {
    const { listen } = window.__TAURI__.event;
    const { invoke } = window.__TAURI__.core;

    // Listen for update status
    listen("update-status", (event) => {
      const payload = event.payload;
      if (payload?.status === "UpdateAvailable" && payload.data) {
        showUpdateScreen(payload.data);
      }
    });

    // Listen for progress updates
    listen("update-progress", (event) => {
      const p = event.payload;
      if (p) {
        updateProgressFill.style.width = `${p.percentage}%`;
        updateProgressPercent.innerText = `${p.percentage}%`;
        updateProgressText.innerText = `Downloaded ${(p.received / (1024 * 1024)).toFixed(1)} MB / ${(p.total / (1024 * 1024)).toFixed(1)} MB`;
      }
    });

    listen("update-complete", () => {
      updateProgressText.innerText = "Update applied! Restarting app...";
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    });

    // Listen for server readiness
    listen("server-ready", () => {
      isServerReady = true;
      footerEngineStatus.innerText = "Online (port 8000)";
      loadConfigInfo();
      loadPacksList();
      checkEngineReadiness();
    });

    // Listen for tunnel readiness
    listen("tunnel-ready", (event) => {
      isTunnelReady = true;
      currentTunnelUrl = event.payload || "";
      checkEngineReadiness();
    });
  } else {
    // Browser fallback / mock mode for local debugging
    setTimeout(() => {
      isServerReady = true;
      isTunnelReady = true;
      currentTunnelUrl = "http://127.0.0.1:8000";
      footerEngineStatus.innerText = "Online (local web)";
      loadConfigInfo();
      loadPacksList();
      checkEngineReadiness();
    }, 1000);
  }
}

function checkEngineReadiness() {
  if (isServerReady && isTunnelReady) {
    statusDot.className = "dot dot-green";
    statusText.innerText = "Studio Engine & Tunnel Active";
    if (btnCreateRoom && selectPack.value) btnCreateRoom.disabled = false;
  } else if (isServerReady) {
    statusDot.className = "dot dot-amber";
    statusText.innerText = "Local Server Ready (Activating Tunnel...)";
  }
}

async function loadConfigInfo() {
  try {
    const resp = await fetch("http://127.0.0.1:8000/api/config");
    if (resp.ok) {
      const data = await resp.json();
      if (data.packs_dir) {
        if (activePathText) activePathText.innerText = data.packs_dir;
        if (inputPackPath && !inputPackPath.value) inputPackPath.value = data.packs_dir;
      }
    }
  } catch (err) {
    console.warn("Could not fetch active config:", err);
  }
}

async function loadPacksList() {
  try {
    const resp = await fetch("http://127.0.0.1:8000/api/packs");
    const data = await resp.json();
    const packs = Array.isArray(data) ? data : Object.values(data.packs || data);

    if (packs && packs.length > 0) {
      selectPack.innerHTML = packs.map(p => `
        <option value="${p.id || p.pack_id}">${p.name || p.title} (${p.line_count || p.lines?.length || 0} lines)</option>
      `).join("");
      if (boxPackWarning) boxPackWarning.style.display = "none";
      if (btnCreateRoom) btnCreateRoom.disabled = !isTunnelReady;
    } else {
      selectPack.innerHTML = `<option value="">No scene packs found in active folder</option>`;
      if (boxPackWarning) boxPackWarning.style.display = "flex";
      if (btnCreateRoom) btnCreateRoom.disabled = true;
    }
  } catch (err) {
    console.error("Error fetching packs registry:", err);
    selectPack.innerHTML = `<option value="">Error loading scene packs</option>`;
    if (boxPackWarning) boxPackWarning.style.display = "flex";
    if (btnCreateRoom) btnCreateRoom.disabled = true;
  }
}

// --- Pack Configuration Modal Controls ---
function openConfigModal() {
  if (configFeedback) configFeedback.style.display = "none";
  if (modalConfig) modalConfig.style.display = "flex";
  loadConfigInfo();
  if (inputPackPath) {
    setTimeout(() => inputPackPath.focus(), 50);
  }
}

function closeConfigModal() {
  if (modalConfig) modalConfig.style.display = "none";
}

if (btnOpenConfig) btnOpenConfig.addEventListener("click", openConfigModal);
if (btnQuickConfig) btnQuickConfig.addEventListener("click", openConfigModal);
if (btnFixPackPath) btnFixPackPath.addEventListener("click", openConfigModal);
if (btnCloseConfig) btnCloseConfig.addEventListener("click", closeConfigModal);
if (btnCancelConfig) btnCancelConfig.addEventListener("click", closeConfigModal);

// Close on backdrop click
if (modalConfig) {
  modalConfig.addEventListener("click", (e) => {
    if (e.target === modalConfig) closeConfigModal();
  });
}

// Close on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalConfig && modalConfig.style.display !== "none") {
    closeConfigModal();
  }
});

// File / Folder picker change event
if (fileFolderPicker) {
  fileFolderPicker.addEventListener("change", (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // In Chromium / WebView2, files[0].path or webkitRelativePath gives insight
      const firstFile = files[0];
      if (firstFile.path) {
        // Full filesystem path available in desktop WebViews
        const dir = firstFile.path.substring(0, Math.max(firstFile.path.lastIndexOf('\\'), firstFile.path.lastIndexOf('/')));
        if (inputPackPath) inputPackPath.value = dir;
      } else if (firstFile.webkitRelativePath) {
        const rootDirName = firstFile.webkitRelativePath.split('/')[0];
        if (inputPackPath) {
          // If input has existing path, update root folder, otherwise suggest folder name
          inputPackPath.value = rootDirName;
        }
      }
    }
  });
}

// Save & Scan Packs Button Handler
if (btnSaveConfig) {
  btnSaveConfig.addEventListener("click", async () => {
    const rawPath = (inputPackPath.value || "").trim();
    if (!rawPath) {
      showConfigFeedback("Please enter or browse to a valid scene packs folder path.", false);
      return;
    }

    btnSaveConfig.disabled = true;
    if (saveConfigSpinner) saveConfigSpinner.style.display = "inline-block";
    if (saveConfigText) saveConfigText.innerText = "Scanning Folder...";

    try {
      const resp = await fetch("http://127.0.0.1:8000/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packs_dir: rawPath })
      });

      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data.detail || data.message || "Failed to update packs directory.");
      }

      // Update UI state
      if (activePathText) activePathText.innerText = data.packs_dir;
      localStorage.setItem("dubmate_custom_packs_dir", data.packs_dir);

      showConfigFeedback(`✅ ${data.message || `Successfully loaded ${data.pack_count} scene pack(s)! Saved for future launches.`}`, true);

      // Refresh pack list
      await loadPacksList();

      setTimeout(() => {
        closeConfigModal();
        btnSaveConfig.disabled = false;
        if (saveConfigSpinner) saveConfigSpinner.style.display = "none";
        if (saveConfigText) saveConfigText.innerText = "Scan & Save Location";
      }, 1400);

    } catch (err) {
      let errMsg = err.message || "Unknown error";
      if (errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError")) {
        errMsg = "Could not reach local engine on port 8000. Please wait a moment while the engine initializes.";
      }
      showConfigFeedback(`❌ ${errMsg}`, false);
      btnSaveConfig.disabled = false;
      if (saveConfigSpinner) saveConfigSpinner.style.display = "none";
      if (saveConfigText) saveConfigText.innerText = "Scan & Save Location";
    }
  });
}

function showConfigFeedback(msg, isSuccess) {
  if (!configFeedback) return;
  configFeedback.className = `config-feedback-box ${isSuccess ? "success" : "error"}`;
  configFeedback.innerText = msg;
  configFeedback.style.display = "block";
}

// --- Create Room Handler ---
if (btnCreateRoom) {
  btnCreateRoom.addEventListener("click", async () => {
    const packId = selectPack.value;
    const hostName = (inputHostName.value || "").trim() || "Director";
    localStorage.setItem("dubmate_actor_name", hostName);

    btnCreateRoom.disabled = true;
    btnCreateRoom.innerText = "Registering Session...";

    try {
      // 1. Create Room in local FastAPI backend
      const localResp = await fetch("http://127.0.0.1:8000/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pack_id: packId,
          host_name: hostName,
          host_color: "#d97706",
          app_version: "1.0.2"
        })
      });
      const localData = await localResp.json();
      const roomId = localData.room_id;

      // 2. Register with Cloudflare Worker Room Registry
      let code = roomId;
      let roomToken = "";
      if (currentTunnelUrl) {
        try {
          const workerResp = await fetch(`${WORKER_REGISTRY_URL}/rooms/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tunnel_url: currentTunnelUrl,
              app_version: "1.0.2"
            })
          });
          if (workerResp.ok) {
            const wData = await workerResp.json();
            code = wData.code || roomId;
            roomToken = wData.room_token || "";
            if (isTauri && roomToken) {
              await window.__TAURI__.core.invoke("set_room_token", { token: roomToken });
            }
          }
        } catch (wErr) {
          console.warn("Could not register with public worker registry:", wErr);
        }
      }

      // Display results card
      createdRoomCode.innerText = code;
      shareLinkText.innerText = `${WORKER_REGISTRY_URL}/join/${code}`;
      roomCreatedBox.style.display = "block";
      btnCreateRoom.style.display = "none";
    } catch (err) {
      alert("Failed to initialize studio room: " + err.message);
      btnCreateRoom.disabled = false;
      btnCreateRoom.innerText = "🎙️ Launch Room";
    }
  });
}

// Copy Code Button
if (btnCopyCode) {
  btnCopyCode.addEventListener("click", () => {
    const link = shareLinkText.innerText;
    navigator.clipboard.writeText(link);
    btnCopyCode.innerText = "Copied!";
    setTimeout(() => {
      btnCopyCode.innerText = "Copy Link";
    }, 1500);
  });
}

// Enter Studio Button
if (btnEnterStudio) {
  btnEnterStudio.addEventListener("click", () => {
    window.location.href = "http://127.0.0.1:8000";
  });
}

// --- Join Room Handler ---
if (btnJoinRoom) {
  btnJoinRoom.addEventListener("click", async () => {
    const rawCode = (inputJoinCode.value || "").trim().toUpperCase();
    const guestName = (inputGuestName.value || "").trim() || "GuestActor";
    localStorage.setItem("dubmate_actor_name", guestName);

    if (!rawCode) {
      alert("Please enter a room code!");
      return;
    }

    const code = rawCode.startsWith("DUB-") ? rawCode : `DUB-${rawCode}`;
    btnJoinRoom.disabled = true;
    btnJoinRoom.innerText = "Resolving Host Stage...";

    try {
      const resp = await fetch(`${WORKER_REGISTRY_URL}/rooms/${code}/resolve`, {
        headers: { "Accept": "application/json" }
      });
      if (!resp.ok) {
        alert(`Room ${code} was not found or has expired. Please verify with the host.`);
        btnJoinRoom.disabled = false;
        btnJoinRoom.innerText = "Join Stage ›";
        return;
      }
      const data = await resp.json();
      const hostUrl = data.tunnel_url;
      if (hostUrl) {
        window.location.href = hostUrl;
      } else {
        throw new Error("Invalid tunnel URL returned from registry");
      }
    } catch (err) {
      alert("Could not connect to host session: " + err.message);
      btnJoinRoom.disabled = false;
      btnJoinRoom.innerText = "Join Stage ›";
    }
  });
}

// Format input code automatically
if (inputJoinCode) {
  inputJoinCode.addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

// --- Update Screen Controller ---
function showUpdateScreen(updateData) {
  pendingUpdateInfo = updateData;
  viewLauncher.style.display = "none";
  viewUpdater.style.display = "block";
  updateTargetVersion.innerText = `v${updateData.latest_version}`;
  updateChangelogText.innerText = updateData.changelog || "Bug fixes and performance enhancements.";
}

if (btnStartUpdate) {
  btnStartUpdate.addEventListener("click", async () => {
    if (!pendingUpdateInfo?.download_url) return;
    btnStartUpdate.disabled = true;
    btnStartUpdate.innerText = "Downloading Update...";
    updateProgressText.innerText = "Connecting to release server...";

    if (isTauri) {
      try {
        await window.__TAURI__.core.invoke("apply_update", {
          downloadUrl: pendingUpdateInfo.download_url
        });
      } catch (err) {
        alert("Failed to apply update: " + err);
        btnStartUpdate.disabled = false;
        btnStartUpdate.innerText = "⚡ Download & Apply Update";
      }
    }
  });
}

init();
