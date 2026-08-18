import { networkInterfaces } from "node:os";

/**
 * The host a shared link should carry, when the request came from loopback.
 *
 * Invite URLs are derived from the Host header, which is right everywhere the
 * header names something other people can dial: behind the tunnel it's the
 * public hostname, on a LAN install it's the machine's LAN address, because
 * that's the address the person was browsing. The one place it fails is the
 * place the desktop app put front and centre: a hosted server whose owner
 * browses it at 127.0.0.1. Every invite they shared said `127.0.0.1:3100` —
 * a link to the *recipient's* machine — and the claim "friends on your
 * network can join with an invite link" had never been walked. This module
 * exists so that claim is true.
 *
 * The substitution deliberately does less than it could:
 *
 * - It only fires when the derived host is loopback. A Host header naming
 *   anything else was reachable by whoever sent it, and second-guessing it
 *   would break the tunnel and LAN cases that already work.
 * - It prefers 192.168/16, then 10/8, then 172.16–31 — not because one
 *   private range is better, but because inside a Docker container the
 *   interfaces are the *container's*, and Docker's default bridge lives at
 *   172.17/16. An operator browsing `localhost:3000` on a Docker host would
 *   otherwise get a bridge address handed out as if friends could dial it.
 *   They can't. Which leads to:
 * - If the only candidates look like the default Docker bridge, it keeps
 *   loopback. A link that is obviously wrong beats a link that is plausibly
 *   wrong — the first gets fixed, the second gets debugged by a confused
 *   friend on a different network.
 */

type InterfaceReader = typeof networkInterfaces;

function isLoopbackName(name: string): boolean {
  const bare = name.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Split "host:port" without being fooled by bracketed IPv6. */
function splitHostPort(host: string): { name: string; port: string } {
  const bracketed = /^(\[[^\]]+\])(?::(\d+))?$/.exec(host);
  if (bracketed) return { name: bracketed[1], port: bracketed[2] ?? "" };
  const lastColon = host.lastIndexOf(":");
  // More than one colon and no brackets means a bare IPv6 address, not a port.
  if (lastColon > -1 && host.indexOf(":") === lastColon) {
    return { name: host.slice(0, lastColon), port: host.slice(lastColon + 1) };
  }
  return { name: host, port: "" };
}

/**
 * Non-internal IPv4 addresses a LAN neighbour could dial, best candidate
 * first. Exported for the endpoint that lets the UI show alternatives later;
 * today only the first is used.
 */
export function lanAddresses(read: InterfaceReader = networkInterfaces): string[] {
  const found: string[] = [];
  const interfaces = read();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node spells the family "IPv4" (string) or 4 (number) depending on
      // version; checking both is cheaper than pinning the behaviour.
      const isV4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (!isV4 || entry.internal) continue;
      found.push(entry.address);
    }
  }
  const rank = (address: string): number => {
    if (/^192\.168\./.test(address)) return 0;
    if (/^10\./.test(address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    return 3; // public or CGNAT — reachable-ish, least likely to be the LAN
  };
  return found.sort((a, b) => rank(a) - rank(b));
}

/** Docker's default bridge network. See the module comment for why it loses. */
function looksLikeDockerBridge(address: string): boolean {
  return /^172\.17\./.test(address);
}

export function shareableHost(
  requestHost: string,
  read: InterfaceReader = networkInterfaces
): string {
  const { name, port } = splitHostPort(requestHost);
  if (!isLoopbackName(name)) return requestHost;

  const candidates = lanAddresses(read).filter(a => !looksLikeDockerBridge(a));
  if (candidates.length === 0) return requestHost;

  return port ? `${candidates[0]}:${port}` : candidates[0];
}
