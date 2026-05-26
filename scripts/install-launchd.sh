#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT_DIR/.bin"
LOG_DIR="$ROOT_DIR/.mcp-logs"
ARTIFACT_DIR="$ROOT_DIR/.mcp-artifacts"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
SERVER_LABEL="com.chatgpt.local-control-mcp"
TUNNEL_LABEL="com.chatgpt.local-control-tunnel"
SERVER_PLIST="$LAUNCH_AGENT_DIR/$SERVER_LABEL.plist"
TUNNEL_PLIST="$LAUNCH_AGENT_DIR/$TUNNEL_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

mkdir -p "$BIN_DIR" "$LOG_DIR" "$ARTIFACT_DIR" "$LAUNCH_AGENT_DIR"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

require_node() {
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    echo "node was not found. Install Node.js 20+ first." >&2
    exit 1
  fi
}

ensure_dependencies() {
  if [[ ! -d "$ROOT_DIR/node_modules/@modelcontextprotocol" ]]; then
    echo "node_modules missing; running npm install..."
    (cd "$ROOT_DIR" && npm install)
  fi
}

ensure_cloudflared() {
  local target="$BIN_DIR/cloudflared"
  if [[ -x "$target" ]]; then
    return 0
  fi

  local arch
  arch="$(uname -m)"
  local asset_arch="amd64"
  if [[ "$arch" == "arm64" ]]; then
    asset_arch="arm64"
  fi

  local archive="$BIN_DIR/cloudflared-darwin-$asset_arch.tgz"
  local url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$asset_arch.tgz"

  echo "Downloading cloudflared for darwin/$asset_arch..."
  curl -L "$url" -o "$archive"
  tar -xzf "$archive" -C "$BIN_DIR"
  chmod +x "$target"
  rm -f "$archive"
}

write_plists() {
  local root_esc node_esc server_esc log_esc path_esc
  local cloudflared_esc
  root_esc="$(xml_escape "$ROOT_DIR")"
  node_esc="$(xml_escape "$NODE_BIN")"
  server_esc="$(xml_escape "$ROOT_DIR/src/server.js")"
  cloudflared_esc="$(xml_escape "$BIN_DIR/cloudflared")"
  log_esc="$(xml_escape "$LOG_DIR")"
  path_esc="$(xml_escape "$BIN_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

  cat > "$SERVER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_esc</string>
    <string>$server_esc</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root_esc</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_esc</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$log_esc/server.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_esc/server.err.log</string>
</dict>
</plist>
PLIST

  cat > "$TUNNEL_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$cloudflared_esc</string>
    <string>tunnel</string>
    <string>--url</string>
    <string>http://localhost:8787</string>
    <string>--no-autoupdate</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root_esc</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_esc</string>
    <key>PORT</key>
    <string>8787</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$log_esc/tunnel.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_esc/tunnel.err.log</string>
</dict>
</plist>
PLIST

  plutil -lint "$SERVER_PLIST" "$TUNNEL_PLIST"
}

reload_job() {
  local label="$1"
  local plist="$2"
  launchctl bootout "$GUI_DOMAIN" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "$GUI_DOMAIN" "$plist"
  launchctl enable "$GUI_DOMAIN/$label"
  launchctl kickstart -k "$GUI_DOMAIN/$label"
}

require_node
ensure_dependencies
ensure_cloudflared
chmod +x "$ROOT_DIR/scripts/start-cloudflare-tunnel.sh"
write_plists

reload_job "$SERVER_LABEL" "$SERVER_PLIST"
sleep 2
reload_job "$TUNNEL_LABEL" "$TUNNEL_PLIST"

echo "Installed launch agents:"
echo "  $SERVER_LABEL"
echo "  $TUNNEL_LABEL"
echo
echo "Logs:"
echo "  $LOG_DIR"
echo "Run npm run service:status to refresh and print the latest tunnel URL:"
echo "  $ARTIFACT_DIR/tunnel-url.txt"
