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
   nginx ──▶ app (:3000)    Conduit (:8008)
                   │
             Postgres · IPFS
```

> Until Roadmap Phase 2 lands, the app itself is not production-ready; everything here can be prepared in parallel.

## 1. Proxmox VM

On the R640 (or any node): Ubuntu Server 24.04 VM, 4 vCPU / 8 GB RAM / 64 GB disk is comfortable for v1. Install Docker + Compose plugin. An LXC also works, but a VM avoids Docker-in-LXC nesting quirks.

```bash
git clone https://github.com/mrknockknockgaming-droid/SOVRGNnet
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
| `sovrgnnet.cc` | `http://app:3000` |
| `www.sovrgnnet.cc` | `http://app:3000` |
| `matrix.sovrgnnet.cc` | `http://matrix:8008` |

Cloudflare creates the DNS records automatically. TLS terminates at Cloudflare's edge — no certbot needed. With the tunnel in place, the bundled nginx service becomes optional (keep it only if you want LAN-direct access).

## 3. Matrix federation (well-known delegation)

So `@user:sovrgnnet.cc` resolves while Conduit lives on a subdomain, the app (or a Cloudflare redirect/Worker route) must serve:

`https://sovrgnnet.cc/.well-known/matrix/server`
```json
{ "m.server": "matrix.sovrgnnet.cc:443" }
```

`https://sovrgnnet.cc/.well-known/matrix/client`
```json
{ "m.homeserver": { "base_url": "https://matrix.sovrgnnet.cc" } }
```

Federation works through Cloudflare's proxy on 443. Verify with the [Matrix federation tester](https://federationtester.matrix.org). Keep `CONDUIT_ALLOW_REGISTRATION=false` in production — accounts are provisioned by the app.

**Cloudflare caveats to know:** free-tier proxied uploads cap at 100 MB per request (plan file uploads accordingly, or chunk); WebSockets are supported and pass through fine; IPFS swarm port 4001 cannot go through the tunnel — either skip public IPFS peering (files still serve via the app) or port-forward 4001 directly if you want DHT participation.

## 4. Launch

```bash
docker compose up -d --build
docker compose ps            # all healthy
docker compose logs -f app
```

Run migrations inside the app container (`pnpm db:push`) on first boot and after schema changes.

## 5. Backups

Nightly cron: `pg_dump` of Postgres, tar of the Conduit volume, IPFS pinset export. Keep an off-VM copy — with three Proxmox hosts, replicating backups to a second node (or Proxmox Backup Server) is the natural move. Test `scripts/restore.sh` before you need it.

## 6. Operations checklist

Uptime checks on `https://sovrgnnet.cc` and `https://matrix.sovrgnnet.cc/_matrix/client/versions`; log rotation; periodic `docker compose pull && docker compose up -d` for base images. Nothing listens on the WAN — the tunnel is outbound-only; keep 5432/8008 unexposed even on the LAN unless needed.

## The desktop app (Tauri)

The Discord-like client ships as a Tauri wrapper around the same web app: a native shell (Windows/macOS/Linux, ~10 MB installers) pointed at `https://sovrgnnet.cc`, with room to grow native features later (notifications, tray, deep links, auto-update). It lives in the roadmap as its own phase — the web app must work first, then the shell is thin.
