//! Starting, supervising and stopping the Python engine and cloudflared tunnel
//! sidecars.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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

/// How long the engine gets to answer before the launcher is told it didn't start. A
/// first start after install, with antivirus scanning every file, can take minutes; the
/// launcher stays neutral meanwhile and offers Restart from 25 s.
const ENGINE_START_TIMEOUT_SECS: u64 = 180;

/// Lines of the engine's stderr kept for the error card's details.
const STDERR_TAIL_LINES: usize = 20;

/// Why the engine didn't start, sent to the launcher as `server-error`. The title names
/// the cause, the message says what to do, and the detail is the log for Copy details.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct EngineFailure {
    /// One of: missing_files, no_runtime, port_in_use, damaged, crashed, timeout.
    pub kind: &'static str,
    pub title: &'static str,
    pub message: &'static str,
    /// Technical detail, empty when there is none.
    pub detail: String,
}

impl EngineFailure {
    pub(crate) fn new(kind: &'static str, detail: String) -> Self {
        let (title, message) = match kind {
            "missing_files" => (
                "Some of DubMate's files are missing",
                "Connect to the internet and restart DubMate to download them, or reinstall it.",
            ),
            "no_runtime" => ("DubMate couldn't start", "Reinstall DubMate to fix this."),
            "port_in_use" => (
                "Another app is using DubMate's port",
                "Close any other copy of DubMate, or restart your computer, then press Restart DubMate.",
            ),
            "damaged" => ("Some of DubMate's files are damaged", "Reinstall DubMate to fix this."),
            "timeout" => (
                "DubMate didn't start",
                "It didn't answer for 3 minutes. Press Restart DubMate.",
            ),
            _ => ("DubMate stopped while starting", "Press Restart DubMate to try again."),
        };
        Self { kind, title, message, detail }
    }
}

/// Reads the cause from the end of the engine's stderr: a busy port (Windows, Linux and
/// macOS word it differently), a missing module, or anything else as a crash.
pub(crate) fn classify_engine_failure(last_stderr: &str) -> EngineFailure {
    let lower = last_stderr.to_ascii_lowercase();
    let kind = if ["10048", "address already in use", "errno 98", "errno 48"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        "port_in_use"
    } else if last_stderr.contains("ModuleNotFoundError") || last_stderr.contains("ImportError") {
        "damaged"
    } else {
        "crashed"
    };
    EngineFailure::new(kind, last_stderr.to_string())
}

/// Keeps the last `STDERR_TAIL_LINES` non-blank lines.
fn push_tail(tail: &mut VecDeque<String>, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if tail.len() == STDERR_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(trimmed.to_string());
}

fn joined_tail(tail: &Mutex<VecDeque<String>>) -> String {
    tail.lock()
        .map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// What `spawn_engine` hands the health poll: whether this engine process has exited
/// (its exit watcher has then said why, if it was a failure), and its recent stderr.
struct EngineWatch {
    exited: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

/// Serialises sidecar startup. `start_sidecars` is reachable from app setup, the
/// Restart buttons (trigger_start_sidecars), apply_update and remove_packbuilder; two
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
        kill_process(pid, image.as_deref());
    }
}

/// Terminates `pid`, with its children, if it is still the executable named `image`.
pub(crate) fn kill_process(pid: u32, image: Option<&str>) {
    #[cfg(target_os = "windows")]
    {
        // Match on PID *and* image name. If the process already exited and
        // Windows recycled its PID, the filter simply matches nothing rather
        // than terminating an unrelated process. /T also takes down children.
        let mut args = vec![
            "/F".to_string(),
            "/T".to_string(),
            "/FI".to_string(),
            format!("PID eq {}", pid),
        ];
        if let Some(name) = image {
            args.push("/FI".to_string());
            args.push(format!("IMAGENAME eq {}", name));
        }
        let _ = std::process::Command::new("taskkill").args(&args).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Confirm the PID still belongs to the expected executable before signalling.
        let matches = match image {
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

/// Sends `server-error` to the launcher and keeps it for `get_last_failure`.
fn report_failure(app: &tauri::AppHandle, failure: EngineFailure) {
    app.state::<SharedState>().0.lock().unwrap().last_failure = Some(failure.clone());
    let _ = app.emit("server-error", failure);
}

pub(crate) async fn start_sidecars(app: tauri::AppHandle) {
    // Held for the whole function, health poll included, so a second caller waits
    // rather than racing a second engine onto the port.
    let _startup_guard = sidecar_start_lock().lock().await;
    app.state::<SharedState>().0.lock().unwrap().last_failure = None;

    let app_py_path = match find_app_py(&app) {
        Some(p) => p,
        None => {
            eprintln!("[Sidecar Error] app.py not found in working directory or resources!");
            report_failure(
                &app,
                EngineFailure::new("missing_files", "app.py was not found.".to_string()),
            );
            return;
        }
    };

    // 1. Resolve and Spawn Python FastAPI sidecar
    // Read before the engine starts: an install that finishes later isn't loaded.
    let install_done_at_spawn = crate::packbuilder::install_done();
    let mut watch = None;
    let mut spawn_error = "The Python runtime was not found.".to_string();
    if let Some(py_exe) = find_python_exe(&app) {
        println!("[DubMate] Launching Python from: {:?}", py_exe);
        let _ = app.emit("startup-progress", "Starting the engine");

        let port = find_available_port(DEFAULT_ENGINE_PORT);
        {
            let state = app.state::<SharedState>();
            state.0.lock().unwrap().engine_port = Some(port);
        }
        if port != DEFAULT_ENGINE_PORT {
            println!("[DubMate] Port {} busy; engine will use {}", DEFAULT_ENGINE_PORT, port);
        }

        match spawn_engine(&app, &app_py_path, &py_exe, port) {
            Ok(w) => watch = Some(w),
            Err(e) => {
                eprintln!("[Sidecar Error] Failed to spawn Python directly: {}", e);
                spawn_error = format!("Could not start {}: {}", py_exe.display(), e);
            }
        }
    }

    let Some(watch) = watch else {
        eprintln!("[Sidecar Error] Unable to launch Python runtime!");
        report_failure(&app, EngineFailure::new("no_runtime", spawn_error));
        return;
    };

    // 2. Poll the engine's health endpoint until responsive
    let engine_port = {
        let state = app.state::<SharedState>();
        let p = state.0.lock().unwrap().engine_port;
        p.unwrap_or(DEFAULT_ENGINE_PORT)
    };
    if !wait_for_engine(&app, engine_port, &watch).await {
        return;
    }
    crate::packbuilder::engine_started(install_done_at_spawn);

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
) -> Result<EngineWatch, String> {
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
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    let tail_writer = stderr_tail.clone();

    std::thread::spawn(move || {
        if let Some(err) = stderr.take() {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[Python ERR] {}", line);
                if let Ok(mut tail) = tail_writer.lock() {
                    push_tail(&mut tail, &line);
                }
                // uvicorn logs this once app.py is imported and its startup (loading the
                // scene library) begins.
                if line.contains("Waiting for application startup") {
                    let _ = app_err_clone.emit("startup-progress", "Loading your scenes");
                }
            }
        }
    });

    let exited = Arc::new(AtomicBool::new(false));
    let exited_flag = exited.clone();
    let app_exit_clone = app.clone();
    let tail_reader = stderr_tail.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let status = child.wait();
        eprintln!("[Python] Process exited with status: {:?}", status);
        // Give the stderr reader a moment to catch the last lines.
        std::thread::sleep(std::time::Duration::from_millis(150));
        // An engine that kill_sidecars stopped (Restart, an update, Pack Builder) is no
        // longer the tracked one, and its exit is not a failure to report.
        let still_tracked = {
            let state = app_exit_clone.state::<SharedState>();
            let data = state.0.lock().unwrap();
            data.python_pid == Some(pid)
        };
        if still_tracked {
            let mut detail = joined_tail(&tail_reader);
            if detail.is_empty() {
                detail = match &status {
                    Ok(status) => format!("The engine exited with status {:?}.", status.code()),
                    Err(e) => format!("The engine stopped: {}", e),
                };
            }
            report_failure(&app_exit_clone, classify_engine_failure(&detail));
        }
        // Set last, so the health poll only gives up once the error above is out.
        exited_flag.store(true, Ordering::SeqCst);
    });

    Ok(EngineWatch { exited, stderr_tail })
}

/// Polls the engine's health endpoint until it answers, for up to
/// `ENGINE_START_TIMEOUT_SECS`. Emits server-ready on success and a `timeout` failure
/// when it never answers. Stops early, without a second error, once the engine process
/// has exited: its exit watcher has already reported why.
async fn wait_for_engine(app: &tauri::AppHandle, engine_port: u16, watch: &EngineWatch) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", engine_port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let started = std::time::Instant::now();
    let limit = std::time::Duration::from_secs(ENGINE_START_TIMEOUT_SECS);
    while started.elapsed() < limit {
        if watch.exited.load(Ordering::SeqCst) {
            eprintln!("[Sidecar Error] The engine exited before it answered on port {}", engine_port);
            return false;
        }
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                let _ = app.emit("server-ready", engine_port);
                println!("[DubMate] Server healthy on http://127.0.0.1:{}", engine_port);
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    eprintln!(
        "[Sidecar Error] Studio engine did not respond on http://127.0.0.1:{} within {} seconds",
        engine_port, ENGINE_START_TIMEOUT_SECS
    );
    let mut detail = format!("No answer from {} after {} seconds.", health_url, ENGINE_START_TIMEOUT_SECS);
    let tail = joined_tail(&watch.stderr_tail);
    if !tail.is_empty() {
        detail.push_str("\n\n");
        detail.push_str(&tail);
    }
    report_failure(app, EngineFailure::new("timeout", detail));
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

#[cfg(test)]
mod engine_failure_tests {
    use super::*;

    #[test]
    fn a_busy_port_on_any_system_is_port_in_use() {
        for stderr in [
            "ERROR:    [Errno 10048] error while attempting to bind on address ('0.0.0.0', 8000)",
            "OSError: [Errno 98] Address already in use",
            "OSError: [Errno 48] Address already in use",
            "something: ADDRESS ALREADY IN USE",
        ] {
            let failure = classify_engine_failure(stderr);
            assert_eq!(failure.kind, "port_in_use", "{stderr}");
            assert_eq!(failure.title, "Another app is using DubMate's port");
            assert_eq!(
                failure.message,
                "Close any other copy of DubMate, or restart your computer, then press Restart DubMate."
            );
            assert_eq!(failure.detail, stderr);
        }
    }

    #[test]
    fn a_missing_module_means_damaged_files() {
        for stderr in [
            "ModuleNotFoundError: No module named 'fastapi'",
            "ImportError: DLL load failed while importing _sounddevice",
        ] {
            let failure = classify_engine_failure(stderr);
            assert_eq!(failure.kind, "damaged", "{stderr}");
            assert_eq!(failure.title, "Some of DubMate's files are damaged");
            assert_eq!(failure.message, "Reinstall DubMate to fix this.");
        }
    }

    #[test]
    fn anything_else_is_a_crash() {
        let failure = classify_engine_failure("ValueError: bad config\nApplication shutdown complete.");
        assert_eq!(failure.kind, "crashed");
        assert_eq!(failure.title, "DubMate stopped while starting");
        assert_eq!(failure.message, "Press Restart DubMate to try again.");
        assert_eq!(classify_engine_failure("").kind, "crashed");
    }

    #[test]
    fn the_port_wins_when_a_traceback_mentions_both() {
        // uvicorn logs the bind error, then shuts down; the bind error is what matters.
        let stderr = "ImportError: optional thing\nERROR:    [Errno 10048] error while attempting to bind";
        assert_eq!(classify_engine_failure(stderr).kind, "port_in_use");
    }

    #[test]
    fn each_kind_has_its_own_words() {
        let missing = EngineFailure::new("missing_files", String::new());
        assert_eq!(missing.title, "Some of DubMate's files are missing");
        assert_eq!(
            missing.message,
            "Connect to the internet and restart DubMate to download them, or reinstall it."
        );
        let runtime = EngineFailure::new("no_runtime", String::new());
        assert_eq!(runtime.title, "DubMate couldn't start");
        assert_eq!(runtime.message, "Reinstall DubMate to fix this.");
        let timeout = EngineFailure::new("timeout", String::new());
        assert_eq!(timeout.title, "DubMate didn't start");
        assert_eq!(timeout.message, "It didn't answer for 3 minutes. Press Restart DubMate.");
    }

    #[test]
    fn the_failure_reaches_the_launcher_as_an_object() {
        let value = serde_json::to_value(EngineFailure::new("timeout", "x".to_string())).unwrap();
        assert_eq!(value["kind"], "timeout");
        assert_eq!(value["title"], "DubMate didn't start");
        assert_eq!(value["detail"], "x");
        assert!(value["message"].is_string());
    }

    #[test]
    fn kill_process_stops_a_running_program_only_by_its_name() {
        // Something harmless that runs for half a minute on its own.
        let (program, args, image): (&str, &[&str], &str) = if cfg!(windows) {
            ("ping", &["-n", "30", "127.0.0.1"], "PING.EXE")
        } else {
            ("sleep", &["30"], "sleep")
        };
        let mut child = std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("could not start the test program");

        // Another program's name leaves it running. Only Windows and Linux can tell
        // the name (taskkill, /proc); elsewhere kill_process signals anyway.
        if cfg!(any(target_os = "windows", target_os = "linux")) {
            kill_process(child.id(), Some("not-this-one.exe"));
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert!(child.try_wait().unwrap().is_none(), "a different name must not be killed");
        }

        kill_process(child.id(), Some(image));
        let started = std::time::Instant::now();
        while child.try_wait().unwrap().is_none() {
            if started.elapsed() > std::time::Duration::from_secs(10) {
                let _ = child.kill();
                panic!("kill_process did not stop it");
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    #[test]
    fn the_stderr_tail_keeps_the_last_lines() {
        let mut tail = std::collections::VecDeque::new();
        for i in 0..(STDERR_TAIL_LINES + 5) {
            push_tail(&mut tail, &format!("line {i}"));
        }
        push_tail(&mut tail, "   ");
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert_eq!(tail.back().map(String::as_str), Some(format!("line {}", STDERR_TAIL_LINES + 4).as_str()));
    }
}
