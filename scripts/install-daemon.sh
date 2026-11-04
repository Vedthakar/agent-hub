#!/usr/bin/env bash
# Installs the Agent Hub Mac daemon as a launchd user agent.
#   ./scripts/install-daemon.sh pair <hub-url> <code>  pair with the hub (code from the dashboard), install, start
#   ./scripts/install-daemon.sh                        install / update and start (already paired, or daemon.env)
#   ./scripts/install-daemon.sh uninstall              stop and remove
set -euo pipefail

LABEL="com.agenthub.daemon"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/AgentHub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/AgentHub"
NODE="$(command -v node)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. State and config kept in $SUPPORT."
  exit 0
fi

[[ -n "$NODE" ]] || { echo "node not found on PATH"; exit 1; }
mkdir -p "$SUPPORT" "$LOGS" "$HOME/Library/LaunchAgents"

(cd "$REPO" && { [[ -d node_modules ]] || npm install --silent; } && npm run build >/dev/null)

if [[ "${1:-}" == "pair" ]]; then
  [[ -n "${2:-}" && -n "${3:-}" ]] || { echo "usage: $0 pair <hub-url> <pairing-code>"; exit 1; }
  "$NODE" --no-warnings=ExperimentalWarning "$REPO/dist/daemon/main.js" pair "$2" "$3"
elif [[ ! -f "$SUPPORT/daemon.json" && ! -f "$SUPPORT/daemon.env" ]]; then
  echo "Not paired yet. Open your hub's dashboard → Connections → Your Mac and copy the pairing command."
  echo "(Advanced: put HUB_URL and HUB_DAEMON_TOKEN in $SUPPORT/daemon.env instead.)"
  exit 1
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>$REPO/dist/daemon/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>AGENT_HUB_ENV</key><string>$SUPPORT/daemon.env</string><key>AGENT_HUB_LAUNCHD</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/daemon.log</string>
  <key>StandardErrorPath</key><string>$LOGS/daemon.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# The stop above finishes in the background, and starting too soon fails, so give it a few tries.
for attempt in 1 2 3 4 5 6; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  if [[ "$attempt" == 6 ]]; then
    echo "Couldn't start the helper. Try running this script again."
    exit 1
  fi
  sleep 2
done

cat <<EOF
Installed $LABEL. Logs: $LOGS/daemon.log

One-time permissions (the dashboard walks you through these and shows when they're granted):
  1. System Settings → Privacy & Security → Full Disk Access → add:
       $NODE
     (the daemon only ever opens chat.db read-only, and restarts itself to pick up the grant)
  2. The first outgoing message triggers a prompt to let node control Messages. Allow it.
EOF
