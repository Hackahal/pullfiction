#!/usr/bin/env python3
"""Replay metadata adapters; optional retained client reads DB2 only."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from classic_db2 import DB2Error
import classic_character_catalog as catalog

SOURCE = {'product':'wow_classic_era','version':'1.15.9.70576','buildKey':'5604ce35a8644bdcf0e26c1daf979c15'}


def fixture():
    tables = {name:{} for name in catalog.LAYOUTS}
    for race in range(1,10):
        tables['ChrRaces'][race] = {'ClientFileString':f'Race{race}', 'Name_lang':f'Race {race}',
                                  'Flags':race, 'FactionID':race+10, 'MaleDisplayID':race*2, 'FemaleDisplayID':race*2+1}
        for sex in (0,1):
            model = race*2+sex
            tables['ChrRaceXChrModel'][model] = {'ChrRacesID':race,'Sex':sex,'ChrModelID':model}
            tables['ChrModel'][model] = {'Sex':sex,'DisplayID':model if race<9 else 999,'CharComponentTextureLayoutID':77}
            for option in range(1,6):
                modern = model*10+option
                tables['ChrCustomizationOption'][modern] = {'ID':modern,'ChrModelID':model}
                for value in (0,1):
                    key = 50000-modern*2-value
                    tables['ChrCustomizationChoice'][key] = {'ID':key,'ChrCustomizationOptionID':modern}
                    tables['ChrCustomizationConversion'][key] = {
                        'ChrRacesID':race,'Sex':sex,'OptionID':option,'Data':value,
                        'DependentOptionID':0,'DependentData':0,'Field_3_4_0_45166_007':-1,
                        'ChrCustomizationChoiceID':key}
    tables['ChrModelMaterial'][1] = {'CharComponentTextureLayoutsID':77,'TextureType':6}
    tables['ChrModelMaterial'][2] = {'CharComponentTextureLayoutsID':77,'TextureType':1}
    tables['ChrModelMaterial'][3] = {'CharComponentTextureLayoutsID':77,'TextureType':8}
    for key,texture_type in enumerate((1,6,8),1):
        tables['ChrCustomizationMaterial'][key] = {'ChrModelTextureTargetID':key}
        tables['ChrModelTextureLayer'][key] = {'CharComponentTextureLayoutsID':77,
            'ChrModelTextureTargetID':[key,0],'TextureType':texture_type}
    for key,row in tables['ChrCustomizationConversion'].items():
        if row['OptionID'] in (1,3):
            tables['ChrCustomizationElement'][key] = {'ChrCustomizationChoiceID':key,
                'RelatedChrCustomizationChoiceID':0,'ChrCustomizationMaterialID':1 if row['OptionID']==1 else 2}
    extra = next(k for k,r in tables['ChrCustomizationConversion'].items()
                 if (r['ChrRacesID'],r['Sex'],r['OptionID'],r['Data'])==(3,1,1,0))
    tables['ChrCustomizationElement'][1] = {'ChrCustomizationChoiceID':extra,
        'RelatedChrCustomizationChoiceID':0,'ChrCustomizationMaterialID':3}
    tables['CharHairGeosets'][1] = {'RaceID':1,'SexID':0,'VariationID':1,'GeosetID':42,'VariationType':3,'GeosetType':0}
    tables['CharacterFacialHairStyles'][1] = {'RaceID':1,'SexID':0,'VariationID':1,'Geoset':[3,4,5,-1,-1]}
    for index,group in enumerate(catalog.HELMET_GROUPS):
        tables['HelmetGeosetData'][index] = {'HelmetGeosetVisDataID':90,'RaceID':index+1,
            'HideGeosetGroup':group,'RaceBitSelection':0,'Field_10_0_0_46047_003':-1}
    return tables


def convert(tables):
    with patch.object(catalog,'named_table',side_effect=lambda data,name:(tables[name],catalog.LAYOUTS[name])):
        return catalog.character_catalog(lambda name:name.encode(),SOURCE)


class CharacterCatalogTests(unittest.TestCase):
    def test_authored_conversions_body_identity_and_helmet_groups(self):
        result = convert(fixture())
        self.assertEqual(len(result['bodies']),16)
        self.assertEqual(len(result['legacyConversions']),160)
        self.assertEqual(result['bodies'][0],{'race':1,'sex':0,'modelId':2,'displayId':2,
                                             'textureLayoutId':77,'textureTypes':[1,6,8]})
        types = {(r['race'],r['sex']):r['types'] for r in result['sectionTextureTypes']}
        self.assertEqual(types[3,1],[1,6,8])
        self.assertEqual(types[6,0],[1,6])
        row = next(v for v in result['legacyConversions'] if (v['race'],v['sex'],v['option'],v['data'])==(1,0,3,1))
        self.assertEqual((row['modernOptionId'],row['choiceId']),(23,49953))
        self.assertEqual(result['facialHair'][0]['geosets'],[3,4,5])
        self.assertEqual(result['helmetMasks'],[{'id':90,'masks':[2,4,8,16,32]}])
        self.assertFalse(result['coverage']['characterCreation'])
        self.assertFalse(result['coverage']['npcCustomization'])

    def test_missing_dial_and_conflicting_playable_body_are_errors(self):
        tables = fixture()
        tables['ChrCustomizationConversion'] = {k:r for k,r in tables['ChrCustomizationConversion'].items()
            if (r['ChrRacesID'],r['Sex'],r['OptionID'],r['Data'])!=(1,0,1,0)}
        with self.assertRaisesRegex(DB2Error,'dial conversion'):
            convert(tables)
        tables = fixture();tables['ChrModel'][2]['DisplayID'] = 999
        with self.assertRaisesRegex(DB2Error,'playable body displays disagree'):
            convert(tables)
        tables = fixture();tables['HelmetGeosetData'][0]['RaceBitSelection'] = 1
        with self.assertRaisesRegex(DB2Error,'helmet'):
            convert(tables)
        tables = fixture();tables['ChrCustomizationMaterial'][1]['ChrModelTextureTargetID'] = 999
        with self.assertRaisesRegex(DB2Error,'texture layer'):
            convert(tables)

    def test_source_layout_and_missing_preparation_fail(self):
        with self.assertRaises(DB2Error):
            catalog.character_catalog(lambda name:b'',{})
        with patch.object(catalog,'named_table',return_value=({},'00000000')):
            with self.assertRaisesRegex(DB2Error,'Unsupported ChrRaces'):
                catalog.character_catalog(lambda name:b'',SOURCE)
        def missing(name):raise FileNotFoundError(name)
        with self.assertRaises(FileNotFoundError):
            catalog.character_catalog(missing,SOURCE)


def retained(client,library,output):
    spec = importlib.util.spec_from_file_location('assets',Path(__file__).with_name('classic-assets.py'))
    assets = importlib.util.module_from_spec(spec);spec.loader.exec_module(assets)
    with assets.CascStorage(client,library) as storage:
        result = catalog.character_catalog(storage.read,assets.client_build(client))
    if output:
        output.write_text(json.dumps(result,separators=(',',':'),allow_nan=False))
    expected = [(49,50),(51,52),(53,54),(55,56),(57,58),(59,60),(1563,1564),(1478,1479)]
    by_body = {(r['race'],r['sex']):r for r in result['bodies']}
    assert len(by_body)==16
    assert {(r['race'],r['sex']) for r in result['sectionTextureTypes'] if 8 in r['types']}=={(6,0),(6,1)}
    for race,pair in enumerate(expected,1):
        for sex in (0,1):
            assert by_body[race,sex]['displayId']==pair[sex]
            for option in range(1,6):
                rows = [r for r in result['legacyConversions'] if (r['race'],r['sex'],r['option'])==(race,sex,option)]
                assert {r['data'] for r in rows}==set(range(len(rows)))
    print(json.dumps({'source':result['source'],'layouts':result['layouts'],
        'counts':{k:len(result[k]) for k in ['races','bodies','legacyConversions','hair','facialHair','helmetMasks']},
        'coverage':result['coverage'],'bodies':result['bodies']},indent=2))


if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--client',type=Path);parser.add_argument('--library',type=Path);parser.add_argument('--output',type=Path)
    options,remaining = parser.parse_known_args()
    tests = unittest.main(argv=[sys.argv[0],*remaining],exit=False).result
    if not tests.wasSuccessful():raise SystemExit(1)
    if options.client and options.library:retained(options.client,options.library,options.output)
