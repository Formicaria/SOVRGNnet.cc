/**
 * Conformance checks for the authenticated surface.
 *
 * The unauthenticated suite (conformance.ts) answers "does this address speak
 * the protocol". This one answers the question PROTOCOL.md gestures at when it
 * says an instance implements "SOVRGN's side of authentication, membership,
 * roles, and invites": does the thing behind the descriptor actually enforce
 * what the descriptor promises?
 *
 * Kept in its own module, deliberately. The split is a safety boundary, not
 * tidiness: everything in conformance.ts is safe to run against a stranger's
 * instance, and everything here requires credentials and CREATES STATE —
 * accounts, a server, messages. A single module would make it too easy for a
 * runner to drift into doing both.
 *
 * Same purity rule as the sibling: the caller does every fetch and hands the
 * exchanges in; this module only decides. That is what lets the tricky
 * deciders — error-code extraction across wire shapes, enumeration-uniformity
 * comparison — be tested without standing up a server.
 *
 * Two lessons from this repo's history are load-bearing here:
 *
 *   - Assert structure, not text. Refusal MESSAGES are wording; refusal CODES
 *     are contract. Every decider below matches on the tRPC error code and
 *     never on prose, so an instance may reword every message and still
 *     conform — and a suite can't fail on its own comment.
 *
 *   - "It's running" and "it's the right one" are separate questions. The
 *     write-wall check doesn't just ask whether a non-member was refused; it
 *     asks whether they were refused with the MEMBERSHIP code rather than the
 *     encryption code, because the second refusal leaks a property of a
 *     channel the caller had no business knowing exists. The ordering was a
 *     real bug once (fixed in 0.6.x); this keeps it fixed in every
 *     implementation, not just this one.
 */

import { pass, fail, warn, asRecord, type CheckResult } from "./conformance";

/**
 * One HTTP exchange the runner already performed. Same shape idea as
 * conformance.ts's Probe, renamed because these are almost all mutations —
 * "probe" would misdescribe a call that registered an account.
 */
export interface Exchange {
  status: number;
  /** Parsed JSON body, or null if the body wasn't JSON. */
  body: unknown;
  /** Transport failure — unreachable, TLS refused, timed out. */
  error?: string;
}

/**
 * The tRPC error code carried in a refusal body, whichever wire shape it
 * arrived in.
 *
 * The server runs superjson, so errors arrive as
 * `{ error: { json: { data: { code } } } }`; without a transformer they'd be
 * `{ error: { data: { code } } }`. Both are accepted because the protocol
 * point is the code, not the envelope — and because e2e-journey.ts's first
 * unwrap() looked in only one place and reported "unknown error" for every
 * failure until someone noticed. Batched responses arrive as a one-element
 * array; that is unwrapped too.
 */
export function trpcErrorCode(body: unknown): string | null {
  const root = Array.isArray(body) ? body[0] : body;
  const record = asRecord(root);
  if (!record) return null;

  const error = asRecord(record.error);
  if (!error) return null;

  const inner = asRecord(error.json) ?? error;
  const data = asRecord(inner.data);
  const code = data?.code;
  return typeof code === "string" ? code : null;
}

/** The `result.data.json` payload of a tRPC success, whichever envelope. */
export function trpcResult(body: unknown): unknown {
  const root = Array.isArray(body) ? body[0] : body;
  const record = asRecord(root);
  if (!record) return undefined;

  const result = asRecord(record.result);
  if (!result) return undefined;

  const data = asRecord(result.data);
  if (data && "json" in data) return data.json;
  return result.data;
}

const transportFailed = (id: string, title: string, x: Exchange): CheckResult =>
  fail(id, title, `The request itself failed: ${x.error}`);

// -- Sessions -----------------------------------------------------------------

/**
 * `auth.me` answers null to a stranger rather than refusing.
 *
 * The front door is a probe, not a challenge: a client asks "who am I here?"
 * before it knows whether it holds a session, and an implementation that
 * answers 401 turns every cold start into an error path.
 */
export function checkAnonMe(x: Exchange): CheckResult {
  const id = "auth-anon-me";
  const title = "auth.me answers null when unauthenticated";

  if (x.error) return transportFailed(id, title, x);
  if (x.status !== 200) {
    return fail(id, title, `Returned HTTP ${x.status}; expected 200 with a null result.`);
  }
  const result = trpcResult(x.body);
  if (result !== null) {
    return fail(
      id,
      title,
      `Returned ${JSON.stringify(result)?.slice(0, 80)} to a request with no session; expected null.`
    );
  }
  return pass(id, title, "null, HTTP 200");
}

/** Registration succeeded and the session landed: me returns the new account. */
export function checkRegisterSucceeded(
  x: Exchange,
  meAfter: Exchange,
  username: string
): CheckResult {
  const id = "auth-register";
  const title = "Registration creates an account and a session";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code) {
    return fail(id, title, `auth.register was refused with ${code}.`);
  }

  const me = asRecord(trpcResult(meAfter.body));
  if (!me || me.username !== username) {
    return fail(
      id,
      title,
      "Registration returned success but auth.me afterwards did not return the new account — " +
        "the account exists and the session does not, which strands the person at a login form " +
        "they just filled in."
    );
  }
  return pass(id, title, `Registered and signed in as ${username}`);
}

/**
 * Registration refused where the advertised join policy demands it.
 *
 * The join policy was advertised by /api/instance and unenforced for months
 * (ROADMAP, phase 7.5) — a closed server that accepts strangers is the
 * descriptor lying. FORBIDDEN specifically: BAD_REQUEST would mean "you asked
 * wrong", and the caller asked exactly right.
 */
export function checkRegisterRefused(x: Exchange, why: string): CheckResult {
  const id = "auth-register-refused";
  const title = `Registration is refused ${why}`;

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "FORBIDDEN") return pass(id, title, "FORBIDDEN");
  if (code) {
    return fail(id, title, `Refused, but with ${code}; the join policy refusal is FORBIDDEN.`);
  }
  return fail(
    id,
    title,
    "The registration was accepted. The instance advertises a policy it does not enforce."
  );
}

/** A second registration under the same username answers CONFLICT. */
export function checkDuplicateUsername(x: Exchange): CheckResult {
  const id = "auth-username-conflict";
  const title = "A taken username answers CONFLICT";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "CONFLICT") return pass(id, title, "CONFLICT");
  if (code) return fail(id, title, `Refused with ${code}; a name collision is CONFLICT.`);
  return fail(
    id,
    title,
    "Registered a second account under an existing username. Two accounts now fold to one " +
      "sign-in identifier."
  );
}

/**
 * A wrong password answers UNAUTHORIZED — and the check stops there, on the
 * code alone. Whether the message distinguishes "no such account" from "wrong
 * password" is an enumeration concern this suite can't probe without hammering
 * the login rate limit of a live instance; the reference keeps them identical
 * on purpose.
 */
export function checkBadPassword(x: Exchange): CheckResult {
  const id = "auth-bad-password";
  const title = "A wrong password answers UNAUTHORIZED";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "UNAUTHORIZED") return pass(id, title, "UNAUTHORIZED");
  if (code === "TOO_MANY_REQUESTS") {
    return warn(
      id,
      title,
      "Rate-limited before the credential check could be observed. Re-run in 15 minutes; " +
        "the limiter answering at attempt one suggests earlier runs or real traffic."
    );
  }
  if (code) return fail(id, title, `Refused with ${code}; a bad credential is UNAUTHORIZED.`);
  return fail(id, title, "A wrong password signed in. Stop and rotate that password.");
}

/** Login with good credentials lands a session that auth.me then confirms. */
export function checkLogin(x: Exchange, meAfter: Exchange, username: string): CheckResult {
  const id = "auth-login";
  const title = "Login issues a working session";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code) return fail(id, title, `auth.login was refused with ${code}.`);

  const me = asRecord(trpcResult(meAfter.body));
  if (!me || me.username !== username) {
    return fail(
      id,
      title,
      "Login returned success but auth.me did not agree afterwards. A session that doesn't " +
        "authenticate the next request is not a session."
    );
  }
  return pass(id, title, `Signed in; auth.me answers ${username}`);
}

/** After logout, auth.me answers null again — the session actually ended. */
export function checkLogout(meAfter: Exchange): CheckResult {
  const id = "auth-logout";
  const title = "Logout ends the session";

  if (meAfter.error) return transportFailed(id, title, meAfter);

  const result = trpcResult(meAfter.body);
  if (result !== null) {
    return fail(
      id,
      title,
      "auth.me still returns the account after auth.logout. A logout that leaves the session " +
        "working is a promise to a person walking away from a shared machine."
    );
  }
  return pass(id, title, "auth.me answers null after logout");
}

// -- Membership ---------------------------------------------------------------

/**
 * A non-member reading server data is refused with FORBIDDEN.
 *
 * NOT_FOUND would arguably hide more; FORBIDDEN is what the reference
 * promises, and the point of a conformance suite is one answer, not a menu.
 * What must never happen is 200: membership is the entire authorization model
 * above the instance's front door.
 */
export function checkReadWall(x: Exchange, what: string): CheckResult {
  const id = `membership-read-wall-${what}`;
  const title = `A non-member cannot read ${what}`;

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "FORBIDDEN") return pass(id, title, "FORBIDDEN");
  if (code) return fail(id, title, `Refused with ${code}; the membership wall answers FORBIDDEN.`);
  return fail(id, title, `A non-member read ${what}. Membership is not being enforced on reads.`);
}

/**
 * A non-member writing is refused with the MEMBERSHIP code — even into an
 * encrypted channel, where a lazier implementation would refuse with the
 * encryption code first and thereby tell a stranger the channel is encrypted.
 * The ordering is load-bearing and was once a real bug; the check exists so it
 * can only be reintroduced by failing conformance.
 */
export function checkWriteWall(x: Exchange, channelEncrypted: boolean): CheckResult {
  const id = "membership-write-wall";
  const title = "A non-member cannot post, and learns nothing trying";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "FORBIDDEN") {
    return pass(
      id,
      title,
      channelEncrypted
        ? "FORBIDDEN — the membership refusal, not the encryption one"
        : "FORBIDDEN"
    );
  }
  if (code === "PRECONDITION_FAILED") {
    return fail(
      id,
      title,
      "Refused with the encryption code rather than the membership one. A stranger just " +
        "learned a channel they can't see is encrypted — the refusal order must check " +
        "membership first."
    );
  }
  if (code) return fail(id, title, `Refused with ${code}; expected FORBIDDEN.`);
  return fail(id, title, "A non-member posted into the channel.");
}

/** After joining by invite, the same read that was walled now answers. */
export function checkMemberRead(x: Exchange): CheckResult {
  const id = "membership-member-read";
  const title = "A member can read what a stranger could not";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code) {
    return fail(
      id,
      title,
      `Still refused (${code}) after joining. Joining that doesn't admit is a wall with no door.`
    );
  }
  return pass(id, title, "Readable after joining");
}

/**
 * A member posting over the plain HTTP surface: succeeds on an unencrypted
 * channel; on an encrypted one is refused with PRECONDITION_FAILED — the
 * instance holds no keys and has nothing to offer an encrypted room but
 * plaintext, so accepting the send would quietly undermine the encryption for
 * everyone in it. Both outcomes are the instance telling the truth.
 */
export function checkMemberSend(x: Exchange, channelEncrypted: boolean): CheckResult {
  const id = "membership-member-send";
  const title = channelEncrypted
    ? "An encrypted channel refuses plaintext, even from a member"
    : "A member can post";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);

  if (channelEncrypted) {
    if (code === "PRECONDITION_FAILED") {
      return pass(id, title, "PRECONDITION_FAILED — composing happens in a client with keys");
    }
    if (code) return fail(id, title, `Refused with ${code}; expected PRECONDITION_FAILED.`);
    return fail(
      id,
      title,
      "The instance accepted plaintext into a channel it advertises as end-to-end encrypted. " +
        "That is the overstatement the e2ee capability exists to rule out."
    );
  }

  if (code) return fail(id, title, `A member's post was refused with ${code}.`);
  return pass(id, title, "Posted");
}

// -- Roles ----------------------------------------------------------------------

/** A plain member is below the admin floor for structural changes. */
export function checkRoleFloor(x: Exchange, what: string): CheckResult {
  const id = `roles-floor-${what}`;
  const title = `A member cannot ${what}`;

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "FORBIDDEN") return pass(id, title, "FORBIDDEN");
  if (code) return fail(id, title, `Refused with ${code}; the role floor answers FORBIDDEN.`);
  return fail(id, title, `A plain member did ${what}. Role ranks are not being enforced.`);
}

/**
 * Nobody grants a role at or above their own — the rule that stops a member
 * self-promoting and two admins deposing each other in a loop.
 */
export function checkNoSelfElevation(x: Exchange): CheckResult {
  const id = "roles-no-self-elevation";
  const title = "A member cannot change roles at all";

  if (x.error) return transportFailed(id, title, x);

  const code = trpcErrorCode(x.body);
  if (code === "FORBIDDEN") return pass(id, title, "FORBIDDEN");
  if (code) return fail(id, title, `Refused with ${code}; expected FORBIDDEN.`);
  return fail(id, title, "A member changed a role. The authority rule is not being enforced.");
}

/**
 * Moderation boundary: deleting someone else's message needs moderator rank,
 * and a member deleting their own is allowed — both halves, because a suite
 * that only proves refusals would pass an instance where nobody can delete
 * anything.
 */
export function checkModerationBoundary(
  deleteOthers: Exchange,
  deleteOwn: Exchange
): CheckResult[] {
  const results: CheckResult[] = [];

  {
    const id = "roles-moderation-others";
    const title = "A member cannot delete someone else's message";
    if (deleteOthers.error) {
      results.push(transportFailed(id, title, deleteOthers));
    } else {
      const code = trpcErrorCode(deleteOthers.body);
      if (code === "FORBIDDEN") results.push(pass(id, title, "FORBIDDEN"));
      else if (code) results.push(fail(id, title, `Refused with ${code}; expected FORBIDDEN.`));
      else
        results.push(
          fail(id, title, "A plain member deleted another person's message.")
        );
    }
  }

  {
    const id = "roles-moderation-own";
    const title = "A member can delete their own message";
    if (deleteOwn.error) {
      results.push(transportFailed(id, title, deleteOwn));
    } else {
      const code = trpcErrorCode(deleteOwn.body);
      if (code) {
        results.push(
          fail(
            id,
            title,
            `Refused with ${code}. Authorship confers deletion; a member locked out of their ` +
              "own words has no way to take anything back."
          )
        );
      } else {
        results.push(pass(id, title, "Deleted"));
      }
    }
  }

  return results;
}

// -- Invites --------------------------------------------------------------------

/**
 * The unauthenticated invite preview shows the community's public face and
 * nothing else. An invite code is a bearer token anyone might forward; it must
 * not leak the shape of a community to someone who never joins.
 */
export function checkInvitePreview(x: Exchange): CheckResult {
  const id = "invite-preview";
  const title = "An invite previews the public face only";

  if (x.error) return transportFailed(id, title, x);
  if (x.status !== 200) {
    return fail(id, title, `GET /api/invite/<code> returned ${x.status} for a live code.`);
  }

  const body = asRecord(x.body);
  const server = body ? asRecord(body.server) : null;
  if (!body || body.valid !== true || !server || typeof server.name !== "string") {
    return fail(id, title, "No { valid: true, server: { name } } in the response.");
  }

  // The same discipline as the descriptor's no-leakage check: name the fields
  // that must not be here, don't trust that they won't be.
  const forbidden = ["members", "memberCount", "users", "channels", "messages", "emails"];
  const leaked = forbidden.filter(key => key in body || key in server);
  if (leaked.length > 0) {
    return fail(id, title, `The preview includes: ${leaked.join(", ")}. This endpoint is public.`);
  }

  return pass(id, title, `Names "${server.name}" and nothing private`);
}

/**
 * Unknown codes are refused uniformly: same status, same body, whichever
 * unknown code is asked about. Any difference between two invalid codes is a
 * bit of information, and enough bits enumerate which codes were once real.
 */
export function checkInviteUniformUnknown(a: Exchange, b: Exchange): CheckResult {
  const id = "invite-uniform-unknown";
  const title = "Unknown invite codes are indistinguishable";

  if (a.error || b.error) return transportFailed(id, title, a.error ? a : b);

  if (a.status !== 404 || b.status !== 404) {
    return fail(
      id,
      title,
      `Expected 404 for both unknown codes; got ${a.status} and ${b.status}.`
    );
  }
  if (JSON.stringify(a.body) !== JSON.stringify(b.body)) {
    return fail(
      id,
      title,
      "Two unknown codes drew different bodies. Whatever varies is a signal to enumerate with."
    );
  }
  return pass(id, title, "Both 404, byte-identical bodies");
}

/** A malformed code is a bad request, not a lookup. */
export function checkInviteMalformed(x: Exchange): CheckResult {
  const id = "invite-malformed";
  const title = "A malformed invite code answers 400";

  if (x.error) return transportFailed(id, title, x);
  if (x.status === 400) return pass(id, title, "400");
  return fail(
    id,
    title,
    `Returned ${x.status}. Refusing garbage before the lookup keeps the 404 space uniform.`
  );
}

// -- Assembly -------------------------------------------------------------------

/**
 * The skip helper, re-exported so the runner states *why* a check didn't run
 * ("closed instance, no operator credentials supplied") instead of quietly
 * shrinking the list. Absent-but-unexplained is the failure mode this suite's
 * sibling calls "nobody looked".
 */
export { skip, summarize, type CheckResult } from "./conformance";
