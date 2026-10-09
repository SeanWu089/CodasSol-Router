#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/Applications/CodasSol-mac.app}"
mkdir -p "$DEST/Contents/MacOS"
mkdir -p "$DEST/Contents/Resources"
swiftc "$ROOT/main.swift" -O -o "$DEST/Contents/MacOS/CodasSolMac"
cp "$ROOT/SeanTemplate.png" "$DEST/Contents/Resources/SeanTemplate.png"
SOURCE_ICON="${CODASSOL_SEAN_ICON:-$HOME/Desktop/Desktop-Air/seanworkspace/media/images/sean.PNG}"
if [[ -f "$SOURCE_ICON" ]]; then
  ICONSET="$(mktemp -d)/CodasSol.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -s format png -z "$s" "$s" "$SOURCE_ICON" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  done
  cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_16x16@2x.png"
  cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
  sips -s format png -z 1024 1024 "$SOURCE_ICON" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "$ICONSET" -o "$DEST/Contents/Resources/CodasSol.icns"
fi
cat > "$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.codassol.mac</string>
<key>CFBundleName</key><string>CodasSol-mac</string>
<key>CFBundleDisplayName</key><string>CodasSol-mac</string>
<key>CFBundleIconFile</key><string>CodasSol</string>
<key>CFBundleExecutable</key><string>CodasSolMac</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
echo "Built $DEST"
