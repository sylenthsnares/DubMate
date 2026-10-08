#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mic_permission;
mod packbuilder;
mod paths;
mod sidecars;
mod state;
mod updater;

use paths::{get_app_install_dir, read_installed_version};
use sidecars::{kill_sidecars, start_sidecars, DEFAULT_ENGINE_PORT};
use state::{DubMateState, SharedState};
use updater::UpdateCheckResult;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SharedState(Mutex::new(DubMateState::default())))
        .setup(|app| {
            // Members join rooms on the host's tunnel origin; don't ask for the mic again there.
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                let res = w.with_webview(|wv| {
                    if let Err(e) = mic_permission::install(wv.controller()) {
                        eprintln!("[Mic] Could not install the microphone permission handler: {e}");
                    }
                });
                if let Err(e) = res {
                    eprintln!("[Mic] Could not reach the main webview: {e}");
                }
            }

            let handle = app.handle().clone();

            // Background task: check for updates and start sidecars
            tauri::async_runtime::spawn(async move {
                let current_version = read_installed_version(&handle);
                let app_py_exists = crate::paths::find_app_py(&handle).is_some();
                
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
            get_engine_port,
            trigger_start_sidecars,
            apply_update,
            updater::cancel_update,
            packbuilder::get_packbuilder_status,
            packbuilder::start_packbuilder_install,
            packbuilder::get_packbuilder_install,
            packbuilder::remove_packbuilder,
            mic_permission::allow_room_origin,
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

#[tauri::command]
fn get_engine_port(state: tauri::State<'_, SharedState>) -> u16 {
    state.0.lock().unwrap().engine_port.unwrap_or(DEFAULT_ENGINE_PORT)
}

#[tauri::command]
async fn trigger_start_sidecars(app: tauri::AppHandle) {
    kill_sidecars(&app);
    start_sidecars(app).await;
}

#[tauri::command]
async fn apply_update(download_url: String, app: tauri::AppHandle) -> Result<(), String> {
    // A Skip from an earlier update must not stop this one.
    updater::clear_update_cancel();

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

    let bundle = updater::download_bundle(&download_url, app.clone()).await?;

    // The bundle carries only Python and static files, so packages the new version needs
    // go into the bundled runtime here, before its files are written: if that fails the
    // old version stays whole and the engine is started on it again.
    let mut engine_stopped = false;
    if let Some(requirements) = updater::requirements_to_install(&bundle, &app_dir)? {
        match updater::bundled_python(&app) {
            Some(python) => {
                engine_stopped = true;
                let _ = app.emit(
                    "update-stage",
                    updater::UpdateStagePayload {
                        headline: "Installing the update".to_string(),
                        detail: "Downloading the parts it needs".to_string(),
                    },
                );
                // Windows won't replace a library the running engine has loaded.
                kill_sidecars(&app);
                let installed = tauri::async_runtime::spawn_blocking(move || {
                    updater::install_bundle_requirements(&python, &requirements)
                })
                .await
                .map_err(|e| format!("{}\n\nDetails: {}", updater::DEPENDENCY_INSTALL_FAILED, e))
                .and_then(|result| result);
                if let Err(message) = installed {
                    eprintln!("[Updater] Installing the update's requirements failed: {}", message);
                    start_sidecars(app.clone()).await;
                    return Err(message);
                }
            }
            None => println!("[Updater] No bundled Python runtime; requirements are left to the developer."),
        }
    }

    if let Err(message) = updater::extract_bundle(&bundle, &app_dir) {
        if engine_stopped {
            start_sidecars(app.clone()).await;
        }
        return Err(message);
    }

    // The running engine still holds the previous Python modules in memory. Without this
    // restart the freshly downloaded fixes stay inert until the next cold launch.
    let _ = app.emit("startup-progress", "Restarting DubMate to finish the update");
    kill_sidecars(&app);
    start_sidecars(app.clone()).await;

    let _ = app.emit("update-complete", ());
    Ok(())
}
