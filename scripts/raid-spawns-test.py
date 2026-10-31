#!/usr/bin/env python3
"""Validate shipped reference coverage and SQL projection decisions."""
import importlib.util
import json
import gzip
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('raid_spawns', Path(__file__).with_name('raid-spawns.py'))
spawns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawns)
ROOT = Path(__file__).resolve().parent.parent


class RaidSpawnTests(unittest.TestCase):
    def test_shipped_reference_covers_all_vanilla_raids_with_valid_positions(self):
        data = json.loads((ROOT / 'third_party/raid-spawns/vanilla.json').read_text())
        raids = json.loads((ROOT / 'web/planner/raids.json').read_text())
        expected = {str(r['map']) for r in raids if not r.get('rulesets')}
        self.assertEqual(set(data['maps']), expected)
        self.assertEqual(data['ruleset'], 'vanilla')
        self.assertRegex(data['sourceURL'], r'/[0-9a-f]{40}/Full_DB/')
        self.assertRegex(data['sourceSHA256'], r'^[0-9a-f]{64}$')
        for map_id, rows in data['maps'].items():
            self.assertTrue(rows, map_id)
            self.assertEqual(len(rows), len({r['id'] for r in rows}))
            for row in rows:
                self.assertGreater(row['entry'], 0)
                self.assertGreater(row['displayID'], 0)
                self.assertTrue(all(abs(n) < 20000 for n in row['position']))

    def test_utf8_names_are_identical_in_plain_and_gzip_input_under_ascii_locale(self):
        sql = "CREATE TABLE `creature_template` (\n `Name` text\n);\nINSERT INTO `creature_template` VALUES ('Se\u00f1or');\n"
        with tempfile.TemporaryDirectory() as tmp:
            for suffix in ('.sql', '.sql.gz'):
                path = Path(tmp) / ('utf8' + suffix)
                encoded = sql.encode('utf-8')
                path.write_bytes(gzip.compress(encoded) if suffix.endswith('.gz') else encoded)
                code = (
                    "import importlib.util,sys;"
                    "spec=importlib.util.spec_from_file_location('spawns',sys.argv[1]);"
                    "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);"
                    "assert module.tables(sys.argv[2])['creature_template'][0]['name']=='Se\\u00f1or'"
                )
                result = subprocess.run([sys.executable, '-c', code,
                    str(ROOT / 'scripts/raid-spawns.py'), str(path)],
                    env={**os.environ, 'PYTHONUTF8': '0', 'PYTHONCOERCECLOCALE': '0', 'LC_ALL': 'C'},
                    capture_output=True, text=True, encoding='utf-8')
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_sql_projection_uses_declared_columns_and_one_random_variant(self):
        sql = '''CREATE TABLE `creature` (
 `map` int,
 `guid` int,
 `id` int,
 `position_x` float,
 `position_y` float,
 `position_z` float,
 `orientation` float
);
INSERT INTO `creature` VALUES (409,1,0,10,20,30,1.5),(1,2,100,1,2,3,0);
CREATE TABLE `creature_template` (
 `Entry` int,
 `Name` text,
 `CreatureType` int,
 `UnitFlags` int,
 `Faction` int,
 `Rank` int,
 `ModelId1` int
);
INSERT INTO `creature_template` VALUES (100,'Boss',3,0,35,3,123),(101,'Other',3,0,14,1,456);
CREATE TABLE `creature_spawn_entry` (
 `guid` int,
 `entry` int
);
INSERT INTO `creature_spawn_entry` VALUES (1,101),(1,100);
'''
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.sql'
            path.write_text(sql)
            result = spawns.project(spawns.tables(path))
        self.assertEqual(len(result['409']), 1)
        self.assertEqual(result['409'][0]['entry'], 100)
        self.assertEqual(result['409'][0]['position'], [10, 20, 30])
        self.assertTrue(result['409'][0]['boss'])


if __name__ == '__main__':
    unittest.main()
