# ADR 0012 — Renaming changes the username, not the Matrix ID

**Status:** accepted
**Date:** 2026-08-16
**Supersedes nothing. Depends on:** ADR 0010 (federated senders)

## Context

Task #29 made the username the identity column, and #31 made it the Matrix
localpart, so `alice` gets `@alice:example.org` instead of `@sovrgn_7:example.org`.
That is a real improvement — the identifier people see is now one they chose.

It also creates a problem the old opaque scheme did not have. Once a username is
visible and meaningful, people will want to change it. Deadnames, harassment,
a name picked at sixteen, a typo noticed a week later. "You may never change
this" is not an acceptable answer for a chat application, and it is especially
not acceptable for the subset of people whose reason for asking is safety.

**Matrix has no rename.** A localpart is fixed at registration, permanently.
There is no endpoint, no admin override, no migration path in the specification.
This is not a Dendrite limitation; it is the protocol.

So the two facts are in direct conflict, and this ADR is about which one gives.

## The options

### A. Refuse renames

Consistent, and honest in the narrow sense that the username and the MXID never
disagree. But it means the software's answer to "I need to stop being called
this" is no, forever, because of an implementation detail of a protocol the
person never chose. Rejected.

### B. Rename by registering a new Matrix account

Change the username, provision `@new:server`, and move the person over.

This is the option that sounds correct, and it is the one we spent the longest
on. What it actually costs:

- **Every room membership is lost.** Membership is per-MXID. `@new:server` has
  joined nothing. Restricted and invite-only rooms need a fresh invite, which
  needs someone with the power to issue it.
- **Power levels are lost, silently.** A moderator who renames stops being a
  moderator, and nothing in the flow would tell them until they tried to use a
  permission they no longer had.
- **Encrypted history stops being readable.** Megolm session keys are held by
  devices belonging to the old account. Recovering them means an explicit
  export and import, and any failure there is unrecoverable and permanent.
- **Already-sent messages still show the old ID.** They are stored, attributed,
  on every server that received them. Federation makes this irreversible in the
  strongest sense: the data is on machines we do not run.
- **Two accounts exist forever.** The old one cannot be deleted without
  breaking history, so the person now has two Matrix identities and other
  servers have no way to know they are the same person.

The last two are the ones that decide it. Even after paying the entire cost, the
old identifier is still visible on every message the person has already sent —
which is precisely what someone renaming for safety reasons is trying to
achieve. Option B is expensive, dangerous, and **does not deliver the thing the
person asked for.**

### C. Rename the username; leave the Matrix ID alone — *chosen*

`users.username` changes. `userProfiles.matrixUserId` does not, ever.

The person is `bob` here — in the member list, in mentions, in search, at the
sign-in prompt — and remains `@alice:example.org` to Matrix and to every
federated server.

## Decision

Option C, with the divergence disclosed rather than hidden.

`renameConsequences()` in `shared/username.ts` returns the facts as data. The
server hands them to the client from `auth.renamePreview`, and the confirmation
renders them. It says, in plain words, that the Matrix address stays as it is
and that already-sent messages keep the old name.

`auth.changeUsername` requires an `acknowledgedMatrixId: true` field. This is
**not** a security control — any API client can pass it. It is a constraint on
this codebase: a rename form cannot be added here without its author running
into the fact that there is something to tell the user.

## Consequences

### The username and the MXID can disagree, and that is now normal

Anything reading one and assuming the other is a bug. Concretely: for an account
that already exists, the Matrix localpart comes from the stored MXID via
`matrix.localpartOf()`, **never** from the current username.

This was already latent before renaming existed. Three call sites — device
login, UIA password challenge, device deletion — re-derived the localpart from
`ctx.user.username` at use time. They were correct only because nothing could
change a username yet. Under a rename they would have logged into an account
that does not exist, and the homeserver's `M_FORBIDDEN` says nothing about
usernames, so it would have read as a broken Matrix account rather than a stale
derivation. Fixed as part of this ADR.

`localpartForUsername()` still exists and is still correct — for *registration*,
where the username genuinely is the localpart being created. The two functions
are deliberately not merged, because the whole distinction is which moment you
are in.

### Federation shows the old identifier

ADR 0010 already notes that remote senders are displayed by MXID when no profile
is available. For a renamed account that MXID is the old name. We cannot fix
this; a remote server has no reason to trust a display name we assert. It is
listed in `docs/THREAT_MODEL.md` under what SOVRGNnet cannot do.

### Someone can take the old name

Releasing it is the correct default — holding names hostage to accounts that no
longer use them is its own problem — but it means an old link or invitation now
points at a different person. Stated in the confirmation.

### This is not a way to become unlinkable

A rename changes what this instance calls you. It does not erase history, does
not hide the previous name from anyone who saw it, and does not detach you from
the MXID that sent your old messages. Anyone renaming to escape something needs
to know that, which is why the disclosure names messages explicitly instead of
stopping at "your Matrix address stays the same".

If someone needs a genuinely fresh identity, the honest answer is a new account,
and we should say so rather than implying a rename does more than it does.

### If Matrix ever adds rename

MSC-level work on account migration has been discussed for years without
landing. If it lands, option B becomes viable and this ADR should be revisited —
the disclosure text, `renameConsequences()`, and the `localpartOf` split are all
in one place each, deliberately, so that revisit is small.
