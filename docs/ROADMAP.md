# Roadmap — SOVRGNnet to production on sovrgnnet.cc

Decisions locked in: self-hosted Postgres, email/password auth first (wallet identity later, optional), SOVRGNnet branding, full stack on our own hardware behind sovrgnnet.cc.

The guiding rule: **a small thing that works end-to-end beats a large thing that doesn't.** v1 is text chat that actually sends and receives. Everything else follows.

## Phase 0 — Stabilize the foundation ✅ (August 2026)

Done: `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build` all pass locally; GitHub Actions CI runs the full gauntlet with a Postgres service container for integration tests (DB tests skip gracefully when no `DATABASE_URL` is set). Manus residue stripped — vite-plugin-manus-runtime, jsx-loc plugin, manusTypes, Map.tsx/map.ts (Forge API dead code), Forge/OAuth env vars — along with unused `js-ipfs`, `webtorrent`, and AWS SDK dependencies; lockfile re-resolved clean. Rebrand finished across UI, compose files, templates, and scripts. Dockerfile fixed (copied a nonexistent `client/dist`; client actually bundles into `dist/public`). Compose healthcheck switched to node (curl isn't in the Alpine image). Server now fails fast in production if its port is taken instead of silently hopping.

**Remaining (manual):** rotate/retire the exposed Supabase credentials; verify `docker compose up` end-to-end on the target host.

## Phase 1 — First-party auth ✅ (August 2026)

Done: Supabase Auth fully replaced with our own. `users` gained `passwordHash` (scrypt — no native deps) and a unique email; fresh Postgres migration history generated (the scaffold's old migrations were unusable MySQL files). tRPC `auth.register`/`login`/`logout`/`me` issue an HS256 session JWT in an httpOnly `SameSite=Lax` cookie; `authenticateRequest` verifies it and loads the DB user by integer id — the identity mismatch is fixed at the root. In-memory login rate limiting (10 attempts / 15 min per IP+email). Client got a thin `AuthContext` over tRPC; Supabase context, OAuth callback page, obsolete compose variants, and the `@supabase/supabase-js` dependency are gone. Also fixed along the way: a broken `drizzle.config.ts` and dead Google-OAuth login button. 19 unit tests pass (hashing, tokens, rate limiting, logout); full register→login→me→logout integration test lands with the Phase 2 DB test suite.

**Remaining (later):** password reset via email; wallet-signature login as an optional identity layer (post-v1).

## Phase 2 — Matrix bridge and real messaging ✅ (August 2026)

Done: server-side `matrixService` (REST client with injectable fetch) provisions one Matrix account per user on first use — deterministic localpart/password derived from the app secret, tokens held in `userProfiles.matrixAccessToken`, never sent to the browser. Servers are Spaces, channels are child rooms, `messages.send` goes through the homeserver and records the event id. Membership is enforced on every read/write; `servers.join` joins the space and all rooms. Dashboard is a real three-pane chat app (rail / channels / messages) with create, discover, and join flows. Integration test suite runs the full two-user flow (create → post → forbidden-before-join → join → post → permissions) against Postgres with a mocked homeserver.

**Deferred within phase:** live updates are 3-second polling for now; a `/sync`-backed SSE/WebSocket bridge replaces it in a later pass. E2EE stays in Phase 6.

## Phase 3 — Files and media

Server-side upload endpoint that pins to our Kubo node and records the `fileShares` row; images render inline, other files get download cards served via our own IPFS gateway (not a public one). Avatar upload for profiles. Defer WebTorrent distribution until file sharing is proven.

**Exit criteria:** drag-and-drop a file into a channel, another user downloads it via sovrgnnet.cc.

## Phase 4 — Production deployment on sovrgnnet.cc

DNS for sovrgnnet.cc and matrix.sovrgnnet.cc; TLS via Let's Encrypt; nginx fronting app and homeserver with `/.well-known/matrix/{server,client}` delegation so federation and third-party Matrix clients work. Postgres backups (the existing backup.sh adapted to pg_dump), log rotation, uptime monitoring, and a staging compose profile. Harden Conduit: registration closed or invite-gated, federation policy decided deliberately.

**Exit criteria:** https://sovrgnnet.cc serves the app, a Matrix federation tester passes, backups restore cleanly.

## Phase 5 — Community features

Invites and membership (make `serverMembers` real: join via invite link, roles enforced in API), user presence, typing indicators, message editing/deletion, reactions (schema already has the column), moderation basics (kick/ban mapped to Matrix power levels).

## Phase 5.5 — Desktop app (Tauri)

Once messaging works in the browser, wrap it: a Tauri shell targeting sovrgnnet.cc with native notifications, system tray, and auto-update. Thin by design — all product logic stays in the web app.

## Phase 6 — The sovereign extras (post-v1)

In deliberate order: end-to-end encryption (Olm/Megolm) once the plaintext path is solid; voice channels via MatrixRTC + LiveKit; optional wallet linking and ENS display names; the soundboard; and only then any token-gated membership reimagining of the old "Nitro" tables — or their removal.

---

*The legacy `todo.md` from the original scaffold is superseded by this document.*
