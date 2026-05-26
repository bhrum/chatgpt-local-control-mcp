#!/usr/bin/env bash
set -euo pipefail

SERVER_LABEL="com.chatgpt.local-control-mcp"
TUNNEL_LABEL="com.chatgpt.local-control-tunnel"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
GUI_DOMAIN="gui/$(id -u)"

unload_job() {
  local label="$1"
  local plist="$LAUNCH_AGENT_DIR/$label.plist"
  launchctl bootout "$GUI_DOMAIN" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
}

unload_job "$TUNNEL_LABEL"
unload_job "$SERVER_LABEL"

echo "Removed launch agents:"
echo "  $TUNNEL_LABEL"
echo "  $SERVER_LABEL"
