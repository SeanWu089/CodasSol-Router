#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/Applications/CodasSol-mac.app}"
mkdir -p "$DEST/Contents/MacOS"
mkdir -p "$DEST/Contents/Resources"
swiftc "$ROOT/main.swift" "$ROOT/DevSpaceManager.swift" -O -o "$DEST/Contents/MacOS/CodasSolMac"
cp "$ROOT/SeanTemplate.png" "$DEST/Contents/Resources/SeanTemplate.png"
cp "$ROOT/devspace-runner.zsh" "$DEST/Contents/Resources/devspace-runner.zsh"
cp "$ROOT/migrate-devspace.py" "$DEST/Contents/Resources/migrate-devspace.py"
# Icons are bundled source assets: moving sean.PNG or the application itself
# must not break fresh builds or the background launcher.
cp "$ROOT/CodasSol.icns" "$DEST/Contents/Resources/CodasSol.icns"
cat > "$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.codassol.mac</string>
<key>CFBundleName</key><string>CodasSol-mac</string>
<key>CFBundleDisplayName</key><string>CodasSol-mac</string>
<key>CFBundleShortVersionString</key><string>0.2.1</string>
<key>CFBundleVersion</key><string>3</string>
<key>CFBundleIconFile</key><string>CodasSol</string>
<key>CFBundleExecutable</key><string>CodasSolMac</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
echo "Built $DEST"
