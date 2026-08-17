import { jwkToPublicKey, type Jwk } from "./identity";

/**
 * Can an instance actually use this identity provider?
 *
 * Everything a server needs from an issuer arrives in one document: the JWKS
 * at `/.well-known/jwks.json`. It fetches that once, caches the public keys,
 * and from then on verifies tokens with no further contact — which is the
 * whole reason the identity service can be down without logging anybody out.
 *
 * That makes the JWKS the entire contract, and worth checking as one. The
 * failures it catches are quiet: a document that parses as JSON but yields no
 * usable key means every SSO sign-in fails with a signature error on the
 * *instance*, pointing at the wrong machine entirely.
 *
 * Pure, and separate from any fetching, so it can be tested against a document
 * captured from production rather than against a live network.
 */

export type IssuerProblem = {
  /** Short, for a log line or a check's output. */
  headline: string;
  /** What it means for someone trying to sign in. */
  detail: string;
};

export type IssuerAssessment = {
  /** True when at least one key is usable for verifying a token. */
  usable: boolean;
  /** Key ids an instance would cache. */
  kids: string[];
  problems: IssuerProblem[];
};

/** Keys this project signs with. Anything else, we cannot verify. */
const REQUIRED = { kty: "OKP", crv: "Ed25519" } as const;

export function checkIssuerJwks(document: unknown): IssuerAssessment {
  const problems: IssuerProblem[] = [];
  const kids: string[] = [];

  if (typeof document !== "object" || document === null || !("keys" in document)) {
    return {
      usable: false,
      kids: [],
      problems: [
        {
          headline: "Not a JWKS",
          detail:
            "The response had no `keys` array. The commonest cause is the URL " +
            "resolving to a static site or a 404 page that still returns 200 — " +
            "check the issuer origin before suspecting the keys.",
        },
      ],
    };
  }

  const keys = (document as { keys: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return {
      usable: false,
      kids: [],
      problems: [
        {
          headline: "No keys published",
          detail:
            "An empty JWKS means every token this issuer signs is unverifiable. " +
            "Servers will refuse SSO sign-ins and report a signature error.",
        },
      ],
    };
  }

  let usable = 0;
  for (const [index, candidate] of keys.entries()) {
    const jwk = candidate as Partial<Jwk>;
    const where = jwk.kid ? `key ${jwk.kid}` : `key at index ${index}`;

    if (jwk.kty !== REQUIRED.kty || jwk.crv !== REQUIRED.crv) {
      problems.push({
        headline: `${where} is not Ed25519`,
        detail:
          `Found kty=${String(jwk.kty)} crv=${String(jwk.crv)}. This project ` +
          "verifies EdDSA over Ed25519 only, so a key of another type is " +
          "published but unusable.",
      });
      continue;
    }

    if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
      problems.push({
        headline: `${where} has no kid`,
        detail:
          "Tokens name the key that signed them by kid. Without one there is " +
          "nothing to look the key up by, and rotation becomes ambiguous.",
      });
      continue;
    }

    if ("d" in jwk) {
      // Worth its own problem rather than a note. This endpoint is public.
      problems.push({
        headline: `${where} contains a private scalar`,
        detail:
          "`d` is the private half of an Ed25519 key. Publishing it hands " +
          "anyone who fetches this URL the ability to mint tokens for every " +
          "account on every server that trusts this issuer. Rotate it now.",
      });
      continue;
    }

    try {
      jwkToPublicKey(jwk as Jwk);
    } catch (error) {
      problems.push({
        headline: `${where} will not parse`,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    kids.push(jwk.kid);
    usable += 1;
  }

  if (usable === 0 && problems.length === 0) {
    problems.push({
      headline: "No usable key",
      detail: "The document had keys, but none of them could be used to verify a token.",
    });
  }

  const duplicates = kids.filter((kid, i) => kids.indexOf(kid) !== i);
  if (duplicates.length > 0) {
    problems.push({
      headline: `Duplicate kid: ${[...new Set(duplicates)].join(", ")}`,
      detail:
        "Two keys sharing a kid is ambiguous — verifiers disagree about which " +
        "one wins. Usually a rotation where the new key was added without the " +
        "old one being removed.",
    });
  }

  return { usable: usable > 0, kids, problems };
}
