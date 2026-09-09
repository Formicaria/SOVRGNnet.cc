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

mod hosting;

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

/// Quit, on purpose, from a button.
///
/// `app.exit` fires `RunEvent::Exit`, which is where `stop_all` lives — the
/// same cleanup a window close gets. It exists as a command because the first
/// Linux walk had no deliberate way to say "quit": single-instance focus made
/// a stale build look freshly launched, and killing the shell with SIGTERM
/// skips the Exit handler entirely, leaving the hosted server as four orphans
/// holding the ports. A person asked to quit-and-relaunch needs a control
/// that provably does the first half.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Width of the shell's rail, and height of its title strip. The server's own
/// webview is inset by these so the frame stays visible around it.
const RAIL_WIDTH: f64 = 68.0;
const HEADER_HEIGHT: f64 = 34.0;

/// Show a server, creating its webview on first use.
///
/// One webview per server, kept alive and hidden rather than destroyed on
/// switch. That's deliberate: each origin keeps its own cookies, storage, and
/// scroll position, which is exactly what lets this hold several signed-in
/// servers at once where a single browser tab could not. It also makes
/// switching instant instead of a reload.
#[tauri::command]
async fn show_server(
    app: tauri::AppHandle,
    url: String,
    label: String,
) -> Result<(), String> {
    // Only ever load http(s). A deep link is untrusted input, and without this
    // a crafted one could point a webview at a local file.
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refusing to open a {} URL", parsed.scheme()));
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is missing".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_width = size.width as f64 / scale;
    let logical_height = size.height as f64 / scale;

    let position = tauri::LogicalPosition::new(RAIL_WIDTH, HEADER_HEIGHT);
    let extent = tauri::LogicalSize::new(
        (logical_width - RAIL_WIDTH).max(0.0),
        (logical_height - HEADER_HEIGHT).max(0.0),
    );

    // Hide whichever server was showing, so they don't stack.
    for webview in window.webviews() {
        if webview.label().starts_with("server-") && webview.label() != label {
            let _ = webview.hide();
        }
    }

    if let Some(existing) = window.get_webview(&label) {
        existing.set_position(position).map_err(|e| e.to_string())?;
        existing.set_size(extent).map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    window
        .add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
                .auto_resize(),
            position,
            extent,
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Forget a server's webview entirely, dropping its session with it.
/// Hide every server webview, without closing any of them.
///
/// A server is a *native child webview*, and a native webview always draws
/// above the parent's DOM — there is no z-index that reaches it. So any dialog
/// the frame renders (sign-in, the host panel, adding a server) appeared
/// underneath the instance: two interfaces visible at once, the frame's dialog
/// showing in whatever strip the instance did not cover.
///
/// Hiding rather than closing, because closing throws away the page's state:
/// scroll position, a half-typed message, the sync it had running. Opening a
/// dialog should not cost any of that.
///
/// `show_server` is what brings one back, which it already does by label.
#[tauri::command]
async fn hide_servers(window: tauri::Window) -> Result<(), String> {
    for webview in window.webviews() {
        if webview.label().starts_with("server-") {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
async fn close_server(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_window("main") {
        if let Some(webview) = window.get_webview(&label) {
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Open a URL in the user's own browser.
///
/// Release downloads and sign-in belong in the browser someone already trusts,
/// not in an app webview.
///
/// Done with the platform's own launcher rather than a Tauri plugin: it's three
/// well-known commands, it adds no dependency whose API can shift between
/// versions, and it needs no extra capability in the manifest.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // Untrusted input reaches here — a release URL, or a link out of a deep
    // link. Anything but http(s) is refused before it becomes a process
    // argument, so this can't be talked into launching a local file or a
    // handler for some other scheme.
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refusing to open a {} URL", parsed.scheme()));
    }
    let url = parsed.to_string();

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };

    // The empty string is the window title `start` expects first; without it
    // a quoted URL would be taken as the title and nothing would open.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };

    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// The running version, so the update check compares against something real.
///
/// Read at compile time from Cargo.toml, which the release train keeps in step
/// with every other version in the repository.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Did the installer — or a `--host-setup` launch — ask this run to open
/// the server setup?
///
/// An NSIS hook can only leave a file behind, so the file is the message:
/// `host-setup.requested` beside the executable, written when the person
/// said yes to "also set up a server" during install. The flag form exists
/// for Linux, where package installs never prompt by policy and a scripted
/// setup still needs a way to ask.
#[tauri::command]
fn host_setup_requested(app: tauri::AppHandle) -> bool {
    if std::env::args().any(|a| a == "--host-setup") {
        return true;
    }
    let marker = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("host-setup.requested")));
    let Some(marker) = marker else { return false };
    if !marker.exists() {
        return false;
    }
    // The tombstone outlives the marker on purpose: deleting a file beside
    // the executable can fail across a permissions boundary, and a question
    // that reopens on every launch forever is worse than a file that stays.
    let consumed = app
        .path()
        .app_data_dir()
        .map(|d| d.join("host-setup.consumed"))
        .ok();
    match consumed {
        Some(tombstone) => !tombstone.exists(),
        None => true,
    }
}

/// The answer was shown; never ask again. Best-effort on the marker itself,
/// authoritative on the tombstone.
#[tauri::command]
fn consume_host_setup(app: tauri::AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::fs::remove_file(dir.join("host-setup.requested"));
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&data);
        let _ = std::fs::write(data.join("host-setup.consumed"), b"");
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
        .manage(hosting::HostProcesses(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
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
            forget_credential,
            show_server,
            hide_servers,
            close_server,
            open_external,
            app_version,
            host_setup_requested,
            consume_host_setup,
            quit_app,
            hosting::host_available,
            hosting::host_install,
            hosting::host_start,
            hosting::host_stop,
            hosting::host_state,
            hosting::host_options_read,
            hosting::host_options_write,
            hosting::host_open_logs,
            hosting::host_uninstall
        ])
        .build(tauri::generate_context!())
        .expect("error while running SOVRGNnet")
        .run(|app_handle, event| {
            // The hosted server's processes are children of this one. Quitting
            // the app must stop them — Postgres through pg_ctl so it
            // checkpoints — or "my server" becomes four orphans holding ports.
            if let tauri::RunEvent::Exit = event {
                let processes = app_handle.state::<hosting::HostProcesses>();
                hosting::stop_all(app_handle, &processes);
            }
        });
}
