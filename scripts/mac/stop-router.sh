#!/bin/zsh

set -euo pipefail

STATE_DIR="${CODASSOL_STATE_DIR:-$HOME/.codassol}"
PID_FILE="$STATE_DIR/router.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "CodasSol Router is not managed by the start script."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in {1..30}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
fi

rm -f "$PID_FILE"
echo "CodasSol Router stopped."

