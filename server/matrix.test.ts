import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ENV is captured when matrixService is imported, and ES module imports are
// hoisted above ordinary statements — so setting process.env here normally
// would happen too late. vi.hoisted runs before the imports below.
const { SHARED_SECRET } = vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-matrix-tests";
  const secret = process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
  process.env.MATRIX_SHARED_SECRET = secret;
  return { SHARED_SECRET: secret };
});

import { createHmac } from "node:crypto";
import {
  __setFetchForTests,
  createChannelRoom,
  createSpace,
  deriveMatrixPassword,
  getRoomMessages,
  localpartForUser,
  MatrixError,
  registerOrLogin,
  sendMessage,
  sharedSecretMac,
} from "./matrixService";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  __setFetchForTests(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  __setFetchForTests((...args) => fetch(...args));
});

describe("Matrix account provisioning", () => {
  it("derives deterministic localparts and passwords", () => {
    expect(localpartForUser(7)).toBe("sovrgn_7");
    expect(deriveMatrixPassword(7)).toBe(deriveMatrixPassword(7));
    expect(deriveMatrixPassword(7)).not.toBe(deriveMatrixPassword(8));
  });

  describe("shared-secret MAC", () => {
    it("matches the HMAC Synapse and Dendrite expect", () => {
      // Null-separated fields, HMAC-SHA1, keyed with the shared secret.
      const expected = createHmac("sha1", "secret")
        .update("nonce\x00alice\x00hunter2\x00notadmin")
        .digest("hex");

      expect(sharedSecretMac("secret", "nonce", "alice", "hunter2", false)).toBe(expected);
    });

    it("distinguishes admin from non-admin", () => {
      expect(sharedSecretMac("s", "n", "u", "p", true)).not.toBe(
        sharedSecretMac("s", "n", "u", "p", false)
      );
    });

    it("changes with every input", () => {
      const base = sharedSecretMac("s", "n", "u", "p", false);
      expect(sharedSecretMac("other", "n", "u", "p", false)).not.toBe(base);
      expect(sharedSecretMac("s", "other", "u", "p", false)).not.toBe(base);
      expect(sharedSecretMac("s", "n", "other", "p", false)).not.toBe(base);
      expect(sharedSecretMac("s", "n", "u", "other", false)).not.toBe(base);
    });

    it("can't be confused by moving a separator", () => {
      // Without the null bytes, ("ab","c") and ("a","bc") would collide.
      expect(sharedSecretMac("s", "n", "ab", "c", false)).not.toBe(
        sharedSecretMac("s", "n", "a", "bc", false)
      );
    });
  });

  it("registers a new account through shared-secret registration", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "nonce_abc" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { user_id: "@sovrgn_7:test", access_token: "tok_a" })
      );

    const creds = await registerOrLogin(7);
    expect(creds).toEqual({ userId: "@sovrgn_7:test", accessToken: "tok_a" });

    // First a nonce, then the registration signed with it.
    expect(String(fetchMock.mock.calls[0][0])).toContain("/_synapse/admin/v1/register");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.username).toBe("sovrgn_7");
    expect(body.admin).toBe(false);
    expect(body.mac).toBe(
      sharedSecretMac(SHARED_SECRET, "nonce_abc", "sovrgn_7", deriveMatrixPassword(7), false)
    );
  });

  it("never asks for an admin account", async () => {
    // Provisioned accounts are ordinary users; an admin one would hand every
    // SOVRGNnet member control of the homeserver.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n" }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@u:test", access_token: "t" }));

    await registerOrLogin(7);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).admin).toBe(false);
  });

  it("falls back to login when the account exists", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n" }))
      .mockResolvedValueOnce(
        jsonResponse(400, { errcode: "M_USER_IN_USE", error: "taken" })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { user_id: "@sovrgn_7:test", access_token: "tok_b" })
      );

    const creds = await registerOrLogin(7);
    expect(creds.accessToken).toBe("tok_b");
    expect(String(fetchMock.mock.calls[2][0])).toContain("/_matrix/client/v3/login");
  });

  it("surfaces other registration failures as MatrixError", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n" }))
      .mockResolvedValueOnce(
        jsonResponse(403, { errcode: "M_FORBIDDEN", error: "registration disabled" })
      );

    await expect(registerOrLogin(7)).rejects.toThrowError(MatrixError);
  });
});

describe("Rooms and messaging", () => {
  it("creates a space with m.space creation content", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { room_id: "!space:test" }));

    const roomId = await createSpace("tok", "My Server");
    expect(roomId).toBe("!space:test");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.creation_content).toEqual({ type: "m.space" });
  });

  it("creates a channel room and links it to the space", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { room_id: "!chan:test" }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const roomId = await createChannelRoom("tok", "!space:test", "general");
    expect(roomId).toBe("!chan:test");
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/state/m.space.child/"
    );
  });

  it("sends a message and returns the event id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { event_id: "$ev1" }));

    const eventId = await sendMessage("tok", "!chan:test", "hello world");
    expect(eventId).toBe("$ev1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/send/m.room.message/");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ msgtype: "m.text", body: "hello world" });
  });

  it("fetches, filters, and orders room messages oldest-first", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        chunk: [
          {
            type: "m.room.message",
            event_id: "$new",
            sender: "@a:test",
            origin_server_ts: 2000,
            content: { msgtype: "m.text", body: "second" },
          },
          {
            type: "m.room.member",
            event_id: "$member",
            sender: "@a:test",
            origin_server_ts: 1500,
            content: {},
          },
          {
            type: "m.room.message",
            event_id: "$old",
            sender: "@b:test",
            origin_server_ts: 1000,
            content: { msgtype: "m.text", body: "first" },
          },
        ],
      })
    );

    const msgs = await getRoomMessages("tok", "!chan:test");
    expect(msgs.map(m => m.body)).toEqual(["first", "second"]);
    expect(msgs[0].sender).toBe("@b:test");
  });
});
