#!/usr/bin/env bash
# Run only in a macOS environment with the Xcode iPhoneOS SDK (such as GitHub Actions).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]] || ! command -v xcodebuild >/dev/null 2>&1; then
  echo 'ERROR: run this build in GitHub Actions macOS, or on a Mac with full Xcode.' >&2
  exit 1
fi
xcodebuild -project CodasSolController.xcodeproj \
  -scheme CodasSolController \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$PWD/.build/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build
app="$PWD/.build/DerivedData/Build/Products/Release-iphoneos/CodasSolController.app"
test -s "$app/Info.plist"
if [[ -d "$app/_CodeSignature" ]]; then
  echo 'ERROR: expected unsigned app' >&2
  exit 1
fi
mkdir -p "$PWD/dist"
ipa="$PWD/dist/CodasSol-iPad-Controller-unsigned.ipa"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/Payload"
ditto "$app" "$tmp/Payload/CodasSolController.app"
(cd "$tmp" && zip -qry -y "$tmp/controller.ipa" Payload)
mv "$tmp/controller.ipa" "$ipa"
test -s "$ipa"
echo 'Unsigned IPA ready; Sideloadly/AltStore signing is still required.'
