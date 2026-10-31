#!/usr/bin/env bash
# Prepare application code and approved numeric metadata for Static Assets. Never deploys.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH"
root="$(pwd)"
output="${1:-$root/.agent/work/browser-static/release}"
bindgen="${WASM_BINDGEN:-$(command -v wasm-bindgen || true)}"
[ -n "$bindgen" ] || bindgen="$root/.agent/work/bin/wasm-bindgen"
[ "$("$bindgen" --version)" = 'wasm-bindgen 0.2.122' ] || { echo 'wasm-bindgen 0.2.122 is required.' >&2; exit 1; }
if [ -e "$output" ] || [ -L "$output" ]; then
  echo "Output already exists; choose a new empty output path: $output" >&2
  exit 1
fi
mkdir -p "$root/.agent/work/browser-static"
stage="$(mktemp -d "$root/.agent/work/browser-static/staging.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# Every input directory starts empty. In particular, never copy web/dist.
cargo build --locked --release --target wasm32-unknown-unknown -p pullfiction-viewer --no-default-features --features browser-static
"$bindgen" --target web --no-typescript --remove-name-section --remove-producers-section \
  --out-dir "$stage/renderer" target/wasm32-unknown-unknown/release/pullfiction_viewer.wasm
if [ ! -d web/editor/node_modules ]; then npm ci --prefix web/editor; fi
VITE_BROWSER_ASSETS=1 npm run build --prefix web/editor -- --outDir "$stage/editor" --emptyOutDir --manifest
bash scripts/browser-assets-build.sh "$stage/archive"
WASM_BINDGEN="$bindgen" bash scripts/browser-codec-build.sh "$stage/archive"
python3 scripts/static-package.py pack --editor "$stage/editor" --renderer "$stage/renderer" \
  --archive "$stage/archive" --output "$stage/release" --report "$stage/report.json"
node scripts/static-viewer-smoke.mjs "$stage/release"
mkdir -p "$(dirname "$output")"
mv "$stage/release" "$output"
cp "$stage/report.json" "$output.audit.json"
printf 'Static release: %s\nAudit report: %s\n' "$output" "$output.audit.json"
