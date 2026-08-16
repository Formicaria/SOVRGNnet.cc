# Running the identity provider

Deliberately on its own machine, separate from any SOVRGNnet server. It's
small — a Node process and a Postgres database — but it's the thing every
server's sign-in depends on, and co-locating it with an instance means one
person's server going down takes identity with it.

It is **not** in the path of any conversation. Servers verify tokens against a
cached public key, so this being unreachable blocks new sign-ins and nothing
else. Nobody gets logged out, no server stops working.

## What it needs

- A small VM. 1 GB of memory is comfortable; this does very little work.
- PostgreSQL, its own database, separate from any server's.
- A hostname — `id.sovrgnnet.cc` — with TLS.
- Node 22.

## Setting it up

```bash
sudo apt update && sudo apt install -y postgresql git
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install -y nodejs
sudo corepack enable
```

```bash
sudo -u postgres createuser identity --pwprompt
sudo -u postgres createdb -O identity sovrgnnet_identity
```

```bash
git clone https://github.com/Formicaria/SOVRGNnet.cc.git /opt/sovrgnnet
cd /opt/sovrgnnet/identity
pnpm install
cp .env.example .env
```

Generate the signing key and put it in `.env`:

```bash
pnpm keygen
```

Then `pnpm db:push` and `pnpm build`.

## The signing key

The one secret here that genuinely matters.

**Losing it** invalidates every token in flight. Survivable — they last five
minutes — and you generate a new one, publish it, and carry on.

**Leaking it** lets anyone mint a token for any account, for any server on the
network. That is not recoverable by rotation alone: you'd have to rotate, and
then hope nothing was signed in the interim. Keep it out of git, out of
backups that travel, and off any machine that doesn't need it.

## Running without email

`MAIL_TRANSPORT=none` is a supported mode, chosen here to avoid depending on a
mail vendor. Two things become permanently true, and the service says both out
loud at startup and at signup:

**No address is ever verified.** A server will therefore never *automatically*
link a sovrgnnet.cc identity to an existing local account — someone with both
has to sign in locally and link deliberately. This is not a limitation to
engineer around: auto-linking on an unverified address is an account takeover,
since anyone could register with someone else's email and inherit their
account everywhere.

**Recovery codes are the only way back.** There is no reset link, and no
administrator who can help. If someone loses their password and their codes,
the account is gone.

That makes two endpoints load-bearing rather than optional:

- `GET /api/recovery-codes/status` — how many are left
- `POST /api/recovery-codes/regenerate` — a fresh set, current password required

Any client of this service should nag when the count gets low, and offer
regeneration somewhere obvious. Turning email on later is a config change and
changes nothing already stored.

## Systemd

```ini
[Unit]
Description=SOVRGNnet identity provider
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=identity
WorkingDirectory=/opt/sovrgnnet/identity
EnvironmentFile=/opt/sovrgnnet/identity/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Put TLS in front of it — Caddy, nginx, or a Cloudflare tunnel. It listens on
`:4000` and should not be exposed directly.

## Pointing servers at it

On each SOVRGNnet server:

```
INSTANCE_ALLOW_SSO=true
IDENTITY_ISSUER=https://id.sovrgnnet.cc
```

Both are opt-in. A server that sets neither accepts only local accounts and is
completely unaffected by anything here — which is the escape hatch that keeps
the sovereignty claim honest.

## Backups

`pg_dump` the database on a schedule, and keep the signing key somewhere
separate and offline. Restoring the database without the key leaves every
account intact but every issued token unverifiable until you publish a new key
— recoverable, but a bad hour.

## When you rotate the key

1. Generate a new one
2. Move the current value of `IDENTITY_SIGNING_KEY` into `IDENTITY_PREVIOUS_KEYS`
3. Put the new key in `IDENTITY_SIGNING_KEY`
4. Restart — JWKS now publishes both, and signing uses the new one
5. Wait out token lifetime plus JWKS cache time (an hour is ample)
6. Clear `IDENTITY_PREVIOUS_KEYS` and restart again

Skipping the overlap breaks every token in flight at once. Both halves of this
are covered by tests: old keys accepted while published, refused once withdrawn.
