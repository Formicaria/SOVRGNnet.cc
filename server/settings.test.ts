/**
 * The precedence rule, pinned.
 *
 * `resolveSettings` is small and its rule is one sentence, which is exactly
 * the kind of code that gets "simplified" into truthiness later. The tests
 * that matter here are the two the obvious implementation gets wrong: a
 * stored empty string and a stored `false` are *values*, not absences, and
 * must not fall through to the environment. Both are how an operator turns
 * something off from the UI, and both look like "unset" to `||`.
 */

import { describe, expect, it } from "vitest";
import { resolveSettings, voiceConfigured } from "./settings";

/** An environment with nothing set — the default in most tests below. */
const NO_ENV = {};

describe("resolveSettings — precedence", () => {
  it("falls through to the environment when the row is absent entirely", () => {
    const resolved = resolveSettings(null, {
      MATRIX_ALLOW_FEDERATION: "true",
      MATRIX_PUBLIC_URL: "https://matrix.example.com",
      LIVEKIT_URL: "wss://voice.example.com",
      IPFS_API_URL: "http://ipfs.example:5001",
    });
    expect(resolved.federationEnabled).toBe(true);
    expect(resolved.matrixPublicUrl).toBe("https://matrix.example.com");
    expect(resolved.voiceUrl).toBe("wss://voice.example.com");
    expect(resolved.ipfsApiUrl).toBe("http://ipfs.example:5001");
  });

  it("falls through per-field: a row may answer some and not others", () => {
    const resolved = resolveSettings(
      { matrixPublicUrl: "https://stored.example.com" },
      { MATRIX_PUBLIC_URL: "https://env.example.com", LIVEKIT_URL: "wss://env.voice" }
    );
    expect(resolved.matrixPublicUrl).toBe("https://stored.example.com");
    // Untouched by the row, so still the environment's.
    expect(resolved.voiceUrl).toBe("wss://env.voice");
  });

  it("prefers a stored value over the environment", () => {
    const resolved = resolveSettings(
      { federationEnabled: true, ipfsApiUrl: "http://stored:5001" },
      { MATRIX_ALLOW_FEDERATION: "false", IPFS_API_URL: "http://env:5001" }
    );
    expect(resolved.federationEnabled).toBe(true);
    expect(resolved.ipfsApiUrl).toBe("http://stored:5001");
  });

  it("treats a stored false as an answer, not an absence", () => {
    // The regression this exists for: `stored ?? env` is right and
    // `stored || env` is wrong, and they differ only here. An operator who
    // switches federation off must not have the environment switch it back.
    const resolved = resolveSettings(
      { federationEnabled: false, ssoEnabled: false },
      { MATRIX_ALLOW_FEDERATION: "true", INSTANCE_ALLOW_SSO: "true" }
    );
    expect(resolved.federationEnabled).toBe(false);
    expect(resolved.ssoEnabled).toBe(false);
  });

  it("treats a stored empty string as an explicit clear", () => {
    // Same shape, one type over. Clearing the metrics token in the UI means
    // /metrics becomes unauthenticated — it must not silently keep requiring
    // the environment's old bearer.
    const resolved = resolveSettings(
      { metricsToken: "", voiceUrl: "", matrixPublicUrl: "" },
      {
        METRICS_TOKEN: "env-secret",
        LIVEKIT_URL: "wss://env.voice",
        MATRIX_PUBLIC_URL: "https://env.matrix",
      }
    );
    expect(resolved.metricsToken).toBeNull();
    expect(resolved.voiceUrl).toBeNull();
    expect(resolved.matrixPublicUrl).toBeNull();
  });

  it("trims stored and environment values alike", () => {
    expect(
      resolveSettings({ matrixPublicUrl: "  https://a.example  " }, NO_ENV).matrixPublicUrl
    ).toBe("https://a.example");
    expect(
      resolveSettings(null, { MATRIX_PUBLIC_URL: "  https://b.example  " }).matrixPublicUrl
    ).toBe("https://b.example");
  });

  it("treats whitespace-only as empty, from either source", () => {
    // A field the operator selected and deleted usually still holds a space.
    expect(resolveSettings({ metricsToken: "   " }, { METRICS_TOKEN: "x" }).metricsToken)
      .toBeNull();
    expect(resolveSettings(null, { MATRIX_PUBLIC_URL: "   " }).matrixPublicUrl).toBeNull();
  });

  it("reports null, never undefined, for an unset optional string", () => {
    // The API serialises these to clients; `undefined` disappears in JSON and
    // would make a field silently absent rather than explicitly empty.
    const resolved = resolveSettings(null, NO_ENV);
    expect(resolved.matrixPublicUrl).toBeNull();
    expect(resolved.voiceUrl).toBeNull();
    expect(resolved.voiceApiKey).toBeNull();
    expect(resolved.voiceApiSecret).toBeNull();
    expect(resolved.metricsToken).toBeNull();
    expect(resolved.identityIssuer).toBeNull();
  });
});

describe("resolveSettings — booleans from the environment", () => {
  it("only the exact string \"true\" enables a flag", () => {
    for (const value of ["false", "1", "yes", "TRUE", "", "  "]) {
      expect(
        resolveSettings(null, { MATRIX_ALLOW_FEDERATION: value }).federationEnabled
      ).toBe(false);
    }
    expect(
      resolveSettings(null, { MATRIX_ALLOW_FEDERATION: "true" }).federationEnabled
    ).toBe(true);
  });

  it("defaults both flags to off when nothing says otherwise", () => {
    const resolved = resolveSettings(null, NO_ENV);
    expect(resolved.federationEnabled).toBe(false);
    expect(resolved.ssoEnabled).toBe(false);
  });
});

describe("resolveSettings — ipfsApiUrl always has an address", () => {
  it("falls back to the documented default", () => {
    expect(resolveSettings(null, NO_ENV).ipfsApiUrl).toBe("http://localhost:5001");
  });

  it("uses the default rather than an empty address when cleared", () => {
    // The one field where empty can't mean "off": there is no such thing as
    // an instance with attachments and no IPFS address to try. Clearing it
    // returns to the default instead of producing a request to "".
    expect(resolveSettings({ ipfsApiUrl: "" }, { IPFS_API_URL: "http://env:5001" })
      .ipfsApiUrl).toBe("http://localhost:5001");
  });
});

describe("resolveSettings — readyTimeoutMs", () => {
  it("defaults to 3000", () => {
    expect(resolveSettings(null, NO_ENV).readyTimeoutMs).toBe(3000);
  });

  it("takes a stored number, then the environment", () => {
    expect(resolveSettings({ readyTimeoutMs: 500 }, { READY_TIMEOUT_MS: "9000" })
      .readyTimeoutMs).toBe(500);
    expect(resolveSettings(null, { READY_TIMEOUT_MS: "9000" }).readyTimeoutMs).toBe(9000);
  });

  it("refuses values that would break the probe", () => {
    // Zero or negative makes /ready answer before it asks; NaN compares false
    // against every bound, so the timeout would never fire and a hung
    // dependency would hang the probe with it.
    for (const bad of ["0", "-1", "banana", ""]) {
      expect(resolveSettings(null, { READY_TIMEOUT_MS: bad }).readyTimeoutMs).toBe(3000);
    }
    expect(resolveSettings({ readyTimeoutMs: 0 }, NO_ENV).readyTimeoutMs).toBe(3000);
    expect(resolveSettings({ readyTimeoutMs: -5 }, NO_ENV).readyTimeoutMs).toBe(3000);
  });
});

describe("voiceConfigured", () => {
  const full = {
    voiceUrl: "wss://voice.example",
    voiceApiKey: "key",
    voiceApiSecret: "secret",
  };

  it("is true only when all three values are present", () => {
    expect(voiceConfigured(resolveSettings(full, NO_ENV))).toBe(true);
  });

  it("is false when any one is missing", () => {
    for (const missing of ["voiceUrl", "voiceApiKey", "voiceApiSecret"] as const) {
      const partial = { ...full, [missing]: null };
      expect(voiceConfigured(resolveSettings(partial, NO_ENV))).toBe(false);
    }
  });

  it("is false when a value is cleared even though the environment has one", () => {
    const resolved = resolveSettings(
      { ...full, voiceApiSecret: "" },
      { LIVEKIT_API_SECRET: "env-secret" }
    );
    expect(voiceConfigured(resolved)).toBe(false);
  });

  it("can be satisfied by a mix of stored and environment values", () => {
    // Half-configured in `.env` and finished from the UI is a real path: the
    // Docker install sets the URL and the operator pastes the keys.
    const resolved = resolveSettings(
      { voiceApiKey: "key", voiceApiSecret: "secret" },
      { LIVEKIT_URL: "wss://env.voice" }
    );
    expect(voiceConfigured(resolved)).toBe(true);
    expect(resolved.voiceUrl).toBe("wss://env.voice");
  });
});
