# Roadmap — SOVRGNnet to production on sovrgnnet.cc

Decisions locked in: self-hosted Postgres, email/password auth first (wallet identity later, optional), SOVRGNnet branding, full stack on our own hardware behind sovrgnnet.cc.

The guiding rule: **a small thing that works end-to-end beats a large thing that doesn't.** v1 is text chat that actually sends and receives. Everything else follows.

A second rule earned the hard way: **software nobody can install isn't sovereign, it's a demo.** Running your own instance must not require a domain, an account with anyone, or knowing what Docker is.

## Phase 0 — Stabilize the foundation ✅ (August 2026)

Done: `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build` all pass locally; GitHub Actions CI runs the full gauntlet with a Postgres service container for integration tests (DB tests skip gracefully when no `DATABASE_URL` is set). Manus residue stripped — vite-plugin-manus-runtime, jsx-loc plugin, manusTypes, Map.tsx/map.ts (Forge API dead code), Forge/OAuth env vars — along with unused `js-ipfs`, `webtorrent`, and AWS SDK dependencies; lockfile re-resolved clean. Rebrand finished across UI, compose files, templates, and scripts. Dockerfile fixed (copied a nonexistent `client/dist`; client actually bundles into `dist/public`). Compose healthcheck switched to node (curl isn't in the Alpine image). Server now fails fast in production if its port is taken instead of silently hopping.

**Remaining (manual):** rotate/retire the exposed Supabase credentials; verify `docker compose up` end-to-end on the target host.

## Phase 1 — First-party auth ✅ (August 2026)

Done: Supabase Auth fully replaced with our own. `users` gained `passwordHash` (scrypt — no native deps) and a unique email; fresh Postgres migration history generated (the scaffold's old migrations were unusable MySQL files). tRPC `auth.register`/`login`/`logout`/`me` issue an HS256 session JWT in an httpOnly `SameSite=Lax` cookie; `authenticateRequest` verifies it and loads the DB user by integer id — the identity mismatch is fixed at the root. In-memory login rate limiting (10 attempts / 15 min per IP+email). Client got a thin `AuthContext` over tRPC; Supabase context, OAuth callback page, obsolete compose variants, and the `@supabase/supabase-js` dependency are gone. Also fixed along the way: a broken `drizzle.config.ts` and dead Google-OAuth login button. 19 unit tests pass (hashing, tokens, rate limiting, logout); full register→login→me→logout integration test lands with the Phase 2 DB test suite.

**Remaining (later):** password reset via email; wallet-signature login as an optional identity layer (post-v1).

## Phase 2 — Matrix bridge and real messaging ✅ (August 2026)

Done: server-side `matrixService` (REST client with injectable fetch) provisions one Matrix account per user on first use — deterministic localpart/password derived from the app secret, tokens held in `userProfiles.matrixAccessToken`, never sent to the browser. Servers are Spaces, channels are child rooms, `messages.send` goes through the homeserver and records the event id. Membership is enforced on every read/write; `servers.join` joins the space and all rooms. Dashboard is a real three-pane chat app (rail / channels / messages) with create, discover, and join flows. Integration test suite runs the full two-user flow (create → post → forbidden-before-join → join → post → permissions) against Postgres with a mocked homeserver.

**Deferred within phase:** live updates are 3-second polling for now; a `/sync`-backed SSE/WebSocket bridge replaces it in a later pass. E2EE stays in Phase 6.

## Phase 3 — Files and media ✅ (August 2026)

Done: `ipfsService` (Kubo API client, injectable fetch) pins uploads to our own node. REST routes move the bytes — `POST /api/upload` (session-authenticated, membership-checked, 50 MB cap) records the `fileShares` row; `GET /api/files/:cid` streams back through the app with membership enforcement, so no public gateway and no leaking CIDs to outsiders. tRPC keeps the metadata surface (`fileShares.listByChannel`, now membership-checked; the client-side create mutation was removed — REST is the only write path). Dashboard merges messages and files into one timeline: images render inline, other files get download cards; upload via paperclip button or drag-and-drop onto the channel.

**Deferred:** avatar uploads (needs profile UI first); WebTorrent for large files.

## Phase 3.5 — Anyone can run it ✅ (August 2026)

Not on the original plan, and it should have been. A sovereign network nobody can install is a demo.

Done: `./install.sh` takes someone from `git clone` to a running instance in one command — detects Docker, asks how people should reach the instance, generates every secret, writes `.env` (preserving secrets on re-run), builds, starts, and prints the URL. Four access modes: LAN-only, **Cloudflare Quick Tunnel — a public `https://` link with no account and no domain**, your own domain via tunnel token, or your own TLS behind nginx; wired to compose profiles `quick` / `tunnel` / `proxy`. `./sovrgnnet start|stop|restart|status|url|logs|backup|update` covers day-to-day operation. `QUICKSTART.md` is written for someone who has never done any of this.

The migration story was quietly broken: the documented `docker compose exec app pnpm db:push` could never have worked, because `drizzle-kit` is a dev dependency absent from the production image, and `drizzle/` was never copied into it. The app now waits for Postgres and applies pending migrations itself at startup via drizzle-orm's runtime migrator, with the SQL baked into the image. There is no migration step left to forget.

Also caught here: `MATRIX_SERVER_NAME` was never passed to the app container, so Matrix space-child links were being built with `via: ["localhost"]`.

A second install path landed alongside it: `scripts/install-lxc.sh` puts PostgreSQL, Conduit, Kubo, and the app on the machine as plain systemd services — no Docker, no nesting — each under its own unprivileged user with `ProtectSystem=strict`. Built for a Proxmox LXC, fine on any bare Debian box. `sovrgnnet` and `backup.sh` detect which install they're on and translate to `docker compose` or `systemctl` accordingly, so the command surface is identical either way. See [LXC.md](LXC.md).

**Deferred:** a Windows/macOS one-click bundle — the Tauri app in Phase 5.5 partly covers this.

## Phase 4 — Production deployment on sovrgnnet.cc

DNS for sovrgnnet.cc and matrix.sovrgnnet.cc; TLS via Let's Encrypt; nginx fronting app and homeserver with `/.well-known/matrix/{server,client}` delegation so federation and third-party Matrix clients work. Uptime monitoring and a staging compose profile.

Hardening is **done** ahead of the rest of this phase: IPFS's admin API (5001) and Conduit (8008) are loopback-only — 5001 was published to the host, and anyone who reached it controlled the node; homeserver registration is gated behind a generated token; federation defaults off behind `MATRIX_ALLOW_FEDERATION`; log rotation on every service; `backup.sh`/`restore.sh` rewritten for Postgres (they were still calling `mysqldump`).

**Exit criteria:** https://sovrgnnet.cc serves the app, a Matrix federation tester passes, backups restore cleanly.

## Phase 5 — Community features ✅ (August 2026)

Done: roles are real and enforced — owner > admin > moderator > member, ranked in one place (`server/permissions.ts`) and applied across the API. Admins manage channels and invites; moderators delete messages and remove people. Two guards do the work: `requireServerRole` for "at least this rank," and `requireAuthorityOver` for "strictly above the person you're acting on" — which is what stops two admins kicking each other in a loop, or a moderator demoting whoever promoted them. Nobody can grant a role at or above their own.

Kick and ban mirror onto Matrix room membership, with bans recorded app-side too so a banned user can't return through discovery or an invite link. Message editing goes out as a proper `m.replace` relation (your own messages only — moderators delete, never rewrite). Reactions toggle per user, stored on the message and echoed as `m.annotation`. Typing indicators and presence are pushed to Matrix so Element sees them, and tracked in-process for our own UI. A member list shows roles, live online dots, and the moderation menu. Matrix power levels are synced as a best-effort mirror; the app's own checks stay authoritative.

**Deferred:** per-channel permission overrides; audit log; timeout/mute as distinct from kick.

**Known limit:** presence and typing live in one process's memory. Correct for a single app container — which is the entire deployment story today — and would want Redis before running several.

---

# The pivot — August 2026

Everything above built a web application you self-host. That was the wrong shape, and [ADR 0001](adr/0001-multi-server-client.md) records the decision to change it.

The intended shape is a **network of independent servers** with a **desktop client that connects to several at once** — your LXC, a friend's box, a community's VPS — where you find a server by its ID but join by invite, conversations are end-to-end encrypted, and the owner configures their server from the client.

The load-bearing consequence: **the current design makes E2EE impossible.** The app server holds every user's Matrix token and proxies every message, so it reads everything in plaintext. Encryption can't be added to that — it's excluded by it. The keys have to move into the client, which is the same change that makes multi-server work. One pivot, not two.

What that costs is written down honestly in the ADR: the central permission check weakens, the homeserver has to become reachable, key management becomes a real user-facing problem, and the web app becomes a permanently less capable fallback.

## Phase 6 — Instance identity ✅ (August 2026)

Done: a server can introduce itself to a client that has never seen it. `GET /api/instance` returns product, API version, a stable instance id, display name, Matrix server name, join policy, and whether encryption is available — public, CORS-open, and carrying nothing about members or messages. The id is derived by hashing the Matrix server name rather than stored, so it survives a database restore and can't be forged without also taking the server name.

Invite links now name the server as well as the code: `https://host/invite/<code>` canonically, `sovrgn://invite/<host>/<code>` for the desktop hand-off. A bare code is now explicitly ambiguous and rejected unless there's a server to resolve it against — which is exactly the bug the old format hid. `GET /api/invite/:code` previews what you're joining before anyone types a password, exposing only the community's public face; missing and revoked codes return identically so codes can't be enumerated.

## Phase 7 — Desktop client shell 🚧

The connection layer is done and tested (`shared/connections.ts`, 23 tests): add a server by address, probe it before showing a login screen, de-duplicate by instance id so the same server at a new address stays one entry, reorder the rail, and refresh — keeping unreachable servers rather than deleting a community because a laptop was shut for the night.

The Tauri scaffold is in `desktop/`: window, `sovrgn://` deep links including cold-start replay, single-instance focus, and per-server credentials in the OS keychain. It currently loads each server's own web UI in a webview, which means it works against server versions older than itself — a property worth keeping until keys move client-side.

The client side landed too: `ConnectionsContext` owns the known-servers list, the rail grows a host strip above the community rail once you know more than one server, and an add-server dialog probes an address *before* saving it — two steps, look then join, so a typo produces "that isn't a SOVRGNnet server" rather than a password prompt on a stranger's website. Encryption status is stated plainly on that screen every time, because someone about to type a password deserves to know which kind of server they're looking at.

**The browser's honest limit:** sessions are httpOnly cookies scoped to one origin, so a web page at one server cannot authenticate against another. On the web this is an address book, not a switchboard — switching hosts navigates there. The desktop client is what turns it into real multiplexing, and the UI says so rather than pretending.

**Remaining:** sign-in per server in the desktop client, and replacing the webview with a native UI.

## Phase 7.5 — The desktop app hosts a server 🚧

On Windows, installing the app should mean you're hosting — not just connecting. [ADR 0002](adr/0002-windows-bundled-server.md) records how: **WSL2**, running the identical Linux stack, rather than a second homeserver implementation. Conduit ships Linux binaries only, and swapping to Dendrite on Windows would mean two config formats, two sets of quirks, and two upgrade paths forever — a permanent tax to serve the platform least likely to be hosting anything.

Done: settings moved out of environment variables into an `instanceSettings` table, with the environment as bootstrap defaults and stored values winning once an admin saves. `admin.getSettings` / `updateSettings` / `listUsers` / `setUserRole` give the client everything an owner would otherwise SSH in to change — as a normal authenticated API, so administering a box in your closet from your laptop is the ordinary case rather than a special one.

**Fixed here, and it was a real one:** the first account was documented as becoming the instance admin and never did. `adminProcedure` existed and checked `role === 'admin'`, but `createLocalUser` never assigned it — so no account on any instance was ever an administrator, and the admin surface was unreachable. First registration now takes the role, and an admin can't demote themselves out of existence.

Also fixed: **the join policy was advertised but never enforced.** `/api/instance` reported `open`/`invite`/`closed` and registration ignored all three, so a server its owner had deliberately closed still accepted anyone who found the address. Now enforced — with the bootstrap exception that matters, since the default is invite-only and without it a fresh install could never create its own first account. Closed means closed even for someone holding an old invite link.

A settings dialog in the client covers name, description, join policy, and directory listing, and states plainly that messages aren't encrypted and the administrator can read them.

**Remaining:** WSL2 provisioning from the installer, lifecycle supervision, LAN reachability (WSL2's NAT address changes across reboots), and surfacing backups somewhere visible in Windows rather than inside the distro.

## Phase 7.6 — One account across every server 🚧

[ADR 0003](adr/0003-central-identity.md) records the decision to have sovrgnnet.cc issue identities that any server accepts, and — unusually for an ADR — spends most of its length arguing against itself, because this is centralisation in the part of the system where it hurts most. The mitigations are the design: Ed25519 signatures verified against a **cached** public key so an outage blocks new sign-ins rather than logging anyone out, tokens bound to a single server so no operator can replay their users' tokens elsewhere, local accounts that keep working, and `INSTANCE_ALLOW_SSO=false` for anyone who wants nothing to do with it.

Done: the token format, signing, and verification in `shared/identity.ts` — shared deliberately, because the provider signs what every server verifies and two implementations of a signature format is how signature bugs are born. 25 tests covering forgery, payload tampering, cross-server replay, `alg: none`, expiry, clock drift, and key rotation overlap. Recovery codes with confusable-character avoidance, forgiving normalisation, hashed storage, and single-use consumption. The provider's schema, kept deliberately ignorant of memberships.

**Per-server profiles** landed alongside: one identity, but "Zach" in one community and "chronus" in another, resolved in a single place and covering messages and member lists.

Also done: the server side. `JwksCache` fetches signing keys and — the property the whole design exists for — **keeps serving cached keys when the provider is unreachable**, indefinitely, rather than failing closed. Failing closed would mean one failed HTTP request logging out a network of unrelated servers; a signature check against a key that rotated last week is a much smaller problem. An unfamiliar key id triggers one refresh and retry, so ordinary rotation needs no operator. 23 tests, including the outage path and both halves of rotation.

`auth.ssoLogin` verifies, then links. The linking rule is the subtle part and has its own tested function: matching an SSO identity to an existing local account **by email is an account takeover** unless the provider verified the address — otherwise anyone could register at sovrgnnet.cc with your email and inherit your account on every server you belong to. An unverified email refuses and asks the person to sign in locally first. The join policy applies to SSO exactly as to local sign-up, so a closed server stays closed regardless of where an identity came from.

The service is built: accounts, sessions, the token endpoint, JWKS, grants a person can see and revoke, and recovery. It runs on its own machine — deliberately not co-located with a server, since identity going down with somebody's instance would be the worst of both arrangements — and is documented in [identity/DEPLOY.md](../identity/DEPLOY.md).

**It runs without email**, which is a chosen configuration rather than a missing feature, and makes two things permanently true: no address is verified, so servers never auto-link an identity to an existing local account; and recovery codes are the only way back. Both are stated at startup, at signup, and in the reset endpoint, which returns "this service doesn't send email" rather than the much crueller "check your inbox." Codes can be regenerated with the current password, and their count is queryable so a client can nag before it matters.

**Remaining:** the sign-in UI on sovrgnnet.cc, and the client-side flow that asks for a token and hands it to a server.

## Phase 8 — Client-side Matrix

The client syncs directly with each homeserver instead of the app proxying. Still plaintext — this step is about moving the transport, not encrypting it, and separating the two keeps each reviewable. Replaces the 3-second polling loop with a real `/sync` stream. Conduit stops being loopback-only and moves behind the tunnel with proper delegation.

## Phase 9 — End-to-end encryption

Olm/Megolm in the client. The part everyone underestimates isn't the encryption, it's the key management: cross-device verification, key backup, and recovery phrases are the difference between encryption and permanent data loss. The web app does not get E2EE and must stop implying it does.

## Phase 10 — Voice

MatrixRTC signalling with a LiveKit SFU. Needs the persistent client from Phase 7 and benefits from the direct sync of Phase 8. A public TURN relay is likely required for people behind hostile NAT — a real, ongoing bandwidth cost to decide on deliberately.

## Phase 11 — Directory and server administration

An opt-in directory at sovrgnnet.cc: servers may register an id and display name to be searchable; joining still needs an invite. It holds server addresses and nothing else — never members, never messages — and an unregistered server stays fully functional, just unsearchable.

Alongside it, server administration from the client: settings, roles, moderation, and join policy, so running a server never requires SSH.

## Later

Optional wallet linking and ENS display names; the soundboard; and a decision on the old "Nitro" tables — reimagined as token-gated membership, or removed. Federation stays possible for operators who want it, but multi-connection comes first: federation makes every server's uptime and moderation policy everyone else's problem, and requires every instance to be publicly reachable, which contradicts running one on a laptop in a closet.

---

*The legacy `todo.md` from the original scaffold is superseded by this document.*
