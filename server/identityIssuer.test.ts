import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Jwk } from "@shared/identity";
import {
  TokenError,
  generateKeypair,
  issueToken,
  jwkToPublicKey,
  publicKeyToJwk,
  verifyToken,
} from "@shared/identity";
import { checkIssuerJwks } from "@shared/identityIssuer";

/**
 * An independent instance can use id.sovrgnnet.cc.
 *
 * "Independent" is the load-bearing word. A server run by somebody else, on
 * hardware we have never seen, gets exactly one thing from the identity
 * provider: the JWKS at `/.well-known/jwks.json`. It fetches that, caches the
 * public keys, and verifies every token afterwards without contacting the
 * service again — which is what lets the provider be down without logging
 * anybody out, and what keeps ADR 0003's claim that it is optional honest.
 *
 * So the contract is one document, and this file tests against the real one,
 * captured from production rather than invented:
 *
 *     curl -s https://id.sovrgnnet.cc/.well-known/jwks.json
 *
 * No network here. A test that needs the internet fails on a train and gets
 * disabled; `scripts/check-identity.ts` is the live version, run deliberately.
 */

/** Fetched from https://id.sovrgnnet.cc/.well-known/jwks.json on 2026-08-17. */
const PRODUCTION_JWKS: { keys: Jwk[] } = {
  keys: [
    {
      kty: "OKP",
      crv: "Ed25519",
      x: "nQIItW4GrOUIfeLRkQIbmRVVJKFJRH0CMhLB9bWaNJo",
      kid: "nQIItW4GrOU",
      use: "sig",
      alg: "EdDSA",
    },
  ],
};

describe("the live sovrgnnet.cc issuer", () => {
  it("publishes a JWKS an independent instance can use", () => {
    const assessment = checkIssuerJwks(PRODUCTION_JWKS);
    expect(assessment.problems).toEqual([]);
    expect(assessment.usable).toBe(true);
    expect(assessment.kids).toEqual(["nQIItW4GrOU"]);
  });

  it("yields a key the verification path actually accepts", () => {
    // Not just "parses". This is the same function server/sso.ts feeds into
    // verifyToken, so if it returns something unusable, SSO fails at the last
    // step with a signature error pointing at the instance.
    const key = jwkToPublicKey(PRODUCTION_JWKS.keys[0]);
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("never publishes the private half", () => {
    // This endpoint is public by design. `d` appearing here would hand anyone
    // who fetched it the ability to mint a token for any account on every
    // server that trusts the issuer.
    expect(JSON.stringify(PRODUCTION_JWKS)).not.toMatch(/"d"\s*:/);
  });
});

describe("an independent instance, end to end", () => {
  it("verifies a token knowing only what the JWKS gave it", () => {
    // The whole relationship, simulated: the provider signs with a private key
    // an instance never sees, publishes the public half, and the instance
    // verifies from that alone. No shared secret, no callback, no runtime
    // dependency on the provider being reachable.
    const provider = generateKeypair();
    const published = { keys: [publicKeyToJwk(provider.publicKey)] };

    const assessment = checkIssuerJwks(published);
    expect(assessment.usable).toBe(true);

    const token = issueToken(provider, {
      subject: "acct_abc123",
      audience: "instance-under-test",
    });

    // The instance's side: it holds only the parsed public key.
    const keys = new Map(published.keys.map((jwk) => [jwk.kid, jwkToPublicKey(jwk)]));
    const verified = verifyToken(token, { keys, audience: "instance-under-test" });
    expect(verified.sub).toBe("acct_abc123");
  });

  it("throws TokenError, not something incidental", () => {
    // Guards the assertions below: they check `code`, which only exists on
    // TokenError. If verification ever threw a plain Error instead, those
    // would silently stop testing what they claim to.
    const keys = new Map<string, never>();
    expect(() => verifyToken("not.a.token", { keys, audience: "x" })).toThrow(TokenError);
  });

  it("refuses a token signed by a key the issuer never published", () => {
    // The property that makes the whole arrangement safe. Anyone can present a
    // well-formed token; only one signed by a published key is accepted.
    const provider = generateKeypair();
    const impostor = generateKeypair();

    const keys = new Map([
      [provider.kid, jwkToPublicKey(publicKeyToJwk(provider.publicKey))],
    ]);
    const forged = issueToken(impostor, {
      subject: "acct_victim",
      audience: "instance-under-test",
    });

    // Asserting the code, not merely that something threw. A bare toThrow()
    // passes on a TypeError from calling verifyToken wrong — which is exactly
    // what this test did on its first run, while looking green.
    expect(() => verifyToken(forged, { keys, audience: "instance-under-test" }))
      .toThrow(expect.objectContaining({ code: "unknown_key" }) as unknown as Error);
  });

  it("refuses a token minted for a different instance", () => {
    // Tokens are audience-bound. Without this, a token obtained for one server
    // would be replayable against every other server on the network.
    const provider = generateKeypair();
    const keys = new Map([
      [provider.kid, jwkToPublicKey(publicKeyToJwk(provider.publicKey))],
    ]);
    const token = issueToken(provider, {
      subject: "acct_abc123",
      audience: "some-other-instance",
    });

    expect(() => verifyToken(token, { keys, audience: "instance-under-test" }))
      .toThrow(expect.objectContaining({ code: "bad_audience" }) as unknown as Error);
  });

  it("still verifies during a rotation overlap", () => {
    // Both keys published, the old one still signing tokens in flight. This is
    // the state the issuer is in for an hour during every rotation, and the
    // one where getting it wrong breaks servers that did nothing.
    const outgoing = generateKeypair();
    const incoming = generateKeypair();
    const published = {
      keys: [publicKeyToJwk(incoming.publicKey), publicKeyToJwk(outgoing.publicKey)],
    };

    expect(checkIssuerJwks(published).kids).toHaveLength(2);

    const keys = new Map(published.keys.map((jwk) => [jwk.kid, jwkToPublicKey(jwk)]));
    const stillInFlight = issueToken(outgoing, {
      subject: "acct_abc123",
      audience: "instance-under-test",
    });
    expect(
      verifyToken(stillInFlight, { keys, audience: "instance-under-test" }).sub
    ).toBe("acct_abc123");
  });
});

describe("what a broken issuer looks like", () => {
  it("names the marketing-site case, because that is the one that happened", () => {
    // IDENTITY_ORIGIN pointed at the apex for a while. Fetching JWKS from a
    // static site returns 200 with HTML, and every SSO sign-in failed with a
    // signature error on the instance — pointing at the wrong machine.
    const assessment = checkIssuerJwks({ html: "<!doctype html>" });
    expect(assessment.usable).toBe(false);
    expect(assessment.problems[0].headline).toBe("Not a JWKS");
    expect(assessment.problems[0].detail).toMatch(/static site/);
  });

  it("rejects an empty key set", () => {
    const assessment = checkIssuerJwks({ keys: [] });
    expect(assessment.usable).toBe(false);
    expect(assessment.problems[0].headline).toBe("No keys published");
  });

  it("flags a leaked private scalar loudly", () => {
    const leaked = { ...publicKeyToJwk(generateKeypair().publicKey), d: "oops" };
    const assessment = checkIssuerJwks({ keys: [leaked] });
    expect(assessment.usable).toBe(false);
    expect(assessment.problems[0].headline).toMatch(/private scalar/);
    expect(assessment.problems[0].detail).toMatch(/Rotate it now/);
  });

  it("flags a duplicate kid", () => {
    const jwk = publicKeyToJwk(generateKeypair().publicKey);
    const assessment = checkIssuerJwks({ keys: [jwk, { ...jwk }] });
    expect(assessment.problems.some((p) => /Duplicate kid/.test(p.headline))).toBe(true);
  });

  it("says a non-Ed25519 key is published but unusable", () => {
    const assessment = checkIssuerJwks({
      keys: [{ kty: "RSA", kid: "rsa1", n: "…", e: "AQAB" }],
    });
    expect(assessment.usable).toBe(false);
    expect(assessment.problems[0].headline).toMatch(/not Ed25519/);
  });
});

describe("the live check exists and is reachable from the docs", () => {
  it("ships a script that fetches what this file only assumes", () => {
    // The fixture above is a snapshot. Snapshots go stale silently — the day
    // production stops matching it, this file keeps passing and says nothing.
    // scripts/check-identity.ts is the half that talks to the network, kept
    // out of the suite so the suite still runs offline.
    const script = readFileSync(join(__dirname, "..", "scripts/check-identity.ts"), "utf8");
    expect(script).toContain("checkIssuerJwks");
    expect(script).toContain("/.well-known/jwks.json");
    // Non-zero exit, or it cannot be used in a pipeline.
    expect(script).toMatch(/process\.exit\(1\)/);
  });

  it("defaults to the origin every instance defaults to", () => {
    // Checking a different issuer than the one instances actually use would
    // be a green check for the wrong service.
    const script = readFileSync(join(__dirname, "..", "scripts/check-identity.ts"), "utf8");
    expect(script).toContain("IDENTITY_ORIGIN");
  });
});
