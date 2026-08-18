# Dependency advisories

**Last triaged:** 2026-08-17, against `pnpm audit --prod` at v0.6.0.

`pnpm audit --prod` reported **43 advisories** — 18 high, 22 moderate, 3 low.
After this pass it reports **8**: 3 high, 3 moderate, 2 low.

A count is not a finding, and "18 high" had sat in the audit list long enough to
become wallpaper. This document exists so the remaining eight are *decisions*
rather than a number nobody has read.

## What was removed, and why that was most of it

**26 of the 43 were `axios`**, and one file imported it: an `IPFSContext`
nothing ever consumed. `useIPFS` had no callers; only the provider was mounted.

Deleting it was a security fix, not a cleanup. The code it carried would have:

- POSTed **plaintext** file bytes to `http://localhost:5001/api/v0/add` — Kubo's
  unauthenticated admin API, over plain HTTP — bypassing both the client-side
  encryption from task #17 and `/api/upload` entirely;
- defaulted `IPFS_GATEWAY` to `https://gateway.pinata.cloud/ipfs`, a third-party
  public gateway, in a project whose whole claim is that your data sits on
  hardware you or someone you trust owns.

Neither was reachable, because nothing called it. Both were one `useIPFS()` away
from being reachable, in a file that looked like working infrastructure.

Removing it also took `form-data` and `follow-redirects` with it, which were
transitive through axios: **28 advisories for one deletion.**

Five more unused shadcn/ui scaffold components went the same way — `chart`,
`carousel`, `drawer`, `input-otp`, `resizable` — with zero importers between
them. `chart` was pulling `recharts`, and `recharts` was pulling the three
`lodash` advisories. `recharts` 2.x is also end-of-life upstream.

`server/dependencies.test.ts` asserts all six stay out of `package.json` and
un-imported, so re-adding one is a deliberate act.

## What was fixed by upgrading

| Package | From | To | Why |
| --- | --- | --- | --- |
| `drizzle-orm` | 0.44.5 | 0.45.2 | **High: SQL injection via improperly escaped SQL identifiers.** This one is ours — we use `sql` templates in `server/db.ts`, including the `WHERE NOT EXISTS` in `renameUser`. Not a theoretical dependency risk. |
| `@trpc/{server,client,react-query}` | 11.6.0 | 11.18.0 | High: prototype pollution in `experimental_nextAppDirCaller`. We don't use Next.js, so it isn't reachable — but it's a same-major bump, so there's nothing to weigh. |

> **Unverified locally.** These are `package.json` and lockfile changes. The
> installed tree in this working copy is still the old one, so the test suite
> has not actually executed against drizzle 0.45. `pnpm install` followed by
> `./scripts/e2e.sh` is what turns that into a verified claim — drizzle is
> pre-1.0 and its minors have broken query builders before.

## What remains, and why

### `path-to-regexp` — high, ReDoS. Via `express@4`

### `qs` — moderate ×2, low ×1, DoS. Via `express@4`

### `body-parser` — low, DoS on invalid content-length. Via `express@4`

Five of the eight are one root cause: **Express 4**. Express 5 fixes all of
them, and it is a genuine migration — routing, `req.query` parsing, error
handling and the removal of several patterns this codebase uses all change.

**Surveyed, and the surface is smaller than expected.** Every breaking change
in Express 5 was checked against this codebase:

- **Route patterns** — the big one, and the survey got it wrong. Two
  `app.use("*", …)` SPA fallbacks live in `server/_core/`, which the grep
  behind this list did not reach: it searched `server/*.ts`, and the app is
  created a directory deeper. path-to-regexp v8 requires wildcards to be
  named, so a bare `*` throws at registration with `Missing parameter name at
  index 1: *`.
  
  Nothing caught it except the end-to-end stage. It typechecks, all 1007 unit
  tests pass, the image builds — and then the app never finishes starting, so
  the container is up and the healthcheck simply never goes green. Both are
  now `app.use(handler)` with no path, which has always meant the same thing
  and keeps the pattern out of path-to-regexp's hands entirely.
  `server/deployment.test.ts` walks every `.ts` in the repository for this
  now, rather than a directory somebody guessed at.
- **`req.body` is `undefined` rather than `{}`** when no body was parsed. Every
  access is already either `req.body?.x` or `schema.safeParse(req.body)`, and
  zod's `safeParse(undefined)` fails cleanly rather than throwing.
- **Removed APIs** — no `res.sendfile`, `app.del`, `req.param()`,
  `res.redirect("back")`, or two-argument `res.send`/`res.json` anywhere.
- **`req.query` is a getter** — never assigned to.
- **`res.status()` throws on invalid codes** — one dynamic call site,
  `res.status(ready ? 200 : 503)`, both valid.
- **`express.urlencoded`** — not used at all.

So the migration is a version bump plus a full run of the suite, rather than a
rewrite. Not taken in this pass only because it wants a clean install and an
unhurried verification across all three workspaces, not because it is risky.

Doing it badly is how a routing change
quietly opens an endpoint, and every one of these five is a denial of service
against a self-hosted instance the operator can restart — a real cost, but a
recoverable one, and much smaller than an authorisation bug introduced while
rushing. **This is the largest single remaining item and should be its own task
with the harness run against it.**

Route patterns here are literal paths and one `:param` each, which is not where
the `path-to-regexp` ReDoS lives (it needs nested quantifiers in a pattern), so
the high severity overstates our exposure.

### `nanoid` — high, infinite loop on negative size

Not reachable. Every call site passes a positive integer literal or nothing:
`nanoid()`, `nanoid(8)`, `nanoid(10)`, `nanoid(16)`. The loop needs a *negative*
size, which needs the size to come from somewhere we don't control.

We stayed on nanoid 5 rather than take a major bump for an unreachable bug — and
because that argument is about our call sites rather than the library, it can
stop being true in a commit about something else. `server/dependencies.test.ts`
fails if any `nanoid(...)` call takes anything but a literal.

### `ws` — high (memory-exhaustion DoS), moderate (uninitialized memory disclosure). Via `wagmi` / `viem` / `@rainbow-me/rainbowkit`

Wallet connectivity, in the browser, and genuinely used (`Web3Context`). Both
advisories describe a WebSocket **server** accepting hostile frames; `ws` here is
a **client** talking to an RPC endpoint the user's own wallet config chose. The
attacker would have to be the RPC provider, who has better options.

Bumping means moving the wagmi/rainbowkit/viem trio together, and there is
already an unmet peer range in the tree (`rainbowkit@2.2.10` wants
`wagmi@^2.9.0`, we're on `3.5.0`). Worth doing as one deliberate change rather
than folded into a security pass.

## How to re-run this

```sh
pnpm audit --prod
```

If the count changed, this file is out of date. Advisories are added to the
database for versions that were already installed, so a number moving does not
mean anything was upgraded — check what's new before assuming a regression.

## The honest summary

Most of what an audit reports on a project like this is not risk, it is
**inventory**: packages nobody chose, arriving with scaffolding, shipped because
removing them was never anyone's task. The 28 advisories that vanished with
`axios` were never exploitable — but the file holding them would have leaked
plaintext to a third party the first time someone wired up a button to it, and
that is worth more than the advisory count it was inflating.

What's left is five Express-4 denial-of-service issues awaiting a migration that
deserves care, one unreachable loop with a test pinning the reachability
argument, and two `ws` issues in the wrong direction to matter. None of it is
remote code execution, none of it touches the cryptography, and none of it is
being described here as smaller than it is.
