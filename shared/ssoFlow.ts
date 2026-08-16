/**
 * The hand-off: signing in at sovrgnnet.cc, then landing back on a server.
 *
 * ## The attack this has to stop
 *
 * A naive version takes the target server's id as a parameter:
 *
 *     /authorize?instance=<id>&return=<url>
 *
 * Which lets anyone ask for a token for *someone else's* server and have it
 * delivered to a URL they control. A token names one server, so it's useless
 * elsewhere — but it is entirely sufficient to sign in as that person on the
 * server it names. That's account takeover with extra steps.
 *
 * So the audience is never taken on trust. The identity provider is given only
 * a return URL, fetches `/api/instance` from that origin, and uses the id the
 * origin reports as the audience. A token can therefore only ever be minted
 * for the server that is actually going to receive it: to obtain a token for
 * someone's server, you would have to already control that server.
 *
 * The token comes back in the URL **fragment**, which browsers don't send to
 * servers and which stays out of access logs, `Referer` headers, and proxies.
 */

export type ReturnTargetError =
  | "not_a_url"
  | "insecure_scheme"
  | "not_a_sovrgnnet_server"
  | "unreachable";

export type ReturnTarget =
  | { ok: true; origin: string; instanceId: string; instanceName: string }
  | { ok: false; reason: ReturnTargetError; message: string };

/** Local addresses may use http; anything else must be https. */
function isLocal(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name.endsWith(".local") ||
    /^192\.168\./.test(name) ||
    /^10\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

export function parseReturnUrl(raw: string): { origin: string; url: URL } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url.hostname))) {
      return null;
    }
    return { origin: url.origin, url };
  } catch {
    return null;
  }
}

/**
 * Work out which server a token should be minted for.
 *
 * Deliberately takes a fetch: the check is a network call to the destination,
 * and the whole security property rests on it actually happening.
 */
export async function resolveReturnTarget(
  returnUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs = 8000
): Promise<ReturnTarget> {
  const parsed = parseReturnUrl(returnUrl);
  if (!parsed) {
    return {
      ok: false,
      reason: "not_a_url",
      message: "That isn't a valid https address to return to.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${parsed.origin}/api/instance`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "not_a_sovrgnnet_server",
        message: "That address doesn't look like a SOVRGNnet server.",
      };
    }

    const info = (await res.json()) as {
      product?: string;
      id?: string;
      name?: string;
    };

    if (info?.product !== "sovrgnnet" || typeof info.id !== "string" || !/^[0-9a-f]{16}$/.test(info.id)) {
      return {
        ok: false,
        reason: "not_a_sovrgnnet_server",
        message: "That address doesn't look like a SOVRGNnet server.",
      };
    }

    return {
      ok: true,
      origin: parsed.origin,
      instanceId: info.id,
      instanceName: typeof info.name === "string" ? info.name : parsed.origin,
    };
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: "Couldn't reach that server. Is it switched on?",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Where to send someone once a token exists. Fragment, never query. */
export function buildReturnRedirect(returnUrl: string, token: string): string {
  const parsed = parseReturnUrl(returnUrl);
  if (!parsed) throw new Error("Invalid return URL");

  // Replace any existing fragment rather than appending to it.
  parsed.url.hash = `token=${encodeURIComponent(token)}`;
  return parsed.url.toString();
}

/** Read the token back out on the server side, and clear it from the address bar. */
export function readTokenFromFragment(hash: string): string | null {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return null;

  const params = new URLSearchParams(trimmed);
  const token = params.get("token");
  return token && token.length > 0 ? token : null;
}
