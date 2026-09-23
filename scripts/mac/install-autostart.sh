#!/bin/zsh

set -euo pipefail

LABEL="com.codassol.router"
UID_VALUE="$(id -u)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="$(command -v node)"
STATE_DIR="${CODASSOL_STATE_DIR:-$HOME/.codassol}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"

mkdir -p "$STATE_DIR" "$PLIST_DIR"
chmod 700 "$STATE_DIR"

cd "$REPO_DIR"
node src/router-cli.js init >/dev/null

launchctl bootout "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true

cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/src/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODASSOL_LISTEN_HOST</key>
    <string>0.0.0.0</string>
    <key>CODASSOL_LISTEN_PORT</key>
    <string>17676</string>
    <key>CODASSOL_BACKEND_HOST</key>
    <string>127.0.0.1</string>
    <key>CODASSOL_BACKEND_PORT</key>
    <string>7676</string>
    <key>CODASSOL_LOCAL_ROOTS</key>
    <string>$HOME</string>
    <key>CODASSOL_STATE_DIR</key>
    <string>$STATE_DIR</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/router.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/router.launchd.err.log</string>
</dict>
</plist>
EOF

chmod 600 "$PLIST_PATH"
plutil -lint "$PLIST_PATH" >/dev/null
launchctl bootstrap "gui/$UID_VALUE" "$PLIST_PATH"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

for _ in {1..30}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:17676/_codassol/health" >/dev/null 2>&1; then
    echo "CodasSol Router LaunchAgent installed and running."
    node src/router-cli.js lan
    exit 0
  fi
  sleep 0.3
done

echo "LaunchAgent installed, but Router health check failed." >&2
exit 1

