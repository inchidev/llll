fn main() {
    // Listed so each is allowed explicitly: the Server list in capabilities/default.json, a Server's page in `allow_server`.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "allow_server",
        "rail_open",
        "rail_list",
        "rail_active",
        "sync_servers",
        "server_needing_key",
        "save_recording_key",
        "pending_page",
        "pending_share",
        "shared_file_bytes",
        "cancel_share",
        "recording_limits",
        "transcribe",
        "send_marked",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("error while running tauri-build");
}
