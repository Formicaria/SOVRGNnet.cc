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
  accessToken?: string
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetchImpl(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
};

/** Register a Matrix account. Falls back to login if it already exists. */
export async function registerOrLogin(appUserId: number): Promise<MatrixCredentials> {
  const username = localpartForUser(appUserId);
  const password = deriveMatrixPassword(appUserId);

  const auth = ENV.matrixRegistrationToken
    ? { type: "m.login.registration_token", token: ENV.matrixRegistrationToken }
    : { type: "m.login.dummy" };

  try {
    const reg = await matrixRequest<{ user_id: string; access_token: string }>(
      "POST",
      "/_matrix/client/v3/register",
      { username, password, auth, inhibit_login: false }
    );
    return { userId: reg.user_id, accessToken: reg.access_token };
  } catch (err) {
    // M_USER_IN_USE → account exists (e.g. token was wiped); log in instead.
    if (err instanceof MatrixError && err.errcode === "M_USER_IN_USE") {
      return await login(username, password);
    }
    throw err;
  }
}

export async function login(username: string, password: string): Promise<MatrixCredentials> {
  const res = await matrixRequest<{ user_id: string; access_token: string }>(
    "POST",
    "/_matrix/client/v3/login",
    {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
    }
  );
  return { userId: res.user_id, accessToken: res.access_token };
}

/** Create a Space (SOVRGNnet "server"). Returns the space room id. */
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
      preset: "public_chat",
      visibility: "public",
      creation_content: { type: "m.space" },
    },
    accessToken
  );
  return res.room_id;
}

/** Create a room (channel) and link it as a child of the space. */
export async function createChannelRoom(
  accessToken: string,
  spaceId: string,
  name: string,
  topic?: string
): Promise<string> {
  const res = await matrixRequest<{ room_id: string }>(
    "POST",
    "/_matrix/client/v3/createRoom",
    { name, topic, preset: "public_chat", visibility: "public" },
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
export async function isHomeserverReachable(): Promise<boolean> {
  try {
    await matrixRequest("GET", "/_matrix/client/versions");
    return true;
  } catch {
    return false;
  }
}
