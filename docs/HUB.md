# The hub — app.sovrgnnet.cc

One page, signed in with the SOVRGN account, showing every server that
account has access to — each one click from being inside it. Served by the
**identity service** on a second hostname; there is no separate hub codebase,
build, or box. Like the identity service itself, it deploys from this repo to
private infrastructure and is not part of the public release artifacts.

## What it is, honestly

A launcher, not a client. Each server still serves its own chat UI at its own
address; the hub is where you see them all and enter any of them without a
second login. The single-pane version — every server's channels rendered in
one page — is a different architecture (per-server auth, CORS on every
authenticated API, one sync engine per server) and is deliberately not
claimed here.

The list is the **grants table**: an observation log of where this account
has actually signed in. A server you've never signed into doesn't appear —
that's what "add a server" is for, and why the first sign-in to any server
still asks you to pick a username there (that name becomes a permanent
Matrix ID; the hub doesn't get to choose it for you).

## How sessions cross hostnames

Cookies are per-host. A session on `id.sovrgnnet.cc` is invisible on
`app.sovrgnnet.cc` even though one process serves both, and the two obvious
fixes are both worse: `Domain=.sovrgnnet.cc` hands the session cookie to
every subdomain forever, and cross-origin credentials means CSRF machinery
on a service that currently needs none.

So the id host mints a one-time code (`hubHandoffs`: hashed at rest, sixty
seconds to live, deleted on redemption — the device-flow discipline) and
redirects to `app…/hub/complete?code=…`, which redeems it for a session on
the hub's own hostname. Sign-in itself, including every OAuth provider,
always happens on the id host, because that is where the provider consoles
point their redirect URIs.

Entering a server is the existing `/authorize` mint — the hub holds no
per-server credentials and never talks to a server itself. The one exception
runs in the visitor's own browser: "add a server" reads the target's public,
unauthenticated `/api/instance` descriptor (CORS-open by design) to show
what it is before anyone signs in. The service deliberately never proxies
that probe — resolving arbitrary typed-in addresses server-side is an SSRF
surface.

## Deploying it

On the id box, after an ordinary identity deploy:

```bash
cd /opt/sovrgnnet/identity
echo 'HUB_PUBLIC_URL=https://app.sovrgnnet.cc' >> .env
pnpm exec drizzle-kit migrate        # adds hubHandoffs
pnpm build && systemctl restart sovrgnnet-identity
```

Then point the hostname at the same service: in the Cloudflare tunnel
config, add `app.sovrgnnet.cc` as a public hostname routed to the identity
service's port, exactly like `id.sovrgnnet.cc`. Anything previously
answering on `app.sovrgnnet.cc` needs a new name first.

Unset, `HUB_PUBLIC_URL` disables nothing visible: the hub still exists at
`/hub` on the identity host, and the handoff never fires because there is no
hostname to cross. That is the arrangement every dev setup and the test
suite run in.

## What's deliberately not here yet

An **owner badge**. Identity has no concept of server ownership, and the
secure signal doesn't exist yet: a public "is X an admin?" endpoint is an
enumeration oracle, and minting tokens to every listed server on page load
would hand fresh credentials to any server you ever visited. Ownership
arrives with the desktop first-run claim flow, where identity legitimately
participates in the moment a server gets its admin.
