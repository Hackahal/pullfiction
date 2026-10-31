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
import re
import struct
import subprocess
import time

from classic_compat import CompatError, read
from classic_table_strings import named_table
from classic_terrain import chunks
from classic_world import World, CENTER, adapt_wdt, floor_face, pack, parts, records, text, wmo_floor, terrain_floor

ROOT = Path(__file__).resolve().parent.parent


def geometry_summary(vertices, indices, camera_seeds=True):
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
    if not issues and camera_seeds:
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


def analyze_group(data, material_count, position=(0, 0, 0), rotation=(0, 0, 0), camera_seeds=True):
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
    result = geometry_summary(vertices, indices, camera_seeds)
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
            # Triangle-list draws ignore an incomplete final primitive (including real AQ20
            # data). Keep its exact authored count; this is not an invalid array/range.
            result.setdefault('partialPrimitives', []).append({'batch': offset//24, 'trailingIndices': count % 3})
        if start + count > len(indices):
            result['issues'].append('batch-triangle-range-out-of-bounds')
        if start % 3 or count % 3 or start + count > len(indices):
            result.setdefault('batchDiagnostics', []).append({'batch': offset//24, 'startIndex': start,
                                                             'indexCount': count, 'availableIndices': len(indices)})
        if material >= material_count:
            invalid_materials.append(material)
    if invalid_materials:
        result['issues'].append('material-slot-out-of-range:' + ','.join(map(str, sorted(set(invalid_materials)))))
    if camera_seeds:
        floor_vertices, floor_indices = wmo_floor(data, position, rotation)
        floors = geometry_summary(floor_vertices, floor_indices)
        result['walkableTriangles'] = floors['triangles']
        result['cameraSeeds'] = floors['cameraSeeds']
        result['issues'] += floors['issues']
    else:
        result['walkableTriangles'] = None
    for tag, stride in [('MONR', 12), ('MOTV', 8), ('MOCV', 4)]:
        for layer in nested.get(tag, []):
            if len(layer) != len(vertices) * stride:
                result['issues'].append(tag + '-vertex-count-mismatch')
    result['batches'] = len(batches)//24
    result['materialSlots'] = sorted({batches[offset+23] for offset in records(batches, 24)})
    result['uvLayers'] = len(nested.get('MOTV', []))
    result['colorLayers'] = len(nested.get('MOCV', []))
    result['interior'] = bool(read(group, '<I', 8)[0] & 0x2000)
    result['requiredModes'] = {'groupFlags': hex(read(group, '<I', 8)[0]),
                              'chunks': {k: len(v) for k, v in sorted(nested.items())},
                              'liquid': bool(raw.get('MLIQ')), 'lightReferences': len(raw.get('MOLR', b''))//2,
                              'doodadReferences': len(raw.get('MODR', b''))//2,
                              'portalReferences': read(group, '<HH', 0x24) if len(group) >= 0x28 else None}
    result['issues'] = sorted(set(result['issues']))
    return result


def analyze_terrain(data, camera_seeds=True):
    values = list(chunks(data))
    texture_names = next((body for tag, body in values if tag == 'MTEX'), b'')
    textures = [s.decode(errors='replace') for s in texture_names.split(b'\0') if s]
    issues, cells, layers, liquids, shadows, color_cells = [], 0, 0, 0, 0, 0
    referenced_textures = set()
    layer_flags, cell_flags = collections.Counter(), collections.Counter()
    for tag, body in values:
        if tag != 'MCNK':
            continue
        cells += 1
        if len(body) < 128:
            raise CompatError('Truncated MCNK header')
        nested = parts(body[128:])
        cell_flags[hex(read(body, '<I', 0)[0])] += 1
        heights = read(nested.get('MCVT', b''), '<145f', 0)
        if not all(math.isfinite(v) for v in heights + read(body, '<3f', 0x68)):
            issues.append('nonfinite-terrain-height-or-position')
        material = nested.get('MCLY', b'')
        for offset in records(material, 16):
            index = read(material, '<I', offset)[0]
            referenced_textures.add(index)
            layer_flags[hex(read(material, '<I', offset+4)[0])] += 1
            if index >= len(textures):
                issues.append('terrain-material-slot-out-of-range')
        layers += len(material)//16
        liquids += int('MCLQ' in nested)
        shadows += int('MCSH' in nested)
        color_cells += int('MCCV' in nested)
        if 'MCCV' in nested and len(nested['MCCV']) != 145 * 4:
            issues.append('terrain-vertex-color-count-mismatch')
    if cells != 256:
        issues.append('terrain-cell-count:' + str(cells))
    vertices, indices = terrain_floor(data)
    result = geometry_summary(vertices, indices, camera_seeds)
    result.update(cells=cells, layers=layers, liquidCells=liquids,
                  dependencies=[name for i, name in enumerate(textures) if i in referenced_textures],
                  declaredDependencies=textures)
    result['requiredModes'] = {'layerFlags': dict(layer_flags), 'cellFlags': dict(cell_flags),
                               'shadowCells': shadows, 'vertexColorCells': color_cells}
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


def root_modes(value, groups):
    """Enumerate required modes without calling their presence implemented support."""
    materials = value.get('MOMT', b'')
    shaders, blends, flags = collections.Counter(), collections.Counter(), collections.Counter()
    secondary, descriptors = 0, []
    for offset in records(materials, 64):
        flag, shader, blend = read(materials, '<3I', offset)
        flags[hex(flag)] += 1
        shaders[str(shader)] += 1
        blends[str(blend)] += 1
        secondary += bool(read(materials, '<I', offset+24)[0] or read(materials, '<I', offset+36)[0])
        descriptors.append({'slot': offset//64, 'shader': shader, 'blend': blend, 'flags': hex(flag),
                            'textures': [read(materials, '<I', offset+field)[0] for field in (12, 24, 36)]})
    portals, vertices, refs = value.get('MOPT', b''), value.get('MOPV', b''), value.get('MOPR', b'')
    issues = []
    for offset in records(portals, 20):
        start, count = read(portals, '<HH', offset)
        if start + count > len(vertices)//12:
            issues.append('portal-vertex-range-out-of-bounds')
    for offset in records(refs, 8):
        portal, group = read(refs, '<HH', offset)
        if portal >= len(portals)//20 or group >= groups:
            issues.append('portal-reference-out-of-bounds')
    return {'shaders': dict(shaders), 'blendModes': dict(blends), 'materialFlags': dict(flags),
            'secondaryTextureMaterials': secondary, 'portalPolygons': len(portals)//20,
            'materials': descriptors, 'textureReferenceMode': 'MOTX-offset' if value.get('MOTX') else 'fileDataID',
            'portalReferences': len(refs)//8, 'lightBytes': len(value.get('MOLT', b'')),
            'fogBytes': len(value.get('MFOG', b'')), 'doodads': len(value.get('MODD', b''))//40,
            'chunks': sorted(value), 'issues': sorted(set(issues))}


class SourceLedger:
    """Hash successful source reads, retain failures, and never retain raw game bytes."""
    def __init__(self, read):
        self.read, self.records = read, {}

    def __call__(self, name):
        previous = self.records.get(name, {})
        try:
            data = self.read(name)
            value = {'resource': name, 'status': 'readable', 'bytes': len(data),
                     'sha256': hashlib.sha256(data).hexdigest(), 'reads': previous.get('reads', 0) + 1}
            if previous.get('sha256') and previous['sha256'] != value['sha256']:
                raise CompatError('Source changed during audit: ' + name)
            self.records[name] = value
            return data
        except Exception as error:
            self.records[name] = {'resource': name, 'status': 'unavailable', 'error': f'{type(error).__name__}: {error}',
                                  'reads': previous.get('reads', 0) + 1}
            raise


class NativeReader:
    """Same bounded framed-stdin pattern as the model audit; one owned child, no asset files."""
    def __init__(self, executable):
        self.process = subprocess.Popen([str(executable.resolve())], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE) if executable else None

    def __enter__(self): return self

    def check(self, kind, data, root=None):
        code = {'terrain': b'A', 'root': b'R', 'group': b'G'}[kind]
        frame = code + ((struct.pack('<I', len(root)) + root) if root is not None else b'') + data
        if len(frame) > 256 * 1024 * 1024:
            raise ValueError('World native probe frame exceeds limit.')
        self.process.stdin.write(struct.pack('<I', len(frame)) + frame)
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line: raise ValueError('Native world reader exited before reporting a result.')
        return json.loads(line)

    def __exit__(self, *_):
        if self.process:
            self.process.stdin.close()
            try:
                if self.process.wait(timeout=60): raise ValueError('Native world reader failed.')
            finally:
                self.process.stdout.close()


def native_reader_identity(executable, identity_path):
    """Validate captured build inputs, never attribute the working tree's source to a binary."""
    identity_bytes = identity_path.read_bytes()
    record = json.loads(identity_bytes)
    binary_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
    if record.get('binarySha256') != binary_hash:
        raise ValueError('Native world reader hash disagrees with its build identity.')
    snapshot_name = record.get('probeSourceSnapshot')
    source_hash = record.get('probeSourceSha256')
    if not isinstance(snapshot_name, str) or not re.fullmatch(r'[0-9a-f]{64}', str(source_hash)):
        raise ValueError('Native world reader identity requires a preserved source snapshot and hash.')
    snapshot = Path(snapshot_name)
    if hashlib.sha256(snapshot.read_bytes()).hexdigest() != source_hash:
        raise ValueError('Native world reader source snapshot disagrees with its build identity.')
    libraries = record.get('rlibs')
    if not isinstance(libraries, dict) or not {'benilla_formats', 'serde_json'} <= libraries.keys():
        raise ValueError('Native world reader identity requires linked formats and serde_json libraries.')
    for name, library in libraries.items():
        if not isinstance(library, dict) or not isinstance(library.get('path'), str) \
                or not re.fullmatch(r'[0-9a-f]{64}', str(library.get('sha256'))):
            raise ValueError('Invalid native world reader library identity: ' + name)
        if hashlib.sha256(Path(library['path']).read_bytes()).hexdigest() != library['sha256']:
            raise ValueError('Native world reader linked library disagrees with its build identity: ' + name)
    return {'path': str(executable.resolve()), 'sha256': binary_hash,
            'sourceSha256': source_hash, 'sourceSnapshot': str(snapshot.resolve()),
            'buildIdentity': str(identity_path.resolve()),
            'buildIdentitySha256': hashlib.sha256(identity_bytes).hexdigest(),
            'rlibs': libraries, 'manifest': record}


class Audit:
    def __init__(self, world, deadline, max_tiles=128, max_groups=2048, camera_seeds=True, verify_dependencies=False,
                 native_reader=None):
        self.world, self.deadline = world, deadline
        self.max_tiles, self.max_groups = max_tiles, max_groups
        self.resources = {}  # Shared WMO/model references are recorded once across maps.
        self.camera_seeds, self.verify_dependencies = camera_seeds, verify_dependencies
        self.group_cache = {}
        self.native_reader = native_reader
        self.native_roots, self.native_groups = {}, {}

    def native(self, kind, data, root=None):
        try:
            return self.native_reader.check(kind, data, root)
        except Exception as error:
            return {'status': 'reader-error', 'error': f'{type(error).__name__}: {error}'}

    def dependency(self, name):
        source = 'id:' + name.split('/')[1].split('.')[0] if name.startswith('__classic/') else name
        if source == 'id:0':
            return {'resource': source, 'status': 'expected-none', 'reason': 'authored-zero-sentinel', 'decode': 'expected-none'}
        if source not in self.resources:
            row = {'resource': source, 'status': 'unverified', 'decode': 'unverified'}
            self.resources[source] = row
            if self.verify_dependencies:
                try:
                    data = self.world.raw(source)
                    row.update(status='readable', bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                               format=data[:4].decode(errors='replace'))
                except Exception as error:
                    row.update(status='unavailable', error=f'{type(error).__name__}: {error}')
        return self.resources[source]

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
                    raw_obj = {tag: body for tag, body in chunks(self.world.raw(f'id:{ids[1]}')) if tag != 'MCNK'}
                    tile['objectDependencies'] = object_dependencies(raw_obj)
                    placed.update((p[0], p[1:]) for p in placements(raw_obj))
                    for ref in tile['objectDependencies']:
                        self.dependency(ref)
                    if number >= self.max_tiles or not self.remaining():
                        tile['reason'] = 'bounded-audit-budget'
                        continue
                    path = f'world/maps/{directory}/{directory}_{x}_{y}.adt'
                    data = self.world.resource(path)
                    tile.update(analyze_terrain(data, self.camera_seeds), status='converted', bytes=len(data),
                                adaptedSha256=hashlib.sha256(data).hexdigest())
                    for ref in tile['dependencies']:
                        self.dependency(ref)
                    tile['status'] = 'fail' if tile['issues'] else 'structural-pass'
                    if self.native_reader:
                        tile['nativeParser'] = self.native('terrain', data)
                except Exception as error:
                    tile.update(status='error', error=f'{type(error).__name__}: {error}')
            decoded = 0
            for uid, (path, position, rotation) in sorted(placed.items()):
                placement = {'uid': uid, 'resource': path, 'position': list(position), 'rotation': list(rotation),
                             'status': 'unverified'}
                report['wmoPlacements'].append(placement)
                try:
                    raw_root = parts(self.world.raw(self.world.source(path)))
                    root_data = self.world.resource(path)
                    root = parts(root_data)
                    count = read(root['MOHD'], '<I', 4)[0]
                    material_count = read(root['MOHD'], '<I', 0)[0]
                    if len(root.get('MOMT', b'')) != material_count * 64:
                        raise CompatError('WMO material metadata count mismatch')
                    dependencies = root_dependencies(raw_root)
                    placement.update(status='converted', groups=count, materials=material_count, dependencies=dependencies)
                    if not self.remaining():
                        placement.update(status='metadata-only', reason='bounded-audit-budget')
                    placement['requiredModes'] = root_modes(raw_root, count)
                    placement['adaptedSha256'] = hashlib.sha256(pack(root)).hexdigest()
                    if self.native_reader:
                        root_hash = placement['adaptedSha256']
                        if root_hash not in self.native_roots:
                            self.native_roots[root_hash] = self.native('root', root_data)
                        placement['nativeParser'] = self.native_roots[root_hash]
                    for ref in dependencies:
                        self.dependency(ref)
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
                            cache_key = (source, material_count)
                            if not self.camera_seeds and cache_key in self.group_cache:
                                row.update(self.group_cache[cache_key], source=source, sharedAnalysis=True)
                            else:
                                data = self.world.resource(logical)
                                row.update(analyze_group(data, material_count, position, rotation, self.camera_seeds),
                                           source=source, bytes=len(data), adaptedSha256=hashlib.sha256(data).hexdigest())
                                if not self.camera_seeds:
                                    self.group_cache[cache_key] = {k: v for k, v in row.items() if k not in
                                        ('areaId', 'placement', 'group', 'resource', 'name', 'status')}
                            row['status'] = 'fail' if row['issues'] else 'structural-pass'
                            if self.native_reader:
                                native_key = (source, placement['adaptedSha256'])
                                if native_key not in self.native_groups:
                                    self.native_groups[native_key] = self.native('group', self.world.resource(logical), root_data)
                                row['nativeParser'] = self.native_groups[native_key]
                            self.resources.setdefault(source, {'resource': source}).update(
                                kind='wmo-group', structuralStatus=row['status'])
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
        report['coverage'] = {
            'tilesExpected': report['wdt'].get('terrainTiles'), 'tilesEnumerated': len(report['tiles']),
            'tilesCompleted': sum(x['status'] in ('structural-pass', 'fail') for x in report['tiles']),
            'tileInventoryErrors': sum(x['status'] == 'error' for x in report['tiles']),
            'tilesBudgetExhausted': sum(x.get('reason') == 'bounded-audit-budget' for x in report['tiles']),
            'placementsEnumerated': len(report['wmoPlacements']),
            'placementMetadataErrors': sum(x['status'] == 'error' for x in report['wmoPlacements']),
            'groupsExpectedFromReadableRoots': sum(x.get('groups', 0) for x in report['wmoPlacements']),
            'groupsEnumerated': len(report['groups']),
            'groupsCompleted': sum(x['status'] in ('structural-pass', 'fail') for x in report['groups']),
            'groupsUnavailable': sum(x['status'] == 'error' for x in report['groups']),
            'groupsBudgetExhausted': sum(x.get('reason') == 'bounded-audit-budget' for x in report['groups'])}
        report['coverage']['dependencyClosureKnown'] = (report['wdt'].get('status') == 'converted'
            and report['coverage']['tileInventoryErrors'] == 0 and report['coverage']['placementMetadataErrors'] == 0)
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
    parser.add_argument('--all-instances', action='store_true', help='Select every installed Map instanceType1/2, retaining unavailable/test maps')
    parser.add_argument('--no-camera-seeds', action='store_true', help='Structural audit without floor/camera sampling; deduplicate shared group analysis')
    parser.add_argument('--verify-dependencies', action='store_true', help='Read/hash all referenced textures/models; readability is separate from decode')
    parser.add_argument('--native-reader', type=Path, help='Fresh compiled renderer-world-audit-native probe; native decoding remains separate from GPU/runtime/visual')
    parser.add_argument('--native-reader-identity', type=Path, help='Captured native binary/source-snapshot/rlib build identity; required with --native-reader')
    args = parser.parse_args()
    if args.budget_seconds <= 0 or args.max_tiles_per_map < 0 or args.max_groups_per_map < 0:
        parser.error('Audit budgets must be nonnegative and time must be positive.')
    if bool(args.native_reader) != bool(args.native_reader_identity):
        parser.error('--native-reader and --native-reader-identity must be supplied together.')
    try:
        native_identity = native_reader_identity(args.native_reader, args.native_reader_identity) if args.native_reader else None
    except (OSError, ValueError) as error:
        parser.error(str(error))
    spec = importlib.util.spec_from_file_location('classic_assets', ROOT / 'scripts/classic-assets.py')
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    source = assets.client_build(args.install)
    raids = json.loads(args.raids.read_text())
    raids.sort(key=lambda r: (0 if r.get('rulesets') == ['sod'] else 1, r['map']))
    args.output.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    adapters = {name: hashlib.sha256((ROOT / 'scripts' / name).read_bytes()).hexdigest() for name in
                ('classic_world.py', 'classic_terrain.py', 'renderer-world-audit.py', 'classic_world_catalog.py')}
    with assets.CascStorage(args.install, args.library) as storage, NativeReader(args.native_reader) as native:
        ledger = SourceLedger(lambda name: storage.read(assets.resource(name)))
        world = World(ledger)
        maps, layout = named_table(world.raw('dbfilesclient/map.db2'), 'Map')
        if any('WdtFileDataID' in row for row in maps.values()):
            world.set_maps(maps.values())  # Filename-free layouts only; Era resolves retained names.
        if args.all_instances:
            raids = [{'map': key, 'name': row['MapName_lang'], 'directory': row['Directory'],
                      'instanceType': row['InstanceType']} for key, row in sorted(maps.items()) if row['InstanceType'] in (1, 2)]
        catalog_path = args.output / 'map-catalog.json'
        catalog_path.write_text(json.dumps({'schema': 1, 'source': source, 'layouts': {'Map': layout},
                                           'maps': [{'id': key, 'name': row['MapName_lang'], 'directory': row['Directory'],
                                                     'instanceType': row['InstanceType']}
                                                    for key, row in maps.items()]}, indent=2) + '\n')
        audit = Audit(world, start + args.budget_seconds, args.max_tiles_per_map, args.max_groups_per_map,
                      not args.no_camera_seeds, args.verify_dependencies, native if args.native_reader else None)
        reports = []
        for raid in raids:
            # Use authoritative installed Map directory, retaining the selection's numeric map identity.
            if raid['map'] in maps:
                raid = dict(raid, directory=maps[raid['map']]['Directory'])
            report = audit.map(raid)
            reports.append(report)
            (args.output / f'{raid["map"]}.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
            print(json.dumps({'map': raid['map'], 'name': raid['name'], **report['summary'], 'issues': report['issues']}), flush=True)
        index = {'schema': 1, 'source': source, 'adapterSources': adapters,
                 'mapsExpected': len(raids), 'mapsCompleted': len(reports),
                 'sourceReads': list(ledger.records.values()),
                 'elapsedSeconds': round(time.monotonic()-start, 3), 'maps': reports,
                 'resources': list(audit.resources.values()),
                 'proof': 'Offline metadata and structural conversion audit. No rendered, visually checked or reference-parity credits.'}
        if args.native_reader:
            index['nativeReader'] = {**native_identity,
                'uniqueRootResults': dict(collections.Counter(v['status'] for v in audit.native_roots.values())),
                'uniqueGroupResults': dict(collections.Counter(v['status'] for v in audit.native_groups.values())),
                'terrainResults': dict(collections.Counter(t.get('nativeParser', {}).get('status', 'unrun') for r in reports for t in r['tiles'])),
                'proofBoundary': 'Native production format/terrain consumers only; GPU/runtime/PVS/lifecycle/visual unverified'}
        (args.output / 'manifest.json').write_text(json.dumps(index, indent=2, allow_nan=False) + '\n')
        (args.output / 'cases.json').write_text(json.dumps(camera_cases(reports), indent=2, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
