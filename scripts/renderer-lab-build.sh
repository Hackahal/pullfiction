#!/usr/bin/env bash
# Build a local diagnostic runtime. Production packaging deliberately rejects it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH"
root="$(pwd)"
output="${1:-$root/.agent/work/renderer-lab/runtime}"
bindgen="${WASM_BINDGEN:-$(command -v wasm-bindgen || true)}"
[ -n "$bindgen" ] || bindgen="$root/.agent/work/bin/wasm-bindgen"
[ "$("$bindgen" --version)" = 'wasm-bindgen 0.2.122' ] || { echo 'wasm-bindgen 0.2.122 is required.' >&2; exit 1; }
if [ -e "$output" ] || [ -L "$output" ]; then
  echo "Output already exists; choose a new path: $output" >&2
  exit 1
fi
mkdir -p "$root/.agent/work/renderer-lab"
stage="$(mktemp -d "$root/.agent/work/renderer-lab/staging.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
cargo build --locked --release --target wasm32-unknown-unknown -p pullfiction-viewer \
  --no-default-features --features browser-static,renderer-lab
"$bindgen" --target web --no-typescript --remove-name-section --remove-producers-section \
  --out-dir "$stage/renderer" target/wasm32-unknown-unknown/release/pullfiction_viewer.wasm
bash scripts/browser-assets-build.sh "$stage/runtime/archive"
WASM_BINDGEN="$bindgen" bash scripts/browser-codec-build.sh "$stage/runtime/archive"
python3 - "$stage" <<'PY'
import gzip, importlib.util, json, sys
from pathlib import Path
root = Path.cwd()
stage = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('package', root / 'scripts/static-package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
renderer, output = stage / 'renderer', stage / 'runtime'
wasm = package.regular_file(renderer, 'pullfiction_viewer_bg.wasm').read_bytes()
if b'renderer_lab_configure' not in wasm:
    raise SystemExit('Diagnostic renderer exports are missing')
package.copy_file(renderer, 'pullfiction_viewer.js', output, 'pullfiction_viewer.bindgen.js')
for name in package.renderer_snippets(renderer, 'pullfiction_viewer.js'):
    package.copy_file(renderer, name, output)
(output / 'pullfiction_viewer_bg.wasm.gz').write_bytes(gzip.compress(wasm, compresslevel=9, mtime=0))
package.copy_file(root, 'scripts/static-viewer-loader.mjs', output, 'pullfiction_viewer.js')
for target, source in package.METADATA_FILES.items():
    package.copy_file(root, source, output, target)
(output / 'renderer-lab-runtime.json').write_text(json.dumps({'schema': 1, 'developmentOnly': True}))
PY
node scripts/static-viewer-smoke.mjs "$stage/runtime"
mkdir -p "$(dirname "$output")"
mv "$stage/runtime" "$output"
printf 'Diagnostic runtime (do not deploy): %s\n' "$output"
