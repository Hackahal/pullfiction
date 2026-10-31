#!/usr/bin/env python3
"""World metadata and WDC5 string tests; optional retained client is read-only."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from classic_db2 import DB2Error
import classic_table_strings as strings
import classic_world_catalog as catalog

SOURCE = {'product':'wow_classic_era','version':'1.15.9.70576','buildKey':'5604ce35a8644bdcf0e26c1daf979c15'}


def string_table(text="Zul'Gurub å".encode()+b'\0'):
    start=300
    value=bytearray(start)
    value[:4]=b'WDC5'
    struct.pack_into('<9I2H7I',value,136,1,2,8,len(text),0,0x12345678,7,9,0,4,0,2,0,0,48,0,0,1)
    struct.pack_into('<Q8I',value,204,0,start,1,len(text),0,4,0,0,2)
    struct.pack_into('<HH5I',value,252,0,32,0,0,0,0,0)
    struct.pack_into('<HH5I',value,276,32,32,0,0,0,0,0)
    value.extend(struct.pack('<2I',8,42))
    value.extend(text)
    value.extend(struct.pack('<5I',7,8,7,9,8))
    return value


class WorldCatalogTests(unittest.TestCase):
    def test_relative_utf8_strings_follow_copy_chains_without_external_data(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'Fixture.dbd').write_text('COLUMNS\nstring Text\nint Number\n')
            with patch.object(strings,'DEFINITIONS',Path(directory)),patch.object(strings,'schema',return_value=(['Text','Number'],None,{'Number':(32,False)})):
                rows,layout=strings.named_table(string_table(),'Fixture')
                self.assertEqual(layout,'12345678')
                self.assertEqual([rows[k]['Text'] for k in [7,8,9]],["Zul'Gurub å"]*3)
                self.assertEqual(rows[9]['Number'],42)
                self.assertEqual(rows[9]['ID'],9)
                changed=string_table();struct.pack_into('<i',changed,300,-10)
                with self.assertRaisesRegex(DB2Error,'outside its string table'):
                    strings.named_table(changed,'Fixture')
                with self.assertRaises(DB2Error):
                    strings.named_table(string_table()[:-1],'Fixture')
                with self.assertRaisesRegex(DB2Error,'UTF-8'):
                    strings.named_table(string_table(b'\xff\0'),'Fixture')

    def fixture(self):
        return {'Map':{409:{'Directory':'MoltenCore','MapName_lang':'Molten Core','MapDescription0_lang':'A','MapDescription1_lang':'H','InstanceType':2,'AreaTableID':2717,'LoadingScreenID':192,'MaxPlayers':40,'MinimapIconScale':0x3f800000}},
                'AreaTable':{2717:{'ContinentID':409,'ParentAreaID':0,'AreaBit':7,'Flags':[1,0],'FactionGroupMask':0,'ExplorationLevel':-1,'AreaName_lang':'Molten Core'}},
                'WMOAreaTable':{1:{'WMOID':52,'NameSetID':0,'WMOGroupID':-1,'SoundProviderPref':0,'SoundProviderPrefUnderwater':11,'AmbienceID':5,'ZoneMusic':6,'IntroSound':7,'AreaTableID':2717,'AreaName_lang':'A room'}}}

    def test_catalog_preserves_authored_fields_and_declares_unused_queue_metadata(self):
        reads=[]
        def read(name):reads.append(name);return name.encode()
        tables=self.fixture()
        with patch.object(catalog,'named_table',side_effect=lambda data,name:(tables[name],catalog.LAYOUTS[name])):
            value=catalog.world_catalog(read,SOURCE)
        self.assertEqual(reads,['dbfilesclient/map.db2','dbfilesclient/areatable.db2','dbfilesclient/wmoareatable.db2'])
        self.assertEqual(value['maps'][0]['areaTableId'],2717)
        self.assertEqual(value['maps'][0]['maxPlayers'],40)
        self.assertEqual(value['maps'][0]['minimapIconScale'],1)
        self.assertEqual(value['areas'][0]['explorationLevel'],-1)
        self.assertEqual(value['wmoAreas'][0]['groupId'],-1)
        self.assertEqual(value['wmoAreas'][0]['soundProvider'],[0,11])
        self.assertFalse(value['coverage']['legacyBattlegroundMetadata'])

    def test_unknown_source_layout_missing_file_and_invalid_directory_fail(self):
        with self.assertRaisesRegex(DB2Error,'source'):
            catalog.world_catalog(lambda _:b'',{})
        with patch.object(catalog,'named_table',return_value=({},'00000000')):
            with self.assertRaisesRegex(DB2Error,'Unsupported Map layout'):
                catalog.world_catalog(lambda _:b'',SOURCE)
        def missing(_):raise FileNotFoundError('not local')
        with self.assertRaisesRegex(FileNotFoundError,'not local'):
            catalog.world_catalog(missing,SOURCE)
        tables=self.fixture();tables['Map'][409]['Directory']='../outside'
        with patch.object(catalog,'named_table',side_effect=lambda data,name:(tables[name],catalog.LAYOUTS[name])):
            with self.assertRaisesRegex(DB2Error,'directory'):
                catalog.world_catalog(lambda _:b'',SOURCE)


def retained(client,library,output):
    spec=importlib.util.spec_from_file_location('assets',Path(__file__).with_name('classic-assets.py'))
    assets=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets)
    with assets.CascStorage(client,library) as storage:
        result=catalog.world_catalog(storage.read,assets.client_build(client))
    if output:
        output.write_text(json.dumps(result,separators=(',',':'),allow_nan=False))
    by_id={row['id']:row for row in result['maps']}
    for key in [0,1,249,309,409,469,509,531,533,2856]:
        assert key in by_id,f'Missing required world map {key}'
    assert by_id[533]['directory']=='Stratholme Raid'
    assert by_id[409]['areaTableId']==2717
    print(json.dumps({'source':result['source'],'layouts':result['layouts'],
        'counts':{key:len(result[key]) for key in ['maps','areas','wmoAreas']},
        'coverage':result['coverage'],'requiredMaps':{key:by_id[key] for key in [0,1,249,309,409,469,509,531,533,2856]}},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--client',type=Path);parser.add_argument('--library',type=Path);parser.add_argument('--output',type=Path)
    options,remaining=parser.parse_known_args()
    tests=unittest.main(argv=[sys.argv[0],*remaining],exit=False).result
    if not tests.wasSuccessful():raise SystemExit(1)
    if options.client and options.library:retained(options.client,options.library,options.output)
