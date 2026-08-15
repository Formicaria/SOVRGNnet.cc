import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-matrix-tests";

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

  it("registers a new account", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_7:test", access_token: "tok_a" })
    );

    const creds = await registerOrLogin(7);
    expect(creds).toEqual({ userId: "@sovrgn_7:test", accessToken: "tok_a" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/_matrix/client/v3/register");
    expect(JSON.parse(init.body).username).toBe("sovrgn_7");
  });

  it("falls back to login when the account exists", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(400, { errcode: "M_USER_IN_USE", error: "taken" })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { user_id: "@sovrgn_7:test", access_token: "tok_b" })
      );

    const creds = await registerOrLogin(7);
    expect(creds.accessToken).toBe("tok_b");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/_matrix/client/v3/login");
  });

  it("surfaces other registration failures as MatrixError", async () => {
    fetchMock.mockResolvedValueOnce(
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
