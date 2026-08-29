use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Emitter;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct GithubRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub assets: Vec<GithubAsset>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct GithubAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", content = "data")]
pub enum UpdateCheckResult {
    UpToDate,
    UpdateAvailable {
        current_version: String,
        latest_version: String,
        changelog: String,
        download_url: String,
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
}

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

/// Verifies the directory is actually writable before any file is replaced.
/// A per-machine install under Program Files fails here with an actionable message
/// instead of blowing up midway through extraction.
pub fn ensure_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Cannot create application directory {}: {}", dir.display(), e))?;

    let probe = dir.join(".dubmate-write-test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!(
            "DubMate cannot write to its installation folder:
{}

{}

Reinstall DubMate somewhere your account can write to, or run it as administrator.",
            dir.display(),
            e
        )),
    }
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
    let app_py_exists = crate::find_app_py(app).is_some();

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
            changelog: if !app_py_exists {
                "Initial Setup: Downloading DubMate core application bundle...".to_string()
            } else {
                release.body.unwrap_or_else(|| "General improvements and fixes.".to_string())
            },
            download_url: asset.browser_download_url.clone(),
        },
        None => UpdateCheckResult::UpToDate,
    }
}

pub async fn download_and_extract_bundle(
    download_url: &str,
    target_app_dir: &Path,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("DubMate-Studio-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    let total_size = response.content_length().unwrap_or(0);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Error reading update stream: {}", e))?;

    let _ = app_handle.emit(
        "update-progress",
        UpdateProgressPayload {
            received: bytes.len() as u64,
            total: if total_size > 0 { total_size } else { bytes.len() as u64 },
            percentage: 100,
        },
    );

    // Extract zip in memory
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Corrupt zip archive: {}", e))?;

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
}
