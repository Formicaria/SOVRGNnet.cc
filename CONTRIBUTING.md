# Working on SOVRGNnet

## The train

Application changes go: **branch → pull request → merge to main → tag → release.**
Nothing lands on `main` directly, and every release comes from a tag on `main`.

```bash
git checkout -b invite-expiry
# ...work...
pnpm check && pnpm test && pnpm build
git push -u origin invite-expiry
gh pr create            # or open it in the browser
```

CI runs on the pull request. Once it's green and merged, `main` is releasable.

**The landing site is exempt.** Changes under `site/` deploy through Cloudflare
Pages on their own and don't gate on application CI — see below.

## Cutting a release

Versions are **linear**: `0.1.0 → 0.1.1 → 0.2.0 → 1.0.0`. No pre-release
suffixes, no build metadata. A release train that permits `1.0.0-rc.3+build7`
needs tooling nobody here wants to maintain.

```bash
./scripts/bump-version.sh patch     # or minor / major / an explicit 0.4.2
```

That rewrites the version in all five places it lives — `package.json`,
`desktop/package.json`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/Cargo.toml`, and `shared/const.ts` — and verifies they
agree. Then:

1. Add a `## v<version>` section to `CHANGELOG.md`
2. Open a pull request with the bump and the changelog
3. Merge it
4. Tag `main`:

```bash
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0
```

The tag is what builds and publishes. Nothing else does.

### What a release produces

| Artifact | Where |
|---|---|
| Linux desktop app (`.deb`, `.AppImage`) | attached to the GitHub release |
| macOS desktop app (`.dmg`, universal) | attached to the GitHub release |
| Windows desktop app (`.msi`) | attached to the GitHub release |
| Server container image | `ghcr.io/formicaria/sovrgnnet.cc:<version>` |

The release is created as a **draft**, each platform uploads into it, and it's
only published once every build and the image have succeeded. A half-finished
release is never publicly visible.

If the tag and `package.json` disagree, the release fails immediately, before
spending an hour of build minutes on installers that would be misnamed.

## CI, and why site changes skip it

`ci.yml` starts by working out what actually changed:

| Job | Runs when | Does |
|---|---|---|
| `app` | `server/`, `client/`, `shared/`, `drizzle/`, build config | typecheck, migrate, test, build (with Postgres) |
| `desktop` | `desktop/`, `shared/` | typecheck the desktop package |
| `versions` | always | the five version strings agree |
| `ci` | always | aggregates the above |

Editing `site/` or a markdown file runs only `versions` and `ci`. Spinning up
Postgres to check a typo on the landing page is a waste of everyone's time.

**Make `ci` the required status check, not the individual jobs.** A skipped
required check never reports a result, so requiring `app` directly would leave
every site-only pull request unmergeable forever. `ci` always runs and fails if
anything it depended on actually failed, treating "skipped" as fine.

Rust is deliberately **not** compiled on pull requests. It costs more minutes
than it catches bugs at this stage; the release build is where the desktop apps
are actually compiled for all three platforms.

## Running things locally

```bash
pnpm install
cp .env.example .env      # DATABASE_URL and JWT_SECRET at minimum
pnpm dev                  # migrates on boot, serves on :3000
```

```bash
pnpm check                # typecheck
pnpm test                 # vitest — DB tests skip without DATABASE_URL
pnpm build
```

The desktop app has its own dependency tree:

```bash
cd desktop
pnpm install
pnpm check
pnpm tauri dev            # needs Rust and the Tauri prerequisites
```

## Things worth knowing before you change them

**`shared/` is compiled by three different builds** — the server, the web
client, and the desktop app. The desktop `tsconfig.json` deliberately does not
include the folder wholesale, because `shared/types.ts` re-exports the drizzle
schema and would drag the database layer into a client that has no business
with it. Import what you need; let TypeScript follow.

**`MATRIX_SERVER_NAME` is permanent.** It's written into every Matrix user and
room ID at creation. Changing it on a live instance orphans all history.

**`encryption` in `/api/instance` is a constant, not a setting.** It describes
whether this *build* has end-to-end encryption, and it's false. It was once
derived from whether the homeserver was publicly reachable, which meant an
instance started claiming E2EE the moment it got a public address. Two tests
guard against that returning.

**Migrations apply themselves at startup.** `pnpm db:push` generates new SQL
after a schema change; it isn't needed to run the app, and it can't run inside
the production image, which has no `drizzle-kit`.

## Architecture decisions

Anything that changes the shape of the system gets an ADR in `docs/adr/`,
including what it costs. The two that explain most of the current design:

- [0001 — a network of servers, not a website](docs/adr/0001-multi-server-client.md)
- [0002 — the Windows app installs a server, on WSL2](docs/adr/0002-windows-bundled-server.md)
