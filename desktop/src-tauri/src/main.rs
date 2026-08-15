// SOVRGNnet desktop client.
//
// The Rust side stays deliberately thin. It owns three things the web app
// cannot do for itself:
//
//   1. Registering the sovrgn:// scheme, so an invite link in a browser or a
//      chat message opens the app on the right server.
//   2. Storing per-server credentials in the OS keychain rather than in
//      browser storage — which matters now for session tokens, and matters far
//      more once the client holds Matrix encryption keys.
//   3. Being a persistent process, which voice and notifications will need.
//
// Everything about *which* servers you're connected to lives in TypeScript, in
// shared/connections.ts, shared with the web app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};

/// Service name under which per-server credentials are filed in the keychain.
const KEYRING_SERVICE: &str = "cc.sovrgnnet.desktop";

/// Store a credential for one server.
///
/// Keyed by the instance's stable id rather than its hostname: the same server
/// reached at a LAN address today and a domain tomorrow must not strand its
/// own session behind an address that changed.
#[tauri::command]
fn store_credential(instance_id: String, secret: String) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, &instance_id)
        .map_err(|e| e.to_string())?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_credential(instance_id: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYRING_SERVICE, &instance_id) {
        Ok(entry) => match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            // No entry is an ordinary state — you simply aren't signed in to
            // that server yet — not an error worth surfacing to the user.
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn forget_credential(instance_id: String) -> Result<(), String> {
    match keyring::Entry::new(KEYRING_SERVICE, &instance_id) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}

/// Hand a sovrgn:// URL to the frontend, which knows how to parse it.
///
/// Parsing lives in TypeScript (shared/invite.ts) so there is exactly one
/// implementation of the invite format, tested once, used by both clients.
fn forward_deep_link(app: &tauri::AppHandle, urls: Vec<String>) {
    for url in urls {
        if let Err(e) = app.emit("deep-link", url) {
            eprintln!("[sovrgnnet] couldn't forward deep link: {e}");
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch — usually someone clicking an invite while the
            // app is already open. Focus the existing window and pass the URL
            // along rather than starting a second copy.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            let links: Vec<String> = argv
                .into_iter()
                .filter(|arg| arg.starts_with("sovrgn://"))
                .collect();
            if !links.is_empty() {
                forward_deep_link(app, links);
            }
        }))
        .setup(|app| {
            // A cold start from an invite link: the URL arrives before the
            // frontend is listening, so it's replayed once the window is up.
            let handle = app.handle().clone();
            let startup: Vec<String> = std::env::args()
                .filter(|arg| arg.starts_with("sovrgn://"))
                .collect();
            if !startup.is_empty() {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    forward_deep_link(&handle, startup);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store_credential,
            read_credential,
            forget_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running SOVRGNnet");
}
