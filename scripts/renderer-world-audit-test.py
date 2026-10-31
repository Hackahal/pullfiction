#!/usr/bin/env python3
"""Synthetic world audit checks. No client assets or renderer are required."""
import importlib.util
from pathlib import Path
import struct
import time
import unittest

from classic_terrain import chunk

SPEC = importlib.util.spec_from_file_location('renderer_world_audit', Path(__file__).with_name('renderer-world-audit.py'))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def group(material=0, batch=False):
    header = bytearray(68)
    struct.pack_into('<I6f', header, 8, 0x2000, 0, 0, 0, 1, 1, 0)
    nested = chunk('MOVT', struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0))
    nested += chunk('MOVI', struct.pack('<3H', 0, 1, 2))
    nested += chunk('MOPY', bytes([0, material]))
    nested += chunk('MOTV', bytes(24)) + chunk('MOTV', bytes(24))
    if batch:
        record = bytearray(24)
        struct.pack_into('<IH', record, 12, 0, 6)
        record[23] = material
        nested += chunk('MOBA', record)
    return chunk('MVER', struct.pack('<I', 17)) + chunk('MOGP', bytes(header) + nested)


def terrain(texture=0):
    body = bytearray(128)
    struct.pack_into('<3f', body, 0x68, 1, 1, 0)
    nested = chunk('MCVT', bytes(145*4)) + chunk('MCLY', struct.pack('<4I', texture, 0, 0, 0))
    return chunk('MTEX', b'local.blp\0') + b''.join(chunk('MCNK', body + nested) for _ in range(256))


class AuditTest(unittest.TestCase):
    def test_authored_walkable_triangle_produces_unverified_camera_seed(self):
        result = audit.analyze_group(group(), 1, (10, 20, 30))
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['uvLayers'], 2)
        self.assertEqual(result['walkableTriangles'], 1)
        self.assertTrue(result['interior'])
        target = result['cameraSeeds'][0]['camera']['target']
        self.assertAlmostEqual(target[0], 10 - 1/3)
        self.assertAlmostEqual(target[2], 31.5)
        self.assertEqual(result['cameraSeeds'][0]['status'], 'unverified')

    def test_invalid_material_and_batch_ranges_are_reported(self):
        result = audit.analyze_group(group(material=7, batch=True), 1)
        self.assertIn('material-slot-out-of-range:7', result['issues'])
        self.assertIn('batch-triangle-range-out-of-bounds', result['issues'])

    def test_nonfinite_geometry_cannot_earn_bounds_or_camera_coverage(self):
        result = audit.geometry_summary([[float('nan'), 0, 0]], [])
        self.assertIsNone(result['bounds'])
        self.assertEqual(result['cameraSeeds'], [])
        self.assertIn('nonfinite-or-out-of-range-coordinate', result['issues'])

    def test_terrain_checks_all_cells_heights_and_texture_slots(self):
        result = audit.analyze_terrain(terrain())
        self.assertEqual(result['cells'], 256)
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['dependencies'], ['local.blp'])
        self.assertIn('terrain-material-slot-out-of-range', audit.analyze_terrain(terrain(2))['issues'])

    def test_out_of_range_triangle_indices_are_explicit(self):
        result = audit.geometry_summary([[0, 0, 0]], [0, 1, 2])
        self.assertIn('triangle-index-out-of-range', result['issues'])
        self.assertEqual(result['cameraSeeds'], [])

    def test_modern_texture_and_doodad_refs_are_deduplicated(self):
        material = bytearray(64)
        struct.pack_into('<I', material, 12, 123)
        refs = audit.root_dependencies({'MOMT': material, 'GFID': struct.pack('<2I', 55, 55),
                                        'MODI': struct.pack('<I', 123)})
        self.assertEqual(refs, ['id:123', 'id:55'])

    def test_terrain_model_references_are_tracked_without_copying_assets(self):
        record = bytearray(36)
        struct.pack_into('<I', record, 0, 777)
        struct.pack_into('<H', record, 34, 0x40)
        self.assertEqual(audit.object_dependencies({'MDDF': bytes(record)}), ['id:777'])

    def test_timed_out_audit_tracks_group_without_claiming_a_pass(self):
        root = bytearray(64)
        struct.pack_into('<II', root, 0, 1, 1)
        metadata = bytearray(32)
        struct.pack_into('<i', metadata, 28, -1)
        placement = bytearray(64)
        struct.pack_into('<II', placement, 0, 0, 9)
        wdt = {'MAIN': bytes(64*64*8), 'MPHD': struct.pack('<I', 1), 'MWMO': b'world/wmo/local.wmo\0',
               'MODF': bytes(placement)}
        class FakeWorld:
            def wdt(self, directory): return wdt
            def source(self, name): return name
            def raw(self, name): return self.resource(name)
            def resource(self, name):
                if name.endswith('.wdt'): return audit.pack(wdt)
                if name.endswith('_000.wmo'): return group()
                return audit.pack({'MOHD': bytes(root), 'MOGI': bytes(metadata), 'MOMT': bytes(64)})
        fresh = audit.Audit(FakeWorld(), time.monotonic() + 10).map({'map': 1, 'name': 'Test', 'directory': 'test'})
        self.assertEqual(fresh['groups'][0]['status'], 'structural-pass')
        self.assertEqual(fresh['summary']['cameraSeeds'], 1)
        cases = audit.camera_cases([fresh])
        self.assertEqual(cases[0]['mapId'], 1)
        self.assertEqual(cases[0]['readiness']['status'], 'unverified')
        self.assertEqual(cases[0]['actors'], [])
        expired = audit.Audit(FakeWorld(), 0).map({'map': 1, 'name': 'Test', 'directory': 'test'})
        self.assertEqual(expired['wmoPlacements'][0]['status'], 'unverified')
        self.assertEqual(expired['summary']['cameraSeeds'], 0)


if __name__ == '__main__':
    unittest.main()
