import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SHARED_SECRET } = vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-matrix-tests";
  const secret = process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
  process.env.MATRIX_SHARED_SECRET = secret;
  return { SHARED_SECRET: secret };
});

import {
  __setFetchForTests,
  clientDeviceId,
  deleteDevice,
  listDevices,
  login,
  MatrixError,
  registerOrLogin,
  SERVER_DEVICE_ID,
  SERVER_DEVICE_NAME,
  whoami,
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
  vi.restoreAllMocks();
});

/** The JSON body of the nth fetch call. */
function bodyOf(call = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

describe("login sends a device identity", () => {
  it("passes device_id and a display name when given them", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_1:x", access_token: "t", device_id: "D1" })
    );

    await login("sovrgn_1", "pw", { deviceId: "D1", displayName: "Zach's laptop" });

    const body = bodyOf();
    expect(body.device_id).toBe("D1");
    expect(body.initial_device_display_name).toBe("Zach's laptop");
  });

  it("omits them entirely rather than sending nulls", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_1:x", access_token: "t" })
    );

    await login("sovrgn_1", "pw");

    const body = bodyOf();
    expect("device_id" in body).toBe(false);
    expect("initial_device_display_name" in body).toBe(false);
  });

  it("returns the device the homeserver assigned", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_1:x", access_token: "t", device_id: "ASSIGNED" })
    );

    const credentials = await login("sovrgn_1", "pw");
    expect(credentials.deviceId).toBe("ASSIGNED");
  });

  it("falls back to the requested device when the homeserver reports none", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_1:x", access_token: "t" })
    );

    const credentials = await login("sovrgn_1", "pw", { deviceId: "D1" });
    expect(credentials.deviceId).toBe("D1");
  });

  it("is null when nobody named a device", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_1:x", access_token: "t" })
    );

    expect((await login("sovrgn_1", "pw")).deviceId).toBeNull();
  });
});

describe("the server's own session", () => {
  it("re-logs in under a fixed device id rather than creating a new one", async () => {
    // Registration says the account exists, so it falls through to login.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n" }))
      .mockResolvedValueOnce(jsonResponse(400, { errcode: "M_USER_IN_USE" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          user_id: "@sovrgn_7:x",
          access_token: "t",
          device_id: SERVER_DEVICE_ID,
        })
      );

    const credentials = await registerOrLogin(7);

    // Third call is the login.
    const body = bodyOf(2);
    expect(body.device_id).toBe(SERVER_DEVICE_ID);
    expect(body.initial_device_display_name).toBe(SERVER_DEVICE_NAME);
    expect(credentials.deviceId).toBe(SERVER_DEVICE_ID);
  });

  it("is recognisable in a device list rather than anonymous", () => {
    // Someone reading their sessions should be able to tell the server holds
    // one, because it does.
    expect(SERVER_DEVICE_NAME.length).toBeGreaterThan(0);
    expect(SERVER_DEVICE_ID).toMatch(/^[A-Z_]+$/);
  });
});

describe("clientDeviceId", () => {
  it("produces a distinct id each time", () => {
    const ids = new Set(Array.from({ length: 200 }, () => clientDeviceId()));
    expect(ids.size).toBe(200);
  });

  it("never collides with the server's device", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(clientDeviceId()).not.toBe(SERVER_DEVICE_ID);
    }
  });

  it("uses only characters safe in a Matrix device id", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(clientDeviceId()).toMatch(/^SOVRGN_[A-Z0-9]{16}$/);
    }
  });
});

describe("listDevices", () => {
  it("reads the user's own sessions with their token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { devices: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "D" }));

    await listDevices("user-token");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/_matrix/client/v3/devices");
    expect(init.headers.Authorization).toBe("Bearer user-token");
    // Deliberately the user's own view, not the admin API.
    expect(String(url)).not.toContain("/_synapse/admin");
  });

  it("recognises a homeserver-named device as the server's own", async () => {
    // The real failure. Shared-secret registration returns a token on a device
    // the homeserver names — Dendrite uses `shared_secret_registration` — so
    // comparing against SERVER_DEVICE_ID never matched for a fresh account.
    // Device id and display name below are verbatim from a live run.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          devices: [
            {
              device_id: "shared_secret_registration",
              display_name: "sovrgn_1",
              last_seen_ip: "172.18.0.5",
              last_seen_ts: 1786868632900,
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { user_id: "@sovrgn_1:x", device_id: "shared_secret_registration" })
      );

    const [device] = await listDevices("server-token");
    expect(device.isServer).toBe(true);
  });

  it("asks the homeserver which device the token is on", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { devices: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "D" }));

    await listDevices("t");

    const called = fetchMock.mock.calls.map(c => String(c[0]));
    expect(called.some(u => u.includes("/account/whoami"))).toBe(true);
  });

  it("still lists devices when whoami fails", async () => {
    // A homeserver that can't answer whoami can still enumerate devices, and
    // losing the whole listing over the flag would be the wrong trade.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { devices: [{ device_id: "SOVRGN_ABC", display_name: "Laptop" }] })
      )
      .mockResolvedValueOnce(jsonResponse(500, { errcode: "M_UNKNOWN" }));

    const devices = await listDevices("t");
    expect(devices).toHaveLength(1);
    expect(devices[0].isServer).toBe(false);
  });

  it("marks the server's session as such", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          devices: [
            { device_id: SERVER_DEVICE_ID, display_name: SERVER_DEVICE_NAME },
            { device_id: "SOVRGN_ABC", display_name: "Laptop" },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { user_id: "@a:x", device_id: SERVER_DEVICE_ID })
      );

    const devices = await listDevices("t");
    expect(devices.find(d => d.deviceId === SERVER_DEVICE_ID)?.isServer).toBe(true);
    expect(devices.find(d => d.deviceId === "SOVRGN_ABC")?.isServer).toBe(false);
  });

  it("normalises missing fields to null rather than undefined", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { devices: [{ device_id: "D" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "OTHER" }));

    const [device] = await listDevices("t");
    expect(device).toEqual({
      deviceId: "D",
      displayName: null,
      lastSeenIp: null,
      lastSeenAt: null,
      isServer: false,
    });
  });

  it("returns an empty list when the homeserver omits the field", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "D" }));
    expect(await listDevices("t")).toEqual([]);
  });

  it("surfaces last seen details when present", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          devices: [
            { device_id: "D", display_name: "Phone", last_seen_ip: "1.2.3.4", last_seen_ts: 1000 },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "OTHER" }));

    const [device] = await listDevices("t");
    expect(device.lastSeenIp).toBe("1.2.3.4");
    expect(device.lastSeenAt).toBe(1000);
  });
});

describe("deleteDevice", () => {
  const auth = { user: "sovrgn_1", password: "derived" };

  it("refuses to sign out the server's own session", async () => {
    // Removing it breaks every operation the server performs on the user's
    // behalf, and they'd experience it as the account silently failing.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@a:x", device_id: SERVER_DEVICE_ID })
    );
    await expect(deleteDevice("t", SERVER_DEVICE_ID, auth)).rejects.toThrow(MatrixError);
    // whoami only — no DELETE was issued.
    expect(fetchMock.mock.calls.every(c => c[1]?.method !== "DELETE")).toBe(true);
  });

  it("refuses a homeserver-named server device too", async () => {
    // The hole: shared-secret registration produces a device the constant
    // doesn't match, so this refusal never fired and the session was
    // removable — silently breaking the account it belonged to.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@a:x", device_id: "shared_secret_registration" })
    );
    await expect(
      deleteDevice("t", "shared_secret_registration", auth)
    ).rejects.toThrow(MatrixError);
    expect(fetchMock.mock.calls.every(c => c[1]?.method !== "DELETE")).toBe(true);
  });

  it("sends user-interactive auth, which the endpoint requires", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "OTHER" }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await deleteDevice("t", "SOVRGN_ABC", auth);

    const body = bodyOf(1) as { auth: Record<string, unknown> };
    expect(body.auth.type).toBe("m.login.password");
    expect(body.auth.password).toBe("derived");
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  });

  it("escapes the device id in the path", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "OTHER" }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await deleteDevice("t", "weird/../id", auth);

    // A device id is server-supplied, but path-injecting through it should not
    // be possible regardless.
    expect(String(fetchMock.mock.calls[1][0])).toContain("weird%2F..%2Fid");
  });

  it("propagates a homeserver refusal", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x", device_id: "OTHER" }))
      .mockResolvedValueOnce(jsonResponse(401, { errcode: "M_FORBIDDEN" }));
    await expect(deleteDevice("t", "SOVRGN_ABC", auth)).rejects.toThrow(MatrixError);
  });
});

describe("whoami", () => {
  it("reports the account and device a token belongs to", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user_id: "@sovrgn_1:x", device_id: "D1" })
    );

    expect(await whoami("t")).toEqual({ userId: "@sovrgn_1:x", deviceId: "D1" });
  });

  it("copes with a homeserver that omits the device", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user_id: "@sovrgn_1:x" }));
    expect((await whoami("t")).deviceId).toBeNull();
  });

  it("sends the token being checked", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user_id: "@a:x" }));
    await whoami("the-token");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer the-token");
  });
});
