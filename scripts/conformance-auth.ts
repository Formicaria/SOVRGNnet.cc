/**
 * Authenticated conformance runner.
 *
 *   pnpm conformance:auth http://localhost:3000 --i-operate-this-instance
 *   pnpm conformance:auth https://staging.example --i-operate-this-instance --invite-code=abc123
 *   pnpm conformance:auth https://staging.example --i-operate-this-instance \
 *       --user-a=name:password --user-b=name:password
 *
 * Exits 0 if the instance conforms, 1 if it doesn't, 2 if it couldn't run.
 *
 * THIS SUITE WRITES. A full run creates two accounts, one server (with its
 * #general), an invite code, and a few messages — all named conformance-*,
 * none deletable afterwards, because the protocol has no account or server
 * deletion. That is why the flag is spelled --i-operate-this-instance and why
 * the suite refuses to start without it: its sibling is safe to point at a
 * stranger's instance, and this one is not. Run it against staging, a fresh
 * container, or an instance whose row count you are personally at peace with.
 *
 * The checks live in shared/conformanceAuth.ts and are pure; this file does
 * the I/O and the sequencing. The sequencing is the journey a hostile-ish
 * client would take: probe, register, poke every wall from the outside, walk
 * through the door, poke the walls reachable from inside.
 *
 * What the operator supplies steers what can run:
 *
 *   open instances     nothing to supply; both accounts self-register
 *   invite instances   --invite-code=<code> lets registration proceed
 *                      (the code only gates registration; nothing joins the
 *                      server it belongs to)
 *   closed instances   --user-a / --user-b with pre-made throwaway accounts,
 *                      or the suite proves closedness and skips the rest —
 *                      each skip saying exactly why
 */

import {
  checkAnonMe,
  checkBadPassword,
  checkDuplicateUsername,
  checkInviteMalformed,
  checkInvitePreview,
  checkInviteUniformUnknown,
  checkLogin,
  checkLogout,
  checkMemberRead,
  checkMemberSend,
  checkModerationBoundary,
  checkNoSelfElevation,
  checkReadWall,
  checkRegisterRefused,
  checkRegisterSucceeded,
  checkRoleFloor,
  checkWriteWall,
  skip,
  summarize,
  trpcErrorCode,
  trpcResult,
  type CheckResult,
  type Exchange,
} from "../shared/conformanceAuth";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

const TIMEOUT_MS = 15_000;

// ------------------------------------------------------------------ transport

/**
 * One user's cookie jar. Sessions are httpOnly cookies, so the runner has to
 * do what a browser does: absorb Set-Cookie and send it back. The pattern is
 * e2e-journey.ts's Session, trimmed to what conformance needs; the wire quirks
 * it learned the hard way (superjson's { json } envelope, getSetCookie) are
 * kept, with the reasoning, because they will bite any second implementation
 * of this runner exactly the same way.
 */
class Session {
  private cookies = new Map<string, string>();

  constructor(readonly base: string) {}

  private cookieHeader(): string {
    return Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; ");
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

  private async exchange(url: URL, init: RequestInit): Promise<Exchange> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...init.headers, cookie: this.cookieHeader() },
      });
      this.absorb(response);
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 0,
        body: null,
        error: message.includes("abort") ? `timed out after ${TIMEOUT_MS / 1000}s` : message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  query(path: string, input?: unknown): Promise<Exchange> {
    const url = new URL(`/api/trpc/${path}`, this.base);
    // Superjson wraps everything on the wire in { json: ... }. Raw input
    // reaches the procedure as undefined and fails validation with an error
    // that says nothing about why.
    if (input !== undefined) url.searchParams.set("input", JSON.stringify({ json: input }));
    return this.exchange(url, { headers: { accept: "application/json" } });
  }

  mutate(path: string, input?: unknown): Promise<Exchange> {
    return this.exchange(new URL(`/api/trpc/${path}`, this.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input ?? {} }),
    });
  }

  rest(path: string): Promise<Exchange> {
    return this.exchange(new URL(path, this.base), { headers: { accept: "application/json" } });
  }
}

// ------------------------------------------------------------------- the run

interface Args {
  base: string;
  json: boolean;
  acknowledged: boolean;
  inviteCode?: string;
  userA?: { username: string; password: string };
  userB?: { username: string; password: string };
}

function parseArgs(argv: string[]): Args | null {
  const target = argv.find(a => !a.startsWith("--"));
  if (!target) return null;

  let base: string;
  try {
    base = new URL(target.includes("://") ? target : `https://${target}`).toString();
  } catch {
    return null;
  }

  const value = (flag: string): string | undefined => {
    const match = argv.find(a => a.startsWith(`--${flag}=`));
    return match?.slice(flag.length + 3);
  };

  const creds = (flag: string) => {
    const raw = value(flag);
    if (!raw) return undefined;
    const index = raw.indexOf(":");
    if (index <= 0) return undefined;
    return { username: raw.slice(0, index), password: raw.slice(index + 1) };
  };

  return {
    base,
    json: argv.includes("--json"),
    acknowledged: argv.includes("--i-operate-this-instance"),
    inviteCode: value("invite-code"),
    userA: creds("user-a"),
    userB: creds("user-b"),
  };
}

/**
 * Throwaway names: conformance-<stamp>-a / -b, the stamp base36 so two runs
 * never collide and every row this suite leaves behind is greppable by
 * prefix. Lowercase throughout — usernames normalise to lowercase and the
 * suite shouldn't depend on that courtesy.
 */
const stamp = Date.now().toString(36);
const NAME_A = `conformance-${stamp}-a`;
const NAME_B = `conformance-${stamp}-b`;
// Random enough for a throwaway that outlives the run; printed at the end so
// the operator can sign in and inspect what the suite did.
const PASSWORD = `conf-${stamp}-${Math.random().toString(36).slice(2, 10)}`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: pnpm conformance:auth <url> --i-operate-this-instance");
    console.error("       [--invite-code=<code>] [--user-a=name:pass --user-b=name:pass] [--json]");
    process.exit(2);
  }

  if (!args.acknowledged) {
    console.error("This suite WRITES to the instance: two accounts, a server, messages —");
    console.error("named conformance-*, and not deletable afterwards (the protocol has no");
    console.error("account or server deletion). Point it at staging or a fresh container.");
    console.error("");
    console.error("If that is what you intend, add:  --i-operate-this-instance");
    process.exit(2);
  }

  const results: CheckResult[] = [];
  const created: string[] = [];

  // -- Discovery first. Refuse to write anything at an address that doesn't
  //    identify as a SOVRGNnet instance — the flag says "I operate this
  //    instance", and this is the runner checking that there is one.
  const anon = new Session(args.base);
  const instance = await anon.rest("/api/instance");
  const descriptor = (instance.body ?? {}) as {
    product?: string;
    joinPolicy?: string;
    capabilities?: { e2ee?: boolean };
  };

  if (instance.error || instance.status !== 200 || descriptor.product !== "sovrgnnet") {
    console.error(
      `Not a reachable SOVRGNnet instance: ${
        instance.error ?? `GET /api/instance returned ${instance.status}`
      }`
    );
    process.exit(2);
  }
  const policy = descriptor.joinPolicy ?? "invite";
  const e2ee = descriptor.capabilities?.e2ee === true;

  // -- The stranger's view.
  results.push(checkAnonMe(await anon.query("auth.me")));

  // -- Accounts. Two of them, because membership and roles are relations and
  //    one account can't be on both sides of a wall.
  const a = new Session(args.base);
  const b = new Session(args.base);
  let haveA = false;
  let haveB = false;

  if (args.userA && args.userB) {
    // Operator-supplied accounts: the registration walls still get probed
    // (bare registration must refuse on non-open instances), but nothing is
    // created at the account layer.
    if (policy !== "open") {
      results.push(
        checkRegisterRefused(
          await anon.mutate("auth.register", { username: NAME_A, password: PASSWORD }),
          // Spelled out per policy — interpolating produced "a invite".
          policy === "invite" ? "bare on an invite-only instance" : "bare on a closed instance"
        )
      );
    }
    const loginA = await a.mutate("auth.login", {
      username: args.userA.username,
      password: args.userA.password,
    });
    results.push(checkLogin(loginA, await a.query("auth.me"), args.userA.username.toLowerCase()));
    const loginB = await b.mutate("auth.login", {
      username: args.userB.username,
      password: args.userB.password,
    });
    haveA = trpcErrorCode(loginA.body) === null;
    haveB = trpcErrorCode(loginB.body) === null;
  } else if (policy === "open") {
    const regA = await a.mutate("auth.register", { username: NAME_A, password: PASSWORD });
    results.push(checkRegisterSucceeded(regA, await a.query("auth.me"), NAME_A));
    haveA = trpcErrorCode(regA.body) === null;
    if (haveA) {
      created.push(`account ${NAME_A}`);
      results.push(
        checkDuplicateUsername(
          await anon.mutate("auth.register", { username: NAME_A, password: PASSWORD })
        )
      );
    }
    const regB = await b.mutate("auth.register", { username: NAME_B, password: PASSWORD });
    haveB = trpcErrorCode(regB.body) === null;
    if (haveB) created.push(`account ${NAME_B}`);
  } else if (policy === "invite") {
    results.push(
      checkRegisterRefused(
        await anon.mutate("auth.register", { username: NAME_A, password: PASSWORD }),
        "without an invite on an invite-only instance"
      )
    );
    if (args.inviteCode) {
      const regA = await a.mutate("auth.register", {
        username: NAME_A,
        password: PASSWORD,
        inviteCode: args.inviteCode,
      });
      results.push(checkRegisterSucceeded(regA, await a.query("auth.me"), NAME_A));
      haveA = trpcErrorCode(regA.body) === null;
      if (haveA) {
        created.push(`account ${NAME_A}`);
        results.push(
          checkDuplicateUsername(
            await anon.mutate("auth.register", {
              username: NAME_A,
              password: PASSWORD,
              inviteCode: args.inviteCode,
            })
          )
        );
      }
      const regB = await b.mutate("auth.register", {
        username: NAME_B,
        password: PASSWORD,
        inviteCode: args.inviteCode,
      });
      haveB = trpcErrorCode(regB.body) === null;
      if (haveB) created.push(`account ${NAME_B}`);
    } else {
      results.push(
        skip(
          "auth-register",
          "Registration with a valid invite succeeds",
          "No --invite-code supplied. The refusal above is all an outsider can prove."
        )
      );
    }
  } else {
    // Closed. The refusal is the conformance property; with no supplied
    // accounts, it is also the end of the road.
    results.push(
      checkRegisterRefused(
        await anon.mutate("auth.register", { username: NAME_A, password: PASSWORD }),
        "on a closed instance"
      )
    );
    if (args.inviteCode) {
      // "Closed means closed even for someone holding an old invite link."
      results.push(
        checkRegisterRefused(
          await anon.mutate("auth.register", {
            username: NAME_A,
            password: PASSWORD,
            inviteCode: args.inviteCode,
          }),
          "on a closed instance even with an invite code"
        )
      );
    }
  }

  // -- Sessions, probed with one deliberate failure. One: the login limiter
  //    allows ten in fifteen minutes, and a conformance run that locks the
  //    operator's throwaway out of its own follow-up checks proved nothing.
  if (haveA) {
    const username = args.userA?.username ?? NAME_A;
    results.push(
      checkBadPassword(
        await anon.mutate("auth.login", { username, password: `wrong-${PASSWORD}` })
      )
    );
  } else {
    results.push(
      skip("auth-bad-password", "A wrong password answers UNAUTHORIZED", noAccounts(policy))
    );
  }

  // -- Membership, roles, invites: need both accounts and a sandbox server.
  if (haveA && haveB) {
    const createdServer = await a.mutate("servers.create", {
      name: `conformance ${stamp}`,
      description: "Created by conformance-auth. Safe to ignore; cannot be deleted via the API.",
    });
    const server = trpcResult(createdServer.body) as {
      server?: { id?: number };
      defaultChannel?: { id?: number; encrypted?: boolean };
    } | null;
    const serverId = server?.server?.id;
    const channelId = server?.defaultChannel?.id;
    // Trust the channel's own answer over the instance-level capability —
    // it is the closer authority, and the two disagreeing is its own finding.
    const channelEncrypted = server?.defaultChannel?.encrypted ?? e2ee;

    if (typeof serverId !== "number" || typeof channelId !== "number") {
      results.push(
        skip(
          "membership",
          "Membership, role, and invite checks",
          `servers.create failed (${trpcErrorCode(createdServer.body) ?? "no id returned"}), ` +
            "so there is no sandbox to test against."
        )
      );
    } else {
      created.push(`server "conformance ${stamp}" (id ${serverId}) with #general`);

      // The walls, from outside.
      results.push(
        checkReadWall(await b.query("servers.getById", { serverId }), "the server")
      );
      results.push(
        checkReadWall(
          await b.query("messages.listByChannel", { channelId, limit: 10 }),
          "its messages"
        )
      );
      results.push(
        checkWriteWall(
          await b.mutate("messages.send", { channelId, content: "conformance write-wall probe" }),
          channelEncrypted
        )
      );

      // The door.
      const invite = await a.mutate("servers.createInvite", { serverId });
      const inviteCode = (trpcResult(invite.body) as { code?: string } | null)?.code;

      if (typeof inviteCode !== "string") {
        results.push(
          skip(
            "invite-preview",
            "Invite checks",
            `servers.createInvite failed (${trpcErrorCode(invite.body) ?? "no code returned"}).`
          )
        );
      } else {
        created.push(`invite code ${inviteCode} (now the server's permanent code)`);

        results.push(checkInvitePreview(await anon.rest(`/api/invite/${inviteCode}`)));
        // Well-formed, never-issued codes: nanoid alphabet, wrong on purpose.
        results.push(
          checkInviteUniformUnknown(
            await anon.rest(`/api/invite/${"0".repeat(10)}`),
            await anon.rest(`/api/invite/${"1".repeat(10)}`)
          )
        );
        results.push(checkInviteMalformed(await anon.rest(`/api/invite/${"x".repeat(64)}`)));

        const joined = await b.mutate("servers.joinByInvite", { code: inviteCode });
        if (trpcErrorCode(joined.body)) {
          results.push(
            skip(
              "membership-member-read",
              "Member checks",
              `joinByInvite failed (${trpcErrorCode(joined.body)}), so B never got inside.`
            )
          );
        } else {
          // The same reads and writes, from inside.
          results.push(
            checkMemberRead(await b.query("messages.listByChannel", { channelId, limit: 10 }))
          );
          const memberSend = await b.mutate("messages.send", {
            channelId,
            content: "conformance member post",
          });
          results.push(checkMemberSend(memberSend, channelEncrypted));

          // Roles: B is a plain member of A's server.
          results.push(
            checkRoleFloor(
              await b.mutate("channels.create", { serverId, name: `probe-${stamp}` }),
              "create channels"
            )
          );

          const bId = (trpcResult(await b.query("auth.me")) as { id?: number } | null)?.id;
          if (typeof bId === "number") {
            results.push(
              checkNoSelfElevation(
                await b.mutate("serverMembers.setRole", { serverId, userId: bId, role: "admin" })
              )
            );
          }

          // Moderation needs a message of A's to aim at — which needs a
          // channel the plain HTTP surface can write to. On an encrypted
          // instance that channel doesn't exist, and saying so beats quietly
          // testing less.
          if (!channelEncrypted) {
            const aPost = await a.mutate("messages.send", {
              channelId,
              content: "conformance moderation target",
            });
            const aMessageId = (trpcResult(aPost.body) as { id?: number } | null)?.id;
            const bMessageId = (trpcResult(memberSend.body) as { id?: number } | null)?.id;
            created.push(
              "up to two messages in #general (one deleted again by the moderation check)"
            );

            if (typeof aMessageId === "number" && typeof bMessageId === "number") {
              results.push(
                ...checkModerationBoundary(
                  await b.mutate("messages.delete", { messageId: aMessageId }),
                  await b.mutate("messages.delete", { messageId: bMessageId })
                )
              );
            }
          } else {
            results.push(
              skip(
                "roles-moderation",
                "Moderation boundary (delete own vs others')",
                "Every channel here is end-to-end encrypted, so this plain-HTTP runner cannot " +
                  "author the message the check needs. Run against an unencrypted instance, or " +
                  "trust the unit suite for this one."
              )
            );
          }
        }
      }

      // Logout last: it ends the session the other checks were using.
      await b.mutate("auth.logout");
      results.push(checkLogout(await b.query("auth.me")));
    }
  } else {
    // Always say why the deep half didn't run. A list that quietly shrinks is
    // the "nobody looked" failure mode wearing a green tick.
    results.push(
      skip(
        "membership",
        "Membership, role, and invite checks",
        args.userA && args.userB
          ? "The supplied --user-a/--user-b credentials did not both sign in; see above."
          : noAccounts(policy)
      )
    );
  }

  // ---------------------------------------------------------------- report

  const summary = summarize(results);

  if (args.json) {
    console.log(JSON.stringify({ target: args.base, summary, results, created }, null, 2));
    process.exit(summary.conformant ? 0 : 1);
  }

  console.log(`\n${BOLD}SOVRGN authenticated conformance${RESET}`);
  console.log(`${DIM}${args.base} — joinPolicy ${policy}, e2ee ${e2ee}${RESET}\n`);

  for (const result of results) {
    const mark =
      result.status === "pass"
        ? `${GREEN}✓${RESET}`
        : result.status === "fail"
          ? `${RED}✗${RESET}`
          : result.status === "warn"
            ? `${YELLOW}!${RESET}`
            : `${DIM}-${RESET}`;
    console.log(`  ${mark} ${result.title}`);
    if (result.status !== "pass") console.log(`      ${DIM}${result.detail}${RESET}`);
  }

  console.log("");
  if (created.length > 0) {
    console.log(`${BOLD}This run left behind:${RESET}`);
    for (const item of created) console.log(`  ${DIM}·${RESET} ${item}`);
    console.log(
      `  ${DIM}password for conformance accounts: ${PASSWORD}${RESET}`
    );
    console.log(
      `${DIM}None of it is deletable through the API — the protocol has no account or\n` +
        `server deletion. That is a real gap, and it is stated here rather than hidden.${RESET}\n`
    );
  }

  const tally = `${summary.passed} passed, ${summary.failed} failed, ${summary.warned} warnings, ${summary.skipped} skipped`;
  if (summary.conformant) {
    console.log(`${GREEN}${BOLD}Conformant.${RESET} ${DIM}${tally}${RESET}`);
    if (summary.skipped > 0) {
      console.log(`${DIM}Skips are unproven, not fine — each says what it needed.${RESET}`);
    }
  } else {
    console.log(`${RED}${BOLD}Not conformant.${RESET} ${DIM}${tally}${RESET}`);
    console.log(`${DIM}See docs/PROTOCOL.md § The authenticated surface.${RESET}`);
  }
  console.log("");
  process.exit(summary.conformant ? 0 : 1);
}

function noAccounts(policy: string): string {
  return policy === "open"
    ? "Registration failed, so the suite has no accounts to continue with."
    : `This is a ${policy} instance and no accounts were supplied. ` +
        "Provide --user-a and --user-b (throwaways you made for this), or an --invite-code.";
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
