# The well-known files are the real delegation

A Matrix ID is `@zach:sovrgnnet.cc`. Everything that wants to reach that person
takes the part after the colon and asks **that host** where the homeserver
actually is. `sovrgnnet.cc` is this Pages site, so these two files are the
answer — for every client and every remote homeserver, always.

## The app has its own copy, and nothing ever reads it

`server/instanceRoutes.ts` serves `/.well-known/matrix/client` and
`/.well-known/matrix/server` too, and gates the second one on
`MATRIX_ALLOW_FEDERATION` with a good reason written next to it: advertising a
federation endpoint while refusing federated traffic invites other servers to
try and then fail.

That gate does not run for this deployment. The app answers on
`app.sovrgnnet.cc`; delegation is fetched from `sovrgnnet.cc`. Nobody asks the
app, so the switch it is guarding has no effect on what the world sees.

The app's copy is not dead code — it is the live delegation for anyone whose
`MATRIX_SERVER_NAME` *is* the hostname their app answers on, which is the
ordinary single-hostname install. It is simply bypassed whenever the server
name and the app's hostname differ, which is the shape sovrgnnet.cc uses.

So on a split-hostname deployment the federation switch lives in two places
that cannot see each other: `MATRIX_ALLOW_FEDERATION` on the instance, and
whether `matrix/server` exists in this directory. Keeping them in step is
manual. That is the honest description, and `scripts/check-site.sh` checks
what it can.

## client

Always present. It tells a Matrix client which homeserver to log in to, and
that is true whether or not this server talks to any other.

```json
{ "m.homeserver": { "base_url": "https://matrix.sovrgnnet.cc" } }
```

## server

**Absent on purpose while federation is off.**

This file exists to tell other homeservers where to send federated traffic.
Dendrite currently runs with `disable_federation: true`, so anything that
followed it would be told exactly where to go and then refused — the failure
the app's gate was written to avoid, arriving by a route the gate cannot see.

When `MATRIX_ALLOW_FEDERATION=true` is set on the instance and Dendrite has
been restarted, create `server` in this directory containing:

```json
{ "m.server": "matrix.sovrgnnet.cc:443" }
```

Then confirm it end to end, which is the part worth not skipping:

```bash
curl -s https://sovrgnnet.cc/.well-known/matrix/server
curl -s https://matrix.sovrgnnet.cc/_matrix/key/v2/server | head -c 200
```

The second one returning `M_UNRECOGNIZED` means federation is still off and
the file is lying again. `/_matrix/key/v2/server` is part of the federation
API, so a homeserver with federation disabled correctly refuses to serve it —
which makes it the exact check for whether this file should exist.

## Cache lifetime

`_headers` sets one hour on `/.well-known/matrix/*`. Long enough to be cheap,
short enough that turning federation on becomes visible the same afternoon
rather than whenever a remote server next decides to look.
