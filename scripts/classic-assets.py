#!/usr/bin/env python3
"""Read an official Classic install into a build-specific, local-only asset cache.

No archive data is downloaded. CascLib is opened offline with strict validation.
Raw modern files are deliberately not presented as 1.12-compatible assets.
"""
from __future__ import annotations

import argparse
import csv
import ctypes as ct
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile

from classic_db2 import DB2Error, creature_catalog

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LIBRARY = ROOT / '.agent/tools/casclib/build/casc.framework/casc'
DEFAULT_INSTALL = Path('/Applications/World of Warcraft')
SCHEMA = 1
MAX_FILE_BYTES = 256 * 1024 * 1024
PRESET = [
    'World/Maps/MoltenCore/MoltenCore.wdt',
    'Creature/Ragnaros/Ragnaros.m2',
    'Character/Gnome/Female/GnomeFemale.m2',
    'Interface/Icons/Spell_Fire_Fire.blp',
    'DBFilesClient/Map.db2',
    'DBFilesClient/CreatureDisplayInfo.db2',
    'DBFilesClient/CreatureModelData.db2',
    'DBFilesClient/SpellName.db2',
]


class AssetError(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def client_build(install: Path) -> dict:
    """Select the active Era product, never a Retail/other Classic build sharing Data."""
    try:
        rows = csv.DictReader((install / '.build.info').read_text().splitlines(), delimiter='|')
        rows = [{k.split('!')[0]: v for k, v in r.items() if k} for r in rows]
    except (OSError, UnicodeError) as e:
        raise AssetError(f'Cannot read .build.info in {install}: {e}') from e
    matches = [r for r in rows if r.get('Active') == '1' and r.get('Product') == 'wow_classic_era']
    if len(matches) != 1:
        raise AssetError('Expected exactly one active wow_classic_era build in .build.info.')
    row = matches[0]
    version, key = row.get('Version', ''), row.get('Build Key', '')
    if not version.startswith('1.15.9.') or len(key) != 32 or any(c not in '0123456789abcdef' for c in key.lower()):
        raise AssetError(f'Unsupported installed build {version!r}; this pipeline targets 1.15.9.')
    return {'product': 'wow_classic_era', 'version': version, 'buildKey': key.lower()}


def resource(value: str | int) -> str:
    if isinstance(value, int) or str(value).startswith('id:'):
        try:
            number = int(str(value).removeprefix('id:'))
        except ValueError as e:
            raise AssetError(f'Invalid file data ID: {value}') from e
        if not 0 < number < 0xFFFFFFFF:
            raise AssetError(f'Invalid file data ID: {value}')
        return f'id:{number}'
    name = str(value).replace('\\', '/').lower()
    if not name or any(p in ('', '.', '..') for p in name.split('/')) or any(c in name for c in '\0:*'):
        raise AssetError(f'Invalid archive name: {value!r}')
    return name


class CascStorage:
    """One offline CascLib storage; handles close even when validation/read fails."""
    def __init__(self, install: Path, library: Path):
        try:
            self.lib = ct.CDLL(str(library.resolve()))
        except OSError as e:
            raise AssetError(f'Cannot load CascLib at {library}. Run scripts/classic-setup.sh first, or pass --library.') from e
        signatures = {
            'CascOpenStorage': ([ct.c_char_p, ct.c_uint32, ct.POINTER(ct.c_void_p)], ct.c_bool),
            'CascOpenFile': ([ct.c_void_p, ct.c_void_p, ct.c_uint32, ct.c_uint32, ct.POINTER(ct.c_void_p)], ct.c_bool),
            'CascGetFileSize64': ([ct.c_void_p, ct.POINTER(ct.c_uint64)], ct.c_bool),
            'CascReadFile': ([ct.c_void_p, ct.c_void_p, ct.c_uint32, ct.POINTER(ct.c_uint32)], ct.c_bool),
            'CascCloseFile': ([ct.c_void_p], ct.c_bool),
            'CascCloseStorage': ([ct.c_void_p], ct.c_bool),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.handle = ct.c_void_p()
        # CascOpenStorage (not OnlineStorage): no online/allow-download flags.
        params = os.fsencode(str(install.resolve()) + '*wow_classic_era')
        if not self.lib.CascOpenStorage(params, 2, ct.byref(self.handle)):
            raise AssetError('Cannot open local Classic Era storage. Finish its Battle.net download first.')

    def read(self, name: str) -> bytes:
        handle = ct.c_void_p()
        by_id = name.startswith('id:')
        encoded = name.replace('/', '\\').encode() if not by_id else None
        arg = ct.c_void_p(int(name[3:])) if by_id else ct.cast(ct.c_char_p(encoded), ct.c_void_p)
        # Strict data check, never CASC_OVERCOME_ENCRYPTED, which returns fabricated zero bytes.
        if not self.lib.CascOpenFile(self.handle, arg, 2, 0x10 | (3 if by_id else 0), ct.byref(handle)):
            raise AssetError(f'Asset is missing or unavailable locally: {name}')
        try:
            size = ct.c_uint64()
            if not self.lib.CascGetFileSize64(handle, ct.byref(size)) or size.value > MAX_FILE_BYTES:
                raise AssetError(f'Invalid or oversized archive file: {name}')
            data = ct.create_string_buffer(size.value)
            count = ct.c_uint32()
            if not self.lib.CascReadFile(handle, data, size.value, ct.byref(count)) or count.value != size.value:
                raise AssetError(f'Incomplete, encrypted, or corrupt local asset: {name}')
            return data.raw[:count.value]
        finally:
            self.lib.CascCloseFile(handle)

    def close(self):
        if self.handle:
            self.lib.CascCloseStorage(self.handle)
            self.handle = ct.c_void_p()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise AssetError('Truncated binary field.')
    return struct.unpack_from('<I', data, offset)[0]


def array(data: bytes, offset: int, stride: int) -> tuple[int, int]:
    count, start = u32(data, offset), u32(data, offset + 4)
    if start + count * stride > len(data):
        raise AssetError('Binary array extends beyond the asset.')
    return count, start


def chunks(data: bytes, reverse: bool = False) -> dict[str, bytes]:
    result = {}
    cursor = 0
    while cursor < len(data):
        if cursor + 8 > len(data):
            raise AssetError('Truncated chunk header.')
        raw, size = data[cursor:cursor + 4], u32(data, cursor + 4)
        end = cursor + 8 + size
        if end > len(data):
            raise AssetError('Chunk extends beyond the asset.')
        try:
            tag = (raw[::-1] if reverse else raw).decode('ascii')
        except UnicodeError as e:
            raise AssetError('Invalid chunk tag.') from e
        if tag in result:
            raise AssetError(f'Duplicate chunk {tag}.')
        result[tag] = data[cursor + 8:end]
        cursor = end
    return result


def ids(data: bytes, stride: int = 4, offset: int = 0) -> list[int]:
    if len(data) % stride:
        raise AssetError('Misaligned file ID table.')
    return [n for p in range(offset, len(data), stride) if (n := u32(data, p))]


def inspect_asset(data: bytes) -> tuple[dict, list[str]]:
    """Inspect format and discover structural dependencies, without guessing display skins.

    Layout references: WoW-Tools/wow.export M2Loader/WMOLoader and wowdev format
    documentation. ID 0 means replaceable/absent and must not be opened as a file.
    """
    magic = data[:4]
    info, dependencies = {'format': magic.decode('ascii', errors='replace')}, []
    if magic == b'MD21':
        parts = chunks(data)
        model = parts.get('MD21', b'')
        if model[:4] != b'MD20' or u32(model, 4) != 274:
            raise AssetError('Expected Classic 1.15.9 MD21 model version 274.')
        vertices, _ = array(model, 0x3C, 48)
        bones, _ = array(model, 0x2C, 88)
        sequences, _ = array(model, 0x1C, 64)
        textures, _ = array(model, 0x50, 16)
        views = u32(model, 0x44)
        skin_ids = ids(parts.get('SFID', b''))
        if len(skin_ids) < views:
            raise AssetError('Model is missing its external skin IDs.')
        info.update(version=274, vertices=vertices, bones=bones, sequences=sequences,
                    views=views, replaceableTextures=sum(u32(model, array(model, 0x50, 16)[1] + i * 16) != 0 for i in range(textures)),
                    chunks=list(parts))
        for tag in ('SFID', 'TXID', 'SKID', 'BFID'):
            dependencies.extend(ids(parts.get(tag, b'')))
        dependencies.extend(ids(parts.get('AFID', b''), 8, 4))
    elif magic == b'REVM':
        parts = chunks(data, reverse=True)
        info.update(format='WDT' if 'MAIN' in parts else 'WMO', version=u32(parts.get('MVER', b''), 0), chunks=list(parts))
        if 'MAIN' in parts:
            if len(parts['MAIN']) != 64 * 64 * 8:
                raise AssetError('Invalid WDT tile table.')
            flags = u32(parts.get('MPHD', b''), 0)
            info.update(terrainTiles=sum(bool(u32(parts['MAIN'], p) & 1) for p in range(0, len(parts['MAIN']), 8)), globalWmo=bool(flags & 1))
            # Modern MAIN tile addresses are replaced by MAID's eight file IDs per tile.
            if 'MAID' in parts:
                if len(parts['MAID']) != 64 * 64 * 32:
                    raise AssetError('Invalid WDT MAID table.')
                dependencies.extend(ids(parts['MAID']))
            if flags & 1 and flags & 0x200:
                modf = parts.get('MODF', b'')
                if len(modf) != 64:
                    raise AssetError('Invalid global WMO placement.')
                dependencies.append(u32(modf, 0))
        elif 'MOHD' in parts:
            info.update(groups=u32(parts['MOHD'], 4), materials=u32(parts['MOHD'], 0))
            dependencies.extend(ids(parts.get('GFID', b'')))
            dependencies.extend(ids(parts.get('MODI', b'')))
            # Modern WMO texture fields are file IDs if MOTX is absent.
            materials = parts.get('MOMT', b'')
            if len(materials) % 64:
                raise AssetError('Invalid WMO material table.')
            if 'MOTX' not in parts:
                for p in range(0, len(materials), 64):
                    dependencies.extend(u32(materials, p + o) for o in (12, 24, 36) if u32(materials, p + o))
        elif 'MOGP' in parts:
            group = parts['MOGP']
            if len(group) < 68:
                raise AssetError('Truncated WMO group.')
            nested = chunks(group[68:], reverse=True)
            info.update(format='WMO-group', vertices=len(nested.get('MOVT', b'')) // 12,
                        triangles=len(nested.get('MOVI', b'')) // 6)
        else:
            info['format'] = 'ADT-or-world-chunks'
    elif magic == b'BLP2':
        info.update(width=u32(data, 12), height=u32(data, 16), encoding=data[8], alphaDepth=data[9])
        if len(data) < 148 or not info['width'] or not info['height']:
            raise AssetError('Invalid BLP2 header.')
        for p in range(16):
            start, size = u32(data, 20 + p * 4), u32(data, 84 + p * 4)
            if start + size > len(data):
                raise AssetError('Truncated BLP2 mip.')
    elif magic == b'WDC5':
        # WDC5 adds schema version + 128-byte schema name before the WDC4-style header.
        if len(data) < 204:
            raise AssetError('Truncated WDC5 header.')
        info.update(schemaVersion=u32(data, 4), records=u32(data, 136), fields=u32(data, 140),
                    recordSize=u32(data, 144), layoutHash=f'{u32(data, 156):08x}')
    elif magic == b'SKIN':
        vertices, _ = array(data, 4, 2)
        indices, _ = array(data, 12, 2)
        sections, _ = array(data, 28, 48)
        batches, _ = array(data, 36, 24)
        info.update(vertices=vertices, triangles=indices // 3, sections=sections, batches=batches)
    return info, [resource(n) for n in dict.fromkeys(dependencies) if n]


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.partial-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def prepare(storage, build: dict, roots: list[str], output: Path, max_files=5000, max_bytes=2 * 1024**3, catalog=None) -> dict:
    """Publish a manifest only after every discovered dependency has been read successfully."""
    root_names = list(dict.fromkeys(resource(n) for n in roots))
    pending, entries, total = root_names.copy(), {}, 0
    while pending:
        name = pending.pop(0)
        if name in entries:
            continue
        if len(entries) >= max_files:
            raise AssetError(f'Preparation exceeds {max_files} files. No manifest published.')
        data = storage.read(name)
        total += len(data)
        if total > max_bytes:
            raise AssetError(f'Preparation exceeds {max_bytes} bytes. No manifest published.')
        info, deps = inspect_asset(data)
        sha = digest(data)
        blob = f'objects/{sha[:2]}/{sha}'
        destination = output / blob
        if not destination.is_file() or digest(destination.read_bytes()) != sha:
            atomic_write(destination, data)
        entries[name] = {'sha256': sha, 'bytes': len(data), 'object': blob, 'info': info, 'dependencies': deps}
        pending.extend(n for n in deps if n not in entries)
    manifest = {'schema': SCHEMA, 'source': build, 'roots': root_names, 'files': entries,
                'bytes': total, 'rendererReady': False,
                'remaining': ['Modern M2 tracks, skins and materials', 'WDC5 catalog decoding',
                              'Modern terrain/WMO dependency integration', 'Modern UI compatibility']}
    if catalog is not None:
        catalog_bytes = (json.dumps(catalog, separators=(',', ':')) + '\n').encode()
        atomic_write(output / 'creatures.json', catalog_bytes)
        manifest['catalogs'] = {'creatures': {'path': 'creatures.json', 'sha256': digest(catalog_bytes)}}
    atomic_write(output / 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())
    return manifest


def verify_cache(output: Path) -> dict:
    try:
        manifest = json.loads((output / 'manifest.json').read_text())
        if manifest['schema'] != SCHEMA:
            raise AssetError('Unsupported asset manifest schema.')
        for name, entry in manifest['files'].items():
            resource(name)
            expected = f"objects/{entry['sha256'][:2]}/{entry['sha256']}"
            if entry['object'] != expected or len(entry['sha256']) != 64 or any(c not in '0123456789abcdef' for c in entry['sha256']):
                raise AssetError(f'Invalid object path: {name}')
            data = (output / expected).read_bytes()
            if len(data) != entry['bytes'] or digest(data) != entry['sha256']:
                raise AssetError(f'Corrupt cached asset: {name}')
            if inspect_asset(data) != (entry['info'], entry['dependencies']):
                raise AssetError(f'Cached format/dependency mismatch: {name}')
            if any(d not in manifest['files'] for d in entry['dependencies']):
                raise AssetError(f'Missing cached dependency: {name}')
        if any(r not in manifest['files'] for r in manifest['roots']):
            raise AssetError('Missing root asset.')
        if 'catalogs' in manifest:
            entry = manifest['catalogs']['creatures']
            if entry['path'] != 'creatures.json' or digest((output / 'creatures.json').read_bytes()) != entry['sha256']:
                raise AssetError('Corrupt creature catalog.')
            def table(name):
                return (output / manifest['files']['dbfilesclient/' + name + '.db2']['object']).read_bytes()
            expected = creature_catalog(table('creaturedisplayinfo'), table('creaturemodeldata'))
            if json.loads((output / 'creatures.json').read_text()) != json.loads(json.dumps(expected)):
                raise AssetError('Creature catalog does not match source databases.')
        return manifest
    except (OSError, KeyError, ValueError, TypeError) as e:
        raise AssetError(f'Invalid asset cache: {e}') from e


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inspect', 'prepare', 'verify'])
    parser.add_argument('assets', nargs='*', help='Internal paths or id:12345; defaults to the MC preparation set')
    parser.add_argument('--display', type=int, action='append', help='Prepare model and texture variants for this display ID; default MC set includes Ragnaros 11121')
    parser.add_argument('--install', type=Path, default=DEFAULT_INSTALL)
    parser.add_argument('--library', type=Path, default=DEFAULT_LIBRARY)
    parser.add_argument('--output', type=Path, help='Cache directory outside the install; default is build-specific local state')
    args = parser.parse_args()
    if args.command == 'verify':
        if not args.output:
            parser.error('verify requires --output')
        manifest = verify_cache(args.output)
    else:
        build = client_build(args.install)
        output = (args.output or ROOT / 'benilla-config/classic-assets' / f"{build['version']}-{build['buildKey']}").resolve()
        if output == args.install.resolve() or args.install.resolve() in output.parents:
            raise AssetError('Cache output must be outside the read-only game installation.')
        with CascStorage(args.install, args.library) as storage:
            if args.command == 'inspect':
                for name in args.assets or PRESET:
                    data = storage.read(resource(name))
                    info, deps = inspect_asset(data)
                    print(json.dumps({'name': resource(name), 'bytes': len(data), **info, 'dependencies': deps}))
                return
            # Build metadata must remain unchanged for the full extraction.
            class StableStorage:
                def read(self, name):
                    if client_build(args.install) != build:
                        raise AssetError('The installed build changed during preparation. Retry after Battle.net finishes.')
                    return storage.read(name)
            source = StableStorage()
            roots = list(args.assets or PRESET)
            catalog = None
            selected_displays = args.display or ([11121] if not args.assets else [])
            if selected_displays:
                tables = ['DBFilesClient/CreatureDisplayInfo.db2', 'DBFilesClient/CreatureModelData.db2']
                catalog = creature_catalog(*(source.read(resource(name)) for name in tables))
                roots.extend(tables)
                for display_id in selected_displays:
                    display = catalog['displays'].get(display_id)
                    if display is None:
                        raise AssetError(f'Display ID {display_id} does not exist in the installed client.')
                    roots.append(resource(catalog['models'][display['modelID']]['fileDataID']))
                    roots.extend(resource(n) for n in display['textures'] if n)
            manifest = prepare(source, build, roots, output, catalog=catalog)
        print(f'Cache: {output}')
    print(f"{manifest['source']['version']}: {len(manifest['files'])} assets, {manifest['bytes']:,} bytes; hashes and dependencies complete.")
    print('Raw modern assets prepared. Renderer migration is not yet complete.')


if __name__ == '__main__':
    try:
        main()
    except (AssetError, DB2Error) as error:
        print(f'Classic assets: {error}', file=sys.stderr)
        sys.exit(1)
