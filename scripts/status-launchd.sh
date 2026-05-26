#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_LABEL="com.chatgpt.local-control-mcp"
TUNNEL_LABEL="com.chatgpt.local-control-tunnel"
GUI_DOMAIN="gui/$(id -u)"
URL_FILE="$ROOT_DIR/.mcp-artifacts/tunnel-url.txt"
ORIGIN_FILE="$ROOT_DIR/.mcp-artifacts/tunnel-origin.txt"
TUNNEL_ENV_FILE="$ROOT_DIR/.mcp-artifacts/named-tunnel.env"
CLOUDFLARED_TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-}"
CLOUDFLARED_TUNNEL_HOSTNAME="${CLOUDFLARED_TUNNEL_HOSTNAME:-}"

if [[ -f "$TUNNEL_ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      CLOUDFLARED_TUNNEL_NAME) CLOUDFLARED_TUNNEL_NAME="$value" ;;
      CLOUDFLARED_TUNNEL_HOSTNAME) CLOUDFLARED_TUNNEL_HOSTNAME="$value" ;;
    esac
  done < <(grep -E '^(CLOUDFLARED_TUNNEL_NAME|CLOUDFLARED_TUNNEL_HOSTNAME)=' "$TUNNEL_ENV_FILE" || true)
fi

print_job() {
  local label="$1"
  if launchctl print "$GUI_DOMAIN/$label" >/dev/null 2>&1; then
    echo "$label: loaded"
    launchctl print "$GUI_DOMAIN/$label" | awk '/pid =|last exit code =|state =/ { print "  " $0 }'
  else
    echo "$label: not loaded"
  fi
}

print_job "$SERVER_LABEL"
print_job "$TUNNEL_LABEL"

echo
echo "Local health:"
if curl -fsS --max-time 3 http://localhost:8787/ >/dev/null; then
  echo "  http://localhost:8787/ ok"
else
  echo "  http://localhost:8787/ failed"
fi

echo
echo "Latest tunnel URL:"
if [[ -n "$CLOUDFLARED_TUNNEL_HOSTNAME" ]]; then
  mkdir -p "$(dirname "$URL_FILE")"
  printf 'https://%s\n' "$CLOUDFLARED_TUNNEL_HOSTNAME" > "$ORIGIN_FILE"
  printf 'https://%s/mcp\n' "$CLOUDFLARED_TUNNEL_HOSTNAME" > "$URL_FILE"
  cat "$URL_FILE"
elif latest_origin="$(grep -hEo 'https://[-a-zA-Z0-9.]+\.trycloudflare\.com' "$ROOT_DIR/.mcp-logs"/tunnel.*.log 2>/dev/null | tail -n 1 || true)" && [[ -n "$latest_origin" ]]; then
  mkdir -p "$(dirname "$URL_FILE")"
  printf '%s\n' "$latest_origin" > "$ORIGIN_FILE"
  printf '%s/mcp\n' "$latest_origin" > "$URL_FILE"
  cat "$URL_FILE"
elif [[ -s "$URL_FILE" ]]; then
  cat "$URL_FILE"
else
  echo "  not ready yet"
fi
