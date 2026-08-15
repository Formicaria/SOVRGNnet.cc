# Deployment — sovrgnnet.cc

Production guide for hosting the full stack on our own hardware. Assumes a Linux host (x64 or ARM64/Pi 5) with Docker and Docker Compose installed.

> Note: parts of this guide describe the *target* state. Until Roadmap Phases 0–2 land, the app itself is not production-ready; the infrastructure steps here can be prepared in parallel.

## 1. DNS

At the sovrgnnet.cc registrar, point A/AAAA records at the host:

```
sovrgnnet.cc            A     <host-ip>
www.sovrgnnet.cc        CNAME sovrgnnet.cc
matrix.sovrgnnet.cc     A     <host-ip>
```

## 2. Environment

```bash
git clone https://github.com/mrknockknockgaming-droid/SOVRGNnet
cd SOVRGNnet
cp docker.env.template .env
```

Set at minimum: `DB_PASSWORD` and `DB_ROOT_PASSWORD` (strong random), `JWT_SECRET` (`openssl rand -base64 32`), `DOMAIN=sovrgnnet.cc`, `MATRIX_SERVER_NAME=sovrgnnet.cc` (the *domain in Matrix user IDs* — choose once, it cannot change later), `VITE_APP_TITLE=SOVRGNnet`. Never commit `.env`.

## 3. TLS

Use Let's Encrypt via certbot on the host (or swap nginx for Caddy/Traefik if preferred):

```bash
sudo certbot certonly --standalone -d sovrgnnet.cc -d www.sovrgnnet.cc -d matrix.sovrgnnet.cc
```

Mount the resulting certs into the nginx container (see `ssl` volume in compose) and set up a renewal hook that runs `docker compose exec nginx nginx -s reload`.

## 4. Matrix federation (well-known delegation)

So `@user:sovrgnnet.cc` works while Conduit lives on a subdomain, nginx must serve:

`https://sovrgnnet.cc/.well-known/matrix/server`
```json
{ "m.server": "matrix.sovrgnnet.cc:443" }
```

`https://sovrgnnet.cc/.well-known/matrix/client`
```json
{ "m.homeserver": { "base_url": "https://matrix.sovrgnnet.cc" } }
```

And proxy `matrix.sovrgnnet.cc` → `conduit:8008`. Verify with the [Matrix federation tester](https://federationtester.matrix.org) once live. Keep `CONDUIT_ALLOW_REGISTRATION=false` in production — accounts are provisioned by the app, not by strangers.

## 5. Launch

```bash
docker compose up -d --build
docker compose ps          # all services healthy
docker compose logs -f app
```

Migrations run via `pnpm db:push` inside the app container (or bake into the image entrypoint — Phase 0 decision).

## 6. Backups

`scripts/backup.sh` (being adapted to Postgres) should cron nightly: `pg_dump` of the app DB, tar of the Conduit data volume, and the IPFS pinset (`ipfs pin ls`). Test restore with `scripts/restore.sh` before you need it. Off-host copies are non-negotiable — a second box or object storage.

## 7. Operations checklist

Uptime monitoring on `https://sovrgnnet.cc` and `https://matrix.sovrgnnet.cc/_matrix/client/versions`; log rotation for the compose services; `docker compose pull && up -d` cadence for base-image updates; firewall allowing only 80/443 (and 4001 for IPFS swarm if public peering is wanted). Port 8008 and 5432 must never be exposed publicly.
