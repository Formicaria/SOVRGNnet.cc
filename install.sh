#!/usr/bin/env bash
#
# SOVRGNnet installer.
#
# Run this once:   ./install.sh
#
# It asks a handful of plain-language questions, generates every password and
# secret for you, and starts the whole thing. You do not need a domain name,
# a Cloudflare account, or any prior knowledge of Docker.
#
# Safe to run again later — your existing settings are kept.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env"

# ---------------------------------------------------------------- appearance

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); PURPLE=$(tput setaf 5)
else
  BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; PURPLE=""
fi

say()    { printf '%s\n' "$*"; }
step()   { printf '\n%s==>%s %s%s%s\n' "$PURPLE" "$RESET" "$BOLD" "$*" "$RESET"; }
ok()     { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()   { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()   { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
hint()   { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }

banner() {
  printf '\n'
  printf '%s   ███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗ ███╗   ██╗%s\n' "$PURPLE" "$RESET"
  printf '%s   ██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝ ████╗  ██║%s\n' "$PURPLE" "$RESET"
  printf '%s   ███████╗██║   ██║██║   ██║██████╔╝██║  ███╗██╔██╗ ██║%s\n' "$PURPLE" "$RESET"
  printf '%s   ╚════██║██║   ██║╚██╗ ██╔╝██╔══██╗██║   ██║██║╚██╗██║%s\n' "$PURPLE" "$RESET"
  printf '%s   ███████║╚██████╔╝ ╚████╔╝ ██║  ██║╚██████╔╝██║ ╚████║%s\n' "$PURPLE" "$RESET"
  printf '%s   ╚══════╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝%s\n' "$PURPLE" "$RESET"
  printf '\n   %sYour own chat network. Your hardware. Your rules.%s\n' "$DIM" "$RESET"
  printf '\n'
}

# Ask a question with a default. Usage: ask VAR "Question" "default"
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

# Yes/no. Usage: if confirm "Do the thing?" "y"; then ...
confirm() {
  local prompt="$1" default="${2:-n}" reply="" options="y/N"
  [ "$default" = "y" ] && options="Y/n"
  while true; do
    printf '  %s %s[%s]%s ' "$prompt" "$DIM" "$options" "$RESET"
    read -r reply </dev/tty || reply=""
    reply="${reply:-$default}"
    case "$reply" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

secret() {
  # 32 bytes of randomness, base64, alphanumeric only so nothing needs quoting
  # in .env, docker compose, or a Postgres connection string.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40
  fi
}

# Read a key's value out of an existing .env, if present.
env_get() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1
}

lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then
    ip=$(ipconfig getifaddr en0 2>/dev/null || true)
  fi
  printf '%s' "${ip:-localhost}"
}

# ------------------------------------------------------------------- docker

DOCKER_COMPOSE=""

detect_docker() {
  step "Checking for Docker"

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker isn't installed."
    say ""
    hint "Docker is the one piece of software SOVRGNnet needs. It runs the"
    hint "database, the chat server, and the app in tidy little boxes."
    say ""
    case "$(uname -s)" in
      Linux)
        say "  On this machine you can install it with Docker's official script:"
        say ""
        say "      ${BOLD}curl -fsSL https://get.docker.com | sudo sh${RESET}"
        say ""
        if confirm "Run that now?" "n"; then
          curl -fsSL https://get.docker.com | sudo sh
          sudo usermod -aG docker "$USER" 2>/dev/null || true
          ok "Docker installed."
          warn "You may need to log out and back in for permissions to apply."
        else
          fail "Install Docker, then run ./install.sh again."
        fi
        ;;
      Darwin)
        say "  Install Docker Desktop from https://docker.com/products/docker-desktop"
        say "  then open it once and run ./install.sh again."
        exit 1
        ;;
      *)
        say "  Install Docker from https://docs.docker.com/get-docker/ and try again."
        exit 1
        ;;
    esac
  fi

  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  else
    fail "Docker is installed but Docker Compose isn't. See https://docs.docker.com/compose/install/"
  fi

  if ! docker info >/dev/null 2>&1; then
    warn "Docker is installed but not responding."
    hint "If you just installed it, try: sudo systemctl start docker"
    hint "If you get a permissions error, log out and back in, or run this with sudo."
    fail "Can't talk to Docker."
  fi

  ok "Docker is ready ($DOCKER_COMPOSE)."
}

# ------------------------------------------------------------------ the ask

ACCESS_MODE=""
DOMAIN=""
TUNNEL_TOKEN=""
MATRIX_SERVER_NAME=""

choose_access() {
  step "How should people reach your SOVRGNnet?"
  say ""
  say "    ${BOLD}1${RESET}  Just me, on this network"
  hint "       Nothing leaves your house. Good for trying it out."
  say ""
  say "    ${BOLD}2${RESET}  Friends over the internet — ${GREEN}no account, no domain${RESET}"
  hint "       Gets you a public https:// link in about a minute. The link"
  hint "       changes if you restart, so it suits hangouts more than a"
  hint "       permanent home."
  say ""
  say "    ${BOLD}3${RESET}  My own domain, through Cloudflare"
  hint "       A permanent address like chat.example.com. Needs a free"
  hint "       Cloudflare account and a domain you own."
  say ""
  say "    ${BOLD}4${RESET}  My own domain, my own certificates"
  hint "       You already run a reverse proxy or have TLS certs. Advanced."
  say ""

  local choice=""
  while true; do
    ask choice "Pick a number" "1"
    case "$choice" in
      1) ACCESS_MODE="local";  break ;;
      2) ACCESS_MODE="quick";  break ;;
      3) ACCESS_MODE="tunnel"; break ;;
      4) ACCESS_MODE="proxy";  break ;;
      *) warn "Enter 1, 2, 3, or 4." ;;
    esac
  done

  case "$ACCESS_MODE" in
    local)
      ok "Home network only."
      ;;
    quick)
      ok "Public link, no account needed."
      hint "This uses Cloudflare's free quick tunnels. No signup involved."
      ;;
    tunnel)
      say ""
      hint "In the Cloudflare dashboard: Zero Trust -> Networks -> Tunnels ->"
      hint "Create a tunnel -> Cloudflared. Point a public hostname at"
      hint "http://app:3000, then copy the tunnel token it shows you."
      say ""
      local existing_token; existing_token="$(env_get CLOUDFLARE_TUNNEL_TOKEN)"
      if [ -n "$existing_token" ]; then
        ok "Found a tunnel token already saved."
        TUNNEL_TOKEN="$existing_token"
        if confirm "Replace it?" "n"; then TUNNEL_TOKEN=""; fi
      fi
      while [ -z "$TUNNEL_TOKEN" ]; do
        ask TUNNEL_TOKEN "Paste your tunnel token:" ""
        # People routinely paste the whole install command. Take the token.
        TUNNEL_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | tr ' ' '\n' | grep -E '^ey' | tail -1 || true)"
        [ -z "$TUNNEL_TOKEN" ] && warn "That didn't look like a token (they start with 'ey')."
      done
      ask DOMAIN "What address will people type?" "$(env_get DOMAIN)"
      DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
      ;;
    proxy)
      ask DOMAIN "What address will people type?" "$(env_get DOMAIN)"
      DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
      hint "Put your certificates in ./ssl/ as cert.pem and key.pem, then"
      hint "uncomment the TLS block at the bottom of nginx.conf."
      ;;
  esac
}

choose_matrix_name() {
  # Conduit bakes server_name into every user and room ID it creates. It
  # cannot be changed later without throwing away all chat history, so this
  # is the one setting worth getting right up front.
  local existing; existing="$(env_get MATRIX_SERVER_NAME)"
  if [ -n "$existing" ]; then
    MATRIX_SERVER_NAME="$existing"
    return
  fi

  case "$ACCESS_MODE" in
    tunnel|proxy)
      if [ -n "$DOMAIN" ]; then
        MATRIX_SERVER_NAME="matrix.$DOMAIN"
      else
        MATRIX_SERVER_NAME="sovrgn.local"
      fi
      ;;
    *)
      # Deliberately not an IP address: your LAN address can change, and this
      # name is permanent. Nothing needs to resolve it while federation is off.
      MATRIX_SERVER_NAME="sovrgn.local"
      ;;
  esac
}

# ------------------------------------------------------------------ writing

write_env() {
  step "Writing settings"

  # Keep secrets across re-runs — regenerating them would orphan every
  # existing account and lock people out of the database.
  local jwt db_pass matrix_token
  jwt="$(env_get JWT_SECRET)";                 [ -z "$jwt" ]          && jwt="$(secret)"
  db_pass="$(env_get DB_PASSWORD)";            [ -z "$db_pass" ]      && db_pass="$(secret)"
  # Read the old name too, so upgrading from a Conduit-era install keeps
  # working rather than silently minting a secret the homeserver won't accept.
  matrix_token="$(env_get MATRIX_SHARED_SECRET)"
  [ -z "$matrix_token" ] && matrix_token="$(env_get MATRIX_REGISTRATION_TOKEN)"
  [ -z "$matrix_token" ] && matrix_token="$(secret)"

  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d%H%M%S)"
    ok "Backed up your previous .env"
  fi

  cat > "$ENV_FILE" <<EOF
# SOVRGNnet settings — written by install.sh on $(date '+%Y-%m-%d %H:%M').
#
# These are real secrets. Don't commit this file or paste it anywhere.
# Re-running ./install.sh keeps them; deleting them locks you out.

# --- secrets (generated) ---
JWT_SECRET=$jwt
DB_PASSWORD=$db_pass
# Lets the app create Matrix accounts. Public registration on the homeserver
# is disabled entirely, so this is the only way accounts come into existence.
MATRIX_SHARED_SECRET=$matrix_token

# --- your instance ---
# The Matrix domain baked into every user and room ID. Changing this after
# first launch orphans all existing chat history.
MATRIX_SERVER_NAME=$MATRIX_SERVER_NAME
MATRIX_HOMESERVER_URL=http://matrix:8008
IPFS_API_URL=http://ipfs:5001
NODE_ENV=production
VITE_APP_TITLE=SOVRGNnet

# Join the wider Matrix network. Off by default: your instance is yours.
# Turning this on requires $MATRIX_SERVER_NAME to be publicly reachable.
MATRIX_ALLOW_FEDERATION=${MATRIX_ALLOW_FEDERATION:-false}

# --- how people reach it ---
SOVRGNNET_ACCESS_MODE=$ACCESS_MODE
DOMAIN=$DOMAIN
CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN
EOF

  chmod 600 "$ENV_FILE"
  ok "Settings saved to .env (passwords generated for you)."

  write_dendrite_config "$matrix_token" "$db_pass"
}

# ------------------------------------------------------------------- matrix

# The homeserver needs a config file and a signing key before it will start.
# Both are generated here rather than by hand, and the key is generated once
# and never regenerated — it *is* this server's identity on the Matrix network.
write_dendrite_config() {
  local shared_secret="$1" db_pass="$2"

  install -d -m 0755 "$REPO_DIR/dendrite"

  local key="$REPO_DIR/dendrite/matrix_key.pem"
  if [ ! -f "$key" ]; then
    if $DOCKER_COMPOSE run --rm --no-deps --entrypoint /usr/bin/generate-keys matrix \
        --private-key /etc/dendrite/matrix_key.pem >/dev/null 2>&1; then
      ok "Generated the homeserver signing key"
    else
      # Fall back to openssl: generate-keys needs the image pulled, and on a
      # first run that hasn't happened yet.
      openssl genpkey -algorithm ed25519 -out "$key" 2>/dev/null
      ok "Generated the homeserver signing key"
    fi
    chmod 600 "$key"
  else
    ok "Keeping the existing homeserver signing key"
  fi

  local federation="true"
  [ "${MATRIX_ALLOW_FEDERATION:-false}" = "true" ] && federation="false"

  sed \
    -e "s|__MATRIX_SERVER_NAME__|$MATRIX_SERVER_NAME|g" \
    -e "s|__MATRIX_SHARED_SECRET__|$shared_secret|g" \
    -e "s|__DENDRITE_DISABLE_FEDERATION__|$federation|g" \
    -e "s|__DENDRITE_DATABASE_URL__|postgresql://sovrgn:$db_pass@db:5432/dendrite?sslmode=disable|g" \
    "$REPO_DIR/dendrite/dendrite.yaml.template" > "$REPO_DIR/dendrite/dendrite.yaml"

  chmod 600 "$REPO_DIR/dendrite/dendrite.yaml"
  ok "Homeserver configured"
}

# ------------------------------------------------------------------- launch

compose_profiles() {
  case "$ACCESS_MODE" in
    quick)  printf '%s' "--profile quick" ;;
    tunnel) printf '%s' "--profile tunnel" ;;
    proxy)  printf '%s' "--profile proxy" ;;
    *)      printf '%s' "" ;;
  esac
}

launch() {
  step "Building and starting (first time takes a few minutes)"
  hint "Docker is downloading and compiling. Nothing is wrong if it pauses."
  say ""

  # shellcheck disable=SC2046
  $DOCKER_COMPOSE $(compose_profiles) up -d --build

  step "Waiting for everything to come up"
  local waited=0
  until curl -fsS -o /dev/null "http://localhost:3000" 2>/dev/null; do
    waited=$((waited + 3))
    if [ "$waited" -ge 180 ]; then
      warn "The app hasn't answered after 3 minutes."
      hint "See what it's saying with:  $DOCKER_COMPOSE logs app"
      return 1
    fi
    printf '.'
    sleep 3
  done
  printf '\n'
  ok "The app is running. (It set up its own database on the way.)"
}

public_url() {
  case "$ACCESS_MODE" in
    quick)
      # cloudflared prints the assigned hostname into its log once connected.
      local url="" tries=0
      while [ "$tries" -lt 30 ]; do
        url=$($DOCKER_COMPOSE logs cloudflared-quick 2>/dev/null \
              | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
        [ -n "$url" ] && break
        tries=$((tries + 1)); sleep 2
      done
      printf '%s' "${url:-unavailable}"
      ;;
    tunnel|proxy) printf 'https://%s' "${DOMAIN:-your-domain}" ;;
    *)            printf 'http://%s:3000' "$(lan_ip)" ;;
  esac
}

finish() {
  local url; url="$(public_url)"

  printf '\n'
  printf '%s─────────────────────────────────────────────────────────%s\n' "$PURPLE" "$RESET"
  printf '\n  %sSOVRGNnet is live.%s\n\n' "$BOLD$GREEN" "$RESET"

  if [ "$url" = "unavailable" ]; then
    warn "Couldn't read the public link yet. Try: ./sovrgnnet url"
  else
    printf '  Open   %s%s%s\n' "$BOLD" "$url" "$RESET"
  fi

  printf '\n  %sThe first account you create becomes the admin.%s\n' "$DIM" "$RESET"

  case "$ACCESS_MODE" in
    local)
      printf '  %sAnyone on your wifi can reach that address.%s\n' "$DIM" "$RESET"
      ;;
    quick)
      printf '  %sThat link works from anywhere — send it to whoever you like.%s\n' "$DIM" "$RESET"
      printf '  %sIt changes when you restart; run ./sovrgnnet url to see the current one.%s\n' "$DIM" "$RESET"
      ;;
  esac

  printf '\n  Day to day:\n'
  printf '    %s./sovrgnnet status%s    is everything healthy?\n' "$BOLD" "$RESET"
  printf '    %s./sovrgnnet stop%s      shut it down\n' "$BOLD" "$RESET"
  printf '    %s./sovrgnnet start%s     bring it back\n' "$BOLD" "$RESET"
  printf '    %s./sovrgnnet backup%s    save a copy of everything\n' "$BOLD" "$RESET"
  printf '    %s./sovrgnnet update%s    get the latest version\n' "$BOLD" "$RESET"
  printf '\n'
  printf '%s─────────────────────────────────────────────────────────%s\n\n' "$PURPLE" "$RESET"
}

# --------------------------------------------------------------------- main

banner
detect_docker
choose_access
choose_matrix_name
write_env
launch
finish
