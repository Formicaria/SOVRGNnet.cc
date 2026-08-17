/**
 * The federation journey — two instances, one room, driven over real HTTP.
 *
 * Run by scripts/e2e-federation.sh in phases, because the harness has work of
 * its own between them (the index splice on instance B, and the shape checks
 * against both databases):
 *
 *   FED_PHASE=setup-a   instance A: first account, community, baseline message
 *   FED_PHASE=join-b    instance B: first account; then a federated invite
 *                       from A's admin and a federated join by B's
 *   FED_PHASE=cross     messages in both directions; both indexes checked for
 *                       both senders — one attributed locally, one federated
 *   FED_PHASE=redact    A's moderator deletes B's message; both indexes agree
 *
 * State crosses phases through a JSON file, because each phase is its own
 * process. Sessions are stateless JWTs, so a phase signs back in with the
 * recorded email and password rather than trying to persist a cookie jar.
 *
 * The transport below is a copy of the one in e2e-journey.ts, deliberately:
 * each harness is self-contained, so a change to one cannot quietly break the
 * other's run. They are small, and they are not clever.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_A = process.env.FED_A_BASE ?? "http://localhost:4101";
const BASE_B = process.env.FED_B_BASE ?? "http://localhost:4102";
const MATRIX_A = process.env.FED_A_MATRIX ?? "http://127.0.0.1:18008";
const MATRIX_B = process.env.FED_B_MATRIX ?? "http://127.0.0.1:28008";
const NAME_A = process.env.FED_A_NAME ?? "matrix-a";
const NAME_B = process.env.FED_B_NAME ?? "matrix-b";
const WORK = process.env.E2E_WORK ?? "/tmp";
const PHASE = process.env.FED_PHASE ?? "setup-a";
const STATE_FILE = join(WORK, "federation-state.json");

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let checks = 0;

function ok(message: string): void {
  checks += 1;
  console.log(`  ${GREEN}✓${RESET} ${message}`);
}

function detail(message: string): void {
  console.log(`    ${DIM}${message}${RESET}`);
}

class JourneyError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JourneyError(message);
}

// ----------------------------------------------------------------- transport

class Session {
  private cookies = new Map<string, string>();

  constructor(
    readonly label: string,
    readonly base: string
  ) {}

  private cookieHeader(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorb(response: Response): void {
    const raw =
      typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get("set-cookie") ?? ""].filter(Boolean);

    for (const entry of raw) {
      const [pair] = entry.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async query<T>(path: string, input?: unknown): Promise<T> {
    const url = new URL(`/api/trpc/${path}`, this.base);
    if (input !== undefined) url.searchParams.set("input", JSON.stringify({ json: input }));
    const response = await fetch(url, { headers: { cookie: this.cookieHeader() } });
    this.absorb(response);
    return unwrap<T>(await response.text(), response.status, `${this.label} GET ${path}`);
  }

  async mutate<T>(path: string, input?: unknown): Promise<T> {
    const response = await fetch(new URL(`/api/trpc/${path}`, this.base), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookieHeader() },
      body: JSON.stringify({ json: input ?? {} }),
    });
    this.absorb(response);
    return unwrap<T>(await response.text(), response.status, `${this.label} POST ${path}`);
  }
}

function unwrap<T>(text: string, status: number, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JourneyError(`${context}: HTTP ${status}, response wasn't JSON — ${text.slice(0, 300)}`);
  }

  const body = parsed as {
    error?: {
      message?: string;
      json?: { message?: string; data?: { code?: string; zodError?: unknown } };
      data?: { code?: string };
    };
    result?: { data?: T | { json?: T } };
  };

  if (body?.error) {
    const err = body.error;
    const message = err.json?.message ?? err.message;
    const code = err.json?.data?.code ?? err.data?.code;
    const zod = err.json?.data?.zodError;
    const parts = [
      `${context}: HTTP ${status}`,
      code ? `[${code}]` : "",
      message ?? "no message in the error body",
      zod ? `\n      ${JSON.stringify(zod).slice(0, 300)}` : "",
    ].filter(Boolean);
    throw new JourneyError(parts.join(" "));
  }

  if (status >= 400) {
    throw new JourneyError(`${context}: HTTP ${status} with no error body — ${text.slice(0, 200)}`);
  }

  const data = body?.result?.data;
  if (data && typeof data === "object" && "json" in (data as Record<string, unknown>)) {
    return (data as { json: T }).json;
  }
  return data as T;
}

// --------------------------------------------------------- matrix, from host

async function matrixCall(
  homeserver: string,
  method: "PUT" | "POST",
  path: string,
  token: string,
  body: unknown,
  context: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`${homeserver}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new JourneyError(`${context}: HTTP ${response.status} — ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Federation is eventually consistent and its first exchange between two
 * fresh homeservers includes key fetches that can fail once and succeed on
 * retry. Nothing here asserts on the first attempt.
 */
async function retryMatrix(
  what: string,
  deadlineMs: number,
  attempt: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs;
  let lastError = "";
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (Date.now() > deadline) break;
      await sleep(2000);
    }
  }
  throw new JourneyError(`${what} never succeeded within ${deadlineMs / 1000}s: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil(what: string, deadlineMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(1000);
  }
  throw new JourneyError(`${what} — still not true after ${deadlineMs / 1000}s`);
}

// ------------------------------------------------------------------- helpers

interface MessageRow {
  id: number;
  userId: number | null;
  senderMatrixId: string | null;
  content: string;
  matrixEventId: string;
}

interface State {
  password: string;
  aliceEmail: string;
  aliceId: number;
  aliceMatrixId: string;
  aliceMatrixToken: string;
  serverIdA: number;
  channelIdA: number;
  roomId: string;
  baselineText: string;
  bobEmail?: string;
  bobId?: number;
  bobMatrixId?: string;
  bobMatrixToken?: string;
  serverIdB?: number;
  bChannelId?: number; // written by the harness after the index splice
  bobText?: string;
  bobEventId?: string;
  aliceText?: string;
}

function readState(): State {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

function writeState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function login(session: Session, email: string, password: string): Promise<void> {
  await session.mutate("auth.login", { email, password });
}

/**
 * clientMatrix and eventIngest come from probes that can race a homeserver
 * still starting; federation is an environment fact. Wait for all three to be
 * advertised rather than asserting into the race.
 */
async function awaitCapabilities(base: string, label: string): Promise<void> {
  let capabilities: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    const instance = (await (await fetch(`${base}/api/instance`)).json()) as {
      capabilities?: Record<string, unknown>;
    };
    capabilities = instance.capabilities ?? {};
    if (
      capabilities.clientMatrix === true &&
      capabilities.eventIngest === true &&
      capabilities.federation === true
    ) {
      ok(`${label} advertises clientMatrix, eventIngest, and federation`);
      return;
    }
    await sleep(500);
  }
  throw new JourneyError(`${label} capabilities never settled: ${JSON.stringify(capabilities)}`);
}

async function mintMatrixSession(
  session: Session,
  displayName: string
): Promise<{ accessToken: string; deviceId: string }> {
  const minted = await session.mutate<{ accessToken: string; deviceId: string }>(
    "matrix.clientSession",
    { displayName }
  );
  assert(
    minted?.accessToken && /^SOVRGN_/.test(minted.deviceId),
    `client session looks wrong: ${JSON.stringify({ ...minted, accessToken: "…" })}`
  );
  return minted;
}

const stamp = Date.now();
const password = "correct-horse-battery-staple";

// -------------------------------------------------------------------- phases

async function setupA(): Promise<void> {
  console.log("\n  Instance A — the room's home");

  const alice = new Session("alice@A", BASE_A);
  const aliceEmail = `alice-${stamp}@fed.local`;
  const aliceUsername = `alice${stamp}`;

  const registered = await alice.mutate<{ id: number; role?: string }>("auth.register", {
    username: aliceUsername,
    email: aliceEmail,
    password,
    name: "Alice",
  });
  assert(registered?.id, `registration returned no id: ${JSON.stringify(registered)}`);
  assert(registered.role === "admin", "the first account on A should be its administrator");
  ok("A's first account registered, and is its administrator");

  const created = await alice.mutate<{
    server: { id: number };
    defaultChannel: { id: number } | null;
  }>("servers.create", {
    name: `Federated community ${stamp}`,
    description: "Created by the federation harness",
  });
  assert(created?.server?.id, `community creation failed: ${JSON.stringify(created)}`);
  const channels = await alice.query<Array<{ id: number; name: string }>>("channels.listByServer", {
    serverId: created.server.id,
  });
  assert(channels.length > 0, "a new community should have a default channel");
  const channel = channels[0];
  ok(`Community and channel exist on A (#${channel.id})`);

  await awaitCapabilities(BASE_A, "A");

  const { matrixRoomId } = await alice.query<{ matrixRoomId: string }>("channels.getById", {
    channelId: channel.id,
  });
  assert(matrixRoomId?.startsWith("!"), `channel has no Matrix room: ${matrixRoomId}`);
  detail(`room ${matrixRoomId}`);

  // Sent before B has any idea the room exists. The cross phase asserts this
  // message *doesn't* appear on B — the index attaches from now on, it does
  // not rewrite history it never saw, and that fact should be stated by a
  // passing test rather than discovered by a confused operator.
  const baselineText = `pre-federation baseline ${stamp}`;
  await alice.mutate("messages.send", { channelId: channel.id, content: baselineText });
  ok("Baseline message sent on A before any federation");

  const minted = await mintMatrixSession(alice, "federation harness (A)");
  ok("Device-scoped Matrix session minted for A's admin");

  writeState({
    password,
    aliceEmail,
    aliceId: registered.id,
    aliceMatrixId: `@${aliceUsername}:${NAME_A}`,
    aliceMatrixToken: minted.accessToken,
    serverIdA: created.server.id,
    channelIdA: channel.id,
    roomId: matrixRoomId,
    baselineText,
  });
}

async function joinB(): Promise<void> {
  console.log("\n  Instance B — a stranger's homeserver");

  const state = readState();
  const bob = new Session("bob@B", BASE_B);
  const bobEmail = `bob-${stamp}@fed.local`;
  const bobUsername = `bob${stamp}`;

  const registered = await bob.mutate<{ id: number; role?: string }>("auth.register", {
    username: bobUsername,
    email: bobEmail,
    password,
    name: "Bob",
  });
  assert(registered?.id, `registration on B failed: ${JSON.stringify(registered)}`);
  ok("B's first account registered");

  // Bob needs a community of his own to host the bridged channel's index row.
  const created = await bob.mutate<{ server: { id: number } }>("servers.create", {
    name: `B's community ${stamp}`,
  });
  assert(created?.server?.id, `community creation on B failed: ${JSON.stringify(created)}`);
  ok("B has its own community");

  await awaitCapabilities(BASE_B, "B");

  const minted = await mintMatrixSession(bob, "federation harness (B)");
  const bobMatrixId = `@${bobUsername}:${NAME_B}`;
  ok(`Device-scoped Matrix session minted for ${bobMatrixId}`);

  // The invite crosses first: A's homeserver must deliver it to B's. Channel
  // rooms are join_rule:restricted on the community space, so an invite is
  // also the honest product path for an outsider — nothing is loosened to
  // make the test pass.
  await retryMatrix("Federated invite from A to B", 90_000, () =>
    matrixCall(
      MATRIX_A,
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(state.roomId)}/invite`,
      state.aliceMatrixToken,
      { user_id: bobMatrixId },
      "invite"
    )
  );
  ok("Invite crossed the federation boundary");

  const joined = await retryMatrix("Federated join by B", 90_000, () =>
    matrixCall(
      MATRIX_B,
      "POST",
      `/_matrix/client/v3/join/${encodeURIComponent(state.roomId)}?server_name=${NAME_A}`,
      minted.accessToken,
      {},
      "join"
    )
  );
  assert(joined.room_id === state.roomId, `join returned the wrong room: ${JSON.stringify(joined)}`);
  ok("B's account joined A's room through its own homeserver");

  writeState({
    ...state,
    bobEmail,
    bobId: registered.id,
    bobMatrixId,
    bobMatrixToken: minted.accessToken,
    serverIdB: created.server.id,
  });
}

async function cross(): Promise<void> {
  console.log("\n  Messages cross");

  const state = readState();
  assert(state.bChannelId, "the harness never recorded B's channel id — the splice step is missing");
  assert(state.bobMatrixToken && state.bobMatrixId && state.bobId, "join-b state is incomplete");

  const alice = new Session("alice@A", BASE_A);
  const bob = new Session("bob@B", BASE_B);
  await login(alice, state.aliceEmail, state.password);
  await login(bob, state.bobEmail!, state.password);

  // B → A. Authored on B's homeserver by B's account; the instance on A only
  // ever hears about it from its own appservice push.
  const bobText = `from B over federation ${stamp}`;
  const sent = await retryMatrix("B's message into the federated room", 60_000, () =>
    matrixCall(
      MATRIX_B,
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(state.roomId)}/send/m.room.message/fed_b_${Date.now()}`,
      state.bobMatrixToken!,
      { msgtype: "m.text", body: bobText },
      "B send"
    )
  );
  const bobEventId = String(sent.event_id ?? "");
  assert(bobEventId.startsWith("$"), `no event id from B's send: ${JSON.stringify(sent)}`);
  ok("B sent through its own homeserver");

  let bobRowOnA: MessageRow | undefined;
  await pollUntil("B's message reaching A's index", 120_000, async () => {
    const rows = await alice.query<MessageRow[]>("messages.listByChannel", {
      channelId: state.channelIdA,
    });
    bobRowOnA = rows.find(r => r.matrixEventId === bobEventId);
    return Boolean(bobRowOnA);
  });
  assert(bobRowOnA!.userId === null, `A should have no local account for B's sender: ${JSON.stringify(bobRowOnA)}`);
  assert(bobRowOnA!.senderMatrixId === state.bobMatrixId, `wrong sender on A: ${JSON.stringify(bobRowOnA)}`);
  ok("A's index recorded it: userId null, sender's Matrix id kept (ADR 0010)");

  let bobRowOnB: MessageRow | undefined;
  await pollUntil("B's message reaching B's own index", 120_000, async () => {
    const rows = await bob.query<MessageRow[]>("messages.listByChannel", {
      channelId: state.bChannelId!,
    });
    bobRowOnB = rows.find(r => r.matrixEventId === bobEventId);
    return Boolean(bobRowOnB);
  });
  assert(bobRowOnB!.userId === state.bobId, `B should attribute its own account: ${JSON.stringify(bobRowOnB)}`);
  ok("B's index attributed the same event to its local account");

  // A → B. Authored through A's ordinary product API — the path every
  // message took before federation existed.
  const aliceText = `from A through the instance ${stamp}`;
  await alice.mutate("messages.send", { channelId: state.channelIdA, content: aliceText });
  ok("A sent through its instance API");

  let aliceRowOnB: MessageRow | undefined;
  await pollUntil("A's message reaching B's index", 120_000, async () => {
    const rows = await bob.query<MessageRow[]>("messages.listByChannel", {
      channelId: state.bChannelId!,
    });
    aliceRowOnB = rows.find(r => r.content === aliceText);
    return Boolean(aliceRowOnB);
  });
  assert(aliceRowOnB!.userId === null, `B should have no local account for A's sender: ${JSON.stringify(aliceRowOnB)}`);
  assert(
    aliceRowOnB!.senderMatrixId === state.aliceMatrixId,
    `wrong sender on B: ${JSON.stringify(aliceRowOnB)}`
  );
  ok("B's index recorded A's sender as a federated Matrix id");

  // The baseline message predates B's membership. It must not have appeared:
  // attaching to a room indexes it from now on, and a test that passed while
  // history silently backfilled would be describing a different feature.
  const rowsOnB = await bob.query<MessageRow[]>("messages.listByChannel", {
    channelId: state.bChannelId!,
  });
  assert(
    !rowsOnB.some(r => r.content === state.baselineText),
    "A's pre-federation message appeared on B — the index is claiming history it never received"
  );
  ok("No invented history: B's index starts at the join, and says so");

  writeState({ ...state, bobText, bobEventId, aliceText });
}

async function redact(): Promise<void> {
  console.log("\n  Moderation crosses");

  const state = readState();
  assert(state.bobEventId && state.bChannelId, "cross-phase state is incomplete");

  const alice = new Session("alice@A", BASE_A);
  const bob = new Session("bob@B", BASE_B);
  await login(alice, state.aliceEmail, state.password);
  await login(bob, state.bobEmail!, state.password);

  // The row A holds for B's message has userId null — there are no local
  // credentials to redact with. This is exactly the path ADR 0010 specified:
  // the moderator's own session redacts, and room-layer power levels decide.
  const rows = await alice.query<MessageRow[]>("messages.listByChannel", {
    channelId: state.channelIdA,
  });
  const target = rows.find(r => r.matrixEventId === state.bobEventId);
  assert(target, "B's message vanished from A before the redaction test ran");
  await alice.mutate("messages.delete", { messageId: target!.id });
  ok("A's moderator deleted the federated sender's message");

  await pollUntil("the redaction clearing A's index", 60_000, async () => {
    const after = await alice.query<MessageRow[]>("messages.listByChannel", {
      channelId: state.channelIdA,
    });
    return !after.some(r => r.matrixEventId === state.bobEventId);
  });
  ok("Gone from A's index");

  await pollUntil("the redaction crossing to B's index", 120_000, async () => {
    const after = await bob.query<MessageRow[]>("messages.listByChannel", {
      channelId: state.bChannelId!,
    });
    return !after.some(r => r.matrixEventId === state.bobEventId);
  });
  ok("Gone from B's index — the redaction federated and both sides agree");

  // What must have survived: the conversation around it.
  const survivors = await bob.query<MessageRow[]>("messages.listByChannel", {
    channelId: state.bChannelId!,
  });
  assert(
    survivors.some(r => r.content === state.aliceText),
    "the redaction took an unrelated message with it"
  );
  ok("Only the redacted message went");
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  try {
    if (PHASE === "setup-a") await setupA();
    else if (PHASE === "join-b") await joinB();
    else if (PHASE === "cross") await cross();
    else if (PHASE === "redact") await redact();
    else throw new JourneyError(`Unknown phase: ${PHASE}`);

    console.log(`\n  ${GREEN}${checks} checks passed${RESET}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ${RED}✗ ${message}${RESET}\n`);
    process.exit(1);
  }
}

void main();
