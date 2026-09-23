#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${CODASSOL_STATE_DIR:-$HOME/.codassol}"
PID_FILE="$STATE_DIR/router.pid"
LOG_FILE="$STATE_DIR/router.log"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "CodasSol Router is already running (PID $PID)."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$REPO_DIR"
node src/router-cli.js init >/dev/null

CODASSOL_LISTEN_HOST="${CODASSOL_LISTEN_HOST:-0.0.0.0}" \
CODASSOL_LISTEN_PORT="${CODASSOL_LISTEN_PORT:-17676}" \
CODASSOL_LOCAL_ROOTS="${CODASSOL_LOCAL_ROOTS:-$HOME}" \
CODASSOL_STATE_DIR="$STATE_DIR" \
nohup node src/server.js >>"$LOG_FILE" 2>&1 &

PID=$!
echo "$PID" >"$PID_FILE"
chmod 600 "$PID_FILE"

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${CODASSOL_LISTEN_PORT:-17676}/_codassol/health" >/dev/null 2>&1; then
    echo "CodasSol Router started (PID $PID)."
    node src/router-cli.js lan
    exit 0
  fi
  sleep 0.2
done

echo "CodasSol Router did not become ready. See $LOG_FILE" >&2
exit 1

