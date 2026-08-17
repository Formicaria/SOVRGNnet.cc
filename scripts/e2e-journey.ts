/**
 * The user journey, driven through the real HTTP API.
 *
 * No mocks, no test doubles, no direct database access. Everything below goes
 * over the wire exactly as a browser would send it, against a real Postgres, a
 * real Dendrite, and a real Kubo. That is the entire point: the unit suite
 * already proves the logic, and every bug that has destroyed data in this
 * project lived in code no test had ever executed.
 *
 * Run by scripts/e2e.sh. Two modes:
 *
 *   (default)        run the journey and record what it created
 *   verify-restore   check that what it created is still there
 *
 * The second mode runs after the schema has been dropped and restored, so it
 * is what makes "the backup works" a claim rather than a hope.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:3999";
const WORK = process.env.E2E_WORK ?? "/tmp";
const MODE = process.env.E2E_MODE ?? "journey";
const STATE_FILE = join(WORK, "journey-state.json");

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new JourneyError(
      `${message}\n      expected: ${expected}\n      actual:   ${actual}`
    );
  }
}

// ----------------------------------------------------------------- transport

/** One user's session. Cookies are kept per-user so two users can act at once. */
class Session {
  private cookies = new Map<string, string>();

  constructor(readonly label: string) {}

  private cookieHeader(): string {
    // Array.from rather than spreading the Map: the root tsconfig targets a
    // low ES level, and iterating a Map directly needs downlevelIteration.
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join(
      "; "
    );
  }

  private absorb(response: Response): void {
    // Node exposes multiple Set-Cookie headers through getSetCookie().
    const raw =
      typeof (response.headers as { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get("set-cookie") ?? ""].filter(Boolean);

    for (const entry of raw) {
      const [pair] = entry.split(";");
      const index = pair.indexOf("=");
      if (index > 0)
        this.cookies.set(
          pair.slice(0, index).trim(),
          pair.slice(index + 1).trim()
        );
    }
  }

  async query<T>(path: string, input?: unknown): Promise<T> {
    const url = new URL(`/api/trpc/${path}`, BASE);
    // The server configures superjson as its tRPC transformer, so everything
    // on the wire is wrapped in { json: ... }. Sending raw input means the
    // procedure receives undefined and fails validation — and the error comes
    // back wrapped too, which is why this first surfaced as "unknown error"
    // rather than as anything diagnosable.
    if (input !== undefined)
      url.searchParams.set("input", JSON.stringify({ json: input }));

    const response = await fetch(url, {
      headers: { cookie: this.cookieHeader() },
    });
    this.absorb(response);
    return unwrap<T>(
      await response.text(),
      response.status,
      `${this.label} GET ${path}`
    );
  }

  async mutate<T>(path: string, input?: unknown): Promise<T> {
    const response = await fetch(new URL(`/api/trpc/${path}`, BASE), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: this.cookieHeader(),
      },
      body: JSON.stringify({ json: input ?? {} }),
    });
    this.absorb(response);
    return unwrap<T>(
      await response.text(),
      response.status,
      `${this.label} POST ${path}`
    );
  }

  /** Expect a call to be refused. Returns the message, so it can be asserted on. */
  async expectDenied(
    path: string,
    input: unknown,
    what: string
  ): Promise<string> {
    try {
      await this.mutate(path, input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new JourneyError(`${what} was allowed, and should not have been.`);
  }

  /**
   * Upload takes the raw bytes as the body, with channelId and filename as
   * query parameters — not multipart/form-data.
   *
   * tRPC is the wrong tool for moving bytes, so these two routes are plain
   * REST and shaped accordingly: express.raw on the body, everything else on
   * the query string.
   */
  async upload(
    channelId: number,
    filename: string,
    bytes: Buffer
  ): Promise<unknown> {
    const url = new URL("/api/upload", BASE);
    url.searchParams.set("channelId", String(channelId));
    url.searchParams.set("filename", filename);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        cookie: this.cookieHeader(),
        // Stored as the share's mimeType, so send something honest.
        "content-type": "text/plain",
      },
      body: new Uint8Array(bytes),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new JourneyError(
        `${this.label} upload failed (${response.status}): ${text.slice(0, 300)}`
      );
    }
    return JSON.parse(text);
  }

  async download(cid: string): Promise<Buffer> {
    const response = await fetch(new URL(`/api/files/${cid}`, BASE), {
      headers: { cookie: this.cookieHeader() },
    });
    if (!response.ok) {
      throw new JourneyError(
        `${this.label} download failed (${response.status})`
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

/**
 * Read a tRPC response, superjson-wrapped or not.
 *
 * Deliberately thorough about errors. The first version reported "unknown
 * error" for every failure, because it looked for `error.message` and superjson
 * puts it at `error.json.message`. A harness whose diagnostics are wrong costs
 * more than one that doesn't exist — it sends you looking in the wrong place.
 */
function unwrap<T>(text: string, status: number, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JourneyError(
      `${context}: HTTP ${status}, response wasn't JSON — ${text.slice(0, 300)}`
    );
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
    // Zod failures are the common case when the wire format is wrong, and the
    // detail is what tells you which field.
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
    throw new JourneyError(
      `${context}: HTTP ${status} with no error body — ${text.slice(0, 200)}`
    );
  }

  const data = body?.result?.data;
  // superjson nests the payload one level deeper.
  if (
    data &&
    typeof data === "object" &&
    "json" in (data as Record<string, unknown>)
  ) {
    return (data as { json: T }).json;
  }
  return data as T;
}

const stamp = Date.now();

// ------------------------------------------------------------------- journey

async function runJourney(): Promise<void> {
  const owner = new Session("owner");
  const guest = new Session("guest");

  const ownerEmail = `owner-${stamp}@e2e.local`;
  const guestEmail = `guest-${stamp}@e2e.local`;
  // Separate from the email local part on purpose: the two are independent
  // identifiers now, and reusing one for the other would hide it if the server
  // ever started deriving a username from an address again.
  const ownerUsername = `owner${stamp}`;
  const guestUsername = `guest${stamp}`;
  const password = "correct-horse-battery-staple";

  // -- accounts -------------------------------------------------------------

  console.log("\n  Accounts");

  // auth.register returns the user object *flat* — toPublicUser(user), not
  // { user }. Shapes here are read off the router rather than assumed; guessing
  // costs a full stack boot per mistake.
  // The bootstrap is gated on a secret only the operator has, because the
  // first account becomes the administrator and a server is usually reachable
  // before its owner has signed up. Asserted from both sides.
  const setupToken = process.env.E2E_SETUP_TOKEN ?? "";
  assert(setupToken, "the harness didn't provide a setup token");

  // Both refusals assert on the *reason*, not just that they were refused.
  //
  // An instance whose token never reached the container refuses everything
  // with "no setup token is configured" — including these two, which would
  // then pass while proving nothing about the gate and while the real
  // registration below was about to fail. That happened on the first run of
  // this check, so the assertions now reject that message explicitly.
  const notConfigured = /no setup token/i;

  const withoutToken = await new Session("stranger").expectDenied(
    "auth.register",
    {
      username: `stranger${stamp}`,
      email: `stranger-${stamp}@e2e.local`,
      password,
      name: "Stranger",
    },
    "Claiming a fresh instance without the setup code"
  );
  assert(
    !notConfigured.test(withoutToken),
    `the instance has no setup token configured, so this proved nothing: ${withoutToken}`
  );
  detail(withoutToken.slice(0, 90));
  ok("A stranger can't claim the instance's first account");

  const wrongToken = await new Session("stranger").expectDenied(
    "auth.register",
    {
      username: `stranger2${stamp}`,
      email: `stranger2-${stamp}@e2e.local`,
      password,
      name: "Stranger",
      setupToken: "definitely-not-the-token",
    },
    "Claiming a fresh instance with a guessed setup code"
  );
  assert(
    !notConfigured.test(wrongToken),
    `refused for the wrong reason: ${wrongToken}`
  );
  assert(
    /setup code/i.test(wrongToken),
    `refused, but not for the setup code: ${wrongToken}`
  );
  detail(wrongToken.slice(0, 90));
  ok("A guessed setup code doesn't work either");

  const registered = await owner.mutate<{ id: number; role?: string }>(
    "auth.register",
    {
      username: ownerUsername,
      email: ownerEmail,
      password,
      name: "Owner",
      setupToken,
    }
  );
  assert(
    registered?.id,
    `registration returned no id: ${JSON.stringify(registered)}`
  );
  ok("First account registered, with the setup code");

  const me = await owner.query<{ role?: string; email?: string }>("auth.me");
  assertEqual(me?.email, ownerEmail, "auth.me returned the wrong account");
  // The installer promises this, and it was broken once: adminProcedure
  // checked for the role and nothing ever assigned it.
  assertEqual(
    me?.role,
    "admin",
    "the first account should be the instance admin"
  );
  ok("First account is the administrator");

  // Default join policy is invite-only, so a second signup must be refused.
  const denied = await guest.expectDenied(
    "auth.register",
    { username: guestUsername, email: guestEmail, password, name: "Guest" },
    "Open registration on an invite-only instance"
  );
  detail(denied.slice(0, 90));
  ok("Invite-only policy is enforced, not just advertised");

  // -- community ------------------------------------------------------------

  console.log("\n  Community");

  // servers.create returns { server, defaultChannel }, not a flat server.
  const created = await owner.mutate<{
    server: { id: number; name: string };
    defaultChannel: { id: number; name: string } | null;
  }>("servers.create", {
    name: `E2E community ${stamp}`,
    description: "Created by the end-to-end harness",
  });
  const community = created?.server;
  assert(
    community?.id,
    `community creation returned no server: ${JSON.stringify(created)}`
  );
  ok(`Community created (#${community.id})`);

  // Listed rather than taken from the create response, so this exercises the
  // read path too — and confirms the default channel was really persisted.
  const channels = await owner.query<Array<{ id: number; name: string }>>(
    "channels.listByServer",
    { serverId: community.id }
  );
  assert(
    channels.length > 0,
    `a new community should have a default channel: ${JSON.stringify(channels)}`
  );
  const channel = channels[0];
  ok(`Default channel exists (#${channel.id} ${channel.name})`);

  // -- capabilities ----------------------------------------------------------
  //
  // Read before anything depends on them, because on a capable instance the
  // *default* is encryption and that changes what the rest of this journey may
  // legitimately expect. clientMatrix comes from a reachability probe, and the
  // boot-time probe can land while Dendrite is still starting; a cached
  // negative expires within seconds, so wait for the truth to settle rather
  // than racing it.
  let capabilities: {
    clientMatrix?: boolean;
    eventIngest?: boolean;
    e2ee?: boolean;
  } = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    const instance = (await (await fetch(`${BASE}/api/instance`)).json()) as {
      capabilities?: typeof capabilities;
    };
    capabilities = instance.capabilities ?? {};
    if (capabilities.clientMatrix === true && capabilities.eventIngest === true)
      break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const encryptedByDefault = capabilities.e2ee === true;

  // -- messages -------------------------------------------------------------

  console.log("\n  Messages");

  const channelState = await owner.query<{ encrypted: boolean }>(
    "channels.getById",
    { channelId: channel.id }
  );
  assertEqual(
    channelState.encrypted,
    encryptedByDefault,
    encryptedByDefault
      ? "a capable instance must create channels encrypted"
      : "an instance that can't offer e2ee must not mark channels encrypted"
  );
  ok(
    encryptedByDefault
      ? "Default channel was created encrypted, without being asked"
      : "Default channel is plaintext — this instance can't offer encryption"
  );

  const text = `hello from e2e ${stamp}`;
  // Whichever message the owner ends up with, for the restore check to look
  // for later. The two paths produce it differently.
  let ownerMessage = text;

  if (encryptedByDefault) {
    // The API composes plaintext server-side, so on an encrypted channel it
    // has nothing to offer but the thing that would undermine the encryption
    // for everyone in it. Refusing is the security property, so it is what
    // gets asserted.
    const refusedSend = await owner.expectDenied(
      "messages.send",
      { channelId: channel.id, content: text },
      "Sending plaintext through the API into an encrypted channel"
    );
    // Asserting on the reason, not just the refusal. A denial for some other
    // cause would pass a bare expectDenied and prove nothing about encryption.
    assert(
      /encrypted/i.test(refusedSend),
      `refused, but not for being encrypted: ${refusedSend}`
    );
    detail(refusedSend.slice(0, 90));
    ok("The API refuses to send plaintext into an encrypted channel");
  } else {
    const sent = await owner.mutate<{ id: number }>("messages.send", {
      channelId: channel.id,
      content: text,
    });
    assert(sent?.id, `sending returned no message: ${JSON.stringify(sent)}`);
    ok("Message sent through the real homeserver");

    const listed = await owner.query<Array<{ id: number; content: string }>>(
      "messages.listByChannel",
      { channelId: channel.id }
    );
    assert(
      listed.some(m => m.content === text),
      "the message just sent didn't come back"
    );
    ok("Message reads back");

    const edited = `${text} (edited)`;
    await owner.mutate("messages.edit", {
      messageId: sent.id,
      content: edited,
    });
    const afterEdit = await owner.query<Array<{ id: number; content: string }>>(
      "messages.listByChannel",
      { channelId: channel.id }
    );
    assert(
      afterEdit.some(m => m.id === sent.id && m.content === edited),
      "the edit didn't take"
    );
    ok("Message edited");
    ownerMessage = edited;
  }

  // -- client-authored events (ADR 0008 stage 3 + ADR 0009) ------------------
  // The full loop nothing else exercises: the client obtains its own Matrix
  // session, sends an event straight to the homeserver — the instance never
  // sees the request — and the appservice push writes it into the index.
  //
  // On an encrypted instance these events are plaintext `m.room.message` in a
  // room whose members' clients would send Megolm. That is deliberate and it
  // is the harness's limitation, not the product's: driving real Olm needs a
  // browser, and this runs in Node. What it does verify — that an event the
  // instance never saw reaches the index, and survives a restore — is
  // orthogonal to whether the payload was encrypted.

  console.log("\n  Client-authored events");
  assert(
    capabilities.clientMatrix === true,
    `clientMatrix should be true in the harness: ${JSON.stringify(capabilities)}`
  );
  assert(
    capabilities.eventIngest === true,
    `eventIngest should be true in the harness: ${JSON.stringify(capabilities)}`
  );
  ok("Capabilities advertise direct sync and ingest");

  const session = await owner.mutate<{
    homeserverUrl: string;
    matrixUserId: string;
    accessToken: string;
    deviceId: string;
  }>("matrix.clientSession", { displayName: "e2e journey" });
  assert(
    session?.accessToken && /^SOVRGN_/.test(session.deviceId),
    `client session looks wrong: ${JSON.stringify({ ...session, accessToken: "…" })}`
  );
  ok("Device-scoped client session minted");

  // The Matrix ID is the username (#31), checked against the real homeserver
  // rather than against our own derivation function.
  //
  // The `@sovrgn_` half of this matters as much as the positive assertion. That
  // was the old scheme, and it was also the appservice namespace regex — an
  // instance left on the stale pattern keeps working while eventIngest silently
  // stops receiving anything, which is the failure this whole harness exists to
  // refuse to ship.
  assertEqual(
    session.matrixUserId,
    `@${ownerUsername}:e2e.local`,
    "the Matrix ID isn't derived from the username"
  );
  assert(
    !session.matrixUserId.includes("sovrgn_"),
    `MXID still uses the old opaque scheme: ${session.matrixUserId}`
  );
  ok("Matrix ID is the username, not an opaque id");

  // The advertised URL is the in-network address; from the host the same
  // homeserver is the published port. The journey knows the topology.
  const homeserver = process.env.E2E_MATRIX ?? "http://127.0.0.1:8008";
  const channelInfo = await owner.query<{ matrixRoomId: string }>(
    "channels.getById",
    { channelId: channel.id }
  );
  const direct = `authored by the client ${stamp}`;
  const put = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(
      channelInfo.matrixRoomId
    )}/send/m.room.message/e2e_${Date.now()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ msgtype: "m.text", body: direct }),
    }
  );
  assert(put.ok, `direct send to the homeserver failed: HTTP ${put.status}`);
  ok("Event sent directly to the homeserver, instance not involved");

  // The appservice push is asynchronous; poll briefly rather than assuming.
  let ingested = false;
  for (let attempt = 0; attempt < 20 && !ingested; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const rows = await owner.query<Array<{ content: string }>>(
      "messages.listByChannel",
      { channelId: channel.id }
    );
    ingested = rows.some(m => m.content === direct);
  }
  assert(
    ingested,
    "the directly-sent event never appeared in the index — the appservice push isn't reaching the instance"
  );
  ok("Ingest recorded it — the database is an index of Matrix, demonstrated");

  if (encryptedByDefault) {
    // On this path the API never sent anything, so this is the owner's only
    // message and the one the restore check has to find.
    ownerMessage = direct;
  }

  if (encryptedByDefault) {
    // Now there is a real message in an encrypted channel, owned by the
    // caller, so the edit refusal can be asserted against a row that exists.
    // Doing it earlier against a made-up id would have been refused as
    // "message not found" and proved nothing.
    const rows = await owner.query<Array<{ id: number; content: string }>>(
      "messages.listByChannel",
      { channelId: channel.id }
    );
    const mine = rows.find(m => m.content === direct);
    assert(mine, "the client-authored message isn't in the index to edit");

    const refusedEdit = await owner.expectDenied(
      "messages.edit",
      { messageId: mine.id, content: `${direct} (edited)` },
      "Editing through the API in an encrypted channel"
    );
    assert(
      /encrypted/i.test(refusedEdit),
      `refused, but not for being encrypted: ${refusedEdit}`
    );
    detail(refusedEdit.slice(0, 90));
    // The sharper of the two refusals: an edit would have written the new text
    // into a row the instance is supposed to hold content-blind.
    ok("The API refuses to edit in an encrypted channel");
  }

  // -- cross-signing through the instance (ADR 0011, decision 2) -------------
  //
  // The load-bearing assumption of stage 4's cross-signing flow, checked
  // against the homeserver that has to honour it.
  //
  // Uploading cross-signing keys is user-interactive-auth gated, and this
  // instance's Matrix passwords are derived, so the instance knows them and
  // the browser doesn't. Rather than hand the password to a web page — it is
  // permanent, unrotatable, and authorises everything — the client starts the
  // flow, receives a UIA session id, asks the instance to satisfy that one
  // stage, then re-submits carrying only the session id.
  //
  // That only works if the homeserver records a completed stage against the
  // session rather than against the request. The spec is written that way and
  // it is how the SSO stage can be satisfied in a different window, but it is
  // an assumption about Dendrite's implementation and nothing else in this
  // repository would notice if it were wrong. Everything about stage 4's
  // identity story rests on it, so it is checked here rather than believed.
  //
  // Real Ed25519, no crypto library: a master cross-signing key is a public
  // key and needs no signature — only the self- and user-signing keys have to
  // be signed by it, and uploading a master key alone is enough to prove the
  // authentication path. The keys are generated in this process and thrown
  // away with the stack.

  console.log("\n  Cross-signing auth (ADR 0011)");

  const uploadUrl = `${homeserver}/_matrix/client/v3/keys/device_signing/upload`;
  const uploadHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  };

  const unauthenticated = await fetch(uploadUrl, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({}),
  });

  if (unauthenticated.status !== 401) {
    // A homeserver that doesn't gate this endpoint makes the whole dance
    // unnecessary — the SDK's first attempt simply succeeds. Worth saying out
    // loud rather than passing silently, because it means this run proved
    // less than it looks like it did.
    // Dendrite is this case. It doesn't gate the endpoint, so the client's
    // first attempt succeeds and the proxy path never runs. Said plainly
    // rather than ticked, because this run has *not* tested ADR 0011's
    // assumption — it has established that this homeserver never asks.
    detail(
      `homeserver answered ${unauthenticated.status}, not 401 — this homeserver ` +
        `doesn't gate device-signing upload`
    );
    detail(
      "ADR 0011's session-vs-request assumption is untested here; it needs a " +
        "homeserver that requires UIA, such as Synapse"
    );
    ok("Device-signing upload needs no interactive auth on this homeserver");
  } else {
    const challenge = (await unauthenticated.json()) as {
      session?: string;
      flows?: Array<{ stages?: string[] }>;
    };
    assert(
      typeof challenge.session === "string" && challenge.session.length > 0,
      `the 401 carried no UIA session: ${JSON.stringify(challenge).slice(0, 200)}`
    );
    const stages = (challenge.flows ?? []).flatMap(flow => flow.stages ?? []);
    assert(
      stages.includes("m.login.password"),
      `no password stage to satisfy; flows were ${JSON.stringify(challenge.flows)}`
    );
    ok(`Upload is UIA-gated, session issued (${stages.join(", ")})`);

    // The instance satisfies the password stage. The derived password never
    // enters this process, exactly as it never enters a browser.
    const completed = await owner.mutate<{ completed: boolean }>(
      "matrix.completeCrossSigningAuth",
      { session: challenge.session }
    );
    assert(
      completed?.completed === true,
      `the instance couldn't complete the stage: ${JSON.stringify(completed)}`
    );
    ok("Instance satisfied the password stage, browser never saw the password");

    const { publicKey } = generateKeyPairSync("ed25519");
    // SPKI for Ed25519 is a 12-byte header followed by the 32-byte key.
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
    const encoded = raw.toString("base64").replace(/=+$/, "");

    const resubmitted = await fetch(uploadUrl, {
      method: "POST",
      headers: uploadHeaders,
      body: JSON.stringify({
        // Only the session id. No password, no identifier — the stage it
        // refers to is already satisfied, and if the homeserver disagreed
        // this is where stage 4's design would fall over.
        auth: { session: challenge.session },
        master_key: {
          user_id: session.matrixUserId,
          usage: ["master"],
          keys: { [`ed25519:${encoded}`]: encoded },
        },
      }),
    });

    if (resubmitted.status === 401) {
      const body = await resubmitted.text();
      throw new JourneyError(
        "The homeserver rejected a re-submission carrying only the UIA session id.\n" +
          "      ADR 0011 decision 2 assumes a completed stage is recorded against the\n" +
          "      session, not the request. On this homeserver it is not, so cross-signing\n" +
          "      setup cannot work without giving the browser the derived password.\n" +
          `      response: ${body.slice(0, 200)}`
      );
    }
    assert(
      resubmitted.ok,
      `re-submission failed: HTTP ${resubmitted.status} ${(await resubmitted.text()).slice(0, 200)}`
    );
    ok(
      "Re-submission with only the session id was accepted — the design holds"
    );

    // And the key is really there, which is the difference between "the
    // request was accepted" and "the upload happened".
    const queried = await fetch(`${homeserver}/_matrix/client/v3/keys/query`, {
      method: "POST",
      headers: uploadHeaders,
      body: JSON.stringify({ device_keys: { [session.matrixUserId]: [] } }),
    });
    assert(queried.ok, `key query failed: HTTP ${queried.status}`);
    const keys = (await queried.json()) as {
      master_keys?: Record<string, { keys?: Record<string, string> }>;
    };
    const master = keys.master_keys?.[session.matrixUserId]?.keys ?? {};
    assert(
      Object.values(master).includes(encoded),
      "the master key isn't in /keys/query — the upload was accepted but not stored"
    );
    ok("Master key readable back from the homeserver");
  }

  // -- files ----------------------------------------------------------------

  console.log("\n  Files");

  const payload = Buffer.from(`e2e file contents ${stamp}\n`.repeat(64));
  const uploaded = (await owner.upload(channel.id, "e2e.txt", payload)) as {
    ipfsHash?: string;
    cid?: string;
  };
  const cid = uploaded.ipfsHash ?? uploaded.cid;
  assert(
    cid,
    `upload returned no CID: ${JSON.stringify(uploaded).slice(0, 160)}`
  );
  ok(`Uploaded and pinned (${String(cid).slice(0, 16)}…)`);

  const fetched = await owner.download(String(cid));
  assert(
    fetched.equals(payload),
    "the file that came back isn't the file that went up"
  );
  ok("Downloaded, byte-for-byte identical");

  // -- invite ---------------------------------------------------------------

  console.log("\n  Invites and membership");

  const invite = await owner.mutate<{ code: string }>("servers.createInvite", {
    serverId: community.id,
  });
  assert(invite?.code, `no invite code returned: ${JSON.stringify(invite)}`);
  ok("Invite created");

  const guestUser = await guest.mutate<{ id: number; role?: string }>(
    "auth.register",
    {
      username: guestUsername,
      email: guestEmail,
      password,
      name: "Guest",
      inviteCode: invite.code,
    }
  );
  assert(
    guestUser?.id,
    `invited registration failed: ${JSON.stringify(guestUser)}`
  );
  // Only the first account is admin. A second must not inherit it.
  assert(guestUser.role !== "admin", "the second account must not be an admin");
  ok("Second account registered via invite, without admin");

  const beforeJoin = await guest.expectDenied(
    "messages.send",
    { channelId: channel.id, content: "should not work" },
    "Posting to a community the user hasn't joined"
  );
  // Refused for *membership*, not for encryption. The two checks sit in the
  // same procedure and the encryption one used to run first, which would have
  // made this assertion pass without membership ever being consulted — and a
  // stranger would have learned the channel is encrypted, which is more than
  // they should know about a channel they can't see.
  assert(
    /member/i.test(beforeJoin),
    `refused, but not for membership: ${beforeJoin}`
  );
  detail(beforeJoin.slice(0, 90));
  ok("Non-members can't post, and are told why that is");

  await guest.mutate("servers.joinByInvite", { code: invite.code });
  ok("Joined by invite");

  const guestMessage = `guest ${stamp}`;
  if (encryptedByDefault) {
    // A second author, over their own session, so the restore check below
    // proves two different people's messages survived rather than one.
    const guestSession = await guest.mutate<{
      accessToken: string;
      deviceId: string;
    }>("matrix.clientSession", { displayName: "e2e journey guest" });
    const put = await fetch(
      `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(
        channelInfo.matrixRoomId
      )}/send/m.room.message/e2e_guest_${Date.now()}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${guestSession.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msgtype: "m.text", body: guestMessage }),
      }
    );
    assert(put.ok, `guest direct send failed: HTTP ${put.status}`);

    let seen = false;
    for (let attempt = 0; attempt < 20 && !seen; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const rows = await guest.query<Array<{ content: string }>>(
        "messages.listByChannel",
        { channelId: channel.id }
      );
      seen = rows.some(m => m.content === guestMessage);
    }
    assert(
      seen,
      "the guest's directly-authored message never reached the index"
    );
    ok("Members can post, over their own Matrix session");
  } else {
    await guest.mutate("messages.send", {
      channelId: channel.id,
      content: guestMessage,
    });
    ok("Members can post");
  }

  // -- permissions ----------------------------------------------------------

  console.log("\n  Permissions");

  const escalation = await guest.expectDenied(
    "serverMembers.setRole",
    { serverId: community.id, userId: registered.id, role: "member" },
    "A member demoting the owner"
  );
  detail(escalation.slice(0, 90));
  ok("A member can't act on the owner");

  const selfPromote = await guest.expectDenied(
    "serverMembers.setRole",
    { serverId: community.id, userId: guestUser.id, role: "admin" },
    "A member promoting themselves"
  );
  detail(selfPromote.slice(0, 90));
  ok("Nobody grants themselves a role at or above their own");

  // -- devices --------------------------------------------------------------

  console.log("\n  Matrix sessions");

  const devices =
    await owner.query<Array<{ deviceId: string; isServer: boolean }>>(
      "profile.devices"
    );
  assert(
    devices.length > 0,
    `no Matrix devices listed: ${JSON.stringify(devices)}`
  );
  const serverDevice = devices.find(d => d.isServer);
  assert(
    serverDevice,
    `the instance's own session should appear, flagged: ${JSON.stringify(devices)}`
  );
  ok(`${devices.length} session(s), server's own shown and flagged`);

  const refusal = await owner.expectDenied(
    "profile.signOutDevice",
    { deviceId: serverDevice.deviceId },
    "Signing out the server's own session"
  );
  detail(refusal.slice(0, 90));
  ok("The server's own session can't be signed out from here");

  // -- renaming (#33, ADR 0012) ---------------------------------------------

  // Last, deliberately: this changes the owner's identity, and every step above
  // reads it. Running it earlier would make a failure here look like a failure
  // there.
  console.log("\n  Renaming");

  const renamedTo = `renamed${stamp}`;

  const preview = await owner.query<{
    ok: boolean;
    available?: boolean;
    consequences?: Array<{ headline: string; detail: string }>;
  }>("auth.renamePreview", { username: renamedTo });
  assert(preview?.ok && preview.available, `rename preview refused: ${JSON.stringify(preview)}`);

  // The disclosure has to name the address that is staying behind. A unit test
  // covers the function; this covers the wire, because a warning that never
  // reaches the client is the same as no warning.
  const disclosure = (preview.consequences ?? [])
    .map(c => `${c.headline} ${c.detail}`)
    .join(" ");
  assert(
    disclosure.includes(session.matrixUserId),
    `the rename preview didn't name the Matrix ID: ${disclosure}`
  );
  ok("Rename preview states the Matrix address that won't change");

  await owner.mutate("auth.changeUsername", {
    username: renamedTo,
    acknowledgedMatrixId: true,
  });
  const renamedMe = await owner.query<{ username?: string }>("auth.me");
  assertEqual(renamedMe?.username, renamedTo, "the rename didn't take");
  ok(`Renamed to @${renamedTo}`);

  // The regression this task existed to fix. Three call sites used to rebuild
  // the localpart from the *current* username, so the first rename made them
  // log into an account that was never registered — and Dendrite answers
  // M_FORBIDDEN, which reads as a broken Matrix account rather than a stale
  // derivation. Minting a session is the cheapest way to prove that path is
  // still sound, and it only means anything against a real homeserver.
  const afterRename = await owner.mutate<{ matrixUserId: string }>(
    "matrix.clientSession",
    { displayName: "e2e journey (after rename)" }
  );
  ok("A device can still log in to Matrix after the rename");

  // And the property the ADR is about: Matrix has no rename, so the address is
  // the one it was registered with. If this ever changes, the disclosure shown
  // to people is wrong and ADR 0012 needs revisiting — not this assertion
  // relaxing.
  assertEqual(
    afterRename.matrixUserId,
    session.matrixUserId,
    "the Matrix ID moved on rename — ADR 0012 says it cannot"
  );
  assert(
    !afterRename.matrixUserId.includes(renamedTo),
    `MXID picked up the new name: ${afterRename.matrixUserId}`
  );
  ok(`Matrix ID unchanged: ${afterRename.matrixUserId}`);

  // Sign-in follows the username, both ways round.
  await owner.mutate("auth.login", { username: renamedTo, password });
  ok("Signing in with the new username works");

  const oldNameRefused = await owner.expectDenied(
    "auth.login",
    { username: ownerUsername, password },
    "Signing in with the old username"
  );
  detail(oldNameRefused.slice(0, 90));
  ok("The old username no longer signs in");

  // Put it back, so the restore check and anything reading the state file see
  // the account it recorded.
  await owner.mutate("auth.changeUsername", {
    username: ownerUsername,
    acknowledgedMatrixId: true,
  });
  await owner.mutate("auth.login", { username: ownerUsername, password });
  ok("Renamed back; the old name was free again");

  // -- record for the restore check -----------------------------------------

  mkdirSync(WORK, { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        // Username first: it is the identity column, and it is the only
        // credential every account is guaranteed to have. Email is optional
        // since #29, so anything that reads ownerEmail to sign in works only
        // for accounts that happen to have one — which is why the browser-test
        // instructions now quote the username.
        ownerUsername,
        guestUsername,
        ownerEmail,
        guestEmail,
        password,
        communityId: community.id,
        communityName: community.name,
        channelId: channel.id,
        messageText: ownerMessage,
        guestMessage,
        cid: String(cid),
        fileBytes: payload.length,
      },
      null,
      2
    )
  );
}

// ----------------------------------------------------- after a restore

async function verifyRestore(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const owner = new Session("owner");

  console.log("\n  After restore");

  // Signing in at all proves accounts and password hashes came back.
  //
  // By username, because that is the identity column and the one field every
  // account has. This used to sign in by email, which passed only because the
  // journey happens to give its accounts one — on an instance where people
  // took "email (optional)" at its word, the restore check would have been
  // testing a path most accounts cannot use.
  await owner.mutate("auth.login", {
    username: state.ownerUsername,
    password: state.password,
  });
  ok("The account still exists and the password still works");

  // And the email path, once, deliberately. It is still supported and still
  // worth a check — it just should not be the only way the harness knows how
  // to sign in. Skipped rather than failed when there is no address, so this
  // assertion cannot become the reason a no-email instance goes red.
  if (state.ownerEmail) {
    await owner.mutate("auth.login", {
      email: state.ownerEmail,
      password: state.password,
    });
    ok("Signing in by email still works too");
  }

  const me = await owner.query<{ role?: string }>("auth.me");
  assertEqual(
    me?.role,
    "admin",
    "the administrator lost their role in the restore"
  );
  ok("Administrator role survived");

  const communities =
    await owner.query<Array<{ id: number; name: string }>>("servers.list");
  const found = communities.find(c => c.id === state.communityId);
  assert(found, `the community is gone: ${JSON.stringify(communities)}`);
  assertEqual(
    found.name,
    state.communityName,
    "the community came back with the wrong name"
  );
  ok("Community survived");

  const messages = await owner.query<Array<{ content: string }>>(
    "messages.listByChannel",
    {
      channelId: state.channelId,
    }
  );
  assert(
    messages.some(m => m.content === state.messageText),
    "the owner's message is gone"
  );
  assert(
    messages.some(m => m.content === state.guestMessage),
    "the guest's message is gone"
  );
  ok(`Messages survived (${messages.length} in the channel)`);

  const files = await owner.query<Array<{ ipfsHash?: string }>>(
    "fileShares.listByChannel",
    {
      channelId: state.channelId,
    }
  );
  assert(
    files.some(f => f.ipfsHash === state.cid),
    "the file record is gone"
  );
  ok("File record survived");

  // The bytes live in IPFS, not Postgres, so this proves the two halves of a
  // restore agree with each other rather than each being individually fine.
  const bytes = await owner.download(state.cid);
  assertEqual(
    bytes.length,
    state.fileBytes,
    "the restored file is the wrong size"
  );
  ok("File contents still downloadable");
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  try {
    if (MODE === "verify-restore") await verifyRestore();
    else await runJourney();

    console.log(`\n  ${GREEN}${checks} checks passed${RESET}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ${RED}✗ ${message}${RESET}\n`);
    process.exit(1);
  }
}

void main();
