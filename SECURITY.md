# Security

## Reporting a vulnerability

Email **security@formicaria.us**. Please don't open a public issue.

Include what you found and how to reproduce it. You'll get an acknowledgement,
and credit in the changelog if you'd like it.

## What this software does and doesn't protect

**Channels are end-to-end encrypted by default.** Every channel created on an
instance that can support it is Megolm-encrypted from the moment it exists,
with no switch to find. Keys live on members' devices, the instance stores
ciphertext, and file contents are encrypted in the browser before upload.
Against an operator who reads the database, or whose backups leak, or who is
handed a subpoena, that works.

**"Can support it" is about the deployment, not the software.** It needs a
homeserver clients can actually reach and a wired appservice — without both,
there is nowhere for your keys to live except the server, so the `e2ee`
capability is false and channels are plaintext. The default LXC install is like
this. On such an instance, and in any channel created before this became the
default, messages are readable by whoever operates the server.

Three things encryption here does not do, said now rather than discovered later:

- **Metadata stays readable** in every channel: membership, timing, who spoke,
  filenames, file sizes, reactions. With contents encrypted everywhere, this is
  the whole of what an operator sees — and it is not a little.
- **The instance can still mint a Matrix device on your account**, because
  passwords here are derived from the app secret. That device **does receive
  room keys** — withholding them from unverified devices makes encrypted
  channels unreadable for everyone, so it was tried and reverted. It shows up
  in your device list as unverified, and noticing it is the whole defence.
- **Lose every device without a recovery key and the messages are gone.** The
  app asks you to set one up the first time it can, and you can decline.

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
| Encrypted channels | Megolm, on by default; keys on devices, ciphertext on the instance, index stores them content-blind |
| Attachments | AES-CTR in the browser before upload; key travels in the encrypted event, hash checked before decryption |
| Device trust | Cross-signed devices inherit their owner's verification, so verifying is per-person; unverified devices are listed first and flagged |
| Key recovery | Recovery key + server-side key backup, both encrypted to a key the instance never sees |
| Desktop credentials | OS keychain, not browser storage |
| Authorization | Role checked server-side on every mutation |
| File access | Streamed through the app with membership checks |
| Homeserver signup | Disabled outright; accounts created via shared secret |
| Identity tokens | Ed25519, audience-bound to one instance, 5-minute life |
| Admin APIs | Homeserver, IPFS, and Postgres bind to loopback only |

## Known gaps

Stated plainly rather than omitted:

- **Metadata is never encrypted** — membership, timing, filenames, reactions —
  and channels on an instance that can't offer e2ee are plaintext throughout
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
