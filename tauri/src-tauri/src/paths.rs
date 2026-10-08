//! Locating the app bundle, the Python runtime, bundled tools and the install
//! directories on disk.

use std::path::{Path, PathBuf};
use tauri::Manager;

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

/// Python executable names probed under each packaged runtime root, in probe order.
#[cfg(target_os = "windows")]
const PYTHON_EXE_NAMES: [&str; 1] = ["python.exe"];
#[cfg(not(target_os = "windows"))]
const PYTHON_EXE_NAMES: [&str; 4] = ["bin/python3", "bin/python", "python3", "python"];

pub fn find_python_exe(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Check in resource_dir (packaged app)
    if let Ok(res_dir) = app.path().resource_dir() {
        for name in PYTHON_EXE_NAMES {
            let candidates = [
                res_dir.join("python-runtime").join(name),
                res_dir.join("resources").join("python-runtime").join(name),
                res_dir.join("sidecar").join("python-runtime").join(name),
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
            for name in PYTHON_EXE_NAMES {
                let candidates = [
                    exe_dir.join("resources").join("python-runtime").join(name),
                    exe_dir.join("python-runtime").join(name),
                    exe_dir.join("sidecar").join("python-runtime").join(name),
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

/// True when `dir` is a cargo build output (a `target` component followed by `debug`
/// or `release`), i.e. a dev run rather than an install. A bare substring test also
/// matched install paths such as `D:\Targets\DubMate`.
fn is_cargo_target_dir(dir: &Path) -> bool {
    let mut after_target = false;
    for part in dir.components().map(|c| c.as_os_str()) {
        if after_target && (part == "debug" || part == "release") {
            return true;
        }
        if part == "target" {
            after_target = true;
        }
    }
    false
}

/// Directory holding app.py (usually `<install root>/resources`), not the install root.
pub fn get_app_install_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(app_py) = find_app_py(app) {
        if let Some(parent) = app_py.parent() {
            return parent.to_path_buf();
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            if !is_cargo_target_dir(parent) {
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

/// Name of the directory holding the optional Pack Builder AI dependencies. It lives in the
/// DubMate data folder (`user_data_root`), so no reinstall or uninstall deletes it by
/// default; 1.x kept it in the install folder, and `resolve_user_item` still finds it there
/// until it has been moved.
pub(crate) const AI_PACKAGES_DIR: &str = "ai-packages";
/// Written by the NSIS installer when the user ticks the Pack Builder option.
pub(crate) const PACKBUILDER_OPTIN_MARKER: &str = "packbuilder.optin";
/// Rooms, takes, saved videos and caches. The engine owns what is inside.
pub(crate) const DATA_DIR: &str = "data";
/// What the DubMate data folder holds, under the names the install folder used, so moving
/// each one out of a 1.x install folder is a single rename.
const USER_ITEMS: [&str; 3] = [DATA_DIR, AI_PACKAGES_DIR, PACKBUILDER_OPTIN_MARKER];
/// Overrides the DubMate data folder. The launcher also sets it for the engine, so both
/// always agree on the folder.
pub(crate) const DATA_DIR_ENV: &str = "DUBMATE_DATA_DIR";
const APP_DATA_FOLDER: &str = "DubMate";
/// Written by us only after pip exits cleanly, so a half-finished download is not
/// mistaken for a usable install.
pub(crate) const AI_COMPLETE_MARKER: &str = ".install-complete";

/// Directory holding the bundled ffmpeg/ffprobe binaries.
///
/// Tauri places `externalBin` sidecars next to the host executable, which is NOT
/// where the Python engine looks (it checks its own BASE_DIR/tools and system PATH).
/// Without bridging the two, a packaged install has no ffmpeg at all unless the user
/// happens to have one installed system-wide.
pub(crate) fn find_bundled_tools_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
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

/// The directory the user actually chose at install time.
///
/// Tauri stages the Python files into a `resources` subfolder, so `get_app_install_dir()`
/// (which follows app.py) points one level too deep. The NSIS installer writes its opt-in
/// marker and the uninstaller cleans up at the real root, beside the executable -- reading
/// the marker from the resources folder meant the Pack Builder opt-in was silently never
/// detected.
pub(crate) fn install_root_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if !is_cargo_target_dir(dir) {
                return dir.to_path_buf();
            }
        }
    }
    get_app_install_dir(app)
}

/// The system whose folder layout `user_data_root_for` follows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum TargetOs {
    Windows,
    MacOs,
    Other,
}

impl TargetOs {
    pub(crate) const CURRENT: TargetOs = if cfg!(windows) {
        TargetOs::Windows
    } else if cfg!(target_os = "macos") {
        TargetOs::MacOs
    } else {
        TargetOs::Other
    };
}

/// The per-user DubMate folder, the same table as `user_data_root` in
/// dubmate/data_home.py: `DUBMATE_DATA_DIR` if set, else `%LOCALAPPDATA%\DubMate` on
/// Windows, `~/Library/Application Support/DubMate` on macOS, the XDG data folder
/// elsewhere. Pure, so every layout can be checked on any computer.
pub(crate) fn user_data_root_for(
    os: TargetOs,
    env: impl Fn(&str) -> Option<String>,
    home: &Path,
) -> PathBuf {
    let var = |name: &str| env(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(dir) = var(DATA_DIR_ENV) {
        return PathBuf::from(dir);
    }
    let base = match os {
        TargetOs::Windows => var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local")),
        TargetOs::MacOs => home.join("Library").join("Application Support"),
        TargetOs::Other => var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share")),
    };
    base.join(APP_DATA_FOLDER)
}

/// True for a `cargo run`/`tauri dev` build, which keeps today's behaviour: everything in
/// the repo, nothing to move.
pub(crate) fn is_dev_run() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(is_cargo_target_dir))
        .unwrap_or(false)
}

/// Where this computer's DubMate data lives (see `user_data_root_for`). A dev run keeps
/// it in the repo, as the engine does for a source install.
pub(crate) fn user_data_root(app: &tauri::AppHandle) -> PathBuf {
    if is_dev_run() && std::env::var_os(DATA_DIR_ENV).is_none() {
        return install_root_dir(app);
    }
    let home = app.path().home_dir().unwrap_or_default();
    user_data_root_for(TargetOs::CURRENT, |name| std::env::var(name).ok(), &home)
}

/// Every place `name` can be, the new one first, then where 1.x kept it (the same order
/// as `legacy_locations` in dubmate/data_home.py). `exe_dir` is the launcher's folder and
/// `app_dir` the folder holding app.py. 1.x kept `data` only in the folder above
/// `resources` (the install folder on Windows, `Contents` on macOS), and Pack Builder's
/// files beside the launcher, in that folder, or beside app.py.
fn item_places(name: &str, new_root: &Path, exe_dir: &Path, app_dir: &Path) -> Vec<PathBuf> {
    let above_resources = match (app_dir.file_name(), app_dir.parent()) {
        (Some(folder), Some(parent)) if folder.eq_ignore_ascii_case("resources") => parent,
        _ => app_dir,
    };
    let old_roots = if name == DATA_DIR {
        vec![above_resources]
    } else {
        vec![exe_dir, above_resources, app_dir]
    };
    let mut places = vec![new_root.join(name)];
    for root in old_roots {
        let place = root.join(name);
        if !places.contains(&place) {
            places.push(place);
        }
    }
    places
}

/// The existence rule, identical to `resolve` in dubmate/data_home.py: the new place
/// unless it is missing and an old place has the item. A move that failed keeps using
/// the old place, a finished one uses the new place, and when both exist the new one wins.
fn first_existing(places: &[PathBuf]) -> PathBuf {
    places
        .iter()
        .find(|p| p.exists())
        .unwrap_or(&places[0])
        .clone()
}

/// True when something is still where 1.x kept it and nothing has replaced it yet, i.e.
/// when the one-time move has work to do.
fn has_items_to_move(new_root: &Path, exe_dir: &Path, app_dir: &Path) -> bool {
    USER_ITEMS.iter().any(|name| {
        let places = item_places(name, new_root, exe_dir, app_dir);
        first_existing(&places) != places[0]
    })
}

/// Every place `name` can be on this computer, the new one first. A dev run has only one.
pub(crate) fn user_item_places(app: &tauri::AppHandle, name: &str) -> Vec<PathBuf> {
    let root = user_data_root(app);
    if is_dev_run() {
        return vec![root.join(name)];
    }
    item_places(name, &root, &install_root_dir(app), &get_app_install_dir(app))
}

/// Where `name` (`ai-packages`, `packbuilder.optin`) is: the DubMate data folder, or the
/// install folder while 1.x's copy there hasn't been moved.
pub(crate) fn resolve_user_item(app: &tauri::AppHandle, name: &str) -> PathBuf {
    first_existing(&user_item_places(app, name))
}

/// True when a 1.x install folder still holds data or Pack Builder to move. Cheap: it
/// only checks whether a few paths exist.
pub(crate) fn legacy_items_present(app: &tauri::AppHandle) -> bool {
    !is_dev_run()
        && has_items_to_move(
            &user_data_root(app),
            &install_root_dir(app),
            &get_app_install_dir(app),
        )
}

/// The Pack Builder folder if it is there, for the engine's PYTHONPATH.
pub fn ai_packages_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let p = resolve_user_item(app, AI_PACKAGES_DIR);
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
pub(crate) fn read_installed_version(app: &tauri::AppHandle) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_target_dir_is_detected_by_component_not_substring() {
        assert!(is_cargo_target_dir(Path::new("/repo/tauri/src-tauri/target/debug")));
        assert!(is_cargo_target_dir(Path::new("/repo/tauri/src-tauri/target/release")));
        assert!(is_cargo_target_dir(Path::new(
            "/repo/tauri/src-tauri/target/x86_64-pc-windows-msvc/release"
        )));
        assert!(!is_cargo_target_dir(Path::new("/Targets/DubMate")));
        assert!(!is_cargo_target_dir(Path::new("/apps/target-practice/DubMate")));
        assert!(!is_cargo_target_dir(Path::new("/apps/target/DubMate")));
    }

    /// An environment holding only `vars`.
    fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> =
            vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    #[test]
    fn windows_keeps_data_in_local_app_data() {
        let home = Path::new(r"C:\Users\a");
        let local = r"C:\Users\a\AppData\Local";
        assert_eq!(
            user_data_root_for(TargetOs::Windows, env_of(&[("LOCALAPPDATA", local)]), home),
            PathBuf::from(local).join("DubMate")
        );
        // An empty variable falls back to the usual place under the profile.
        assert_eq!(
            user_data_root_for(TargetOs::Windows, env_of(&[("LOCALAPPDATA", "  ")]), home),
            home.join("AppData").join("Local").join("DubMate")
        );
    }

    #[test]
    fn macos_keeps_data_in_application_support() {
        let home = Path::new("/Users/a");
        assert_eq!(
            user_data_root_for(TargetOs::MacOs, env_of(&[("LOCALAPPDATA", "ignored")]), home),
            home.join("Library").join("Application Support").join("DubMate")
        );
    }

    #[test]
    fn other_systems_use_the_xdg_data_folder() {
        let home = Path::new("/home/a");
        assert_eq!(
            user_data_root_for(TargetOs::Other, env_of(&[]), home),
            home.join(".local").join("share").join("DubMate")
        );
        assert_eq!(
            user_data_root_for(TargetOs::Other, env_of(&[("XDG_DATA_HOME", "/data/a")]), home),
            PathBuf::from("/data/a").join("DubMate")
        );
    }

    #[test]
    fn dubmate_data_dir_wins_everywhere() {
        let home = Path::new("/home/a");
        for os in [TargetOs::Windows, TargetOs::MacOs, TargetOs::Other] {
            let env = env_of(&[(DATA_DIR_ENV, "/elsewhere/DM"), ("LOCALAPPDATA", "C:/x")]);
            assert_eq!(user_data_root_for(os, env, home), PathBuf::from("/elsewhere/DM"), "{os:?}");
        }
    }

    /// A fresh, empty folder for one test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dubmate-paths-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 1.x Windows install: `<inst>\DubMate.exe`, `<inst>\resources\app.py`, with data,
    /// Pack Builder and its opt-in beside the executable. Returns (new root, exe dir, app dir).
    fn windows_install(base: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let inst = base.join("DubMate Studio");
        std::fs::create_dir_all(inst.join("resources")).unwrap();
        std::fs::create_dir_all(inst.join("data").join("rooms")).unwrap();
        std::fs::create_dir_all(inst.join(AI_PACKAGES_DIR).join("torch")).unwrap();
        std::fs::write(inst.join(PACKBUILDER_OPTIN_MARKER), b"").unwrap();
        (base.join("Local").join("DubMate"), inst.clone(), inst.join("resources"))
    }

    #[test]
    fn a_windows_install_folder_is_used_until_its_files_have_moved() {
        let base = scratch("win");
        let (root, exe_dir, app_dir) = windows_install(&base);
        let places = |name| item_places(name, &root, &exe_dir, &app_dir);

        assert_eq!(first_existing(&places(AI_PACKAGES_DIR)), exe_dir.join(AI_PACKAGES_DIR));
        assert_eq!(first_existing(&places(DATA_DIR)), exe_dir.join(DATA_DIR));
        assert_eq!(
            first_existing(&places(PACKBUILDER_OPTIN_MARKER)),
            exe_dir.join(PACKBUILDER_OPTIN_MARKER)
        );
        assert!(has_items_to_move(&root, &exe_dir, &app_dir));

        // Once something is in the new place, the new place wins, even if the old copy stays.
        std::fs::create_dir_all(root.join(AI_PACKAGES_DIR)).unwrap();
        assert_eq!(first_existing(&places(AI_PACKAGES_DIR)), root.join(AI_PACKAGES_DIR));
        assert!(has_items_to_move(&root, &exe_dir, &app_dir), "data and the opt-in still wait");

        for name in [DATA_DIR, PACKBUILDER_OPTIN_MARKER] {
            std::fs::rename(exe_dir.join(name), root.join(name)).unwrap();
        }
        assert!(!has_items_to_move(&root, &exe_dir, &app_dir), "nothing left to move");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_macos_bundle_is_searched_where_1x_kept_each_item() {
        let base = scratch("mac");
        let contents = base.join("DubMate.app").join("Contents");
        let exe_dir = contents.join("MacOS");
        let res = contents.join("Resources");
        let app_dir = res.join("resources");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&app_dir).unwrap();
        let root = base.join("Library").join("Application Support").join("DubMate");
        let places = |name| item_places(name, &root, &exe_dir, &app_dir);

        assert!(!has_items_to_move(&root, &exe_dir, &app_dir), "a fresh install has nothing to move");

        // Data sat above the staged `resources` folder, Pack Builder beside the launcher.
        std::fs::create_dir_all(res.join(DATA_DIR).join("rooms")).unwrap();
        std::fs::create_dir_all(exe_dir.join(AI_PACKAGES_DIR)).unwrap();
        assert_eq!(first_existing(&places(DATA_DIR)), res.join(DATA_DIR));
        assert_eq!(first_existing(&places(AI_PACKAGES_DIR)), exe_dir.join(AI_PACKAGES_DIR));
        assert!(has_items_to_move(&root, &exe_dir, &app_dir));
        // `data` beside the launcher was never 1.x's; it isn't picked up.
        assert!(!places(DATA_DIR).contains(&exe_dir.join(DATA_DIR)));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nothing_anywhere_means_the_new_place() {
        let base = scratch("fresh");
        let (root, exe_dir, app_dir) = (base.join("new"), base.join("inst"), base.join("inst").join("resources"));
        for name in USER_ITEMS {
            let places = item_places(name, &root, &exe_dir, &app_dir);
            assert_eq!(places[0], root.join(name));
            assert_eq!(first_existing(&places), root.join(name));
            let mut unique = places.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(unique.len(), places.len(), "{name}: no place twice");
        }
        assert!(!has_items_to_move(&root, &exe_dir, &app_dir));
        let _ = std::fs::remove_dir_all(&base);
    }
}
