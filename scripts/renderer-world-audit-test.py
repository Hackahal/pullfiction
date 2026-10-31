#!/usr/bin/env python3
"""Synthetic world audit checks. No client assets or renderer are required."""
import importlib.util
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
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
    def test_native_reader_uses_preserved_build_source_and_rejects_stale_artifacts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary, snapshot, live = root/'probe', root/'source-snapshot.rs', root/'renderer-world-audit-native.rs'
            binary.write_bytes(b'old native executable')
            snapshot.write_bytes(b'old source used to build that executable')
            live.write_bytes(b'new working tree source must not acquire credit')
            libraries = {}
            for name in ['benilla_formats', 'serde_json']:
                path = root/(name+'.rlib')
                path.write_bytes(('old linked '+name).encode())
                libraries[name] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            record = {'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                      'probeSourceSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(),
                      'probeSourceSnapshot': str(snapshot), 'sourcePaths': {'probe': str(live)}, 'rlibs': libraries}
            identity = root/'identity.json'
            identity.write_text(json.dumps(record))
            result = audit.native_reader_identity(binary, identity)
            self.assertEqual(result['sourceSha256'], record['probeSourceSha256'])
            self.assertNotEqual(result['sourceSha256'], hashlib.sha256(live.read_bytes()).hexdigest())
            self.assertEqual(result['manifest'], record)
            for artifact, message in [(binary, 'reader hash'), (snapshot, 'source snapshot'),
                                      (Path(libraries['benilla_formats']['path']), 'linked library')]:
                original = artifact.read_bytes()
                artifact.write_bytes(b'changed after compilation')
                with self.assertRaisesRegex(ValueError, message):
                    audit.native_reader_identity(binary, identity)
                artifact.write_bytes(original)
            for field, message in [('probeSourceSnapshot', 'preserved source'), ('rlibs', 'linked formats')]:
                bad = {key: value for key, value in record.items() if key != field}
                identity.write_text(json.dumps(bad))
                with self.assertRaisesRegex(ValueError, message):
                    audit.native_reader_identity(binary, identity)

    def test_native_reader_cli_requires_its_matching_identity_before_opening_source(self):
        for option in ['--native-reader', '--native-reader-identity']:
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('renderer-world-audit.py')),
                                     option, 'does-not-exist'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('must be supplied together', result.stderr)

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
        self.assertEqual(expired['wmoPlacements'][0]['status'], 'metadata-only')
        self.assertEqual(expired['coverage']['groupsExpectedFromReadableRoots'], 1)
        self.assertEqual(expired['coverage']['groupsEnumerated'], 1)
        self.assertEqual(expired['coverage']['groupsCompleted'], 0)
        self.assertEqual(expired['coverage']['groupsBudgetExhausted'], 1)
        self.assertEqual(expired['summary']['cameraSeeds'], 0)
        class FailingNative:
            def check(self, kind, data, root=None):
                self.last = (kind, root)
                return {'status': 'decode-error' if kind == 'group' else 'decoded'}
        native = FailingNative()
        native_audit = audit.Audit(FakeWorld(), time.monotonic() + 10, native_reader=native)
        checked = native_audit.map({'map': 1, 'name': 'Test', 'directory': 'test'})
        self.assertEqual(checked['groups'][0]['status'], 'structural-pass')
        self.assertEqual(checked['groups'][0]['nativeParser']['status'], 'decode-error')
        self.assertEqual(checked['wmoPlacements'][0]['nativeParser']['status'], 'decoded')
        self.assertEqual(native.last[0], 'group')
        self.assertIsNotNone(native.last[1], 'group decode must use its actual owning root')

    def test_root_modes_record_required_shader_and_portal_ranges_without_support_credit(self):
        material = bytearray(64)
        struct.pack_into('<4I', material, 0, 4, 23, 2, 123)
        struct.pack_into('<I', material, 24, 456)
        value = {'MOMT': material, 'MOPV': bytes(12), 'MOPT': struct.pack('<HH4f', 0, 2, 0, 0, 1, 0),
                 'MOPR': struct.pack('<HHhh', 3, 4, 1, 0)}
        result = audit.root_modes(value, 1)
        self.assertEqual(result['shaders'], {'23': 1})
        self.assertEqual(result['secondaryTextureMaterials'], 1)
        self.assertIn('portal-vertex-range-out-of-bounds', result['issues'])
        self.assertIn('portal-reference-out-of-bounds', result['issues'])
        self.assertNotIn('supported', result)

    def test_hash_ledger_keeps_unavailable_reads_separate_and_detects_source_changes(self):
        values = iter([b'first', b'first', b'changed'])
        ledger = audit.SourceLedger(lambda name: next(values))
        self.assertEqual(ledger('local'), b'first')
        self.assertEqual(ledger('local'), b'first')
        self.assertEqual(ledger.records['local']['reads'], 2)
        with self.assertRaisesRegex(audit.CompatError, 'Source changed'):
            ledger('local')
        self.assertEqual(ledger.records['local']['status'], 'unavailable')

    def test_nonvisual_group_checks_do_not_generate_camera_or_visual_credit(self):
        result = audit.analyze_group(group(), 1, camera_seeds=False)
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['cameraSeeds'], [])
        self.assertIsNone(result['walkableTriangles'])
        self.assertEqual(result['requiredModes']['chunks']['MOTV'], 2)

    def test_group_portal_reference_span_follows_bounds_without_reusing_bbox_bytes(self):
        data = bytearray(group())
        at = data.index(b'PGOM') + 8
        struct.pack_into('<HH', data, at + 0x24, 13, 7)
        result = audit.analyze_group(bytes(data), 1, camera_seeds=False)
        self.assertEqual(result['requiredModes']['portalReferences'], (13, 7))

    def test_triangle_list_partial_tail_is_not_an_invalid_range_or_a_missing_dependency(self):
        data = group(batch=True)
        pos = data.index(b'ABOM') + 8
        data = bytearray(data)
        struct.pack_into('<H', data, pos + 16, 2)
        result = audit.analyze_group(bytes(data), 1, camera_seeds=False)
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['partialPrimitives'], [{'batch': 0, 'trailingIndices': 2}])
        class FakeWorld:
            def raw(self, name): raise AssertionError('zero sentinel must not be read')
        instance = audit.Audit(FakeWorld(), time.monotonic() + 10, verify_dependencies=True)
        self.assertEqual(instance.dependency('__classic/0.blp')['status'], 'expected-none')
        self.assertEqual(instance.resources, {})


if __name__ == '__main__':
    unittest.main()
