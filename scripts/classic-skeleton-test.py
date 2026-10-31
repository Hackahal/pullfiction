#!/usr/bin/env python3
"""Self-contained SKL1 relocation checks; no game assets or archive library."""
import importlib.util
from pathlib import Path
import struct
import unittest
from classic_compat import adapt_model, inline_skeleton, read, CompatError, UnsupportedFeatureError

spec = importlib.util.spec_from_file_location('fixtures', Path(__file__).with_name('classic-compat-test.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


def chunk(tag, value):
    return tag + struct.pack('<I', len(value)) + value


def fixture():
    original, skin = f.fixture()
    source = bytearray(original[8:])
    sks, skb, ska = bytearray(source), bytearray(source), bytearray(source)
    for payload, mappings in [(sks, [(0,0x14),(8,0x1c),(16,0x24)]),
                               (skb, [(0,0x2c),(8,0x34)]), (ska, [(0,0xf0),(8,0xf8)])]:
        for field, old in mappings:
            payload[field:field+8] = source[old:old+8]
    for field in [0x14,0x1c,0x24,0x2c,0x34,0xf0,0xf8]:
        struct.pack_into('<II', source, field, 0, 0)
    raw = chunk(b'MD21', source) + chunk(b'SKID', struct.pack('<I', 777))
    parts = {b'SKL1': struct.pack('<I',0x100)+bytes(28), b'SKS1':sks, b'SKB1':skb, b'SKA1':ska}
    return original, raw, skin, parts


class SkeletonTests(unittest.TestCase):
    def test_chunk_relative_nested_tracks_preserve_identical_adapted_output(self):
        original, raw, skin, parts = fixture()
        reads = []
        def read_file(name):
            reads.append(name)
            return b''.join(chunk(k,v) for k,v in parts.items())
        actual = adapt_model(raw, [skin], read_file)
        self.assertEqual(actual, adapt_model(original, [skin]))
        self.assertEqual(reads, ['id:777'])
        with self.assertRaisesRegex(UnsupportedFeatureError, 'External modern'):
            adapt_model(raw, [skin])

    def test_parent_external_or_conflicting_tables_remain_explicit(self):
        original, raw, skin, parts = fixture()
        for tag in [b'SKPD', b'AFID', b'BFID']:
            with self.subTest(tag=tag), self.assertRaises(UnsupportedFeatureError):
                adapt_model(raw, [skin], lambda _: b''.join(chunk(k,v) for k,v in parts.items())+chunk(tag,b'\1'*16))
        conflicting = original + chunk(b'SKID', struct.pack('<I',777))
        with self.assertRaisesRegex(UnsupportedFeatureError, 'conflicts'):
            adapt_model(conflicting,[skin],lambda _:b''.join(chunk(k,v) for k,v in parts.items()))

    def test_invalid_nested_animation_array_fails_before_conversion(self):
        _, raw, skin, parts = fixture()
        bone_at = read(parts[b'SKB1'],'<I',4)[0]
        struct.pack_into('<II',parts[b'SKB1'],bone_at+16+4,1,len(parts[b'SKB1'])+20)
        with self.assertRaises(CompatError):
            adapt_model(raw,[skin],lambda _:b''.join(chunk(k,v) for k,v in parts.items()))


if __name__ == '__main__':
    unittest.main()
