#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$HOME/Desktop/PROJECTS/CodasSol-Router}"
BASE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$BASE/router-addon/controller-api.js"
SERVER="$ROOT/src/server.js"
ADDON="$ROOT/src/controller-api.js"
if [[ ! -f "$SERVER" || ! -f "$ROOT/src/runtime.js" ]]; then
  echo "ERROR: CodasSol v0.2 project not found at: $ROOT" >&2
  exit 1
fi
if grep -q 'handleControllerRoute' "$SERVER"; then
  echo "Controller API already installed; no changes made."
  exit 0
fi
if [[ -e "$ADDON" ]]; then
  echo "ERROR: Existing src/controller-api.js will not be overwritten." >&2
  exit 1
fi
TEMP_BACKUP="$(mktemp)"
cp "$SERVER" "$TEMP_BACKUP"
rollback() {
  cp "$TEMP_BACKUP" "$SERVER"
  rm -f "$ADDON" "$TEMP_BACKUP"
  echo "Installation failed; Router source restored." >&2
}
trap rollback ERR
cp "$SRC" "$ADDON"
node --input-type=module - "$SERVER" <<'JS'
import fs from 'node:fs';
const filename = process.argv[2];
let code = fs.readFileSync(filename, 'utf8');
const anchor = 'import http from "node:http";';
const marker = '    try {\n      if (await handlePeerRoute(req, res, config, runtime)) return;';
if (!code.includes(anchor) || !code.includes(marker)) {
    throw new Error('Router version mismatch: expected CodasSol v0.2 server.js');
}
code = code.replace(anchor, 'import { handleControllerRoute, createControllerListener } from "./controller-api.js";\n' + anchor);
code = code.replace(marker,
  '    if (await handleControllerRoute(req, res, config, runtime, probeBackend)) return;\n' + marker);
const afterListen = '  await activeRuntime.peerMesh?.refresh();';
if (!code.includes(afterListen)) throw Error('Router startRouter() signature has changed');
code = code.replace(afterListen, `  if (process.env.CODASSOL_CONTROLLER_PORT) {
    const port = Number(process.env.CODASSOL_CONTROLLER_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      server.close();
      throw new Error("Invalid CODASSOL_CONTROLLER_PORT");
    }
    const controller = createControllerListener(config, activeRuntime, probeBackend);
    try {
      await new Promise((resolve, reject) => {
        controller.once("error", reject);
        controller.listen(port, process.env.CODASSOL_CONTROLLER_HOST || "127.0.0.1", resolve);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    server.controllerListener = controller;
    server.once("close", () => controller.close());
  }
` + afterListen);
fs.writeFileSync(filename, code);
JS
node --check "$ADDON"
node --check "$SERVER"
(cd "$BASE" && npm test)
(cd "$ROOT" && npm test)
trap - ERR
rm -f "$TEMP_BACKUP"
echo "Controller API installed, syntax and tests passed. Restart Router to activate."
