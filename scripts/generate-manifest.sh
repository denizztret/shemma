#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: $0 <version> [channel]}"
CHANNEL="${2:-stable}"
BASE_URL="${MANIFEST_BASE_URL:-https://github.com/example/di.draw/releases/download/v$VERSION}"

cd release

# Pairs are "platform:filename" — bash 3.2-compatible (no associative arrays).
PAIRS=(
  "darwin-arm64:didraw-darwin-arm64"
  "darwin-x64:didraw-darwin-x64"
  "linux-x64:didraw-linux-x64"
)

assets="["
first=1
for pair in "${PAIRS[@]}"; do
  IFS=':' read -r plat file <<< "$pair"
  [[ ! -f "$file" ]] && { echo "missing $file" >&2; exit 1; }
  sha=$(shasum -a 256 "$file" | awk '{print $1}')
  [[ $first -eq 0 ]] && assets="$assets,"
  assets="$assets{\"platform\":\"$plat\",\"url\":\"$BASE_URL/$file\",\"sha256\":\"$sha\"}"
  first=0
done
assets="$assets]"

cat > release-manifest.json <<JSON
{
  "channels": {
    "$CHANNEL": {
      "version": "$VERSION",
      "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
      "notes": "$BASE_URL",
      "assets": $assets
    }
  }
}
JSON

echo "manifest written → release/release-manifest.json"
cat release-manifest.json
