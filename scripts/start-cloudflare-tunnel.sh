#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/.mcp-artifacts"
LOG_DIR="$ROOT_DIR/.mcp-logs"
URL_FILE="$ARTIFACT_DIR/tunnel-url.txt"
ORIGIN_FILE="$ARTIFACT_DIR/tunnel-origin.txt"
LOG_FILE="$LOG_DIR/cloudflared-tunnel.log"
PORT="${PORT:-8787}"

mkdir -p "$ARTIFACT_DIR" "$LOG_DIR"

find_cloudflared() {
  local candidates=(
    "$ROOT_DIR/.bin/cloudflared"
    "$HOME/.local/bin/cloudflared"
    "/opt/homebrew/bin/cloudflared"
    "/usr/local/bin/cloudflared"
    "/usr/bin/cloudflared"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi

  return 1
}

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(find_cloudflared)}"

if [[ -z "$CLOUDFLARED_BIN" || ! -x "$CLOUDFLARED_BIN" ]]; then
  echo "cloudflared not found. Run npm run service:install first." >&2
  exit 127
fi

echo "Starting cloudflared tunnel with $CLOUDFLARED_BIN" >> "$LOG_FILE"
echo "Waiting for tunnel URL..." > "$URL_FILE"

"$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" --no-autoupdate 2>&1 | while IFS= read -r line; do
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$line" >> "$LOG_FILE"
  if [[ "$line" =~ https://[-a-zA-Z0-9.]+\.trycloudflare\.com ]]; then
    printf '%s\n' "${BASH_REMATCH[0]}" > "$ORIGIN_FILE"
    printf '%s/mcp\n' "${BASH_REMATCH[0]}" > "$URL_FILE"
  fi
  printf '%s\n' "$line"
done
