#!/usr/bin/env bash
# Local only: game data goes directly to Cloudflare, never through GitHub.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec python3 scripts/hosted_asset_deployment.py "$@"
