# sovrgnnet.cc — the public site

Static HTML and one stylesheet. No build step, no framework, no JavaScript at
all. Deploys free on **Cloudflare Pages**.

```
site/
  index.html              landing page
  legal.html              licence, privacy, terms
  404.html
  assets/style.css        the only stylesheet
  docs/
    index.html            docs hub
    install.html          installing (Docker + LXC, all four access modes)
    operating.html        the sovrgnnet commands, backups, updates, triage
    architecture.html     how the pieces fit, and what's deliberately absent
    security.html         what's protected, what isn't, ports, encryption
  .well-known/matrix/     federation + client delegation
  _headers                security headers and cache policy
```

## Deploying

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Select this repo; **build command: none**, **output directory: `site`**
3. Add the custom domain `sovrgnnet.cc` (and `www`) — Cloudflare handles DNS and TLS

The app itself lives at `app.sovrgnnet.cc` behind the Cloudflare Tunnel (see
`docs/DEPLOYMENT.md`). Keeping the site on Pages and the app on the tunnel means
this page stays up even when the homelab doesn't.

## Two things to know before editing

**There is no JavaScript, and `_headers` enforces that.** The Content-Security-
Policy is `default-src 'none'; style-src 'self'` — no inline styles, no inline
event handlers, no third-party scripts, no external fonts. A `style="..."`
attribute will be silently dropped by the browser. Use a class in
`assets/style.css` instead; there are small utilities at the bottom of the file
for the one-off cases.

**The landing page draws its own artwork.** `index.html` opens with an inline
`<svg class="sprite">` holding every icon, the SOVRGN sigil, and the gradients,
masks and filters the wordmark needs; everything else references them with
`<use href="#id">`. CSS selectors do not reach inside a `<use>` shadow tree, so
paint for the sigil is set on `#sigil` itself and inherits down. The mobile menu
is a checkbox and two labels — no script — and the hero wordmark is vector
letterforms, not a font, because `font-src 'self'` rules out a webfont.

**The docs here mirror the repository, they don't replace it.** `QUICKSTART.md`,
`docs/LXC.md`, `docs/DEPLOYMENT.md`, and the rest stay authoritative because
they version with the code. These pages are the readable front door — when you
change how installation works, both need updating.

## Checking your work

Nothing to build, so open the files directly, or:

```bash
cd site && python3 -m http.server 8000
```

Root-relative links (`/docs/`, `/assets/style.css`) need a server root at
`site/`, so opening `index.html` straight off disk will lose the stylesheet.
