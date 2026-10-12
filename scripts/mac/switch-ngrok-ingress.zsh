#!/bin/zsh
# One-shot, detached, fail-safe migration of ONE verified fixed-domain ngrok
# process from DevSpace :7676 to CodasSol Router :17676.
# Do not invoke unless manage-ngrok-ingress.sh validated the old PID/URL.
emulate -L zsh
set -euo pipefail

if (( $# != 4 )); then
  print -u2 -- "Usage: switch-ngrok-ingress.zsh OLD_NGROK_PID PUBLIC_URL PLIST LABEL"
  exit 64
fi
old_pid="$1"
url="$2"
plist="$3"
label="$4"
launch_domain="gui/$(id -u)"
ngrok="/opt/homebrew/bin/ngrok"
success=false
stopped_old=false

function get_tunnel() {
  /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:4040/api/tunnels
}

function tunnel_matches() {
  local port="$1"
  get_tunnel | /usr/bin/python3 -c '
import json,sys
try:
 t=json.load(sys.stdin).get("tunnels",[])
 ok=len(t)==1 and t[0].get("public_url")==sys.argv[1] and t[0].get("config",{}).get("addr") in (
  "http://localhost:"+sys.argv[2], "http://127.0.0.1:"+sys.argv[2])
 sys.exit(0 if ok else 1)
except (ValueError,KeyError): sys.exit(1)
' "$url" "$port"
}

function live_health() {
  /usr/bin/curl -fsS --max-time 12 "$url/_codassol/health" |
    /usr/bin/python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if x.get("ok") is True and x.get("backendReachable") is True else 1)'
}

function rollback() {
  if [[ "$success" == true || "$stopped_old" != true ]]; then return; fi
  print -u2 -- "FAILURE: restoring original DevSpace :7676 public tunnel"
  /bin/launchctl bootout "$launch_domain/$label" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! get_tunnel >/dev/null 2>&1; then break; fi
    /bin/sleep 0.5
  done
  if get_tunnel >/dev/null 2>&1; then
    print -u2 -- "ROLLBACK STOPPED: ngrok still owns port 4040; not starting competing tunnel."
    return
  fi
  /usr/bin/nohup "$ngrok" http 7676 --url "$url" --log stdout --log-format json >>"$HOME/.codassol/ngrok-ingress-rollback.log" 2>&1 < /dev/null &
  for _ in {1..60}; do
    if tunnel_matches 7676; then
      print -- "ROLLBACK COMPLETE: fixed domain restored to original DevSpace 7676."
      return
    fi
    /bin/sleep 0.5
  done
  print -u2 -- "CRITICAL: automatic rollback did not reconnect; inspect log."
}
trap rollback EXIT

if [[ ! "$old_pid" == <-> || ! -f "$plist" || ! -x "$ngrok" ||
      "$label" != "com.codassol.ngrok.ingress" ||
      ! "$url" =~ '^https://[a-z0-9.-]+(:443)?$' ]]; then
  print -u2 -- "Refusing invalid migration parameters."
  exit 64
fi

old_command="$(/bin/ps -p "$old_pid" -o command=)"
if [[ "$old_command" != *"ngrok http 7676"* ||
      "$old_command" != *"$url"* ]] || ! tunnel_matches 7676; then
  print -u2 -- "Old PID/domain no longer matches; migration aborted."
  exit 1
fi
if ! /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:17676/_codassol/health >/dev/null; then
  print -u2 -- "Router is not ready; leave tunnel unchanged."
  exit 1
fi

print -- "Verified legacy ngrok PID $old_pid; switching fixed domain to Router :17676"
/bin/kill -TERM "$old_pid"
stopped_old=true
for _ in {1..30}; do
  if ! /bin/kill -0 "$old_pid" 2>/dev/null; then break; fi
  /bin/sleep 0.2
done
for _ in {1..20}; do
  if ! get_tunnel >/dev/null 2>&1; then break; fi
  /bin/sleep 0.5
done
if get_tunnel >/dev/null 2>&1; then
  print -u2 -- "Old tunnel did not release API port; rollback guard engaged."
  exit 1
fi

/bin/launchctl bootstrap "$launch_domain" "$plist"
for _ in {1..90}; do
  if tunnel_matches 17676 && live_health; then
    # Require the public MCP path to enforce authorization, not to return
    # a DevSpace HTML 404. Do not send any bearer credentials in this probe.
    code="$(/usr/bin/curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$url/mcp" || true)"
    if [[ "$code" == "401" ]]; then
      success=true
      print -- "SUCCESS: fixed domain -> Router 17676 -> DevSpace 7676; public MCP HTTP 401 (expected)."
      exit 0
    fi
  fi
  /bin/sleep 0.5
done
print -u2 -- "Timed out waiting for Router public health/MCP; running rollback."
exit 1
