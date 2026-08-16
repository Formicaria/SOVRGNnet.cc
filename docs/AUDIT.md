# Codebase Audit — August 2026

End-to-end sweep of the repo as inherited. This is the ground truth the roadmap is built on. The project began as a Manus-generated scaffold ("decentralized-discord") and carries residue from that origin.

## What genuinely works

The Vite + React 19 client with a full shadcn/ui component library, theming, and routing (wouter, patched). The tRPC 11 API skeleton with typed routers for servers, channels, messages, file shares, soundboard, members, and profiles. A complete Drizzle/Postgres schema with migrations for all core entities (users, profiles, servers, channels, messages, fileShares, soundboardClips, serverMembers, plus a speculative NFT-subscription table since removed). Lazy DB connection so tooling runs without a database. A Docker Compose stack definition covering app, DB, Matrix (Conduit), IPFS (Kubo), and nginx. Vitest test files exist for auth, db, matrix, and routers.

## Critical defects (block everything)

**1. Identity type mismatch — auth is broken at the root.** `server/_core/supabaseAuth.ts` returns `payload.sub` (a Supabase UUID string) as `User.id`, but the schema's `users.id` is a serial integer and every foreign key (`ownerId`, `userId`, etc.) expects it. Every `protectedProcedure` that writes will fail or corrupt relations. There is also no user upsert on login, so authenticated users never exist in our DB at all.

**2. Matrix proxy is unauthenticated and hardcoded.** `routers.ts` calls `http://localhost:8008/_matrix/client/v3/createRoom` — ignoring `MATRIX_HOMESERVER_URL` — and sends no access token. Conduit requires an authenticated Matrix user to create rooms, so this fails in any real deployment. There is no appservice registration or user provisioning bridging our accounts to Matrix accounts.

**3. Database engine mismatch.** Code and schema are Postgres (`drizzle-orm/postgres-js`), but `docker-compose.yml` shipped MySQL 8 and a `mysql://` DATABASE_URL, and mounted `scripts/init-db.sql` which doesn't exist. *(Fixed: compose now runs Postgres 16.)*

**4. Secrets committed to the repo.** `.env.production` contained a live Supabase project URL and publishable key. *(Fixed: file removed, replaced by `.env.example`. The key is still in git history — rotate it in the Supabase dashboard, or retire the project entirely since we're going self-hosted.)*

## Major gaps

Messaging is not implemented: `MatrixContext` is a stub that hardcodes `isConnected: true`; Dashboard's send-message handler is a TODO; there is no sync loop, no message history fetch, no rooms list. Auth direction is unresolved: the client uses Supabase Auth (cloud) while the decision is self-hosted email/password — the server needs first-party registration/login with hashed passwords and the existing session-cookie plumbing (`_core/cookies.ts`), replacing the Supabase client dependency. No user provisioning into Matrix. IPFS context exists client-side but no server-side pinning or upload endpoint.

## Cleanup debt

Manus scaffold residue: `vite-plugin-manus-runtime`, `manusTypes.ts`, Forge API and Manus OAuth env vars in compose/templates, `OAUTH_SERVER_URL` references. Package was named `decentralized-discord` *(fixed: now `sovrgnnet`)*. `js-ipfs@0.0.301` is a deprecated/suspicious dependency (the real js-ipfs is discontinued; its successor is Helia) — remove or replace. `findAvailablePort` silently hops ports in production, which breaks Docker port mapping — should fail fast instead. Compose healthcheck uses `curl` not present in the Alpine runtime image. Branding strings ("Decentralized Discord") remain across UI, compose defaults, and scripts. The scaffold's NFT-subscription tables and routers (named after a third party's paid tier) are speculative scope that should not gate v1 *(since removed entirely — migration 0007)*.

## Test and build status

Not yet verified in CI — no CI exists. First engineering task on the roadmap is a clean `pnpm install && pnpm check && pnpm test && pnpm build` and a GitHub Actions workflow to keep it that way.
