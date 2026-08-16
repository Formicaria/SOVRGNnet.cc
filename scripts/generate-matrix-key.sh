#!/usr/bin/env bash
#
# Generate the homeserver's signing key, in the format Dendrite actually wants.
#
#   scripts/generate-matrix-key.sh <output-path>
#
# Dendrite does not accept a standard PKCS#8 private key. It wants its own PEM
# block:
#
#   -----BEGIN MATRIX PRIVATE KEY-----
#   Key-ID: ed25519:abc123
#   <base64 seed>
#   -----END MATRIX PRIVATE KEY-----
#
# `openssl genpkey -algorithm ed25519` produces `BEGIN PRIVATE KEY`, which is a
# perfectly valid key and useless here. Dendrite refuses it with:
#
#   Invalid config file: failed to load private_key: keyBlock is nil
#
# install.sh used openssl as its fallback, so every Docker install that reached
# that path produced a homeserver that would not start. The native install was
# unaffected — it builds Dendrite from source and calls the real generator,
# which is why this went unnoticed.
#
# This uses Dendrite's own generate-keys from the pinned image rather than
# writing the format by hand. The format is a cryptographic identity; inferring
# its encoding from an error message is not a thing to be clever about.

set -euo pipefail

OUT="${1:?output path required}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Read the image from compose so this can never drift from the pinned version.
IMAGE="$(grep -oE 'ghcr\.io/element-hq/dendrite-monolith:[^ ]+' "$REPO_DIR/docker-compose.yml" | head -1)"
IMAGE="${IMAGE:-ghcr.io/element-hq/dendrite-monolith:v0.15.2}"

OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT_NAME="$(basename "$OUT")"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to generate the homeserver signing key" >&2
  exit 1
}

# Mount the directory, not the file. A file bind-mount needs the file to exist
# first, and Docker silently creates a *directory* when it doesn't — which is
# its own confusing failure.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$OUT_DIR:/keys" \
  --entrypoint /usr/bin/generate-keys \
  "$IMAGE" \
  --private-key "/keys/$OUT_NAME" >/dev/null 2>&1 \
  || { echo "generate-keys failed (image: $IMAGE)" >&2; exit 1; }

# Verify rather than assume. A key in the wrong format fails much later, inside
# Dendrite, with an error that doesn't mention where the key came from.
if [ ! -s "$OUT" ]; then
  echo "generate-keys produced no key at $OUT" >&2
  exit 1
fi

if ! head -1 "$OUT" | grep -q "BEGIN MATRIX PRIVATE KEY"; then
  echo "the generated key is not in Dendrite's format:" >&2
  head -1 "$OUT" >&2
  exit 1
fi

if ! grep -q "^Key-ID: ed25519:" "$OUT"; then
  echo "the generated key has no Key-ID header — Dendrite will reject it" >&2
  exit 1
fi

chmod 600 "$OUT"
