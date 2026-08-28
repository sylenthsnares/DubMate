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
      loadPacksList();
      checkEngineReadiness();
    }, 1000);
  }
}

function checkEngineReadiness() {
  if (isServerReady && isTunnelReady) {
    statusDot.className = "dot dot-green";
    statusText.innerText = "Studio Engine & Tunnel Active";
    if (btnCreateRoom) btnCreateRoom.disabled = false;
  } else if (isServerReady) {
    statusDot.className = "dot dot-amber";
    statusText.innerText = "Local Server Ready (Activating Tunnel...)";
  }
}

async function loadPacksList() {
  try {
    const resp = await fetch("http://127.0.0.1:8000/api/packs");
    const data = await resp.json();
    const packs = Object.values(data.packs || data);

    if (packs && packs.length > 0) {
      selectPack.innerHTML = packs.map(p => `
        <option value="${p.id || p.pack_id}">${p.name} (${p.line_count || p.lines?.length || 0} lines)</option>
      `).join("");
      btnCreateRoom.disabled = !isTunnelReady;
    } else {
      selectPack.innerHTML = `<option value="">No scene packs found in Packs/</option>`;
    }
  } catch (err) {
    console.error("Error fetching packs registry:", err);
    selectPack.innerHTML = `<option value="">Error loading scene packs</option>`;
  }
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
          app_version: "1.0.0"
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
              app_version: "1.0.0"
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
