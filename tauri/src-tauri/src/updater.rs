use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::Emitter;

#[derive(Deserialize, Clone, Debug)]
pub struct GithubRelease {
    pub tag_name: String,
    pub body: Option<String>,
    pub assets: Vec<GithubAsset>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct GithubAsset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", content = "data")]
pub enum UpdateCheckResult {
    UpToDate,
    UpdateAvailable {
        current_version: String,
        latest_version: String,
        /// The release notes. Kept for older launchers; the current one doesn't show them.
        changelog: String,
        download_url: String,
        /// No app.py yet: this download is DubMate itself, not an update.
        first_download: bool,
    },
    NoInternet {
        message: String,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct UpdateProgressPayload {
    pub received: u64,
    pub total: u64,
    pub percentage: u8,
    /// Seconds left, once the download speed has settled.
    pub eta_secs: Option<u64>,
}

/// How much each new speed reading moves the smoothed speed.
const ETA_SMOOTHING: f64 = 0.3;

/// Time left for a download, from a smoothed speed. It says nothing (None) until enough
/// time and samples have passed for the speed to mean something, so the launcher never
/// shows a wild first guess.
pub(crate) struct EtaEstimator {
    min_secs: f64,
    min_samples: u32,
    samples: u32,
    /// Seconds and bytes at the last sample.
    last: (f64, f64),
    /// Bytes per second, smoothed.
    speed: Option<f64>,
}

impl EtaEstimator {
    pub(crate) fn new(min_secs: f64, min_samples: u32) -> Self {
        Self { min_secs, min_samples, samples: 0, last: (0.0, 0.0), speed: None }
    }

    /// Records that `done` bytes had arrived `elapsed` seconds after the start. Only
    /// progress counts as a sample.
    pub(crate) fn sample(&mut self, elapsed: f64, done: f64) {
        let (then, before) = self.last;
        if elapsed <= then || done <= before {
            return;
        }
        let speed = (done - before) / (elapsed - then);
        self.speed = Some(match self.speed {
            Some(smoothed) => smoothed + ETA_SMOOTHING * (speed - smoothed),
            None => speed,
        });
        self.samples += 1;
        self.last = (elapsed, done);
    }

    /// Seconds to fetch `remaining` more bytes, or None while the speed isn't stable yet.
    pub(crate) fn eta_secs(&self, elapsed: f64, remaining: f64) -> Option<u64> {
        if elapsed < self.min_secs || self.samples < self.min_samples {
            return None;
        }
        let speed = self.speed.filter(|s| *s > 0.0)?;
        Some((remaining.max(0.0) / speed).round() as u64)
    }
}

/// Set by "Skip this time" on the update card; `download_bundle` checks it per chunk.
static UPDATE_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What `apply_update` returns when the download was skipped.
pub const UPDATE_SKIPPED: &str = "skipped";

/// Stops the update download in progress. It has no effect once the download is done:
/// the launcher hides Skip when installing starts.
#[tauri::command]
pub fn cancel_update() {
    UPDATE_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn clear_update_cancel() {
    UPDATE_CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
}

fn update_cancelled() -> bool {
    UPDATE_CANCEL.load(std::sync::atomic::Ordering::SeqCst)
}

/// A step of applying the update that has no byte count (event `update-stage`). The
/// launcher shows it on the update card in place of the download figures.
#[derive(Serialize, Clone, Debug)]
pub struct UpdateStagePayload {
    pub headline: String,
    pub detail: String,
}

/// Shown when the packages a new version needs could not be installed. The old
/// version's files are kept, so DubMate still opens as before and retries next time.
pub const DEPENDENCY_INSTALL_FAILED: &str =
    "DubMate couldn't download the parts this update needs. Check your internet connection.";

/// Upper bound for installing a new version's packages. pip gives up on an unreachable
/// server long before this; it only catches an install that hangs.
const DEPENDENCY_INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// True when `candidate` is a strictly newer semantic version than `current`.
/// Non-numeric noise is ignored and missing components are treated as zero, so
/// "1.3" compares as 1.3.0 and "v1.0.8" as 1.0.8.
fn is_newer(candidate: &str, current: &str) -> bool {
    fn parse(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|s| s.parse::<u64>().ok())
            .chain(std::iter::repeat(0))
            .take(3)
            .collect()
    }
    parse(candidate) > parse(current)
}

/// Host that release assets must come from.
const RELEASE_ASSET_HOST: &str = "github.com";
/// Path prefix that a legitimate release asset URL must start with.
const RELEASE_ASSET_PREFIX: &str = "/sylenthsnares/DubMate/releases/download/";

/// True when `url` genuinely points at a release asset for this project.
///
/// `apply_update` is a Tauri command taking an arbitrary string, and the window
/// navigates to the local studio UI, so any script injection there could otherwise
/// point the updater at an attacker-hosted zip which is then extracted over the
/// install directory and executed on next launch. Comparison is on the parsed host,
/// not a substring, so "github.com.evil.test" and "evil.test/?x=github.com" both fail.
pub fn is_trusted_update_url(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(r) => r,
        None => return false, // plaintext http is never acceptable here
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return false,
    };
    // Reject embedded credentials (https://github.com@evil.test/...).
    if authority.contains('@') {
        return false;
    }
    let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();
    if host != RELEASE_ASSET_HOST && !host.ends_with(&format!(".{}", RELEASE_ASSET_HOST)) {
        return false;
    }
    let path_lower = path.to_ascii_lowercase();
    if path_lower.contains("..") {
        return false;
    }
    path_lower.starts_with(&RELEASE_ASSET_PREFIX.to_ascii_lowercase())
}

/// Creates `dir` if needed and checks a file can be written in it; the error is the
/// system's reason.
pub fn probe_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let probe = dir.join(".dubmate-write-test");
    std::fs::File::create(&probe).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Verifies the directory is actually writable before any file is replaced.
/// A per-machine install under Program Files fails here with an actionable message
/// instead of blowing up midway through extraction.
pub fn ensure_writable(dir: &Path) -> Result<(), String> {
    probe_writable(dir).map_err(|e| {
        format!(
            "DubMate cannot write to its installation folder:
{}

{}

Reinstall DubMate somewhere your account can write to, or run it as administrator.",
            dir.display(),
            e
        )
    })
}

pub async fn check_for_update(current_version: &str, app: &tauri::AppHandle) -> UpdateCheckResult {
    let client = match reqwest::Client::builder()
        .user_agent("DubMate-Studio-Desktop/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return UpdateCheckResult::NoInternet {
                message: format!("HTTP client configuration error: {}", e),
            };
        }
    };

    let url = "https://api.github.com/repos/sylenthsnares/DubMate/releases/latest";
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            return UpdateCheckResult::NoInternet {
                message: format!("Network request failed: {}", e),
            };
        }
    };

    if !resp.status().is_success() {
        return UpdateCheckResult::NoInternet {
            message: format!("GitHub release API returned status {}", resp.status()),
        };
    }

    let release: GithubRelease = match resp.json().await {
        Ok(rel) => rel,
        Err(e) => {
            return UpdateCheckResult::NoInternet {
                message: format!("Failed to parse release metadata: {}", e),
            };
        }
    };

    let latest_clean = release.tag_name.trim().trim_start_matches('v');
    let current_clean = current_version.trim().trim_start_matches('v');
    let app_py_exists = crate::paths::find_app_py(app).is_some();

    // Only move forward. String equality alone would happily "update" the user onto an
    // older tag if the release feed ever pointed at one.
    if app_py_exists && !is_newer(latest_clean, current_clean) {
        return UpdateCheckResult::UpToDate;
    }

    // Find the app-bundle-v*.zip asset
    let bundle_asset = release
        .assets
        .iter()
        .find(|a| a.name.starts_with("app-bundle") && a.name.ends_with(".zip"));

    match bundle_asset {
        Some(asset) => UpdateCheckResult::UpdateAvailable {
            current_version: current_clean.to_string(),
            latest_version: latest_clean.to_string(),
            changelog: release.body.unwrap_or_else(|| "General improvements and fixes.".to_string()),
            download_url: asset.browser_download_url.clone(),
            first_download: !app_py_exists,
        },
        None => UpdateCheckResult::UpToDate,
    }
}

/// Downloads the app bundle zip into memory, reporting progress as `update-progress`.
/// Returns `Err(UPDATE_SKIPPED)` when `cancel_update` stops it.
pub async fn download_bundle(download_url: &str, app_handle: tauri::AppHandle) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent("DubMate-Studio-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    // Zero means the server sent no content-length; the launcher then shows an
    // indeterminate bar with just the downloaded size.
    let total_size = response.content_length().unwrap_or(0);
    // Cap the up-front reservation so a bogus header cannot force a huge allocation.
    let mut bytes: Vec<u8> = Vec::with_capacity(total_size.min(256 * 1024 * 1024) as usize);
    let mut stream = response.bytes_stream();
    let mut last_percent: u8 = 0;
    let mut last_emit = std::time::Instant::now();
    let started = std::time::Instant::now();
    let mut eta = EtaEstimator::new(10.0, 3);

    while let Some(chunk) = stream.next().await {
        if update_cancelled() {
            println!("[Updater] Download skipped.");
            return Err(UPDATE_SKIPPED.to_string());
        }
        let chunk = chunk.map_err(|e| format!("Error reading update stream: {}", e))?;
        bytes.extend_from_slice(&chunk);

        let received = bytes.len() as u64;
        let percent = if total_size > 0 {
            ((received.min(total_size) * 100) / total_size) as u8
        } else {
            0
        };
        // Throttle: at most one event per whole percent, or every 250 ms.
        if percent > last_percent || last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            last_percent = percent;
            last_emit = std::time::Instant::now();
            let elapsed = started.elapsed().as_secs_f64();
            eta.sample(elapsed, received as f64);
            let eta_secs = if total_size > 0 {
                eta.eta_secs(elapsed, total_size.saturating_sub(received) as f64)
            } else {
                None
            };
            let _ = app_handle.emit(
                "update-progress",
                UpdateProgressPayload {
                    received,
                    total: total_size,
                    percentage: percent,
                    eta_secs,
                },
            );
        }
    }

    let _ = app_handle.emit(
        "update-progress",
        UpdateProgressPayload {
            received: bytes.len() as u64,
            total: if total_size > 0 { total_size } else { bytes.len() as u64 },
            percentage: 100,
            eta_secs: None,
        },
    );

    Ok(bytes)
}

/// Writes every file of the bundle into `target_app_dir`, replacing what is there.
pub fn extract_bundle(bundle: &[u8], target_app_dir: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bundle))
        .map_err(|e| format!("Corrupt zip archive: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(path) => target_app_dir.join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// The text of one file at the top of the bundle, or None when the bundle has no such file.
pub fn bundle_file_text(bundle: &[u8], name: &str) -> Result<Option<String>, String> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bundle))
        .map_err(|e| format!("Corrupt zip archive: {}", e))?;
    let mut file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("Could not read {} from the update: {}", name, e)),
    };
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("Could not read {} from the update: {}", name, e))?;
    Ok(Some(text))
}

/// A requirements file reduced to what pip acts on: one entry per requirement, with
/// comments, blank lines, spacing, letter case and order ignored.
fn normalized_requirements(text: &str) -> Vec<String> {
    let mut entries: Vec<String> = text
        .lines()
        .map(|line| {
            // pip reads "#" as a comment at the start of a line or after whitespace.
            let cut = line
                .char_indices()
                .find(|&(i, c)| c == '#' && (i == 0 || line[..i].ends_with(char::is_whitespace)))
                .map(|(i, _)| i)
                .unwrap_or(line.len());
            line[..cut]
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase()
        })
        .filter(|entry| !entry.is_empty())
        .collect();
    entries.sort();
    entries.dedup();
    entries
}

/// True when the bundle's requirements differ from the installed ones (or none are
/// installed), so the runtime needs a pip install before the new files go live.
pub fn requirements_changed(installed: Option<&str>, bundled: &str) -> bool {
    match installed {
        Some(installed) => normalized_requirements(installed) != normalized_requirements(bundled),
        None => true,
    }
}

/// The bundle's requirements when they differ from the ones beside app.py in `app_dir`,
/// i.e. when the runtime needs packages before the new files go live.
pub fn requirements_to_install(bundle: &[u8], app_dir: &Path) -> Result<Option<String>, String> {
    let Some(bundled) = bundle_file_text(bundle, "requirements.txt")? else {
        return Ok(None);
    };
    let installed = std::fs::read_to_string(app_dir.join("requirements.txt")).ok();
    Ok(requirements_changed(installed.as_deref(), &bundled).then_some(bundled))
}

/// True for the Python that ships inside DubMate (`.../python-runtime/...`). Only that
/// one is ever given packages: a developer's venv or a system Python found as a fallback
/// is left alone.
pub fn is_bundled_runtime(python: &Path) -> bool {
    python
        .components()
        .any(|part| part.as_os_str().to_string_lossy().eq_ignore_ascii_case("python-runtime"))
}

/// The bundled runtime's python, when there is one to install packages into.
pub fn bundled_python(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::paths::find_python_exe(app).filter(|py| is_bundled_runtime(py))
}

/// pip's arguments for installing `requirements` into the runtime's own site-packages,
/// the folder the installer filled: `Lib\site-packages` beside the Windows embedded
/// python.exe (listed in its `._pth`), `lib/python3.x/site-packages` on macOS. No
/// `--target`, so pip keeps every package that already satisfies its line and downloads
/// only what is new or changed. `-I` and `--isolated` keep PYTHONPATH (the Pack Builder
/// add-on), the user's site-packages and the user's pip settings out of it.
pub fn dependency_install_args(requirements: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        "--no-warn-script-location",
        "--prefer-binary",
        "-r",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(requirements.as_os_str().to_os_string());
    args
}

/// Installs a new version's requirements into the bundled runtime. Stop the engine
/// first: Windows won't replace a library a running engine has loaded. On failure the
/// error starts with the plain message, with pip's last lines after "Details:".
pub fn install_bundle_requirements(python: &Path, requirements_text: &str) -> Result<(), String> {
    let fail = |detail: String| format!("{}\n\nDetails: {}", DEPENDENCY_INSTALL_FAILED, detail);

    let scratch = std::env::temp_dir().join(format!("dubmate-update-{}", std::process::id()));
    std::fs::create_dir_all(&scratch)
        .map_err(|e| fail(format!("cannot create {}: {}", scratch.display(), e)))?;
    let requirements = scratch.join("requirements.txt");
    let result = std::fs::write(&requirements, requirements_text)
        .map_err(|e| fail(format!("cannot write {}: {}", requirements.display(), e)))
        .and_then(|_| run_pip(python, &requirements, &scratch).map_err(fail));
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

fn run_pip(python: &Path, requirements: &Path, cwd: &Path) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Read};
    use std::sync::{Arc, Mutex};

    let mut cmd = std::process::Command::new(python);
    cmd.args(dependency_install_args(requirements))
        // Not the app folder: the Windows runtime's ._pth puts its parent on sys.path.
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::sidecars::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {}", python.display(), e))?;

    // Both pipes drain on their own threads so a chatty pip never blocks on a full pipe.
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let streams: [Option<Box<dyn Read + Send>>; 2] = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ];
    let readers: Vec<_> = streams
        .into_iter()
        .flatten()
        .map(|stream| {
            let tail = tail.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    println!("[Updater] pip: {}", line);
                    if let Ok(mut t) = tail.lock() {
                        t.push_back(line);
                        if t.len() > 12 {
                            t.pop_front();
                        }
                    }
                }
            })
        })
        .collect();

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() > DEPENDENCY_INSTALL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "pip took longer than {} minutes",
                    DEPENDENCY_INSTALL_TIMEOUT.as_secs() / 60
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(e) => {
                let _ = child.kill();
                break Err(e.to_string());
            }
        }
    };
    for reader in readers {
        let _ = reader.join();
    }
    let tail = tail
        .lock()
        .map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("pip exited with {}\n{}", status.code().unwrap_or(-1), tail)),
        Err(e) => Err(format!("{}\n{}", e, tail)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_genuine_release_assets() {
        assert!(is_trusted_update_url(
            "https://github.com/sylenthsnares/DubMate/releases/download/v1.0.9/app-bundle-v1.0.9.zip"
        ));
        // GitHub redirects assets to objects.githubusercontent.com; the host check
        // allows subdomains of github.com only, so document the exact accepted shape.
        assert!(is_trusted_update_url(
            "https://GITHUB.COM/sylenthsnares/DubMate/releases/download/v1.0.9/x.zip"
        ));
    }

    #[test]
    fn rejects_untrusted_hosts() {
        for bad in [
            "https://evil.test/sylenthsnares/DubMate/releases/download/v1/x.zip",
            "https://github.com.evil.test/sylenthsnares/DubMate/releases/download/v1/x.zip",
            "https://evil.test/?x=github.com/sylenthsnares/DubMate/releases/download/v1/x.zip",
            "https://github.com@evil.test/sylenthsnares/DubMate/releases/download/v1/x.zip",
            "http://github.com/sylenthsnares/DubMate/releases/download/v1/x.zip",
            "file:///C:/evil.zip",
            "",
        ] {
            assert!(!is_trusted_update_url(bad), "should have rejected {bad}");
        }
    }

    #[test]
    fn rejects_wrong_repo_or_path() {
        for bad in [
            "https://github.com/attacker/DubMate/releases/download/v1/x.zip",
            "https://github.com/sylenthsnares/DubMate/archive/refs/heads/main.zip",
            "https://github.com/sylenthsnares/DubMate/releases/download/../../evil.zip",
        ] {
            assert!(!is_trusted_update_url(bad), "should have rejected {bad}");
        }
    }

    #[test]
    fn is_newer_moves_forward_only() {
        assert!(is_newer("1.0.9", "1.0.8"));
        assert!(!is_newer("1.0.8", "1.0.9")); // never downgrade
        assert!(!is_newer("1.0.9", "1.0.9"));
        assert!(is_newer("v1.3", "1.0.8"));
        assert!(!is_newer("garbage", "1.0.8"));
    }

    #[test]
    fn requirements_change_only_when_what_pip_installs_changes() {
        let installed = "fastapi>=0.100.0\nnumpy>=1.24.0\nhttpx>=0.24.0\n";
        // Same requirements, reordered, re-spaced, re-cased and commented: nothing to install.
        assert!(!requirements_changed(
            Some(installed),
            "# core\r\nNumPy >= 1.24.0  # audio\r\n\r\nhttpx>=0.24.0\r\nfastapi>=0.100.0\r\n"
        ));
        // A new package or a moved pin needs pip.
        assert!(requirements_changed(Some(installed), &format!("{installed}pedalboard==0.9.24\n")));
        assert!(requirements_changed(Some(installed), "fastapi>=0.100.0\nnumpy>=2.0\nhttpx>=0.24.0\n"));
        // A dropped package changes the file too (pip leaves it installed, which is harmless).
        assert!(requirements_changed(Some(installed), "fastapi>=0.100.0\nnumpy>=1.24.0\n"));
        // Nothing installed beside app.py yet (the first download): always install.
        assert!(requirements_changed(None, installed));
        // A "#" inside a URL is not a comment.
        assert!(requirements_changed(
            Some("pkg @ https://x.test/a.whl#sha256=aa\n"),
            "pkg @ https://x.test/a.whl#sha256=bb\n"
        ));
    }

    #[test]
    fn only_the_runtime_shipped_with_dubmate_gets_packages() {
        assert!(is_bundled_runtime(Path::new(
            "C:/Users/a/AppData/Local/DubMate/resources/python-runtime/python.exe"
        )));
        assert!(is_bundled_runtime(Path::new(
            "/Applications/DubMate.app/Contents/Resources/python-runtime/bin/python3"
        )));
        assert!(!is_bundled_runtime(Path::new("C:/repo/.venv/Scripts/python.exe")));
        assert!(!is_bundled_runtime(Path::new("/usr/bin/python3")));
        assert!(!is_bundled_runtime(Path::new("/home/a/python-runtime-notes/python3")));
    }

    #[test]
    fn pip_installs_into_the_runtime_itself_and_ignores_outside_settings() {
        let args: Vec<String> = dependency_install_args(Path::new("req.txt"))
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(&args[..3], ["-I", "-m", "pip"]);
        assert!(args.iter().any(|a| a == "--isolated"));
        // Same site-packages the installer filled; nothing already satisfied is replaced.
        assert!(!args.iter().any(|a| a == "--target" || a == "--user" || a == "--upgrade"));
        assert_eq!(&args[args.len() - 2..], ["-r", "req.txt"]);
    }

    const MB: f64 = 1024.0 * 1024.0;

    #[test]
    fn no_time_left_until_the_speed_has_settled() {
        // The update download: at least 10 s and 3 samples.
        let mut eta = EtaEstimator::new(10.0, 3);
        assert_eq!(eta.eta_secs(0.0, 100.0 * MB), None);
        eta.sample(4.0, 4.0 * MB);
        eta.sample(8.0, 8.0 * MB);
        eta.sample(9.0, 9.0 * MB);
        // Three samples, but under 10 s.
        assert_eq!(eta.eta_secs(9.0, 91.0 * MB), None);
        // Past 10 s with enough samples: 1 MB/s.
        eta.sample(11.0, 11.0 * MB);
        assert_eq!(eta.eta_secs(11.0, 89.0 * MB), Some(89));

        // Two samples are never enough, however long it has run.
        let mut slow = EtaEstimator::new(10.0, 3);
        slow.sample(30.0, 30.0 * MB);
        slow.sample(60.0, 60.0 * MB);
        assert_eq!(slow.eta_secs(60.0, 40.0 * MB), None);
    }

    #[test]
    fn a_steady_speed_gives_a_steady_estimate() {
        let mut eta = EtaEstimator::new(10.0, 3);
        for second in 1..=20 {
            eta.sample(second as f64, second as f64 * 2.0 * MB);
        }
        // 2 MB/s with 60 MB to go.
        assert_eq!(eta.eta_secs(20.0, 60.0 * MB), Some(30));
    }

    #[test]
    fn a_sudden_burst_moves_the_estimate_only_part_way() {
        let mut eta = EtaEstimator::new(0.0, 1);
        for second in 1..=10 {
            eta.sample(second as f64, second as f64 * MB);
        }
        assert_eq!(eta.eta_secs(10.0, 100.0 * MB), Some(100));
        // One second at 10 MB/s: smoothed, not taken at face value.
        eta.sample(11.0, 20.0 * MB);
        let after = eta.eta_secs(11.0, 100.0 * MB).unwrap();
        assert!(after > 10 && after < 100, "got {after}");
    }

    #[test]
    fn samples_without_progress_do_not_count() {
        let mut eta = EtaEstimator::new(0.0, 2);
        eta.sample(5.0, 5.0 * MB);
        // Same bytes later on: no new sample, and the speed isn't dragged to zero.
        eta.sample(9.0, 5.0 * MB);
        assert_eq!(eta.eta_secs(9.0, 10.0 * MB), None);
        eta.sample(10.0, 10.0 * MB);
        assert!(eta.eta_secs(10.0, 10.0 * MB).is_some());
        // Nothing left is zero seconds, not None.
        assert_eq!(eta.eta_secs(10.0, 0.0), Some(0));
    }

    #[test]
    fn the_launcher_learns_whether_this_is_the_first_download() {
        let update = UpdateCheckResult::UpdateAvailable {
            current_version: "1.1.3".to_string(),
            latest_version: "1.1.4".to_string(),
            changelog: "Fixes".to_string(),
            download_url: "https://github.com/x.zip".to_string(),
            first_download: true,
        };
        let value = serde_json::to_value(&update).unwrap();
        assert_eq!(value["status"], "UpdateAvailable");
        assert_eq!(value["data"]["first_download"], true);
        assert_eq!(value["data"]["latest_version"], "1.1.4");
        assert_eq!(value["data"]["changelog"], "Fixes");

        let progress = serde_json::to_value(UpdateProgressPayload {
            received: 1,
            total: 2,
            percentage: 50,
            eta_secs: None,
        })
        .unwrap();
        assert!(progress["eta_secs"].is_null());
    }

    #[test]
    fn skipping_is_cleared_when_an_update_starts() {
        cancel_update();
        assert!(update_cancelled());
        clear_update_cancel();
        assert!(!update_cancelled());
    }

    /// A small bundle zip holding the given files.
    fn bundle_with(files: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, text) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn installs_only_when_the_bundle_brings_new_requirements() {
        let dir = std::env::temp_dir().join(format!("dubmate-updater-reqs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("requirements.txt"), "numpy>=1.24.0\n").unwrap();

        let same = bundle_with(&[("app.py", ""), ("requirements.txt", "numpy>=1.24.0\r\n")]);
        assert_eq!(requirements_to_install(&same, &dir).unwrap(), None);

        let newer = bundle_with(&[("requirements.txt", "numpy>=1.24.0\npedalboard==0.9.24\n")]);
        assert_eq!(
            requirements_to_install(&newer, &dir).unwrap().as_deref(),
            Some("numpy>=1.24.0\npedalboard==0.9.24\n")
        );
        // A bundle without the file has nothing to install.
        assert_eq!(requirements_to_install(&bundle_with(&[("app.py", "")]), &dir).unwrap(), None);

        // Reading the bundle writes nothing: the old files stay until extract_bundle.
        assert_eq!(std::fs::read_to_string(dir.join("requirements.txt")).unwrap(), "numpy>=1.24.0\n");
        extract_bundle(&newer, &dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("requirements.txt")).unwrap(),
            "numpy>=1.24.0\npedalboard==0.9.24\n"
        );
        // Once the new files are in, the same bundle needs no second install.
        assert_eq!(requirements_to_install(&newer, &dir).unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_install_reports_the_plain_message_first() {
        let missing = std::env::temp_dir().join("dubmate-no-such-python").join("python-runtime").join("python.exe");
        let err = install_bundle_requirements(&missing, "numpy>=1.24.0\n").unwrap_err();
        assert!(err.starts_with(DEPENDENCY_INSTALL_FAILED), "{err}");
        assert!(err.contains("\n\nDetails: "), "{err}");
    }
}
