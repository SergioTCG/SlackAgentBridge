#!/bin/bash
# Private implementation for `sab account`.
#
# Each named account is a long-lived OAuth token (from `claude setup-token`,
# which requires that account's own Claude subscription). Sessions reference an
# account by NAME; the token itself is resolved inside the private runner, so it
# never appears in argv — `ps` is readable by every user on the machine.
#
#   sab account list                 registered emails/groups, or legacy aliases
#   sab account add <name>           mint a token by signing in (browser)
#   sab account set <name>           store a token minted elsewhere (stdin)
#   sab account remove <name>
#   sab account preview [--json]      read-only pool migration inventory
#   sab account capabilities [--probe] [--json]
#   sab account registry <plan|stage|status|check> ...
set -euo pipefail
# The native installer puts claude in ~/.local/bin, which a login shell may lack.
command -v claude >/dev/null 2>&1 || PATH="$HOME/.local/bin:$PATH"

# Pool tooling must bypass the legacy registry's mkdir/chmod/create steps.
# Explicit staging writes only its own inactive metadata, never credentials or
# session state. Inspection never logs in or refreshes tokens.
case "${1:-list}" in
  list)
    [ "$#" -eq 0 ] || shift
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-registry.mjs" list "$@"
    ;;
  login-claude)
    shift
    [ "$#" -eq 1 ] || { echo 'Usage: sab account login-claude PROFILE' >&2; exit 2; }
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-profile.mjs" login "$1" claude
    ;;
  manage|group)
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-manage.mjs" "$@"
    ;;
  login-codex)
    shift
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-profile.mjs" login "$@"
    ;;
  pool)
    shift
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-pool.mjs" "$@"
    ;;
  registry)
    shift
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-registry.mjs" "$@"
    ;;
  preview|capabilities)
    exec node "$(dirname "${BASH_SOURCE[0]}")/sab-account-inspect.mjs" "$@"
    ;;
esac

CONFIG_DIR="${CCS_CONFIG_DIR:-$HOME/.config/ccs}"
ACCOUNTS="$CONFIG_DIR/accounts"

mkdir -p "$CONFIG_DIR"
[ -f "$ACCOUNTS" ] || { umask 177; : > "$ACCOUNTS"; }
chmod 600 "$ACCOUNTS" 2>/dev/null || true

valid_name() { [ "${#1}" -le 64 ] || return 1; case "$1" in ''|*[!a-zA-Z0-9_-]*) return 1 ;; *) return 0 ;; esac; }

store() { # name token
  local tmp
  tmp="$(mktemp)"
  grep -v "^$1=" "$ACCOUNTS" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  umask 177
  mv "$tmp" "$ACCOUNTS"
  chmod 600 "$ACCOUNTS"
  echo "✓ account '$1' stored in $ACCOUNTS"
  echo "  Bind a session to it in Slack:  /sab-account $1"
}

case "${1:-list}" in
  add)
    name="${2:?usage: sab account add <name>}"
    valid_name "$name" || { echo "name must be [a-zA-Z0-9_-]" >&2; exit 1; }
    # Mint in a throwaway config dir so this login never disturbs the machine's
    # own Claude session (auth is per-config-dir).
    tmpcfg="$(mktemp -d)"; out="$(mktemp)"
    trap 'rm -rf "$tmpcfg" "$out"' EXIT
    echo "Sign in as the person who owns this subscription (a browser will open)…"
    CLAUDE_CONFIG_DIR="$tmpcfg" claude setup-token 2>&1 | tee "$out" || true
    tok="$(grep -oE 'sk-ant-oat[0-9]*-[A-Za-z0-9_-]+' "$out" | tail -1 || true)"
    [ -n "$tok" ] || { echo "Could not read a token from that run. Paste it manually: sab account set $name" >&2; exit 1; }
    store "$name" "$tok"
    ;;
  set)
    name="${2:?usage: sab account set <name>   (token on stdin)}"
    valid_name "$name" || { echo "name must be [a-zA-Z0-9_-]" >&2; exit 1; }
    if [ -t 0 ]; then printf 'Paste the token for %s (input hidden): ' "$name"; read -rs tok; echo; else read -r tok; fi
    [ -n "${tok:-}" ] || { echo "no token given" >&2; exit 1; }
    store "$name" "$tok"
    ;;
  remove|rm)
    name="${2:?usage: sab account remove <name>}"
    valid_name "$name" || { echo 'invalid account name' >&2; exit 2; }
    CCS_ACCOUNT_REMOVE="$name" node "$(dirname "${BASH_SOURCE[0]}")/sab-account-registry.mjs" guard-remove >/dev/null
    tmp="$(mktemp)"
    grep -v "^$name=" "$ACCOUNTS" > "$tmp" 2>/dev/null || true
    umask 177; mv "$tmp" "$ACCOUNTS"; chmod 600 "$ACCOUNTS"
    echo "✓ removed '$name' (sessions still bound to it will refuse to start; no fallback login is used)"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
