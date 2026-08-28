# DubMate Desktop App — Implementation Checklist
<!-- last updated: 2026-08-28 -->

> **Repo:** `github.com/sylenthsnares/DubMate`
> **Worker domain:** `https://dubmate.bkaproductions.com` (Cloudflare zone: `bkaproductions.com`)
> **Design spec:** `docs/superpowers/specs/2026-08-28-desktop-app-design.md`

Complete sub-projects **in order**. Each depends on the previous being verified before starting the next.
Do not skip the Verification steps — they are the completion gate for each sub-project.

---

## How to read this file

- `[NEW]` = create this file from scratch
- `[MODIFY]` = edit an existing file in the repo
- `[INFRA]` = action in an external dashboard (Cloudflare, GitHub)
- Code blocks marked `// exact` contain the literal code to write
- Code blocks marked `// pattern` show the structural shape; fill in the logic

---

## Sub-Project 1 — Cloudflare Worker + KV Room Registry

**What it does:** Runs as a Cloudflare Worker at `dubmate.bkaproductions.com`. Stores a mapping
of short room codes (`DUB-XXXX`) to ephemeral Cloudflare tunnel URLs. Hosts register on launch;
guests resolve the code to find the host. No database, no server — just Cloudflare KV with a 12-hour TTL.

**Why this first:** Fully independent of Tauri and Python. Can be deployed and tested in one sitting.

---

### 1.1 Cloudflare Dashboard Setup

- [ ] `[INFRA]` Log into Cloudflare → **Workers & Pages → KV → Create namespace**
  - Name it `DUBMATE_ROOMS`
  - Copy the generated namespace ID (looks like `abc123def456...`) — needed in step 1.3
- [ ] `[INFRA]` **Workers & Pages → Create application → Worker** — name it `dubmate-room-registry`
  - This step just reserves the name; actual code comes from `wrangler deploy`

---

### 1.2 Local project scaffold

- [ ] `[NEW]` Create `worker/` directory at the repo root
- [ ] Run inside `worker/`:
  ```bash
  npm create cloudflare@latest . -- --type=hello-world --lang=ts --no-git
  ```
  Delete the generated starter content in `src/index.ts` — we write our own below.

---

### 1.3 `[NEW]` `worker/wrangler.toml`

> **Why `custom_domain = true`:** Cloudflare's custom domain mode handles DNS and SSL automatically
> for domains already in your account. It is simpler than manually setting zone+route patterns.

```toml
name = "dubmate-room-registry"
main = "src/index.ts"
compatibility_date = "2025-02-04"

[[kv_namespaces]]
binding = "ROOMS"
id = "<PASTE_KV_NAMESPACE_ID_FROM_STEP_1.1_HERE>"

[[routes]]
pattern = "dubmate.bkaproductions.com/*"
custom_domain = true
```

After writing this file, run `npx wrangler types` inside `worker/` to generate `worker-configuration.d.ts`.

---

### 1.4 `[NEW]` `worker/src/types.ts`

```typescript
// exact
export interface RoomEntry {
  tunnel_url: string;    // Full https://xxxx.trycloudflare.com URL
  room_token: string;    // 32-char hex secret — only the host ever sees this
  created_at: number;    // Unix timestamp (seconds)
  app_version: string;   // e.g. "1.0.0" — used by clients to detect mismatches
}
```

---

### 1.5 `[NEW]` `worker/src/index.ts`

**Room code / token helpers (add above the default export):**

```typescript
// exact
function generateRoomCode(): string {
  // Excludes I, O, 0, 1 to avoid user confusion when reading aloud
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "DUB-" + Array.from(bytes).map(b => chars[b % chars.length]).join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

**Main Worker handler (pattern — implement all three branches):**

```typescript
// pattern
import { RoomEntry } from "./types";

interface Env {
  ROOMS: KVNamespace;
  DUBMATE_SECRET_KEY: string;  // set via `wrangler secret put`, never hardcoded
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /rooms/create
    // Called by the host's Tauri app when creating a new session.
    // Auth: X-DubMate-Key header must match env.DUBMATE_SECRET_KEY.
    // Body: { tunnel_url: string, app_version: string }
    // Logic:
    //   1. Validate auth header; return 401 if wrong
    //   2. Parse and validate body
    //   3. Generate room code; check KV for collision (retry up to 10 times)
    //   4. Generate room_token
    //   5. Write to KV: key=code, value=JSON.stringify(entry), expirationTtl=43200
    //   6. Return 201: { code, room_token }
    if (request.method === "POST" && path === "/rooms/create") { /* ... */ }

    // POST /rooms/:code/update
    // Called by the NEW host's Tauri app during a host transfer.
    // Auth: Authorization header must be "Bearer {room_token}" from the stored entry.
    // Body: { tunnel_url: string, app_version: string }
    // Logic:
    //   1. Extract code from path segments: path.split("/")[2]
    //   2. GET from KV; return 404 if null
    //   3. Validate Authorization header against stored room_token; return 401 if wrong
    //   4. Update entry: overwrite tunnel_url and app_version, keep created_at
    //   5. PUT back to KV with same expirationTtl: 43200
    //   6. Return 200: { ok: true }
    if (request.method === "POST" && path.includes("/update")) { /* ... */ }

    // GET /rooms/:code/resolve
    // Called by guest clients to find the host's current tunnel URL.
    // Returns 302 redirect so the WebView navigates to the host directly.
    // Logic:
    //   1. Extract code from path
    //   2. GET from KV; if null return HTML error page (see note below)
    //   3. Return 302 with Location: entry.tunnel_url
    //
    // Error page HTML (return as text/html with status 404):
    //   "<h2>Room not found or expired</h2>
    //    <p>Ask your host to share a new room code.</p>"
    if (request.method === "GET" && path.includes("/resolve")) { /* ... */ }

    return new Response("Not Found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
```

---

### 1.6 Set the shared secret

- [ ] Run inside `worker/`: `npx wrangler secret put DUBMATE_SECRET_KEY`
  - Enter a strong random string (32+ chars). Store it in your password manager.
- [ ] `[INFRA]` Add the same value as a **GitHub Actions secret** named `DUBMATE_SECRET_KEY`
  - Settings → Secrets and variables → Actions → New repository secret
  - The Tauri app will embed this at build time via an env var to authenticate Worker calls

---

### 1.7 Verification

- [ ] `npx wrangler dev` → Worker running at `http://localhost:8787`
- [ ] Test create:
  ```bash
  curl -X POST http://localhost:8787/rooms/create \
    -H "Content-Type: application/json" \
    -H "X-DubMate-Key: <your-secret>" \
    -d '{"tunnel_url":"https://test.trycloudflare.com","app_version":"1.0.0"}'
  # Expected: {"code":"DUB-XXXX","room_token":"...32 hex chars..."}
  ```
- [ ] Test resolve: `curl -v http://localhost:8787/rooms/DUB-XXXX/resolve`
  - Expected: `HTTP 302`, `Location: https://test.trycloudflare.com`
- [ ] Test missing code: `curl -v http://localhost:8787/rooms/DUB-0000/resolve`
  - Expected: `HTTP 404`, HTML body with "Room not found or expired"
- [ ] Test update with correct token → `{"ok":true}`
- [ ] Test update with wrong token → `HTTP 401`
- [ ] `[INFRA]` Deploy: `npx wrangler deploy`
- [ ] Verify live: `curl -X POST https://dubmate.bkaproductions.com/rooms/create ...`

---

## Sub-Project 2 — Tauri Shell + Sidecar Management

**What it does:** Wraps the existing Python FastAPI app and cloudflared in a native desktop `.exe`/`.dmg`.
The Tauri app starts both sidecars, waits for Python to be ready, parses the cloudflared tunnel URL
from its stderr output, then shows a launcher UI where users can create or join a room.
The full DubMate studio is still served by Python — Tauri just manages process lifecycle.

**Why Tauri v2 not Electron:** ~5MB Rust binary vs ~150MB Chromium bundle. Uses the OS WebView
(WebView2 on Windows, WKWebView on macOS) which is pre-installed on modern systems.
The `tauri-plugin-shell` provides the sidecar API with a clean permissions model.

**Key gotcha — cloudflared logs to stderr, not stdout:**
The quick tunnel URL appears in cloudflared's stderr, not stdout.
Listen to `CommandEvent::Stderr` lines in the Rust sidecar listener.
The URL format is: `https://[a-z0-9-]+\.trycloudflare\.com`

**Requires:** Sub-Project 1 deployed to `dubmate.bkaproductions.com`.

---

### 2.1 Scaffold the Tauri project

```bash
npm create tauri-app@latest tauri -- --template vanilla --manager npm --no-open
cd tauri && npm install
cargo add tauri-plugin-shell --manifest-path src-tauri/Cargo.toml
cargo add regex reqwest --manifest-path src-tauri/Cargo.toml
```

---

### 2.2 `[NEW]` `tauri/src-tauri/src/state.rs`

> Keeping state in a separate module prevents `main.rs` from growing unwieldy.
> `Mutex<T>` enables safe shared mutable access across threads and Tauri commands.

```rust
// exact
use std::sync::Mutex;

#[derive(Default)]
pub struct DubMateState {
    pub tunnel_url: Option<String>,    // parsed from cloudflared stderr
    pub room_token: Option<String>,    // set after creating a room; used for host transfer auth
    pub python_pid: Option<u32>,       // stored so we can kill it on app exit
    pub cloudflared_pid: Option<u32>,  // stored so we can kill it on app exit
}

pub struct SharedState(pub Mutex<DubMateState>);
```

---

### 2.3 `[NEW]` `tauri/src-tauri/src/main.rs`

> **Sidecar binary naming (critical — Tauri will refuse to bundle without this):**
> Every sidecar binary filename MUST end with the host target triple.
> Run `rustc -Vv | grep host` to find your triple.
> Example: `cloudflared.exe` on Windows x64 must be on disk as:
> `src-tauri/sidecar/cloudflared-x86_64-pc-windows-msvc.exe`
> In code and in `tauri.conf.json`, refer to it by base name only: `"sidecar/cloudflared"`.

```rust
// pattern — implement the functions described in the comments
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
use state::SharedState;

use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use std::sync::Mutex;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SharedState(Mutex::new(state::DubMateState::default())))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_sidecars(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tunnel_url,
            get_room_token,
            set_room_token,
        ])
        .on_window_event(|window, event| {
            // Kill both sidecar processes when the main window closes.
            // Without this, cloudflared and python.exe become orphan processes.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<SharedState>();
                let data = state.0.lock().unwrap();
                for pid in [data.python_pid, data.cloudflared_pid].into_iter().flatten() {
                    // Windows: taskkill /F /PID <pid>
                    // macOS:   kill -9 <pid>
                    #[cfg(target_os = "windows")]
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .output();
                    #[cfg(not(target_os = "windows"))]
                    let _ = std::process::Command::new("kill")
                        .args(["-9", &pid.to_string()])
                        .output();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn start_sidecars(app: tauri::AppHandle) {
    // Step 1: Start Python FastAPI
    // app.shell().sidecar("sidecar/python-runtime/python")
    //   .args(["../../app.py"])   // path relative to where the sidecar binary lives
    //   .spawn() → (rx, child)
    // Store child.pid() in SharedState.python_pid
    // Spawn a task to drain rx (required or the buffer fills and the process hangs)
    //
    // Step 2: Poll http://127.0.0.1:8000/health every 500ms (max 60 tries = 30s)
    // Use reqwest::Client::get().send() in a loop with tokio::time::sleep
    // Emit "server-ready" event to all windows when /health returns 200
    //
    // Step 3: Start cloudflared
    // app.shell().sidecar("sidecar/cloudflared")
    //   .args(["tunnel", "--url", "http://127.0.0.1:8000"])
    //   .spawn() → (rx, child)
    // Store child.pid() in SharedState.cloudflared_pid
    // Spawn a task listening to CommandEvent::Stderr lines:
    //   regex match: r"https://[a-z0-9-]+\.trycloudflare\.com"
    //   On first match: store URL in SharedState.tunnel_url
    //                   emit "tunnel-ready" event to all windows
}

#[tauri::command]
fn get_tunnel_url(state: tauri::State<'_, SharedState>) -> Option<String> {
    state.0.lock().unwrap().tunnel_url.clone()
}

#[tauri::command]
fn get_room_token(state: tauri::State<'_, SharedState>) -> Option<String> {
    state.0.lock().unwrap().room_token.clone()
}

#[tauri::command]
fn set_room_token(token: String, state: tauri::State<'_, SharedState>) {
    state.0.lock().unwrap().room_token = Some(token);
}
```

---

### 2.4 `[MODIFY]` `tauri/src-tauri/capabilities/default.json`

Replace the default capabilities with:
```json
{
  "identifier": "default",
  "description": "DubMate default capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "sidecar/python-runtime/python", "sidecar": true, "args": true },
        { "name": "sidecar/cloudflared",           "sidecar": true, "args": true },
        { "name": "sidecar/ffmpeg",                "sidecar": true, "args": true }
      ]
    }
  ]
}
```

---

### 2.5 `[MODIFY]` `tauri/src-tauri/tauri.conf.json`

```json
{
  "productName": "DubMate Studio",
  "identifier": "com.dubmate.studio",
  "bundle": {
    "active": true,
    "externalBin": [
      "sidecar/python-runtime/python",
      "sidecar/cloudflared",
      "sidecar/ffmpeg"
    ],
    "icon": ["icons/icon.ico", "icons/icon.icns", "icons/icon.png"]
  },
  "app": {
    "windows": [
      {
        "title": "DubMate Studio",
        "width": 920,
        "height": 640,
        "minWidth": 800,
        "minHeight": 560,
        "resizable": true,
        "fullscreen": false,
        "backgroundColor": "#0d0d0d"
      }
    ]
  }
}
```

> Generate icons: `npx tauri icon path/to/logo.png` — auto-generates all required sizes and formats.

---

### 2.6 `[MODIFY]` `app.py` — add `/health` endpoint

Add after the CORS middleware setup, near the top of the route definitions:

```python
# exact — add to app.py
@app.get("/health")
async def health():
    """Liveness probe used by the Tauri launcher to know when
    the Python server is ready to accept requests."""
    return {"status": "ok", "version": _read_version()}

def _read_version() -> str:
    version_path = os.path.join(BASE_DIR, "VERSION")
    try:
        with open(version_path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "0.0.0"
```

---

### 2.7 `[NEW]` `tauri/src/launcher/` — Launcher UI

Three files: `index.html`, `launcher.js`, `launcher.css`.

**Create Room flow (launcher.js — pattern):**
```javascript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const WORKER_URL = "https://dubmate.bkaproductions.com";
const SECRET_KEY = import.meta.env.VITE_DUBMATE_SECRET_KEY; // injected at build time

// Disable buttons until both sidecars are confirmed ready
await listen("tunnel-ready", () => enableButtons());

async function createRoom() {
  const tunnelUrl = await invoke("get_tunnel_url");

  // 1. Create room on local FastAPI
  const { room_id, user_id } = await fetch("http://localhost:8000/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pack_id: selectedPack,
      host_name: displayName.value.trim(),
      host_color: "#7c5cff",
      app_version: window.__app_version, // read from /health response
    }),
  }).then(r => r.json());

  // 2. Register tunnel with Worker
  const { code, room_token } = await fetch(`${WORKER_URL}/rooms/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DubMate-Key": SECRET_KEY },
    body: JSON.stringify({ tunnel_url: tunnelUrl, app_version: window.__app_version }),
  }).then(r => r.json());

  // 3. Persist room_token in Tauri state for later host transfer use
  await invoke("set_room_token", { token: room_token });

  // Store session info for host transfer (needed by room_socket.js later)
  window.__dubmate_room_code   = code;
  window.__dubmate_room_id     = room_id;
  window.__dubmate_user_id     = user_id;
  window.__dubmate_room_token  = room_token;

  // 4. Show room code card + "Enter Studio" button
  showRoomCode(code, `${WORKER_URL}/join/${code}`);
}

async function joinRoom() {
  const code = codeInput.value.trim().toUpperCase().replace(/^DUB-?/, "DUB-");
  // Resolve code → host tunnel URL (Worker returns 302; fetch follows it)
  const resp = await fetch(`${WORKER_URL}/rooms/${code}/resolve`, { redirect: "follow" });
  if (!resp.ok) { showError("Room not found. Check the code and try again."); return; }
  window.location.href = resp.url; // navigate WebView to host's tunnel
}
```

---

### 2.8 Verification

- [ ] `cargo tauri dev` — launcher window opens, status bar shows "Starting server…"
- [ ] Status bar updates to "Tunnel active" within ~10s
- [ ] Pack list loads in Create Room panel
- [ ] Create Room → `DUB-XXXX` code appears; copy button copies `dubmate.bkaproductions.com/join/DUB-XXXX`
- [ ] "Enter Studio" → WebView navigates to `http://localhost:8000`, DubMate studio loads
- [ ] On a second machine: open app, enter code → WebView opens host's studio

---

## Sub-Project 3 — Host Transfer Protocol

**What it does:** Allows the current host to pass the session to another participant already in the room.
The new host's machine becomes the session server. All guests reconnect to the new host's tunnel.
Session state (takes, casting, pack) is wiped on transfer. A warning is shown before the host confirms.

**Why clean slate:** The new host loads their own `Packs/` directory. Pack file paths, audio takes,
and character assignments are all bound to the old host's server filesystem. Migrating them is
complex and error-prone. A fresh start is the safe, correct behavior.

**Data flow summary:**
1. Host UI → WS `initiate_transfer` → old host's server
2. Server validates, broadcasts `host_transfer_pending` to all
3. New host's Tauri app: calls Worker `/update`, creates local room, sends WS `complete_transfer`
4. Server validates, resets state, broadcasts `host_transfer_confirmed`
5. All clients navigate to new host's tunnel

**Requires:** Sub-Project 2 working.

---

### 3.1 `[MODIFY]` `app.py` — Room model additions

In `Room.__init__` (~line 52), add after the existing fields:
```python
# exact
self.min_required_version: str = "1.0.0"
self.pending_transfer_to: Optional[str] = None
self._transfer_timeout_task: Optional[asyncio.Task] = None
```

In `POST /api/rooms` (~line 682), add inside `create_room()` after the Room is constructed:
```python
# exact
app_version = payload.get("app_version", "1.0.0")
room.min_required_version = app_version
```

---

### 3.2 `[MODIFY]` `app.py` — version gate in WS `join` handler

Inside the `elif msg_type == "join":` block (~line 1169), add at the very top before any user writes:

```python
# exact — paste at start of the "join" handler body
client_version = payload.get("app_version", "0.0.0")
if client_version < room.min_required_version:
    await websocket.send_text(json.dumps({
        "type": "version_mismatch",
        "payload": {
            "required": room.min_required_version,
            "yours": client_version,
        }
    }))
    await websocket.close()
    return
```

> **Note:** String comparison of version numbers is lexicographically incorrect for versions
> like "1.10" vs "1.9". Acceptable for v1 (keep patch versions single-digit). Add proper semver
> compare (split on ".", compare each int part) before releasing v2.

---

### 3.3 `[MODIFY]` `app.py` — new WS message handlers

Add these two `elif` blocks inside the `while True:` loop, after the existing `elif msg_type == "ping":` block:

```python
# pattern — implement the logic described in comments

elif msg_type == "initiate_transfer":
    # Guard: only current host can initiate
    if user_id != room.host_id:
        continue
    target_id = payload.get("target_user_id")
    # Guard: target must be a known, online user in this room
    if not target_id or target_id not in room.users:
        continue
    if not room.users[target_id].get("is_online", False):
        continue

    room.pending_transfer_to = target_id

    # Safety timeout: if new host does not confirm within 10s, cancel
    async def _timeout(tid=target_id):
        await asyncio.sleep(10)
        if room.pending_transfer_to == tid:
            room.pending_transfer_to = None
            await room.broadcast("host_transfer_cancelled", {"reason": "timeout"})

    if room._transfer_timeout_task and not room._transfer_timeout_task.done():
        room._transfer_timeout_task.cancel()
    room._transfer_timeout_task = asyncio.get_event_loop().create_task(_timeout())

    await room.broadcast("host_transfer_pending", {
        "new_host_id": target_id,
        "new_host_name": room.users[target_id].get("name", "Unknown"),
    })

elif msg_type == "complete_transfer":
    # Guard: only the designated transfer target can complete
    if user_id != room.pending_transfer_to:
        continue

    new_tunnel_url = payload.get("new_tunnel_url", "")
    if not new_tunnel_url.startswith("https://"):
        continue

    # Cancel the safety timeout
    if room._transfer_timeout_task and not room._transfer_timeout_task.done():
        room._transfer_timeout_task.cancel()
    room.pending_transfer_to = None

    # Clean slate: wipe all session state
    room.takes.clear()
    room.role_assignments = {char: [] for char in room.pack.characters}
    room.status = "lobby"
    room.current_line = 0
    room.exported_video_path = None
    room.exported_video_9_16_path = None

    # Promote new host
    room.host_id = user_id
    for uid, u in room.users.items():
        u["is_host"] = (uid == room.host_id)

    await room.broadcast("host_transfer_confirmed", {
        "new_host_id": user_id,
        "new_tunnel_url": new_tunnel_url,
    })
```

---

### 3.4 `[MODIFY]` `static/js/room_socket.js` — new message handlers

Add these cases to the existing message dispatch (alongside `user_joined`, `role_assigned`, etc.):

```javascript
// pattern — add to the onmessage dispatch

case "host_transfer_pending": {
  const { new_host_id, new_host_name } = data.payload;
  showTransferOverlay(`Host changing to ${new_host_name}…`);

  // Only the new host needs to act; guests just wait
  const isTauri = !!window.__TAURI__;
  if (new_host_id === window.__dubmate_user_id && isTauri) {
    // We are the new host and we are inside the Tauri WebView
    const { invoke } = await import("@tauri-apps/api/core");
    const [tunnelUrl, roomToken] = await Promise.all([
      invoke("get_tunnel_url"),
      invoke("get_room_token"),
    ]);

    // Update the Worker KV entry to point to our tunnel
    await fetch(`https://dubmate.bkaproductions.com/rooms/${window.__dubmate_room_code}/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${roomToken}`,
      },
      body: JSON.stringify({
        tunnel_url: tunnelUrl,
        app_version: window.__dubmate_app_version,
      }),
    });

    // Create a fresh room on our own local Python server
    const { room_id: newRoomId } = await fetch("http://localhost:8000/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pack_id: window.__dubmate_pack_id,
        host_name: window.__dubmate_user_name,
        host_color: window.__dubmate_user_color,
        app_version: window.__dubmate_app_version,
      }),
    }).then(r => r.json());

    // Notify the old host's server (and all guests) that transfer is done
    // This WS message goes through the CURRENT (old) host's server — that is intentional
    window.__dubmate_socket.send(JSON.stringify({
      type: "complete_transfer",
      payload: { new_tunnel_url: tunnelUrl, new_room_id: newRoomId },
    }));
  }
  break;
}

case "host_transfer_confirmed": {
  const { new_host_id, new_tunnel_url } = data.payload;
  if (new_host_id === window.__dubmate_user_id) {
    // We are the new host — navigate to our own local server
    window.location.href = "http://localhost:8000";
  } else {
    // We are a guest — navigate to new host's tunnel
    window.location.href = new_tunnel_url;
  }
  break;
}

case "host_transfer_cancelled": {
  hideTransferOverlay();
  showToast("Host transfer cancelled (the new host did not respond in time).");
  break;
}

case "version_mismatch": {
  const { required, yours } = data.payload;
  // Non-dismissable blocking modal — user must restart to update
  showVersionMismatchModal(required, yours);
  window.__dubmate_socket.disconnect();
  break;
}
```

---

### 3.5 `[MODIFY]` Studio UI — add host controls

Find the host controls section in `static/index.html` and the room management JavaScript:

- **"Hand Off Host" button** — visible only when `is_host === true`
  - Click → open guest picker modal listing all online, non-host users
  - Select a user → show confirmation dialog:
    ```
    ⚠️ Hand off to [Name]?
    This will reset the session — all takes, casting, and pack selections will be cleared.
    The room will reload on their machine.
    [Cancel]  [Hand Off]
    ```
  - On "Hand Off": `socket.send({ type: "initiate_transfer", payload: { target_user_id: id } })`

- **Transfer overlay** — full-screen semi-transparent dark overlay with spinner + message text
  - Hidden by default (`display: none`)
  - Shown by `showTransferOverlay(message)`, hidden by `hideTransferOverlay()`
  - User cannot dismiss it — it clears automatically on `host_transfer_confirmed` or `host_transfer_cancelled`

- **Version mismatch modal** — non-dismissable full-screen overlay:
  ```
  ⚠️ Update Required
  Your DubMate (v{yours}) is too old for this room.
  The host requires v{required} or newer.
  Restart DubMate to update automatically.
  ```

---

### 3.6 Verification

- [ ] Two machines with the app: host creates room, guest joins
- [ ] Host clicks "Hand Off Host", selects guest, reads warning, confirms
- [ ] Both clients show the transfer overlay with spinner
- [ ] New host's app calls Worker `/update` — verify by `curl /rooms/:code/resolve` (new tunnel URL)
- [ ] Both clients redirect: new host goes to `localhost:8000`, original host goes to new host's tunnel
- [ ] New session is clean slate: no takes, no casting, no existing exports
- [ ] Version gate test: set `min_required_version = "99.0.0"` in the new host's room, have a guest try to join → version mismatch modal shown, WS closed
- [ ] Timeout test: initiate transfer, disconnect the target guest before they confirm → `host_transfer_cancelled` broadcast after 10s

---

## Sub-Project 4 — Mandatory Auto-Updater

**What it does:** On every launch, the app checks `github.com/sylenthsnares/DubMate/releases/latest`.
If the local `VERSION` is behind the latest release, the app locks the UI and downloads the
`app-bundle-v{tag}.zip` release asset, extracts it over the current install, then restarts.
Users cannot skip or defer the update. This prevents multiplayer version mismatch bugs entirely.

**Two-tier update strategy:**
- **Tier 1 (frequent):** Python + JS/CSS files bundled as `app-bundle-v{VERSION}.zip`.
  Published by pushing to `main`. No Rust rebuild needed.
- **Tier 2 (rare):** Tauri binary itself (Rust code changes, new sidecar definitions).
  Uses Tauri's built-in updater, requires a full installer rebuild on GitHub Actions.
  This checklist covers Tier 1 only.

**Requires:** A `v1.0.0` release published manually on `sylenthsnares/DubMate` before writing any updater code.
This is a hard prerequisite — the updater must have a release to fetch.

---

### 4.1 `[NEW]` `VERSION`

Create a plain text file in the project root:
```
1.0.0
```
No trailing newline. This file is included in `app-bundle-v{VERSION}.zip` so the
running app can always read what version it is.

---

### 4.2 `[NEW]` `CHANGELOG.md`

Start tracking changes. The GitHub Release `body` field (populated from `CHANGELOG.md` in CI)
is displayed in the update screen so users know what changed before the update completes.

---

### 4.3 `[NEW]` `tauri/src-tauri/src/updater.rs`

> **GitHub API details:**
> `GET https://api.github.com/repos/sylenthsnares/DubMate/releases/latest`
> Required header: `User-Agent: DubMate` (GitHub returns 403 without it)
> No `Authorization` header needed (public repo; anonymous limit is 60 req/hr — fine)
> Key response fields:
>   - `tag_name`: `"v1.4.0"` — strip the leading `v` to get the version string
>   - `body`: changelog text (shown in update screen)
>   - `assets[].name`: find the one starting with `"app-bundle-"`
>   - `assets[].browser_download_url`: direct download link to the zip

```rust
// pattern — implement the functions described in comments
use serde::Deserialize;

#[derive(Deserialize, Clone)]
pub struct GithubRelease {
    pub tag_name: String,
    pub body: Option<String>,
    pub assets: Vec<GithubAsset>,
}

#[derive(Deserialize, Clone)]
pub struct GithubAsset {
    pub name: String,
    pub browser_download_url: String,
}

pub enum UpdateCheckResult {
    UpToDate,
    UpdateAvailable { release: GithubRelease, download_url: String },
    NoInternet,
}

pub async fn check_for_update(current_version: &str) -> UpdateCheckResult {
    // 1. Build reqwest Client with User-Agent header
    // 2. GET https://api.github.com/repos/sylenthsnares/DubMate/releases/latest
    //    On any network error or non-200 status: return NoInternet
    // 3. Deserialize into GithubRelease
    // 4. Strip "v" prefix from tag_name to get latest_version string
    // 5. If latest_version == current_version: return UpToDate
    // 6. Find asset where name starts with "app-bundle-"
    //    If not found: return UpToDate (malformed release; do not crash)
    // 7. Return UpdateAvailable { release, download_url: asset.browser_download_url }
    todo!()
}

pub async fn download_and_apply(
    download_url: &str,
    app_dir: &std::path::Path,
    progress_cb: impl Fn(u64, u64) + Send + 'static,
) -> Result<(), String> {
    // 1. GET download_url with reqwest (GitHub CDN; reqwest follows redirects automatically)
    //    Read Content-Length header for progress bar total
    // 2. Stream bytes into a temp file: app_dir.join("../dubmate-update.zip")
    //    Call progress_cb(bytes_received, total) after each chunk
    // 3. On complete: extract zip over app_dir
    //    Use crate `zip = "2"`: ZipArchive::new(file)?, iterate entries, write each file
    //    This overwrites app.py, static/, etc. with the new versions
    // 4. Delete the temp zip file
    // 5. Return Ok(())
    todo!()
}
```

Add to `src-tauri/Cargo.toml`:
```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
zip = "2"
```

---

### 4.4 `[NEW]` `tauri/src/updater/` — Update lock screen

Three files: `updater.html`, `updater.js`, `updater.css`.

**Layout:**
```
  🎙️ DubMate needs to update

  v1.3 → v1.4

  [███████████░░░░░░░]  67%   5.1 MB / 7.6 MB

  What's new:
  {changelog text from release.body}
```

**Error state (shown when `check_for_update` returns `NoInternet`):**
```
  ⚠️ No internet connection

  DubMate needs to verify your version before launching.
  Connect to the internet and try again.

  [Retry]
```

**updater.js (pattern):**
```javascript
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// Tauri emits "update-available" from the setup hook when an update is found
await listen("update-available", async (event) => {
  const { current, latest, changelog, download_url } = event.payload;
  showUpdateUI(current, latest, changelog);
  // Start the download + apply + restart sequence
  await invoke("start_update", { download_url });
});

// Tauri emits "update-progress" while downloading
await listen("update-progress", (event) => {
  const { received, total } = event.payload;
  updateProgressBar(received, total);
});

// Tauri emits "update-complete" when extraction is done; app restarts automatically
await listen("update-complete", () => {
  invoke("restart_app");
});

// Shown when NoInternet
document.getElementById("retry-btn").addEventListener("click", () => {
  invoke("recheck_update"); // re-runs the check
});
```

---

### 4.5 `[NEW]` `.github/workflows/publish-bundle.yml`

> **Trigger strategy:** Every push to `main` publishes a release.
> This means you MUST bump `VERSION` in the same commit as any user-facing change.
> Pushes that do not bump VERSION will fail with "tag already exists".
> To gate publishing: add `if: contains(github.event.head_commit.message, '[release]')` to the job.

```yaml
name: Publish App Bundle

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Read VERSION
        id: ver
        run: echo "VERSION=$(cat VERSION)" >> $GITHUB_OUTPUT

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Run tests
        run: |
          pip install pytest -q
          pip install -r requirements.txt -q
          python -m pytest test_systematic.py test_pack_builder.py test_pack_security.py -q

      - name: Create app bundle zip
        run: |
          zip -r app-bundle-v${{ steps.ver.outputs.VERSION }}.zip \
            app.py \
            audio_processor.py \
            pack_loader.py \
            pack_builder.py \
            static/ \
            VERSION \
            requirements.txt

      - name: Publish GitHub Release
        uses: softprops/action-gh-release@v3
        with:
          tag_name: v${{ steps.ver.outputs.VERSION }}
          name: "DubMate v${{ steps.ver.outputs.VERSION }}"
          body_path: CHANGELOG.md
          files: app-bundle-v${{ steps.ver.outputs.VERSION }}.zip
          token: ${{ secrets.GITHUB_TOKEN }}
```

---

### 4.6 Verification

- [ ] Publish `v1.0.0` release manually on `sylenthsnares/DubMate` (prerequisite — do this first)
- [ ] Temporarily set local `VERSION` to `0.0.1` → launch app → update screen appears with progress bar
- [ ] Download completes → app restarts → `VERSION` file now reads `1.0.0`
- [ ] Launch again → update screen skipped, normal launcher shown
- [ ] Disable Wi-Fi → launch → "No internet connection" error screen shown, no crash
- [ ] Retry button works (re-runs check)
- [ ] Bump `VERSION` to `1.0.1`, push to `main` → GitHub Actions publishes release → client on `1.0.0` picks up the update on next launch

---

## Sub-Project 5 — Installer Bundling

**What it does:** Packages Python runtime + FFmpeg + cloudflared inside the Tauri installer.
Users download one file and double-click to install — no Python install, no PATH configuration,
no manual dependency steps. GitHub Actions builds both `.msi` (Windows) and `.dmg` (macOS)
and uploads them as release assets automatically on every version tag push.

**Why embed Python instead of requiring it:** Users are non-technical creators. Requiring a
Python installation is a hard friction point that causes drop-off. The CPython embeddable zip
is a self-contained runtime built exactly for this bundled-app use case.

**Requires:** All prior sub-projects working in `cargo tauri dev` mode first.

---

### 5.1 Sidecar naming convention (read this before writing any scripts)

> Tauri requires every sidecar binary to have the host target triple as a suffix in its filename.
> This is non-negotiable — Tauri will refuse to bundle or run binaries without the correct suffix.
>
> Find your triple: `rustc -Vv | grep host`
>
> | Platform           | Triple                        |
> |--------------------|-------------------------------|
> | Windows x64        | `x86_64-pc-windows-msvc`      |
> | macOS Apple Silicon| `aarch64-apple-darwin`        |
> | macOS Intel        | `x86_64-apple-darwin`         |
>
> On disk: `sidecar/cloudflared-x86_64-pc-windows-msvc.exe`
> In `tauri.conf.json` and in Rust code: `"sidecar/cloudflared"` (no triple, no extension)

- [ ] Run `rustc -Vv | grep host` on each build machine and record the triple

---

### 5.2 `[NEW]` `tauri/scripts/stage-sidecars.ps1` (Windows)

```powershell
# pattern — fill in exact download URLs for your target Python/FFmpeg versions
param([string]$Triple = "x86_64-pc-windows-msvc")

$SidecarDir = "$PSScriptRoot\..\src-tauri\sidecar"
New-Item -ItemType Directory -Force $SidecarDir | Out-Null

# 1. Python 3.12 embeddable zip (python.org official, no installer, no PATH changes)
#    URL: https://www.python.org/ftp/python/3.12.4/python-3.12.4-embed-amd64.zip
#    Download → expand into $SidecarDir\python-runtime\
#    Rename python.exe to python-$Triple.exe (required by Tauri sidecar convention)

# 2. Bootstrap pip (NOT included in embeddable zip by design)
#    Download https://bootstrap.pypa.io/get-pip.py
#    Run: python-$Triple.exe get-pip.py --no-warn-script-location

# 3. Install Python deps into embedded runtime
#    Run: python-$Triple.exe -m pip install
#           -r ..\..\requirements.txt
#           --target $SidecarDir\python-runtime\Lib\site-packages
#           --no-warn-script-location --quiet

# 4. FFmpeg static build (gyan.dev/ffmpeg/builds — use "essentials" build, ~70MB)
#    URL: https://github.com/GyanD/codexffmpeg/releases/download/7.0.2/ffmpeg-7.0.2-essentials_build.zip
#    Extract → find ffmpeg.exe in the nested bin/ dir
#    Copy to $SidecarDir\ffmpeg-$Triple.exe

# 5. cloudflared (already downloaded by setup_dubmate_win.bat → tools\cloudflared.exe)
#    Copy tools\cloudflared.exe to $SidecarDir\cloudflared-$Triple.exe

Write-Host "[OK] All sidecars staged for $Triple"
```

---

### 5.3 `[NEW]` `tauri/scripts/stage-sidecars.sh` (macOS)

```bash
#!/bin/bash
# pattern — fill in exact download URLs
set -e

SIDECAR_DIR="$(dirname "$0")/../src-tauri/sidecar"
mkdir -p "$SIDECAR_DIR"

for TRIPLE in "aarch64-apple-darwin" "x86_64-apple-darwin"; do
  # 1. Python: use indygreg/python-build-standalone (self-contained, no system deps)
  #    URL: https://github.com/indygreg/python-build-standalone/releases/download/
  #         20240713/cpython-3.12.4+20240713-${TRIPLE}-install_only.tar.gz
  #    Extract → copy the python3 binary to $SIDECAR_DIR/python-runtime-$TRIPLE

  # 2. FFmpeg static (evermeet.cx for macOS, or use ffmpeg.org)
  #    URL: https://evermeet.cx/ffmpeg/ffmpeg-7.0.zip
  #    Extract → copy ffmpeg binary to $SIDECAR_DIR/ffmpeg-$TRIPLE
  #    chmod +x

  # 3. cloudflared
  #    ARCH = first part of TRIPLE (aarch64 or x86_64)
  #    URL: https://github.com/cloudflare/cloudflared/releases/latest/download/
  #         cloudflared-darwin-${ARCH}
  #    Download to $SIDECAR_DIR/cloudflared-$TRIPLE
  #    chmod +x
done

# 4. Install Python deps once (arm64 binary; same packages work on both arches)
"$SIDECAR_DIR/python-runtime-aarch64-apple-darwin" -m pip install \
  -r "$(dirname "$0")/../../requirements.txt" \
  --target "$SIDECAR_DIR/python-site-packages" --quiet

echo "[OK] macOS sidecars staged"
```

---

### 5.4 `[MODIFY]` `tauri/src-tauri/tauri.conf.json` — `beforeBuildCommand`

```json
{
  "build": {
    "beforeBuildCommand": "pwsh -File scripts/stage-sidecars.ps1",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../src"
  }
}
```

The GitHub Actions macOS job overrides this by calling `bash scripts/stage-sidecars.sh` explicitly.

---

### 5.5 `[NEW]` `.github/workflows/build-installer.yml`

```yaml
name: Build Installer

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            tauri-args: ""
          - platform: macos-latest
            tauri-args: "--target universal-apple-darwin"

    runs-on: ${{ matrix.platform }}

    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install frontend deps
        run: npm install
        working-directory: tauri

      - name: Stage sidecars (Windows)
        if: matrix.platform == 'windows-latest'
        run: pwsh -File tauri/scripts/stage-sidecars.ps1

      - name: Stage sidecars (macOS)
        if: matrix.platform == 'macos-latest'
        run: bash tauri/scripts/stage-sidecars.sh

      - name: Build Tauri installer
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VITE_DUBMATE_SECRET_KEY: ${{ secrets.DUBMATE_SECRET_KEY }}
        with:
          projectPath: tauri
          args: ${{ matrix.tauri-args }}
          tagName: ${{ github.ref_name }}
          releaseName: "DubMate ${{ github.ref_name }}"
          releaseBody: "See CHANGELOG.md for what changed."
          releaseDraft: false
          prerelease: false
```

---

### 5.6 Verification

- [ ] Run `tauri/scripts/stage-sidecars.ps1` locally → confirm all three binaries appear in `sidecar/` with triple-suffixed names
- [ ] `cargo tauri build` (not `dev`) — build completes without "binary not found" errors
- [ ] Install the `.msi` on a **fresh Windows VM** (no Python, no FFmpeg, no cloudflared in PATH)
  - Launch DubMate Studio
  - Both sidecars start; tunnel URL appears in launcher status bar
  - Create Room → pack list loads → studio opens
  - Record a take → export works (proves FFmpeg is bundled correctly)
- [ ] Push a `v1.0.0` tag → GitHub Actions matrix build runs → both `.msi` and `.dmg` appear as release assets on `github.com/sylenthsnares/DubMate/releases`

---

## Done Criteria

The checklist is complete when all five sub-projects pass their verification steps. The end-to-end test:

1. Install `DubMate-Setup.exe` on a clean Windows machine (no prerequisites)
2. Launch → mandatory update check passes, launcher loads
3. Create a room → `DUB-XXXX` code registered at `dubmate.bkaproductions.com`
4. Friend installs the same `.exe`, enters the code → joins the session
5. Host hands off to friend → warning shown, session resets, friend's machine becomes the server
6. Developer pushes a feature commit bumping `VERSION` to `main` → GitHub Actions publishes bundle → all users receive it on next launch

---

## Common Pitfalls Reference

| Pitfall | Fix |
|---------|-----|
| cloudflared tunnel URL comes from **stderr**, not stdout | Listen to `CommandEvent::Stderr` in Rust sidecar listener |
| Tauri sidecar binary missing target triple suffix | Rename: `cloudflared.exe` → `cloudflared-x86_64-pc-windows-msvc.exe` |
| CPython embeddable zip has no pip | Bootstrap with `get-pip.py` before running `pip install` |
| KV TTL in Cloudflare uses `expirationTtl` (seconds, not unix timestamp) | Use `expirationTtl: 43200` not `expiration: <unix>` |
| Version string compare: `"1.10" < "1.9"` is wrong lexicographically | Acceptable for v1; add proper int-by-int semver compare before v2 |
| `wrangler types` not re-run after KV binding added | Run `npx wrangler types` after every `wrangler.toml` change |
| `DUBMATE_SECRET_KEY` visible in launcher JS bundle | Acceptable for v1; move Worker call to a Rust `#[tauri::command]` in v2 |
| `complete_transfer` goes through the old host's WS | Correct — old server is still running; it broadcasts the redirect to all guests |
| `taskkill` only works on Windows; `kill -9` on macOS | Use `cfg!(target_os = "windows")` in Rust to branch |
| Stale Tauri build caches old sidecar binary | Run `cargo clean` between builds if a sidecar was updated |
| `push to main` publishes duplicate release tag if VERSION not bumped | CI fails with "tag already exists"; always bump VERSION with a releasable change |
