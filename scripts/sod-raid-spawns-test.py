#!/usr/bin/env python3
"""Independent coordinate, ruleset, coverage, and source-identity checks."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('sod_raid_spawns', Path(__file__).with_name('sod-raid-spawns.py'))
spawns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawns)


def floor(bounds=(10, 20, 394, 276), index=1, floor_id=375):
    return {'id': floor_id, 'index': index,
            **dict(zip(('ingame_min_x', 'ingame_min_y', 'ingame_max_x', 'ingame_max_y'), bounds))}


def versions():
    return [{'id': 100, 'dungeon_id': 138, 'game_version_id': 2, 'version': 999},
            {'id': 538, 'dungeon_id': 138, 'game_version_id': 10, 'version': 1},
            {'id': 539, 'dungeon_id': 138, 'game_version_id': 10, 'version': 3}]


def enemy(enemy_id=1, entry=123, mapping=539, floor_id=375):
    return {'id': enemy_id, 'mapping_version_id': mapping, 'floor_id': floor_id,
            'npc_id': entry, 'lat': -128, 'lng': 192}


def npc(friendly=False):
    return {'display_id': 456, 'classification_id': 3,
            'aggressiveness': 'friendly' if friendly else 'aggressive'}


class SoDReferenceTests(unittest.TestCase):
    def test_independent_map_corners_and_axis_conventions(self):
        f = floor()
        self.assertEqual(spawns.world_position(f, 0, 0, 'identity'), [394, 276, None])
        self.assertEqual(spawns.world_position(f, -256, 384, 'identity'), [10, 20, None])
        self.assertEqual(spawns.world_position(f, -128, 192, 'identity'), [202, 148, None])
        self.assertEqual(spawns.world_position(f, -128, 192, 'rotated'), [148, -202, None])
        descending = floor((394, 276, 10, 20))
        self.assertEqual(spawns.world_position(descending, 0, 0, 'identity'), [10, 20, None])

    def test_independently_checked_gnomer_and_aq_native_anchors(self):
        # Gnomer7603 is already nativeXY. AQ Emperor15276 needs the rotated plane.
        gnomer = floor((-967.33, -127.77, -387.55, 741.89))
        aq = floor((-138.07, -9510.98, -2915.62, -7659.28))
        self.assertEqual(spawns.world_position(gnomer, -188.78, 282.08, 'identity'),
                         [-813.4467, 100.5837, None])
        self.assertEqual(spawns.world_position(aq, -167.15, 236.36, 'rotated'),
                         [-8868.3099, 1205.9801, None])

    def test_selects_explicit_sod_mapping_not_classic_or_raw_log_import(self):
        self.assertEqual(spawns.select_mapping(versions(), 138)['id'], 539)
        with self.assertRaisesRegex(spawns.SourceError, 'No explicit SoD'):
            spawns.select_mapping([versions()[0]], 138)
        result = spawns.project_map({'id': 138, 'floors': [floor()]}, versions(),
            {123: npc()}, {123: 'Boss'}, {1: [enemy(1), enemy(2, mapping=100), enemy(3, mapping=538)]}, 'identity')
        self.assertEqual(result['mappingVersion'], 539)
        self.assertEqual(result['sourceCount'], 1)
        self.assertEqual([row['id'] for row in result['placements']], ['1'])

    def test_zero_or_missing_bounds_stay_unplaced_without_fabricated_height_or_facing(self):
        self.assertIsNone(spawns.world_position(floor((0, 0, 0, 0)), -10, 20, 'rotated'))
        self.assertIsNone(spawns.world_position({'index': 1}, -10, 20, 'identity'))
        result = spawns.project_map({'id': 138, 'floors': [floor((0, 0, 0, 0))]}, versions(),
            {123: npc()}, {123: 'Boss'}, {1: [enemy()]}, 'rotated')
        self.assertEqual(result['placements'], [])
        self.assertEqual(result['unplaced'], [{'id': '1', 'entry': 123, 'name': 'Boss',
            'displayID': 456, 'floor': 1, 'sourcePosition': [-128, 192]}])
        with self.assertRaisesRegex(spawns.SourceError, 'non-finite'):
            spawns.world_position(floor(), float('nan'), 20, 'identity')

    def test_counts_friendly_exclusions_and_rejects_missing_required_metadata(self):
        result = spawns.project_map({'id': 138, 'floors': [floor()]}, versions(),
            {123: npc(), 124: npc(True)}, {123: 'Boss'}, {1: [enemy(), enemy(2, entry=124)]}, 'identity')
        self.assertEqual(result['sourceCount'], 2)
        self.assertEqual(result['excludedFriendly'], 1)
        self.assertEqual(len(result['placements']), 1)
        self.assertTrue(result['placements'][0]['boss'])
        self.assertIsNone(result['placements'][0]['position'][2])
        self.assertIsNone(result['placements'][0]['facing'])
        with self.assertRaisesRegex(spawns.SourceError, 'Missing NPC metadata'):
            spawns.project_map({'id': 138, 'floors': [floor()]}, versions(), {}, {}, {1: [enemy()]}, 'identity')
        with self.assertRaisesRegex(spawns.SourceError, 'Missing NPC display or name'):
            spawns.project_map({'id': 138, 'floors': [floor()]}, versions(), {123: npc()}, {}, {1: [enemy()]}, 'identity')

    def test_rejects_wrong_floor_and_duplicate_source_actor_ids(self):
        for rows, message in [([enemy(floor_id=999)], 'different source floor'),
                              ([enemy(), enemy()], 'unique positive integers')]:
            with self.assertRaisesRegex(spawns.SourceError, message):
                spawns.project_map({'id': 138, 'floors': [floor()]}, versions(),
                    {123: npc()}, {123: 'Boss'}, {1: rows}, 'identity')

    def test_php_names_do_not_execute_source_and_preserve_literal_escapes(self):
        text = "<?php\nreturn [\n 123 => 'Mason\\'s Echo',\n 124 => 'NPC\\\\Name',\n];\n"
        self.assertEqual(spawns.npc_names(text), {123: "Mason's Echo", 124: 'NPC\\Name'})

    def test_source_cache_cannot_change_manifest_and_bytes_together(self):
        data = b'approved numeric input\n'
        approved = {'sha256': hashlib.sha256(data).hexdigest(),
                    'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}
        manifest = {'commit': spawns.SOURCE_REVISION,
                    'files': [{'path': 'input.json', 'sha256': approved['sha256'], 'blob': approved['gitBlob']}]}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(spawns.SOURCE_FILES, {'input.json': approved}, clear=True):
            source = Path(tmp)
            (source / 'source-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            (source / 'input.json').write_bytes(data)
            self.assertEqual(spawns.load_source(source), {'input.json': data})
            (source / 'input.json').write_bytes(b'changed')
            with self.assertRaisesRegex(spawns.SourceError, 'content mismatch'):
                spawns.load_source(source)
            manifest['files'][0]['sha256'] = hashlib.sha256(b'changed').hexdigest()
            (source / 'source-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(spawns.SourceError, 'manifest identity mismatch'):
                spawns.load_source(source)
            manifest['commit'] = 'another-revision'
            (source / 'source-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(spawns.SourceError, 'pinned revision'):
                spawns.load_source(source)

    def test_pinned_checkout_does_not_require_an_ignored_manifest(self):
        data = b'approved checkout input\n'
        approved = {'sha256': hashlib.sha256(data).hexdigest(),
                    'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(spawns.SOURCE_FILES, {'input.json': approved}, clear=True):
            source = Path(tmp)
            (source / 'input.json').write_bytes(data)
            self.assertFalse((source / 'source-manifest.json').exists())
            self.assertEqual(spawns.load_source(source), {'input.json': data})
            (source / 'input.json').write_bytes(b'tampered checkout')
            with self.assertRaisesRegex(spawns.SourceError, 'content mismatch'):
                spawns.load_source(source)

    def test_similarity_registration_uses_only_paired_map_and_native_anchors(self):
        coefficients = spawns.similarity_registration([[0, 0], [0, 1]], [[10, 20], [10, 22]])
        self.assertEqual(coefficients, {'real': 0, 'imaginary': 2, 'offsetX': 10, 'offsetY': 20})
        self.assertEqual(spawns.registered_position(coefficients, 1, 1), [8, 22, None])
        with self.assertRaisesRegex(spawns.SourceError, 'distinct'):
            spawns.similarity_registration([[0, 0], [0, 0]], [[10, 20], [10, 22]])
        with self.assertRaisesRegex(spawns.SourceError, 'finite'):
            spawns.similarity_registration([[0, 0], [0, float('nan')]], [[10, 20], [10, 22]])

    def test_shipped_portal_references_retain_registration_and_uncertainty(self):
        value = json.loads((ROOT / 'third_party/raid-spawns/sod.json').read_text(encoding='utf-8'))
        scarlet = value['maps']['2856']
        registration, = scarlet['registrations']
        self.assertEqual(registration['id'], 'scarlet-floor2-portals')
        self.assertEqual(registration['kind'], 'portal-registration-approximate')
        self.assertEqual(registration['mappingVersion'], 539)
        self.assertEqual((registration['sourceFloor'], registration['targetFloor']), (2, 1))
        self.assertEqual([(a['sourceMarkerID'], a['targetMarkerID']) for a in registration['anchors']],
                         [(2027, 2028), (2029, 2026)])
        self.assertEqual(registration['anchors'][0]['sourcePercent'], [45.5, 92.3828125])
        self.assertEqual([a['sourcePosition'] for a in registration['anchors']],
                         [[-236.5, 174.72], [-245.75, 139.47]])
        self.assertEqual([a['targetPosition'] for a in registration['anchors']],
                         [[-35, 276.71], [-45.5, 237.21]])
        for actual, expected in zip(registration['anchors'][0]['nativePosition'], [1784.084375, -5925.14587734375]):
            self.assertAlmostEqual(actual, expected, places=8)
        self.assertEqual(registration['validation']['geometryAmbiguities'], 37)
        self.assertEqual(registration['validation']['placementCount'], 220)
        self.assertEqual(registration['validation']['bossLandmarks'], 3)
        self.assertIn('not authoritative server spawns', registration['uncertainty'])
        expected_bosses = {238954: [1946.225, -5775.339], 241021: [2157.892, -6165.265],
                           240794: [2086.156, -5724.212]}
        approximate = [row for row in scarlet['placements'] if row['kind'] == 'portal-registered-reference']
        self.assertEqual(len(approximate), 220)
        self.assertEqual({row['floor'] for row in approximate}, {2})
        for row in approximate:
            self.assertEqual(row['confidence'], 'portal-registration-approximate')
            self.assertEqual(row['registration'], registration['id'])
            self.assertIsNone(row['position'][2])
            self.assertIsNone(row['facing'])
            self.assertEqual(spawns.registered_position(registration['coefficients'], *row['sourcePosition']),
                             row['position'])
            if row['entry'] in expected_bosses:
                for actual, expected in zip(row['position'], expected_bosses[row['entry']]):
                    self.assertAlmostEqual(actual, expected, delta=0.001)
        self.assertEqual(len([r for r in scarlet['placements'] if r['kind'] == 'sod-reference']), 374)
        paths = {row['path'] for row in value['sourceFiles']}
        self.assertEqual(len(paths), 18)
        self.assertIn('database/seeders/dungeondata/classic/scarlet_enclave/1/dungeon_floor_switch_markers.json', paths)
        self.assertIn('database/seeders/dungeondata/classic/scarlet_enclave/2/dungeon_floor_switch_markers.json', paths)
        self.assertFalse(any('log' in path.lower() or 'event' in path.lower() for path in paths))

    def test_shipped_counts_coordinates_and_provenance(self):
        value = json.loads((ROOT / 'third_party/raid-spawns/sod.json').read_text(encoding='utf-8'))
        self.assertEqual(value['schema'], 1)
        self.assertEqual(value['ruleset'], 'sod')
        self.assertEqual(value['sourceRevision'], spawns.SOURCE_REVISION)
        self.assertEqual(value['sourceURL'], f'{spawns.SOURCE_ROOT}/tree/{spawns.SOURCE_REVISION}')
        self.assertEqual({row['path']: {key: row[key] for key in ('sha256', 'gitBlob')}
                          for row in value['sourceFiles']}, spawns.SOURCE_FILES)
        self.assertEqual(set(value['maps']), {'90', '531', '2856'})
        expected = {'90': (304, 294, 2, 292, 0), '531': (442, 164, 0, 164, 0),
                    '2856': (539, 662, 0, 594, 68)}
        for key, counts in expected.items():
            row = value['maps'][key]
            self.assertEqual((row['mappingVersion'], row['sourceCount'], row['excludedFriendly'],
                              len(row['placements']), len(row['unplaced'])), counts)
            self.assertEqual(row['kind'], 'sod-reference')
            self.assertEqual(len({r['id'] for r in row['placements'] + row['unplaced']}),
                             row['sourceCount'] - row['excludedFriendly'])
            for actor in row['placements']:
                self.assertEqual(len(actor['position']), 3)
                self.assertIsNone(actor['position'][2])
                self.assertIsNone(actor['facing'])
                self.assertGreater(actor['displayID'], 0)
        self.assertEqual({r['floor'] for r in value['maps']['2856']['placements']}, {1, 2})
        self.assertEqual({r['floor'] for r in value['maps']['2856']['unplaced']}, {4, 5})
        self.assertNotIn(7998, {r['entry'] for r in value['maps']['90']['placements']})
        self.assertNotIn(7850, {r['entry'] for r in value['maps']['90']['placements']})


if __name__ == '__main__':
    unittest.main()
