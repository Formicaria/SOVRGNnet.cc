import { afterEach, describe, expect, it, vi } from "vitest";
import * as voice from "./voice";

/**
 * The presence half is pure and the proxy half is injectable, so both are
 * testable without a database or a Cloudflare account — which is the point:
 * these are the parts that are ours.
 */

afterEach(() => {
  voice.__resetPresenceForTests();
  voice.__setSfuFetchForTests((...args) => fetch(...args));
  delete process.env.CF_REALTIME_APP_ID;
  delete process.env.CF_REALTIME_APP_SECRET;
  vi.useRealTimers();
});

describe("voice configuration", () => {
  it("is off until both credentials exist — half-configured is unconfigured", () => {
    expect(voice.voiceConfigured()).toBe(false);
    process.env.CF_REALTIME_APP_ID = "app";
    expect(voice.voiceConfigured()).toBe(false);
    process.env.CF_REALTIME_APP_SECRET = "secret";
    expect(voice.voiceConfigured()).toBe(true);
  });

  it("refuses to call the SFU unconfigured, before any network is touched", async () => {
    const spy = vi.fn();
    voice.__setSfuFetchForTests(spy as never);
    await expect(voice.newSession("sdp")).rejects.toThrow(/not configured/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the SFU proxy", () => {
  it("carries the secret in the header and surfaces SFU errors as errors", async () => {
    process.env.CF_REALTIME_APP_ID = "app-1";
    process.env.CF_REALTIME_APP_SECRET = "sekrit";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    voice.__setSfuFetchForTests((async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ sessionId: "s1", sessionDescription: { type: "answer", sdp: "x" } }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }) as never);

    const result = await voice.newSession("offer-sdp");
    expect(result.sessionId).toBe("s1");
    expect(calls[0].url).toBe("https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/new");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sekrit");

    voice.__setSfuFetchForTests((async () =>
      new Response(JSON.stringify({ errorCode: "x", errorDescription: "bad offer" }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as never);
    await expect(voice.newSession("offer")).rejects.toThrow("bad offer");
  });
});

describe("presence", () => {
  it("one entry per user, tracks update in place, leave removes", () => {
    voice.joinPresence(1, { userId: 7, username: "z", sessionId: "a", tracks: [] });
    voice.joinPresence(1, { userId: 7, username: "z", sessionId: "b", tracks: [] });
    expect(voice.participants(1)).toHaveLength(1);
    expect(voice.participants(1)[0].sessionId).toBe("b");

    voice.announceTracks(1, 7, ["mic-1"]);
    expect(voice.participants(1)[0].tracks).toEqual(["mic-1"]);

    voice.leavePresence(1, 7);
    expect(voice.participants(1)).toHaveLength(0);
  });

  it("sweeps the silent: no heartbeat for 20s means gone", () => {
    vi.useFakeTimers();
    voice.joinPresence(2, { userId: 1, username: "a", sessionId: "s", tracks: [] });
    voice.joinPresence(2, { userId: 2, username: "b", sessionId: "t", tracks: [] });

    vi.advanceTimersByTime(15_000);
    voice.heartbeat(2, 2);
    vi.advanceTimersByTime(10_000);

    // User 1 last seen 25s ago; user 2 heartbeated 10s ago.
    const alive = voice.participants(2);
    expect(alive.map(p => p.userId)).toEqual([2]);
  });
});
