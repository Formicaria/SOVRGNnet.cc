import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// See routers.test.ts for why these are hoisted: matrixService captures env at
// import time, and provisioning refuses to run without a shared secret.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-client-session";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET || "test-shared-secret-for-client-session";
});

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import {
  __resetForTests as resetProbe,
  __setFetchForTests as setProbeFetch,
  refreshDirectSync,
} from "./matrixPublic";
import { __setFetchForTests as setMatrixFetch } from "./matrixService";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * The homeserver as this test sees it: shared-secret registration for
 * provisioning, password login handing back whatever device id was asked for —
 * which is the property clientSession's reuse contract depends on.
 */
function installFakeHomeserver() {
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/register")) {
      if (method === "GET") return json({ nonce: `nonce_${Date.now()}` });
      return json({
        user_id: `@fake_${Date.now()}_${Math.random().toString(36).slice(2, 6)}:test`,
        access_token: `tok_${Math.random().toString(36).slice(2)}`,
      });
    }
    if (url.includes("/login")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({
        user_id: `@${body.identifier?.user ?? "someone"}:test`,
        access_token: `device_tok_${Math.random().toString(36).slice(2)}`,
        device_id: body.device_id ?? `GENERATED_${Date.now()}`,
      });
    }
    if (url.includes("/account/whoami")) {
      return json({ user_id: "@whoever:test", device_id: "SOVRGNNET_SERVER" });
    }
    return json({ errcode: "M_UNRECOGNIZED" }, 404);
  });
  setMatrixFetch(fake as unknown as typeof fetch);
  return fake;
}

const PUBLIC_URL = "https://matrix.public.test";
let previousPublicUrl: string | undefined;

describe.skipIf(!process.env.DATABASE_URL)("matrix.clientSession (ADR 0008 stage 3)", () => {
  let alice: AuthenticatedUser;

  beforeAll(async () => {
    previousPublicUrl = process.env.MATRIX_PUBLIC_URL;
    process.env.MATRIX_PUBLIC_URL = PUBLIC_URL;

    installFakeHomeserver();

    // The capability comes from a probe, not the variable — answer it.
    resetProbe();
    setProbeFetch((async () =>
      json({ versions: ["v1.11"] })) as unknown as typeof fetch);
    await refreshDirectSync();

    alice = (await db.createLocalUser(
      `sync_${Date.now()}@test.cc`,
      "x",
      "Sync Alice"
    )) as AuthenticatedUser;
  });

  afterAll(() => {
    if (previousPublicUrl === undefined) delete process.env.MATRIX_PUBLIC_URL;
    else process.env.MATRIX_PUBLIC_URL = previousPublicUrl;
    resetProbe();
  });

  it("mints a device-scoped session against the advertised homeserver", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    const session = await caller.matrix.clientSession({
      displayName: "SOVRGNnet web · Vitest",
    });

    expect(session.homeserverUrl).toBe(PUBLIC_URL);
    expect(session.deviceId).toMatch(/^SOVRGN_[A-Z0-9]{16}$/);
    expect(session.accessToken).toMatch(/^device_tok_/);
    expect(session.matrixUserId).toContain(":test");
  });

  it("reusing a deviceId replaces that session rather than adding another", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    const first = await caller.matrix.clientSession({
      displayName: "SOVRGNnet web · Vitest",
    });
    const second = await caller.matrix.clientSession({
      deviceId: first.deviceId,
      displayName: "SOVRGNnet web · Vitest",
    });

    expect(second.deviceId).toBe(first.deviceId);
    // New token each time — the old session was replaced, not shared.
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  it("rejects device ids that aren't client-shaped", async () => {
    const caller = appRouter.createCaller(contextFor(alice));
    await expect(
      caller.matrix.clientSession({
        deviceId: "SOVRGNNET_SERVER" as never,
        displayName: "impostor",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses when direct sync is not available", async () => {
    delete process.env.MATRIX_PUBLIC_URL;
    resetProbe();
    try {
      const caller = appRouter.createCaller(contextFor(alice));
      await expect(
        caller.matrix.clientSession({ displayName: "SOVRGNnet web · Vitest" })
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      process.env.MATRIX_PUBLIC_URL = PUBLIC_URL;
      resetProbe();
      setProbeFetch((async () =>
        json({ versions: ["v1.11"] })) as unknown as typeof fetch);
      await refreshDirectSync();
    }
  });
});
