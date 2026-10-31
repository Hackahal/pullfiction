#!/usr/bin/env python3
import struct
import unittest
from classic_terrain import adapt_adt, chunk, chunks, liquid_blocks, rle_literal
from classic_compat import CompatError


class TerrainTest(unittest.TestCase):
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
