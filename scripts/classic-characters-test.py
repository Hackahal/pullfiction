#!/usr/bin/env python3
"""Exercise real modern appearance data without consulting a legacy client."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from classic_characters import Characters, visible_geosets
from classic_db2 import DB2Error
from classic_compat import adapt_model, read as read_field

ROOT = Path(__file__).resolve().parent.parent


class ModernCharacters(unittest.TestCase):
    def test_unresolved_optional_armor_model_keeps_body_recipe_and_reports_partial(self):
        recipe = self.characters.appearance({'race':1,'sex':0,'legacyLook':[0]*5,
            'gear':[{'id':21331,'slot':4}]})
        self.assertTrue(any(layer.get('item') == 21331 for tex in recipe['textures'] for layer in tex['layers']))
        self.assertTrue(any(row['type'] == 'gear-model-attachment' and row['id'] == 21331
                            for row in recipe['unsupported']))

    @classmethod
    def setUpClass(cls):
        install = os.environ.get('PULLFICTION_CLIENT_VIEW')
        library = os.environ.get('PULLFICTION_CASC_LIBRARY')
        if not install or not library:
            raise unittest.SkipTest('Set PULLFICTION_CLIENT_VIEW and PULLFICTION_CASC_LIBRARY for real-client appearance checks')
        value = {'install': install, 'library': library}
        if not Path(install).exists() or not Path(library).is_file():
            raise FileNotFoundError('The explicitly configured client view or CascLib binary is unavailable')
        spec = importlib.util.spec_from_file_location('assets', ROOT/'scripts/classic-assets.py')
        assets = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assets)
        cls.storage = assets.CascStorage(Path(value['install']), Path(value['library']))
        cls.reads = []
        def read(name):
            if 'charsections' in name.lower() or name.lower().endswith('.dbc'):
                raise AssertionError('Legacy character data was requested')
            cls.reads.append(name)
            return cls.storage.read(name)
        cls.read = staticmethod(read)
        cls.characters = Characters(read, assets.client_build(Path(value['install'])))

    @classmethod
    def tearDownClass(cls):
        cls.storage.close()

    def test_all_sixteen_playable_race_body_combinations_resolve_local_textures(self):
        count = 0
        for identity in self.characters.supported():
            if identity['race'] > 8:
                continue
            recipe = self.characters.appearance(identity)
            self.assertGreater(recipe['file'], 0)
            self.assertFalse(recipe['unsupported'])
            self.assertIn(0, recipe['visibleGeosets'])
            self.assertLessEqual(set(recipe['visibleGeosets']), set(self.characters.model_geosets(recipe['file'])))
            self.assertTrue(any(t['type'] == 1 for t in recipe['textures']))
            for texture in recipe['textures']:
                for layer in texture['layers']:
                    x, y, width, height = layer['rect']
                    self.assertLessEqual(x + width, texture['width'])
                    self.assertLessEqual(y + height, texture['height'])
                    self.assertEqual(self.read('id:'+str(layer['file']))[:4], b'BLP2')
            count += 1
        self.assertEqual(count, 16)
        self.assertFalse(any('charsections' in name.lower() for name in self.reads))

    def test_a_geoset_choice_changes_the_appearance_without_changing_identity(self):
        first = self.characters.appearance({'race': 7, 'sex': 1})
        choice = next(row for row in self.characters.tables['ChrCustomizationChoice'].values()
                      if any(option['option'] == row['ChrCustomizationOptionID'] and option['choice'] != row['ID']
                             for option in first['choices']) and
                      any(e['ChrCustomizationGeosetID'] for e in self.characters.elements[row['ID']]))
        second = self.characters.appearance({'race': 7, 'sex': 1,
            'choices': {str(choice['ChrCustomizationOptionID']): choice['ID']}})
        self.assertEqual(first['file'], second['file'])
        self.assertNotEqual(first['geosetOverrides'], second['geosetOverrides'])
        self.assertNotEqual(first['visibleGeosets'], second['visibleGeosets'])

    def test_recorded_five_byte_looks_use_authored_conversion_rows_for_all_playable_bodies(self):
        for identity in self.characters.supported():
            if identity['race'] > 8:
                continue
            rows = self.characters.legacy_conversions[identity['race'], identity['sex']]
            look = [min(1, max(r['Data'] for r in rows if r['OptionID'] == option)) for option in range(1,6)]
            recipe = self.characters.appearance({**identity, 'legacyLook': look})
            choices = {r['option']:r['choice'] for r in recipe['choices']}
            for option, value in enumerate(look,1):
                row = next(r for r in rows if r['OptionID'] == option and r['Data'] == value)
                choice = self.characters.tables['ChrCustomizationChoice'][row['ChrCustomizationChoiceID']]
                self.assertEqual(choices[choice['ChrCustomizationOptionID']],choice['ID'])
        with self.assertRaises(DB2Error):
            self.characters.appearance({'race':1,'sex':0,'legacyLook':[255]*5})

    def test_original_body_display_ids_resolve_the_same_authored_garment_layers(self):
        request = {'race':1,'sex':0,'legacyLook':[0]*5}
        by_item = self.characters.appearance({**request,'gear':[{'id':16815,'slot':4},{'id':16800,'slot':7}]})
        ids = {r['slot']:r['display'] for r in by_item['gear']}
        by_display = self.characters.appearance({**request,'bodyDisplays':[0,ids[4],0,0,ids[7],0,0,0]})
        def layers(value):
            return [{k:v for k,v in r.items() if k != 'item'} for t in value['textures'] if t['type'] == 1 for r in t['layers']]
        self.assertEqual(layers(by_item),layers(by_display))
        self.assertFalse(by_display['unsupported'])
        with self.assertRaises(DB2Error):
            self.characters.appearance({**request,'bodyDisplays':[0]*7})

    def test_foreign_choices_and_invalid_identity_fail_explicitly(self):
        human = self.characters.appearance({'race': 1, 'sex': 0})['choices'][0]
        for request in [None, {'race': True, 'sex': 0}, {'race': 7, 'sex': 2},
                        {'race': 7, 'sex': 1, 'class': 'mage'},
                        {'race': 7, 'sex': 1, 'choices': {str(human['option']): human['choice']}}]:
            with self.assertRaises(DB2Error):
                self.characters.appearance(request)

    def test_equipped_armor_changes_body_layers_and_geosets_from_client_rows(self):
        naked = self.characters.appearance({'race': 1, 'sex': 0})
        clothed = self.characters.appearance({'race': 1, 'sex': 0, 'gear': [
            {'id': 16815, 'slot': 4},  # client robe display has six authored body sections
            {'id': 16800, 'slot': 7},
        ]})
        self.assertFalse(clothed['unsupported'])
        self.assertEqual({row['id'] for row in clothed['gear']}, {16815, 16800})
        body = next(row for row in clothed['textures'] if row['type'] == 1)
        layers = [row for row in body['layers'] if row.get('item')]
        self.assertGreaterEqual(len(layers), 8)
        self.assertTrue(all(row['blend'] == 15 for row in layers))
        self.assertNotEqual(naked['visibleGeosets'], clothed['visibleGeosets'])
        for layer in layers:
            x, y, w, h = layer['rect']
            self.assertLessEqual(x+w, body['width'])
            self.assertLessEqual(y+h, body['height'])
            self.assertEqual(self.read('id:'+str(layer['file']))[:4], b'BLP2')

    def test_gear_layers_resolve_across_all_sixteen_playable_race_body_combinations(self):
        count = 0
        for identity in self.characters.supported():
            if identity['race'] > 8:
                continue
            recipe = self.characters.appearance({**identity, 'gear': [
                {'id': 16815, 'slot': 4}, {'id': 16800, 'slot': 7},
            ]})
            self.assertFalse(recipe['unsupported'])
            body = next(row for row in recipe['textures'] if row['type'] == 1)
            for layer in body['layers']:
                self.assertEqual(self.read('id:'+str(layer['file']))[:4], b'BLP2')
            count += 1
        self.assertEqual(count, 16)

    def test_helm_shoulders_and_weapons_resolve_authored_model_attachments(self):
        recipe = self.characters.appearance({'race': 7, 'sex': 1, 'gear': [
            {'id': 16813, 'slot': 0}, {'id': 16816, 'slot': 2},
            {'id': 18842, 'slot': 15}, {'id': 19366, 'slot': 16},
        ]})
        self.assertFalse(recipe['unsupported'])
        self.assertEqual({row['point']['id'] for row in recipe['attachments']}, {11, 6, 5, 1, 2})
        self.assertEqual(len(recipe['attachments']), 5)
        for row in recipe['attachments']:
            self.assertEqual(row['mode'], 'melee' if row['slot'] in (15, 16) else 'armor')
            self.assertIn(b'MD21', self.characters.model_parts(row['file']))
            skin = read_field(self.characters.model_parts(row['file'])[b'SFID'], '<I', 0)[0]
            converted = adapt_model(self.read('id:'+str(row['file'])), [self.read('id:'+str(skin))])
            self.assertEqual(converted[:4], b'MD20')
            self.assertEqual(row['point'], self.characters.attachment_point(recipe['file'], row['point']['id']))
            for texture in row['textures']:
                self.assertEqual(self.read('id:'+str(texture['file']))[:4], b'BLP2')

    def test_helmet_hiding_uses_selected_race_and_authored_visibility_rows(self):
        # Resolve a representative helmet from table relationships, without
        # guessing which individual item should hide a character's hair.
        self.characters.appearance({'race': 1, 'sex': 0, 'gear': [{'id': 16813, 'slot': 0}]})
        hiding = self.characters.gear_tables['HelmetGeosetData'].values()
        hidden_by_visibility = {}
        for row in hiding:
            if row['RaceID'] == 1:
                hidden_by_visibility.setdefault(row['HelmetGeosetVisDataID'], set()).add(row['HideGeosetGroup'])
        for id, item in self.characters.item_data['items'].items():
            display = self.characters.gear_tables['ItemDisplayInfo'].get(item['display'])
            if item['inventory'] == 1 and display and display['HelmetGeosetVis'][0] in hidden_by_visibility:
                recipe = self.characters.appearance({'race': 1, 'sex': 0, 'gear': [{'id': id, 'slot': 0}]})
                for group in hidden_by_visibility[display['HelmetGeosetVis'][0]]:
                    self.assertEqual(recipe['geosetOverrides'][str(group)], [])
                    self.assertFalse(any(value and value // 100 == group for value in recipe['visibleGeosets']))
                break
        else:
            self.fail('Configured modern client contains no helmet visibility fixture')

    def test_equipment_validation_and_unknown_item_are_explicit(self):
        for gear in (None, [{'id': True, 'slot': 4}], [{'id': 16815, 'slot': False}],
                     [{'id': 16815, 'slot': -1}], [{'id': 1, 'slot': 4}, {'id': 2, 'slot': 4}]):
            with self.subTest(gear=gear), self.assertRaises(DB2Error):
                self.characters.appearance({'race': 1, 'sex': 0, 'gear': gear})
        recipe = self.characters.appearance({'race': 1, 'sex': 0, 'gear': [{'id': 2**30, 'slot': 4}]})
        self.assertEqual(recipe['unsupported'][0]['type'], 'gear-item')
        self.assertFalse(recipe['gear'])
        wrong_slot = self.characters.appearance({'race': 1, 'sex': 0, 'gear': [{'id': 16815, 'slot': 15}]})
        self.assertEqual(wrong_slot['unsupported'][0]['type'], 'gear-slot-mismatch')
        self.assertFalse(wrong_slot['attachments'])

    def test_ranged_attachments_preserve_model_and_texture_references_with_separate_mode(self):
        recipe = self.characters.appearance({'race': 1, 'sex': 0, 'gear': [
            {'id': 18842, 'slot': 15}, {'id': 18713, 'slot': 17},
        ]})
        self.assertFalse(recipe['unsupported'])
        modes = {row['slot']: row for row in recipe['attachments']}
        self.assertEqual(modes[15]['mode'], 'melee')
        self.assertEqual(modes[17]['mode'], 'ranged')
        self.assertEqual(modes[17]['point']['id'], 2)
        self.assertGreater(modes[17]['file'], 0)
        self.assertTrue(modes[17]['textures'])


class Visibility(unittest.TestCase):
    def test_hidden_group_sentinels_and_model_defaults(self):
        self.assertEqual(visible_geosets([0, 1, 2, 101, 102, 401, 1701], {0: {2}, 1: {100}}), [0, 2, 401])

    def test_equipment_resource_selection_honors_authored_gender_wildcards(self):
        characters = Characters.__new__(Characters)
        characters.tables = {'ComponentTextureFileData': {}, 'TextureFileData': {}}
        self.assertEqual(characters.select_gear_file([{'file': 101, 'race': 0, 'sex': 3}], 1, 0, 0, texture=True), 101)
        self.assertEqual(characters.select_gear_file([{'file': 102, 'race': 0, 'sex': 2, 'position': 1}], 1, 0, 0, position=1), 102)
        self.assertIsNone(characters.select_gear_file([{'file': 103, 'race': 7, 'sex': 1}], 1, 0, 0))
        with self.assertRaisesRegex(DB2Error, 'Ambiguous equipment'):
            characters.select_gear_file([{'file': 104}, {'file': 105}], 1, 0, 0)


if __name__ == '__main__':
    unittest.main()
