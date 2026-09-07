#!/bin/bash
# Pi activation for an existing bridge installation. Never restarts the daemon.
set -euo pipefail

BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  -h|--help)
    printf 'Usage: %s\n\nStage the Pi integration without restarting the live daemon.\n' "$0"
    exit 0 ;;
  '') ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
printf 'Staging the Pi integration without restarting the live daemon.\n'
exec bash "$BRIDGE/install.sh" --provider pi --no-daemon-reload
