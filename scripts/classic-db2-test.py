#!/usr/bin/env python3
"""WDC5 compression and record identity tests, using synthetic data only."""
import struct
import unittest
from classic_db2 import DB2Error, decode, f32


def table():
    fields = [(0, 32, 0, 0, 0, 0, 0), (32, 3, 0, 1, 0, 0, 0),
              (35, 0, 8, 2, 42, 0, 0), (35, 2, 16, 3, 0, 0, 0),
              (37, 1, 16, 4, 0, 0, 2), (38, 4, 0, 5, 0, 0, 0),
              (64, 64, 0, 0, 0, 0, 0)]
    start = 204 + 40 + len(fields) * 4 + len(fields) * 24 + 32 + 8
    data = bytearray(start)
    data[:4] = b'WDC5'
    struct.pack_into('<9I2H7I', data, 136, 2, 7, 16, 0, 0, 0x12345678, 7, 9, 0, 4, 0, 7, 0, 0, 168, 8, 32, 1)
    struct.pack_into('<Q8I', data, 204, 0, start, 2, 0, 0, 8, 0, 0, 1)
    pos = 244 + 7 * 4
    for field in fields:
        struct.pack_into('<HH5I', data, pos, *field)
        pos += 24
    struct.pack_into('<8I', data, pos, 10, 20, 30, 40, 100, 101, 200, 201)
    struct.pack_into('<II', data, pos + 32, 7, 99)
    for i in range(2):
        value = 0x3F800000 | (5 << 32) | (2 << 35) | (1 << 37) | ((13 if i == 0 else 3) << 38) | (1 << 64) | (2 << 96)
        data.extend(value.to_bytes(16, 'little'))
    data.extend(struct.pack('<4I', 7, 8, 9, 8))
    return data


class DB2Test(unittest.TestCase):
    def test_sectionless_empty_table_requires_its_exact_field_envelope(self):
        data=bytearray(212);data[:4]=b'WDC5'
        struct.pack_into('<9I2H7I',data,136,0,2,0,0,0,0x19a69a6c,0,0,0xffffffff,
                         4,0,2,0,0,0,0,0,0)
        struct.pack_into('<2I',data,204,32,32)
        self.assertEqual(decode(data),('19a69a6c',{}))
        for changed in (data[:-1],data+b'\0'):
            with self.assertRaisesRegex(DB2Error,'empty WDC5'):
                decode(changed)
        sparse=bytearray(data);struct.pack_into('<H',sparse,172,1)
        with self.assertRaisesRegex(DB2Error,'Sparse'):
            decode(sparse)

    def test_all_storage_kinds_and_copy_ids(self):
        layout, rows = decode(table())
        self.assertEqual(layout, '12345678')
        self.assertEqual(set(rows), {7, 8, 9})
        self.assertEqual(f32(rows[7][0]), 1.0)
        self.assertEqual(rows[7][1:], [5, 99, 30, [200, 201], -3, [1, 2]])
        self.assertEqual(rows[8][2], 42)
        self.assertEqual(rows[8][5], 3)
        self.assertEqual(rows[9], rows[8])

    def test_relationships_follow_section_ids_and_copy_records(self):
        data = table()
        struct.pack_into('<I', data, 232, 28)
        data.extend(struct.pack('<7I', 2, 101, 202, 101, 0, 202, 1))
        _, rows = decode(data, relationships=True)
        self.assertEqual(rows[7][-1], 101)
        self.assertEqual(rows[8][-1], 202)
        self.assertEqual(rows[9][-1], 202)
        struct.pack_into('<I', data, len(data)-4, 10)
        with self.assertRaisesRegex(DB2Error, 'relationship record index'):
            decode(data, relationships=True)

    def test_truncation_and_unsupported_sections_fail(self):
        for changed in [table()[:170], table()[:-1]]:
            with self.assertRaises(DB2Error):
                decode(changed)
        encrypted = table()
        struct.pack_into('<Q', encrypted, 204, 1)
        with self.assertRaisesRegex(DB2Error, 'Encrypted'):
            decode(encrypted)
        sparse = table()
        struct.pack_into('<H', sparse, 172, 1)
        with self.assertRaisesRegex(DB2Error, 'Sparse'):
            decode(sparse)

    def test_invalid_compression_and_copy_cycles_fail(self):
        changed = table()
        struct.pack_into('<I', changed, 244 + 7 * 4 + 8, 99)
        with self.assertRaisesRegex(DB2Error, 'Unknown WDC5 compression'):
            decode(changed)
        changed = table()
        struct.pack_into('<II', changed, len(changed) - 8, 9, 100)
        with self.assertRaisesRegex(DB2Error, 'Unresolved or cyclic'):
            decode(changed)


if __name__ == '__main__':
    unittest.main()
