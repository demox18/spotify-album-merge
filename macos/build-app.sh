#!/bin/bash
# Costruisce Scaffale.app: sito statico con base /, wrapper Swift, icona, firma ad hoc.
# Uso: bash macos/build-app.sh [--install]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INSTALL=0
case "${1:-}" in
  "") ;;
  --install) INSTALL=1 ;;
  *)
    echo "Uso: bash macos/build-app.sh [--install]" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Serve Node.js 20 o più recente (node e npm nel PATH)." >&2
  exit 1
fi

for tool in sips iconutil codesign lipo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Manca «$tool». Installa gli strumenti da riga di comando di Xcode." >&2
    exit 1
  fi
done

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Manca swiftc. Installa gli strumenti da riga di comando di Xcode." >&2
  exit 1
fi

export SCAFFALE_BASE=/
npm ci
npm run build

node "$ROOT/macos/make-icon.mjs"
ICON_SRC="$ROOT/macos/.build/icon-1024.png"
ICONSET="$ROOT/macos/.build/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

render_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/$name" >/dev/null
}

render_icon 16 icon_16x16.png
render_icon 32 icon_16x16@2x.png
render_icon 32 icon_32x32.png
render_icon 64 icon_32x32@2x.png
render_icon 128 icon_128x128.png
render_icon 256 icon_128x128@2x.png
render_icon 256 icon_256x256.png
render_icon 512 icon_256x256@2x.png
render_icon 512 icon_512x512.png
render_icon 1024 icon_512x512@2x.png
iconutil -c icns "$ICONSET" -o "$ROOT/macos/.build/AppIcon.icns"

APP="$ROOT/macos/Scaffale.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/macos/.build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp -R "$ROOT/dist" "$APP/Contents/Resources/dist"

# Il test di «if» non fa uscire lo script con set -e (anche con bash 3.2 di macOS).
BUILT=()
for arch in arm64 x86_64; do
  out="$ROOT/macos/.build/Scaffale-$arch"
  if xcrun --sdk macosx swiftc \
    -target "${arch}-apple-macos13.0" \
    -O \
    -parse-as-library \
    -framework AppKit \
    -framework WebKit \
    -o "$out" \
    "$ROOT/macos/Sources/main.swift"
  then
    BUILT+=("$out")
  else
    echo "Compilazione $arch non riuscita: tengo le architetture che compilano." >&2
  fi
done

if [[ ${#BUILT[@]} -eq 0 ]]; then
  rm -rf "$APP"
  echo "swiftc non ha prodotto un binario." >&2
  exit 1
elif [[ ${#BUILT[@]} -eq 1 ]]; then
  cp "${BUILT[0]}" "$APP/Contents/MacOS/Scaffale"
else
  lipo -create -output "$APP/Contents/MacOS/Scaffale" "${BUILT[@]}"
fi
chmod +x "$APP/Contents/MacOS/Scaffale"

codesign --force --sign - "$APP"
codesign --verify --verbose=2 "$APP"

echo "Fatto: $APP"
echo "Apri con: open \"$APP\""

if [[ "$INSTALL" -eq 1 ]]; then
  if ! command -v ditto >/dev/null 2>&1; then
    echo "Manca ditto." >&2
    exit 1
  fi
  DEST="/Applications/Scaffale.app"
  copied=0
  if { [[ ! -e "$DEST" ]] || rm -rf "$DEST"; } && ditto "$APP" "$DEST"; then
    copied=1
  fi
  if [[ "$copied" -ne 1 ]]; then
    echo "Serve il permesso di scrivere in /Applications. Riprovo con sudo, solo per la copia." >&2
    sudo rm -rf "$DEST"
    sudo ditto "$APP" "$DEST"
  fi
  echo "Scaffale è in $DEST"
fi
