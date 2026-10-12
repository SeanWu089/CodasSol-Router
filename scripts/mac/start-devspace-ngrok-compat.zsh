#!/bin/zsh
# Compatibility alias: managed DevSpace has its own LaunchAgent already.
# Invoking the old command must NEVER kill DevSpace or bypass CodasSol Router.
emulate -L zsh
set -euo pipefail
managed="$HOME/.local/share/codassol-router/bin/manage-ngrok-ingress.sh"
if [[ ! -f "$managed" ]]; then
  print -u2 -- "CodasSol ingress not staged; run scripts/mac/manage-ngrok-ingress.sh --stage."
  exit 66
fi
exec /bin/zsh "$managed" start
