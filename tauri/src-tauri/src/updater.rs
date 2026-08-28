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

pub async fn check_for_update(current_version: &str) -> UpdateCheckResult {
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

    if latest_clean == current_clean {
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
