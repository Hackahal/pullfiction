#!/usr/bin/env python3
"""Synthetic WDC5 tests and explicit read-only retained-client catalog checks."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import sys
import unittest

from classic_creatures import BAKE_LAYOUTS, LAYOUTS, character_paths, creature_catalog, npc_bake_files
from classic_db2 import DB2Error, creature_catalog as previous_catalog, decode
from classic_spells import schema

SOURCE = {'product': 'wow_classic_era', 'version': '1.15.9.70576', 'buildKey': 'a' * 32}


def bits(number):
    return struct.unpack('<I', struct.pack('<f', number))[0]


def table(name, key, values):
    layout = (LAYOUTS | BAKE_LAYOUTS)[name]
    fields, _, _ = schema(name, layout)
    arrays = {'GeoBox': 6, 'TextureVariationFileDataID': 4,
              'CustomDisplayOption': 3, 'SoundFidget': 5, 'CustomAttack': 4}
    rows = [values.get(field, [0] * arrays[field] if field in arrays else 0) for field in fields]
    widths = [len(value) if isinstance(value, list) else 1 for value in rows]
    size, count = sum(widths) * 4, len(fields)
    start = 244 + count * 28
    data = bytearray(start)
    data[:4] = b'WDC5'
    struct.pack_into('<9I2H7I', data, 136, 1, count, size, 0, 0, int(layout, 16), key, key, 0, 4, 0, count, 0, 0, count * 24, 0, 0, 1)
    struct.pack_into('<Q8I', data, 204, 0, start, 1, 0, 0, 4, 0, 0, 0)
    offset = 0
    for index, width in enumerate(widths):
        struct.pack_into('<HH5I', data, 244 + count * 4 + index * 24, offset, width * 32, 0, 0, 0, 0, 0)
        offset += width * 32
    for value in rows:
        for scalar in value if isinstance(value, list) else [value]:
            data.extend(struct.pack('<I', scalar & 0xffffffff))
    data.extend(struct.pack('<I', key))
    return data


def fixture(model=7):
    values = {
        'CreatureDisplayInfo': (100, {'ID': 100, 'ModelID': model, 'ExtendedDisplayInfoID': 8,
            'CreatureModelScale': bits(2), 'CreatureModelAlpha': 128, 'SizeClass': -1,
            'TextureVariationFileDataID': [123, 0, 456, 789], 'SoundID': 9}),
        'CreatureModelData': (7, {'FileDataID': 123020, 'ModelScale': bits(1.5), 'Flags': 2,
            'SizeClass': 4, 'BloodID': -1, 'FootprintTextureID': 7,
            'FootprintTextureLength': bits(18), 'FootprintTextureWidth': bits(12),
            'CollisionWidth': bits(1), 'CollisionHeight': bits(3), 'SoundID': 9}),
        'CreatureDisplayInfoExtra': (8, {'ID': 8, 'DisplayRaceID': 3, 'DisplaySexID': 1,
            'SkinID': 4, 'FaceID': 5, 'HairStyleID': 6, 'HairColorID': 7, 'FacialHairID': 8,
            'BakeMaterialResourcesID': 900}),
        'CreatureSoundData': (9, {'ID': 9}),
        'TextureFileData': (4444, {'FileDataID':4444,'MaterialResourcesID':900,'UsageType':0}),
        'ComponentTextureFileData': (4444, {'ID':4444,'RaceID':0,'GenderIndex':3,'ClassID':0}),
    }
    return {'dbfilesclient/' + name.lower() + '.db2': table(name, key, row)
            for name, (key, row) in values.items()}


class CreatureTests(unittest.TestCase):
    def test_character_path_identity_comes_from_joined_rows_and_shared_npc_body_stays_generic(self):
        tables = {'ChrRaces': {1: {'ClientFileString': 'Human', 'MaleDisplayID': 49, 'FemaleDisplayID': 50},
                               9: {'ClientFileString': 'Goblin', 'MaleDisplayID': 100, 'FemaleDisplayID': 100}},
                  'ChrRaceXChrModel': {1: {'ChrRacesID': 1, 'ChrModelID': 1, 'Sex': 0},
                                       2: {'ChrRacesID': 9, 'ChrModelID': 2, 'Sex': 0},
                                       3: {'ChrRacesID': 9, 'ChrModelID': 3, 'Sex': 1}},
                  'ChrModel': {1: {'DisplayID': 49, 'Sex': 0}, 2: {'DisplayID': 100, 'Sex': 0},
                               3: {'DisplayID': 100, 'Sex': 1}}}
        self.assertEqual(character_paths(tables, {49: {'modelID': 1}, 100: {'modelID': 2}},
                                         {1: {'fileDataID': 101}, 2: {'fileDataID': 102}}),
                         {'Character\\Human\\Male\\HumanMale.m2': 101})

    def test_named_modern_fields_preserve_models_alpha_scale_and_textures(self):
        files, reads = fixture(), []
        def read(name):
            reads.append(name)
            return files[name]
        graph = creature_catalog(read, SOURCE, include_character_aliases=False)
        display, model = graph['displays'][100], graph['models'][7]
        self.assertEqual(set(reads), set(files))
        self.assertTrue(all(name.endswith('.db2') for name in reads))
        self.assertEqual((display['alpha'], display['scale'], display['sizeClass']), (128, 2, -1))
        self.assertEqual(display['textures'], [123, 0, 456, 789])
        self.assertEqual((model['fileDataID'], model['scale'], model['collisionHeight']), (123020, 1.5, 3))
        self.assertEqual((model['flags'], model['bloodID'], model['footprintLength']), (2, -1, 18))
        self.assertEqual(graph['extras'][8]['race'], 3)
        self.assertEqual(graph['extras'][8]['bakeFileDataID'],4444)
        self.assertEqual(graph['bakeCoverage'],{'extraRows':1,'normalResourceReferences':1,
            'resolvedNormalReferences':1,'unresolvedNormalReferences':0,'emptyNormalReferences':0,'hdOnlyReferences':0})
        self.assertEqual(graph['soundRows'], [9])
        self.assertEqual(graph['firstDisplayID'], 100)
        self.assertIn('npcEquipment', graph['unsupported'])

    def test_bake_profiles_choose_authored_normal_color_and_reject_missing_or_ambiguous_files(self):
        extra = {1:{'DisplayRaceID':3,'DisplaySexID':1,'DisplayClassID':0,
                    'BakeMaterialResourcesID':90,'HDBakeMaterialResourcesID':91}}
        tables = {'TextureFileData':{
            1:{'FileDataID':1,'MaterialResourcesID':90,'UsageType':0},
            2:{'FileDataID':2,'MaterialResourcesID':90,'UsageType':0},
            3:{'FileDataID':3,'MaterialResourcesID':90,'UsageType':1},
            4:{'FileDataID':4,'MaterialResourcesID':91,'UsageType':0}},
            'ComponentTextureFileData':{2:{'RaceID':3,'GenderIndex':1,'ClassID':0}}}
        self.assertEqual(npc_bake_files(tables,extra)[0],{1:2})
        tables['TextureFileData'][5] = {'FileDataID':5,'MaterialResourcesID':90,'UsageType':0}
        tables['ComponentTextureFileData'][5] = {'RaceID':3,'GenderIndex':1,'ClassID':0}
        with self.assertRaisesRegex(DB2Error,'ambiguous'):
            npc_bake_files(tables,extra)
        tables['TextureFileData'] = {}
        with self.assertRaisesRegex(DB2Error,'no compatible color texture'):
            npc_bake_files(tables,extra)
        extra[1]['BakeMaterialResourcesID'] = 0
        with self.assertRaisesRegex(DB2Error,'only an HD bake'):
            npc_bake_files(tables,extra)
        extra[1]['HDBakeMaterialResourcesID'] = 0
        self.assertEqual(npc_bake_files(tables,extra)[0],{1:0})

    def test_source_layout_missing_reads_and_dangling_models_fail(self):
        for source in [{}, dict(SOURCE, product='wow'), dict(SOURCE, version='1.12.1'), dict(SOURCE, buildKey='bad')]:
            with self.subTest(source=source), self.assertRaisesRegex(DB2Error, '1.15.9'):
                creature_catalog(lambda _: self.fail('source validation must precede reads'), source)
        files = fixture()
        changed = files['dbfilesclient/creaturedisplayinfo.db2'][:]
        struct.pack_into('<I', changed, 156, 0x12345678)
        files['dbfilesclient/creaturedisplayinfo.db2'] = changed
        with self.assertRaisesRegex(DB2Error, 'Unsupported'):
            creature_catalog(files.__getitem__, SOURCE)
        with self.assertRaises(KeyError):
            creature_catalog({}.__getitem__, SOURCE)
        with self.assertRaisesRegex(DB2Error, 'absent model'):
            creature_catalog(fixture(model=999).__getitem__, SOURCE)


def retained(client, library, output):
    spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    source = assets.client_build(client)
    with assets.CascStorage(client, library) as storage:
        graph = creature_catalog(storage.read, source)
        old = previous_catalog(storage.read('dbfilesclient/creaturedisplayinfo.db2'), storage.read('dbfilesclient/creaturemodeldata.db2'))
        for kind in ['displays', 'models']:
            assert set(graph[kind]) == set(old[kind])
            for key, row in old[kind].items():
                for field, value in row.items():
                    assert graph[kind][key][field] == value, (kind, key, field)
        _, raw = decode(storage.read('dbfilesclient/creaturedisplayinfo.db2'))
        for key, row in raw.items():
            assert graph['displays'][key]['alpha'] == row[5] & 255
            assert graph['displays'][key]['sizeClass'] == ((row[3] & 255) - 256 if row[3] & 128 else row[3])
        assert len(graph['characterModelPaths']) == 16
        for alias, file in graph['characterModelPaths'].items():
            assert storage.read(alias) == storage.read('id:' + str(file)), alias
    if output:
        output.write_text(json.dumps(graph, separators=(',', ':')))
    print('Retained modern creature checks PASS:', source, {kind: len(graph[kind]) for kind in ['displays', 'models', 'extras', 'soundRows']})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--client', type=Path)
    parser.add_argument('--library', type=Path)
    parser.add_argument('--output', type=Path)
    args, tests = parser.parse_known_args()
    result = unittest.main(argv=[sys.argv[0]] + tests, exit=False)
    if not result.result.wasSuccessful():
        raise SystemExit(1)
    if args.client:
        if not args.library:
            parser.error('--client requires --library')
        retained(args.client, args.library, args.output)
