#!/usr/bin/env sh
set -eu

ROOT_DIR="$(pwd)"
FRONTEND_REPO="${LATEXDO_FRONTEND_REPO:-../latexdo}"
OUT_DIR="$ROOT_DIR/dist"

if [ ! -f "$FRONTEND_REPO/package.json" ]; then
  echo "LatexDo frontend repo not found at $FRONTEND_REPO" >&2
  echo "Set LATEXDO_FRONTEND_REPO=/path/to/latexdo and retry." >&2
  exit 1
fi

npm --prefix "$FRONTEND_REPO" ci
cd "$FRONTEND_REPO"
VITE_LATEXDO_RUNTIME=cloud npx vite build --outDir "$OUT_DIR" --emptyOutDir
