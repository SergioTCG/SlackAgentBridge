#!/bin/sh
# Claude Code global hook → bridge daemon. Must be instant, silent, and never fail the session.
[ -n "$CCS_BRIDGE" ] || exit 0
payload=$(cat)
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)

# Bind delayed Claude lifecycle delivery to the time the native hook fired.
# The daemon uses this only to select an already-journaled task generation; a
# missing jq/node binary simply preserves the historical payload.
if [ "$event" = "Stop" ] || [ "$event" = "UserPromptSubmit" ]; then
  observed_at=$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null) || observed_at=''
  if [ -n "$observed_at" ]; then
    stamped=$(printf '%s' "$payload" | jq -c --argjson observed_at "$observed_at" '. + {observed_at: $observed_at}' 2>/dev/null) || stamped=''
    [ -n "$stamped" ] && payload=$stamped
  fi
fi
curl -s -m 2 -X POST "http://127.0.0.1:8877/hook?ppid=$PPID&tmux=$CCS_TMUX" \
  -H 'content-type: application/json' -H "x-ccs-flags: $CCS_FLAGS" -H "x-ccs-account: $CCS_ACCOUNT" \
  --data-binary "$payload" >/dev/null 2>&1
exit 0
