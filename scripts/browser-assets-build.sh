#!/usr/bin/env bash
# Developer build only. Users load the resulting archive reader in their browser.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
sdk="${PULLFICTION_EMSDK:-$(pwd)/.agent/tools/emsdk}"
source_dir="$(pwd)/.agent/tools/casclib/source"
build_dir="$(pwd)/.agent/work/browser-assets/cmake"
output="${1:-$(pwd)/.agent/work/browser-assets/dist}"
revision=6b889ec8f421cbc9baccec296c582362ab917887
export PATH="$(pwd)/.agent/tools/casclib/python/bin:$PATH"
export PYTHONPATH="$(pwd)/.agent/tools/casclib/python${PYTHONPATH:+:$PYTHONPATH}"
[ -f "$sdk/emsdk_env.sh" ] || { echo 'Set PULLFICTION_EMSDK to Emscripten SDK 6.0.13.' >&2; exit 1; }
# shellcheck disable=SC1091
source "$sdk/emsdk_env.sh" >/dev/null 2>&1
[ "$(emcc -dumpversion)" = 6.0.13 ] || { echo 'This build requires Emscripten 6.0.13.' >&2; exit 1; }
[ "$(git -C "$source_dir" rev-parse HEAD)" = "$revision" ] || { echo 'Unexpected CascLib source revision.' >&2; exit 1; }
[ -z "$(git -C "$source_dir" status --porcelain)" ] || { echo 'CascLib source has local edits.' >&2; exit 1; }
mkdir -p "$build_dir" "$output"
emcmake cmake -S "$source_dir" -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCASC_BUILD_SHARED_LIB=OFF -DCASC_BUILD_STATIC_LIB=ON -DCASC_BUILD_TESTS=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=TRUE
cmake --build "$build_dir" --parallel 6
em++ web/archive/casc.cpp "$build_dir/libcasc.a" -I "$source_dir/src" \
  -O3 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker,node \
  -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1073741824 \
  -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,ccall,HEAPU8 \
  -lworkerfs.js -lnodefs.js -o "$output/casc.mjs"
cp "$source_dir/LICENSE" "$output/CascLib-LICENSE.txt"
cp web/archive/{policy,worker,client,cache,converter,hosted-appearance}.mjs "$output/"
python3 scripts/browser-converter-build.py "$output"
