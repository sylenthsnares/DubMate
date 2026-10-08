//! Opening the only places outside DubMate it sends someone: the system's microphone
//! privacy page, the studio in the default browser, the download page for the DubMate
//! installer, and About's fixed DubMate pages (source code, licence, third-party notices,
//! privacy, security). The targets are fixed, so no page can make the app open an
//! arbitrary address or program: the studio sends a page's name, never a URL.

use crate::sidecars::DEFAULT_ENGINE_PORT;
use crate::state::SharedState;

/// Where the DubMate installers are published.
const DOWNLOAD_PAGE_URL: &str = "https://github.com/sylenthsnares/DubMate/releases/latest";

const SOURCE_URL: &str = "https://github.com/sylenthsnares/DubMate";
const LICENCE_URL: &str = "https://github.com/sylenthsnares/DubMate/blob/main/LICENSE";
const NOTICES_URL: &str = "https://github.com/sylenthsnares/DubMate/blob/main/THIRD_PARTY_NOTICES.md";
const PRIVACY_URL: &str = "https://github.com/sylenthsnares/DubMate/blob/main/PRIVACY.md";
const SECURITY_URL: &str = "https://github.com/sylenthsnares/DubMate/blob/main/SECURITY.md";

/// The DubMate pages About links to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum DubMatePage {
    Source,
    Licence,
    Notices,
    Privacy,
    Security,
}

impl DubMatePage {
    /// The page the studio names, or None for any other name.
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "source" => Some(Self::Source),
            "licence" => Some(Self::Licence),
            "notices" => Some(Self::Notices),
            "privacy" => Some(Self::Privacy),
            "security" => Some(Self::Security),
            _ => None,
        }
    }

    fn url(self) -> &'static str {
        match self {
            Self::Source => SOURCE_URL,
            Self::Licence => LICENCE_URL,
            Self::Notices => NOTICES_URL,
            Self::Privacy => PRIVACY_URL,
            Self::Security => SECURITY_URL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ExternalTarget {
    /// The system page that lets apps use the microphone.
    MicSettings,
    /// The studio served by the engine on this port.
    Studio(u16),
    /// The releases page with the DubMate installers.
    DownloadPage,
    /// One of About's DubMate pages.
    Page(DubMatePage),
}

/// The program and arguments that open `target` on `os` (`std::env::consts::OS`).
pub(crate) fn external_command(
    target: ExternalTarget,
    os: &str,
) -> Result<(&'static str, Vec<String>), String> {
    match (target, os) {
        (ExternalTarget::MicSettings, "windows") => {
            Ok(("explorer.exe", vec!["ms-settings:privacy-microphone".to_string()]))
        }
        (ExternalTarget::MicSettings, "macos") => Ok((
            "open",
            vec!["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone".to_string()],
        )),
        (ExternalTarget::Studio(port), "windows") => Ok((
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_string(), studio_url(port)],
        )),
        (ExternalTarget::Studio(port), "macos") => Ok(("open", vec![studio_url(port)])),
        (ExternalTarget::DownloadPage, "windows") => Ok((
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_string(), DOWNLOAD_PAGE_URL.to_string()],
        )),
        (ExternalTarget::DownloadPage, "macos") => Ok(("open", vec![DOWNLOAD_PAGE_URL.to_string()])),
        (ExternalTarget::Page(page), "windows") => Ok((
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_string(), page.url().to_string()],
        )),
        (ExternalTarget::Page(page), "macos") => Ok(("open", vec![page.url().to_string()])),
        _ => Err(format!("Opening this isn't supported on {}.", os)),
    }
}

fn studio_url(port: u16) -> String {
    format!("http://127.0.0.1:{}/", port)
}

fn open(target: ExternalTarget) -> Result<(), String> {
    let (program, args) = external_command(target, std::env::consts::OS)?;
    let mut child = std::process::Command::new(program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", program, e))?;
    // These hand off to the system and exit; wait so nothing is left behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Opens the system's microphone privacy settings (Windows and macOS).
#[tauri::command]
pub fn open_mic_settings() -> Result<(), String> {
    open(ExternalTarget::MicSettings)
}

/// Opens the studio in the default browser, on the port the engine is using.
#[tauri::command]
pub fn open_studio_in_browser(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let port = state.0.lock().unwrap().engine_port.unwrap_or(DEFAULT_ENGINE_PORT);
    open(ExternalTarget::Studio(port))
}

/// Opens the download page for the DubMate installer in the default browser.
#[tauri::command]
pub fn open_download_page() -> Result<(), String> {
    open(ExternalTarget::DownloadPage)
}

/// The target for a page name from the studio; anything but the five names is refused.
fn page_target(page: &str) -> Result<ExternalTarget, String> {
    DubMatePage::from_name(page)
        .map(ExternalTarget::Page)
        .ok_or_else(|| "That isn't a DubMate page.".to_string())
}

/// Opens one of About's DubMate pages ("source", "licence", "notices", "privacy" or
/// "security") in the default browser.
#[tauri::command]
pub fn open_dubmate_page(page: String) -> Result<(), String> {
    open(page_target(&page)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mic_page_on_windows_and_macos() {
        assert_eq!(
            external_command(ExternalTarget::MicSettings, "windows").unwrap(),
            ("explorer.exe", vec!["ms-settings:privacy-microphone".to_string()])
        );
        assert_eq!(
            external_command(ExternalTarget::MicSettings, "macos").unwrap(),
            (
                "open",
                vec!["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone".to_string()]
            )
        );
        assert!(external_command(ExternalTarget::MicSettings, "linux").is_err());
    }

    #[test]
    fn the_studio_on_the_engine_port_in_the_default_browser() {
        assert_eq!(
            external_command(ExternalTarget::Studio(8003), "windows").unwrap(),
            (
                "rundll32",
                vec!["url.dll,FileProtocolHandler".to_string(), "http://127.0.0.1:8003/".to_string()]
            )
        );
        assert_eq!(
            external_command(ExternalTarget::Studio(8000), "macos").unwrap(),
            ("open", vec!["http://127.0.0.1:8000/".to_string()])
        );
        assert!(external_command(ExternalTarget::Studio(8000), "linux").is_err());
    }

    #[test]
    fn the_download_page_in_the_default_browser() {
        let url = "https://github.com/sylenthsnares/DubMate/releases/latest".to_string();
        assert_eq!(
            external_command(ExternalTarget::DownloadPage, "windows").unwrap(),
            ("rundll32", vec!["url.dll,FileProtocolHandler".to_string(), url.clone()])
        );
        assert_eq!(
            external_command(ExternalTarget::DownloadPage, "macos").unwrap(),
            ("open", vec![url])
        );
        assert!(external_command(ExternalTarget::DownloadPage, "linux").is_err());
    }

    #[test]
    fn each_dubmate_page_in_the_default_browser() {
        let pages = [
            ("source", "https://github.com/sylenthsnares/DubMate"),
            ("licence", "https://github.com/sylenthsnares/DubMate/blob/main/LICENSE"),
            ("notices", "https://github.com/sylenthsnares/DubMate/blob/main/THIRD_PARTY_NOTICES.md"),
            ("privacy", "https://github.com/sylenthsnares/DubMate/blob/main/PRIVACY.md"),
            ("security", "https://github.com/sylenthsnares/DubMate/blob/main/SECURITY.md"),
        ];
        for (name, url) in pages {
            let target = page_target(name).unwrap();
            assert_eq!(
                external_command(target, "windows").unwrap(),
                ("rundll32", vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()]),
                "{}",
                name
            );
            assert_eq!(
                external_command(target, "macos").unwrap(),
                ("open", vec![url.to_string()]),
                "{}",
                name
            );
            assert!(external_command(target, "linux").is_err(), "{}", name);
        }
    }

    #[test]
    fn any_other_page_name_is_refused() {
        for name in ["", "Source", "https://example.com", "download", "../LICENSE", "licence "] {
            assert!(page_target(name).is_err(), "{:?}", name);
        }
        assert!(open_dubmate_page("https://example.com".to_string()).is_err());
    }
}
