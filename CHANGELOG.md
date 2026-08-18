# Changelog

## v0.6.1 — 2026-08-17

**A Windows build shipped without `createdb`.** `initdb` ran, the cluster came
up, and setup died three steps later with `The system cannot find the file
specified`. `scripts/host-bundle.sh` verified `initdb` and treated it as proof
the whole PostgreSQL bundle was good; `bundle_present()` in `hosting.rs` did
the same, so the app offered to host on a bundle it could not finish using.
Both now check every binary the supervisor actually spawns — `initdb`,
`postgres`, `pg_ctl`, `createdb` — and a test derives that list from
`hosting.rs` rather than repeating it, so adding a fifth cannot skip either
check. A missing file now fails when the bundle is built, where the fix is
re-running one script.

**"Load failed" was the entire sign-in error on Linux.** Every HTTP status the
identity service can return is handled with a sentence explaining it, but a
fetch that never completes throws a bare `TypeError` whose message each engine
words differently and uselessly — WebKitGTK, the Linux webview, says "Load
failed". It names no host and no cause. The request not arriving is now
distinguished from the service answering badly, and says which host could not
be reached.

**Express 5.** Five of the eight production advisories were Express 4's
transitive dependencies — `path-to-regexp`, `qs`, `body-parser` — and they
arrive with Express or not at all.

The migration survey said route patterns were clean. It was wrong, and wrong in
an instructive way: the grep behind it searched `server/*.ts`, while the app is
created in `server/_core/`, where two `app.use("*", …)` SPA fallbacks were
sitting. path-to-regexp v8 requires wildcards to be named, so a bare `*` throws
at *registration* — the app never finishes starting. Typecheck passed, all 1007
unit tests passed, the image built, and the container came up with a healthcheck
that never went green.

The end-to-end stage caught it, on the very first run of the job added hours
earlier for exactly this case. Both fallbacks are now `app.use(handler)` with no
path, which has always meant the same thing and keeps the pattern out of
path-to-regexp's hands. A test now walks every `.ts` in the repository for
unnamed wildcards and `:param?` optionals — searching everywhere rather than
where somebody guessed, since the scope of the search was the actual bug.

**CI never brought the stack up, and UPGRADING.md said it did.** The `app` job
runs the unit suite against a real Postgres, which is most of the value — but
nothing started Dendrite, built the image, or restored a backup. An image bump
could go green without a single migration being exercised, while this page
described a pipeline that proved exactly that. Written this morning, wrong by
the afternoon.

There is now an `e2e` job running the full `scripts/e2e.sh`, gated on pushes to
main and on pull requests labelled `dependencies` — which is what Renovate
applies. Every other pull request keeps the fast path; the case the gate exists
for is the one that gets the stack.

`renovate.json` opens those pull requests. It groups the things that only work
when moved together: Express with the transitive advisories that arrive with
it, matrix-js-sdk with its Rust bindings, Tauri's two package managers — each
of which produces a green typecheck and a broken runtime when split. Postgres
majors and Dendrite get `needs-migration-plan`, because both migrate data
forward one way. `cloudflared` gets its own off-schedule rule after sitting
twenty months out of date while every other signal looked healthy.

**Nothing auto-merges, and a test enforces it.** The argument in UPGRADING.md
is that nothing in this stack should update itself; a bot that merges its own
pull requests is Watchtower with extra steps.

**An independent instance can use id.sovrgnnet.cc, and now something checks
that.** A server run by somebody else gets exactly one thing from the identity
provider — the JWKS at `/.well-known/jwks.json` — and verifies every token
afterwards without contacting it again. That single document is the whole
contract, so `shared/identityIssuer.ts` assesses it as one and returns problems
as data rather than copy.

`server/identityIssuer.test.ts` runs the real production JWKS through it, then
simulates the relationship end to end: a provider signs with a key the instance
never sees, publishes the public half, and the instance verifies from that
alone — including refusing a token signed by an unpublished key, refusing one
minted for a different instance, and accepting one signed by the outgoing key
during a rotation overlap.

Two of those assertions passed on their first run for the wrong reason. `expect
(...).toThrow()` accepts *any* error, and they were catching a `TypeError` from
my calling `verifyToken` with the wrong signature. They now assert the specific
`TokenError` code, with a test above them checking that verification throws
`TokenError` at all — otherwise the code assertions would quietly stop meaning
anything.

`pnpm check:identity` is the live half, kept out of the suite so the suite still
runs offline. The fixture is a snapshot, and snapshots go stale in silence.

**The crypto stage's log quieting never quieted anything.** `quietTheSdk()` set
a default level and turned down the loggers that existed, with a comment saying
anything created later was caught by the default. A full preflight run printed
a thousand lines of `sync Getting saved sync token…` around eleven passing
checks, which is how it was noticed.

Two things made the comment false. It runs before matrix-js-sdk is imported, so
`getLoggers()` is empty and the loop turns down nothing. And the SDK's
`logger.js` calls `setLevel(loglevel.levels.DEBUG, false)` on every logger it
creates — an explicit level always beats a default. It now clamps `setLevel`
itself, so whatever the SDK asks for cannot go below warnings; intercepting the
request is the only form that holds for loggers created afterwards, which is
all of them. `E2E_CRYPTO_VERBOSE=1` still restores everything.

**Both servers announced themselves as Express on every response.**
`X-Powered-By` is on by default and neither app turned it off. Not an exploit,
and hiding it keeps nobody out — but it names the framework to every scanner
that touches the origin, which is unhelpful given that the deferred advisories
in `docs/DEPENDENCIES.md` are Express 4 denial-of-service issues somebody would
have to decide to aim at us. Disabled in both, with a test, because the two
apps are created in different files and one of them being hardened alone is how
this comes back.

**The apex advertised federation the homeserver refuses.**
`server/instanceRoutes.ts` gates `/.well-known/matrix/server` on
`MATRIX_ALLOW_FEDERATION`, with the reason written beside it: advertising a
federation endpoint while refusing federated traffic invites other servers to
try and then fail. That gate never runs on sovrgnnet.cc. Delegation is always
fetched from the *server name*, and `sovrgnnet.cc` is a static Pages site — so
the app's route is never asked and the static file answered unconditionally.
The safety mechanism existed, was well argued, and was not in the path.

The static `matrix/server` is now absent while federation is off;
`matrix/client` stays, because telling a client which homeserver to log in to
is true either way. `site/.well-known/README.md` carries the file to restore
and the one-line check that proves it should exist —
`/_matrix/key/v2/server` returning `M_UNRECOGNIZED` means federation is still
off. `check-site.sh` reports on both.

**The site kept advertising the previous version.** `check-versions.sh` watches
six manifests; the static site is HTML and is not one of them, so v0.6.1
shipped with a landing page offering v0.6.0 and download links pointing at
release assets that do not exist under that tag. `bump-version.sh` now rewrites
the site as well.

**The identity service has tests now.** It was live, holding the key that mints
tokens for every server trusting this issuer, with nothing exercising its own
code — `server/identity.test.ts` covers the consumer side, verification. 40
tests across the three parts where a quiet mistake is worst.

Keys: refusing to start without one rather than generating an ephemeral key
nobody can verify against; the rotation overlap that keeps old tokens valid
while their key is still published; and JWKS never carrying a duplicate `kid`
or a private half. Including a test for a PEM folded onto one line with literal
`\n`, because systemd's `EnvironmentFile` cannot hold a multi-line value and
every systemd deployment therefore depends on that path working.

Accounts: that a malformed stored hash fails the login rather than throwing —
`timingSafeEqual` throws on a length mismatch, so the guard in front of it
decides whether a truncated row is a rejection or a 500. And that email
normalization does *not* strip dots or plus-addressing: those are Gmail's rules
rather than the internet's, and folding `a.b@` into `ab@` at most providers is
an account takeover.

Rate limiting: that each endpoint keeps its own counter, that the 429 discloses
neither the limit nor the window, and that keying on the account as well as the
address bounds what a botnet can do to one person — the case address-only
limiting is blind to.

**Backups now run on their own, and say when they haven't left the box.**
`scripts/backup.sh` has always worked and nothing ever called it — no cron, no
timer, and the only archive on the production instance was sitting on the disk
it was protecting. `install-lxc.sh` installs `sovrgnnet-backup.timer`: take,
verify, copy to `SOVRGN_BACKUP_DEST`, prune to `SOVRGN_BACKUP_KEEP`. Pruning is
last so that a bad run cannot delete good history and replace it with nothing,
and the job exits non-zero on a failed verification so systemd records it
instead of the failure landing in a log nobody opens.

With no destination set it still runs, and still says every night that the
archive never left the machine — `sovrgnnet status` shows `local only` too. A
copy on the disk it protects survives someone deleting the wrong thing and none
of the failures people actually keep backups for.

`sovrgnnet status` also prints the age of the newest archive, because a backup
that stops happening produces no error anywhere: the timer is healthy, the disk
is fine, and the last one just keeps getting older.

**`pnpm preflight` runs the identity tests too.** Three workspaces carry three
tsconfigs with three ideas of strict — the root leaves `noUnusedLocals` off,
`identity` and `desktop` turn it on — and checking only the root sent three
separate failures to CI in one afternoon, each a real defect a narrower local
run never looked for.

The fix was already in the repository: `scripts/preflight.sh` has covered every
workspace for a while, in eleven stages. A `pnpm verify` script was added here
before noticing that, which is the same mistake in a different direction — it
duplicated preflight badly, and two commands that almost mean the same thing is
how one of them silently stops matching CI. Removed. What preflight was
genuinely missing is now added: stage 8 ran a typecheck against the identity
service and nothing else, while that service was live holding the signing key
for the whole network.

**The desktop release build was the first thing to bundle the desktop.** CI's
desktop job ran `pnpm check` — typecheck only. `shared/identity.ts` opens with
`import { ... } from "node:crypto"`, and the shell imports one constant from
it, which pulls the whole module into a browser bundle: Vite externalises
node:crypto, Rollup fails on the missing `generateKeyPairSync`, and all three
platforms died at `beforeBuildCommand` after the tag was pushed. The constants
moved to `shared/identityOrigin.ts`, which a browser can load, and
`shared/identity.ts` re-exports them so server callers are unchanged. CI's
desktop job now runs `pnpm build`. That is the same lesson the `desktop-rust`
job already existed for — "code that only compiles during a release fails
during a release" — applied to the half of the shell that is JavaScript.

**IDENTITY_ORIGIN still pointed at the marketing site.** It was honest when
nothing was deployed and the comment said so. `id.sovrgnnet.cc` is running now,
so it is `https://id.sovrgnnet.cc` — meaning SSO no longer defaults to fetching
JWKS from a static page with no keys.

**Four tests could only pass on a machine that had run the e2e harness.**
`server/appservice.test.ts` read `dendrite/appservice-e2e.yaml`, which
`scripts/e2e.sh` generates and `.gitignore` excludes because it carries real
tokens. On any clean checkout it does not exist, so the tests threw ENOENT. The
property they guarded — that the generated registration's user namespace
matches the template's — is now checked from committed files: the generator is
a `sed` over two token placeholders, so the namespace can only drift if a
placeholder appears inside it. The direct comparison still runs for anyone who
has the generated file.

**CI caught a dependency we never declared.** `scripts/e2e-crypto.ts` imported
`loglevel`, which arrives transitively through matrix-js-sdk. It resolved on
the machine that wrote the code and not on a clean install, so `tsc --noEmit`
passed locally and failed in CI — the worst place to learn it. Beyond the
broken build, an undeclared package is pinned to whatever version something
else happens to want and can disappear in a patch release of a package
unrelated to us. Now declared, and `server/imports.test.ts` fails locally on
the next one.


**A Conduit-era machine upgraded to Dendrite and kept running Conduit.** ADR
0006 replaced the homeserver and gave Dendrite the same port, 6167, but nothing
ever retired `conduit.service`. On those machines Conduit keeps the port,
Dendrite dies with `bind: address already in use` every five seconds, and
because `Restart=always` never lets it settle, systemd reports it as
`activating` rather than `failed`. The homeserver answers throughout — it is
simply the wrong one, under the old server name, no longer the one being
configured. `install-lxc.sh` now stops and disables Conduit before writing
Dendrite's unit, and leaves its database alone: an installer does not get to
delete somebody's only copy of their history during an upgrade.

**Dendrite's internal event stream lived in a directory systemd wipes.** With
no `jetstream.storage_path` Dendrite picks a temporary directory and warns that
data could be lost on reboot; the unit sets `PrivateTmp=true`, so it was lost
on every restart instead. JetStream is how Dendrite's components hand events to
each other, which makes the failure mode an event that was accepted and then
never arrived — not a crash, and not visible anywhere. Now stored under
`/var/lib/dendrite/jetstream`.

**`sovrgnnet start` could not start a native install.** The control script
managed a `conduit` unit; ADR 0006 replaced Conduit with Dendrite and
`install-lxc.sh` has written `dendrite.service` ever since. Nothing connects
those two files, so the list was never updated. Under `set -e`, `systemctl
start postgresql conduit ipfs sovrgnnet` aborted on the missing unit — before
reaching IPFS or the app — meaning the documented way to start an LXC install
had to be worked around by hand. A test now asserts every unit the control
script manages is one the installer creates.

`sovrgnnet update --force` for the two cases the boring path can't handle: a
repository that won't fast-forward, and images that are stale despite the
version being current (`up -d --build` reuses the local cache, so a version tag
rebuilt upstream never arrives). It takes a backup first and aborts if that
fails, prints the commits and tracked files it will discard, and refuses to run
`git clean` — `.env` is untracked, and deleting `MATRIX_SERVER_NAME` is
unrecoverable in the strict sense. On native installs it also refreshes
`cloudflared`, which `install-lxc.sh` fetches only when absent and therefore
never updates.

**Signing in never brought your servers with you.** The desktop reads the
grants list after sign-in and reconnects each instance, keyed on a field called
`address` — which `/api/grants` has never returned. The property was declared
optional, so the type checker was satisfied, the guard skipped every grant, and
the feature the first-run screen advertises did nothing at all from the day it
was written. Grants now carry an `instanceUrl`, written only from an origin the
identity service resolved itself, and the desktop reads that. An optional field
the server never sends is invisible to every tool we have; the only thing that
catches it is running the path.

**The upgrade doc described a stack we don't have.** It claimed every image was
"pinned by digest" and that two operators on the same version "run the same
bytes." No image carried a digest — all six were mutable version tags, and the
Dockerfile's `node:22-alpine` floats across every 22.x patch. Corrected to say
what is actually true, with the cost of real digest pinning written down rather
than implied. `docs/DEPLOYMENT.md` separately showed `cloudflared:latest` in a
snippet people copy, making the rule true where it was enforced and false where
it was taught. Both are now covered by tests.

`cloudflared` bumped 2024.12.2 → 2026.8.2. Of everything in the compose file it
is the only process with an unsolicited path to the internet, which makes it
the pin whose age matters most. `docs/UPGRADING.md` gains a section on what
should update automatically (host security packages), what must not (Postgres
and Dendrite both migrate one-way, which is why Watchtower is the wrong tool
here), and the shape that works for the rest — a bot proposes the bump, the e2e
harness proves it, a person merges it.

**Voice has a constraint worth knowing before it is designed.** Cloudflare
Tunnel carries no UDP, and WebRTC media is UDP, so the transport everything
else here depends on cannot carry audio. `docs/ROADMAP.md` records the three
ways out and what each costs — including that self-hosting an SFU makes the
"no port forwarding anywhere in the design" claim false and would need
correcting in the same commit. `voice: false` remains accurate.


**A stranger could claim a freshly deployed instance.** The first registration
becomes the administrator, and it was decided by `countUsers() === 0` followed
by a separate insert — a check and an act with a gap between them. Two
registrations arriving together both read zero and both became admins, and the
whole window is open on a server that has just been pointed at a public address
by an owner who hasn't signed up yet.

The bootstrap now needs `SOVRGN_SETUP_TOKEN`, compared in constant time, and
the count and the insert happen in one transaction under
`pg_advisory_xact_lock`. An instance with no accounts and no token configured
refuses to create one and names the variable — fail-closed, because the cost of
refusing is an operator reading an error and the cost of allowing is losing the
server. `install.sh` generates one and prints it; the compose template, the
example env and the e2e harness set it. Bootstrapping through SSO is refused
outright: a token can't cross a provider redirect without leaking, and closing
that path removes the race on it rather than gating it more weakly.

**Recovery codes and device codes weren't single-use.** Both checked a row and
wrote it in separate statements, so concurrent requests spent the same code
twice — one recovery code, two password resets; one approval, several desktop
sessions nobody knows about. Both claim conditionally now
(`usedAt IS NULL`, `DELETE … RETURNING`), so the database picks a winner and
the loser changes nothing. Recovery also spends the code *before* touching the
password, which is the ordering a crash makes matter. The same one-line fix
went to the email verification and password-reset tokens, which had it too.

**Device approval loaded every pending code and scanned it in memory**, making
the endpoint's cost grow with a queue anyone can lengthen by requesting device
codes. One indexed query now; the generated alphabet excludes O, I, 0 and 1, so
normalising in SQL is safe and needed no migration.

**The identity service had no rate limiting at all.** Registration, sign-in,
recovery, password reset and device-code creation were each a way to spend an
operator's CPU on scrypt, and recovery-code guessing was free. All bounded now,
per address *and* per account where guessing is the risk — address-only
limiting lets a botnet try one password against ten thousand accounts.
In-process and per-instance, matching the main app, with that limitation
written down rather than left to be discovered.

**Encrypted uploads could be orphaned.** Introduced by v0.6.0. Ciphertext is
pinned before the event carrying its key is sent — the CID doesn't exist until
the upload finishes, so there is no other order — and a failed send left bytes
nobody could ever read and no way to remove them. The client retries once and
then abandons the upload through a new owner-scoped delete, which unpins only
when no other share points at the same CID.

**A file shared into two channels could 403 the wrong person.** Lookup by CID
took the first row and checked membership against *its* channel, so the answer
depended on insertion order. Every share is considered now.

**Two ordering bugs surfaced while making the harness assert this.** The
encryption refusal in `messages.send` ran before the membership check, so a
stranger learned a channel was encrypted before being told they weren't a
member — and the harness's "non-members can't post" assertion was passing on
the wrong branch. And `messages.edit` had no encryption guard at all: editing
through the API would have written plaintext into a row the index is meant to
hold content-blind.

Still open from that audit: the `pnpm audit --prod` advisories, the shared
`sovrgn.host` identity across desktop-hosted servers, and grants carrying no
address for the desktop to restore.

## v0.6.0 — 2026-08-16

**End-to-end encryption, on by default (ADR 0008 stage 4, ADR 0011).** Every
channel created on an instance that can support it is Megolm-encrypted from the
moment it exists — no switch, no per-channel choice, nothing to know to turn
on. Keys live on members' devices, the homeserver stores what it cannot read,
and the instance's own index — which has held `m.room.encrypted` content-blind
since v0.5 — keeps the ordering and none of the content. ADR 0008 said `e2ee`
flips only when all of it works including recovery, so all of it is here:
cross-signing, emoji device verification, a recovery key, server-side key
backup, and restoring a new device from that key.

*The default is conditional on the deployment, and only on the deployment.* An
instance needs a homeserver its clients can reach and a wired appservice;
without both there is nowhere for a member's keys to live except the server,
which is the arrangement encryption exists to end. Those instances get
plaintext channels and an `e2ee` capability that says so. The LXC install is
one of them.

*Files are encrypted too, or the lock icon would be a lie.* Attachment bytes
are AES-CTR encrypted in the browser before upload, per Matrix's `EncryptedFile`
format, with the key carried inside the Megolm-encrypted event — so the
instance pins ciphertext it has no key for. The hash is checked before
decryption, because AES-CTR is unauthenticated and a flipped ciphertext bit is
a flipped plaintext bit with nothing to complain. Filenames, sizes and MIME
types stay in the index in the clear; that is how the file list works, it is
metadata the threat model already concedes, and it is now written down.

*Recovery is offered on the first session that could set it up*, skippable
once, with the amber badge persisting until it's done. Encryption everywhere
without recovery everywhere would be a data-loss default: clear your browser,
lose your history.

*The harness now encrypts something.* Until this release nothing in the
repository had ever performed encryption — unit tests covered the judgement
around it and the journey drove HTTP, and neither can tell you whether a room
key reaches the other device. `scripts/e2e-crypto.ts` imports the shipped
client module and runs it in Node against the harness's Dendrite with two
device-scoped sessions: the crypto stack starts, a message becomes ciphertext,
**the index holds no plaintext anywhere**, a second device decrypts it to the
same string, stored file bytes are ciphertext, and a tampered file is refused.
The only difference from the browser is that Node has no IndexedDB. SAS and key
backup still aren't covered — they need an interactive exchange — and that's
said in the ADR rather than left to be assumed.

*Two ordering bugs found while making the harness assert this.* The API's
encryption refusal ran before its membership check, so a stranger learned a
channel was encrypted before being told they weren't a member — and any test
asserting "non-members can't post" passed on the wrong check. And
`messages.edit` had no encryption guard at all: editing through the API would
have posted plaintext into an encrypted room *and* written the new text into a
row the index is supposed to hold content-blind, leaking what the original
message never did.

*What it doesn't do ships in the same commit as what it does.* Metadata is
readable in every channel. The instance can still mint a Matrix device for any
user, because the derived password still exists, and that device **receives
room keys like any other** — withholding them from unverified devices was built
first and then reverted, because it makes encrypted channels unreadable by
everyone until every pair of members has verified each other. What stands
between a minted device and the conversation is an entry in a device list that
somebody has to notice. The threat model gains T20 and T21 and rewrites T1 and
T17 around it; ADR 0011 decision 3 records the reversal and why the stronger
setting can't ship.

*matrix-js-sdk arrives and the hand-rolled sync engine leaves.* Stage 3 said
the SDK would earn its bundle weight when crypto landed. Running both would
mean two positions in one stream and a bug with two candidate causes — the
exact thing separating stages 3 and 4 was meant to avoid — so
`shared/matrixSyncCore.ts` and its test suite are deleted rather than kept
alongside.

The weight is real and is paid only by instances that can use it: about 1 MB of
JavaScript and a 7.8 MB WASM module, all of it behind a dynamic import gated on
`clientMatrix`, none of it in the entry chunk. An instance whose homeserver is
on loopback fetches not one byte and behaves exactly as it did before.

*Cross-signing without putting the derived password in a browser.* The key
upload is user-interactive-auth gated and only the instance knows the password.
Rather than hand it over — permanent, unrotatable, one XSS from an attacker —
the client starts the flow, gets a UIA session id, and asks the instance to
satisfy that one stage. Private keys stay in the browser; the password stays on
the server. A UIA stage is recorded as soon as the credentials check out, before
the endpoint reads the rest of the body, so the instance's keyless request
completing the stage and *then* being rejected is the success case. Only 401
and 403 are failures.

That last part is an assumption about a homeserver, so the e2e harness checks
it against a real one — and reports that **Dendrite doesn't gate the endpoint
at all**. It answers 400, not 401, so the client's first attempt succeeds and
the whole path is dead code there. It stays for Synapse, which does gate it,
and the harness prints that it proved nothing rather than a tick that suggests
otherwise. Verifying it properly needs a Synapse in the harness.

*Sending into an encrypted room has no fallback, and that inverts a rule.*
Every other client-side send falls back to the instance API so a message isn't
lost to an architectural preference. The API path composes plaintext
server-side, so here the fallback would put cleartext into a room whose members
believe it's encrypted. The send fails, says so, and puts the text back in the
box.

*`e2ee` is derived, not declared.* Three conditions: the build ships crypto, a
homeserver actually answered at the advertised address, and the appservice is
wired. No environment variable sets any of them. This codebase has twice turned
a deployment detail into a claim — `encryption` in v0.3, `clientMatrix` before
stage 2 — and a client acted on it both times.

*An unreadable message now says which kind of unreadable it is:* waiting for a
key, fixable by verifying this device or entering a recovery key, or gone.
They were one grey row before, and only the middle kind is something anybody
can act on.

Also corrected: `SECURITY.md` still claimed Matrix tokens are never sent to a
browser. That stopped being true when stage 3 shipped.

**The desktop app can host (ADR 0005, finally real).** On Linux and Windows,
"Run a server on this computer" sets up a complete instance — PostgreSQL, a
Dendrite built from the same tag Docker pins, Kubo, and the app on a bundled
Node runtime — under your own user account, no terminal, nothing needing an
administrator. The supervisor lives in the shell
(`desktop/src-tauri/src/hosting.rs`) and decides nothing: ports, states, and
install-step wording stay in `shared/hosting.ts`, where they were already
tested. Secrets are generated in the frontend and live in the OS keychain.
The server runs while the app runs, stops cleanly on quit (Postgres through
`pg_ctl`), and joins the rail as an ordinary connection — so its settings are
its own interface, same as any server across the world. v1 limits, stated:
loopback homeserver (so `e2ee` is honestly false on a hosted-here instance),
macOS installs are client-only, and the components ship only in release
builds — a dev build says it can't host rather than failing three steps in.
`server/hostingShell.test.ts` holds the Rust, the bundle script, the CI
wiring, and the policy to the same names, steps, and versions, and CI now
cargo-checks the shell on both shipping platforms on every push.

**Federation has its proof (ADR 0010's criterion, runnable).**
`scripts/e2e-federation.sh` stands up two complete instances that share
exactly one thing — a network between their homeservers, over a real TLS
federation transport — then proves a federated invite crosses, messages cross
both ways, both indexes attribute both senders (one by local account, one as
`userId NULL` plus a bare Matrix id), a moderator's redaction of a federated
sender clears both indexes, and neither side's conformance or `/metrics`
regresses. One splice is stated where it happens: B's channel row is INSERTed
directly, because no attach-a-remote-room surface exists yet. The 0.7 checkbox
ticks on the harness's first green run on a real Docker host.

**The site has a download page.** Per-platform buttons that say what each
installer does — including which ones can host — plus the server installs for
machines that stay on without you. `check-site.sh` now also fails if a
download link points at a release other than the version everything else
claims, which is the same guard the status line already had.

## v0.5.1 — 2026-08-16

**v0.5.0's desktop builds never shipped, and this is the release that fixes
why.** A bump-time edit to `desktop/src-tauri/Cargo.lock` used a pattern that
matched every crate pinned at the old version, not just this package — turning
`heck 0.4.1` into a second `heck 0.5.0` entry. Cargo refuses a lockfile like
that, so all three platform builds died in CI while every local check stayed
green, because nothing local parses the lockfile. The lockfile is restored
from history with only the one intended change, and `check-versions.sh` (run
by preflight and the release guard) now fails on duplicate lockfile packages —
the mistake now costs seconds locally instead of a broken release.

Everything below rode the broken tag and ships properly here.

**Onboarding that reads the room (0.6).** The sign-in page now fetches the
instance's name, description, and join policy and shapes itself around them:
invite-only instances show an invite-code field with an explanation instead of
letting a visitor type a doomed signup and learn the policy from a 403; closed
instances say they're closed; a code typed into the form or carried by an
invite link both feed registration. The first account — the person who just
set the instance up — lands on an administrator's welcome that says what to do
next instead of a generic empty state.

**The index can represent federated senders (ADR 0010, the 0.7 brick).**
`messages.userId` is nullable and every message carries its full Matrix
sender id (migration 0008). The ingest records remote members of known rooms
— previously it skipped them, which under federation would have meant
conversations with silent holes. Display falls back to the Matrix id
(`@ana:their.server`): honest, unambiguous, no invented profiles. Moderation
of federated messages rides the moderator's own session and room power
levels. The 0.7 checkbox stays open until a two-instance harness proves
messages, senders, and redactions actually cross.

**Third-party trademark removed.** The scaffold's speculative NFT-subscription
feature carried the name of a competitor's paid tier through a table, an enum,
a router, and a soundboard flag. All of it is gone — migration 0007 drops the
table, the enum, and the column; the router and its client surface never had a
caller. Migration history keeps the word in already-applied files, which are
immutable by design; everything living is clean.

**Administration without SSH (0.6).** The server settings dialog grows two
tabs. *Health*: live dependency status (database, homeserver, IPFS — each
probed with a 2-second bound through the new admin-gated `admin.overview`),
direct-sync and event-ingest state, version, uptime, and instance totals,
refreshing every ten seconds while watched. *Members*: every account on the
instance with role management — grant and revoke admin from the client, with
the existing self-demotion guard, so an instance always keeps at least the
administrator you are.

## v0.5.0 — 2026-08-16

Portable infrastructure, completed — and the architecture that end-to-end
encryption requires, in place before the encryption itself.

**Encrypted backups at rest.** Set `SOVRGN_BACKUP_PASSPHRASE` and the backup
archive is sealed in an authenticated envelope (scrypt, N=2^15, + AES-256-GCM
with the format magic as authenticated data). The plaintext inside is a
byte-for-byte ordinary archive, so every existing validation and restore path
works unchanged after the envelope opens. Wrong passphrase and corrupt file
fail loudly at open — GCM cannot tell them apart, and the error says so.
Restore detects encryption by content, not filename.

**Prometheus metrics.** `GET /metrics` in text exposition format: build info,
uptime, memory, and up/down gauges for database, homeserver, and IPFS — each
probed at scrape time with a 2-second bound, because monitoring that hangs
with the incident is decoration. Instance totals (users, communities,
messages) are included only when the database can actually answer; totals
only, no per-user cardinality. `METRICS_TOKEN` makes the endpoint
bearer-gated.

**Documented, deterministic upgrades.** `docs/UPGRADING.md` — previously
referenced by the threat model and missing — now exists: what `sovrgnnet
update` actually does, what deterministic means here (pinned images, frozen
lockfile, journaled linear migrations), why downgrade is restore, and the
version-specific notes including the T18 room-state repair options.

**E2EE groundwork (ADR 0008 stage 4, first slice).** The sync engine now
delivers the crypto signal set — to-device messages (from the initial batch
too, where queued room keys live; dropping them would make messages
permanently undecryptable), device-list changes, and one-time-key counts. The
appservice records `m.room.encryption` state, so a room any client encrypts
is known to the index; channels carry an `encrypted` flag (migration 0006);
encrypted events render as explicitly unreadable rather than as blank rows;
and both send paths — API and client-authored — refuse to send plaintext into
an encrypted room instead of quietly undermining it. The `e2ee` capability
remains false: this is the transport and index shape encryption requires, not
encryption.

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
