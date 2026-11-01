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
    def test_only_complete_exact_zero_rate_body_procedures_are_compatible(self):
        freeze = {'type': 11, 'values': [0, 0, 0, 0]}
        self.assertTrue(s.freeze_procedure_compatible(freeze))
        for changed in [dict(freeze, rendererCompatible=False), dict(freeze, type=11.0),
                        dict(freeze, type=14), dict(freeze, values=[0, 2, 0, 0]),
                        dict(freeze, values=[1, 0, 0, 0]), dict(freeze, values=[0, 0, 0]),
                        dict(freeze, values=[0, 0, 0, None]), dict(freeze, values=[False, 0, 0, 0])]:
            self.assertFalse(s.freeze_procedure_compatible(changed), changed)

    def test_reference_closure_is_sparse_cycle_safe_and_preserves_float_bits_and_stand(self):
        definitions={
            'Positioner':{7:{'ID':7,'FirstStateID':8},999:{'ID':999}},
            'PositionerState':{8:{'ID':8,'NextStateID':8,'PosEntryID':20,'TransformMatrixID':40}},
            'PositionerStateEntry':{20:{'ID':20,'CurveID':10,'ParamA':0x3e800000}},
            'TransformMatrix':{40:{'ID':40,'Pos':[0,0,0],'Scale':0x3f800000,'Pitch':0x7fc00000}},
            'Curve':{10:{'ID':10,'Type':0,'Flags':0},999:{'ID':999}},
            'CurvePoint':{100:{'ID':100,'CurveID':10,'OrderIndex':0,'Pos':[0,0]},
                          101:{'ID':101,'CurveID':10,'OrderIndex':1,'Pos':[0x3f800000,0x40000000]},
                          999:{'ID':999,'CurveID':999,'Pos':[0,0]}},
            'AnimKit':{30:{'ID':30,'OneShotStopAnimKitID':30}},
            'AnimKitSegment':{300:{'ID':300,'ParentAnimKitID':30,'AnimID':0,'AnimKitConfigID':50}},
            'AnimationData':{0:{'ID':0,'Fallback':0}},
            'AnimKitConfig':{50:{'ID':50}},
            'AnimKitConfigBoneSet':{500:{'ID':500,'ParentAnimKitConfigID':50,'AnimKitBoneSetID':60,'AnimKitPriorityID':70}},
            'AnimKitBoneSet':{60:{'ID':60}},'AnimKitBoneSetAlias':{},
            'AnimKitPriority':{70:{'ID':70,'Priority':1}},
            'SpellMissileMotion':{9:{'ID':9,'Name':'motion','ScriptBody':'return source'}}}
        calls=[]
        def read(resource):calls.append(resource);return resource.encode()
        with patch('classic_table_strings.named_table',side_effect=lambda raw,name:(definitions[name],'12345678')):
            out=s.reference_definitions(read,{'SpellVisualMissile':{1:{'CastPositionerID':7,'AnimKitID':30,'SpellMissileMotionID':9}}})
        self.assertEqual(out['missingReferences'],[])
        self.assertEqual(set(out['tables']['Positioner']['rows']),{7})
        self.assertEqual(set(out['tables']['CurvePoint']['rows']),{100,101})
        self.assertIn(0,out['tables']['AnimationData']['rows'])
        self.assertEqual(out['tables']['PositionerStateEntry']['rows'][20]['ParamA'],.25)
        self.assertEqual(out['tables']['PositionerStateEntry']['rows'][20]['floatBits']['ParamA'],0x3e800000)
        self.assertIsNone(out['tables']['TransformMatrix']['rows'][40]['Pitch'])
        self.assertEqual(out['tables']['TransformMatrix']['rows'][40]['floatBits']['Pitch'],0x7fc00000)
        self.assertEqual(out['tables']['SpellMissileMotion']['rows'][9]['ScriptBody'],'return source')
        self.assertEqual(len(calls),len(set(calls)))
        json.dumps(out,allow_nan=False)

    def test_reference_closure_distinguishes_missing_rows_from_unavailable_tables(self):
        def table(raw,name):
            if name=='Positioner':return {7:{'ID':7,'FirstStateID':8}},'12345678'
            if name=='PositionerState':return {},'12345678'
            raise s.DB2Error('Unknown layout')
        with patch('classic_table_strings.named_table',side_effect=table):
            out=s.reference_definitions(lambda resource:b'fixed',{'SpellVisualMissile':{
                1:{'CastPositionerID':7,'AnimKitID':9}}})
        self.assertEqual({r['reason'] for r in out['missingReferences']},{'record-absent','table-unavailable'})
        self.assertEqual(out['tables']['AnimKit']['status'],'unavailable')
        self.assertEqual(out['tables']['PositionerState']['availableRecords'],0)
        self.assertIn('sourceSha256',out['tables']['AnimKit'])

    def test_attachment_animation_phases_retain_stand_zero_and_explicit_overrides(self):
        tables={name:{} for name in s.TABLES}
        tables['SpellVisualKit']={7:{}}
        tables['SpellVisualKitEffect']={1:{'ParentSpellVisualKitID':7,'EffectType':2,'Effect':8}}
        tables['SpellVisualKitModelAttach']={8:{'SpellVisualEffectNameID':9,'AttachmentID':34,
            'Offset':[0]*3,'Yaw':0,'Pitch':0,'Roll':0,'Scale':0x3f800000,'StartDelay':0,
            'PositionerID':0,'Flags':4,'StartAnimID':0,'AnimID':144,'EndAnimID':193}}
        with patch.object(s,'read_tables',return_value=(tables,{})):
            graph=s.spell_catalog(lambda _:b'',{})
        self.assertEqual(graph['kits'][7]['effects'][0]['animation'],{'start':0,'loop':144,'end':193})

    def test_model_format_headers_are_bounded_deduplicated_and_never_full_read(self):
        m2=b'MD21'+struct.pack('<I',100)+b'MD20'
        wmo=b'REVM'+struct.pack('<II',4,17)
        self.assertEqual(s.model_asset_format(m2),'m2')
        self.assertEqual(s.model_asset_format(b'MD20'+struct.pack('<II',256,0)),'m2')
        self.assertEqual(s.model_asset_format(wmo),'wmo')
        self.assertEqual(s.model_asset_format(b'REVM'+struct.pack('<II',4,18)),'unknown')
        for header in (b'',m2[:4],bytes(12),b'REVM'+struct.pack('<II',8,17)):
            self.assertEqual(s.model_asset_format(header),'unknown')
        tables={name:{} for name in s.TABLES}
        row=lambda fid:{'ModelFileDataID':fid,'Type':0,'Scale':0x3f800000,
                        'Alpha':0x3f800000,'BaseMissileSpeed':0}
        tables['SpellVisualEffectName']={1:row(100),2:row(100),3:row(200),4:row(300),5:row(0)}
        calls=[]
        def header(resource,offset,size):
            calls.append((resource,offset,size))
            if resource=='id:300':raise FileNotFoundError('not locally available')
            return {'id:100':m2,'id:200':wmo}[resource]
        def full(_):raise AssertionError('Model full reads are forbidden during catalog generation')
        with patch.object(s,'read_tables',return_value=(tables,{})):
            graph=s.spell_catalog(full,{},header)
        self.assertEqual(calls,[('id:100',0,12),('id:200',0,12),('id:300',0,12)])
        self.assertEqual([graph['effects'][i].get('assetFormat') for i in range(1,6)],
                         ['m2','m2','wmo','unknown',None])
        self.assertEqual(graph['effects'][4]['assetFormatEvidence']['probeBytes'],0)

    def test_authored_metadata_keeps_unmapped_nondefault_fields_without_duplicate_defaults(self):
        row={'ID':7,'Offset':[0,0,0],'Scale':0x3f800000,
             'OffsetVariation':[0,0x3f800000,0],'StartAnimID':-1,
             'AnimID':158,'EndAnimID':159,'Flags':[0,0],'AnimKitID':0}
        self.assertEqual(s.authored_extra(row,{'Offset','Scale'}),{
            'OffsetVariation':[0,0x3f800000,0],'AnimID':158,'EndAnimID':159})

    def test_particle_palette_transposes_slots_and_preserves_rgb_without_alpha(self):
        row={'Start':[0xaa010203,0xff102030,0],
             'MID':[0xbb040506,0xff405060,0],
             'End':[0xcc070809,0xff708090,0]}
        with patch.object(s,'read_tables',return_value=({'ParticleColor':{7:row}},{})):
            palettes=s.particle_colors(lambda _:b'')
        self.assertEqual(palettes[7][0],[[v/255 for v in rgb] for rgb in ([1,2,3],[4,5,6],[7,8,9])])
        self.assertEqual(palettes[7][1][2],[0x70/255,0x80/255,0x90/255])
        self.assertEqual(palettes[7][2],[[0.,0.,0.]]*3)

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

    def test_procedures_are_checked_before_chain_conversion_and_invalid_bits_survive_json(self):
        bits = lambda v: struct.unpack('<I', struct.pack('<f', v))[0]
        for ty in (1, 2, 14, 17):
            proc = s.procedure({'Type': ty, 'Value': [bits(-.25), 0, 0, 0]})
            self.assertIsNone(s.chain_procedure_id(proc))
            self.assertEqual(proc['values'][0], -.25)
        for values in ([8.5, 1, 0, 0], [8, 1.5, 0, 0], [8, 1, -1, 0],
                       [0, 1, 0, 0], [8, 1, 0, float('inf')]):
            proc = s.procedure({'Type': 0, 'Value': [bits(v) for v in values]})
            self.assertIsNone(s.chain_procedure_id(proc))
            self.assertFalse(proc['rendererCompatible'])
            json.dumps(proc, allow_nan=False)
        for bad in (float('nan'), float('inf'), -float('inf')):
            raw = [bits(bad), bits(1), 0, 0]
            proc = s.procedure({'Type': 12, 'Value': raw})
            self.assertIsNone(proc['values'][0])
            self.assertEqual(proc['rawValueBits'], raw)
            self.assertIsNone(s.chain_procedure_id(proc))
            json.dumps(proc, allow_nan=False)
        self.assertEqual(s.chain_procedure_id(s.procedure({
            'Type': 0, 'Value': [bits(8227), bits(3), bits(1), 0]})), 8227)

    def test_authored_weapon_trail_is_exported_as_supported_without_becoming_a_chain(self):
        bits = lambda v: struct.unpack('<I', struct.pack('<f', v))[0]
        tables = {name: {} for name in s.TABLES}
        tables['SpellVisualKit'] = {40: {}}
        tables['SpellProceduralEffect'] = {7: {'Type': 8,
            'Value': [bits(0xda4321), bits(20), bits(600), bits(100)]}}
        tables['SpellVisualKitEffect'] = {1: {
            'ParentSpellVisualKitID': 40, 'EffectType': 1, 'Effect': 7}}
        with patch.object(s, 'read_tables', return_value=(tables, {})):
            graph = s.spell_catalog(lambda _: b'', {})
        proc = graph['kits'][40]['proceduralEffects'][0]
        self.assertTrue(s.trail_procedure_compatible(proc))
        self.assertIsNone(s.chain_procedure_id(proc))
        self.assertEqual(graph['kits'][40]['unsupported'], [])
        for value in (-1, .5, 256):
            self.assertFalse(s.trail_procedure_compatible(dict(proc, values=[123, 20, 600, value])))

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
