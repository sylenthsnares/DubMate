//! Opening the only two places outside DubMate it sends someone: the system's
//! microphone privacy page and the studio in the default browser. The targets are fixed,
//! so no page can make the app open an arbitrary address or program.

use crate::sidecars::DEFAULT_ENGINE_PORT;
use crate::state::SharedState;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ExternalTarget {
    /// The system page that lets apps use the microphone.
    MicSettings,
    /// The studio served by the engine on this port.
    Studio(u16),
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
}
