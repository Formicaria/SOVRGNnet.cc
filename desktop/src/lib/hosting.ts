import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  COMPONENTS,
  evaluate,
  portCandidates,
  type Component,
  type ComponentId,
  type ComponentState,
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
}

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
    if (!stored.matrix_server_name) {
      stored.matrix_server_name = freshServerName();
      await credentials.store(HOST_KEYCHAIN_ID, JSON.stringify(stored));
    }
    return stored as HostSecrets;
  }
  const fresh: HostSecrets = {
    db_password: randomHex(24),
    jwt_secret: randomHex(32),
    matrix_shared_secret: randomHex(32),
    matrix_server_name: freshServerName(),
  };
  await credentials.store(HOST_KEYCHAIN_ID, JSON.stringify(fresh));
  return fresh;
}

export async function hostAvailable(): Promise<{ bundled: boolean; installed: boolean }> {
  return await invoke("host_available");
}

export async function hostInstall(): Promise<void> {
  await invoke("host_install", { secrets: await hostSecrets() });
}

/** Start everything and return the evaluated state, ready to render. */
export async function hostStart(): Promise<HostState> {
  const report = await invoke<HostReport>("host_start", {
    secrets: await hostSecrets(),
    ports: {
      postgres: portCandidates("postgres"),
      matrix: portCandidates("matrix"),
      ipfs: portCandidates("ipfs"),
      app: portCandidates("app"),
    },
  });
  return interpret(report);
}

export async function hostStop(): Promise<void> {
  await invoke("host_stop");
}

export async function hostState(): Promise<HostState> {
  return interpret(await invoke<HostReport>("host_state"));
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
  const components: Component[] = COMPONENTS.map((id: ComponentId) => {
    const raw = byId.get(id);
    return {
      id,
      state: (raw?.state ?? "stopped") as ComponentState,
      port: raw?.port ?? null,
      error: raw?.error ?? null,
    };
  });

  return evaluate(components, report.url ?? "");
}
