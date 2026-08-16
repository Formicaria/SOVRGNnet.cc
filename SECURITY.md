# Security

## Reporting a vulnerability

Email **security@formicaria.us**. Please don't open a public issue.

Include what you found and how to reproduce it. You'll get an acknowledgement,
and credit in the changelog if you'd like it.

## What this software does and doesn't protect

**Messages are not end-to-end encrypted.** They are stored as plaintext on the
instance. Whoever operates it can read everything. For a server you run
yourself that's usually you, which is the point — but if you're on someone
else's instance, they can read your messages, and if you run one for others,
they deserve to know you can read theirs.

End-to-end encryption is the next architectural milestone. Until it ships,
nothing in this project should be described as private in the way Signal is
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
| Matrix tokens | Held server-side; never sent to a browser |
| Desktop credentials | OS keychain, not browser storage |
| Authorization | Role checked server-side on every mutation |
| File access | Streamed through the app with membership checks |
| Homeserver signup | Disabled outright; accounts created via shared secret |
| Identity tokens | Ed25519, audience-bound to one instance, 5-minute life |
| Admin APIs | Homeserver, IPFS, and Postgres bind to loopback only |

## Known gaps

Stated plainly rather than omitted:

- No end-to-end encryption
- **Sessions are stateless and last a year.** Logging out clears the cookie but
  does not invalidate the token; rotating `JWT_SECRET` is the only way to
  revoke, and it revokes everyone
- No per-device session revocation
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
