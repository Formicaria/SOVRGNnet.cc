/**
 * What is wrong with this instance, and what should I do about it?
 *
 * The desktop client shows each instance's own web UI in a webview. That works
 * well and has one blind spot that matters enormously: when the instance is
 * broken, the webview is *blank*. Exactly when an operator most needs
 * information, the design gives them a white rectangle.
 *
 * So this runs outside the webview, against the unauthenticated discovery
 * endpoints, and answers the question the blank rectangle raises. It needs no
 * credentials — which is the point, because "I can't sign in" is one of the
 * failures it has to be able to report.
 *
 * Pure. The caller fetches; this decides. Health logic that can only be
 * exercised against a broken live server is health logic that never gets
 * tested, and then it's wrong on the day it matters.
 */

import {
  checkCompatibility,
  parseInstanceDescriptor,
  supports,
  type Capabilities,
  type InstanceDescriptor,
} from "./protocol";

export type HealthState =
  /** Everything answers. */
  | "healthy"
  /** The app is up; something it depends on is not. */
  | "degraded"
  /** Nothing answered at all. */
  | "unreachable"
  /** Something answered, but it isn't a SOVRGNnet instance. */
  | "not-sovrgnnet"
  /** It is one, and this client can't speak to it. */
  | "incompatible";

export interface HealthProbe {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

export interface HealthProbes {
  health?: HealthProbe;
  ready?: HealthProbe;
  instance?: HealthProbe;
}

export interface DependencyStatus {
  name: string;
  ok: boolean;
  /** Whether the instance is unusable without it. */
  fatal: boolean;
  detail: string;
}

export interface InstanceHealth {
  state: HealthState;
  /** One line, written for whoever is staring at a blank window. */
  summary: string;
  /** What to actually do. Empty when there is nothing to do. */
  guidance: string[];
  dependencies: DependencyStatus[];
  version: string | null;
  uptimeSeconds: number | null;
  capabilities: Capabilities | null;
  descriptor: InstanceDescriptor | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const DEPENDENCY_LABELS: Record<string, { label: string; fatal: boolean; whenDown: string }> = {
  database: {
    label: "Database",
    fatal: true,
    whenDown: "Nothing works without it. Check that PostgreSQL is running.",
  },
  matrix: {
    label: "Homeserver",
    fatal: false,
    whenDown: "Messages won't send or load. Everything else still works.",
  },
  ipfs: {
    label: "File storage",
    fatal: false,
    whenDown: "File uploads and downloads will fail. Messaging is unaffected.",
  },
};

/**
 * Assess in order of what would make later answers meaningless.
 *
 * There is no point reporting a degraded database on something that turned out
 * not to be a SOVRGNnet instance at all.
 */
export function assessHealth(probes: HealthProbes): InstanceHealth {
  const base: InstanceHealth = {
    state: "unreachable",
    summary: "",
    guidance: [],
    dependencies: [],
    version: null,
    uptimeSeconds: null,
    capabilities: null,
    descriptor: null,
  };

  const healthAnswered = Boolean(probes.health && !probes.health.error);
  const instanceAnswered = Boolean(probes.instance && !probes.instance.error);

  // -- Nothing answered -------------------------------------------------------

  if (!healthAnswered && !instanceAnswered) {
    const reason = probes.health?.error ?? probes.instance?.error ?? "no response";
    return {
      ...base,
      state: "unreachable",
      summary: "Can't reach this instance.",
      guidance: [
        `The connection failed: ${reason}.`,
        "If it's your own instance, check it's running: `sovrgnnet status`.",
        "If it's someone else's, their machine may simply be off — the instance stays in your list.",
      ],
    };
  }

  // -- It answered. Is it ours? ----------------------------------------------

  const raw = instanceAnswered ? asRecord(probes.instance?.body) : null;

  if (instanceAnswered && probes.instance?.ok && raw && raw.product !== "sovrgnnet") {
    return {
      ...base,
      state: "not-sovrgnnet",
      summary: "Something is running at this address, but it isn't SOVRGNnet.",
      guidance: [
        "Check the address is right.",
        "A web server answering on the same host will look like this.",
      ],
    };
  }

  const descriptor = raw ? parseInstanceDescriptor(raw) : null;

  // The app can answer /health from a process too broken to describe itself,
  // so a missing descriptor is a real state rather than an assessment failure.
  if (instanceAnswered && probes.instance?.ok && !descriptor) {
    return {
      ...base,
      state: "not-sovrgnnet",
      summary: "This address answered, but not with anything recognisable.",
      guidance: ["It may be a much older instance, or a different service entirely."],
    };
  }

  if (descriptor) {
    const compatibility = checkCompatibility(descriptor.protocol);
    if (!compatibility.ok) {
      const tooOld = compatibility.reason === "server-too-old";
      return {
        ...base,
        descriptor,
        capabilities: descriptor.capabilities,
        version: descriptor.server.version,
        state: "incompatible",
        summary: tooOld
          ? "This instance is too old for this client."
          : "This instance is newer than this client understands.",
        guidance: tooOld
          ? ["Its operator needs to update it before you can connect."]
          : ["Update this app, then try again."],
      };
    }
  }

  // -- It's ours and compatible. What's actually broken? ----------------------

  const healthBody = asRecord(probes.health?.body);
  const uptime = typeof healthBody?.uptime === "number" ? healthBody.uptime : null;

  const dependencies = readDependencies(probes.ready);
  const fatalDown = dependencies.filter(d => !d.ok && d.fatal);
  const nonFatalDown = dependencies.filter(d => !d.ok && !d.fatal);

  const version = descriptor?.server.version ?? null;
  const capabilities = descriptor?.capabilities ?? null;

  // The app process is down but discovery answered — possible behind a proxy
  // that serves cached responses, or if only /health is failing.
  if (!healthAnswered) {
    return {
      ...base,
      descriptor,
      capabilities,
      version,
      dependencies,
      state: "degraded",
      summary: "The instance answers, but its health check doesn't.",
      guidance: ["The app process may be restarting. Check `sovrgnnet logs`."],
    };
  }

  if (fatalDown.length > 0) {
    return {
      ...base,
      descriptor,
      capabilities,
      version,
      uptimeSeconds: uptime,
      dependencies,
      state: "degraded",
      // Naming the component matters: "instance is down" sends someone
      // restarting the whole stack when one service needs attention.
      summary: `The app is running, but ${listNames(fatalDown)} ${fatalDown.length === 1 ? "is" : "are"} down.`,
      guidance: [
        ...fatalDown.map(d => d.detail),
        "Run `sovrgnnet status` on the machine to see which service stopped.",
      ],
    };
  }

  if (nonFatalDown.length > 0) {
    return {
      ...base,
      descriptor,
      capabilities,
      version,
      uptimeSeconds: uptime,
      dependencies,
      state: "degraded",
      summary: `Running, with ${listNames(nonFatalDown)} unavailable.`,
      guidance: nonFatalDown.map(d => d.detail),
    };
  }

  return {
    ...base,
    descriptor,
    capabilities,
    version,
    uptimeSeconds: uptime,
    dependencies,
    state: "healthy",
    summary: "Everything is running.",
    guidance: [],
  };
}

function readDependencies(ready: HealthProbe | undefined): DependencyStatus[] {
  if (!ready || ready.error) return [];

  const body = asRecord(ready.body);
  const checks = body ? asRecord(body.checks) : null;
  if (!checks) return [];

  return Object.entries(checks).map(([name, value]) => {
    const known = DEPENDENCY_LABELS[name];
    const ok = value === "ok";
    return {
      name: known?.label ?? name,
      ok,
      fatal: known?.fatal ?? false,
      detail: ok ? "Responding." : (known?.whenDown ?? `${name} is not responding.`),
    };
  });
}

function listNames(items: DependencyStatus[]): string {
  const names = items.map(d => d.name.toLowerCase());
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Which features to actually offer for this instance.
 *
 * Returns what is missing, so the interface can say why rather than silently
 * omitting a button — someone whose friend's instance has no voice should
 * learn that, not wonder where it went.
 */
export function missingFeatures(
  health: InstanceHealth,
  wanted: Array<keyof Capabilities>
): Array<keyof Capabilities> {
  if (!health.descriptor) return wanted;
  return wanted.filter(capability => !supports(health.descriptor!, capability));
}

/** Short label for a status dot. */
export function healthLabel(state: HealthState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "unreachable":
      return "Offline";
    case "not-sovrgnnet":
      return "Unknown";
    case "incompatible":
      return "Incompatible";
  }
}

/** Whether the client should even try to load this instance's interface. */
export function shouldLoadInterface(health: InstanceHealth): boolean {
  // Degraded still loads: a dead homeserver leaves an interface worth showing,
  // and one that explains itself beats a blank rectangle.
  return health.state === "healthy" || health.state === "degraded";
}
