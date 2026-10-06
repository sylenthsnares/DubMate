//! Starting, supervising and stopping the Python engine and cloudflared tunnel
//! sidecars.

use std::path::Path;

use regex::Regex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::paths::{
    ai_packages_dir, find_app_py, find_bundled_tools_dir, find_python_exe, install_root_dir,
};
use crate::state::SharedState;

/// Port the engine prefers. Anything already holding it used to make the app fail to
/// start with an error that named the cause but offered no way out.
pub(crate) const DEFAULT_ENGINE_PORT: u16 = 8000;

/// Serialises sidecar startup. `start_sidecars` is reachable from app setup, the
/// Retry button, apply_update and the Pack Builder install/remove commands; two
/// overlapping runs would each spawn an engine while `python_pid` only remembers
/// the last, leaving the other orphaned and holding the port.
static SIDECAR_START_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

fn sidecar_start_lock() -> &'static tokio::sync::Mutex<()> {
    SIDECAR_START_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// First bindable port at or after `preferred`, so a busy 8000 is no longer fatal.
fn find_available_port(preferred: u16) -> u16 {
    for candidate in preferred..preferred.saturating_add(50) {
        if std::net::TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return candidate;
        }
    }
    preferred
}

/// Terminates the Python and cloudflared sidecars and clears the tracked state so a
/// subsequent start is treated as a cold boot.
pub(crate) fn kill_sidecars(app: &tauri::AppHandle) {
    let targets: Vec<(u32, Option<String>)> = {
        let state = app.state::<SharedState>();
        let mut data = state.0.lock().unwrap();
        let mut targets = Vec::new();
        if let Some(pid) = data.python_pid {
            targets.push((pid, data.python_image.clone()));
        }
        if let Some(pid) = data.cloudflared_pid {
            targets.push((pid, data.cloudflared_image.clone()));
        }
        data.python_pid = None;
        data.cloudflared_pid = None;
        data.python_image = None;
        data.cloudflared_image = None;
        data.is_tunnel_ready = false;
        targets
    };

    for (pid, image) in targets {
        #[cfg(target_os = "windows")]
        {
            // Match on PID *and* image name. If the sidecar already exited and
            // Windows recycled its PID, the filter simply matches nothing rather
            // than terminating an unrelated process. /T also takes down children.
            let mut args = vec![
                "/F".to_string(),
                "/T".to_string(),
                "/FI".to_string(),
                format!("PID eq {}", pid),
            ];
            if let Some(name) = image.as_deref() {
                args.push("/FI".to_string());
                args.push(format!("IMAGENAME eq {}", name));
            }
            let _ = std::process::Command::new("taskkill").args(&args).output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Confirm the PID still belongs to the expected executable before signalling.
            let matches = match image.as_deref() {
                Some(name) => std::fs::read_to_string(format!("/proc/{}/comm", pid))
                    .map(|c| c.trim() == name.trim_end_matches(".exe"))
                    .unwrap_or(true),
                None => true,
            };
            if matches {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .output();
            }
        }
    }
}

/// Stops a console window flashing up for a child process on Windows. No-op elsewhere.
pub(crate) fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

pub(crate) async fn start_sidecars(app: tauri::AppHandle) {
    // Held for the whole function, health poll included, so a second caller waits
    // rather than racing a second engine onto the port.
    let _startup_guard = sidecar_start_lock().lock().await;

    let app_py_path = match find_app_py(&app) {
        Some(p) => p,
        None => {
            eprintln!("[Sidecar Error] app.py not found in working directory or resources!");
            let _ = app.emit("server-error", "Some of DubMate's files are missing. Connect to the internet and restart DubMate to download them, or reinstall it.");
            let _ = app.emit("startup-progress", "Files missing");
            return;
        }
    };

    let _ = app.emit("startup-progress", "Starting DubMate");

    // 1. Resolve and Spawn Python FastAPI sidecar
    let mut spawned = false;
    if let Some(py_exe) = find_python_exe(&app) {
        println!("[DubMate] Launching Python from: {:?}", py_exe);
        let _ = app.emit("startup-progress", "Starting DubMate");

        let port = find_available_port(DEFAULT_ENGINE_PORT);
        {
            let state = app.state::<SharedState>();
            state.0.lock().unwrap().engine_port = Some(port);
        }
        if port != DEFAULT_ENGINE_PORT {
            println!("[DubMate] Port {} busy; engine will use {}", DEFAULT_ENGINE_PORT, port);
        }

        match spawn_engine(&app, &app_py_path, &py_exe, port) {
            Ok(()) => spawned = true,
            Err(e) => eprintln!("[Sidecar Error] Failed to spawn Python directly: {}", e),
        }
    }

    if !spawned {
        eprintln!("[Sidecar Error] Unable to launch Python runtime!");
        let _ = app.emit("server-error", "DubMate couldn't start. Reinstall DubMate to fix this.");
        return;
    }

    // 2. Poll the engine's health endpoint until responsive
    let engine_port = {
        let state = app.state::<SharedState>();
        let p = state.0.lock().unwrap().engine_port;
        p.unwrap_or(DEFAULT_ENGINE_PORT)
    };
    if !wait_for_engine(&app, engine_port).await {
        return;
    }

    // 3. Spawn cloudflared tunnel sidecar
    start_tunnel(&app, engine_port);
}

/// Spawns the Python engine directly from `py_exe` on `port`: environment, process,
/// stdout/stderr log pipes and the exit watcher that reports a crash to the UI.
fn spawn_engine(
    app: &tauri::AppHandle,
    app_py_path: &Path,
    py_exe: &Path,
    port: u16,
) -> Result<(), String> {
    let app_dir = app_py_path.parent().unwrap_or(app_py_path);

    let mut cmd = std::process::Command::new(py_exe);
    cmd.current_dir(app_dir)
        .arg("-u")
        .arg(app_py_path)
        .env("DUBMATE_PORT", port.to_string());

    // Add adjacent site-packages and app_dir to PYTHONPATH and set PYTHONHOME
    if let Some(py_dir) = py_exe.parent() {
        cmd.env("PYTHONHOME", py_dir);
        let site_pkgs = py_dir.join("Lib").join("site-packages");
        let mut pypath = vec![app_dir.to_path_buf()];
        if site_pkgs.is_dir() {
            pypath.push(site_pkgs);
        }
        // Optional Pack Builder AI pipeline, installed inside the application
        // directory so it stays on whichever drive the user installed to.
        if let Some(ai) = ai_packages_dir(&install_root_dir(app)) {
            pypath.push(ai);
        }
        if let Ok(joined) = std::env::join_paths(pypath) {
            cmd.env("PYTHONPATH", joined);
        }
    }

    // Shared registry key, baked in at compile time from the CI secret so it is
    // not in source control. Absent in local dev builds, which just disables
    // public room registration -- local and LAN play are unaffected.
    if let Some(worker_key) = option_env!("DUBMATE_WORKER_KEY") {
        if !worker_key.trim().is_empty() {
            cmd.env("DUBMATE_WORKER_KEY", worker_key.trim());
        }
    }

    // Hand the engine an explicit pointer to the bundled media binaries, and put
    // them on PATH too since Whisper/Demucs invoke ffmpeg by bare name.
    if let Some(tools_dir) = find_bundled_tools_dir(app) {
        cmd.env("DUBMATE_TOOLS_DIR", &tools_dir);
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}{}{}", tools_dir.display(), sep, existing));
    }

    hide_console(&mut cmd);

    cmd.stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    {
        let state = app.state::<SharedState>();
        let mut data = state.0.lock().unwrap();
        data.python_pid = Some(pid);
        data.python_image = py_exe
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
    }

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    std::thread::spawn(move || {
        if let Some(out) = stdout.take() {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                println!("[Python] {}", line);
            }
        }
    });

    let app_err_clone = app.clone();
    let last_error_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let last_error_writer = last_error_buf.clone();

    std::thread::spawn(move || {
        if let Some(err) = stderr.take() {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[Python ERR] {}", line);
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let mut b = last_error_writer.lock().unwrap();
                    *b = trimmed.to_string();
                }
                if line.contains("Traceback") || line.contains("ModuleNotFoundError") || line.contains("Error") {
                    let _ = app_err_clone.emit("startup-progress", "Still starting");
                }
            }
        }
    });

    let app_exit_clone = app.clone();
    let last_error_reader = last_error_buf.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(status) = child.wait() {
            eprintln!("[Python] Process exited with status: {:?}", status);
            if !status.success() {
                std::thread::sleep(std::time::Duration::from_millis(150));
                let err_msg = {
                    let b = last_error_reader.lock().unwrap();
                    if !b.is_empty() {
                        b.clone()
                    } else {
                        format!("Process exited with status {:?}", status.code())
                    }
                };
                let _ = app_exit_clone.emit("server-error", format!("DubMate stopped while starting. Click Try again to restart it.\n\nDetails: {}", err_msg));
            }
        }
    });

    Ok(())
}

/// Polls the engine's health endpoint until it answers (max 60 attempts x 500ms = 30s).
/// Emits server-ready on success and server-error on timeout.
async fn wait_for_engine(app: &tauri::AppHandle, engine_port: u16) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", engine_port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    for _attempt in 1..=60 {
        let _ = app.emit("startup-progress", "Starting DubMate");
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                let _ = app.emit("server-ready", engine_port);
                println!("[DubMate] Server healthy on http://127.0.0.1:{}", engine_port);
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    eprintln!("[Sidecar Error] Studio engine did not respond on http://127.0.0.1:{} within 30 seconds", engine_port);
    let _ = app.emit("server-error", "DubMate didn't start in time. Click Try again to restart it.");
    false
}

/// Starts the cloudflared quick tunnel to the engine: resolve, spawn, the URL watcher
/// that publishes the URL to the UI and the engine, and the watchdog.
fn start_tunnel(app: &tauri::AppHandle, engine_port: u16) {
    // Both the tunnel target and the callback below use `engine_port`, not a
    // hardcoded 8000. The engine falls back to a free port when 8000 is taken, and
    // pointing the tunnel at 8000 regardless meant guests reached nothing and the
    // engine never learned its own public URL.
    let tunnel_target = format!("http://127.0.0.1:{}", engine_port);

    // Every failure below is reported. All four used to be silent: a missing
    // sidecar, a failed spawn, cloudflared exiting, and cloudflared running but
    // never producing a URL all left the engine sitting on tunnel_url = None,
    // and the studio told the host "Waiting for the public tunnel to come up..."
    // forever with nothing anywhere explaining that it was never coming.
    let cf_cmd = match resolve_cloudflared(app) {
        Some(cmd) => cmd,
        None => {
            report_tunnel_failure(
                app,
                engine_port,
                "Online invites are unavailable because a DubMate file is missing. Reinstall DubMate to fix this. Friends on your network can still join.".to_string(),
            );
            return;
        }
    };

    let spawned = cf_cmd.args(["tunnel", "--url", &tunnel_target]).spawn();
    let (mut rx, child) = match spawned {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[DubMate] cloudflared spawn failed: {e}");
            report_tunnel_failure(
                app,
                engine_port,
                "Online invites couldn't start. Friends on your network can still join.".to_string(),
            );
            return;
        }
    };
    {
        let state = app.state::<SharedState>();
        let mut data = state.0.lock().unwrap();
        data.cloudflared_pid = Some(child.pid());
        data.cloudflared_image = Some(
            if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" }.to_string(),
        );
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let re = Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap();
        let mut last_reported: Option<String> = None;
        while let Some(event) = rx.recv().await {
            // cloudflared prints the quick-tunnel banner on stderr, but read
            // stdout too so a logging change upstream cannot silently break
            // public rooms.
            let text = match event {
                CommandEvent::Stderr(bytes) | CommandEvent::Stdout(bytes) => {
                    String::from_utf8_lossy(&bytes).into_owned()
                }
                _ => continue,
            };
            let Some(mat) = re.find(&text) else { continue };

            let tunnel_url = mat.as_str().to_string();
            if last_reported.as_deref() == Some(tunnel_url.as_str()) {
                continue;
            }
            last_reported = Some(tunnel_url.clone());
            {
                let state = app_clone.state::<SharedState>();
                let mut data = state.0.lock().unwrap();
                data.is_tunnel_ready = true;
            }
            let _ = app_clone.emit("tunnel-ready", tunnel_url.clone());

            // Notify the local engine of the active tunnel URL. This is what
            // makes room codes resolvable, so it retries: dropping it on a
            // single transient failure leaves every room of the session
            // unjoinable with no way to recover.
            tauri::async_runtime::spawn(post_tunnel_notice(
                engine_port,
                serde_json::json!({ "tunnel_url": tunnel_url }),
                10,
            ));
        }

        // The stream only ends when cloudflared exits. If it never gave us
        // a URL, the tunnel is not coming and the host needs to know.
        if last_reported.is_none() {
            report_tunnel_failure(
                &app_clone,
                engine_port,
                "Online invites stopped before they were ready. Your network may be blocking them. Friends on your network can still join.".to_string(),
            );
        }
    });

    // Watchdog. A quick tunnel normally reports its URL within seconds;
    // if it has not after a minute, something is wrong and saying nothing
    // is the worst option.
    let watchdog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(TUNNEL_READY_TIMEOUT_SECS)).await;
        let ready = {
            let state = watchdog_app.state::<SharedState>();
            let data = state.0.lock().unwrap();
            data.is_tunnel_ready
        };
        if !ready {
            report_tunnel_failure(
                &watchdog_app,
                engine_port,
                format!(
                    "Online invites didn't start within {TUNNEL_READY_TIMEOUT_SECS} seconds. Friends on your network can still join; friends elsewhere can't yet."
                ),
            );
        }
    });
}

/// Names to try when locating the bundled cloudflared, most likely first.
///
/// The first entry is what the bundler actually ships; the second is the path as
/// declared in tauri.conf.json, kept only so a future bundler change cannot break
/// this again. Named rather than inlined so tests/test_sidecar_names.py can check
/// it against tauri.conf.json.
const CLOUDFLARED_SIDECAR_NAMES: [&str; 2] = ["cloudflared", "sidecar/cloudflared"];

/// Seconds to wait for cloudflared to publish a URL before declaring it failed.
const TUNNEL_READY_TIMEOUT_SECS: u64 = 60;

/// Finds the bundled cloudflared, tolerating either sidecar layout.
///
/// tauri.conf.json declares the external binary as "sidecar/cloudflared", and it
/// was being requested under that same string at runtime. The bundler does not
/// keep that directory: it flattens external binaries next to the executable, so
/// the shipped file is `<app dir>/cloudflared.exe` while the lookup asked for
/// `<app dir>/sidecar/cloudflared.exe`, which never existed. The call therefore
/// failed on every launch of every install, and because it sat inside an
/// `if let Ok(..)` with no else, nothing said so -- the tunnel simply never
/// started, room codes were never published, and no guest could ever join.
///
/// Both names are tried so this keeps working whichever layout a future bundler
/// produces, and so it does not silently break again if the config changes.
fn resolve_cloudflared(app: &tauri::AppHandle) -> Option<tauri_plugin_shell::process::Command> {
    for name in CLOUDFLARED_SIDECAR_NAMES {
        match app.shell().sidecar(name) {
            Ok(cmd) => {
                println!("[DubMate] Using cloudflared sidecar '{name}'");
                return Some(cmd);
            }
            Err(e) => eprintln!("[DubMate] cloudflared sidecar '{name}' unavailable: {e}"),
        }
    }
    None
}

/// Tells the user, the log and the engine that the public tunnel is not coming.
///
/// The engine records it so `/api/rooms/{code}/share` can answer "the tunnel
/// failed" instead of "waiting for the public tunnel", which is what it said
/// indefinitely no matter what went wrong.
fn report_tunnel_failure(app: &tauri::AppHandle, engine_port: u16, reason: String) {
    eprintln!("[DubMate] Public tunnel unavailable: {reason}");
    let _ = app.emit("tunnel-error", reason.clone());

    tauri::async_runtime::spawn(post_tunnel_notice(
        engine_port,
        serde_json::json!({ "error": reason }),
        5,
    ));
}

/// POSTs `body` to the engine's /api/tunnel, retrying every 2s up to `attempts` times
/// until the engine accepts it.
async fn post_tunnel_notice(port: u16, body: serde_json::Value, attempts: u32) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let endpoint = format!("http://127.0.0.1:{}/api/tunnel", port);
    for attempt in 1..=attempts {
        match client.post(&endpoint).json(&body).send().await {
            Ok(resp) if resp.status().is_success() => {
                println!("[DubMate] Tunnel notice {} published to engine", body);
                return;
            }
            Ok(resp) => {
                eprintln!(
                    "[DubMate] Engine rejected tunnel notice ({}), attempt {}/{}",
                    resp.status(),
                    attempt,
                    attempts
                );
            }
            Err(e) => {
                eprintln!(
                    "[DubMate] Could not notify engine of tunnel ({}), attempt {}/{}",
                    e, attempt, attempts
                );
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    eprintln!("[DubMate] Gave up notifying engine of tunnel notice {}", body);
}
