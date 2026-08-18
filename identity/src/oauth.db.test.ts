import { sql } from "drizzle-orm";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimits } from "./rateLimit";

/**
 * The OAuth broker routes, against a real database and a mocked provider.
 *
 * The mock is the point: every request that would leave for Google or GitHub
 * goes through `__setOAuthFetchForTests`, so what's under test is exactly the
 * part that is ours — state redemption being single-use, the account-matching
 * rule holding at the database, a provider identity never attaching to two
 * accounts — and none of the part that is theirs.
 *
 * Same throwaway-Postgres arrangement as routes.db.test.ts, same warning:
 * these truncate tables. Never against id.sovrgnnet.cc.
 */

const TEST_DB = process.env.IDENTITY_TEST_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    "[identity] oauth tests skipped — run ./identity/scripts/test-db.sh for a throwaway database"
  );
}

const PROVIDER_ENV = {
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
} as const;

async function makeApp(): Promise<Express> {
  const { registerRoutes } = await import("./routes");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  registerRoutes(app, { async send() {} } as never);
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers,
      redirect: "manual",
    });
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => (out[key] = value));
    return { status: res.status, text: await res.text(), headers: out };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A GitHub that recognises one person. */
function mockGithub(overrides?: {
  emails?: unknown;
  profile?: Record<string, unknown>;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return jsonResponse(200, { access_token: "gh_token" });
    }
    if (url.includes("/user/emails")) {
      return jsonResponse(
        200,
        overrides?.emails ?? [{ email: "z@example.com", primary: true, verified: true }]
      );
    }
    if (url.includes("api.github.com/user")) {
      return jsonResponse(200, overrides?.profile ?? { id: 777, login: "zach", name: "Zach" });
    }
    return jsonResponse(404, {});
  });
}

describeWithDb("the oauth broker, against the database", () => {
  let db: Awaited<ReturnType<typeof import("./db")["getDb"]>>;
  let routes: typeof import("./routes");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    Object.assign(process.env, PROVIDER_ENV);
    db = await (await import("./db")).getDb();
    routes = await import("./routes");
  });

  beforeEach(async () => {
    __resetRateLimits();
    await db.execute(
      sql`TRUNCATE accounts, identities, "oauthAttempts", sessions RESTART IDENTITY CASCADE`
    );
  });

  afterEach(() => {
    routes.__setOAuthFetchForTests((...args) => fetch(...args));
  });

  async function startAttempt(app: Express, provider = "github"): Promise<string> {
    const started = await request(app, "GET", `/oauth/${provider}/start?continue=%2Fdevice%3Fcode%3DABCD`);
    expect(started.status).toBe(302);
    const location = started.headers["location"] ?? "";
    const state = new URL(location).searchParams.get("state");
    expect(state, "start should have planted a state").toBeTruthy();
    return state as string;
  }

  it("start redirects to the provider and plants a single-use state", async () => {
    const app = await makeApp();
    const state = await startAttempt(app);

    const rows = await db.execute(
      sql`SELECT provider, "returnUrl" FROM "oauthAttempts" WHERE state = ${state}`
    );
    expect(rows.length).toBe(1);
    expect((rows[0] as { returnUrl: string }).returnUrl).toBe("/device?code=ABCD");
  });

  it("start refuses an absolute continuation rather than storing it", async () => {
    const app = await makeApp();
    const started = await request(
      app,
      "GET",
      `/oauth/github/start?continue=${encodeURIComponent("https://evil.example/phish")}`
    );
    const planted = new URL(started.headers["location"] ?? "").searchParams.get("state");
    const rows = await db.execute(
      sql`SELECT "returnUrl" FROM "oauthAttempts" WHERE state = ${planted}`
    );
    // Discarded to "/", not stored and filtered later: a stored bad value is
    // a bad value waiting for a refactor to stop filtering it.
    expect((rows[0] as { returnUrl: string }).returnUrl).toBe("/");
  });

  it("a full first sign-in creates the account, the identity, and a session", async () => {
    const app = await makeApp();
    routes.__setOAuthFetchForTests(mockGithub() as unknown as typeof fetch);
    const state = await startAttempt(app);

    const done = await request(app, "GET", `/oauth/github/callback?code=c0de&state=${state}`);
    expect(done.status).toBe(302);
    expect(done.headers["location"]).toBe("/device?code=ABCD");
    expect(done.headers["set-cookie"] ?? "").toContain("sovrgnnet_identity=");

    const accounts = await db.execute(sql`SELECT email, "emailVerified", "passwordHash" FROM accounts`);
    expect(accounts.length).toBe(1);
    expect((accounts[0] as { email: string }).email).toBe("z@example.com");
    expect((accounts[0] as { emailVerified: boolean }).emailVerified).toBe(true);
    expect((accounts[0] as { passwordHash: string | null }).passwordHash).toBeNull();

    const identities = await db.execute(sql`SELECT provider, "providerUserId" FROM identities`);
    expect(identities.length).toBe(1);
    expect((identities[0] as { providerUserId: string }).providerUserId).toBe("777");
  });

  it("the same provider identity signs in to the same account, forever", async () => {
    const app = await makeApp();
    routes.__setOAuthFetchForTests(mockGithub() as unknown as typeof fetch);

    const first = await startAttempt(app);
    await request(app, "GET", `/oauth/github/callback?code=a&state=${first}`);
    const second = await startAttempt(app);
    await request(app, "GET", `/oauth/github/callback?code=b&state=${second}`);

    const accounts = await db.execute(sql`SELECT id FROM accounts`);
    expect(accounts.length).toBe(1);
    const sessions = await db.execute(sql`SELECT id FROM sessions`);
    expect(sessions.length).toBe(2);
  });

  it("a state is single-use: the replayed callback is refused", async () => {
    const app = await makeApp();
    routes.__setOAuthFetchForTests(mockGithub() as unknown as typeof fetch);
    const state = await startAttempt(app);

    const first = await request(app, "GET", `/oauth/github/callback?code=c&state=${state}`);
    expect(first.status).toBe(302);
    const replay = await request(app, "GET", `/oauth/github/callback?code=c&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.text).toContain("expired or was already used");
  });

  it("an email collision refuses rather than linking — the takeover branch", async () => {
    const app = await makeApp();
    await db.execute(
      sql`INSERT INTO accounts (subject, email, "emailVerified", "passwordHash")
          VALUES ('subj_existing', 'z@example.com', true, 'x')`
    );
    routes.__setOAuthFetchForTests(mockGithub() as unknown as typeof fetch);
    const state = await startAttempt(app);

    const done = await request(app, "GET", `/oauth/github/callback?code=c&state=${state}`);
    expect(done.status).toBe(409);
    expect(done.text).toContain("Sign in the way you did before");

    const identities = await db.execute(sql`SELECT id FROM identities`);
    expect(identities.length).toBe(0);
  });

  it("a provider account with no verified email cannot create an account", async () => {
    const app = await makeApp();
    routes.__setOAuthFetchForTests(mockGithub({ emails: [] }) as unknown as typeof fetch);
    const state = await startAttempt(app);

    const done = await request(app, "GET", `/oauth/github/callback?code=c&state=${state}`);
    expect(done.status).toBe(400);
    expect(done.text).toContain("verified email");
    const accounts = await db.execute(sql`SELECT id FROM accounts`);
    expect(accounts.length).toBe(0);
  });

  it("the provider's cancel comes back as a page, not a stack trace", async () => {
    const app = await makeApp();
    const done = await request(app, "GET", `/oauth/github/callback?error=access_denied&state=x`);
    expect(done.status).toBe(200);
    expect(done.text).toContain("cancelled");
  });

  it("an unconfigured provider 404s at start rather than failing at the callback", async () => {
    const app = await makeApp();
    const saved = process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_ID;
    const started = await request(app, "GET", "/oauth/discord/start?continue=%2F");
    expect(started.status).toBe(404);
    // The page HTML-escapes its apostrophe ("isn&#39;t configured"), so the
    // assertion matches around it. The original "isn't configured" form had
    // never actually run against a database — it failed the first time it did.
    expect(started.text).toContain("configured");
    if (saved) process.env.DISCORD_CLIENT_ID = saved;
  });
});
