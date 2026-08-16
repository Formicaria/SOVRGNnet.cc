# sovrgnnet.cc — the public site

Static HTML and one stylesheet. No build step, no framework, no JavaScript at
all. Deploys free on **Cloudflare Pages**.

```
site/
  index.html              landing page
  manifesto.html          the six principles, and the test they have to pass
  about.html              what SOVRGN is, where it stands, who builds it
  legal.html              licence, privacy, terms
  404.html
  assets/
    style.css             the only stylesheet
    mark.svg              the SOVRGN mark — also the favicon
    formicaria.svg        the Formicaria mark, footer only
    fonts/                Archivo Black + JetBrains Mono, both SIL OFL 1.1
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

## Three things to know before editing

**There is no JavaScript, and `_headers` enforces that.** The Content-Security-
Policy is `default-src 'none'; style-src 'self'; img-src 'self' data:;
font-src 'self'` — no inline styles, no inline event handlers, no third-party
scripts, no hosted fonts. A `style="..."` attribute will be silently dropped by
the browser. Use a class in `assets/style.css` instead; there are small
utilities near the bottom of the file for the one-off cases.

**Anything interactive has to be CSS-only.** The mobile menu is a native
`<details>`/`<summary>` disclosure for exactly this reason — it is keyboard
accessible and announces its own state without a line of script. Reach for the
same pattern rather than adding JavaScript.

**Fonts are vendored, not linked.** `assets/fonts/` holds latin-subset woff2
files for Archivo Black (the display face) and JetBrains Mono (everything
technical), about 82 kB in total. Both are SIL OFL 1.1 and the licences ship
alongside them. `font-src 'self'` means a Google Fonts link would simply fail.

**The docs here mirror the repository, they don't replace it.** `QUICKSTART.md`,
`docs/LXC.md`, `docs/DEPLOYMENT.md`, and the rest stay authoritative because
they version with the code. These pages are the readable front door — when you
change how installation works, both need updating.

## Checking your work

Nothing to build, so:

```bash
cd site && python3 -m http.server 8000
```

Root-relative links (`/docs/`, `/assets/style.css`) need a server root at
`site/`, so opening `index.html` straight off disk will lose the stylesheet and
every font.

The product preview in the hero is CSS, not a screenshot — a real `<div>` tree
under `.app` in `index.html`. When the desktop client's layout changes, update
that markup so the homepage keeps showing the software people actually get.
