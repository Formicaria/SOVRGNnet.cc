/**
 * The staging journey — a real user's day, driven against a remote instance.
 *
 * Run by scripts/verify-staging.sh. This is not e2e-journey.ts pointed
 * elsewhere: that journey owns its whole stack — it drops schemas, assumes a
 * fresh database, and reaches the homeserver on a published localhost port.
 * A staging box is a machine with a history, reached only over HTTP, where
 * the only honest assertions are the ones a user could make. So this journey
 * does what a user does and nothing else: sign up or in, make a community,
 * post, share a file, invite someone — and it adapts to what the instance
 * advertises instead of assuming the harness topology.
 *
 * Two modes, exactly one of which must be configured:
 *
 *   STAGING_SETUP_TOKEN            fresh box — claims the first account and
 *                                  proves the claim guard on the way
 *   STAGING_EMAIL/STAGING_PASSWORD a box with history — signs in and works
 *                                  as that account
 *
 * PRODUCTION REFUSAL is enforced twice: verify-staging.sh checks the URL,
 * and this script checks what the instance says its Matrix server name is —
 * because a production box reached by IP would sail past a hostname check.
 * The names refused here are the real deployment's, hardcoded on purpose:
 * a config knob for "which production to refuse" is a knob someone unsets.
 *
 * The transport is a copy of e2e-journey.ts's, deliberately — see the note
 * there. Small, not clever, and a change to one harness can't break another.
 */

const BASE = process.env.STAGING_BASE ?? "";
const SETUP_TOKEN = process.env.STAGING_SETUP_TOKEN ?? "";
const EMAIL = process.env.STAGING_EMAIL ?? "";
const PASSWORD = process.env.STAGING_PASSWORD ?? "";

const PRODUCTION_SERVER_NAMES = ["sovrgnnet.cc"];
const PRODUCTION_HOSTS = ["sovrgnnet.cc", "app.sovrgnnet.cc", "www.sovrgnnet.cc"];

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let checks = 0;

function ok(message: string): void {
  checks += 1;
  console.log(`  ${GREEN}✓${RESET} ${message}`);
}

function skip(message: string): void {
  console.log(`  ${DIM}– ${message}${RESET}`);
}

class JourneyError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JourneyError(message);
}

// ----------------------------------------------------------------- transport

class Session {
  private cookies = new Map<string, string>();

  constructor(readonly label: string) {}

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
    const url = new URL(`/api/trpc/${path}`, BASE);
    if (input !== undefined) url.searchParams.set("input", JSON.stringify({ json: input }));
    const response = await fetch(url, { headers: { cookie: this.cookieHeader() } });
    this.absorb(response);
    return unwrap<T>(await response.text(), response.status, `${this.label} GET ${path}`);
  }

  async mutate<T>(path: string, input?: unknown): Promise<T> {
    const response = await fetch(new URL(`/api/trpc/${path}`, BASE), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookieHeader() },
      body: JSON.stringify({ json: input ?? {} }),
    });
    this.absorb(response);
    return unwrap<T>(await response.text(), response.status, `${this.label} POST ${path}`);
  }

  async expectDenied(path: string, input: unknown, what: string): Promise<string> {
    try {
      await this.mutate(path, input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new JourneyError(`${what} was allowed, and should not have been.`);
  }

  async upload(channelId: number, filename: string, bytes: Uint8Array): Promise<unknown> {
    const url = new URL("/api/upload", BASE);
    url.searchParams.set("channelId", String(channelId));
    url.searchParams.set("filename", filename);
    const response = await fetch(url, {
      method: "POST",
      headers: { cookie: this.cookieHeader(), "content-type": "text/plain" },
      // A fresh copy, because TS types a view over ArrayBufferLike as not
      // being BodyInit — the same strictness attachments.ts satisfies.
      body: new Uint8Array(bytes),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new JourneyError(`${this.label} upload failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  }

  async download(cid: string): Promise<Uint8Array> {
    const response = await fetch(new URL(`/api/files/${cid}`, BASE), {
      headers: { cookie: this.cookieHeader() },
    });
    if (!response.ok) throw new JourneyError(`${this.label} download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
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
      json?: { message?: string; data?: { code?: string } };
      data?: { code?: string };
    };
    result?: { data?: T | { json?: T } };
  };
  if (body?.error) {
    const err = body.error;
    const message = err.json?.message ?? err.message;
    const code = err.json?.data?.code ?? err.data?.code;
    throw new JourneyError(
      [`${context}: HTTP ${status}`, code ? `[${code}]` : "", message ?? "no message"].filter(Boolean).join(" ")
    );
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

// ---------------------------------------------------------------------- main

const stamp = Date.now();

async function main(): Promise<void> {
  assert(BASE, "STAGING_BASE is required");
  const baseHost = new URL(BASE).host.toLowerCase();
  assert(
    !PRODUCTION_HOSTS.includes(baseHost.replace(/:\d+$/, "")),
    `Refusing to run against ${baseHost} — this journey creates accounts and communities, and that is production.`
  );
  assert(
    Boolean(SETUP_TOKEN) !== Boolean(EMAIL && PASSWORD),
    "Configure exactly one mode: STAGING_SETUP_TOKEN (fresh box) or STAGING_EMAIL + STAGING_PASSWORD (existing account)."
  );

  // -- what the instance says about itself -----------------------------------

  console.log("\n  The instance");

  const descriptor = (await (await fetch(`${BASE}/api/instance`)).json()) as {
    matrix?: { serverName?: string };
    capabilities?: Record<string, boolean>;
    server?: { version?: string };
  };
  const serverName = descriptor.matrix?.serverName ?? "";
  assert(serverName, "the instance descriptor names no Matrix server — is this a SOVRGNnet instance?");
  assert(
    !PRODUCTION_SERVER_NAMES.includes(serverName.toLowerCase()),
    `This instance says it is ${serverName} — that is production, reached by another name. Refusing.`
  );
  const capabilities = descriptor.capabilities ?? {};
  ok(`Talking to ${serverName} (v${descriptor.server?.version ?? "?"}) — not production, checked twice`);

  // -- an account ------------------------------------------------------------

  console.log("\n  Account");

  const me = new Session("verifier");
  let secondAccountPossible = false;

  if (SETUP_TOKEN) {
    // A fresh box proves the claim guard on the way in: no token, no account.
    const refused = await new Session("stranger").expectDenied(
      "auth.register",
      { username: `stranger${stamp}`, password: "correct-horse-battery-staple", name: "Stranger" },
      "Claiming a fresh instance without the setup token"
    );
    void refused;
    ok("A fresh instance can't be claimed without its setup token");

    await me.mutate("auth.register", {
      username: `verify${stamp}`,
      password: "correct-horse-battery-staple",
      name: "Staging verifier",
      setupToken: SETUP_TOKEN,
    });
    const who = await me.query<{ role?: string }>("auth.me");
    assert(who?.role === "admin", "the first account should be the administrator");
    ok("First account claimed with the setup token; it is the administrator");
    secondAccountPossible = true;
  } else {
    await me.mutate("auth.login", { email: EMAIL, password: PASSWORD });
    ok("Signed in with the provided account");
  }

  // -- a community, honestly encrypted or honestly not -----------------------

  console.log("\n  Community");

  const created = await me.mutate<{ server: { id: number } }>("servers.create", {
    name: `Staging verify ${new Date(stamp).toISOString().slice(0, 16)}`,
    description: "Created by scripts/staging-journey.ts — safe to delete",
  });
  assert(created?.server?.id, "community creation returned nothing");
  const channels = await me.query<Array<{ id: number; name: string; encrypted: boolean }>>(
    "channels.listByServer",
    { serverId: created.server.id }
  );
  assert(channels.length > 0, "a new community should have a default channel");
  const channel = channels[0];

  // The channel's encryption must match the instance's advertised capability.
  // Both directions are lies this project has shipped once each: a lock over
  // plaintext, and plaintext where the capability promised keys.
  if (capabilities.e2ee === true) {
    assert(channel.encrypted, "e2ee is advertised but the new channel is plaintext");
    ok("Channel born encrypted, as the e2ee capability promises");
  } else {
    assert(!channel.encrypted, "e2ee is not advertised but the channel claims encryption");
    ok("Channel plaintext, matching the honest capability");
  }

  // -- messages, respecting what the channel is ------------------------------

  console.log("\n  Messages");

  if (channel.encrypted) {
    // Plaintext into an encrypted room is the one send with no fallback.
    await me.expectDenied(
      "messages.send",
      { channelId: channel.id, content: "plaintext probe" },
      "Sending plaintext into an encrypted channel"
    );
    ok("The API refuses plaintext into the encrypted channel (sending needs a crypto-capable client)");
  } else {
    const text = `staging probe ${stamp}`;
    await me.mutate("messages.send", { channelId: channel.id, content: text });
    const listed = await me.query<Array<{ content: string }>>("messages.listByChannel", {
      channelId: channel.id,
    });
    assert(listed.some(m => m.content === text), "the message just sent didn't come back");
    ok("Message sent and read back");
  }

  // -- a file ----------------------------------------------------------------

  console.log("\n  Files");

  const payload = new TextEncoder().encode(`staging file ${stamp}\n`.repeat(32));
  const uploaded = (await me.upload(channel.id, "staging.txt", payload)) as {
    ipfsHash?: string;
    cid?: string;
  };
  const cid = uploaded.ipfsHash ?? uploaded.cid;
  assert(cid, "upload returned no CID");
  const fetched = await me.download(String(cid));
  assert(
    fetched.length === payload.length && fetched.every((b, i) => b === payload[i]),
    "the file that came back isn't the file that went up"
  );
  ok("File round-trips byte-identical");

  // -- the invite names this instance, not the requester's loopback ----------

  console.log("\n  Invites");

  const invite = await me.mutate<{ code: string; url: string | null }>("servers.createInvite", {
    serverId: created.server.id,
  });
  assert(invite?.code, "no invite code returned");
  assert(invite.url, "no invite URL returned — the server saw no Host header?");
  const inviteHost = new URL(invite.url).host;
  assert(
    inviteHost === baseHost,
    `invite names ${inviteHost} but this instance is ${baseHost} — a friend clicking it goes somewhere else`
  );
  ok(`Invite URL names this instance (${inviteHost})`);

  if (secondAccountPossible) {
    const guest = new Session("guest");
    await guest.mutate("auth.register", {
      username: `verifyguest${stamp}`,
      password: "correct-horse-battery-staple",
      name: "Staging guest",
      inviteCode: invite.code,
    });
    await guest.mutate("servers.joinByInvite", { code: invite.code });
    ok("A second account registered through the invite and joined");

    const escalation = await guest.expectDenied(
      "serverMembers.setRole",
      { serverId: created.server.id, userId: 1, role: "member" },
      "A member acting on the owner"
    );
    void escalation;
    ok("Permission refusals hold for the new member");
  } else {
    skip("Second-account checks need a fresh box (invite-only instances won't take a bare signup)");
  }

  // -- direct sync, if advertised --------------------------------------------

  if (capabilities.clientMatrix === true) {
    const session = await me.mutate<{ accessToken: string; deviceId: string }>(
      "matrix.clientSession",
      { displayName: "staging journey" }
    );
    assert(/^SOVRGN_/.test(session.deviceId), "client session device id has the wrong shape");
    ok("Device-scoped Matrix session minted (clientMatrix is real, not just advertised)");
  } else {
    skip("clientMatrix not advertised — direct-sync checks don't apply here");
  }

  console.log(`\n  ${GREEN}${checks} checks passed${RESET}`);
  console.log(`  ${DIM}The throwaway community is named so a human can delete it on sight.${RESET}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  ${RED}✗ ${message}${RESET}\n`);
  process.exit(1);
});
