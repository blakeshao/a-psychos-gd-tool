#!/usr/bin/env bash
# One-shot setup: checks the Node version, installs dependencies, and fetches
# a font into public/fonts/. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# Vite 7 needs Node 20.19+ or 22+.
node_version="$(node --version 2>/dev/null)" || {
  echo "error: node not found — install Node.js 20.19+ or 22+" >&2
  exit 1
}
major="${node_version#v}"; major="${major%%.*}"
minor="${node_version#v*.}"; minor="${minor%%.*}"
if [ "$major" -lt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -lt 19 ]; } || [ "$major" -eq 21 ]; then
  echo "error: Node $node_version is too old — Vite 7 needs Node 20.19+ or 22+" >&2
  exit 1
fi
echo "node $node_version ok"

npm install

./scripts/get-font.sh

echo
echo "setup complete — run 'npm run dev' and open the printed URL in a WebGPU browser (Chrome/Edge 113+ or Safari 18+)"
