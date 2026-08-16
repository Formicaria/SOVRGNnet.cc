# Changelog

## Unreleased

**Matrix becomes the source of record (ADR 0009).** The instance registers as
an application service with its homeserver and ingests pushed events into the
database — which turns the database from a ledger written beside Matrix into
an index built from it. Ingest is hs_token-authenticated (403 + log on
failure, 404 while unconfigured), idempotent by event id, acknowledges
transactions wholesale so one bad event can't wedge the queue, and stores
`m.room.encrypted` as a content-blind row — E2EE's shape, implemented and
tested before any ciphertext exists. A new `eventIngest` capability reports
it, and clients author messages over their own Matrix session only when
`clientMatrix && eventIngest`, falling back to the API path otherwise —
because a directly-sent message an instance can't record would be invisible
to members on the polling fallback. Registration template in
`dendrite/appservice.yaml.template`; threat model gains T19 (forged
transactions) with its mitigations.

**Direct Matrix sync (ADR 0008 stage 3).** On instances that advertise
`clientMatrix`, the client now obtains its own device-scoped Matrix session
over the authenticated instance API and long-polls `/sync` directly — messages
and file shares arrive when they happen instead of on a 3–5 second poll. The
sync engine is ~150 dependency-free lines with an injectable fetch, tested
against a scripted homeserver; matrix-js-sdk waits for stage 4, where its
crypto earns the bundle weight. Uploads emit an `m.file` room event so files
announce themselves on the stream. Device ids persist per browser so reloads
replace the same session rather than minting anonymous devices; access tokens
stay in memory only, and a revoked device stops the stream at the next request
(401 is treated as final). Instances without the capability keep the proxy and
the polling fallback, unchanged. T8 in the threat model rewritten to match —
"tokens never reach the browser" is no longer claimed, because it is no longer
true.

## v0.4.1 — 2026-08-16

A patch release: the headline is that v0.4.0's Docker image could not start.
The device-session work and the site rebuild ride along.

**End-to-end verification, locally.** `pnpm preflight` runs in about 20 seconds
before a push; `pnpm preflight --full` stands up Postgres, Dendrite, Kubo and
the app under their own compose project, drives a full user journey through the
real HTTP API, takes a backup, verifies it, **drops the schema**, restores, and
confirms accounts, roles, communities, both users' messages and the file bytes
came back. `pnpm test:db` runs the 28 integration tests that skip themselves
without a database.

**It found six production bugs on its way to passing.** None were caught by 590
unit tests or by review, and four of them were invisible outside Docker —
because the native install was the only deployment anyone had ever actually
booted:

- **The production image could not start.** `index.ts` statically imported the
  Vite dev server; the runtime check was right but a static import resolves
  when the module graph loads. The `--prod` install has no `vite`, so the
  container died immediately.
- **`/ready` hung** whenever the homeserver was slow to start. The reachability
  probe had no timeout, and a readiness endpoint that never answers is worse
  than one reporting a failure.
- **`install.sh` never produced a usable signing key.** Its primary path wrote
  to a read-only bind mount that couldn't exist yet, and its fallback used
  `openssl genpkey`, which makes a valid PKCS#8 key that Dendrite rejects. So
  every Docker install produced a homeserver that refused to start.
- **There was no `.dockerignore`**, so `COPY . .` shipped 388 MB of host
  `node_modules` over the container's, along with the host's `dist/` and any
  `.env` — secrets into an image layer.
- **The generated homeserver config and signing key were not gitignored.**
  `matrix_key.pem` *is* the instance's Matrix identity; committing it lets
  anyone impersonate the server to everyone it has federated with. Never
  committed here, now ignored.

**Device-scoped Matrix sessions.** Logins carry a device identity, so sessions
are listable and individually revocable — closing a gap the threat model had
recorded as unfixed. The instance's own session is shown and flagged rather
than hidden, and refuses to be signed out, because removing it breaks every
operation the server performs on that account.

Which device belongs to the instance is now determined by asking the homeserver
rather than comparing against a constant. The constant only matched accounts
created through the login path; every account made by shared-secret
registration had a homeserver-named device, so the refusal never fired and the
server's session was removable. Found by the harness reading a live device list.

**T17: the instance can log in as any of its users.** Matrix passwords are
derived from the app secret, so the server can create a session for any
account. It adds nothing while messages are plaintext — the operator can
already read them — and becomes the sharpest edge the moment E2EE ships.
Documented before the claim rather than after.

**ADR 0008** records the plan to invert the Matrix proxy so the client owns the
session, which is a precondition for end-to-end encryption meaning anything.

**The public site has a new landing page, and the rest of the site now matches
it.** `site/index.html` is rebuilt around the SOVRGN mark and wordmark: a hero
split between the mark and a preview of the client, the five-part ownership
bar, the feature grid, an architecture diagram that puts your instance at the
centre, the install transcript, and the honest-status section. `/docs`,
`/legal.html` and `/404.html` pick up the same header, footer, palette and
iconography rather than staying on the old chrome, so the site reads as one
product end to end.

Two pages are new. `manifesto.html` states the six commitments the project can
be held to, starting from the one that matters — if sovrgnnet.cc disappeared
tomorrow, a correctly configured instance keeps running. `about.html` covers
what SOVRGN is, where v0.4.0 actually stands, and which of SOVRGN, SOVRGNnet
and Formicaria means what.

The preview and the diagram claim only what is built. There are no voice
channels in the client mock, because there is no voice; the bot's status card
says `Tunnel`, because that is what it is; and federation appears in the
architecture diagram as a dashed edge labelled *off by default, untested*,
because that is what it is. Every line of the install transcript is a line
`install.sh` really prints.

Still zero build and zero JavaScript. The mobile menu is a native `<details>`
disclosure, the SOVRGN and Formicaria marks are two SVG files, and the display
and monospace faces are vendored under `assets/fonts` with their SIL OFL
licences — about 82 kB, cached for a year — because `font-src 'self'` rules out
a hosted webfont. Nothing needs a `style` attribute and the
Content-Security-Policy is unchanged.

## v0.4.0 — 2026-08-15

The release that makes "sovereign" a property you can check rather than a word
in the README.

**The protocol is now versioned separately from the application.** Instances
are run by different people who upgrade on their own schedule. If they had to
track our releases to keep working with everyone else, every instance would be
quietly downstream of us — which is the dependency this project exists to
remove. Compatibility is one rule now: the same protocol major version.
Application versions never gate a connection.

**Capabilities are explicit and default to absent.** A client asks an instance
what it can do before offering a feature, and an instance that has never heard
of a capability reads as "doesn't have it" rather than "probably fine".
Optimistic defaults are how a client ends up offering something that silently
does nothing. When a feature is missing, the interface explains why instead of
hiding the button.

**Anyone can check another implementation.** `pnpm conformance <url>` verifies
the descriptor, version compatibility, capability negotiation, health
endpoints, and self-consistency — including whether an instance is claiming a
security property its architecture cannot provide. No credentials needed, so
it's safe to point at an instance you don't operate.

**Backups are portable and verified.** `.sovbackup` carries a manifest with the
schema version, protocol version, instance identity, and a checksum per
component. `sovrgnnet verify` answers "will this restore cleanly onto this
machine?" and changes nothing. `sovrgnnet restore` runs it first and refuses
rather than half-applying. The check that matters most is the Matrix server
name: restoring across a mismatch detaches every room from its history,
silently.

**Three ways restore quietly destroyed data.** Chat history was never
restored — the script looked for a file that stopped existing when Dendrite
moved to Postgres, while the real dump was taken faithfully and then ignored.
The homeserver signing key was backed up and never put back, so every restored
instance became a different server to anyone it had federated with. And native
installs couldn't restore at all, despite backups supporting them.

**`/ready` reported the database as healthy when there was none.** It called a
query that catches its own errors and returns null by design — right for
serving traffic on defaults, useless as a probe. A readiness check that cannot
fail is not a check, and an orchestrator would have routed traffic to a broken
instance indefinitely. Found by pointing the new conformance suite at a live
process, not by reading code that looks like it checks something.

**The desktop client can tell you what's wrong.** The shell shows each
instance's own UI in a webview, which goes blank when the instance breaks —
handing you a white rectangle exactly when you need information. A status panel
now runs outside the webview against the unauthenticated endpoints, names the
component that stopped rather than blaming the instance, and keeps working when
the failure is "I can't sign in".

**Security documented honestly.** A threat model with sixteen threats, a
security architecture describing mechanisms as built, and a reporting policy.
Writing them surfaced an undisclosed gap: sessions are stateless and last a
year, so logging out doesn't invalidate anything and the only revocation lever
signs out everyone. It's now in every gap list rather than left to be
discovered.

**Smaller and more deterministic.** Every infrastructure image pinned — no
`latest`, so two installs a month apart are the same software. Seventeen unused
dependencies removed after verifying each individually, including a `pnpm add
add` typo and a `pnpm` devDependency that conflicted with the `packageManager`
field.

**`shared/protocol.ts` has no dependencies.** It is the specification, and a
contract defined in terms of one language's schema library is one nobody can
implement in another language. A test holds that line now, because the same
class of mistake already shipped once and only surfaced during packaging.

Docs rewritten to match what exists: the architecture document still described
Supabase auth removed two releases ago and called Dendrite a Rust binary.
Terminology standardised — an *instance* is a deployment, a *community* is a
space inside one. The site stopped selling a Discord clone.

Tests: 208 → 473.

## v0.3.0 — 2026-08-15

**Dendrite replaces Conduit.** Conduit ships Linux binaries only, which made
bundling a server into the Windows and macOS desktop installers impossible.
Dendrite is Go, cross-compiles everywhere, and has complete Spaces support —
and Spaces are how communities are modelled, so Conduit's partial support was
disqualifying regardless. See [ADR 0006](docs/adr/0006-dendrite-replaces-conduit.md).

**One account across every instance, optionally.** Sign-in goes through Google,
Microsoft, GitHub, or Discord, so no password store exists to breach. It is off
by default; an instance that never enables it never contacts the identity
service at all. Instances verify tokens against a cached key and keep serving
stale keys through an outage, so the identity service going down blocks new
sign-ins but logs nobody out.

**The desktop app checks for updates on launch.** It bundles components whose
security fixes are ours to ship, and a version nobody installs is a fix nobody
gets. Security updates prompt every launch; routine ones weekly. A failed check
reports "unknown" rather than "up to date".

**Desktop sign-in uses device flow, not a redirect.** `sovrgn://` scheme
registration is unauthenticated on every operating system — any installed
application can claim it — so a redirect flow would hand a sign-in token to
whichever program got there first.

## v0.2.0 — 2026-08-15

The release that makes SOVRGNnet installable by someone who isn't a developer,
and usable as an actual community rather than a chat demo.

**Install it in one command.** `./install.sh` goes from `git clone` to a
running instance — generating every secret, building, starting, and printing
the URL. It asks one question: how people should reach you. One of the answers
gets you a public `https://` address **with no domain and no account
anywhere**. `scripts/install-lxc.sh` does the same with no Docker at all,
running everything as systemd services. `./sovrgnnet start|stop|status|url|
logs|backup|update` drives either install identically.

**The app migrates itself.** There is no migration step to forget — and the
one previously documented could never have worked, since `drizzle-kit` isn't
in the production image.

**Community features are real.** Roles enforced in one place across the whole
API, a member list with live presence, kick and ban mirrored onto Matrix,
message editing as a proper `m.replace`, reactions, typing indicators, and
per-server profiles so one account can be "Zach" in one community and
"chronus" in another.

**Security fixes that mattered.** IPFS's unauthenticated admin API was
published to the host, where anyone reaching it controlled the node — it and
the homeserver are loopback-only now. Homeserver registration is gated behind
a token. Federation defaults to off. The join policy was advertised and never
enforced, so a server its owner had closed still accepted anyone.

**And nobody was ever an administrator.** The installer promised the first
account would be admin; `adminProcedure` checked for the role; nothing ever
assigned it. Fixed, along with a settings screen so running a server doesn't
require SSH.

**Honesty fixes.** The login page claimed end-to-end encryption that does not
exist, and advertised NFT subscriptions, voice, and a soundboard that also do
not exist. Messages are plaintext on your own server, the interface says so,
and the site now separates what works from what's planned.

See below for the full detail.

## v0.4.1 — 2026-08-16

### Anyone can run this now

- **`./install.sh`** — one command from clone to running instance. Asks how
  people should reach you, generates every secret, builds, starts, and prints
  the URL. No domain, no Cloudflare account, no Docker knowledge required.
- **A public link with no signup anywhere.** The `quick` profile runs a
  Cloudflare Quick Tunnel: a real `https://` address in about a minute, no
  account and no port forwarding. Random and non-permanent by nature — the
  tradeoff for needing nothing at all.
- **`./sovrgnnet`** — `start`, `stop`, `restart`, `status`, `url`, `logs`,
  `backup`, `update`. The whole operational surface in plain words.
- **The app migrates itself.** On boot it waits for Postgres and applies
  pending migrations via drizzle-orm's runtime migrator. There is no longer a
  migration step to forget — and the old instructions could not have worked,
  since `drizzle-kit` is a dev dependency absent from the production image.
- **`scripts/install-lxc.sh`** — a second install with no Docker at all.
  PostgreSQL, Conduit, Kubo, and the app as plain systemd services, each under
  its own unprivileged user with `ProtectSystem=strict` and a single writable
  path. Built for a Proxmox LXC; works on any bare Debian or Ubuntu machine.
  Kubo's download is checksum-verified. See [docs/LXC.md](docs/LXC.md).
- **`sovrgnnet` drives either install.** It detects Docker vs. native and
  translates to `docker compose` or `systemctl`; `backup.sh` does the same.
  One set of commands regardless of how you installed.
- **[QUICKSTART.md](QUICKSTART.md)** — setup written for someone who has never
  done this before, including what to do when it goes wrong.

### Community features

- **Roles are enforced.** owner > admin > moderator > member, checked in one
  place and applied across the API. Admins manage channels and invites;
  moderators delete messages and remove people. Nobody can grant a role at or
  above their own, or moderate someone ranked equal or higher.
- **Member list** with roles, live online dots, and a moderation menu.
- **Kick and ban**, mirrored onto Matrix room membership. Bans are recorded
  app-side too, so a banned user can't stroll back in via discovery or an
  invite link.
- **Message editing** — sent as a proper Matrix `m.replace` so third-party
  clients render it correctly. Only ever your own messages; moderators can
  delete but never rewrite what someone said.
- **Reactions** — six quick emoji, toggled per user, stored on the message and
  echoed to Matrix as `m.annotation`.
- **Typing indicators and presence**, pushed to Matrix so Element sees them
  and tracked in-process for our own UI.
- Matrix power levels are kept in sync with app roles as a best-effort mirror;
  SOVRGNnet's own checks remain authoritative.

### Hardening

- **IPFS's admin API is no longer exposed.** Port 5001 was published to the
  host — anyone who could reach it controlled the node. It and the gateway
  are loopback-only now, as is Conduit's 8008.
- **Homeserver registration is gated** behind a generated token instead of
  standing open to the internet.
- **Federation defaults to off.** Your instance talks to nobody until you set
  `MATRIX_ALLOW_FEDERATION=true`.
- `MATRIX_SERVER_NAME` now actually reaches the app container. Without it,
  Matrix space links were being built with `localhost`.
- Log rotation on every service; nginx moved behind a `proxy` profile since
  the tunnel makes it redundant.
- `backup.sh` and `restore.sh` rewritten for Postgres — they were still
  calling `mysqldump` against a database that hasn't been MySQL for months.
  Restore is now interactive and picks up where a backup left off.

### Files

- File sharing over IPFS: uploads pin to the instance's own Kubo node;
  authenticated, membership-enforced upload/download routes; images inline
  and file cards in a unified channel timeline; paperclip + drag-and-drop.

### The pivot: a network of servers, not a website

Recorded in [ADR 0001](docs/adr/0001-multi-server-client.md) and
[ADR 0002](docs/adr/0002-windows-bundled-server.md). The short version: the
current design *cannot* have end-to-end encryption, because the app server
holds every user's Matrix token and reads every message in plaintext. Moving
keys into the client is the same change that makes a multi-server client
possible — one pivot, not two.

- **Instance identity** — `GET /api/instance` lets a server introduce itself to
  a client that has never seen it. The id is derived by hashing the Matrix
  server name rather than stored, so it survives a database restore and can't
  be forged without also taking the server name.
- **Invites name their server.** The old format was a bare code, which assumed
  you were already on the right instance — fine for one deployment, ambiguous
  the moment a client holds four. Now `https://host/invite/<code>` plus
  `sovrgn://invite/<host>/<code>` for the desktop hand-off. A bare code is
  explicitly rejected unless there's a server to resolve it against.
- **Connection layer** (`shared/connections.ts`, shared by web and desktop):
  probes a host *before* showing a login screen, so a typo produces "that isn't
  a SOVRGNnet server" rather than a password prompt on a stranger's website.
  De-duplicates by instance id, so the same box at a LAN address and later a
  domain stays one entry. Keeps unreachable servers rather than deleting a
  community because a laptop was shut for the night.
- **Host rail and add-server flow** — two steps, look then join, with
  encryption status stated plainly every time.
- **Tauri scaffold** (`desktop/`) — `sovrgn://` deep links including cold-start
  replay, single-instance focus, per-server credentials in the OS keychain.
- **The browser's honest limit:** sessions are httpOnly cookies scoped to one
  origin, so a page served by one server cannot authenticate against another.
  On the web this is an address book; switching hosts navigates there. The
  desktop client is what makes it a switchboard, and the UI says so.

### Server administration

- **Settings live in the database now**, not environment variables, so an owner
  can rename their instance or close registration from the client instead of
  over SSH. The environment remains the bootstrap default; stored values win.
- `admin.getSettings` / `updateSettings` / `listUsers` / `setUserRole`, as a
  normal authenticated API — administering a box in your closet from your
  laptop is the ordinary case, not a special one.
- **Fixed: nobody was ever an administrator.** The installer and QUICKSTART
  both promised "the first account you create becomes the admin."
  `adminProcedure` existed and checked `role === 'admin'`, but
  `createLocalUser` never assigned it — so the admin surface was unreachable on
  every instance ever created. First registration now takes the role, and an
  admin can't demote themselves out of existence.

### Website

- sovrgnnet.cc grew from one landing page into a real site: a docs section
  (installing, operating, architecture, security), a legal page covering the
  MIT licence, a privacy notice, and terms — with the distinction between *the
  software*, *the website*, and *your instance* made explicit, since the
  responsibilities differ for each.
- The landing page now reflects what actually shipped: one-command install, no
  domain or account required, and a plainly-worded section on what the project
  is *not* yet — starting with the absence of end-to-end encryption.
- Shared stylesheet, a 404 page, and security headers with a strict CSP
  (`default-src 'none'`). The site ships no JavaScript at all.

### Tests

- 55 passing, up from 23: permission ranking and moderation authority,
  typing/presence lifecycle including expiry.

## v0.1.0 — 2026-08-15 (alpha)

First working release: a self-hosted, Discord-style platform with real
text messaging over Matrix.

### Platform
- First-party email/password auth: scrypt password hashing, httpOnly JWT
  session cookies, login rate limiting. No third-party auth dependency.
- Matrix bridge: one homeserver account provisioned per user, tokens held
  server-side; servers are Spaces, channels are rooms, every message is a
  Matrix event on your own Conduit instance.
- Three-pane chat UI: server rail, channel list, live message pane with
  create/join/discover flows.
- Membership enforcement on every read and write; owner-only channel
  creation; public server discovery and join.
- PostgreSQL via Drizzle with a clean migration history.

### Infrastructure
- Single Docker Compose stack: app, Postgres 16, Conduit, IPFS (Kubo),
  nginx, optional cloudflared tunnel.
- Deployment architecture for sovrgnnet.cc: Cloudflare Pages landing site
  (with Matrix well-known delegation) + Cloudflare Tunnel to the homelab.
- GitHub Actions CI (typecheck, migrate, test against Postgres, build) and
  release image publishing to GHCR on tag.
- Static landing site in `site/`, zero-build, Pages-ready.

### Removed
- Manus scaffold residue, Supabase auth, MySQL compose configs, dead
  dependencies (js-ipfs, webtorrent, aws-sdk), network-dependent tests.

### Known limitations (route to roadmap)
- No E2EE yet — messages are plaintext on your own homeserver (Phase 6).
- Message updates poll every 3s; a push sync bridge is planned.
- No file sharing UI yet (Phase 3), no voice (Phase 6), no password reset.
