#!/bin/zsh
set -euo pipefail
exec /usr/bin/python3 "$HOME/Library/Application Support/CodasSol/production/bin/cloudflare-supervisor.py"
