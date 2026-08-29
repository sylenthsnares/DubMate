fn main() {
    // The worker registry key is baked in via option_env! in main.rs. Cargo does not
    // otherwise track env vars, so a rotated key would silently keep the old value
    // until something else forced a rebuild.
    println!("cargo:rerun-if-env-changed=DUBMATE_WORKER_KEY");
    tauri_build::build()
}
