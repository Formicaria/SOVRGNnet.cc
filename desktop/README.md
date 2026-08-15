# SOVRGNnet desktop client

The client that connects to many SOVRGNnet servers at once, holds its own
Matrix keys, and eventually does voice. See
[ADR 0001](../docs/adr/0001-multi-server-client.md) for why it exists and what
it changes.

## Status

**Scaffold.** The shell, the deep-link handler, and the connection layer are
real. The encrypted transport is not — the client still loads each server's
web UI, which means messages still go through that server in plaintext. That
changes in step 4 of the sequencing in ADR 0001, and nothing here should be
described as encrypted until it does.

What works:

- Multi-server connection management — see `shared/connections.ts`, which is
  shared with the web app and covered by tests
- `sovrgn://invite/<host>/<code>` deep links, registered with the OS
- Per-server credentials in the OS keychain rather than browser storage

What doesn't, yet:

- Client-side Matrix sync (each server's web UI is loaded in a webview)
- End-to-end encryption
- Voice
- Auto-update

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
