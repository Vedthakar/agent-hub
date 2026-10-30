#!/usr/bin/env bash
# Keeps the MacBook awake with the lid closed so the daemon keeps reading iMessage.
# caffeinate does NOT survive a lid close; pmset disablesleep does.
#   ./scripts/keep-awake.sh on | off | status
set -euo pipefail

case "${1:-status}" in
  on)
    echo "Warning: with sleep disabled and the lid closed the Mac can run warm and drain the battery."
    echo "Prefer leaving it on power, on a hard surface. Revert with: $0 off"
    sudo pmset -a disablesleep 1
    ;;
  off)
    sudo pmset -a disablesleep 0
    echo "Normal sleep restored."
    ;;
  status)
    pmset -g | grep -i -E "SleepDisabled|disablesleep" || echo "SleepDisabled not set (normal sleep)."
    ;;
  *)
    echo "usage: $0 on|off|status"; exit 1 ;;
esac
