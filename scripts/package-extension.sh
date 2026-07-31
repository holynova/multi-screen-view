#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
OUTPUT_DIR="$PROJECT_ROOT/dist"
OUTPUT_FILE="$OUTPUT_DIR/viewport-relay-$PACKAGE_VERSION.zip"
PACKAGE_DIR="$(mktemp -d /tmp/viewport-relay-package.XXXXXX)"

cleanup() {
  rm -rf "$PACKAGE_DIR"
}
trap cleanup EXIT

node "$PROJECT_ROOT/scripts/validate-store-assets.mjs"
mkdir -p "$OUTPUT_DIR" "$PACKAGE_DIR/icons"

PACKAGE_FILES=(
  LICENSE
  background.js
  content.js
  devices.js
  index.html
  launcher.js
  layout.js
  legal.css
  manifest.json
  privacy.html
  styles.css
  targeting.js
)

for PACKAGE_FILE in "${PACKAGE_FILES[@]}"; do
  cp "$PROJECT_ROOT/$PACKAGE_FILE" "$PACKAGE_DIR/$PACKAGE_FILE"
done

cp "$PROJECT_ROOT"/icons/icon*.png "$PACKAGE_DIR/icons/"
rm -f "$OUTPUT_FILE"
(
  cd "$PACKAGE_DIR"
  zip -q -r "$OUTPUT_FILE" .
)

for PACKAGE_FILE in "${PACKAGE_FILES[@]}"; do
  unzip -p "$OUTPUT_FILE" "$PACKAGE_FILE" | cmp -s "$PROJECT_ROOT/$PACKAGE_FILE" - || {
    echo "Archive mismatch: $PACKAGE_FILE" >&2
    exit 1
  }
done

for ICON_SIZE in 16 32 48 128; do
  ICON_PATH="icons/icon$ICON_SIZE.png"
  unzip -p "$OUTPUT_FILE" "$ICON_PATH" | cmp -s "$PROJECT_ROOT/$ICON_PATH" - || {
    echo "Archive mismatch: $ICON_PATH" >&2
    exit 1
  }
done

EXPECTED_FILE_COUNT=$((${#PACKAGE_FILES[@]} + 4))
ACTUAL_FILE_COUNT="$(unzip -Z1 "$OUTPUT_FILE" | awk '!/\/$/' | wc -l | tr -d ' ')"
if [[ "$ACTUAL_FILE_COUNT" != "$EXPECTED_FILE_COUNT" ]]; then
  echo "Archive contains unexpected files: expected $EXPECTED_FILE_COUNT, found $ACTUAL_FILE_COUNT" >&2
  exit 1
fi

unzip -tq "$OUTPUT_FILE" >/dev/null

echo "$OUTPUT_FILE"
