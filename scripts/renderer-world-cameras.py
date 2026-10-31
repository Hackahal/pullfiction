#!/usr/bin/env python3
"""Frame authored raid fixtures from offline, placed WMO triangles.

Requires NumPy and an existing renderer-world-audit directory. Reads local CASC
only, writes JSON metadata only, and never overwrites output files. The resulting
views remain unverified until browser acceptance; static ray samples cannot
establish complete camera-volume, doodad or dynamic-object clearance.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time

try:
    import numpy as np
except ImportError as error:
    raise SystemExit('renderer-world-cameras requires NumPy; use a Python environment containing numpy.') from error

from classic_world import World, parts, transform
from classic_terrain import chunks

PROOF = ('Offline geometry candidates only. Static WMO ray samples do not establish '
         'dynamic/doodad visibility, other-placement collision, complete camera-volume '
         'clearance, or GPU acceptance. All cases remain unverified.')
OCCLUSION_SCOPE = ('Same placed WMO groups whose world AABB overlaps the selected group '
                   'bounds expanded by 12 yards; triangle tests clipped to each eye XY '
                   '+/-100 yards. No doodad/model or other-placement collision claim.')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_destinations(install, output, evidence):
    """Resolve symlinks before allowing any output or parent-directory creation."""
    install = install.resolve()
    data = (install / 'Data').resolve()
    protected = [install, data]
    if data.name.lower() == 'data':
        protected.append(data.parent)
    shared = install.parent / 'Data'
    if shared.exists():
        protected.append(shared.resolve())
    destinations = [output, evidence]
    if output.resolve() == evidence.resolve():
        raise ValueError('Output and evidence must be different files.')
    for path in destinations:
        resolved = path.resolve()
        if any(resolved == root or root in resolved.parents for root in protected):
            raise ValueError(f'Output must be outside the installation and its Data directory: {path}')
        if path.exists() or path.is_symlink():
            raise ValueError(f'Refusing to overwrite existing output: {path}')


def write_outputs(install, output, evidence, cases, report):
    """Exclusive creation also refuses files created after the initial preflight."""
    payloads = [json.dumps(value, indent=2, allow_nan=False) + '\n' for value in (cases, report)]
    validate_destinations(install, output, evidence)
    for path in (output, evidence):
        path.parent.mkdir(parents=True, exist_ok=True)
    created = []
    try:
        for path, payload in zip((output, evidence), payloads):
            with path.open('x') as stream:
                created.append(path)
                stream.write(payload)
    except Exception:
        for path in created:
            path.unlink()
        raise


def placed_bounds(group, placement):
    lo, hi = group['bounds']
    corners = np.array([transform([x, y, z], placement['position'], placement['rotation'])
                        for x in [lo[0], hi[0]] for y in [lo[1], hi[1]] for z in [lo[2], hi[2]]])
    return corners.min(axis=0), corners.max(axis=0)


class Geometry:
    def __init__(self, world):
        self.world = world
        self.cache = {}
        self.sources = {}

    def read(self, group, placement):
        key = (group['source'], tuple(placement['position']), tuple(placement['rotation']))
        if key in self.cache:
            return self.cache[key]
        raw = self.world.raw(group['source'])
        values = {}
        for tag, data in chunks(parts(raw)['MOGP'][68:]):
            if tag in ('MOVT', 'MOVI', 'MOPY', 'MPY2'):
                if tag in values:
                    raise ValueError(f'Duplicate {tag} in {group["source"]}')
                values[tag] = data
        vertices = np.frombuffer(values['MOVT'], dtype='<f4').reshape(-1, 3).astype(float)
        rotation = np.array([transform(point, [0, 0, 0], placement['rotation'])
                             for point in [[1, 0, 0], [0, 1, 0], [0, 0, 1]]]).T
        vertices = vertices @ rotation.T + np.array(placement['position'])
        indices = np.frombuffer(values['MOVI'], dtype='<u2').reshape(-1, 3)
        triangles = vertices[indices]
        modern = 'MPY2' in values
        flags = np.frombuffer(values['MPY2' if modern else 'MOPY'],
                              dtype='<u2' if modern else 'u1').reshape(-1, 2)
        if len(flags) != len(triangles) or not np.isfinite(triangles).all():
            raise ValueError(f'Invalid triangle geometry in {group["source"]}')
        normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        lengths = np.linalg.norm(normals, axis=1)
        floors = ((lengths > 1e-8) & (normals[:, 2] / np.maximum(lengths, 1e-8) >= .65)
                  & ((flags[:, 0] & 4) == 0))
        self.sources[group['source']] = {'sha256': hashlib.sha256(raw).hexdigest(),
                                          'bytes': len(raw), 'triangles': len(triangles)}
        self.cache[key] = (triangles, np.flatnonzero(floors), normals)
        return self.cache[key]


def rays(origin, directions, triangles):
    """Two-sided Moller-Trumbore hits; direction length determines distance units."""
    a = triangles[:, 0]
    e1, e2 = triangles[:, 1] - a, triangles[:, 2] - a
    tvec = origin - a
    qvec = np.cross(tvec, e1)
    result = []
    for direction in directions:
        h = np.cross(direction, e2)
        det = np.einsum('ij,ij->i', e1, h)
        inverse = np.divide(1.0, det, out=np.zeros_like(det), where=abs(det) > 1e-9)
        u = np.einsum('ij,ij->i', tvec, h) * inverse
        v = qvec @ direction * inverse
        distance = np.einsum('ij,ij->i', e2, qvec) * inverse
        valid = ((abs(det) > 1e-9) & (u >= -1e-7) & (v >= -1e-7)
                 & (u + v <= 1.0000001) & (distance > 1e-4))
        indices = np.flatnonzero(valid)
        if len(indices):
            hit = indices[np.argmin(distance[indices])]
            result.append((float(distance[hit]), int(hit)))
        else:
            result.append((float('inf'), None))
    return result


def vertical_clearance(floor, mesh, normals):
    """Reject roof tops, low ceilings and geometry between the floor and eye."""
    eye = floor + [0, 0, 1.7]
    up, down = rays(eye, np.array([[0, 0, 1.], [0, 0, -1.]]), mesh)
    if down[0] < 1.68 or down[0] > 1.72:
        return None, 'floor-not-nearest-below-eye'
    if up[0] < .9 or up[0] > 100 or up[1] is None or normals[up[1], 2] >= -1e-8:
        return None, 'no-front-facing-overhead-or-low-ceiling'
    if rays(floor + [0, 0, .03], np.array([[0, 0, 1.]]), mesh)[0][0] < 1.67:
        return None, 'blocked-floor-to-eye-segment'
    return (eye, up[0], down[0]), None


def camera_from_eye(eye, heading):
    target = eye + np.array([5 * math.cos(heading), 5 * math.sin(heading), -.25])
    return {'yaw': float((heading + math.pi) % (2 * math.pi)),
            'pitch': math.atan2(.25, 5), 'distance': math.hypot(5, .25), 'target': target.tolist()}


def finite(value):
    return float(value) if math.isfinite(value) else None


def choose_eye(case, triangles, floors, full):
    full_normals = np.cross(full[:, 1] - full[:, 0], full[:, 2] - full[:, 0])
    centers = triangles[floors].mean(axis=1)
    old_floor = np.array(case['position']) - [0, 0, 1.7]
    nearest = np.argsort(np.linalg.norm(centers - old_floor, axis=1))[:4]
    spread = np.linspace(0, len(floors) - 1, min(28, len(floors))).astype(int)
    candidates = list(dict.fromkeys(list(nearest) + list(spread)))
    best, rejected = None, collections.Counter()
    for index in candidates:
        floor = centers[index]
        eye = floor + [0, 0, 1.7]
        near = ((full.max(axis=1)[:, 0] >= eye[0] - 100) & (full.min(axis=1)[:, 0] <= eye[0] + 100)
                & (full.max(axis=1)[:, 1] >= eye[1] - 100) & (full.min(axis=1)[:, 1] <= eye[1] + 100))
        mesh, normals = full[near], full_normals[near]
        clearance, reason = vertical_clearance(floor, mesh, normals)
        if reason:
            rejected[reason] += 1
            continue
        eye, overhead, below = clearance
        angles = np.arange(48) * math.tau / 48
        directions = np.array([[math.cos(a), math.sin(a), 0] for a in angles])
        distances = [hit[0] for hit in rays(eye, directions, mesh)]
        if min(distances) < .45:
            rejected['wall-within-eye-clearance'] += 1
            continue
        eligible = [j for j in range(48) if distances[j] >= 8
                    and min(distances[(j - 3) % 48], distances[(j + 3) % 48]) >= 4]
        eligible.sort(key=lambda j: min(distances[j], 40)
                      + .2 * min(distances[(j - 3) % 48], distances[(j + 3) % 48], 30), reverse=True)
        for j in eligible[:3]:
            heading = angles[j]
            center, left, right = distances[j], distances[(j - 3) % 48], distances[(j + 3) % 48]
            look = np.array([5 * math.cos(heading), 5 * math.sin(heading), -.25])
            look /= np.linalg.norm(look)
            target_los = rays(eye, [look], mesh)[0][0]
            if target_los < math.hypot(5, .25):
                continue
            fan = [(heading + math.radians(yaw), math.radians(pitch))
                   for yaw in [-22.5, 0, 22.5] for pitch in [-20, 0, 20]]
            directions = np.array([[math.cos(yaw) * math.cos(pitch), math.sin(yaw) * math.cos(pitch),
                                    math.sin(pitch)] for yaw, pitch in fan])
            visible = rays(eye, directions, mesh)
            if min(hit[0] for hit in visible) < .9 or all(hit[0] > 100 for hit in visible):
                continue
            score = min(center, 40) + .2 * min(left, right, 30) - .04 * float(np.linalg.norm(floor - old_floor))
            if best is None or score > best['score']:
                best = {'score': score, 'floor': floor.tolist(), 'eye': eye.tolist(),
                        'heading': float(heading), 'floorTriangleIndex': int(floors[index]),
                        'overheadYards': overhead, 'belowEyeYards': below,
                        'minimumHorizontalClearanceYards': finite(min(distances)),
                        'centerHorizontalLosYards': finite(center), 'targetLosYards': finite(target_los),
                        'fanHitYards': [round(hit[0], 5) if math.isfinite(hit[0]) else None for hit in visible]}
    return best, len(candidates), dict(rejected)


def eye_on_authored_tile(report, eye):
    """WMO references in edge ADTs can describe placements outside this map."""
    if not report.get('wdt', {}).get('terrainTiles'):
        return True  # Untiled, global-WMO instances have no terrain mask.
    return any(tile.get('bounds') and all(tile['bounds'][0][axis] <= eye[axis] <= tile['bounds'][1][axis]
                                         for axis in (0, 1))
               for tile in report.get('tiles', []))


def frame_cases(world, cases, reports, max_views=2, budget_seconds=380):
    geometry = Geometry(world)
    diagnostics, accepted = [], []
    started = time.monotonic()
    for case in cases:
        if time.monotonic() - started > budget_seconds:
            diagnostics.append({'sourceCaseId': case['id'], 'mapId': case['mapId'], 'status': 'unverified-budget'})
            continue
        report = reports[case['mapId']]
        area = next(value.split(':', 2)[2] for value in case['coverageIds'] if value.startswith('world-area:'))
        group = next(group for group in report['groups'] if group['areaId'] == area)
        placement = next(row for row in report['wmoPlacements'] if row['uid'] == group['placement'])
        triangles, floors, _ = geometry.read(group, placement)
        lo, hi = placed_bounds(group, placement)
        nearby, scope = [], []
        for other in report['groups']:
            if (other.get('placement') != group['placement'] or other.get('status') != 'structural-pass'
                    or not other.get('bounds')):
                continue
            other_lo, other_hi = placed_bounds(other, placement)
            if np.all(other_hi >= lo - 12) and np.all(other_lo <= hi + 12):
                nearby.append(geometry.read(other, placement)[0])
                scope.append(other['areaId'])
        best, tested, rejected = choose_eye(case, triangles, floors, np.concatenate(nearby)) if nearby else (None, 0, {})
        outside_map = best is not None and not eye_on_authored_tile(report, best['eye'])
        diag = {'sourceCaseId': case['id'], 'mapId': case['mapId'], 'areaId': area,
                'sourceGroup': group['source'], 'placement': {key: placement[key] for key in ('uid', 'position', 'rotation')},
                'occlusionGroupAreaIds': scope, 'candidatesTested': tested, 'candidateRejections': rejected,
                'status': ('unverified-outside-authored-terrain' if outside_map else
                           'geometry-candidate' if best else 'unverified-no-enclosed-safe-candidate'), 'selection': best}
        diagnostics.append(diag)
        if best and not outside_map:
            result = json.loads(json.dumps(case))
            result['id'] += '-framed'
            result['label'] += ': floor-eye framing'
            result['position'] = best['eye']
            result['camera'] = camera_from_eye(np.array(best['eye']), best['heading'])
            result['timesMs'] = [0]
            result['readiness'] = {'status': 'unverified', 'reason':
                'Eye is 1.7 yards above an authored front-facing floor; overhead, local clearance and room-directed '
                'ray fan checked against co-located placed WMO geometry. Browser visibility and dynamic/doodad '
                'occlusion remain unverified.'}
            result['expectedReadableFeatures'] = [
                'Room surfaces visible from eye on authored floor + 1.7 yards',
                'Camera faces an open room direction with >=8 yards horizontal center line of sight',
                'Ceiling, walls and floor should frame the room; dynamic/doodad occlusion and GPU appearance remain unverified']
            accepted.append((result, diag))
    chosen = []
    for map_id in reports:
        entries = [entry for entry in accepted if entry[0]['mapId'] == map_id]
        entries.sort(key=lambda entry: entry[1]['selection']['score'], reverse=True)
        chosen.extend(entries[:max_views])
    output = [case for case, _ in chosen]
    evidence = {'schema': 1, 'proofBoundary': PROOF, 'occlusionScope': OCCLUSION_SCOPE,
                'algorithm': 'Non-DETAIL upward floor centroids; eye=floor+1.7. Nearest floor 1.7 below; unblocked '
                'floor-to-eye; front-facing overhead 0.9..100 yards; 48 horizontal rays >=0.45 clearance; center '
                'LOS>=8, +/-22.5-degree LOS>=4; 3x3 ray fan >=0.9; clear exact target segment. Target five yards '
                'forward and 0.25 down. At most the configured number of views per map.',
                'inputCases': len(cases), 'processedCases': sum(d['status'] != 'unverified-budget' for d in diagnostics),
                'outputCases': len(output), 'maps': sorted({case['mapId'] for case in output}),
                'sourceFiles': geometry.sources, 'selected': [diag for _, diag in chosen], 'diagnostics': diagnostics,
                'elapsedSeconds': time.monotonic() - started}
    return output, evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', type=Path, required=True, help='Local Classic Era CASC installation root')
    parser.add_argument('--library', type=Path, required=True, help='Local CascLib shared library')
    parser.add_argument('--audit', type=Path, required=True, help='Existing world-audit directory with manifest.json and MAP.json')
    parser.add_argument('--cases', type=Path, required=True, help='Existing authored RendererCase JSON array')
    parser.add_argument('--output', type=Path, required=True, help='New output JSON file, outside install/Data')
    parser.add_argument('--evidence', type=Path, required=True, help='New evidence JSON file, outside install/Data')
    parser.add_argument('--max-views-per-map', type=int, default=2)
    parser.add_argument('--budget-seconds', type=float, default=380)
    args = parser.parse_args()
    try:
        if args.max_views_per_map <= 0 or not math.isfinite(args.budget_seconds) or args.budget_seconds <= 0:
            raise ValueError('View count and finite time budget must be positive.')
        validate_destinations(args.install, args.output, args.evidence)
        spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
        assets = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assets)
        manifest_path = args.audit / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        source = assets.client_build(args.install)
        if source != manifest['source']:
            raise ValueError('Installed client build differs from the source world audit.')
        cases = json.loads(args.cases.read_text())
        if not isinstance(cases, list) or not cases:
            raise ValueError('Input cases must be a nonempty JSON array.')
        reports, inputs = {}, [args.cases, manifest_path]
        for case in cases:
            map_id = case['mapId']
            if type(map_id) is not int or map_id < 0 or case.get('category') != 'world':
                raise ValueError('Only authored world cases with numeric mapId are supported.')
            if map_id not in reports:
                path = args.audit / f'{map_id}.json'
                reports[map_id] = json.loads(path.read_text())
                if reports[map_id]['mapId'] != map_id:
                    raise ValueError(f'Audit map identity mismatch: {path}')
                inputs.append(path)
        with assets.CascStorage(args.install, args.library) as storage:
            world = World(lambda name: storage.read(assets.resource(name)))
            output, evidence = frame_cases(world, cases, reports, args.max_views_per_map, args.budget_seconds)
        evidence.update(sourceBuild=source, inputFiles=[{'path': str(path), 'sha256': digest(path)} for path in inputs],
                        generatorSHA256=digest(Path(__file__)),
                        options={'maxViewsPerMap': args.max_views_per_map, 'budgetSeconds': args.budget_seconds})
        write_outputs(args.install, args.output, args.evidence, output, evidence)
        print(json.dumps({'outputCases': len(output), 'maps': evidence['maps'],
                          'elapsedSeconds': evidence['elapsedSeconds'], 'proofBoundary': PROOF}))
    except (ValueError, OSError, KeyError, StopIteration) as error:
        parser.error(str(error) or 'Input does not contain the requested WMO group/placement.')


if __name__ == '__main__':
    main()
