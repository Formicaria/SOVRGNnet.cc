# ADR 0004 — The identity provider brokers, it doesn't store passwords

**Status:** Accepted · August 2026
**Amends:** [ADR 0003](0003-central-identity.md)

## Context

ADR 0003 built sovrgnnet.cc as an identity provider holding email addresses,
password hashes, and recovery codes. It worked, and it was tested, and it had
two problems that only became obvious once it existed.

**Email was load-bearing and we'd chosen not to have it.** Verification gates
safe account linking — a server may only bind an identity to an existing local
account if the address is proven, or anyone could sign up with someone else's
email and inherit their account everywhere. Running without a mail provider
meant that path was permanently closed, and recovery codes became the *only*
way back into an account. Lose the codes, lose the account, no exceptions.

**And it made us a target worth attacking.** A service holding passwords for a
network of servers is a prize. The recovery flow, the reset tokens, the hashing
parameters — all of it security-critical, all of it ours to get right forever.

Google, Microsoft, GitHub, and Discord have already solved every one of these.
They verify addresses. They handle recovery, two-factor, breach detection, and
device management better than this project ever will.

## Decision

**The identity provider becomes a broker.** People sign in with Google,
Microsoft, GitHub, or Discord. It stores a mapping — "this provider account is
this subject" — and mints the same audience-bound tokens as before.

Nothing about the token format, the JWKS cache, the audience derivation, or
how servers verify changes. That work stands. What changes is where the
*human* proves who they are.

**A password remains optional**, not removed. It's the fallback for anyone who
wants no third party involved, and the insurance for anyone a provider locks
out. Accounts with no password simply have a null hash.

**Multiple providers may link to one account.** This is the important one:
Google alone means a Google suspension costs someone every SOVRGNnet server at
once. Two linked providers, or a provider plus a password, means it doesn't.

## Consequences

**Email verification comes for free.** Google and Microsoft attest addresses,
so safe automatic linking works without us sending a single message. GitHub
requires a second call to `/user/emails` and only its verified addresses are
used — the profile endpoint's email carries no verification signal and is
never trusted for this.

**The database gets small and boring.** No password hashes, no reset tokens.
A leak of the identities table reveals which third-party accounts map to which
subject — unpleasant, and it lets nobody sign in as anybody.

**We depend on companies, for sign-in.** That deserves stating plainly in a
project about not depending on companies. The mitigations are real but partial:
servers can refuse SSO entirely and use local accounts, a password can be set,
and several providers can be linked. It remains a dependency, in a place where
we previously had none.

**Provider suspension is now a failure mode.** Losing a Google account loses
every server signed into with it, unless something else is linked. The account
screen should push people toward a second provider, and it should say why.

**More surface, differently shaped.** Four OAuth flows instead of one password
form: state parameters, PKCE, four response shapes, four ways of expressing
"is this address verified." That last one is where the danger is, which is why
normalisation is a single tested function rather than four inline objects.

**Recovery codes stay, demoted.** They're a fallback for password accounts
rather than the only path. Nobody's account should now hinge on a piece of
paper.

## Notes from the implementation

`isProviderId` originally used `value in PROVIDERS`, which returns true for
`constructor`, `toString`, and `__proto__` — the `in` operator walks the
prototype chain. Those strings would then have indexed provider config and
been interpolated into URLs. Caught by a test that tried exactly those inputs;
it uses `Object.hasOwn` now. Worth remembering the next time a lookup is
guarded by `in`.
