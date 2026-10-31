#!/usr/bin/env python3
"""Behavioral checks for approximate, separately sourced BFD SoD guide references."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sod_guide_spawns', Path(__file__).with_name('sod-guide-spawns.py'))
guide_spawns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guide_spawns)
ROOT = Path(__file__).resolve().parent.parent
PINS = [('Entrance', [36.5, 15.5]), ('Baron Aquanis', [40.5, 30.5]),
        ('Ghamoo-ra', [29.5, 42.5]), ('Lady Sarevess', [20.5, 32.0]),
        ('Gelihast', [40.5, 40.5]), ('Lorgus Jett', [45.5, 54.5]),
        ('Twilight Lord Kelris', [51.5, 77.0]), ("Aku'mai", [70.5, 80.0])]
# Each display is from that exact SoD NPC's numeric metadata projection.
OWN_DISPLAYS = {202699: 110, 201722: 111481, 204068: 112103, 204921: 5243,
                207356: 12822, 209678: 4939, 213334: 116784}


class SodGuideTests(unittest.TestCase):
    def setUp(self):
        self.shipped = json.loads((ROOT / 'third_party/raid-spawns/sod-guides.json').read_text(encoding='utf-8'))
        self.baseline = json.loads((ROOT / 'third_party/raid-spawns/classic-dungeons.json').read_text(encoding='utf-8'))
        self.guide = {'sourceURL': guide_spawns.GUIDE_URL,
                      'sourceSHA256': self.shipped['sourceSHA256'], 'ruleset': 'sod',
                      'nativeMap': 48, 'mapperZone': 719, 'mapperFloor': 0, 'mapperPhase': 0,
                      'pins': [{'label': name, 'percent': point, 'type': 0 if name == 'Entrance' else 4}
                               for name, point in PINS]}
        self.models = {'schema': 1, 'provider': 'Wowhead', 'versions': {'sod': {'creatures': {}}}}
        for row in self.shipped['maps']['48']:
            self.models['versions']['sod']['creatures'][str(row['entry'])] = {
                'name': row['name'], 'displayID': row['displayID'], 'displayIDs': row['displayIDs'],
                'sourceURL': row['displaySourceURL'], 'sourceSHA256': row['displaySourceSHA256']}

    def project(self):
        return guide_spawns.project(self.guide, self.models, self.baseline)

    def test_affine_registration_recovers_an_independent_known_transform(self):
        anchors = [{'percent': [x, y], 'nativeXY': [100 + 2*x - 3*y, -50 + 4*x + 0.5*y]}
                   for x, y in [(0, 0), (100, 0), (0, 100), (33, 60), (80, 80)]]
        fitted = guide_spawns.affine(anchors)
        for actual, expected in zip(fitted['nativeX'], [100, 2, -3]):
            self.assertAlmostEqual(actual, expected, places=9)
        for actual, expected in zip(fitted['nativeY'], [-50, 4, 0.5]):
            self.assertAlmostEqual(actual, expected, places=9)
        self.assertEqual(len(fitted['nativeX']), 3)

    def test_real_anchors_have_independently_recomputed_residuals_and_distinct_identities(self):
        result = self.project()
        registration = result['registration']
        anchors = registration['anchors']
        self.assertEqual(len(anchors), 5)
        self.assertEqual(len({a['referenceEntry'] for a in anchors}), 5)
        self.assertEqual(len({a['referenceSpawnID'] for a in anchors}), 5)
        errors = []
        for anchor in anchors:
            x, y = anchor['percent']
            cx, cy = registration['coefficients']['nativeX'], registration['coefficients']['nativeY']
            predicted = [cx[0] + cx[1]*x + cx[2]*y, cy[0] + cy[1]*x + cy[2]*y]
            error = math.hypot(predicted[0] - anchor['nativeXY'][0], predicted[1] - anchor['nativeXY'][1])
            self.assertAlmostEqual(anchor['residualYards'], error, places=5)
            errors.append(error)
        self.assertAlmostEqual(max(errors), 29.038420, places=5)
        self.assertAlmostEqual(sorted(errors)[2], 12.529246, places=5)
        self.assertAlmostEqual(registration['maxResidualYards'], max(errors), places=5)
        self.assertIn('not a bound', registration['residualSemantics'])

    def test_seven_bosses_use_their_own_sod_models_and_keep_unknown_z_and_facing(self):
        result = self.project()
        rows = result['maps']['48']
        self.assertEqual(len(rows), 7)
        self.assertEqual({r['entry'] for r in rows}, set(OWN_DISPLAYS))
        self.assertEqual(result['ruleset'], 'sod')
        self.assertEqual(set(result['maps']), {'48'})
        self.assertNotIn('imageProjection', result)
        self.assertIn('not server spawn', result['coordinateSemantics'])
        self.assertEqual(result['sourceEntrancePercent'], [36.5, 15.5])
        for row in rows:
            self.assertEqual(row['displayID'], OWN_DISPLAYS[row['entry']])
            self.assertEqual(row['sourcePercent'], dict(PINS)[row['name']])
            self.assertEqual(row['kind'], 'guide-reference')
            self.assertEqual(row['positionPrecision'], 'guide-icon-approximate')
            self.assertIsNone(row['position'][2])
            self.assertIsNone(row['facing'])
            self.assertEqual(row['heightSource'], 'unknown')
            self.assertEqual(row['facingSource'], 'unknown')
            self.assertTrue(all(math.isfinite(value) for value in row['position'][:2]))
            self.assertEqual(row['displaySourceURL'], f"https://www.wowhead.com/classic/npc={row['entry']}?env=4")
            self.assertRegex(row['sourceSHA256'], r'^[a-f0-9]{64}$')
            self.assertRegex(row['displaySourceSHA256'], r'^[a-f0-9]{64}$')

    def test_wrong_ruleset_map_zone_or_floor_and_unrelated_icons_are_rejected(self):
        for key, value in [('nativeMap', 533), ('mapperZone', 16236), ('mapperFloor', 1),
                           ('mapperPhase', 1), ('ruleset', 'vanilla'), ('sourceURL', 'https://example.com/')]:
            with self.subTest(key=key):
                original = self.guide[key]
                self.guide[key] = value
                with self.assertRaises(guide_spawns.GuideError):
                    self.project()
                self.guide[key] = original
        self.guide['pins'][1]['label'] = 'Not a BFD boss'
        with self.assertRaises(guide_spawns.GuideError):
            self.project()

    def test_own_model_identity_is_required_and_classic_or_other_npc_models_are_rejected(self):
        model = self.models['versions']['sod']['creatures']['202699']
        model['sourceURL'] = 'https://www.wowhead.com/classic/npc=12876'
        with self.assertRaises(guide_spawns.GuideError):
            self.project()
        model['sourceURL'] = 'https://www.wowhead.com/classic/npc=202699?env=4'
        model['displayID'] = 123456
        with self.assertRaises(guide_spawns.GuideError):
            self.project()

    def test_registration_requires_the_correct_raid_unique_anchors_and_bounded_residuals(self):
        baseline = copy.deepcopy(self.baseline)
        self.baseline['maps'] = {'533': baseline['maps']['48']}
        with self.assertRaises(guide_spawns.GuideError):
            self.project()
        self.baseline = copy.deepcopy(baseline)
        anchor = next(row for row in self.baseline['maps']['48'] if row['entry'] == 4887)
        self.baseline['maps']['48'].append(copy.deepcopy(anchor))
        with self.assertRaises(guide_spawns.GuideError):
            self.project()
        self.baseline = copy.deepcopy(baseline)
        anchor = next(row for row in self.baseline['maps']['48'] if row['entry'] == 4887)
        anchor['position'][0] += 1000
        with self.assertRaises(guide_spawns.GuideError):
            self.project()
        self.baseline = baseline
        for pin in self.guide['pins']:
            pin['percent'] = [50, 50]
        with self.assertRaises(guide_spawns.GuideError):
            self.project()

    def test_cli_reproduces_the_shipped_projection_from_numeric_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bfd-guide-pins.json').write_text(json.dumps(self.guide), encoding='utf-8')
            (root / 'bfd-npc-models.json').write_text(json.dumps(self.models), encoding='utf-8')
            output = root / 'sod-guides.json'
            run = subprocess.run([sys.executable, str(ROOT / 'scripts/sod-guide-spawns.py'),
                                  '--source-dir', str(root), '--baseline', str(ROOT / 'third_party/raid-spawns/classic-dungeons.json'),
                                  '--output', str(output)], capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(output.read_bytes(), (ROOT / 'third_party/raid-spawns/sod-guides.json').read_bytes())

    def test_fresh_checkout_catalog_route_reproduces_bytes_without_cached_source_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'regenerated.json'
            run = subprocess.run([sys.executable, str(ROOT / 'scripts/sod-guide-spawns.py'),
                                  '--source-catalog', str(ROOT / 'third_party/raid-spawns/sod-guides.json'),
                                  '--baseline', str(ROOT / 'third_party/raid-spawns/classic-dungeons.json'),
                                  '--output', str(output)], cwd=root,
                                 capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(output.read_bytes(), (ROOT / 'third_party/raid-spawns/sod-guides.json').read_bytes())

    def test_catalog_route_refits_original_percent_facts_instead_of_reusing_derived_positions(self):
        catalog = copy.deepcopy(self.shipped)
        for row in catalog['maps']['48']:
            row['position'] = [9000, 9000, None]
        catalog['registration']['coefficients'] = {'nativeX': [0, 0, 0], 'nativeY': [0, 0, 0]}
        guide, models = guide_spawns.catalog_inputs(catalog)
        regenerated = guide_spawns.project(guide, models, self.baseline)
        self.assertEqual(regenerated, self.shipped)

    def test_catalog_route_rejects_incompatible_or_incomplete_source_facts(self):
        for mutation in (
                lambda c: c.update(schema=2),
                lambda c: c.update(ruleset='vanilla'),
                lambda c: c['registration'].update(nativeMap=533),
                lambda c: c['registration'].update(mapperZone=16236),
                lambda c: c['registration'].update(mapperFloor=1),
                lambda c: c['maps']['48'][0].update(sourcePercent=None),
                lambda c: c['maps']['48'][0].update(displaySourceURL='https://www.wowhead.com/classic/npc=12876'),
                lambda c: c['maps']['48'][0].update(displaySourceSHA256='unknown'),
                lambda c: c['maps']['48'][0].update(sourceSHA256='0' * 64),
                lambda c: c['maps']['48'].__setitem__(1, c['maps']['48'][0])):
            catalog = copy.deepcopy(self.shipped)
            mutation(catalog)
            with self.assertRaises(guide_spawns.GuideError):
                guide, models = guide_spawns.catalog_inputs(catalog)
                guide_spawns.project(guide, models, self.baseline)

    def test_cli_source_routes_are_mutually_exclusive(self):
        run = subprocess.run([sys.executable, str(ROOT / 'scripts/sod-guide-spawns.py'),
                              '--source-catalog', 'catalog.json', '--source-dir', 'sources',
                              '--baseline', 'baseline.json', '--output', 'output.json'],
                             capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(run.returncode, 2)
        self.assertIn('not allowed with argument', run.stderr)


if __name__ == '__main__':
    unittest.main()
