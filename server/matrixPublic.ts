import {
  directSyncStatus,
  parsePublicMatrixUrl,
  type DirectSyncStatus,
} from "@shared/matrixDelegation";

/**
 * Is the homeserver actually reachable at the address we advertise?
 *
 * `clientMatrix` used to be `Boolean(MATRIX_PUBLIC_URL)` — set the variable and
 * the instance announced that clients could sync directly, whether or not
 * anything answered there. Same shape as the `encryption` flag in v0.3, where a
 * deployment detail became a claim about the software. Capabilities exist so a
 * client can decide what to offer; one that lies is worse than one that's
 * absent, because the client acts on it.
 *
 * So this probes, caches, and defaults to *not available*.
 *
 * Cached because /api/instance is polled and this is a network round trip.
 * Stale-while-revalidate rather than blocking: a capability that goes briefly
 * out of date is a much smaller problem than a descriptor endpoint that waits
 * on a third party.
 */

type FetchLike = typeof fetch;

let fetchImpl: FetchLike = (...args) => fetch(...args);

/** Test seam. */
export function __setFetchForTests(f: FetchLike): void {
  fetchImpl = f;
}

const PROBE_TIMEOUT_MS = 3000;
const FRESH_FOR_MS = 60_000;
/**
 * A negative answer expires much sooner than a positive one. The common way
 * to cache a "no" is probing during boot, while the homeserver is itself
 * still starting — and a 60-second "no" from that window means the instance
 * spends its first minute denying a capability it has. A dead homeserver
 * stays dead across a 5-second retry; a starting one doesn't.
 */
const NEGATIVE_FRESH_FOR_MS = 5_000;

type Probe = {
  reachable: boolean;
  isHomeserver: boolean;
  checked: boolean;
  at: number;
};

let cached: Probe | null = null;
let inFlight: Promise<Probe> | null = null;

export function __resetForTests(): void {
  cached = null;
  inFlight = null;
}

function publicUrl(): string | null {
  return parsePublicMatrixUrl(process.env.MATRIX_PUBLIC_URL);
}

/**
 * Ask the advertised address whether it is a Matrix homeserver.
 *
 * `/_matrix/client/versions` is the right probe: unauthenticated, cheap, and
 * it distinguishes "something answered" from "a homeserver answered". A
 * reverse proxy returning its own 200 page would pass a naive check and fail
 * every real request afterwards.
 */
async function probe(base: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${base}/_matrix/client/versions`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return { reachable: false, isHomeserver: false, checked: true, at: Date.now() };
    }

    let body: unknown = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }

    const versions = (body as { versions?: unknown } | null)?.versions;
    const isHomeserver = Array.isArray(versions) && versions.length > 0;

    return { reachable: true, isHomeserver, checked: true, at: Date.now() };
  } catch {
    return { reachable: false, isHomeserver: false, checked: true, at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current status, refreshing in the background when stale.
 *
 * Never blocks on the network beyond the first call. A descriptor request that
 * waits three seconds on a dead homeserver is a descriptor request that times
 * out, and the whole point of the endpoint is that it answers.
 */
export function directSync(): DirectSyncStatus {
  const base = publicUrl();
  if (!base) return directSyncStatus(null, null);

  const freshFor =
    cached && cached.reachable && cached.isHomeserver
      ? FRESH_FOR_MS
      : NEGATIVE_FRESH_FOR_MS;
  const stale = !cached || Date.now() - cached.at > freshFor;

  if (stale && !inFlight) {
    inFlight = probe(base)
      .then(result => {
        cached = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    // Deliberately not awaited.
    void inFlight.catch(() => {});
  }

  return directSyncStatus(base, cached);
}

/** Probe now and wait for it. Used at startup and by tests. */
export async function refreshDirectSync(): Promise<DirectSyncStatus> {
  const base = publicUrl();
  if (!base) return directSyncStatus(null, null);

  cached = await probe(base);
  return directSyncStatus(base, cached);
}
