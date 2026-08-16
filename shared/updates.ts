/**
 * Checking whether a newer desktop release exists.
 *
 * This matters more than a typical "update available" nag. ADR 0005 bundles
 * PostgreSQL, a homeserver, and IPFS into the installer, which makes shipping
 * security fixes *our* job rather than a distribution's — and a fix nobody
 * installs is not a fix. So the check runs on launch, and the prompt is
 * honest about why.
 *
 * Deliberately advisory: it tells and offers, it does not install behind
 * someone's back. An app that silently replaces a running server while people
 * are talking is not a good citizen on a machine somebody owns.
 */

export type ReleaseInfo = {
  version: string;
  url: string;
  notes?: string;
  publishedAt?: string;
  /** Set when a release fixes something people should not sit on. */
  security?: boolean;
};

export type UpdateCheck =
  | { status: "current" }
  | { status: "available"; release: ReleaseInfo; urgency: "routine" | "security" }
  | { status: "unknown"; reason: string };

/** Semantic version comparison. Returns negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      // Drop any pre-release or build suffix; the release train is linear and
      // doesn't produce them, but a hand-made tag shouldn't break the check.
      .split(/[-+]/)[0]
      .split(".")
      .map(part => parseInt(part, 10));

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(current, candidate) < 0;
}

/**
 * Decide what to tell someone, given what's published.
 *
 * A failed check is "unknown", never "current" — claiming someone is up to
 * date when we couldn't reach the server is the one answer that could leave
 * them sitting on an unpatched bundled homeserver believing otherwise.
 */
export function evaluateUpdate(
  currentVersion: string,
  latest: ReleaseInfo | null,
  error?: string
): UpdateCheck {
  if (!latest) {
    return { status: "unknown", reason: error ?? "Couldn't reach the update server." };
  }
  if (!isNewer(latest.version, currentVersion)) {
    return { status: "current" };
  }
  return {
    status: "available",
    release: latest,
    urgency: latest.security ? "security" : "routine",
  };
}

/**
 * Parse a GitHub release into what we need.
 *
 * Drafts and prereleases are ignored: the release train publishes a draft
 * first and flips it to public only once every platform has built, so
 * offering a draft would point people at a release with missing installers.
 */
export function parseGithubRelease(raw: unknown): ReleaseInfo | null {
  const release = raw as {
    tag_name?: unknown;
    html_url?: unknown;
    body?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  };

  if (release?.draft === true || release?.prerelease === true) return null;
  if (typeof release?.tag_name !== "string" || typeof release?.html_url !== "string") {
    return null;
  }

  const version = release.tag_name.replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;

  const notes = typeof release.body === "string" ? release.body : undefined;

  return {
    version,
    url: release.html_url,
    notes,
    publishedAt:
      typeof release.published_at === "string" ? release.published_at : undefined,
    // Convention rather than metadata: GitHub has no "security" flag, so the
    // release notes say so and this looks for it.
    security: notes ? /\bsecurity (fix|release|update)\b/i.test(notes) : false,
  };
}

export const RELEASES_URL =
  "https://api.github.com/repos/Formicaria/SOVRGNnet.cc/releases/latest";

export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
  url: string = RELEASES_URL
): Promise<UpdateCheck> {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { status: "unknown", reason: `Update check failed (${res.status}).` };
    }
    return evaluateUpdate(currentVersion, parseGithubRelease(await res.json()));
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : "Couldn't check for updates.",
    };
  }
}

/**
 * Should we interrupt someone about this, having already asked before?
 *
 * Nagging on every launch is how people learn to dismiss update prompts
 * without reading them — which is precisely the habit that gets a security
 * fix ignored. A routine update asks once a week; a security one asks every
 * time, because that's what "security" is supposed to mean.
 */
export const ROUTINE_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldPrompt(
  check: UpdateCheck,
  lastPromptedVersion: string | null,
  lastPromptedAt: number | null,
  now: number = Date.now()
): boolean {
  if (check.status !== "available") return false;
  if (check.urgency === "security") return true;
  if (lastPromptedVersion !== check.release.version) return true;
  if (lastPromptedAt == null) return true;
  return now - lastPromptedAt > ROUTINE_REMINDER_MS;
}
