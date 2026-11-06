#!/usr/bin/env bash
# One-command setup: checks your machine, installs, starts the hub and opens the setup page.
set -euo pipefail
cd "$(dirname "$0")"
REPO="$PWD"

command -v node >/dev/null || { echo "Node.js isn't installed. Get version 22.13 or newer from https://nodejs.org, then run this again."; exit 1; }
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Agent Hub needs Node.js 22.13 or newer. You have $(node -v). Update from https://nodejs.org, then run this again."
  exit 1
fi

case "$REPO" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Library/Mobile Documents/"*)
    if [[ "$(uname)" == "Darwin" ]]; then
      echo "Heads up: this folder may sync to iCloud, which can move a live database off your disk and stall the hub."
      echo "We recommend moving it to ~/Code/agent-hub first. Press Enter to continue anyway, or Ctrl-C to stop."
      read -r _ || true
    fi
    ;;
esac

echo "Installing. This takes a minute or two..."
# Install scripts only compile optional speedups, and they would require Python and a compiler.
npm ci --ignore-scripts --silent --no-fund --no-audit
npm run build --silent

if [[ "$(uname)" != "Darwin" ]]; then
  echo
  echo "Installed. Start it with: npm run start"
  echo "It prints a link to open. To keep it running in the background, use Docker: docker compose up -d"
  exit 0
fi

./scripts/install-hub.sh
LOG="$HOME/Library/Logs/AgentHub/hub.log"
for _ in $(seq 1 60); do
  curl -fsS -m 2 http://localhost:8787/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -m 2 http://localhost:8787/health >/dev/null 2>&1 || { echo "The hub didn't start. See $LOG"; exit 1; }

URL="$(grep -o 'http[^"]*/welcome?token=[^"]*' "$LOG" 2>/dev/null | tail -1 || true)"
[[ -n "$URL" ]] || URL="http://localhost:8787"
echo
echo "Agent Hub is running: $URL"
open "$URL" 2>/dev/null || true
