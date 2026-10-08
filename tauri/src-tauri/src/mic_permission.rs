//! Microphone permission for the main window.
//!
//! A member who joins a room moves to the host's tunnel origin, and WebView2
//! asks for the microphone again on every new origin. In the desktop app we
//! allow the microphone, and only the microphone, for DubMate's own origins:
//! the local engine, and the one room tunnel the member joined from the studio
//! (the studio calls `allow_room_origin` just before going there). Any other
//! tunnel page, and everything else, keeps WebView2's own prompt. macOS needs
//! nothing here: wry already grants media capture.

use std::sync::Mutex;

/// Domains whose https subdomains serve rooms.
/// Keep in sync with ALLOWED_TUNNEL_URL_DOMAINS in worker/src/index.ts.
const TUNNEL_DOMAINS: [&str; 2] = ["trycloudflare.com", "bkaproductions.com"];

/// The room tunnel the member last joined from the studio, as `https://host[:port]`.
static ROOM_ORIGIN: Mutex<Option<String>> = Mutex::new(None);

/// (scheme, host, port) of `uri`, lowercased, when it is well formed: no userinfo,
/// a numeric port if any, and a host of letters, digits, dots and dashes.
fn parse(uri: &str) -> Option<(String, String, Option<String>)> {
    let (scheme, rest) = uri.split_once("://")?;
    let authority_end = rest
        .find(['/', '?', '#', '\\'])
        .unwrap_or(rest.len());
    let authority = rest[..authority_end].to_ascii_lowercase();
    // No userinfo ("https://trycloudflare.com@evil.com").
    if authority.contains('@') {
        return None;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h.to_string(), Some(p.to_string())),
        None => (authority.clone(), None),
    };
    if let Some(p) = &port {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    if host.is_empty()
        || host.starts_with('.')
        || host.contains("..")
        || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host, port))
}

/// True for `http://127.0.0.1[:port]` and `http://localhost[:port]`.
fn is_loopback(uri: &str) -> bool {
    matches!(parse(uri), Some((scheme, host, _))
        if scheme == "http" && (host == "127.0.0.1" || host == "localhost"))
}

/// `https://host[:port]` (without the default port) when `uri` is an `https://` host
/// equal to a tunnel domain or ending in `.` plus one; None for anything else.
fn tunnel_origin(uri: &str) -> Option<String> {
    let (scheme, host, port) = parse(uri)?;
    if scheme != "https" {
        return None;
    }
    let is_tunnel = TUNNEL_DOMAINS
        .iter()
        .any(|d| host == *d || (host.len() > d.len() + 1 && host.ends_with(&format!(".{d}"))));
    if !is_tunnel {
        return None;
    }
    Some(match port.as_deref() {
        None | Some("443") => format!("https://{host}"),
        Some(p) => format!("https://{host}:{p}"),
    })
}

/// True when a microphone request from `uri` can be allowed without asking: the local
/// engine, or the page is on `room`, the tunnel origin the member joined from the studio.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn auto_grant_origin(uri: &str, room: Option<&str>) -> bool {
    if is_loopback(uri) {
        return true;
    }
    match (tunnel_origin(uri), room) {
        (Some(origin), Some(room)) => origin == room,
        _ => false,
    }
}

/// Called by the studio on the local engine just before it takes the member to a host's
/// room. Remembers that tunnel's origin so the microphone works there without a second
/// prompt. A URL that isn't a room tunnel is refused and forgets the previous room.
#[tauri::command]
pub fn allow_room_origin(url: String) -> bool {
    let origin = tunnel_origin(&url);
    let allowed = origin.is_some();
    if let Ok(mut room) = ROOM_ORIGIN.lock() {
        *room = origin;
    }
    allowed
}

#[cfg_attr(not(windows), allow(dead_code))]
fn current_room_origin() -> Option<String> {
    ROOM_ORIGIN.lock().ok().and_then(|room| room.clone())
}

/// Allows microphone requests from the local engine and the joined room in this webview.
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
                if auto_grant_origin(&uri, current_room_origin().as_deref()) {
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
    use super::{allow_room_origin, auto_grant_origin, current_room_origin, tunnel_origin};

    const ROOM: Option<&str> = Some("https://quiet-river-1234.trycloudflare.com");

    fn grant(uri: &str) -> bool {
        auto_grant_origin(uri, ROOM)
    }

    #[test]
    fn grants_the_local_engine() {
        for room in [None, ROOM] {
            assert!(auto_grant_origin("http://127.0.0.1", room));
            assert!(auto_grant_origin("http://127.0.0.1:8000", room));
            assert!(auto_grant_origin("http://127.0.0.1:8000/", room));
            assert!(auto_grant_origin("http://127.0.0.1:8000/studio?room=abc", room));
            assert!(auto_grant_origin("http://localhost", room));
            assert!(auto_grant_origin("http://localhost:5173/", room));
            assert!(auto_grant_origin("HTTP://LocalHost:8000/", room));
        }
    }

    #[test]
    fn grants_only_the_joined_room() {
        assert!(grant("https://quiet-river-1234.trycloudflare.com"));
        assert!(grant("https://quiet-river-1234.trycloudflare.com/?room=x"));
        assert!(grant("https://Quiet-River-1234.trycloudflare.com:443/x"));
        assert!(!grant("https://other-room-9.trycloudflare.com/"));
        assert!(!grant("https://trycloudflare.com/"));
        assert!(!grant("https://quiet-river-1234.trycloudflare.com:8443/"));
        assert!(!auto_grant_origin("https://quiet-river-1234.trycloudflare.com/", None));
        let named = Some("https://room.bkaproductions.com");
        assert!(auto_grant_origin("https://room.bkaproductions.com/", named));
        assert!(!auto_grant_origin("https://a.b.bkaproductions.com/x", named));
    }

    #[test]
    fn tunnel_origins() {
        assert_eq!(
            tunnel_origin("https://quiet-river-1234.trycloudflare.com/?room=AB12&home=x#dm=1").as_deref(),
            ROOM
        );
        assert_eq!(
            tunnel_origin("https://room.bkaproductions.com:443/").as_deref(),
            Some("https://room.bkaproductions.com")
        );
        assert_eq!(
            tunnel_origin("https://bkaproductions.com:8443").as_deref(),
            Some("https://bkaproductions.com:8443")
        );
        assert_eq!(tunnel_origin("http://quiet-river-1234.trycloudflare.com/"), None);
        assert_eq!(tunnel_origin("https://evil.com/"), None);
        assert_eq!(tunnel_origin("http://127.0.0.1:8000/"), None);
    }

    #[test]
    fn allow_room_origin_remembers_one_tunnel() {
        assert!(allow_room_origin("https://quiet-river-1234.trycloudflare.com/?room=AB12".into()));
        assert_eq!(current_room_origin().as_deref(), ROOM);
        assert!(!allow_room_origin("https://evil.com/".into()));
        assert_eq!(current_room_origin(), None);
    }

    #[test]
    fn refuses_plain_http_tunnels_and_https_local() {
        assert!(!grant("http://quiet-river-1234.trycloudflare.com/"));
        assert!(!grant("http://bkaproductions.com/"));
        assert!(!grant("https://127.0.0.1:8000/"));
        assert!(!grant("https://localhost/"));
    }

    #[test]
    fn refuses_lookalike_hosts() {
        for room in [ROOM, Some("https://trycloudflare.com"), Some("https://bkaproductions.com")] {
            assert!(!auto_grant_origin("https://eviltrycloudflare.com/", room));
            assert!(!auto_grant_origin("https://evilbkaproductions.com/", room));
            assert!(!auto_grant_origin("https://trycloudflare.com.evil.com/", room));
            assert!(!auto_grant_origin("https://.trycloudflare.com/", room));
            assert!(!auto_grant_origin("https://a..trycloudflare.com/", room));
            assert!(!auto_grant_origin("http://127.0.0.1.evil.com/", room));
            assert!(!auto_grant_origin("http://localhost.evil.com:8000/", room));
            assert!(!auto_grant_origin("https://evil.com/trycloudflare.com", room));
            assert!(!auto_grant_origin("https://evil.com\\.trycloudflare.com/", room));
            assert!(!auto_grant_origin("https://evil.com?x=.trycloudflare.com", room));
        }
    }

    #[test]
    fn refuses_userinfo_tricks() {
        assert!(!grant("https://quiet-river-1234.trycloudflare.com@evil.com/"));
        assert!(!grant("https://user:pw@quiet-river-1234.trycloudflare.com/"));
        assert!(!grant("http://127.0.0.1@evil.com/"));
        assert!(!grant("http://localhost:8000@evil.com/"));
    }

    #[test]
    fn refuses_other_schemes_and_junk() {
        assert!(!grant("tauri://localhost"));
        assert!(!grant("file:///C:/x.html"));
        assert!(!grant("wss://quiet-river-1234.trycloudflare.com/"));
        assert!(!grant("javascript:alert(1)"));
        assert!(!grant(""));
        assert!(!grant("127.0.0.1:8000"));
        assert!(!grant("http://"));
        assert!(!grant("http://localhost:/"));
        assert!(!grant("http://localhost:80a/"));
    }
}
