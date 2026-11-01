#!/usr/bin/env python3
"""Trim conversion inputs, unused WMO tables, and audited raid exterior scenery from a prepared pack."""
import argparse
from functools import lru_cache
import gzip
import importlib.util
import json
import os
from pathlib import Path

from hosted_assets import audit, digest, json_bytes
from hosted_asset_optimization import STANDALONE_RAIDS, prepare_standalone, repack_hosted_assets
from classic_world import World, chunks, parts
from classic_table_strings import named_table

ROOT = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def optimize(source, destination, storage):
    audit(source)
    manifest = json.loads((source/'manifest.json').read_bytes())
    @lru_cache(maxsize=4)
    def chunk(sha):
        data = (source/'chunks'/(sha+'.bin.gz')).read_bytes()
        if digest(data) != sha:
            raise ValueError('Source changed after audit')
        return gzip.decompress(data)
    def payload(key):
        entry = manifest['files'][key]
        data = b''.join(chunk(p['chunk'])[p['offset']:p['offset']+p['length']] for p in entry['parts'])
        if digest(data) != entry['sha256']:
            raise ValueError('Source resource changed after audit')
        return data
    assets = module('optimize_classic_assets', 'classic-assets.py')
    def raw(name):
        name = assets.resource(name)
        data = storage.read(name)
        entry = manifest['files'].get('read:'+name)
        if entry is not None and digest(data) != entry['sha256']:
            raise ValueError('Installed source differs from the prepared baseline: '+name)
        return data
    world = World(raw)
    map_rows, _ = named_table(raw('dbfilesclient/map.db2'), 'Map')
    if any('WdtFileDataID' in row for row in map_rows.values()):
        world.set_maps(map_rows.values())
    standalone, replacements, excluded = {}, {}, set()
    for map_id, config in STANDALONE_RAIDS.items():
        directory = config['directory']
        if not any(raid['map'] == map_id for raid in manifest.get('maps', [])):
            continue
        selected = prepare_standalone(world, raw, map_id, directory)
        standalone[map_id] = selected
        replacements[f'world:world/maps/{directory}/{directory}.wdt'] = selected['wdt']
        replacements['map:'+str(map_id)] = json_bytes(selected['map'])
        excluded.update(key for key in manifest['files']
                        if key.startswith(f'world:world/maps/{directory}/') and key.endswith('.adt'))
    # Retain only WMOs referenced by surviving map WDT/ADT resources. Shared
    # buildings used in other raids stay available even if Naxx no longer uses them.
    roots = set()
    for key in manifest['files']:
        if not key.startswith('world:') or key in excluded or not key.endswith(('.wdt','.adt')):
            continue
        data = replacements[key] if key in replacements else payload(key)
        value = {tag:body for tag,body in chunks(data) if tag != 'MCNK'}
        roots.update(name.decode().replace('\\','/').lower() for name in value.get('MWMO',b'').split(b'\0') if name)
    # Some spells use a WMO directly rather than a map placement. Preserve
    # those roots and their groups as runtime effect dependencies too.
    spells = json.loads(payload('catalog:spells'))
    roots.update('__classic/'+str(effect['fileDataID'])+'.wmo'
                 for effect in spells.get('effects',{}).values()
                 if effect.get('assetFormat') == 'wmo' and effect.get('fileDataID'))
    for key in manifest['files']:
        if not key.startswith('world:') or not key.endswith('.wmo'):
            continue
        name = key[6:]
        stem = name.rsplit('/',1)[-1]
        if len(stem) > 8 and stem[-8] == '_' and stem[-7:-4].isdigit():
            name = name[:-8]+'.wmo'
        if name not in roots:
            excluded.add(key)
    for map_id in standalone:
        if 'world:__classic/'+str(STANDALONE_RAIDS[map_id]['root'])+'.wmo' in excluded:
            raise ValueError('Standalone raid root was incorrectly excluded')
    result = repack_hosted_assets(source,destination,replacements,excluded)
    def stats(value):
        return {'areas':len(value['areas']), 'floors':len(value['floors']), 'tiles':len(value['tiles']),
                'triangles':sum(len(f['indices'])//3 for f in value['floors'])}
    result['raids'] = []
    for raid in manifest.get('maps', []):
        map_id = raid['map']
        before = json.loads(payload('map:'+str(map_id)))
        selected = standalone.get(map_id)
        report = {**raid, 'action':'standalone' if selected else 'preserved',
                  'before':stats(before), 'after':stats(selected['map'] if selected else before)}
        if selected:
            report.update({key:selected[key] for key in ('sourceUID','sourcePosition','position','worldResources')})
        result['raids'].append(report)
    # Keep the original report field for existing local inspection tools.
    result['naxx'] = next((r for r in result['raids'] if r['map'] == 533), None)

    (Path(str(destination)+'.optimization.json')).write_bytes(json_bytes(result))
    return result


def main():
    if os.environ.get('GITHUB_ACTIONS') or os.environ.get('CI'):
        raise SystemExit('Game asset optimization must run locally, outside CI')
    producer = module('hosted_producer_paths','prepare-hosted-assets.py')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True,type=producer.output_path)
    parser.add_argument('--output',required=True,type=producer.output_path)
    parser.add_argument('--install',required=True,type=Path)
    parser.add_argument('--library',required=True,type=Path)
    args=parser.parse_args()
    with producer.assets.CascStorage(args.install,args.library) as storage:
        result=optimize(args.input,args.output,storage)
    print(json.dumps({k:v for k,v in result.items() if k not in ('removed','naxx','raids')},sort_keys=True))
    print(json.dumps([{k:v for k,v in raid.items() if k != 'worldResources'} for raid in result['raids']],sort_keys=True))


if __name__ == '__main__':
    main()
