/**
 * Where a setting's value actually comes from.
 *
 * Until v0.8 the answer was "an environment variable", for everything except
 * the four fields `instanceSettings` already held. That was defensible for a
 * Docker deployment and false everywhere else: the desktop host has no `.env`
 * to edit, no terminal to edit it from, and `docker-compose.yml` never passed
 * most of these through to the container anyway — so `.env.example` documented
 * a dozen knobs, of which an operator could actually turn about four. Voice
 * was the sharpest case. `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
 * `LIVEKIT_API_SECRET` decide whether an instance advertises voice at all, and
 * on a desktop host there was no way to set any of them.
 *
 * So: one place that knows the precedence, and one rule.
 *
 *     a stored value wins · otherwise the environment · otherwise a default
 *
 * "Stored" means *present in the row*, not *truthy*. A column is nullable and
 * null means "not set here, ask the environment"; any non-null value is
 * authoritative, including an empty string and including `false`. That
 * distinction is the whole reason an operator can clear a metrics token from
 * the UI and have it stay cleared, rather than watching the environment's old
 * value reappear on the next read.
 *
 * The resolution itself is a pure function of (row, environment) so it can be
 * tested without a database — the same posture `instance.ts` takes by making
 * callers pass `stored` in. The caching around it is the impure half, kept
 * small and at the bottom of this file.
 */

import type { InstanceSettings } from "../drizzle/schema";
import * as db from "./db";

/** The subset of the row this module resolves. Nulls fall through to env. */
export type SettingsRow = Partial<
  Pick<
    InstanceSettings,
    | "federationEnabled"
    | "matrixPublicUrl"
    | "ssoEnabled"
    | "identityIssuer"
    | "voiceUrl"
    | "voiceApiKey"
    | "voiceApiSecret"
    | "ipfsApiUrl"
    | "metricsToken"
    | "readyTimeoutMs"
  >
> | null;

/** Just the environment keys this module reads, so tests can pass a literal. */
export type SettingsEnv = Partial<Record<string, string | undefined>>;

export interface ResolvedSettings {
  /** Whether this instance federates. Dendrite must restart to follow. */
  federationEnabled: boolean;
  /** The homeserver address clients are told to dial, or null. */
  matrixPublicUrl: string | null;
  ssoEnabled: boolean;
  /** Only meaningful when `ssoEnabled`; the caller decides the fallback. */
  identityIssuer: string | null;
  voiceUrl: string | null;
  voiceApiKey: string | null;
  voiceApiSecret: string | null;
  ipfsApiUrl: string;
  /** Empty means /metrics is unauthenticated — deliberately expressible. */
  metricsToken: string | null;
  readyTimeoutMs: number;
}

/** Defaults, matching what the bare `process.env` reads used before v0.8. */
const DEFAULT_IPFS_API_URL = "http://localhost:5001";
const DEFAULT_READY_TIMEOUT_MS = 3000;

/**
 * A stored string, or null to mean "ask the environment".
 *
 * Trimmed, because a value pasted into a text field arrives with whitespace
 * more often than not, and a homeserver URL with a trailing space fails in a
 * way nobody enjoys diagnosing. A trimmed-to-empty stored value is still a
 * value — it means the operator cleared the field on purpose.
 */
function storedString(value: string | null | undefined): string | null {
  return value == null ? null : value.trim();
}

/** An environment string, or null when absent or blank. */
function envString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveSettings(
  row: SettingsRow,
  env: SettingsEnv = process.env
): ResolvedSettings {
  const stored = {
    matrixPublicUrl: storedString(row?.matrixPublicUrl),
    identityIssuer: storedString(row?.identityIssuer),
    voiceUrl: storedString(row?.voiceUrl),
    voiceApiKey: storedString(row?.voiceApiKey),
    voiceApiSecret: storedString(row?.voiceApiSecret),
    ipfsApiUrl: storedString(row?.ipfsApiUrl),
    metricsToken: storedString(row?.metricsToken),
  };

  // A stored empty string is an explicit "off" and must not fall through, so
  // every branch below tests `!== null` rather than truthiness.
  return {
    federationEnabled:
      row?.federationEnabled ?? env.MATRIX_ALLOW_FEDERATION === "true",

    matrixPublicUrl:
      stored.matrixPublicUrl !== null
        ? stored.matrixPublicUrl || null
        : envString(env.MATRIX_PUBLIC_URL),

    ssoEnabled: row?.ssoEnabled ?? env.INSTANCE_ALLOW_SSO === "true",

    identityIssuer:
      stored.identityIssuer !== null
        ? stored.identityIssuer || null
        : envString(env.IDENTITY_ISSUER),

    voiceUrl:
      stored.voiceUrl !== null ? stored.voiceUrl || null : envString(env.LIVEKIT_URL),

    voiceApiKey:
      stored.voiceApiKey !== null
        ? stored.voiceApiKey || null
        : envString(env.LIVEKIT_API_KEY),

    voiceApiSecret:
      stored.voiceApiSecret !== null
        ? stored.voiceApiSecret || null
        : envString(env.LIVEKIT_API_SECRET),

    // The one field with a non-null default: there is always an IPFS address
    // to try, and "" would mean "attachments are broken" rather than "off".
    ipfsApiUrl:
      (stored.ipfsApiUrl !== null ? stored.ipfsApiUrl : envString(env.IPFS_API_URL)) ||
      DEFAULT_IPFS_API_URL,

    metricsToken:
      stored.metricsToken !== null
        ? stored.metricsToken || null
        : envString(env.METRICS_TOKEN),

    readyTimeoutMs: resolveReadyTimeout(row?.readyTimeoutMs, env.READY_TIMEOUT_MS),
  };
}

/**
 * A positive integer, or the default.
 *
 * Guarded rather than trusted because this bounds every dependency check on
 * `/ready`: zero or a negative would make the probe answer before it asked,
 * and `parseInt("banana")` is NaN, which compares false against everything and
 * would have made the timeout never fire.
 */
function resolveReadyTimeout(
  stored: number | null | undefined,
  env: string | undefined
): number {
  const candidate = stored ?? (env !== undefined ? parseInt(env, 10) : NaN);
  return Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_READY_TIMEOUT_MS;
}

/**
 * Whether voice can be offered: all three values present.
 *
 * Kept here rather than at each call site because `instance.ts` and `voice.ts`
 * both need the answer and previously each spelled it out, which is how two
 * places end up disagreeing about whether a feature exists.
 */
export function voiceConfigured(resolved: ResolvedSettings): boolean {
  return Boolean(resolved.voiceUrl && resolved.voiceApiKey && resolved.voiceApiSecret);
}

// ------------------------------------------------------------------ caching

/**
 * The last row read, and the resolution built from it.
 *
 * Synchronous readers are the point. `voice.ts` mints a token inside a request,
 * `metrics.ts` authenticates one, `instanceRoutes.ts` bounds a probe — none of
 * them can afford a database round trip per call, and several sit on paths that
 * must keep answering when the database is *down*. So the row is read on a
 * schedule and cached, exactly as `refreshDirectSync` handles the homeserver
 * probe, and a failed read leaves the previous answer standing rather than
 * dropping the instance back to environment defaults mid-flight.
 *
 * The cost is that a save takes effect on the next refresh rather than the next
 * request — which is why `saveInstanceSettings` calls `refreshSettings()` and
 * doesn't wait for the interval.
 */
let cachedRow: SettingsRow = null;
let everLoaded = false;

/** Re-read the row. Safe to call often; failures keep the last good value. */
export async function refreshSettings(): Promise<void> {
  try {
    const row = await db.getInstanceSettings();
    cachedRow = row ?? null;
    everLoaded = true;
  } catch {
    // Deliberately silent. getInstanceSettings already swallows its own
    // errors and returns null; this catch is for the case where the module
    // itself is unavailable, and the honest response is to keep serving.
  }
}

/** The current resolution. Environment-only until the first refresh lands. */
export function settings(): ResolvedSettings {
  return resolveSettings(cachedRow, process.env);
}

/** Whether a row has ever been read — for reporting, not for behaviour. */
export function settingsLoaded(): boolean {
  return everLoaded;
}

/** Test seam: install a row without touching a database. */
export function __setCachedRow(row: SettingsRow): void {
  cachedRow = row;
  everLoaded = true;
}
