//! Optional Pack Builder AI pipeline: install status, the pip install itself and
//! the plain-language progress shown while it runs.

use std::path::Path;
use tauri::Emitter;

use crate::paths::{
    find_python_exe, get_app_install_dir, install_root_dir, AI_COMPLETE_MARKER, AI_PACKAGES_DIR,
    PACKBUILDER_OPTIN_MARKER,
};
use crate::sidecars::{kill_sidecars, start_sidecars};

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
        "GPU acceleration libraries"
    } else if p.starts_with("torch") {
        "the neural network engine"
    } else if p.starts_with("demucs") || p.starts_with("julius") || p.starts_with("dora") {
        "the vocal separation model"
    } else if p.contains("whisper") || p.starts_with("tiktoken") {
        "the speech recognition model"
    } else if p.starts_with("yt-dlp") || p.starts_with("yt_dlp") {
        "the video downloader"
    } else if p.starts_with("numpy") || p.starts_with("scipy") || p.starts_with("numba")
        || p.starts_with("llvmlite") || p.starts_with("sympy") || p.starts_with("mpmath")
    {
        "audio maths libraries"
    } else if p.starts_with("pykakasi") {
        "Japanese text support"
    } else {
        "supporting components"
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
                "Unpacking and installing".to_string(),
                if self.install_count > 0 {
                    format!("{} components", self.install_count)
                } else {
                    "Almost there".to_string()
                },
            ),
            _ => (
                "Finishing up".to_string(),
                "Restarting the studio engine".to_string(),
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
        assert_eq!(friendly_component_name("torch"), "the neural network engine");
        assert_eq!(friendly_component_name("nvidia-cublas-cu12"), "GPU acceleration libraries");
        assert_eq!(friendly_component_name("openai-whisper"), "the speech recognition model");
        assert_eq!(friendly_component_name("some-random-dep"), "supporting components");
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
        assert_eq!(second.headline, "Downloading the vocal separation model");
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
}

#[tauri::command]
pub fn get_packbuilder_status(app: tauri::AppHandle) -> PackBuilderStatus {
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
            detail: "Restarting the studio engine".to_string(),
            percent: 98.0,
            raw: "Restarting Studio Engine...".to_string(),
        },
    );
    kill_sidecars(&app);
    start_sidecars(app.clone()).await;

    Ok(())
}
