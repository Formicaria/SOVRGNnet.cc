import { parseInvite, type ParsedInvite } from "./invite";
import { APP_URL_SCHEME } from "./const";

/**
 * What a `sovrgn://` URL means.
 *
 * Deep links arrive from outside the app — a browser, a chat message, a
 * command line — which makes them untrusted input that can appear at any
 * moment, including before the UI has finished loading. Turning one into a
 * decision is pure, ordinary logic, so it lives here and is tested rather
 * than being buried in an event handler.
 *
 * Unrecognised links resolve to `{ kind: "unknown" }` rather than throwing.
 * A malformed URL is something a user does, not an exceptional condition, and
 * the app should say "that link didn't make sense" instead of crashing.
 */

export type DeepLinkAction =
  | { kind: "invite"; invite: ParsedInvite }
  | { kind: "server"; host: string; secure: boolean }
  | { kind: "unknown"; raw: string };

const SCHEME = `${APP_URL_SCHEME}://`;

function isLocalHost(host: string): boolean {
  const name = host.split(":")[0].toLowerCase();
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name.endsWith(".local") ||
    /^192\.168\./.test(name) ||
    /^10\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

export function routeDeepLink(raw: string): DeepLinkAction {
  const url = raw.trim();
  if (!url.toLowerCase().startsWith(SCHEME)) {
    return { kind: "unknown", raw };
  }

  // sovrgn://invite/<host>/<code>
  if (/^sovrgn:\/\/invite\//i.test(url)) {
    const invite = parseInvite(url);
    return invite ? { kind: "invite", invite } : { kind: "unknown", raw };
  }

  // sovrgn://server/<host> — jump straight to a server you already know.
  const server = /^sovrgn:\/\/server\/([^/?#]+)/i.exec(url);
  if (server) {
    const host = server[1];
    if (!host) return { kind: "unknown", raw };
    return { kind: "server", host, secure: !isLocalHost(host) };
  }

  return { kind: "unknown", raw };
}

/**
 * Deep links can arrive before anything is listening — a cold start from an
 * invite click is exactly that. This queues them until a handler appears,
 * then drains in arrival order.
 */
export class DeepLinkQueue {
  private pending: string[] = [];
  private handler: ((action: DeepLinkAction) => void) | null = null;

  push(raw: string): void {
    if (this.handler) {
      this.handler(routeDeepLink(raw));
    } else {
      this.pending.push(raw);
    }
  }

  onLink(handler: (action: DeepLinkAction) => void): () => void {
    this.handler = handler;
    const queued = this.pending;
    this.pending = [];
    queued.forEach(raw => handler(routeDeepLink(raw)));
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
