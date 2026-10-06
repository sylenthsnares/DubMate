//! Optional Pack Builder AI pipeline: install status, the pip install itself, the
//! plain-language progress shown while it runs, and removing it again.

use std::path::{Path, PathBuf};
use tauri::Emitter;

use crate::paths::{
    find_python_exe, get_app_install_dir, install_root_dir, AI_COMPLETE_MARKER, AI_PACKAGES_DIR,
    PACKBUILDER_OPTIN_MARKER,
};
use crate::sidecars::{hide_console, kill_sidecars, start_sidecars};

/// A human-readable snapshot of the Pack Builder install, sent to the launcher in
/// place of raw pip output. Nobody installing a dubbing app should have to read
/// "Collecting nvidia-cublas-cu12==12.4.5.8" to know whether anything is happening.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PackBuilderProgress {
    /// One of: preparing, downloading, installing, finalizing.
    pub phase: String,
    /// Short plain-language line, e.g. "Downloading the neural network engine".
    pub headline: String,
    /// Supporting figure, e.g. "412 MB of ~2.0 GB".
    pub detail: String,
    /// 0-100, monotonic. Never rewinds even when the size estimate grows.
    pub percent: f64,
    /// The original pip line, kept for the collapsible technical view.
    pub raw: String,
}

/// Roughly what the AI pipeline weighs. Only used as the denominator until pip has
/// announced enough real wheel sizes to beat it, so a wrong guess self-corrects
/// instead of pinning the bar.
const PACKBUILDER_EXPECTED_BYTES: f64 = 2.0 * 1024.0 * 1024.0 * 1024.0;

/// Turns a pip distribution name into something a person recognises.
fn friendly_component_name(package: &str) -> &'static str {
    let p = package.to_ascii_lowercase();
    if p.starts_with("nvidia-") || p.starts_with("triton") || p.starts_with("cuda") {
        "graphics card support"
    } else if p.starts_with("torch") {
        "the processing engine"
    } else if p.starts_with("demucs") || p.starts_with("julius") || p.starts_with("dora") {
        "voice separation"
    } else if p.contains("whisper") || p.starts_with("tiktoken") {
        "speech recognition"
    } else if p.starts_with("yt-dlp") || p.starts_with("yt_dlp") {
        "the link importer"
    } else if p.starts_with("numpy") || p.starts_with("scipy") || p.starts_with("numba")
        || p.starts_with("llvmlite") || p.starts_with("sympy") || p.starts_with("mpmath")
    {
        "audio tools"
    } else if p.starts_with("pykakasi") {
        "Japanese text support"
    } else {
        "supporting files"
    }
}

/// Incrementally turns pip's line-by-line chatter into `PackBuilderProgress`.
///
/// pip does not render its byte-level progress bar when stdout is a pipe, so the
/// only size signal available is the "Downloading x.whl (197.8 MB)" announcements.
/// A file is treated as complete once the next one is announced, which is accurate
/// enough for a bar and never overstates what has finished.
#[derive(Default)]
struct PipProgressParser {
    completed_bytes: f64,
    announced_total: f64,
    current_bytes: f64,
    current_component: String,
    phase: String,
    install_count: usize,
    last_percent: f64,
}

impl PipProgressParser {
    fn new() -> Self {
        Self {
            phase: "preparing".to_string(),
            ..Default::default()
        }
    }

    /// Parses a trailing "(197.8 MB)" size annotation into bytes.
    fn parse_size(line: &str) -> Option<f64> {
        let open = line.rfind('(')?;
        let close = line[open..].find(')')? + open;
        let inner = line[open + 1..close].trim();
        let mut parts = inner.split_whitespace();
        let value: f64 = parts.next()?.parse().ok()?;
        let unit = parts.next()?.to_ascii_lowercase();
        let scale = match unit.as_str() {
            "b" | "bytes" => 1.0,
            "kb" => 1024.0,
            "mb" => 1024.0 * 1024.0,
            "gb" => 1024.0 * 1024.0 * 1024.0,
            _ => return None,
        };
        Some(value * scale)
    }

    /// Pulls the distribution name out of "Collecting torch==2.4.0" or
    /// "Downloading torch-2.4.0-cp311-win_amd64.whl (197.8 MB)".
    fn package_from(line: &str, keyword: &str) -> String {
        let rest = match line.find(keyword) {
            Some(i) => line[i + keyword.len()..].trim(),
            None => return String::new(),
        };
        let token = rest.split_whitespace().next().unwrap_or("");
        // Wheel filenames are name-version-tags.whl; requirement specs are name==ver.
        let name = token
            .split(&['=', '<', '>', '!', '~', '['][..])
            .next()
            .unwrap_or(token);
        match name.split_once('-') {
            Some((head, _)) if name.ends_with(".whl") || name.ends_with(".tar.gz") => head.to_string(),
            _ => name.to_string(),
        }
    }

    fn format_bytes(bytes: f64) -> String {
        if bytes >= 1024.0 * 1024.0 * 1024.0 {
            format!("{:.1} GB", bytes / (1024.0 * 1024.0 * 1024.0))
        } else {
            format!("{:.0} MB", bytes / (1024.0 * 1024.0))
        }
    }

    fn snapshot(&mut self, raw: &str) -> PackBuilderProgress {
        let downloaded = self.completed_bytes;
        let total = self.announced_total.max(PACKBUILDER_EXPECTED_BYTES);

        // Downloading owns most of the bar because it owns most of the wall clock.
        let raw_percent = match self.phase.as_str() {
            "preparing" => 2.0,
            "downloading" => 4.0 + (downloaded / total).min(1.0) * 81.0,
            "installing" => 88.0,
            _ => 97.0,
        };
        self.last_percent = raw_percent.max(self.last_percent).min(100.0);

        let (headline, detail) = match self.phase.as_str() {
            "preparing" => (
                "Working out what to download".to_string(),
                "This takes a moment".to_string(),
            ),
            "downloading" => (
                format!("Downloading {}", self.current_component),
                format!(
                    "{} of ~{}",
                    Self::format_bytes(downloaded),
                    Self::format_bytes(total)
                ),
            ),
            "installing" => (
                "Installing".to_string(),
                if self.install_count > 0 {
                    "Almost there".to_string()
                } else {
                    "Almost there".to_string()
                },
            ),
            _ => (
                "Finishing up".to_string(),
                "Restarting DubMate".to_string(),
            ),
        };

        PackBuilderProgress {
            phase: self.phase.clone(),
            headline,
            detail,
            percent: self.last_percent,
            raw: raw.to_string(),
        }
    }

    fn push(&mut self, line: &str) -> PackBuilderProgress {
        let trimmed = line.trim();

        if trimmed.starts_with("Downloading ") || trimmed.starts_with("Using cached ") {
            let keyword = if trimmed.starts_with("Using cached ") {
                "Using cached "
            } else {
                "Downloading "
            };
            // The previously announced file is finished the moment a new one starts.
            self.completed_bytes += self.current_bytes;
            self.current_bytes = Self::parse_size(trimmed).unwrap_or(0.0);
            self.announced_total += self.current_bytes;
            let package = Self::package_from(trimmed, keyword);
            if !package.is_empty() {
                self.current_component = friendly_component_name(&package).to_string();
            }
            self.phase = "downloading".to_string();
        } else if trimmed.starts_with("Collecting ") || trimmed.starts_with("Requirement already satisfied") {
            if self.phase == "preparing" {
                let package = Self::package_from(trimmed, "Collecting ");
                if !package.is_empty() {
                    self.current_component = friendly_component_name(&package).to_string();
                }
            }
        } else if trimmed.starts_with("Installing collected packages") {
            // Everything announced has landed by this point.
            self.completed_bytes += self.current_bytes;
            self.current_bytes = 0.0;
            self.install_count = trimmed
                .split_once(':')
                .map(|(_, list)| list.split(',').filter(|s| !s.trim().is_empty()).count())
                .unwrap_or(0);
            self.phase = "installing".to_string();
        } else if trimmed.starts_with("Successfully installed") {
            self.phase = "finalizing".to_string();
        }

        self.snapshot(trimmed)
    }
}

#[cfg(test)]
mod packbuilder_progress_tests {
    use super::*;

    #[test]
    fn parses_wheel_sizes_in_several_units() {
        assert_eq!(
            PipProgressParser::parse_size("Downloading torch-2.4.0.whl (197.8 MB)"),
            Some(197.8 * 1024.0 * 1024.0)
        );
        assert_eq!(
            PipProgressParser::parse_size("Downloading tiny-1.0.whl (12.0 kB)"),
            Some(12.0 * 1024.0)
        );
        assert_eq!(PipProgressParser::parse_size("Collecting torch"), None);
    }

    #[test]
    fn extracts_package_names_from_specs_and_wheels() {
        assert_eq!(PipProgressParser::package_from("Collecting torch==2.4.0", "Collecting "), "torch");
        assert_eq!(
            PipProgressParser::package_from("Downloading nvidia_cublas_cu12-12.4.5.8-py3.whl (363 MB)", "Downloading "),
            "nvidia_cublas_cu12"
        );
    }

    #[test]
    fn maps_packages_to_language_a_person_understands() {
        assert_eq!(friendly_component_name("torch"), "the processing engine");
        assert_eq!(friendly_component_name("nvidia-cublas-cu12"), "graphics card support");
        assert_eq!(friendly_component_name("openai-whisper"), "speech recognition");
        assert_eq!(friendly_component_name("some-random-dep"), "supporting files");
    }

    #[test]
    fn progress_advances_through_phases_and_never_rewinds() {
        let mut p = PipProgressParser::new();
        let lines = [
            "Collecting torch>=2.0.0",
            "Downloading torch-2.4.0-cp311-win_amd64.whl (197.8 MB)",
            "Downloading nvidia_cublas_cu12-12.4.5.8.whl (363.4 MB)",
            "Installing collected packages: torch, demucs, openai-whisper",
            "Successfully installed torch-2.4.0 demucs-4.0.1",
        ];

        let mut last = 0.0;
        let mut phases = Vec::new();
        for line in lines {
            let snap = p.push(line);
            assert!(snap.percent >= last, "percent rewound at {line}: {} < {last}", snap.percent);
            assert!(snap.percent <= 100.0);
            assert!(!snap.headline.is_empty());
            last = snap.percent;
            phases.push(snap.phase);
        }

        assert_eq!(phases[0], "preparing");
        assert_eq!(phases[1], "downloading");
        assert_eq!(phases[3], "installing");
        assert_eq!(phases[4], "finalizing");
        assert!(last > 90.0, "should be near complete, got {last}");
    }

    #[test]
    fn download_detail_reports_completed_bytes_not_announced_ones() {
        let mut p = PipProgressParser::new();
        // A single announced file is in flight, so nothing has completed yet.
        let first = p.push("Downloading torch-2.4.0.whl (100.0 MB)");
        assert!(first.detail.starts_with("0 MB of"), "got {}", first.detail);

        // Announcing the next file means the first one landed.
        let second = p.push("Downloading demucs-4.0.1.whl (50.0 MB)");
        assert!(second.detail.starts_with("100 MB of"), "got {}", second.detail);
        assert_eq!(second.headline, "Downloading voice separation");
    }

    #[test]
    fn oversized_installs_grow_the_estimate_instead_of_pinning_the_bar() {
        let mut p = PipProgressParser::new();
        // Announce well beyond the 2 GB guess.
        p.push("Downloading a-1.0.whl (3000.0 MB)");
        let snap = p.push("Downloading b-1.0.whl (1000.0 MB)");
        assert!(snap.detail.contains("of ~3.9 GB"), "estimate should grow: {}", snap.detail);
        assert!(snap.percent < 100.0);
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
    /// Disk space the install uses, in bytes. Only measured when asked for
    /// (`withSize`): walking ~2 GB of files on every launch would slow startup.
    pub size_bytes: Option<u64>,
}

/// Async so that measuring the folder never blocks the window's main thread.
#[tauri::command]
pub async fn get_packbuilder_status(
    app: tauri::AppHandle,
    with_size: Option<bool>,
) -> PackBuilderStatus {
    let root = install_root_dir(&app);
    let target = root.join(AI_PACKAGES_DIR);
    let installed = target.join(AI_COMPLETE_MARKER).is_file();
    let size_bytes = if installed && with_size.unwrap_or(false) {
        let dir = target.clone();
        tauri::async_runtime::spawn_blocking(move || folder_size(&dir))
            .await
            .ok()
    } else {
        None
    };
    PackBuilderStatus {
        opted_in: root.join(PACKBUILDER_OPTIN_MARKER).is_file(),
        installed,
        target_dir: target.to_string_lossy().to_string(),
        size_bytes,
    }
}

/// Total size of the files under `dir`. Links are counted as themselves and never
/// followed, matching what removal deletes.
fn folder_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            // DirEntry::file_type does not follow links, so a link is never a dir here.
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
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

    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch pip from {}: {}", py.display(), e))?;

    // One parser shared by both streams, behind a mutex: pip interleaves them and the
    // progress estimate has to see every line to stay accurate.
    let parser = std::sync::Arc::new(std::sync::Mutex::new(PipProgressParser::new()));

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let parser = parser.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(mut p) = parser.lock() {
                    let _ = app.emit("packbuilder-progress", p.push(&line));
                }
            }
        });
    }

    let mut errors: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut p) = parser.lock() {
                let _ = app.emit("packbuilder-progress", p.push(&line));
            }
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
pub async fn install_packbuilder(app: tauri::AppHandle) -> Result<(), String> {
    // Requirements ship beside app.py (resources), but the packages install at the
    // install root so they land on the drive the user chose.
    let app_dir = get_app_install_dir(&app);
    let root = install_root_dir(&app);
    crate::updater::ensure_writable(&root)?;

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
    let _ = app.emit(
        "packbuilder-progress",
        PackBuilderProgress {
            phase: "finalizing".to_string(),
            headline: "Finishing up".to_string(),
            detail: "Restarting DubMate".to_string(),
            percent: 98.0,
            raw: "Restarting DubMate".to_string(),
        },
    );
    kill_sidecars(&app);
    start_sidecars(app.clone()).await;

    Ok(())
}

/// The folder removal is allowed to delete: the real `ai-packages` folder directly
/// inside the install folder, or `None` when there is none. Anything else in its
/// place is refused, because a link or junction there would point the delete at
/// files that are not Pack Builder's.
fn removal_target(root: &Path) -> Result<Option<PathBuf>, String> {
    let target = root.join(AI_PACKAGES_DIR);
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read {}: {}", target.display(), e)),
    };
    // On Windows a junction also reports as a symlink here.
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!(
            "Refusing to remove {}: it is not a plain folder.",
            target.display()
        ));
    }

    // Resolve both ends so a link higher up cannot move the folder somewhere else.
    let real_root = root
        .canonicalize()
        .map_err(|e| format!("Could not resolve {}: {}", root.display(), e))?;
    let real_target = target
        .canonicalize()
        .map_err(|e| format!("Could not resolve {}: {}", target.display(), e))?;
    let is_add_on_folder = real_target.parent() == Some(real_root.as_path())
        && real_target
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(AI_PACKAGES_DIR));
    if !is_add_on_folder {
        return Err(format!(
            "Refusing to remove {}: it is not the Pack Builder folder in {}.",
            real_target.display(),
            real_root.display()
        ));
    }
    Ok(Some(real_target))
}

/// Deletes the checked folder, then the installer's opt-in marker so the launcher
/// does not download Pack Builder again. The marker goes last: if the folder can't
/// be deleted, the user's choice is kept and nothing claims it was removed.
fn delete_packbuilder_files(root: &Path, target: Option<PathBuf>) -> Result<(), String> {
    if let Some(dir) = target {
        // An engine that was just stopped can hold its files open for a moment.
        let mut attempt = 0;
        loop {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if attempt < 4 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                Err(e) => return Err(format!("Could not remove {}: {}", dir.display(), e)),
            }
        }
    }
    match std::fs::remove_file(root.join(PACKBUILDER_OPTIN_MARKER)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove {}: {}", PACKBUILDER_OPTIN_MARKER, e)),
    }
}

/// Removes the Pack Builder add-on and restarts the engine without it. Resolves once
/// the engine answers again, so the caller can reload the studio straight away.
#[tauri::command]
pub async fn remove_packbuilder(app: tauri::AppHandle) -> Result<(), String> {
    let root = install_root_dir(&app);
    // Checked before anything stops, so a refusal leaves DubMate running.
    let target = removal_target(&root)?;

    // Windows won't delete a library the engine still has loaded, so stop it first.
    // The restart afterwards is also what makes Pack Builder show as not installed:
    // the engine only looks for the add-on when it starts.
    kill_sidecars(&app);
    let removed = tauri::async_runtime::spawn_blocking(move || {
        delete_packbuilder_files(&root, target)
    })
    .await
    .map_err(|e| format!("Removal task failed: {}", e))
    .and_then(|result| result);

    start_sidecars(app.clone()).await;
    removed
}

#[cfg(test)]
mod packbuilder_removal_tests {
    use super::*;

    /// A fresh, empty folder standing in for the install folder.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dubmate-p40-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Makes `link` lead to the folder `target`: a junction on Windows (no admin
    /// rights needed), a symlink elsewhere. False if the system refuses.
    fn link_folder(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// Removes a link without touching what it leads to.
    fn unlink(link: &Path) {
        let _ = std::fs::remove_dir(link).or_else(|_| std::fs::remove_file(link));
    }

    #[test]
    fn accepts_the_add_on_folder_inside_the_install_folder() {
        let root = scratch("plain");
        std::fs::create_dir_all(root.join(AI_PACKAGES_DIR).join("torch")).unwrap();

        let target = removal_target(&root).unwrap().expect("should be removable");
        assert_eq!(target, root.join(AI_PACKAGES_DIR).canonicalize().unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_to_remove_when_the_folder_is_missing() {
        let root = scratch("missing");
        assert_eq!(removal_target(&root).unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_file_in_place_of_the_folder() {
        let root = scratch("file");
        std::fs::write(root.join(AI_PACKAGES_DIR), b"not a folder").unwrap();
        assert!(removal_target(&root).is_err());
        assert!(root.join(AI_PACKAGES_DIR).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_link_that_leads_out_of_the_install_folder() {
        let root = scratch("link");
        let outside = scratch("link-outside");
        std::fs::write(outside.join("keep.txt"), b"keep me").unwrap();
        let link = root.join(AI_PACKAGES_DIR);
        if !link_folder(&outside, &link) {
            eprintln!("skipped: this system would not create a folder link");
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        assert!(removal_target(&root).is_err());
        assert!(outside.join("keep.txt").is_file(), "the link's target must be untouched");

        unlink(&link);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn removal_deletes_only_the_add_on_and_its_opt_in() {
        let root = scratch("delete");
        let outside = scratch("delete-outside");
        std::fs::write(outside.join("keep.txt"), b"keep me").unwrap();
        let add_on = root.join(AI_PACKAGES_DIR);
        std::fs::create_dir_all(add_on.join("torch")).unwrap();
        std::fs::write(add_on.join(AI_COMPLETE_MARKER), b"1.1.3").unwrap();
        std::fs::write(root.join(PACKBUILDER_OPTIN_MARKER), b"").unwrap();
        std::fs::write(root.join("DubMate.exe"), b"app").unwrap();
        // A link inside the add-on must be removed as a link, not followed.
        let inner_link = add_on.join("linked");
        let linked = link_folder(&outside, &inner_link);

        let target = removal_target(&root).unwrap();
        delete_packbuilder_files(&root, target).unwrap();

        assert!(!add_on.exists(), "the add-on folder should be gone");
        assert!(!root.join(PACKBUILDER_OPTIN_MARKER).exists(), "the opt-in should be gone");
        assert!(root.join("DubMate.exe").is_file(), "files beside it must stay");
        if linked {
            assert!(outside.join("keep.txt").is_file(), "a link's target must stay");
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn removal_with_nothing_installed_is_a_no_op() {
        let root = scratch("noop");
        std::fs::write(root.join("DubMate.exe"), b"app").unwrap();
        delete_packbuilder_files(&root, removal_target(&root).unwrap()).unwrap();
        assert!(root.join("DubMate.exe").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_the_studio_on_this_computer_may_remove_it() {
        use std::str::FromStr;
        use tauri::utils::acl::{capability::Capability, RemoteUrlPattern};

        let capability: Capability =
            serde_json::from_str(include_str!("../capabilities/studio.json")).unwrap();
        assert!(!capability.local, "the launcher has its own capability");
        let patterns: Vec<RemoteUrlPattern> = capability
            .remote
            .expect("the studio page is a remote origin")
            .urls
            .iter()
            .map(|url| RemoteUrlPattern::from_str(url).unwrap())
            .collect();
        let allowed = |url: &str| {
            let url = tauri::Url::parse(url).unwrap();
            patterns.iter().any(|pattern| pattern.test(&url))
        };

        // The engine picks its port at runtime, so any port on the loopback address.
        assert!(allowed("http://127.0.0.1:8000/"));
        assert!(allowed("http://127.0.0.1:8023/builder.html?select_pack=x"));
        // A host's room page, a LAN address or a look-alike host must not get in.
        assert!(!allowed("https://abc.trycloudflare.com/"));
        assert!(!allowed("http://192.168.1.20:8000/"));
        assert!(!allowed("http://127.0.0.1.evil.example:8000/"));
    }

    #[test]
    fn measures_the_files_under_a_folder() {
        let root = scratch("size");
        std::fs::create_dir_all(root.join("a").join("b")).unwrap();
        std::fs::write(root.join("one.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(root.join("a").join("b").join("two.bin"), vec![0u8; 24]).unwrap();
        assert_eq!(folder_size(&root), 1024);
        let _ = std::fs::remove_dir_all(&root);
    }
}
