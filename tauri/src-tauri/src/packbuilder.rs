//! Optional Pack Builder AI pipeline: install status, the pip install itself, the
//! plain-language progress shown while it runs, and removing it again.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::Emitter;

use crate::paths::{
    find_python_exe, get_app_install_dir, install_root_dir, AI_COMPLETE_MARKER, AI_PACKAGES_DIR,
    PACKBUILDER_OPTIN_MARKER,
};
use crate::sidecars::{hide_console, kill_sidecars, start_sidecars};
use crate::updater::EtaEstimator;

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
    /// Bytes of the files that have finished downloading.
    pub done_bytes: f64,
    /// The download's expected size, which grows as pip announces more files.
    pub total_bytes: f64,
    /// Seconds of download left, once the speed has settled; None outside downloading.
    pub eta_secs: Option<u64>,
}

/// Where the background install is, for the studio's header chip
/// (`get_packbuilder_install`). It lives as long as the app, so it survives page reloads.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InstallState {
    Idle,
    Running,
    Done,
    Failed,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PackBuilderInstall {
    pub state: InstallState,
    pub progress: Option<PackBuilderProgress>,
    pub error: Option<String>,
}

impl PackBuilderInstall {
    const IDLE: Self = Self { state: InstallState::Idle, progress: None, error: None };

    /// Starts a fresh run and returns true, or returns false when one is already running.
    fn begin(&mut self) -> bool {
        if self.state == InstallState::Running {
            return false;
        }
        *self = Self { state: InstallState::Running, ..Self::IDLE };
        true
    }

    fn report(&mut self, progress: PackBuilderProgress) {
        if self.state == InstallState::Running {
            self.progress = Some(progress);
        }
    }

    fn finish(&mut self, result: Result<(), String>) {
        match result {
            Ok(()) => {
                self.state = InstallState::Done;
                self.error = None;
            }
            Err(e) => {
                self.state = InstallState::Failed;
                self.error = Some(e);
            }
        }
    }

    /// Back to idle after Pack Builder is removed, unless an install is running.
    fn forget(&mut self) {
        if self.state != InstallState::Running {
            *self = Self::IDLE;
        }
    }
}

static INSTALL: Mutex<PackBuilderInstall> = Mutex::new(PackBuilderInstall::IDLE);

fn install_state() -> MutexGuard<'static, PackBuilderInstall> {
    INSTALL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
struct PipProgressParser {
    completed_bytes: f64,
    announced_total: f64,
    current_bytes: f64,
    /// The file in flight came from pip's cache, so it finishes at no download speed.
    current_cached: bool,
    /// Bytes of finished files that really came over the network: the speed's measure.
    fetched_bytes: f64,
    current_component: String,
    phase: String,
    install_count: usize,
    last_percent: f64,
    /// pip only reports whole files, so the speed settles after 20 s and 2 of them.
    eta: EtaEstimator,
}

impl PipProgressParser {
    fn new() -> Self {
        Self {
            completed_bytes: 0.0,
            announced_total: 0.0,
            current_bytes: 0.0,
            current_cached: false,
            fetched_bytes: 0.0,
            current_component: String::new(),
            phase: "preparing".to_string(),
            install_count: 0,
            last_percent: 0.0,
            eta: EtaEstimator::new(20.0, 2),
        }
    }

    /// The file in flight has landed, `elapsed` seconds after pip started.
    fn finish_current(&mut self, elapsed: f64) {
        self.completed_bytes += self.current_bytes;
        if !self.current_cached && self.current_bytes > 0.0 {
            self.fetched_bytes += self.current_bytes;
            self.eta.sample(elapsed, self.fetched_bytes);
        }
        self.current_bytes = 0.0;
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

    fn snapshot(&mut self, raw: &str, elapsed: f64) -> PackBuilderProgress {
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
                "Almost done".to_string(),
            ),
        };

        let eta_secs = if self.phase == "downloading" {
            self.eta.eta_secs(elapsed, total - downloaded)
        } else {
            None
        };

        PackBuilderProgress {
            phase: self.phase.clone(),
            headline,
            detail,
            percent: self.last_percent,
            raw: raw.to_string(),
            done_bytes: downloaded,
            total_bytes: total,
            eta_secs,
        }
    }

    /// Reads one line of pip's output, `elapsed` seconds after pip started.
    fn push(&mut self, line: &str, elapsed: f64) -> PackBuilderProgress {
        let trimmed = line.trim();

        if trimmed.starts_with("Downloading ") || trimmed.starts_with("Using cached ") {
            let cached = trimmed.starts_with("Using cached ");
            let keyword = if cached { "Using cached " } else { "Downloading " };
            // The previously announced file is finished the moment a new one starts.
            self.finish_current(elapsed);
            self.current_cached = cached;
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
            self.finish_current(elapsed);
            self.install_count = trimmed
                .split_once(':')
                .map(|(_, list)| list.split(',').filter(|s| !s.trim().is_empty()).count())
                .unwrap_or(0);
            self.phase = "installing".to_string();
        } else if trimmed.starts_with("Successfully installed") {
            self.phase = "finalizing".to_string();
        }

        self.snapshot(trimmed, elapsed)
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
            let snap = p.push(line, 0.0);
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
        let first = p.push("Downloading torch-2.4.0.whl (100.0 MB)", 0.0);
        assert!(first.detail.starts_with("0 MB of"), "got {}", first.detail);

        // Announcing the next file means the first one landed.
        let second = p.push("Downloading demucs-4.0.1.whl (50.0 MB)", 0.0);
        assert!(second.detail.starts_with("100 MB of"), "got {}", second.detail);
        assert_eq!(second.headline, "Downloading voice separation");
    }

    #[test]
    fn oversized_installs_grow_the_estimate_instead_of_pinning_the_bar() {
        let mut p = PipProgressParser::new();
        // Announce well beyond the 2 GB guess.
        p.push("Downloading a-1.0.whl (3000.0 MB)", 0.0);
        let snap = p.push("Downloading b-1.0.whl (1000.0 MB)", 0.0);
        assert!(snap.detail.contains("of ~3.9 GB"), "estimate should grow: {}", snap.detail);
        assert!(snap.percent < 100.0);
    }

    const MB: f64 = 1024.0 * 1024.0;

    #[test]
    fn progress_carries_the_bytes_behind_the_detail() {
        let mut p = PipProgressParser::new();
        let start = p.push("Collecting torch", 0.0);
        assert_eq!(start.done_bytes, 0.0);
        assert_eq!(start.total_bytes, PACKBUILDER_EXPECTED_BYTES);

        p.push("Downloading a-1.0.whl (100.0 MB)", 1.0);
        let snap = p.push("Downloading b-1.0.whl (3000.0 MB)", 2.0);
        assert_eq!(snap.done_bytes, 100.0 * MB);
        assert_eq!(snap.total_bytes, 3100.0 * MB);
    }

    #[test]
    fn time_left_waits_for_20_seconds_and_two_finished_files() {
        let mut p = PipProgressParser::new();
        assert_eq!(p.push("Downloading a-1.0.whl (100.0 MB)", 0.0).eta_secs, None);
        // One finished file: not enough, however long it took.
        assert_eq!(p.push("Downloading b-1.0.whl (100.0 MB)", 30.0).eta_secs, None);
        // Two finished files, past 20 s: about 3.3 MB/s with 1848 MB to go.
        let snap = p.push("Downloading c-1.0.whl (100.0 MB)", 60.0);
        let eta = snap.eta_secs.expect("stable by now");
        assert!((500..=620).contains(&eta), "got {eta}");

        // Two finished files, but under 20 s.
        let mut quick = PipProgressParser::new();
        quick.push("Downloading a-1.0.whl (100.0 MB)", 0.0);
        quick.push("Downloading b-1.0.whl (100.0 MB)", 5.0);
        assert_eq!(quick.push("Downloading c-1.0.whl (100.0 MB)", 10.0).eta_secs, None);
    }

    #[test]
    fn cached_files_do_not_count_as_download_speed() {
        let mut p = PipProgressParser::new();
        p.push("Using cached torch-2.4.0.whl (800.0 MB)", 1.0);
        // The cached file "finished" instantly; only the next one is a real sample.
        p.push("Downloading a-1.0.whl (100.0 MB)", 1.5);
        let snap = p.push("Downloading b-1.0.whl (100.0 MB)", 30.0);
        assert_eq!(snap.done_bytes, 900.0 * MB, "cached bytes still count as done");
        assert_eq!(snap.eta_secs, None, "one real download is not a stable speed");
    }

    #[test]
    fn no_time_left_once_the_download_is_over() {
        let mut p = PipProgressParser::new();
        p.push("Downloading a-1.0.whl (100.0 MB)", 0.0);
        p.push("Downloading b-1.0.whl (100.0 MB)", 30.0);
        p.push("Downloading c-1.0.whl (100.0 MB)", 60.0);
        let snap = p.push("Installing collected packages: a, b, c", 90.0);
        assert_eq!(snap.eta_secs, None);
        // The finishing step no longer claims a restart: the studio offers it.
        let done = p.push("Successfully installed a b c", 120.0);
        assert!(!done.detail.contains("Restarting"), "{}", done.detail);
    }
}

#[cfg(test)]
mod packbuilder_install_state_tests {
    use super::*;

    fn progress(percent: f64) -> PackBuilderProgress {
        let mut p = PipProgressParser::new();
        let mut snap = p.push("Collecting torch", 0.0);
        snap.percent = percent;
        snap
    }

    #[test]
    fn an_install_runs_then_finishes() {
        let mut install = PackBuilderInstall::IDLE;
        assert_eq!(install.state, InstallState::Idle);
        assert!(install.begin());
        assert_eq!(install.state, InstallState::Running);
        install.report(progress(40.0));
        assert_eq!(install.progress.as_ref().map(|p| p.percent), Some(40.0));
        install.finish(Ok(()));
        assert_eq!(install.state, InstallState::Done);
        assert_eq!(install.error, None);
    }

    #[test]
    fn a_failed_install_keeps_its_error_and_can_start_again() {
        let mut install = PackBuilderInstall::IDLE;
        assert!(install.begin());
        install.finish(Err("No internet".to_string()));
        assert_eq!(install.state, InstallState::Failed);
        assert_eq!(install.error.as_deref(), Some("No internet"));

        // Try again starts clean.
        assert!(install.begin());
        assert_eq!(install.state, InstallState::Running);
        assert_eq!(install.error, None);
        assert_eq!(install.progress, None);
    }

    #[test]
    fn starting_while_running_changes_nothing() {
        let mut install = PackBuilderInstall::IDLE;
        assert!(install.begin());
        install.report(progress(55.0));
        let before = install.clone();
        assert!(!install.begin());
        assert_eq!(install, before);
    }

    #[test]
    fn progress_after_the_end_is_ignored() {
        let mut install = PackBuilderInstall::IDLE;
        install.report(progress(10.0));
        assert_eq!(install.progress, None, "nothing is running");
        assert!(install.begin());
        install.finish(Ok(()));
        install.report(progress(99.0));
        assert_eq!(install.progress, None);
    }

    #[test]
    fn removing_pack_builder_forgets_a_finished_install() {
        let mut install = PackBuilderInstall::IDLE;
        assert!(install.begin());
        install.finish(Ok(()));
        install.forget();
        assert_eq!(install, PackBuilderInstall::IDLE);

        // A running install is left alone.
        assert!(install.begin());
        install.forget();
        assert_eq!(install.state, InstallState::Running);
    }

    #[test]
    fn the_studio_reads_the_state_in_lowercase() {
        let mut install = PackBuilderInstall::IDLE;
        let idle = serde_json::to_value(&install).unwrap();
        assert_eq!(idle["state"], "idle");
        assert!(idle["progress"].is_null());
        assert!(idle["error"].is_null());
        install.begin();
        install.report(progress(12.0));
        let running = serde_json::to_value(&install).unwrap();
        assert_eq!(running["state"], "running");
        assert_eq!(running["progress"]["percent"], 12.0);
        assert!(running["progress"]["done_bytes"].is_number());
        assert!(running["progress"]["total_bytes"].is_number());
        assert!(running["progress"]["eta_secs"].is_null());
        install.finish(Err("x".to_string()));
        assert_eq!(serde_json::to_value(&install).unwrap()["state"], "failed");
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
    let started = std::time::Instant::now();

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let parser = parser.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(mut p) = parser.lock() {
                    publish(&app, p.push(&line, started.elapsed().as_secs_f64()));
                }
            }
        });
    }

    let mut errors: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut p) = parser.lock() {
                publish(app, p.push(&line, started.elapsed().as_secs_f64()));
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

/// Keeps the latest progress for `get_packbuilder_install` and sends it to the launcher.
fn publish(app: &tauri::AppHandle, progress: PackBuilderProgress) {
    install_state().report(progress.clone());
    let _ = app.emit("packbuilder-progress", progress);
}

/// What the install needs, checked before anything is downloaded: a writable install
/// folder, the requirements file and the bundled Python.
fn prepare_install(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    // Requirements ship beside app.py (resources), but the packages install at the
    // install root so they land on the drive the user chose.
    let app_dir = get_app_install_dir(app);
    let root = install_root_dir(app);
    crate::updater::ensure_writable(&root)?;

    let requirements = app_dir.join("requirements_builder.txt");
    if !requirements.is_file() {
        return Err(format!(
            "requirements_builder.txt was not found in {}. Apply the core update first.",
            app_dir.display()
        ));
    }

    let py = find_python_exe(app)
        .ok_or_else(|| "Bundled Python runtime not found; cannot install the AI pipeline.".to_string())?;
    Ok((py, requirements, root.join(AI_PACKAGES_DIR)))
}

/// Starts the Pack Builder download in the background and returns at once, so the
/// studio can open while it runs. Calling it while an install runs does nothing.
///
/// The engine keeps running: it only picks Pack Builder up when it next starts, which
/// the studio offers ("Restart to finish Pack Builder") once the state is `done`.
#[tauri::command]
pub async fn start_packbuilder_install(app: tauri::AppHandle) -> Result<(), String> {
    if !install_state().begin() {
        return Ok(());
    }
    let (py, requirements, target) = match prepare_install(&app) {
        Ok(found) => found,
        Err(e) => {
            install_state().finish(Err(e.clone()));
            return Err(e);
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let result = run_pip_install(&py, &requirements, &target, &app);
        if let Err(e) = &result {
            eprintln!("[PackBuilder] Install failed: {}", e);
        }
        install_state().finish(result);
    });
    Ok(())
}

/// Where the background install is: `{ state, progress, error }`.
#[tauri::command]
pub fn get_packbuilder_install() -> PackBuilderInstall {
    install_state().clone()
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
    if removed.is_ok() {
        // A finished install no longer waits for a restart.
        install_state().forget();
    }

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
