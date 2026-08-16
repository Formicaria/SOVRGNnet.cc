# Architecture decision records

Why the architecture is the way it is, including the parts that were later
reversed. A decision without its reasoning is indistinguishable from an
accident, and the reversed ones are the most useful to keep — they record what
was tried and what it cost.

| # | Decision | Status |
|---|---|---|
| [0001](0001-multi-server-client.md) | The client connects to multiple independent instances; E2EE becomes core | Accepted |
| [0002](0002-windows-bundled-server.md) | Ship the Windows server on WSL2 | **Superseded by 0005** |
| [0003](0003-central-identity.md) | One optional account across instances, at sovrgnnet.cc | Accepted |
| [0004](0004-identity-broker.md) | The identity service brokers Google/Microsoft/GitHub/Discord rather than storing passwords | Accepted |
| [0005](0005-desktop-hosts-a-server.md) | The desktop app hosts a server, bundled, no WSL2 | Accepted |
| [0006](0006-dendrite-replaces-conduit.md) | Dendrite everywhere; Conduit removed | Accepted |
| [0007](0007-protocol-versioning.md) | The protocol is versioned separately from the application | Accepted |
| [0008](0008-client-side-matrix.md) | The client owns its Matrix session, in four stages — reverses the proxy chosen in 0001 | Accepted, all four shipped |
| [0009](0009-appservice-ingest.md) | Matrix becomes the source of record; the database becomes an index built from it | Accepted |
| [0010](0010-federated-senders.md) | The index holds senders with no local account | Accepted |
| [0011](0011-crypto-machine.md) | matrix-js-sdk owns the client session; cross-signing setup goes through the instance | Accepted |

## The through-line

Every one of these is a consequence of the same commitment, which is worth
stating once:

> If Formicaria disappeared tomorrow, someone already operating an instance
> could keep running their server, keep talking to their users, keep restoring
> their backups, and keep control of their identity and data.

0001 exists because a client tied to one instance makes that instance's
operator a landlord. 0003 and 0004 exist because identity is the easiest place
to accidentally become a dependency, so the identity service is optional, off
by default, deploys separately, and serves cached keys through its own outages.
0005 and 0006 exist because software nobody can install isn't sovereign, it's a
demo. 0007 exists because instances that must track our releases to stay usable
are downstream of us in a way that undoes the rest.

## Writing one

Context, decision, consequences. State the alternatives and why they lost.
Record what a decision costs, not only what it buys — an ADR that reads as
unambiguously correct is usually hiding the trade-off.

When a decision is reversed, mark the old one superseded and say what changed.
Deleting it loses the reasoning that made the reversal necessary; 0002 is
retained for exactly that reason.
