#!/usr/bin/env bash
set -euo pipefail

# Downloads the latest stable tusd binary for the current platform.
# Usage: bash scripts/download-tusd.sh [version]
# Example: bash scripts/download-tusd.sh v2.9.1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../bin"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "Fetching latest tusd release version..."
    VERSION=$(curl -sL https://api.github.com/repos/tus/tusd/releases/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
    echo "Latest version: $VERSION"
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
    darwin) EXT="zip" ;;
    linux)  EXT="tar.gz" ;;
    *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

FILENAME="tusd_${OS}_${ARCH}.${EXT}"
URL="https://github.com/tus/tusd/releases/download/${VERSION}/${FILENAME}"

mkdir -p "$BIN_DIR"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Downloading $URL ..."
curl -sL "$URL" -o "$TEMP_DIR/$FILENAME"

echo "Extracting..."
if [ "$EXT" = "zip" ]; then
    unzip -qo "$TEMP_DIR/$FILENAME" -d "$TEMP_DIR"
else
    tar -xzf "$TEMP_DIR/$FILENAME" -C "$TEMP_DIR"
fi

# Find the tusd binary in the extracted contents
TUSD_BIN=$(find "$TEMP_DIR" -name "tusd" -type f | head -1)
if [ -z "$TUSD_BIN" ]; then
    echo "Error: tusd binary not found in archive"
    exit 1
fi

cp "$TUSD_BIN" "$BIN_DIR/tusd"
chmod +x "$BIN_DIR/tusd"

echo "tusd ${VERSION} installed to $BIN_DIR/tusd"
"$BIN_DIR/tusd" -version 2>/dev/null || echo "(version check not supported)"
