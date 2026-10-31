"""Modern creature catalog for the original renderer, from pinned named DB2 fields.

The existing displays/models shape remains usable by catalog consumers. Additional
fields retain authored modern values without manufacturing legacy DBC records.
"""
import math
import re
from collections import defaultdict

from classic_db2 import DB2Error, f32
from classic_table_strings import named_table

LAYOUTS = {
    'CreatureDisplayInfo': 'f75f884c',
    'CreatureModelData': '3ffee408',
    'CreatureDisplayInfoExtra': 'f5e49981',
    'CreatureSoundData': 'e5ee765b',
}
ALIAS_LAYOUTS = {'ChrRaces': '47a2e62f', 'ChrRaceXChrModel': 'a203bc29', 'ChrModel': '03fab755'}
BAKE_LAYOUTS = {'TextureFileData': 'bd7c74c2', 'ComponentTextureFileData': 'b32b030a'}


def source_check(source):
    if (not isinstance(source, dict) or source.get('product') != 'wow_classic_era'
            or not isinstance(source.get('version'), str)
            or not isinstance(source.get('buildKey'), str)
            or not re.fullmatch(r'1\.15\.9\.\d+', source.get('version', ''))
            or not re.fullmatch(r'[0-9a-f]{32}', source.get('buildKey', ''))):
        raise DB2Error('Creature catalog requires an identified Classic Era 1.15.9 source.')


def number(row, field):
    value = f32(row[field])
    if not math.isfinite(value):
        raise DB2Error(f'Non-finite creature field {field}.')
    return value


def signed_id(value):
    return value - (1 << 32) if value & (1 << 31) else value


def character_paths(tables, displays, models):
    candidates = {}
    for link in tables['ChrRaceXChrModel'].values():
        race = tables['ChrRaces'].get(link['ChrRacesID'])
        body = tables['ChrModel'].get(link['ChrModelID'])
        sex = link['Sex']
        if race is None or body is None or sex not in (0, 1) or body['Sex'] != sex:
            raise DB2Error('Invalid character model/race join in creature catalog.')
        display = displays.get(body['DisplayID'])
        if display is None:
            raise DB2Error('Character model refers to an absent creature display.')
        if body['DisplayID'] != race['MaleDisplayID' if sex == 0 else 'FemaleDisplayID']:
            # NPC-only race/model links do not identify the race's default character body.
            continue
        name = race['ClientFileString']
        if not re.fullmatch(r'[A-Za-z]+', name):
            raise DB2Error('Invalid character model client file string.')
        gender = 'Male' if sex == 0 else 'Female'
        file = models[display['modelID']]['fileDataID']
        if file:
            candidates.setdefault(file, set()).add(f'Character\\{name}\\{gender}\\{name}{gender}.m2')
    # Shared NPC bodies such as Goblin have both sexes on one file, not two character rigs.
    return {next(iter(paths)): file for file, paths in candidates.items() if len(paths) == 1}


def npc_bake_files(tables, extras):
    """Resolve normal Classic NPC bakes through their authored material references.

    UsageType 0 is the color texture used by the existing character pipeline.
    Component profiles, when present, use the same race/sex/class selection as
    equipment preparation. A resource with multiple equally specific files is
    an error, never an arbitrary first-file selection.
    """
    textures = defaultdict(list)
    for row in tables['TextureFileData'].values():
        if row['UsageType'] == 0:
            textures[row['MaterialResourcesID']].append(row['FileDataID'])
    resolved = {}
    normal_count = 0
    for key, row in extras.items():
        resource = row['BakeMaterialResourcesID']
        if not resource:
            if row['HDBakeMaterialResourcesID']:
                raise DB2Error(f'NPC appearance {key} has only an HD bake, outside the Classic model contract.')
            resolved[key] = 0
            continue
        normal_count += 1
        candidates = []
        for file in textures[resource]:
            profile = tables['ComponentTextureFileData'].get(file, {})
            race, sex, class_id = (profile.get(k, default) for k, default in
                [('RaceID', 0), ('GenderIndex', -1), ('ClassID', 0)])
            if race not in (0, row['DisplayRaceID']) or sex not in (-1, 3, row['DisplaySexID']) or class_id not in (0, row['DisplayClassID']):
                continue
            if not 0 < file <= 0xffffffff:
                raise DB2Error(f'NPC appearance {key} has an invalid bake texture file ID.')
            candidates.append(((race == row['DisplayRaceID'], sex == row['DisplaySexID'], class_id != 0), file))
        if not candidates:
            raise DB2Error(f'NPC appearance {key} bake resource {resource} has no compatible color texture file.')
        rank = max(score for score, _ in candidates)
        files = {file for score, file in candidates if score == rank}
        if len(files) != 1:
            raise DB2Error(f'NPC appearance {key} bake resource {resource} has ambiguous texture files.')
        resolved[key] = files.pop()
    return resolved, {'extraRows':len(extras), 'normalResourceReferences':normal_count,
        'resolvedNormalReferences':sum(bool(file) for file in resolved.values()),
        'unresolvedNormalReferences':0, 'emptyNormalReferences':len(extras)-normal_count,
        'hdOnlyReferences':0}


def creature_catalog(read, source, *, include_character_aliases=True):
    source_check(source)
    tables, layouts = {}, {}
    for name, expected in (LAYOUTS | BAKE_LAYOUTS).items():
        rows, layout = named_table(read('dbfilesclient/' + name.lower() + '.db2'), name)
        if layout != expected:
            raise DB2Error(f'Unsupported {name} creature layout {layout}; expected {expected}.')
        tables[name], layouts[name] = rows, layout
    models = {}
    for key, row in tables['CreatureModelData'].items():
        models[key] = {
            'fileDataID': row['FileDataID'], 'scale': number(row, 'ModelScale'),
            'collisionWidth': number(row, 'CollisionWidth'),
            'collisionHeight': number(row, 'CollisionHeight'),
            'bounds': [f32(value) for value in row['GeoBox']],
            'flags': row['Flags'] & 0xffffffff, 'sizeClass': row['SizeClass'],
            'bloodID': signed_id(row['BloodID']), 'soundID': row['SoundID'],
            'footprintTextureID': signed_id(row['FootprintTextureID']),
            'footprintLength': number(row, 'FootprintTextureLength'),
            'footprintWidth': number(row, 'FootprintTextureWidth'),
            'foleyMaterialID': row['FoleyMaterialID'],
            # CameraEffect IDs are not the original CameraShakes IDs.
            'footstepCameraEffectID': row['FootstepCameraEffectID'],
            'deathThudCameraEffectID': row['DeathThudCameraEffectID'],
        }
    displays = {}
    for key, row in tables['CreatureDisplayInfo'].items():
        displays[key] = {
            'modelID': row['ModelID'], 'scale': number(row, 'CreatureModelScale'),
            'textures': row['TextureVariationFileDataID'],
            'extraDisplayID': row['ExtendedDisplayInfoID'],
            'portraitFileDataID': row['PortraitTextureFileDataID'],
            'alpha': row['CreatureModelAlpha'], 'sizeClass': row['SizeClass'],
            'bloodID': row['BloodID'], 'soundID': row['SoundID'], 'flags': row['Flags'] & 0xffffffff,
        }
    if not displays or not models:
        raise DB2Error('Creature display/model tables must not be empty.')
    if any(row['modelID'] not in models for row in displays.values()):
        raise DB2Error('Creature display refers to an absent model record.')
    extras = {key: {
        'race': row['DisplayRaceID'], 'sex': row['DisplaySexID'],
        'skin': row['SkinID'], 'face': row['FaceID'], 'hairStyle': row['HairStyleID'],
        'hairColor': row['HairColorID'], 'facialHair': row['FacialHairID'],
        'bakeMaterialResourcesID': row['BakeMaterialResourcesID'],
        'hdBakeMaterialResourcesID': row['HDBakeMaterialResourcesID'],
        'customDisplayOption': row['CustomDisplayOption'], 'flags': row['Flags'] & 0xffffffff,
    } for key, row in tables['CreatureDisplayInfoExtra'].items()}
    bake_files, bake_coverage = npc_bake_files(tables, tables['CreatureDisplayInfoExtra'])
    for key, row in extras.items():
        row['bakeFileDataID'] = bake_files[key]
    if any(row['extraDisplayID'] and row['extraDisplayID'] not in extras for row in displays.values()):
        raise DB2Error('Creature display refers to an absent appearance record.')
    aliases = {}
    if include_character_aliases:
        for name, expected in ALIAS_LAYOUTS.items():
            rows, layout = named_table(read('dbfilesclient/' + name.lower() + '.db2'), name)
            if layout != expected:
                raise DB2Error(f'Unsupported {name} character alias layout {layout}.')
            tables[name], layouts[name] = rows, layout
        aliases = character_paths(tables, displays, models)
        by_file = {file: path for path, file in aliases.items()}
        for model in models.values():
            if model['fileDataID'] in by_file:
                model['pathAlias'] = by_file[model['fileDataID']]
    return {
        'schema': 1, 'source': source,
        'layouts': [layouts['CreatureDisplayInfo'], layouts['CreatureModelData']],
        'tableLayouts': layouts, 'firstDisplayID': next(iter(displays)),
        'displays': displays, 'models': models, 'extras': extras,
        'soundRows': list(tables['CreatureSoundData']),
        'characterModelPaths': aliases,
        'bakeCoverage': bake_coverage,
        'unsupported': ['npcEquipment',
                        'cameraEffectToLegacyShake', 'fourthCreatureTextureSlot'],
    }
