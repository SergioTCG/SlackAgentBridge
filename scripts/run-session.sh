#!/bin/bash
# Private provider runner for `sab new` and daemon-owned detached tmux sessions.
set -euo pipefail

provider="${1:-}"
case "$provider" in claude|codex|pi) shift ;; *) echo "sab: invalid provider" >&2; exit 2 ;; esac

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [ "${SOURCE:0:1}" != "/" ] && SOURCE="$DIR/$SOURCE"
done
BRIDGE="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
CONFIG_DIR="${CCS_CONFIG_DIR:-$HOME/.config/ccs}"

command -v tmux >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
case "$provider" in
  claude) command -v claude >/dev/null 2>&1 || PATH="$HOME/.local/bin:$PATH" ;;
  codex) command -v codex >/dev/null 2>&1 || PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH" ;;
  pi) command -v pi >/dev/null 2>&1 || PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH" ;;
esac

export CCS_BRIDGE=1
export CCS_PROVIDER="$provider"
export CCS_FLAGS="$*"

case "$provider" in
  claude)
    unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_PID \
      CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_ENTRYPOINT CLAUDECODE 2>/dev/null || true
    ;;
  codex)
    unset CODEX_THREAD_ID CODEX_TURN_ID CODEX_SESSION_ID 2>/dev/null || true
    ;;
esac

if [ -z "${TMUX:-}" ] && [ -z "${CCS_NO_TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  unset CCS_TMUX
  TN="sab-${provider}-$$-$RANDOM"
  if [ "$provider" = "claude" ]; then "$BRIDGE/scripts/claude-consent.sh" "$TN" >/dev/null 2>&1 & fi
  bridge_env=("CCS_BRIDGE=1" "CCS_PROVIDER=$provider" "CCS_TMUX=$TN")
  if [ -n "${CCS_ACCOUNT:-}" ]; then bridge_env+=("CCS_ACCOUNT=$CCS_ACCOUNT"); fi
  exec tmux new-session -s "$TN" -- env "${bridge_env[@]}" \
    "$BRIDGE/bin/sab" __run "$provider" "$@"
fi

if [ -n "${TMUX:-}" ] && [ -z "${CCS_TMUX:-}" ]; then
  CCS_TMUX="$(tmux display-message -p '#S' 2>/dev/null)"
  export CCS_TMUX
fi

run_claude() {
  if [ -n "${CCS_ACCOUNT:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    acct_tok="$(grep -m1 "^${CCS_ACCOUNT}=" "$CONFIG_DIR/accounts" 2>/dev/null | cut -d= -f2-)"
    if [ -n "$acct_tok" ]; then
      export CLAUDE_CODE_OAUTH_TOKEN="$acct_tok"
    else
      echo "sab: unknown account '$CCS_ACCOUNT' — using this machine's Claude login" >&2
    fi
    unset acct_tok
  fi
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/mcp.json" <<EOF
{ "mcpServers": { "slack-bridge": { "command": "node", "args": ["$BRIDGE/channel/server.mjs"] } } }
EOF
  exec claude --mcp-config "$CONFIG_DIR/mcp.json" \
    --dangerously-load-development-channels server:slack-bridge "$@"
}

run_codex() {
  direct_codex() { exec codex -c 'tui.keymap.chat.interrupt_turn="f12"' "$@"; }
  if [ "${CCS_CODEX_APP_SERVER:-1}" = "0" ] || [ -z "${CCS_TMUX:-}" ]; then direct_codex "$@"; fi

  runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/sab-codex-events.XXXXXX")" || direct_codex "$@"
  app_log="$runtime_dir/app-server.log"
  proxy_log="$runtime_dir/event-proxy.log"
  app_pid=""
  proxy_pid=""

  cleanup_sidecars() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then kill "$proxy_pid" 2>/dev/null || true; fi
    if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then kill "$app_pid" 2>/dev/null || true; fi
    if [ -n "$proxy_pid" ]; then wait "$proxy_pid" 2>/dev/null || true; fi
    if [ -n "$app_pid" ]; then wait "$app_pid" 2>/dev/null || true; fi
    rm -f "$app_log" "$proxy_log"
    rmdir "$runtime_dir" 2>/dev/null || true
    return "$status"
  }
  wait_for_url() {
    log_file=$1; owner_pid=$2
    for _ in $(seq 1 50); do
      url=$(sed -n 's/.*listening on: \(ws:\/\/127\.0\.0\.1:[0-9][0-9]*\).*/\1/p' "$log_file" 2>/dev/null | head -n 1)
      if [ -n "$url" ]; then printf '%s\n' "$url"; return 0; fi
      kill -0 "$owner_pid" 2>/dev/null || return 1
      sleep 0.1
    done
    return 1
  }
  fallback_to_direct() {
    printf '%s\n' 'sab: Codex commentary transport unavailable; using the direct TUI.' >&2
    cleanup_sidecars || true
    direct_codex "$@"
  }

  codex app-server --listen ws://127.0.0.1:0 >"$app_log" 2>&1 & app_pid=$!
  app_url="$(wait_for_url "$app_log" "$app_pid")" || fallback_to_direct "$@"
  node "$BRIDGE/scripts/codex-event-proxy.mjs" \
    --upstream "$app_url" --agent-pid "$app_pid" --tmux "$CCS_TMUX" >"$proxy_log" 2>&1 & proxy_pid=$!
  proxy_url="$(wait_for_url "$proxy_log" "$proxy_pid")" || fallback_to_direct "$@"
  trap cleanup_sidecars EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  codex --remote "$proxy_url" -c 'tui.keymap.chat.interrupt_turn="f12"' "$@"
}

run_pi() {
  extension="$BRIDGE/pi/sab-extension.ts"
  [ -f "$extension" ] || { echo "sab: Pi bridge extension is missing: $extension" >&2; exit 1; }
  export CCS_PI_SAFE=""
  pi_args=()
  for arg in "$@"; do
    if [ "$arg" = "--safe" ]; then
      export CCS_PI_SAFE=1
    elif [[ "$arg" == --model=* || "$arg" == --thinking=* || "$arg" == --provider=* ]]; then
      pi_args+=("${arg%%=*}" "${arg#*=}")
    else
      pi_args+=("$arg")
    fi
  done
  exec pi --extension "$extension" "${pi_args[@]}"
}

case "$provider" in
  claude) run_claude "$@" ;;
  codex) run_codex "$@" ;;
  pi) run_pi "$@" ;;
esac
