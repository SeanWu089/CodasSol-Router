#!/bin/sh
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/dist"
name="CodasSol-File-Sentinel-v0.1.0"
mkdir -p "$out/$name/windows"
cp "$root/components/file-sentinel/windows/"*.ps1 "$out/$name/windows/"
cp "$root/components/file-sentinel/README.md" "$out/$name/"
rm -f "$out/$name.zip"
(cd "$out" && zip -q -r -X "$name.zip" "$name" && shasum -a 256 "$name.zip" > "$name.zip.sha256")
echo "Built $out/$name.zip"
