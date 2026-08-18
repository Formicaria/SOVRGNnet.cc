# Third-party sign-in: setting up the providers

The identity service brokers sign-ins through Google, Microsoft, GitHub, and
Discord. The code ships in every install; **a provider appears on the sign-in
pages only when its credentials are configured**, so this document is the
whole distance between "the button doesn't exist" and "it works".

Each provider needs two things created in their console: an OAuth app, and
its **redirect URI**, which for the production identity service is always:

```
https://id.sovrgnnet.cc/oauth/<provider>/callback
```

with `<provider>` one of `google`, `microsoft`, `github`, `discord`. Get the
URI wrong and the provider refuses at their end with their own error page —
nothing in our logs will explain it.

## Google

1. https://console.cloud.google.com → create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: External, app name "SOVRGN",
   your support email. Scopes: `openid`, `email`, `profile` (non-sensitive —
   no verification review needed). Publish the app; in Testing mode only
   listed test users can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   type *Web application*, authorized redirect URI
   `https://id.sovrgnnet.cc/oauth/google/callback`.
4. Copy the client ID and secret into the env (below):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## GitHub

1. https://github.com/settings/developers → **OAuth Apps → New OAuth App**
   (a plain OAuth App, not a GitHub App — simpler and sufficient).
2. Homepage `https://sovrgnnet.cc`, callback
   `https://id.sovrgnnet.cc/oauth/github/callback`.
3. Generate a client secret. → `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

GitHub's profile endpoint returns only the public email, usually null; the
service fetches `/user/emails` and uses the primary **verified** address. An
account with no verified email at GitHub can't create a SOVRGN account, and
the error page says so.

## Microsoft

1. https://entra.microsoft.com → **App registrations → New registration**.
2. Supported account types: *Accounts in any organizational directory and
   personal Microsoft accounts* — this is what makes personal @outlook.com
   sign-ins work; the default (single tenant) silently refuses them.
3. Redirect URI: platform *Web*,
   `https://id.sovrgnnet.cc/oauth/microsoft/callback`.
4. **Certificates & secrets → New client secret** — note it expires (max 24
   months); put a reminder somewhere that outlives the person setting it up.
   → `MICROSOFT_CLIENT_ID` (the *Application (client) ID*),
   `MICROSOFT_CLIENT_SECRET` (the secret's *Value*, not its ID).

## Discord

1. https://discord.com/developers/applications → **New Application**.
2. **OAuth2** page: add redirect
   `https://id.sovrgnnet.cc/oauth/discord/callback`.
3. → `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` (Reset Secret to see one).

## Deploying to the id box

The identity service reads the credentials from its environment. On the LXC:

```bash
# on the id container
cat >> /opt/sovrgnnet/identity/.env <<'EOF'
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
EOF
chmod 600 /opt/sovrgnnet/identity/.env
systemctl restart sovrgnnet-identity
```

Configure any subset — one provider is a perfectly good start (GitHub is the
fastest to set up). The sign-in, register, and device pages show buttons for
exactly the configured set and nothing for the rest.

## Verifying it worked

From a browser (not curl — CORS and cookies are the product here):

1. `https://id.sovrgnnet.cc/device` → the sign-in page shows
   "Continue with …" for each configured provider.
2. Click one, approve at the provider, land back at the device page signed
   in. First time through, an account is created from the provider's
   **verified** email; there is deliberately no password on it.
3. Sign out, sign in again with the same provider — same account, no
   duplicate. `/api/me` shows the subject.

Two refusals that are correct behaviour, not bugs: a provider account whose
email matches an existing SOVRGN account is told to sign in the old way and
link from settings (anything else is an account takeover via whichever
provider asserts an address); and a provider account with no verified email
can't create an account at all.

## What this changes about the trust story

Nothing that wasn't already documented: the identity service holds a mapping
from provider identity to subject, never a provider credential. What it adds
is honest to say out loud — for provider-only accounts, **account recovery is
the provider's**. Losing the Google account loses the SOVRGN account unless a
second provider or a password was linked first, which is why linking exists.
