import { createHash, timingSafeEqual } from "node:crypto";
import { deriveE2eeCapability } from "@shared/e2ee";
import { PROTOCOL_VERSION, type InstanceDescriptor } from "@shared/protocol";
import { IDENTITY_ORIGIN } from "@shared/identity";
import { ENV } from "./_core/env";
import { appserviceConfigured } from "./appservice";
import { directSync } from "./matrixPublic";

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
  return createHash("sha256")
    .update(`sovrgnnet:instance:${seed}`)
    .digest("hex")
    .slice(0, 16);
}

export type RegistrationVerdict =
  | { allowed: true; reason: "bootstrap" | "open" | "invite" }
  | { allowed: false; message: string };

/**
 * Constant-time comparison of the setup token.
 *
 * `===` on a secret leaks its length and prefix through timing, and this one
 * is worth guessing: it is the difference between owning an instance and not.
 * Hashing both sides first means the comparison is always over the same number
 * of bytes, so a wrong length can't shortcut it.
 */
function presentedTokenMatches(
  expected: string,
  presented: string | undefined
): boolean {
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

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
  /** The instance's configured setup token, empty when none is set. */
  setupToken?: string;
  /** What the registrant presented, if anything. */
  presentedSetupToken?: string;
}): RegistrationVerdict {
  if (input.isFirstAccount) {
    // The bootstrap exception is also the instance's front door: whoever takes
    // it becomes the administrator. A server is normally reachable before its
    // owner has registered — you point DNS at it, then go and sign up — so
    // without a secret, the exception belongs to whoever scans the address
    // first.
    //
    // Fail-closed when no token is configured. The cost of refusing is an
    // operator reading an error that tells them exactly what to set; the cost
    // of allowing is somebody else owning their instance.
    if (!input.setupToken) {
      return {
        allowed: false,
        message:
          "This instance has no setup token, so the first account can't be created. " +
          "Set SOVRGN_SETUP_TOKEN and restart — see docs/INSTALL or your .env.",
      };
    }
    if (!presentedTokenMatches(input.setupToken, input.presentedSetupToken)) {
      return {
        allowed: false,
        message:
          "That setup code isn't right. It's in the instance's environment as SOVRGN_SETUP_TOKEN.",
      };
    }
    return { allowed: true, reason: "bootstrap" };
  }

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
            message:
              "This server is invite-only. You'll need an invite link to join.",
          };
  }
}

export function normalizeJoinPolicy(
  raw: string | null | undefined
): JoinPolicy {
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
 * Whether this build ships a crypto implementation at all.
 *
 * A property of the software, not of any deployment, so it stays a constant
 * that no environment variable can turn on. It became true when Olm/Megolm
 * actually shipped in the client — ADR 0008 stage 4 — and not one commit
 * sooner. It was false for five releases while the groundwork went in, which
 * is the point of having it.
 *
 * It is necessary and not sufficient. See `e2eeAvailable`.
 */
const E2EE_IMPLEMENTED = true;

/**
 * Whether *this instance* can offer end-to-end encryption.
 *
 * Shipping the code is one of three conditions and the only one the build
 * controls. The others are facts about the deployment, and both are things
 * this codebase has previously got wrong by asserting instead of checking:
 * `encryption` in v0.3 was a constant that claimed more than the software did,
 * and `clientMatrix` before stage 2 was `Boolean(MATRIX_PUBLIC_URL)`, which
 * announced a capability the moment an operator set a variable.
 *
 * So the answer is derived. A homeserver has to have actually answered at the
 * advertised address, because that is what lets a client hold its own session
 * and therefore its own keys — on a loopback-only deployment the only place
 * keys could live is the server, which is the arrangement encryption exists to
 * end. And the appservice has to be wired, because an encrypted message the
 * instance never records is invisible to every member whose client is on the
 * API fallback.
 *
 * The derivation itself lives in `shared/e2ee.ts`, where it is unit-tested
 * and where a client can read the same rule the instance applied.
 */
export function e2eeAvailable(): boolean {
  return deriveE2eeCapability({
    implemented: E2EE_IMPLEMENTED,
    homeserverReachable: directSync().available,
    eventIngest: appserviceConfigured(),
  });
}

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
      // Derived by the same function the app reports everywhere else, so
      // this can never drift into claiming encryption that doesn't exist.
      e2ee: info.encryption,
      // True only when the operator runs their own LiveKit SFU and set its
      // three values — ADR 0013 as superseded. Same posture as sso:
      // unconfigured means honestly absent, not broken. Nothing here ever
      // depends on a SOVRGN-held backend.
      voice: Boolean(
        process.env.LIVEKIT_URL &&
          process.env.LIVEKIT_API_KEY &&
          process.env.LIVEKIT_API_SECRET
      ),
      federation: process.env.MATRIX_ALLOW_FEDERATION === "true",
      sso: info.sso.enabled,
      publicRegistration: info.joinPolicy === "open",
      // True only when a homeserver has actually answered at the advertised
      // address — not merely when MATRIX_PUBLIC_URL is set.
      //
      // It used to be `Boolean(publicMatrix)`, which announced the capability
      // the moment an operator set a variable, before anything confirmed a
      // homeserver was there or that the address was even right. Same mistake
      // `encryption` made in v0.3: a deployment detail silently becoming a
      // claim. A client acts on capabilities, so one that lies is worse than
      // one that's absent.
      clientMatrix: directSync().available,
      // True only when the appservice registration is wired (ADR 0009).
      // Clients must not author events an instance cannot record, so this
      // gates client-side sending the same way clientMatrix gates sync.
      eventIngest: appserviceConfigured(),
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

export function instanceInfo(
  version: string,
  stored: StoredSettings = null
): InstanceInfo {
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
      stored?.description?.trim() ||
      process.env.INSTANCE_DESCRIPTION?.trim() ||
      null,
    matrixServerName: ENV.matrixServerName,
    // Only advertise the homeserver once an operator has published one.
    // Clients use its presence to decide whether direct sync (and therefore
    // encryption) is available here at all.
    matrixBaseUrl: publicMatrix || null,
    joinPolicy: normalizeJoinPolicy(
      stored?.joinPolicy ?? process.env.INSTANCE_JOIN_POLICY
    ),
    encryption: e2eeAvailable(),
    listed: stored?.listed ?? process.env.INSTANCE_LISTED === "true",
    sso: {
      enabled: process.env.INSTANCE_ALLOW_SSO === "true",
      issuer:
        process.env.INSTANCE_ALLOW_SSO === "true"
          ? process.env.IDENTITY_ISSUER?.trim() || IDENTITY_ORIGIN
          : null,
    },
    software: { name: "sovrgnnet", version },
  };
}
