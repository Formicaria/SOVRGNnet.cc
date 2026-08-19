import { afterEach, describe, expect, it } from "vitest";
import * as voice from "./voice";

/**
 * The whole surface is a decision put into a signed token, so the tests are
 * about the decision and the signature — no SFU, no network, nothing shared.
 */

afterEach(() => {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
});

function configure() {
  process.env.LIVEKIT_URL = "wss://voice.example.test";
  process.env.LIVEKIT_API_KEY = "APIkey123";
  process.env.LIVEKIT_API_SECRET = "not-a-real-secret-but-long-enough";
}

describe("voice configuration", () => {
  it("is off until all three values exist — partially configured is unconfigured", () => {
    expect(voice.voiceConfigured()).toBe(false);
    process.env.LIVEKIT_URL = "wss://voice.example.test";
    expect(voice.voiceConfigured()).toBe(false);
    process.env.LIVEKIT_API_KEY = "APIkey123";
    expect(voice.voiceConfigured()).toBe(false);
    process.env.LIVEKIT_API_SECRET = "s";
    expect(voice.voiceConfigured()).toBe(true);
  });

  it("refuses to mint unconfigured", async () => {
    await expect(
      voice.mintVoiceToken({ channelId: 1, identity: "user-1", displayName: "z" })
    ).rejects.toThrow(/not configured/);
  });
});

describe("the admission token", () => {
  it("carries exactly one room, the identity, and the operator's issuer", async () => {
    configure();
    const token = await voice.mintVoiceToken({
      channelId: 42,
      identity: "user-7",
      displayName: "zach",
    });
    const claims = await voice.__verifyVoiceTokenForTests(token);
    expect(claims.iss).toBe("APIkey123");
    expect(claims.sub).toBe("user-7");
    expect((claims as any).name).toBe("zach");
    const grant = (claims as any).video;
    expect(grant.room).toBe("voice-42");
    expect(grant.roomJoin).toBe(true);
    // A token for channel 42 says nothing about channel 43 — per-channel
    // isolation is the token's shape, not a runtime check anymore.
    expect(grant.room).not.toBe(voice.roomName(43));
  });

  it("expires: admission is minutes, not a standing credential", async () => {
    configure();
    const token = await voice.mintVoiceToken({
      channelId: 1,
      identity: "user-1",
      displayName: "z",
    });
    const claims = await voice.__verifyVoiceTokenForTests(token);
    const ttl = (claims.exp ?? 0) - (claims.iat ?? 0);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60);
  });

  it("does not verify under a different secret — per-instance isolation is the key itself", async () => {
    configure();
    const token = await voice.mintVoiceToken({
      channelId: 1,
      identity: "user-1",
      displayName: "z",
    });
    process.env.LIVEKIT_API_SECRET = "some-other-instance-entirely";
    await expect(voice.__verifyVoiceTokenForTests(token)).rejects.toThrow();
  });
});
