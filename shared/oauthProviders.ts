import { createHash, randomBytes } from "node:crypto";

/**
 * Signing in through Google, Microsoft, GitHub, or Discord.
 *
 * The identity provider is a **broker**: it doesn't hold passwords, it holds a
 * mapping from "this Google account" to "this SOVRGNnet subject". Which means
 * the two most dangerous things a login service can own — password hashes and
 * the recovery path — mostly stop being ours. Losing access becomes "recover
 * your Google account," which Google handles far better than we would.
 *
 * The part that needs care is that all four return a different shape, and
 * whether an email is *verified* is the difference between safe account
 * linking and an account takeover. Each provider says it differently, and one
 * of them doesn't say it at all.
 */

export type ProviderId = "google" | "microsoft" | "github" | "discord";

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  /** OIDC providers support PKCE; plain OAuth2 ones vary. */
  usesPkce: boolean;
};

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  google: {
    id: "google",
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    usesPkce: true,
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft",
    // "common" accepts both personal and work/school accounts.
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scopes: ["openid", "email", "profile"],
    usesPkce: true,
  },
  github: {
    id: "github",
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    // read:user alone doesn't return a private email; user:email does, and
    // without an email there's nothing to link an account by.
    scopes: ["read:user", "user:email"],
    usesPkce: false,
  },
  discord: {
    id: "discord",
    label: "Discord",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userInfoUrl: "https://discord.com/api/users/@me",
    scopes: ["identify", "email"],
    usesPkce: false,
  },
};

export function isProviderId(value: string): value is ProviderId {
  // Object.hasOwn, not `in`: the `in` operator walks the prototype chain, so
  // "constructor", "toString", and "__proto__" would all pass as provider ids
  // and then be used to index config and build URLs.
  return Object.hasOwn(PROVIDERS, value);
}

// ------------------------------------------------------------------- profile

export type NormalizedProfile = {
  provider: ProviderId;
  /** The provider's own permanent id for this person. Never their email. */
  providerUserId: string;
  email: string | null;
  /**
   * Whether the *provider* attests the address is theirs.
   *
   * This is the load-bearing field. A server will only auto-link a
   * sovrgnnet.cc identity to an existing local account when it's true —
   * otherwise anyone could sign up with someone else's address and inherit
   * their account everywhere.
   */
  emailVerified: boolean;
  name: string | null;
  avatar: string | null;
};

/**
 * Flatten each provider's response into one shape.
 *
 * The `emailVerified` handling differs per provider and is the reason this
 * function exists rather than being four inline object literals.
 */
export function normalizeProfile(
  provider: ProviderId,
  raw: Record<string, unknown>
): NormalizedProfile | null {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  switch (provider) {
    case "google": {
      const sub = str(raw.sub);
      if (!sub) return null;
      return {
        provider,
        providerUserId: sub,
        email: str(raw.email),
        // Google returns a real boolean, and sometimes the string "true".
        emailVerified: raw.email_verified === true || raw.email_verified === "true",
        name: str(raw.name),
        avatar: str(raw.picture),
      };
    }

    case "microsoft": {
      const sub = str(raw.sub) ?? str(raw.oid);
      if (!sub) return null;
      return {
        provider,
        providerUserId: sub,
        email: str(raw.email) ?? str(raw.preferred_username),
        // Microsoft's OIDC userinfo doesn't return email_verified. An address
        // on a Microsoft account is one they control, so treating a present
        // address as verified is reasonable — and stated here rather than
        // silently assumed.
        emailVerified: Boolean(str(raw.email) ?? str(raw.preferred_username)),
        name: str(raw.name),
        avatar: str(raw.picture),
      };
    }

    case "github": {
      const id = raw.id != null ? String(raw.id) : null;
      if (!id) return null;
      return {
        provider,
        providerUserId: id,
        // /user returns the *public* email, which is often null. The real
        // address comes from /user/emails — see githubPrimaryEmail.
        email: str(raw.email),
        // Never trust this endpoint for verification; /user/emails says so
        // properly, and mergeGithubEmail supplies it.
        emailVerified: false,
        name: str(raw.name) ?? str(raw.login),
        avatar: str(raw.avatar_url),
      };
    }

    case "discord": {
      const id = str(raw.id);
      if (!id) return null;
      return {
        provider,
        providerUserId: id,
        email: str(raw.email),
        // Discord's `verified` refers to the email address specifically.
        emailVerified: raw.verified === true,
        name: str(raw.global_name) ?? str(raw.username),
        avatar:
          str(raw.avatar) && id
            ? `https://cdn.discordapp.com/avatars/${id}/${String(raw.avatar)}.png`
            : null,
      };
    }
  }
}

/**
 * GitHub keeps the real address behind a second call.
 *
 * Picks the primary verified address. An account with no verified address
 * yields nothing rather than a plausible-looking unverified one, because the
 * whole point of the field is that it can be trusted.
 */
export function githubPrimaryEmail(
  emails: Array<{ email?: unknown; primary?: unknown; verified?: unknown }>
): { email: string; verified: boolean } | null {
  const usable = emails.filter(
    entry => typeof entry.email === "string" && entry.verified === true
  );
  if (usable.length === 0) return null;

  const primary = usable.find(entry => entry.primary === true) ?? usable[0];
  return { email: String(primary.email), verified: true };
}

/** Fold GitHub's separate email lookup into the profile. */
export function mergeGithubEmail(
  profile: NormalizedProfile,
  found: { email: string; verified: boolean } | null
): NormalizedProfile {
  if (!found) return profile;
  return { ...profile, email: found.email, emailVerified: found.verified };
}

// ---------------------------------------------------------------- PKCE, state

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export type Pkce = { verifier: string; challenge: string };

/**
 * PKCE, for providers that support it.
 *
 * Stops an intercepted authorization code being redeemed by anyone who didn't
 * start the exchange — worth having even with a confidential client.
 */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  provider: ProviderConfig,
  options: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge?: string;
  }
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", options.state);

  if (provider.usesPkce && options.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  // Ask Google for a stable, non-consenting sign-in rather than a fresh
  // consent screen every time.
  if (provider.id === "google") {
    url.searchParams.set("access_type", "online");
  }

  return url.toString();
}

// ------------------------------------------------------ matching an account

export type BrokerMatch =
  | { action: "sign-in"; accountId: number }
  | { action: "link"; accountId: number }
  | { action: "create" }
  | { action: "refuse"; message: string };

/**
 * Which account a provider sign-in belongs to.
 *
 * **Matched by provider identity and by nothing else** — the same rule as
 * `decideSsoLink` on the instance side, for the same reason, and the two should
 * be changed together if either is.
 *
 * The dangerous branch is matching by email, and the earlier version of this
 * function took it whenever a provider called the address verified. That is one
 * compromised or careless provider away from total: whoever can make any
 * configured provider assert `alice@example.com` inherits Alice's account.
 * GitHub's profile endpoint hands out an unverified address, which is why it
 * was never trusted here — but "trust it only when the provider says verified"
 * still puts the account behind the provider's word rather than behind
 * something Alice controls.
 *
 * So an email match is now a reason to stop. A known provider identity signs
 * in; an unknown one creates a separate account; a collision refuses and points
 * at deliberate linking, which happens from inside an authenticated session
 * where the person has already proved the account is theirs.
 */
export function matchBrokerAccount(input: {
  profile: Pick<NormalizedProfile, "email" | "emailVerified">;
  /** Account already bound to this exact provider identity. */
  existingByIdentity: { id: number } | null;
  /** Account with the same email address, if any. */
  existingByEmail: { id: number } | null;
}): BrokerMatch {
  if (input.existingByIdentity) {
    return { action: "sign-in", accountId: input.existingByIdentity.id };
  }

  if (!input.profile.email || !input.existingByEmail) {
    return { action: "create" };
  }

  // Verified or not. `emailVerified` is deliberately not consulted here any
  // more: it decides nothing, because the answer is the same either way.
  return {
    action: "refuse",
    message:
      "An account already uses that email address. Sign in the way you did before, then link this provider from your account settings.",
  };
}

/** Which providers an operator has actually configured. */
export function configuredProviders(
  env: Record<string, string | undefined>
): ProviderConfig[] {
  return (Object.keys(PROVIDERS) as ProviderId[])
    .filter(id => {
      const prefix = id.toUpperCase();
      return Boolean(env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`]);
    })
    .map(id => PROVIDERS[id]);
}
