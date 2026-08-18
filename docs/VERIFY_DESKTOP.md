# Verifying the desktop on a real build

The walk below is the stranger's path — install, host, first account, a
friend joining, sign-in — run on a locally built bundle before any release
that touches `desktop/`, hosting, invites, or identity. It exists because
three desktop features shipped compiled-but-never-run: the setup token (a
hosted server whose first account could not be created), identity CORS
(desktop SSO that had never worked once), and invite links that said
`127.0.0.1` (fixed in code, unverified on a build until this walk passes).

Every step names its expected outcome. Record what actually happened, not
whether it felt fine — "it's running" and "it's the right one" are separate
questions, and most of these steps exist to ask the second.

## Build what a stranger gets

```bash
./scripts/host-bundle.sh linux-x64          # needs Go on PATH; ~10 min first run
cd desktop && pnpm install && pnpm tauri build --bundles deb
sudo apt install ./src-tauri/target/release/bundle/deb/SOVRGNnet_*.deb
```

Windows: `host-bundle.sh windows-x64` on a Windows machine (Git Bash), then
`pnpm tauri build --bundles nsis` and run the `-setup.exe`. Expect SmartScreen
to warn — builds are unsigned, and the download page says so.

You need a **second device on the same network** (a phone browser is enough)
and, for step 8, the machine's LAN IP (`ip -4 addr` / `ipconfig`).

## The walk

Do these in order; several depend on state the earlier ones create.

**1. First launch.**
Expected: the welcome screen offers three actions, including *Run a server on
this computer* — its presence proves the bundle rode the installer. A dev
build shows only two and the host panel says this build can't host; if a
*release* build says that, stop here, the bundle didn't ship.

**2. Set up the server.**
Click through. Expected: named install steps in order (unpacking → database →
chat server → storage → keys → tables → starting), then "Your server is
running at `http://127.0.0.1:31xx`", and the server appears in the rail as a
connection. On Windows additionally expected: **no console windows flash**
during install or start.

**3. The claim check, from the second device, before any account exists.**
Open `http://<LAN-IP>:<port>` on the second device now. Expected: the page
loads (the app listens on all interfaces) and signing up demands a setup code
— a fresh server must not be claimable by whoever reaches it first. Anything
you type as the code is refused.

**4. First account, from the app.**
Sign up inside the app's own view. Expected: **no setup-code field, or one
already satisfied** — the token lives in the OS keychain and the app applies
it; a person is never shown a code they have no way to know. The account is
created and is the administrator. If the screen asks you to find a code in a
`.env`, the token plumbing regressed to exactly the bug it fixed.

**5. Community and encryption honesty.**
Create a community. Expected: `#general` exists, and because a hosted
server's homeserver is loopback-only, `e2ee` is false — the channel is
plaintext and the interface *says so* (status panel: "not end-to-end
encrypted"). A lock icon here would be a lie; absence of one is the pass.

**6. The invite link.**
Create an invite from the community. Expected: the link reads
`http://<LAN-IP>:<port>/invite/<code>` — **not** `127.0.0.1`. Loopback here
is the exact bug `server/lanHost.ts` exists to kill; record the URL you got.
(Offline/airplane-mode machines keep loopback deliberately — there is no
better answer to give.)

**7. The friend joins.**
Open that URL on the second device, register through it, post a message.
Expected: registration works without touching the setup code (invites are the
join path), the message appears on the owner's side within a few seconds
(hosted servers poll — no direct sync on loopback), and a reply crosses back.

**8. Files.**
Upload a file from each side; download it on the other. Expected:
byte-identical round trips both ways.

**9. Desktop SSO, the browser-origin way.**
First the transport, from a real browser origin — `curl` passed for a year
while the app never worked, because CORS only exists in browsers. From any
https page's devtools console:

```js
fetch("https://id.sovrgnnet.cc/api/device/code", { method: "POST" })
  .then(r => r.json()).then(console.log)
```

Expected: a JSON body with `device_code` and `user_code`, no CORS error in
the console. Then the product path: *Sign in with SOVRGNnet* in the app.
Expected: a code on screen, the browser opens `id.sovrgnnet.cc`, approving
there signs the app in, and any servers previously granted to the account are
adopted into the rail.

**10. Quit means quit.**
Quit the app. Expected: within a few seconds `pgrep -f 'host/pg'`,
`pgrep -f dendrite`, `pgrep -f 'ipfs daemon'` and the hosted node process all
return nothing (Windows: Task Manager shows none of the four). Orphaned
processes holding ports is the failure this checks for.

**11. Relaunch means resume.**
Start the app again. Expected: the server starts without being asked, the
same address works, the account still signs in, history is intact, and the
server kept its identity — the Matrix server name in the status panel is the
same `*.desktop.sovrgn.host` name as before, because a name that changed
would have orphaned every ID on the server.

**12. Honest failure (optional but worth one run).**
While running, kill the homeserver process by hand. Expected: the host panel
degrades to words — which component, what happened — rather than a spinner
or silence.

## Record

```
date:               commit:              version:
platform:           linux-x64 / windows-x64
step:  1[ ] 2[ ] 3[ ] 4[ ] 5[ ] 6[ ] 7[ ] 8[ ] 9[ ] 10[ ] 11[ ] 12[ ]
invite URL as issued:
anything that surprised you:
```

A release that touches the desktop tags only after a walk of this list on at
least one platform, with the record kept in the tag's notes or the PR. The
harnesses prove the server; this list is the part only a person with two
devices can prove.
