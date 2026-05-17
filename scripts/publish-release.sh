#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: $0 <version> [channel]}"
CHANNEL="${2:-stable}"

./scripts/build-release.sh "$VERSION" "$CHANNEL"
./scripts/generate-manifest.sh "$VERSION" "$CHANNEL"

if ! command -v gh &>/dev/null; then
  echo "gh CLI not found — skipping GitHub Release upload"
  echo "Manual upload: release/shemma-*  release/release-manifest.json"
  exit 0
fi

git tag "v$VERSION" -m "Release v$VERSION ($CHANNEL)"
git push --tags

gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes "Release v$VERSION on channel $CHANNEL" \
  release/shemma-* release/release-manifest.json

echo "Published v$VERSION"
