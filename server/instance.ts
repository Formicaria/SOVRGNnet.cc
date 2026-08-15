import { createHash } from "node:crypto";
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

function joinPolicy(): JoinPolicy {
  const raw = (process.env.INSTANCE_JOIN_POLICY ?? "invite").toLowerCase();
  return raw === "open" || raw === "closed" ? raw : "invite";
}

export function instanceInfo(version: string): InstanceInfo {
  const publicMatrix = process.env.MATRIX_PUBLIC_URL?.trim();

  return {
    product: "sovrgnnet",
    apiVersion: 1,
    id: instanceId(),
    name: process.env.INSTANCE_NAME?.trim() || ENV.matrixServerName || "A SOVRGNnet server",
    description: process.env.INSTANCE_DESCRIPTION?.trim() || null,
    matrixServerName: ENV.matrixServerName,
    // Only advertise the homeserver once an operator has published one.
    // Clients use its presence to decide whether direct sync (and therefore
    // encryption) is available here at all.
    matrixBaseUrl: publicMatrix || null,
    joinPolicy: joinPolicy(),
    encryption: Boolean(publicMatrix),
    listed: process.env.INSTANCE_LISTED === "true",
    software: { name: "sovrgnnet", version },
  };
}
