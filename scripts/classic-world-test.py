#!/usr/bin/env python3
"""World adapter fixtures; optional retained-client checks use --client and --library."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

from classic_compat import CompatError
from classic_terrain import chunk, chunks
from classic_world import World, adapt_wdt, adapt_wmo, parts, rotate, terrain_floor, wmo_floor


def blob(**values):
    return b''.join(chunk(tag, value) for tag, value in values.items())


def placement(fdid=100, uid=7, position=(0, 0, 0), rotation=(0, 180, 0), flags=0):
    out = bytearray(64)
    struct.pack_into('<2I6f', out, 0, fdid, uid, *position, *rotation)
    struct.pack_into('<H', out, 56, flags)
    return bytes(out)


def root(groups=2):
    header = bytearray(64)
    struct.pack_into('<I', header, 4, groups)
    info = bytearray()
    for group in range(groups):
        info.extend(struct.pack('<I6fi', 0, 0, 0, group*10, 3, 3, group*10+2, group*7))
    return blob(MOHD=header, MOGI=info, MOGN=b'Bottom\0Upper\0', GFID=struct.pack('<'+'I'*groups, *range(101, 101+groups)))


def group(height=0):
    vertices = [(0, 0, height), (3, 0, height), (0, 3, height),
                (0, 0, height+10), (3, 0, height+10), (0, 3, height+10)]
    # Two upward floors, reversed ceiling, detail sheet and vertical wall.
    triangles = [(0, 1, 2), (3, 4, 5), (2, 1, 0), (0, 1, 2), (0, 3, 1)]
    return blob(MOGP=bytes(68)+blob(MOVT=b''.join(struct.pack('<3f', *p) for p in vertices),
                                    MOVI=b''.join(struct.pack('<3H', *t) for t in triangles),
                                    MOPY=bytes([0, 0, 0, 0, 0, 0, 4, 0, 0, 0])))


def modern_group():
    value = parts(group())['MOGP']
    geometry = parts(value[68:])
    del geometry['MOPY']
    geometry['MPY2'] = b''.join(struct.pack('<HH',flags,material) for flags,material in
        [(97,12),(8,0xffff),(33,14),(4,15),(33,16)])
    batch = bytearray(24)
    struct.pack_into('<HIH',batch,10,12,0,3)
    batch[22] = 2
    geometry['MOBA'],geometry['MOGX'] = bytes(batch),bytes(256)
    return blob(MOGP=value[:68]+blob(**geometry))


def wdt(**values):
    defaults = dict(MPHD=struct.pack('<I', 1), MAIN=bytes(4096*8),
                    MODF=placement(position=(11, 22, 33)))
    defaults.update(values)
    return blob(**defaults)


class MapFileTests(unittest.TestCase):
    def test_metadata_resolves_numeric_wdt_for_resources_and_tactical_map(self):
        reads=[]
        def read(name):
            reads.append(name)
            return wdt()
        world=World(read)
        world.set_maps([{'Directory':'New Dungeon','WdtFileDataID':123},
                        {'Directory':'Unreleased','WdtFileDataID':0}])
        self.assertEqual(world.wdt('new dungeon')['MPHD'],struct.pack('<I',1))
        world.resource('world/maps/New Dungeon/New Dungeon.wdt')
        self.assertEqual(reads,['id:123','id:123'])
        self.assertEqual(world.source('world/maps/Unreleased/Unreleased.wdt'),
                         'world/maps/Unreleased/Unreleased.wdt')
        with self.assertRaisesRegex(CompatError,'Conflicting'):
            world.set_maps([{'Directory':'New Dungeon','WdtFileDataID':1},
                            {'Directory':'new dungeon','WdtFileDataID':2}])
        with self.assertRaisesRegex(CompatError,'directory'):
            world.set_maps([{'Directory':'../outside','WdtFileDataID':123}])


class WorldTests(unittest.TestCase):
    def setUp(self):
        self.reads = []
        self.files = {'world/maps/test/test.wdt': wdt(), 'id:100': root(),
                      'id:101': group(), 'id:102': group(20)}
        def read(name):
            self.reads.append(name)
            return self.files[name]
        self.world = World(read)

    def test_world_conversion_resolves_file_id_groups_without_original_data(self):
        value = parts(self.world.resource('World/Maps/Test/Test.wdt'))
        self.assertEqual(value['MWMO'], b'__classic/100.wmo\0')
        self.assertEqual(self.world.resource('__classic/100_000.wmo'), self.files['id:101'])
        self.assertEqual(self.world.resource('__classic/100_001.wmo'), self.files['id:102'])
        with self.assertRaisesRegex(CompatError, 'outside GFID'):
            self.world.resource('__classic/100_002.wmo')

    def test_root_material_and_doodad_offsets_preserve_flags_and_zero_textures(self):
        material, doodad = bytearray(64), bytearray(40)
        struct.pack_into('<I', material, 12, 345)
        struct.pack_into('<I', doodad, 0, 0x7f000001)
        value = parts(adapt_wmo(blob(MOHD=bytes(64), MOMT=material, MODI=struct.pack('<2I', 600, 601), MODD=doodad)))
        self.assertEqual(value['MOTX'], b'__classic/345.blp\0\0\0')
        self.assertEqual(struct.unpack_from('<I', value['MODD'])[0], 0x7f000000+len(b'__classic/600.m2\0'))
        self.assertEqual(value['MODN'], b'__classic/600.m2\0__classic/601.m2\0')

    def test_modern_group_normalizes_triangle_and_batch_materials_without_changing_geometry(self):
        source = modern_group()
        before = parts(parts(source)['MOGP'][68:])
        converted = adapt_wmo(source)
        after = parts(parts(converted)['MOGP'][68:])
        self.assertEqual(after['MOPY'],bytes([97,12,8,255,33,14,4,15,33,16]))
        for name in ['MOVT','MOVI','MONR','MOGX','MPY2']:
            if name in before:self.assertEqual(after[name],before[name])
        self.assertEqual(after['MOBA'][22:24],bytes([0,12]))
        self.assertEqual(parts(converted)['MOGP'][:68],parts(source)['MOGP'][:68])
        self.assertEqual(adapt_wmo(converted),converted,'group normalization is idempotent')
        vertices,indices = wmo_floor(converted,(0,0,0),(0,180,0))
        self.assertEqual(len(indices),6,'render floor and collision-only floor remain, detail/ceiling/wall do not')
        self.assertEqual(sorted({p[2] for p in vertices}),[0,10])
        repeated = blob(MOGP=parts(source)['MOGP']+chunk('MOTV',b'first')+chunk('MOTV',b'second'))
        result = list(chunks(parts(adapt_wmo(repeated))['MOGP'][68:]))
        self.assertEqual([v for name,v in result if name=='MOTV'],[b'first',b'second'])

    def test_modern_group_rejects_unrepresentable_fields_and_corrupt_triangle_metadata(self):
        source = parts(modern_group())['MOGP']
        geometry = parts(source[68:])
        variants = [dict(geometry,MPY2=geometry['MPY2'][:-1]),
                    dict(geometry,MPY2=geometry['MPY2'][:-4]),
                    dict(geometry,MPY2=struct.pack('<HH',0x100,12)+geometry['MPY2'][4:]),
                    dict(geometry,MPY2=struct.pack('<HH',97,256)+geometry['MPY2'][4:]),
                    dict(geometry,MPY2=struct.pack('<HH',97,0xffff)+geometry['MPY2'][4:]),
                    dict(geometry,MOPY=bytes(10)),
                    dict(geometry,MOVI=struct.pack('<H',999)+geometry['MOVI'][2:])]
        for fields in variants:
            with self.assertRaises(CompatError):
                adapt_wmo(blob(MOGP=source[:68]+blob(**fields)))
        for offset,fmt,value in [(10,'<H',256),(12,'<I',999),(16,'<H',2)]:
            batch = bytearray(geometry['MOBA']);struct.pack_into(fmt,batch,offset,value)
            with self.assertRaises(CompatError):
                adapt_wmo(blob(MOGP=source[:68]+blob(**dict(geometry,MOBA=bytes(batch)))))

    def test_map_is_actual_placed_geometry_with_separate_group_heights(self):
        value = self.world.map(409, 'Test')
        self.assertEqual(value['map'], 409)
        self.assertEqual(value['tiles'], [])
        self.assertEqual([a['name'] for a in value['areas']], ['Bottom', 'Upper'])
        self.assertEqual([a['id'] for a in value['areas']], ['7:0', '7:1'])
        self.assertEqual([a['height'] for a in value['areas']], [38, 58])
        self.assertEqual(value['bounds'], [-25, -14, -22, -11])
        self.assertEqual(value['floors'][0]['vertices'][0], [11, 22, 33])
        self.assertEqual(len(value['floors'][0]['indices']), 6)
        self.assertNotIn('id:103', self.reads)
        self.assertTrue(all(not r.startswith(('http:', 'https:')) for r in self.reads))

    def test_floor_metadata_retains_authored_interior_flags(self):
        value = parts(self.files['id:100'])
        info = bytearray(value['MOGI'])
        struct.pack_into('<I', info, 0, 0x2000)
        value['MOGI'] = bytes(info)
        self.files['id:100'] = blob(**value)
        floors = self.world.map(409, 'Test')['floors']
        self.assertTrue(floors[0]['interior'])
        self.assertFalse(floors[1]['interior'])

    def test_modern_wmo_minimap_uses_authored_id_group_and_grid_without_name_translation(self):
        value = parts(self.files['id:100'])
        header, groups = bytearray(value['MOHD']), bytearray(value['MOGI'])
        struct.pack_into('<I',header,32,2714)
        struct.pack_into('<2f',groups,16,300,200)
        value['MOHD'],value['MOGI'] = bytes(header),bytes(groups)
        self.files['id:100'] = blob(**value)
        self.files.update({'dbfilesclient/wmominimaptexture.db2':b'fixture',
                           'id:999':b'local minimap BLP','id:998':b'other local minimap BLP'})
        rows = {1:{'WMOID':2714,'GroupNum':0,'BlockX':1,'BlockY':0,'FileDataID':999},
                2:{'WMOID':2714,'GroupNum':0,'BlockX':0,'BlockY':1,'FileDataID':998}}
        with patch('classic_world.named_table',return_value=(rows,'01230a50')):
            result = self.world.map(409,'Test')
        self.assertEqual([t['resource'] for t in result['tiles']],['id:998','id:999'])
        self.assertEqual([t['cell'] for t in result['tiles']],[[0,1],[1,0]])
        self.assertEqual(result['tiles'][0]['corners'],[[11,278],[139,278],[139,150],[11,150]])
        self.assertEqual(result['tiles'][1]['corners'],[[139,150],[267,150],[267,22],[139,22]])
        self.assertEqual(self.reads.count('dbfilesclient/wmominimaptexture.db2'),1)
        self.assertIn('id:999',self.reads)
        self.assertEqual(result['floors'][0]['vertices'][0],[11,22,33])

    def test_modern_minimap_unknown_layout_duplicate_reference_and_missing_file_are_explicit(self):
        self.files['dbfilesclient/wmominimaptexture.db2'] = b'fixture'
        row = {'WMOID':2714,'GroupNum':0,'BlockX':0,'BlockY':0,'FileDataID':999}
        for rows,layout,message in [({1:row},'00000000','Unsupported'),
                                    ({1:row,2:dict(row,FileDataID=998)},'01230a50','Ambiguous')]:
            with patch('classic_world.named_table',return_value=(rows,layout)):
                for _ in range(2):
                    with self.assertRaisesRegex(CompatError,message):
                        self.world.wmo_minimap(2714,0,0,0)
        with patch('classic_world.named_table',return_value=({1:row},'01230a50')):
            self.world.wmo_minimaps = None
            with self.assertRaises(KeyError):
                self.world.wmo_minimap(2714,0,0,0)
        self.assertIsNone(self.world.wmo_minimap(2714,0,1,0),'an unauthored cell has no invented tile')

    def test_identical_minimap_copies_and_unrelated_conflicts_do_not_block_a_world(self):
        self.files['dbfilesclient/wmominimaptexture.db2'] = b'fixture'
        self.files['id:999'] = b'local minimap'
        row = {'WMOID':2714,'GroupNum':0,'BlockX':0,'BlockY':0,'FileDataID':999}
        rows = {1:row,2:dict(row),3:dict(row,WMOID=777),4:dict(row,WMOID=777,FileDataID=998)}
        with patch('classic_world.named_table',return_value=(rows,'01230a50')):
            self.assertEqual(self.world.wmo_minimap(2714,0,0,0),'id:999')
            with self.assertRaisesRegex(CompatError,'Ambiguous'):
                self.world.wmo_minimap(777,0,0,0)

    def test_walkable_filter_keeps_stacked_floors_and_drops_ceiling_wall_detail(self):
        vertices, indices = wmo_floor(group(), (10, 20, 30), (0, 180, 0))
        self.assertEqual(len(indices), 6)
        self.assertEqual(sorted({p[2] for p in vertices}), [30, 40])

    def test_floor_extraction_accepts_multiple_uv_layers_but_rejects_duplicate_geometry(self):
        body = parts(group())['MOGP']
        layered = chunk('MOGP',body + chunk('MOTV',bytes(48)) + chunk('MOTV',bytes(48)))
        self.assertEqual(wmo_floor(layered,(0,0,0),(0,180,0)),
                         wmo_floor(group(),(0,0,0),(0,180,0)))
        bad = chunk('MOGP',body + chunk('MOVT',bytes(12)))
        with self.assertRaisesRegex(CompatError,'Duplicate WMO floor geometry'):
            wmo_floor(bad,(0,0,0),(0,180,0))
        self.assertEqual(rotate((1, 2, 3), (0, 180, 0)), [1, 2, 3])
        tilted = rotate((1, 2, 3), (30, 45, 60))
        # coords.rs's independent quaternion golden, applied in Bevy then mapped back.
        for actual, expected in zip(tilted, [-2.8850841162, -.6250656257, 2.2990370707]):
            self.assertAlmostEqual(actual, expected, places=5)

    def test_scope_and_empty_map_fail_before_returning_schematic(self):
        for resource in ('http://remote/test.wdt', 'world/maps/../test.wdt', '__classic/4294967295.wmo', 'interface/worldmap/a.wdt'):
            with self.subTest(resource=resource), self.assertRaises(CompatError):
                self.world.resource(resource)
        self.assertEqual(self.reads, [])
        for map_id, directory in ((False, 'Test'), (1, '../Test'), (0, 'Test')):
            with self.assertRaises(CompatError):
                self.world.map(map_id, directory)
        self.files['world/maps/test/test.wdt'] = wdt(MODF=b'')
        with self.assertRaisesRegex(CompatError, 'no available local'):
            self.world.map(409, 'Test')

    def test_different_selected_map_does_not_reuse_previous_geometry(self):
        first = self.world.map(409, 'Test')
        self.files['world/maps/other/other.wdt'] = wdt(MODF=placement(position=(100, 200, 300)))
        second = self.world.map(533, 'Other')
        self.assertNotEqual(first['bounds'], second['bounds'])
        self.assertEqual(second['floors'][0]['vertices'][0], [100, 200, 300])

    def test_terrain_metadata_has_actual_heights_holes_and_north_up_tile_corners(self):
        main, maid = bytearray(4096*8), bytearray(4096*32)
        struct.pack_into('<I', main, (31*64+30)*8, 1)
        struct.pack_into('<8I', maid, (31*64+30)*32, 200, 201, 0, 202, 0, 0, 0, 203)
        self.files['world/maps/outdoor/outdoor.wdt'] = wdt(MPHD=struct.pack('<I', 4), MAIN=main, MAID=maid, MODF=b'')
        header = bytearray(128)
        struct.pack_into('<3f', header, 0x68, 100, 200, 30)
        struct.pack_into('<H', header, 0x3c, 1)
        self.files.update({'id:200': blob(MCNK=header+blob(MCVT=struct.pack('<145f', *range(145)))),
                           'id:201': b'', 'id:203': b'local BLP'})
        value = self.world.map(309, 'Outdoor')
        self.assertEqual(value['tiles'][0]['resource'], 'id:203')
        north, west = 1600/3, 2*1600/3
        self.assertEqual(value['tiles'][0]['corners'], [[north, west], [north, west-1600/3], [north-1600/3, west-1600/3], [north-1600/3, west]])
        self.assertEqual(value['floors'][0]['vertices'][0], [100, 200, 30])
        self.assertEqual(len(value['floors'][0]['indices']), 18, 'one coarse cell containing a real hole stays open')
        self.assertNotIn('id:202', self.reads, 'tactical metadata never loads terrain texture layers')

    def test_missing_required_geometry_is_explicit_but_minimap_is_optional(self):
        del self.files['id:101']
        with self.assertRaises(KeyError):
            self.world.map(409, 'Test')
        with self.assertRaises(CompatError):
            terrain_floor(blob(MCNK=bytes(128)))


def retained_client_checks(client, library):
    spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    with assets.CascStorage(client, library) as storage:
        world = World(storage.read)
        for map_id, directory in [(409, 'MoltenCore'), (533, 'Stratholme Raid'), (309, "Zul'gurub"), (2856,'2856')]:
            name = f'world/maps/{directory.lower()}/{directory.lower()}.wdt'
            converted = world.resource(name)
            wdt_parts = parts(converted)
            if wdt_parts.get('MWMO'):
                resource = wdt_parts['MWMO'].split(b'\0')[0].decode()
            else:
                for y in range(64):
                    for x in range(64):
                        if struct.unpack_from('<I', wdt_parts['MAIN'], (y*64+x)*8)[0] & 1:
                            resource = f'world/maps/{directory.lower()}/{directory.lower()}_{x}_{y}.adt'
                            break
                    else:
                        continue
                    break
            assert world.resource(resource), 'Required world geometry is missing'
            if resource.endswith('.wmo'):
                assert world.resource(resource[:-4]+'_000.wmo'), 'Required interior group is missing'
            value = world.map(map_id, directory)
            assert value['floors'] and all(f['indices'] for f in value['floors'])
            assert all(max(f['indices']) < len(f['vertices']) for f in value['floors'])
            assert value['bounds'][0] < value['bounds'][2] and value['bounds'][1] < value['bounds'][3]
            print(json.dumps({'directory': directory, 'tiles': len(value['tiles']), 'areas': len(value['areas']),
                              'triangles': sum(len(f['indices'])//3 for f in value['floors']),
                              'bounds': value['bounds'], 'geometryValidated': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--client', type=Path)
    parser.add_argument('--library', type=Path)
    args, tests = parser.parse_known_args()
    if args.client:
        if not args.library:
            parser.error('--client requires --library')
        retained_client_checks(args.client, args.library)
    else:
        unittest.main(argv=[sys.argv[0], *tests])
