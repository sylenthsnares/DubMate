#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
mod updater;

use state::{DubMateState, SharedState};
use updater::UpdateCheckResult;

use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

pub fn find_app_py(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Check current executable directory & resources
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let direct = exe_dir.join("app.py");
            if direct.is_file() {
                return Some(direct);
            }
            let res = exe_dir.join("resources").join("app.py");
            if res.is_file() {
                return Some(res);
            }
        }
    }

    // 2. Check Tauri resource directory
    if let Ok(res_dir) = app.path().resource_dir() {
        let res_app = res_dir.join("app.py");
        if res_app.is_file() {
            return Some(res_app);
        }
        let nested_res = res_dir.join("resources").join("app.py");
        if nested_res.is_file() {
            return Some(nested_res);
        }
    }

    // 3. Check current working directory and parent paths (development mode)
    if let Ok(cwd) = std::env::current_dir() {
        let direct = cwd.join("app.py");
        if direct.is_file() {
            return Some(direct);
        }
        if let Some(parent) = cwd.parent() {
            let p_app = parent.join("app.py");
            if p_app.is_file() {
                return Some(p_app);
            }
            if let Some(gp) = parent.parent() {
                let gp_app = gp.join("app.py");
                if gp_app.is_file() {
                    return Some(gp_app);
                }
            }
        }
    }

    None
}

pub fn find_python_exe(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Check in resource_dir (packaged app)
    if let Ok(res_dir) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let names = ["python.exe", "python-x86_64-pc-windows-msvc.exe"];
        #[cfg(not(target_os = "windows"))]
        let names = ["bin/python3", "bin/python", "python3", "python"];

        for name in names {
            let candidates = [
                res_dir.join("python-runtime").join(name),
                res_dir.join("resources").join("python-runtime").join(name),
                res_dir.join("sidecar").join("python-runtime").join(name),
                res_dir.join(name),
            ];
            for p in candidates {
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    // 2. Check exe directory (installed root)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            #[cfg(target_os = "windows")]
            let names = ["python.exe", "python-x86_64-pc-windows-msvc.exe"];
            #[cfg(not(target_os = "windows"))]
            let names = ["bin/python3", "bin/python", "python3", "python"];

            for name in names {
                let candidates = [
                    exe_dir.join("resources").join("python-runtime").join(name),
                    exe_dir.join("python-runtime").join(name),
                    exe_dir.join("sidecar").join("python-runtime").join(name),
                    exe_dir.join(name),
                ];
                for p in candidates {
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    // 3. Check CWD and dev paths (dev mode)
    if let Ok(cwd) = std::env::current_dir() {
        #[cfg(target_os = "windows")]
        let candidates = [
            cwd.join("tauri").join("src-tauri").join("sidecar").join("python-runtime").join("python.exe"),
            cwd.join("tauri").join("src-tauri").join("sidecar").join("python-runtime").join("python-x86_64-pc-windows-msvc.exe"),
            cwd.join("src-tauri").join("sidecar").join("python-runtime").join("python.exe"),
            cwd.join("sidecar").join("python-runtime").join("python.exe"),
            cwd.join(".venv").join("Scripts").join("python.exe"),
        ];
        #[cfg(not(target_os = "windows"))]
        let candidates = [
            cwd.join("tauri").join("src-tauri").join("sidecar").join("python-runtime").join("bin").join("python3"),
            cwd.join(".venv").join("bin").join("python3"),
            cwd.join(".venv").join("bin").join("python"),
        ];

        for p in candidates {
            if p.is_file() {
                return Some(p);
            }
        }

        if let Some(parent) = cwd.parent() {
            #[cfg(target_os = "windows")]
            let p_cands = [
                parent.join("tauri").join("src-tauri").join("sidecar").join("python-runtime").join("python.exe"),
                parent.join("tauri").join("src-tauri").join("sidecar").join("python-runtime").join("python-x86_64-pc-windows-msvc.exe"),
                parent.join(".venv").join("Scripts").join("python.exe"),
            ];
            #[cfg(not(target_os = "windows"))]
            let p_cands = [
                parent.join("tauri").join("src-tauri").join("sidecar").join("python-runtime").join("bin").join("python3"),
                parent.join(".venv").join("bin").join("python3"),
            ];
            for p in p_cands {
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    // 4. System PATH fallback
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("where").arg("python").output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let p = PathBuf::from(line.trim());
                    if p.is_file() && !line.contains("WindowsApps") {
                        return Some(p);
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = std::process::Command::new("which").arg("python3").output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = stdout.lines().next() {
                    let p = PathBuf::from(first.trim());
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    None
}

pub fn get_app_install_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(app_py) = find_app_py(app) {
        if let Some(parent) = app_py.parent() {
            return parent.to_path_buf();
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let p_str = parent.to_string_lossy();
            if !p_str.contains("target") {
                return parent.to_path_buf();
            }
        }
    }

    if let Ok(res_dir) = app.path().resource_dir() {
        if res_dir.exists() {
            return res_dir;
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if cwd.ends_with("src-tauri") {
            if let Some(p) = cwd.parent().and_then(|p| p.parent()) {
                return p.to_path_buf();
            }
        } else if cwd.ends_with("tauri") {
            if let Some(p) = cwd.parent() {
                return p.to_path_buf();
            }
        }
        return cwd;
    }

    PathBuf::from(".")
}

/// Name of the directory holding the optional Pack Builder AI dependencies. It sits inside
/// the application directory on purpose: installing DubMate to X:\ must not push ~2 GB of
/// PyTorch onto C:\.
const AI_PACKAGES_DIR: &str = "ai-packages";
/// Written by the NSIS installer when the user ticks the Pack Builder option.
const PACKBUILDER_OPTIN_MARKER: &str = "packbuilder.optin";
/// Written by us only after pip exits cleanly, so a half-finished download is not
/// mistaken for a usable install.
const AI_COMPLETE_MARKER: &str = ".install-complete";

/// Directory holding the bundled ffmpeg/ffprobe binaries.
///
/// Tauri places `externalBin` sidecars next to the host executable, which is NOT
/// where the Python engine looks (it checks its own BASE_DIR/tools and system PATH).
/// Without bridging the two, a packaged install has no ffmpeg at all unless the user
/// happens to have one installed system-wide.
fn find_bundled_tools_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
            roots.push(dir.join("sidecar"));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("sidecar"));
        roots.push(res.join("tools"));
        roots.push(res);
    }

    for root in roots {
        for name in ["ffmpeg.exe", "ffmpeg"] {
            if root.join(name).is_file() {
                return Some(root);
            }
        }
    }
    None
}

/// Port the engine prefers. Anything already holding it used to make the app fail to
/// start with an error that named the cause but offered no way out.
const DEFAULT_ENGINE_PORT: u16 = 8000;

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

/// The directory the user actually chose at install time.
///
/// Tauri stages the Python files into a `resources` subfolder, so `get_app_install_dir()`
/// (which follows app.py) points one level too deep. The NSIS installer writes its opt-in
/// marker and the uninstaller cleans up at the real root, beside the executable -- reading
/// the marker from the resources folder meant the Pack Builder opt-in was silently never
/// detected.
fn install_root_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if !dir.to_string_lossy().contains("target") {
                return dir.to_path_buf();
            }
        }
    }
    get_app_install_dir(app)
}

/// Resolves the AI package directory if it exists, for injection into PYTHONPATH.
pub fn ai_packages_dir(app_dir: &Path) -> Option<PathBuf> {
    let p = app_dir.join(AI_PACKAGES_DIR);
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Version of the Python bundle currently on disk. OTA rewrites `app.py` and `VERSION`
/// together, so this is the value the update check must compare against — a compiled-in
/// constant goes stale the moment the first bundle lands and makes the app re-download
/// the same update on every launch.
fn read_installed_version(app: &tauri::AppHandle) -> String {
    if let Some(app_py) = find_app_py(app) {
        if let Some(dir) = app_py.parent() {
            if let Ok(raw) = std::fs::read_to_string(dir.join("VERSION")) {
                let v = raw.trim().to_string();
                if !v.is_empty() {
                    return v;
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_string()
}

/// Terminates the Python and cloudflared sidecars and clears the tracked state so a
/// subsequent start is treated as a cold boot.
fn kill_sidecars(app: &tauri::AppHandle) {
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
        data.is_server_ready = false;
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

#[derive(serde::Serialize, Clone, Debug)]
pub struct PackBuilderStatus {
    /// User ticked the Pack Builder option during installation.
    pub opted_in: bool,
    /// A completed install is present and importable.
    pub installed: bool,
    /// Where the dependencies live, shown to the user before a ~2 GB download.
    pub target_dir: String,
}

#[tauri::command]
fn get_packbuilder_status(app: tauri::AppHandle) -> PackBuilderStatus {
    let root = install_root_dir(&app);
    PackBuilderStatus {
        opted_in: root.join(PACKBUILDER_OPTIN_MARKER).is_file(),
        installed: root
            .join(AI_PACKAGES_DIR)
            .join(AI_COMPLETE_MARKER)
            .is_file(),
        target_dir: root.join(AI_PACKAGES_DIR).to_string_lossy().to_string(),
    }
}

/// Streams `pip install --target` output back to the launcher so a multi-gigabyte
/// download is not a frozen window.
fn run_pip_install(
    py: &Path,
    requirements: &Path,
    target: &Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};

    std::fs::create_dir_all(target)
        .map_err(|e| format!("Cannot create {}: {}", target.display(), e))?;

    let mut cmd = std::process::Command::new(py);
    cmd.arg("-u")
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-input")
        .arg("--upgrade")
        // Embedded Python ignores the isolated build env pip creates, so sdist
        // packages fail to find their backend. The backends are staged into the
        // runtime instead; see stage-sidecars.
        .arg("--no-build-isolation")
        .arg("--target")
        .arg(target)
        .arg("-r")
        .arg(requirements)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch pip from {}: {}", py.display(), e))?;

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit("packbuilder-progress", line);
            }
        });
    }

    let mut errors: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("packbuilder-progress", line.clone());
            errors.push(line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("pip did not complete: {}", e))?;

    if !status.success() {
        let tail = errors[errors.len().saturating_sub(8)..].join("\n");
        return Err(format!(
            "Pack Builder install failed (exit {}).\n{}",
            status.code().unwrap_or(-1),
            tail
        ));
    }

    std::fs::write(target.join(AI_COMPLETE_MARKER), env!("CARGO_PKG_VERSION"))
        .map_err(|e| format!("Install finished but the completion marker failed: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn install_packbuilder(app: tauri::AppHandle) -> Result<(), String> {
    // Requirements ship beside app.py (resources), but the packages install at the
    // install root so they land on the drive the user chose.
    let app_dir = get_app_install_dir(&app);
    let root = install_root_dir(&app);
    updater::ensure_writable(&root)?;

    let requirements = app_dir.join("requirements_builder.txt");
    if !requirements.is_file() {
        return Err(format!(
            "requirements_builder.txt was not found in {}. Apply the core update first.",
            app_dir.display()
        ));
    }

    let py = find_python_exe(&app)
        .ok_or_else(|| "Bundled Python runtime not found; cannot install the AI pipeline.".to_string())?;
    let target = root.join(AI_PACKAGES_DIR);

    let app_for_thread = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_pip_install(&py, &requirements, &target, &app_for_thread)
    })
    .await
    .map_err(|e| format!("Install task failed: {}", e))??;

    // The engine caches imports at startup, so it must restart before torch/whisper
    // become importable — the same trap that made OTA updates look like no-ops.
    let _ = app.emit("packbuilder-progress", "Restarting Studio Engine...");
    kill_sidecars(&app);
    start_sidecars(app.clone()).await;

    let _ = app.emit("packbuilder-complete", ());
    Ok(())
}

#[tauri::command]
async fn remove_packbuilder(app: tauri::AppHandle) -> Result<(), String> {
    let root = install_root_dir(&app);
    let target = root.join(AI_PACKAGES_DIR);
    if target.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Could not remove {}: {}", target.display(), e))?;
    }
    let _ = std::fs::remove_file(root.join(PACKBUILDER_OPTIN_MARKER));

    kill_sidecars(&app);
    start_sidecars(app.clone()).await;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SharedState(Mutex::new(DubMateState::default())))
        .setup(|app| {
            let handle = app.handle().clone();

            // Background task: check for updates and start sidecars
            tauri::async_runtime::spawn(async move {
                let current_version = read_installed_version(&handle);
                let app_py_exists = crate::find_app_py(&handle).is_some();
                
                if app_py_exists {
                    // Start Python and Cloudflare sidecars immediately so engine is ready without delay
                    let h = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        start_sidecars(h).await;
                    });
                }

                // Mandatory Update Check
                let update_res = updater::check_for_update(&current_version, &handle).await;
                let _ = handle.emit("update-status", &update_res);

                match &update_res {
                    UpdateCheckResult::UpdateAvailable { .. } => {
                        if !app_py_exists {
                            println!("[Updater] Initial bundle required before starting sidecars.");
                        } else {
                            println!("[Updater] Update available; engine restarts once it is applied.");
                        }
                    }
                    _ => {
                        if !app_py_exists {
                            start_sidecars(handle.clone()).await;
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tunnel_url,
            get_room_token,
            set_room_token,
            get_engine_port,
            trigger_start_sidecars,
            apply_update,
            get_packbuilder_status,
            install_packbuilder,
            remove_packbuilder,
        ])
        .on_window_event(|window, event| {
            // Kill child sidecar processes cleanly when the window is closed
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                kill_sidecars(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn start_sidecars(app: tauri::AppHandle) {
    // Held for the whole function, health poll included, so a second caller waits
    // rather than racing a second engine onto the port.
    let _startup_guard = sidecar_start_lock().lock().await;

    let app_py_path = match find_app_py(&app) {
        Some(p) => p,
        None => {
            eprintln!("[Sidecar Error] app.py not found in working directory or resources!");
            let _ = app.emit("server-error", "app.py not found in application directory or resources. If this is a new installation, please apply the update bundle.");
            let _ = app.emit("startup-progress", "Error: Application files missing.");
            return;
        }
    };
    let app_dir = app_py_path.parent().unwrap_or(&app_py_path);

    let _ = app.emit("startup-progress", "Resolving Python runtime...");

    // 1. Resolve and Spawn Python FastAPI sidecar
    let mut spawned = false;
    if let Some(py_exe) = find_python_exe(&app) {
        println!("[DubMate] Launching Python from: {:?}", py_exe);
        let _ = app.emit("startup-progress", format!("Launching Python engine ({:?})...", py_exe.file_name().unwrap_or_default()));

        let port = find_available_port(DEFAULT_ENGINE_PORT);
        {
            let state = app.state::<SharedState>();
            state.0.lock().unwrap().engine_port = Some(port);
        }
        if port != DEFAULT_ENGINE_PORT {
            println!("[DubMate] Port {} busy; engine will use {}", DEFAULT_ENGINE_PORT, port);
        }

        let mut cmd = std::process::Command::new(&py_exe);
        cmd.current_dir(app_dir)
            .arg("-u")
            .arg(&app_py_path)
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
            if let Some(ai) = ai_packages_dir(&install_root_dir(&app)) {
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
        if let Some(tools_dir) = find_bundled_tools_dir(&app) {
            cmd.env("DUBMATE_TOOLS_DIR", &tools_dir);
            let sep = if cfg!(windows) { ";" } else { ":" };
            let existing = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}{}{}", tools_dir.display(), sep, existing));
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::piped());

        match cmd.spawn() {
            Ok(mut child) => {
                let pid = child.id();
                {
                    let state = app.state::<SharedState>();
                    let mut data = state.0.lock().unwrap();
                    data.python_pid = Some(pid);
                    data.python_image = py_exe
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string());
                }
                spawned = true;

                let mut stdout = child.stdout.take();
                let mut stderr = child.stderr.take();

                tauri::async_runtime::spawn(async move {
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

                tauri::async_runtime::spawn(async move {
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
                                let _ = app_err_clone.emit("startup-progress", format!("Python: {}", line.trim()));
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
                            let _ = app_exit_clone.emit("server-error", format!("Studio engine error: {}", err_msg));
                        }
                    }
                });
            }
            Err(e) => {
                eprintln!("[Sidecar Error] Failed to spawn Python directly: {}", e);
            }
        }
    }

    // Fallback: try Tauri shell sidecar API
    if !spawned {
        if let Ok(sidecar_cmd) = app.shell().sidecar("sidecar/python-runtime/python") {
            let cmd = sidecar_cmd
                .current_dir(app_dir)
                .args(["-u", app_py_path.to_str().unwrap()]);

            if let Ok((mut rx, child)) = cmd.spawn() {
                spawned = true;
                {
                    let state = app.state::<SharedState>();
                    let mut data = state.0.lock().unwrap();
                    data.python_pid = Some(child.pid());
                    data.python_image = find_python_exe(&app)
                        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
                }

                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                let line = String::from_utf8_lossy(&bytes);
                                print!("[Python] {}", line);
                            }
                            CommandEvent::Stderr(bytes) => {
                                let line = String::from_utf8_lossy(&bytes);
                                eprintln!("[Python ERR] {}", line);
                            }
                            _ => {}
                        }
                    }
                });
            }
        }
    }

    if !spawned {
        eprintln!("[Sidecar Error] Unable to launch Python runtime!");
        let _ = app.emit("server-error", "Unable to start Python runtime. Please ensure Python is installed or reinstall DubMate Studio.");
        return;
    }

    // 2. Poll the engine's health endpoint until responsive (max 60 attempts x 500ms = 30s)
    let engine_port = {
        let state = app.state::<SharedState>();
        let p = state.0.lock().unwrap().engine_port;
        p.unwrap_or(DEFAULT_ENGINE_PORT)
    };
    let health_url = format!("http://127.0.0.1:{}/health", engine_port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let mut is_ready = false;
    for i in 1..=60 {
        let _ = app.emit("startup-progress", format!("Connecting to Studio Engine... ({}/60)", i));
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                let state = app.state::<SharedState>();
                state.0.lock().unwrap().is_server_ready = true;
                is_ready = true;
                let _ = app.emit("server-ready", engine_port);
                println!("[DubMate] Server healthy on http://127.0.0.1:{}", engine_port);
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    if !is_ready {
        eprintln!("[Sidecar Error] Studio engine did not respond on http://127.0.0.1:{} within 30 seconds", engine_port);
        let _ = app.emit("server-error", format!("Studio engine did not respond on port {} in time. Click Retry to restart it.", engine_port));
        return;
    }

    // 3. Spawn cloudflared tunnel sidecar
    if let Ok(cf_cmd) = app.shell().sidecar("sidecar/cloudflared") {
        if let Ok((mut rx, child)) = cf_cmd
            .args(["tunnel", "--url", "http://127.0.0.1:8000"])
            .spawn()
        {
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
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stderr(bytes) = event {
                        let text = String::from_utf8_lossy(&bytes);
                        if let Some(mat) = re.find(&text) {
                            let tunnel_url = mat.as_str().to_string();
                            {
                                let state = app_clone.state::<SharedState>();
                                let mut data = state.0.lock().unwrap();
                                data.tunnel_url = Some(tunnel_url.clone());
                                data.is_tunnel_ready = true;
                            }
                            let _ = app_clone.emit("tunnel-ready", tunnel_url.clone());

                            // Notify local FastAPI server of active tunnel URL
                            let url_clone = tunnel_url.clone();
                            tauri::async_runtime::spawn(async move {
                                let c = reqwest::Client::new();
                                let _ = c.post("http://127.0.0.1:8000/api/tunnel")
                                    .json(&serde_json::json!({ "tunnel_url": url_clone }))
                                    .send()
                                    .await;
                            });
                        }
                    }
                }
            });
        }
    }
}

#[tauri::command]
fn get_engine_port(state: tauri::State<'_, SharedState>) -> u16 {
    state.0.lock().unwrap().engine_port.unwrap_or(DEFAULT_ENGINE_PORT)
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

#[tauri::command]
async fn trigger_start_sidecars(app: tauri::AppHandle) {
    kill_sidecars(&app);
    start_sidecars(app).await;
}

#[tauri::command]
async fn apply_update(download_url: String, app: tauri::AppHandle) -> Result<(), String> {
    // Only ever fetch from this project's own release assets. Without this the
    // command would extract whatever zip the caller names over the install dir.
    if !updater::is_trusted_update_url(&download_url) {
        return Err(format!(
            "Refusing to apply an update from an untrusted location:
{}",
            download_url
        ));
    }

    let app_dir = get_app_install_dir(&app);

    // Fail before touching anything if the install directory is read-only. Half-writing a
    // bundle is worse than refusing, and the caller surfaces this message to the user.
    updater::ensure_writable(&app_dir)?;

    updater::download_and_extract_bundle(&download_url, &app_dir, app.clone()).await?;

    // The running engine still holds the previous Python modules in memory. Without this
    // restart the freshly downloaded fixes stay inert until the next cold launch.
    let _ = app.emit("startup-progress", "Restarting Studio Engine with the update...");
    kill_sidecars(&app);
    start_sidecars(app.clone()).await;

    let _ = app.emit("update-complete", ());
    Ok(())
}
