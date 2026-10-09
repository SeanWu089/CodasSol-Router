#!/bin/zsh
set -euo pipefail

# Isolated launchd smoke test: it uses a unique label, mocked DevSpace package
# and no network listener. It never touches the production service or port.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d '/tmp/CodasSol mac lifecycle.XXXXXX')"
LABEL="com.codassol.devspace.test.$$"
DOMAIN="gui/$(id -u)"
trap '/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

mkdir -p "$TMP/Application Support" "$TMP/npm/devspace/dist"
cp "$ROOT/scripts/mac/menu-app/devspace-runner.zsh" "$TMP/Application Support/runner.zsh"
print -r -- '{"name":"@waishnav/devspace"}' > "$TMP/npm/devspace/package.json"
print -r -- 'console.log("MOCK_LAUNCH_AGENT_ACTIVE " + process.argv.slice(2).join(" "))' > "$TMP/npm/devspace/dist/cli.js"
NODE="$(command -v node)"

/usr/bin/python3 - "$TMP" "$LABEL" "$NODE" <<'PY'
import os,plistlib,sys
root,label,node=sys.argv[1:]
options={
    'Label':label,
    'ProgramArguments':['/bin/zsh',f'{root}/Application Support/runner.zsh','--serve'],
    'EnvironmentVariables':{'CODASSOL_NODE_BIN':node,'CODASSOL_DEVSPACE_PACKAGE':f'{root}/npm/devspace'},
    'RunAtLoad':True,
    'KeepAlive':{'SuccessfulExit':False},
    'StandardOutPath':f'{root}/stdout.log',
    'StandardErrorPath':f'{root}/stderr.log',
}
with open(f'{root}/fixture.plist','wb') as fd: plistlib.dump(options,fd)
PY

/usr/bin/plutil -lint "$TMP/fixture.plist"
/bin/launchctl bootstrap "$DOMAIN" "$TMP/fixture.plist"
found=false
for _ in {1..25}; do
  if [[ -f "$TMP/stdout.log" ]] && /usr/bin/grep -q 'MOCK_LAUNCH_AGENT_ACTIVE serve' "$TMP/stdout.log"; then
    found=true
    break
  fi
  /bin/sleep 0.2
done
if [[ "$found" != true ]]; then
  print -u2 -- "Fixture did not start: $(cat "$TMP/stderr.log" 2>/dev/null)"
  exit 1
fi
print -- 'PASS: LaunchAgent can start stable helper with a path containing spaces'
/bin/launchctl bootout "$DOMAIN/$LABEL"
if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  print -u2 -- 'FAIL: fixture LaunchAgent still loaded after bootout'
  exit 1
fi
print -- 'PASS: LaunchAgent stopped and unloaded without affecting production DevSpace'
