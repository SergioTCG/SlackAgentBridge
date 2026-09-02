#!/bin/bash
# Auto-dismiss Claude's workspace-trust and development-channel dialogs.
TN="${1:-}"
[ -n "$TN" ] || exit 0
for _ in $(seq 1 30); do tmux has-session -t "$TN" 2>/dev/null && break; sleep 0.3; done
deadline=$(( $(date +%s) + 30 ))
trust_done=0
channel_done=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  tmux has-session -t "$TN" 2>/dev/null || exit 0
  pane="$(tmux capture-pane -t "$TN" -p 2>/dev/null)"
  if [ "$trust_done" -eq 0 ] && printf '%s' "$pane" | grep -q "you created or one you trust"; then
    # Claude 2.1.258 changed the trust screen's initial selection to
    # "No, exit". Never press Enter until the affirmative row is visibly
    # selected: a detached session otherwise exits before SessionStart.
    if printf '%s\n' "$pane" | grep -Eq '^[[:space:]]*(❯|>)[[:space:]]*Yes, I trust this folder'; then
      tmux send-keys -t "$TN" Enter; trust_done=1; sleep 1; continue
    fi
    if printf '%s\n' "$pane" | grep -Eq '^[[:space:]]*(❯|>)[[:space:]]*No, exit'; then
      tmux send-keys -t "$TN" Down; sleep 0.5; continue
    fi
    # Unknown prompt rendering fails closed instead of guessing a key.
    sleep 0.5; continue
  fi
  if [ "$channel_done" -eq 0 ] && printf '%s' "$pane" | grep -q "development channels"; then
    tmux send-keys -t "$TN" Enter; channel_done=1; sleep 1; continue
  fi
  [ "$channel_done" -eq 1 ] && exit 0
  sleep 0.5
done
