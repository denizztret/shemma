#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-$(jq -r .version package.json)}"
CHANNEL="${2:-stable}"
GIT_SHA="$(git rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Building frontend..."
bun run --cwd apps/frontend build
rm -rf apps/backend/src/frontend-dist
cp -r apps/frontend/dist apps/backend/src/frontend-dist

mkdir -p release

build_target() {
  local target="$1"
  local out="$2"
  echo "Building $out..."
  bun build packages/didraw-cli/src/index.ts \
    --compile \
    --target="$target" \
    --outfile="release/$out" \
    --define "process.env.DIDRAW_VERSION='$VERSION'" \
    --define "process.env.DIDRAW_CHANNEL='$CHANNEL'" \
    --define "process.env.DIDRAW_GIT_SHA='$GIT_SHA'" \
    --define "process.env.DIDRAW_BUILD_DATE='$BUILD_DATE'"
}

build_target "bun-darwin-arm64" "didraw-darwin-arm64"
build_target "bun-darwin-x64" "didraw-darwin-x64"
build_target "bun-linux-x64" "didraw-linux-x64"

# Copy frontend-dist alongside the binaries so they can serve the UI
echo "Copying frontend-dist to release/..."
rm -rf release/frontend-dist
cp -r apps/backend/src/frontend-dist release/frontend-dist

echo "Release builds ready in release/"
ls -lh release/
