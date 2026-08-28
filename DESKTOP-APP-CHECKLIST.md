# DubMate Desktop App — Implementation Checklist

> **Repo:** `github.com/sylenthsnares/DubMate`
> **Worker domain:** `https://dubmate.bkaproductions.com` (on `bkaproductions.com` Cloudflare zone)
> **Design spec:** `docs/superpowers/specs/2026-08-28-desktop-app-design.md`

Work through sub-projects **in order** — each depends on the previous being verified before starting the next.

---

## Sub-Project 1 — Cloudflare Worker + KV Room Registry

- [ ] Create KV namespace in Cloudflare dashboard → copy ID into `wrangler.toml`
- [ ] `wrangler secret put DUBMATE_SECRET_KEY` — set shared auth secret
- [ ] **[NEW]** `worker/src/types.ts` — `RoomEntry` interface `{ tunnel_url, room_token, created_at, app_version }`
- [ ] **[NEW]** `worker/src/index.ts` — three routes:
  - [ ] `POST /rooms/create` — generate `DUB-XXXX` code, write KV (12h TTL), return `{ code, room_token }`; auth via `X-DubMate-Key`
  - [ ] `POST /rooms/:code/update` — validate `room_token` header, overwrite `tunnel_url`
  - [ ] `GET /rooms/:code/resolve` — KV lookup → `302` to `tunnel_url`; missing → HTML error "Room not found or expired"
- [ ] **[NEW]** `worker/wrangler.toml` — route `dubmate.bkaproductions.com/*`, zone `bkaproductions.com`, KV binding `ROOMS`
- [ ] **[NEW]** `worker/package.json` + TypeScript config
- [ ] **Verify locally:** `wrangler dev` + `curl` all three endpoints
- [ ] **Deploy:** `wrangler deploy` → confirm live at `https://dubmate.bkaproductions.com`
- [ ] **Verify live:** `curl -X POST https://dubmate.bkaproductions.com/rooms/create` returns `{ code, room_token }`

---

## Sub-Project 2 — Tauri Shell + Sidecar Management

- [ ] Scaffold Tauri project: `npm create tauri-app@latest` inside `tauri/`
- [ ] **[NEW]** `tauri/src-tauri/tauri.conf.json`
  - [ ] `externalBin`: `sidecar/python-runtime/python`, `sidecar/ffmpeg`, `sidecar/cloudflared`
  - [ ] Window: `800x600` min, title `"DubMate Studio"`, bg `#0d0d0d`
  - [ ] `identifier`: `com.dubmate.studio`, `productName`: `DubMate Studio`
- [ ] **[NEW]** `tauri/src-tauri/src/main.rs`
  - [ ] Spawn Python sidecar; poll `GET localhost:8000/health` (max 30s)
  - [ ] Spawn cloudflared sidecar; parse stdout for `trycloudflare.com` URL
  - [ ] Expose Tauri commands: `get_tunnel_url()`, `get_local_url()`, `get_room_token()`, `set_room_token()`
  - [ ] On app exit: terminate both sidecars cleanly
- [ ] **[MODIFY]** `app.py` — add `GET /health` → `{ "status": "ok" }`
- [ ] **[NEW]** `tauri/src/launcher/` (HTML + JS + CSS)
  - [ ] Create Room: pack picker, display name, call `/api/rooms` then Worker `/rooms/create`, show `DUB-XXXX` + copy + share string, "Enter Studio"
  - [ ] Join Room: code + name inputs, call Worker `/rooms/:code/resolve`, navigate WebView to host tunnel URL
- [ ] **Verify:** `cargo tauri dev` — sidecars start, tunnel URL parsed
- [ ] **Verify:** Create Room → code appears in Worker KV
- [ ] **Verify:** Join Room on second machine → WebView opens host's studio

---

## Sub-Project 3 — Host Transfer Protocol

- [ ] **[MODIFY]** `app.py`
  - [ ] `POST /api/rooms` — accept + store `app_version` as `room.min_required_version`
  - [ ] `Room.__init__` — add `min_required_version`, `pending_transfer_to`, `_transfer_timeout_task`
  - [ ] WS `initiate_transfer`: validate sender is host, validate target is online, broadcast `host_transfer_pending`, start 10s timeout
  - [ ] WS `complete_transfer`: validate sender is pending target, reset room state (clear takes/casting/status), broadcast `host_transfer_confirmed`, cancel timeout
  - [ ] WS `join`: version gate — reject clients below `min_required_version` with `version_mismatch` + close
- [ ] **[MODIFY]** `static/js/room_socket.js`
  - [ ] `host_transfer_pending`: show overlay; if this client is new host → call Worker `/update` → create local room → send `complete_transfer`
  - [ ] `host_transfer_confirmed`: guest navigates to `new_tunnel_url`; new host navigates to `localhost:8000`
  - [ ] `version_mismatch`: blocking modal "Update required — restart DubMate"
- [ ] **[MODIFY]** Studio UI
  - [ ] "Hand Off Host" button (host-only), guest picker modal, confirmation dialog with reset warning
  - [ ] Transfer overlay (hidden until `host_transfer_pending`)
- [ ] **Verify:** Transfer flow — overlay shown, new host registers tunnel, guests reconnect clean
- [ ] **Verify:** Outdated client blocked with clear message

---

## Sub-Project 4 — Mandatory Auto-Updater

- [ ] Publish `v1.0.0` release manually on `github.com/sylenthsnares/DubMate` (prerequisite)
- [ ] **[NEW]** `VERSION` — plain text `1.0.0` in project root
- [ ] **[NEW]** `CHANGELOG.md` — start tracking changes
- [ ] **[NEW]** `tauri/src-tauri/src/updater.rs`
  - [ ] Fetch `https://api.github.com/repos/sylenthsnares/DubMate/releases/latest`
  - [ ] Compare `tag_name` to local `VERSION`; return `Ok(None)` / `Ok(Some(release))` / `Err("no_internet")`
- [ ] **[NEW]** `tauri/src/updater/` (HTML + JS + CSS)
  - [ ] Full-screen lock: "DubMate needs to update — v{old} -> v{new}"
  - [ ] Progress bar (bytes / content-length for `app-bundle-v{tag}.zip`)
  - [ ] Changelog from release `body`
  - [ ] On complete: unzip bundle to app data dir → restart
  - [ ] Network error: "Connect to the internet to continue." + Retry
- [ ] **[NEW]** `.github/workflows/publish-bundle.yml`
  - [ ] Trigger: push to `main` or manual dispatch
  - [ ] Run pytest → bump VERSION → zip Python + static files → create GitHub Release on `sylenthsnares/DubMate` with `app-bundle-v{VERSION}.zip` + `CHANGELOG.md`
- [ ] **Verify:** Set local VERSION to `0.0.1` → update screen appears → downloads → relaunches
- [ ] **Verify:** No network → error screen, no crash
- [ ] **Verify:** Current version → update screen skipped

---

## Sub-Project 5 — Installer Bundling

- [ ] **[NEW]** `tauri/scripts/stage-sidecars.ps1` (Windows)
  - [ ] Download CPython embeddable → `tauri/sidecar/python-runtime/`
  - [ ] Download FFmpeg static (gyan.dev) → `tauri/sidecar/ffmpeg`
  - [ ] Copy `tools/cloudflared.exe` → `tauri/sidecar/cloudflared`
  - [ ] `pip install -r requirements.txt --target python-runtime/Lib/site-packages`
- [ ] **[NEW]** `tauri/scripts/stage-sidecars.sh` (macOS)
  - [ ] Download portable Python → `tauri/sidecar/python-runtime/`
  - [ ] Download FFmpeg static (evermeet.cx) → `tauri/sidecar/ffmpeg`
  - [ ] Download cloudflared darwin universal → `tauri/sidecar/cloudflared`
  - [ ] pip install deps into bundled Python
- [ ] **[MODIFY]** `tauri/src-tauri/tauri.conf.json` — add `beforeBuildCommand`, finalize `externalBin` paths
- [ ] **[NEW]** `.github/workflows/build-installer.yml`
  - [ ] Trigger: on release tag push
  - [ ] `windows-latest`: `cargo tauri build` → `.msi` + NSIS `.exe`
  - [ ] `macos-latest`: `cargo tauri build --target universal-apple-darwin` → `.dmg`
  - [ ] Upload both as release assets on `sylenthsnares/DubMate`
- [ ] **Verify (Windows):** Fresh machine install → launch → sidecars start → create room → full studio works
- [ ] **Verify (Mac):** Fresh machine install → launch → full studio works

---

## Done Criteria

All five sub-projects verified. A user on a clean machine can:

1. Download and install `DubMate-Setup.exe` / `DubMate.dmg`
2. Launch — mandatory update check passes, studio loads
3. Create a room — receives `DUB-XXXX` code
4. Share the code — a friend installs the same app, enters the code, joins the session
5. Host transfers to a friend — friend''s packs load, session resets cleanly with warning
6. Push a code update to `main` on GitHub — all users receive it silently on next launch
