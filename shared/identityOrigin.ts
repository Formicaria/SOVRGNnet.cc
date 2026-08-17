/**
 * Where the identity provider lives. Constants only, and deliberately alone.
 *
 * These were in `shared/identity.ts` next to the token signing and
 * verification. That file opens with `import { ... } from "node:crypto"`, and
 * a browser importing one constant from it drags the whole module in: Vite
 * externalises `node:crypto` for the browser, Rollup then finds
 * `generateKeyPairSync` missing from the shim, and the bundle fails to build.
 *
 * The desktop shell needs a default identity URL and nothing else. Splitting
 * the two costs a file and makes the dependency honest — a value a browser can
 * hold, in a module a browser can load.
 *
 * `shared/identity.ts` re-exports both, so server-side callers importing them
 * alongside the crypto helpers keep working unchanged.
 */

/**
 * The origin of the sovrgnnet.cc identity provider.
 *
 * Every default that names this service reads it from here. It was written out
 * separately in four places — TOKEN_ISSUER, two IDENTITY_ISSUER defaults, and
 * the desktop's IDENTITY_URL — all pointing at the apex, which serves the
 * static marketing site. The desktop's sign-in POST got a 405 from a host with
 * no API, and any server with SSO enabled fetched JWKS from a page that
 * publishes no keys. One wrong copy gets fixed; four get fixed one at a time,
 * over months, as each is discovered separately.
 *
 * Overridable per deployment with IDENTITY_ISSUER (server) or
 * VITE_IDENTITY_URL (desktop) — an instance is free to trust a different
 * provider, or none.
 */
export const IDENTITY_ORIGIN = "https://id.sovrgnnet.cc";

/**
 * The `iss` claim on every token this provider signs, and what each server
 * checks before trusting one.
 *
 * The same string as the origin, and separately named because they are the
 * same by convention rather than by necessity: the issuer is an identifier,
 * the origin is an address. A deployment that moved the service without
 * reissuing every token in flight would need them to differ for a while.
 */
export const TOKEN_ISSUER = IDENTITY_ORIGIN;
