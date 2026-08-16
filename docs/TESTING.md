# Verifying a change before you push

```bash
pnpm preflight            # ~20s  — before every push
pnpm preflight --full     # ~10m  — before a release or a risky change
```

Preflight stops at the first failure and runs cheapest-first, so a typo costs
seconds rather than a Docker build.

## What each layer actually proves

Four layers, and the distinction matters — passing the first three has
repeatedly not meant the software worked.

| Layer | Command | Proves | Time |
|---|---|---|---|
| Unit | `pnpm test` | Logic is right | 7s |
| Integration | `pnpm test:db` | It's right against a real Postgres | ~40s |
| End-to-end | `pnpm e2e` | The whole stack works together | ~8m |
| Conformance | `pnpm conformance <url>` | An instance speaks the protocol | 2s |

### Unit — 531 tests

Pure functions, mocked boundaries, no network and no database. Fast enough to
run constantly, which is the point.

**They cover less than the number suggests.** 28 tests skip themselves without
`DATABASE_URL`. That's correct — a missing database shouldn't look like a
failure — but it means a green `pnpm test` locally is not the same green CI
gets. Preflight says so explicitly rather than letting the number reassure you.

### Integration — the 28 skipped ones

```bash
pnpm test:db              # throwaway Postgres on :55432, torn down after
pnpm test:db --keep       # leave it running for repeat runs
```

Runs the full register → create → post → join → permissions flow against a real
database with a mocked homeserver. Never touches a real instance's data.

### End-to-end — the whole thing

```bash
pnpm e2e                  # build, run, tear down
pnpm e2e --keep           # leave it up at :3999 to poke at
pnpm e2e --no-build       # reuse the image, for repeat runs
```

Stands up Postgres, Dendrite, Kubo, and the app under their own compose project
(`sovrgnnet-e2e`, port 3999, separate volumes), then:

1. Waits for `/ready` — per-dependency, not just a listening port
2. Waits for the homeserver separately, because Dendrite is slower and a
   journey that starts too early fails confusingly on the first message
3. Runs the conformance suite against the live instance
4. Drives a full journey through the real HTTP API — register, admin
   assignment, invite-only enforcement, community, channel, send, read, edit,
   upload, download, invite, join, permission refusals, device listing
5. Takes a backup and verifies it with the real verifier
6. **Drops the schema**, then restores
7. Confirms accounts, roles, communities, both users' messages, and the file
   bytes all came back

Step 6 is the one that matters. A restore that has never followed actual data
loss has never been tested, and three data-destroying bugs in this project were
found by reading that code rather than running it.

**It cannot touch your real instance.** Own project name, own volumes, own
generated secrets, own port. The teardown asserts the project name before
removing anything, and `server/e2eHarness.test.ts` asserts that guard exists.

### Conformance

```bash
pnpm conformance https://your-instance.example
```

Protocol surface only, no credentials, safe to point at someone else's
instance. Exit 0 means it conforms; warnings never fail it.

## Why this exists

Every bug in this project that destroyed data or shipped a false claim was in
code no test had executed:

- `/ready` reported `database: "ok"` with no database. It called a query that
  catches its own errors by design. Found by pointing conformance at a live
  process, not by reading the code — which looks like it checks something.
- Restore never restored chat history, because it looked for a file that
  stopped existing when Dendrite moved to Postgres.
- Restore never put back the signing key, so every restored instance silently
  became a different server to anyone it had federated with.
- The join policy was advertised and never enforced.
- Nobody was ever an administrator — `adminProcedure` checked the role and
  nothing assigned it.

Each is now asserted in the journey. That is the actual purpose of the harness:
not to catch new mistakes in the abstract, but to make sure these specific ones
cannot come back silently.

## What still can't be checked locally

Stated so it isn't mistaken for coverage:

- **Tauri bundling.** Needs each target OS; only CI builds installers.
- **macOS packaging.** Non-blocking in CI for the same reason.
- **Federation.** Needs two reachable homeservers.
- **Cloudflare Tunnel modes.** Need real DNS.
- **Upgrade paths.** Nothing tests migrating a v0.2 instance to v0.4.

## The release train

```
pnpm preflight --full
git push -u origin feat/whatever
# open a PR, let CI run, merge
./scripts/bump-version.sh minor
# commit the bump, merge it
git checkout main && git pull
git tag v0.5.0 && git push origin v0.5.0
```

**Tag after merging, never before.** The tag guard compares the tag against
`package.json` on the commit it points at, so tagging `main` before the version
bump lands fails — which has happened, and is what the guard is for.
