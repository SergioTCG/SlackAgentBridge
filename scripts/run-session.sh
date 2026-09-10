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
startup_status_file="${CCS_STARTUP_STATUS_FILE:-}"
unset CCS_STARTUP_STATUS_FILE
startup_status_root="$CONFIG_DIR/runtime/"
startup_status_name="${startup_status_file#"$startup_status_root"}"
if [[ "$startup_status_file" != "$startup_status_root"* || "$startup_status_name" == */* ||
      ! "$startup_status_name" =~ ^resume-[A-Za-z0-9_.:-]+\.exit$ ]]; then
  startup_status_file=""
fi

record_startup_exit() {
  status="$1"
  [ -n "$startup_status_file" ] || return 0
  [ -f "${startup_status_file}.armed" ] || return 0
  tmp_status="${startup_status_file}.tmp.$$"
  (umask 077 && printf '%s\n' "$status" > "$tmp_status") || return 0
  mv -f "$tmp_status" "$startup_status_file" 2>/dev/null || rm -f "$tmp_status"
}

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
  if [ -n "$startup_status_file" ]; then
    status=0
    claude --mcp-config "$CONFIG_DIR/mcp.json" \
      --channels server:slack-bridge "$@" || status=$?
    record_startup_exit "$status"
    return "$status"
  fi
  exec claude --mcp-config "$CONFIG_DIR/mcp.json" \
    --channels server:slack-bridge "$@"
}

run_codex() {
  # SAB owns provider updates through `/sab-update`; a native startup chooser
  # would otherwise strand a detached session before hooks can bind its Slack
  # channel. Keep this internal so it is neither user launch metadata nor a
  # remotely configurable flag.
  codex_tui_args=(-c 'check_for_update_on_startup=false' -c 'tui.keymap.chat.interrupt_turn="f12"')
  direct_codex() { exec codex "${codex_tui_args[@]}" "$@"; }
  if [ "${CCS_CODEX_APP_SERVER:-1}" = "0" ] || [ -z "${CCS_TMUX:-}" ]; then direct_codex "$@"; fi

  runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/sab-codex-events.XXXXXX")" || direct_codex "$@"
  app_log="$runtime_dir/app-server.log"
  proxy_log="$runtime_dir/event-proxy.log"
  app_pid=""
  proxy_pid=""

  cleanup_sidecars() {
    status=${1:-$?}
    proxy_status=0
    trap - EXIT HUP INT TERM
    if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then kill "$proxy_pid" 2>/dev/null || true; fi
    # The proxy owns the stable commentary/final delivery queue. Let its bounded
    # shutdown drain finish while the correlated App Server process is still
    # alive, otherwise the daemon's exact-process ancestry check rejects the
    # final response which the proxy is trying to flush.
    if [ -n "$proxy_pid" ]; then
      if wait "$proxy_pid" 2>/dev/null; then proxy_status=0; else proxy_status=$?; fi
    fi
    if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then kill "$app_pid" 2>/dev/null || true; fi
    if [ -n "$app_pid" ]; then wait "$app_pid" 2>/dev/null || true; fi
    if [ "$proxy_status" -ne 0 ]; then
      if [ -s "$proxy_log" ]; then tail -n 20 "$proxy_log" >&2; fi
      printf '%s\n' 'sab: Codex response delivery did not drain; the final may require daemon recovery or a retry.' >&2
      if [ "$status" -eq 0 ]; then status=1; fi
    fi
    rm -f "$app_log" "$proxy_log"
    rmdir "$runtime_dir" 2>/dev/null || true
    return "$status"
  }
  exit_with_cleanup() {
    original_status=$?
    if cleanup_sidecars "$original_status"; then final_status=0; else final_status=$?; fi
    exit "$final_status"
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
    cleanup_sidecars 0 || true
    direct_codex "$@"
  }

  # Codex >= 0.154 refuses a permission-override flag when resuming a REMOTE
  # (app-server) task: "Permission overrides are not supported when resuming a
  # remote task." New remote tasks still accept it, and the direct fallback
  # below accepts it too. So only on a remote resume: move the override off the
  # client and onto the app-server, which sets the hosted task's permissions
  # instead. The resumed session keeps the same posture
  # (--yolo/--dangerously-bypass-approvals-and-sandbox -> Full Access) while the
  # resume is allowed to proceed. Non-resume launches are left untouched.
  app_policy_args=()
  remote_args=("$@")
  if [ "${1:-}" = "resume" ]; then
    filtered=()
    stripped_override=0
    for arg in "$@"; do
      case "$arg" in
        --yolo|--dangerously-bypass-approvals-and-sandbox) stripped_override=1 ;;
        *) filtered+=("$arg") ;;
      esac
    done
    if [ "$stripped_override" = 1 ]; then
      remote_args=("${filtered[@]}")
      app_policy_args=(-c sandbox_mode=danger-full-access -c approval_policy=never)
    fi
  fi

  if [ "${#app_policy_args[@]}" -gt 0 ]; then
    codex app-server --listen ws://127.0.0.1:0 "${app_policy_args[@]}" >"$app_log" 2>&1 & app_pid=$!
  else
    codex app-server --listen ws://127.0.0.1:0 >"$app_log" 2>&1 & app_pid=$!
  fi
  app_url="$(wait_for_url "$app_log" "$app_pid")" || fallback_to_direct "$@"
  node "$BRIDGE/scripts/codex-event-proxy.mjs" \
    --upstream "$app_url" --agent-pid "$app_pid" --tmux "$CCS_TMUX" >"$proxy_log" 2>&1 & proxy_pid=$!
  proxy_url="$(wait_for_url "$proxy_log" "$proxy_pid")" || fallback_to_direct "$@"
  trap exit_with_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  codex --remote "$proxy_url" "${codex_tui_args[@]}" "${remote_args[@]}"
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
