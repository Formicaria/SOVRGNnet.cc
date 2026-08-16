/**
 * The SOVRGN protocol — the interoperability layer between any client and any
 * instance.
 *
 * This is deliberately separate from application versioning. An instance
 * running 0.4.0 and a client running 0.6.0 must interoperate if they speak the
 * same protocol major version, because independently operated servers do not
 * upgrade in lockstep with anybody's release schedule. Requiring them to would
 * make every instance quietly dependent on the project's cadence, which is the
 * thing this architecture exists to avoid.
 *
 * The PostgreSQL schema is implementation state. *This* is the contract.
 *
 * **This module has no dependencies, deliberately.** Two reasons. It is
 * imported by the desktop client, which keeps a four-package runtime and should
 * not gain a validation library to read a JSON document. And a specification
 * defined in terms of one language's schema library is a specification nobody
 * can implement in another language — "whatever zod does with this" is not
 * something a Go implementer can read. The parser below is the normative
 * description of the wire format, in explicit structural terms.
 */

/**
 * Protocol version.
 *
 * Major changes break compatibility: a client that speaks major 1 cannot talk
 * to an instance that speaks only major 2. Minor changes add capabilities and
 * are always backward compatible — an older client simply won't ask for the
 * new things.
 */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export interface ProtocolVersion {
  major: number;
  minor: number;
}

/**
 * What an instance can do.
 *
 * Every capability defaults to **false** except messaging. That direction
 * matters: an older instance that has never heard of a capability must read as
 * "doesn't have it", never as "probably fine". Optimistic defaults are how a
 * client ends up offering a feature that silently does nothing.
 */
export interface Capabilities {
  /** Text messaging. The one thing every instance has. */
  messaging: boolean;
  /** File sharing through the instance's own storage. */
  media: boolean;
  /** End-to-end encryption. False until keys genuinely live on devices. */
  e2ee: boolean;
  /** Voice and video channels. */
  voice: boolean;
  /** Whether this homeserver talks to other Matrix servers. */
  federation: boolean;
  /** Whether this instance accepts identities from an identity provider. */
  sso: boolean;
  /** Whether anyone may create an account without an invite. */
  publicRegistration: boolean;
  /** Whether the client may talk to Matrix directly rather than via the app. */
  clientMatrix: boolean;
  /**
   * Whether the instance records events pushed by its homeserver (ADR 0009).
   * Clients only author events over their own Matrix session when this is
   * true, because a sent message the instance never records is invisible to
   * every member still on the API fallback.
   */
  eventIngest: boolean;
  /** Whether this instance can produce and consume portable backups. */
  portableBackup: boolean;
}

export type CapabilityName = keyof Capabilities;

/** Applied to any capability an instance didn't mention. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  messaging: true,
  media: false,
  e2ee: false,
  voice: false,
  federation: false,
  sso: false,
  publicRegistration: false,
  clientMatrix: false,
  eventIngest: false,
  portableBackup: false,
};

export const CAPABILITY_NAMES = Object.keys(DEFAULT_CAPABILITIES) as CapabilityName[];

export type JoinPolicy = "open" | "invite" | "closed";

export const JOIN_POLICIES: JoinPolicy[] = ["open", "invite", "closed"];

/**
 * What an instance says about itself, to anyone who asks.
 *
 * Deliberately free of anything private: no member counts, no channel lists,
 * no user data. A stranger fetching this learns what the software can do and
 * whether they may join — nothing about who is already there.
 */
export interface InstanceDescriptor {
  /** Confirms this is a SOVRGNnet instance and not something else entirely. */
  product: "sovrgnnet";
  protocol: ProtocolVersion;
  server: {
    /** Application version. Informational — never used for compatibility. */
    version: string;
    /**
     * Stable, non-secret identifier: exactly 16 lowercase hex characters,
     * SHA-256 of `sovrgnnet:instance:<matrix server name>` truncated.
     *
     * The format is normative because this value is the audience of every
     * identity token minted for the instance, and an ambiguous audience means
     * two instances could both plausibly claim the same token.
     */
    id: string;
    name: string;
    description: string | null;
  };
  capabilities: Capabilities;
  matrix: {
    /** The domain in Matrix IDs. Permanent for the life of the instance. */
    serverName: string;
    /** Public homeserver URL, when clients may reach it directly. */
    baseUrl: string | null;
  };
  /** open = anyone · invite = invite required · closed = nobody */
  joinPolicy: JoinPolicy;
  /** Where identities come from, if this instance accepts external ones. */
  identityIssuer: string | null;
}

// ------------------------------------------------------------------- parsing

const INSTANCE_ID = /^[0-9a-f]{16}$/;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A URL, or null. Anything unparseable is rejected rather than passed on —
 *  these end up in fetch() and in the address bar. */
function absoluteUrl(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Read a capability set, treating anything absent or non-boolean as absent.
 *
 * A string "true" is not a boolean and does not mean yes. Being strict here is
 * what makes the false-by-default rule actually hold.
 */
export function parseCapabilities(raw: unknown): Capabilities {
  const source = record(raw) ?? {};
  const result = { ...DEFAULT_CAPABILITIES };
  for (const name of CAPABILITY_NAMES) {
    const value = source[name];
    if (typeof value === "boolean") result[name] = value;
  }
  return result;
}

export function parseProtocolVersion(raw: unknown): ProtocolVersion | null {
  const source = record(raw);
  if (!source) return null;
  const major = wholeNumber(source.major);
  const minor = wholeNumber(source.minor);
  if (major === null || minor === null) return null;
  return { major, minor };
}

/**
 * Parse whatever an instance returned.
 *
 * Anything unrecognisable is null rather than an exception, because pointing a
 * client at the wrong address is an ordinary thing people do, not an
 * exceptional condition.
 */
export function parseInstanceDescriptor(raw: unknown): InstanceDescriptor | null {
  const source = record(raw);
  if (!source) return null;
  if (source.product !== "sovrgnnet") return null;

  const protocol = parseProtocolVersion(source.protocol);
  if (!protocol) return null;

  const server = record(source.server);
  if (!server) return null;

  if (typeof server.version !== "string") return null;
  if (typeof server.id !== "string" || !INSTANCE_ID.test(server.id)) return null;
  if (typeof server.name !== "string" || server.name.length < 1 || server.name.length > MAX_NAME) {
    return null;
  }

  let description: string | null = null;
  if (server.description !== null && server.description !== undefined) {
    if (typeof server.description !== "string" || server.description.length > MAX_DESCRIPTION) {
      return null;
    }
    description = server.description;
  }

  const matrix = record(source.matrix);
  if (!matrix || typeof matrix.serverName !== "string") return null;

  const baseUrl = absoluteUrl(matrix.baseUrl);
  if (!baseUrl.ok) return null;

  const issuer = absoluteUrl(source.identityIssuer);
  if (!issuer.ok) return null;

  let joinPolicy: JoinPolicy = "invite";
  if (source.joinPolicy !== undefined && source.joinPolicy !== null) {
    if (!JOIN_POLICIES.includes(source.joinPolicy as JoinPolicy)) return null;
    joinPolicy = source.joinPolicy as JoinPolicy;
  }

  return {
    product: "sovrgnnet",
    protocol,
    server: { version: server.version, id: server.id, name: server.name, description },
    capabilities: parseCapabilities(source.capabilities),
    matrix: { serverName: matrix.serverName, baseUrl: baseUrl.value },
    joinPolicy,
    identityIssuer: issuer.value,
  };
}

// -------------------------------------------------------------- compatibility

export type Compatibility =
  | { ok: true; protocol: ProtocolVersion }
  | { ok: false; reason: "client-too-old" | "server-too-old" | "not-sovrgnnet"; message: string };

/**
 * Can this client talk to this instance?
 *
 * Same major version is the whole test. A newer minor on either side is fine:
 * the older party doesn't know about the additions and won't ask for them.
 */
export function checkCompatibility(
  instance: ProtocolVersion,
  client: ProtocolVersion = PROTOCOL_VERSION
): Compatibility {
  if (instance.major > client.major) {
    return {
      ok: false,
      reason: "client-too-old",
      message:
        "This instance speaks a newer version of the SOVRGN protocol. Update your client to connect.",
    };
  }
  if (instance.major < client.major) {
    return {
      ok: false,
      reason: "server-too-old",
      message:
        "This instance speaks an older version of the SOVRGN protocol. Its operator needs to update it.",
    };
  }
  return { ok: true, protocol: instance };
}

/**
 * Ask whether an instance supports something.
 *
 * Always route capability questions through here rather than reading the flag
 * directly: a descriptor from an older instance may not carry the field at
 * all, and this treats missing as absent.
 */
export function supports(
  descriptor: Pick<InstanceDescriptor, "capabilities">,
  capability: CapabilityName
): boolean {
  return descriptor.capabilities?.[capability] === true;
}

/**
 * Why a feature is unavailable, in words for a person.
 *
 * Graceful degradation means explaining, not hiding. Someone whose friend's
 * instance has no voice should learn that, not wonder where the button went.
 */
export function explainMissing(capability: CapabilityName): string {
  const reasons: Record<CapabilityName, string> = {
    messaging: "This instance doesn't support messaging, which is unusual — it may be misconfigured.",
    media: "This instance doesn't have file sharing switched on.",
    e2ee: "This instance doesn't support end-to-end encryption yet. Messages are readable by whoever runs it.",
    voice: "This instance doesn't have voice channels.",
    federation: "This instance doesn't talk to other Matrix servers.",
    sso: "This instance only accepts accounts created on it directly.",
    publicRegistration: "This instance is invite-only.",
    clientMatrix: "This instance routes messages through its own server rather than letting clients connect to Matrix directly.",
    eventIngest: "This instance doesn't record events sent directly to its homeserver, so messages are sent through its API instead.",
    portableBackup: "This instance doesn't support portable backups.",
  };
  return reasons[capability];
}
