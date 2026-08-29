#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
mod updater;

use state::{DubMateState, SharedState};
use updater::UpdateCheckResult;

use regex::Regex;
use std::path::PathBuf;
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SharedState(Mutex::new(DubMateState::default())))
        .setup(|app| {
            let handle = app.handle().clone();

            // Background task: check for updates and start sidecars
            tauri::async_runtime::spawn(async move {
                let current_version = "1.0.8";
                let app_py_exists = crate::find_app_py(&handle).is_some();
                
                if app_py_exists {
                    // Start Python and Cloudflare sidecars immediately so engine is ready without delay
                    let h = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        start_sidecars(h).await;
                    });
                }

                // Mandatory Update Check
                let update_res = updater::check_for_update(current_version, &handle).await;
                let _ = handle.emit("update-status", &update_res);

                match &update_res {
                    UpdateCheckResult::UpdateAvailable { .. } => {
                        if !app_py_exists {
                            println!("[Updater] Initial bundle required before starting sidecars.");
                        } else {
                            println!("[Updater] Update available in background.");
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
            trigger_start_sidecars,
            apply_update,
        ])
        .on_window_event(|window, event| {
            // Kill child sidecar processes cleanly when the window is closed
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<SharedState>();
                let data = state.0.lock().unwrap();

                for pid in [data.python_pid, data.cloudflared_pid].into_iter().flatten() {
                    #[cfg(target_os = "windows")]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/PID", &pid.to_string()])
                            .output();
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        let _ = std::process::Command::new("kill")
                            .args(["-9", &pid.to_string()])
                            .output();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn start_sidecars(app: tauri::AppHandle) {
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

        let mut cmd = std::process::Command::new(&py_exe);
        cmd.current_dir(app_dir)
            .arg("-u")
            .arg(&app_py_path);

        // Add adjacent site-packages and app_dir to PYTHONPATH and set PYTHONHOME
        if let Some(py_dir) = py_exe.parent() {
            cmd.env("PYTHONHOME", py_dir);
            let site_pkgs = py_dir.join("Lib").join("site-packages");
            let mut pypath = vec![app_dir.to_path_buf()];
            if site_pkgs.is_dir() {
                pypath.push(site_pkgs);
            }
            if let Ok(joined) = std::env::join_paths(pypath) {
                cmd.env("PYTHONPATH", joined);
            }
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

    // 2. Poll localhost:8000/health until responsive (max 60 attempts x 500ms = 30s)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let mut is_ready = false;
    for i in 1..=60 {
        let _ = app.emit("startup-progress", format!("Connecting to Studio Engine... ({}/60)", i));
        if let Ok(resp) = client.get("http://127.0.0.1:8000/health").send().await {
            if resp.status().is_success() {
                let state = app.state::<SharedState>();
                state.0.lock().unwrap().is_server_ready = true;
                is_ready = true;
                let _ = app.emit("server-ready", ());
                println!("[DubMate] Server healthy on http://127.0.0.1:8000");
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    if !is_ready {
        eprintln!("[Sidecar Error] Studio engine did not respond on http://127.0.0.1:8000 within 30 seconds");
        let _ = app.emit("server-error", "Studio engine did not respond on port 8000 in time. Please check if another application is using port 8000 or click Retry.");
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
    start_sidecars(app).await;
}

#[tauri::command]
async fn apply_update(download_url: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_dir = get_app_install_dir(&app);
    updater::download_and_extract_bundle(&download_url, &app_dir, app.clone()).await?;
    let _ = app.emit("update-complete", ());
    Ok(())
}
