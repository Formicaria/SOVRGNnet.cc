/**
 * The authenticated conformance deciders, tested the way the suite itself is
 * built: pure functions over already-shaped exchanges, no server anywhere.
 *
 * Wire bodies below are constructed in BOTH shapes the runner can meet —
 * superjson's `{ error: { json: { data } } }` and the transformerless
 * `{ error: { data } }` — because the first version of e2e-journey's unwrap()
 * read only one of them and turned every diagnostic into "unknown error".
 * The deciders must not repeat that.
 */

import { describe, expect, it } from "vitest";
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
  trpcErrorCode,
  trpcResult,
  type Exchange,
} from "@shared/conformanceAuth";

// ---------------------------------------------------------------- fixtures

/** A tRPC refusal as superjson puts it on the wire. */
function refusal(code: string, message = "whatever the implementation says"): Exchange {
  return {
    status: 403, // deciders must not read this; the code in the body decides
    body: { error: { json: { message, code: -32603, data: { code, httpStatus: 403 } } } },
  };
}

/** The same refusal without a transformer. */
function plainRefusal(code: string): Exchange {
  return { status: 403, body: { error: { message: "m", data: { code } } } };
}

/** A tRPC success, superjson-enveloped. */
function success(payload: unknown): Exchange {
  return { status: 200, body: { result: { data: { json: payload } } } };
}

const transportDown: Exchange = { status: 0, body: null, error: "connect ECONNREFUSED" };

// ------------------------------------------------------------- wire parsing

describe("trpcErrorCode", () => {
  it("reads the superjson envelope", () => {
    expect(trpcErrorCode(refusal("FORBIDDEN").body)).toBe("FORBIDDEN");
  });

  it("reads the transformerless envelope", () => {
    expect(trpcErrorCode(plainRefusal("CONFLICT").body)).toBe("CONFLICT");
  });

  it("unwraps a batched one-element response", () => {
    expect(trpcErrorCode([refusal("UNAUTHORIZED").body])).toBe("UNAUTHORIZED");
  });

  it("answers null for successes and for things that aren't tRPC at all", () => {
    expect(trpcErrorCode(success({ id: 1 }).body)).toBeNull();
    expect(trpcErrorCode(null)).toBeNull();
    expect(trpcErrorCode("nope")).toBeNull();
    expect(trpcErrorCode({ error: "a string, not an object" })).toBeNull();
    expect(trpcErrorCode({ error: { json: { data: { code: 42 } } } })).toBeNull();
  });
});

describe("trpcResult", () => {
  it("reads both envelopes and batched responses", () => {
    expect(trpcResult(success({ username: "a" }).body)).toEqual({ username: "a" });
    expect(trpcResult({ result: { data: { username: "a" } } })).toEqual({ username: "a" });
    expect(trpcResult([success(null).body])).toBeNull();
  });

  it("answers undefined when there is no result", () => {
    expect(trpcResult(refusal("FORBIDDEN").body)).toBeUndefined();
    expect(trpcResult(null)).toBeUndefined();
  });
});

// ----------------------------------------------------------------- sessions

describe("checkAnonMe", () => {
  it("passes on a null answer", () => {
    expect(checkAnonMe(success(null)).status).toBe("pass");
  });

  it("fails when a stranger gets an account back", () => {
    expect(checkAnonMe(success({ id: 1, username: "a" })).status).toBe("fail");
  });

  it("fails on a non-200 — the probe must not be a challenge", () => {
    expect(checkAnonMe({ status: 401, body: null }).status).toBe("fail");
  });

  it("fails on transport errors rather than guessing", () => {
    expect(checkAnonMe(transportDown).status).toBe("fail");
  });
});

describe("checkRegisterSucceeded", () => {
  it("passes when registration lands and the session proves it", () => {
    const result = checkRegisterSucceeded(
      success({ id: 7, username: "conformance-x-a" }),
      success({ id: 7, username: "conformance-x-a" }),
      "conformance-x-a"
    );
    expect(result.status).toBe("pass");
  });

  it("fails when the account exists but the session doesn't", () => {
    const result = checkRegisterSucceeded(
      success({ id: 7, username: "conformance-x-a" }),
      success(null),
      "conformance-x-a"
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("session");
  });

  it("fails when registration is refused", () => {
    expect(
      checkRegisterSucceeded(refusal("FORBIDDEN"), success(null), "x").status
    ).toBe("fail");
  });
});

describe("checkRegisterRefused", () => {
  it("passes on FORBIDDEN regardless of message wording", () => {
    expect(checkRegisterRefused(refusal("FORBIDDEN", "closed."), "x").status).toBe("pass");
    expect(
      checkRegisterRefused(refusal("FORBIDDEN", "entirely different prose"), "x").status
    ).toBe("pass");
  });

  it("fails on the wrong refusal code", () => {
    expect(checkRegisterRefused(refusal("BAD_REQUEST"), "x").status).toBe("fail");
  });

  it("fails when the registration is accepted — the advertised policy lied", () => {
    expect(checkRegisterRefused(success({ id: 9 }), "x").status).toBe("fail");
  });
});

describe("checkDuplicateUsername", () => {
  it("passes on CONFLICT and fails on acceptance", () => {
    expect(checkDuplicateUsername(refusal("CONFLICT")).status).toBe("pass");
    expect(checkDuplicateUsername(success({ id: 2 })).status).toBe("fail");
  });
});

describe("checkBadPassword", () => {
  it("passes on UNAUTHORIZED", () => {
    expect(checkBadPassword(refusal("UNAUTHORIZED")).status).toBe("pass");
  });

  it("warns — not fails — when the rate limiter got there first", () => {
    expect(checkBadPassword(refusal("TOO_MANY_REQUESTS")).status).toBe("warn");
  });

  it("fails hard when a wrong password signs in", () => {
    expect(checkBadPassword(success({ id: 1 })).status).toBe("fail");
  });
});

describe("checkLogin / checkLogout", () => {
  it("login passes only when auth.me agrees afterwards", () => {
    const user = { id: 3, username: "op-a" };
    expect(checkLogin(success(user), success(user), "op-a").status).toBe("pass");
    expect(checkLogin(success(user), success(null), "op-a").status).toBe("fail");
    expect(checkLogin(refusal("UNAUTHORIZED"), success(null), "op-a").status).toBe("fail");
  });

  it("logout passes only when the session is actually gone", () => {
    expect(checkLogout(success(null)).status).toBe("pass");
    expect(checkLogout(success({ id: 3, username: "op-a" })).status).toBe("fail");
  });
});

// --------------------------------------------------------------- membership

describe("membership walls", () => {
  it("read wall: FORBIDDEN passes, anything readable fails", () => {
    expect(checkReadWall(refusal("FORBIDDEN"), "the server").status).toBe("pass");
    expect(checkReadWall(success([]), "the server").status).toBe("fail");
    expect(checkReadWall(refusal("NOT_FOUND"), "the server").status).toBe("fail");
  });

  it("write wall: the membership refusal passes on any channel", () => {
    expect(checkWriteWall(refusal("FORBIDDEN"), false).status).toBe("pass");
    expect(checkWriteWall(refusal("FORBIDDEN"), true).status).toBe("pass");
  });

  it("write wall: the encryption refusal reaching a stranger is the ordering bug", () => {
    const result = checkWriteWall(refusal("PRECONDITION_FAILED"), true);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("membership");
  });

  it("member read passes once the wall opens", () => {
    expect(checkMemberRead(success([])).status).toBe("pass");
    expect(checkMemberRead(refusal("FORBIDDEN")).status).toBe("fail");
  });

  it("member send: plaintext lands on a plain channel", () => {
    expect(checkMemberSend(success({ id: 11 }), false).status).toBe("pass");
    expect(checkMemberSend(refusal("FORBIDDEN"), false).status).toBe("fail");
  });

  it("member send: an encrypted channel must refuse plaintext even from a member", () => {
    expect(checkMemberSend(refusal("PRECONDITION_FAILED"), true).status).toBe("pass");
    // Accepting it is the overstatement the capability exists to rule out.
    expect(checkMemberSend(success({ id: 11 }), true).status).toBe("fail");
  });
});

// -------------------------------------------------------------------- roles

describe("roles", () => {
  it("the admin floor holds against a member", () => {
    expect(checkRoleFloor(refusal("FORBIDDEN"), "create channels").status).toBe("pass");
    expect(checkRoleFloor(success({ id: 5 }), "create channels").status).toBe("fail");
  });

  it("a member cannot touch roles", () => {
    expect(checkNoSelfElevation(refusal("FORBIDDEN")).status).toBe("pass");
    expect(checkNoSelfElevation(success({ role: "admin" })).status).toBe("fail");
  });

  it("moderation boundary needs both halves", () => {
    const both = checkModerationBoundary(refusal("FORBIDDEN"), success({ deleted: true }));
    expect(both.map(r => r.status)).toEqual(["pass", "pass"]);

    // A member deleting someone else's words is the failure that matters most.
    const leaky = checkModerationBoundary(success({ deleted: true }), success({ deleted: true }));
    expect(leaky[0].status).toBe("fail");

    // And a member locked out of their own is the other half of the contract.
    const lockedOut = checkModerationBoundary(refusal("FORBIDDEN"), refusal("FORBIDDEN"));
    expect(lockedOut[1].status).toBe("fail");
  });
});

// ------------------------------------------------------------------ invites

describe("invites", () => {
  const goodPreview: Exchange = {
    status: 200,
    body: {
      valid: true,
      server: { name: "conformance x", description: null, icon: null },
      instance: { id: "abcd1234abcd1234", name: "Test", matrixServerName: "t", encryption: true },
    },
  };

  it("a live code previews the public face", () => {
    expect(checkInvitePreview(goodPreview).status).toBe("pass");
  });

  it("member or channel data in the preview is a disclosure", () => {
    const leaky: Exchange = {
      status: 200,
      body: {
        ...(goodPreview.body as Record<string, unknown>),
        memberCount: 12,
      },
    };
    expect(checkInvitePreview(leaky).status).toBe("fail");
    expect(checkInvitePreview(leaky).detail).toContain("memberCount");
  });

  it("a live code that 404s is a fail", () => {
    expect(checkInvitePreview({ status: 404, body: { error: "x" } }).status).toBe("fail");
  });

  it("unknown codes must be indistinguishable", () => {
    const body = { error: "This invite is no longer valid" };
    expect(
      checkInviteUniformUnknown({ status: 404, body }, { status: 404, body }).status
    ).toBe("pass");

    expect(
      checkInviteUniformUnknown(
        { status: 404, body },
        { status: 404, body: { error: "This invite was revoked" } }
      ).status
    ).toBe("fail");

    expect(
      checkInviteUniformUnknown({ status: 404, body }, { status: 410, body }).status
    ).toBe("fail");
  });

  it("malformed codes are refused before the lookup", () => {
    expect(checkInviteMalformed({ status: 400, body: { error: "m" } }).status).toBe("pass");
    expect(checkInviteMalformed({ status: 404, body: { error: "m" } }).status).toBe("fail");
  });
});

// -------------------------------------------------- structure over prose

describe("deciders match structure, never prose", () => {
  it("every refusal decider gives the same verdict whatever the message says", () => {
    // The lesson from this repo's own history: a check that matches text
    // fails on a reworded message — or worse, on its own comment.
    for (const message of ["Access denied.", "完全に別の言い回し", ""]) {
      expect(checkReadWall(refusal("FORBIDDEN", message), "x").status).toBe("pass");
      expect(checkWriteWall(refusal("FORBIDDEN", message), true).status).toBe("pass");
      expect(checkRegisterRefused(refusal("FORBIDDEN", message), "x").status).toBe("pass");
      expect(checkRoleFloor(refusal("FORBIDDEN", message), "x").status).toBe("pass");
    }
  });
});
