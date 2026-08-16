import { createHash } from "node:crypto";
import { PROTOCOL_VERSION, type InstanceDescriptor } from "@shared/protocol";
import { ENV } from "./_core/env";

/**
 * Who this server is, to someone who has never met it.
 *
 * A SOVRGNnet client connects to many independent servers — Zach's LXC, a
 * friend's box, a community's VPS. Before it can show a login screen it needs
 * to know what it's talking to: is this even a SOVRGNnet server, what's it
 * called, can I register here, and where is its homeserver.
 *
 * That's what `GET /api/instance` answers. It is deliberately public and
 * deliberately boring — no membership, no user counts, no room list. Just
 * enough for a client to decide whether to offer a "connect" button.
 */

export type JoinPolicy = "open" | "invite" | "closed";

export type InstanceInfo = {
  /** Always "sovrgnnet" — how a client confirms what it's found. */
  product: "sovrgnnet";
  /** Bumped when this payload's shape changes incompatibly. */
  apiVersion: number;
  /** Stable, non-secret identifier. Derived, not stored — see instanceId(). */
  id: string;
  name: string;
  description: string | null;
  /** The Matrix server_name, which is also this instance's federation identity. */
  matrixServerName: string;
  /**
   * Public base URL of the homeserver, for clients that sync directly.
   * Null while the homeserver is loopback-only (the web-proxy deployment).
   */
  matrixBaseUrl: string | null;
  joinPolicy: JoinPolicy;
  /** Whether messages on this instance are end-to-end encrypted. */
  encryption: boolean;
  /** Whether this instance is listed in the sovrgnnet.cc directory. */
  listed: boolean;
  /**
   * Whether this server accepts sovrgnnet.cc accounts, and where from.
   * Public so a client can decide whether to offer the button at all.
   */
  sso: { enabled: boolean; issuer: string | null };
  software: { name: string; version: string };
};

/**
 * A stable public ID for this instance.
 *
 * Derived by hashing the Matrix server name — which is already permanent and
 * already public — rather than generating and storing a UUID. Two properties
 * fall out of that: it survives a database restore, and it can't be forged
 * into somebody else's identity without also taking their server name.
 *
 * The app secret is deliberately NOT mixed in: this value is meant to be
 * shared, and a secret-derived ID would leak with every invite link.
 */
export function instanceId(): string {
  const seed = ENV.matrixServerName || "unconfigured";
  return createHash("sha256").update(`sovrgnnet:instance:${seed}`).digest("hex").slice(0, 16);
}

export type RegistrationVerdict =
  | { allowed: true; reason: "bootstrap" | "open" | "invite" }
  | { allowed: false; message: string };

/**
 * May this person create an account here?
 *
 * Pure, because the interesting part is the policy and not the database.
 *
 * The bootstrap case is the one that's easy to get wrong: the default policy
 * is invite-only, so enforcing it without an exception would mean a freshly
 * installed server could never create its own first account — the owner would
 * need an invite to a community that doesn't exist yet. The first
 * registration is always allowed, and it becomes the administrator.
 */
export function canRegister(input: {
  policy: JoinPolicy;
  isFirstAccount: boolean;
  hasValidInvite: boolean;
}): RegistrationVerdict {
  if (input.isFirstAccount) return { allowed: true, reason: "bootstrap" };

  switch (input.policy) {
    case "open":
      return { allowed: true, reason: "open" };

    case "closed":
      return {
        allowed: false,
        message: "This server isn't accepting new accounts.",
      };

    case "invite":
      return input.hasValidInvite
        ? { allowed: true, reason: "invite" }
        : {
            allowed: false,
            message: "This server is invite-only. You'll need an invite link to join.",
          };
  }
}

export function normalizeJoinPolicy(raw: string | null | undefined): JoinPolicy {
  const value = (raw ?? "").toLowerCase();
  return value === "open" || value === "closed" ? value : "invite";
}

/**
 * Settings an administrator has saved, if any.
 *
 * Kept as a parameter rather than fetched here so this stays a pure function —
 * the route does the I/O, and tests don't need a database.
 */
export type StoredSettings = {
  name?: string | null;
  description?: string | null;
  joinPolicy?: string | null;
  listed?: boolean | null;
} | null;

/**
 * Whether this build encrypts messages end-to-end.
 *
 * A property of the software, not of any deployment — so it is a constant, and
 * no environment variable can turn it on. It flips to true when Olm/Megolm
 * actually ships in the client (ADR 0001, phase 9), and not one commit sooner.
 *
 * This was briefly derived from whether the homeserver was publicly
 * reachable, which is wrong: a reachable homeserver is a *precondition* for
 * clients to sync directly and therefore for encryption to become possible.
 * It is not encryption. Conflating the two would have made every instance
 * advertise E2EE the moment it got a public address.
 */
const E2EE_AVAILABLE = false;

/**
 * The formal protocol descriptor for this instance.
 *
 * Separate from `instanceInfo` on purpose: that shape is what v0.1–v0.3
 * clients already parse, and independently operated instances upgrade on
 * nobody's schedule but their own. Both are served from `/api/instance` —
 * old fields kept, new ones added alongside — so an old client keeps working
 * and a new one gets a typed, negotiated contract.
 */
export function instanceDescriptor(
  version: string,
  stored: StoredSettings = null
): InstanceDescriptor {
  const info = instanceInfo(version, stored);
  const publicMatrix = process.env.MATRIX_PUBLIC_URL?.trim() || null;

  return {
    product: "sovrgnnet",
    protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
    server: {
      version,
      id: info.id,
      name: info.name,
      description: info.description,
    },
    capabilities: {
      messaging: true,
      media: true,
      // Declared by the same constant the app reports everywhere else, so
      // this can never drift into claiming encryption that doesn't exist.
      e2ee: info.encryption,
      voice: false,
      federation: process.env.MATRIX_ALLOW_FEDERATION === "true",
      sso: info.sso.enabled,
      publicRegistration: info.joinPolicy === "open",
      // True once clients sync with Matrix themselves. Requires a reachable
      // homeserver, which is exactly what MATRIX_PUBLIC_URL announces.
      clientMatrix: Boolean(publicMatrix),
      portableBackup: true,
    },
    matrix: {
      serverName: info.matrixServerName,
      baseUrl: publicMatrix,
    },
    joinPolicy: info.joinPolicy,
    identityIssuer: info.sso.enabled ? info.sso.issuer : null,
  };
}

export function instanceInfo(version: string, stored: StoredSettings = null): InstanceInfo {
  const publicMatrix = process.env.MATRIX_PUBLIC_URL?.trim();

  return {
    product: "sovrgnnet",
    apiVersion: 1,
    id: instanceId(),
    // Saved settings win; the environment is only the bootstrap default for
    // an instance nobody has configured yet.
    name:
      stored?.name?.trim() ||
      process.env.INSTANCE_NAME?.trim() ||
      ENV.matrixServerName ||
      "A SOVRGNnet server",
    description:
      stored?.description?.trim() || process.env.INSTANCE_DESCRIPTION?.trim() || null,
    matrixServerName: ENV.matrixServerName,
    // Only advertise the homeserver once an operator has published one.
    // Clients use its presence to decide whether direct sync (and therefore
    // encryption) is available here at all.
    matrixBaseUrl: publicMatrix || null,
    joinPolicy: normalizeJoinPolicy(stored?.joinPolicy ?? process.env.INSTANCE_JOIN_POLICY),
    encryption: E2EE_AVAILABLE,
    listed: stored?.listed ?? process.env.INSTANCE_LISTED === "true",
    sso: {
      enabled: process.env.INSTANCE_ALLOW_SSO === "true",
      issuer:
        process.env.INSTANCE_ALLOW_SSO === "true"
          ? process.env.IDENTITY_ISSUER?.trim() || "https://sovrgnnet.cc"
          : null,
    },
    software: { name: "sovrgnnet", version },
  };
}
