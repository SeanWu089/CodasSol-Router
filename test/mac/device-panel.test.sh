#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMP="$(mktemp -d)"
cleanup() {
  kill "${LIVE_PID:-}" "${OLD_PID:-}" 2>/dev/null || true
  rm -rf "$TEMP"
}
trap cleanup EXIT
TOKEN="test-mac-device-panel-local-secret-123456789"
printf '{"adminToken":"%s","agents":{"legacy-win":{"label":"Office PC","platform":"win32","tokenHash":"not-exposed"}}}' "$TOKEN" > "$TEMP/router.json"
node "$ROOT/scripts/mac/test-support/device-panel-fixture.cjs" "$TEMP/live.port" registry "$TOKEN" &
LIVE_PID=$!
node "$ROOT/scripts/mac/test-support/device-panel-fixture.cjs" "$TEMP/old.port" legacy "$TOKEN" &
OLD_PID=$!
for i in {1..50}; do
  [[ -s "$TEMP/live.port" && -s "$TEMP/old.port" ]] && break
  sleep 0.1
done
[[ -s "$TEMP/live.port" && -s "$TEMP/old.port" ]] || { echo 'Mock Router failed to start' >&2; exit 1; }
swiftc "$ROOT/scripts/mac/menu-app/DeviceDirectoryClient.swift" "$ROOT/test/mac/DevicePanelClientTest.swift" -o "$TEMP/device-panel-test"
"$TEMP/device-panel-test" "$(cat "$TEMP/live.port")" "$(cat "$TEMP/old.port")" "$TEMP/router.json"
