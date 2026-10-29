#!/bin/zsh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/dist"
version='v0.2.0-rc.1'
name="CodasSol-Windows-Clean-Reinstall-$version"
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
cp "$here/scripts/windows/clean/runtime/"*.mjs "$build/payload/runtime/"
cp "$here/scripts/windows/clean/"*.ps1 "$build/"
cp "$here/scripts/windows/clean/"*.cmd "$build/"
cp "$here/scripts/windows/clean/README-WINDOWS.txt" "$build/"
# Windows command interpreter expects CRLF line endings for batch scripts.
BUILD_DIR="$build" python3 - <<'PY'
from pathlib import Path
import os
for script in Path(os.environ['BUILD_DIR']).rglob('*.ps1'):
    script.write_bytes(b'\xef\xbb\xbf' + script.read_bytes().removeprefix(b'\xef\xbb\xbf'))
for batch in Path(os.environ['BUILD_DIR']).rglob('*.cmd'):
    content = batch.read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    batch.write_bytes(content)
PY

BUILD_DIR="$build" SOURCE_COMMIT="$(git -C "$here" rev-parse HEAD)" python3 - <<'MANIFEST'
from pathlib import Path
import os, json, hashlib
root=Path(os.environ['BUILD_DIR'])
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}
for name in files:
    if Path(name).name in {'outbound-agent.json','router.json','auth.json','device-id.txt','roots.txt'}:
        raise SystemExit('Private runtime state in payload: '+name)
manifest={'version':'0.2.0-clean-rc.1','sourceCommit':os.environ['SOURCE_COMMIT'],'qualification':'Windows automated CI; physical Windows acceptance pending','dependencies':{'node':'22.23.3 win-x64 bundled, checksum checked against retained upstream list','devspace':'1.1.0-beta.4 fetched from npm during installation','powershell':'Windows 5.1; isolated CI parsing and fault injection'},'files':files}
(root/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
MANIFEST

(
  cd "$out"
  zip -q -r -X "$zipname" "$name"
)
( cd "$out" && shasum -a 256 "$zipname" > "$zipname.sha256" )
print "Built $out/$zipname"
print "SHA256 $(cat "$out/$zipname.sha256")"
