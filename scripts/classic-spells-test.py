#!/usr/bin/env python3
"""Schema and modern graph regression tests using synthetic data, never client data."""
import unittest
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unittest.mock import patch
import classic_spells as s


def spell_names(text='Localized spell å'.encode() + b'\0'):
    """One inline string and two chained copies, with external spell IDs."""
    start = 272
    data = bytearray(start)
    data[:4] = b'WDC5'
    struct.pack_into('<9I2H7I', data, 136, 1, 1, 4, len(text), 0, 0x782ee721,
                     7, 9, 0, 4, 0, 1, 0, 0, 24, 0, 0, 1)
    struct.pack_into('<Q8I', data, 204, 0, start, 1, len(text), 0, 4, 0, 0, 2)
    struct.pack_into('<HH5I', data, 248, 0, 32, 0, 0, 0, 0, 0)
    data.extend(struct.pack('<I', 4))
    data.extend(text)
    data.extend(struct.pack('<5I', 7, 8, 7, 9, 8))
    return data


def simple_chain(texture=123):
    bits = lambda v: struct.unpack('<I', struct.pack('<f', v))[0]
    return {'Flags': 4, 'StartWidth': bits(.25), 'EndWidth': bits(.25),
        'Alpha': 255, 'Red': 255, 'Green': 255, 'Blue': 255, 'BlendMode': 3,
        'TextureFileDataID': [texture, 0, 0], 'TextureCoordScaleU': [bits(1)] * 3,
        'TextureCoordScaleV': [0] * 3, 'TextureRepeatLengthU': [0] * 3,
        'TextureRepeatLengthV': [0] * 3, 'AvgSegLen': bits(2.78),
        'NoiseScale': bits(.01), 'TexCoordScale': bits(-.5),
        'SegDuration': 1000, 'SegDelay': 200}


class SpellTest(unittest.TestCase):
    def test_pinned_procedural_and_chain_layouts_match_installed_build(self):
        self.assertEqual(s.schema('SpellProceduralEffect', 'fd22050d')[0], ['ID', 'Type', 'Value'])
        fields, parent, types = s.schema('SpellChainEffects', '3e3b28f5')
        self.assertIn('StartWidth', fields)
        self.assertIn('TextureFileDataID', fields)
        self.assertEqual(types['TextureFileDataID'], (32, True))

    def test_simple_chain_keeps_authored_shape_texture_and_reverse_scroll(self):
        row = s.chain_effect(simple_chain())
        self.assertTrue(row['rendererCompatible'])
        self.assertEqual(row['textureFileDataIDs'], [123, 0, 0])
        self.assertEqual(row['halfWidth'], .25)
        self.assertEqual(row['scrollPeriod'], -.5)
        for change in ({'Flags': 6}, {'WaveHeight': 1}, {'StartWidth': 0},
                       {'TextureFileDataID': [123, 456, 0]}, {'WidthScaleCurveID': 9}):
            self.assertFalse(s.chain_effect(dict(simple_chain(), **change))['rendererCompatible'])

    def test_kit_exports_actual_procedural_values_and_keeps_unsupported_references(self):
        tables = {name: {} for name in s.TABLES}
        tables['SpellVisualKit'] = {40: {}}
        tables['SpellChainEffects'] = {8227: simple_chain()}
        bits = lambda v: struct.unpack('<I', struct.pack('<f', v))[0]
        tables['SpellProceduralEffect'] = {
            7: {'Type': 0, 'Value': [bits(8227), bits(1), bits(1), 0]},
            8: {'Type': 12, 'Value': [bits(999), bits(1), 0, 0]}}
        tables['SpellVisualKitEffect'] = {
            1: {'ParentSpellVisualKitID': 40, 'EffectType': 1, 'Effect': 7},
            2: {'ParentSpellVisualKitID': 40, 'EffectType': 1, 'Effect': 8}}
        with patch.object(s, 'read_tables', return_value=(tables, {})):
            graph = s.spell_catalog(lambda _: b'', {'version': 'fixture'})
        self.assertEqual(graph['kits'][40]['proceduralEffects'], [
            {'id': 7, 'type': 0, 'values': [8227., 1., 1., 0.]},
            {'id': 8, 'type': 12, 'values': [999., 1., 0., 0.]}])
        self.assertEqual(graph['kits'][40]['unsupported'], [{'type': 'SpellProceduralEffectID', 'id': 8}])
        self.assertTrue(graph['chainEffects'][8227]['rendererCompatible'])

    def test_explicit_presentation_metadata_only_annotates_existing_spells(self):
        tables = {name: {} for name in s.TABLES}
        tables['SpellName'] = {7: {'Name_lang': 'Recorded summon'}, 8: {'Name_lang': 'Hidden visual'}}
        cue = {'displayID': 9, 'visualSpellID': 8, 'presentation': 'illustrative'}
        with patch.object(s, 'read_tables', return_value=(tables, {})), patch.object(s, 'SUMMON_CUES', {7: cue, 99: cue}):
            graph = s.spell_catalog(lambda _: b'', {'version': 'fixture'})
        self.assertEqual(graph['spells'][7]['summonCue'], cue)
        self.assertNotIn('summonCue', graph['spells'][8])
        self.assertNotIn(99, graph['spells'])

    def test_pinned_schema_keeps_parent_and_padded_scalar_widths(self):
        fields,parent,types=s.schema('SpellMisc','a1cc356a')
        self.assertEqual(parent,'SpellID')
        self.assertEqual(fields[5],'SchoolMask')
        self.assertEqual(types['SchoolMask'],(8,False))
        self.assertEqual(types['Attributes'],(32,True))
        with self.assertRaisesRegex(s.DB2Error,'Unsupported'):
            s.schema('SpellMisc','00000000')

    def test_modern_event_and_effect_enums_are_reused(self):
        self.assertEqual(s.enum('SpellVisualEventEvent')[1],'Precast Start')
        self.assertEqual(s.enum('SpellVisualEventEvent')[7],'Aura Start')
        self.assertEqual(s.enum('SpellVisualKitEffectType')[2],'SpellVisualKitModelAttachID')
        self.assertEqual(s.enum('SpellVisualEventTargetType')[3],'Area')

    def test_schema_masks_padded_bits_and_retains_signed_values(self):
        # One fixed record, with a parent from the relationship section.
        row=[[0]*17,0,1,0,0,576,0,0,0,0,0,0,0,400574]
        with patch.object(s,'TABLES',['SpellMisc']),patch.object(s,'decode',return_value=('a1cc356a',{1:row})):
            tables,_=s.read_tables(lambda name:b'')
        self.assertEqual(tables['SpellMisc'][1]['SchoolMask'],64)
        self.assertEqual(tables['SpellMisc'][1]['SpellID'],400574)

    def test_names_use_pinned_schema_and_shared_relative_string_decoder(self):
        self.assertEqual(s.schema('SpellName', '782ee721'), (['Name_lang'], None, {}))
        reads = []
        def read(name):
            reads.append(name)
            return spell_names()
        tables, layouts = s.read_tables(read, names=['SpellName'])
        self.assertEqual(reads, ['dbfilesclient/spellname.db2'])
        self.assertEqual(layouts, {'SpellName': '782ee721'})
        self.assertEqual({key: row['Name_lang'] for key, row in tables['SpellName'].items()},
                         {7: 'Localized spell å', 8: 'Localized spell å', 9: 'Localized spell å'})

    def test_unknown_layout_invalid_string_and_missing_names_fail_explicitly(self):
        data = spell_names()
        struct.pack_into('<I', data, 156, 0)
        with self.assertRaisesRegex(s.DB2Error, 'Unsupported SpellName layout'):
            s.read_tables(lambda _: data, names=['SpellName'])
        data = spell_names()
        struct.pack_into('<i', data, 272, -4)
        with self.assertRaisesRegex(s.DB2Error, 'outside its string table'):
            s.read_tables(lambda _: data, names=['SpellName'])
        with self.assertRaisesRegex(s.DB2Error, 'UTF-8'):
            s.read_tables(lambda _: spell_names(b'\xff\0'), names=['SpellName'])
        def missing(_):
            raise FileNotFoundError('not available locally')
        with self.assertRaisesRegex(FileNotFoundError, 'not available locally'):
            s.read_tables(missing, names=['SpellName'])

    def test_graph_keeps_names_without_visuals_and_preserves_visual_choices(self):
        tables = {name: {} for name in s.TABLES}
        tables['SpellName'] = {7: {'Name_lang': 'Localized spell å'}, 8: {'Name_lang': 'Aura only'}}
        tables['SpellXSpellVisual'] = {1: {'SpellID': 7, 'SpellVisualID': 42,
            'Priority': 2, 'DifficultyID': 0, 'ViewerUnitConditionID': 0,
            'ViewerPlayerConditionID': 0, 'CasterUnitConditionID': 0, 'CasterPlayerConditionID': 0}}
        with patch.object(s, 'read_tables', return_value=(tables, {'SpellName': '782ee721'})):
            value = s.spell_catalog(lambda _: b'', {'version': 'fixture'})
        self.assertEqual(value['spells'][7]['name'], 'Localized spell å')
        self.assertEqual(value['spells'][7]['visuals'], [{'id': 42, 'priority': 2,
                         'difficulty': 0, 'conditions': [0, 0, 0, 0]}])
        self.assertEqual(value['spells'][8], {'name': 'Aura only', 'visuals': []})
        self.assertEqual(value['layouts']['SpellName'], '782ee721')


def retained(client, library, output):
    spec = importlib.util.spec_from_file_location('assets', Path(__file__).with_name('classic-assets.py'))
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    with assets.CascStorage(client, library) as storage:
        source = assets.client_build(client)
        result = s.spell_catalog(storage.read, source)
        names = s.read_tables(storage.read, names=['SpellName'])[0]['SpellName']
    for key, row in names.items():
        assert result['spells'][key]['name'] == row['Name_lang'], f'Changed client name {key}'
    examples = {133: 'Fireball', 116: 'Frostbolt', 1459: 'Arcane Intellect',
                19746: 'Concentration Aura', 400574: 'Arcane Blast', 401556: 'Living Flame'}
    for key, expected in examples.items():
        assert result['spells'][key]['name'] == expected, f'Unexpected local name {key}'
    if output:
        output.write_text(json.dumps(result, separators=(',', ':'), allow_nan=False))
    print(json.dumps({'source': source, 'nameLayout': result['layouts']['SpellName'],
        'nameRecords': len(names), 'spells': len(result['spells']),
        'namedSpells': sum(bool(row.get('name')) for row in result['spells'].values()),
        'examples': {key: result['spells'][key]['name'] for key in examples}}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--client', type=Path)
    parser.add_argument('--library', type=Path)
    parser.add_argument('--output', type=Path)
    options, remaining = parser.parse_known_args()
    tests = unittest.main(argv=[sys.argv[0], *remaining], exit=False).result
    if not tests.wasSuccessful():
        raise SystemExit(1)
    if options.client and options.library:
        retained(options.client, options.library, options.output)
