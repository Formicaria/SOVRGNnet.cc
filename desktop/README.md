# SOVRGNnet desktop client

The client that connects to many SOVRGNnet servers at once, holds its own
Matrix keys, and eventually does voice. See
[ADR 0001](../docs/adr/0001-multi-server-client.md) for why it exists and what
it changes.

## Status

**Written, not yet run.** Every file here is complete and coherent, but the
Rust has never been compiled and the frontend has never been rendered —
neither has a toolchain in the environment it was written in. Treat the first
`pnpm tauri dev` as the real test, and expect to fix things.

The parts that *are* verified are the ones that matter most, because they live
in `shared/` and are covered by the root test suite: connection management
(23 tests), invite parsing (20), and deep-link routing (15). Those are the
pieces where a bug would be subtle. The rest is wiring.

The encrypted transport does not exist. The client loads each server's own web
UI, so messages still pass through that server in plaintext. That changes at
step 4 of ADR 0001, and nothing here should be described as encrypted until it
does.

What's built:

- Multi-server connection management, shared with the web app
- `sovrgn://invite/<host>/<code>` deep links, including the cold-start case
  where the URL arrives before React has mounted
- One webview per server, kept alive on switch so each origin holds its own
  cookies, storage, and scroll position — the thing a browser tab can't do
- Per-server credentials in the OS keychain
- Scheme checking on every URL before a webview is pointed at it

What isn't:

- Client-side Matrix sync
- End-to-end encryption
- Voice
- Auto-update
- Any packaging beyond the bundle config

## Verifying it yourself

The root suite covers the shared logic:

```bash
pnpm test          # from the repository root
```

The desktop package typechecks separately, since it has its own dependencies:

```bash
cd desktop && pnpm install && pnpm check
```

## Building it

Needs [Rust](https://rustup.rs) and the
[Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your
platform.

```bash
cd desktop
pnpm install
pnpm tauri dev      # run against the dev build
pnpm tauri build    # produce installers
```

On Linux you'll want `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, and
`build-essential` at minimum; the Tauri docs have the current list per distro.

## How the pieces fit

```
desktop/
  src-tauri/
    src/main.rs            window, deep links, keychain commands
    tauri.conf.json        app identity, the sovrgn:// scheme, bundle config
    capabilities/          what the frontend is permitted to call
  src/                     the client UI (shares shared/ with the web app)
```

The connection layer lives in `shared/connections.ts` at the repository root,
not here, because the web app needs the same logic and there's no reason for
two implementations of "which servers am I connected to" to drift apart.

## Why a webview per server, for now

Loading each server's own web UI means the client works against *any* version
of a SOVRGNnet server, including ones older than itself. That property is worth
keeping as long as it's cheap.

It stops being cheap at step 4, when the client needs to hold Matrix keys and
decrypt locally — at which point the UI has to move into the client and talk to
each server's API directly. The connection layer is already written for that
world; the webview is the temporary part.
