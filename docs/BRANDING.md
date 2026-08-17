# Branding

## The names

**SOVRGN** is the brand. **SOVRGNnet** is the software, and **Formicaria** is
who publishes it. The website leads with SOVRGN, so the sign-in page does too.
Anywhere the two are used interchangeably is a bug, not a synonym.

## The mark

The three-chevron S, kept in two places:

- `client/src/assets/mark.png` — trimmed to its content, imported by the web UI
- `client/public/mark.png` — the same file, served as the favicon, which the
  browser asks for before any bundle exists
- `desktop/src-tauri/icon-source.png` — 1024×1024 with the mark centred at 12%
  margin, the input every desktop icon is generated from

Regenerate the desktop set from the square master rather than editing icons by
hand — hand-edited variants drift:

```
cd desktop && pnpm tauri icon src-tauri/icon-source.png
```

That writes `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`,
`icon.png`, `icon.icns`, `icon.ico`, the `Square*Logo.png` Store set, and the
`android/` and `ios/` trees. Only five of those are named in
`tauri.conf.json`; the rest are found by platform convention, which is why
replacing just the listed ones leaves the old art in the Store and mobile
targets.

**Resolution ceiling.** The source is a 253×320 PNG, so the 1024 master is
upscaled and the largest icons are softer than they should be. Fine at dock and
favicon sizes, visibly soft at 512 and above. A vector `mark.svg` or a
≥1024px original would fix it; nothing else needs to change if one arrives —
drop it in and re-run the command above.

## The wordmark

Type, not an image, the way the site sets it. It stays selectable, searchable
and legible to a screen reader, and there is no second asset to keep in sync.

The `.wordmark` class in `client/src/index.css` matches the live site exactly:
Oxanium 800, uppercase, 0.005em tracking, 0.88 line-height, and a brushed-metal
fill made of a fractal-noise texture over a four-stop grey gradient, both
clipped to the glyphs. Values were read off the rendered site rather than
approximated, because "close" reads as wrong when the two are seen an hour
apart.

Oxanium ships in the bundle via `@fontsource/oxanium`, imported in `index.css`.
Self-hosted deliberately: a page that pulls a font from Google contacts Google
on every view, which is precisely the property this project claims not to have.
The fallback stack is the site's own — Eurostile, then Bahnschrift, then
system-ui.

There is a `@supports` fallback to a flat colour, because without
`background-clip: text` the fill paints as a box behind fully transparent text
and the wordmark disappears completely.

## Colour

| Token | Value | Where |
|---|---|---|
| Background | `#05040a` | site `theme-color`, now also in `index.html` |
| Accent | `#8b5cf6` | site `--accent` |

The app's own chrome is still a `slate-900`/`slate-800` gradient, which is
cooler and lighter than `#05040a`. Not yet reconciled.

## What the sign-in page may claim

It used to read: *"Chat on a server someone you trust actually owns. Built on
Matrix and IPFS, running on their hardware — not a company's."*

Removed. Two of its claims are things the page cannot know: whether the
operator is someone the reader trusts, and whose hardware it is. A stranger's
invite link makes the first false; a VPS makes the second false. The page shows
the operator's instance name instead, which is a fact the server reports.

The rule for this page is unchanged: claims here must be true today, not on the
roadmap. It is the last thing someone reads before typing a password.
