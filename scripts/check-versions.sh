#!/usr/bin/env bash
#
# The version number lives in six places. Verify they agree.
#
# Run by CI on every pull request, and by bump-version.sh after it writes.
# Drift here is invisible until a release, where it produces an app that
# reports one version and installers named another.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

read_json_version() {
  # Deliberately not jq — CI runners have node, and this avoids a dependency
  # for a job whose whole purpose is to be fast and boring.
  node -e "process.stdout.write(require('./$1').version)"
}

ROOT="$(read_json_version package.json)"

declare -A FOUND=(
  ["package.json"]="$ROOT"
  ["desktop/package.json"]="$(read_json_version desktop/package.json)"
  ["desktop/src-tauri/tauri.conf.json"]="$(read_json_version desktop/src-tauri/tauri.conf.json)"
  ["shared/const.ts"]="$(sed -n 's/^export const APP_VERSION = "\(.*\)";$/\1/p' shared/const.ts)"
  ["desktop/src-tauri/Cargo.toml"]="$(sed -n '0,/^version = "\(.*\)"$/s//\1/p' desktop/src-tauri/Cargo.toml)"
  # The lock records our own package's version too. It drifted once, silently,
  # because cargo rewrites it on the next build and nobody looks at the diff.
  ["desktop/src-tauri/Cargo.lock"]="$(sed -n '/^name = "sovrgnnet-desktop"$/{n;s/^version = "\(.*\)"$/\1/p;}' desktop/src-tauri/Cargo.lock)"
)

failed=0
for file in "${!FOUND[@]}"; do
  value="${FOUND[$file]}"
  if [ -z "$value" ]; then
    echo "✗ $file — couldn't read a version out of it"
    failed=1
  elif [ "$value" != "$ROOT" ]; then
    echo "✗ $file — $value (expected $ROOT)"
    failed=1
  else
    echo "✓ $file — $value"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "Versions disagree. Fix with:  ./scripts/bump-version.sh $ROOT"
  exit 1
fi

echo ""
echo "All ${#FOUND[@]} agree on $ROOT"
