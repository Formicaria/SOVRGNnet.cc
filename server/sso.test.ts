import { describe, expect, it, vi } from "vitest";
import { generateKeypair, issueToken, publicKeyToJwk } from "@shared/identity";
import { JwksCache, decideSsoLink, verifySsoToken, type SsoConfig } from "./sso";

const ISSUER = "https://sovrgnnet.cc";
const SERVER = "abc123def4567890";
const provider = generateKeypair();

const enabled: SsoConfig = { issuer: ISSUER, audience: SERVER, enabled: true };

function jwksBody(...pairs: Array<ReturnType<typeof generateKeypair>>) {
  return { keys: pairs.map(p => publicKeyToJwk(p.publicKey)) };
}

/** A fetch that answers with JWKS, or fails, on command. */
function stubFetch(behaviour: { body?: unknown; fail?: boolean; status?: number }) {
  return vi.fn(async () => {
    if (behaviour.fail) throw new Error("network unreachable");
    return {
      ok: (behaviour.status ?? 200) < 400,
      status: behaviour.status ?? 200,
      json: async () => behaviour.body,
    } as Response;
  }) as unknown as typeof fetch;
}

function token(pair = provider, audience = SERVER) {
  return issueToken(pair, { subject: "acct_1", audience });
}

describe("JwksCache", () => {
  it("fetches keys and verifies a token with them", async () => {
    const cache = new JwksCache(ISSUER, stubFetch({ body: jwksBody(provider) }));
    const claims = await verifySsoToken(token(), cache, enabled);
    expect(claims.sub).toBe("acct_1");
  });

  it("only fetches once while the cache is fresh", async () => {
    const fetchImpl = stubFetch({ body: jwksBody(provider) });
    const cache = new JwksCache(ISSUER, fetchImpl);

    await verifySsoToken(token(), cache, enabled);
    await verifySsoToken(token(), cache, enabled);
    await verifySsoToken(token(), cache, enabled);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchImpl = stubFetch({ body: jwksBody(provider) });
    const cache = new JwksCache(ISSUER, fetchImpl);

    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe("when the identity provider is unreachable", () => {
    it("keeps verifying with the keys it already had", async () => {
      // This is the property the whole design exists for: sovrgnnet.cc being
      // down must not stop a server in someone's house from working.
      const cache = new JwksCache(ISSUER, stubFetch({ body: jwksBody(provider) }));
      await cache.refresh();

      const offline = new JwksCache(ISSUER, stubFetch({ fail: true }));
      offline.__setForTests(await cache.getKeys(), 0); // primed, but stale

      const claims = await verifySsoToken(token(), offline, enabled);
      expect(claims.sub).toBe("acct_1");
    });

    it("refuses only when it has never had any keys", async () => {
      const cache = new JwksCache(ISSUER, stubFetch({ fail: true }));
      await expect(verifySsoToken(token(), cache, enabled)).rejects.toThrow(/unreachable/i);
    });

    it("treats an HTTP error the same as a network failure", async () => {
      const cache = new JwksCache(ISSUER, stubFetch({ body: {}, status: 503 }));
      await expect(cache.refresh()).rejects.toThrow(/503/);
    });
  });

  describe("bad responses", () => {
    it("rejects an empty key set", async () => {
      const cache = new JwksCache(ISSUER, stubFetch({ body: { keys: [] } }));
      await expect(cache.refresh()).rejects.toThrow(/no keys/i);
    });

    it("rejects a response that isn't JWKS at all", async () => {
      const cache = new JwksCache(ISSUER, stubFetch({ body: { hello: "world" } }));
      await expect(cache.refresh()).rejects.toThrow(/no keys/i);
    });

    it("keeps working keys when a bad refresh arrives", async () => {
      // A malformed response must not half-empty a cache that was fine.
      const cache = new JwksCache(ISSUER, stubFetch({ body: jwksBody(provider) }));
      await cache.refresh();
      expect(cache.size).toBe(1);

      const broken = new JwksCache(ISSUER, stubFetch({ body: { keys: [] } }));
      broken.__setForTests(await cache.getKeys());
      await expect(broken.refresh()).rejects.toThrow();
      expect(broken.size).toBe(1);
    });

    it("skips an individual key it can't understand", async () => {
      const body = {
        keys: [
          { kty: "RSA", kid: "old-rsa", use: "sig", alg: "RS256" },
          publicKeyToJwk(provider.publicKey),
        ],
      };
      const cache = new JwksCache(ISSUER, stubFetch({ body }));
      await cache.refresh();
      expect(cache.size).toBe(1);
    });
  });

  describe("key rotation", () => {
    it("refetches once when it meets an unfamiliar key id", async () => {
      const rotated = generateKeypair();
      let current = jwksBody(provider);

      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => current,
      })) as unknown as typeof fetch;

      const cache = new JwksCache(ISSUER, fetchImpl);
      await verifySsoToken(token(), cache, enabled);

      // The provider rotates, and a token signed with the new key arrives.
      current = jwksBody(provider, rotated);
      const claims = await verifySsoToken(token(rotated), cache, enabled);
      expect(claims.sub).toBe("acct_1");
    });

    it("gives up if the key is still unknown after refreshing", async () => {
      const impostor = generateKeypair();
      const cache = new JwksCache(ISSUER, stubFetch({ body: jwksBody(provider) }));

      await expect(verifySsoToken(token(impostor), cache, enabled)).rejects.toThrow(
        /unknown signing key/i
      );
    });
  });
});

describe("decideSsoLink", () => {
  const claims = { sub: "acct_1", email: "z@example.com" };

  it("signs in an account already bound to this identity", () => {
    expect(
      decideSsoLink({
        claims,
        existingBySubject: { id: 7 },
        existingByEmail: null,
      })
    ).toEqual({ action: "sign-in", userId: 7 });
  });

  it("creates an account when nothing matches", () => {
    expect(
      decideSsoLink({ claims, existingBySubject: null, existingByEmail: null })
    ).toEqual({ action: "create" });
  });

  describe("the takeover it has to prevent", () => {
    it("never links on a matching email, however the provider labels it", () => {
      // This is the whole change. It used to return { action: "link" } here
      // whenever the provider marked the address verified, which made every
      // local account claimable by whoever could get the provider to assert
      // that address — on every instance the person belongs to, at once.
      //
      // "Verified" means the provider believes it. That is worth exactly as
      // much as the provider, which ADR 0003 says is optional and therefore
      // must not be able to take over accounts.
      const decision = decideSsoLink({
        claims,
        existingBySubject: null,
        existingByEmail: { id: 3, ssoSubject: null },
      });

      expect(decision.action).toBe("refuse");
      expect(decision).toHaveProperty(
        "message",
        expect.stringMatching(/sign in with your password/i)
      );
    });

    it("never returns a link action at all", () => {
      // Exhaustive over the shapes an email match can take. If any of them can
      // produce a sign-in or a link, the takeover path is back.
      const byEmail = [
        { id: 3, ssoSubject: null },
        { id: 3, ssoSubject: "somebody_else" },
        { id: 3, ssoSubject: "acct_1" },
      ];
      for (const existingByEmail of byEmail) {
        const decision = decideSsoLink({
          claims,
          existingBySubject: null,
          existingByEmail,
        });
        expect(decision.action, JSON.stringify(existingByEmail)).toBe("refuse");
      }
    });

    it("refuses when the email belongs to a different identity", () => {
      const decision = decideSsoLink({
        claims,
        existingBySubject: null,
        existingByEmail: { id: 3, ssoSubject: "somebody_else" },
      });

      expect(decision.action).toBe("refuse");
      expect(decision).toHaveProperty("message", expect.stringMatching(/different/i));
    });

    it("says how to link deliberately rather than just refusing", () => {
      // A refusal with no route forward is a dead end. Linking still exists —
      // it moved to auth.linkSso, where the person proves they hold the local
      // account first and the bind is an authenticated act rather than an
      // inference drawn from a string.
      const decision = decideSsoLink({
        claims,
        existingBySubject: null,
        existingByEmail: { id: 3, ssoSubject: null },
      });
      expect(decision).toHaveProperty(
        "message",
        expect.stringMatching(/link your sovrgnnet\.cc account/i)
      );
    });
  });

  it("prefers the subject match over the email match", () => {
    // The subject is the identity; email is only ever a hint for first link.
    expect(
      decideSsoLink({
        claims,
        existingBySubject: { id: 7 },
        existingByEmail: { id: 3, ssoSubject: null },
      })
    ).toEqual({ action: "sign-in", userId: 7 });
  });

  it("creates an account when the token carries no email at all", () => {
    expect(
      decideSsoLink({
        claims: { sub: "acct_2" },
        existingBySubject: null,
        existingByEmail: null,
      })
    ).toEqual({ action: "create" });
  });
});

describe("verifySsoToken", () => {
  it("refuses everything when the operator has disabled SSO", async () => {
    // The escape hatch: a server that wants nothing to do with central
    // identity stays fully functional and simply declines.
    const cache = new JwksCache(ISSUER, stubFetch({ body: jwksBody(provider) }));
    await expect(
      verifySsoToken(token(), cache, { ...enabled, enabled: false })
    ).rejects.toThrow(/doesn't accept/i);
  });

  it("refuses a token minted for a different server", async () => {
    const cache = new JwksCache(ISSUER, stubFetch({ body: jwksBody(provider) }));
    await expect(
      verifySsoToken(token(provider, "9999888877776666"), cache, enabled)
    ).rejects.toThrow(/different server/i);
  });

  it("does not hit the network when SSO is off", async () => {
    const fetchImpl = stubFetch({ body: jwksBody(provider) });
    const cache = new JwksCache(ISSUER, fetchImpl);
    await expect(
      verifySsoToken(token(), cache, { ...enabled, enabled: false })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
