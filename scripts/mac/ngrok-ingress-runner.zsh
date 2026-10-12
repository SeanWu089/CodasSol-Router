#!/bin/zsh
# Single-purpose launchd process: ONLY the public ngrok -> CodasSol Router tunnel.
# DevSpace and Router are managed by their existing independent LaunchAgents.
emulate -L zsh
set -euo pipefail

mode="${1:---serve}"
if [[ "$mode" != "--serve" && "$mode" != "--check" ]]; then
  print -u2 -- "Usage: ngrok-ingress-runner.zsh --check|--serve"
  exit 64
fi

url="${CODASSOL_PUBLIC_URL:-}"
if [[ ! "$url" =~ '^https://[a-z0-9.-]+(:443)?$' ]]; then
  print -u2 -- "Set CODASSOL_PUBLIC_URL to the exact fixed HTTPS ngrok origin."
  exit 64
fi

ngrok_bin="${CODASSOL_NGROK_BIN:-/opt/homebrew/bin/ngrok}"
if [[ ! -x "$ngrok_bin" ]]; then
  print -u2 -- "ngrok binary missing: $ngrok_bin"
  exit 69
fi

health="$(/usr/bin/curl --silent --show-error --max-time 4 http://127.0.0.1:17676/_codassol/health)" || {
  print -u2 -- "CodasSol Router :17676 is not ready; refusing to expose DevSpace directly."
  exit 75
}

# A TCP listener or an unrelated HTTP 200 is not enough; require Router's
# explicit backendReachable signal. No admin or OAuth tokens are involved.
if ! /usr/bin/python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h.get("ok") is True and h.get("backendReachable") is True else 1)' <<< "$health"; then
  print -u2 -- "CodasSol Router health or DevSpace backend is not healthy."
  exit 75
fi

if [[ "$mode" == "--check" ]]; then
  print -- "READY: $url -> CodasSol Router :17676 -> DevSpace :7676"
  exit 0
fi

print -- "Starting dedicated ingress: $url -> 127.0.0.1:17676"
exec "$ngrok_bin" http 17676 --url "$url" --log stdout --log-format json
