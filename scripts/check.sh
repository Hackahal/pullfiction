#!/usr/bin/env bash
# Check the current Pull Fiction app without starting clients, services or deployments.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$PATH:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin"
case "${1:-}" in
  ""|--source-only) ;;
  *) echo "Usage: bash scripts/check.sh [--source-only]" >&2; exit 2 ;;
esac
python3 scripts/repository-audit.py --tree-only
python3 scripts/repository-audit-test.py
npm run check --prefix web/editor
npm test --prefix web/editor
node --test cloudflare/*.test.mjs web/planner/*.test.mjs scripts/static-viewer-loader.test.mjs scripts/wowhead-page-fetch.test.mjs web/archive/policy.test.mjs
for test in scripts/*-test.py scripts/test_ui_quality_loop.py; do
  python3 "$test"
done
if [ "${1:-}" != --source-only ]; then
  cargo fmt --all -- --check
  cargo check --locked --target wasm32-unknown-unknown -p pullfiction-viewer --no-default-features --features browser-static
fi
