#!/usr/bin/env bash
# Installs the Agent Hub Mac daemon as a launchd user agent.
#   ./scripts/install-daemon.sh            install / update and start
#   ./scripts/install-daemon.sh uninstall  stop and remove
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

if [[ ! -f "$SUPPORT/daemon.env" ]]; then
  cat > "$SUPPORT/daemon.env" <<EOF
HUB_URL=https://your-hub.example.com
HUB_DAEMON_TOKEN=
# BACKFILL_HOURS=24
EOF
  chmod 600 "$SUPPORT/daemon.env"
  echo "Created $SUPPORT/daemon.env. Fill in HUB_URL and HUB_DAEMON_TOKEN, then re-run this script."
  exit 0
fi

(cd "$REPO" && npm run build >/dev/null)

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
  <dict><key>AGENT_HUB_ENV</key><string>$SUPPORT/daemon.env</string></dict>
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
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat <<EOF
Installed $LABEL. Logs: $LOGS/daemon.log

One-time permissions:
  1. System Settings → Privacy & Security → Full Disk Access → add:
       $NODE
     (the daemon only ever opens chat.db read-only)
  2. The first outgoing message triggers a prompt to let node control Messages. Allow it.
Then restart:  launchctl kickstart -k gui/$(id -u)/$LABEL
EOF
