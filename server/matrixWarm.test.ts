import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-warm-tests";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
});

import {
  __setFetchForTests as setMatrixFetch,
  warmToDevicePipeline,
} from "./matrixService";

/**
 * The boot-time warm ping exists because Dendrite drops the first to-device
 * message a cold pipeline receives near a room-creation burst — permanently,
 * with a 200 (docs/upstream/dendrite-to-device-loss.md). These tests pin the
 * exact requests the warm-up makes, because a warm-up that silently stopped
 * sending would re-open a hole the harness took sixteen runs to corner.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const matrixFetch = vi.fn();

beforeEach(() => {
  matrixFetch.mockReset();
  setMatrixFetch(matrixFetch as unknown as typeof fetch);
});

afterEach(() => {
  setMatrixFetch(fetch);
});

const calls = () =>
  matrixFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? "GET",
    body: (init as RequestInit | undefined)?.body
      ? JSON.parse(String((init as RequestInit).body))
      : undefined,
  }));

describe("warming the to-device pipeline at boot", () => {
  it("registers the probe account and pings its own device", async () => {
    matrixFetch
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          user_id: "@sovrgnnet-pipeline:test.local",
          access_token: "probe-token",
          device_id: "shared_secret_registration",
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(warmToDevicePipeline()).resolves.toBe(true);

    const seen = calls();
    expect(seen).toHaveLength(3);
    expect(seen[0].url).toContain("/_synapse/admin/v1/register");
    expect(seen[1].method).toBe("POST");
    expect(seen[1].body.username).toBe("sovrgnnet-pipeline");
    // The ping targets the probe's own user and its own device — nobody
    // else's sync stream ever sees it.
    expect(seen[2].method).toBe("PUT");
    expect(seen[2].url).toContain("/sendToDevice/m.sovrgnnet.warm/");
    expect(
      seen[2].body.messages["@sovrgnnet-pipeline:test.local"][
        "shared_secret_registration"
      ]
    ).toBeDefined();
  });

  it("logs in instead when the probe account already exists", async () => {
    matrixFetch
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n2" }))
      .mockResolvedValueOnce(
        jsonResponse(400, { errcode: "M_USER_IN_USE", error: "taken" })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          user_id: "@sovrgnnet-pipeline:test.local",
          access_token: "probe-token-2",
          device_id: "SOVRGN_PIPELINE",
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(warmToDevicePipeline()).resolves.toBe(true);

    const seen = calls();
    expect(seen[2].url).toContain("/_matrix/client/v3/login");
    // A fixed device id, so repeated boots replace one session instead of
    // accumulating a graveyard of probe devices.
    expect(seen[2].body.device_id).toBe("SOVRGN_PIPELINE");
    expect(seen[3].url).toContain("/sendToDevice/m.sovrgnnet.warm/");
  });

  it("reports failure without throwing when the homeserver is down", async () => {
    matrixFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    // Boot must survive this — the warm-up is fire-and-forget by contract.
    await expect(warmToDevicePipeline()).resolves.toBe(false);
  });
});
