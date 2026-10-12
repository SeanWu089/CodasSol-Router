#!/bin/zsh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/dist"
version='v0.2.0-standalone-preview.2'
name="CodasSol-Windows-Node-$version"
zipname="$name.zip"
cache="$out/.downloads"
nodeversion="${CODASSOL_NODE_VERSION:-v22.23.3}"
archive="node-$nodeversion-win-x64.zip"
mkdir -p "$out" "$cache"

download() {
  local file="$1" dest="$2"
  if [[ -s "$dest" ]]; then return 0; fi
  for base in "https://npmmirror.com/mirrors/node/$nodeversion" "https://nodejs.org/dist/$nodeversion"; do
    if curl -fL --retry 1 --connect-timeout 8 --max-time 60 "$base/$file" -o "$dest.tmp"; then
      mv "$dest.tmp" "$dest"; return 0
    fi
  done
  rm -f "$dest.tmp"
  print -u2 "Could not download $file; build aborted."
  exit 1
}

download "$archive" "$cache/$archive"
download 'SHASUMS256.txt' "$cache/SHASUMS256.txt"
expected="$(awk -v n="$archive" '$2 == n {print $1}' "$cache/SHASUMS256.txt")"
actual="$(shasum -a 256 "$cache/$archive" | awk '{print $1}')"
[[ -n "$expected" && "$expected" == "$actual" ]] || { print -u2 'Node checksum mismatch.'; exit 1; }

build="$out/$name"
rm -rf "$build" "$out/$zipname"
mkdir -p "$build/payload/app" "$build/payload/runtime" "$out/.node-stage"
ditto -x -k "$cache/$archive" "$out/.node-stage"
mv "$out/.node-stage/node-$nodeversion-win-x64" "$build/payload/node"
rm -rf "$out/.node-stage"
cp "$here"/src/*.js "$build/payload/app/"
print '{"name":"codassol-standalone-windows","type":"module","private":true}' > "$build/payload/app/package.json"
cp "$here/scripts/windows/runtime/configure-devspace-root.mjs" "$build/payload/runtime/"
cp "$here/scripts/windows/standalone/runtime/"*.ps1 "$build/payload/runtime/"
cp "$here/scripts/windows/standalone/runtime/"*.mjs "$build/payload/runtime/"
cp "$here/scripts/windows/standalone/"*.ps1 "$build/"
cp "$here/scripts/windows/standalone/"*.cmd "$build/"
cp "$here/scripts/windows/standalone/probe-mcp.mjs" "$build/"
cp "$here/scripts/windows/standalone/README-WINDOWS.txt" "$build/"
# Windows command interpreter expects CRLF line endings for batch scripts.
BUILD_DIR="$build" python3 - <<'PY'
from pathlib import Path
import os
for batch in Path(os.environ['BUILD_DIR']).glob('*.cmd'):
    content = batch.read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    batch.write_bytes(content)
PY

(
  cd "$out"
  zip -q -r -X "$zipname" "$name"
)
( cd "$out" && shasum -a 256 "$zipname" > "$zipname.sha256" )
print "Built $out/$zipname"
print "SHA256 $(cat "$out/$zipname.sha256")"
