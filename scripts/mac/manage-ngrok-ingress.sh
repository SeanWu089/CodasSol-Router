#!/bin/zsh
# Manage the separate public CodasSol ingress LaunchAgent. It NEVER starts,
# stops or pkills DevSpace/Router, and never kills other ngrok endpoints.
emulate -L zsh
set -euo pipefail

mode="${1:-status}"
label="com.codassol.ngrok.ingress"
domain="gui/$(id -u)"
home="$HOME"
support="$home/.local/share/codassol-router/bin"
runner="$support/ngrok-ingress-runner.zsh"
plist="$home/Library/LaunchAgents/$label.plist"
state="$home/.codassol"
repo="$(cd "${0:A:h}/../.." && pwd)"
public_url="${CODASSOL_PUBLIC_URL:-}"

function current_tunnel() {
  /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:4040/api/tunnels
}

function url_from_tunnel() {
  current_tunnel | /usr/bin/python3 -c '
import json,sys
try:
 t=json.load(sys.stdin).get("tunnels",[])
 urls={x["public_url"] for x in t if x.get("public_url","").startswith("https://")}
 print(next(iter(urls)) if len(urls)==1 else "")
except (ValueError,KeyError): print("")
'
}

function configured_url() {
  if [[ -n "$public_url" ]]; then print -r -- "$public_url"; return; fi
  if [[ -f "$plist" ]]; then
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CODASSOL_PUBLIC_URL" "$plist" 2>/dev/null && return
  fi
  url_from_tunnel
}

function log_status() {
  print -- "DevSpace 7676: $(/usr/bin/curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:7676/healthz || true)"
  print -- "Router 17676:  $(/usr/bin/curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:17676/_codassol/health || true)"
  if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    print -- "ngrok LaunchAgent: installed and loaded"
  else
    print -- "ngrok LaunchAgent: not loaded"
  fi
  current_tunnel | /usr/bin/python3 -c '
import sys,json
try:
 for t in json.load(sys.stdin).get("tunnels",[]):
  print("ngrok tunnel: {} -> {}".format(t.get("public_url"), t.get("config",{}).get("addr")))
except (ValueError,KeyError):
 print("ngrok: no healthy agent management API")
' || true
}

function stage() {
  local url
  url="$(configured_url)"
  if [[ ! "$url" =~ '^https://[a-z0-9.-]+(:443)?$' ]]; then
    print -u2 -- "Cannot determine unique fixed URL; set CODASSOL_PUBLIC_URL."
    exit 64
  fi
  CODASSOL_PUBLIC_URL="$url" /bin/zsh "$repo/scripts/mac/ngrok-ingress-runner.zsh" --check
  if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    print -u2 -- "Ingress already managed. Use status; no destructive replacement performed."
    exit 1
  fi
  if [[ -e "$plist" ]]; then
    print -u2 -- "Existing ingress plist is not loaded. Inspect it before replacing: $plist"
    exit 1
  fi
  /bin/mkdir -p "$support" "$state" "$home/Library/LaunchAgents"
  /bin/chmod 700 "$state"
  /bin/cp "$repo/scripts/mac/ngrok-ingress-runner.zsh" "$runner.tmp.$$"
  /bin/chmod 700 "$runner.tmp.$$"
  /bin/mv "$runner.tmp.$$" "$runner"
  for name in manage-ngrok-ingress.sh switch-ngrok-ingress.zsh; do
    /bin/cp "$repo/scripts/mac/$name" "$support/$name.tmp.$$"
    /bin/chmod 700 "$support/$name.tmp.$$"
    /bin/mv "$support/$name.tmp.$$" "$support/$name"
  done
  /usr/bin/python3 - "$plist" "$label" "$runner" "$url" "$state" <<'PY'
import plistlib,sys
plist,label,runner,url,state=sys.argv[1:]
config={
 "Label":label,
 "ProgramArguments":["/bin/zsh",runner,"--serve"],
 "EnvironmentVariables":{"CODASSOL_PUBLIC_URL":url},
 "RunAtLoad":True,"KeepAlive":True,"ThrottleInterval":15,
 "StandardOutPath":state+"/ngrok-ingress.launchd.log",
 "StandardErrorPath":state+"/ngrok-ingress.launchd.err.log"
}
with open(plist,"wb") as f: plistlib.dump(config,f)
PY
  /bin/chmod 600 "$plist"
  /usr/bin/plutil -lint "$plist"
  print -- "STAGED: $url -> :17676. Not running. Next: --migrate."
}

function migrated() {
  if [[ ! -f "$plist" ]]; then
    print -u2 -- "Run --stage first."
    exit 66
  fi
  if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    print -u2 -- "Ingress already loaded. No automatic restart."
    exit 1
  fi
  local url
  url="$(configured_url)"
  CODASSOL_PUBLIC_URL="$url" /bin/zsh "$runner" --check

  local info
  info="$(current_tunnel)" || { print -u2 -- "Cannot inspect existing ngrok; aborting."; exit 1; }
  # Identify the single ngrok process by the management port and validate
  # its exact public domain and old target. Never terminate by name/pattern.
  local old_pid
  old_pid="$(/usr/sbin/lsof -nP -t -iTCP:4040 -sTCP:LISTEN | /usr/bin/head -1)"
  if [[ -z "$old_pid" ]]; then print -u2 -- "ngrok API owner PID unknown."; exit 1; fi
  local old_command
  old_command="$(/bin/ps -p "$old_pid" -o command=)"
  if [[ "$old_command" != *"ngrok http 7676"* || "$old_command" != *"$url"* ]]; then
    print -u2 -- "Refusing to stop unexpected ngrok process PID $old_pid: $old_command"
    exit 1
  fi
  /usr/bin/python3 -c '
import json,sys
t=json.load(sys.stdin).get("tunnels",[])
assert len(t)==1
assert t[0].get("public_url")==sys.argv[1]
assert t[0].get("config",{}).get("addr") in ("http://localhost:7676","http://127.0.0.1:7676")
' "$url" <<< "$info" || { print -u2 -- "ngrok endpoint/target changed; aborting."; exit 1; }

  # Run in a detached process before changing the network path so the
  # switching operation survives interruption of the current MCP session.
  local file="$state/ngrok-ingress-migration-$(/bin/date +%Y%m%d-%H%M%S).log"
  /usr/bin/nohup /bin/zsh "$support/switch-ngrok-ingress.zsh" "$old_pid" "$url" "$plist" "$label" >"$file" 2>&1 < /dev/null &
  print -- "Migration guard running PID=$!, log=$file. Temporary MCP reconnect may occur."
}

case "$mode" in
  status|--status) log_status ;;
  --stage) stage ;;
  --migrate) migrated ;;
  start|--start)
    if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
      log_status
    elif [[ ! -f "$plist" ]]; then
      print -u2 -- "No dedicated ingress installed. Run --stage then --migrate."
      exit 1
    elif current_tunnel >/dev/null 2>&1; then
      print -u2 -- "Another ngrok process is running. Refusing to compete; use --migrate."
      exit 1
    else
      /bin/launchctl bootstrap "$domain" "$plist"
      log_status
    fi
    ;;
  *) print -u2 -- "Usage: $0 [status|--stage|--migrate|start]"; exit 64 ;;
esac
