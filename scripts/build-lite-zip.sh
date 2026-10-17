#!/bin/sh
# Build a local zip of this tree. Does not tag, push, or open a GitHub release.
# release.yml publishes only on a push to main or a v* tag. Do not do either.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
VERSION=$(python3 -c "import json; print(json.load(open('$ROOT/manifest.json'))['version'])")
case "$VERSION" in
  4.0.0) ;;
  *)
    echo "refusing to zip: manifest version $VERSION is not 4.0.0" >&2
    exit 1
    ;;
esac
STAGE="$ROOT/_build/medicus-suite-v$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.gitignore' \
  --exclude='README.md' \
  --exclude='LICENSE' \
  --exclude='_build/' \
  --exclude='test-*.js' \
  --exclude='scripts/' \
  --exclude='.claude/' \
  --exclude='*.zip' \
  --exclude='.DS_Store' \
  --exclude='package.json' \
  --exclude='package-lock.json' \
  --exclude='node_modules/' \
  --exclude='eslint.config.mjs' \
  --exclude='.prettierrc.json' \
  --exclude='.prettierignore' \
  --exclude='.githooks/' \
  --exclude='brand/generate-icons.mjs' \
  "$ROOT/" "$STAGE/"
OUT="$ROOT/medicus-suite-v$VERSION.zip"
rm -f "$OUT"
( cd "$ROOT/_build" && zip -qr "$OUT" "medicus-suite-v$VERSION" )
echo "$OUT"
