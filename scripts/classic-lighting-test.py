#!/usr/bin/env python3
"""Lighting schema/string fixtures, plus optional read-only retained-client proof."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

from classic_db2 import DB2Error
import classic_lighting as lighting
from classic_spells import schema


def skybox_table(name=b'Environments\\Stars\\Stars.mdx\0'):
    fields = [(i*32,32,0,0,0,0,0) for i in range(4)]
    start = 244 + len(fields)*28
    data = bytearray(start)
    data[:4] = b'WDC5'
    struct.pack_into('<9I2H7I',data,136,1,4,16,len(name),0,0x9d4956ff,1,1,0,4,0,4,0,0,96,0,0,1)
    struct.pack_into('<Q8I',data,204,0,start,1,len(name),0,4,0,0,0)
    for i,field in enumerate(fields):
        struct.pack_into('<HH5I',data,260+i*24,*field)
    data.extend(struct.pack('<4I',16,0,0,0))
    data.extend(name)
    data.extend(struct.pack('<I',4))
    return data


class LightingTests(unittest.TestCase):
    def test_pinned_schemas_name_the_actual_world_coordinates_and_common_keys(self):
        fields,_,_=schema('Light',lighting.LAYOUTS['Light'])
        self.assertEqual(fields,['GameCoords','GameFalloffStart','GameFalloffEnd','ContinentID','LightParamsID'])
        fields,_,_=schema('LightData',lighting.LAYOUTS['LightData'])
        self.assertEqual(fields[:4],['LightParamID','Time','DirectColor','AmbientColor'])
        self.assertEqual(lighting.COLOR_FIELDS[11:14],['CloudLayer1AmbientColor','CloudEmissiveColor','CloudLayer2AmbientColor'])

    def test_skybox_names_resolve_inline_relative_strings_and_preserve_authored_labels(self):
        self.assertEqual(lighting.skybox_names(skybox_table()),{4:'Environments\\Stars\\Stars.mdx'})
        with self.assertRaises(DB2Error):
            lighting.skybox_names(skybox_table()[:-1])
        data=skybox_table()
        struct.pack_into('<i',data,356,-1000)
        with self.assertRaisesRegex(DB2Error,'outside its string table'):
            lighting.skybox_names(data)
        with self.assertRaisesRegex(DB2Error,'Invalid LightSkybox'):
            lighting.skybox_names(skybox_table(b'../outside.m2\0'))

    def test_numeric_skybox_file_join_precedes_friendly_name_and_keeps_label(self):
        names = {4: 'Environments\\Stars\\Stars.mdx', 655: 'Dueling Zone - Skybox', 670: 'Scarlet Skybox', 1: 'Environments\\Stars\\StratholmeSkybox.mdx',
                 329: 'environments\\stars\\stars.mdx - combine with procedural'}
        rows = {4: {'SkyboxFileDataID': 130629}, 655: {'SkyboxFileDataID': 130495},
                670: {'SkyboxFileDataID': 130502}, 1: {'SkyboxFileDataID': 0}, 329: {'SkyboxFileDataID': 0}}
        result = {row['id']: row for row in lighting.skybox_models(names, rows)}
        for key, file_id in [(4, 130629), (655, 130495), (670, 130502)]:
            self.assertEqual(result[key]['path'], f'__classic/{file_id}.m2')
            self.assertEqual(result[key]['label'], names[key])
            self.assertEqual(result[key]['fileDataID'], file_id)
        self.assertEqual(result[1]['path'], 'Environments/Stars/StratholmeSkybox.m2')
        self.assertEqual(result[329]['path'], 'environments/stars/stars.m2')
        self.assertEqual(result[329]['label'], names[329])
        with self.assertRaisesRegex(DB2Error, 'no authored model file'):
            lighting.skybox_models({9: 'Friendly label'}, {9: {'SkyboxFileDataID': 0}})
        with self.assertRaisesRegex(DB2Error, 'Invalid LightSkybox file ID'):
            lighting.skybox_models({9: 'Friendly label'}, {9: {'SkyboxFileDataID': -1}})

    def test_missing_underwater_links_remain_unknown_and_authored_values_are_unscaled(self):
        bits=lambda value:struct.unpack('<I',struct.pack('<f',value))[0]
        tables={
            'Light':{1:{'LightParamsID':[12,10,4,0],'ContinentID':0,'GameCoords':[bits(-10),bits(20),bits(30)],'GameFalloffStart':bits(5),'GameFalloffEnd':bits(50)}},
            'LightParams':{12:{'Glow':bits(.65),'HighlightSky':1,'WaterShallowAlpha':bits(.5),'WaterDeepAlpha':bits(1),'OceanShallowAlpha':bits(.75),'OceanDeepAlpha':bits(1),'LightSkyboxID':0}},
            'LightData':{100:{'LightParamID':12,'Time':1440,'FogEnd':bits(18000),'FogScaler':bits(-.5),'CloudDensity':bits(.7),**{name:0x123456 for name in lighting.COLOR_FIELDS}}},
            'LightSkybox':{4:{}}}
        with patch.object(lighting,'read_tables',return_value=(tables,lighting.LAYOUTS)),patch.object(lighting,'skybox_names',return_value={4:'Environments/Stars/Stars.m2'}):
            value=lighting.lighting_catalog(lambda _:b'bytes',{'version':'fixture'})
        self.assertEqual(value['lights'][0]['params'],[12,None,10,None,4])
        self.assertEqual(value['lights'][0]['position'],[-10,20,30])
        self.assertEqual(value['samples'][0]['fogEnd'],18000)
        self.assertEqual(value['samples'][0]['fogStart'],-.5)
        self.assertFalse(value['coverage']['underwaterProfileLinks'])
        self.assertEqual(value['samples'][0]['colors'],[0x123456]*18)

    def test_unknown_layout_and_nonfinite_values_fail_explicitly(self):
        with self.assertRaisesRegex(DB2Error,'Non-finite'):
            lighting.number(0x7f800000)
        with patch.object(lighting,'read_tables',return_value=({},{})):
            with self.assertRaisesRegex(DB2Error,'Unsupported Classic lighting'):
                lighting.lighting_catalog(lambda _:b'bytes',{})


def retained(client,library):
    spec=importlib.util.spec_from_file_location('assets',Path(__file__).with_name('classic-assets.py'))
    assets=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    with assets.CascStorage(client,library) as storage:
        catalog=lighting.lighting_catalog(storage.read,assets.client_build(client))
    print(json.dumps({'source':catalog['source'],'layouts':catalog['layouts'],
        'counts':{key:len(catalog[key]) for key in ['lights','params','samples','skyboxes']},
        'coverage':catalog['coverage'],'fallbackLight':next(v for v in catalog['lights'] if v['id']==1)},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--client',type=Path)
    parser.add_argument('--library',type=Path)
    options,remaining=parser.parse_known_args()
    result=unittest.main(argv=[sys.argv[0],*remaining],exit=False).result
    if not result.wasSuccessful():
        raise SystemExit(1)
    if options.client and options.library:
        retained(options.client,options.library)
