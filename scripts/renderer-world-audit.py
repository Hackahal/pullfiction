#!/usr/bin/env python3
"""Bounded read-only raid-world conversion audit through shipping Python adapters.

Writes metadata and camera seeds only. A successful geometry conversion does not
prove GPU rendering, visible rooms, lighting correctness or official-client parity.
"""
import argparse
import collections
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import time

from classic_compat import CompatError, read
from classic_table_strings import named_table
from classic_terrain import chunks
from classic_world import World, CENTER, adapt_wdt, floor_face, pack, parts, records, text, wmo_floor, terrain_floor

ROOT = Path(__file__).resolve().parent.parent


def geometry_summary(vertices, indices):
    issues = []
    if any(len(p) != 3 or not all(math.isfinite(v) and abs(v) < 1e6 for v in p) for p in vertices):
        issues.append('nonfinite-or-out-of-range-coordinate')
    if len(indices) % 3:
        issues.append('misaligned-triangle-indices')
    if any(type(i) is not int or i < 0 or i >= len(vertices) for i in indices):
        issues.append('triangle-index-out-of-range')
    bounds = None
    if vertices and not issues:
        bounds = [[min(p[i] for p in vertices) for i in range(3)],
                  [max(p[i] for p in vertices) for i in range(3)]]
    seeds = []
    if not issues:
        # Spread samples across source triangle order; each target lies on an authored upward face.
        triangles = []
        for start in range(0, len(indices), 3):
            tri = [vertices[i] for i in indices[start:start+3]]
            if floor_face(tri):
                triangles.append([sum(p[i] for p in tri)/3 for i in range(3)])
        for index in sorted(set([0, len(triangles)//2, len(triangles)-1])) if triangles else []:
            target = triangles[index]
            seeds.append({'position': [target[0], target[1], target[2] + 1.7],
                          'camera': {'yaw': .65, 'pitch': .25, 'distance': 10,
                                     'target': [target[0], target[1], target[2] + 1.5]},
                          'status': 'unverified', 'reason': 'Walkable triangle seed; camera occlusion and visible-room acceptance remain unverified.'})
    return {'vertices': len(vertices), 'triangles': len(indices)//3, 'bounds': bounds,
            'issues': issues, 'cameraSeeds': seeds}


def analyze_group(data, material_count, position=(0, 0, 0), rotation=(0, 0, 0)):
    group = parts(data).get('MOGP')
    if group is None or len(group) < 68:
        raise CompatError('Missing or truncated MOGP header')
    nested = collections.defaultdict(list)
    for tag, body in chunks(group[68:]):
        nested[tag].append(body)
    for name in ('MOVT', 'MOVI', 'MOPY', 'MOBA'):
        if len(nested[name]) > 1:
            raise CompatError('Duplicate geometry chunk: ' + name)
    raw = {k: v[0] for k, v in nested.items() if v}
    vertices = [list(p) for p in struct.iter_unpack('<3f', raw.get('MOVT', b''))]
    indices = [i[0] for i in struct.iter_unpack('<H', raw.get('MOVI', b''))]
    result = geometry_summary(vertices, indices)
    header_bounds = read(group, '<6f', 12)
    if not all(math.isfinite(v) for v in header_bounds):
        result['issues'].append('nonfinite-group-header-bounds')
    if any(header_bounds[i] > header_bounds[i+3] for i in range(3)):
        result['issues'].append('inverted-group-header-bounds')
    flags = raw.get('MOPY', b'')
    if len(flags) != len(indices)//3 * 2:
        result['issues'].append('triangle-material-count-mismatch')
    invalid_materials = []
    for offset in records(flags, 2):
        flag, material = flags[offset:offset+2]
        # 255 is the authored no-material sentinel for collision-only geometry.
        if material >= material_count and not (material == 255 and flag & 8 and not flag & 0x20):
            invalid_materials.append(material)
    batches = raw.get('MOBA', b'')
    for offset in records(batches, 24):
        start, count = read(batches, '<IH', offset+12)
        material = batches[offset+23]
        if start % 3:
            result['issues'].append('batch-start-not-triangle-aligned')
        if count % 3:
            result['issues'].append('batch-count-not-triangle-aligned')
        if start + count > len(indices):
            result['issues'].append('batch-triangle-range-out-of-bounds')
        if start % 3 or count % 3 or start + count > len(indices):
            result.setdefault('batchDiagnostics', []).append({'batch': offset//24, 'startIndex': start,
                                                             'indexCount': count, 'availableIndices': len(indices)})
        if material >= material_count:
            invalid_materials.append(material)
    if invalid_materials:
        result['issues'].append('material-slot-out-of-range:' + ','.join(map(str, sorted(set(invalid_materials)))))
    floor_vertices, floor_indices = wmo_floor(data, position, rotation)
    floors = geometry_summary(floor_vertices, floor_indices)
    result['walkableTriangles'] = floors['triangles']
    result['cameraSeeds'] = floors['cameraSeeds']
    result['issues'] += floors['issues']
    result['batches'] = len(batches)//24
    result['uvLayers'] = len(nested.get('MOTV', []))
    result['colorLayers'] = len(nested.get('MOCV', []))
    result['interior'] = bool(read(group, '<I', 8)[0] & 0x2000)
    result['issues'] = sorted(set(result['issues']))
    return result


def analyze_terrain(data):
    values = list(chunks(data))
    texture_names = next((body for tag, body in values if tag == 'MTEX'), b'')
    textures = [s.decode(errors='replace') for s in texture_names.split(b'\0') if s]
    issues, cells, layers, liquids = [], 0, 0, 0
    for tag, body in values:
        if tag != 'MCNK':
            continue
        cells += 1
        if len(body) < 128:
            raise CompatError('Truncated MCNK header')
        nested = parts(body[128:])
        heights = read(nested.get('MCVT', b''), '<145f', 0)
        if not all(math.isfinite(v) for v in heights + read(body, '<3f', 0x68)):
            issues.append('nonfinite-terrain-height-or-position')
        material = nested.get('MCLY', b'')
        for offset in records(material, 16):
            index = read(material, '<I', offset)[0]
            if index >= len(textures):
                issues.append('terrain-material-slot-out-of-range')
        layers += len(material)//16
        liquids += int('MCLQ' in nested)
    if cells != 256:
        issues.append('terrain-cell-count:' + str(cells))
    vertices, indices = terrain_floor(data)
    result = geometry_summary(vertices, indices)
    result.update(cells=cells, layers=layers, liquidCells=liquids, dependencies=textures)
    result['issues'] = sorted(set(result['issues'] + issues))
    return result


def placements(value, global_wmo=False):
    names, indices = value.get('MWMO', b''), value.get('MWID', b'')
    for offset in records(value.get('MODF', b''), 64):
        blob = value['MODF']
        name_id, uid = read(blob, '<2I', offset)
        flags = read(blob, '<H', offset + 56)[0]
        if not global_wmo and flags & 8:
            name = f'__classic/{name_id}.wmo'
        else:
            name = text(names, name_id if global_wmo else read(indices, '<I', name_id*4)[0])
        position, rotation = read(blob, '<3f', offset+8), read(blob, '<3f', offset+20)
        if not global_wmo:
            position = [CENTER-position[2], CENTER-position[0], position[1]]
        if not all(math.isfinite(v) for v in tuple(position) + tuple(rotation)):
            raise CompatError('Nonfinite WMO placement')
        yield uid, name.replace('\\', '/').lower(), position, rotation


def object_dependencies(value):
    refs = set()
    for offset in records(value.get('MDDF', b''), 36):
        name_id = read(value['MDDF'], '<I', offset)[0]
        flags = read(value['MDDF'], '<H', offset+34)[0]
        if flags & 0x40:
            if name_id:
                refs.add(f'id:{name_id}')
        else:
            string_offset = read(value.get('MMID', b''), '<I', name_id*4)[0]
            refs.add(text(value.get('MMDX', b''), string_offset))
    return sorted(refs)


def root_dependencies(value):
    refs = set()
    for name in ('GFID', 'MODI'):
        refs.update(f'id:{i[0]}' for i in struct.iter_unpack('<I', value.get(name, b'')) if i[0])
    if not value.get('MOTX'):
        for offset in records(value.get('MOMT', b''), 64):
            refs.update(f'id:{read(value["MOMT"], "<I", offset+field)[0]}' for field in (12, 24, 36)
                        if read(value['MOMT'], '<I', offset+field)[0])
    else:
        refs.update(p.decode(errors='replace') for p in value['MOTX'].split(b'\0') if p)
    return sorted(refs)


class Audit:
    def __init__(self, world, deadline, max_tiles=128, max_groups=2048):
        self.world, self.deadline = world, deadline
        self.max_tiles, self.max_groups = max_tiles, max_groups
        self.resources = {}  # Shared WMO/model references are recorded once across maps.

    def remaining(self):
        return time.monotonic() < self.deadline

    def map(self, raid):
        report = {'mapId': raid['map'], 'name': raid['name'], 'directory': raid['directory'],
                  'wdt': {}, 'tiles': [], 'wmoPlacements': [], 'groups': [], 'issues': [],
                  'proof': 'Read/decode/adapt/structural geometry only. GPU and visible-room coverage are unverified.'}
        directory = raid['directory'].lower()
        try:
            wdt = self.world.wdt(directory)
            logical = f'world/maps/{directory}/{directory}.wdt'
            converted = self.world.resource(logical)
            cells = [(x, y) for y in range(64) for x in range(64) if read(wdt['MAIN'], '<I', (y*64+x)*8)[0] & 1]
            report['wdt'] = {'status': 'converted', 'source': self.world.source(logical), 'bytes': len(converted),
                             'terrainTiles': len(cells), 'chunks': list(wdt)}
            placed = {}
            if read(wdt['MPHD'], '<I', 0)[0] & 1:
                placed.update((p[0], p[1:]) for p in placements(parts(adapt_wdt(pack(wdt))), True))
            # Inventory every authored tile even if an explicit time/tile budget stops decoding.
            for number, (x, y) in enumerate(cells):
                tile = {'x': x, 'y': y, 'status': 'unverified', 'issues': []}
                report['tiles'].append(tile)
                try:
                    ids = self.world.terrain_ids(wdt, x, y)
                    tile['fileIds'] = list(ids)
                    tile['sourceDependencies'] = [f'id:{i}' for i in ids if i]
                    if number >= self.max_tiles or not self.remaining():
                        tile['reason'] = 'bounded-audit-budget'
                        continue
                    raw_obj = {tag: body for tag, body in chunks(self.world.raw(f'id:{ids[1]}')) if tag != 'MCNK'}
                    tile['objectDependencies'] = object_dependencies(raw_obj)
                    placed.update((p[0], p[1:]) for p in placements(raw_obj))
                    path = f'world/maps/{directory}/{directory}_{x}_{y}.adt'
                    data = self.world.resource(path)
                    tile.update(analyze_terrain(data), status='converted', bytes=len(data))
                    tile['status'] = 'fail' if tile['issues'] else 'structural-pass'
                except Exception as error:
                    tile.update(status='error', error=f'{type(error).__name__}: {error}')
            decoded = 0
            for uid, (path, position, rotation) in sorted(placed.items()):
                placement = {'uid': uid, 'resource': path, 'position': list(position), 'rotation': list(rotation),
                             'status': 'unverified'}
                report['wmoPlacements'].append(placement)
                if not self.remaining():
                    placement['reason'] = 'bounded-audit-budget'
                    continue
                try:
                    raw_root = parts(self.world.raw(self.world.source(path)))
                    root = parts(self.world.resource(path))
                    count = read(root['MOHD'], '<I', 4)[0]
                    material_count = read(root['MOHD'], '<I', 0)[0]
                    if len(root.get('MOMT', b'')) != material_count * 64:
                        raise CompatError('WMO material metadata count mismatch')
                    dependencies = root_dependencies(raw_root)
                    placement.update(status='converted', groups=count, materials=material_count, dependencies=dependencies)
                    self.resources.setdefault(path, {'resource': path, 'kind': 'wmo-root', 'dependencies': dependencies})
                    metadata, names = root.get('MOGI', b''), root.get('MOGN', b'')
                    if len(metadata) != count * 32:
                        raise CompatError('WMO group metadata count mismatch')
                    for index in range(count):
                        logical = path[:-4] + f'_{index:03}.wmo'
                        row = {'areaId': f'{uid}:{index}', 'placement': uid, 'group': index, 'resource': logical,
                               'status': 'unverified'}
                        report['groups'].append(row)
                        offset = read(metadata, '<i', index*32+28)[0]
                        row['name'] = text(names, offset) if 0 <= offset < len(names) else f'Group {index}'
                        if decoded >= self.max_groups or not self.remaining():
                            row['reason'] = 'bounded-audit-budget'
                            continue
                        decoded += 1
                        try:
                            source = self.world.source(logical)
                            data = self.world.resource(logical)
                            row.update(analyze_group(data, material_count, position, rotation), source=source, bytes=len(data))
                            row['status'] = 'fail' if row['issues'] else 'structural-pass'
                            self.resources.setdefault(source, {'resource': source, 'kind': 'wmo-group', 'status': row['status']})
                        except Exception as error:
                            row.update(status='error', error=f'{type(error).__name__}: {error}')
                except Exception as error:
                    placement.update(status='error', error=f'{type(error).__name__}: {error}')
        except Exception as error:
            report['issues'].append(f'{type(error).__name__}: {error}')
            report['wdt']['status'] = 'error'
        report['summary'] = {'tiles': dict(collections.Counter(x['status'] for x in report['tiles'])),
                             'groups': dict(collections.Counter(x['status'] for x in report['groups'])),
                             'placements': dict(collections.Counter(x['status'] for x in report['wmoPlacements'])),
                             'cameraSeeds': sum(len(x.get('cameraSeeds', [])) for x in report['tiles'] + report['groups'])}
        return report


def camera_cases(reports):
    """Convert geometry seeds to the editor's RendererCase schema without visual credit."""
    cases = []
    for report in reports:
        map_id = report['mapId']
        for row in report['tiles'] + report['groups']:
            area = row.get('areaId', f"terrain:{row.get('x')}:{row.get('y')}")
            for index, seed in enumerate(row.get('cameraSeeds', [])):
                cases.append({'id': f'world:{map_id}:{area}:{index}',
                              'label': f"{report['name']}: {row.get('name', area)} viewpoint {index+1}",
                              'category': 'world', 'content': 'sod', 'mapId': map_id,
                              'position': seed['position'], 'camera': seed['camera'],
                              'actors': [], 'effects': [], 'timesMs': [0, 1000], 'seed': 1,
                              'expectedReadableFeatures': ['visible authored geometry at walkable seed',
                                                           'material continuity; camera occlusion remains unverified'],
                              'coverageIds': [f'map:{map_id}', f'world-area:{map_id}:{area}'],
                              'readiness': {'status': 'unverified', 'reason': seed['reason']}})
    return sorted(cases, key=lambda c: c['id'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', type=Path, default=ROOT / '.agent/work/browser-static/retained-client')
    parser.add_argument('--library', type=Path, default=ROOT / '.agent/tools/casclib/build/casc.framework/Versions/1.0.0/casc')
    parser.add_argument('--raids', type=Path, default=ROOT / 'web/planner/raids.json')
    parser.add_argument('--output', type=Path, default=ROOT / '.agent/work/renderer-correctness-20261030/world-audit')
    parser.add_argument('--budget-seconds', type=float, default=180)
    parser.add_argument('--max-tiles-per-map', type=int, default=128)
    parser.add_argument('--max-groups-per-map', type=int, default=2048)
    args = parser.parse_args()
    if args.budget_seconds <= 0 or args.max_tiles_per_map < 0 or args.max_groups_per_map < 0:
        parser.error('Audit budgets must be nonnegative and time must be positive.')
    spec = importlib.util.spec_from_file_location('classic_assets', ROOT / 'scripts/classic-assets.py')
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    source = assets.client_build(args.install)
    raids = json.loads(args.raids.read_text())
    raids.sort(key=lambda r: (0 if r.get('rulesets') == ['sod'] else 1, r['map']))
    args.output.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    with assets.CascStorage(args.install, args.library) as storage:
        world = World(lambda name: storage.read(assets.resource(name)))
        maps, layout = named_table(world.raw('dbfilesclient/map.db2'), 'Map')
        if any('WdtFileDataID' in row for row in maps.values()):
            world.set_maps(maps.values())  # Filename-free layouts only; Era resolves retained names.
        catalog_path = args.output / 'map-catalog.json'
        catalog_path.write_text(json.dumps({'schema': 1, 'source': source, 'layouts': {'Map': layout},
                                           'maps': [{'id': key, 'name': row['MapName_lang'], 'directory': row['Directory']}
                                                    for key, row in maps.items()]}, indent=2) + '\n')
        audit = Audit(world, start + args.budget_seconds, args.max_tiles_per_map, args.max_groups_per_map)
        reports = []
        for raid in raids:
            # Use authoritative installed Map directory, retaining the selection's numeric map identity.
            if raid['map'] in maps:
                raid = dict(raid, directory=maps[raid['map']]['Directory'])
            report = audit.map(raid)
            reports.append(report)
            (args.output / f'{raid["map"]}.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
            print(json.dumps({'map': raid['map'], 'name': raid['name'], **report['summary'], 'issues': report['issues']}), flush=True)
        digest = hashlib.sha256(b''.join((ROOT / 'scripts' / name).read_bytes() for name in
                                        ('classic_world.py', 'classic_terrain.py', 'renderer-world-audit.py'))).hexdigest()
        index = {'schema': 1, 'source': source, 'adapterSHA256': digest,
                 'elapsedSeconds': round(time.monotonic()-start, 3), 'maps': reports,
                 'resources': list(audit.resources.values()),
                 'proof': 'Offline metadata and structural conversion audit. No rendered, visually checked or reference-parity credits.'}
        (args.output / 'manifest.json').write_text(json.dumps(index, indent=2, allow_nan=False) + '\n')
        (args.output / 'cases.json').write_text(json.dumps(camera_cases(reports), indent=2, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
