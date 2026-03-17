#!/bin/bash
# PostToolUse hook: cache team→lead session mapping when TeamCreate is called.
# Writes ~/.claude/team-lead-cache/{team_name} = {session_id}
# Used by ccusage agent to nest team members under their parent lead,
# even after JSONL compaction destroys the TeamCreate tool_use entries.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL" != "TeamCreate" ]; then
  exit 0
fi

TEAM_NAME=$(echo "$INPUT" | jq -r '.tool_input.team_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$TEAM_NAME" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

CACHE_DIR="$HOME/.claude/team-lead-cache"
mkdir -p "$CACHE_DIR"
echo -n "$SESSION_ID" > "$CACHE_DIR/$TEAM_NAME"
exit 0
