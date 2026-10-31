#!/usr/bin/env bash
# Build the offline archive reader outside Git. Never writes to the game install.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/opt/homebrew/bin:$PATH"
tools="$(pwd)/.agent/tools/casclib"
revision=6b889ec8f421cbc9baccec296c582362ab917887
mkdir -p "$tools"
if ! command -v cmake >/dev/null; then
  if [ ! -x "$tools/python/bin/cmake" ]; then
    python3 -m pip install --target "$tools/python" cmake==4.4.4
  fi
  export PYTHONPATH="$tools/python${PYTHONPATH:+:$PYTHONPATH}"
  export PATH="$tools/python/bin:$PATH"
fi
if [ ! -d "$tools/source/.git" ]; then
  git clone https://github.com/ladislav-zezula/CascLib.git "$tools/source"
  git -C "$tools/source" checkout --detach "$revision"
fi
[ "$(git -C "$tools/source" rev-parse HEAD)" = "$revision" ] || {
  echo 'The local CascLib checkout differs from the pinned revision; preserve it and use a fresh tools directory.' >&2
  exit 1
}
[ -z "$(git -C "$tools/source" status --porcelain)" ] || {
  echo 'Local CascLib has edits. Refusing to build an unverified reader.' >&2
  exit 1
}
cmake -S "$tools/source" -B "$tools/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build "$tools/build" --parallel 8
printf 'Offline CASC reader built from %s\n' "$revision"
