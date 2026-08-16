import type { Express, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueToken,
} from "@shared/identity";
import { accounts, emailTokens, grants, recoveryCodes, sessions } from "../schema";
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
import { jwks, loadKeys } from "./keys";
import { errorPage, recoveryCodesPage, registerPage, signInPage } from "./pages";
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

const credentials = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
});

function baseUrl(): string {
  return (process.env.IDENTITY_PUBLIC_URL ?? "https://sovrgnnet.cc").replace(/\/+$/, "");
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
    .where(and(eq(sessions.tokenHash, hashOpaqueToken(raw)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const account = rows[0]?.account ?? null;
  if (!account || account.suspendedAt) return null;
  return account;
}

export function registerRoutes(app: Express, mail: MailTransport): void {
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

  app.post("/api/register", async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email and a password of 8+ characters." });
    }

    const email = normalizeEmail(parsed.data.email);
    const db = await getDb();

    const taken = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email)).limit(1);
    if (taken.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const [account] = await db
      .insert(accounts)
      .values({
        subject: generateSubject(),
        email,
        passwordHash: await hashPassword(parsed.data.password),
        displayName: typeof req.body?.name === "string" ? req.body.name.slice(0, 80) : null,
      })
      .returning();

    // Shown exactly once, here. There is deliberately no way to read them
    // back — storing anything recoverable would defeat the point.
    const codes = generateRecoveryCodes(8);
    await db.insert(recoveryCodes).values(
      codes.map(code => ({ accountId: account.id, codeHash: hashRecoveryCode(code) }))
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
        .send(verificationEmail(email, `${baseUrl()}/verify?token=${verify.token}`))
        .catch(error => console.error("[identity] couldn't send verification email:", error));
    }

    const session = generateOpaqueToken();
    await db.insert(sessions).values({
      accountId: account.id,
      tokenHash: session.hash,
      userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
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
  });

  /**
   * Replace every recovery code with a fresh set.
   *
   * Essential when email is off, because there is no other way to recover from
   * having used or mislaid the codes. Requires the current password, so a
   * borrowed session can't quietly mint a new way in.
   */
  app.post("/api/recovery-codes/regenerate", async (req, res) => {
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
    await db.delete(recoveryCodes).where(eq(recoveryCodes.accountId, account.id));
    await db.insert(recoveryCodes).values(
      codes.map(code => ({ accountId: account.id, codeHash: hashRecoveryCode(code) }))
    );

    res.json({
      recoveryCodes: codes,
      warning: "Your previous codes no longer work. Save these.",
    });
  });

  /** How many codes are left, so the UI can nag before it's too late. */
  app.get("/api/recovery-codes/status", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });

    const db = await getDb();
    const unused = await db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.accountId, account.id), isNull(recoveryCodes.usedAt)));

    res.json({
      remaining: unused.length,
      emailRecoveryAvailable: emailEnabled() && account.emailVerified,
    });
  });

  // ------------------------------------------------------------------ signin

  app.post("/api/login", async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Email and password required." });

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
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
    await db.update(accounts).set({ lastSignedIn: new Date() }).where(eq(accounts.id, account.id));
    setSession(res, session.token);

    res.json({
      subject: account.subject,
      email: account.email,
      emailVerified: account.emailVerified,
      displayName: account.displayName,
    });
  });

  app.post("/api/logout", async (req, res) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) {
      const db = await getDb();
      await db.delete(sessions).where(eq(sessions.tokenHash, hashOpaqueToken(raw)));
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
        instanceId: z.string().regex(/^[0-9a-f]{16}$/, "Not a valid instance id"),
        instanceName: z.string().max(120).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Bad request" });
    }

    const db = await getDb();

    // A revoked grant means the person told us to forget this server.
    const [existing] = await db
      .select()
      .from(grants)
      .where(and(eq(grants.accountId, account.id), eq(grants.instanceId, parsed.data.instanceId)))
      .limit(1);

    if (existing?.revokedAt) {
      return res.status(403).json({ error: "You've revoked this server's access." });
    }

    const token = issueToken(loadKeys().active, {
      subject: account.subject,
      audience: parsed.data.instanceId,
      name: account.displayName ?? undefined,
      email: account.email,
      emailVerified: account.emailVerified,
    });

    if (existing) {
      await db.update(grants).set({ lastUsedAt: new Date() }).where(eq(grants.id, existing.id));
    } else {
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
        })
      );
    }

    const db = await getDb();
    const [existing] = await db
      .select()
      .from(grants)
      .where(and(eq(grants.accountId, account.id), eq(grants.instanceId, target.instanceId)))
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

    if (existing) {
      await db
        .update(grants)
        .set({ lastUsedAt: new Date(), instanceName: target.instanceName })
        .where(eq(grants.id, existing.id));
    } else {
      await db.insert(grants).values({
        accountId: account.id,
        instanceId: target.instanceId,
        instanceName: target.instanceName,
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
      })
    );
  });

  app.get("/recovery-codes", (req, res) => {
    res.send(recoveryCodesPage(String(req.query.return ?? "")));
  });

  // ------------------------------------------------------------------ grants

  app.get("/api/grants", async (req, res) => {
    const account = await currentAccount(req);
    if (!account) return res.status(401).json({ error: "Not signed in." });

    const db = await getDb();
    const rows = await db.select().from(grants).where(eq(grants.accountId, account.id));
    res.json(
      rows.map(row => ({
        instanceId: row.instanceId,
        instanceName: row.instanceName,
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
        and(eq(grants.accountId, account.id), eq(grants.instanceId, req.params.instanceId))
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

  app.post("/api/verify-email", async (req, res) => {
    if (!emailEnabled()) {
      return res.status(501).json({ error: "This service doesn't send email." });
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

    if (!row) return res.status(400).json({ error: "That link is invalid or has expired." });

    await db.update(accounts).set({ emailVerified: true }).where(eq(accounts.id, row.accountId));
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
    res.json({ verified: true });
  });

  app.post("/api/reset/request", async (req, res) => {
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
    const [account] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);

    if (account) {
      const reset = generateOpaqueToken();
      await db.insert(emailTokens).values({
        accountId: account.id,
        purpose: "reset",
        tokenHash: reset.hash,
        expiresAt: new Date(Date.now() + RESET_TTL_HOURS * 60 * 60 * 1000),
      });
      await mail
        .send(passwordResetEmail(email, `${baseUrl()}/reset?token=${reset.token}`))
        .catch(error => console.error("[identity] couldn't send reset email:", error));
    }

    // Always the same answer, whether or not the account exists. Otherwise
    // this is a way to find out who has one.
    res.json({ ok: true, message: "If that address has an account, a reset link is on its way." });
  });

  app.post("/api/reset/complete", async (req, res) => {
    const parsed = z
      .object({ token: z.string().min(1), password: z.string().min(8).max(256) })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Token and a new password required." });

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

    if (!row) return res.status(400).json({ error: "That link is invalid or has expired." });

    await db
      .update(accounts)
      .set({ passwordHash: await hashPassword(parsed.data.password), updatedAt: new Date() })
      .where(eq(accounts.id, row.accountId));
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));

    // Every existing session goes. If a password reset was someone else's
    // doing, leaving their session alive would make the reset pointless.
    await db.delete(sessions).where(eq(sessions.accountId, row.accountId));

    res.json({ reset: true });
  });

  /**
   * The way back for someone who has lost access to their email.
   *
   * Without this, the mail provider is the sole root of account security.
   */
  app.post("/api/recover", async (req, res) => {
    const parsed = z
      .object({
        email: z.string().email().max(320),
        code: z.string().min(1).max(32),
        password: z.string().min(8).max(256),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Email, recovery code, and a new password." });

    const db = await getDb();
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, normalizeEmail(parsed.data.email)))
      .limit(1);
    if (!account) return res.status(400).json({ error: "That code isn't valid." });

    const unused = await db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.accountId, account.id), isNull(recoveryCodes.usedAt)));

    const outcome = consumeRecoveryCode(
      parsed.data.code,
      unused.map(row => row.codeHash)
    );
    if (!outcome.ok) return res.status(400).json({ error: "That code isn't valid." });

    const spent = unused.find(row => !outcome.remaining.includes(row.codeHash));
    if (spent) {
      await db
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(recoveryCodes.id, spent.id));
    }

    await db
      .update(accounts)
      .set({ passwordHash: await hashPassword(parsed.data.password), updatedAt: new Date() })
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
  });
}
