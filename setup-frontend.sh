#!/usr/bin/env bash
# One-shot helper: install deps, link the latest snapshots.json, start dev.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f ../snapshots.json ]; then
  echo "No ../snapshots.json found. Generate one first, e.g."
  echo "  cd ..; source .venv/bin/activate; python -m rnasim --seq ... --out snapshots.json"
  exit 1
fi

mkdir -p public
# symlink instead of copy so re-running the engine refreshes the UI on reload
ln -sf ../../snapshots.json public/snapshots.json

if [ ! -d node_modules ]; then
  npm install
fi

echo "Starting dev server on http://localhost:5173 ..."
npm run dev
