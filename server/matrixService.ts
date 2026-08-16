import { createHmac } from "node:crypto";

import { nanoid } from "nanoid";
import { ENV } from "./_core/env";

/**
 * Server-side Matrix client.
 *
 * SOVRGNnet proxies every Matrix operation through this module: the app
 * provisions one Matrix account per SOVRGNnet user, holds the access tokens
 * server-side, and acts on the user's behalf against the homeserver over the
 * internal network. The browser never talks to Matrix directly.
 */

export class MatrixError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly errcode?: string
  ) {
    super(message);
    this.name = "MatrixError";
  }
}

type FetchLike = typeof fetch;

// Injectable for tests.
let fetchImpl: FetchLike = (...args) => fetch(...args);
export function __setFetchForTests(f: FetchLike): void {
  fetchImpl = f;
}

function baseUrl(): string {
  return ENV.matrixHomeserverUrl.replace(/\/+$/, "");
}

async function matrixRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  accessToken?: string,
  options?: { signal?: AbortSignal }
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetchImpl(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options?.signal,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    throw new MatrixError(
      json?.error ?? `Matrix API error ${res.status}`,
      res.status,
      json?.errcode
    );
  }
  return json as T;
}

/**
 * Deterministic per-user Matrix password derived from the app secret, so a
 * lost access token can always be recovered via login — no plaintext
 * passwords stored anywhere.
 */
export function deriveMatrixPassword(userId: number): string {
  return createHmac("sha256", ENV.cookieSecret)
    .update(`matrix-account:${userId}`)
    .digest("hex");
}

export function localpartForUser(userId: number): string {
  return `sovrgn_${userId}`;
}

export type MatrixCredentials = {
  userId: string;
  accessToken: string;
  /** Null only when talking to a homeserver that didn't report one. */
  deviceId?: string | null;
};

/**
 * The MAC proving a shared-secret registration request is ours.
 *
 * Dendrite implements Synapse's shared-secret registration: the homeserver
 * hands out a nonce, and the caller returns an HMAC-SHA1 over
 * `nonce\0username\0password\0admin-or-not`, keyed with a secret only the
 * server knows.
 *
 * The null separators matter. Joining the fields without them would let
 * different field splits produce identical MACs — a classic length-extension
 * -adjacent confusion — so they're explicit here rather than incidental.
 */
export function sharedSecretMac(
  sharedSecret: string,
  nonce: string,
  username: string,
  password: string,
  admin: boolean
): string {
  return createHmac("sha1", sharedSecret)
    .update(`${nonce}\x00${username}\x00${password}\x00${admin ? "admin" : "notadmin"}`)
    .digest("hex");
}

/**
 * Provision a Matrix account, falling back to login when it already exists.
 *
 * Uses shared-secret registration rather than a registration token, because
 * Dendrite has no token flow — its choices are registration disabled, or
 * reCAPTCHA, or open. Shared secret is strictly better than the token we used
 * with Conduit: public registration stays *fully disabled*, and only something
 * holding the secret can create an account. The secret never leaves this
 * process.
 */
export async function registerOrLogin(appUserId: number): Promise<MatrixCredentials> {
  const username = localpartForUser(appUserId);
  const password = deriveMatrixPassword(appUserId);

  if (!ENV.matrixSharedSecret) {
    throw new MatrixError(
      "MATRIX_SHARED_SECRET is not set, so this server can't create Matrix accounts.",
      500,
      "M_MISSING_SHARED_SECRET"
    );
  }

  try {
    // The homeserver issues a nonce per attempt; it's single-use, which is
    // what stops a captured request being replayed.
    const { nonce } = await matrixRequest<{ nonce: string }>(
      "GET",
      "/_synapse/admin/v1/register"
    );

    const reg = await matrixRequest<{ user_id: string; access_token: string }>(
      "POST",
      "/_synapse/admin/v1/register",
      {
        nonce,
        username,
        password,
        admin: false,
        mac: sharedSecretMac(ENV.matrixSharedSecret, nonce, username, password, false),
      }
    );
    return { userId: reg.user_id, accessToken: reg.access_token };
  } catch (err) {
    // The account already exists — expected whenever an access token was
    // wiped but the Matrix account survived. Log in instead.
    if (
      err instanceof MatrixError &&
      (err.errcode === "M_USER_IN_USE" || err.status === 400)
    ) {
      // Always under the same device id, so a token lost and recovered
      // replaces the server's session instead of adding another anonymous one
      // beside it. Homeservers used to accumulate one per recovery.
      return await login(username, password, {
        deviceId: SERVER_DEVICE_ID,
        displayName: SERVER_DEVICE_NAME,
      });
    }
    throw err;
  }
}

/**
 * Devices are named, not anonymous.
 *
 * Every login used to create a fresh device with no id and no display name, so
 * a homeserver accumulated identical unnamed sessions that nobody could tell
 * apart — which is the actual reason there was no per-device revocation.
 * Nothing was identified, so nothing could be revoked.
 *
 * The instance's own session is deliberately recognisable. Someone looking at
 * their device list should be able to see that the server holds one, because
 * it does, and hiding it would be the dishonest option.
 */
export const SERVER_DEVICE_ID = "SOVRGNNET_SERVER";
export const SERVER_DEVICE_NAME = "SOVRGNnet server";

/** A device id for a client session. Random, so two clients never collide. */
export function clientDeviceId(): string {
  return `SOVRGN_${nanoid(16).toUpperCase().replace(/[^A-Z0-9]/g, "0")}`;
}

export type MatrixDevice = {
  deviceId: string;
  displayName: string | null;
  lastSeenIp: string | null;
  lastSeenAt: number | null;
  /** Whether this is the session the instance itself holds. */
  isServer: boolean;
};

export async function login(
  username: string,
  password: string,
  device?: { deviceId?: string; displayName?: string }
): Promise<MatrixCredentials> {
  const res = await matrixRequest<{
    user_id: string;
    access_token: string;
    device_id?: string;
  }>("POST", "/_matrix/client/v3/login", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: username },
    password,
    // Reusing a device_id replaces that session rather than adding another,
    // which is what stops the server's own repeated logins piling up.
    ...(device?.deviceId ? { device_id: device.deviceId } : {}),
    ...(device?.displayName ? { initial_device_display_name: device.displayName } : {}),
  });

  return {
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id ?? device?.deviceId ?? null,
  };
}

/**
 * Which device the instance's own token belongs to.
 *
 * Asked rather than assumed. SERVER_DEVICE_ID is only applied on the *login*
 * path, which runs when an account already exists. A fresh account is created
 * by shared-secret registration, and that returns a token on a device the
 * homeserver names itself — Dendrite calls it `shared_secret_registration`.
 *
 * So for most accounts the constant never matched, `isServer` was false on the
 * instance's own session, and deleteDevice would happily sign it out. That
 * breaks every operation the server performs for that user, and presents as the
 * account mysteriously failing.
 *
 * whoami is authoritative: whichever device this token belongs to *is* the
 * server's session, whatever anyone named it.
 */
async function serverDeviceId(accessToken: string): Promise<string | null> {
  try {
    return (await whoami(accessToken)).deviceId;
  } catch {
    // Fall back to the constant rather than failing the whole listing — a
    // homeserver that can't answer whoami can still enumerate devices.
    return SERVER_DEVICE_ID;
  }
}

/**
 * Every session on this account.
 *
 * Needs the user's own token — this is deliberately not an admin API call, so
 * it reports what that user can actually see and act on.
 */
export async function listDevices(accessToken: string): Promise<MatrixDevice[]> {
  const [res, ownDevice] = await Promise.all([
    matrixRequest<{
      devices?: Array<{
        device_id: string;
        display_name?: string | null;
        last_seen_ip?: string | null;
        last_seen_ts?: number | null;
      }>;
    }>("GET", "/_matrix/client/v3/devices", undefined, accessToken),
    serverDeviceId(accessToken),
  ]);

  return (res.devices ?? []).map(device => ({
    deviceId: device.device_id,
    displayName: device.display_name ?? null,
    lastSeenIp: device.last_seen_ip ?? null,
    lastSeenAt: device.last_seen_ts ?? null,
    // Either the device this token is on, or one the server explicitly named.
    isServer: device.device_id === ownDevice || device.device_id === SERVER_DEVICE_ID,
  }));
}

/**
 * Sign a device out.
 *
 * Deleting a device on Matrix requires user-interactive auth, so the password
 * goes in the auth block. It is derived rather than stored — see
 * deriveMatrixPassword, and ADR 0008 for why that is a disclosed weakness
 * rather than a hidden one.
 *
 * Refuses to remove the instance's own session: doing so would break every
 * operation the server performs on the user's behalf, and the user would
 * experience it as the account silently failing.
 */
export async function deleteDevice(
  accessToken: string,
  deviceId: string,
  auth: { user: string; password: string }
): Promise<void> {
  // Ask which device this token is on rather than comparing to a constant.
  // The constant only ever matched accounts created by the login path; every
  // account registered through the shared secret had a homeserver-named device,
  // so this refusal never fired for them and the session was removable.
  const ownDevice = await serverDeviceId(accessToken);

  if (deviceId === ownDevice || deviceId === SERVER_DEVICE_ID) {
    throw new MatrixError(
      "That session belongs to the server itself and can't be signed out from here.",
      400,
      "M_FORBIDDEN"
    );
  }

  await matrixRequest<unknown>(
    "DELETE",
    `/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`,
    {
      auth: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: auth.user },
        password: auth.password,
      },
    },
    accessToken
  );
}

/** Which account and device a token actually belongs to. */
export async function whoami(
  accessToken: string
): Promise<{ userId: string; deviceId: string | null }> {
  const res = await matrixRequest<{ user_id: string; device_id?: string }>(
    "GET",
    "/_matrix/client/v3/account/whoami",
    undefined,
    accessToken
  );
  return { userId: res.user_id, deviceId: res.device_id ?? null };
}

/** Create a Space (SOVRGNnet "server"). Returns the space room id. */
/**
 * Room version. Restricted join rules (MSC3083) need 8 or later; 10 is what
 * Dendrite v0.15 defaults to and what the child rooms below rely on.
 */
const ROOM_VERSION = "10";

/**
 * Only moderators and above may invite Matrix users directly.
 *
 * The default is 0 — any member. That was invisible while the app was the only
 * thing talking to Matrix, and becomes a hole the moment a client syncs
 * directly: a member could invite arbitrary Matrix accounts into a community,
 * including someone SOVRGN had banned, and the app's own membership tables
 * would know nothing about it.
 */
// 50 is POWER_LEVELS.moderator, which is declared further down this file.
const POWER_LEVEL_OVERRIDES = { invite: 50 };

/**
 * Create a Space — a SOVRGNnet community.
 *
 * **Invite-only and unlisted.** It was `preset: "public_chat"` with
 * `visibility: "public"`, which meant every community was joinable by anyone
 * who could reach the homeserver, *and* published in its public room
 * directory. SOVRGN's own join policy defaults to invite-only, so the app was
 * enforcing a rule the Matrix layer underneath it contradicted.
 *
 * That was masked while the homeserver was loopback-only. ADR 0008 stage 2
 * makes exposing it a supported configuration, which turns a latent
 * contradiction into a live one: a private community would have been listed
 * publicly and joinable without an invite.
 */
export async function createSpace(
  accessToken: string,
  name: string,
  topic?: string
): Promise<string> {
  const res = await matrixRequest<{ room_id: string }>(
    "POST",
    "/_matrix/client/v3/createRoom",
    {
      name,
      topic,
      preset: "private_chat",
      // Not in the homeserver's public room directory. Discovery is SOVRGN's
      // job, gated on its own join policy.
      visibility: "private",
      room_version: ROOM_VERSION,
      power_level_content_override: POWER_LEVEL_OVERRIDES,
      creation_content: { type: "m.space" },
    },
    accessToken
  );
  return res.room_id;
}

/** Create a room (channel) and link it as a child of the space. */
/**
 * Create a channel room inside a Space.
 *
 * Joinable by anyone already in the Space, and nobody else — a *restricted*
 * join rule, which is the thing Spaces were designed for. That keeps the
 * familiar behaviour (join a community, get its channels) without the room
 * being open to the world, and without needing an invite per channel.
 *
 * Restricted rules need room version 8+, hence the explicit version: relying
 * on the homeserver's default would silently produce a public room on an older
 * one, which is the failure this is fixing.
 */
export async function createChannelRoom(
  accessToken: string,
  spaceId: string,
  name: string,
  topic?: string
): Promise<string> {
  const res = await matrixRequest<{ room_id: string }>(
    "POST",
    "/_matrix/client/v3/createRoom",
    {
      name,
      topic,
      preset: "private_chat",
      visibility: "private",
      room_version: ROOM_VERSION,
      power_level_content_override: POWER_LEVEL_OVERRIDES,
      initial_state: [
        {
          type: "m.room.join_rules",
          state_key: "",
          content: {
            join_rule: "restricted",
            allow: [{ type: "m.room_membership", room_id: spaceId }],
          },
        },
      ],
    },
    accessToken
  );

  await matrixRequest(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(res.room_id)}`,
    { via: [ENV.matrixServerName], suggested: true },
    accessToken
  );

  return res.room_id;
}

/**
 * Invite a Matrix user to a room.
 *
 * Needed because the Space is invite-only now. SOVRGN decides who may join —
 * through its own join policy, invite codes, and bans — and this is how that
 * decision is carried into Matrix. The alternative was leaving the Space open
 * to anyone who could reach the homeserver, which made the app's rules
 * decorative.
 *
 * Requires a token with the invite power level, so it runs as the community
 * owner rather than as the person joining.
 */
export async function inviteToRoom(
  accessToken: string,
  roomId: string,
  matrixUserId: string
): Promise<void> {
  await matrixRequest(
    "POST",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    { user_id: matrixUserId },
    accessToken
  );
}

export async function joinRoom(accessToken: string, roomId: string): Promise<void> {
  await matrixRequest(
    "POST",
    `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    {},
    accessToken
  );
}

/** Send a text message. Returns the Matrix event id. */
export async function sendMessage(
  accessToken: string,
  roomId: string,
  body: string
): Promise<string> {
  const txnId = `sovrgn_${Date.now()}_${nanoid(8)}`;
  const res = await matrixRequest<{ event_id: string }>(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    { msgtype: "m.text", body },
    accessToken
  );
  return res.event_id;
}

/**
 * Announce a file share in the room.
 *
 * File bytes live on the instance's IPFS node and are served through the
 * membership-checked `/api/files/:cid` route — the event deliberately carries
 * no URL, only the CID under a namespaced key. Its purpose is liveness: a
 * client on direct sync (ADR 0008 stage 3) hears it and refetches the file
 * list, instead of polling every five seconds. `m.file` msgtype keeps the
 * event legible in third-party Matrix clients, which show the filename.
 */
export async function sendFileNotice(
  accessToken: string,
  roomId: string,
  file: { filename: string; cid: string; size: number; mimeType?: string | null }
): Promise<string> {
  const txnId = `sovrgn_${Date.now()}_${nanoid(8)}`;
  const res = await matrixRequest<{ event_id: string }>(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: "m.file",
      body: file.filename,
      "cc.sovrgnnet.file": {
        cid: file.cid,
        size: file.size,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      },
    },
    accessToken
  );
  return res.event_id;
}

/** Redact (delete) an event. Returns the redaction event id. */
export async function redactEvent(
  accessToken: string,
  roomId: string,
  eventId: string,
  reason?: string
): Promise<string> {
  const txnId = `sovrgn_redact_${Date.now()}_${nanoid(8)}`;
  const res = await matrixRequest<{ event_id: string }>(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
    reason ? { reason } : {},
    accessToken
  );
  return res.event_id;
}

/** Leave a room. */
export async function leaveRoom(accessToken: string, roomId: string): Promise<void> {
  await matrixRequest(
    "POST",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
    {},
    accessToken
  );
}

/**
 * Edit a message.
 *
 * Matrix models an edit as a *new* event that points back at the original
 * with an `m.replace` relation — the original is never mutated. Clients that
 * understand the relation render the replacement; ones that don't still see
 * the fallback body, which is why it's prefixed with "* " by convention.
 */
export async function editMessage(
  accessToken: string,
  roomId: string,
  originalEventId: string,
  newBody: string
): Promise<string> {
  const txnId = `sovrgn_edit_${Date.now()}_${nanoid(8)}`;
  const res = await matrixRequest<{ event_id: string }>(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: "m.text",
      body: `* ${newBody}`,
      "m.new_content": { msgtype: "m.text", body: newBody },
      "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
    },
    accessToken
  );
  return res.event_id;
}

/** React to a message (an `m.annotation` relation carrying the emoji). */
export async function sendReaction(
  accessToken: string,
  roomId: string,
  targetEventId: string,
  emoji: string
): Promise<string> {
  const txnId = `sovrgn_react_${Date.now()}_${nanoid(8)}`;
  const res = await matrixRequest<{ event_id: string }>(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
    {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: targetEventId,
        key: emoji,
      },
    },
    accessToken
  );
  return res.event_id;
}

/**
 * Tell the room someone is typing.
 *
 * Fire-and-forget by design: a dropped typing notification is not worth
 * failing a request over.
 */
export async function setTyping(
  accessToken: string,
  roomId: string,
  matrixUserId: string,
  typing: boolean,
  timeoutMs = 8000
): Promise<void> {
  await matrixRequest(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(matrixUserId)}`,
    typing ? { typing: true, timeout: timeoutMs } : { typing: false },
    accessToken
  );
}

/** Power levels: what a Matrix room understands about authority. */
export const POWER_LEVELS = {
  owner: 100,
  admin: 75,
  moderator: 50,
  member: 0,
} as const;

/**
 * Grant a user a power level in a room.
 *
 * Power levels live in a single `m.room.power_levels` state event, so raising
 * one user means reading the current state, amending it, and writing it back.
 */
export async function setPowerLevel(
  accessToken: string,
  roomId: string,
  matrixUserId: string,
  level: number
): Promise<void> {
  const current = await matrixRequest<{ users?: Record<string, number> }>(
    "GET",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
    undefined,
    accessToken
  );

  const users = { ...(current?.users ?? {}) };
  if (level <= 0) {
    delete users[matrixUserId];
  } else {
    users[matrixUserId] = level;
  }

  await matrixRequest(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
    { ...current, users },
    accessToken
  );
}

/** Remove someone from a room. They can be re-invited or rejoin if public. */
export async function kickUser(
  accessToken: string,
  roomId: string,
  matrixUserId: string,
  reason?: string
): Promise<void> {
  await matrixRequest(
    "POST",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`,
    reason ? { user_id: matrixUserId, reason } : { user_id: matrixUserId },
    accessToken
  );
}

/** Ban someone from a room. Unlike a kick, this survives rejoin attempts. */
export async function banUser(
  accessToken: string,
  roomId: string,
  matrixUserId: string,
  reason?: string
): Promise<void> {
  await matrixRequest(
    "POST",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/ban`,
    reason ? { user_id: matrixUserId, reason } : { user_id: matrixUserId },
    accessToken
  );
}

export type MatrixMessage = {
  eventId: string;
  sender: string;
  body: string;
  timestamp: number;
};

/** Fetch recent messages from a room (newest first from the API; returned oldest-first). */
export async function getRoomMessages(
  accessToken: string,
  roomId: string,
  limit = 50
): Promise<MatrixMessage[]> {
  const res = await matrixRequest<{
    chunk: Array<{
      type: string;
      event_id: string;
      sender: string;
      origin_server_ts: number;
      content?: { msgtype?: string; body?: string };
    }>;
  }>(
    "GET",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
    undefined,
    accessToken
  );

  return res.chunk
    .filter(e => e.type === "m.room.message" && typeof e.content?.body === "string")
    .map(e => ({
      eventId: e.event_id,
      sender: e.sender,
      body: e.content!.body as string,
      timestamp: e.origin_server_ts,
    }))
    .reverse();
}

/** Liveness check against the homeserver. */
/**
 * Is the homeserver answering right now?
 *
 * **Bounded on purpose.** Without a timeout this hangs whenever the homeserver
 * is starting, half-up, or reachable-but-not-responding — and since /ready
 * calls it, the readiness endpoint hung too. A readiness check that never
 * returns is worse than one that reports a failure: an orchestrator sees a
 * timeout rather than an answer, and an operator watching it learns nothing.
 *
 * Three seconds is well beyond a healthy local response and well under any
 * sensible probe interval.
 */
export async function isHomeserverReachable(timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await matrixRequest("GET", "/_matrix/client/versions", undefined, undefined, {
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
