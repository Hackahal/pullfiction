#!/usr/bin/env python3
"""Audit catalog-referenced models from local Classic CASC, without downloads.

Results prove dependency readability, adapter execution and selected numerical
invariants. They do not certify GPU rendering or parity with an official client.
Raw game assets never leave memory; only local JSON evidence is written.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys
import time
import subprocess

from classic_compat import CompatError, UnsupportedFeatureError, adapt_model, inline_skeleton, read, span, table

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
DEFAULT_CATALOGS = [ROOT / '.agent/work/modern-local-creatures/creatures.json',
                    ROOT / '.agent/work/modern-local-catalogs/spell-effects.json',
                    ROOT / '.agent/work/modern-local-catalogs/item-appearances.json']


def digest(data):
    return hashlib.sha256(data).hexdigest()


class NativeReader:
    def __init__(self, executable):
        self.process = subprocess.Popen([str(executable.resolve())], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE) if executable else None

    def __enter__(self): return self

    def check(self, data):
        self.process.stdin.write(struct.pack('<I', len(data)) + data)
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line: raise ValueError('Native model reader exited before reporting a result.')
        return json.loads(line)

    def __exit__(self, *_):
        if self.process:
            self.process.stdin.close()
            try:
                if self.process.wait(timeout=60): raise ValueError('Native model reader failed.')
            finally:
                self.process.stdout.close()


def native_reader_identity(executable, identity_path, required_libraries=None):
    record = json.loads(identity_path.read_text())
    binary_hash = digest(executable.read_bytes())
    if record.get('binarySha256') != binary_hash:
        raise ValueError('Native model reader hash disagrees with its build identity.')
    if not record.get('probeSourceSnapshot') or not record.get('probeSourceSha256'):
        raise ValueError('Native reader requires a preserved source snapshot and hash.')
    snapshot = Path(record['probeSourceSnapshot'])
    if not snapshot.is_absolute(): snapshot = identity_path.parent / snapshot
    if not snapshot.is_file() or digest(snapshot.read_bytes()) != record['probeSourceSha256']:
        raise ValueError('Native model reader source snapshot disagrees with its build identity.')
    required = set(required_libraries or ('benilla_formats', 'serde_json'))
    if required_libraries is None and b'benilla_blp::' in snapshot.read_bytes():
        required.add('benilla_blp')
    libraries = record.get('rlibs')
    if not isinstance(libraries, dict) or not required.issubset(libraries):
        raise ValueError('Native reader is missing required library identities: ' + ', '.join(sorted(required)))
    for name, library in libraries.items():
        if not isinstance(library, dict) or not library.get('path') or not library.get('sha256'):
            raise ValueError(f'Native reader library {name} lacks an artifact path/hash.')
        path = Path(library['path'])
        if not path.is_absolute(): path = identity_path.parent / path
        if not path.is_file():
            raise ValueError(f'Native reader library {name} is unavailable: {path}')
        if digest(path.read_bytes()) != library['sha256']:
            raise ValueError(f'Native reader library {name} hash disagrees with its build identity.')
    return {'path': str(executable.resolve()), 'sha256': binary_hash,
            'sourceSha256': record.get('probeSourceSha256'),
            'buildIdentity': str(identity_path.resolve()), 'buildIdentitySha256': digest(identity_path.read_bytes()),
            'sourceSnapshot': str(snapshot.resolve()), 'rlibs': libraries}


def merge_model_manifest(selected, manifest, source):
    if manifest.get('source') != source:
        raise ValueError('Model manifest source disagrees with selected client.')
    for key, refs in manifest.get('models', {}).items():
        file = int(key)
        assets.resource(file)
        selected.setdefault(file, []).extend(refs)
    for path, refs in manifest.get('namedModels', {}).items():
        path = assets.resource(path)
        selected.setdefault(path, []).extend(refs)


def inventory(catalogs, source):
    """Deduplicate actual file IDs while retaining all source record associations."""
    result = {}
    for path, catalog in catalogs:
        if catalog.get('source') != source:
            raise ValueError(f'Catalog build disagrees with installed client: {path}')
        def add(value, category, key):
            if isinstance(value, int) and value > 0:
                result.setdefault(value, []).append(f'{category}:{key}')
        for key, model in catalog.get('models', {}).items():
            add(model.get('fileDataID'), 'creature', key)
        for key, value in catalog.get('characterModelPaths', {}).items():
            add(value, 'character', key)
        for key, effect in catalog.get('effects', {}).items():
            if effect.get('assetFormat') != 'wmo':
                add(effect.get('fileDataID'), 'spell-effect', key)
        for key, slots in catalog.get('itemVisuals', {}).items():
            for file in slots:
                add(file, 'item-visual', key)
        for key, display in catalog.get('displays', {}).items():
            for slot in display.get('models', []):
                for model in slot:
                    add(model.get('file'), 'item-display', key)
    return dict(sorted(result.items()))


def excluded_model_consumers(catalogs):
    return [{'catalog':str(path), 'record':'spell-effect:' + str(key),
             'fileDataID':effect.get('fileDataID'), 'assetFormat':'wmo', 'consumer':'world-WMO'}
            for path, catalog in catalogs for key, effect in catalog.get('effects', {}).items()
            if effect.get('assetFormat') == 'wmo' and effect.get('fileDataID')]


def appearance_dependencies(catalogs):
    """Include replaceable textures supplied by creature and equipment displays."""
    result = {}
    for _, catalog in catalogs:
        models = catalog.get('models', {})
        for display in catalog.get('displays', {}).values():
            if 'modelID' in display:
                model_id = models.get(str(display['modelID']), {}).get('fileDataID', 0)
                textures = display.get('textures', [])
                extra = catalog.get('extras', {}).get(str(display.get('extraDisplayID', 0)), {})
                textures = [*textures, extra.get('bakeFileDataID', 0)]
                files = [model_id]
            else:
                files = [model['file'] for slot in display.get('models', []) for model in slot]
                textures = [texture['file'] for slot in display.get('textures', []) for texture in slot]
            for file_id in files:
                if file_id:
                    result.setdefault(file_id, set()).update(t for t in textures if t)
    return result


def raw_evidence(data):
    parts = assets.chunks(data)
    body = parts.get('MD21', b'')
    if body[:4] != b'MD20':
        raise CompatError('Expected an MD21 model body.')
    arrays = {'sequences': (0x1c, 64), 'bones': (0x2c, 88), 'vertices': (0x3c, 48),
              'textures': (0x50, 16), 'lights': (0x108, 156), 'cameras': (0x110, 116),
              'ribbons': (0x120, 176), 'particles': (0x128, 492)}
    counts = {name: read(body, '<I', field)[0] for name, (field, _) in arrays.items()}
    vertices = table(body, 0x3c, 48)
    positions = [read(v, '<3f', 0) for v in vertices]
    if any(not math.isfinite(value) for vertex in vertices for value in (*read(vertex, '<3f', 0), *read(vertex, '<7f', 20))):
        raise CompatError('Non-finite model vertex position, normal, or UV.')
    bounds = [[min(p[a] for p in positions), max(p[a] for p in positions)] for a in range(3)] if positions else []
    dependencies = []
    for tag in ('SFID', 'TXID', 'SKID', 'BFID', 'GPID', 'RPID'):
        dependencies.extend((tag, value) for value in assets.ids(parts.get(tag, b'')))
    dependencies.extend(('AFID', value) for value in assets.ids(parts.get('AFID', b''), 8, 4))
    particles = table(body, 0x128, 492) if read(body, '<I', 4)[0] == 274 else []
    features = {
        'externalSkeleton': any(assets.ids(parts.get('SKID', b''))),
        'externalAnimation': any(assets.ids(parts.get('AFID', b''), 8, 4)),
        'multiTextureParticles': sum(bool(read(p, '<I', 4)[0] & 0x10000000) for p in particles),
        'particleColorReplacement': sum(bool(read(p, '<H', 42)[0]) for p in particles),
        'particleColorIndices': dict(Counter(str(read(p, '<H', 42)[0]) for p in particles)),
        'particleBlends': dict(Counter(str(read(p, '<B', 40)[0]) for p in particles)),
        'particleShapes': dict(Counter(str(read(p, '<B', 41)[0]) for p in particles)),
        'particleFlags': dict(Counter(str(read(p, '<I', 4)[0]) for p in particles)),
        'geometryModelParticles': sum(bool(value) for value in assets.ids(parts.get('GPID', b''))),
        'recursiveModelParticles': len(assets.ids(parts.get('RPID', b''))),
        'refractionParticles': sum(bool(read(p, '<I', 4)[0] & 0x100000)
                                  and not bool(read(p, '<I', 4)[0] & 0x10000000) for p in particles),
    }
    txac = parts.get('TXAC', b'')
    features['particleCoordinateModes'] = dict(Counter(
        str(read(txac, '<H', i * 2)[0]) for i in range(min(len(particles), len(txac) // 2))))
    features['textureTypes'] = dict(Counter(str(read(t, '<I', 0)[0]) for t in table(body, 0x50, 16)))
    return parts, body, {'features': features, 'sha256': digest(data), 'bytes': len(data), 'version': read(body, '<I', 4)[0],
                        'chunks': list(parts), 'counts': counts, 'positionBounds': bounds,
                        'sequenceDurations': [read(s, '<I', 4)[0] for s in table(body, 0x1c, 64)],
                        'animationIDs': sorted({read(s, '<H', 0)[0] for s in table(body, 0x1c, 64)}),
                        'verticesSha256': digest(b''.join(vertices))}, dependencies


def preservation(body, skins, adapted):
    """Compare independent source/adapted fields, not adapter-derived expectations."""
    checks = {}
    checks['verticesExact'] = table(body, 0x3c, 48) == table(adapted, 0x44, 48)
    checks['boundsExact'] = span(body, 0xa0, 56) == span(adapted, 0xb4, 56)
    sequences = table(adapted, 0x1c, 68)
    checks['sequenceDurationsExact'] = [read(s, '<I', 4)[0] for s in table(body, 0x1c, 64)] == [read(s, '<I', 8)[0] - read(s, '<I', 4)[0] for s in sequences]
    checks['boneParentsPivotsExact'] = [(b[:12], b[76:88]) for b in table(body, 0x2c, 88)] == [(b[:12], b[96:108]) for b in table(adapted, 0x34, 108)]
    profiles = table(adapted, 0x4c, 44)
    checks['skinProfileCountExact'] = len(profiles) == len(skins)
    checks['skinIndicesExact'] = True
    checks['batchShaderStagesExact'] = True
    for skin, profile in zip(skins, profiles):
        for field in (4, 12):
            count, offset = read(profile, '<II', field - 4)
            checks['skinIndicesExact'] &= b''.join(table(skin, field, 2)) == span(adapted, offset, count * 2)
        count, offset = read(profile, '<II', 32)
        converted = [span(adapted, offset + i * 24, 24) for i in range(count)]
        checks['batchShaderStagesExact'] &= [(b[2:4], b[14:18]) for b in table(skin, 36, 24)] == [(b[2:4], b[14:18]) for b in converted]
    return checks


def audit_model(storage, file_id, refs, dependency_cache=None, appearance_textures=(), native_reader=None):
    cache = dependency_cache if dependency_cache is not None else {}
    resource = f'id:{file_id}' if isinstance(file_id, int) else file_id
    record = {'fileDataID': file_id if isinstance(file_id, int) else None,
              'resource': resource, 'references': refs, 'status': 'unverified', 'dependencies': [],
              'gpuExecution': 'unverified', 'visualApproval': 'unverified'}
    try:
        data = storage.read(resource)
    except assets.AssetError as error:
        return dict(record, status='unavailable', family=str(error).split(':')[0], error=str(error))
    if data[:4] != b'MD21':
        try:
            info, dependencies = assets.inspect_asset(data)
            return dict(record, status='other-format', family='Asset requires a different format pipeline.',
                        source=dict(info, sha256=digest(data), bytes=len(data)),
                        otherFormatDependencies=dependencies)
        except assets.AssetError as error:
            return dict(record, status='invalid', family=str(error), error=str(error))
    try:
        parts, body, evidence, deps = raw_evidence(data)
        record['source'] = evidence
        deps.extend(('appearance-texture', value) for value in sorted(appearance_textures))
        skins = []
        required = assets.ids(parts.get('SFID', b''))[:read(body, '<I', 0x44)[0]]
        for kind, dependency in dict.fromkeys(deps):
            if dependency not in cache:
                try:
                    raw = storage.read(f'id:{dependency}')
                    cache[dependency] = {'available': True, 'bytes': len(raw), 'sha256': digest(raw), 'format': raw[:4].decode('ascii', errors='replace')}
                except assets.AssetError as error:
                    cache[dependency] = {'available': False, 'error': str(error)}
            record['dependencies'].append(dict(cache[dependency], kind=kind, fileDataID=dependency))
        missing = [d for d in record['dependencies'] if not d['available']]
        record['dependencyStatus'] = 'unavailable' if missing else 'readable'
        record['missingDependencies'] = len(missing)
        # Conversion and dependency completeness are independent outcomes.
        for value in required:
            skins.append(storage.read(f'id:{value}'))
        if len(skins) != read(body, '<I', 0x44)[0]:
            raise CompatError('Model is missing its external skin IDs.')
        record['skinFeatures'] = [{'sha256': digest(skin), 'bytes': len(skin),
            'sections': len(table(skin, 28, 48)),
            'batches': [{'shader': read(b, '<H', 2)[0], 'textureStages': read(b, '<H', 14)[0],
                         'textureCombo': read(b, '<H', 16)[0], 'uvCombo': read(b, '<H', 18)[0],
                         'animationCombo': read(b, '<H', 22)[0]}
                        for b in table(skin, 36, 24)]} for skin in skins]
        record['source']['features']['multiStageMaterials'] = sum(b['textureStages'] > 2 for skin in record['skinFeatures'] for b in skin['batches'])
        record['source']['features']['wideIndexSections'] = sum(bool(read(section, '<H', 2)[0]) for skin in skins for section in table(skin, 28, 48))
        features = record['source']['features']
        record['requiredCapabilities'] = [name for name in (
            'externalSkeleton', 'externalAnimation', 'multiTextureParticles',
            'particleColorReplacement', 'geometryModelParticles', 'recursiveModelParticles',
            'refractionParticles', 'multiStageMaterials', 'wideIndexSections') if features.get(name)]
        effective = inline_skeleton(data, storage.read)
        effective_body = assets.chunks(effective)['MD21']
        adapted = adapt_model(effective, skins)
        if native_reader:
            record['nativeParser'] = native_reader(adapted)
        checks = preservation(effective_body, skins, adapted)
        if 'GPID' in parts:
            geometry_ids = [read(parts['GPID'], '<I', offset)[0] for offset in range(0, len(parts['GPID']), 4)]
            emitters = table(adapted, 0x13c, 504)
            checks['particleGeometryPathsExact'] = len(geometry_ids) == len(emitters)
            for file_id, emitter in zip(geometry_ids, emitters):
                if file_id:
                    size, offset = read(emitter, '<II', 24)
                    checks['particleGeometryPathsExact'] &= span(adapted, offset, size) == f'__classic/{file_id}.m2\0'.encode()
        record['adapted'] = {'sha256': digest(adapted), 'bytes': len(adapted), 'checks': checks}
        if effective != data:
            record['adapted']['inlinedSkeleton'] = True
            record['adapted']['effectiveSkeletalCounts'] = {
                name: read(effective_body, '<I', field)[0]
                for name, field in [('bones',0x2c),('sequences',0x1c),('attachments',0xf0)]}
        record['status'] = 'adapted' if all(checks.values()) else 'invariant-failure'
        features = record['source']['features']
        partial = []
        if features.get('refractionParticles'):
            partial.append('refraction-scene-color-pass')
        if features.get('recursiveModelParticles'):
            # RPID dependency discovery is separate from proof that the adapter retains it.
            expected = assets.ids(parts.get('RPID', b''))
            actual = []
            for emitter in table(adapted, 0x13c, 504):
                n, at = read(emitter, '<II', 32)
                actual.append(span(adapted, at, n).rstrip(b'\0'))
            if any(f'__classic/{value}.m2'.encode() not in actual for value in expected):
                partial.append('unretained-recursive-particle-model')
        record['implementationStatus'] = 'renderable-but-partial' if partial else 'decode-verified'
        record['unverifiedCapabilities'] = partial
        record['gpuExecution'] = 'unverified'
        record['visualApproval'] = 'unverified'
        if not all(checks.values()):
            record['family'] = ','.join(k for k, v in checks.items() if not v)
    except UnsupportedFeatureError as error:
        record.update(status='unsupported', family=str(error), error=str(error))
    except assets.AssetError as error:
        record.update(status='unavailable-dependency', family=str(error).split(':')[0], error=str(error))
    except (CompatError, ValueError, struct.error, OverflowError) as error:
        record.update(status='invalid', family=str(error), error=str(error))
    return record


def summary(records):
    feature_models = Counter()
    for record in records:
        for name, value in record.get('source', {}).get('features', {}).items():
            if not isinstance(value, dict) and value:
                feature_models[name] += 1
    return {'featureModelCounts': dict(feature_models), 'models': len(records), 'statusCounts': dict(Counter(r['status'] for r in records)),
            'families': dict(Counter(r.get('family', r['status']) for r in records)),
            'dependencyStatusCounts': dict(Counter(r.get('dependencyStatus', 'uninspected') for r in records)),
            'implementationStatusCounts': dict(Counter(r.get('implementationStatus', 'unverified') for r in records)),
            'nativeParserStatusCounts': dict(Counter(r.get('nativeParser', {}).get('status', 'unverified') for r in records)),
            'scope': 'catalog-referenced model IDs, direct chunk dependencies and display model textures; offline decode and selected numerical preservation only',
            'rendered': 0, 'visuallyChecked': 0}


def validate_output_location(install, output):
    # Retained metadata roots may point Data at the real installation by symlink.
    data = (install / 'Data').resolve()
    protected = {install.resolve(), data}
    if data.name.lower() == 'data':
        protected.add(data.parent)
    if any(output == path or path in output.parents for path in protected):
        raise ValueError('Audit output must be outside the read-only game installation and its resolved Data storage.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', type=Path, default=assets.DEFAULT_INSTALL)
    parser.add_argument('--library', type=Path, default=assets.DEFAULT_LIBRARY)
    parser.add_argument('--catalog', type=Path, action='append')
    parser.add_argument('--id', type=int, action='append', help='Audit explicit IDs instead of catalogs.')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--recursive', action='store_true', help='Also audit reachable GPID/RPID model files, retaining reference edges.')
    parser.add_argument('--appearances', action='store_true', help='Audit the full character condition graph and legal item/body/slot recipes; include a character catalog.')
    parser.add_argument('--model-manifest', type=Path, action='append', default=[], help='Merge additional identified model roots and named archive paths, retaining associations.')
    parser.add_argument('--native-reader', type=Path, help='Existing compiled production reader probe; never invokes Cargo.')
    parser.add_argument('--native-reader-identity', type=Path, help='Build manifest with exact native binary, source and rlib hashes; required with --native-reader.')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit must be positive.')
    if bool(args.native_reader) != bool(args.native_reader_identity):
        parser.error('--native-reader and --native-reader-identity must be supplied together.')
    for file_id in args.id or []:
        assets.resource(file_id)
    output = args.output.resolve()
    validate_output_location(args.install, output)
    build = assets.client_build(args.install)
    catalogs = [(p, json.loads(p.read_text())) for p in (args.catalog or DEFAULT_CATALOGS)] if not args.id else []
    selected = inventory(catalogs, build) if catalogs else {i: ['explicit'] for i in sorted(set(args.id or []))}
    manifests = [(p, json.loads(p.read_text())) for p in args.model_manifest]
    for _, manifest in manifests:
        merge_model_manifest(selected, manifest, build)
    if args.limit is not None:
        selected = dict(list(selected.items())[:args.limit])
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'identity.json').exists() or (output / 'models.jsonl').exists():
        parser.error('Audit output already contains evidence; select a new run directory.')
    records, cache = [], {}
    expected_roots = len(selected)
    appearance_textures = appearance_dependencies(catalogs)
    started = time.time()
    identity = {'schema': 1, 'source': build, 'offline': True, 'converterSha256': digest(Path(__file__).with_name('classic_compat.py').read_bytes()),
                'auditSha256': digest(Path(__file__).read_bytes()),
                'catalogs': [{'path': str(p), 'sha256': digest(p.read_bytes())} for p, _ in catalogs],
                'modelManifests': [{'path': str(p), 'sha256': digest(p.read_bytes())} for p, _ in manifests],
                'selectedModels': len(selected), 'recursive': args.recursive}
    identity['excludedModelConsumers'] = excluded_model_consumers(catalogs)
    if args.appearances:
        identity['appearanceAuditSha256'] = digest(Path(__file__).with_name('renderer_character_audit.py').read_bytes())
    if args.native_reader:
        identity['nativeReader'] = native_reader_identity(args.native_reader, args.native_reader_identity)
    for index, (path, _) in enumerate(catalogs):
        snapshot = output / f'catalog-{index}.json'
        snapshot.write_bytes(path.read_bytes())
        identity['catalogs'][index]['snapshot'] = str(snapshot)
    assets.atomic_write(output / 'identity.json', json.dumps(identity, indent=2).encode())
    with assets.CascStorage(args.install, args.library) as storage, (output / 'models.jsonl').open('w') as stream, NativeReader(args.native_reader) as native:
        queue = list(selected.items())
        queued = set(selected)
        for index, (file_id, refs) in enumerate(queue, 1):
            record = audit_model(storage, file_id, refs, cache, appearance_textures.get(file_id, ()),
                native.check if native.process else None)
            stream.write(json.dumps(record, allow_nan=False) + '\n')
            stream.flush()
            records.append(record)
            if args.recursive:
                for dep in record['dependencies']:
                    if dep['kind'] in ('GPID', 'RPID') and dep['fileDataID'] not in queued:
                        queued.add(dep['fileDataID'])
                        queue.append((dep['fileDataID'], [f"{dep['kind']}:{file_id}"]))
            if index % 100 == 0:
                print(json.dumps({'checked': index, **summary(records)['statusCounts']}), flush=True)
    result = dict(identity, **summary(records), expectedRootModels=expected_roots,
                  expectedModelsIncludingRecursive=len(queue), processedModels=len(records),
                  completeEnumeration=len(records) == len(queue),
                  uniqueDependencies=len(cache), elapsedSeconds=round(time.time() - started, 2))
    if args.appearances:
        from renderer_character_audit import run as audit_appearances
        with assets.CascStorage(args.install, args.library) as storage:
            result['appearances'] = audit_appearances(storage, build, catalogs, output,
                                                    assets.inspect_asset, assets.AssetError)
    assets.atomic_write(output / 'summary.json', json.dumps(result, indent=2).encode())
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (assets.AssetError, OSError, ValueError) as error:
        print(f'Renderer model audit: {error}', file=sys.stderr)
        sys.exit(1)
