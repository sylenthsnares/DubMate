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
pub(crate) const AI_PACKAGES_DIR: &str = "ai-packages";
/// Written by the NSIS installer when the user ticks the Pack Builder option.
pub(crate) const PACKBUILDER_OPTIN_MARKER: &str = "packbuilder.optin";
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
