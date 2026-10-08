fn main() {
    // The worker registry key is baked in via option_env! in main.rs. Cargo does not
    // otherwise track env vars, so a rotated key would silently keep the old value
    // until something else forced a rebuild.
    println!("cargo:rerun-if-env-changed=DUBMATE_WORKER_KEY");

    // The studio page comes from the engine at http://127.0.0.1:<port>, which Tauri
    // treats as a remote origin: it can only call a command that a capability with
    // `remote.urls` allows by name (capabilities/studio.json). Listing the commands
    // here generates those allow-<command> permissions. It also means the launcher
    // has to name its own commands (capabilities/default.json).
    let manifest = tauri_build::AppManifest::new().commands(&[
        "get_engine_port",
        "get_last_failure",
        "trigger_start_sidecars",
        "apply_update",
        "cancel_update",
        "get_packbuilder_status",
        "start_packbuilder_install",
        "get_packbuilder_install",
        "remove_packbuilder",
        "allow_room_origin",
        "open_mic_settings",
        "open_studio_in_browser",
        "open_download_page",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
