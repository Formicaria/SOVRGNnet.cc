# sovrgnnet.cc landing site

Static, single-file, zero-build. Deploys free on **Cloudflare Pages**:

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Select this repo; set **build command: none**, **output directory: `site`**
3. Add custom domain `sovrgnnet.cc` (and `www`) — Cloudflare handles DNS + TLS

The app itself lives at `app.sovrgnnet.cc` via the Cloudflare Tunnel (see
`docs/DEPLOYMENT.md`). Keeping the marketing site on Pages and the app on the
tunnel means the landing page stays up even when the homelab doesn't.
