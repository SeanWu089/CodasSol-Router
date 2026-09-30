#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_DIR/dist"
BUILD_DIR="$DIST_DIR/CodasSol-Windows-Agent"
PAYLOAD_DIR="$BUILD_DIR/payload"
NODE_VERSION="${CODASSOL_NODE_VERSION:-v22.23.3}"
NODE_ARCHIVE="node-${NODE_VERSION}-win-x64.zip"
NODE_MIRROR_BASE="https://npmmirror.com/mirrors/node/${NODE_VERSION}"
NODE_OFFICIAL_BASE="https://nodejs.org/dist/${NODE_VERSION}"
DOWNLOAD_DIR="$DIST_DIR/.downloads"

mkdir -p "$DIST_DIR" "$DOWNLOAD_DIR"
rm -rf "$BUILD_DIR" "$DIST_DIR/CodasSol-Windows-Agent.zip"
mkdir -p "$PAYLOAD_DIR/app" "$PAYLOAD_DIR/runtime"

download_with_fallback() {
  local name="$1"
  local destination="$2"
  local mirror_url="$NODE_MIRROR_BASE/$name"
  local official_url="$NODE_OFFICIAL_BASE/$name"

  if [[ -f "$destination" ]]; then
    return 0
  fi

  echo "Downloading $name from npmmirror..."
  if curl -fL --retry 2 --connect-timeout 10 "$mirror_url" -o "$destination.tmp"; then
    mv "$destination.tmp" "$destination"
    return 0
  fi

  rm -f "$destination.tmp"
  echo "Mirror failed; trying official Node source..."
  curl -fL --retry 2 --connect-timeout 10 "$official_url" -o "$destination.tmp"
  mv "$destination.tmp" "$destination"
}

download_with_fallback "$NODE_ARCHIVE" "$DOWNLOAD_DIR/$NODE_ARCHIVE"
download_with_fallback "SHASUMS256.txt" "$DOWNLOAD_DIR/SHASUMS256.txt"

EXPECTED_HASH="$(awk -v name="$NODE_ARCHIVE" '$2 == name {print $1}' "$DOWNLOAD_DIR/SHASUMS256.txt")"
if [[ -z "$EXPECTED_HASH" ]]; then
  echo "Could not find checksum for $NODE_ARCHIVE" >&2
  exit 1
fi

ACTUAL_HASH="$(shasum -a 256 "$DOWNLOAD_DIR/$NODE_ARCHIVE" | awk '{print $1}')"
if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
  echo "Node archive checksum mismatch." >&2
  exit 1
fi

TMP_NODE="$DIST_DIR/.node-extract"
rm -rf "$TMP_NODE"
mkdir -p "$TMP_NODE"
ditto -x -k "$DOWNLOAD_DIR/$NODE_ARCHIVE" "$TMP_NODE"
NODE_EXTRACTED="$TMP_NODE/node-${NODE_VERSION}-win-x64"
if [[ ! -f "$NODE_EXTRACTED/node.exe" ]]; then
  echo "Extracted Node runtime is incomplete." >&2
  exit 1
fi
mv "$NODE_EXTRACTED" "$PAYLOAD_DIR/node"
rm -rf "$TMP_NODE"

cp "$REPO_DIR/src/agent.js" "$PAYLOAD_DIR/app/"
cp "$REPO_DIR/src/agent-config.js" "$PAYLOAD_DIR/app/"
cp "$REPO_DIR/src/devspace-local-auth.js" "$PAYLOAD_DIR/app/"
cat > "$PAYLOAD_DIR/app/package.json" <<'JSON'
{
  "name": "codassol-windows-agent-runtime",
  "private": true,
  "type": "module"
}
JSON

cp "$REPO_DIR/scripts/windows/runtime/start-devspace.ps1" "$PAYLOAD_DIR/runtime/"
cp "$REPO_DIR/scripts/windows/runtime/start-agent.ps1" "$PAYLOAD_DIR/runtime/"
cp "$REPO_DIR/scripts/windows/runtime/configure-devspace-root.mjs" "$PAYLOAD_DIR/runtime/"
cp "$REPO_DIR/scripts/windows/bundle/INSTALL.cmd" "$BUILD_DIR/"
cp "$REPO_DIR/scripts/windows/bundle/install.ps1" "$BUILD_DIR/"
cp "$REPO_DIR/scripts/windows/bundle/install-autostart.ps1" "$BUILD_DIR/"
cp "$REPO_DIR/scripts/windows/bundle/REPAIR-ROOT.cmd" "$BUILD_DIR/"
cp "$REPO_DIR/scripts/windows/bundle/repair-root.ps1" "$BUILD_DIR/"
cp "$REPO_DIR/scripts/windows/runtime/configure-devspace-root.mjs" "$BUILD_DIR/"

ROUTER_IP="${CODASSOL_ROUTER_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
if [[ -n "$ROUTER_IP" ]]; then
  printf 'http://%s:17676\n' "$ROUTER_IP" > "$BUILD_DIR/router-default.txt"
else
  : > "$BUILD_DIR/router-default.txt"
fi

cat > "$BUILD_DIR/README-WINDOWS.txt" <<'TXT'
CodasSol Windows Agent
======================

1. Extract this ZIP to a normal folder.
2. Double-click INSTALL.cmd.
3. If DevSpace is being initialized for the first time, choose "Coding Agents".
4. Paste the pairing token shown on the Mac Router when prompted.

The installer:
- uses the bundled private Node 22 runtime;
- does not require Git;
- does not modify global Node/npm configuration;
- installs DevSpace only under %LOCALAPPDATA%\CodasSol\Agent;
- tries npmmirror first, then existing npm/proxy settings, then official npm;
- verifies Node, DevSpace, Router reachability, Agent config, and autostart tasks;
- stores private Agent credentials only in %USERPROFILE%\.codassol\agent.json.

Do not share the pairing token or .codassol\agent.json.
TXT

(
  cd "$DIST_DIR"
  zip -q -r -X "CodasSol-Windows-Agent.zip" "CodasSol-Windows-Agent"
)

echo "Built: $DIST_DIR/CodasSol-Windows-Agent.zip"
echo "Default Router URL: $(cat "$BUILD_DIR/router-default.txt" 2>/dev/null || true)"
