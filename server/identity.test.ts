import { describe, expect, it } from "vitest";
import {
  TOKEN_ISSUER,
  TokenError,
  consumeRecoveryCode,
  generateKeypair,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueToken,
  jwkToPublicKey,
  keyId,
  normalizeRecoveryCode,
  publicKeyToJwk,
  recoveryCodeMatches,
  verifyToken,
} from "@shared/identity";

const provider = generateKeypair();
const SERVER = "abc123def4567890";

/** The keys a server holds after fetching the provider's JWKS. */
function keysOf(...pairs: Array<ReturnType<typeof generateKeypair>>) {
  return new Map(pairs.map(p => [p.kid, p.publicKey]));
}

function token(overrides: Parameters<typeof issueToken>[1] = { subject: "u1", audience: SERVER }) {
  return issueToken(provider, { subject: "u1", audience: SERVER, ...overrides });
}

describe("keys", () => {
  it("derives the same key id from the same key every time", () => {
    expect(keyId(provider.publicKey)).toBe(keyId(provider.publicKey));
  });

  it("gives different keys different ids", () => {
    expect(generateKeypair().kid).not.toBe(generateKeypair().kid);
  });

  it("round-trips a public key through JWKS", () => {
    const jwk = publicKeyToJwk(provider.publicKey);
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });

    // This is the actual path: a server fetches JWKS and rebuilds the key.
    const restored = jwkToPublicKey(jwk);
    const claims = verifyToken(token(), {
      keys: new Map([[jwk.kid, restored]]),
      audience: SERVER,
    });
    expect(claims.sub).toBe("u1");
  });
});

describe("issuing and verifying", () => {
  it("verifies a token the provider just signed", () => {
    const claims = verifyToken(token(), { keys: keysOf(provider), audience: SERVER });
    expect(claims.sub).toBe("u1");
    expect(claims.iss).toBe(TOKEN_ISSUER);
    expect(claims.aud).toBe(SERVER);
  });

  it("carries optional profile hints", () => {
    const raw = token({
      subject: "u1",
      audience: SERVER,
      name: "chronus",
      email: "z@example.com",
      emailVerified: true,
    });
    const claims = verifyToken(raw, { keys: keysOf(provider), audience: SERVER });
    expect(claims).toMatchObject({
      name: "chronus",
      email: "z@example.com",
      email_verified: true,
    });
  });

  it("gives every token a unique id", () => {
    const a = verifyToken(token(), { keys: keysOf(provider), audience: SERVER });
    const b = verifyToken(token(), { keys: keysOf(provider), audience: SERVER });
    expect(a.jti).not.toBe(b.jti);
  });
});

describe("what verification must refuse", () => {
  it("a token minted for a different server", () => {
    // The attack this prevents: whoever runs server A replaying their users'
    // tokens against server B to impersonate them there.
    const forServerA = issueToken(provider, { subject: "u1", audience: "aaaa111122223333" });
    expect(() =>
      verifyToken(forServerA, { keys: keysOf(provider), audience: SERVER })
    ).toThrow(/different server/i);
  });

  it("a signature from a key it doesn't know", () => {
    const impostor = generateKeypair();
    const forged = issueToken(impostor, { subject: "u1", audience: SERVER });
    expect(() =>
      verifyToken(forged, { keys: keysOf(provider), audience: SERVER })
    ).toThrow(/unknown signing key/i);
  });

  it("a token whose payload was edited after signing", () => {
    const [header, payload, signature] = token().split(".");
    const tampered = JSON.parse(Buffer.from(payload, "base64url").toString());
    tampered.sub = "somebody-else";
    const swapped = Buffer.from(JSON.stringify(tampered))
      .toString("base64url")
      .replace(/=+$/, "");

    expect(() =>
      verifyToken(`${header}.${swapped}.${signature}`, {
        keys: keysOf(provider),
        audience: SERVER,
      })
    ).toThrow(/signature/i);
  });

  it('a token claiming "alg": "none"', () => {
    // The classic JWT vulnerability: believing the token about its own
    // algorithm. Refused before any key is even looked up.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: provider.kid }))
      .toString("base64url")
      .replace(/=+$/, "");
    const payload = Buffer.from(
      JSON.stringify({
        iss: TOKEN_ISSUER,
        sub: "attacker",
        aud: SERVER,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: "x",
      })
    )
      .toString("base64url")
      .replace(/=+$/, "");

    expect(() =>
      verifyToken(`${header}.${payload}.`, { keys: keysOf(provider), audience: SERVER })
    ).toThrow(/algorithm/i);
  });

  it("an expired token", () => {
    const old = issueToken(provider, {
      subject: "u1",
      audience: SERVER,
      now: Math.floor(Date.now() / 1000) - 10_000,
    });
    expect(() => verifyToken(old, { keys: keysOf(provider), audience: SERVER })).toThrow(
      /expired/i
    );
  });

  it("a token issued in the future beyond clock tolerance", () => {
    const future = issueToken(provider, {
      subject: "u1",
      audience: SERVER,
      now: Math.floor(Date.now() / 1000) + 10_000,
    });
    expect(() => verifyToken(future, { keys: keysOf(provider), audience: SERVER })).toThrow(
      /not valid yet/i
    );
  });

  it("but tolerates small clock drift between machines", () => {
    // A self-hosted server on a laptop will not have perfect time.
    const slightlyAhead = issueToken(provider, {
      subject: "u1",
      audience: SERVER,
      now: Math.floor(Date.now() / 1000) + 30,
    });
    expect(() =>
      verifyToken(slightlyAhead, { keys: keysOf(provider), audience: SERVER })
    ).not.toThrow();
  });

  it("structurally broken input, without crashing", () => {
    for (const bad of ["", "nonsense", "a.b", "a.b.c.d", "....", "%%%.%%%.%%%"]) {
      expect(() => verifyToken(bad, { keys: keysOf(provider), audience: SERVER })).toThrow(
        TokenError
      );
    }
  });
});

describe("key rotation", () => {
  it("accepts tokens from an old key while it's still published", () => {
    // Rotation has to overlap, or every token in flight breaks at once.
    const oldKey = generateKeypair();
    const signedWithOld = issueToken(oldKey, { subject: "u1", audience: SERVER });

    expect(
      verifyToken(signedWithOld, {
        keys: keysOf(provider, oldKey),
        audience: SERVER,
      }).sub
    ).toBe("u1");
  });

  it("rejects the old key once it's withdrawn", () => {
    const retired = generateKeypair();
    const signedWithRetired = issueToken(retired, { subject: "u1", audience: SERVER });

    expect(() =>
      verifyToken(signedWithRetired, { keys: keysOf(provider), audience: SERVER })
    ).toThrow(/unknown signing key/i);
  });
});

describe("recovery codes", () => {
  it("look like something a person can write down", () => {
    expect(generateRecoveryCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("avoid characters people confuse", () => {
    // I/O against 1/0 is the classic write-it-down failure.
    const codes = generateRecoveryCodes(40).join("");
    expect(codes).not.toMatch(/[IO01]/);
  });

  it("are different every time", () => {
    const codes = generateRecoveryCodes(20);
    expect(new Set(codes).size).toBe(20);
  });

  it("match however they were written down", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);

    for (const variant of [
      code,
      code.toLowerCase(),
      code.replace(/-/g, " "),
      code.replace(/-/g, ""),
      ` ${code} `,
    ]) {
      expect(recoveryCodeMatches(variant, hash)).toBe(true);
    }
  });

  it("forgive an O typed for a zero", () => {
    expect(normalizeRecoveryCode("ABCO")).toBe(normalizeRecoveryCode("ABC0"));
    expect(normalizeRecoveryCode("ABCI")).toBe(normalizeRecoveryCode("ABC1"));
  });

  it("reject a code that isn't one", () => {
    const hash = hashRecoveryCode(generateRecoveryCode());
    expect(recoveryCodeMatches("XXXX-XXXX-XXXX", hash)).toBe(false);
    expect(recoveryCodeMatches("", hash)).toBe(false);
  });

  it("are stored as hashes, not as themselves", () => {
    // A database leak must not hand over working recovery codes.
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).not.toContain(code.replace(/-/g, ""));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("single use", () => {
    it("removes the code it consumed", () => {
      const codes = generateRecoveryCodes(3);
      const hashes = codes.map(hashRecoveryCode);

      const first = consumeRecoveryCode(codes[1], hashes);
      expect(first.ok).toBe(true);
      expect(first.remaining).toHaveLength(2);

      // The whole point: it cannot be used again.
      const second = consumeRecoveryCode(codes[1], first.remaining);
      expect(second.ok).toBe(false);
      expect(second.remaining).toHaveLength(2);
    });

    it("leaves the list alone when nothing matched", () => {
      const hashes = generateRecoveryCodes(3).map(hashRecoveryCode);
      const result = consumeRecoveryCode("ZZZZ-ZZZZ-ZZZZ", hashes);
      expect(result).toEqual({ ok: false, remaining: hashes });
    });
  });
});
