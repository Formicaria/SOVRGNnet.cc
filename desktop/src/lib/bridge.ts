import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DeepLinkQueue } from "@shared/deeplink";

/**
 * The narrow seam between the UI and the shell.
 *
 * Everything the desktop app can do that a web page cannot goes through here,
 * in one place, so the rest of the UI stays ordinary React and the surface
 * that needs auditing stays small.
 */

/** Per-server credentials, in the OS keychain rather than browser storage. */
export const credentials = {
  async store(instanceId: string, secret: string): Promise<void> {
    await invoke("store_credential", { instanceId, secret });
  },

  async read(instanceId: string): Promise<string | null> {
    return await invoke<string | null>("read_credential", { instanceId });
  },

  async forget(instanceId: string): Promise<void> {
    await invoke("forget_credential", { instanceId });
  },
};

/**
 * Links arriving from outside the app.
 *
 * Queued rather than delivered immediately, because a cold start from an
 * invite click produces the URL before React has mounted. `startListening`
 * is called once at boot; the UI subscribes whenever it's ready and receives
 * anything that arrived in the meantime.
 */
export const deepLinks = new DeepLinkQueue();

export async function startListeningForDeepLinks(): Promise<void> {
  await listen<string>("deep-link", event => {
    if (typeof event.payload === "string") {
      deepLinks.push(event.payload);
    }
  });
}

/**
 * Show a server.
 *
 * Each server is loaded in its own webview so that sessions, cookies, and
 * storage stay separated per origin — which is the whole reason this can hold
 * several servers at once while a browser tab cannot. The Rust side owns
 * creating and switching them; see src-tauri/src/main.rs.
 */
export async function showServer(url: string, label: string): Promise<void> {
  await invoke("show_server", { url, label });
}

/**
 * Hide every server webview without closing it.
 *
 * Native child webviews draw above the frame's DOM, so a dialog rendered by
 * the shell sits *under* the instance unless the instance is hidden first.
 * Hidden rather than closed, so scroll position, a half-typed message and the
 * running sync all survive opening a dialog.
 */
export async function hideServers(): Promise<void> {
  await invoke("hide_servers");
}

export async function closeServer(label: string): Promise<void> {
  await invoke("close_server", { label });
}

/**
 * Open a link in the user's real browser, not in the app.
 *
 * Used for release pages and sign-in. A download or an OAuth flow inside an
 * app webview is both worse and more suspicious than the browser someone
 * already trusts.
 */
export async function openExternal(url: string): Promise<void> {
  await invoke("open_external", { url });
}

/** The app's own version, read from the shell rather than hardcoded. */
export async function appVersion(): Promise<string> {
  return await invoke<string>("app_version");
}

/**
 * Did the installer (or a --host-setup launch) ask this run to open the
 * server setup? Windows answers via a marker file the NSIS hook left beside
 * the executable; Linux answers via the flag, because package installs
 * never prompt by policy. Asked once — consuming it writes a tombstone so
 * the question can't reopen on every launch forever.
 */
export async function hostSetupRequested(): Promise<boolean> {
  return await invoke<boolean>("host_setup_requested");
}

export async function consumeHostSetup(): Promise<void> {
  await invoke("consume_host_setup");
}

/**
 * Quit, deliberately.
 *
 * The Rust side calls `app.exit`, which fires `RunEvent::Exit` — where
 * `stop_all` lives — so the hosted server's children go down with the app,
 * Postgres through pg_ctl so it checkpoints. This is the same path a window
 * close takes; it exists as a button because the first Linux walk proved the
 * alternatives lie: relaunching just focuses the old instance, and SIGTERM
 * skips the Exit handler and orphans the children.
 */
export async function quitApp(): Promise<void> {
  await invoke("quit_app");
}

/** A stable, filesystem-safe webview label for a connection. */
export function webviewLabel(instanceId: string): string {
  return `server-${instanceId}`;
}
