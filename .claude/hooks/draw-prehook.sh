#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"

# No-op if not a canvas command
if [[ "$COMMAND" != *"shemma"* ]] && [[ "$COMMAND" != *"localhost:8787"* ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":""}}\n'
  exit 0
fi

ROOM="${CLAUDE_SESSION_ID:-default}"
STATE_FILE="${HOME}/.claude/.draw-state-${ROOM}"
LAST=0
[[ -f "$STATE_FILE" ]] && LAST=$(cat "$STATE_FILE")

PORT="${SHEMMA_PORT:-8787}"
DIFF=$(curl -sf "http://localhost:${PORT}/api/state?room=${ROOM}&since=${LAST}" 2>/dev/null \
  || echo '{"diff":[],"version":0}')
NEW=$(echo "$DIFF" | jq -r '.version // 0')
echo "$NEW" > "$STATE_FILE"

D=$(echo "$DIFF" | jq -c '.diff // []')
if [[ "$D" == "[]" ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":""}}\n'
else
  jq -n --arg ctx "## Canvas diff since v${LAST}\n\`\`\`json\n${D}\n\`\`\`" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
fi
