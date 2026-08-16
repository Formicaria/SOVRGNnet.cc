import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-matrix-tests";
  process.env.MATRIX_SHARED_SECRET = process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
  process.env.MATRIX_SERVER_NAME = process.env.MATRIX_SERVER_NAME || "test.example";
});

import {
  __setFetchForTests,
  createChannelRoom,
  createSpace,
  inviteToRoom,
} from "./matrixService";

/**
 * Community rooms must not be open to the world.
 *
 * They were created with `preset: "public_chat"` and `visibility: "public"`,
 * which means:
 *
 *   - join_rule: public — anyone who can reach the homeserver may join,
 *     without an invite, regardless of SOVRGN's own join policy or its bans
 *   - listed in the homeserver's public room directory, so a private
 *     community was publicly enumerable
 *   - invite power level 0 — any member could pull arbitrary Matrix users in
 *
 * None of that was reachable while the homeserver was loopback-only, which is
 * why it survived. ADR 0008 stage 2 makes exposing the homeserver a supported
 * configuration, so the contradiction stops being theoretical: the app would
 * be enforcing rules the layer beneath it ignored.
 */

const fetchMock = vi.fn();

/** A fresh Response per call — a body can only be read once. */
function created(roomId = "!room:test.example") {
  return () =>
    new Response(JSON.stringify({ room_id: roomId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

beforeEach(() => {
  fetchMock.mockReset();
  __setFetchForTests(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function bodyOf(call = 0): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

describe("a community Space", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(created("!space:test.example"));
  });

  it("is not publicly joinable", async () => {
    await createSpace("token", "Zach's community");
    // private_chat sets join_rule: invite.
    expect(bodyOf().preset).toBe("private_chat");
    expect(bodyOf().preset).not.toBe("public_chat");
  });

  it("is not listed in the homeserver's room directory", async () => {
    // A private community appearing in /publicRooms is a disclosure, and
    // discovery is SOVRGN's job — gated on its own join policy.
    await createSpace("token", "Zach's community");
    expect(bodyOf().visibility).toBe("private");
  });

  it("only lets moderators and above invite", async () => {
    // The default is 0 — any member. With direct sync that becomes a way to
    // add arbitrary Matrix users, including someone SOVRGN has banned.
    await createSpace("token", "Zach's community");
    expect(bodyOf().power_level_content_override).toEqual({ invite: 50 });
  });

  it("is still a Space", async () => {
    await createSpace("token", "Zach's community");
    expect(bodyOf().creation_content).toEqual({ type: "m.space" });
  });

  it("pins the room version, rather than trusting the homeserver default", async () => {
    // Restricted child rooms need version 8+. An older default would silently
    // produce a public room — the exact failure being fixed.
    await createSpace("token", "Zach's community");
    expect(Number(bodyOf().room_version)).toBeGreaterThanOrEqual(8);
  });
});

describe("a channel room", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(created("!channel:test.example"));
  });

  it("is joinable by Space members and nobody else", async () => {
    await createChannelRoom("token", "!space:test.example", "general");

    const joinRules = bodyOf().initial_state.find(
      (event: { type: string }) => event.type === "m.room.join_rules"
    );
    expect(joinRules.content.join_rule).toBe("restricted");
    expect(joinRules.content.allow).toEqual([
      { type: "m.room_membership", room_id: "!space:test.example" },
    ]);
  });

  it("is not in the room directory either", async () => {
    await createChannelRoom("token", "!space:test.example", "general");
    expect(bodyOf().visibility).toBe("private");
  });

  it("carries the same invite restriction", async () => {
    await createChannelRoom("token", "!space:test.example", "general");
    expect(bodyOf().power_level_content_override).toEqual({ invite: 50 });
  });

  it("is still linked into the Space", async () => {
    await createChannelRoom("token", "!space:test.example", "general");
    // Second call is the m.space.child state event.
    expect(String(fetchMock.mock.calls[1][0])).toContain("m.space.child");
  });

  it("never uses a public preset", async () => {
    await createChannelRoom("token", "!space:test.example", "general");
    expect(bodyOf().preset).not.toBe("public_chat");
    expect(bodyOf().visibility).not.toBe("public");
  });
});

describe("inviteToRoom", () => {
  it("invites the named Matrix user", async () => {
    fetchMock.mockImplementation(() => new Response("{}", { status: 200 }));

    await inviteToRoom("owner-token", "!space:test.example", "@sovrgn_2:test.example");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/invite");
    expect(bodyOf().user_id).toBe("@sovrgn_2:test.example");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer owner-token");
  });

  it("escapes the room id into the path", async () => {
    fetchMock.mockImplementation(() => new Response("{}", { status: 200 }));
    await inviteToRoom("t", "!weird/../room:test.example", "@a:test.example");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/../");
  });
});
