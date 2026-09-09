import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  COMPONENTS,
  VOICE_UDP_RANGE,
  evaluate,
  portCandidates,
  type AccessMode,
  type Component,
  type ComponentId,
  type ComponentState,
  type HostOptions,
  type HostState,
} from "@shared/hosting";
import { credentials } from "@/lib/bridge";

/**
 * The hosting side of the bridge.
 *
 * The Rust supervisor spawns and stops processes and says what happened;
 * everything that decides something lives here or in shared/hosting.ts —
 * which ports to offer, what the reports mean, when to call the server
 * usable. Secrets are generated here too, and live in the OS keychain under
 * the reserved id "host"; the Rust side receives them per call and persists
 * nothing.
 */

const HOST_KEYCHAIN_ID = "host";

export interface HostSecrets {
  db_password: string;
  jwt_secret: string;
  matrix_shared_secret: string;
  /**
   * This machine's Matrix server name. Not a secret — it ends up in every
   * Matrix ID — but it lives here because it needs exactly the same
   * generate-once-and-never-again treatment as the values around it.
   *
   * Every desktop host used to be `sovrgn.host`. Since the server derives its
   * instance id by hashing this, and identity tokens are audience-bound to that
   * id, one shared name meant a token minted for one person's desktop verified
   * on everybody else's. It also made the backup-restore server-name guard pass
   * between unrelated machines. See hosting.rs for the full account.
   */
  matrix_server_name: string;
  /**
   * The token that gates creating this server's first account.
   *
   * The instance refuses to bootstrap without one — deliberately, because a
   * server that has just been pointed at an address and has no accounts yet
   * would otherwise be claimable by whoever reached it first. That guard was
   * added for hosted servers and the desktop was never given a token, so
   * hosting on this computer produced a server whose first account could not
   * be created at all. The sign-up screen asked for a code that had never
   * existed and told people to look in a `.env` they do not have.
   *
   * Kept here, in the keychain, because the app is the only thing that knows
   * it: there is no terminal to print it to and nobody to read it.
   */
  setup_token: string;
  /**
   * The key pair the bundled voice SFU accepts admission tokens under — what
   * makes a desktop host's `voice: true` true out of the box (ADR 0013 as
   * superseded). The key is an identifier — it rides every token as the
   * issuer — and the secret signs admissions; both are per-install for the
   * same reason the server name is: nothing about one person's machine
   * should verify on another's.
   */
  livekit_api_key: string;
  livekit_api_secret: string;
  /**
   * The appservice registration's tokens — what lets the homeserver push
   * every event to the instance, which is what lets clients author events
   * the instance can't read and still have them indexed (ADR 0009, made
   * mandatory by ADR 0015). Per-install, generated once, for the same reason
   * as everything above: nothing about one machine's registration should
   * verify on another's.
   */
  appservice_as_token: string;
  appservice_hs_token: string;
}

interface ComponentReport {
  id: string;
  state: string;
  port: number | null;
  error: string | null;
}

interface HostReport {
  installed: boolean;
  components: ComponentReport[];
  url: string | null;
  /** The tunnel's public address, when one is up. Optional: older supervisors omit it. */
  public_url?: string | null;
}

/**
 * The last full report — the one with ports and the url.
 *
 * `host_start` is the only call that knows which port each component was
 * given and where the app answers; `host_state` reports live process states
 * and nothing else, by design. So a poll is overlaid on this rather than
 * replacing it, or every refresh would erase the ports from the panel and
 * the url from the app.
 */
let lastReport: HostReport | null = null;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A server name for one machine.
 *
 * A subdomain of a name we control, so it is a well-formed hostname and
 * obviously a desktop host. Federation is off for desktop hosts, so it never
 * has to resolve — but a malformed server name would produce Matrix IDs other
 * homeservers reject, and that is not a thing to discover after the IDs are
 * permanent.
 *
 * 64 bits of randomness. Collisions here are not a security boundary — these
 * servers do not federate — but two people sharing a name would reintroduce
 * exactly the bug this replaced, so it is sized to not happen.
 */
export function freshServerName(): string {
  return `${randomHex(8)}.desktop.sovrgn.host`;
}

/**
 * The keychain either already holds this machine's server secrets, or gains
 * them now. They are made exactly once: the database password in particular
 * is baked into the cluster at initdb, so "regenerate" would mean "lock
 * yourself out of your own messages".
 */
export async function hostSecrets(): Promise<HostSecrets> {
  const existing = await credentials.read(HOST_KEYCHAIN_ID);
  if (existing) {
    const stored = JSON.parse(existing) as Partial<HostSecrets>;
    // Backfilled rather than regenerated. Entries written before the server
    // name lived here have no field, and the Rust side needs *something* to
    // propose — but it only uses the proposal when there is no name on disk and
    // no existing database, so backfilling cannot rename a working install.
    // That decision stays in hosting.rs, next to the data directory that is the
    // only authority on whether this machine has hosted before.
    let changed = false;
    if (!stored.matrix_server_name) {
      stored.matrix_server_name = freshServerName();
      changed = true;
    }
    // Same backfill, same reasoning. An install from before this field existed
    // has a server it cannot create an account on; minting a token now fixes
    // that, and on an install that *already* has accounts the token is simply
    // never consulted again — bootstrap only runs when there are none.
    if (!stored.setup_token) {
      stored.setup_token = randomHex(16);
      changed = true;
    }
    // Voice, for installs that predate it. Backfilling mints the pair the
    // bundled SFU signs against, and voice lights up on the next start —
    // nothing else about the install changes, and a bundle too old to carry
    // the SFU simply never consults these.
    if (!stored.livekit_api_key || !stored.livekit_api_secret) {
      stored.livekit_api_key = randomHex(8);
      stored.livekit_api_secret = randomHex(24);
      changed = true;
    }
    // The appservice tokens, for installs that predate ADR 0015. Minting
    // them here is what turns an existing plaintext host into an encrypting
    // one on its next start: the supervisor renders the registration from
    // these, Dendrite reads it at boot, and eventIngest is true.
    if (!stored.appservice_as_token || !stored.appservice_hs_token) {
      stored.appservice_as_token = randomHex(32);
      stored.appservice_hs_token = randomHex(32);
      changed = true;
    }
    if (changed) await credentials.store(HOST_KEYCHAIN_ID, JSON.stringify(stored));
    return stored as HostSecrets;
  }
  const fresh: HostSecrets = {
    db_password: randomHex(24),
    jwt_secret: randomHex(32),
    matrix_shared_secret: randomHex(32),
    matrix_server_name: freshServerName(),
    setup_token: randomHex(16),
    livekit_api_key: randomHex(8),
    livekit_api_secret: randomHex(24),
    appservice_as_token: randomHex(32),
    appservice_hs_token: randomHex(32),
  };
  await credentials.store(HOST_KEYCHAIN_ID, JSON.stringify(fresh));
  return fresh;
}

export async function hostAvailable(): Promise<{ bundled: boolean; installed: boolean }> {
  return await invoke("host_available");
}

/**
 * Whether the hosted instance is still waiting for its first account.
 *
 * Read from the instance's own descriptor — the same `needsSetup` the web
 * sign-up form consults — because the instance is the only authority on
 * whether it has accounts. Unreachable reads as "no": the wrong answer here
 * merely skips a form, while a false "yes" would show account creation for
 * a server that can't accept one.
 */
export async function hostNeedsFirstAccount(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/instance", url));
    if (!response.ok) return false;
    const info = (await response.json()) as { needsSetup?: boolean };
    return info.needsSetup === true;
  } catch {
    return false;
  }
}

/**
 * Create the hosted server's first account — the administrator — spending
 * the setup token this app already holds.
 *
 * The token exists to stop a stranger over the network claiming a freshly
 * reachable instance. The person who clicked "Set up my server" is not that
 * stranger: the token was minted by this app, lives in this machine's
 * keychain, and making its owner transcribe it from one pane into another
 * was a ceremony with no threat model — the Windows walk found people
 * stranded at a sign-up form demanding a code whose only display had
 * closed. The guard on the server is untouched; this is the app using the
 * key it was always holding.
 *
 * Wire shape matches the server's tRPC transformer (superjson): input rides
 * as `{ json: ... }`, and errors come back wrapped the same way.
 */
export async function createFirstAccount(
  url: string,
  account: { username: string; password: string; email?: string }
): Promise<void> {
  const secrets = await hostSecrets();
  let response: Response;
  try {
    response = await fetch(new URL("/api/trpc/auth.register", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: {
          username: account.username,
          password: account.password,
          ...(account.email ? { email: account.email } : {}),
          setupToken: secrets.setup_token,
        },
      }),
    });
  } catch {
    // The webview's entire account of any network-layer failure is "Failed
    // to fetch" — shown on a panel that just said the server is running.
    // Say what is known and what to do instead.
    throw new Error(
      `Couldn't reach your server at ${url} to create the account. ` +
        "It was answering a moment ago — close this panel and try again. " +
        "If it keeps happening, the last lines under host/logs/ say why."
    );
  }
  if (!response.ok) {
    let message = `The server refused (${response.status}).`;
    try {
      const body = (await response.json()) as {
        error?: { json?: { message?: string }; message?: string };
      };
      message = body.error?.json?.message ?? body.error?.message ?? message;
    } catch {
      /* an unreadable error body keeps the status-code message */
    }
    throw new Error(message);
  }
}

export async function hostInstall(): Promise<void> {
  await invoke("host_install", { secrets: await hostSecrets() });
}

/**
 * The access choice this install was made with, or null if nobody has
 * chosen yet.
 *
 * Null is the answer the first-run flow is built around: it is what puts the
 * question in front of the person instead of exposing their server — or
 * silently not exposing it — on their behalf. An install from before the
 * choice existed reads as null too, which is right: nobody chose for it, and
 * the one-time question on its next launch is the cost of that.
 */
export async function hostOptions(): Promise<HostOptions | null> {
  const raw = await invoke<{ access?: string } | null>("host_options_read");
  if (!raw) return null;
  // Anything unrecognised is LAN: the mode with no exposure to get wrong.
  const access: AccessMode = raw.access === "tunnel" ? "tunnel" : "lan";
  return { access };
}

export async function saveHostOptions(options: HostOptions): Promise<void> {
  await invoke("host_options_write", { options });
}

/** Start everything and return the evaluated state, ready to render. */
export async function hostStart(options: HostOptions): Promise<HostState> {
  const report = await invoke<HostReport>("host_start", {
    secrets: await hostSecrets(),
    ports: {
      postgres: portCandidates("postgres"),
      matrix: portCandidates("matrix"),
      ipfs: portCandidates("ipfs"),
      voice: portCandidates("voice"),
      app: portCandidates("app"),
      voice_udp: VOICE_UDP_RANGE,
    },
    options,
  });
  lastReport = report;
  return interpret(report);
}

export async function hostStop(): Promise<void> {
  await invoke("host_stop");
  lastReport = null;
}

/**
 * The live picture: what the start report said, updated with what the
 * processes are doing now.
 *
 * This existed before and nothing called it, which is why the panel's rows
 * froze at the moment of start: a component that crashed ten minutes in read
 * "running" forever, and ipfs and voice — reported "starting" by design,
 * without waiting — read "starting" forever, whether or not they had come
 * up. `watchHostState` is the caller now.
 */
export async function hostState(): Promise<HostState> {
  const poll = await invoke<HostReport>("host_state");
  const merged = lastReport ? overlay(lastReport, poll) : poll;
  lastReport = merged;
  return interpret(merged);
}

/**
 * Merge a state poll onto the last full report.
 *
 * A poll carries live process states and, when there is a tunnel, its
 * address; it carries no ports (they were decided at start and don't move)
 * and no url. A component absent from a poll is one with no child process:
 * either it never spawned — a start-time failure, whose words are worth
 * keeping — or it has since been stopped.
 */
function overlay(base: HostReport, poll: HostReport): HostReport {
  return {
    installed: poll.installed,
    url: base.url,
    public_url: poll.public_url ?? base.public_url ?? null,
    components: base.components.map(component => {
      const live = poll.components.find(p => p.id === component.id);
      if (live) {
        return {
          ...component,
          state: live.state,
          // A poll's error is fresher when it has one ("exited: ..."); when it
          // doesn't, a start-time reason is only still true if the state is.
          error: live.error ?? (live.state === component.state ? component.error : null),
        };
      }
      if (component.state === "failed" || component.state === "off") return component;
      return { ...component, state: "stopped", error: null };
    }),
  };
}

/**
 * Poll the supervisor and report each change.
 *
 * Polling rather than pushing because the process handles live in Rust with
 * no event of their own — `try_wait` is a question, not a notification — and
 * five seconds is a fine answer to "is it still up" for a panel a person is
 * looking at. Only *changes* reach the handler, compared structurally, so a
 * steady server causes no re-renders at all.
 */
export function watchHostState(
  handler: (state: HostState) => void,
  intervalMs = 5000
): () => void {
  let stopped = false;
  let last = "";
  const tick = async () => {
    if (stopped) return;
    try {
      const state = await hostState();
      const key = JSON.stringify(state);
      if (key !== last) {
        last = key;
        handler(state);
      }
    } catch {
      // A poll that fails says nothing new; the last state stands.
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Reveal the component logs in the OS file manager. */
export async function hostOpenLogs(): Promise<void> {
  await invoke("host_open_logs");
}

/**
 * Remove the hosted server entirely: every process stopped, every byte it
 * wrote deleted, and the secrets it was started with forgotten.
 *
 * The keychain half is here rather than in Rust because the secrets were
 * always the frontend's — generated here, stored here, never held by the
 * supervisor past the call that used them. The confirmation is the
 * caller's; by the time this runs, the person has read the words and said yes.
 */
export async function hostUninstall(): Promise<void> {
  await invoke("host_uninstall");
  await credentials.forget(HOST_KEYCHAIN_ID);
  lastReport = null;
}

export function onInstallStep(handler: (stepId: string) => void): Promise<UnlistenFn> {
  return listen<string>("host-install-step", event => handler(event.payload));
}

export function onHostState(handler: (state: HostState) => void): Promise<UnlistenFn> {
  return listen<HostReport>("host-state", event => handler(interpret(event.payload)));
}

/**
 * Turn the supervisor's raw report into the policy layer's HostState.
 *
 * The report may omit components (nothing spawned yet) or ports (a state
 * poll doesn't re-derive them); absent components read as stopped, which is
 * what they are.
 */
function interpret(report: HostReport): HostState {
  if (!report.installed) return { status: "absent" };

  const byId = new Map(report.components.map(c => [c.id, c]));
  const components: Component[] = COMPONENTS.filter((id: ComponentId) => {
    // Voice and the tunnel are the optional components: a dev build or a
    // bundle from before the SFU shipped runs a perfectly good server
    // without voice, and a LAN-only host has no tunnel by choice. A
    // permanent "stopped" row for something that was never going to start
    // reads as a problem. Absent from the report means absent from the
    // machine; the rows below mean "expected and not answering".
    return (id !== "voice" && id !== "tunnel") || byId.has(id);
  }).map((id: ComponentId) => {
    const raw = byId.get(id);
    return {
      id,
      state: (raw?.state ?? "stopped") as ComponentState,
      port: raw?.port ?? null,
      error: raw?.error ?? null,
    };
  });

  return evaluate(components, report.url ?? "", report.public_url ?? null);
}
