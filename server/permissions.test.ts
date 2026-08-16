import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The permission layer's only dependency is the database; stubbing it lets us
// test the rules themselves rather than Postgres.
vi.mock("./db", () => ({
  getServerById: vi.fn(),
  getServerMemberRole: vi.fn(),
}));

import * as db from "./db";
import {
  atLeast,
  getServerRole,
  requireAuthorityOver,
  requireServerRole,
} from "./permissions";

const OWNER_ID = 1;
const SERVER_ID = 10;

function asServer(ownerId: number | null) {
  return ownerId === null ? undefined : ({ id: SERVER_ID, ownerId } as never);
}

/** Everyone in this table is a member; the owner is whoever owns the server. */
function withMembers(ownerId: number | null, roles: Record<number, string | null>) {
  vi.mocked(db.getServerById).mockResolvedValue(asServer(ownerId));
  vi.mocked(db.getServerMemberRole).mockImplementation(async (_s, userId) => {
    return (roles[userId] ?? null) as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("atLeast", () => {
  it("accepts an exact match", () => {
    expect(atLeast("moderator", "moderator")).toBe(true);
  });

  it("accepts a higher rank", () => {
    expect(atLeast("owner", "member")).toBe(true);
    expect(atLeast("admin", "moderator")).toBe(true);
  });

  it("rejects a lower rank", () => {
    expect(atLeast("member", "moderator")).toBe(false);
    expect(atLeast("moderator", "admin")).toBe(false);
  });
});

describe("getServerRole", () => {
  it("calls the server's owner an owner even without a membership row", async () => {
    withMembers(OWNER_ID, {});
    expect(await getServerRole(SERVER_ID, OWNER_ID)).toBe("owner");
  });

  it("returns the membership role for everyone else", async () => {
    withMembers(OWNER_ID, { 2: "moderator" });
    expect(await getServerRole(SERVER_ID, 2)).toBe("moderator");
  });

  it("returns null for a stranger", async () => {
    withMembers(OWNER_ID, {});
    expect(await getServerRole(SERVER_ID, 99)).toBeNull();
  });

  it("returns null when the server doesn't exist", async () => {
    withMembers(null, {});
    expect(await getServerRole(SERVER_ID, OWNER_ID)).toBeNull();
  });
});

describe("requireServerRole", () => {
  it("lets a sufficiently ranked member through", async () => {
    withMembers(OWNER_ID, { 2: "admin" });
    await expect(requireServerRole(SERVER_ID, 2, "moderator")).resolves.toBe("admin");
  });

  it("rejects a member reaching above their rank", async () => {
    withMembers(OWNER_ID, { 2: "member" });
    await expect(requireServerRole(SERVER_ID, 2, "moderator")).rejects.toThrow(TRPCError);
  });

  it("rejects a non-member", async () => {
    withMembers(OWNER_ID, {});
    await expect(requireServerRole(SERVER_ID, 99, "member")).rejects.toThrow(
      /not a member/i
    );
  });

  it("says who is allowed when refusing an owner-only action", async () => {
    withMembers(OWNER_ID, { 2: "admin" });
    await expect(requireServerRole(SERVER_ID, 2, "owner")).rejects.toThrow(
      /only the server owner/i
    );
  });
});

describe("requireAuthorityOver", () => {
  it("lets an owner act on a member", async () => {
    withMembers(OWNER_ID, { 2: "member" });
    await expect(requireAuthorityOver(SERVER_ID, OWNER_ID, 2)).resolves.toEqual({
      actorRole: "owner",
      targetRole: "member",
    });
  });

  it("refuses to let someone act on themselves", async () => {
    withMembers(OWNER_ID, { 2: "admin" });
    await expect(requireAuthorityOver(SERVER_ID, 2, 2)).rejects.toThrow(/yourself/i);
  });

  it("refuses equal ranks — two admins can't kick each other", async () => {
    withMembers(OWNER_ID, { 2: "admin", 3: "admin" });
    await expect(requireAuthorityOver(SERVER_ID, 2, 3)).rejects.toThrow(/below you/i);
  });

  it("refuses acting upward", async () => {
    withMembers(OWNER_ID, { 2: "moderator", 3: "admin" });
    await expect(requireAuthorityOver(SERVER_ID, 2, 3)).rejects.toThrow(/below you/i);
  });

  it("refuses a plain member any moderation at all", async () => {
    withMembers(OWNER_ID, { 2: "member", 3: "member" });
    await expect(requireAuthorityOver(SERVER_ID, 2, 3)).rejects.toThrow(TRPCError);
  });

  it("refuses when the target isn't in the server", async () => {
    withMembers(OWNER_ID, {});
    await expect(requireAuthorityOver(SERVER_ID, OWNER_ID, 99)).rejects.toThrow(
      /isn't a member/i
    );
  });

  it("nobody can moderate the owner", async () => {
    withMembers(OWNER_ID, { 2: "admin" });
    await expect(requireAuthorityOver(SERVER_ID, 2, OWNER_ID)).rejects.toThrow(
      /below you/i
    );
  });
});
