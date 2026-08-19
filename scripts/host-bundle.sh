#!/usr/bin/env bash
#
# Assemble the hosted-server bundle the desktop app ships — ADR 0005.
#
#   ./scripts/host-bundle.sh linux-x64      # or windows-x64
#
# Fills desktop/src-tauri/host/ with everything the supervisor needs to turn
# a client install into a server:
#
#   host/
#     postgres/            full PostgreSQL dist (bin, lib, share)
#     dendrite[.exe]       the Matrix homeserver, built from the pinned tag
#     generate-keys[.exe]  its signing-key tool, same build
#     kubo[.exe]           IPFS
#     livekit[.exe]        the voice SFU, so a desktop host offers voice out of the box
#     node[.exe]           the Node runtime that runs the app bundle
#     app/                 self-contained server: index.mjs, public/, drizzle/
#     dendrite.yaml.template
#
# Version pins match the rest of the repository where a counterpart exists:
# Kubo and Dendrite are the same versions docker-compose.yml pins, because a
# desktop-hosted server and a Docker one should not quietly diverge. Every
# download is printed with its sha256 so a build log is an auditable record.
#
# Run in CI before `tauri build`; also runs on a workstation for a local
# release build. Dendrite needs Go on PATH.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

TARGET="${1:-}"
case "$TARGET" in
  linux-x64|windows-x64) ;;
  *) echo "Usage: $0 linux-x64|windows-x64" >&2; exit 2 ;;
esac

# --- pins --------------------------------------------------------------------
NODE_VERSION="${HOST_NODE_VERSION:-22.12.0}"
KUBO_VERSION="${HOST_KUBO_VERSION:-0.43.0}"       # = docker-compose.yml ipfs/kubo pin
DENDRITE_TAG="${HOST_DENDRITE_TAG:-v0.15.2}"      # = docker-compose.yml dendrite pin
# zonky's embedded-postgres binaries: plain PostgreSQL, repackaged per
# platform, on Maven Central. Major matches the compose file's postgres:16.
PG_VERSION="${HOST_PG_VERSION:-16.6.0}"
# No compose-file counterpart to match: a dedicated deployment's operator runs
# their own SFU (docs/VOICE.md), so this pin is the desktop host's alone.
LIVEKIT_VERSION="${HOST_LIVEKIT_VERSION:-1.13.1}"

HOST_DIR="desktop/src-tauri/host"
WORK="$(mktemp -d -t sovrgnnet-host.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

say()  { printf '\n▸ %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

fetch() {
  local url="$1" out="$2"
  curl -fSL --retry 3 -o "$out" "$url" || die "download failed: $url"
  printf '  sha256 %s  %s\n' "$(sha256sum "$out" | cut -d' ' -f1)" "$(basename "$out")"
}

# Extraction goes through Python's own zipfile/tarfile, because the GitHub
# Windows runners have neither unzip nor a GNU tar that reads zip — and
# Python is on every runner and every workstation this will meet.
unpack() {
  local archive="$1" dest="$2"
  case "$archive" in
    *.zip|*.jar) python3 -m zipfile -e "$archive" "$dest" ;;
    *.tar.gz|*.tgz|*.tar.xz|*.txz) python3 -m tarfile -e "$archive" "$dest" ;;
    *) die "don't know how to unpack $archive" ;;
  esac
}

command -v curl >/dev/null || die "curl is required"
command -v python3 >/dev/null || die "python3 is required (archive extraction)"
command -v go >/dev/null || die "Go is required to build Dendrite from source"
command -v pnpm >/dev/null || die "pnpm is required"

rm -rf "$HOST_DIR"
mkdir -p "$HOST_DIR"

# --- the app, self-contained -------------------------------------------------
say "Building the self-contained app bundle"
pnpm build >/dev/null
pnpm build:host >/dev/null
mkdir -p "$HOST_DIR/app"
cp dist-host/index.mjs "$HOST_DIR/app/index.mjs"
node --check "$HOST_DIR/app/index.mjs" || die "the host server bundle doesn't parse"
cp -r dist/public "$HOST_DIR/app/public"
cp -r drizzle "$HOST_DIR/app/drizzle"

# Creating the two databases, without `createdb`. zonky's embedded-postgres
# binaries omit the client tools on Windows and Linux and include them on
# macOS, so a bundle built on a Mac works and the same bundle built anywhere
# else fails on a user's first run. Bundling this removes the dependency
# rather than working around it — see scripts/host-createdbs.ts.
pnpm exec esbuild scripts/host-createdbs.ts \
  --platform=node --bundle --format=esm \
  --outfile="$HOST_DIR/app/createdbs.mjs" >/dev/null
node --check "$HOST_DIR/app/createdbs.mjs" || die "the createdbs bundle doesn't parse"
# Immutable migration inputs only — snapshots and journal ride along because
# the runtime migrator reads the journal.
ok "app bundle: index.mjs + public/ + drizzle/"

cp dendrite/dendrite.yaml.template "$HOST_DIR/dendrite.yaml.template"

# --- node runtime ------------------------------------------------------------
say "Node $NODE_VERSION"
case "$TARGET" in
  linux-x64)
    fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$WORK/node.tar.xz"
    unpack "$WORK/node.tar.xz" "$WORK"
    install -m 755 "$WORK/node-v$NODE_VERSION-linux-x64/bin/node" "$HOST_DIR/node"
    ;;
  windows-x64)
    fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" "$WORK/node.zip"
    unpack "$WORK/node.zip" "$WORK"
    cp "$WORK/node-v$NODE_VERSION-win-x64/node.exe" "$HOST_DIR/node.exe"
    ;;
esac
ok "node runtime in place"

# --- kubo --------------------------------------------------------------------
say "Kubo $KUBO_VERSION"
case "$TARGET" in
  linux-x64)
    fetch "https://dist.ipfs.tech/kubo/v$KUBO_VERSION/kubo_v${KUBO_VERSION}_linux-amd64.tar.gz" "$WORK/kubo.tgz"
    unpack "$WORK/kubo.tgz" "$WORK"
    install -m 755 "$WORK/kubo/ipfs" "$HOST_DIR/kubo"
    ;;
  windows-x64)
    fetch "https://dist.ipfs.tech/kubo/v$KUBO_VERSION/kubo_v${KUBO_VERSION}_windows-amd64.zip" "$WORK/kubo.zip"
    unpack "$WORK/kubo.zip" "$WORK"
    cp "$WORK/kubo/ipfs.exe" "$HOST_DIR/kubo.exe"
    ;;
esac
ok "kubo in place"

# --- dendrite ----------------------------------------------------------------
# Built from the pinned tag because upstream publishes containers, not
# binaries. Same code a Docker instance runs, compiled for this platform.
say "Dendrite $DENDRITE_TAG (building from source)"
git clone --quiet --depth 1 --branch "$DENDRITE_TAG" \
  https://github.com/element-hq/dendrite "$WORK/dendrite"
(
  cd "$WORK/dendrite"
  export CGO_ENABLED=0
  case "$TARGET" in
    linux-x64)   export GOOS=linux GOARCH=amd64; EXT="" ;;
    windows-x64) export GOOS=windows GOARCH=amd64; EXT=".exe" ;;
  esac
  go build -trimpath -ldflags "-s -w" -o "dendrite$EXT" ./cmd/dendrite
  go build -trimpath -ldflags "-s -w" -o "generate-keys$EXT" ./cmd/generate-keys
)
case "$TARGET" in
  linux-x64)   cp "$WORK/dendrite/dendrite" "$HOST_DIR/dendrite"; cp "$WORK/dendrite/generate-keys" "$HOST_DIR/generate-keys" ;;
  windows-x64) cp "$WORK/dendrite/dendrite.exe" "$HOST_DIR/dendrite.exe"; cp "$WORK/dendrite/generate-keys.exe" "$HOST_DIR/generate-keys.exe" ;;
esac
ok "dendrite + generate-keys built"

# --- livekit -----------------------------------------------------------------
# The voice SFU — ADR 0013 as superseded: every instance houses its own voice
# backend, and a desktop-hosted instance is no exception. Shipping it is what
# makes the supervisor able to say `voice: true` honestly, out of the box.
# The `install`/`cp` below fails loudly if upstream's archive layout ever
# stops putting `livekit-server` at the root — the fix belongs here, where
# re-running this script is the fix, not on somebody's first run.
say "LiveKit $LIVEKIT_VERSION"
LIVEKIT_BASE="https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION"
case "$TARGET" in
  linux-x64)
    fetch "$LIVEKIT_BASE/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" "$WORK/livekit.tgz"
    unpack "$WORK/livekit.tgz" "$WORK/livekit"
    install -m 755 "$WORK/livekit/livekit-server" "$HOST_DIR/livekit"
    ;;
  windows-x64)
    fetch "$LIVEKIT_BASE/livekit_${LIVEKIT_VERSION}_windows_amd64.zip" "$WORK/livekit.zip"
    unpack "$WORK/livekit.zip" "$WORK/livekit"
    cp "$WORK/livekit/livekit-server.exe" "$HOST_DIR/livekit.exe"
    ;;
esac
ok "livekit in place"

# --- postgres ----------------------------------------------------------------
say "PostgreSQL $PG_VERSION (zonky embedded binaries)"
ZONKY_BASE="https://repo1.maven.org/maven2/io/zonky/test/postgres"
case "$TARGET" in
  linux-x64)
    fetch "$ZONKY_BASE/embedded-postgres-binaries-linux-amd64/$PG_VERSION/embedded-postgres-binaries-linux-amd64-$PG_VERSION.jar" "$WORK/pg.jar"
    unpack "$WORK/pg.jar" "$WORK/pgjar"
    mkdir -p "$HOST_DIR/postgres"
    unpack "$(ls "$WORK/pgjar"/postgres-linux-*.txz)" "$HOST_DIR/postgres"
    ;;
  windows-x64)
    fetch "$ZONKY_BASE/embedded-postgres-binaries-windows-amd64/$PG_VERSION/embedded-postgres-binaries-windows-amd64-$PG_VERSION.jar" "$WORK/pg.jar"
    unpack "$WORK/pg.jar" "$WORK/pgjar"
    mkdir -p "$HOST_DIR/postgres"
    unpack "$(ls "$WORK/pgjar"/postgres-windows-*.txz)" "$HOST_DIR/postgres"
    ;;
esac
# Every PostgreSQL binary hosting.rs actually spawns, not just the first one.
#
# This checked `initdb` alone and treated it as proof the bundle was good. It
# is not: a Windows build shipped without `createdb`, `initdb` succeeded, the
# database cluster came up, and setup then died on
#
#   createdb sovrgnnet: couldn't run: The system cannot find the file specified
#
# — three steps into a first run, on somebody else's machine, for a file that
# was missing when the bundle was built. A missing binary should fail here,
# where the fix is re-running this script, rather than there.
# `createdb` is deliberately absent from this list: it is missing from the
# upstream tarball on two of three platforms, and nothing spawns it any more.
for tool in initdb postgres pg_ctl; do
  [ -x "$HOST_DIR/postgres/bin/$tool" ] || [ -f "$HOST_DIR/postgres/bin/$tool.exe" ] \
    || die "the PostgreSQL bundle has no $tool — upstream's layout changed, or this build omits client tools"
done
ok "postgres in place (initdb, postgres, pg_ctl)"

# --- summary -----------------------------------------------------------------
say "Bundle assembled"
du -sh "$HOST_DIR" | sed 's/^/  /'
find "$HOST_DIR" -maxdepth 1 | sort | sed 's/^/  /'
printf '\nThe supervisor (desktop/src-tauri/src/hosting.rs) expects exactly these names.\n'
