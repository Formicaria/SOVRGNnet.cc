# SOVRGNnet identity provider

The service behind "sign up once, use it on every server." Runs on
sovrgnnet.cc. See [ADR 0003](../docs/adr/0003-central-identity.md) for why it
exists and what it costs — including the parts that argue against it.

## What it does

```
  person → sovrgnnet.cc      signs in, asks for a token for one server
  person → their server      presents the token
  server                     verifies the signature against a cached public key
  server                     finds or creates a local account for that subject
```

It issues short-lived Ed25519-signed tokens and publishes the public half at
`/.well-known/jwks.json`. It never sees a server's data, never holds a session
on anyone's behalf, and is not contacted when someone uses a server they're
already signed into.

## The three properties that matter

**A server that has cached the key can verify tokens with this service
completely unreachable.** That is the entire reason for public-key signatures
rather than a shared secret. An outage here blocks *new* sign-ins; it does not
log anyone out and does not take down a single server.

**Every token names one server and works only there.** Without that binding,
whoever runs one server could replay their users' tokens against every other
server on the network. The audience check is not optional and is tested.

**Servers can refuse this service entirely.** `INSTANCE_ALLOW_SSO=false` makes
an instance local-accounts-only and fully functional. Every instance also keeps
at least one local administrator, so no server can be locked out of itself by
something happening here.

## Account recovery

The hard part, and the reason most systems quietly lose people's accounts.

**Email reset** is the familiar path and the default. It also makes the mail
provider the root of account security: whoever controls the address controls
the account.

**Recovery codes** are the way back for someone who no longer controls their
email. Twelve characters in three groups, generated at signup, shown once.
They avoid `I`, `O`, `0`, and `1` because these get written on paper, and a
typed `O` is accepted where a `0` was meant. They're stored as hashes, so a
database leak here doesn't hand anyone a working code, and each is single-use.

**What recovery cannot do**, and must say so plainly at the point of use:

- It restores access to the *identity*, not to any server's local data.
- If a server has locally banned the account, recovery doesn't undo that.
- When end-to-end encryption ships, recovering an account will **not** recover
  message history. Keys live on devices. An identity is not a key backup, and
  implying otherwise would be the cruellest possible bug.

## Running it

```bash
cd identity
pnpm install
cp .env.example .env      # set IDENTITY_SIGNING_KEY and DATABASE_URL
pnpm dev
```

The signing key is an Ed25519 private key in PEM form. Generate one:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');\
const {privateKey}=generateKeyPairSync('ed25519');\
console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
```

Keep it out of the repository and out of backups that travel. Losing it
invalidates every token in flight — survivable, since they last five minutes.
Leaking it lets anyone impersonate any account on any server, which is not.

## Rotating the signing key

Key ids are derived from the key itself, so rotation is additive:

1. Add the new key; publish **both** in JWKS
2. Start signing with the new one
3. Wait longer than the token lifetime plus however long servers cache JWKS
4. Remove the old key

Skipping the overlap breaks every token in flight at once. There are tests for
both halves of this — old keys accepted while published, refused once
withdrawn.

## What isn't built yet

The HTTP service itself: registration, sign-in, the token endpoint, the JWKS
route, and email delivery. What exists and is tested is the part where a
mistake is unrecoverable — token format, signing, verification, and recovery
codes, in `shared/identity.ts` with 25 tests covering forgery, tampering,
replay across servers, `alg: none`, expiry, and clock drift.

Nothing here affects a running instance until the service exists and a server
sets `INSTANCE_ALLOW_SSO=true`.
