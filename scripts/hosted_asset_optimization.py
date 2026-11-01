"""Local audited pack pruning and the source-grounded Naxxramas WMO extraction.

This module never changes a source pack or a client installation. Callers choose
fresh output directories and explicitly identify any world resources to remove.
"""
from functools import lru_cache
import gzip
import json
from pathlib import Path
import struct

from hosted_assets import ChunkWriter, audit, digest, json_bytes
from classic_compat import CompatError, read
from classic_world import CENTER, World, adapt_wdt, chunks, pack, parts, records, text

NAXX_DIRECTORY = 'stratholme raid'
NAXX_ROOT = '__classic/110251.wmo'
GLOBAL_WMO_UID = 0xffffffff


def naxx_placements(adapted_adts):
    """Find one source placement, deduplicating identical cross-tile MODF rows."""
    found = {}
    for data in adapted_adts:
        value = {tag:body for tag,body in chunks(data) if tag != "MCNK"}
        for offset in records(value.get('MODF', b''), 64):
            row = value['MODF'][offset:offset+64]
            name_index, uid = read(row, '<2I', 0)
            name_offset = read(value.get('MWID', b''), '<I', name_index*4)[0]
            name = text(value.get('MWMO', b''), name_offset).replace('\\', '/').lower()
            if name != NAXX_ROOT:
                continue
            if uid in found and found[uid][4:] != row[4:]:
                raise CompatError('Conflicting duplicate Naxxramas placement')
            found.setdefault(uid, row)
    if len(found) != 1:
        raise CompatError('Expected exactly one unique Naxxramas placement UID')
    return next(iter(found.values()))


def naxx_wdt(wdt_bytes, placement):
    """Move the exact source MODF transform into a standalone global-WMO WDT.

    ADT storage coordinates differ from WDT global coordinates. Match World.map
    and the native placement transform, preserving rotation and source sets.
    """
    source = parts(wdt_bytes)
    if len(placement) != 64:
        raise CompatError('Expected one complete Naxxramas MODF placement')
    row = bytearray(placement)
    struct.pack_into('<2I', row, 0, 110251, GLOBAL_WMO_UID)
    position = read(row, '<3f', 8)
    struct.pack_into('<3f', row, 8, CENTER-position[2], CENTER-position[0], position[1])
    # Extents use the same source position frame. Axis inversion also swaps
    # minimum and maximum endpoints; native rendering currently ignores these.
    lo, hi = read(row, '<3f', 32), read(row, '<3f', 44)
    struct.pack_into('<6f', row, 32, CENTER-hi[2], CENTER-hi[0], lo[1],
                     CENTER-lo[2], CENTER-lo[0], hi[1])
    # Clear ADT's file-ID flag. Global WDT MODF stores a direct file ID until
    # adapt_wdt materializes the MWMO name and its byte offset.
    struct.pack_into('<H', row, 56, read(row, '<H', 56)[0] & ~8)
    mphd = bytearray(source.get('MPHD', b'\0'*32))
    if len(mphd) < 4:
        raise CompatError('Truncated Naxxramas MPHD')
    struct.pack_into('<I', mphd, 0, read(mphd, '<I', 0)[0] | 1)
    return pack({'MVER': source.get('MVER', struct.pack('<I', 18)),
                 'MPHD': bytes(mphd), 'MAIN': b'\0'*(64*64*8), 'MODF': bytes(row)})


def prepare_naxx(world, raw, map_id=533, directory=NAXX_DIRECTORY):
    """Extract Naxx from actual adapted ADTs without modifying the supplied World.

    The returned WDT and map use native GLOBAL_WMO_UID, while all 73 authored
    groups remain available. The whitelist covers converted world resources;
    callers retain raw textures/models discovered by their ordinary dependency
    collector. Source scanning may read exterior ADTs, but never returns them.
    """
    if directory.lower() != NAXX_DIRECTORY or map_id != 533:
        raise CompatError('Naxxramas optimization requires map 533 / Stratholme Raid')
    scan = World(raw)
    scan.map_files = dict(world.map_files)
    scan.liquid_types = world.liquid_types
    source_name = scan.source(f'world/maps/{directory}/{directory}.wdt')
    source_bytes = raw(source_name)
    source_wdt = parts(source_bytes)
    cells = [(x, y) for y in range(64) for x in range(64)
             if read(source_wdt['MAIN'], '<I', (y*64+x)*8)[0] & 1]
    placement = naxx_placements(scan.resource(f'world/maps/{directory}/{directory}_{x}_{y}.adt')
                                for x, y in cells)
    modern = naxx_wdt(source_bytes, placement)
    def wrapped_raw(name):
        return modern if name == source_name else raw(name)
    selected = World(wrapped_raw)
    selected.map_files = dict(world.map_files)
    selected.liquid_types = world.liquid_types
    root = parts(selected.resource(NAXX_ROOT))
    if read(root['MOHD'], '<I', 4)[0] != 73:
        raise CompatError('Expected all 73 authored Naxxramas WMO groups')
    resources = {f'world/maps/{directory}/{directory}.wdt'}
    resource = selected.resource
    def tracked(name):
        resources.add(name)
        return resource(name)
    selected.resource = tracked
    tactical = selected.map(map_id, directory)
    expected = {NAXX_ROOT} | {NAXX_ROOT[:-4]+f'_{group:03}.wmo' for group in range(73)}
    if not expected <= resources:
        raise CompatError('Naxxramas tactical map omitted authored groups')
    return {'wdt': adapt_wdt(modern), 'modernWdt': modern, 'map': tactical,
            'worldResources': sorted(resources), 'sourceUID': read(placement, '<I', 4)[0],
            'sourcePosition': list(read(placement, '<3f', 8)),
            'position': list(read(parts(modern)['MODF'], '<3f', 8))}


def keep_runtime_raw(key, payload, appearance_inputs):
    if key in appearance_inputs:
        return True
    if payload[:4] in (b'BLP1', b'BLP2'):
        return True
    return payload[:4] in (b'\x00\x01\x00\x00', b'OTTO', b'true', b'ttcf')


def repack_hosted_assets(source, destination, replacements=None, excluded_world=None):
    """Audit, prune conversion-only raw bytes, write a fresh pack, then audit it.

    Prepared catalog/model/world/map entries survive by default. Exclusions are
    explicit full world: keys only. Replacement payloads can update the Naxx WDT
    and map while preserving all unrelated entries and manifest metadata.
    """
    source, destination = Path(source), Path(destination)
    if destination.resolve().is_relative_to(source.resolve()):
        raise ValueError('Repacked output must be outside the source pack')
    before = audit(source)
    manifest = json.loads((source/'manifest.json').read_bytes())
    replacements, excluded_world = dict(replacements or {}), set(excluded_world or ())
    if any(not key.startswith('world:') for key in excluded_world):
        raise ValueError('Only explicit world resources may be excluded')
    if set(replacements) & excluded_world:
        raise ValueError('A replaced resource cannot also be excluded')
    if any(not key.startswith(('world:', 'map:')) for key in replacements):
        raise ValueError('Only world/map resources may be replaced')
    if destination.exists():
        raise FileExistsError('Output must be a fresh directory')
    appearance = set(manifest.get('appearanceInputs', []))
    @lru_cache(maxsize=4)
    def chunk(sha):
        compressed = (source/'chunks'/(sha+'.bin.gz')).read_bytes()
        if digest(compressed) != sha:
            raise ValueError('Source chunk changed after audit')
        return gzip.decompress(compressed)
    def resource(entry):
        payload = b''.join(chunk(p['chunk'])[p['offset']:p['offset']+p['length']] for p in entry['parts'])
        if len(payload) != entry['bytes'] or digest(payload) != entry['sha256']:
            raise ValueError('Source resource changed after audit')
        return payload
    writer = ChunkWriter(destination, manifest['build'])
    order = {sha:i for i,sha in enumerate(manifest['chunks'])}
    def locality(key):
        entries = manifest['files'][key]['parts']
        return (order[entries[0]['chunk']], entries[0]['offset'], key) if entries else (-1, 0, key)
    removed = []
    for key in sorted(manifest['files'], key=locality):
        if key in excluded_world:
            removed.append(key); continue
        payload = bytes(replacements.pop(key)) if key in replacements else resource(manifest['files'][key])
        if key.startswith('read:') and not keep_runtime_raw(key, payload, appearance):
            removed.append(key); continue
        writer.add(key, payload)
    for key, payload in sorted(replacements.items()):
        writer.add(key, payload)
    metadata = {key:value for key,value in manifest.items() if key not in ('schema','build','files','chunks','revision')}
    writer.finish(**metadata)
    after = audit(destination)
    return {'before': before, 'after': after, 'removed': sorted(removed),
            'savedBytes': before['bytes']-after['bytes'],
            'savedCompressedBytes': before['compressedBytes']-after['compressedBytes']}
