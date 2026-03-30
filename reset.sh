#!/usr/bin/env bash
# reset.sh — restore repo state from .data/ secrets
# The .data/ directory is gitignored and holds credentials + env config.
# This script creates symlinks so the repo uses them without copying.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.data"

if [ ! -d "$DATA_DIR" ]; then
  echo "Error: .data/ directory not found. Set up credentials first."
  exit 1
fi

# Symlink .env.local from .data/
if [ -f "$DATA_DIR/.env.local" ]; then
  ln -sf .data/.env.local "$SCRIPT_DIR/.env.local"
  echo "Linked .env.local -> .data/.env.local"
else
  echo "Warning: .data/.env.local not found. Copy .env.example to .data/.env.local and fill in values."
fi

# Ensure reports/ directory exists (gitignored, used for output)
mkdir -p "$SCRIPT_DIR/reports"
echo "Created reports/ directory"

echo "Done. Run 'pnpm calendar:scrape' to fetch calendar data."
