import { beforeEach, describe, expect, it, vi } from "vitest";

// ENV is captured when ./routers imports matrixService, and ES module imports
// are hoisted above ordinary statements — so these must be set inside
// vi.hoisted or they land too late to be seen.
vi.hoisted(() => {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "test-secret-for-profile-editable-tests";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET ||
    "test-shared-secret-for-profile-editable-tests";
});

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getEditableUserProfile: vi.fn() };
});

import * as db from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

const USER_ID = 3;

function caller() {
  const user: AuthenticatedUser = {
    id: USER_ID,
    openId: `user-${USER_ID}`,
    username: `user${USER_ID}`,
    usernameFold: `user${USER_ID}`,
    passwordHash: null,
    ssoSubject: null,
    email: null,
    name: `User ${USER_ID}`,
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("profile.editable", () => {
  it("answers with what is stored", async () => {
    vi.mocked(db.getEditableUserProfile).mockResolvedValue({
      avatar: "https://example.test/a.png",
      bio: "Runs a server in a closet.",
    });

    await expect(caller().profile.editable()).resolves.toEqual({
      avatar: "https://example.test/a.png",
      bio: "Runs a server in a closet.",
    });
  });

  it("answers with nulls for an account that has no profile row yet", async () => {
    // Not an error: it is the state of every account before anyone fills
    // anything in, and the form has to be able to tell it from "still loading".
    vi.mocked(db.getEditableUserProfile).mockResolvedValue(undefined);

    await expect(caller().profile.editable()).resolves.toEqual({
      avatar: null,
      bio: null,
    });
  });

  it("returns those two fields and nothing else, whatever the row holds", async () => {
    // The regression this exists for. `profile.get` next door is a `select()`
    // over the whole row, `matrixAccessToken` included — the instance's own
    // credential for acting as this account, and the one session
    // `signOutDevice` refuses to revoke. Rewriting the body as `return profile`
    // would look like a tidy-up and would hand that token to the browser.
    vi.mocked(db.getEditableUserProfile).mockResolvedValue({
      avatar: null,
      bio: null,
      matrixAccessToken: "syt_do_not_leak_me",
      matrixUserId: "@someone:test",
      walletAddress: "0xdeadbeef",
    } as never);

    const result = await caller().profile.editable();

    expect(Object.keys(result).sort()).toEqual(["avatar", "bio"]);
    expect(JSON.stringify(result)).not.toContain("syt_do_not_leak_me");
  });
});
