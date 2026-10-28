#!/bin/zsh
# Stable, cloud-independent production launcher.
emulate -L zsh
set -euo pipefail
# Public access is provided only by the authenticated HTTPS tunnel.
export CODASSOL_LISTEN_HOST=127.0.0.1
root="$HOME/Library/Application Support/CodasSol/production"
node="${CODASSOL_NODE:-$HOME/.local/share/fnm/aliases/default/bin/node}"
if [[ ! -x "$node" || ! -f "$root/current/src/server.js" ]]; then
  print -u2 -- "CodasSol production router runtime missing"
  exit 70
fi
# Node resolves symlinks in import.meta.url. Pass the same physical path as argv[1].
runtime="$(cd "$root/current" && /bin/pwd -P)"
cd "$runtime"
exec "$node" "$runtime/src/server.js"
