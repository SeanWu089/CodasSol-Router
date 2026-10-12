#!/bin/zsh
set -euo pipefail

ROOT="$(cd "${0:A:h}/../.." && pwd)"
for file in \
  "$ROOT/scripts/mac/ngrok-ingress-runner.zsh" \
  "$ROOT/scripts/mac/manage-ngrok-ingress.sh" \
  "$ROOT/scripts/mac/switch-ngrok-ingress.zsh" \
  "$ROOT/scripts/mac/start-devspace-ngrok-compat.zsh"; do
  /bin/zsh -n "$file"
done

# No accidental global process cleanup or bypass of CodasSol Router.
if /usr/bin/grep -Eq '(^|[[:space:]])(pkill|killall)[[:space:]]|exec .*ngrok http "?7676' \
  "$ROOT/scripts/mac/ngrok-ingress-runner.zsh" \
  "$ROOT/scripts/mac/manage-ngrok-ingress.sh"; then
  print -u2 -- "FAIL: ingress launcher must not kill shared processes or expose DevSpace"
  exit 1
fi

set +e
CODASSOL_PUBLIC_URL="http://unsafe.example.test" \
  /bin/zsh "$ROOT/scripts/mac/ngrok-ingress-runner.zsh" --check >/dev/null 2>&1
invalid_status=$?
set -e
if [[ "$invalid_status" != 64 ]]; then
  print -u2 -- "FAIL: HTTP public domain was not rejected"
  exit 1
fi

print -- "PASS: scripts parse, production services untouched, invalid public origin rejected."
