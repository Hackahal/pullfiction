#!/usr/bin/env python3
"""Prepare hosted raid resources from one strict offline Classic Era CASC install.

Game bytes and generated reports are confined to a fresh ignored .agent output.
No network access or deployment is performed by this command.
"""
import argparse
from collections import deque
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

from hosted_assets import ChunkWriter, audit, digest, json_bytes, durable_write, sync_file, sync_directory
from classic_compat import CompatError, adapt_model
from classic_world import World, parts, chunks as world_chunks, read as field
from classic_table_strings import named_table
from classic_characters import Characters, TABLES as CHARACTER_TABLES
from classic_items import TABLES as ITEM_TABLES
from classic_lighting import lighting_catalog
from classic_talents import talent_catalog

ROOT = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


assets = module('hosted_classic_assets', 'classic-assets.py')
catalog_tools = module('hosted_catalog_tools', 'renderer-catalogs.py')
model_tools = module('hosted_model_tools', 'renderer-model-audit.py')
world_tools = module('hosted_world_tools', 'renderer-world-audit.py')


def logical_resource(name):
    """Renderer aliases resolve to the same archive file ID as the browser bridge."""
    name = assets.resource(name)
    match = re.fullmatch(r'__classic/([1-9]\d*)\.(?:blp|m2|wmo)', name)
    return assets.resource(int(match[1])) if match else name


def normalized_catalog_pairs(catalogs):
    # Inventory adapters also consume JSON snapshots, whose record keys are
    # strings. Match that public representation before joining fresh exporters.
    return list(json.loads(json_bytes(catalogs)).items())


def creature_texture_resources(catalog):
    result = set()
    for display in catalog.get('displays', {}).values():
        result.update(file for file in display.get('textures', []) if type(file) is int and file > 0)
    for extra in catalog.get('extras', {}).values():
        file = extra.get('bakeFileDataID', 0)
        if type(file) is int and file > 0: result.add(file)
    return sorted(result)



def write_checkpoint(writer, checkpoint_path, record):
    """Flush chunk persistence before atomically publishing preparation state."""
    writer.flush()
    durable_write(checkpoint_path,json_bytes(record))


def prune_prepared_chunks(writer):
    """Finalize reachability in producer-owned output, never deployed retention."""
    # Pending slices receive their content hash only during flush.
    writer.flush()
    used = {part['chunk'] for entry in writer.manifest['files'].values() for part in entry['parts']}
    for path in (writer.output/'chunks').iterdir():
        if re.fullmatch(r'[0-9a-f]{64}\.bin\.gz', path.name) and path.name[:-7] not in used:
            path.unlink()
    writer.manifest['chunks'] = {sha:entry for sha,entry in writer.manifest['chunks'].items() if sha in used}


def prepare(storage, build, output, raids, *, chunk_bytes=16*1024*1024, max_bytes=64*1024**3, max_files=500000, resume=False):
    checkpoint_path = Path(str(output)+'.checkpoint.json')
    state = json.loads(checkpoint_path.read_bytes()) if resume else None
    if state:
        if state['build'] != build: raise ValueError('Checkpoint source build differs')
        writer = ChunkWriter.__new__(ChunkWriter)
        writer.output, writer.limit, writer.max_bytes, writer.max_files = Path(output), chunk_bytes, max_bytes, max_files
        writer.pending, writer.references = bytearray(), []
        writer.manifest, writer.total = state['manifest'], state['total']
        # A checkpoint created by an older producer may predate synced chunk
        # writes. Request persistence once before publishing any newer state.
        referenced = {part['chunk'] for entry in writer.manifest['files'].values() for part in entry['parts']}
        for sha in referenced:
            with (writer.output/'chunks'/(sha+'.bin.gz')).open('rb') as stream:
                sync_file(stream.fileno())
        sync_directory(writer.output/'chunks')
        sync_directory(writer.output)
        sync_directory(writer.output.parent)
    else:
        writer = ChunkWriter(output, build, chunk_bytes, max_bytes, max_files)
    queue, queued, processed = deque(), set(), set()
    unsupported, models, maps = {}, {}, []
    required, dependency_graph, references = set(), {}, {}
    active_model = None
    if state:
        queue, queued, processed = deque(state['queue']), set(state['queued']), set(state['processed'])
        unsupported, models = state['unsupported'], state['models']
        unsupported = {k:v for k,v in unsupported.items() if not v['reason'].startswith('Unavailable dependencies: ')}
        required = set(state['required'])
        dependency_graph = {k:set(v) for k,v in state['dependencyGraph'].items()}
    def checkpoint():
        record = {'build':build,'manifest':writer.manifest,'total':writer.total,'queue':list(queue),
            'queued':sorted(queued),'processed':sorted(processed),'unsupported':unsupported,'models':models,
            'required':sorted(required),'dependencyGraph':{k:sorted(v) for k,v in dependency_graph.items()}}
        write_checkpoint(writer,checkpoint_path,record)
    aliases = {}
    start = time.monotonic()

    def enqueue(name):
        name = logical_resource(name)
        if name not in queued:
            queued.add(name); queue.append(name)
        return name

    def raw(name):
        name = logical_resource(name)
        if active_model is not None:
            dependency_graph.setdefault(active_model,set()).add(name)
        data = storage.read(name)
        writer.add('read:'+name, data)
        enqueue(name)
        return data

    finalizing = False
    try:
        snapshot = catalog_tools.snapshot_catalogs(raw, build, catalog_tools.prefix_reader(storage))
        if snapshot['manifest']['status'] != 'complete':
            raise ValueError('Required catalogs failed: '+json.dumps(snapshot['manifest']['catalogs']))
        catalogs = snapshot['catalogs']
        catalogs['lighting'] = lighting_catalog(raw, build)
        catalogs['talents'] = talent_catalog(raw, build)
        for kind, value in catalogs.items():
            writer.add('catalog:'+kind, json_bytes(value))
        pairs = normalized_catalog_pairs(catalogs)
        for file, refs in model_tools.inventory(pairs, build).items():
            name = enqueue(file); references[name] = refs
        for files in model_tools.appearance_dependencies(pairs).values():
            for file in sorted(files): enqueue(file)
        for file in creature_texture_resources(catalogs['creatures']):
            enqueue(file)
        for effect in model_tools.excluded_model_consumers(pairs):
            enqueue(effect['fileDataID'])
        # Catalog region textures are selected dynamically for equipped items.
        def texture_rows(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == 'file' and type(child) is int and child > 0: enqueue(child)
                    elif isinstance(child, (list, dict)): texture_rows(child)
            elif isinstance(value, list):
                for child in value: texture_rows(child)
        texture_rows(catalogs['items'].get('displays', {}))
        def icons(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in ('iconFile','iconFileDataID') and type(child) is int and child > 0: enqueue(child)
                    elif key == 'icon' and isinstance(child,str) and child.startswith('id:'): enqueue(child)
                    elif isinstance(child,(dict,list)): icons(child)
            elif isinstance(value,list):
                for child in value: icons(child)
        icons(catalogs)
        for skybox in catalogs['lighting'].get('skyboxes',[]):
            enqueue(skybox['path'])
            if skybox.get('celestialFileDataID'): enqueue(skybox['celestialFileDataID'])
        appearances = Characters(raw, build)
        for table in sorted(set(CHARACTER_TABLES+ITEM_TABLES+['HelmetGeosetData'])):
            raw('dbfilesclient/'+table.lower()+'.db2')
        # All authored candidate textures for every dynamic character material.
        materials = {row['MaterialResourcesID'] for row in appearances.tables['ChrCustomizationMaterial'].values()}
        for row_id, row in appearances.tables['TextureFileData'].items():
            if row['UsageType'] == 0 and row['MaterialResourcesID'] in materials:
                enqueue(row.get('FileDataID', row_id))
        appearance_inputs = {key for key in writer.manifest['files'] if key.startswith('read:dbfilesclient/')}
        aliases = {assets.resource(k):assets.resource(v) for k,v in catalogs['creatures']['characterModelPaths'].items()}
        for alias, name in sorted(aliases.items()):
            data = raw(name)
            appearance_inputs.add('read:'+name)
            for skin in assets.ids(assets.chunks(data).get('SFID', b'')):
                raw(f'id:{skin}'); appearance_inputs.add(f'read:id:{skin}')
        # Boot resources mirror original-client-assets.ts, with generated liquid frames.
        ui_source = (ROOT/'web/editor/src/original-client-assets.ts').read_text()
        ui_block = ui_source.split('export const ORIGINAL_UI_FILES = [',1)[1].split('] as const',1)[0]
        boot = re.findall(r'"([^"]+)"', ui_block)
        boot += ['textures/'+n+'.blp' for n in ('suncenter','sunglare','moon','moonglare','moon02','waterpoop02')]
        boot += ['environments/stars/stars.blp','environments/stars/stars2.blp','textures/weather/raindrop01.blp','xtextures/splash/splash.blp','xtextures/splash/wake.blp']
        for directory,stem,count in [('river','lake_a',30),('river','fast_a',16),('ocean','ocean_h',30),('lava','lava',30),('slime','slime',30)]:
            boot += [f'xtextures/{directory}/{stem}.{i}.blp' for i in range(1,count+1)]
        for name in boot:
            required.add(logical_resource(name)); raw(name)
        for name in ['textures/shadowblob.blp','textures/unitselecttexture.blp','interface/spellshadow/spell-shadow-acceptable.blp','interface/spellshadow/spell-shadow-unacceptable.blp']:
            enqueue(name)
        world = World(raw)
        map_rows, _ = named_table(raw('dbfilesclient/map.db2'), 'Map')
        if any('WdtFileDataID' in row for row in map_rows.values()):
            world.set_maps(map_rows.values())
        def required_raw(name):
            name = logical_resource(name)
            data = raw(name)
            required.add(name)
            return data
        world.raw = required_raw
        original = world.resource
        def world_resource(name):
            name = assets.resource(name)
            key = 'world:'+name
            data = original(name)
            writer.add(key, data)
            if name.endswith('.adt'):
                value = {tag:body for tag,body in world_chunks(data) if tag != 'MCNK'}
                for ref in world_tools.object_dependencies(value): enqueue(ref)
                for ref in value.get('MTEX', b'').split(b'\0'):
                    if ref: required.add(enqueue(ref.decode()))
            return data
        world.resource = world_resource
        for raid in sorted(raids, key=lambda r:r['map']):
            directory = raid['directory'].lower()
            world.resource(f'world/maps/{directory}/{directory}.wdt')
            wdt = world.wdt(directory)
            for y in range(64):
                for x in range(64):
                    if field(wdt['MAIN'], '<I', (y*64+x)*8)[0] & 1:
                        world.resource(f'world/maps/{directory}/{directory}_{x}_{y}.adt')
            tactical = world.map(raid['map'], directory)
            writer.add('map:'+str(raid['map']), json_bytes(tactical))
            maps.append({'map':raid['map'], 'directory':directory, 'status':'prepared'})
            print(f"Map {raid['map']} prepared ({len(writer.manifest['files'])} resources)", flush=True)
        # Every structural source dependency is read; no missing reference is ignored.
        while queue:
            name = queue[0]
            if name in processed:
                queue.popleft(); continue
            try:
                data = raw(name)
            except assets.AssetError as error:
                if name in required: raise
                unsupported[name] = {'status':'unavailable','reason':str(error),'references':references.get(name,[])}
                processed.add(name); queue.popleft(); continue
            try:
                if data[:4] == b'REVM':
                    unique = {tag:body for tag,body in world_chunks(data) if tag != 'MCNK'}
                    if any(tag == 'MCNK' for tag,_ in world_chunks(data)) or 'MHDR' in unique or 'MTXP' in unique or 'MDDF' in unique:
                        info, dependencies = {'format':'ADT'}, []
                        for ref in world_tools.object_dependencies(unique): enqueue(ref)
                    else:
                        info, dependencies = assets.inspect_asset(data)
                else:
                    info, dependencies = assets.inspect_asset(data)
                if data[:4] == b'MD21':
                    model_chunks = assets.chunks(data)
                    for tag in ('GPID','RPID'):
                        dependencies.extend(f'id:{file}' for file in assets.ids(model_chunks.get(tag,b'')))
                dependency_graph.setdefault(name,set()).update(logical_resource(d) for d in dependencies)
                for dep in dependencies: enqueue(dep)
                if data[:4] == b'MD21':
                    chunks = assets.chunks(data)
                    try:
                        active_model = name
                        skins = [raw(f'id:{file}') for file in assets.ids(chunks.get('SFID', b''))[:info['views']]]
                        converted = adapt_model(data, skins, raw)
                        writer.add('model:'+name, converted)
                        models[name] = {'status':'converted'}
                    except (CompatError, assets.AssetError) as error:
                        unsupported[name] = {'status':'unsupported','reason':str(error),'references':references.get(name,[])}
                        models[name] = {'status':'unsupported', 'reason':str(error)}
                    finally:
                        active_model = None
                elif data[:4] == b'REVM':
                    value = {tag:body for tag,body in world_chunks(data) if tag != 'MCNK'}
                    if 'MOHD' in value:
                        doodads = {f'id:{n}' for n in assets.ids(value.get('MODI',b''))}
                        for ref in world_tools.root_dependencies(value):
                            ref = enqueue(ref)
                            if name in required and ref not in doodads: required.add(ref)
                        if name.startswith('id:'):
                            world.resource('__classic/'+name[3:]+'.wmo')
                            for group in range(field(value['MOHD'], '<I', 4)[0]):
                                world.resource('__classic/'+name[3:]+f'_{group:03}.wmo')
            except (assets.AssetError, CompatError) as error:
                if name in required: raise
                unsupported[name] = {'status':'unsupported','reason':str(error),'references':references.get(name,[])}
                writer.manifest['files'].pop('model:'+name,None)
            processed.add(name)
            queue.popleft()
            if len(processed) % 1000 == 0:
                checkpoint()
                print(f'Closure {len(processed)}/{len(queued)}, {writer.total/1024**3:.2f} GiB', flush=True)
        # Any unavailable structural dependency invalidates every converted parent.
        changed = True
        while changed:
            changed = False
            for name, deps in dependency_graph.items():
                if name not in models and name not in references: continue
                bad = sorted(d for d in deps if d in unsupported)
                if bad and name not in unsupported:
                    unsupported[name] = {'status':'unavailable','reason':'Unavailable dependencies: '+', '.join(bad),'references':references.get(name,[])}
                    changed = True
        if required & unsupported.keys():
            raise ValueError('Required resources unavailable: '+', '.join(sorted(required & unsupported.keys())))
        for name in unsupported:
            writer.manifest['files'].pop('model:'+name,None)
        # Persist the new resource reachability before deleting chunks that an
        # earlier checkpoint might still have referenced.
        checkpoint()
        prune_prepared_chunks(writer)
        # Named character paths remain usable in the renderer as well as file IDs.
        for alias, name in sorted(aliases.items()):
            entry = writer.manifest['files'].get('model:'+name)
            if entry: writer.manifest['files']['model:'+alias] = dict(entry)
        finalizing = True
        manifest = writer.finish(status='ready', coverage={'catalogModelCandidates':len(references),'modelsConverted':sum('model:'+name in writer.manifest['files'] for name in models),'unsupportedResources':len(unsupported)}, appearanceInputs=sorted(appearance_inputs),
            aliases=aliases, unsupported=unsupported, maps=maps,
            producer={'sha256':digest(Path(__file__).read_bytes()), 'adaptersSha256':digest(b''.join(p.read_bytes() for p in sorted((ROOT/'scripts').glob('classic_*.py'))))})
        report = audit(output)
        report.update(maps=maps, models=len(models), unsupported=unsupported, seconds=round(time.monotonic()-start, 2))
        Path(str(output)+'.report.json').write_bytes(json_bytes(report))
        return manifest, report
    except Exception as error:
        if finalizing:
            # Keep the durable pre-finalization checkpoint free of finish()
            # metadata, including when audit/reporting fails after it returns.
            try:
                (Path(output)/'manifest.json').unlink(missing_ok=True)
            except OSError as cleanup:
                error.add_note('Could not remove partial manifest: '+str(cleanup))
        else:
            try:
                checkpoint()
            except Exception as saving:
                error.add_note('Could not save failure checkpoint: '+str(saving))
        # Retain explicit failure evidence without poisoning resumable state or
        # replacing the original exception when the filesystem is unavailable.
        try:
            Path(str(output)+'.failure.json').write_bytes(json_bytes({'status':'failed', 'error':type(error).__name__, 'reason':str(error),
                'maps':maps, 'processed':len(processed), 'queued':len(queued), 'unsupported':unsupported}))
        except OSError as reporting:
            error.add_note('Could not write failure evidence: '+str(reporting))
        raise


def output_path(value):
    path = Path(value).absolute()
    base = ROOT/'.agent'
    if not path.is_relative_to(base) or path.resolve() != path or any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('Output must be a fresh nonsymlink directory under this checkout .agent')
    return path


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'audit':
        print(json.dumps(audit(Path(sys.argv[2])), sort_keys=True)); return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', type=Path)
    parser.add_argument('--library', type=Path)
    parser.add_argument('--output', required=True, type=output_path)
    parser.add_argument('--audit', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Resume a local sibling checkpoint, verifying source identity')
    parser.add_argument('--max-bytes', type=int, default=64*1024**3)
    parser.add_argument('--max-files', type=int, default=500000)
    args = parser.parse_args()
    if args.audit:
        print(json.dumps(audit(args.output), sort_keys=True)); return
    if not args.install or not args.library:
        parser.error('--install and --library are required for preparation')
    if os.environ.get('CI') or os.environ.get('GITHUB_ACTIONS'):
        raise ValueError('Game asset preparation is local only and forbidden in CI')
    import subprocess
    if subprocess.run(['git', 'check-ignore', '-q', str(args.output)], cwd=ROOT).returncode != 0:
        raise ValueError('Output must be ignored by Git')
    build = assets.client_build(args.install)
    raids = json.loads((ROOT/'web/planner/raids.json').read_bytes())
    with assets.CascStorage(args.install, args.library) as storage:
        _, report = prepare(storage, build, args.output, raids, max_bytes=args.max_bytes, max_files=args.max_files, resume=args.resume)
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, CompatError, assets.AssetError) as error:
        print('Hosted assets: '+str(error), file=sys.stderr); sys.exit(1)
