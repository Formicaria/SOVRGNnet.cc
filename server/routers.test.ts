import { beforeAll, describe, expect, it, vi } from "vitest";

// ENV is captured when ./routers imports matrixService, and ES module imports
// are hoisted above ordinary statements — so these must be set inside
// vi.hoisted or they land too late. Account provisioning now refuses to run
// without a shared secret, which would fail every test in this file during
// setup rather than at the assertion that cares.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-router-tests";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET || "test-shared-secret-for-router-tests";
});

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { __setFetchForTests } from "./matrixService";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function contextFor(user: AuthenticatedUser): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {}, ip: "127.0.0.1" } as TrpcContext["req"],
    res: {
      cookie: () => {},
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}

/**
 * Fake homeserver: answers register/createRoom/state/join/send with canned
 * Matrix responses so the full app flow runs against real Postgres alone.
 */
let roomCounter = 0;
function installFakeHomeserver() {
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/register")) {
      // Shared-secret registration is two calls: GET for a nonce, then POST
      // carrying it back with a MAC. Answering both with the same body would
      // leave the nonce undefined and hide a real bug behind a passing test.
      if (method === "GET") return json({ nonce: `nonce_${Date.now()}` });
      return json({
        user_id: `@fake_${Date.now()}_${Math.random().toString(36).slice(2, 6)}:test`,
        access_token: `tok_${Math.random().toString(36).slice(2)}`,
      });
    }
    if (url.includes("/createRoom")) {
      roomCounter += 1;
      return json({ room_id: `!room_${Date.now()}_${roomCounter}:test` });
    }
    if (url.includes("/state/m.space.child/")) return json({});
    if (url.includes("/join/")) return json({});
    if (url.includes("/send/m.room.message/")) {
      return json({ event_id: `$ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}:test` });
    }
    if (url.includes("/versions")) return json({ versions: ["v1.11"] });
    return new Response(JSON.stringify({ errcode: "M_UNRECOGNIZED" }), { status: 404 });
  });
  __setFetchForTests(fakeFetch as unknown as typeof fetch);
}

// Integration tests — require a live Postgres (DATABASE_URL). CI provides one;
// locally run `docker compose up db` or they are skipped.
describe.skipIf(!process.env.DATABASE_URL)("Platform flow (DB + fake homeserver)", () => {
  let alice: AuthenticatedUser;
  let bob: AuthenticatedUser;
  let serverId: number;
  let generalChannelId: number;

  beforeAll(async () => {
    installFakeHomeserver();
    const suffix = Date.now();
    alice = (await db.createLocalUser({
      username: `alice${suffix}`,
      passwordHash: "x",
      email: `alice_${suffix}@test.cc`,
      name: "Alice",
    })) as AuthenticatedUser;
    bob = (await db.createLocalUser({
      username: `bob${suffix}`,
      passwordHash: "x",
      email: `bob_${suffix}@test.cc`,
      name: "Bob",
    })) as AuthenticatedUser;
  });

  it("auth.me returns the user without passwordHash", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    const me = await caller.auth.me();
    expect(me?.id).toBe(alice.id);
    expect(me && "passwordHash" in me).toBe(false);
  });

  it("alice creates a server and gets a #general channel", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    const { server, defaultChannel } = await caller.servers.create({
      name: "Test Community",
      description: "integration test server",
    });

    expect(server.ownerId).toBe(alice.id);
    expect(server.matrixRoomId).toMatch(/^!room_/);
    expect(defaultChannel.name).toBe("general");

    serverId = server.id;
    generalChannelId = defaultChannel.id;

    const servers = await caller.servers.list();
    expect(servers.some(s => s.id === serverId)).toBe(true);
  });

  it("alice sends a message through the Matrix bridge", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    const msg = await caller.messages.send({
      channelId: generalChannelId,
      content: "hello sovereign world",
    });
    expect(msg.matrixEventId).toMatch(/^\$ev_/);

    const messages = await caller.messages.listByChannel({
      channelId: generalChannelId,
      limit: 50,
    });
    expect(messages.at(-1)?.content).toBe("hello sovereign world");
    expect(messages.at(-1)?.senderName).toBe("Alice");
  });

  it("bob cannot read the channel before joining", async () => {
    const caller = appRouter.createCaller(contextFor(bob));
    await expect(
      caller.messages.listByChannel({ channelId: generalChannelId, limit: 10 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bob discovers, joins, and posts", async () => {
    const caller = appRouter.createCaller(contextFor(bob));

    const publicServers = await caller.servers.listPublic();
    expect(publicServers.some(s => s.id === serverId)).toBe(true);

    await caller.servers.join({ serverId });

    const msg = await caller.messages.send({
      channelId: generalChannelId,
      content: "bob was here",
    });
    expect(msg.userId).toBe(bob.id);

    const aliceCaller = appRouter.createCaller(contextFor(alice));
    const messages = await aliceCaller.messages.listByChannel({
      channelId: generalChannelId,
      limit: 50,
    });
    expect(messages.at(-1)?.content).toBe("bob was here");
    expect(messages.at(-1)?.senderName).toBe("Bob");
  });

  it("only the owner can create channels", async () => {
    const bobCaller = appRouter.createCaller(contextFor(bob));
    await expect(
      bobCaller.channels.create({ serverId, name: "sneaky", type: "text" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const aliceCaller = appRouter.createCaller(contextFor(alice));
    const channel = await aliceCaller.channels.create({
      serverId,
      name: "announcements",
      type: "text",
    });
    expect(channel.name).toBe("announcements");
  });

  it("lists members including the joiner", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    const members = await caller.serverMembers.list({ serverId });
    const ids = members.map(m => m.userId);
    expect(ids).toContain(alice.id);
    expect(ids).toContain(bob.id);
  });

  it("invite links: owner creates, a third user joins by code", async () => {
    const aliceCaller = appRouter.createCaller(contextFor(alice));
    const { code } = await aliceCaller.servers.createInvite({ serverId });
    expect(code).toBeTruthy();

    // Idempotent: asking again returns the same code.
    const again = await aliceCaller.servers.createInvite({ serverId });
    expect(again.code).toBe(code);

    const carol = (await db.createLocalUser({
      username: `carol${Date.now()}`,
      passwordHash: "x",
      email: `carol_${Date.now()}@test.cc`,
      name: "Carol",
    })) as AuthenticatedUser;
    const carolCaller = appRouter.createCaller(contextFor(carol));
    const joined = await carolCaller.servers.joinByInvite({ code });
    expect(joined.serverId).toBe(serverId);

    const messages = await carolCaller.messages.listByChannel({
      channelId: generalChannelId,
      limit: 10,
    });
    expect(Array.isArray(messages)).toBe(true);
  });

  it("message deletion: author can, others cannot, owner can moderate", async () => {
    const bobCaller = appRouter.createCaller(contextFor(bob));
    const aliceCaller = appRouter.createCaller(contextFor(alice));

    const msg = await bobCaller.messages.send({
      channelId: generalChannelId,
      content: "delete me",
    });

    // Alice (owner) is allowed; a random author check first: bob deletes his own.
    await bobCaller.messages.delete({ messageId: msg.id });
    const after = await bobCaller.messages.listByChannel({
      channelId: generalChannelId,
      limit: 50,
    });
    expect(after.some(m => m.id === msg.id)).toBe(false);

    // Owner moderation: alice deletes bob's second message.
    const msg2 = await bobCaller.messages.send({
      channelId: generalChannelId,
      content: "moderate me",
    });
    await aliceCaller.messages.delete({ messageId: msg2.id });

    // Bob cannot delete alice's message.
    const aliceMsg = await aliceCaller.messages.send({
      channelId: generalChannelId,
      content: "untouchable",
    });
    await expect(
      bobCaller.messages.delete({ messageId: aliceMsg.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("leaving: members can leave, owners cannot", async () => {
    const bobCaller = appRouter.createCaller(contextFor(bob));
    await bobCaller.servers.leave({ serverId });
    await expect(
      bobCaller.messages.listByChannel({ channelId: generalChannelId, limit: 10 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const aliceCaller = appRouter.createCaller(contextFor(alice));
    await expect(
      aliceCaller.servers.leave({ serverId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("admin.overview: vitals for admins, forbidden for everyone else", async () => {
    // Bob is an ordinary account; the panel must not exist for him.
    const bobCaller = appRouter.createCaller(contextFor(bob));
    await expect(bobCaller.admin.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await db.setUserRole(alice.id, "admin");
    const adminCaller = appRouter.createCaller(
      contextFor({ ...alice, role: "admin" })
    );
    const overview = await adminCaller.admin.overview();

    expect(typeof overview.version).toBe("string");
    expect(overview.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof overview.checks.database).toBe("boolean");
    expect(typeof overview.checks.homeserver).toBe("boolean");
    expect(typeof overview.eventIngest).toBe("boolean");
    // The database is genuinely up in this suite, and the probe should say so.
    expect(overview.checks.database).toBe(true);
    expect(overview.totals).not.toBeNull();
    expect(overview.totals!.users).toBeGreaterThanOrEqual(2);
  });
});
