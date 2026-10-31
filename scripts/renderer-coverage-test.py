#!/usr/bin/env python3
"""Synthetic catalog tests; no installed client or game imagery required."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('renderer_coverage', Path(__file__).with_name('renderer-coverage.py'))
coverage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coverage)
SOURCE = {'product': 'fixture', 'version': '1', 'buildKey': 'local'}


def catalogs():
    return {'spells': {'source': SOURCE, 'spells': {'1': {'visuals': [{'id': 4, 'conditions': [7]}]}, '2': {'visuals': []}},
                      'visuals': {'4': {'events': [{'start': 'Cast', 'target': 'Caster', 'kit': 8},
                                                 {'start': 'Cast', 'target': 'Caster', 'kit': 8}],
                                       'missiles': [{'effect': 9}]}},
                      'kits': {'8': {'effects': [{'effect': 9}]}},
                      'effects': {'9': {'fileDataID': 123, 'scale': 1}}},
            'creatures': {'source': SOURCE, 'models': {'10': {'fileDataID': 123}},
                          'displays': {'11': {'modelID': 10, 'scale': 1, 'textures': [123]}}}}


class CoverageTest(unittest.TestCase):
    def test_shared_assets_and_kits_deduplicate_without_crediting_spell_routing(self):
        result = coverage.build_manifest(catalogs(), batch_size=2)
        rows = {r['id']: r for r in result['entries']}
        self.assertEqual([k for k in rows if k.startswith('asset:')], ['asset:123'])
        self.assertEqual(len([c for c in result['cases'] if c['id'].startswith('kit:')]), 1)
        self.assertEqual(rows['spell:1']['status']['render'], 'unverified')
        self.assertEqual(rows['spell:2']['status']['render'], 'expected-none')
        self.assertTrue(all(r['status']['decode'] == 'unverified' for r in rows.values()))
        ids = [c['id'] for c in result['cases']]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual([i for b in result['batches'] for i in b['caseIds']], ids)

    def test_resume_preserves_only_unchanged_transitive_dependencies_and_profile(self):
        initial = coverage.build_manifest(catalogs(), verification_id='test-build')
        for row in initial['entries']:
            row['status']['render'] = 'pass'
            row['evidence'] = [{'path': 'local-evidence.png', 'rendererHash': 'test'}]
        resumed = coverage.build_manifest(catalogs(), resume=initial, verification_id='test-build')
        self.assertTrue(all(r['status']['render'] == 'pass' for r in resumed['entries']))
        changed = catalogs()
        changed['spells']['effects']['9']['scale'] = 2
        rerun = coverage.build_manifest(changed, resume=initial, verification_id='test-build')
        rows = {r['id']: r for r in rerun['entries']}
        self.assertEqual(rows['spell:1']['status']['render'], 'unverified')
        self.assertEqual(rows['kit:8']['status']['render'], 'unverified')
        self.assertEqual(rows['asset:123']['status']['render'], 'pass')
        self.assertEqual(rows['spell:1']['evidence'], [])
        no_identity = coverage.build_manifest(catalogs(), resume=initial)
        self.assertFalse(any(r['status']['render'] == 'pass' for r in no_identity['entries']))
        era = coverage.build_manifest(catalogs(), content='era', resume=initial, verification_id='test-build')
        self.assertFalse(any(r['status']['render'] == 'pass' for r in era['entries']))

    def test_client_mismatch_and_layout_conflict_are_rejected(self):
        mixed = catalogs()
        mixed['creatures']['source'] = dict(SOURCE, version='2')
        with self.assertRaisesRegex(ValueError, 'source mismatch'):
            coverage.build_manifest(mixed)
        mixed = catalogs()
        mixed['creatures']['layouts'] = {'Table': 'a'}
        mixed['spells']['layouts'] = {'Table': 'b'}
        with self.assertRaisesRegex(ValueError, 'Conflicting layout'):
            coverage.build_manifest(mixed)

    def test_missing_references_and_unknown_events_stay_explicit(self):
        data = catalogs()
        data['spells']['visuals']['4']['events'].append({'start': 'UnknownEvent', 'kit': 404})
        result = coverage.build_manifest(data)
        row = next(r for r in result['entries'] if r['id'] == 'visual:4')
        self.assertIn('missing-reference:kit:404', row['issues'])
        self.assertIn('unmapped-event:UnknownEvent', row['issues'])
        self.assertEqual(row['status']['render'], 'unverified')

    def test_boss_variants_and_unavailable_bosses_are_tracked(self):
        npcs = {'versions': {'sod': {'creatures': {'42': {'name': 'Boss', 'displayIDs': [11, 12]}}}}}
        result = coverage.build_manifest(catalogs(), npcs=npcs, bosses=[{'npcId': 42}, {'npcId': 43}])
        cases = [c for c in result['cases'] if c['category'] == 'boss']
        self.assertEqual(len(cases), 3)
        self.assertEqual(cases[-1]['readiness']['status'], 'unavailable')

    def test_world_origin_does_not_earn_visible_room_or_lighting_credit(self):
        result = coverage.build_manifest({'world': {'source': SOURCE, 'maps': [{'id': 48, 'name': 'Local map'}],
                                                   'areas': [{'id': 99, 'mapId': 48, 'name': 'Room'}]}})
        self.assertEqual({c['category'] for c in result['cases']}, {'world', 'lighting'})
        self.assertTrue(all(c['readiness']['status'] == 'unverified' for c in result['cases']))
        self.assertEqual(result['summary']['byStatus']['render'], {'unverified': 3})

    def test_gear_representatives_and_all_item_inventory(self):
        data = {'items': {'source': SOURCE, 'items': {'1': {'display': 5, 'inventory': 1}, '2': {'display': 5, 'inventory': 1}},
                          'displays': {'5': {'models': [[123]], 'geosets': [1], 'textures': [[456]]}}},
                'characters': [{'source': SOURCE, 'race': 1, 'sex': 0, 'file': 789}]}
        result = coverage.build_manifest(data)
        self.assertEqual(result['summary']['byKind']['item'], 2)
        gear = next(c for c in result['cases'] if c['id'].startswith('gear-case:'))
        self.assertEqual(gear['actors'][0]['equipment'], [{'slot': 0, 'displayId': 5}])

    def test_cli_writes_repeatable_local_batches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            source = path / 'spells.json'
            source.write_text(json.dumps(catalogs()['spells']))
            cmd = [sys.executable, str(Path(__file__).with_name('renderer-coverage.py')), '--spells', str(source),
                   '--output', str(path / 'out'), '--batch-size', '2']
            subprocess.run(cmd, check=True, capture_output=True)
            first = (path / 'out/manifest.json').read_bytes()
            subprocess.run(cmd, check=True, capture_output=True)
            self.assertEqual((path / 'out/manifest.json').read_bytes(), first)
            self.assertTrue(list((path / 'out').glob('batch-*.json')))
            self.assertFalse(list((path / 'out').glob('*.png')))


if __name__ == '__main__':
    unittest.main()
