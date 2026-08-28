#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
mod updater;

use state::{DubMateState, SharedState};
use updater::UpdateCheckResult;

use regex::Regex;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SharedState(Mutex::new(DubMateState::default())))
        .setup(|app| {
            let handle = app.handle().clone();

            // Background task: check for mandatory updates and start sidecars
            tauri::async_runtime::spawn(async move {
                let current_version = "1.0.2";
                
                // 1. Mandatory Update Check
                let update_res = updater::check_for_update(current_version).await;
                let _ = handle.emit("update-status", &update_res);

                match &update_res {
                    UpdateCheckResult::UpdateAvailable { .. } => {
                        // Wait for user to trigger update from the UI
                        println!("[Updater] Update available. Holding sidecar startup.");
                    }
                    _ => {
                        // Start Python and Cloudflare sidecars immediately
                        start_sidecars(handle.clone()).await;
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
    // 1. Spawn Python FastAPI sidecar
    if let Ok(sidecar_cmd) = app.shell().sidecar("sidecar/python-runtime/python") {
        if let Ok((mut rx, child)) = sidecar_cmd.args(["app.py"]).spawn() {
            {
                let state = app.state::<SharedState>();
                let mut data = state.0.lock().unwrap();
                data.python_pid = Some(child.pid());
            }

            // Drain stdout / stderr in background task
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            print!("[Python] {}", line);
                        }
                        CommandEvent::Stderr(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            eprint!("[Python ERR] {}", line);
                        }
                        _ => {}
                    }
                }
            });
        }
    }

    // 2. Poll localhost:8000/health until responsive (max 30s)
    let client = reqwest::Client::new();
    for _ in 0..60 {
        if let Ok(resp) = client.get("http://127.0.0.1:8000/health").send().await {
            if resp.status().is_success() {
                let state = app.state::<SharedState>();
                state.0.lock().unwrap().is_server_ready = true;
                let _ = app.emit("server-ready", ());
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
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
                            let _ = app_clone.emit("tunnel-ready", tunnel_url);
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
    let app_dir = std::env::current_dir().map_err(|e| e.to_string())?;
    updater::download_and_extract_bundle(&download_url, &app_dir, app.clone()).await?;
    let _ = app.emit("update-complete", ());
    Ok(())
}
