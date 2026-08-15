# Setting up SOVRGNnet

Your own private chat network — like Discord, except it runs on a computer you
own and nobody else can read it, sell it, or shut it down.

This guide assumes you've never done anything like this before. It takes about
ten minutes, most of which is waiting.

**You do not need:** a domain name, a Cloudflare account, a credit card, or any
knowledge of Docker, databases, or Matrix.

---

## What you need

**A computer that stays on.** An old laptop, a Raspberry Pi 5, a mini PC, a
spare desktop in a closet. It needs about 4 GB of memory and a wired or wifi
connection. It does *not* need to be powerful — this comfortably runs on
hardware people throw away.

**Ten minutes.**

That's the list.

---

## Step 1 — Get the code

Open a terminal on that computer. (On Ubuntu or Raspberry Pi OS: press
`Ctrl+Alt+T`. On a Mac: open Terminal from Applications → Utilities.)

Copy and paste this, then press Enter:

```bash
git clone https://github.com/Formicaria/SOVRGNnet.cc.git sovrgnnet
cd sovrgnnet
```

If it says `git: command not found`, install it first with
`sudo apt install git` and try again.

---

## Step 2 — Run the installer

```bash
./install.sh
```

It will ask you one real question:

```
How should people reach your SOVRGNnet?

  1  Just me, on this network
  2  Friends over the internet — no account, no domain
  3  My own domain, through Cloudflare
  4  My own domain, my own certificates
```

**Pick 1** if you're trying it out. Everything stays inside your house.

**Pick 2** if you want to invite friends today. You get a real
`https://` web address in about a minute, with no signup anywhere. The catch:
the address is random and changes whenever you restart, so it's better for a
weekend than for a permanent home.

**Pick 3** if you own a domain name. You'll get a permanent address like
`chat.yourname.com`. It needs a free Cloudflare account. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the walkthrough.

**Pick 4** if you already run your own reverse proxy and know what a
certificate is.

Everything else is automatic. The installer generates all your passwords,
writes them down in a file called `.env`, downloads what it needs, and starts
the whole system. **The first run takes a few minutes** — it's compiling. A
long pause is normal.

When it's finished you'll see something like:

```
  SOVRGNnet is live.

  Open   http://192.168.1.50:3000

  The first account you create becomes the admin.
```

---

## Step 3 — Make your account

Open that address in a web browser. Sign up with an email and password.

The email is just your username — nothing is sent anywhere, and there's no
outside service involved. It's your server.

Then:

1. Click the **+** on the left to create a server.
2. Click the **person-plus** icon at the top to get an invite link.
3. Send that link to a friend. They make an account and land in your server.

That's it. You're running your own chat network.

---

## Living with it

Everything is one command, run from inside the `sovrgnnet` folder:

| Command | What it does |
|---|---|
| `./sovrgnnet status` | Is everything healthy? |
| `./sovrgnnet url` | What address do people use? |
| `./sovrgnnet stop` | Turn it off (your data stays) |
| `./sovrgnnet start` | Turn it back on |
| `./sovrgnnet backup` | Save a copy of everything |
| `./sovrgnnet update` | Get the latest version |
| `./sovrgnnet logs` | Watch what it's doing |

### Back it up

Run `./sovrgnnet backup` occasionally. It makes one file in `backups/`
containing your accounts, messages, and shared files.

**Copy that file somewhere else** — a USB drive, another computer, anywhere
that isn't the machine it came from. A backup that lives on the thing that
breaks isn't a backup.

To bring it back, on any machine: `./scripts/restore.sh`

---

## When something goes wrong

**The address doesn't load.**
Run `./sovrgnnet status`. If it says the app isn't answering, give it another
minute — the first startup is slow. Still stuck? `./sovrgnnet logs` shows what
it's complaining about.

**"Permission denied" when running a command.**
Your user isn't in the Docker group yet. Log out and back in, or run
`sudo ./install.sh`.

**Friends can't connect (option 2).**
The random address changes every restart. Run `./sovrgnnet url` and send them
the current one.

**I want to start completely over.**
`docker compose down -v` erases everything — all accounts and messages — then
`./install.sh` sets it up fresh. There's no undo, so back up first.

**A message says a port is already in use.**
Something else on that computer is using port 3000 or 80. Stop that program,
or run SOVRGNnet on a machine that isn't busy.

---

## Running it without Docker

If you're on Proxmox and would rather use an LXC container — lighter, no
Docker layer — there's a second installer that sets everything up as ordinary
system services:

```bash
apt update && apt install -y git
git clone https://github.com/Formicaria/SOVRGNnet.cc.git /opt/sovrgnnet
/opt/sovrgnnet/scripts/install-lxc.sh
```

Same questions, same result, same `sovrgnnet` commands afterward.
[docs/LXC.md](docs/LXC.md) has the details, including creating the container.

## What's actually running

Not required reading, but useful if you're curious.

Five pieces, each in its own container:

- **app** — the website you log into
- **db** — PostgreSQL, holding accounts and message history
- **matrix** — a Conduit homeserver; the actual chat protocol
- **ipfs** — stores the files people share
- **cloudflared** — only if you chose option 2 or 3; carries traffic in from
  the internet without opening any ports on your router

Your messages live on your machine. They pass through no company's servers.

One honest caveat: messages are stored as plain text on *your* homeserver
today — end-to-end encryption is on the [roadmap](docs/ROADMAP.md), not
finished. Anyone with administrator access to that computer could read them.
For most people that's just you, which is the entire point. But it's worth
knowing before you use it for anything sensitive.
