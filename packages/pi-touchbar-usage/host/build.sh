#!/bin/sh
# Builds UsageBar.app into ~/Applications. Command Line Tools are enough;
# no Xcode, no project file.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
APP="$HOME/Applications/UsageBar.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/src"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>UsageBar</string>
  <key>CFBundleDisplayName</key><string>UsageBar</string>
  <key>CFBundleIdentifier</key><string>dev.handlerone.usagebar</string>
  <key>CFBundleExecutable</key><string>UsageBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- Touch Bar only: no Dock tile, no menu bar. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

swiftc -O -target arm64-apple-macos11 \
  -framework AppKit \
  -o "$APP/Contents/MacOS/UsageBar" \
  "$DIR/main.swift"

cp "$DIR/../bin/pi-usagebar" "$APP/Contents/Resources/bin/pi-usagebar"
cp "$DIR/../src/usage.mjs" "$APP/Contents/Resources/src/usage.mjs"
chmod +x "$APP/Contents/Resources/bin/pi-usagebar"

codesign --force --sign - "$APP" 2>/dev/null || true
echo "built $APP"
