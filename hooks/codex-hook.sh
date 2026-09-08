#!/bin/sh
# Codex lifecycle hook → bridge daemon. Global registration is safe because the
# relay is inert unless the session was launched through `sab new codex`.
[ -n "$CCS_BRIDGE" ] && [ "$CCS_PROVIDER" = "codex" ] || exit 0

payload=$(cat)
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)

# Preserve when Codex emitted each lifecycle event, not merely when the daemon
# eventually dequeued its HTTP request. This lets a delayed Stop remain bound
# to the native turn which ended before a newer prompt was accepted.
if [ "$event" = "Stop" ] || [ "$event" = "UserPromptSubmit" ]; then
  observed_at=$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null) || observed_at=''
  if [ -n "$observed_at" ]; then
    stamped=$(printf '%s' "$payload" | jq -c --argjson observed_at "$observed_at" '. + {observed_at: $observed_at}' 2>/dev/null) || stamped=''
    [ -n "$stamped" ] && payload=$stamped
  fi
fi

if [ "$event" = "PermissionRequest" ]; then
  # PermissionRequest is synchronous: Slack's verdict is returned as Codex hook
  # JSON. If the daemon is unavailable or times out, emit no decision (`{}`), so
  # Codex falls back to its ordinary local approval prompt.
  result=$(curl -sS --max-time 590 -X POST \
    "http://127.0.0.1:8877/codex/permission?ppid=$PPID&tmux=$CCS_TMUX" \
    -H 'content-type: application/json' -H 'x-ccs-provider: codex' \
    --data-binary "$payload" 2>/dev/null) || result='{}'
  printf '%s' "$result" | jq -e . >/dev/null 2>&1 || result='{}'
  printf '%s\n' "$result"
  exit 0
fi

curl -s -m 2 -X POST "http://127.0.0.1:8877/hook?ppid=$PPID&tmux=$CCS_TMUX" \
  -H 'content-type: application/json' -H 'x-ccs-provider: codex' \
  -H "x-ccs-flags: $CCS_FLAGS" --data-binary "$payload" >/dev/null 2>&1
exit 0
