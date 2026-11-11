mod portal;
mod share;

use tauri::ipc::CapabilityBuilder;
use tauri::plugin::Builder as PluginBuilder;
use std::sync::Mutex;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime, TitleBarStyle, Url, Webview, WebviewUrl, Window, WindowEvent};

/// Wide enough to hold the window's three controls (8 to 70 points) in its middle.
const RAIL_WIDTH: f64 = 78.0;

/// The Server on screen. None on the app's own pages, which have no rail.
#[derive(Default)]
struct ActiveServer(Mutex<Option<String>>);

/// Grants the injected bridge's permissions to one Server's origin. Only the
/// bundled Server list and the rail may call this; other pages get no native access.
#[tauri::command]
fn allow_server(webview: Webview, origin: String) -> Result<(), String> {
    let current = webview.url().map_err(|error| error.to_string())?;
    if current.scheme() != "tauri" {
        return Err("Only the Server list can allow a Server".into());
    }
    allow_origin(&webview, &origin)
}

fn allow_origin(webview: &Webview, origin: &str) -> Result<(), String> {
    let url = Url::parse(origin).map_err(|error| error.to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("L4 servers must use HTTPS".into());
    }
    let origin = url.origin().ascii_serialization();
    webview
        .app_handle()
        .add_capability(
            CapabilityBuilder::new(format!("server-{origin}"))
                .remote(format!("{origin}/*"))
                .window("main")
                .permission("core:default")
                .permission("core:window:allow-start-dragging")
                .permission("core:window:allow-set-badge-count")
                .permission("notification:default")
                .permission("opener:default")
                .permission("allow-server-needing-key")
                .permission("allow-save-recording-key")
                // Ask to share a window of this Mac: the app checks the link and asks the person (ADR 0014).
                .permission("allow-portal-share"),
        )
        .map_err(|error| error.to_string())
}

fn server_origin(url: &Url) -> Option<String> {
    matches!(url.scheme(), "https" | "http").then(|| url.origin().ascii_serialization())
}

/// Only the rail may use these: it is the app's own page, in its own webview.
fn from_rail<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    (webview.label() == "rail").then_some(()).ok_or_else(|| "Only the Server rail can do this".to_string())
}

#[tauri::command]
fn rail_open(webview: Webview, origin: String) -> Result<(), String> {
    from_rail(&webview)?;
    allow_origin(&webview, &origin)?;
    let url = Url::parse(&origin).map_err(|error| error.to_string())?;
    let page = webview.app_handle().get_webview("main").ok_or("No page")?;
    page.navigate(url).map_err(|error| error.to_string())
}

#[tauri::command]
fn rail_list(webview: Webview) -> Result<(), String> {
    from_rail(&webview)?;
    let page = webview.app_handle().get_webview("main").ok_or("No page")?;
    let list = Url::parse("tauri://localhost/index.html#servers").map_err(|error| error.to_string())?;
    page.navigate(list).map_err(|error| error.to_string())
}

#[tauri::command]
fn rail_active(webview: Webview) -> Result<Option<String>, String> {
    from_rail(&webview)?;
    let active = webview.state::<ActiveServer>();
    let origin = active.0.lock().map_err(|error| error.to_string())?.clone();
    Ok(origin)
}

/// The rail takes the left of the window on a Server's page, and the page has all of it elsewhere.
fn lay_out<R: Runtime>(window: &Window<R>) {
    let (Some(page), Some(rail)) = (window.get_webview("main"), window.get_webview("rail")) else { return };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let show = window.state::<ActiveServer>().0.lock().map(|active| active.is_some()).unwrap_or(false);
    let left = if show { (RAIL_WIDTH * scale).round() as u32 } else { 0 };
    let _ = page.set_position(PhysicalPosition::new(left as i32, 0));
    let _ = page.set_size(PhysicalSize::new(size.width.saturating_sub(left), size.height));
    let _ = rail.set_position(PhysicalPosition::new(0, 0));
    let _ = rail.set_size(PhysicalSize::new(left.max(1), size.height));
    let _ = if show { rail.show() } else { rail.hide() };
}

fn page_changed<R: Runtime>(page: &Webview<R>, url: &Url) {
    let origin = server_origin(url);
    let state = page.state::<ActiveServer>();
    {
        let Ok(mut active) = state.0.lock() else { return };
        if *active == origin { return }
        active.clone_from(&origin);
    }
    let Some(window) = page.app_handle().get_window("main") else { return };
    if let Some(rail) = window.get_webview("rail") {
        let value = serde_json::to_string(&origin).unwrap_or_else(|_| "null".into());
        let _ = rail.eval(format!("window.__L4_RAIL__?.setActive({value})"));
    }
    lay_out(&window);
}

fn open_window(app: &tauri::App) -> tauri::Result<()> {
    let window = WindowBuilder::new(app, "main")
        .title("L4")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .resizable(true)
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .build()?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    let page = WebviewBuilder::new("main", WebviewUrl::App("index.html".into()))
        .on_page_load(|page, payload| {
            if matches!(payload.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
                page_changed(&page, payload.url());
            }
        });
    let rail = WebviewBuilder::new("rail", WebviewUrl::App("rail.html".into()));
    window.add_child(page, LogicalPosition::new(0.0, 0.0), size)?;
    window.add_child(rail, LogicalPosition::new(0.0, 0.0), LogicalSize::new(RAIL_WIDTH, size.height))?;
    lay_out(&window);
    let handle = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
            lay_out(&handle);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            PluginBuilder::<tauri::Wry>::new("server-bridge")
                .js_init_script(include_str!("../../www/native-bridge.js").to_string())
                .build(),
        )
        .manage(share::SharedFile::default())
        .manage(ActiveServer::default())
        .setup(|app| Ok(open_window(app)?))
        .invoke_handler(tauri::generate_handler![
            allow_server,
            rail_open,
            rail_list,
            rail_active,
            share::sync_servers,
            share::server_needing_key,
            share::save_recording_key,
            share::pending_page,
            share::pending_share,
            share::shared_file_bytes,
            share::cancel_share,
            share::recording_limits,
            share::transcribe,
            share::send_marked,
            portal::portal_share,
        ])
        .build(tauri::generate_context!())
        .expect("error while building L4")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                share::receive(app, urls);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
