#!/usr/bin/env python3
"""Build a renderer-compatible local asset overlay; report unsupported models explicitly."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
from classic_compat import CompatError, adapt_model

spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def build_overlay(cache):
    manifest = assets.verify_cache(cache)
    output = cache / 'renderer'
    files, unsupported = {}, {}

    def add(name, data):
        sha = assets.digest(data)
        obj = f'objects/{sha[:2]}/{sha}'
        assets.atomic_write(output / obj, data)
        files[name.replace('\\', '/').lower()] = {'object': obj, 'sha256': sha, 'bytes': len(data)}

    for name, entry in manifest['files'].items():
        if entry['info']['format'] == 'BLP2':
            if name.startswith('id:'):
                add(f'__classic/{name[3:]}.blp', (cache / entry['object']).read_bytes())
            else:
                add(name, (cache / entry['object']).read_bytes())
        if entry['info']['format'] != 'MD21':
            continue
        skins = [cache / manifest['files'][d]['object'] for d in entry['dependencies'] if manifest['files'][d]['info']['format'] == 'SKIN']
        try:
            adapted = adapt_model((cache / entry['object']).read_bytes(), [p.read_bytes() for p in skins])
        except CompatError as error:
            unsupported[name] = str(error)
            continue
        add(f'__classic/{name[3:]}.m2' if name.startswith('id:') else name, adapted)
    prepared = {'schema': 1, 'source': manifest['source'], 'files': files, 'unsupported': unsupported,
                'complete': False, 'purpose': 'Renderer compatibility validation. Full source switchover requires world, effects, catalogs, and UI acceptance.'}
    assets.atomic_write(output / 'manifest.json', (json.dumps(prepared, indent=2) + '\n').encode())
    return output, prepared


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cache', type=Path)
    args = parser.parse_args()
    try:
        output, manifest = build_overlay(args.cache.resolve())
        print(f'Overlay: {output}')
        print(f"{len(manifest['files'])} assets adapted; {len(manifest['unsupported'])} models require further format support.")
        for name, reason in manifest['unsupported'].items():
            print(f'{name}: {reason}')
    except (assets.AssetError, OSError, ValueError) as error:
        print(f'Classic adapter: {error}', file=sys.stderr)
        sys.exit(1)
