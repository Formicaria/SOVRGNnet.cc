import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-router-tests";

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
  const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/register")) {
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
    alice = (await db.createLocalUser(`alice_${suffix}@test.cc`, "x", "Alice")) as AuthenticatedUser;
    bob = (await db.createLocalUser(`bob_${suffix}@test.cc`, "x", "Bob")) as AuthenticatedUser;
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
});
