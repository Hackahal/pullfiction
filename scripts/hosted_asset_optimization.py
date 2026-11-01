"""Local audited pack pruning and source-grounded standalone raid extraction.

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
from classic_world import CENTER, World, adapt_wdt, adapt_wmo_group, chunks, pack, parts, records, text

NAXX_DIRECTORY = 'stratholme raid'
NAXX_ROOT = '__classic/110251.wmo'
GLOBAL_WMO_UID = 0xffffffff
STANDALONE_RAIDS = {
    469: {"directory":"blackwinglair", "root":108348, "groups":24, "name":"Blackwing Lair"},
    533: {"directory":NAXX_DIRECTORY, "root":110251, "groups":73, "name":"Naxxramas"},
}
# Current runtime readers rebuild collision from MOVT/MOVI/MOPY, not the source
# BSP. MPY2 is redundant only after its validated MOPY conversion. Preserve all
# unlisted chunks, including unknown chunks and repeated UV/color layers.
UNUSED_GROUP_TABLES = frozenset(("MOBN", "MOBR", "MPY2"))


def standalone_placements(adapted_adts, root, label):
    """Find one source placement, deduplicating identical cross-tile MODF rows."""
    found = {}
    for data in adapted_adts:
        value = {tag:body for tag,body in chunks(data) if tag != "MCNK"}
        for offset in records(value.get('MODF', b''), 64):
            row = value['MODF'][offset:offset+64]
            name_index, uid = read(row, '<2I', 0)
            name_offset = read(value.get('MWID', b''), '<I', name_index*4)[0]
            name = text(value.get('MWMO', b''), name_offset).replace('\\', '/').lower()
            if name != root:
                continue
            if uid in found and found[uid][4:] != row[4:]:
                raise CompatError('Conflicting duplicate '+label+' placement')
            found.setdefault(uid, row)
    if len(found) != 1:
        raise CompatError('Expected exactly one unique '+label+' placement UID')
    return next(iter(found.values()))


def standalone_wdt(wdt_bytes, placement, root_id):
    """Move an exact source MODF transform into a standalone global-WMO WDT.

    ADT storage coordinates differ from WDT global coordinates. Match World.map
    and the native placement transform, preserving rotation and source sets.
    """
    source = parts(wdt_bytes)
    if len(placement) != 64:
        raise CompatError('Expected one complete raid MODF placement')
    row = bytearray(placement)
    struct.pack_into('<2I', row, 0, root_id, GLOBAL_WMO_UID)
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
        raise CompatError('Truncated raid MPHD')
    struct.pack_into('<I', mphd, 0, read(mphd, '<I', 0)[0] | 1)
    return pack({'MVER': source.get('MVER', struct.pack('<I', 18)),
                 'MPHD': bytes(mphd), 'MAIN': b'\0'*(64*64*8), 'MODF': bytes(row)})


def prepare_standalone(world, raw, map_id, directory):
    """Extract an explicitly audited raid root without changing the supplied World.

    The returned WDT and map use native GLOBAL_WMO_UID, while all authored
    groups remain available. The whitelist covers converted world resources;
    callers retain raw textures/models discovered by their ordinary dependency
    collector. Source scanning may read exterior ADTs, but never returns them.
    """
    config = STANDALONE_RAIDS.get(map_id)
    if not config or directory.lower() != config['directory']:
        raise CompatError('Unsupported standalone raid map/directory')
    root_name = '__classic/'+str(config['root'])+'.wmo'
    scan = World(raw)
    scan.map_files = dict(world.map_files)
    scan.liquid_types = world.liquid_types
    source_name = scan.source(f'world/maps/{directory}/{directory}.wdt')
    source_bytes = raw(source_name)
    source_wdt = parts(source_bytes)
    cells = [(x, y) for y in range(64) for x in range(64)
             if read(source_wdt['MAIN'], '<I', (y*64+x)*8)[0] & 1]
    placement = standalone_placements(
        (scan.resource(f'world/maps/{directory}/{directory}_{x}_{y}.adt') for x, y in cells),
        root_name, config['name'])
    modern = standalone_wdt(source_bytes, placement, config['root'])
    def wrapped_raw(name):
        return modern if name == source_name else raw(name)
    selected = World(wrapped_raw)
    selected.map_files = dict(world.map_files)
    selected.liquid_types = world.liquid_types
    root = parts(selected.resource(root_name))
    if read(root['MOHD'], '<I', 4)[0] != config['groups']:
        raise CompatError('Unexpected authored group count for '+config['name'])
    resources = {f'world/maps/{directory}/{directory}.wdt'}
    resource = selected.resource
    def tracked(name):
        resources.add(name)
        return resource(name)
    selected.resource = tracked
    tactical = selected.map(map_id, directory)
    expected = {root_name} | {root_name[:-4]+f'_{group:03}.wmo' for group in range(config['groups'])}
    if not expected <= resources:
        raise CompatError('Standalone tactical map omitted authored groups')
    return {'wdt': adapt_wdt(modern), 'modernWdt': modern, 'map': tactical,
            'worldResources': sorted(resources), 'sourceUID': read(placement, '<I', 4)[0],
            'sourcePosition': list(read(placement, '<3f', 8)),
            'position': list(read(parts(modern)['MODF'], '<3f', 8))}



def naxx_placements(adapted_adts):
    return standalone_placements(adapted_adts, NAXX_ROOT, 'Naxxramas')


def naxx_wdt(wdt_bytes, placement):
    return standalone_wdt(wdt_bytes, placement, STANDALONE_RAIDS[533]['root'])


def prepare_naxx(world, raw, map_id=533, directory=NAXX_DIRECTORY):
    if map_id != 533 or directory.lower() != NAXX_DIRECTORY:
        raise CompatError('Naxxramas optimization requires map 533 / Stratholme Raid')
    return prepare_standalone(world, raw, map_id, directory)


def trim_wmo_group(data):
    """Drop only audited non-runtime tables; keep every other chunk byte-for-byte.

    Reject MPY2 without an already matching converted MOPY. Re-running the
    existing adapter validates modern sentinel/material semantics too, without
    silently repairing an unconverted resource during optimization.
    """
    value = parts(data)
    if 'MOGP' not in value:
        return data
    group = value['MOGP']
    if len(group) < 68:
        raise CompatError('Truncated WMO group header')
    children = list(chunks(group[68:]))
    if any(tag == 'MPY2' for tag, _ in children):
        if not any(tag == 'MOPY' for tag, _ in children) or adapt_wmo_group(data, value) != data:
            raise CompatError('WMO group is not already normalized for the runtime')
    if not any(tag in UNUSED_GROUP_TABLES for tag, _ in children):
        return data
    value['MOGP'] = group[:68] + b''.join(pack({tag:body}) for tag,body in children
                                          if tag not in UNUSED_GROUP_TABLES)
    return pack(value)


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
    group_tables = {"files":0, "savedBytes":0}
    for key in sorted(manifest['files'], key=locality):
        if key in excluded_world:
            removed.append(key); continue
        payload = bytes(replacements.pop(key)) if key in replacements else resource(manifest['files'][key])
        if key.startswith('read:') and not keep_runtime_raw(key, payload, appearance):
            removed.append(key); continue
        if key.startswith('world:') and key.endswith('.wmo'):
            trimmed = trim_wmo_group(payload)
            if trimmed != payload:
                group_tables['files'] += 1
                group_tables['savedBytes'] += len(payload)-len(trimmed)
            payload = trimmed
        writer.add(key, payload)
    for key, payload in sorted(replacements.items()):
        writer.add(key, payload)
    metadata = {key:value for key,value in manifest.items() if key not in ('schema','build','files','chunks','revision')}
    writer.finish(**metadata)
    after = audit(destination)
    return {'before': before, 'after': after, 'removed': sorted(removed),
            'groupTables':group_tables, 'savedBytes': before['bytes']-after['bytes'],
            'savedCompressedBytes': before['compressedBytes']-after['compressedBytes']}
