//! A screenshot or recording handed to the app, from the Dock, Open With or the
//! Share menu, opens the app's own marking page, and then becomes a Task on a
//! Server through that Server's device key. Each page reaches only its own origin's entry.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State, Url, Webview};
use tauri_plugin_notification::NotificationExt;

const SHARE_EXTENSION_ID: &str = "gg.llll.desktop.share";
const MAX_FILE_BYTES: u64 = 1 << 30;
/// A UUID and the dash after it.
const UUID_PREFIX: usize = 37;

#[derive(Default)]
pub struct SharedFile(Mutex<Option<Received>>);

struct Received {
    path: PathBuf,
    /// Our own copy from the Share menu; a file from the Dock stays where it is.
    remove_after: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Server {
    id: String,
    origin: String,
    name: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Saved {
    servers: Vec<Server>,
    keys: BTreeMap<String, String>,
    last_origin: Option<String>,
}

fn saved_path(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    Ok(folder.join("share.json"))
}

fn read_saved(app: &AppHandle) -> Saved {
    saved_path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_saved(app: &AppHandle, saved: &Saved) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let path = saved_path(app)?;
    let bytes = serde_json::to_vec(saved).map_err(|error| error.to_string())?;
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

fn is_bundled_list(webview: &Webview) -> bool {
    webview.url().map(|url| url.scheme() == "tauri").unwrap_or(false)
}

fn page_origin(webview: &Webview) -> Result<String, String> {
    Ok(webview.url().map_err(|error| error.to_string())?.origin().ascii_serialization())
}

#[tauri::command]
pub fn sync_servers(app: AppHandle, webview: Webview, servers: Vec<Server>) -> Result<(), String> {
    if !is_bundled_list(&webview) {
        return Err("Only the Server list can do this".into());
    }
    let mut saved = read_saved(&app);
    saved.keys.retain(|origin, _| servers.iter().any(|server| &server.origin == origin));
    saved.servers = servers;
    write_saved(&app, &saved)
}

#[tauri::command]
pub fn server_needing_key(app: AppHandle, webview: Webview) -> Result<Option<String>, String> {
    let origin = page_origin(&webview)?;
    let saved = read_saved(&app);
    if saved.keys.contains_key(&origin) {
        return Ok(None);
    }
    Ok(saved.servers.iter().find(|server| server.origin == origin).map(|server| server.id.clone()))
}

#[tauri::command]
pub fn save_recording_key(app: AppHandle, webview: Webview, token: String) -> Result<(), String> {
    let origin = page_origin(&webview)?;
    let mut saved = read_saved(&app);
    if !saved.servers.iter().any(|server| server.origin == origin) {
        return Err("This page isn't a Server on this device".into());
    }
    saved.keys.insert(origin, token);
    write_saved(&app, &saved)?;
    // A file was waiting for this key, so the marking page can offer this Server.
    let waiting = app.state::<SharedFile>().0.lock().map_err(|error| error.to_string())?.is_some();
    if waiting {
        show_marking_page(&app);
    }
    Ok(())
}

fn display_name(file: &Received) -> String {
    let name = file.path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "recording".into());
    // The Share extension's copies start with a UUID so they can't collide.
    if file.remove_after && name.len() > UUID_PREFIX {
        return name[UUID_PREFIX..].to_string();
    }
    name
}

fn require_list(webview: &Webview) -> Result<(), String> {
    if is_bundled_list(webview) { Ok(()) } else { Err("Only the app's own pages can do this".into()) }
}

/// The page the Server list should open first: the marking page while a file waits.
#[tauri::command]
pub fn pending_page(webview: Webview, shared: State<SharedFile>) -> Result<Option<String>, String> {
    require_list(&webview)?;
    Ok(shared.0.lock().map_err(|error| error.to_string())?.as_ref().map(|_| "mark.html".to_string()))
}

#[derive(Serialize)]
pub struct PendingShare {
    name: String,
    origin: Option<String>,
    servers: Vec<Server>,
}

#[tauri::command]
pub fn pending_share(app: AppHandle, webview: Webview, shared: State<SharedFile>) -> Result<Option<PendingShare>, String> {
    require_list(&webview)?;
    let pending = shared.0.lock().map_err(|error| error.to_string())?;
    let Some(file) = pending.as_ref() else { return Ok(None) };
    let saved = read_saved(&app);
    let servers = saved.servers.iter().filter(|server| saved.keys.contains_key(&server.origin)).cloned().collect();
    Ok(Some(PendingShare { name: display_name(file), origin: saved.last_origin, servers }))
}

#[tauri::command]
pub async fn shared_file_bytes(webview: Webview, app: AppHandle) -> Result<Response, String> {
    require_list(&webview)?;
    let path = {
        let shared = app.state::<SharedFile>();
        let pending = shared.0.lock().map_err(|error| error.to_string())?;
        pending.as_ref().ok_or("There is no file to send.")?.path.clone()
    };
    if fs::metadata(&path).map_err(|error| error.to_string())?.len() > MAX_FILE_BYTES {
        return Err("That file is too large.".into());
    }
    Ok(Response::new(read_file(path).await?))
}

#[tauri::command]
pub fn cancel_share(webview: Webview, shared: State<SharedFile>) -> Result<(), String> {
    require_list(&webview)?;
    if let Some(file) = shared.0.lock().map_err(|error| error.to_string())?.take() {
        if file.remove_after {
            let _ = fs::remove_file(file.path);
        }
    }
    Ok(())
}

fn keyed_url(app: &AppHandle, origin: &str, path: &str, query: &[(&str, &str)]) -> Result<Url, String> {
    let saved = read_saved(app);
    let token = saved.keys.get(origin).ok_or("Open this Server in L4 and sign in first.")?;
    let mut url = Url::parse(&format!("{origin}{path}")).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("key", token).extend_pairs(query);
    Ok(url)
}

/// A device-key answer as text, or the Server's own words for why not.
async fn answer_text(response: tauri_plugin_http::reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if status.is_success() {
        return Ok(body);
    }
    Err(serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|value| value["error"]["message"].as_str().map(str::to_string)).unwrap_or_else(|| "That did not work.".into()))
}

const NO_CONNECTION: &str = "Check your connection and try again.";

#[tauri::command]
pub async fn recording_limits(app: AppHandle, webview: Webview, origin: String) -> Result<String, String> {
    require_list(&webview)?;
    let url = keyed_url(&app, &origin, "/api/recordings/limits", &[])?;
    answer_text(tauri_plugin_http::reqwest::get(url).await.map_err(|_| NO_CONNECTION.to_string())?).await
}

#[tauri::command]
pub async fn transcribe(app: AppHandle, webview: Webview, origin: String, at: f64, wav: String) -> Result<String, String> {
    require_list(&webview)?;
    let audio = base64::engine::general_purpose::STANDARD.decode(wav).map_err(|error| error.to_string())?;
    let url = keyed_url(&app, &origin, "/api/recordings/voice", &[("at", &at.to_string())])?;
    let response = tauri_plugin_http::reqwest::Client::new().post(url).header("Content-Type", "audio/wav").body(audio).send().await.map_err(|_| NO_CONNECTION.to_string())?;
    answer_text(response).await
}

/// Takes the file and its marks and sends them in the background, so the page can move on at once.
#[tauri::command]
pub fn send_marked(app: AppHandle, webview: Webview, origin: String, content_type: String, body: String) -> Result<(), String> {
    require_list(&webview)?;
    let marks = base64::engine::general_purpose::STANDARD.decode(body).map_err(|error| error.to_string())?;
    keyed_url(&app, &origin, "/api/recordings", &[])?;
    let file = app.state::<SharedFile>().0.lock().map_err(|error| error.to_string())?.take().ok_or("There is no file to send.")?;
    let mut saved = read_saved(&app);
    saved.last_origin = Some(origin.clone());
    write_saved(&app, &saved)?;
    tauri::async_runtime::spawn(async move {
        let result = upload(&app, &origin, &file, marks, &content_type).await;
        if file.remove_after {
            let _ = fs::remove_file(&file.path);
        }
        if let Err(message) = result {
            let _ = app.notification().builder().title("Not sent").body(message).show();
        }
    });
    Ok(())
}

async fn upload(app: &AppHandle, origin: &str, file: &Received, marks: Vec<u8>, content_type: &str) -> Result<(), String> {
    let client = tauri_plugin_http::reqwest::Client::new();
    let bytes = read_file(file.path.clone()).await?;
    let url = keyed_url(app, origin, "/api/recordings", &[("name", &display_name(file))])?;
    let response = client.post(url).header("Content-Type", "application/octet-stream").body(bytes).send().await.map_err(|_| "The upload stopped. Check your connection and try again.".to_string())?;
    let answer = response.text().await.map_err(|error| error.to_string())?;
    // The answer is one address: the marking page, or a page saying why the file was refused.
    let address = Url::parse(answer.trim()).map_err(|_| "The Server didn't take this file.".to_string())?;
    if address.path() == "/recording-problem" {
        let why = address.query_pairs().find(|(key, _)| key == "why").map(|(_, why)| why.into_owned()).unwrap_or_default();
        if why == "unauthorized" {
            let mut saved = read_saved(app);
            saved.keys.remove(origin);
            write_saved(app, &saved)?;
            return Err("This device needs to connect to this Server again. Open the Server in L4, wait until it has loaded, then send the file again. There's nothing to copy or paste.".into());
        }
        return Err(if why == "too_large" { "That file is too large." } else { "The Server didn't take this file." }.into());
    }
    if !answer.trim().starts_with(&format!("{origin}/")) {
        return Err("This Server answered with another address.".into());
    }
    let task = address.path_segments().and_then(|mut segments| segments.next_back()).ok_or("The Server didn't take this file.")?.to_string();
    let url = keyed_url(app, origin, &format!("/api/recordings/{task}/marks"), &[])?;
    let response = client.post(url).header("Content-Type", content_type).body(marks).send().await;
    match response {
        Ok(response) if response.status().is_success() => Ok(()),
        _ => Err("The recording was sent, but not its marks. Open its Task to mark it.".into()),
    }
}

async fn read_file(path: PathBuf) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read(path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "Could not read this file.".to_string())
}

/// The Share extension is sandboxed and this app is not, so it reads the copy in the extension's
/// own container. Only a bare file name is accepted, so a link can't reach anywhere else.
fn extension_copy(app: &AppHandle, url: &Url) -> Option<PathBuf> {
    if url.scheme() != "llll" || url.host_str() != Some("share") {
        return None;
    }
    let name = url.query_pairs().find(|(key, _)| key == "file")?.1.into_owned();
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return None;
    }
    let path = app
        .path()
        .home_dir()
        .ok()?
        .join("Library/Containers")
        .join(SHARE_EXTENSION_ID)
        .join("Data/Library/Application Support/share")
        .join(name);
    path.is_file().then_some(path)
}

pub fn receive(app: &AppHandle, urls: Vec<Url>) {
    let received = urls.iter().find_map(|url| {
        if url.scheme() == "file" {
            return url.to_file_path().ok().map(|path| Received { path, remove_after: false });
        }
        extension_copy(app, url).map(|path| Received { path, remove_after: true })
    });
    let Some(received) = received else { return };
    if let Ok(mut pending) = app.state::<SharedFile>().0.lock() {
        *pending = Some(received);
    }
    show_marking_page(app);
}

fn show_marking_page(app: &AppHandle) {
    if let Some(window) = app.get_webview("main") {
        let _ = window.navigate(Url::parse("tauri://localhost/mark.html").expect("a valid address"));
        let _ = window.set_focus();
    }
}
