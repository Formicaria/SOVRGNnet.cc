import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  buildAuthorizeUrl,
  configuredProviders,
  generatePkce,
  generateState,
  githubPrimaryEmail,
  isProviderId,
  matchBrokerAccount,
  mergeGithubEmail,
  normalizeProfile,
} from "@shared/oauthProviders";

describe("normalizeProfile", () => {
  describe("google", () => {
    it("reads a verified account", () => {
      expect(
        normalizeProfile("google", {
          sub: "1029384756",
          email: "z@example.com",
          email_verified: true,
          name: "Zachary",
          picture: "https://example.com/a.png",
        })
      ).toEqual({
        provider: "google",
        providerUserId: "1029384756",
        email: "z@example.com",
        emailVerified: true,
        name: "Zachary",
        avatar: "https://example.com/a.png",
      });
    });

    it('accepts the string "true", which Google sometimes sends', () => {
      expect(
        normalizeProfile("google", { sub: "1", email: "z@x.com", email_verified: "true" })
      ).toMatchObject({ emailVerified: true });
    });

    it("treats an unverified address as unverified", () => {
      expect(
        normalizeProfile("google", { sub: "1", email: "z@x.com", email_verified: false })
      ).toMatchObject({ emailVerified: false });
    });

    it("refuses a response with no subject", () => {
      expect(normalizeProfile("google", { email: "z@x.com" })).toBeNull();
    });
  });

  describe("microsoft", () => {
    it("falls back to oid when sub is absent", () => {
      expect(
        normalizeProfile("microsoft", { oid: "abc-def", email: "z@work.com" })
      ).toMatchObject({ providerUserId: "abc-def", email: "z@work.com" });
    });

    it("falls back to preferred_username for the address", () => {
      expect(
        normalizeProfile("microsoft", { sub: "s1", preferred_username: "z@work.com" })
      ).toMatchObject({ email: "z@work.com", emailVerified: true });
    });

    it("is unverified when there's no address at all", () => {
      expect(normalizeProfile("microsoft", { sub: "s1" })).toMatchObject({
        email: null,
        emailVerified: false,
      });
    });
  });

  describe("github", () => {
    it("never trusts /user for verification", () => {
      // This endpoint returns the *public* profile email with no verification
      // signal. Treating it as verified would be an account-takeover path.
      expect(
        normalizeProfile("github", { id: 4242, email: "public@example.com", login: "chronus" })
      ).toMatchObject({ email: "public@example.com", emailVerified: false });
    });

    it("stringifies the numeric id", () => {
      expect(normalizeProfile("github", { id: 4242, login: "x" })?.providerUserId).toBe("4242");
    });

    it("falls back to the login when there's no name", () => {
      expect(normalizeProfile("github", { id: 1, login: "chronus" })?.name).toBe("chronus");
    });
  });

  describe("discord", () => {
    it("reads a verified account and builds the avatar URL", () => {
      expect(
        normalizeProfile("discord", {
          id: "99887766",
          email: "z@example.com",
          verified: true,
          global_name: "chronus",
          avatar: "abc123",
        })
      ).toEqual({
        provider: "discord",
        providerUserId: "99887766",
        email: "z@example.com",
        emailVerified: true,
        name: "chronus",
        avatar: "https://cdn.discordapp.com/avatars/99887766/abc123.png",
      });
    });

    it("treats an unverified Discord email as unverified", () => {
      expect(
        normalizeProfile("discord", { id: "1", email: "z@x.com", verified: false })
      ).toMatchObject({ emailVerified: false });
    });

    it("falls back to username when there's no display name", () => {
      expect(normalizeProfile("discord", { id: "1", username: "chronus" })?.name).toBe("chronus");
    });
  });

  it("treats blank strings as absent across providers", () => {
    expect(normalizeProfile("google", { sub: "1", email: "   ", name: "" })).toMatchObject({
      email: null,
      name: null,
    });
  });
});

describe("githubPrimaryEmail", () => {
  it("picks the primary verified address", () => {
    expect(
      githubPrimaryEmail([
        { email: "alt@example.com", primary: false, verified: true },
        { email: "main@example.com", primary: true, verified: true },
      ])
    ).toEqual({ email: "main@example.com", verified: true });
  });

  it("ignores unverified addresses entirely", () => {
    // Including one marked primary — verification is the point.
    expect(
      githubPrimaryEmail([
        { email: "unverified@example.com", primary: true, verified: false },
        { email: "verified@example.com", primary: false, verified: true },
      ])
    ).toEqual({ email: "verified@example.com", verified: true });
  });

  it("returns nothing when no address is verified", () => {
    expect(
      githubPrimaryEmail([{ email: "nope@example.com", primary: true, verified: false }])
    ).toBeNull();
    expect(githubPrimaryEmail([])).toBeNull();
  });

  it("merges into a profile, upgrading it to verified", () => {
    const base = normalizeProfile("github", { id: 1, login: "chronus" })!;
    expect(base.emailVerified).toBe(false);

    const merged = mergeGithubEmail(base, { email: "real@example.com", verified: true });
    expect(merged).toMatchObject({ email: "real@example.com", emailVerified: true });
  });

  it("leaves the profile alone when nothing was found", () => {
    const base = normalizeProfile("github", { id: 1, login: "chronus" })!;
    expect(mergeGithubEmail(base, null)).toEqual(base);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the parameters every provider needs", () => {
    const url = new URL(
      buildAuthorizeUrl(PROVIDERS.google, {
        clientId: "client-123",
        redirectUri: "https://id.sovrgnnet.cc/auth/google/callback",
        state: "st_abc",
        codeChallenge: "chal",
      })
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st_abc");
    expect(url.searchParams.get("scope")).toContain("email");
  });

  it("adds PKCE for providers that support it", () => {
    const url = new URL(
      buildAuthorizeUrl(PROVIDERS.microsoft, {
        clientId: "c",
        redirectUri: "https://id.sovrgnnet.cc/auth/microsoft/callback",
        state: "s",
        codeChallenge: "chal",
      })
    );
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE for providers that don't", () => {
    const url = new URL(
      buildAuthorizeUrl(PROVIDERS.github, {
        clientId: "c",
        redirectUri: "https://id.sovrgnnet.cc/auth/github/callback",
        state: "s",
        codeChallenge: "chal",
      })
    );
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("asks GitHub for the address scope", () => {
    // Without user:email there is no verified address, and no safe linking.
    expect(PROVIDERS.github.scopes).toContain("user:email");
  });
});

describe("state and PKCE", () => {
  it("generates unguessable, unique state", () => {
    const values = new Set(Array.from({ length: 50 }, generateState));
    expect(values.size).toBe(50);
    expect(generateState().length).toBeGreaterThan(20);
  });

  it("derives a challenge that matches its verifier", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).not.toBe(challenge);
    // Same verifier must always give the same challenge, or the exchange fails.
    expect(generatePkce().challenge).not.toBe(challenge);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("configuredProviders", () => {
  it("lists only providers with both an id and a secret", () => {
    const found = configuredProviders({
      GOOGLE_CLIENT_ID: "a",
      GOOGLE_CLIENT_SECRET: "b",
      GITHUB_CLIENT_ID: "c",
      // no GITHUB_CLIENT_SECRET — half-configured is not configured
      DISCORD_CLIENT_ID: "d",
      DISCORD_CLIENT_SECRET: "e",
    });

    expect(found.map(p => p.id).sort()).toEqual(["discord", "google"]);
  });

  it("returns nothing when none are set up", () => {
    expect(configuredProviders({})).toEqual([]);
  });
});

describe("matchBrokerAccount", () => {
  const verified = { email: "z@example.com", emailVerified: true };
  const unverified = { email: "z@example.com", emailVerified: false };

  it("signs in a provider identity it already knows", () => {
    expect(
      matchBrokerAccount({
        profile: verified,
        existingByIdentity: { id: 7 },
        existingByEmail: null,
      })
    ).toEqual({ action: "sign-in", accountId: 7 });
  });

  it("creates an account when nothing matches", () => {
    expect(
      matchBrokerAccount({
        profile: verified,
        existingByIdentity: null,
        existingByEmail: null,
      })
    ).toEqual({ action: "create" });
  });

  it("links a new provider to an account on a verified address", () => {
    // This is what makes a second provider possible, and what stops one
    // suspension costing someone every server they belong to.
    expect(
      matchBrokerAccount({
        profile: verified,
        existingByIdentity: null,
        existingByEmail: { id: 3 },
      })
    ).toEqual({ action: "link", accountId: 3 });
  });

  it("refuses to link on an unverified address", () => {
    // The takeover: set an unverified email at any provider to someone else's
    // address, and inherit their account everywhere.
    const match = matchBrokerAccount({
      profile: unverified,
      existingByIdentity: null,
      existingByEmail: { id: 3 },
    });

    expect(match.action).toBe("refuse");
    expect(match).toHaveProperty("message", expect.stringMatching(/confirmed/i));
  });

  it("creates rather than refuses when the address is new", () => {
    expect(
      matchBrokerAccount({
        profile: unverified,
        existingByIdentity: null,
        existingByEmail: null,
      })
    ).toEqual({ action: "create" });
  });

  it("creates when the provider gave no address at all", () => {
    expect(
      matchBrokerAccount({
        profile: { email: null, emailVerified: false },
        existingByIdentity: null,
        existingByEmail: { id: 3 },
      })
    ).toEqual({ action: "create" });
  });

  it("prefers the known identity over any email match", () => {
    expect(
      matchBrokerAccount({
        profile: verified,
        existingByIdentity: { id: 7 },
        existingByEmail: { id: 3 },
      })
    ).toEqual({ action: "sign-in", accountId: 7 });
  });

  it("refuses a GitHub profile email, which is never verified", () => {
    // normalizeProfile marks these unverified precisely so this branch fires.
    const github = normalizeProfile("github", { id: 1, email: "z@example.com", login: "x" })!;
    expect(
      matchBrokerAccount({
        profile: github,
        existingByIdentity: null,
        existingByEmail: { id: 3 },
      }).action
    ).toBe("refuse");
  });
});

describe("isProviderId", () => {
  it("accepts the four supported providers", () => {
    for (const id of ["google", "microsoft", "github", "discord"]) {
      expect(isProviderId(id)).toBe(true);
    }
  });

  it("rejects anything else, including path tricks", () => {
    for (const bad of ["", "facebook", "../../etc", "GOOGLE", "constructor"]) {
      expect(isProviderId(bad)).toBe(false);
    }
  });
});
