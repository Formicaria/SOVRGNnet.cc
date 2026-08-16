/**
 * Matrix `.well-known` delegation, and the rules around advertising a
 * reachable homeserver.
 *
 * A Matrix ID looks like `@zach:example.com`. Clients and other homeservers
 * take the part after the colon and ask `https://example.com/.well-known/...`
 * where the homeserver actually lives. That indirection is what lets the
 * server name stay `example.com` while Dendrite runs on a subdomain, a
 * different port, or behind a tunnel — and the server name is permanent, so
 * getting the indirection right is what keeps it changeable.
 *
 * Dependency-free on purpose: this is protocol shape, and the client needs the
 * same rules to decide whether direct sync is possible.
 */

export interface ClientDelegation {
  "m.homeserver": { base_url: string };
  "m.identity_server"?: { base_url: string };
}

export interface ServerDelegation {
  "m.server": string;
}

/**
 * Is this usable as a homeserver base URL?
 *
 * Deliberately strict. The value ends up in a client's fetch calls and in a
 * federation handshake, so a typo should fail here rather than three layers
 * down with a confusing error.
 */
export function parsePublicMatrixUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // A base URL with a path would produce `…/_matrix/client/v3/sync` under that
  // path, which is legal but almost never what someone meant to configure.
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;

  // No trailing slash: every caller appends `/_matrix/...`, and `//` in a
  // Matrix path is not always treated the same by every implementation.
  return `${url.protocol}//${url.host}`;
}

/**
 * The document served at `/.well-known/matrix/client`.
 *
 * Clients read this to find the homeserver. Returns null when no public URL is
 * configured, because serving a delegation that points nowhere is worse than
 * serving none: a client that gets a 404 falls back sensibly, and one that gets
 * a broken address does not.
 */
export function clientDelegation(
  publicMatrixUrl: string | null,
  identityServer?: string | null
): ClientDelegation | null {
  const base = parsePublicMatrixUrl(publicMatrixUrl);
  if (!base) return null;

  const document: ClientDelegation = { "m.homeserver": { base_url: base } };

  const identity = parsePublicMatrixUrl(identityServer);
  if (identity) document["m.identity_server"] = { base_url: identity };

  return document;
}

/**
 * The document served at `/.well-known/matrix/server`.
 *
 * This one is *only* about federation — it tells other homeservers where to
 * deliver events. Serving it while federation is switched off would invite
 * traffic the instance then refuses, so it is gated on federation actually
 * being enabled rather than on a URL merely being present.
 *
 * The value is `host[:port]`, not a URL: the federation API has its own
 * scheme rules and prepending `https://` here produces a document other
 * servers reject.
 */
export function serverDelegation(
  publicMatrixUrl: string | null,
  federationEnabled: boolean
): ServerDelegation | null {
  if (!federationEnabled) return null;

  const base = parsePublicMatrixUrl(publicMatrixUrl);
  if (!base) return null;

  const { host, protocol } = new URL(base);

  // Federation defaults to 8448 when no port is given. Being explicit avoids
  // depending on the other server's assumption.
  if (!host.includes(":")) {
    return { "m.server": `${host}:${protocol === "https:" ? 443 : 8008}` };
  }
  return { "m.server": host };
}

// ------------------------------------------------------- readiness for sync

export type DirectSyncBlocker =
  | "no-public-url"
  | "unreachable"
  | "not-a-homeserver"
  | "unverified";

export interface DirectSyncStatus {
  /** Whether clients may be told to sync with Matrix themselves. */
  available: boolean;
  /** Present when unavailable. */
  reason?: DirectSyncBlocker;
  /** For humans, in the interface or a log. */
  detail?: string;
}

/**
 * Decide whether to advertise `clientMatrix`.
 *
 * The rule that matters: **a configured URL is not a reachable homeserver.**
 * This was previously `Boolean(MATRIX_PUBLIC_URL)`, which announced the
 * capability the moment an operator set a variable — before anything had
 * confirmed a homeserver answers there, and regardless of whether it was
 * correct. That is the same mistake the `encryption` flag made in v0.3, where
 * a deployment detail silently became a claim about the software.
 *
 * So the default is false, and it takes a successful probe to move.
 */
export function directSyncStatus(
  publicUrl: string | null,
  probe: { reachable: boolean; isHomeserver: boolean; checked: boolean } | null
): DirectSyncStatus {
  const base = parsePublicMatrixUrl(publicUrl);
  if (!base) {
    return {
      available: false,
      reason: "no-public-url",
      detail:
        "This instance proxies Matrix. Set MATRIX_PUBLIC_URL to a reachable homeserver to let clients sync directly.",
    };
  }

  if (!probe || !probe.checked) {
    return {
      available: false,
      reason: "unverified",
      detail: `${base} is configured but hasn't been verified yet.`,
    };
  }

  if (!probe.reachable) {
    return {
      available: false,
      reason: "unreachable",
      detail: `${base} is configured but didn't answer. Clients will keep using the proxy.`,
    };
  }

  if (!probe.isHomeserver) {
    return {
      available: false,
      reason: "not-a-homeserver",
      detail: `${base} answered, but not like a Matrix homeserver.`,
    };
  }

  return { available: true };
}
