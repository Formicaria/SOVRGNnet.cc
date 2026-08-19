# Voice channels — your SFU, your machine

Voice is per-instance by architecture: nothing about it depends on any
SOVRGN backend. Your server's only role is the admission decision — is this
person a member of this channel — signed into a short-lived token with your
own secret. Media flows browser ↔ your LiveKit server and nowhere else.

## The ten-minute setup

On the machine that runs your instance (or any machine you control):

```bash
# 1) Run LiveKit (Docker; a bare binary works the same — livekit.io/install)
docker run -d --name livekit --restart unless-stopped \
  -p 7880:7880 -p 7881:7881 -p 50000-50200:50000-50200/udp \
  -e LIVEKIT_KEYS="sovrgn: $(openssl rand -hex 24)" \
  livekit/livekit-server --bind 0.0.0.0

# 2) Tell your instance where it is
cat >> /opt/sovrgnnet/.env <<ENV
LIVEKIT_URL=ws://<this-machine>:7880
LIVEKIT_API_KEY=sovrgn
LIVEKIT_API_SECRET=<the hex you generated above>
ENV
systemctl restart sovrgnnet
```

Your descriptor now says `voice: true`, and it's true.

## The honest constraint

WebRTC media cannot ride a Cloudflare Tunnel. A voice-enabled instance
needs its media ports reachable by the people using it: on a LAN
(desktop-hosted servers), that's automatic; on the public internet, forward
the UDP range above (and 7880/7881), or put TURN-TLS in front (LiveKit
ships one — see its docs). Text works everywhere regardless, and an
instance that skips voice advertises `voice: false` rather than pretending.

Production tip: put `wss://` in front with your own TLS
(`LIVEKIT_URL=wss://voice.your-domain`), same as any websocket service.
