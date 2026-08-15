# Roadmap — SOVRGNnet to production on sovrgnnet.cc

Decisions locked in: self-hosted Postgres, email/password auth first (wallet identity later, optional), SOVRGNnet branding, full stack on our own hardware behind sovrgnnet.cc.

The guiding rule: **a small thing that works end-to-end beats a large thing that doesn't.** v1 is text chat that actually sends and receives. Everything else follows.

## Phase 0 — Stabilize the foundation ✅ (August 2026)

Done: `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build` all pass locally; GitHub Actions CI runs the full gauntlet with a Postgres service container for integration tests (DB tests skip gracefully when no `DATABASE_URL` is set). Manus residue stripped — vite-plugin-manus-runtime, jsx-loc plugin, manusTypes, Map.tsx/map.ts (Forge API dead code), Forge/OAuth env vars — along with unused `js-ipfs`, `webtorrent`, and AWS SDK dependencies; lockfile re-resolved clean. Rebrand finished across UI, compose files, templates, and scripts. Dockerfile fixed (copied a nonexistent `client/dist`; client actually bundles into `dist/public`). Compose healthcheck switched to node (curl isn't in the Alpine image). Server now fails fast in production if its port is taken instead of silently hopping.

**Remaining (manual):** rotate/retire the exposed Supabase credentials; verify `docker compose up` end-to-end on the target host.

## Phase 1 — First-party auth

Replace Supabase Auth with our own: `users` table gains a `passwordHash` (argon2id); tRPC `auth.register` / `auth.login` / `auth.logout` issuing the existing session cookie; `authenticateRequest` verifies our JWT and loads the DB user by integer id — fixing the identity mismatch at the root. Client's SupabaseAuthContext becomes a thin AuthContext over tRPC. Rate-limit login, add password reset via email later (not a v1 blocker).

**Exit criteria:** register → login → protected API call → logout works against local Postgres; tests cover the token path.

## Phase 2 — Matrix bridge and real messaging (the heart of v1)

Server-side Matrix service that provisions a Matrix account per SOVRGNnet user (Conduit shared-secret or appservice registration), stores the mapping in `userProfiles.matrixUserId`, and holds access tokens server-side. Rework the matrix router: create space (server), create room (channel), join, send message, fetch history — all authenticated, all using `MATRIX_HOMESERVER_URL` from env. Client gets live updates via a `/sync` bridge over WebSocket or SSE. The Dashboard becomes a real three-pane app: server list, channel list, working message pane.

**Exit criteria:** two accounts in two browsers exchange messages in a channel through Conduit; history survives reload.

## Phase 3 — Files and media

Server-side upload endpoint that pins to our Kubo node and records the `fileShares` row; images render inline, other files get download cards served via our own IPFS gateway (not a public one). Avatar upload for profiles. Defer WebTorrent distribution until file sharing is proven.

**Exit criteria:** drag-and-drop a file into a channel, another user downloads it via sovrgnnet.cc.

## Phase 4 — Production deployment on sovrgnnet.cc

DNS for sovrgnnet.cc and matrix.sovrgnnet.cc; TLS via Let's Encrypt; nginx fronting app and homeserver with `/.well-known/matrix/{server,client}` delegation so federation and third-party Matrix clients work. Postgres backups (the existing backup.sh adapted to pg_dump), log rotation, uptime monitoring, and a staging compose profile. Harden Conduit: registration closed or invite-gated, federation policy decided deliberately.

**Exit criteria:** https://sovrgnnet.cc serves the app, a Matrix federation tester passes, backups restore cleanly.

## Phase 5 — Community features

Invites and membership (make `serverMembers` real: join via invite link, roles enforced in API), user presence, typing indicators, message editing/deletion, reactions (schema already has the column), moderation basics (kick/ban mapped to Matrix power levels).

## Phase 6 — The sovereign extras (post-v1)

In deliberate order: end-to-end encryption (Olm/Megolm) once the plaintext path is solid; voice channels via MatrixRTC + LiveKit; optional wallet linking and ENS display names; the soundboard; and only then any token-gated membership reimagining of the old "Nitro" tables — or their removal.

---

*The legacy `todo.md` from the original scaffold is superseded by this document.*
