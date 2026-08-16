import { describe, expect, it, vi } from "vitest";

import {
  createSyncEngine,
  type CryptoSignals,
  type SyncEvent,
  type SyncState,
} from "@shared/matrixSyncCore";

/**
 * The engine is a loop, so tests drive it with a scripted fetch and wait for
 * the observable effects rather than poking internals.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function until<T>(probe: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = probe();
      if (value !== undefined) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const message = (roomId: string, eventId: string, body: string) => ({
  rooms: {
    join: {
      [roomId]: {
        timeline: {
          events: [
            {
              type: "m.room.message",
              event_id: eventId,
              sender: "@alice:test",
              origin_server_ts: 1000,
              content: { msgtype: "m.text", body },
            },
          ],
        },
      },
    },
  },
});

describe("Matrix sync engine", () => {
  it("ignores the initial batch, then emits later events", async () => {
    const events: SyncEvent[] = [];
    let calls = 0;
    let holdForever = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);

      if (calls === 1) {
        // Initial position: timeout=0, history present but must be ignored.
        expect(url).toContain("timeout=0");
        return jsonResponse(200, {
          next_batch: "s1",
          ...message("!room:test", "$history", "old news"),
        });
      }
      if (calls === 2) {
        expect(url).toContain("since=s1");
        return jsonResponse(200, {
          next_batch: "s2",
          ...message("!room:test", "$fresh", "hello"),
        });
      }
      // Park subsequent long-polls forever so the loop stays quiet.
      holdForever = true;
      return new Promise<Response>(() => {});
    });

    const engine = createSyncEngine({
      baseUrl: "https://matrix.test",
      accessToken: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: e => events.push(e),
    });

    await until(() => (events.length > 0 ? true : undefined));
    engine.stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      roomId: "!room:test",
      eventId: "$fresh",
      type: "m.room.message",
      sender: "@alice:test",
    });
    expect(holdForever).toBe(true);
  });

  it("stops permanently on 401 — a revoked device is not a retry", async () => {
    const states: SyncState[] = [];
    const fetchMock = vi.fn(async () => jsonResponse(401, { errcode: "M_UNKNOWN_TOKEN" }));

    const engine = createSyncEngine({
      baseUrl: "https://matrix.test",
      accessToken: "revoked",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: () => {},
      onStateChange: s => states.push(s),
    });

    await until(() => (states.includes("stopped") ? true : undefined));
    expect(engine.state).toBe("stopped");
    // One request, no retries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off through failures and recovers", async () => {
    const states: SyncState[] = [];
    const events: SyncEvent[] = [];
    let calls = 0;

    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(200, { next_batch: "s1" });
      if (calls === 2) return jsonResponse(502, { error: "bad gateway" });
      if (calls === 3) {
        return jsonResponse(200, {
          next_batch: "s2",
          ...message("!room:test", "$after-recovery", "back"),
        });
      }
      return new Promise<Response>(() => {});
    });

    const engine = createSyncEngine({
      baseUrl: "https://matrix.test",
      accessToken: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: e => events.push(e),
      onStateChange: s => states.push(s),
      maxBackoffMs: 10,
    });

    await until(() => (events.length > 0 ? true : undefined));
    engine.stop();

    expect(states).toContain("reconnecting");
    expect(states.filter(s => s === "live").length).toBeGreaterThanOrEqual(1);
    expect(events[0].eventId).toBe("$after-recovery");
  });

  it("delivers crypto signals from the initial batch — queued room keys must not be dropped", async () => {
    const signals: CryptoSignals[] = [];
    const events: SyncEvent[] = [];

    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        // The initial response: timeline history (ignored) alongside queued
        // to-device messages (must be delivered).
        return jsonResponse(200, {
          next_batch: "s1",
          ...message("!room:test", "$history", "old"),
          to_device: {
            events: [
              {
                type: "m.room_key",
                sender: "@alice:test",
                content: { algorithm: "m.megolm.v1.aes-sha2" },
              },
            ],
          },
          device_one_time_keys_count: { signed_curve25519: 12 },
        });
      }
      return new Promise<Response>(() => {});
    });

    const engine = createSyncEngine({
      baseUrl: "https://matrix.test",
      accessToken: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: e => events.push(e),
      onCryptoSignals: s => signals.push(s),
    });

    await until(() => (signals.length > 0 ? true : undefined));
    engine.stop();

    // Timeline history stayed suppressed; the crypto queue did not.
    expect(events).toHaveLength(0);
    expect(signals[0].toDevice).toHaveLength(1);
    expect(signals[0].toDevice[0].type).toBe("m.room_key");
    expect(signals[0].oneTimeKeyCounts).toEqual({ signed_curve25519: 12 });
  });

  it("surfaces device-list changes", async () => {
    const signals: CryptoSignals[] = [];
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse(200, { next_batch: "s1" });
      }
      if (fetchMock.mock.calls.length === 2) {
        return jsonResponse(200, {
          next_batch: "s2",
          device_lists: { changed: ["@bob:test"], left: ["@gone:test"] },
        });
      }
      return new Promise<Response>(() => {});
    });

    const engine = createSyncEngine({
      baseUrl: "https://matrix.test",
      accessToken: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: () => {},
      onCryptoSignals: s => signals.push(s),
    });

    await until(() => (signals.length > 0 ? true : undefined));
    engine.stop();

    expect(signals[0].deviceListsChanged).toEqual(["@bob:test"]);
    expect(signals[0].deviceListsLeft).toEqual(["@gone:test"]);
  });

  it("keeps the stream lean: filter excludes presence and ephemeral", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const filter = JSON.parse(url.searchParams.get("filter") ?? "{}");
      expect(filter.presence?.types).toEqual([]);
      expect(filter.room?.ephemeral?.types).toEqual([]);
      return jsonResponse(200, { next_batch: "s1" });
    });

    const engine = createSyncEngine({
      baseUrl: "https://matrix.test",
      accessToken: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onEvent: () => {},
    });

    await until(() => (fetchMock.mock.calls.length > 0 ? true : undefined));
    engine.stop();
  });
});
