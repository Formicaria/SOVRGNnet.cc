import { sql } from "drizzle-orm";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { __resetKeysForTests } from "./keys";
import { __resetRateLimits } from "./rateLimit";

/**
 * The routes, against a real database.
 *
 * Everything else in this workspace tests pure functions. These are the paths
 * where the interesting failures live: single-use redemption, atomicity,
 * whether a row that must not be readable twice actually isn't. None of that
 * can be tested without a database, because all of it is about what the
 * database does under a second, concurrent attempt.
 *
 * Run with `./identity/scripts/test-db.sh`, which brings up a throwaway
 * Postgres on :55433. **Never against id.sovrgnnet.cc.** These tests truncate
 * tables between cases; pointed at production that is a script for deleting
 * every identity on the network. An instance's data can be restored from last
 * night's backup — an account subject cannot, because every server on the
 * network keys its local user off it.
 *
 * Skipped, loudly, when there is no test database. A suite that needs one and
 * silently passes without it is worse than one that isn't written.
 */

const TEST_DB = process.env.IDENTITY_TEST_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    "[identity] route tests skipped — run ./identity/scripts/test-db.sh for a throwaway database"
  );
}

async function makeApp(): Promise<Express> {
  const { registerRoutes } = await import("./routes");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  // MAIL_TRANSPORT=none is the deployed configuration, so it is the one worth
  // testing. A transport that records instead of sending would test a mode
  // nobody runs.
  registerRoutes(app, { async send() {} } as never);
  return app;
}

/** Minimal in-process request, so these tests need no HTTP listener. */
async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return {
      status: res.status,
      body: parsed,
      headers: Object.fromEntries(res.headers.entries()),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describeWithDb("identity routes, against a real database", () => {
  let app: Express;
  let db: Awaited<ReturnType<typeof import("./db").getDb>>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.MAIL_TRANSPORT = "none";
    process.env.IDENTITY_PUBLIC_URL = "https://id.test.local";
    process.env.IDENTITY_SIGNING_KEY = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    __resetKeysForTests();
    db = await (await import("./db")).getDb();
    app = await makeApp();
  });

  afterEach(async () => {
    __resetRateLimits();
    // Order matters: children before parents. TRUNCATE ... CASCADE would be
    // shorter and would also quietly hide a missing foreign key.
    await db.execute(
      sql`TRUNCATE "deviceAuthorizations", "grants", "sessions", "recoveryCodes", "emailTokens", "oauthAttempts", "identities", "accounts" RESTART IDENTITY`
    );
  });

  afterAll(() => {
    __resetKeysForTests();
  });

  describe("the endpoint every instance depends on", () => {
    it("serves a JWKS with a usable key", async () => {
      const res = await request(app, "GET", "/.well-known/jwks.json");
      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0].kty).toBe("OKP");
    });

    it("is readable cross-origin, because that is who reads it", async () => {
      // A server verifying a token fetches this from its own origin. Without
      // the header it gets a CORS failure that looks like the service being
      // down.
      const res = await request(app, "GET", "/.well-known/jwks.json");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("never serves the private half", async () => {
      const res = await request(app, "GET", "/.well-known/jwks.json");
      expect(JSON.stringify(res.body)).not.toMatch(/"d"\s*:/);
    });
  });

  describe("registration", () => {
    it("creates an account and refuses the address twice", async () => {
      const credentials = { email: "zach@example.com", password: "a-long-enough-password" };

      const first = await request(app, "POST", "/api/register", credentials);
      expect(first.status).toBeLessThan(400);

      const second = await request(app, "POST", "/api/register", credentials);
      expect(second.status).toBeGreaterThanOrEqual(400);
    });

    it("treats the address case-insensitively", async () => {
      // normalizeEmail folds case on write. If lookup did not, `Zach@` and
      // `zach@` would be two accounts, and the second person to register would
      // silently get a different identity everywhere.
      await request(app, "POST", "/api/register", {
        email: "case@example.com",
        password: "a-long-enough-password",
      });
      const again = await request(app, "POST", "/api/register", {
        email: "CASE@Example.COM",
        password: "a-long-enough-password",
      });
      expect(again.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects a body that isn't a registration at all", async () => {
      // Express 5 leaves req.body undefined when nothing parsed. zod's
      // safeParse handles that; this proves it rather than assuming.
      const res = await request(app, "POST", "/api/register", undefined);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("the device flow", () => {
    it("issues a code, and the same device code cannot be redeemed twice", async () => {
      // The property the whole flow rests on. A device code that survives
      // redemption is a session anyone who saw it can mint again.
      const created = await request(app, "POST", "/api/device/code");
      expect(created.status).toBe(200);
      expect(created.body.device_code).toBeTruthy();
      expect(created.body.user_code).toBeTruthy();
      // Both URI forms, per RFC 8628: the bare page, and the same page with
      // the code already in it so approving is a click, not a transcription.
      // The complete form must carry exactly the user_code this response
      // shows, or the app opens a page that quietly approves a different
      // pending sign-in.
      expect(created.body.verification_uri).toMatch(/\/device$/);
      expect(created.body.verification_uri_complete).toBe(
        `${created.body.verification_uri}?code=${encodeURIComponent(created.body.user_code)}`
      );

      // Unapproved, so this is a pending answer rather than a session.
      const first = await request(app, "POST", "/api/device/token", {
        device_code: created.body.device_code,
      });
      expect(first.status).toBeGreaterThanOrEqual(400);
      expect(String(JSON.stringify(first.body))).toMatch(/pending|authorization_pending/i);
    });

    it("refuses a device code that was never issued", async () => {
      const res = await request(app, "POST", "/api/device/token", {
        device_code: "not-a-real-code",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("stores the code hashed, not in plaintext", async () => {
      // The table is the thing a database leak exposes. A plaintext device
      // code in it is a pending sign-in anybody can complete.
      const created = await request(app, "POST", "/api/device/code");
      const rows = await db.execute(
        sql`SELECT "deviceCodeHash" FROM "deviceAuthorizations"`
      );
      const stored = JSON.stringify([...rows]);
      expect(stored).not.toContain(created.body.device_code);
    });
  });

  describe("rate limiting, end to end", () => {
    it("stops issuing device codes past the limit", async () => {
      // LIMITS.deviceCode is 20/hour. This endpoint writes a row and takes no
      // authentication at all, so unbounded it fills a database somebody pays
      // for.
      let refused = 0;
      for (let i = 0; i < 25; i += 1) {
        const res = await request(app, "POST", "/api/device/code");
        if (res.status === 429) refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
    });

    it("says when to come back, without saying how fast to go", async () => {
      for (let i = 0; i < 25; i += 1) await request(app, "POST", "/api/device/code");
      const res = await request(app, "POST", "/api/device/code");
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(JSON.stringify(res.body)).not.toMatch(/\b20\b/);
    });
  });

  describe("grants", () => {
    it("requires a session", async () => {
      // The list names every server an account has signed into. Unauthenticated
      // it would be a map of who is on which instance.
      const res = await request(app, "GET", "/api/grants");
      expect(res.status).toBe(401);
    });

    it("refuses to revoke without one", async () => {
      const res = await request(app, "POST", "/api/grants/abc123/revoke");
      expect(res.status).toBe(401);
    });
  });

  describe("the endpoints a native app calls", () => {
    // The desktop shell's webview origin is tauri://localhost, so every call
    // it makes here is cross-origin. Without these headers the browser throws
    // the response away and fetch rejects with a TypeError that WebKitGTK
    // words as "Load failed" — which is what desktop sign-in showed while
    // curl, and every check built on curl, succeeded.
    for (const path of ["/api/device/code", "/api/device/token", "/api/grants"]) {
      it(`${path} is readable cross-origin`, async () => {
        const res = await request(app, "OPTIONS", path);
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe("*");
      });

      it(`${path} allows the headers the app actually sends`, async () => {
        // Authorization on the grants call, Content-Type on the JSON bodies.
        // Either one makes the request non-simple, which is what triggers the
        // preflight above — so both have to be named or the real request is
        // never sent.
        const res = await request(app, "OPTIONS", path);
        const allowed = String(res.headers["access-control-allow-headers"] ?? "");
        expect(allowed.toLowerCase()).toContain("authorization");
        expect(allowed.toLowerCase()).toContain("content-type");
      });
    }

    it("does not open the cookie-authenticated routes", async () => {
      // These carry ambient authority. Allowing another origin to call them is
      // how a page nobody trusts acts as somebody who is signed in — and
      // browsers refuse `*` together with credentials anyway.
      for (const path of ["/api/me", "/api/logout", "/api/login"]) {
        const res = await request(app, "OPTIONS", path);
        expect(res.headers["access-control-allow-origin"], path).toBeUndefined();
      }
    });

    it("never allows credentials to ride along", async () => {
      const res = await request(app, "OPTIONS", "/api/device/code");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("answers the real request with the header too, not just the preflight", async () => {
      // A preflight that passes and a response with no ACAO is still a
      // rejected fetch. Both halves matter.
      const res = await request(app, "POST", "/api/device/code");
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });
});
