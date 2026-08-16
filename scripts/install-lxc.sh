#!/usr/bin/env bash
#
# SOVRGNnet — native install, no Docker.
#
# Built for a Proxmox LXC container, but it works on any bare Debian or Ubuntu
# machine. Everything runs as ordinary systemd services:
#
#   postgresql        accounts, servers, channels, messages
#   dendrite          the Matrix homeserver (127.0.0.1:6167)
#   ipfs              Kubo, storing shared files (127.0.0.1:5001)
#   sovrgnnet         the app itself (:3000)
#   cloudflared       optional, only if you want a public address
#
# Run as root inside a fresh container:
#
#   apt update && apt install -y git
#   git clone https://github.com/Formicaria/SOVRGNnet.cc.git /opt/sovrgnnet
#   /opt/sovrgnnet/scripts/install-lxc.sh
#
# Safe to run again — it keeps the secrets and data it already generated.

set -euo pipefail

APP_DIR="/opt/sovrgnnet"
ENV_DIR="/etc/sovrgnnet"
ENV_FILE="$ENV_DIR/sovrgnnet.env"
DENDRITE_CONFIG="/etc/dendrite/dendrite.yaml"
DENDRITE_DATA="/var/lib/dendrite"
# Dendrite publishes no binaries — source tarballs only — so it's built here.
# See docs/adr/0006-dendrite-replaces-conduit.md.
DENDRITE_VERSION="${DENDRITE_VERSION:-v0.15.2}"
GO_VERSION="${GO_VERSION:-1.23.4}"
IPFS_HOME="/var/lib/ipfs"

# ---------------------------------------------------------------- appearance

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); PURPLE=$(tput setaf 5)
else
  BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; PURPLE=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$PURPLE" "$RESET" "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
hint()  { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
fail()  { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ -n "$__default" ]; then
    printf '  %s %s[%s]%s ' "$__prompt" "$DIM" "$__default" "$RESET"
  else
    printf '  %s ' "$__prompt"
  fi
  read -r __reply </dev/tty || true
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40
  fi
}

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -1
}

lan_ip() {
  local ip=""
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
  [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${ip:-localhost}"
}

banner() {
  printf '\n'
  printf '%s   ███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗ ███╗   ██╗%s\n' "$PURPLE" "$RESET"
  printf '%s   ██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝ ████╗  ██║%s\n' "$PURPLE" "$RESET"
  printf '%s   ███████╗██║   ██║██║   ██║██████╔╝██║  ███╗██╔██╗ ██║%s\n' "$PURPLE" "$RESET"
  printf '%s   ╚════██║██║   ██║╚██╗ ██╔╝██╔══██╗██║   ██║██║╚██╗██║%s\n' "$PURPLE" "$RESET"
  printf '%s   ███████║╚██████╔╝ ╚████╔╝ ██║  ██║╚██████╔╝██║ ╚████║%s\n' "$PURPLE" "$RESET"
  printf '%s   ╚══════╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝%s\n' "$PURPLE" "$RESET"
  printf '\n   %sYour own chat network. Your hardware. Your rules.%s\n' "$DIM" "$RESET"
  printf '   %snative install · no docker · systemd services%s\n' "$DIM" "$RESET"
  printf '\n'
}

# ------------------------------------------------------------------ preflight

banner

step "Checking this machine"

[ "$(id -u)" -eq 0 ] || fail "Run this as root (it installs system services)."
command -v systemctl >/dev/null 2>&1 || fail "This needs systemd. Is this a minimal container?"
[ -f /etc/debian_version ] || warn "Not Debian or Ubuntu — this may not go smoothly."

case "$(uname -m)" in
  x86_64)          GO_ARCH="amd64"; KUBO_ARCH="linux-amd64" ;;
  aarch64|arm64)   GO_ARCH="arm64"; KUBO_ARCH="linux-arm64" ;;
  *) fail "Unsupported architecture: $(uname -m)." ;;
esac
ok "$(uname -m)"

if [ ! -d "$APP_DIR/.git" ] && [ ! -f "$APP_DIR/package.json" ]; then
  fail "Expected the SOVRGNnet source at $APP_DIR. Clone it there first."
fi

# systemd-detect-virt tells us whether we're in a container; harmless if absent.
if command -v systemd-detect-virt >/dev/null 2>&1; then
  VIRT="$(systemd-detect-virt 2>/dev/null || echo none)"
  [ "$VIRT" = "lxc" ] && ok "Running inside an LXC container."
fi

# ------------------------------------------------------------------- packages

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git xz-utils tar \
  postgresql postgresql-contrib \
  openssl >/dev/null
ok "Base packages, PostgreSQL"

# Node via NodeSource, keyed properly rather than piping a script into a shell.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v)"

command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10 --silent >/dev/null 2>&1
ok "pnpm $(pnpm --version)"

# ------------------------------------------------------------------- secrets

step "Settings"

install -d -m 0750 "$ENV_DIR"

JWT_SECRET="$(env_get JWT_SECRET)";                 [ -z "$JWT_SECRET" ] && JWT_SECRET="$(secret)"
DB_PASSWORD="$(env_get DB_PASSWORD)";               [ -z "$DB_PASSWORD" ] && DB_PASSWORD="$(secret)"
# Read the old name too, so a Conduit-era install upgrades rather than
# silently minting a secret the homeserver will not accept.
MATRIX_SHARED_SECRET="$(env_get MATRIX_SHARED_SECRET)"
[ -z "$MATRIX_SHARED_SECRET" ] && MATRIX_SHARED_SECRET="$(env_get MATRIX_REGISTRATION_TOKEN)"
[ -z "$MATRIX_SHARED_SECRET" ] && MATRIX_SHARED_SECRET="$(secret)"

MATRIX_SERVER_NAME="$(env_get MATRIX_SERVER_NAME)"
ACCESS_MODE="$(env_get SOVRGNNET_ACCESS_MODE)"
DOMAIN="$(env_get DOMAIN)"
TUNNEL_TOKEN="$(env_get CLOUDFLARE_TUNNEL_TOKEN)"

if [ -z "$ACCESS_MODE" ]; then
  printf '\n  %sHow should people reach your SOVRGNnet?%s\n\n' "$BOLD" "$RESET"
  printf '    %s1%s  Just this network\n' "$BOLD" "$RESET"
  printf '    %s2%s  Friends over the internet — %sno account, no domain%s\n' "$BOLD" "$RESET" "$GREEN" "$RESET"
  printf '    %s3%s  My own domain, through Cloudflare\n' "$BOLD" "$RESET"
  printf '\n'
  choice=""
  while true; do
    ask choice "Pick a number" "1"
    case "$choice" in
      1) ACCESS_MODE="local"; break ;;
      2) ACCESS_MODE="quick"; break ;;
      3) ACCESS_MODE="tunnel"; break ;;
      *) warn "Enter 1, 2, or 3." ;;
    esac
  done

  if [ "$ACCESS_MODE" = "tunnel" ]; then
    while [ -z "$TUNNEL_TOKEN" ]; do
      ask TUNNEL_TOKEN "Paste your Cloudflare tunnel token:" ""
      TUNNEL_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | tr ' ' '\n' | grep -E '^ey' | tail -1 || true)"
      [ -z "$TUNNEL_TOKEN" ] && warn "Tokens start with 'ey'."
    done
    ask DOMAIN "What address will people type?" ""
    DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
  fi
fi

# Baked into every Matrix ID at creation; never change it after first launch.
if [ -z "$MATRIX_SERVER_NAME" ]; then
  if [ "$ACCESS_MODE" = "tunnel" ] && [ -n "$DOMAIN" ]; then
    MATRIX_SERVER_NAME="matrix.$DOMAIN"
  else
    MATRIX_SERVER_NAME="sovrgn.local"
  fi
fi

cat > "$ENV_FILE" <<EOF
# SOVRGNnet — native install. Written by install-lxc.sh on $(date '+%Y-%m-%d %H:%M').
# Real secrets. Readable only by root and the sovrgnnet service user.

SOVRGNNET_RUNTIME=native

JWT_SECRET=$JWT_SECRET
DB_PASSWORD=$DB_PASSWORD
MATRIX_SHARED_SECRET=$MATRIX_SHARED_SECRET

DATABASE_URL=postgresql://sovrgn:$DB_PASSWORD@127.0.0.1:5432/sovrgnnet
NODE_ENV=production
PORT=3000
VITE_APP_TITLE=SOVRGNnet

MATRIX_HOMESERVER_URL=http://127.0.0.1:6167
MATRIX_SERVER_NAME=$MATRIX_SERVER_NAME
MATRIX_ALLOW_FEDERATION=${MATRIX_ALLOW_FEDERATION:-false}

IPFS_API_URL=http://127.0.0.1:5001

SOVRGNNET_ACCESS_MODE=$ACCESS_MODE
DOMAIN=$DOMAIN
CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN
EOF
chmod 640 "$ENV_FILE"
ok "Settings written to $ENV_FILE"

# ------------------------------------------------------------------ postgres

step "Database"

systemctl enable --now postgresql >/dev/null 2>&1 || true

# Wait for the socket — a fresh cluster takes a moment on slow storage.
for _ in $(seq 1 30); do
  su - postgres -c "psql -tAc 'select 1'" >/dev/null 2>&1 && break
  sleep 1
done

if su - postgres -c "psql -tAc \"select 1 from pg_roles where rolname='sovrgn'\"" | grep -q 1; then
  su - postgres -c "psql -qc \"alter role sovrgn with password '$DB_PASSWORD'\"" >/dev/null
  ok "Database role updated"
else
  su - postgres -c "psql -qc \"create role sovrgn with login password '$DB_PASSWORD'\"" >/dev/null
  ok "Database role created"
fi

if ! su - postgres -c "psql -tAc \"select 1 from pg_database where datname='sovrgnnet'\"" | grep -q 1; then
  su - postgres -c "createdb -O sovrgn sovrgnnet"
  ok "Database created"
else
  ok "Database already present"
fi

# ------------------------------------------------------------------ dendrite

step "Matrix homeserver (Dendrite)"

id -u dendrite >/dev/null 2>&1 || \
  adduser --system dendrite --group --disabled-login --no-create-home >/dev/null

# Dendrite gets its own database inside the PostgreSQL instance already
# running here. One engine, one backup — Conduit kept a separate RocksDB store.
if ! su - postgres -c "psql -tAc \"select 1 from pg_database where datname='dendrite'\"" | grep -q 1; then
  su - postgres -c "createdb -O sovrgn dendrite"
  ok "Homeserver database created"
fi

if [ ! -x /usr/local/bin/dendrite ]; then
  # Built from source because Dendrite publishes no binaries — only source
  # tarballs. Go is fetched, used, and left in /usr/local/go.
  hint "Building the homeserver (a few minutes; Dendrite ships no binaries)..."

  if ! command -v go >/dev/null 2>&1; then
    TMP_GO="$(mktemp -d)"
    curl -fsSL -o "$TMP_GO/go.tar.gz" \
      "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "$TMP_GO/go.tar.gz"
    rm -rf "$TMP_GO"
  fi
  export PATH="/usr/local/go/bin:$PATH"

  TMP_SRC="$(mktemp -d)"
  curl -fsSL -o "$TMP_SRC/dendrite.tar.gz" \
    "https://github.com/element-hq/dendrite/archive/refs/tags/${DENDRITE_VERSION}.tar.gz"
  tar xzf "$TMP_SRC/dendrite.tar.gz" -C "$TMP_SRC"

  # CGO off: with the PostgreSQL backend Dendrite needs no C dependencies,
  # which is also what lets it cross-compile for Windows later.
  ( cd "$TMP_SRC"/dendrite-* && CGO_ENABLED=0 go build -trimpath -o /usr/local/bin/ ./cmd/dendrite ./cmd/generate-keys )
  rm -rf "$TMP_SRC"
  ok "Dendrite $DENDRITE_VERSION built"
else
  ok "Dendrite already installed"
fi

install -d -m 0755 /etc/dendrite
install -d -o dendrite -g dendrite -m 0700 "$DENDRITE_DATA"
install -d -o dendrite -g dendrite -m 0700 "$DENDRITE_DATA/media"

# The signing key is this server's identity on the Matrix network. Generated
# once; regenerating it makes the server a different server.
if [ ! -f /etc/dendrite/matrix_key.pem ]; then
  /usr/local/bin/generate-keys --private-key /etc/dendrite/matrix_key.pem >/dev/null
  ok "Signing key generated"
else
  ok "Keeping the existing signing key"
fi
chown dendrite:dendrite /etc/dendrite/matrix_key.pem
chmod 600 /etc/dendrite/matrix_key.pem

# Public registration is disabled outright. Accounts are created by the app
# through shared-secret registration, so nobody who finds this homeserver can
# sign up on it.
DISABLE_FEDERATION="true"
[ "${MATRIX_ALLOW_FEDERATION:-false}" = "true" ] && DISABLE_FEDERATION="false"

sed \
  -e "s|__MATRIX_SERVER_NAME__|$MATRIX_SERVER_NAME|g" \
  -e "s|__MATRIX_SHARED_SECRET__|$MATRIX_SHARED_SECRET|g" \
  -e "s|__DENDRITE_DISABLE_FEDERATION__|$DISABLE_FEDERATION|g" \
  -e "s|__DENDRITE_DATABASE_URL__|postgresql://sovrgn:$DB_PASSWORD@127.0.0.1:5432/dendrite?sslmode=disable|g" \
  "$APP_DIR/dendrite/dendrite.yaml.template" > "$DENDRITE_CONFIG"

chown dendrite:dendrite "$DENDRITE_CONFIG"
chmod 600 "$DENDRITE_CONFIG"

cat > /etc/systemd/system/dendrite.service <<EOF
[Unit]
Description=Dendrite Matrix homeserver (SOVRGNnet)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=dendrite
Group=dendrite
WorkingDirectory=$DENDRITE_DATA
ExecStart=/usr/local/bin/dendrite --config $DENDRITE_CONFIG --http-bind-address 127.0.0.1:6167
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DENDRITE_DATA

[Install]
WantedBy=multi-user.target
EOF
ok "Dendrite configured"

# ---------------------------------------------------------------------- ipfs

step "File storage (IPFS)"

id -u ipfs >/dev/null 2>&1 || \
  adduser --system ipfs --group --disabled-login --home "$IPFS_HOME" >/dev/null
install -d -o ipfs -g ipfs -m 0750 "$IPFS_HOME"

if [ ! -x /usr/local/bin/ipfs ]; then
  hint "Downloading Kubo..."
  KUBO_VERSION="$(curl -fsSL https://dist.ipfs.tech/kubo/versions | grep -v -- '-rc' | tail -1)"
  KUBO_VERSION="${KUBO_VERSION:-v0.43.0}"
  KUBO_FILE="kubo_${KUBO_VERSION}_${KUBO_ARCH}.tar.gz"
  KUBO_BASE="https://dist.ipfs.tech/kubo/${KUBO_VERSION}"

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/$KUBO_FILE" "$KUBO_BASE/$KUBO_FILE"

  # Verify against the checksum published alongside it. A tarball that
  # becomes a long-running daemon is worth thirty seconds of paranoia.
  if curl -fsSL -o "$TMP/$KUBO_FILE.sha512" "$KUBO_BASE/$KUBO_FILE.sha512" 2>/dev/null; then
    if ( cd "$TMP" && sha512sum -c "$KUBO_FILE.sha512" >/dev/null 2>&1 ); then
      ok "Checksum verified"
    else
      fail "Kubo checksum did not match. Refusing to install — try again, and if it repeats, something is wrong upstream or in between."
    fi
  else
    warn "No checksum published for this release; skipping verification."
  fi

  tar xzf "$TMP/$KUBO_FILE" -C "$TMP"
  install -m 0755 "$TMP/kubo/ipfs" /usr/local/bin/ipfs
  rm -rf "$TMP"
  trap - EXIT
  ok "Kubo $KUBO_VERSION installed"
else
  ok "Kubo already installed"
fi

if [ ! -f "$IPFS_HOME/config" ]; then
  su -s /bin/sh ipfs -c "IPFS_PATH=$IPFS_HOME /usr/local/bin/ipfs init --profile server" >/dev/null
fi

# The API is an unauthenticated admin socket — it must never leave loopback.
su -s /bin/sh ipfs -c "IPFS_PATH=$IPFS_HOME /usr/local/bin/ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001"
su -s /bin/sh ipfs -c "IPFS_PATH=$IPFS_HOME /usr/local/bin/ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8081"

cat > /etc/systemd/system/ipfs.service <<EOF
[Unit]
Description=IPFS daemon (SOVRGNnet)
After=network.target

[Service]
Environment="IPFS_PATH=$IPFS_HOME"
User=ipfs
Group=ipfs
ExecStart=/usr/local/bin/ipfs daemon --migrate=true
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$IPFS_HOME

[Install]
WantedBy=multi-user.target
EOF
ok "IPFS configured"

# ----------------------------------------------------------------------- app

step "Building the app (a few minutes)"

id -u sovrgnnet >/dev/null 2>&1 || \
  adduser --system sovrgnnet --group --disabled-login --no-create-home >/dev/null

cd "$APP_DIR"
pnpm install --frozen-lockfile --silent
pnpm build >/dev/null
ok "Built"

# The service user needs to read the source tree and the env file, and to
# write nothing except its own logs.
chown -R sovrgnnet:sovrgnnet "$APP_DIR/dist"
chgrp sovrgnnet "$ENV_FILE"
install -d -o sovrgnnet -g sovrgnnet -m 0750 "$APP_DIR/logs"

cat > /etc/systemd/system/sovrgnnet.service <<EOF
[Unit]
Description=SOVRGNnet
After=network.target postgresql.service dendrite.service ipfs.service
Wants=postgresql.service dendrite.service ipfs.service

[Service]
Type=simple
User=sovrgnnet
Group=sovrgnnet
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/logs

[Install]
WantedBy=multi-user.target
EOF
ok "Service installed"

# --------------------------------------------------------------- cloudflared

if [ "$ACCESS_MODE" = "quick" ] || [ "$ACCESS_MODE" = "tunnel" ]; then
  step "Public access (cloudflared)"

  if [ ! -x /usr/local/bin/cloudflared ]; then
    case "$KUBO_ARCH" in
      linux-amd64) CF_ARCH="amd64" ;;
      linux-arm64) CF_ARCH="arm64" ;;
    esac
    curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
    chmod +x /usr/local/bin/cloudflared
  fi

  if [ "$ACCESS_MODE" = "quick" ]; then
    CF_EXEC="/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000"
  else
    CF_EXEC="/usr/local/bin/cloudflared tunnel --no-autoupdate run --token $TUNNEL_TOKEN"
  fi

  cat > /etc/systemd/system/sovrgnnet-tunnel.service <<EOF
[Unit]
Description=Cloudflare tunnel for SOVRGNnet
After=network.target sovrgnnet.service
Wants=sovrgnnet.service

[Service]
Type=simple
User=nobody
ExecStart=$CF_EXEC
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  ok "Tunnel configured"
fi

# -------------------------------------------------------------------- launch

step "Starting everything"

systemctl daemon-reload
systemctl enable --now dendrite ipfs >/dev/null 2>&1
sleep 3
systemctl enable --now sovrgnnet >/dev/null 2>&1
[ -f /etc/systemd/system/sovrgnnet-tunnel.service ] && \
  systemctl enable --now sovrgnnet-tunnel >/dev/null 2>&1

waited=0
until curl -fsS -o /dev/null http://127.0.0.1:3000 2>/dev/null; do
  waited=$((waited + 3))
  if [ "$waited" -ge 120 ]; then
    warn "The app hasn't answered after two minutes."
    hint "See why with:  journalctl -u sovrgnnet -n 50"
    break
  fi
  printf '.'
  sleep 3
done
printf '\n'

# Handy from anywhere, and it picks native mode up from the env file.
ln -sf "$APP_DIR/sovrgnnet" /usr/local/bin/sovrgnnet

# --------------------------------------------------------------------- done

URL="http://$(lan_ip):3000"
if [ "$ACCESS_MODE" = "tunnel" ] && [ -n "$DOMAIN" ]; then
  URL="https://$DOMAIN"
elif [ "$ACCESS_MODE" = "quick" ]; then
  for _ in $(seq 1 20); do
    FOUND=$(journalctl -u sovrgnnet-tunnel --no-pager 2>/dev/null \
            | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
    [ -n "$FOUND" ] && { URL="$FOUND"; break; }
    sleep 2
  done
fi

printf '\n%s─────────────────────────────────────────────────────────%s\n\n' "$PURPLE" "$RESET"
printf '  %sSOVRGNnet is live.%s\n\n' "$BOLD$GREEN" "$RESET"
printf '  Open   %s%s%s\n\n' "$BOLD" "$URL" "$RESET"
printf '  %sThe first account you create becomes the admin.%s\n' "$DIM" "$RESET"
[ "$ACCESS_MODE" = "quick" ] && \
  printf '  %sThat link changes on restart — see the current one with: sovrgnnet url%s\n' "$DIM" "$RESET"
printf '\n  Day to day:\n'
printf '    %ssovrgnnet status%s    is everything healthy?\n' "$BOLD" "$RESET"
printf '    %ssovrgnnet logs%s      watch what it is doing\n' "$BOLD" "$RESET"
printf '    %ssovrgnnet backup%s    save a copy of everything\n' "$BOLD" "$RESET"
printf '    %ssovrgnnet update%s    get the latest version\n' "$BOLD" "$RESET"
printf '\n%s─────────────────────────────────────────────────────────%s\n\n' "$PURPLE" "$RESET"
