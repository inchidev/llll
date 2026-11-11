//! Portal (ADR 0014): a Server's page asks to share a window of this Mac. The page only asks. The app checks
//! that the Portal is on the page's own Server, asks the person in a dialog it draws itself, and hands the
//! `partyportal://` link to macOS, which opens PartyPortal; PartyPortal asks again which window. The link's keys
//! go nowhere else.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Url, Webview};

const SCHEME: &str = "partyportal";
const LONGEST_LINK: usize = 2048;
const NOT_INSTALLED: &str = "Install PartyPortal for Mac to share a window.";

/// One question at a time: a page cannot stack dialogs.
static ASKING: AtomicBool = AtomicBool::new(false);

/// What the app hands to macOS: rebuilt from the checked parts, so nothing unchecked rides along.
#[derive(Debug, PartialEq, Eq)]
pub struct PortalLink {
    pub portal: Url,
    host_key: String,
    guest_key: String,
}

impl PortalLink {
    pub fn link(&self) -> String {
        let query = url_encoded(&[("url", self.portal.as_str()), ("key", &self.host_key), ("t", &self.guest_key)]);
        format!("{SCHEME}://portal?{query}")
    }
}

fn url_encoded(pairs: &[(&str, &str)]) -> String {
    let mut base = Url::parse("x:").expect("a valid address");
    base.query_pairs_mut().extend_pairs(pairs);
    base.query().unwrap_or_default().to_string()
}

fn is_key(value: &str) -> bool {
    (16..=256).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// `/portal/<UUID>`, lowercase, as the Server makes it.
fn is_portal_path(path: &str) -> bool {
    let Some(id) = path.strip_prefix("/portal/") else { return false };
    id.len() == 36
        && id.char_indices().all(|(index, char)| match index {
            8 | 13 | 18 | 23 => char == '-',
            _ => char.is_ascii_digit() || ('a'..='f').contains(&char),
        })
}

fn is_server_address(url: &Url) -> bool {
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    url.scheme() == "https" || (url.scheme() == "http" && local)
}

/// Accepts only `partyportal://portal?url=…&key=…&t=…` whose Portal is on `page_origin`, the page asking.
pub fn check_link(link: &str, page_origin: &str) -> Result<PortalLink, String> {
    const NOT_A_PORTAL: &str = "This is not a Portal link.";
    if link.len() > LONGEST_LINK {
        return Err(NOT_A_PORTAL.into());
    }
    let page = Url::parse(page_origin).map_err(|_| "Only a Server's page can open a Portal.")?;
    if !is_server_address(&page) {
        return Err("Only a Server's page can open a Portal.".into());
    }
    let parsed = Url::parse(link).map_err(|_| NOT_A_PORTAL)?;
    let bare = parsed.username().is_empty() && parsed.password().is_none() && parsed.port().is_none() && parsed.fragment().is_none();
    if parsed.scheme() != SCHEME || parsed.host_str() != Some("portal") || !matches!(parsed.path(), "" | "/") || !bare {
        return Err(NOT_A_PORTAL.into());
    }
    let (mut portal, mut host_key, mut guest_key) = (None, None, None);
    for (name, value) in parsed.query_pairs() {
        let slot = match name.as_ref() {
            "url" => &mut portal,
            "key" => &mut host_key,
            "t" => &mut guest_key,
            _ => return Err(NOT_A_PORTAL.into()),
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(NOT_A_PORTAL.into());
        }
    }
    let (Some(portal), Some(host_key), Some(guest_key)) = (portal, host_key, guest_key) else {
        return Err(NOT_A_PORTAL.into());
    };
    if !is_key(&host_key) || !is_key(&guest_key) {
        return Err(NOT_A_PORTAL.into());
    }
    let portal = Url::parse(&portal).map_err(|_| NOT_A_PORTAL)?;
    let bare = portal.username().is_empty() && portal.password().is_none() && portal.query().is_none() && portal.fragment().is_none();
    if !is_server_address(&portal) || !bare || !is_portal_path(portal.path()) {
        return Err(NOT_A_PORTAL.into());
    }
    if portal.origin() != page.origin() {
        return Err("A Server can only open its own Portals.".into());
    }
    Ok(PortalLink { portal, host_key, guest_key })
}

/// The name this Mac knows the Server by, from the app's own Server list, with its address so no name can pass
/// for another Server.
fn server_label(name: Option<&str>, portal: &Url) -> String {
    let host = portal.host_str().unwrap_or_default();
    let host = match portal.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let name = name.map(|name| name.chars().filter(|char| !char.is_control()).take(60).collect::<String>());
    match name.as_deref().map(str::trim).filter(|name| !name.is_empty() && *name != host) {
        Some(name) => format!("{name} ({host})"),
        None => host,
    }
}

/// Asks the person, then opens PartyPortal with the link. `Ok(false)` when they said no.
#[tauri::command]
pub async fn portal_share(app: tauri::AppHandle, webview: Webview, link: String) -> Result<bool, String> {
    if webview.label() != "main" {
        return Err("Only a Server's page can open a Portal.".into());
    }
    let page = webview.url().map_err(|error| error.to_string())?;
    let checked = check_link(&link, &page.origin().ascii_serialization())?;
    if ASKING.swap(true, Ordering::SeqCst) {
        return Err("L4 is already asking about a Portal.".into());
    }
    let result = ask_and_open(&app, &checked).await;
    ASKING.store(false, Ordering::SeqCst);
    result
}

async fn ask_and_open(app: &tauri::AppHandle, checked: &PortalLink) -> Result<bool, String> {
    let origin = checked.portal.origin().ascii_serialization();
    let name = crate::share::server_name(app, &origin);
    let label = server_label(name.as_deref(), &checked.portal);
    let opener = mac::opener(app).ok_or(NOT_INSTALLED)?;
    if !mac::confirm(app, &label).await? {
        return Ok(false);
    }
    mac::open(&opener, &checked.link()).await?;
    Ok(true)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::{Path, PathBuf};

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
    use objc2_foundation::{NSArray, NSError, NSString, NSURL};
    use tauri::async_runtime::channel;

    /// PartyPortal built into this app, if the build carried one (`PARTYPORTAL_APP`).
    fn bundled() -> Option<PathBuf> {
        let contents = std::env::current_exe().ok()?.parent()?.parent()?.to_path_buf();
        let helper = contents.join("Helpers/PartyPortal.app");
        helper.join("Contents/Info.plist").is_file().then_some(helper)
    }

    /// The app that will open the link: our own copy first, else whatever macOS has for `partyportal://`.
    pub fn opener(_app: &tauri::AppHandle) -> Option<PathBuf> {
        if let Some(helper) = bundled() {
            return Some(helper);
        }
        let probe = NSURL::URLWithString(&NSString::from_str("partyportal://portal"))?;
        NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&probe)?.to_file_path()
    }

    /// The app's own alert: a Server's page cannot draw or answer it.
    pub async fn confirm(app: &tauri::AppHandle, server: &str) -> Result<bool, String> {
        let (answer, mut answered) = channel::<bool>(1);
        let message = format!("{server} wants you to share a window of this Mac through a Portal.");
        app.run_on_main_thread(move || {
            let Some(main) = MainThreadMarker::new() else { return };
            let alert = NSAlert::new(main);
            alert.setAlertStyle(NSAlertStyle::Informational);
            alert.setMessageText(&NSString::from_str(&message));
            alert.setInformativeText(&NSString::from_str("PartyPortal will ask which window."));
            // The first button answers Return; one titled Cancel answers Escape.
            alert.addButtonWithTitle(&NSString::from_str("Open PartyPortal"));
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            let _ = answer.try_send(alert.runModal() == NSAlertFirstButtonReturn);
        })
        .map_err(|error| error.to_string())?;
        answered.recv().await.ok_or_else(|| "L4 could not ask about the Portal.".to_string())
    }

    /// Hands the link to that app through Launch Services: the keys are in no command line.
    pub async fn open(app_path: &Path, link: &str) -> Result<(), String> {
        let (done, mut finished) = channel::<bool>(1);
        {
            let link = NSURL::URLWithString(&NSString::from_str(link)).ok_or("This is not a Portal link.")?;
            let app = NSURL::from_file_path(app_path).ok_or(super::NOT_INSTALLED)?;
            let handler = RcBlock::new(move |_: *mut NSRunningApplication, error: *mut NSError| {
                let _ = done.try_send(error.is_null());
            });
            let urls = NSArray::from_retained_slice(&[link]);
            NSWorkspace::sharedWorkspace().openURLs_withApplicationAtURL_configuration_completionHandler(&urls, &app, &NSWorkspaceOpenConfiguration::configuration(), Some(&handler));
        }
        match finished.recv().await {
            Some(true) => Ok(()),
            _ => Err("PartyPortal did not open. Install PartyPortal for Mac to share a window.".into()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use std::path::{Path, PathBuf};

    pub fn opener(_app: &tauri::AppHandle) -> Option<PathBuf> {
        None
    }
    pub async fn confirm(_app: &tauri::AppHandle, _server: &str) -> Result<bool, String> {
        Err(super::NOT_INSTALLED.into())
    }
    pub async fn open(_app: &Path, _link: &str) -> Result<(), String> {
        Err(super::NOT_INSTALLED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0194f3a2-7c1d-7e2f-8a3b-4c5d6e7f8091";
    const HOST_KEY: &str = "aB3_dE5-fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC";
    const GUEST_KEY: &str = "zY8_xW6-vU4tS2rQ0pO8nM6lK4jI2hG0fE8dC6bA4zY";

    fn link(portal: &str) -> String {
        format!("partyportal://portal?{}", url_encoded(&[("url", portal), ("key", HOST_KEY), ("t", GUEST_KEY)]))
    }

    #[test]
    fn accepts_a_portal_on_the_page_s_own_server() {
        let portal = format!("https://team.example.com/portal/{ID}");
        let checked = check_link(&link(&portal), "https://team.example.com").unwrap();
        assert_eq!(checked.portal.as_str(), portal);
        assert_eq!(checked.link(), link(&portal));
        assert!(check_link(&link(&format!("http://localhost:3000/portal/{ID}")), "http://localhost:3000").is_ok());
    }

    #[test]
    fn the_link_handed_to_macos_is_rebuilt_from_what_was_checked() {
        let portal = format!("https://team.example.com/portal/{ID}");
        let reordered = format!("partyportal://portal/?t={GUEST_KEY}&key={HOST_KEY}&url={}", url_encoded(&[("u", &portal)]).trim_start_matches("u="));
        assert_eq!(check_link(&reordered, "https://team.example.com").unwrap().link(), link(&portal));
    }

    #[test]
    fn rejects_a_portal_on_another_origin() {
        let error = "A Server can only open its own Portals.";
        for (portal, page) in [
            ("https://other.example.com", "https://team.example.com"),
            ("https://team.example.com:8443", "https://team.example.com"),
            ("http://localhost:3001", "http://localhost:3000"),
            ("https://example.com", "https://team.example.com"),
        ] {
            assert_eq!(check_link(&link(&format!("{portal}/portal/{ID}")), page).unwrap_err(), error, "{portal} from {page}");
        }
        // Plain HTTP away from this Mac is no Server address at all.
        assert!(check_link(&link(&format!("http://team.example.com/portal/{ID}")), "https://team.example.com").is_err());
        assert!(check_link(&link(&format!("http://team.example.com/portal/{ID}")), "http://team.example.com").is_err());
    }

    #[test]
    fn rejects_other_schemes() {
        let page = "https://team.example.com";
        let portal = format!("https://team.example.com/portal/{ID}");
        let query = url_encoded(&[("url", &portal), ("key", HOST_KEY), ("t", GUEST_KEY)]);
        for bad in [
            format!("javascript:alert(1)//?{query}"),
            "javascript://portal?url=x".to_string(),
            format!("https://team.example.com/portal?{query}"),
            format!("file:///Applications/PartyPortal.app?{query}"),
            format!("llll://portal?{query}"),
            format!("PartyPortal-x://portal?{query}"),
            format!("partyportal://share?{query}"),
            format!("partyportal://portal/extra?{query}"),
            format!("partyportal://user@portal?{query}"),
            format!("partyportal://portal:1?{query}"),
            format!("partyportal://portal?{query}#more"),
            "".to_string(),
            "not a link".to_string(),
        ] {
            assert!(check_link(&bad, page).is_err(), "{bad}");
        }
    }

    #[test]
    fn requires_each_parameter_once_and_nothing_else() {
        let page = "https://team.example.com";
        let portal = format!("https://team.example.com/portal/{ID}");
        for pairs in [
            vec![("key", HOST_KEY), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("key", HOST_KEY)],
            vec![("url", portal.as_str()), ("key", ""), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("key", "short"), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("key", "has space and more than sixteen"), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("key", HOST_KEY), ("t", GUEST_KEY), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("url", portal.as_str()), ("key", HOST_KEY), ("t", GUEST_KEY)],
            vec![("url", portal.as_str()), ("key", HOST_KEY), ("t", GUEST_KEY), ("control", "1")],
        ] {
            let bad = format!("partyportal://portal?{}", url_encoded(&pairs));
            assert!(check_link(&bad, page).is_err(), "{bad}");
        }
        assert!(check_link(&format!("partyportal://portal?url={portal}&key={HOST_KEY}&t={}", "x".repeat(LONGEST_LINK)), page).is_err());
    }

    #[test]
    fn the_portal_address_is_exactly_a_portal_page() {
        let page = "https://team.example.com";
        for portal in [
            "javascript:alert(1)".to_string(),
            "https://team.example.com/".to_string(),
            "https://team.example.com/api/portals".to_string(),
            format!("https://team.example.com/portal/{ID}/host"),
            format!("https://team.example.com/portal/{}", ID.to_uppercase()),
            format!("https://team.example.com/portal/{ID}?next=/settings"),
            format!("https://team.example.com/portal/{ID}#t=elsewhere"),
            format!("https://someone@team.example.com/portal/{ID}"),
            format!("https://team.example.com/x/../portal/{ID}/"),
        ] {
            assert!(check_link(&link(&portal), page).is_err(), "{portal}");
        }
    }

    #[test]
    fn only_a_server_page_can_ask() {
        let portal = format!("https://team.example.com/portal/{ID}");
        for page in ["tauri://localhost", "null", "file:///", "http://team.example.com"] {
            assert!(check_link(&link(&portal), page).is_err(), "{page}");
        }
    }

    #[test]
    fn names_the_server_with_its_address() {
        let portal = Url::parse(&format!("https://team.example.com/portal/{ID}")).unwrap();
        assert_eq!(server_label(Some("Acme"), &portal), "Acme (team.example.com)");
        assert_eq!(server_label(Some("  "), &portal), "team.example.com");
        assert_eq!(server_label(Some("team.example.com"), &portal), "team.example.com");
        assert_eq!(server_label(None, &portal), "team.example.com");
        assert_eq!(server_label(Some(&format!("A\nB{}", "x".repeat(100))), &portal), format!("AB{} (team.example.com)", "x".repeat(58)));
        let local = Url::parse(&format!("http://localhost:3000/portal/{ID}")).unwrap();
        assert_eq!(server_label(None, &local), "localhost:3000");
    }
}
