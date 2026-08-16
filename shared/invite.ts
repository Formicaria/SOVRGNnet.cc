import { APP_URL_SCHEME } from "./const";

/**
 * Invite links that say which server they're for.
 *
 * The v0.1 format was just a code — `/invite/abc123` — which silently assumed
 * the person clicking it was already on the right instance. That holds for a
 * single deployment and breaks the moment a client can be connected to four
 * different people's servers at once: a bare code is ambiguous.
 *
 * An invite now carries both parts: **where** and **which**.
 *
 *   https://chat.example.com/invite/abc123     canonical, clickable anywhere
 *   sovrgn://invite/chat.example.com/abc123    hands off to the desktop client
 *
 * The web form stays a real URL on the server itself, so it works with no
 * client installed, no directory lookup, and nothing central involved. The
 * deep link is derived from it rather than being a separate identifier.
 */

export type ParsedInvite = {
  /** Host (optionally with port) of the server issuing the invite. */
  host: string;
  /** The invite code itself. */
  code: string;
  /** Whether to reach the host over https. Only false for plain-http hosts. */
  secure: boolean;
};

/** Hosts we're willing to treat as http rather than https. */
function isLocalHost(host: string): boolean {
  const name = host.split(":")[0].toLowerCase();
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name.endsWith(".local") ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(name) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(name)
  );
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;

export function isValidInviteCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/** The link a person shares. Works in any browser, client or not. */
export function inviteUrl(host: string, code: string): string {
  const scheme = isLocalHost(host) ? "http" : "https";
  return `${scheme}://${host}/invite/${code}`;
}

/** The link that hands off to the desktop client. */
export function inviteDeepLink(host: string, code: string): string {
  return `${APP_URL_SCHEME}://invite/${host}/${code}`;
}

/**
 * Parse anything that might be an invite into host + code.
 *
 * Accepts the canonical URL, the deep link, and a bare code (resolved against
 * `fallbackHost`, which is how a link pasted inside an already-connected
 * server still works). Returns null rather than throwing — bad invites are an
 * ordinary thing a user does, not an exceptional condition.
 */
export function parseInvite(input: string, fallbackHost?: string): ParsedInvite | null {
  const raw = input.trim();
  if (!raw) return null;

  // Bare code — only meaningful with a server to resolve it against.
  if (CODE_PATTERN.test(raw)) {
    if (!fallbackHost) return null;
    return { host: fallbackHost, code: raw, secure: !isLocalHost(fallbackHost) };
  }

  // sovrgn://invite/<host>/<code>
  const deepLink = new RegExp(`^${APP_URL_SCHEME}://invite/([^/]+)/([^/?#]+)`, "i").exec(raw);
  if (deepLink) {
    const [, host, code] = deepLink;
    if (!isValidInviteCode(code)) return null;
    return { host, code, secure: !isLocalHost(host) };
  }

  // A full URL ending in /invite/<code>
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const match = /\/invite\/([^/?#]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const code = match[1];
    if (!isValidInviteCode(code)) return null;
    return {
      host: url.host,
      code,
      // Trust an explicit scheme; fall back to host shape when it was implied.
      secure: url.protocol === "https:" || (url.protocol !== "http:" && !isLocalHost(url.host)),
    };
  } catch {
    return null;
  }
}

/** Base URL for talking to a server's API, derived from a parsed invite. */
export function serverBaseUrl(invite: Pick<ParsedInvite, "host" | "secure">): string {
  return `${invite.secure ? "https" : "http"}://${invite.host}`;
}
