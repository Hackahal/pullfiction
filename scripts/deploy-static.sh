#!/usr/bin/env bash
# Deploy only an audited, freshly prepared static package.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "$#" != 1 ]; then
  echo 'Usage: bash scripts/deploy-static.sh RELEASE_DIRECTORY' >&2
  exit 2
fi
release="$1"
python3 scripts/static-package.py audit "$release"
node scripts/static-viewer-smoke.mjs "$release"
export WRANGLER_SEND_METRICS=false
config="$(node scripts/sharing-config.mjs)"
exec tools/release/node_modules/.bin/wrangler deploy --config "$config" --assets "$release"
