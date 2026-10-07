//! Microphone permission for the main window.
//!
//! A member who joins a room moves to the host's tunnel origin, and WebView2
//! asks for the microphone again on every new origin. In the desktop app we
//! allow the microphone, and only the microphone, for DubMate's own origins:
//! the local engine and the room tunnels. Everything else keeps WebView2's
//! own prompt. macOS needs nothing here: wry already grants media capture.

/// Domains whose https subdomains serve rooms.
/// Keep in sync with ALLOWED_TUNNEL_URL_DOMAINS in worker/src/index.ts.
#[cfg_attr(not(windows), allow(dead_code))]
const TUNNEL_DOMAINS: [&str; 2] = ["trycloudflare.com", "bkaproductions.com"];

/// True when a microphone request from `uri` can be allowed without asking:
/// `http://127.0.0.1[:port]`, `http://localhost[:port]`, or an `https://` host
/// equal to a tunnel domain or ending in `.` plus one.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn auto_grant_origin(uri: &str) -> bool {
    let Some((scheme, rest)) = uri.split_once("://") else {
        return false;
    };
    let authority_end = rest
        .find(['/', '?', '#', '\\'])
        .unwrap_or(rest.len());
    let authority = rest[..authority_end].to_ascii_lowercase();
    // No userinfo ("https://trycloudflare.com@evil.com").
    if authority.contains('@') {
        return false;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority.as_str(), None),
    };
    if let Some(p) = port {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    if host.is_empty()
        || host.starts_with('.')
        || host.contains("..")
        || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return false;
    }
    match scheme.to_ascii_lowercase().as_str() {
        "http" => host == "127.0.0.1" || host == "localhost",
        "https" => TUNNEL_DOMAINS.iter().any(|d| {
            host == *d || (host.len() > d.len() + 1 && host.ends_with(&format!(".{d}")))
        }),
        _ => false,
    }
}

/// Allows microphone requests from DubMate's own origins in this webview.
/// Any other request is left untouched so WebView2 shows its own prompt.
#[cfg(windows)]
pub fn install(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    unsafe {
        let webview = controller.CoreWebView2()?;
        let mut token: i64 = 0;
        webview.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    return Ok(());
                }
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if auto_grant_origin(&uri) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::auto_grant_origin;

    #[test]
    fn grants_the_local_engine() {
        assert!(auto_grant_origin("http://127.0.0.1"));
        assert!(auto_grant_origin("http://127.0.0.1:8000"));
        assert!(auto_grant_origin("http://127.0.0.1:8000/"));
        assert!(auto_grant_origin("http://127.0.0.1:8000/studio?room=abc"));
        assert!(auto_grant_origin("http://localhost"));
        assert!(auto_grant_origin("http://localhost:5173/"));
        assert!(auto_grant_origin("HTTP://LocalHost:8000/"));
    }

    #[test]
    fn grants_room_tunnels_over_https() {
        assert!(auto_grant_origin("https://trycloudflare.com/"));
        assert!(auto_grant_origin("https://quiet-river-1234.trycloudflare.com"));
        assert!(auto_grant_origin("https://quiet-river-1234.trycloudflare.com/?room=x"));
        assert!(auto_grant_origin("https://bkaproductions.com"));
        assert!(auto_grant_origin("https://room.bkaproductions.com:443/"));
        assert!(auto_grant_origin("https://a.b.bkaproductions.com/x"));
    }

    #[test]
    fn refuses_plain_http_tunnels_and_https_local() {
        assert!(!auto_grant_origin("http://quiet-river-1234.trycloudflare.com/"));
        assert!(!auto_grant_origin("http://bkaproductions.com/"));
        assert!(!auto_grant_origin("https://127.0.0.1:8000/"));
        assert!(!auto_grant_origin("https://localhost/"));
    }

    #[test]
    fn refuses_lookalike_hosts() {
        assert!(!auto_grant_origin("https://eviltrycloudflare.com/"));
        assert!(!auto_grant_origin("https://evilbkaproductions.com/"));
        assert!(!auto_grant_origin("https://trycloudflare.com.evil.com/"));
        assert!(!auto_grant_origin("https://.trycloudflare.com/"));
        assert!(!auto_grant_origin("https://a..trycloudflare.com/"));
        assert!(!auto_grant_origin("http://127.0.0.1.evil.com/"));
        assert!(!auto_grant_origin("http://localhost.evil.com:8000/"));
        assert!(!auto_grant_origin("https://evil.com/trycloudflare.com"));
        assert!(!auto_grant_origin("https://evil.com\\.trycloudflare.com/"));
        assert!(!auto_grant_origin("https://evil.com?x=.trycloudflare.com"));
    }

    #[test]
    fn refuses_userinfo_tricks() {
        assert!(!auto_grant_origin("https://trycloudflare.com@evil.com/"));
        assert!(!auto_grant_origin("https://user:pw@room.trycloudflare.com/"));
        assert!(!auto_grant_origin("http://127.0.0.1@evil.com/"));
        assert!(!auto_grant_origin("http://localhost:8000@evil.com/"));
    }

    #[test]
    fn refuses_other_schemes_and_junk() {
        assert!(!auto_grant_origin("tauri://localhost"));
        assert!(!auto_grant_origin("file:///C:/x.html"));
        assert!(!auto_grant_origin("wss://room.trycloudflare.com/"));
        assert!(!auto_grant_origin("javascript:alert(1)"));
        assert!(!auto_grant_origin(""));
        assert!(!auto_grant_origin("127.0.0.1:8000"));
        assert!(!auto_grant_origin("http://"));
        assert!(!auto_grant_origin("http://localhost:/"));
        assert!(!auto_grant_origin("http://localhost:80a/"));
    }
}
