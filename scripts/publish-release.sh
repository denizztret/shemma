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

# Numeric tag — naming convention (см. CLAUDE.md / memory/feedback-gitflow-semver-tags).
git tag "$VERSION" -m "Release $VERSION ($CHANNEL)"
git push origin "$VERSION"

# Extract this version's section from CHANGELOG.md as release notes.
# Awk прихватывает следующую "## " heading; sed '$d' срезает её.
NOTES_FILE="$(mktemp)"
awk "/^## $VERSION/{flag=1; next} flag && /^## /{exit} flag" CHANGELOG.md > "$NOTES_FILE"

if [[ ! -s "$NOTES_FILE" ]]; then
  echo "warn: no CHANGELOG entry for $VERSION — falling back to placeholder notes" >&2
  echo "Release $VERSION on channel $CHANNEL" > "$NOTES_FILE"
fi

gh release create "$VERSION" \
  --title "$VERSION" \
  --notes-file "$NOTES_FILE" \
  release/shemma-* release/release-manifest.json

rm -f "$NOTES_FILE"
echo "Published $VERSION"
