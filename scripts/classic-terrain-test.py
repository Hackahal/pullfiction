#!/usr/bin/env python3
import struct
import unittest
from classic_terrain import adapt_adt, chunk, chunks, liquid_blocks, rle_literal
from classic_compat import CompatError


class TerrainTest(unittest.TestCase):
    def test_authored_bgra_vertex_colors_survive_without_consuming_hole_metadata(self):
        colors = bytes([0, 127, 255, 91]) + bytes([127, 127, 127, 255]) * 144
        def inputs(payload):
            root, tex = bytearray(), bytearray()
            for index in range(256):
                header = bytearray(128)
                struct.pack_into('<I', header, 0, 0x10000)
                root.extend(chunk('MCNK', header + chunk('MCVT', bytes(145*4))
                                  + (chunk('MCCV', payload) if index == 0 else b'')))
                tex.extend(chunk('MCNK', b''))
            return root, tex
        root, tex = inputs(colors)
        converted = [body for tag, body in chunks(adapt_adt(root, tex, b'')) if tag == 'MCNK']
        for index, data in enumerate(converted):
            nested = dict(chunks(data[128:]))
            self.assertEqual(nested['PFH1'], bytes(8))
            offset = struct.unpack_from('<I', data, 0x74)[0]
            if index == 0:
                self.assertEqual(nested['MCCV'], colors)
                self.assertEqual(data[offset-8:offset-4], b'VCCM')
            else:
                self.assertEqual(offset, 0)
                self.assertNotIn('MCCV', nested)
        for malformed in (colors[:-1], colors + bytes(4), b''):
            with self.assertRaisesRegex(CompatError, '145 authored terrain vertex colors'):
                adapt_adt(*inputs(malformed), b'')

    def test_high_resolution_holes_retain_the_exact_cell_mask_in_private_cache_metadata(self):
        root, tex = bytearray(), bytearray()
        mask = (1 << 0) | (1 << 63)
        for index in range(256):
            header = bytearray(128)
            struct.pack_into('<I', header, 0, 0x10000)
            struct.pack_into('<Q', header, 0x14, mask if index == 0 else 0)
            root.extend(chunk('MCNK', header + chunk('MCVT', bytes(145*4))))
            tex.extend(chunk('MCNK', b''))
        converted = [body for tag, body in chunks(adapt_adt(root, tex, b'')) if tag == 'MCNK']
        self.assertEqual(dict(chunks(converted[0][128:]))['PFH1'], struct.pack('<Q', mask))
        self.assertEqual(dict(chunks(converted[1][128:]))['PFH1'], bytes(8))
        self.assertEqual(struct.unpack_from('<H', converted[0], 0x3c)[0], 1 | (1 << 15))
        self.assertFalse(struct.unpack_from('<I', converted[0])[0] & 0x10000)

    def test_split_files_keep_geometry_textures_and_file_id_placements(self):
        root, tex = bytearray(), bytearray(chunk('MDID', struct.pack('<I', 123)))
        for i in range(256):
            header = bytearray(128)
            struct.pack_into('<II', header, 4, i % 16, i // 16)
            struct.pack_into('<3f', header, 0x68, 100, 200, 30)
            root.extend(chunk('MCNK', header + chunk('MCVT', struct.pack('<145f', *([float(i)] * 145)))))
            tex.extend(chunk('MCNK', chunk('MCLY', struct.pack('<4I', 0, 0, 0, 0))))
        placement = bytearray(36)
        struct.pack_into('<I', placement, 0, 567)
        struct.pack_into('<H', placement, 34, 0x40)
        output = list(chunks(adapt_adt(root, tex, chunk('MDDF', placement))))
        self.assertIn(('MTEX', b'__classic/123.blp\0'), output)
        self.assertIn(('MMDX', b'__classic/567.m2\0'), output)
        geometry = [b for t, b in output if t == 'MCNK']
        self.assertEqual(len(geometry), 256)
        offset = struct.unpack_from('<I', geometry[31], 0x14)[0] - 8
        self.assertEqual(geometry[31][offset:offset+4], b'TVCM')
        self.assertEqual(struct.unpack_from('<f', geometry[31], offset+8)[0], 31)
        self.assertEqual(struct.unpack_from('<3f', geometry[31], 0x68), (100,200,30))

    def test_literal_alpha_preserves_all_8_bits(self):
        original = bytes(range(256)) * 16
        packed = rle_literal(original)
        result, at = bytearray(), 0
        while at < len(packed):
            n = packed[at]; at += 1
            result.extend(packed[at:at+n]); at += n
        self.assertEqual(result, original)

    def test_stacked_water_keeps_masks_and_heights(self):
        data = bytearray(3072 + 48 + 2)
        struct.pack_into('<III', data, 0, 3072, 2, 0)
        for i in range(2):
            struct.pack_into('<HHff4BII', data, 3072+i*24, 5, 0, 10+i*20, 10+i*20, i, 0, 1, 1, 3120+i, 0)
            data[3120+i] = 1
        blocks, flags = liquid_blocks(data, 0, {5:0})
        self.assertEqual(flags.bit_count(),2)
        self.assertEqual(struct.unpack_from('<f',blocks,12)[0],10)
        self.assertEqual(struct.unpack_from('<f',blocks,0x324+12)[0],30)
        self.assertEqual(blocks[656:658],bytes([0,15]))
        self.assertEqual(blocks[0x324+656:0x324+658],bytes([15,0]))

    def test_truncated_chunks_fail(self):
        with self.assertRaises(CompatError):
            list(chunks(b'KNCM'+struct.pack('<I',128)+b'bad'))


if __name__ == '__main__': unittest.main()
