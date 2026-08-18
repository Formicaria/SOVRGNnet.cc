import { APP_VERSION, COOKIE_NAME } from "@shared/const";
import { inviteDeepLink, inviteUrl } from "@shared/invite";
import { TRPCError } from "@trpc/server";
import {
  checkLoginRateLimit,
  createSessionToken,
  hashPassword,
  resetLoginRateLimit,
  setSessionCookie,
  verifyPassword,
} from "./_core/auth";
import { getSessionCookieOptions } from "./_core/cookies";
import { ENV } from "./_core/env";
import { systemRouter } from "./_core/systemRouter";
import {
  adminProcedure,
  publicProcedure,
  protectedProcedure,
  router,
} from "./_core/trpc";
import {
  canRegister,
  e2eeAvailable,
  instanceId,
  instanceInfo,
  normalizeJoinPolicy,
} from "./instance";
import {
  JwksCache,
  decideSsoLink,
  ssoConfigFromEnv,
  verifySsoToken,
} from "./sso";
import { nanoid } from "nanoid";
import { z } from "zod";
import { IDENTITY_ORIGIN } from "@shared/identity";
import { parsePublicMatrixUrl } from "@shared/matrixDelegation";
import { checkUsername, foldUsername, renameConsequences } from "@shared/username";
import { appserviceConfigured } from "./appservice";
import * as db from "./db";
import { isIpfsReachable } from "./ipfsService";
import { shareableHost } from "./lanHost";
import { directSync } from "./matrixPublic";
import * as matrix from "./matrixService";
import {
  createChannelRoom,
  ensureMatrixCredentials,
  joinServerRooms,
  removeFromServerRooms,
  requireServerMembership,
  syncPowerLevels,
} from "./matrixBridge";
import {
  atLeast,
  getServerRole,
  requireAuthorityOver,
  requireServerRole,
  type ServerRole,
} from "./permissions";
import * as presence from "./presence";
import type { User } from "../drizzle/schema";

/**
 * Registration: a username is required, an email address is not.
 *
 * The username bound here is only a length guard so an oversized string is
 * rejected before it reaches anything else — the real rules live in
 * `checkUsername`, which the sign-up form also calls, and which produces the
 * message shown to the person. Duplicating those rules in a zod schema is how
 * the form and the server start disagreeing.
 */
const registerCredentials = z.object({
  username: z.string().min(1).max(64),
  email: z.string().email().max(320).optional(),
  password: z.string().min(8).max(256),
});

/**
 * Signing in: whichever of the two the person remembers.
 *
 * Email stays accepted because accounts that predate usernames have one and
 * existing clients send it. Username is the new identity, and for an account
 * registered without an email it is the only way in — which is why this had to
 * change in the same step that made email optional, rather than waiting for
 * the sign-in form work. Requiring an email to log in, on an instance that no
 * longer requires one to register, is an account you can create and never use.
 */
const loginInput = z
  .object({
    username: z.string().min(1).max(64).optional(),
    email: z.string().email().max(320).optional(),
    password: z.string().min(8).max(256),
  })
  .refine(value => Boolean(value.username || value.email), {
    message: "Sign in with a username or an email address.",
  });

/**
 * Signing keys from the identity provider, cached for the process lifetime.
 *
 * One instance, so every request shares the cache — and so an outage at the
 * provider is survived by the whole server rather than per-request.
 */
const jwksCache = new JwksCache(
  process.env.IDENTITY_ISSUER?.trim() || IDENTITY_ORIGIN
);
const ssoConfig = () => ssoConfigFromEnv(instanceId());

/** Public shape of a user — never expose passwordHash. */
function toPublicUser(user: User) {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

/**
 * Credentials for inviting someone into a community's Space.
 *
 * Community Spaces are invite-only, so joining takes an invite from somebody
 * holding the invite power level — which the person joining does not have, on
 * purpose. SOVRGN decides who may join, using its own join policy, invite
 * codes and bans; this carries that decision into Matrix rather than leaving
 * the Space open to anyone who can reach the homeserver.
 *
 * Null when the owner has no Matrix session yet. joinServerRooms then falls
 * back to a plain join, which still works for communities created before the
 * rooms became invite-only.
 */
async function inviterFor(
  ownerId: number,
  joiningMatrixUserId: string
): Promise<{ ownerAccessToken: string; joiningMatrixUserId: string } | null> {
  const owner = await db.getMatrixCredentials(ownerId).catch(() => null);
  if (!owner) return null;
  return { ownerAccessToken: owner.accessToken, joiningMatrixUserId };
}

/**
 * Bridge the pure policy verdict to what the locked insert needs.
 *
 * `canRegister` answers "may they?"; the insert also needs "as what?". Keeping
 * them separate is what lets the policy stay a pure function with no database
 * and no environment, tested on its own.
 */
function toDecision(
  verdict: ReturnType<typeof canRegister>,
  isFirstAccount: boolean
):
  | { allowed: true; role: "user" | "admin" }
  | { allowed: false; message: string } {
  if (!verdict.allowed) return { allowed: false, message: verdict.message };
  return { allowed: true, role: isFirstAccount ? "admin" : "user" };
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(({ ctx }) =>
      ctx.user ? toPublicUser(ctx.user) : null
    ),

    register: publicProcedure
      .input(
        registerCredentials.extend({
          name: z.string().min(1).max(100).optional(),
          /** Carried from an invite link, for invite-only instances. */
          inviteCode: z.string().min(1).max(32).optional(),
          /**
           * Required for the very first account only — the one that becomes
           * the administrator. Ignored afterwards.
           */
          setupToken: z.string().min(1).max(128).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // Validated with the same function the sign-up form uses, so the two
        // can't disagree about what's allowed. The message comes from there
        // too rather than being reworded here.
        const checked = checkUsername(input.username);
        if (!checked.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: checked.message });
        }
        const username = checked.username;

        // Checked against the fold, so `alice.hart` is refused when
        // `alice_hart` exists. The unique index is still the real guard —
        // this is only here to answer with something better than a constraint
        // violation when two people aren't racing.
        if (await db.getUserByUsername(username)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That username is taken.",
          });
        }

        if (input.email && (await db.getUserByEmail(input.email))) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "An account with this email already exists.",
          });
        }

        // The instance's join policy was advertised by /api/instance but never
        // actually enforced, so a server marked "closed" still accepted
        // anyone. It does now.
        const settings = await db.getInstanceSettings().catch(() => null);
        const policy = instanceInfo(APP_VERSION, settings).joinPolicy;
        const hasValidInvite = input.inviteCode
          ? (await db.getServerByInviteCode(input.inviteCode)) != null
          : false;

        const passwordHash = await hashPassword(input.password);

        // Whoever registers first is the person who set this instance up, so
        // they get the keys to it — which is exactly why the decision and the
        // insert happen under one lock, and why the bootstrap needs a token.
        // Counting first and inserting afterwards let two requests both be
        // "first", and let a stranger race the operator for a server that had
        // just been given a public address.
        const outcome = await db.createUserUnderBootstrapLock(
          { username, passwordHash, email: input.email, name: input.name },
          isFirstAccount =>
            toDecision(
              canRegister({
                policy,
                isFirstAccount,
                hasValidInvite,
                setupToken: ENV.setupToken,
                presentedSetupToken: input.setupToken,
              }),
              isFirstAccount
            )
        );

        if (!outcome.ok) {
          throw new TRPCError({ code: "FORBIDDEN", message: outcome.message });
        }
        const user = outcome.user;

        const token = await createSessionToken(user.id);
        setSessionCookie(ctx.req, ctx.res, token);
        return toPublicUser(user);
      }),

    login: publicProcedure
      .input(loginInput)
      .mutation(async ({ ctx, input }) => {
        // Username lookups fold, so the rate-limit key has to fold too:
        // keying on the raw string would let one attacker get a fresh bucket
        // per spelling of the same account — `alice.hart`, `alice_hart`,
        // `a1ice-hart` — and the limit would never bite.
        const identifier = input.username
          ? foldUsername(input.username)
          : (input.email ?? "").toLowerCase();
        const rateKey = `${ctx.req.ip ?? "unknown"}:${identifier}`;
        if (!checkLoginRateLimit(rateKey)) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many login attempts. Try again in 15 minutes.",
          });
        }

        const user = input.username
          ? await db.getUserByUsername(input.username)
          : await db.getUserByEmail(input.email ?? "");
        const valid =
          user?.passwordHash != null &&
          (await verifyPassword(input.password, user.passwordHash));

        if (!user || !valid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            // Deliberately does not say which of the two was wrong, and
            // deliberately the same text whichever field was used: a message
            // that distinguishes "no such account" from "wrong password" is a
            // way to enumerate who has an account here.
            message: "Invalid credentials.",
          });
        }

        resetLoginRateLimit(rateKey);
        await db.touchLastSignedIn(user.id);

        const token = await createSessionToken(user.id);
        setSessionCookie(ctx.req, ctx.res, token);
        return toPublicUser(user);
      }),

    /**
     * Sign in with a sovrgnnet.cc account.
     *
     * The token was minted for this server specifically and is verified
     * against a cached public key, so this works even when the identity
     * provider is unreachable. Servers that want nothing to do with central
     * identity leave INSTANCE_ALLOW_SSO unset and this always refuses.
     */
    ssoLogin: publicProcedure
      .input(z.object({ token: z.string().min(1).max(4096) }))
      .mutation(async ({ ctx, input }) => {
        let claims;
        try {
          claims = await verifySsoToken(input.token, jwksCache, ssoConfig());
        } catch (err) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message:
              err instanceof Error
                ? err.message
                : "That sign-in couldn't be verified.",
          });
        }

        // Both are looked up, but only the first can produce a sign-in. The
        // email is consulted to *refuse*; see decideSsoLink for why matching on
        // it would be a takeover path rather than a convenience.
        const [existingBySubject, existingByEmail] = await Promise.all([
          db.getUserBySsoSubject(claims.sub),
          claims.email
            ? db.getUserByEmail(claims.email)
            : Promise.resolve(null),
        ]);

        const decision = decideSsoLink({
          claims,
          existingBySubject: existingBySubject
            ? { id: existingBySubject.id }
            : null,
          existingByEmail: existingByEmail
            ? { id: existingByEmail.id, ssoSubject: existingByEmail.ssoSubject }
            : null,
        });

        if (decision.action === "refuse") {
          throw new TRPCError({ code: "CONFLICT", message: decision.message });
        }

        let user;
        if (decision.action === "create") {
          // The same join policy applies to SSO as to local sign-up — a
          // closed server stays closed no matter where the identity is from.
          const isFirstAccount = (await db.countUsers()) === 0;

          // Bootstrapping an instance through SSO is refused outright.
          //
          // The bootstrap grants administrator, and the setup token is what
          // stops a stranger claiming it — but a token can't travel through an
          // identity-provider redirect without being pasted somewhere it would
          // leak. Rather than invent a weaker gate for this path, it's closed:
          // create the first account locally with the token, then link the
          // provider to it.
          //
          // This also removes the race on this path entirely. With no
          // privilege to win, two concurrent SSO sign-ups both become ordinary
          // users and the count no longer needs a lock.
          if (isFirstAccount) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "This instance has no accounts yet. Create the first one directly " +
                "with the setup code, then link your account — the first account " +
                "becomes the administrator and can't be claimed through a provider.",
            });
          }

          const settings = await db.getInstanceSettings().catch(() => null);
          const verdict = canRegister({
            policy: instanceInfo(APP_VERSION, settings).joinPolicy,
            isFirstAccount,
            hasValidInvite: false,
          });
          if (!verdict.allowed) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: verdict.message,
            });
          }

          // Stop here rather than create. A username becomes a permanent
          // Matrix ID, so this path asks instead of guessing — the caller
          // presents the same token back to `ssoRegister` with a chosen name.
          //
          // Nothing is written yet, so abandoning here leaves no trace, and the
          // token stays the only proof of identity: the second call re-verifies
          // it rather than trusting a subject sent by the client.
          return {
            status: "choose-username" as const,
            suggestion: await db.suggestUsername(
              claims.name ?? claims.email?.split("@")[0] ?? null
            ),
          };
        }

        const found = await db.getUserById(decision.userId);
        if (!found) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Account not found.",
          });
        }
        user = found;

        await db.touchLastSignedIn(user.id);
        const token = await createSessionToken(user.id);
        setSessionCookie(ctx.req, ctx.res, token);
        return { status: "signed-in" as const, user: toPublicUser(user) };
      }),

    /**
     * Finish an SSO sign-up with a username the person actually chose.
     *
     * The token is verified again here. It is the only thing establishing who
     * this is — the client is told the subject in no form it could echo back,
     * because a subject accepted from a request body would let anyone claim any
     * identity by typing it.
     */
    ssoRegister: publicProcedure
      .input(
        z.object({
          token: z.string().min(1).max(4096),
          username: z.string().min(1).max(64),
        })
      )
      .mutation(async ({ ctx, input }) => {
        let claims;
        try {
          claims = await verifySsoToken(input.token, jwksCache, ssoConfig());
        } catch (err) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message:
              err instanceof Error
                ? err.message
                : "That sign-in couldn't be verified.",
          });
        }

        const checked = checkUsername(input.username);
        if (!checked.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: checked.message });
        }

        // Re-run the whole decision rather than trusting that the first call
        // said "create". Between the two requests someone may have registered
        // this subject, or an account with this email may have appeared.
        const [existingBySubject, existingByEmail] = await Promise.all([
          db.getUserBySsoSubject(claims.sub),
          claims.email
            ? db.getUserByEmail(claims.email)
            : Promise.resolve(null),
        ]);
        const decision = decideSsoLink({
          claims,
          existingBySubject: existingBySubject
            ? { id: existingBySubject.id }
            : null,
          existingByEmail: existingByEmail
            ? { id: existingByEmail.id, ssoSubject: existingByEmail.ssoSubject }
            : null,
        });
        if (decision.action === "refuse") {
          throw new TRPCError({ code: "CONFLICT", message: decision.message });
        }
        if (decision.action === "sign-in") {
          // Already created — a double submit, or two tabs. Sign them in
          // instead of failing on the unique constraint.
          const found = await db.getUserById(decision.userId);
          if (found) {
            await db.touchLastSignedIn(found.id);
            const session = await createSessionToken(found.id);
            setSessionCookie(ctx.req, ctx.res, session);
            return toPublicUser(found);
          }
        }

        if (await db.getUserByUsername(checked.username)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That username is taken.",
          });
        }

        // The same refusal as `ssoLogin`: the first account is the
        // administrator and cannot be claimed through a provider.
        const isFirstAccount = (await db.countUsers()) === 0;
        if (isFirstAccount) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "This instance has no accounts yet. Create the first one directly " +
              "with the setup code, then link your account — the first account " +
              "becomes the administrator and can't be claimed through a provider.",
          });
        }

        const settings = await db.getInstanceSettings().catch(() => null);
        const verdict = canRegister({
          policy: instanceInfo(APP_VERSION, settings).joinPolicy,
          isFirstAccount,
          hasValidInvite: false,
        });
        if (!verdict.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: verdict.message });
        }

        const user = await db.createSsoUser(
          claims.sub,
          checked.username,
          claims.email ?? null,
          claims.name ?? null,
          "user"
        );

        await db.touchLastSignedIn(user.id);
        const session = await createSessionToken(user.id);
        setSessionCookie(ctx.req, ctx.res, session);
        return toPublicUser(user);
      }),

    /**
     * What changing your username would do, before doing it.
     *
     * Split from the mutation so the confirmation can be rendered from the
     * server's own account of the consequences rather than from a copy of it
     * in the client. The two drifting apart is exactly how a warning ends up
     * describing behaviour the code no longer has.
     */
    renamePreview: protectedProcedure
      .input(z.object({ username: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        const checked = checkUsername(input.username);
        if (!checked.ok) {
          return { ok: false as const, message: checked.message };
        }

        const credentials = await db.getMatrixCredentials(ctx.user.id);
        const taken = await db.getUserByUsername(checked.username);

        return {
          ok: true as const,
          username: checked.username,
          // A name you already hold is not "taken" — see db.renameUser.
          available: !taken || taken.id === ctx.user.id,
          consequences: renameConsequences({
            currentMatrixId: credentials?.userId ?? null,
            newUsername: checked.username,
          }),
        };
      }),

    /**
     * Change your username.
     *
     * Renaming is allowed, and the Matrix ID does not move — ADR 0012 has the
     * reasoning. The interesting part of this handler is what it deliberately
     * does *not* do: it never touches `userProfiles.matrixUserId`, never
     * re-provisions a Matrix account, and never tries to migrate rooms.
     *
     * `acknowledgedMatrixId` is a design constraint on our own client, not a
     * security control — anything calling this API can pass `true`. What it
     * buys is that a rename form cannot be wired up in this codebase without
     * the author noticing there is something to disclose. That is worth a
     * required field; pretending it is a protection would not be.
     */
    changeUsername: protectedProcedure
      .input(
        z.object({
          username: z.string().min(1).max(64),
          acknowledgedMatrixId: z.literal(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const checked = checkUsername(input.username);
        if (!checked.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: checked.message });
        }

        // Unchanged apart from case or separators. Reported rather than
        // written, so the answer doesn't imply something happened.
        if (foldUsername(checked.username) === foldUsername(ctx.user.username)) {
          if (checked.username === ctx.user.username) {
            return { username: ctx.user.username, changed: false as const };
          }
          // A pure case change still folds the same, and is worth allowing.
        }

        const renamed = await db.renameUser(ctx.user.id, checked.username);
        if (!renamed) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Someone already has that username on this server.",
          });
        }

        return { username: renamed.username, changed: true as const };
      }),

    /**
     * Bind a provider identity to the account already signed in.
     *
     * This is the deliberate half of subject-only linking. `decideSsoLink`
     * refuses to infer a link from a matching email; this is how one is made
     * instead — by someone who has already proved they hold the local account,
     * and who is holding a valid token for the provider identity at the same
     * moment. Both halves are demonstrated rather than assumed.
     */
    linkSso: protectedProcedure
      .input(z.object({ token: z.string().min(1).max(4096) }))
      .mutation(async ({ ctx, input }) => {
        let claims;
        try {
          claims = await verifySsoToken(input.token, jwksCache, ssoConfig());
        } catch (err) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message:
              err instanceof Error
                ? err.message
                : "That sign-in couldn't be verified.",
          });
        }

        const alreadyBound = await db.getUserBySsoSubject(claims.sub);
        if (alreadyBound && alreadyBound.id !== ctx.user.id) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "That sovrgnnet.cc account is already linked to a different account here.",
          });
        }
        if (ctx.user.ssoSubject && ctx.user.ssoSubject !== claims.sub) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This account is already linked to a different sovrgnnet.cc account.",
          });
        }

        await db.linkSsoSubject(ctx.user.id, claims.sub);
        return { linked: true } as const;
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Server operations
  servers: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return await db.getServersByUser(ctx.user.id);
    }),

    listPublic: protectedProcedure.query(async () => {
      return await db.getPublicServers();
    }),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(100),
          description: z.string().max(500).optional(),
          icon: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const creds = await ensureMatrixCredentials(ctx.user);

        const spaceId = await matrix.createSpace(
          creds.accessToken,
          input.name,
          input.description
        );
        const server = await db.createServer(
          input.name,
          input.description,
          spaceId,
          ctx.user.id,
          input.icon
        );
        await db.addServerMember(server.id, ctx.user.id, "owner");

        // Every server starts with a #general channel, encrypted if this
        // instance can support it at all.
        const generalRoom = await createChannelRoom(
          creds.accessToken,
          spaceId,
          "general"
        );
        const general = await db.createChannel(
          server.id,
          "general",
          undefined,
          generalRoom.roomId,
          "text",
          generalRoom.encrypted
        );

        return { server, defaultChannel: general };
      }),

    join: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server || !server.isPublic) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Server not found.",
          });
        }
        if (await db.isServerMember(server.id, ctx.user.id)) {
          return { joined: true } as const;
        }
        if (await db.isServerBanned(server.id, ctx.user.id)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You've been banned from this server.",
          });
        }

        const creds = await ensureMatrixCredentials(ctx.user);
        const channels = await db.getChannelsByServer(server.id);
        await joinServerRooms(
          creds.accessToken,
          server.matrixRoomId,
          channels.map(c => c.matrixRoomId),
          await inviterFor(server.ownerId, creds.userId)
        );
        await db.addServerMember(server.id, ctx.user.id, "member");
        return { joined: true } as const;
      }),

    getById: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        return await db.getServerById(input.serverId);
      }),

    /** Admins and up create (or return the existing) shareable invite code. */
    createInvite: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Server not found.",
          });
        }
        await requireServerRole(input.serverId, ctx.user.id, "admin");

        let code = server.inviteCode;
        if (!code) {
          code = nanoid(10);
          await db.setServerInviteCode(server.id, code);
        }

        // The link has to name the server, not just the code — a client
        // connected to several servers can't resolve a bare code. Derived
        // from the Host header so it's correct behind a tunnel or proxy,
        // where the app has no reliable idea of its own public address.
        //
        // With one exception, found by walking the desktop path in code: a
        // hosted desktop server's owner browses it at 127.0.0.1, so the
        // header names the one host guaranteed wrong for everyone else —
        // every invite was a link to the recipient's own machine, and
        // "friends on your network can join with an invite link" had never
        // been true. shareableHost swaps a LAN address in for loopback and
        // touches nothing else; tunnel and LAN requests keep their header.
        const rawHost = String(
          ctx.req.headers["x-forwarded-host"] ?? ctx.req.headers.host ?? ""
        );
        const host = rawHost ? shareableHost(rawHost) : "";
        return {
          code,
          url: host ? inviteUrl(host, code) : null,
          deepLink: host ? inviteDeepLink(host, code) : null,
        };
      }),

    /** Join via invite code — works for private servers too. */
    joinByInvite: protectedProcedure
      .input(z.object({ code: z.string().min(1).max(32) }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerByInviteCode(input.code);
        if (!server) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Invalid invite.",
          });
        }
        if (await db.isServerBanned(server.id, ctx.user.id)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You've been banned from this server.",
          });
        }
        if (!(await db.isServerMember(server.id, ctx.user.id))) {
          const creds = await ensureMatrixCredentials(ctx.user);
          const channels = await db.getChannelsByServer(server.id);
          await joinServerRooms(
            creds.accessToken,
            server.matrixRoomId,
            channels.map(c => c.matrixRoomId),
            await inviterFor(server.ownerId, creds.userId)
          );
          await db.addServerMember(server.id, ctx.user.id, "member");
        }
        return { serverId: server.id, serverName: server.name };
      }),

    /** Leave a server (owners can't leave their own). */
    leave: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Server not found.",
          });
        }
        if (server.ownerId === ctx.user.id) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Owners cannot leave their own server.",
          });
        }

        const creds = await db.getMatrixCredentials(ctx.user.id);
        if (creds) {
          const channels = await db.getChannelsByServer(server.id);
          for (const roomId of [
            server.matrixRoomId,
            ...channels.map(c => c.matrixRoomId),
          ]) {
            try {
              await matrix.leaveRoom(creds.accessToken, roomId);
            } catch {
              // Best-effort; membership removal below is authoritative.
            }
          }
        }
        await db.removeServerMember(server.id, ctx.user.id);
        return { left: true } as const;
      }),
  }),

  // Channel operations
  channels: router({
    listByServer: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        return await db.getChannelsByServer(input.serverId);
      }),

    create: protectedProcedure
      .input(
        z.object({
          serverId: z.number(),
          name: z.string().min(1).max(100),
          description: z.string().max(500).optional(),
          type: z.enum(["text", "voice", "video"]).default("text"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Server not found.",
          });
        }
        await requireServerRole(input.serverId, ctx.user.id, "admin");

        const creds = await ensureMatrixCredentials(ctx.user);
        // Encrypted unless the deployment can't support it. No option, by
        // design — see `createChannelRoom`.
        const room = await createChannelRoom(
          creds.accessToken,
          server.matrixRoomId,
          input.name,
          input.description
        );
        return await db.createChannel(
          input.serverId,
          input.name,
          input.description,
          room.roomId,
          input.type,
          room.encrypted
        );
      }),

    getById: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) return undefined;
        await requireServerMembership(channel.serverId, ctx.user.id);
        return channel;
      }),

    /**
     * Turn on end-to-end encryption for a channel — ADR 0008 stage 4.
     *
     * Permanent, and gated three ways.
     *
     * *Admin only*, because it changes what every member of the channel can
     * read and cannot be undone by any of them.
     *
     * *Refused unless the instance advertises `e2ee`* — which means a
     * homeserver actually answered at the advertised address, and the instance
     * records what that homeserver pushes. Encrypting a room whose members
     * can't hold their own keys produces a channel nobody can read, the
     * instance least of all, since it deliberately stores ciphertext
     * content-blind.
     *
     * *Refused when already encrypted*, so a second call can't rotate the
     * algorithm out from under existing history.
     */
    enableEncryption: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        await requireServerRole(channel.serverId, ctx.user.id, "admin");

        if (channel.encrypted) {
          return { encrypted: true, alreadyEnabled: true } as const;
        }

        if (!e2eeAvailable()) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This instance can't offer encryption yet — its homeserver isn't " +
              "reachable by clients, or it isn't recording the events they send.",
          });
        }

        const creds = await ensureMatrixCredentials(ctx.user);
        await matrix.enableRoomEncryption(
          creds.accessToken,
          channel.matrixRoomId
        );

        // The appservice marks the channel encrypted when the homeserver
        // pushes the state event back. Doing it here too makes the change
        // visible immediately and is idempotent — `markChannelEncrypted` only
        // ever sets the flag true, and Matrix never downgrades the state.
        await db.markChannelEncrypted(channel.matrixRoomId);

        return { encrypted: true, alreadyEnabled: false } as const;
      }),

    /** "I'm typing" — call while someone is composing. */
    setTyping: protectedProcedure
      .input(
        z.object({ channelId: z.number(), typing: z.boolean().default(true) })
      )
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        if (input.typing) {
          presence.noteTyping(input.channelId, ctx.user.id);
        } else {
          presence.clearTyping(input.channelId, ctx.user.id);
        }

        // Also tell Matrix, so people watching from Element see it too.
        const [creds, matrixUserId] = await Promise.all([
          db.getMatrixCredentials(ctx.user.id),
          db.getMatrixUserId(ctx.user.id),
        ]);
        if (creds && matrixUserId) {
          matrix
            .setTyping(
              creds.accessToken,
              channel.matrixRoomId,
              matrixUserId,
              input.typing
            )
            .catch(() => {
              // A lost typing notification is not worth surfacing.
            });
        }

        return { ok: true } as const;
      }),

    /** Names of everyone currently typing here, excluding you. */
    whoIsTyping: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) return [];
        await requireServerMembership(channel.serverId, ctx.user.id);

        // Reading the channel is a sign of life, so it doubles as a heartbeat.
        presence.noteActivity(ctx.user.id);

        const userIds = presence.getTypingUserIds(input.channelId, ctx.user.id);
        if (userIds.length === 0) return [];

        const members = await db.getServerMembersDetailed(channel.serverId);
        const nameById = new Map(members.map(m => [m.userId, m.name]));
        return userIds.map(id => ({
          userId: id,
          name: nameById.get(id) ?? "Someone",
        }));
      }),
  }),

  // Message operations
  messages: router({
    listByChannel: protectedProcedure
      .input(
        z.object({
          channelId: z.number(),
          limit: z.number().min(1).max(200).default(50),
        })
      )
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);
        // The server id lets each sender be shown under their per-server
        // nickname rather than their account name.
        return await db.getMessagesByChannel(
          input.channelId,
          input.limit,
          channel.serverId
        );
      }),

    send: protectedProcedure
      .input(
        z.object({
          channelId: z.number(),
          content: z.string().min(1).max(4000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        // Membership first, and the order is load-bearing. A stranger who gets
        // "this channel is encrypted" has learned something about a channel
        // they have no business knowing exists — and any test asserting that
        // non-members are refused would pass on the encryption check without
        // ever reaching the membership one.
        await requireServerMembership(channel.serverId, ctx.user.id);

        if (channel.encrypted) {
          // The instance cannot compose Megolm — by construction, since it
          // holds no keys — so this path has nothing to offer an encrypted
          // channel but plaintext, which would quietly undermine the
          // encryption for everyone in it.
          //
          // Now that encryption is the default, this refuses *most* sends on a
          // capable instance, and that is the intended shape: composing
          // happens in a client holding its own keys, or it doesn't happen.
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This channel is end-to-end encrypted, so it can only be written to " +
              "by a client holding its own keys. This one isn't — reload, or use a " +
              "client that can.",
          });
        }

        const creds = await ensureMatrixCredentials(ctx.user);
        const eventId = await matrix.sendMessage(
          creds.accessToken,
          channel.matrixRoomId,
          input.content
        );

        presence.clearTyping(input.channelId, ctx.user.id);

        // E2EE lands in a later phase; until then messages are plaintext.
        return await db.createMessage(
          input.channelId,
          ctx.user.id,
          input.content,
          eventId,
          false,
          creds.userId
        );
      }),

    /** Edit your own message. Moderators can't rewrite what others said. */
    edit: protectedProcedure
      .input(
        z.object({
          messageId: z.number(),
          content: z.string().min(1).max(4000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const message = await db.getMessageById(input.messageId);
        if (!message) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Message not found.",
          });
        }
        if (message.userId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only edit your own messages.",
          });
        }

        const channel = await db.getChannelById(message.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        if (channel.encrypted) {
          // Worse than the send path, and easier to miss. Editing through here
          // would post a plaintext `m.new_content` into an encrypted room *and*
          // write the new text into the index — turning a content-blind row
          // into a readable one, for a message whose original the instance
          // never could read. An edit that leaks what the message never did.
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This channel is end-to-end encrypted, so edits have to come from a " +
              "client holding its own keys.",
          });
        }

        const creds = await db.getMatrixCredentials(ctx.user.id);
        if (creds) {
          try {
            await matrix.editMessage(
              creds.accessToken,
              channel.matrixRoomId,
              message.matrixEventId,
              input.content
            );
          } catch {
            // The homeserver keeps the original; our copy is what the app shows.
          }
        }

        return await db.updateMessageContent(message.id, input.content);
      }),

    /** Toggle one emoji reaction for the current user. */
    react: protectedProcedure
      .input(
        z.object({
          messageId: z.number(),
          // Emoji only — this is a reaction, not a second message body.
          emoji: z.string().min(1).max(16),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const message = await db.getMessageById(input.messageId);
        if (!message) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Message not found.",
          });
        }
        const channel = await db.getChannelById(message.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        const existing = (message.reactions as db.ReactionMap | null) ?? {};
        const wasReacted = (existing[input.emoji] ?? []).includes(ctx.user.id);

        const reactions = await db.toggleMessageReaction(
          message.id,
          ctx.user.id,
          input.emoji
        );

        // Matrix has no "unreact" beyond redacting the annotation event, and
        // we don't track annotation ids yet — so only additions propagate.
        //
        // Deliberately not gated on `channel.encrypted`, unlike send and edit.
        // `m.reaction` is an unencrypted relation even in an encrypted room —
        // that is what the spec says and what every Matrix client does, because
        // encrypting an annotation hides an emoji while leaving the fact of it,
        // its author and its target in the clear anyway. So an operator can see
        // who reacted to what with which emoji in an encrypted channel. That is
        // metadata, it is already conceded in the threat model, and pretending
        // otherwise by encrypting it would buy nothing.
        if (!wasReacted) {
          const creds = await db.getMatrixCredentials(ctx.user.id);
          if (creds) {
            try {
              await matrix.sendReaction(
                creds.accessToken,
                channel.matrixRoomId,
                message.matrixEventId,
                input.emoji
              );
            } catch {
              // Cosmetic on the Matrix side; the app's copy is authoritative.
            }
          }
        }

        return reactions;
      }),

    /** Delete a message — the author, or a moderator and above. */
    delete: protectedProcedure
      .input(z.object({ messageId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const message = await db.getMessageById(input.messageId);
        if (!message) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Message not found.",
          });
        }
        const channel = await db.getChannelById(message.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        const isAuthor = message.userId === ctx.user.id;
        const role = await getServerRole(channel.serverId, ctx.user.id);
        if (!role) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a member of this server.",
          });
        }
        if (!isAuthor && !atLeast(role, "moderator")) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only delete your own messages.",
          });
        }

        // Redact as the author when possible, else as the acting moderator.
        // A federated sender has no local credentials (ADR 0010): the
        // moderator's own session does the redacting, and Matrix power
        // levels — already bound at the room layer — decide whether it lands.
        const creds =
          (await db.getMatrixCredentials(
            isAuthor || message.userId == null ? ctx.user.id : message.userId
          )) ?? (await db.getMatrixCredentials(ctx.user.id));
        if (creds) {
          try {
            await matrix.redactEvent(
              creds.accessToken,
              channel.matrixRoomId,
              message.matrixEventId
            );
          } catch {
            // DB deletion below is authoritative for the app's view.
          }
        }
        await db.deleteMessage(message.id);
        return { deleted: true } as const;
      }),
  }),

  // File share metadata (uploads/downloads go through /api/upload and /api/files)
  fileShares: router({
    listByChannel: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Channel not found.",
          });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);
        return await db.getFileSharesByChannel(input.channelId);
      }),
  }),

  // Soundboard operations
  soundboard: router({
    listByServer: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ input }) => {
        return await db.getSoundboardClipsByServer(input.serverId);
      }),

    create: protectedProcedure
      .input(
        z.object({
          serverId: z.number(),
          name: z.string(),
          ipfsHash: z.string(),
          duration: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        return await db.createSoundboardClip(
          input.serverId,
          input.name,
          input.ipfsHash,
          input.duration,
          ctx.user.id
        );
      }),
  }),

  // User profile operations
  profile: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUserProfile(ctx.user.id);
    }),

    update: protectedProcedure
      .input(
        z.object({
          walletAddress: z.string().optional(),
          ensName: z.string().optional(),
          avatar: z.string().optional(),
          bio: z.string().optional(),
          matrixUserId: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        return await db.createOrUpdateUserProfile(
          ctx.user.id,
          input.walletAddress,
          input.ensName,
          input.avatar,
          input.bio,
          input.matrixUserId
        );
      }),

    /**
     * Every Matrix session on this account.
     *
     * Deliberately includes the instance's own, flagged as such. Someone
     * looking at their sessions should be able to see that the server holds
     * one — because it does, and omitting it would be the dishonest option.
     */
    devices: protectedProcedure.query(async ({ ctx }) => {
      const credentials = await db.getMatrixCredentials(ctx.user.id);
      if (!credentials) return [];

      try {
        return await matrix.listDevices(credentials.accessToken);
      } catch {
        // A homeserver that's down shouldn't make the settings page fail —
        // it should say it couldn't ask.
        return [];
      }
    }),

    /** Sign a session out. Refuses the server's own — see matrixService. */
    signOutDevice: protectedProcedure
      .input(z.object({ deviceId: z.string().min(1).max(255) }))
      .mutation(async ({ ctx, input }) => {
        const credentials = await db.getMatrixCredentials(ctx.user.id);
        if (!credentials) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You don't have a Matrix session yet.",
          });
        }

        try {
          await matrix.deleteDevice(credentials.accessToken, input.deviceId, {
            // From the stored MXID, not from the current username: after a
            // rename those differ, and this account is the one that exists.
            user: matrix.localpartOf(credentials.userId),
            password: matrix.deriveMatrixPassword(ctx.user.id),
          });
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              error instanceof Error
                ? error.message
                : "Couldn't sign that session out.",
          });
        }

        return { signedOut: input.deviceId } as const;
      }),
  }),

  // Server members (joining happens via servers.join / servers.joinByInvite)
  serverMembers: router({
    /** Everyone in the server, with role and whether they're around. */
    list: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        presence.noteActivity(ctx.user.id);

        const server = await db.getServerById(input.serverId);
        const members = await db.getServerMembersDetailed(input.serverId);

        // The owner may predate the membership table; make sure they appear.
        const rows = members.some(m => m.userId === server?.ownerId)
          ? members
          : server
            ? [
                {
                  userId: server.ownerId,
                  role: "owner" as const,
                  joinedAt: server.createdAt,
                  name: null as string | null,
                  email: null as string | null,
                  matrixUserId: null as string | null,
                },
                ...members,
              ]
            : members;

        const online = presence.onlineUserIds(rows.map(r => r.userId));
        const rank: Record<string, number> = {
          owner: 0,
          admin: 1,
          moderator: 2,
          member: 3,
        };

        return rows
          .map(r => ({
            userId: r.userId,
            name: r.name,
            role: r.userId === server?.ownerId ? ("owner" as const) : r.role,
            joinedAt: r.joinedAt,
            online: online.has(r.userId),
          }))
          .sort(
            (a, b) =>
              rank[a.role] - rank[b.role] ||
              (a.name ?? "").localeCompare(b.name ?? "")
          );
      }),

    /** Promote or demote. Only the owner hands out admin. */
    setRole: protectedProcedure
      .input(
        z.object({
          serverId: z.number(),
          userId: z.number(),
          role: z.enum(["admin", "moderator", "member"]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { actorRole } = await requireAuthorityOver(
          input.serverId,
          ctx.user.id,
          input.userId
        );

        // You can't hand out authority at or above your own.
        const granting: ServerRole = input.role;
        const rankOf: Record<ServerRole, number> = {
          owner: 4,
          admin: 3,
          moderator: 2,
          member: 1,
        };
        if (rankOf[granting] >= rankOf[actorRole]) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can't grant a role equal to or above your own.",
          });
        }

        await db.setServerMemberRole(input.serverId, input.userId, input.role);
        await syncPowerLevels(
          input.serverId,
          ctx.user.id,
          input.userId,
          matrix.POWER_LEVELS[input.role]
        );

        return { role: input.role } as const;
      }),

    /** Remove someone. They can come back through discovery or an invite. */
    kick: protectedProcedure
      .input(
        z.object({
          serverId: z.number(),
          userId: z.number(),
          reason: z.string().max(500).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireAuthorityOver(input.serverId, ctx.user.id, input.userId);
        await removeFromServerRooms(
          input.serverId,
          ctx.user.id,
          input.userId,
          "kick",
          input.reason
        );
        await db.removeServerMember(input.serverId, input.userId);
        return { kicked: true } as const;
      }),

    /** Remove someone and keep them out. */
    ban: protectedProcedure
      .input(
        z.object({
          serverId: z.number(),
          userId: z.number(),
          reason: z.string().max(500).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireAuthorityOver(input.serverId, ctx.user.id, input.userId);
        await removeFromServerRooms(
          input.serverId,
          ctx.user.id,
          input.userId,
          "ban",
          input.reason
        );
        await db.removeServerMember(input.serverId, input.userId);
        await db.banServerMember(
          input.serverId,
          input.userId,
          ctx.user.id,
          input.reason
        );
        return { banned: true } as const;
      }),

    unban: protectedProcedure
      .input(z.object({ serverId: z.number(), userId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireServerRole(input.serverId, ctx.user.id, "moderator");
        await db.unbanServerMember(input.serverId, input.userId);
        return { unbanned: true } as const;
      }),

    listBans: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerRole(input.serverId, ctx.user.id, "moderator");
        return await db.getServerBans(input.serverId);
      }),

    /**
     * Your profile within one server.
     *
     * One identity, many faces: the same account can be "Zach" in one
     * community and "chronus" in another, the way Discord handles it.
     */
    myProfile: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        const profile = await db.getServerProfile(input.serverId, ctx.user.id);
        return {
          nickname: profile?.nickname ?? null,
          avatar: profile?.avatar ?? null,
          /** What's shown if the nickname is cleared. */
          accountName: ctx.user.name,
        };
      }),

    updateMyProfile: protectedProcedure
      .input(
        z.object({
          serverId: z.number(),
          // Empty string clears it, falling back to the account name.
          nickname: z.string().max(80).nullable(),
          avatar: z.string().max(500).nullable().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);

        const nickname = input.nickname?.trim() ? input.nickname.trim() : null;
        await db.setServerProfile(input.serverId, ctx.user.id, {
          nickname,
          ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
        });

        return { nickname, name: db.displayName(nickname, ctx.user.name) };
      }),

    /** Your own role here — the client uses this to decide what to show. */
    myRole: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        return await getServerRole(input.serverId, ctx.user.id);
      }),
  }),

  /**
   * Instance administration.
   *
   * Everything a server owner would otherwise SSH in to change. Restricted to
   * accounts with the instance-level admin role — which is the first account
   * registered, and anyone they promote.
   *
   * Works the same whether the client is on the same machine as the server or
   * across the internet: administering a box in your closet from the laptop
   * in your hand is the point, not a special case.
   */
  admin: router({
    getSettings: adminProcedure.query(async () => {
      const stored = await db.getInstanceSettings();
      const info = instanceInfo(APP_VERSION, stored);
      return {
        name: info.name,
        description: info.description,
        joinPolicy: info.joinPolicy,
        listed: info.listed,
        // Read-only facts an admin needs to see but cannot change here:
        // the Matrix name is permanent, and encryption depends on deployment.
        matrixServerName: info.matrixServerName,
        encryption: info.encryption,
        instanceId: info.id,
        version: info.software.version,
        /** True once an admin has saved anything; false means env defaults. */
        configured: stored != null,
      };
    }),

    updateSettings: adminProcedure
      .input(
        z.object({
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(500).nullable().optional(),
          joinPolicy: z.enum(["open", "invite", "closed"]).optional(),
          listed: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const saved = await db.saveInstanceSettings(input);
        return {
          name: saved.name,
          description: saved.description,
          joinPolicy: normalizeJoinPolicy(saved.joinPolicy),
          listed: saved.listed,
        };
      }),

    /**
     * The instance's vital signs, for the settings panel — 0.6's "no SSH for
     * routine operations". The same facts /ready and /metrics export, shaped
     * for a person: every probe bounded at 2s so a hung dependency shows as
     * down instead of hanging the panel with it.
     */
    overview: adminProcedure.query(async () => {
      const bounded = <T>(work: Promise<T>, fallback: T): Promise<T> =>
        Promise.race([
          work.catch(() => fallback),
          new Promise<T>(resolve => setTimeout(() => resolve(fallback), 2000)),
        ]);

      const [database, homeserver, ipfs, totals] = await Promise.all([
        bounded(
          db.pingDatabase().then(r => r.ok),
          false
        ),
        bounded(matrix.isHomeserverReachable(), false),
        bounded(isIpfsReachable(), false),
        bounded(
          db.countTotals(),
          null as { users: number; servers: number; messages: number } | null
        ),
      ]);

      const sync = directSync();

      return {
        version: APP_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        checks: { database, homeserver, ipfs },
        directSync: {
          available: sync.available,
          detail: sync.detail ?? null,
        },
        eventIngest: appserviceConfigured(),
        totals,
      };
    }),

    /** Everyone with an account on this instance. */
    listUsers: adminProcedure.query(async () => {
      return await db.listUsers();
    }),

    /** Grant or revoke instance administration. */
    setUserRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ ctx, input }) => {
        if (input.userId === ctx.user.id && input.role === "user") {
          // An instance with no administrator can only be repaired from a
          // database console, which is exactly what this surface exists to
          // avoid needing.
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You can't remove your own admin access.",
          });
        }
        await db.setUserRole(input.userId, input.role);
        return { role: input.role } as const;
      }),
  }),

  // Matrix status (everything else goes through servers/channels/messages)
  matrix: router({
    status: publicProcedure.query(async () => ({
      reachable: await matrix.isHomeserverReachable(),
    })),

    /**
     * A device-scoped Matrix session for this client — ADR 0008 stage 3.
     *
     * Gated on the same probe that decides the `clientMatrix` capability, so
     * a token is only ever minted for a homeserver the client can actually
     * reach. Handing it out when the homeserver is loopback-only would give
     * the client a credential for an address that refuses it.
     *
     * The client may pass back the deviceId it was given before; reusing it
     * replaces that session on the homeserver instead of piling up a new
     * anonymous device per page load. The id must be client-shaped — the
     * server's own session and other users' devices are not claimable,
     * because login only ever touches devices under this user's account and
     * the prefix check keeps the server's recognisable id out of reach.
     */
    clientSession: protectedProcedure
      .input(
        z.object({
          deviceId: z
            .string()
            .regex(/^SOVRGN_[A-Z0-9]{16}$/)
            .optional(),
          displayName: z.string().min(1).max(100),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const status = directSync();
        if (!status.available) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              status.detail ??
              "This instance does not offer direct Matrix sync.",
          });
        }

        // The account must exist before a device can log into it. Its MXID is
        // also the only reliable source for the localpart to log in *as* — see
        // matrix.localpartOf.
        const account = await ensureMatrixCredentials(ctx.user);

        const deviceId = input.deviceId ?? matrix.clientDeviceId();
        const session = await matrix.login(
          matrix.localpartOf(account.userId),
          matrix.deriveMatrixPassword(ctx.user.id),
          { deviceId, displayName: input.displayName }
        );

        const base = parsePublicMatrixUrl(process.env.MATRIX_PUBLIC_URL);
        if (!base) {
          // directSync().available implies a parseable URL; if it vanished
          // between the check and here, refuse rather than hand out a token
          // with nowhere to use it.
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "The homeserver address is no longer configured.",
          });
        }

        return {
          homeserverUrl: base,
          matrixUserId: session.userId,
          accessToken: session.accessToken,
          deviceId: session.deviceId ?? deviceId,
        };
      }),

    /**
     * Satisfy the password stage of one user-interactive-auth session, so a
     * client can upload cross-signing keys it generated itself — ADR 0011.
     *
     * The narrowest thing that makes stage 4 possible on this architecture.
     * Uploading cross-signing keys is UIA-gated; this instance's Matrix
     * passwords are derived from the app secret, so the instance knows them
     * and the browser doesn't. Handing one over for the duration of the flow
     * would put a permanent, unrotatable, fully-authorising credential inside
     * a web page. This does the opposite: the client keeps its private keys,
     * the instance keeps the password, and the only thing that crosses is a
     * session id the homeserver issued a moment ago.
     *
     * The session id is not a capability by itself. It is meaningless without
     * the request the client is already making, it belongs to the caller's own
     * account because the password used is derived from `ctx.user.id`, and it
     * expires with the UIA session. Passing somebody else's session id here
     * completes a stage on a flow this instance would then satisfy with the
     * *caller's* password, which the homeserver rejects.
     */
    completeCrossSigningAuth: protectedProcedure
      .input(z.object({ session: z.string().min(1).max(255) }))
      .mutation(async ({ ctx, input }) => {
        if (!directSync().available) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This instance does not offer direct Matrix sync.",
          });
        }

        const account = await ensureMatrixCredentials(ctx.user);

        await matrix.completeUiaPasswordStage(
          matrix.localpartOf(account.userId),
          matrix.deriveMatrixPassword(ctx.user.id),
          input.session
        );

        return { completed: true } as const;
      }),
  }),
});

export type AppRouter = typeof appRouter;
