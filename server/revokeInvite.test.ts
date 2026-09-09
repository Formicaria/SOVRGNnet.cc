import { beforeEach, describe, expect, it, vi } from "vitest";

// ENV is captured when ./routers imports matrixService, and ES module imports
// are hoisted above ordinary statements — so these must be set inside
// vi.hoisted or they land too late to be seen.
vi.hoisted(() => {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "test-secret-for-revoke-invite-tests";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET ||
    "test-shared-secret-for-revoke-invite-tests";
});

/**
 * Only the three accessors this procedure and its permission check reach for;
 * the rest of the module stays real. A partial mock rather than a hand-written
 * stand-in because `./routers` imports the whole namespace — an invented module
 * would pass here while the procedure quietly called something that isn't there.
 */
vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getServerById: vi.fn(),
    getServerMemberRole: vi.fn(),
    clearServerInviteCode: vi.fn(),
  };
});

import * as db from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

const SERVER_ID = 7;
const OWNER_ID = 1;
/** Anyone who isn't the owner, so the membership role decides the answer. */
const OTHER_ID = 2;

function callerFor(userId: number) {
  const user: AuthenticatedUser = {
    id: userId,
    openId: `user-${userId}`,
    username: `user${userId}`,
    usernameFold: `user${userId}`,
    passwordHash: null,
    ssoSubject: null,
    email: null,
    name: `User ${userId}`,
    loginMethod: "local",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return appRouter.createCaller({
    user,
    req: {
      protocol: "https",
      headers: {},
      ip: "127.0.0.1",
    } as TrpcContext["req"],
    res: {
      cookie: () => {},
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  });
}

/** As much of a server row as the permission check and the procedure read. */
function serverRow(inviteCode: string | null) {
  return { id: SERVER_ID, ownerId: OWNER_ID, inviteCode } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("servers.revokeInvite", () => {
  it("clears the code, and says a live link stopped working", async () => {
    vi.mocked(db.getServerById).mockResolvedValue(serverRow("V1StGXR8_Z"));

    await expect(
      callerFor(OWNER_ID).servers.revokeInvite({ serverId: SERVER_ID })
    ).resolves.toEqual({ revoked: true });
    expect(db.clearServerInviteCode).toHaveBeenCalledWith(SERVER_ID);
  });

  it("answers false, and writes nothing, when there was no link to kill", async () => {
    // The dialog says "that link is dead" on a true. Returning one here would
    // tell an admin they had just cut off a link that never existed.
    vi.mocked(db.getServerById).mockResolvedValue(serverRow(null));

    await expect(
      callerFor(OWNER_ID).servers.revokeInvite({ serverId: SERVER_ID })
    ).resolves.toEqual({ revoked: false });
    expect(db.clearServerInviteCode).not.toHaveBeenCalled();
  });

  it("lets an admin revoke, not just the owner", async () => {
    vi.mocked(db.getServerById).mockResolvedValue(serverRow("V1StGXR8_Z"));
    vi.mocked(db.getServerMemberRole).mockResolvedValue("admin");

    await expect(
      callerFor(OTHER_ID).servers.revokeInvite({ serverId: SERVER_ID })
    ).resolves.toEqual({ revoked: true });
  });

  it("refuses a moderator — minting is admin+, so taking one back is too", async () => {
    // The asymmetry would be the bug: a moderator who could revoke but not
    // create could shut the door on a server and not reopen it.
    vi.mocked(db.getServerById).mockResolvedValue(serverRow("V1StGXR8_Z"));
    vi.mocked(db.getServerMemberRole).mockResolvedValue("moderator");

    await expect(
      callerFor(OTHER_ID).servers.revokeInvite({ serverId: SERVER_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.clearServerInviteCode).not.toHaveBeenCalled();
  });

  it("refuses someone who isn't in the server at all", async () => {
    vi.mocked(db.getServerById).mockResolvedValue(serverRow("V1StGXR8_Z"));
    vi.mocked(db.getServerMemberRole).mockResolvedValue(null);

    await expect(
      callerFor(OTHER_ID).servers.revokeInvite({ serverId: SERVER_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.clearServerInviteCode).not.toHaveBeenCalled();
  });

  it("says NOT_FOUND for a server that doesn't exist, before asking about rank", async () => {
    vi.mocked(db.getServerById).mockResolvedValue(undefined);

    await expect(
      callerFor(OWNER_ID).servers.revokeInvite({ serverId: SERVER_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.getServerMemberRole).not.toHaveBeenCalled();
  });
});
