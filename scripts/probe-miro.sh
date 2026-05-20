#!/usr/bin/env bash
# scripts/probe-miro.sh — DRW-103 probe utility for Miro REST API v2.
#
# Resolves three open questions blocking color-mapping.ts and builder.ts:
#   1. Exact 16 preset hex values accepted by shape style.fillColor.
#   2. Field name for shemmaId tracking: `metadata` vs `appData`.
#   3. Bulk items max chunk size (probe with 60 items).
#
# Output goes to apps/backend/src/export/miro/probe.md as captured responses.
#
# Prerequisites:
#   - jq installed (brew install jq)
#   - Miro developer token in ~/.config/shemma/config.json
#   - Sandbox board ID in ~/.config/shemma/probe-board-id.txt
#
# Usage:
#   chmod +x scripts/probe-miro.sh
#   ./scripts/probe-miro.sh

set -euo pipefail

TOKEN=$(jq -r '.miro.token' ~/.config/shemma/config.json)
BOARD_ID=$(cat ~/.config/shemma/probe-board-id.txt)
BOARD_ID_ENC=$(echo -n "$BOARD_ID" | sed 's/=/%3D/g')
BASE="https://api.miro.com/v2/boards/$BOARD_ID_ENC"
OUT="apps/backend/src/export/miro/probe.md"

mkdir -p "$(dirname "$OUT")"

{
  echo "# Miro API probe — DRW-103"
  echo
  echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Board ID (encoded): $BOARD_ID_ENC"
  echo
  echo "## A. Shape style.fillColor — invalid value response (probe enum)"
  echo
  echo '```'
  curl -sS -X POST "$BASE/shapes" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"shape":"rectangle","content":"probe"},"style":{"fillColor":"#abcdef"},"position":{"x":0,"y":0},"geometry":{"width":100,"height":100}}'
  echo
  echo '```'
  echo
  echo "## B. Field name probe — metadata"
  echo
  echo '```'
  curl -sS -X POST "$BASE/shapes" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"shape":"rectangle","content":"meta-probe"},"position":{"x":200,"y":0},"geometry":{"width":100,"height":100},"metadata":{"shemmaId":"probe-meta","exportedAt":"2026-05-20T00:00:00Z"}}'
  echo
  echo '```'
  echo
  echo "## C. Field name probe — appData"
  echo
  echo '```'
  curl -sS -X POST "$BASE/shapes" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"shape":"rectangle","content":"app-probe"},"position":{"x":400,"y":0},"geometry":{"width":100,"height":100},"appData":"{\"shemmaId\":\"probe-app\"}"}'
  echo
  echo '```'
  echo
  echo "## D. GET items — verify which custom-field round-trips"
  echo
  echo '```'
  curl -sS "$BASE/items?limit=50" \
    -H "Authorization: Bearer $TOKEN"
  echo
  echo '```'
  echo
  echo "## E. Bulk size probe — POST /items/bulk with 60 shape items"
  echo
  echo '```'
  PAYLOAD=$(jq -n --argjson n 60 '
    {data: [range(0; $n) | {
      type: "shape",
      data: {shape: "rectangle", content: "bulk-\(.)" },
      position: {x: (. * 10), y: 500},
      geometry: {width: 8, height: 8}
    }]}
  ')
  curl -sS -X POST "$BASE/items/bulk" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" | jq '.' | head -200
  echo
  echo '```'
} > "$OUT"

echo "Probe complete → $OUT"
