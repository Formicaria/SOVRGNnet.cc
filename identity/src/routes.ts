import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueToken,
} from "@shared/identity";
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode,
} from "@shared/deviceFlow";
import {
  buildAuthorizeUrl,
  configuredProviders,
  generatePkce,
  generateState,
  githubPrimaryEmail,
  isProviderId,
  matchBrokerAccount,
  mergeGithubEmail,
  normalizeProfile,
  PROVIDERS,
} from "@shared/oauthProviders";
import {
  accounts,
  deviceAuthorizations,
  emailTokens,
  grants,
  identities,
  oauthAttempts,
  recoveryCodes,
  sessions,
} from "../schema";
import {
  generateOpaqueToken,
  generateSubject,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "./accounts";
import { buildReturnRedirect, resolveReturnTarget } from "@shared/ssoFlow";
import { getDb } from "./db";
import { emailFromBody, LIMITS, rateLimit } from "./rateLimit";
import { jwks, loadKeys } from "./keys";
import {
  devicePage,
  deviceSignInPage,
  errorPage,
  recoveryCodesPage,
  registerPage,
  signInPage,
} from "./pages";
import {
  emailEnabled,
  passwordResetEmail,
  recoveryUsedEmail,
  verificationEmail,
  type MailTransport,
} from "./mail";

const SESSION_COOKIE = "sovrgnnet_identity";
const SESSION_TTL_DAYS = 30;
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1;
const OAUTH_ATTEMPT_TTL_MINUTES = 10;

/**
 * Swapped by tests so provider exchanges hit a mock and never the internet —
 * the same arrangement matrixService uses, for the same reason: a test that
 * dials Google is a test that fails on somebody's train.
 */
let oauthFetch: typeof fetch = (...args) => fetch(...args);
export function __setOAuthFetchForTests(impl: typeof fetch): void {
  oauthFetch = impl;
}

/**
 * The only continuations a provider callback may resume are pages on this
 * service. Anything absolute — or scheme-relative, which `//evil.example`
 * is — is discarded before storage rather than after, because a continuation
 * an attacker chooses turns a successful sign-in into a redirect wearing our
 * chrome.
 */
function safeContinue(raw: unknown): string {
  const value = String(raw ?? "");
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

/** Provider buttons for the sign-in pages: whatever the operator configured. */
function providerList(): Array<{ id: string; label: string }> {
  return configuredProviders(process.env).map(p => ({ id: p.id, label: p.label }));
}

const credentials = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
});

function baseUrl(): string {
  return (process.env.IDENTITY_PUBLIC_URL ?? "https://sovrgnnet.cc").replace(
    /\/+$/,
    ""
  );
}

function setSession(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

/** The account behind the request's session cookie, if any. */
async function currentAccount(req: Request) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;

  const db = await getDb();
  const rows = await db
    .select({ account: accounts })
    .from(sessions)
    .innerJoin(accounts, eq(sessions.accountId, accounts.id))
    .where(
      and(
        eq(sessions.tokenHash, hashOpaqueToken(raw)),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  const account = rows[0]?.account ?? null;
  if (!account || account.suspendedAt) return null;
  return account;
}

/**
 * Cross-origin access for the endpoints a native app calls.
 *
 * The desktop shell runs in a webview whose origin is `tauri://localhost`, so
 * every call it makes to this service is cross-origin. Without these headers
 * the browser refuses to expose the response and `fetch` rejects with a bare
 * `TypeError` — which WebKitGTK, the webview on Linux, words as "Load failed".
 *
 * That is what desktop sign-in showed. The request arrived, the service
 * answered it correctly, and the browser threw the answer away. `curl` and
 * every other check we ran succeeded, because nothing but a browser enforces
 * CORS — so the endpoints that exist *specifically* for a native client to
 * call had never once worked from one.
 *
 * ## Why `*` is safe on exactly these routes, and nowhere else
 *
 * Every route below authenticates with something carried *in the request*: a
 * device code, or a bearer token. There is no ambient authority for another
 * origin to borrow — a hostile page cannot obtain the token, and holding it is
 * the whole of being authorised.
 *
 * The cookie-authenticated routes (`/api/me`, `/api/logout`, sign-in, the
 * browser approval pages) deliberately get none of this. Those carry ambient
 * authority, and opening them cross-origin is how a page nobody trusts acts as
 * somebody who is signed in. Browsers also refuse `*` together with
 * credentials, which is the specification agreeing.
 *
 * `Access-Control-Allow-Credentials` is therefore never set, so cookies cannot
 * ride along even by accident.
 */
function nativeClientCors(req: Request, res: Response, next: NextFunction): void {
  res.set("Access-Control-Allow-Origin", "*");
  // Authorization for the bearer-token routes, Content-Type for the JSON
  // bodies. Both make a request "not simple", which is what triggers the
  // preflight this also has to answer.
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Max-Age", "600");

  // The preflight itself. Express does not answer OPTIONS for a route
  // registered only for GET or POST, so without this the browser never gets
  // as far as sending the real request.
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

export function registerRoutes(app: Express, mail: MailTransport): void {
  // The three endpoints the desktop shell calls, and only those.
  app.use(
    ["/api/device/code", "/api/device/token", "/api/grants", "/api/grants/:instanceId/revoke"],
    nativeClientCors
  );

  /**
   * The public keys every server verifies tokens against.
   *
   * Cacheable and boring by design. Servers hold these for an hour and keep
   * serving them if this endpoint is unreachable, so a blip here does not log
   * anybody out anywhere.
   */
  app.get("/.well-known/jwks.json", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.set("Access-Control-Allow-Origin", "*");
    res.json(jwks());
  });

  app.get("/.well-known/sovrgnnet-identity", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      issuer: baseUrl(),
      jwks_uri: `${baseUrl()}/.well-known/jwks.json`,
      token_endpoint: `${baseUrl()}/api/token`,
      algorithms: ["EdDSA"],
    });
  });

  // ------------------------------------------------------------------ signup

  app.post(
    "/api/register",
    rateLimit({ ...LIMITS.register, alsoKeyOn: emailFromBody }),
    async (req, res) => {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "A valid email and a password of 8+ characters." });
      }

      const email = normalizeEmail(parsed.data.email);
      const db = await getDb();

      const taken = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.email, email))
        .limit(1);
      if (taken.length > 0) {
        return res
          .status(409)
          .json({ error: "An account with that email already exists." });
      }

      const [account] = await db
        .insert(accounts)
        .values({
          subject: generateSubject(),
          email,
          passwordHash: await hashPassword(parsed.data.password),
          displayName:
            typeof req.body?.name === "string"
              ? req.body.name.slice(0, 80)
              : null,
        })
        .returning();

      // Shown exactly once, here. There is deliberately no way to read them
      // back — storing anything recoverable would defeat the point.
      const codes = generateRecoveryCodes(8);
      await db
        .insert(recoveryCodes)
        .values(
          codes.map(code => ({
            accountId: account.id,
            codeHash: hashRecoveryCode(code),
          }))
        );

      if (emailEnabled()) {
        const verify = generateOpaqueToken();
        await db.insert(emailTokens).values({
          accountId: account.id,
          purpose: "verify",
          tokenHash: verify.hash,
          expiresAt: new Date(Date.now() + VERIFY_TTL_HOURS * 60 * 60 * 1000),
        });
        await mail
          .send(
            verificationEmail(
              email,
              `${baseUrl()}/verify?token=${verify.token}`
            )
          )
          .catch(error =>
            console.error("[identity] couldn't send verification email:", error)
          );
      }

      const session = generateOpaqueToken();
      await db.insert(sessions).values({
        accountId: account.id,
        tokenHash: session.hash,
        userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
        expiresAt: new Date(
          Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
        ),
      });
      setSession(res, session.token);

      res.status(201).json({
        subject: account.subject,
        email: account.email,
        emailVerified: false,
        recoveryCodes: codes,
        // Deliberately blunt when email is off, because in that mode this really
        // is the only way back and there is nobody who can override it.
        warning: emailEnabled()
          ? "Save these recovery codes somewhere safe. They're shown once, and they're the way back into your account if you lose access to your email."
          : "Save these recovery codes now. This server has no email, so they are the ONLY way back into your account. They're shown once. If you lose them, the account is gone and nobody — including whoever runs this service — can restore it.",
      });
    }
  );

  /**
   * Replace every recovery code with a fresh set.
   *
   * Essential when email is off, because there is no other way to recover from
   * having used or mislaid the codes. Requires the current password, so a
   * borrowed session can't quietly mint a new way in.
   */
  app.post(
    "/api/recovery-codes/regenerate",
    rateLimit(LIMITS.signIn),
    async (req, res) => {
      const account = await currentAccount(req);
      if (!account) return res.status(401).json({ error: "Not signed in." });

      const password = String(req.body?.password ?? "");
      if (account.passwordHash == null) {
        // A provider-only account has no password to prove with. Requiring one
        // would lock these people out of regenerating codes entirely; a fresh
        // sign-in through their provider is the equivalent proof.
        return res.status(400).json({
          error:
            "This account signs in through a provider and has no password. Sign in again to regenerate codes.",
        });
      }
      if (!(await verifyPassword(password, account.passwordHash))) {
        return res.status(401).json({ error: "That password is incorrect." });
      }

      const db = await getDb();
      const codes = generateRecoveryCodes(8);

      // Old codes go, including unused ones. A regenerated set that left the
      // previous batch working would defeat the point of regenerating.
      await db
        .delete(recoveryCodes)
        .where(eq(recoveryCodes.accountId, account.id));
      await db
        .insert(recoveryCodes)
        .values(
          codes.map(code => ({
            accountId: account.id,
            codeHash: hashRecoveryCode(code),
          }))
        );

      res.json({
        recoveryCodes: codes,
        warning: "Your previous codes no longer work. Save these.",
      });
    }
  );

  /** How many codes are left, so the UI can nag before it's too late. */
  app.get("/api/recovery-codes/status", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });

    const db = await getDb();
    const unused = await db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.accountId, account.id),
          isNull(recoveryCodes.usedAt)
        )
      );

    res.json({
      remaining: unused.length,
      emailRecoveryAvailable: emailEnabled() && account.emailVerified,
    });
  });

  // ------------------------------------------------------------------ signin

  app.post(
    "/api/login",
    rateLimit({ ...LIMITS.signIn, alsoKeyOn: emailFromBody }),
    async (req, res) => {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "Email and password required." });

      const db = await getDb();
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, normalizeEmail(parsed.data.email)))
        .limit(1);

      // Identical response either way — a different error for "no such account"
      // turns this endpoint into a way to enumerate who has one. An account with
      // no password (provider-only) fails here for the same reason and with the
      // same message, rather than revealing how it signs in.
      const ok =
        account?.passwordHash != null &&
        (await verifyPassword(parsed.data.password, account.passwordHash));
      if (!ok || account.suspendedAt) {
        return res.status(401).json({ error: "Incorrect email or password." });
      }

      const session = generateOpaqueToken();
      await db.insert(sessions).values({
        accountId: account.id,
        tokenHash: session.hash,
        userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
        expiresAt: new Date(
          Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
        ),
      });
      await db
        .update(accounts)
        .set({ lastSignedIn: new Date() })
        .where(eq(accounts.id, account.id));
      setSession(res, session.token);

      res.json({
        subject: account.subject,
        email: account.email,
        emailVerified: account.emailVerified,
        displayName: account.displayName,
      });
    }
  );

  app.post("/api/logout", async (req, res) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) {
      const db = await getDb();
      await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, hashOpaqueToken(raw)));
    }
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });
    res.json({
      subject: account.subject,
      email: account.email,
      emailVerified: account.emailVerified,
      displayName: account.displayName,
      avatar: account.avatar,
    });
  });

  // ------------------------------------------------------------------- token

  /**
   * Mint a token for one server.
   *
   * The audience is whatever instance id the client asks for. This service
   * doesn't verify that the server exists — it has no directory and wants
   * none. What matters is that the token names one server and works only
   * there, which the signature binds.
   */
  app.post("/api/token", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });

    const parsed = z
      .object({
        instanceId: z
          .string()
          .regex(/^[0-9a-f]{16}$/, "Not a valid instance id"),
        instanceName: z.string().max(120).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Bad request" });
    }

    const db = await getDb();

    // A revoked grant means the person told us to forget this server.
    const [existing] = await db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.accountId, account.id),
          eq(grants.instanceId, parsed.data.instanceId)
        )
      )
      .limit(1);

    if (existing?.revokedAt) {
      return res
        .status(403)
        .json({ error: "You've revoked this server's access." });
    }

    const token = issueToken(loadKeys().active, {
      subject: account.subject,
      audience: parsed.data.instanceId,
      name: account.displayName ?? undefined,
      email: account.email,
      emailVerified: account.emailVerified,
    });

    if (existing) {
      await db
        .update(grants)
        .set({ lastUsedAt: new Date() })
        .where(eq(grants.id, existing.id));
    } else {
      // No instanceUrl. This path has no origin: it is a server calling the
      // API with an id and a name it chose for itself, and there is nothing
      // here this service has checked. Recording a self-reported address in a
      // screen people use to decide what to revoke would be handing the party
      // being authorised a line of text inside the security UI.
      //
      // instanceName is stored because the list is unusable without something
      // human-readable, but it is presented as self-reported until the browser
      // flow resolves the instance and fills in an address.
      await db.insert(grants).values({
        accountId: account.id,
        instanceId: parsed.data.instanceId,
        instanceName: parsed.data.instanceName ?? null,
      });
    }

    res.json({ token });
  });

  // --------------------------------------------------------------- authorize

  /**
   * The hand-off a server sends people to.
   *
   *   GET /authorize?return=https://chat.example.com/sso/callback
   *
   * Note what is *not* a parameter: which server the token is for. That's
   * resolved by asking the return origin what instance it is, so a token can
   * only ever be minted for the server actually receiving it. Accepting the
   * audience from the caller would let anyone request a token for someone
   * else's server and have it delivered to a URL they control.
   */
  app.get("/authorize", async (req, res) => {
    const returnUrl = String(req.query.return ?? "");

    const target = await resolveReturnTarget(returnUrl, fetch);
    if (!target.ok) {
      return res.status(400).send(errorPage("Can't continue", target.message));
    }

    const account = await currentAccount(req);
    if (!account) {
      return res.send(
        signInPage({
          returnUrl,
          instanceName: target.instanceName,
          instanceHost: new URL(target.origin).host,
          providers: providerList(),
        })
      );
    }

    const db = await getDb();
    const [existing] = await db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.accountId, account.id),
          eq(grants.instanceId, target.instanceId)
        )
      )
      .limit(1);

    if (existing?.revokedAt) {
      return res
        .status(403)
        .send(
          errorPage(
            "Access revoked",
            "You previously revoked this server's access to your account. Restore it from your account settings if you meant to sign in again."
          )
        );
    }

    const token = issueToken(loadKeys().active, {
      subject: account.subject,
      audience: target.instanceId,
      name: account.displayName ?? undefined,
      email: account.email,
      emailVerified: account.emailVerified,
    });

    // `target.origin` came from resolveReturnTarget: this service followed the
    // return URL and read the instance descriptor there. It is an observation,
    // not a claim, which is the only reason it is allowed into the grant list
    // at all — see the column comment in schema.ts.
    //
    // Refreshed on every use, deliberately. A desktop host that was restored
    // onto a different port, or an instance that moved, should show where it
    // is *now*; a grant list pointing at last year's address is the failure
    // this column exists to fix, and it would come straight back if the value
    // were only written once.
    if (existing) {
      await db
        .update(grants)
        .set({
          lastUsedAt: new Date(),
          instanceName: target.instanceName,
          instanceUrl: target.origin,
        })
        .where(eq(grants.id, existing.id));
    } else {
      await db.insert(grants).values({
        accountId: account.id,
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        instanceUrl: target.origin,
      });
    }

    // Fragment, not query: fragments never reach a server, stay out of access
    // logs, and don't leak through Referer.
    res.redirect(302, buildReturnRedirect(returnUrl, token));
  });

  app.get("/register", async (req, res) => {
    const returnUrl = String(req.query.return ?? "");
    const target = await resolveReturnTarget(returnUrl, fetch);
    if (!target.ok) {
      return res.status(400).send(errorPage("Can't continue", target.message));
    }
    res.send(
      registerPage({
        returnUrl,
        instanceName: target.instanceName,
        emailDisabled: !emailEnabled(),
        providers: providerList(),
      })
    );
  });

  app.get("/recovery-codes", (req, res) => {
    res.send(recoveryCodesPage(String(req.query.return ?? "")));
  });

  // ---------------------------------------------------------- oauth broker
  //
  // shared/oauthProviders.ts held the whole broker — PKCE, per-provider
  // profile normalization, the account-matching rule, 38 tests — and was
  // imported by nothing. The site said sign-in "goes through Google,
  // Microsoft, GitHub, or Discord" while the only working way in was the
  // email form. These two routes put the mechanism in the path. The account
  // schema was already shaped for it (`identities`, `oauthAttempts`), which
  // is how a claim gets ahead of a product: every layer but the last one.

  app.get("/oauth/:provider/start", rateLimit(LIMITS.signIn), async (req, res) => {
    const id = String(req.params.provider);
    if (!isProviderId(id)) {
      return res.status(404).send(errorPage("Unknown provider", "That sign-in provider doesn't exist."));
    }
    const clientId = process.env[`${id.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${id.toUpperCase()}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      return res
        .status(404)
        .send(errorPage("Not available", `${PROVIDERS[id].label} sign-in isn't configured on this service.`));
    }

    // link=1 attaches this provider to the *current* account instead of
    // signing in — which is why it demands a session: linking is claiming,
    // and only someone who has already proved the account is theirs may.
    let linkToAccountId: number | null = null;
    if (String(req.query.link ?? "") === "1") {
      const account = await currentAccount(req);
      if (!account) {
        return res.status(401).send(errorPage("Sign in first", "Linking a provider happens from inside a signed-in session."));
      }
      linkToAccountId = account.id;
    }

    const provider = PROVIDERS[id];
    const state = generateState();
    const pkce = provider.usesPkce ? generatePkce() : null;

    const db = await getDb();
    await db.insert(oauthAttempts).values({
      state,
      provider: id,
      codeVerifier: pkce?.verifier ?? null,
      returnUrl: safeContinue(req.query.continue),
      linkToAccountId,
      expiresAt: new Date(Date.now() + OAUTH_ATTEMPT_TTL_MINUTES * 60 * 1000),
    });

    res.redirect(
      302,
      buildAuthorizeUrl(provider, {
        clientId,
        redirectUri: `${baseUrl()}/oauth/${id}/callback`,
        state,
        codeChallenge: pkce?.challenge,
      })
    );
  });

  app.get("/oauth/:provider/callback", rateLimit(LIMITS.signIn), async (req, res) => {
    const id = String(req.params.provider);
    if (!isProviderId(id)) {
      return res.status(404).send(errorPage("Unknown provider", "That sign-in provider doesn't exist."));
    }
    const provider = PROVIDERS[id];

    // The person pressed cancel at the provider, or the provider refused.
    // Ordinary, not an error worth a stack trace.
    if (typeof req.query.error === "string" && req.query.error) {
      return res.send(errorPage("Sign-in cancelled", `${provider.label} didn't complete the sign-in. Nothing has changed; you can try again.`));
    }

    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) {
      return res.status(400).send(errorPage("Can't continue", "The provider's reply was missing its code or state."));
    }

    // Delete-returning makes the state single-use by construction: a replayed
    // callback finds nothing, whatever the timing. Expiry is checked in the
    // same statement so an expired row can't be consumed either.
    const db = await getDb();
    const [attempt] = await db
      .delete(oauthAttempts)
      .where(
        and(
          eq(oauthAttempts.state, state),
          eq(oauthAttempts.provider, id),
          gt(oauthAttempts.expiresAt, new Date())
        )
      )
      .returning();
    if (!attempt) {
      return res.status(400).send(errorPage("Sign-in expired", "That sign-in attempt expired or was already used. Start again from the sign-in page."));
    }

    const clientId = process.env[`${id.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${id.toUpperCase()}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      return res.status(404).send(errorPage("Not available", `${provider.label} sign-in isn't configured on this service.`));
    }

    // -- code → access token --------------------------------------------------
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${baseUrl()}/oauth/${id}/callback`,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (attempt.codeVerifier) form.set("code_verifier", attempt.codeVerifier);

    // Accept: application/json matters for GitHub, whose token endpoint
    // answers form-encoded unless asked otherwise.
    const tokenRes = await oauthFetch(provider.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    if (!tokenRes.ok) {
      return res.status(502).send(errorPage("Provider refused", `${provider.label} refused the token exchange (HTTP ${tokenRes.status}). If this persists, the client secret configured here is probably wrong.`));
    }
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenBody.access_token) {
      return res.status(502).send(errorPage("Provider refused", `${provider.label} answered the exchange without an access token.`));
    }

    // -- access token → who this is ------------------------------------------
    // GitHub's API refuses requests without a User-Agent; harmless elsewhere.
    const authHeaders = {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: "application/json",
      "User-Agent": "sovrgnnet-identity",
    };
    const profileRes = await oauthFetch(provider.userInfoUrl, { headers: authHeaders });
    if (!profileRes.ok) {
      return res.status(502).send(errorPage("Provider refused", `${provider.label} wouldn't say who signed in (HTTP ${profileRes.status}).`));
    }
    let profile = normalizeProfile(id, (await profileRes.json().catch(() => ({}))) as Record<string, unknown>);
    if (!profile) {
      return res.status(502).send(errorPage("Provider refused", `${provider.label}'s profile response wasn't readable.`));
    }
    if (id === "github") {
      // The profile endpoint returns only the public email, usually null; the
      // real, verified address is a second call away.
      const emailsRes = await oauthFetch("https://api.github.com/user/emails", { headers: authHeaders });
      if (emailsRes.ok) {
        const list = (await emailsRes.json().catch(() => [])) as Array<Record<string, unknown>>;
        profile = mergeGithubEmail(profile, githubPrimaryEmail(list));
      }
    }

    // -- linking a second provider to a signed-in account ---------------------
    if (attempt.linkToAccountId) {
      try {
        await db.insert(identities).values({
          accountId: attempt.linkToAccountId,
          provider: id,
          providerUserId: profile.providerUserId,
          email: profile.email,
          emailVerified: profile.emailVerified,
        });
      } catch {
        // The unique (provider, providerUserId) constraint: this third-party
        // account already belongs to somebody. Refusing is the only honest
        // answer — silently re-pointing it would steal it from them.
        return res.status(409).send(errorPage("Already linked", `That ${provider.label} account is already linked to a different SOVRGN account.`));
      }
      return res.redirect(302, safeContinue(attempt.returnUrl));
    }

    // -- sign in, create, or refuse -------------------------------------------
    const [byIdentity] = await db
      .select({ accountId: identities.accountId, identityId: identities.id })
      .from(identities)
      .where(and(eq(identities.provider, id), eq(identities.providerUserId, profile.providerUserId)))
      .limit(1);

    const byEmail = profile.email
      ? await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.email, normalizeEmail(profile.email)))
          .limit(1)
      : [];

    const match = matchBrokerAccount({
      profile,
      existingByIdentity: byIdentity ? { id: byIdentity.accountId } : null,
      existingByEmail: byEmail[0] ?? null,
    });

    if (match.action === "refuse") {
      return res.status(409).send(errorPage("Account already exists", match.message));
    }

    let accountId: number;
    if (match.action === "create") {
      // accounts.email is NOT NULL and the linking rules lean on it, so an
      // account can only be created from a provider-verified address. The
      // failure is spelled out per provider because each has a different fix.
      if (!profile.email || !profile.emailVerified) {
        return res.status(400).send(errorPage(
          "No verified email",
          `Your ${provider.label} account didn't provide a verified email address, and SOVRGN needs one to create an account. Verify an address with ${provider.label} and try again, or create an account with email and password instead.`
        ));
      }
      try {
        const [account] = await db
          .insert(accounts)
          .values({
            subject: generateSubject(),
            email: normalizeEmail(profile.email),
            emailVerified: true,
            passwordHash: null,
            displayName: profile.name,
            avatar: profile.avatar,
          })
          .returning();
        await db.insert(identities).values({
          accountId: account.id,
          provider: id,
          providerUserId: profile.providerUserId,
          email: profile.email,
          emailVerified: profile.emailVerified,
        });
        accountId = account.id;
      } catch {
        // Two tabs racing, or an email registered between our check and the
        // insert. Same shape as the deliberate refusal, same guidance.
        return res.status(409).send(errorPage(
          "Account already exists",
          "An account already uses that email address. Sign in the way you did before, then link this provider from your account settings."
        ));
      }
    } else {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, match.accountId)).limit(1);
      if (!account || account.suspendedAt) {
        return res.status(403).send(errorPage("Account unavailable", "This account is suspended."));
      }
      accountId = account.id;
      await db
        .update(identities)
        .set({ lastUsedAt: new Date(), email: profile.email, emailVerified: profile.emailVerified })
        .where(eq(identities.id, byIdentity!.identityId));
    }

    // Same session shape as /api/login — a provider sign-in is a sign-in.
    const session = generateOpaqueToken();
    await db.insert(sessions).values({
      accountId,
      tokenHash: session.hash,
      userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
    await db.update(accounts).set({ lastSignedIn: new Date() }).where(eq(accounts.id, accountId));
    setSession(res, session.token);

    res.redirect(302, safeContinue(attempt.returnUrl));
  });

  // ------------------------------------------------------------- device flow

  /**
   * Start a desktop sign-in.
   *
   * Returns a secret the app polls with and a short code the person types in
   * their browser. Unauthenticated by necessity — nobody is signed in yet —
   * which is safe because a code is worthless until somebody who *is* signed
   * in approves it.
   */
  app.post(
    "/api/device/code",
    rateLimit(LIMITS.deviceCode),
    async (_req, res) => {
      const db = await getDb();

      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();
      const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

      await db.insert(deviceAuthorizations).values({
        deviceCodeHash: hashOpaqueToken(deviceCode),
        userCode,
        expiresAt,
      });

      res.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${baseUrl()}/device`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      });
    }
  );

  /**
   * The app asking whether its code has been approved yet.
   *
   * Answers in the shape the device-flow spec uses, because the client
   * interprets those error strings — see shared/deviceFlow.ts.
   */
  app.post("/api/device/token", async (req, res) => {
    const deviceCode = String(req.body?.device_code ?? "");
    if (!deviceCode) return res.status(400).json({ error: "invalid_request" });

    const db = await getDb();
    const [pending] = await db
      .select()
      .from(deviceAuthorizations)
      .where(
        eq(deviceAuthorizations.deviceCodeHash, hashOpaqueToken(deviceCode))
      )
      .limit(1);

    if (!pending) return res.status(400).json({ error: "expired_token" });

    if (pending.expiresAt.getTime() <= Date.now()) {
      await db
        .delete(deviceAuthorizations)
        .where(eq(deviceAuthorizations.id, pending.id));
      return res.status(400).json({ error: "expired_token" });
    }

    // Polling faster than asked gets a back-off rather than a ban.
    const since = pending.lastPolledAt
      ? Date.now() - pending.lastPolledAt.getTime()
      : Infinity;
    if (since < (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000) {
      return res
        .status(400)
        .json({
          error: "slow_down",
          interval: DEVICE_POLL_INTERVAL_SECONDS + 5,
        });
    }
    await db
      .update(deviceAuthorizations)
      .set({ lastPolledAt: new Date(), polls: pending.polls + 1 })
      .where(eq(deviceAuthorizations.id, pending.id));

    if (pending.status === "denied") {
      await db
        .delete(deviceAuthorizations)
        .where(eq(deviceAuthorizations.id, pending.id));
      return res.status(400).json({ error: "access_denied" });
    }
    if (pending.status !== "approved" || !pending.accountId) {
      return res.status(400).json({ error: "authorization_pending" });
    }

    // Approved. Claim the authorization *before* minting anything.
    //
    // This used to mint the session and then delete the row, which is two
    // statements and therefore a race: a device polling on its normal interval
    // while a retry or a duplicate request is in flight has both reads seeing
    // "approved", and one approval becomes two sessions — neither of which the
    // person who approved it knows about.
    //
    // The delete is the claim. Exactly one caller gets a row back, and only
    // that caller mints. Deleting first means a failure between the two loses
    // the authorization and the device has to start over, which is the right
    // way round to fail: starting over is an inconvenience, a second session
    // nobody knows about is not.
    const [claimed] = await db
      .delete(deviceAuthorizations)
      .where(
        and(
          eq(deviceAuthorizations.id, pending.id),
          eq(deviceAuthorizations.status, "approved")
        )
      )
      .returning({ accountId: deviceAuthorizations.accountId });

    if (!claimed?.accountId) {
      // Someone else took it between the read above and here.
      return res.status(400).json({ error: "expired_token" });
    }

    const session = generateOpaqueToken();
    await db.insert(sessions).values({
      accountId: claimed.accountId,
      tokenHash: session.hash,
      userAgent: "SOVRGNnet desktop",
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    res.json({ session_token: session.token });
  });

  /** The page someone lands on to approve a desktop sign-in. */
  app.get("/device", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) {
      // Sign in first, then come back here — the code survives in the URL.
      const back = `/device${req.query.code ? `?code=${encodeURIComponent(String(req.query.code))}` : ""}`;
      return res.send(
        deviceSignInPage(
          back,
          typeof req.query.code === "string" ? req.query.code : "",
          providerList()
        )
      );
    }
    res.send(
      devicePage(
        typeof req.query.code === "string" ? req.query.code : "",
        account.email
      )
    );
  });

  /** Approving or refusing a desktop sign-in, from the browser. */
  app.post(
    "/api/device/approve",
    rateLimit(LIMITS.deviceApprove),
    async (req, res) => {
      const account = await currentAccount(req);
      if (!account) return res.status(401).json({ error: "Not signed in." });

      const parsed = z
        .object({ user_code: z.string().min(1).max(16), approve: z.boolean() })
        .safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "Enter the code from the app." });

      const db = await getDb();

      // Matched in one query rather than by loading every pending authorization
      // and scanning it in memory. That worked, and it made an unauthenticated-
      // adjacent endpoint's cost grow with the number of devices waiting — which
      // anyone can inflate by asking for device codes.
      //
      // Normalising in SQL is safe here because the generated alphabet excludes
      // O, I, 0 and 1, so `normalizeUserCode`'s letter-to-digit substitutions can
      // never apply to a *stored* code. Removing the dash is the whole of it, and
      // that keeps the leniency the client-side matcher had: typed lowercase,
      // spaced, or without the dash all still find it.
      const normalized = normalizeUserCode(parsed.data.user_code);
      const [match] = await db
        .select()
        .from(deviceAuthorizations)
        .where(
          and(
            eq(deviceAuthorizations.status, "pending"),
            gt(deviceAuthorizations.expiresAt, new Date()),
            sql`replace(${deviceAuthorizations.userCode}, '-', '') = ${normalized}`
          )
        )
        .limit(1);

      if (!match) {
        return res
          .status(400)
          .json({ error: "That code isn't valid, or it expired." });
      }

      await db
        .update(deviceAuthorizations)
        .set({
          status: parsed.data.approve ? "approved" : "denied",
          accountId: parsed.data.approve ? account.id : null,
        })
        .where(eq(deviceAuthorizations.id, match.id));

      res.json({ ok: true, approved: parsed.data.approve });
    }
  );

  // ------------------------------------------------------------------ grants

  app.get("/api/grants", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });

    const db = await getDb();
    const rows = await db
      .select()
      .from(grants)
      .where(eq(grants.accountId, account.id));
    res.json(
      rows.map(row => ({
        instanceId: row.instanceId,
        instanceName: row.instanceName,
        // Null when this grant has only ever come through the API flow. The
        // client is expected to say that plainly rather than render an empty
        // field — "we have never resolved this server ourselves" is the useful
        // fact, and it is not the same as "it has no address".
        instanceUrl: row.instanceUrl,
        firstUsedAt: row.firstUsedAt,
        lastUsedAt: row.lastUsedAt,
        revoked: row.revokedAt != null,
      }))
    );
  });

  app.post("/api/grants/:instanceId/revoke", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });

    const db = await getDb();
    await db
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(grants.accountId, account.id),
          eq(grants.instanceId, req.params.instanceId)
        )
      );

    // Honest about the limit: revoking stops new tokens. A token already
    // issued stays valid until it expires, which is at most five minutes, and
    // the local account that server created is theirs to remove, not ours.
    res.json({
      revoked: true,
      note: "New sign-ins are blocked. Any token already issued expires within five minutes. Your account on that server still exists — remove it there.",
    });
  });

  // ---------------------------------------------------------------- recovery

  app.post("/api/verify-email", rateLimit(LIMITS.signIn), async (req, res) => {
    if (!emailEnabled()) {
      return res
        .status(501)
        .json({ error: "This service doesn't send email." });
    }
    const token = String(req.body?.token ?? "");
    if (!token) return res.status(400).json({ error: "Missing token." });

    const db = await getDb();
    const [row] = await db
      .select()
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.tokenHash, hashOpaqueToken(token)),
          eq(emailTokens.purpose, "verify"),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!row)
      return res
        .status(400)
        .json({ error: "That link is invalid or has expired." });

    // Claimed conditionally like the others. Verifying twice is harmless in
    // itself — the outcome is idempotent — but a token that survives its own
    // use is a token that can be replayed, and the consistency is worth more
    // than the one saved statement.
    const [claimed] = await db
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(emailTokens.id, row.id), isNull(emailTokens.usedAt)))
      .returning({ id: emailTokens.id });

    if (!claimed) {
      return res
        .status(400)
        .json({ error: "That link is invalid or has expired." });
    }

    await db
      .update(accounts)
      .set({ emailVerified: true })
      .where(eq(accounts.id, row.accountId));
    res.json({ verified: true });
  });

  app.post(
    "/api/reset/request",
    rateLimit({ ...LIMITS.resetRequest, alsoKeyOn: emailFromBody }),
    async (req, res) => {
      // Saying "check your inbox" when no email will ever arrive is the worst
      // possible failure here — someone waits, then concludes the account is
      // lost. Say what's actually true and point at the path that works.
      if (!emailEnabled()) {
        return res.status(501).json({
          error: "This service doesn't send email.",
          recovery: "Use one of your recovery codes to set a new password.",
        });
      }

      const email = normalizeEmail(String(req.body?.email ?? ""));
      const db = await getDb();
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, email))
        .limit(1);

      if (account) {
        const reset = generateOpaqueToken();
        await db.insert(emailTokens).values({
          accountId: account.id,
          purpose: "reset",
          tokenHash: reset.hash,
          expiresAt: new Date(Date.now() + RESET_TTL_HOURS * 60 * 60 * 1000),
        });
        await mail
          .send(
            passwordResetEmail(email, `${baseUrl()}/reset?token=${reset.token}`)
          )
          .catch(error =>
            console.error("[identity] couldn't send reset email:", error)
          );
      }

      // Always the same answer, whether or not the account exists. Otherwise
      // this is a way to find out who has one.
      res.json({
        ok: true,
        message: "If that address has an account, a reset link is on its way.",
      });
    }
  );

  app.post(
    "/api/reset/complete",
    rateLimit(LIMITS.recover),
    async (req, res) => {
      const parsed = z
        .object({
          token: z.string().min(1),
          password: z.string().min(8).max(256),
        })
        .safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: "Token and a new password required." });

      const db = await getDb();
      const [row] = await db
        .select()
        .from(emailTokens)
        .where(
          and(
            eq(emailTokens.tokenHash, hashOpaqueToken(parsed.data.token)),
            eq(emailTokens.purpose, "reset"),
            isNull(emailTokens.usedAt),
            gt(emailTokens.expiresAt, new Date())
          )
        )
        .limit(1);

      if (!row)
        return res
          .status(400)
          .json({ error: "That link is invalid or has expired." });

      // Same shape as the recovery-code race, same fix: claim the token before
      // acting on it, conditional on it still being unused, so two clicks on the
      // same reset link can't both reset the password.
      const [claimed] = await db
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(emailTokens.id, row.id), isNull(emailTokens.usedAt)))
        .returning({ id: emailTokens.id });

      if (!claimed) {
        return res
          .status(400)
          .json({ error: "That link is invalid or has expired." });
      }

      await db
        .update(accounts)
        .set({
          passwordHash: await hashPassword(parsed.data.password),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, row.accountId));

      // Every existing session goes. If a password reset was someone else's
      // doing, leaving their session alive would make the reset pointless.
      await db.delete(sessions).where(eq(sessions.accountId, row.accountId));

      res.json({ reset: true });
    }
  );

  /**
   * The way back for someone who has lost access to their email.
   *
   * Without this, the mail provider is the sole root of account security.
   */
  app.post(
    "/api/recover",
    rateLimit({ ...LIMITS.recover, alsoKeyOn: emailFromBody }),
    async (req, res) => {
      const parsed = z
        .object({
          email: z.string().email().max(320),
          code: z.string().min(1).max(32),
          password: z.string().min(8).max(256),
        })
        .safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: "Email, recovery code, and a new password." });

      const db = await getDb();
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, normalizeEmail(parsed.data.email)))
        .limit(1);
      if (!account)
        return res.status(400).json({ error: "That code isn't valid." });

      const unused = await db
        .select()
        .from(recoveryCodes)
        .where(
          and(
            eq(recoveryCodes.accountId, account.id),
            isNull(recoveryCodes.usedAt)
          )
        );

      const outcome = consumeRecoveryCode(
        parsed.data.code,
        unused.map(row => row.codeHash)
      );
      if (!outcome.ok)
        return res.status(400).json({ error: "That code isn't valid." });

      const spent = unused.find(
        row => !outcome.remaining.includes(row.codeHash)
      );
      if (!spent)
        return res.status(400).json({ error: "That code isn't valid." });

      // Spend the code atomically, and spend it *before* changing anything.
      //
      // The select above and the update below used to be independent, so two
      // requests presenting the same code both found it unused and both
      // proceeded — one code, two password resets. `usedAt IS NULL` in the WHERE
      // makes the database pick a winner: the loser gets no row back and is
      // refused, having changed nothing.
      //
      // The ordering matters as much as the atomicity. Setting the password
      // first and marking the code used afterwards would leave a window where a
      // crash spends nothing and changes the password, and a lost race changes
      // it twice.
      const [claimed] = await db
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(eq(recoveryCodes.id, spent.id), isNull(recoveryCodes.usedAt))
        )
        .returning({ id: recoveryCodes.id });

      if (!claimed)
        return res.status(400).json({ error: "That code isn't valid." });

      await db
        .update(accounts)
        .set({
          passwordHash: await hashPassword(parsed.data.password),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
      await db.delete(sessions).where(eq(sessions.accountId, account.id));

      await mail
        .send(recoveryUsedEmail(account.email, outcome.remaining.length))
        .catch(() => {
          // The person may well have lost this mailbox — that's why they're
          // here. Failing to warn them must not fail the recovery.
        });

      res.json({
        recovered: true,
        remainingCodes: outcome.remaining.length,
        note:
          outcome.remaining.length === 0
            ? "That was your last recovery code. Generate new ones now."
            : undefined,
      });
    }
  );
}
