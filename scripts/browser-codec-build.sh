#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH"
output="${1:-$(pwd)/.agent/work/browser-assets/dist}"
bindgen="${WASM_BINDGEN:-$(command -v wasm-bindgen || true)}"
[ -n "$bindgen" ] || bindgen="$(pwd)/.agent/work/bin/wasm-bindgen"
[ "$("$bindgen" --version)" = 'wasm-bindgen 0.2.122' ] || { echo 'wasm-bindgen 0.2.122 is required.' >&2; exit 1; }
cargo build --release --target wasm32-unknown-unknown -p pullfiction-asset-codec
mkdir -p "$output"
"$bindgen" --target web --no-typescript --remove-name-section --remove-producers-section \
  --out-dir "$output" target/wasm32-unknown-unknown/release/pullfiction_asset_codec.wasm
