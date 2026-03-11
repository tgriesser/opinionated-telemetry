#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GHOST_DIR="$SCRIPT_DIR/ghost-app"
ROOT_DIR="$SCRIPT_DIR/../.."

echo "=== Ghost + opinionated-telemetry ==="
echo ""

cd $ROOT_DIR && npm install && npm run build

# Clean previous install if requested
if [[ "${1:-}" == "--clean" ]]; then
  echo "Cleaning previous installation..."
  rm -rf "$GHOST_DIR"
fi

if [[ ! -d "$GHOST_DIR" ]]; then
  # Install Ghost CLI if not available
  if ! command -v ghost &>/dev/null; then
    echo "Installing Ghost CLI..."
    npm install -g ghost-cli
  fi

  # Install Ghost locally (uses SQLite by default)
  echo ""
  echo "Installing Ghost..."
  mkdir -p "$GHOST_DIR"
  cd "$GHOST_DIR"
  ghost install local --no-start
fi

cd $SCRIPT_DIR
npm install

cd $GHOST_DIR
node --watch --env-file=../.env --experimental-strip-types --import ../telemetry.mts current/index.js
