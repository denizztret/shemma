#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-$(jq -r .version package.json)}"
CHANNEL="${2:-stable}"
GIT_SHA="$(git rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ASSETS_FILE="apps/backend/src/embedded-assets.ts"
ASSETS_BACKUP="$(mktemp)"
cp "$ASSETS_FILE" "$ASSETS_BACKUP"
restore_placeholder() {
  cp "$ASSETS_BACKUP" "$ASSETS_FILE"
  rm -f "$ASSETS_BACKUP"
}
trap restore_placeholder EXIT

echo "Building frontend..."
bun run --cwd apps/frontend build
rm -rf apps/backend/src/frontend-dist
cp -r apps/frontend/dist apps/backend/src/frontend-dist

echo "Generating embedded-assets manifest..."
bun scripts/generate-embedded-assets.ts

mkdir -p release

build_target() {
  local target="$1"
  local out="$2"
  echo "Building $out..."
  bun build packages/shemma-cli/src/index.ts \
    --compile \
    --target="$target" \
    --outfile="release/$out" \
    --define "process.env.SHEMMA_VERSION='$VERSION'" \
    --define "process.env.SHEMMA_CHANNEL='$CHANNEL'" \
    --define "process.env.SHEMMA_GIT_SHA='$GIT_SHA'" \
    --define "process.env.SHEMMA_BUILD_DATE='$BUILD_DATE'"
}

build_target "bun-darwin-arm64" "shemma-darwin-arm64"
build_target "bun-darwin-x64" "shemma-darwin-x64"
build_target "bun-linux-x64" "shemma-linux-x64"

echo "Release builds ready in release/"
ls -lh release/
