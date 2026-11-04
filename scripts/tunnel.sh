#!/usr/bin/env bash
# Gives the hub a public https:// address so Claude, ChatGPT and Gemini can reach it. Uses ngrok's free,
# permanent dev domain. Saves the address as HUB_PUBLIC_URL in .env and stays running until Ctrl-C.
set -euo pipefail

PORT="${PORT:-8787}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${TUNNEL_ENV_FILE:-$REPO/.env}"

command -v ngrok >/dev/null || { echo "ngrok isn't installed. Run: brew install ngrok, then ngrok config add-authtoken <your token>"; exit 1; }

ngrok http "$PORT" --log=false >/dev/null &
NGROK=$!
trap 'kill "$NGROK" 2>/dev/null || true' EXIT

URL=""
for _ in $(seq 1 30); do
  URL="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).tunnels.find(t=>t.public_url.startsWith("https://"));console.log(t?t.public_url:"")})' || true)"
  [[ -n "$URL" ]] && break
  kill -0 "$NGROK" 2>/dev/null || { echo "ngrok stopped. Run 'ngrok http $PORT' to see why."; exit 1; }
  sleep 1
done
[[ -n "$URL" ]] || { echo "ngrok didn't report an address in time."; exit 1; }

CHANGED=1
if [[ -f "$ENV_FILE" ]] && grep -qx "HUB_PUBLIC_URL=$URL" "$ENV_FILE"; then
  CHANGED=0
else
  touch "$ENV_FILE"
  grep -v '^HUB_PUBLIC_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
  echo "HUB_PUBLIC_URL=$URL" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

echo
echo "  Public address: $URL"
echo "  Connector URL:  $URL/mcp"
if [[ "$CHANGED" == 1 ]]; then
  echo "  Saved to .env. Restart the hub once (Ctrl-C, then npm run start) so it uses this address."
fi
echo "  Keep this window open. Your dashboard stays at http://localhost:$PORT"
echo
wait "$NGROK"
