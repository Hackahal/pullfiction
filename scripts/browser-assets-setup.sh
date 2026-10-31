#!/usr/bin/env bash
# Pinned developer/CI tools. No client files, services, credentials or deployment.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$(pwd)"
emsdk="$root/.agent/tools/emsdk"
emsdk_revision=d7b4130688bfa348392b921ab04015aa15c4f154
casc="$root/.agent/tools/casclib/source"
casc_revision=6b889ec8f421cbc9baccec296c582362ab917887
python_tools="$root/.agent/tools/casclib/python"

clone_pinned() {
  local url="$1" revision="$2" destination="$3"
  if [ ! -e "$destination" ]; then
    mkdir -p "$destination"
    git -C "$destination" init --quiet
    git -C "$destination" remote add origin "$url"
    git -C "$destination" fetch --depth 1 origin "$revision"
    git -C "$destination" checkout --quiet --detach FETCH_HEAD
  fi
  [ "$(git -C "$destination" rev-parse HEAD)" = "$revision" ] || {
    echo "Preserve the existing checkout and use the pinned revision in $destination" >&2
    exit 1
  }
  [ -z "$(git -C "$destination" status --porcelain)" ] || {
    echo "Refusing a modified tool checkout: $destination" >&2
    exit 1
  }
}

clone_pinned https://github.com/emscripten-core/emsdk.git "$emsdk_revision" "$emsdk"
clone_pinned https://github.com/ladislav-zezula/CascLib.git "$casc_revision" "$casc"
if ! [ -x "$python_tools/bin/cmake" ]; then
  python3 -m pip install --target "$python_tools" cmake==4.4.4
fi
PYTHONPATH="$python_tools" "$python_tools/bin/cmake" --version | head -1

# Do not activate a different version or alter global shell configuration.
if ! (source "$emsdk/emsdk_env.sh" >/dev/null 2>&1 && [ "$(emcc -dumpversion)" = 6.0.13 ]); then
  "$emsdk/emsdk" install 6.0.13
  "$emsdk/emsdk" activate 6.0.13
fi
npm ci --prefix tools/release --ignore-scripts --no-audit --no-fund
printf 'Browser archive build tools are ready. No deployment performed.\n'
