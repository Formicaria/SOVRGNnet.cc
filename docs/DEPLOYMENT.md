# Deployment — sovrgnnet.cc

Production architecture: **Cloudflare (free) as the front door, your Proxmox homelab as the host.** Cloudflare cannot run this stack (it needs long-lived processes, Postgres, a Matrix homeserver), but its free tier provides everything in front: DNS, TLS at the edge, CDN/DDoS protection, and — the key piece — **Cloudflare Tunnel**, which connects your homelab outbound so you never port-forward or expose your home IP.

```
Internet ──▶ Cloudflare edge (DNS, TLS, proxy)
                   │  (outbound-only tunnel, no open ports)
                   ▼
        cloudflared (in the compose stack)
                   │
     ┌─────────────┼──────────────┐
     ▼             ▼              ▼
   nginx ──▶ app (:3000)    Dendrite (:8008)
                   │
             Postgres · IPFS
```

> Until Roadmap Phase 2 lands, the app itself is not production-ready; everything here can be prepared in parallel.

## 1. Proxmox VM

On the R640 (or any node): Ubuntu Server 24.04 VM, 4 vCPU / 8 GB RAM / 64 GB disk is comfortable for v1. Install Docker + Compose plugin. An LXC also works, but a VM avoids Docker-in-LXC nesting quirks.

```bash
git clone https://github.com/Formicaria/SOVRGNnet.cc
cd SOVRGNnet
cp docker.env.template .env    # set real values; never commit .env
```

Critical env values: `DB_PASSWORD` (strong random), `JWT_SECRET` (`openssl rand -base64 32`), `MATRIX_SERVER_NAME=sovrgnnet.cc` — this is the domain baked into every Matrix user ID (`@zach:sovrgnnet.cc`); choose once, it can never change.

## 2. Cloudflare Tunnel

In the Cloudflare dashboard (Zero Trust → Networks → Tunnels), create a tunnel named `sovrgnnet` and note the token. Add a `cloudflared` service to the compose stack:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    networks:
      - sovrgnnet
```

Then map public hostnames to internal services in the tunnel config:

| Public hostname | Service |
|---|---|
| `app.sovrgnnet.cc` | `http://app:3000` (via tunnel) |
| `matrix.sovrgnnet.cc` | `http://matrix:8008` (via tunnel) |

The apex `sovrgnnet.cc` (+ `www`) hosts the static landing site from `site/` on **Cloudflare Pages** (see `site/README.md`) — it stays up even if the homelab is down, and it serves the Matrix well-known files.

Cloudflare creates the DNS records automatically. TLS terminates at Cloudflare's edge — no certbot needed. With the tunnel in place, the bundled nginx service becomes optional (keep it only if you want LAN-direct access).

## 3. Matrix federation (well-known delegation)

So `@user:sovrgnnet.cc` resolves while Dendrite lives on a subdomain, the apex must serve two well-known files. These ship as static files in `site/.well-known/matrix/` and deploy automatically with the Pages site:

`https://sovrgnnet.cc/.well-known/matrix/server`
```json
{ "m.server": "matrix.sovrgnnet.cc:443" }
```

`https://sovrgnnet.cc/.well-known/matrix/client`
```json
{ "m.homeserver": { "base_url": "https://matrix.sovrgnnet.cc" } }
```

Federation works through Cloudflare's proxy on 443. Verify with the [Matrix federation tester](https://federationtester.matrix.org). Public registration on the homeserver is disabled outright and should stay that way — accounts are provisioned by the app through shared-secret registration, so nobody who finds the homeserver directly can sign up on it.

**Cloudflare caveats to know:** free-tier proxied uploads cap at 100 MB per request (plan file uploads accordingly, or chunk); WebSockets are supported and pass through fine; IPFS swarm port 4001 cannot go through the tunnel — either skip public IPFS peering (files still serve via the app) or port-forward 4001 directly if you want DHT participation.

## 4. Launch

```bash
./install.sh                 # choose 3 — "my own domain, through Cloudflare"
```

It finds an existing tunnel token in `.env` if one is there, keeps every
secret already generated, and starts the stack with the `tunnel` profile.
Equivalent by hand:

```bash
docker compose --profile tunnel up -d --build
./sovrgnnet status
./sovrgnnet logs app
```

**No migration step.** The app waits for Postgres and applies pending
migrations itself on every boot. `pnpm db:push` is a development command for
*generating* new migration SQL after a schema change — it was never able to
run inside the production image, which has no `drizzle-kit`.

Two settings deserve a moment's thought before first launch:

- `MATRIX_SERVER_NAME` is written into every Matrix user and room ID at
  creation time. Changing it later orphans all existing history. For
  sovrgnnet.cc that's `matrix.sovrgnnet.cc`.
- `MATRIX_ALLOW_FEDERATION` defaults to `false`. Turn it on deliberately, once
  the well-known delegation above is verified — federation means other
  homeservers can reach yours.

## 5. Backups

`./sovrgnnet backup` writes a single archive containing a `pg_dump` of both
databases — the app's and the homeserver's — the homeserver's signing key, the
IPFS blockstore, and your `.env`. The signing key matters more than its size
suggests: restore everything else without it and you are a different server to
everyone you have federated with. Nightly via cron:

```
0 3 * * * cd /root/sovrgnnet && ./sovrgnnet backup >> logs/backup.log 2>&1
```

Keep an off-VM copy — with three Proxmox hosts, replicating to a second node
(or Proxmox Backup Server) is the natural move. The archive contains your
secrets; treat it like a password file. Test `./scripts/restore.sh` before you
need it, not after.

## 6. Operations checklist

Uptime checks on `https://sovrgnnet.cc` and
`https://matrix.sovrgnnet.cc/_matrix/client/versions`. Log rotation is
configured in compose (10 MB × 5 per service). Periodic
`docker compose pull && ./sovrgnnet start` for base images; `./sovrgnnet
update` for app changes.

Nothing listens on the WAN — the tunnel is outbound-only. Postgres is not
published at all; Dendrite (8008) and the IPFS API (5001) bind to loopback
only, which matters: 5001 is an unauthenticated admin API, and anyone who
reaches it owns the node. Public registration on the homeserver is disabled
entirely, and accounts are created by the app using `MATRIX_SHARED_SECRET`, so
it isn't an open signup target even once it's publicly routable.

## The desktop app (Tauri)

The Discord-like client ships as a Tauri wrapper around the same web app: a native shell (Windows/macOS/Linux, ~10 MB installers) pointed at `https://sovrgnnet.cc`, with room to grow native features later (notifications, tray, deep links, auto-update). It lives in the roadmap as its own phase — the web app must work first, then the shell is thin.
