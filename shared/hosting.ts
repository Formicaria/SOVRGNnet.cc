/**
 * Supervising a server that runs inside the desktop app.
 *
 * The state model and the rules for deciding "is this usable yet" live here,
 * in TypeScript, tested — while the process handling lives in Rust. That split
 * is deliberate: the interesting mistakes in a supervisor are about *policy*
 * (when to call something ready, what to do when one piece dies, which port to
 * use) and policy is cheap to test and expensive to get wrong.
 *
 * See docs/adr/0005-desktop-hosts-a-server.md.
 */

/** The pieces a hosted server is made of, in start order. */
export const COMPONENTS = ["postgres", "conduit", "ipfs", "app"] as const;
export type ComponentId = (typeof COMPONENTS)[number];

export type ComponentState =
  | "stopped"
  | "starting"
  | "running"
  /** Running but not answering health checks — starting up, or wedged. */
  | "unhealthy"
  | "failed";

export type Component = {
  id: ComponentId;
  state: ComponentState;
  /** Port it was actually given, which is not necessarily the one we wanted. */
  port: number | null;
  /** Set when state is "failed", for showing a person something true. */
  error: string | null;
};

export type HostState =
  /** Nothing installed — this machine has never hosted. */
  | { status: "absent" }
  | { status: "installing"; step: string; completed: number; total: number }
  | { status: "starting"; components: Component[] }
  | { status: "running"; components: Component[]; url: string }
  | { status: "degraded"; components: Component[]; url: string; problem: string }
  | { status: "stopped"; components: Component[] }
  | { status: "failed"; components: Component[]; problem: string };

/**
 * Ports we'd like, in preference order.
 *
 * A desktop is not a dedicated container: something else is already using
 * things. These are starting points, and the supervisor moves on when one is
 * taken — which is why every component reports the port it actually got rather
 * than anyone assuming.
 */
export const PREFERRED_PORTS: Record<ComponentId, number> = {
  postgres: 5433, // not 5432 — a developer's own Postgres is likely there
  conduit: 6167,
  ipfs: 5101, // not 5001 — a developer's own Kubo is likely there
  app: 3100, // not 3000 — everything uses 3000
};

/** How many ports to try past the preferred one before giving up. */
export const PORT_SEARCH_RANGE = 40;

export function portCandidates(component: ComponentId): number[] {
  const first = PREFERRED_PORTS[component];
  return Array.from({ length: PORT_SEARCH_RANGE }, (_, i) => first + i);
}

/**
 * Is the whole thing usable?
 *
 * "Usable" means the app answers — that's what a person interacts with. But
 * the app cannot be healthy without Postgres, so a healthy app implies a
 * healthy database whether or not the database's own check has caught up.
 *
 * IPFS is deliberately not required: without it file sharing fails, and
 * everything else works. Refusing to open a working chat because an unrelated
 * component is slow would be the wrong call.
 */
export function isUsable(components: Component[]): boolean {
  return components.find(c => c.id === "app")?.state === "running";
}

export const REQUIRED_FOR_CHAT: ComponentId[] = ["postgres", "conduit", "app"];

/**
 * Turn a set of component states into one thing to show a person.
 *
 * Deliberately not a naive "all running or bust". A server where files don't
 * work is degraded, not broken, and telling someone their server is down when
 * they can chat perfectly well would be both wrong and alarming.
 */
export function evaluate(components: Component[], url: string): HostState {
  const byId = new Map(components.map(c => [c.id, c]));

  const failed = components.filter(c => c.state === "failed");
  const chatFailed = failed.filter(c => REQUIRED_FOR_CHAT.includes(c.id));
  if (chatFailed.length > 0) {
    return {
      status: "failed",
      components,
      problem: describeFailure(chatFailed),
    };
  }

  if (components.every(c => c.state === "stopped")) {
    return { status: "stopped", components };
  }

  const starting = components.some(c => c.state === "starting");
  if (starting && !isUsable(components)) {
    return { status: "starting", components };
  }

  if (isUsable(components)) {
    // Anything non-essential being unwell is worth saying, without pretending
    // the server is down.
    const ailing = components.filter(
      c => c.state === "unhealthy" || c.state === "failed"
    );
    if (ailing.length > 0) {
      return {
        status: "degraded",
        components,
        url,
        problem: describeDegradation(ailing),
      };
    }
    return { status: "running", components, url };
  }

  const unhealthy = components.filter(c => c.state === "unhealthy");
  if (unhealthy.length > 0) {
    return { status: "starting", components };
  }

  return {
    status: "failed",
    components,
    problem: byId.get("app")?.error ?? "The server didn't start.",
  };
}

const HUMAN_NAMES: Record<ComponentId, string> = {
  postgres: "the database",
  conduit: "the chat server",
  ipfs: "file storage",
  app: "the app",
};

function describeFailure(failed: Component[]): string {
  const first = failed[0];
  const name = HUMAN_NAMES[first.id];
  return first.error
    ? `${name} couldn't start: ${first.error}`
    : `${name} couldn't start.`;
}

function describeDegradation(ailing: Component[]): string {
  const names = ailing.map(c => HUMAN_NAMES[c.id]);
  if (ailing.some(c => c.id === "ipfs")) {
    return "Everything works except file sharing — file storage isn't responding.";
  }
  return `Running, but ${names.join(" and ")} ${names.length === 1 ? "is" : "are"} not responding.`;
}

/**
 * A person-facing line for each install step.
 *
 * Installing takes minutes and moves several gigabytes. A progress bar with no
 * words is how people conclude something has hung and kill it halfway through
 * writing a database.
 */
export const INSTALL_STEPS: Array<{ id: string; label: string }> = [
  { id: "unpack", label: "Unpacking components" },
  { id: "database", label: "Setting up the database" },
  { id: "homeserver", label: "Preparing the chat server" },
  { id: "storage", label: "Preparing file storage" },
  { id: "secrets", label: "Generating your keys" },
  { id: "migrate", label: "Creating the database tables" },
  { id: "start", label: "Starting everything up" },
];

export function installProgress(stepId: string): { completed: number; total: number } {
  const index = INSTALL_STEPS.findIndex(step => step.id === stepId);
  return {
    completed: index < 0 ? 0 : index + 1,
    total: INSTALL_STEPS.length,
  };
}

/**
 * Whether a hosted server's data must be backed up before an upgrade.
 *
 * ADR 0005 calls bundled Postgres upgrades the schedule risk, for good reason:
 * a major version change needs pg_upgrade or a dump/restore, on a machine
 * nobody can inspect. Getting it wrong destroys message history, so the rule
 * is simple and refuses to be clever — different major version means back up
 * first, no exceptions, no "probably fine".
 */
export function needsBackupBeforeUpgrade(
  installedVersion: string,
  bundledVersion: string
): boolean {
  const major = (version: string) => parseInt(version.split(".")[0] ?? "", 10);
  const installed = major(installedVersion);
  const bundled = major(bundledVersion);

  // An unreadable version is the most alarming case, not the least.
  if (Number.isNaN(installed) || Number.isNaN(bundled)) return true;
  return bundled !== installed;
}
