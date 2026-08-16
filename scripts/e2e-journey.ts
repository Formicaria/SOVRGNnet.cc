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
    throw new JourneyError(`${message}\n      expected: ${expected}\n      actual:   ${actual}`);
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
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorb(response: Response): void {
    // Node exposes multiple Set-Cookie headers through getSetCookie().
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
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));

    const response = await fetch(url, {
      headers: { cookie: this.cookieHeader() },
    });
    this.absorb(response);
    return unwrap<T>(await response.text(), `${this.label} GET ${path}`);
  }

  async mutate<T>(path: string, input?: unknown): Promise<T> {
    const response = await fetch(new URL(`/api/trpc/${path}`, BASE), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookieHeader() },
      body: JSON.stringify(input ?? {}),
    });
    this.absorb(response);
    return unwrap<T>(await response.text(), `${this.label} POST ${path}`);
  }

  /** Expect a call to be refused. Returns the message, so it can be asserted on. */
  async expectDenied(path: string, input: unknown, what: string): Promise<string> {
    try {
      await this.mutate(path, input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new JourneyError(`${what} was allowed, and should not have been.`);
  }

  async upload(channelId: number, filename: string, bytes: Buffer): Promise<unknown> {
    const form = new FormData();
    form.set("channelId", String(channelId));
    form.set("file", new Blob([new Uint8Array(bytes)]), filename);

    const response = await fetch(new URL("/api/upload", BASE), {
      method: "POST",
      headers: { cookie: this.cookieHeader() },
      body: form,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new JourneyError(`${this.label} upload failed (${response.status}): ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }

  async download(cid: string): Promise<Buffer> {
    const response = await fetch(new URL(`/api/files/${cid}`, BASE), {
      headers: { cookie: this.cookieHeader() },
    });
    if (!response.ok) {
      throw new JourneyError(`${this.label} download failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function unwrap<T>(text: string, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JourneyError(`${context}: response wasn't JSON — ${text.slice(0, 200)}`);
  }

  const body = parsed as { error?: { message?: string }; result?: { data?: T } };
  if (body?.error) {
    throw new JourneyError(`${context}: ${body.error.message ?? "unknown error"}`);
  }
  return body?.result?.data as T;
}

const stamp = Date.now();

// ------------------------------------------------------------------- journey

async function runJourney(): Promise<void> {
  const owner = new Session("owner");
  const guest = new Session("guest");

  const ownerEmail = `owner-${stamp}@e2e.local`;
  const guestEmail = `guest-${stamp}@e2e.local`;
  const password = "correct-horse-battery-staple";

  // -- accounts -------------------------------------------------------------

  console.log("\n  Accounts");

  const registered = await owner.mutate<{ user?: { id: number; role?: string } }>(
    "auth.register",
    { email: ownerEmail, password, name: "Owner" }
  );
  assert(registered?.user?.id, "registration returned no user");
  ok("First account registered");

  const me = await owner.query<{ role?: string; email?: string }>("auth.me");
  assertEqual(me?.email, ownerEmail, "auth.me returned the wrong account");
  // The installer promises this, and it was broken once: adminProcedure
  // checked for the role and nothing ever assigned it.
  assertEqual(me?.role, "admin", "the first account should be the instance admin");
  ok("First account is the administrator");

  // Default join policy is invite-only, so a second signup must be refused.
  const denied = await guest.expectDenied(
    "auth.register",
    { email: guestEmail, password, name: "Guest" },
    "Open registration on an invite-only instance"
  );
  detail(denied.slice(0, 90));
  ok("Invite-only policy is enforced, not just advertised");

  // -- community ------------------------------------------------------------

  console.log("\n  Community");

  const community = await owner.mutate<{ id: number; name: string }>("servers.create", {
    name: `E2E community ${stamp}`,
    description: "Created by the end-to-end harness",
  });
  assert(community?.id, "community creation returned no id");
  ok(`Community created (#${community.id})`);

  const channels = await owner.query<Array<{ id: number; name: string }>>(
    "channels.listByServer",
    { serverId: community.id }
  );
  assert(channels.length > 0, "a new community should have a default channel");
  const channel = channels[0];
  ok(`Default channel exists (#${channel.id} ${channel.name})`);

  // -- messages -------------------------------------------------------------

  console.log("\n  Messages");

  const text = `hello from e2e ${stamp}`;
  const sent = await owner.mutate<{ id: number }>("messages.send", {
    channelId: channel.id,
    content: text,
  });
  assert(sent?.id, "sending returned no message");
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
  await owner.mutate("messages.edit", { messageId: sent.id, content: edited });
  const afterEdit = await owner.query<Array<{ id: number; content: string }>>(
    "messages.listByChannel",
    { channelId: channel.id }
  );
  assert(
    afterEdit.some(m => m.id === sent.id && m.content === edited),
    "the edit didn't take"
  );
  ok("Message edited");

  // -- files ----------------------------------------------------------------

  console.log("\n  Files");

  const payload = Buffer.from(`e2e file contents ${stamp}\n`.repeat(64));
  const uploaded = (await owner.upload(channel.id, "e2e.txt", payload)) as {
    ipfsHash?: string;
    cid?: string;
  };
  const cid = uploaded.ipfsHash ?? uploaded.cid;
  assert(cid, `upload returned no CID: ${JSON.stringify(uploaded).slice(0, 160)}`);
  ok(`Uploaded and pinned (${String(cid).slice(0, 16)}…)`);

  const fetched = await owner.download(String(cid));
  assert(fetched.equals(payload), "the file that came back isn't the file that went up");
  ok("Downloaded, byte-for-byte identical");

  // -- invite ---------------------------------------------------------------

  console.log("\n  Invites and membership");

  const invite = await owner.mutate<{ code: string }>("servers.createInvite", {
    serverId: community.id,
  });
  assert(invite?.code, "no invite code returned");
  ok("Invite created");

  const guestUser = await guest.mutate<{ user?: { id: number; role?: string } }>(
    "auth.register",
    { email: guestEmail, password, name: "Guest", inviteCode: invite.code }
  );
  assert(guestUser?.user?.id, "invited registration failed");
  // Only the first account is admin. A second must not inherit it.
  assert(guestUser.user.role !== "admin", "the second account must not be an admin");
  ok("Second account registered via invite, without admin");

  const beforeJoin = await guest.expectDenied(
    "messages.send",
    { channelId: channel.id, content: "should not work" },
    "Posting to a community the user hasn't joined"
  );
  detail(beforeJoin.slice(0, 90));
  ok("Non-members can't post");

  await guest.mutate("servers.joinByInvite", { code: invite.code });
  ok("Joined by invite");

  await guest.mutate("messages.send", { channelId: channel.id, content: `guest ${stamp}` });
  ok("Members can post");

  // -- permissions ----------------------------------------------------------

  console.log("\n  Permissions");

  const escalation = await guest.expectDenied(
    "serverMembers.setRole",
    { serverId: community.id, userId: registered.user.id, role: "member" },
    "A member demoting the owner"
  );
  detail(escalation.slice(0, 90));
  ok("A member can't act on the owner");

  const selfPromote = await guest.expectDenied(
    "serverMembers.setRole",
    { serverId: community.id, userId: guestUser.user.id, role: "admin" },
    "A member promoting themselves"
  );
  detail(selfPromote.slice(0, 90));
  ok("Nobody grants themselves a role at or above their own");

  // -- devices --------------------------------------------------------------

  console.log("\n  Matrix sessions");

  const devices = await owner.query<Array<{ deviceId: string; isServer: boolean }>>(
    "profile.devices"
  );
  assert(devices.length > 0, "no Matrix devices listed");
  const serverDevice = devices.find(d => d.isServer);
  assert(serverDevice, "the instance's own session should appear, flagged");
  ok(`${devices.length} session(s), server's own shown and flagged`);

  const refusal = await owner.expectDenied(
    "profile.signOutDevice",
    { deviceId: serverDevice.deviceId },
    "Signing out the server's own session"
  );
  detail(refusal.slice(0, 90));
  ok("The server's own session can't be signed out from here");

  // -- record for the restore check -----------------------------------------

  mkdirSync(WORK, { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        ownerEmail,
        guestEmail,
        password,
        communityId: community.id,
        communityName: community.name,
        channelId: channel.id,
        messageText: edited,
        guestMessage: `guest ${stamp}`,
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
  await owner.mutate("auth.login", { email: state.ownerEmail, password: state.password });
  ok("The account still exists and the password still works");

  const me = await owner.query<{ role?: string }>("auth.me");
  assertEqual(me?.role, "admin", "the administrator lost their role in the restore");
  ok("Administrator role survived");

  const communities = await owner.query<Array<{ id: number; name: string }>>("servers.list");
  const found = communities.find(c => c.id === state.communityId);
  assert(found, "the community is gone");
  assertEqual(found.name, state.communityName, "the community came back with the wrong name");
  ok("Community survived");

  const messages = await owner.query<Array<{ content: string }>>("messages.listByChannel", {
    channelId: state.channelId,
  });
  assert(
    messages.some(m => m.content === state.messageText),
    "the owner's message is gone"
  );
  assert(
    messages.some(m => m.content === state.guestMessage),
    "the guest's message is gone"
  );
  ok(`Messages survived (${messages.length} in the channel)`);

  const files = await owner.query<Array<{ ipfsHash?: string }>>("fileShares.listByChannel", {
    channelId: state.channelId,
  });
  assert(
    files.some(f => f.ipfsHash === state.cid),
    "the file record is gone"
  );
  ok("File record survived");

  // The bytes live in IPFS, not Postgres, so this proves the two halves of a
  // restore agree with each other rather than each being individually fine.
  const bytes = await owner.download(state.cid);
  assertEqual(bytes.length, state.fileBytes, "the restored file is the wrong size");
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
