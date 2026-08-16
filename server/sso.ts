import type { KeyObject } from "node:crypto";
import {
  TOKEN_ISSUER,
  TokenError,
  jwkToPublicKey,
  verifyToken,
  type IdentityClaims,
  type Jwk,
} from "@shared/identity";

/**
 * Verifying sovrgnnet.cc identity tokens, from a server's point of view.
 *
 * The whole reason ADR 0003 chose public-key signatures is so that a server
 * does not depend on the identity provider being reachable. That promise is
 * only real if this cache behaves correctly when the provider is down, which
 * is what most of this file is about.
 *
 * The policy, deliberately:
 *
 * - Keys are fetched once and cached for a long time.
 * - A refresh that fails **keeps serving the old keys**, indefinitely.
 * - Failing closed would mean one failed HTTP request logging out a network
 *   of servers that have nothing to do with each other. A signature check
 *   against a key that rotated last week is a far smaller problem.
 */

const REFRESH_AFTER_MS = 60 * 60 * 1000; // an hour
const FETCH_TIMEOUT_MS = 8000;

type FetchLike = typeof fetch;

export type SsoConfig = {
  /** Base URL of the identity provider. */
  issuer?: string;
  /** This server's instance id — tokens for anyone else are refused. */
  audience: string;
  enabled: boolean;
};

export function ssoConfigFromEnv(instanceId: string): SsoConfig {
  return {
    issuer: process.env.IDENTITY_ISSUER?.trim() || TOKEN_ISSUER,
    audience: instanceId,
    // Off unless an operator opts in. A server that wants nothing to do with
    // central identity stays fully functional.
    enabled: process.env.INSTANCE_ALLOW_SSO === "true",
  };
}

export type LinkDecision =
  | { action: "sign-in"; userId: number }
  | { action: "link"; userId: number }
  | { action: "create" }
  | { action: "refuse"; message: string };

/**
 * What to do when someone presents a valid identity token.
 *
 * Split out and tested because the unsafe path here is not obvious: matching
 * an SSO account to an existing local account **by email address** is an
 * account takeover unless the provider has verified that the person actually
 * controls the address. Otherwise anyone could register at sovrgnnet.cc with
 * your email and inherit your account on every server you belong to.
 *
 * So an unverified email never links. It refuses and tells the person to sign
 * in locally first — mildly annoying, and the alternative is a vulnerability.
 */
export function decideSsoLink(input: {
  claims: Pick<IdentityClaims, "sub" | "email" | "email_verified">;
  /** Existing account already bound to this subject, if any. */
  existingBySubject: { id: number } | null;
  /** Existing local account with the same email, if any. */
  existingByEmail: { id: number; ssoSubject: string | null } | null;
}): LinkDecision {
  if (input.existingBySubject) {
    return { action: "sign-in", userId: input.existingBySubject.id };
  }

  const byEmail = input.existingByEmail;
  if (!byEmail) return { action: "create" };

  // Already bound to a different sovrgnnet.cc account. Two identities can't
  // share one local account, and silently rebinding would hand it over.
  if (byEmail.ssoSubject && byEmail.ssoSubject !== input.claims.sub) {
    return {
      action: "refuse",
      message:
        "That email is already linked to a different sovrgnnet.cc account on this server.",
    };
  }

  if (!input.claims.email_verified) {
    return {
      action: "refuse",
      message:
        "An account with that email already exists here. Sign in with your password first to link it to your sovrgnnet.cc account.",
    };
  }

  return { action: "link", userId: byEmail.id };
}

export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly issuer: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get size(): number {
    return this.keys.size;
  }

  /** True once we hold keys, whether or not they're fresh. */
  get isPrimed(): boolean {
    return this.keys.size > 0;
  }

  private get isStale(): boolean {
    return Date.now() - this.fetchedAt > REFRESH_AFTER_MS;
  }

  /**
   * Keys to verify against, refreshing when stale.
   *
   * A failed refresh is swallowed when we already hold keys — that's the
   * outage case, and it's the point. It only propagates when we have nothing
   * at all, because then there is genuinely no way to verify anything.
   */
  async getKeys(): Promise<Map<string, KeyObject>> {
    if (this.isPrimed && !this.isStale) return this.keys;

    try {
      await this.refresh();
    } catch (error) {
      if (!this.isPrimed) throw error;
      console.warn(
        "[SSO] Couldn't refresh signing keys; continuing with cached ones:",
        error instanceof Error ? error.message : error
      );
    }

    return this.keys;
  }

  /** Force a refresh. Concurrent callers share one request. */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const url = `${this.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
        const res = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`JWKS request failed (${res.status})`);

        const body = (await res.json()) as { keys?: Jwk[] };
        if (!Array.isArray(body?.keys) || body.keys.length === 0) {
          throw new Error("JWKS contained no keys");
        }

        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys) {
          try {
            next.set(jwk.kid, jwkToPublicKey(jwk));
          } catch {
            // One unusable key shouldn't discard the rest — a provider may
            // publish an algorithm this version doesn't know.
          }
        }
        if (next.size === 0) throw new Error("No usable keys in JWKS");

        // Replaced wholesale only on success, so a bad response can't
        // half-empty a working cache.
        this.keys = next;
        this.fetchedAt = Date.now();
      } finally {
        clearTimeout(timer);
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  /** Test seam: prime the cache without a network call. */
  __setForTests(keys: Map<string, KeyObject>, fetchedAt = Date.now()): void {
    this.keys = keys;
    this.fetchedAt = fetchedAt;
  }
}

/**
 * Verify a token presented to this server.
 *
 * If the key id is unknown, refresh once and retry — that's the ordinary
 * consequence of the provider having rotated keys since we last looked, and
 * it shouldn't need an operator.
 */
export async function verifySsoToken(
  token: string,
  cache: JwksCache,
  config: SsoConfig
): Promise<IdentityClaims> {
  if (!config.enabled) {
    throw new TokenError("This server doesn't accept sovrgnnet.cc accounts", "sso_disabled");
  }

  const attempt = async () =>
    verifyToken(token, { keys: await cache.getKeys(), audience: config.audience });

  try {
    return await attempt();
  } catch (error) {
    if (error instanceof TokenError && error.code === "unknown_key") {
      await cache.refresh();
      return await attempt();
    }
    throw error;
  }
}
