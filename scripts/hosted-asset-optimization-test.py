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
from hosted_asset_optimization import (GLOBAL_WMO_UID, NAXX_ROOT, STANDALONE_RAIDS, naxx_placements,
                                       naxx_wdt, prepare_naxx, prepare_standalone, trim_wmo_group, repack_hosted_assets)

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


    def test_blackwing_keeps_all24_authored_groups_and_source_placement(self):
        config = STANDALONE_RAIDS[469]
        root_name = '__classic/108348.wmo'
        mohd = bytearray(64); struct.pack_into('<I',mohd,4,24)
        root = pack({'MOHD':bytes(mohd), 'MOGI':struct.pack('<I6fi',0,0,0,0,1,1,1,0)*24,
                     'MOGN':b'Room\0', 'GFID':struct.pack('<24I',*range(2000,2024))})
        geometry = pack({'MOVT':struct.pack('<9f',0,0,0,1,0,0,0,1,0),
                         'MOVI':struct.pack('<6H',0,1,2,2,1,0),'MOPY':b'\0'*4})
        group = pack({'MOGP':b'\0'*68+geometry})
        def raw(key):
            if key=='world/maps/blackwinglair/blackwinglair.wdt': return wdt()
            if key=='id:108348': return root
            if key.startswith('id:') and 2000 <= int(key[3:]) < 2024: return group
            if key.endswith('.blp'): return b'BLP2fixture'
            raise FileNotFoundError(key)
        original = World.resource
        def adapted(world,key):
            if key.endswith('.adt'): return adt(placement()).replace(NAXX_ROOT.encode(),root_name.encode())
            return original(world,key)
        world=World(raw)
        with patch.object(World,'resource',adapted): result=prepare_standalone(world,raw,469,config['directory'])
        self.assertEqual(result['sourceUID'],17)
        self.assertEqual(len(result['worldResources']),26)
        self.assertEqual(len(result['map']['floors']),24)
        self.assertEqual(parts(result['wdt'])['MWMO'],(root_name+'\0').encode())
        self.assertTrue(all(f['area'].startswith(str(GLOBAL_WMO_UID)+':') for f in result['map']['floors']))
        with self.assertRaisesRegex(ValueError,'Unsupported standalone'): prepare_standalone(world,raw,469,'moltencore')
        with self.assertRaisesRegex(ValueError,'Unsupported standalone'): prepare_standalone(world,raw,309,"zul'gurub")

    def test_group_trim_keeps_header_unknown_and_repeated_layers_exact(self):
        from classic_world import chunks
        header=bytes(range(68))
        kept=[('MOVT',struct.pack('<9f',0,0,0,1,0,0,0,1,0)),
              ('MOVI',struct.pack('<3H',0,1,2)),('MOPY',b'\0\0'),
              ('MOTV',b'first'),('MOTV',b'second'),('MOCV',b'color'),
              ('MODR',b'props'),('MOLR',b'lights'),('MLIQ',b'liquid'),('UNKN',b'unknown')]
        children=kept+[('MOBN',b'bspnodes'),('MOBR',b'bspfaces'),('MPY2',struct.pack('<2H',0,0))]
        source=pack({'MVER':struct.pack('<I',17),'MOGP':header+b''.join(pack({t:b}) for t,b in children),'OTHR':b'outer'})
        result=trim_wmo_group(source); group=parts(result)['MOGP']
        self.assertEqual(group[:68],header)
        self.assertEqual(list(chunks(group[68:])),kept)
        self.assertEqual(parts(result)['OTHR'],b'outer')
        self.assertEqual(trim_wmo_group(result),result)
        self.assertEqual(trim_wmo_group(pack({'MOHD':b'root'})),pack({'MOHD':b'root'}))

    def test_group_trim_rejects_unconverted_conflicting_or_truncated_input(self):
        base=pack({'MOVT':struct.pack('<9f',0,0,0,1,0,0,0,1,0),'MOVI':struct.pack('<3H',0,1,2)})
        mp=pack({'MPY2':struct.pack('<2H',0,0)})
        for body in (base+mp,base+mp+pack({'MOPY':b'\1\0'})):
            with self.assertRaises(ValueError): trim_wmo_group(pack({'MOGP':b'\0'*68+body}))
        with self.assertRaisesRegex(ValueError,'Truncated'): trim_wmo_group(pack({'MOGP':b'short'}))

    def test_repack_trims_groups_without_changing_resource_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            source,dest=Path(tmp)/'source',Path(tmp)/'dest'
            original=pack({'MOGP':b'\0'*68+pack({'MOBN':b'node','MOBR':b'face','UNKN':b'keep'})})
            writer=ChunkWriter(source,BUILD)
            writer.add('world:room_000.wmo',original);writer.finish()
            report=repack_hosted_assets(source,dest)
            result=json.loads((dest/'manifest.json').read_bytes())
            self.assertEqual(set(result['files']),{'world:room_000.wmo'})
            self.assertEqual(report['removed'],[])
            self.assertEqual(report['groupTables'],{'files':1,'savedBytes':24})
            self.assertEqual(audit(dest)['status'],'verified')

if __name__=='__main__': unittest.main()
