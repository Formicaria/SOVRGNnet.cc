import { describe, expect, it, vi } from "vitest";
import {
  ROUTINE_REMINDER_MS,
  checkForUpdate,
  compareVersions,
  evaluateUpdate,
  isNewer,
  parseGithubRelease,
  shouldPrompt,
  type ReleaseInfo,
} from "@shared/updates";

const release = (over: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  version: "0.3.0",
  url: "https://github.com/Formicaria/SOVRGNnet.cc/releases/tag/v0.3.0",
  ...over,
});

describe("compareVersions", () => {
  it("orders by each component", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("doesn't compare version numbers as strings", () => {
    // The classic: "0.10.0" < "0.9.0" alphabetically, and that's wrong.
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
  });

  it("tolerates a leading v", () => {
    expect(compareVersions("v0.1.0", "0.2.0")).toBeLessThan(0);
  });

  it("ignores pre-release and build suffixes", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0+build7", "1.0.0")).toBe(0);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
  });

  it("gives up rather than guessing on nonsense", () => {
    expect(compareVersions("banana", "1.0.0")).toBe(0);
  });
});

describe("isNewer", () => {
  it("is true only for a genuinely later version", () => {
    expect(isNewer("0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });
});

describe("evaluateUpdate", () => {
  it("reports current when nothing newer exists", () => {
    expect(evaluateUpdate("0.3.0", release({ version: "0.3.0" }))).toEqual({
      status: "current",
    });
  });

  it("reports available with the release attached", () => {
    const check = evaluateUpdate("0.2.0", release());
    expect(check).toMatchObject({ status: "available", urgency: "routine" });
  });

  it("marks a security release as urgent", () => {
    const check = evaluateUpdate("0.2.0", release({ security: true }));
    expect(check).toMatchObject({ status: "available", urgency: "security" });
  });

  it("says unknown — never current — when the check failed", () => {
    // Claiming someone is up to date when we couldn't reach the server would
    // leave them sitting on an unpatched bundled homeserver believing
    // otherwise. That's the one wrong answer here.
    const check = evaluateUpdate("0.2.0", null, "network down");
    expect(check.status).toBe("unknown");
    expect(check).toHaveProperty("reason", "network down");
  });
});

describe("parseGithubRelease", () => {
  const raw = {
    tag_name: "v0.3.0",
    html_url: "https://github.com/x/y/releases/tag/v0.3.0",
    body: "Some notes",
    published_at: "2026-08-15T12:00:00Z",
    draft: false,
    prerelease: false,
  };

  it("reads a published release", () => {
    expect(parseGithubRelease(raw)).toMatchObject({
      version: "0.3.0",
      url: raw.html_url,
      notes: "Some notes",
      security: false,
    });
  });

  it("ignores drafts", () => {
    // The release train publishes a draft first and flips it public only once
    // every platform built — offering a draft points people at missing
    // installers.
    expect(parseGithubRelease({ ...raw, draft: true })).toBeNull();
  });

  it("ignores prereleases", () => {
    expect(parseGithubRelease({ ...raw, prerelease: true })).toBeNull();
  });

  it("flags a security release from the notes", () => {
    expect(
      parseGithubRelease({ ...raw, body: "This is a security fix for the homeserver." })
    ).toMatchObject({ security: true });
  });

  it("rejects a tag that isn't a linear version", () => {
    for (const tag of ["nightly", "v1.0", "release-3", ""]) {
      expect(parseGithubRelease({ ...raw, tag_name: tag })).toBeNull();
    }
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [null, undefined, {}, { tag_name: 5 }, "string"]) {
      expect(parseGithubRelease(bad)).toBeNull();
    }
  });
});

describe("checkForUpdate", () => {
  const ok = (body: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

  it("finds a newer release", async () => {
    const check = await checkForUpdate(
      "0.2.0",
      ok({ tag_name: "v0.3.0", html_url: "https://example.com", draft: false })
    );
    expect(check.status).toBe("available");
  });

  it("returns unknown on an HTTP error", async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect((await checkForUpdate("0.2.0", failing)).status).toBe("unknown");
  });

  it("returns unknown when offline, without throwing", async () => {
    const offline = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const check = await checkForUpdate("0.2.0", offline);
    expect(check.status).toBe("unknown");
    expect(check).toHaveProperty("reason", expect.stringContaining("ENOTFOUND"));
  });
});

describe("shouldPrompt", () => {
  const available = evaluateUpdate("0.2.0", release());
  const security = evaluateUpdate("0.2.0", release({ security: true }));
  const now = 1_000_000_000_000;

  it("never prompts when up to date", () => {
    expect(shouldPrompt({ status: "current" }, null, null, now)).toBe(false);
  });

  it("never prompts when the check failed", () => {
    // Nothing useful to say, and a scary dialog about an unknown state is
    // worse than silence.
    expect(shouldPrompt({ status: "unknown", reason: "x" }, null, null, now)).toBe(false);
  });

  it("prompts the first time it sees a version", () => {
    expect(shouldPrompt(available, null, null, now)).toBe(true);
  });

  it("stays quiet about a routine update already dismissed", () => {
    expect(shouldPrompt(available, "0.3.0", now - 1000, now)).toBe(false);
  });

  it("asks again about a routine update after a week", () => {
    expect(shouldPrompt(available, "0.3.0", now - ROUTINE_REMINDER_MS - 1, now)).toBe(true);
  });

  it("prompts for a newer version even if an older one was dismissed", () => {
    expect(shouldPrompt(available, "0.2.5", now - 1000, now)).toBe(true);
  });

  it("always prompts for a security release, however recently dismissed", () => {
    // Otherwise "security update" means the same as any other nag, and people
    // learn to dismiss both without reading.
    expect(shouldPrompt(security, "0.3.0", now - 1, now)).toBe(true);
  });
});
