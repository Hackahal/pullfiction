#!/usr/bin/env python3
"""Synthetic format/transaction tests; contains no client assets."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('classic_assets', Path(__file__).with_name('classic-assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def chunk(tag, data, reverse=False):
    return (tag[::-1] if reverse else tag).encode() + struct.pack('<I', len(data)) + data


def put(data, offset, *values):
    struct.pack_into('<' + 'I' * len(values), data, offset, *values)


def model():
    body = bytearray(312)
    body[:4] = b'MD20'
    put(body, 4, 274)
    put(body, 0x44, 1)
    return chunk('MD21', body) + chunk('SFID', struct.pack('<I', 42)) + chunk('TXID', struct.pack('<II', 0, 43))


class FakeStorage:
    def __init__(self, files):
        self.files = files
        self.reads = []

    def read(self, name):
        self.reads.append(name)
        if name not in self.files:
            raise assets.AssetError('Unavailable locally')
        return self.files[name]


class ClassicAssetsTest(unittest.TestCase):
    def test_build_selects_active_era_among_other_products(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            header = 'Product!STRING:0|Active!DEC:1|Version!STRING:0|Build Key!HEX:16\n'
            (root / '.build.info').write_text(header + 'wow|1|12.0.0.1|' + 'b' * 32 + '\nwow_classic_era|1|1.15.9.70003|' + 'a' * 32)
            self.assertEqual(assets.client_build(root)['version'], '1.15.9.70003')
            (root / '.build.info').write_text(header + 'wow_classic_era|1|1.15.8.1|' + 'a' * 32)
            with self.assertRaisesRegex(assets.AssetError, 'Unsupported installed build'):
                assets.client_build(root)

    def test_archive_names_and_ids_are_normalized_and_bounded(self):
        self.assertEqual(assets.resource('Creature\\Ragnaros/Ragnaros.m2'), 'creature/ragnaros/ragnaros.m2')
        self.assertEqual(assets.resource(42), 'id:42')
        for bad in ['../WoW', '/abs', 'a//b', 'C:/wow', 'id:0', 'id:4294967295', 'id:no', 'a\0b', 'a*b']:
            with self.subTest(bad=bad), self.assertRaises(assets.AssetError):
                assets.resource(bad)

    def test_model_follows_external_skins_and_textures_without_zero_ids(self):
        info, deps = assets.inspect_asset(model())
        self.assertEqual(info['version'], 274)
        self.assertEqual(deps, ['id:42', 'id:43'])
        with self.assertRaisesRegex(assets.AssetError, 'external skin'):
            assets.inspect_asset(model().split(b'SFID')[0])

    def test_rejects_truncated_and_duplicate_chunks(self):
        for data in [b'MD21', b'MD21\xff\xff\xff\xff', chunk('MD21', b'MD20')]:
            with self.assertRaises(assets.AssetError):
                assets.inspect_asset(data)
        with self.assertRaisesRegex(assets.AssetError, 'Duplicate'):
            assets.chunks(chunk('TEST', b'') * 2)

    def test_global_wmo_and_world_material_dependencies(self):
        flags = struct.pack('<I', 0x201)
        placement = bytearray(64)
        put(placement, 0, 100)
        wdt = b''.join(chunk(t, d, True) for t, d in [('MVER', struct.pack('<I', 18)), ('MPHD', flags), ('MAIN', bytes(32768)), ('MODF', placement)])
        self.assertEqual(assets.inspect_asset(wdt)[1], ['id:100'])
        mat = bytearray(64)
        put(mat, 12, 200)
        put(mat, 24, 201)
        root = b''.join(chunk(t, d, True) for t, d in [('MVER', struct.pack('<I', 17)), ('MOHD', bytes(64)), ('MOMT', mat), ('GFID', struct.pack('<I', 101)), ('MODI', struct.pack('<I', 102))])
        self.assertEqual(assets.inspect_asset(root)[1], ['id:101', 'id:102', 'id:200', 'id:201'])

    def test_transaction_deduplicates_dependencies_and_verifies_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store = FakeStorage({'root.m2': model(), 'id:42': b'raw skin', 'id:43': b'raw texture'})
            result = assets.prepare(store, {'version': 'test'}, ['root.m2', 'id:42'], root)
            self.assertEqual(store.reads, ['root.m2', 'id:42', 'id:43'])
            self.assertFalse(result['rendererReady'])
            self.assertEqual(assets.verify_cache(root), result)
            blob = root / result['files']['id:42']['object']
            blob.write_bytes(b'corrupt')
            with self.assertRaisesRegex(assets.AssetError, 'Corrupt cached'):
                assets.verify_cache(root)

    def test_failed_preparation_preserves_previous_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            assets.prepare(FakeStorage({'old': b'old'}), {}, ['old'], root)
            previous = (root / 'manifest.json').read_bytes()
            with self.assertRaises(assets.AssetError):
                assets.prepare(FakeStorage({'root': model()}), {}, ['root'], root)
            self.assertEqual((root / 'manifest.json').read_bytes(), previous)
            for limits in [{'max_files': 0}, {'max_bytes': 1}]:
                with self.assertRaises(assets.AssetError):
                    assets.prepare(FakeStorage({'root': b'xx'}), {}, ['root'], root, **limits)
            self.assertEqual((root / 'manifest.json').read_bytes(), previous)

    def test_cache_manifest_cannot_reference_paths_outside_object_store(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            result = assets.prepare(FakeStorage({'root': b'xx'}), {}, ['root'], root)
            result['files']['root']['object'] = '../secret'
            (root / 'manifest.json').write_text(json.dumps(result))
            with self.assertRaisesRegex(assets.AssetError, 'Invalid object path'):
                assets.verify_cache(root)


if __name__ == '__main__':
    unittest.main()
