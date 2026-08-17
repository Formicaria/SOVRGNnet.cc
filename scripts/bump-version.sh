#!/usr/bin/env bash
#
# Move the version forward, everywhere, in one command.
#
#   ./scripts/bump-version.sh patch     0.1.0 -> 0.1.1
#   ./scripts/bump-version.sh minor     0.1.0 -> 0.2.0
#   ./scripts/bump-version.sh major     0.1.0 -> 1.0.0
#   ./scripts/bump-version.sh 0.4.2     set it explicitly
#
# Writes package.json, desktop/package.json, tauri.conf.json, Cargo.toml, and
# shared/const.ts, then verifies they agree. Does not commit or tag — see
# CONTRIBUTING.md for where this sits in the release train.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo); RED=$(tput setaf 1 2>/dev/null || echo)

fail() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

CURRENT="$(node -e "process.stdout.write(require('./package.json').version)")"
[ -n "$CURRENT" ] || fail "Couldn't read the current version from package.json"

ARG="${1:-}"
[ -n "$ARG" ] || fail "Usage: $0 <major|minor|patch|X.Y.Z>"

# Linear bumps only: no pre-release tags, no build metadata. A release train
# that allows 1.0.0-rc.3+build7 needs tooling nobody here wants to maintain.
case "$ARG" in
  major|minor|patch)
    IFS=. read -r MAJOR MINOR PATCH <<< "$CURRENT"
    case "$ARG" in
      major) NEXT="$((MAJOR + 1)).0.0" ;;
      minor) NEXT="${MAJOR}.$((MINOR + 1)).0" ;;
      patch) NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
    esac
    ;;
  *)
    [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Version must look like 1.2.3 (got '$ARG')"
    NEXT="$ARG"
    ;;
esac

[ "$NEXT" != "$CURRENT" ] || fail "Already at $CURRENT"

# Refuse to go backwards. Published versions are permanent, and a lower number
# would make every client's compatibility check nonsense.
lowest="$(printf '%s\n%s\n' "$CURRENT" "$NEXT" | sort -V | head -1)"
[ "$lowest" = "$CURRENT" ] || fail "$NEXT is older than $CURRENT — versions only go forward"

printf '\n  %s%s → %s%s\n\n' "$BOLD" "$CURRENT" "$NEXT" "$RESET"

set_json_version() {
  node -e "
    const fs = require('fs');
    const file = '$1';
    const text = fs.readFileSync(file, 'utf8');
    // Rewrite only the first top-level \"version\" so formatting, comments,
    // and key order survive untouched.
    const updated = text.replace(/(\"version\"\s*:\s*\")[^\"]+(\")/, '\$1$NEXT\$2');
    if (updated === text) { console.error('no version field in ' + file); process.exit(1); }
    fs.writeFileSync(file, updated);
  "
  printf '  %s✓%s %s\n' "$DIM" "$RESET" "$1"
}

# Everything is rewritten through node rather than `sed -i`. GNU sed and BSD
# sed disagree about whether -i takes a suffix, and the `.bak` dance leaves a
# stray file behind on any filesystem that won't let us delete it.
rewrite() {
  local file="$1" pattern="$2" replacement="$3"
  node -e "
    const fs = require('fs');
    const file = '$file';
    const text = fs.readFileSync(file, 'utf8');
    const updated = text.replace($pattern, \`$replacement\`);
    if (updated === text) { console.error('nothing to update in ' + file); process.exit(1); }
    fs.writeFileSync(file, updated);
  "
  printf '  %s✓%s %s\n' "$DIM" "$RESET" "$file"
}

set_json_version package.json
set_json_version desktop/package.json
set_json_version desktop/src-tauri/tauri.conf.json

# Cargo.toml: only the first `version =`, which is the package's own — later
# ones belong to dependencies, hence the non-global regex.
rewrite desktop/src-tauri/Cargo.toml '/^version = "[^"]*"$/m' "version = \\\"$NEXT\\\""

# Cargo.lock records our own package's version as well, and cargo rewrites it
# on the next build. Leaving it stale means a --locked build fails, or CI
# quietly produces a dirty tree — neither worth discovering during a release.
if [ -f desktop/src-tauri/Cargo.lock ]; then
  rewrite desktop/src-tauri/Cargo.lock \
    '/(name = "sovrgnnet-desktop"\nversion = ")[^"]*(")/' "\\\$1$NEXT\\\$2"
fi

rewrite shared/const.ts '/^export const APP_VERSION = "[^"]*";$/m' \
  "export const APP_VERSION = \\\"$NEXT\\\";"

printf '\n'
# The static site names the version too, in prose and in download URLs. It is
# not in check-versions.sh's list of six because it is HTML rather than a
# manifest — which is exactly why it drifted: v0.6.1 shipped with a site still
# advertising v0.6.0 and download links pointing at release assets that do not
# exist under that tag. scripts/check-site.sh catches it after the fact; this
# stops it happening.
if [ -d site ]; then
  PREVIOUS_TAG="v$CURRENT"
  grep -rl "$PREVIOUS_TAG\|SOVRGNnet_${CURRENT}_" site --include=*.html 2>/dev/null | while read -r page; do
    sed -i "s|$PREVIOUS_TAG|v$NEXT|g; s|SOVRGNnet_${CURRENT}_|SOVRGNnet_${NEXT}_|g" "$page"
    printf '  %ssite/%s%s\n' "$DIM" "${page#site/}" "$RESET"
  done
fi

./scripts/check-versions.sh

cat <<EOF

  ${BOLD}Next:${RESET}
    1. Add a "## v$NEXT" section to CHANGELOG.md
    2. Open a pull request with these changes
    3. Once it's merged to main:
         git checkout main && git pull
         git tag v$NEXT && git push origin v$NEXT

  ${DIM}The tag is what builds and publishes the release.${RESET}

EOF
