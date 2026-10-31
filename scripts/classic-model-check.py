#!/usr/bin/env python3
"""Validate prepared modern geometry/animation with native readers, without a browser."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cache', type=Path)
    args = parser.parse_args()
    cache = args.cache.resolve()
    manifest = assets.verify_cache(cache)
    cargo = shutil.which('cargo')
    if not cargo:
        fallback = Path('/opt/homebrew/opt/rustup/bin/cargo')
        cargo = str(fallback) if fallback.is_file() else None
    if not cargo:
        raise assets.AssetError('Cargo is required for the native reader checks.')
    environment = dict(os.environ)
    environment['PATH'] = str(Path(cargo).parent) + os.pathsep + environment.get('PATH', '')

    def run(package, example, paths):
        result = subprocess.run([cargo, 'run', '--quiet', '-p', package, '--example', example, '--', *map(str, paths)],
                                cwd=ROOT, env=environment, text=True, capture_output=True)
        if result.returncode:
            raise assets.AssetError(result.stderr.strip())
        return result.stdout.strip()

    count = 0
    for name, entry in manifest['files'].items():
        if entry['info']['format'] != 'MD21':
            continue
        skin = next((n for n in entry['dependencies'] if manifest['files'][n]['info']['format'] == 'SKIN'), None)
        if skin is None:
            raise assets.AssetError(f'Missing skin for model {name}')
        summary = run('benilla-m2', 'classic-inspect', [cache / entry['object'], cache / manifest['files'][skin]['object']])
        print(f'{name}: {summary}')
        count += 1
    groups = [cache / e['object'] for e in manifest['files'].values() if e['info']['format'] == 'WMO-group']
    if groups:
        print(run('benilla-wmo', 'classic-world-inspect', groups))
    print(f'{count} model entries decoded. This checks geometry and bone data, not rendered appearance.')


if __name__ == '__main__':
    try:
        main()
    except (assets.AssetError, OSError) as error:
        print(f'Classic model check: {error}', file=sys.stderr)
        sys.exit(1)
