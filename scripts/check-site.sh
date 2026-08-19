#!/usr/bin/env bash
#
# Check the static site before it ships.
#
#   ./scripts/check-site.sh
#
# The site is plain HTML with no build step, which is why it's pleasant to work
# on and why nothing catches a typo in an href. Four things are worth checking
# mechanically, all of them cheap:
#
#   - internal links resolve to a file that exists
#   - referenced assets exist
#   - no inline script or style, because _headers ships a strict CSP that
#     silently blocks them
#   - the advertised version matches package.json
#
# Deliberately no crawler, no headless browser, no link-checking dependency.
# A check nobody can run because it needs a toolchain is a check nobody runs.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR/site"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo)
RED=$(tput setaf 1 2>/dev/null || echo); GREEN=$(tput setaf 2 2>/dev/null || echo)
YELLOW=$(tput setaf 3 2>/dev/null || echo)

PROBLEMS=0
WARNINGS=0

problem() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*"; PROBLEMS=$((PROBLEMS + 1)); }
warn()    { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; WARNINGS=$((WARNINGS + 1)); }
ok()      { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

PAGES=$(find . -name "*.html" | sort)
PAGE_COUNT=$(printf '%s\n' "$PAGES" | wc -l | tr -d ' ')

printf '\n%sStatic site%s %s(%s pages)%s\n\n' "$BOLD" "$RESET" "$DIM" "$PAGE_COUNT" "$RESET"

# ---------------------------------------------------------- internal links

# Resolve a root-relative URL to the file that would actually be served.
target_for() {
  local url="$1"
  case "$url" in
    /)   printf './index.html' ;;
    */)  printf '.%sindex.html' "$url" ;;
    *)   printf '.%s' "$url" ;;
  esac
}

broken=0
while IFS= read -r page; do
  # href and src, root-relative only. Fragments and external URLs are not our
  # problem; a same-page anchor that's wrong is a design issue, not a 404.
  grep -o 'href="/[^"#]*"\|src="/[^"]*"' "$page" 2>/dev/null \
    | sed 's/.*="//;s/"//' | sort -u | while IFS= read -r url; do
      [ -n "$url" ] || continue
      [ -e "$(target_for "$url")" ] || printf '%s|%s\n' "$page" "$url"
    done
done <<< "$PAGES" > /tmp/site-broken.$$ || true

if [ -s /tmp/site-broken.$$ ]; then
  while IFS='|' read -r page url; do
    problem "$(printf '%-24s → %s' "${page#./}" "$url") ${DIM}(no such file)${RESET}"
    broken=$((broken + 1))
  done < /tmp/site-broken.$$
else
  ok "every internal link resolves"
fi
rm -f /tmp/site-broken.$$

# ------------------------------------------------------------------- CSP

# _headers ships: default-src 'none'; style-src 'self'; img-src 'self' data:
# Inline anything is blocked, and the failure is silent — the page renders
# without it rather than reporting an error.
inline=0
while IFS= read -r page; do
  if grep -q '<script' "$page" 2>/dev/null; then
    problem "${page#./} has a <script> tag — the CSP blocks inline and external script"
    inline=$((inline + 1))
  fi
  if grep -q 'style="' "$page" 2>/dev/null; then
    problem "${page#./} has an inline style attribute — blocked by style-src 'self'"
    inline=$((inline + 1))
  fi
  if grep -qE 'on(click|load|error|submit)=' "$page" 2>/dev/null; then
    problem "${page#./} has an inline event handler — blocked by the CSP"
    inline=$((inline + 1))
  fi
done <<< "$PAGES"
[ "$inline" -eq 0 ] && ok "no inline script or style (CSP-safe)"

# --------------------------------------------------------- fonts and assets

# Preloaded fonts that don't exist cost a round trip and a console error.
missing_assets=0
while IFS= read -r page; do
  grep -o 'href="/assets/[^"]*"\|src="/assets/[^"]*"' "$page" 2>/dev/null \
    | sed 's/.*="//;s/"//' | sort -u | while IFS= read -r asset; do
      [ -e ".$asset" ] || printf '%s|%s\n' "$page" "$asset"
    done
done <<< "$PAGES" > /tmp/site-assets.$$ || true

if [ -s /tmp/site-assets.$$ ]; then
  while IFS='|' read -r page asset; do
    problem "${page#./} references missing asset $asset"
    missing_assets=$((missing_assets + 1))
  done < /tmp/site-assets.$$
else
  ok "every referenced asset exists"
fi
rm -f /tmp/site-assets.$$

# Fonts are redistributed, so their licences have to travel with them.
if [ -d assets/fonts ]; then
  font_count=$(find assets/fonts -name "*.woff2" | wc -l | tr -d ' ')
  licence_count=$(find assets/fonts -iname "LICENSE*" | wc -l | tr -d ' ')
  if [ "$font_count" -gt 0 ] && [ "$licence_count" -eq 0 ]; then
    warn "$font_count font files with no licence alongside them"
  else
    ok "$font_count fonts, $licence_count licence file(s)"
  fi
fi

# ------------------------------------------------------------- version drift

APP_VERSION="$(node -e "process.stdout.write(require('../package.json').version)" 2>/dev/null || echo)"
if [ -n "$APP_VERSION" ]; then
  # The status line has claimed a version two releases behind more than once.
  # Both spellings are matched — "v0.6.0 alpha" and "v0.6.0 — alpha" — because
  # the second evaded this check once by having an em-dash in it.
  advertised=$(grep -rhoE 'v[0-9]+\.[0-9]+\.[0-9]+ (— )?alpha' . 2>/dev/null | sed 's/ — / /' | sort -u || true)
  if [ -z "$advertised" ]; then
    ok "no version claims to keep in sync"
  else
    stale=0
    while IFS= read -r claim; do
      [ -n "$claim" ] || continue
      if [ "$claim" != "v$APP_VERSION alpha" ]; then
        problem "site says \"$claim\" but package.json says $APP_VERSION"
        stale=$((stale + 1))
      fi
    done <<< "$advertised"
    [ "$stale" -eq 0 ] && ok "version claims match package.json ($APP_VERSION)"
  fi

  # Download buttons pin exact release assets, so a bump that forgets this
  # page ships buttons pointing at the previous release — working links to
  # the wrong software, which is worse than broken ones.
  dl_versions=$(grep -rhoE 'releases/download/v[0-9]+\.[0-9]+\.[0-9]+' . 2>/dev/null | sed 's|.*/v||' | sort -u || true)
  dl_stale=0
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if [ "$v" != "$APP_VERSION" ]; then
      problem "a download link points at v$v but package.json says $APP_VERSION"
      dl_stale=$((dl_stale + 1))
    fi
  done <<< "$dl_versions"
  if [ -n "$dl_versions" ] && [ "$dl_stale" -eq 0 ]; then
    ok "download links point at v$APP_VERSION"
  fi

  # Container image tags are version claims too. One sat at 0.6.0 through an
  # entire 0.7.0 preflight because the two checks above only knew "vX.Y.Z
  # alpha" prose and release-asset links — a third spelling of the same fact,
  # unguarded, is how a claim goes quietly stale.
  image_tags=$(grep -rhoE 'ghcr\.io/formicaria/sovrgnnet\.cc:[0-9]+\.[0-9]+\.[0-9]+' . 2>/dev/null | sed 's|.*:||' | sort -u || true)
  image_stale=0
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if [ "$v" != "$APP_VERSION" ]; then
      problem "the site names container image :$v but package.json says $APP_VERSION"
      image_stale=$((image_stale + 1))
    fi
  done <<< "$image_tags"
  if [ -n "$image_tags" ] && [ "$image_stale" -eq 0 ]; then
    ok "container image tags match ($APP_VERSION)"
  fi
fi

# ------------------------------------------------ links into the repository

# Docs links point at files in this repo; a renamed doc breaks them silently.
missing_docs=0
for path in $(grep -rhoE 'blob/main/[A-Za-z0-9_./-]+' . 2>/dev/null | sed 's|blob/main/||' | sort -u); do
  [ -e "../$path" ] || { problem "links to $path, which isn't in the repository"; missing_docs=$((missing_docs + 1)); }
done
[ "$missing_docs" -eq 0 ] && ok "repository links point at files that exist"

# ------------------------------------------------------------------ verdict

printf '\n'
# ------------------------------------------------------- matrix delegation

# These two files are the live delegation for every MXID ending in this
# domain, and they are the only one — the app serves its own copy on a
# different hostname that nothing ever asks. See site/.well-known/README.md.

if [ ! -f .well-known/matrix/client ]; then
  printf '  %s✗%s .well-known/matrix/client is missing\n' "$RED" "$RESET"
  printf '    %sWithout it a Matrix client cannot find the homeserver for this domain.%s\n' "$DIM" "$RESET"
  PROBLEMS=$((PROBLEMS + 1))
else
  printf '  %s✓%s matrix/client delegation present\n' "$GREEN" "$RESET"
fi

# matrix/server is federation, and its presence is a claim about a setting
# that lives on the instance rather than in this repository. Nothing here can
# read MATRIX_ALLOW_FEDERATION, so this cannot be an error either way — but it
# can refuse to let the file be silent about what it commits you to.
if [ -f .well-known/matrix/server ]; then
  printf '  %s!%s matrix/server present — this advertises federation\n' "$YELLOW" "$RESET"
  printf '    %sOnly correct if MATRIX_ALLOW_FEDERATION=true on the instance. Check:%s\n' "$DIM" "$RESET"
  printf '    %scurl -s https://matrix.sovrgnnet.cc/_matrix/key/v2/server%s\n' "$DIM" "$RESET"
  printf '    %sM_UNRECOGNIZED there means federation is off and this file is lying.%s\n' "$DIM" "$RESET"
else
  printf '  %s✓%s matrix/server absent — not advertising federation\n' "$GREEN" "$RESET"
fi

if [ "$PROBLEMS" -gt 0 ]; then
  printf '%s%s%d problem(s).%s' "$BOLD" "$RED" "$PROBLEMS" "$RESET"
  [ "$WARNINGS" -gt 0 ] && printf ' %s%d warning(s).%s' "$DIM" "$WARNINGS" "$RESET"
  printf '\n\n'
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  printf '%s%sSite OK%s %s(%d warning(s))%s\n\n' "$BOLD" "$GREEN" "$RESET" "$DIM" "$WARNINGS" "$RESET"
else
  printf '%s%sSite OK.%s\n\n' "$BOLD" "$GREEN" "$RESET"
fi
