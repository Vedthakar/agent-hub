#!/usr/bin/env bash
# Runs the hub in the background as a launchd user agent, so it survives closing Terminal and restarting the Mac.
#   ./scripts/install-hub.sh             install / update and start
#   ./scripts/install-hub.sh uninstall   stop and remove
set -euo pipefail

LABEL="com.agenthub.hub"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/AgentHub"
NODE="$(command -v node)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. Your data is untouched."
  exit 0
fi

[[ -n "$NODE" ]] || { echo "node not found on PATH"; exit 1; }
if [[ "$REPO" == "$HOME/Documents/"* || "$REPO" == "$HOME/Desktop/"* ]]; then
  echo "Warning: $REPO may sync to iCloud, which can make the hub stall. Keep it somewhere else, like ~/Code."
fi
mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"
(cd "$REPO" && npm run build >/dev/null)

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/dist/hub/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/hub.log</string>
  <key>StandardErrorPath</key><string>$LOGS/hub.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# The stop above finishes in the background, and starting too soon fails, so give it a few tries.
for attempt in 1 2 3 4 5 6; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  if [[ "$attempt" == 6 ]]; then
    echo "Couldn't start the hub. Try running this script again."
    exit 1
  fi
  sleep 2
done
echo "Hub running in the background. Logs: $LOGS/hub.log"
