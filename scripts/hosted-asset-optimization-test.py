#!/usr/bin/env python3
"""Small authored fixtures, no client game bytes."""
import gzip
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from classic_world import CENTER, World, pack, parts, read
from hosted_assets import ChunkWriter, audit
from hosted_asset_optimization import (GLOBAL_WMO_UID, NAXX_ROOT, naxx_placements,
                                       naxx_wdt, prepare_naxx, repack_hosted_assets)

BUILD = {'product':'fixture','version':'1','buildKey':'a'*32}


def placement(uid=17, position=(100, 200, 300)):
    row = bytearray(64)
    struct.pack_into('<2I6f6f4H', row, 0, 0, uid, *position, 0, 0, 0,
                     90, 190, 290, 110, 210, 310, 8, 5, 6, 1024)
    return bytes(row)


def adt(row):
    return pack({'MWMO': (NAXX_ROOT+'\0').encode(), 'MWID': struct.pack('<2I',0,0), 'MODF':row}) + pack({'MCNK': b'one'}) + pack({'MCNK': b'two'})


def wdt():
    main = bytearray(64*64*8)
    struct.pack_into('<I', main, 0, 1); struct.pack_into('<I', main, 8, 1)
    return pack({'MVER':struct.pack('<I',18),'MPHD':b'\0'*32,'MAIN':bytes(main)})


class OptimizationTests(unittest.TestCase):
    def test_placement_dedup_and_fail_closed(self):
        row = placement()
        other = bytearray(row); struct.pack_into('<I',other,0,1)
        self.assertEqual(naxx_placements([adt(row),adt(bytes(other))]),row)
        with self.assertRaisesRegex(ValueError,'unique'): naxx_placements([])
        with self.assertRaisesRegex(ValueError,'unique'): naxx_placements([adt(row),adt(placement(uid=18))])
        with self.assertRaisesRegex(ValueError,'Conflicting'): naxx_placements([adt(row),adt(placement(position=(101,200,300)))])

    def test_global_transform_preserves_sets_rotation_and_bounds(self):
        row = placement()
        result = parts(naxx_wdt(wdt(),row))
        self.assertEqual(read(result['MPHD'],'<I',0)[0]&1,1)
        self.assertEqual(set(result['MAIN']),{0})
        modf = result['MODF']
        self.assertEqual(read(modf,'<2I',0),(110251,GLOBAL_WMO_UID))
        for actual, expected in zip(read(modf,'<3f',8),(CENTER-300,CENTER-100,200)):
            self.assertAlmostEqual(actual,expected,places=2)
        self.assertEqual(modf[20:32],row[20:32])
        self.assertEqual(read(modf,'<4H',56),(0,5,6,1024))
        for actual, expected in zip(read(modf,'<6f',32),(CENTER-310,CENTER-110,190,CENTER-290,CENTER-90,210)):
            self.assertAlmostEqual(actual,expected,places=2)

    def test_prepare_all73_groups_uses_global_uid_without_mutating_world(self):
        mohd = bytearray(64); struct.pack_into('<I',mohd,4,73)
        info = b''.join(struct.pack('<I6fi',0,0,0,0,1,1,1,0) for _ in range(73))
        root = pack({'MOHD':bytes(mohd),'MOGI':info,'MOGN':b'Room\0',
                     'GFID':struct.pack('<73I',*range(2000,2073))})
        geometry = pack({'MOVT':struct.pack('<9f',0,0,0,1,0,0,0,1,0),
                         'MOVI':struct.pack('<6H',0,1,2,2,1,0),'MOPY':b'\0'*4})
        group = pack({'MOGP':b'\0'*68+geometry})
        def raw(key):
            if key=='world/maps/stratholme raid/stratholme raid.wdt': return wdt()
            if key=='id:110251': return root
            if key.startswith('id:') and 2000 <= int(key[3:]) < 2073: return group
            if key.endswith('.blp'): return b'BLP2fixture'
            raise FileNotFoundError(key)
        original_resource = World.resource
        def adapted(self,key):
            if key.endswith('.adt'): return adt(placement())
            return original_resource(self,key)
        world=World(raw)
        with patch.object(World,'resource',adapted): result=prepare_naxx(world,raw)
        self.assertIs(world.raw,raw)
        self.assertEqual(len(result['worldResources']),75)
        self.assertFalse(any(key.endswith('.adt') for key in result['worldResources']))
        self.assertEqual(len(result['map']['areas']),73)
        self.assertEqual(len(result['map']['floors']),73)
        self.assertTrue(all(row['area'].startswith(str(GLOBAL_WMO_UID)+':') for row in result['map']['floors']))
        self.assertEqual(parts(result['wdt'])['MWMO'],(NAXX_ROOT+'\0').encode())
        self.assertEqual(read(parts(result['wdt'])['MODF'],'<I',0)[0],0)

    def test_prune_preserves_prepared_resources_appearance_and_runtime_formats(self):
        with tempfile.TemporaryDirectory() as tmp:
            source,dest=Path(tmp)/'source',Path(tmp)/'dest'
            writer=ChunkWriter(source,BUILD,chunk_bytes=16)
            values={'catalog:spells':b'{}','model:id:3':b'MD20model','world:raid.wdt':b'world',
                    'map:533':b'{}','read:id:1':b'BLP2texture','read:id:2':b'BLP1texture',
                    'read:fonts/a.ttf':b'\0\1\0\0font','read:dbfilesclient/required.db2':b'WDC5appearance',
                    'read:id:3':b'MD21rawmodel','read:unused.db2':b'WDC5unused','read:id:99':b'SKINunused'}
            for key,value in values.items(): writer.add(key,value)
            writer.finish(appearanceInputs=['read:dbfilesclient/required.db2'],status='ready',aliases={'character/a.m2':'id:3'})
            original=(source/'manifest.json').read_bytes()
            with self.assertRaisesRegex(ValueError,'outside'): repack_hosted_assets(source,source/'nested')
            report=repack_hosted_assets(source,dest)
            result=json.loads((dest/'manifest.json').read_bytes())
            self.assertEqual(set(report['removed']),{'read:id:3','read:unused.db2','read:id:99'})
            self.assertEqual(set(result['files']),set(values)-set(report['removed']))
            self.assertEqual(result['aliases'],{'character/a.m2':'id:3'})
            self.assertEqual((source/'manifest.json').read_bytes(),original)
            self.assertEqual(audit(dest)['status'],'verified')
            with self.assertRaises(FileExistsError): repack_hosted_assets(source,dest)

    def test_explicit_world_exclusion_and_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            source,dest=Path(tmp)/'source',Path(tmp)/'dest'
            writer=ChunkWriter(source,BUILD,chunk_bytes=16)
            writer.add('world:exterior.adt',b'exterior'); writer.add('world:raid.wdt',b'old');writer.add('map:533',b'oldmap')
            writer.finish(appearanceInputs=[])
            report=repack_hosted_assets(source,dest,{'world:raid.wdt':b'new','map:533':b'newmap'},{'world:exterior.adt'})
            result=json.loads((dest/'manifest.json').read_bytes())
            self.assertEqual(report['removed'],['world:exterior.adt'])
            self.assertEqual(result['files']['world:raid.wdt']['bytes'],3)
            with self.assertRaisesRegex(ValueError,'Only explicit world'): repack_hosted_assets(source,Path(tmp)/'bad',excluded_world={'model:id:3'})

if __name__=='__main__': unittest.main()
