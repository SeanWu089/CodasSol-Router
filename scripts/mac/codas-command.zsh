#!/bin/zsh
# Codas! — safe, idempotent Mac startup for the existing managed services.
# Never kill processes, run npm, replace Router, or expose DevSpace publicly.
emulate -L zsh
set -euo pipefail

case "${1:-start}" in
  start|status|--status) ;;
  *) print -u2 -- 'Usage: Codas! [status]'; exit 64 ;;
esac
mode="${1:-start}"
managed="$HOME/.local/share/codassol-router/bin/manage-ngrok-ingress.sh"
domain="gui/$(id -u)"

if [[ ! -f "$managed" ]]; then
  print -u2 -- "CodasSol ingress manager missing; install the Mac ingress first."
  exit 66
fi

function check_http() {
  /usr/bin/curl --fail --silent --max-time 3 "$1" >/dev/null
}

function ready_or_kickstart() {
  local label="$1" port="$2" endpoint="$3"
  if check_http "$endpoint"; then return 0; fi
  if ! /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    print -u2 -- "Not a registered LaunchAgent: $label. Refusing unmanaged startup."
    return 1
  fi
  # Never launch a second process if an unrecognized service already
  # occupies the expected TCP port.
  if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    print -u2 -- "TCP/$port is occupied but unhealthy. Diagnose $label; no restart performed."
    return 1
  fi
  /bin/launchctl kickstart "$domain/$label"
  for i in {1..20}; do
    if check_http "$endpoint"; then return 0; fi
    /bin/sleep 0.5
  done
  print -u2 -- "Managed service failed readiness: $label"
  return 1
}

if [[ "$mode" != "status" && "$mode" != "--status" ]]; then
  ready_or_kickstart "com.codassol.devspace.mac" 7676 \
    "http://127.0.0.1:7676/healthz"
  ready_or_kickstart "com.codassol.router" 17676 \
    "http://127.0.0.1:17676/_codassol/health"
  /bin/zsh "$managed" start
else
  /bin/zsh "$managed" status
fi
