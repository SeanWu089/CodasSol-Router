#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash scripts/cloud-build-ipa.sh
open -R "$PWD/dist/CodasSol-iPad-Controller-unsigned.ipa"
