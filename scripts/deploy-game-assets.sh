#!/usr/bin/env bash
# Local only: game data goes directly to Cloudflare, never through GitHub.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "$#" != 1 ]; then
  echo 'Usage: bash scripts/deploy-game-assets.sh PREPARED_DIRECTORY' >&2
  exit 2
fi
if [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${CI:-}" ]; then
  echo 'Game assets must be prepared and deployed locally, outside CI.' >&2
  exit 1
fi
release="$1"
python3 - "$release" <<'PY'
from pathlib import Path
import subprocess,sys
root=Path.cwd().resolve()
release=Path(sys.argv[1]).resolve()
if not release.is_relative_to(root/'.agent'):
    raise SystemExit('Game assets must remain beneath the ignored .agent directory.')
if subprocess.run(['git','check-ignore','-q',str(release)]).returncode:
    raise SystemExit('Game asset output is not ignored by Git.')
if subprocess.check_output(['git','ls-files','--',str(release)]):
    raise SystemExit('Refusing to deploy game assets tracked by Git.')
PY
python3 scripts/prepare-hosted-assets.py audit "$release"
# Retain immutable chunks so already-open sessions survive a manifest update.
retained=".agent/work/hosted-assets/deployed"
mkdir -p .agent/work/hosted-assets
stage="$(mktemp -d .agent/work/hosted-assets/upload.XXXXXX)"
mkdir "$stage/chunks"
if [ -d "$retained" ]; then
  python3 scripts/prepare-hosted-assets.py audit "$retained"
  cp "$retained"/chunks/*.bin.gz "$stage/chunks/"
fi
cp "$release"/chunks/*.bin.gz "$stage/chunks/"
cp "$release/manifest.json" "$stage/manifest.json"
cp cloudflare/game-asset-headers "$stage/_headers"
python3 scripts/prepare-hosted-assets.py audit "$stage"
export WRANGLER_SEND_METRICS=false
tools/release/node_modules/.bin/wrangler deploy --config wrangler.game-assets.jsonc --assets "$stage"
# Record only a successful upload as the next retention source. Keep upload
# directories for local recovery; they never enter application release outputs.
mkdir -p "$retained/chunks"
cp "$stage"/chunks/*.bin.gz "$retained/chunks/"
cp "$stage/manifest.json" "$retained/manifest.json"
cp "$stage/_headers" "$retained/_headers"
printf 'Uploaded asset generation retained in %s\n' "$retained"
