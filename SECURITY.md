# Security

## Reporting a vulnerability

Email **security@formicaria.us**. Please don't open a public issue.

Include what you found and how to reproduce it. You'll get an acknowledgement,
and credit in the changelog if you'd like it.

## What this software does and doesn't protect

**A channel is plaintext unless somebody turned encryption on.** In a plaintext
channel — the default — messages are stored readable on the instance, and
whoever operates it can read everything. For a server you run yourself that's
usually you, which is the point. If you're on someone else's instance, they can
read your messages; if you run one for others, they deserve to know you can
read theirs.

**An administrator can encrypt a channel, permanently.** From then on it's
Megolm: keys live on members' devices and the instance stores ciphertext it has
no key for. Against an operator who reads the database, or whose backups leak,
or who is handed a subpoena, that works.

Three things it does not do, said here rather than discovered later:

- **Metadata stays readable** in every channel — membership, timing, who spoke.
- **The instance can still mint a Matrix device on your account**, because
  passwords here are derived from the app secret. It receives no room keys
  until one of your own devices verifies it, so the defence is real — and it
  ends with a person reading a dialog and deciding.
- **It needs a reachable homeserver and a wired appservice.** Without both the
  `e2ee` capability is false and the option isn't offered, because there'd be
  nowhere for your keys to live except the server.

Nothing in this project should be described as private in the way Signal is
private.

The full analysis — attacker capabilities, mitigations, and residual risk per
threat — is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Supported versions

Only the latest release. This is alpha software; there are no long-term
support branches.

## What's protected today

| Area | How |
|---|---|
| Passwords | scrypt, salted per account |
| Sessions | Signed JWT in an httpOnly, SameSite=Lax cookie (stateless — see gaps) |
| Brute force | 10 login attempts per IP+email per 15 minutes |
| Matrix tokens | Device-scoped, minted per client, memory-only in the browser and never persisted |
| Matrix sessions | Device-scoped and named; listable and individually revocable |
| Encrypted channels | Megolm; keys on devices, ciphertext on the instance, index stores them content-blind |
| Room keys | Shared only with cross-signed devices — an unverified device receives none |
| Key recovery | Recovery key + server-side key backup, both encrypted to a key the instance never sees |
| Desktop credentials | OS keychain, not browser storage |
| Authorization | Role checked server-side on every mutation |
| File access | Streamed through the app with membership checks |
| Homeserver signup | Disabled outright; accounts created via shared secret |
| Identity tokens | Ed25519, audience-bound to one instance, 5-minute life |
| Admin APIs | Homeserver, IPFS, and Postgres bind to loopback only |

## Known gaps

Stated plainly rather than omitted:

- **Encryption is off by default and per channel**, and metadata is never
  encrypted
- **Sessions are stateless and last a year.** Logging out clears the cookie but
  does not invalidate the token; rotating `JWT_SECRET` is the only way to
  revoke, and it revokes everyone
- **The instance can log in as any of its users.** Matrix passwords are derived
  from the app secret, so the server can create a session for any account. In a
  plaintext channel it adds nothing — the operator can already read everything.
  In an encrypted one it is the sharpest remaining edge: the minted device gets
  no keys until somebody verifies it, and somebody might
- **Setting up cross-signing requires the instance's cooperation**, because the
  key upload is auth-gated and only the instance knows the derived password.
  The private keys never leave your browser and the password never enters it,
  but the instance could substitute its own keys at that moment — visibly, as
  an identity change your contacts' clients report
- **The browser's crypto store is unencrypted at rest.** Anything that can read
  the browser profile can read past message keys. The access token is not
  stored, so it cannot read a live session
- No two-factor authentication for local accounts
- Backups are not encrypted at rest
- No rate limiting beyond login
- No audit log of administrative actions
- No independent security audit

Mechanism-level detail is in
[docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md).

## If you run an instance for other people

You are the security boundary. Concretely:

- **Tell people you can read their messages.** Not doing so is the one failure
  this project would be embarrassed by.
- **Guard your backups.** Each contains every message and every secret.
- **Keep the machine patched.** `apt upgrade` for the system, `sovrgnnet
  update` for the app. Dendrite is built from source and updates separately.
- **Guard the signing keys.** The homeserver's `matrix_key.pem` is its identity
  on the Matrix network; the identity provider's signing key, if you run one,
  can mint tokens for any account.

## Dependencies

Infrastructure images are pinned to explicit versions rather than `latest`, so
an install is deterministic and upgrades are deliberate. Application
dependencies are audited for actual use — the tree is intentionally small.
