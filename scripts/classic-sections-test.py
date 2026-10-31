"""Synthetic multi-section fixtures, never requires game data or keys."""
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import classic_sections as sections
import classic_table_strings as strings
from classic_db2 import DB2Error


def fixture():
    # Three records, one per section. First and last remain usable around a
    # protected middle section. Physical trailers are absent from logical offsets.
    data = bytearray(204 + 3 * 40 + 4 + 24)
    data[:4] = b'WDC5'
    texts = [b'Alpha\0', b'Hidden\0', b'Omega\0']
    struct.pack_into('<9I2H7I', data, 136, 3, 1, 4, sum(map(len, texts)), 0,
                     0x12345678, 1, 4, 0, 4, 0, 1, 0, 0, 24, 0, 0, 3)
    struct.pack_into('<HH5I', data, 328, 0, 32, 0, 0, 0, 0, 0)
    start, prior = len(data), 0
    ranges = []
    for i, text in enumerate(texts):
        copies = 1 if i == 2 else 0
        struct.pack_into('<Q8I', data, 204 + i * 40, 123 if i == 1 else 0,
                         start, 1, len(text), 0, 4, 0, 0, copies)
        payload = struct.pack('<i', 12 + prior - i * 4) + text + struct.pack('<I', i + 1)
        if copies:
            payload += struct.pack('<II', 4, 3)
        data.extend(payload)
        ranges.append((start, start + len(payload)))
        start += len(payload)
        prior += len(text)
    return data, ranges


class SectionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name)
        (directory / 'Fixture.dbd').write_text('COLUMNS\nstring Text\n')
        for module in [sections, strings]:
            for name, value in [('DEFINITIONS', directory), ('schema', lambda *_: (['Text'], None, {}))]:
                patcher = patch.object(module, name, value)
                patcher.start()
                self.addCleanup(patcher.stop)

    def load(self, locked=False, error=None, source=None):
        data, ranges = fixture()
        if source is not None:
            data = source
        def read(offset, size):
            if locked and ranges[1][0] <= offset < ranges[1][1]:
                raise error or sections.EncryptedSectionError('Missing key')
            return data[offset:offset + size]
        return sections.readable_table(read, 'Fixture')

    def test_full_multi_section_logical_strings_and_copy_ids(self):
        data, _ = fixture()
        struct.pack_into('<Q', data, 244, 0)
        rows, _ = strings.named_table(data, 'Fixture')
        self.assertEqual([r['Text'] for r in rows.values()], ['Alpha', 'Hidden', 'Omega', 'Omega'])
        normalized, coverage = self.load()
        self.assertEqual(strings.named_table(normalized, 'Fixture')[0], rows)
        self.assertTrue(coverage['complete'])
        self.assertEqual(coverage['includedRecords'], 3)

    def test_locked_middle_section_rebases_later_strings_and_preserves_copies(self):
        normalized, coverage = self.load(locked=True)
        rows, _ = strings.named_table(normalized, 'Fixture')
        self.assertEqual(set(rows), {1, 3, 4})
        self.assertEqual(rows[3]['Text'], 'Omega')
        self.assertEqual(rows[4]['Text'], 'Omega')
        self.assertFalse(coverage['complete'])
        self.assertEqual(coverage['omittedSections'][0]['records'], 1)
        self.assertEqual(coverage['zeroFilledBytes'], 0)
        # Reopening after data becomes readable automatically includes that row.
        full, coverage = self.load()
        self.assertIn(2, strings.named_table(full, 'Fixture')[0])
        self.assertTrue(coverage['complete'])

    def test_corrupt_or_missing_ranges_are_not_treated_as_locked(self):
        with self.assertRaisesRegex(OSError, 'Corrupt archive'):
            self.load(locked=True, error=OSError('Corrupt archive'))
        with self.assertRaisesRegex(FileNotFoundError, 'Not local'):
            self.load(locked=True, error=FileNotFoundError('Not local'))
        data, _ = fixture()
        with self.assertRaisesRegex(DB2Error, 'Truncated'):
            self.load(source=data[:-1])

    def test_invalid_counts_offsets_and_strings_fail(self):
        for offset, value, expected in [(136, 4, 'totals'), (212, 100, 'overlapping'),
                                         (352, 99999, 'outside its section')]:
            with self.subTest(offset=offset):
                data, _ = fixture()
                struct.pack_into('<I', data, offset, value)
                with self.assertRaisesRegex(DB2Error, expected):
                    self.load(source=data)


if __name__ == '__main__':
    unittest.main()
