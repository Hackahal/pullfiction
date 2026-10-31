#!/usr/bin/env python3
"""Stream an identified texture manifest through production CPU BLP decoders.

Only hashes, dimensions and decoder results are saved. This does not render or
certify GPU sampling. The native probe must already exist; no Cargo is invoked.
"""
from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
import sys
import time

SPEC = importlib.util.spec_from_file_location('renderer_model_audit', Path(__file__).with_name('renderer-model-audit.py'))
models = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(models)


def resource_key(row):
    resource = row.get('resource')
    if resource:
        virtual = re.fullmatch(r'__classic/(\d+)\.blp', resource.replace('\\', '/').lower())
        return 'id:' + virtual[1] if virtual else models.assets.resource(resource)
    file = row.get('fileDataID')
    if isinstance(file, bool) or not isinstance(file, int) or file <= 0:
        raise ValueError('Texture manifest requires positive integer fileDataIDs or archive paths.')
    return 'id:' + str(file)


def manifest_rows(path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    seen = set()
    for row in rows:
        resource = resource_key(row)
        if resource in seen:
            raise ValueError(f'Duplicate texture resource {resource}.')
        seen.add(resource)
    return rows


def model_texture_rows(path):
    with path.open() as stream:
        for line in stream:
            model = json.loads(line)
            key = model.get('resource') or 'id:' + str(model['fileDataID'])
            for dependency in model.get('dependencies', []):
                if dependency['kind'] in ('TXID', 'appearance-texture') or str(dependency.get('format', '')).startswith('BLP'):
                    yield {'fileDataID': dependency['fileDataID'], 'sha256': dependency.get('sha256'),
                        'bytes': dependency.get('bytes'), 'references': [f'{path}:{key}:{dependency["kind"]}']}
            for resource in model.get('nativeParser', {}).get('texturePaths', []):
                yield {'resource': resource, 'references': [f'{path}:{key}:native-texture-path']}


def merge_rows(rows):
    result = {}
    for row in rows:
        resource = resource_key(row)
        if resource not in result:
            result[resource] = dict(row, resource=resource, references=[])
        target = result[resource]
        if target.get('sha256') and row.get('sha256') and target['sha256'] != row['sha256']:
            raise ValueError(f'Texture source hashes disagree for {resource}.')
        if row.get('sha256'): target['sha256'] = row['sha256']
        if row.get('header'): target['header'] = row['header']
        target['references'].extend(row.get('references', []))
    for row in result.values(): row['references'] = sorted(set(row['references']))
    return [result[key] for key in sorted(result)]


def audit_texture(storage, expected, native_reader, cache=None):
    resource = resource_key(expected)
    row = {'resource': resource, 'references': expected.get('references', [])}
    if resource.startswith('id:'): row['fileDataID'] = int(resource[3:])
    try:
        raw = storage.read(resource)
    except models.assets.AssetError as error:
        return dict(row, status='unavailable', error=str(error))
    row.update(sha256=models.digest(raw), bytes=len(raw))
    if expected.get('sha256') and row['sha256'] != expected['sha256']:
        return dict(row, status='source-mismatch', expectedSha256=expected['sha256'])
    row['sourceHashCheck'] = 'matched' if expected.get('sha256') else 'fresh-source-read'
    if not raw.startswith(b'BLP2'):
        return dict(row, status='unexpected-format')
    try:
        header, _ = models.assets.inspect_asset(raw)
        row['header'] = header
    except models.assets.AssetError as error:
        return dict(row, status='invalid-header', error=str(error))
    reused = cache is not None and row['sha256'] in cache
    decoded = cache[row['sha256']] if reused else native_reader(raw)
    if cache is not None: cache[row['sha256']] = decoded
    row['nativeDecodeReused'] = reused
    row['nativeDecoder'] = decoded
    row['status'] = decoded.get('status', 'invalid-native-response')
    if row['status'] == 'decoded':
        expected_header = expected.get('header') or header
        if decoded.get('assetType') != 'texture' or not decoded.get('mips', 0) \
            or decoded.get('width') != header.get('width') \
            or decoded.get('height') != header.get('height') \
            or expected_header.get('width', decoded['width']) != decoded['width'] \
            or expected_header.get('height', decoded['height']) != decoded['height'] \
            or decoded.get('rgbaBytes', 0) < decoded['width'] * decoded['height'] * 4:
            row.update(status='invalid-native-response', error='Native texture identity, dimensions or byte count disagrees with manifest.')
    return row


def texture_native_identity(executable, identity_path):
    models.native_reader_identity(executable, identity_path,
        required_libraries=('benilla_blp', 'serde_json'))
    return json.loads(identity_path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', type=Path, required=True)
    parser.add_argument('--library', type=Path, default=models.assets.DEFAULT_LIBRARY)
    parser.add_argument('--manifest', type=Path, action='append', default=[])
    parser.add_argument('--model-audit', type=Path, action='append', default=[], help='Union all typed TXID/appearance/BLP dependencies and native texture paths.')
    parser.add_argument('--source-identity', type=Path, required=True)
    parser.add_argument('--native-reader', type=Path, required=True)
    parser.add_argument('--native-identity', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.manifest and not args.model_audit:
        parser.error('Supply at least one texture manifest or model audit.')
    output = args.output.resolve()
    models.validate_output_location(args.install, output)
    source = models.assets.client_build(args.install)
    if json.loads(args.source_identity.read_text()).get('source') != source:
        parser.error('Texture manifest source disagrees with selected client.')
    native_identity = texture_native_identity(args.native_reader, args.native_identity)
    inputs = [*args.manifest, *args.model_audit]
    for path in inputs:
        sidecar = path.with_suffix('.json') if path.with_suffix('.json').exists() else path.parent / 'identity.json'
        if sidecar.exists():
            identity = json.loads(sidecar.read_text())
            if identity.get('source') and identity['source'] != source:
                parser.error(f'Texture input source disagrees with selected client: {path}')
    rows = merge_rows([row for path in args.manifest for row in manifest_rows(path)] +
                      [row for path in args.model_audit for row in model_texture_rows(path)])
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'identity.json').exists() or (output / 'textures.jsonl').exists():
        parser.error('Audit output already contains evidence; select a new run directory.')
    identity = {'schema': 1, 'source': source, 'offline': True,
        'inputs': [{'path':str(path.resolve()), 'sha256':models.digest(path.read_bytes())} for path in inputs],
        'sourceIdentitySha256': models.digest(args.source_identity.read_bytes()),
        'auditSha256': models.digest(Path(__file__).read_bytes()),
        'nativeReader': dict(native_identity, path=str(args.native_reader.resolve())),
        'expected': len(rows), 'expectedResources': len(rows),
        'expectedKnownContentHashes': len({row['sha256'] for row in rows if row.get('sha256')}),
        'resourcesWithoutPriorSourceHash': sum(not row.get('sha256') for row in rows),
        'gpuExecution': 'unverified', 'visualApproval': 'unverified',
        'proofBoundary': 'Production CPU BLP decoding and native-block parsing. No GPU upload, sampling, visual inspection or multi-item outfit acceptance.'}
    (output / 'identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    counts, texels = Counter(), Counter()
    native_cache, aliases = {}, {}
    rgba_bytes = native_bytes = 0
    started = time.monotonic()
    with models.assets.CascStorage(args.install, args.library) as storage, \
        models.NativeReader(args.native_reader) as native, (output / 'textures.jsonl').open('w') as stream:
        for index, expected in enumerate(rows, 1):
            row = audit_texture(storage, expected, native.check, native_cache)
            counts[row['status']] += 1
            if row['status'] == 'decoded':
                decoded = row['nativeDecoder']
                if not row['nativeDecodeReused']:
                    texels[decoded['nativeTexels']] += 1
                    rgba_bytes += decoded['rgbaBytes']
                    native_bytes += decoded['nativeBytes']
            identity_key = 'sha256:' + row['sha256'] if row.get('sha256') else row['resource']
            group = aliases.setdefault(identity_key, {'id':identity_key, 'status':row['status'], 'resources':[], 'references':set(), 'resourceStatus':Counter()})
            group['resourceStatus'][row['status']] += 1
            if len(group['resourceStatus']) > 1: group['status'] = 'partial'
            group['resources'].append(row['resource'])
            group['references'].update(row['references'])
            stream.write(json.dumps(row, allow_nan=False, separators=(',', ':')) + '\n')
            if index % 1000 == 0:
                stream.flush()
                print(json.dumps({'checked': index, 'statusCounts': dict(counts)}), flush=True)
    result = dict(identity, processed=sum(counts.values()), statusCounts=dict(counts),
        processedResources=sum(counts.values()), uniqueContentHashes=sum(k.startswith('sha256:') for k in aliases),
        uniqueNativeAssetsProcessed=len(native_cache),
        uniqueNativeStatus=dict(Counter(row['status'] for row in native_cache.values())),
        nativeTexels=dict(texels), rgbaBytesDecoded=rgba_bytes, nativeBytesParsed=native_bytes,
        completeEnumeration=sum(counts.values()) == len(rows), elapsedSeconds=round(time.monotonic() - started, 2))
    with (output / 'assets.jsonl').open('w') as stream:
        for group in aliases.values():
            group['references'] = sorted(group['references'])
            stream.write(json.dumps(group, separators=(',', ':')) + '\n')
    (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (models.assets.AssetError, OSError, ValueError) as error:
        print(f'Renderer texture audit: {error}', file=sys.stderr)
        sys.exit(1)
