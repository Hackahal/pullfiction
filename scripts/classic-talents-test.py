#!/usr/bin/env python3
"""Synthetic talent contracts and optional read-only retained-client verification."""
import argparse
import importlib.util
from pathlib import Path
import unittest
from copy import deepcopy

from classic_db2 import DB2Error
from classic_sections import EncryptedSectionError, readable_table
from classic_table_strings import named_table
from classic_talents import TABLE_IDS
from classic_talents import talent_catalog, LAYOUTS

SOURCE = {'product': 'wow_classic_era', 'version': '1.15.9.70003', 'buildKey': 'a'*32}


def fixture():
    return {'TalentTab': [{'ID': 41, 'ClassMask': 128, 'Name_lang': 'Fire', 'OrderIndex': 1, 'SpellIconID': 135810}],
            'ChrClasses': [{'ID': 8, 'Name_lang': 'Mage'}],
            'Talent': [{'ID': 29, 'TabID': 41, 'ClassID': 8, 'TierID': 2, 'ColumnIndex': 1,
                        'SpellRank': [11366, 12345, 0, 0, 0, 0, 0, 0, 0], 'PrereqTalent': [0, 0, 0], 'PrereqRank': [0, 0, 0]},
                       {'ID': 32, 'TabID': 41, 'ClassID': 8, 'TierID': 4, 'ColumnIndex': 1,
                        'SpellRank': [11113, 0, 0, 0, 0, 0, 0, 0, 0], 'PrereqTalent': [29, 0, 0], 'PrereqRank': [1, 0, 0]}]}


def convert(tables, locked=(), partial=()):
    def table(name):
        if name in locked:
            raise EncryptedSectionError('Missing local key')
        return {'rows': tables[name], 'layout': LAYOUTS[name],
                'coverage': {'complete': name not in partial, 'includedRecords': len(tables[name])}}
    return talent_catalog(None, SOURCE, table)


class TalentTests(unittest.TestCase):
    def test_grid_rank_spells_local_icon_and_one_based_prerequisite(self):
        result = convert(fixture())
        self.assertTrue(result['readable'])
        self.assertFalse(result['partial'])
        tree = result['trees'][0]
        self.assertEqual((tree['classId'], tree['order'], tree['icon']), (8, 1, 'id:135810'))
        self.assertEqual(tree['nodes'][0]['ranks'], [11366, 12345])
        self.assertEqual(tree['nodes'][1]['prerequisites'], [{'id': 29, 'rank': 2}])
        self.assertNotIn('allocation', tree['nodes'][0])

    def test_locked_talents_preserve_tree_names_without_inventing_nodes(self):
        result = convert(fixture(), locked=['Talent'])
        self.assertTrue(result['partial'])
        self.assertEqual(result['trees'][0]['nodes'], [])
        self.assertEqual(result['coverage']['unavailableTables'], ['Talent'])
        self.assertFalse(convert(fixture(), locked=['TalentTab'])['readable'])

    def test_partial_sections_keep_missing_prerequisite_honest(self):
        tables = fixture(); tables['Talent'] = tables['Talent'][1:]
        result = convert(tables, partial=['Talent'])
        self.assertTrue(result['partial'])
        self.assertEqual(result['trees'][0]['nodes'][0]['prerequisites'], [{'id': 29, 'rank': 2}])
        with self.assertRaisesRegex(DB2Error, 'prerequisite'):
            convert(tables)

    def test_bad_grid_rank_prefix_and_prerequisite_fail(self):
        for field, value in [('TierID', 7), ('ColumnIndex', 4), ('ClassID', 1), ('SpellRank', [11366, 0, 12345])]:
            tables = deepcopy(fixture()); tables['Talent'][0][field] = value
            with self.subTest(field=field), self.assertRaises(DB2Error): convert(tables)
        tables = fixture(); tables['Talent'][1]['PrereqRank'][0] = 9
        with self.assertRaisesRegex(DB2Error, 'prerequisite'): convert(tables)

    def test_wrong_source_and_layout_fail_instead_of_guessing(self):
        with self.assertRaises(DB2Error): talent_catalog(None, {**SOURCE, 'product': 'wowf'})
        with self.assertRaisesRegex(DB2Error, 'layout'):
            talent_catalog(None, SOURCE, lambda name: {'rows': [], 'layout': 'unknown', 'coverage': {}})


def retained(install):
    spec = importlib.util.spec_from_file_location('assets', Path(__file__).with_name('classic-assets.py'))
    assets = importlib.util.module_from_spec(spec); spec.loader.exec_module(assets)
    with assets.CascStorage(install, assets.DEFAULT_LIBRARY) as storage:
        result = talent_catalog(storage.read, assets.client_build(install))
        def table(name):
            raw = storage.read('id:' + str(TABLE_IDS[name]))
            data, coverage = readable_table(lambda offset, size: raw[offset:offset + size], name)
            rows, layout = named_table(data, name)
            return {'rows': list(rows.values()), 'layout': layout, 'coverage': coverage}
        sectioned = talent_catalog(None, assets.client_build(install), table)
        assert sectioned['trees'] == result['trees']
        assert sectioned['coverage']['complete']
        for tree in result['trees']:
            assert storage.read(tree['icon'])[:4] == b'BLP2'
    assert len(result['trees']) == 27
    assert all(len([tree for tree in result['trees'] if tree['classId'] == cls['id']]) == 3 for cls in result['classes'])
    assert sum(len(tree['nodes']) for tree in result['trees']) == 432
    mage = [tree['name'] for tree in result['trees'] if tree['classId'] == 8]
    assert mage == ['Arcane', 'Fire', 'Frost'], mage
    print('Retained Classic: 27 trees, 432 talent nodes, 9 classes; complete metadata with local icon references.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--install', type=Path); args = parser.parse_args()
    if args.install: retained(args.install)
    else: unittest.main(argv=['classic-talents-test.py'])
