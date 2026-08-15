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

## Phase 5.5 — Desktop app (Tauri)

Once messaging works in the browser, wrap it: a Tauri shell targeting sovrgnnet.cc with native notifications, system tray, and auto-update. Thin by design — all product logic stays in the web app.

## Phase 6 — The sovereign extras (post-v1)

In deliberate order: end-to-end encryption (Olm/Megolm) once the plaintext path is solid; voice channels via MatrixRTC + LiveKit; optional wallet linking and ENS display names; the soundboard; and only then any token-gated membership reimagining of the old "Nitro" tables — or their removal.

---

*The legacy `todo.md` from the original scaffold is superseded by this document.*
