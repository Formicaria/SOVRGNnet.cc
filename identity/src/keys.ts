import { privateKeyFromPem, publicKeyToJwk, type Jwk, type Keypair } from "@shared/identity";

/**
 * The signing keys this provider mints tokens with.
 *
 * Supports more than one because rotation has to overlap: publish the new key
 * alongside the old, start signing with the new, wait out the old tokens and
 * every server's JWKS cache, then drop the old one. Without the overlap every
 * token in flight breaks at once, on servers that did nothing wrong.
 *
 * IDENTITY_SIGNING_KEY      the key currently signing
 * IDENTITY_PREVIOUS_KEYS    older public keys still published, comma-separated
 */

let active: Keypair | null = null;
let retired: Keypair[] = [];

function parse(pem: string, label: string): Keypair {
  try {
    return privateKeyFromPem(pem.replace(/\\n/g, "\n").trim());
  } catch (error) {
    throw new Error(
      `${label} is not a usable Ed25519 private key: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

export function loadKeys(): { active: Keypair; all: Keypair[] } {
  if (!active) {
    const pem = process.env.IDENTITY_SIGNING_KEY?.trim();
    if (!pem) {
      // Refusing to start beats generating an ephemeral key: every token
      // signed with it would be invalid the moment the process restarted, and
      // the failure would look like a mysterious signature error on servers
      // rather than a missing setting here.
      throw new Error(
        "IDENTITY_SIGNING_KEY is not set. Generate one with `pnpm keygen` and put it in .env."
      );
    }
    active = parse(pem, "IDENTITY_SIGNING_KEY");

    const previous = process.env.IDENTITY_PREVIOUS_KEYS?.trim();
    retired = previous
      ? previous
          .split(",")
          .map(entry => entry.trim())
          .filter(Boolean)
          .map((entry, index) => parse(entry, `IDENTITY_PREVIOUS_KEYS[${index}]`))
      : [];
  }

  return { active, all: [active, ...retired] };
}

/** The public half, for servers to fetch and cache. */
export function jwks(): { keys: Jwk[] } {
  const { all } = loadKeys();
  const seen = new Set<string>();

  const keys: Jwk[] = [];
  for (const keypair of all) {
    const jwk = publicKeyToJwk(keypair.publicKey);
    if (seen.has(jwk.kid)) continue;
    seen.add(jwk.kid);
    keys.push(jwk);
  }
  return { keys };
}

/** Test seam. */
export function __resetKeysForTests(): void {
  active = null;
  retired = [];
}
