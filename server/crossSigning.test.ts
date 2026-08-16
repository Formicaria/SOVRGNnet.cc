import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ENV is captured when matrixService is imported and ES imports hoist above
// ordinary statements, so this has to run first. Same pattern as matrix.test.ts.
vi.hoisted(() => {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "test-secret-for-crypto-tests";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
});

import {
  __setFetchForTests,
  completeUiaPasswordStage,
  enableRoomEncryption,
  MatrixError,
} from "./matrixService";

/**
 * The two server-side halves of ADR 0008 stage 4 — ADR 0011.
 *
 * Neither does any cryptography. `enableRoomEncryption` writes one state event
 * and `completeUiaPasswordStage` satisfies one authentication stage, and both
 * are places where getting the *protocol* subtly wrong produces something that
 * looks like it worked.
 */

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

describe("enableRoomEncryption", () => {
  it("writes m.room.encryption as room state, with Megolm v1", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { event_id: "$enc" }));

    const eventId = await enableRoomEncryption("token", "!room:example.org");

    expect(eventId).toBe("$enc");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/state/m.room.encryption/");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body).algorithm).toBe("m.megolm.v1.aes-sha2");
  });

  it("escapes the room id rather than pasting it into the path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { event_id: "$enc" }));
    await enableRoomEncryption("token", "!a/b:example.org");
    // A room id is opaque and can contain characters that change what path
    // the homeserver thinks it was asked for.
    expect(fetchMock.mock.calls[0][0]).toContain(
      encodeURIComponent("!a/b:example.org")
    );
  });

  it("surfaces a refusal instead of reporting the room encrypted", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {
        errcode: "M_FORBIDDEN",
        error: "You don't have permission",
      })
    );
    // The caller marks the channel encrypted on success. Swallowing this would
    // mark a plaintext room as encrypted in the index, which is the single
    // worst thing this file could do.
    await expect(
      enableRoomEncryption("token", "!room:example.org")
    ).rejects.toThrow(MatrixError);
  });
});

describe("completeUiaPasswordStage", () => {
  it("submits the password stage against the session the client was given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    await completeUiaPasswordStage(
      "sovrgn_7",
      "derived-password",
      "uia-session-abc"
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/_matrix/client/v3/keys/device_signing/upload");
    const body = JSON.parse(init.body);
    expect(body.auth).toMatchObject({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "sovrgn_7" },
      password: "derived-password",
      session: "uia-session-abc",
    });
  });

  it("carries no keys — the client keeps those", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await completeUiaPasswordStage("sovrgn_7", "derived-password", "s");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The entire point of the flow: the instance satisfies the auth stage and
    // never touches the cross-signing keys, which stay in the browser.
    expect(Object.keys(body)).toEqual(["auth"]);
    expect(body.master_key).toBeUndefined();
    expect(body.self_signing_key).toBeUndefined();
    expect(body.user_signing_key).toBeUndefined();
  });

  it("sends no access token — the password is the credential here", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await completeUiaPasswordStage("sovrgn_7", "derived-password", "s");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it.each([
    [200, "the homeserver accepted an empty upload"],
    [400, "the stage completed and the empty body was then rejected"],
    [404, "an endpoint shape we didn't expect, after the stage passed"],
  ])("treats %d as success — %s", async (status, _why) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(status, { errcode: "M_MISSING_PARAM" })
    );
    // A UIA stage is recorded against the session as soon as the credentials
    // check out, before the endpoint looks at the rest of the body. Failing
    // here would abandon a flow that has actually succeeded, and the client's
    // own re-submission would have gone through.
    await expect(
      completeUiaPasswordStage("sovrgn_7", "derived-password", "s")
    ).resolves.toBeUndefined();
  });

  it.each([401, 403])(
    "treats %d as failure — the password was not accepted",
    async status => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(status, {
          errcode: "M_FORBIDDEN",
          error: "Invalid password",
        })
      );
      await expect(
        completeUiaPasswordStage("sovrgn_7", "wrong-password", "s")
      ).rejects.toThrow(MatrixError);
    }
  );

  it("reports the homeserver's errcode on refusal", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { errcode: "M_FORBIDDEN" })
    );
    await expect(
      completeUiaPasswordStage("sovrgn_7", "wrong", "s")
    ).rejects.toMatchObject({ errcode: "M_FORBIDDEN", status: 401 });
  });

  it("survives a refusal with a non-JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>gateway said no</html>", { status: 403 })
    );
    // A reverse proxy in front of the homeserver returns HTML. Failing to
    // parse it must still fail the call, not throw a SyntaxError from inside
    // the error path.
    await expect(
      completeUiaPasswordStage("sovrgn_7", "p", "s")
    ).rejects.toThrow(MatrixError);
  });
});
