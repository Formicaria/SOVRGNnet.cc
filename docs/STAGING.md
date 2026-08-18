# A staging instance

One more container, running the same installer as production, so changes get
rehearsed on something you would not mind breaking.

The argument for it is short. Everything found in production this week was a
mechanism that reported healthy while being wrong — a control script managing a
unit that had been deleted, a homeserver crash-looping as `activating`, Conduit
answering under the old server name while the install configured a homeserver
that never started. Each took minutes to diagnose on a throwaway box and hours
on the live one, because on the live one the first question is always "is
anyone using it right now".

`scripts/e2e.sh` already proves the code. What it cannot prove is the
*upgrade*: a machine that has been running for months, with data, an old
config, and whatever somebody did to it at 2am. That is what this is for.

## What it is not

Not a second production instance, and not federated with the first. It has its
own server name, so nothing on it can be confused for a real account, and
nothing there can talk to anything real.

**`MATRIX_SERVER_NAME=staging.sovrgnnet.cc`** — permanent there too, and the
point of choosing it deliberately is that a staging account should be
recognisably a staging account in every log it appears in.

## Build it

```bash
pct create 202 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname sovrgn-staging \
  --cores 2 --memory 4096 --swap 1024 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=0 \
  --onboot 0 --start 1
```

`--onboot 0` deliberately: it should be off unless you are using it, so a
forgotten staging box is not a forgotten attack surface.

Inside, the same installer production runs:

```bash
apt update && apt install -y git
git clone https://github.com/Formicaria/SOVRGNnet.cc.git /opt/sovrgnnet
/opt/sovrgnnet/scripts/install-lxc.sh
```

Then set the name before creating any account, because it cannot be changed
afterwards:

```
MATRIX_SERVER_NAME=staging.sovrgnnet.cc
MATRIX_PUBLIC_URL=https://matrix-staging.sovrgnnet.cc
```

## Give it a tunnel, or don't

If staging only needs to be reachable from your network, skip cloudflared
entirely and use the LAN address. Fewer public hostnames is fewer things to get
wrong, and the whole reason for this box is that getting things wrong on it is
cheap.

If you do want it public, it needs **its own tunnel** — the same rule as the
identity container, for the same reason: every connector on a tunnel serves
that tunnel's entire ingress config, so a second connector on `sovrgnnet` would
advertise production's routes from a staging machine.

## Verify it

From any machine that can reach it — deliberately *not* from a shell on the
box, because users don't have one:

```bash
# fresh box (the setup token is in the box's /opt/sovrgnnet/.env):
STAGING_SETUP_TOKEN=... ./scripts/verify-staging.sh http://<staging-ip>:3000

# a box with history:
STAGING_EMAIL=... STAGING_PASSWORD=... ./scripts/verify-staging.sh http://<staging-ip>:3000
```

Conformance (read-only), then a real user journey — account, community, a
message or the encrypted-channel refusal depending on what the box honestly
advertises, a file round trip, an invite whose URL must name the box — then
`/metrics`. The journey writes one throwaway community, named so a human can
delete it on sight.

Both the script and the journey **refuse production**, by hostname and by the
server name the instance reports about itself, with the names hardcoded —
`server/stagingVerify.test.ts` fails the suite if either refusal weakens.

## What to rehearse on it

The things that have actually gone wrong:

- **An upgrade with data in the database.** Restore a production backup onto
  it — the server names differ, so `restore` will refuse, which is itself the
  behaviour worth confirming. Then create accounts, let it sit, and upgrade.
- **`sovrgnnet update --force`**, including the backup-first path and the
  prune. Confirm the archive leaves the box.
- **A Renovate pull request** before merging it, when the bump touches
  Postgres or Dendrite.
- **The desktop installer**, pointed at staging rather than production.

## Keeping it honest

A staging box that has drifted from production tests nothing. Two habits keep
it useful:

**Rebuild it rather than repairing it.** When something breaks there, the
tempting move is to fix it by hand; the useful move is to note what broke,
destroy the container, and run the installer again. A staging instance that has
been hand-repaired is a machine nobody else can reproduce.

**Point it at the same identity provider.** `IDENTITY_ISSUER=https://id.sovrgnnet.cc`
is correct here — the whole design is that an instance needs nothing from the
provider but a cached public key, and staging using the real one exercises
exactly that. It writes a grant row and nothing else.

## Cost

One container, off unless in use. Against an evening spent diagnosing a
crash-looping homeserver on the machine everyone is trying to talk on, it pays
for itself the first time.
