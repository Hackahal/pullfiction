#!/usr/bin/env python3
"""Portable encoding and invisible-text publication regressions."""
import contextlib
import io
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

LIBRARY = Path(__file__).resolve().parent.parent / 'docs' / 'encounters'
validator = runpy.run_path(str(LIBRARY / 'validate.py'))


class EncounterLibraryQualityTest(unittest.TestCase):
    def test_all_library_reads_explicitly_use_utf8(self):
        original = Path.read_text
        encodings = []

        def read(path, *args, **kwargs):
            self.assertEqual(kwargs.get('encoding'), 'utf-8', str(path))
            encodings.append(kwargs['encoding'])
            return original(path, *args, **kwargs)

        with patch.object(Path, 'read_text', read), contextlib.redirect_stdout(io.StringIO()):
            validator['main']()
        self.assertGreater(len(encodings), 147)

    def test_zero_width_prose_is_rejected_without_changing_any_file(self):
        original = Path.read_text

        def read(path, *args, **kwargs):
            text = original(path, *args, **kwargs)
            return text + '\u200b' if path == LIBRARY / 'README.md' else text

        with patch.object(Path, 'read_text', read), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'invisible zero-width space'):
                validator['validate_library']('sod', 88, 89)


if __name__ == '__main__':
    unittest.main()
