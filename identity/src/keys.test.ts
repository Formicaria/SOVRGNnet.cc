import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetKeysForTests, jwks, loadKeys } from "./keys";

/**
 * The signing keys.
 *
 * This is the highest-consequence code in the project and had no tests of its
 * own. A leaked key lets anyone mint a token for any account on every server
 * that trusts this issuer; a mishandled rotation invalidates every token in
 * flight on servers that did nothing wrong.
 *
 * These run without a database. Everything here is key material and process
 * environment, which is exactly the part that has to be right before the
 * service is allowed to start at all.
 */

function pem(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  __resetKeysForTests();
  delete process.env.IDENTITY_SIGNING_KEY;
  delete process.env.IDENTITY_PREVIOUS_KEYS;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetKeysForTests();
});

describe("loading the active key", () => {
  it("refuses to start without one", () => {
    // Not "generate an ephemeral key and carry on". Every token signed with a
    // key that dies with the process is invalid after the next restart, and
    // the failure surfaces on somebody else's server as an unexplained
    // signature error rather than here as a missing setting.
    expect(() => loadKeys()).toThrow(/IDENTITY_SIGNING_KEY is not set/);
  });

  it("names the variable when the key is unusable", () => {
    process.env.IDENTITY_SIGNING_KEY = "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----";
    expect(() => loadKeys()).toThrow(/IDENTITY_SIGNING_KEY is not a usable Ed25519 private key/);
  });

  it("accepts a PEM folded onto one line with literal \\n", () => {
    // The single most likely way this is misconfigured, and it comes from a
    // real constraint rather than carelessness: systemd's EnvironmentFile
    // cannot hold a multi-line value, so the documented install folds the PEM
    // with awk. If this stopped working, every systemd-managed deployment
    // would fail at startup with a PEM parse error pointing nowhere useful.
    process.env.IDENTITY_SIGNING_KEY = pem().replace(/\n/g, "\\n");
    expect(() => loadKeys()).not.toThrow();
    expect(jwks().keys).toHaveLength(1);
  });

  it("tolerates surrounding whitespace", () => {
    process.env.IDENTITY_SIGNING_KEY = `\n  ${pem()}  \n`;
    expect(() => loadKeys()).not.toThrow();
  });
});

describe("rotation", () => {
  it("publishes retired keys alongside the active one", () => {
    // The overlap is the whole point. Tokens live five minutes and servers
    // cache JWKS for longer, so a key withdrawn the instant it stops signing
    // takes working tokens down with it.
    const [current, old] = [pem(), pem()];
    process.env.IDENTITY_SIGNING_KEY = current;
    process.env.IDENTITY_PREVIOUS_KEYS = old;

    expect(jwks().keys).toHaveLength(2);
  });

  it("signs with the active key, not a retired one", () => {
    const [current, old] = [pem(), pem()];
    process.env.IDENTITY_SIGNING_KEY = current;
    process.env.IDENTITY_PREVIOUS_KEYS = old;

    const { active, all } = loadKeys();
    expect(all[0]).toBe(active);
  });

  it("takes several retired keys, and ignores the gaps between them", () => {
    // Editing a comma-separated list by hand leaves trailing commas and
    // stray spaces. Failing on those would turn a cosmetic slip into a
    // service that will not boot, during a rotation, which is the worst
    // moment to be down.
    const [current, a, b] = [pem(), pem(), pem()];
    process.env.IDENTITY_SIGNING_KEY = current;
    process.env.IDENTITY_PREVIOUS_KEYS = ` ${a} , ${b} ,, `;

    expect(jwks().keys).toHaveLength(3);
  });

  it("names which retired key is malformed", () => {
    process.env.IDENTITY_SIGNING_KEY = pem();
    process.env.IDENTITY_PREVIOUS_KEYS = `${pem()},garbage`;
    expect(() => loadKeys()).toThrow(/IDENTITY_PREVIOUS_KEYS\[1\]/);
  });
});

describe("the published JWKS", () => {
  it("never contains a duplicate kid", () => {
    // The obvious rotation mistake: put the new key in IDENTITY_SIGNING_KEY
    // and forget to take it out of IDENTITY_PREVIOUS_KEYS. A JWKS with two
    // entries sharing a kid is ambiguous, and verifiers disagree about which
    // one wins.
    const key = pem();
    process.env.IDENTITY_SIGNING_KEY = key;
    process.env.IDENTITY_PREVIOUS_KEYS = key;

    const kids = jwks().keys.map((k) => k.kid);
    expect(kids).toHaveLength(1);
    expect(new Set(kids).size).toBe(kids.length);
  });

  it("publishes public halves only", () => {
    process.env.IDENTITY_SIGNING_KEY = pem();
    const serialized = JSON.stringify(jwks());

    // `d` is the private scalar in an OKP JWK. Publishing it would hand the
    // whole network's identity to anyone who fetched the endpoint, and this
    // document is served to the public by design.
    for (const key of jwks().keys) {
      expect(key).not.toHaveProperty("d");
    }
    expect(serialized).not.toMatch(/PRIVATE KEY/);
    expect(serialized).not.toMatch(/"d"\s*:/);
  });

  it("describes the keys as Ed25519 signing keys", () => {
    process.env.IDENTITY_SIGNING_KEY = pem();
    const [key] = jwks().keys;
    expect(key.kty).toBe("OKP");
    expect(key.crv).toBe("Ed25519");
    expect(key.use).toBe("sig");
    expect(key.alg).toBe("EdDSA");
  });
});
