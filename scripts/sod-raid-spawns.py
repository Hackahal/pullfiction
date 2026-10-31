#!/usr/bin/env python3
"""Generate numeric SoD reference placements from a pinned public source cache.

Reads curated mapping records, never combat-log samples. Unknown world transforms
remain unplaced and unknown Z/facing remain null. Downloads and art are excluded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re

SOURCE_REVISION = "9046aea1a824fa8f8a5caa9c651cad088b826a73"
SOURCE_ROOT = "https://github.com/RaiderIO/keystone.guru"
SOD_VERSION = 10
DUNGEONS = {
    "90": ("gnomeregan_sod", "identity"),
    "531": ("temple_of_ahnqiraj_classic", "rotated"),
    "2856": ("scarlet_enclave", "rotated"),
}
# Independently verified pinned input identities, not values trusted from the cache.
SOURCE_FILES = {'database/seeders/dungeondata/classic/gnomeregan_sod/1/enemies.json': {'gitBlob': '26497849b68fdf871834beb19febbff3cb65fc66',
                                                                        'sha256': 'c3517203b8c333ca9180ace4ec687bad3bdc9f4df8b8eff24738e23b686d6fbd'},
 'database/seeders/dungeondata/classic/gnomeregan_sod/2/enemies.json': {'gitBlob': 'e651eaac76c66c57ac21c3b6bb181396729dd9da',
                                                                        'sha256': 'ced1a1c2659123b5356b74aace2dc5f979bdff21e8573051d934c6aa7d151062'},
 'database/seeders/dungeondata/classic/gnomeregan_sod/3/enemies.json': {'gitBlob': '7ad032952a1a782cfefeb5c6a608e1738a202645',
                                                                        'sha256': 'f84a0cdfb3d040d916f8ed5022be4e3ea531bf2dc533ea7b7a74675e57776dc1'},
 'database/seeders/dungeondata/classic/gnomeregan_sod/4/enemies.json': {'gitBlob': '598e5675f070d0628ad6620a52282d08112655f0',
                                                                        'sha256': '6cb978db01b72f7a01906a3e7b60cf096b8e19736af28ab586a31482d5d18ddb'},
 'database/seeders/dungeondata/classic/scarlet_enclave/1/dungeon_floor_switch_markers.json': {'gitBlob': 'f7e2a3c3fd333ded6c8208e1e47f37c8ca809af4',
                                                                                              'sha256': 'da8942d63756d6cdda25959bc943e6565952fb7576e9231202d4b9bc8ed08dd1'},
 'database/seeders/dungeondata/classic/scarlet_enclave/1/enemies.json': {'gitBlob': 'e4330a29d55683155d4b3c387d709ed40e635d0a',
                                                                         'sha256': '7a694d9bfa80e46c4fa7e6b534a0ad0f60cde41334a2dd282d0f8ed1bf4240d5'},
 'database/seeders/dungeondata/classic/scarlet_enclave/2/dungeon_floor_switch_markers.json': {'gitBlob': '2e146f9bfd03db9065a027f4dbd3a27ee20b622b',
                                                                                              'sha256': '29d9008f80a47831330d10c7d779f87466d055254ddf947ab80da47bc11d6942'},
 'database/seeders/dungeondata/classic/scarlet_enclave/2/enemies.json': {'gitBlob': '8e4c8a0d94105b1047c4fe3436de53568f51feb9',
                                                                         'sha256': '20de5cef5df33cfbcbe90b636eb77262886f2e2967f563d884b4c754ccc9806e'},
 'database/seeders/dungeondata/classic/scarlet_enclave/3/enemies.json': {'gitBlob': '0637a088a01e8ddab3bf3fa98dbe804cbde1a0dc',
                                                                         'sha256': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'},
 'database/seeders/dungeondata/classic/scarlet_enclave/4/enemies.json': {'gitBlob': '172d1e21db0e65bf5e792a2f8d2c940b5b1a46d0',
                                                                         'sha256': '4eab95cf6e2b131172a9f8a7177250b726c870cfc13fbb4ed50aaaa1a10f516c'},
 'database/seeders/dungeondata/classic/scarlet_enclave/5/enemies.json': {'gitBlob': 'cb8841a1056bf8ae4c7fa377ebe93ff68d4b0623',
                                                                         'sha256': 'b3b39cf51c6b9e1de10369adee76aa7e98f2fb476cd52d8bf4644140947af689'},
 'database/seeders/dungeondata/classic/temple_of_ahnqiraj_classic/1/enemies.json': {'gitBlob': 'f819f28d1757e5462f7532e744d421016c8874ee',
                                                                                    'sha256': 'c2fb26728dfcc39f74cd285393e71d01f663fbc25d0a9434cac93cba3e1686a2'},
 'database/seeders/dungeondata/classic/temple_of_ahnqiraj_classic/2/enemies.json': {'gitBlob': '1b3220d88faf0b220803931bfe6947c4b62ba52d',
                                                                                    'sha256': 'd9f885961cc2867cd19684153d38e26a09af3cc3601a9bb45281528af2613ee6'},
 'database/seeders/dungeondata/classic/temple_of_ahnqiraj_classic/3/enemies.json': {'gitBlob': '428d430593e1960f23cc42e8fa7b95da8df748b2',
                                                                                    'sha256': '93fedc932cd3bdff71a44199876466cb38721346f9f4ca33291d1baf70f43687'},
 'database/seeders/dungeondata/dungeons.json': {'gitBlob': '29430d6b0090cae1dface30a9863c4b6b7cd446b',
                                                'sha256': '88e56602b293499a39252fd8277b53d7ff660f964ff12fff954eefd85d4ec892'},
 'database/seeders/dungeondata/mapping_versions.json': {'gitBlob': '17b1271e018a4b4204def9605b324ebd4668b866',
                                                        'sha256': '2283ef63802008f6112e901fec12bb926d95f109fadc78f448da837785e015ad'},
 'database/seeders/dungeondata/npcs.json': {'gitBlob': '44787f534df45e2c933efeb11d42a0a5955180dd',
                                            'sha256': '13175243029791fc3cf27c3188f6c4310f242ae6f06d8905d29dcfa91b89583a'},
 'lang/en_US/npcs.php': {'gitBlob': 'fae48d619f7a3007c110228aefa1209a11f3b701',
                         'sha256': '8994a1b3662435e65ef90ac13ac770015ecec7960e713b59440251aa0a3d2f19'}}


class SourceError(ValueError):
    """The pinned numeric reference source is missing or inconsistent."""


def load_source(source_dir: Path) -> dict[str, bytes]:
    """Check mandatory pinned blobs; also verify a cache manifest when present."""
    manifest_path = source_dir / 'source-manifest.json'
    declared = None
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            raise SourceError('Cannot read the source cache manifest') from error
        if manifest.get('commit') != SOURCE_REVISION:
            raise SourceError('Source manifest does not identify the pinned revision')
        declared = {row['path']: row for row in manifest.get('files', [])}
    result = {}
    for path, approved in SOURCE_FILES.items():
        if declared is not None:
            row = declared.get(path)
            if not row or row.get('sha256') != approved['sha256'] or row.get('blob') != approved['gitBlob']:
                raise SourceError(f'Source manifest identity mismatch: {path}')
        try:
            data = (source_dir / path).read_bytes()
        except OSError as error:
            raise SourceError(f'Missing pinned input: {path}') from error
        digest = hashlib.sha256(data).hexdigest()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()
        if digest != approved['sha256'] or blob != approved['gitBlob']:
            raise SourceError(f'Pinned input content mismatch: {path}')
        result[path] = data
    return result


def npc_names(text: str) -> dict[int, str]:
    """Read numeric names from the source's single-quoted PHP translation table."""
    names = {}
    pattern = r"^\s*(\d+)\s*=>\s*'((?:\\.|[^'\\])*)',?\s*$"
    for entry, quoted in re.findall(pattern, text, re.MULTILINE):
        # PHP single quotes interpret only escaped backslash and apostrophe.
        names[int(entry)] = re.sub(r"\\(['\\])", r'\1', quoted)
    return names


def select_mapping(versions: list[dict], dungeon_id: int) -> dict:
    candidates = [row for row in versions
                  if row['dungeon_id'] == dungeon_id and row['game_version_id'] == SOD_VERSION]
    if not candidates:
        raise SourceError(f'No explicit SoD mapping for dungeon {dungeon_id}')
    return max(candidates, key=lambda row: (row['version'], row['id']))


def finite_number(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def world_position(floor: dict, lat: float, lng: float, axes: str, *, rounding=True) -> list | None:
    """Convert the authored map plane, rejecting missing/degenerate transforms."""
    if not finite_number(lat) or not finite_number(lng):
        raise SourceError('Reference map coordinate is non-finite')
    bounds = [floor.get('ingame_' + key) for key in ('min_x', 'min_y', 'max_x', 'max_y')]
    if not all(finite_number(value) for value in bounds):
        return None
    x0, y0, x1, y1 = bounds
    if x0 == x1 or y0 == y1:
        return None
    x = x0 + (x1 - x0) * (1 - lng / 384)
    y = y0 + (y1 - y0) * (1 + lat / 256)
    if axes == 'rotated':
        x, y = y, -x
    elif axes != 'identity':
        raise SourceError(f'Unsupported coordinate convention: {axes}')
    if not all(math.isfinite(value) and abs(value) < 20000 for value in (x, y)):
        raise SourceError('Reference world position is outside supported bounds')
    return [round(x, 4), round(y, 4), None] if rounding else [x, y, None]


def similarity_registration(source_points: list[list], native_points: list[list]) -> dict:
    """Fit exactly two public map-plane anchors to native XY, without log inputs."""
    if len(source_points) != 2 or len(native_points) != 2:
        raise SourceError('Portal registration requires two paired anchors')
    if not all(len(point) >= 2 and all(finite_number(v) for v in point[:2])
               for point in source_points + native_points):
        raise SourceError('Portal registration anchors must be finite coordinates')
    source = [complex(point[1], point[0]) for point in source_points]  # [lat, lng]
    target = [complex(point[0], point[1]) for point in native_points]
    if abs(source[1] - source[0]) < 1e-9 or abs(target[1] - target[0]) < 1e-9:
        raise SourceError('Portal registration anchors must be distinct')
    scale_rotation = (target[1] - target[0]) / (source[1] - source[0])
    offset = target[0] - scale_rotation * source[0]
    return {'real': scale_rotation.real, 'imaginary': scale_rotation.imag,
            'offsetX': offset.real, 'offsetY': offset.imag}


def registered_position(coefficients: dict, lat: float, lng: float) -> list:
    if not all(finite_number(v) for v in [lat, lng, *coefficients.values()]):
        raise SourceError('Portal registration values must be finite')
    value = complex(coefficients['real'], coefficients['imaginary']) * complex(lng, lat)
    value += complex(coefficients['offsetX'], coefficients['offsetY'])
    if not all(abs(v) < 20000 for v in (value.real, value.imag)):
        raise SourceError('Registered reference position is outside supported bounds')
    return [round(value.real, 4), round(value.imag, 4), None]


def scarlet_floor2_registration(dungeon: dict, mapping_id: int, markers: dict[int, list[dict]]) -> dict:
    floors = {floor['index']: floor for floor in dungeon['floors']}
    current = {marker['id']: marker for rows in markers.values() for marker in rows
               if marker['mapping_version_id'] == mapping_id}
    anchors = []
    # Cross-pair the two authored exits. Adjacent IDs describe different paths.
    for source_id, target_id in [(2027, 2028), (2029, 2026)]:
        try:
            source, target = current[source_id], current[target_id]
        except KeyError as error:
            raise SourceError('Missing paired Scarlet portal marker') from error
        if (source['floor_id'] != floors[2]['id'] or target['floor_id'] != floors[1]['id']
                or source['target_floor_id'] != floors[1]['id'] or target['target_floor_id'] != floors[2]['id']):
            raise SourceError('Scarlet portal markers do not connect the expected floors')
        native = world_position(floors[1], target['lat'], target['lng'], 'rotated', rounding=False)
        if native is None:
            raise SourceError('Scarlet portal target floor has no native bounds')
        anchors.append({'sourceMarkerID': source_id, 'targetMarkerID': target_id,
                        'sourcePosition': [source['lat'], source['lng']],
                        'sourcePercent': [source['lng'] / 384 * 100, -source['lat'] / 256 * 100],
                        'targetPosition': [target['lat'], target['lng']],
                        'targetPercent': [target['lng'] / 384 * 100, -target['lat'] / 256 * 100],
                        'nativePosition': native[:2]})
    coefficients = similarity_registration([a['sourcePosition'] for a in anchors],
                                            [a['nativePosition'] for a in anchors])
    return {'id': 'scarlet-floor2-portals', 'kind': 'portal-registration-approximate',
            'mappingVersion': mapping_id, 'sourceFloor': 2, 'targetFloor': 1,
            'sourceCoordinateSystem': 'Keystone map plane: sourcePosition=[lat,lng], sourcePercent=[horizontal,vertical]',
            'anchors': anchors, 'coefficients': coefficients,
            'uncertainty': 'Approximate portal-registered planning references, not authoritative server spawns. '
                           'All three boss regions are plausible; 37 of 220 points have unresolved local geometry ambiguities.',
            'validation': {'bossLandmarks': 3, 'geometryAmbiguities': 37, 'placementCount': 220,
                           'scope': 'Coarse region plausibility only; exact initial positions are unverified.'}}


def project_map(dungeon: dict, versions: list[dict], npcs: dict[int, dict],
                names: dict[int, str], enemies: dict[int, list[dict]], axes: str,
                registrations: dict[int, dict] | None = None) -> dict:
    mapping = select_mapping(versions, dungeon['id'])
    placements, unplaced = [], []
    source_count = excluded_friendly = 0
    seen = set()
    for floor in sorted(dungeon['floors'], key=lambda row: row['index']):
        for enemy in enemies[floor['index']]:
            if enemy['mapping_version_id'] != mapping['id']:
                continue
            source_count += 1
            if enemy['floor_id'] != floor['id']:
                raise SourceError(f'Enemy {enemy["id"]} belongs to a different source floor')
            if type(enemy['id']) is not int or enemy['id'] <= 0 or enemy['id'] in seen:
                raise SourceError('Reference enemy IDs must be unique positive integers')
            seen.add(enemy['id'])
            entry = enemy['npc_id']
            npc = npcs.get(entry)
            if npc is None:
                raise SourceError(f'Missing NPC metadata for entry {entry}')
            if npc.get('aggressiveness') == 'friendly':
                excluded_friendly += 1
                continue
            display = npc.get('display_id')
            name = names.get(entry)
            if type(display) is not int or display <= 0 or not name:
                raise SourceError(f'Missing NPC display or name for entry {entry}')
            lat, lng = enemy['lat'], enemy['lng']
            position = world_position(floor, lat, lng, axes)
            registration = (registrations or {}).get(floor['index']) if position is None else None
            if registration is not None:
                position = registered_position(registration['coefficients'], lat, lng)
            actor = {'id': str(enemy['id']), 'entry': entry, 'name': name,
                     'displayID': display, 'floor': floor['index']}
            if position is None:
                unplaced.append({**actor, 'sourcePosition': [lat, lng]})
            else:
                placement = {**actor, 'boss': npc.get('classification_id') == 3,
                             'position': position, 'facing': None, 'kind': 'sod-reference'}
                if registration is not None:
                    placement.update({'kind': 'portal-registered-reference',
                                      'confidence': 'portal-registration-approximate',
                                      'registration': registration['id'], 'sourcePosition': [lat, lng]})
                placements.append(placement)
    return {'kind': 'sod-reference', 'mappingVersion': mapping['id'],
            'sourceCount': source_count, 'excludedFriendly': excluded_friendly,
            'placements': sorted(placements, key=lambda row: int(row['id'])),
            'unplaced': sorted(unplaced, key=lambda row: int(row['id'])),
            **({'registrations': list(registrations.values())} if registrations else {})}


def generate(source_dir: Path) -> dict:
    files = load_source(source_dir)
    def table(name):
        return json.loads(files['database/seeders/dungeondata/' + name + '.json'].decode('utf-8'))
    dungeons = table('dungeons')
    versions = table('mapping_versions')
    npcs = {row['id']: row for row in table('npcs')}
    names = npc_names(files['lang/en_US/npcs.php'].decode('utf-8'))
    maps = {}
    for map_id, (key, axes) in DUNGEONS.items():
        dungeon = next((row for row in dungeons if row['key'] == key and row['map_id'] == int(map_id)), None)
        if dungeon is None:
            raise SourceError(f'Missing source dungeon {key} on map {map_id}')
        enemies = {floor['index']: json.loads(files[
            f'database/seeders/dungeondata/classic/{key}/{floor["index"]}/enemies.json'
        ].decode('utf-8')) for floor in dungeon['floors']}
        registrations = None
        if map_id == '2856':
            mapping = select_mapping(versions, dungeon['id'])
            markers = {index: json.loads(files[
                f'database/seeders/dungeondata/classic/{key}/{index}/dungeon_floor_switch_markers.json'
            ].decode('utf-8')) for index in (1, 2)}
            registrations = {2: scarlet_floor2_registration(dungeon, mapping['id'], markers)}
        maps[map_id] = project_map(dungeon, versions, npcs, names, enemies, axes, registrations)
    return {'schema': 1, 'ruleset': 'sod', 'provider': 'Keystone.guru',
            'sourceRevision': SOURCE_REVISION, 'sourceURL': f'{SOURCE_ROOT}/tree/{SOURCE_REVISION}',
            'sourceFiles': [{'path': path, 'sha256': identities['sha256'], 'gitBlob': identities['gitBlob']}
                            for path, identities in sorted(SOURCE_FILES.items())],
            'maps': maps}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True, type=Path, help='Pinned public source checkout or cache; optional manifest is checked when present')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = generate(args.source_dir)
    except (SourceError, OSError, KeyError, ValueError, TypeError) as error:
        parser.exit(1, f'SoD reference generation failed: {error}\n')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
    print(json.dumps({key: {'placed': len(value['placements']), 'unplaced': len(value['unplaced']),
                            'excludedFriendly': value['excludedFriendly']}
                      for key, value in result['maps'].items()}))


if __name__ == '__main__':
    main()
