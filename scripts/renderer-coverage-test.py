#!/usr/bin/env python3
"""Synthetic catalog tests; no installed client or game imagery required."""
import importlib.util
import copy
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
                          'displays': {'11': {'modelID': 10, 'scale': 1, 'textures': [124]}}}}


def decoded_model(file_id=123):
    return {'fileDataID': file_id, 'status': 'adapted',
            'source': {'sha256': 'local-content-hash',
                       'counts': {'vertices': 3, 'particles': 1, 'ribbons': 0},
                       'features': {'multiTextureParticles': 1, 'particleFlags': {'16': 1}}},
            'skinFeatures': [{'batches': [{'shader': 0x4011, 'textureStages': 2}]}],
            'renderFeatures': {'meshUvSources': [0, 1], 'meshBlendModes': [2],
                               'particleUvModes': ['identity'], 'particleGravityModes': ['scalar-z']}}


class CoverageTest(unittest.TestCase):
    def test_nonpositive_item_visual_sentinels_do_not_create_missing_dependencies(self):
        data = catalogs()
        data['items'] = {'source': SOURCE, 'displays': {'1': {'visual': -1, 'rangedVisual': -1},
            '2': {'visual': 0}, '3': {'visual': 7}},
            'enchantments': {'10': {'visual': -1}, '11': {'visual': 0}, '12': {'visual': 7}}}
        rows = {r['id']: r for r in coverage.build_manifest(data, max_cases=0)['entries']}
        for key in ['gear:1', 'gear:2', 'enchantment:10', 'enchantment:11']:
            self.assertEqual(rows[key]['dependencies'], [])
            self.assertFalse(any('item-visual:-1' in gap for gap in rows[key]['coverageGaps']))
        for key in ['gear:3', 'enchantment:12']:
            self.assertIn('missing-reference:item-visual:7', rows[key]['coverageGaps'])

    def test_item_visual_and_enchant_chains_preserve_positional_slots_and_missing_targets(self):
        data = catalogs()
        data['items'] = {'source': SOURCE, 'items': {'41': {'display': 12}},
            'displays': {'12': {'visual': 7, 'rangedVisual': 4}},
            'itemVisuals': {'7': [0, 999, -1, 1000, 0]},
            'enchantments': {'8': {'visual': 7}, '9': {'visual': 77}, '10': {'visual': 0}}}
        rows = {r['id']: r for r in coverage.build_manifest(data, max_cases=0)['entries']}
        self.assertEqual(rows['item-visual:7']['dependencies'], ['asset:1000', 'asset:999'])
        self.assertEqual(rows['item-visual:7']['fingerprint'], coverage.digest(['item-visual', [0, 999, -1, 1000, 0], ['asset:1000', 'asset:999']]))
        self.assertEqual(rows['enchantment:8']['dependencies'], ['item-visual:7'])
        self.assertEqual(rows['enchantment:10']['dependencies'], [])
        self.assertIn('missing-reference:item-visual:77', rows['enchantment:9']['coverageGaps'])
        self.assertEqual(rows['gear:12']['dependencies'], ['item-visual:7', 'visual:4'])
        self.assertIn('resource:model', rows['item:41']['renderCapabilities'])
        self.assertNotIn('asset:7', rows)

    def test_sparse_definition_roots_join_real_owners_and_preserve_backreferences(self):
        data = catalogs()
        data['spells']['kits']['8']['effects'][0]['id'] = 99
        definitions = {'tables': {'Curve': {'rows': {'1': {'ID': 1}}},
                                 'CurvePoint': {'rows': {'2': {'ID': 2, 'Value': 1}}}},
            'roots': [{'owner': 'SpellVisualKitModelAttach:99', 'field': 'ScaleCurveID', 'table': 'Curve', 'id': 1}],
            'references': [{'owner': 'Curve:1', 'table': 'CurvePoint', 'id': 2},
                           {'owner': 'CurvePoint:2', 'table': 'Curve', 'id': 1}]}
        data['spells']['referenceDefinitions'] = definitions
        result = coverage.build_manifest(data, verification_id='local')
        rows = {r['id']: r for r in result['entries']}
        self.assertIn('definition:Curve:1', rows['kit:8']['dependencies'])
        self.assertEqual(rows['definition:Curve:1']['referenceTargets'], ['definition:CurvePoint:2'])
        self.assertEqual(rows['definition:Curve:1']['dependencies'], [], 'membership backreferences are not recursive render loads')
        self.assertFalse(any('dependency-cycle' in gap for gap in rows['spell:1']['coverageGaps']))
        before = rows['spell:1']['dependencyFingerprint']
        definitions['tables']['CurvePoint']['rows']['2']['Value'] = .5
        changed = coverage.build_manifest(data, verification_id='local')
        self.assertNotEqual(before, next(r for r in changed['entries'] if r['id'] == 'spell:1')['dependencyFingerprint'])
        definitions['references'][0]['id'] = 404
        missing = coverage.build_manifest(data)
        self.assertIn('missing-reference:definition:CurvePoint:404', next(r for r in missing['entries'] if r['id'] == 'spell:1')['coverageGaps'])

    def test_definition_animation_zero_and_unjoined_owners_are_not_silently_dropped(self):
        data = catalogs()
        data['spells']['kits']['8']['animations'] = [{'ID': 7}]
        data['spells']['referenceDefinitions'] = {'tables': {'AnimationData': {'rows': {'0': {'ID': 0}}}},
            'roots': [{'owner': 'SpellVisualAnim:7', 'table': 'AnimationData', 'id': 0},
                      {'owner': 'FutureOwner:9', 'table': 'AnimationData', 'id': 0}], 'references': []}
        rows = {r['id']: r for r in coverage.build_manifest(data)['entries']}
        self.assertIn('definition:AnimationData:0', rows['kit:8']['dependencies'])
        self.assertIn('normalized-reference-owner-unavailable', rows['definition-owner:FutureOwner:9']['issues'])

    def test_raw_items_without_default_appearance_remain_explicit_without_guessed_displays(self):
        data = catalogs()
        data['items'] = {'source': SOURCE, 'items': {}, 'displays': {}, 'unresolvedItems': {
            '41': {'inventory': 6, 'display': 0}, '42': {'inventory': 0, 'display': 0}}}
        result = coverage.build_manifest(data, max_cases=0)
        rows = {r['id']: r for r in result['entries']}
        self.assertIn('default-item-appearance-unavailable', rows['item:41']['issues'])
        self.assertIn('item-without-renderer-equipment-slot', rows['item:42']['issues'])
        self.assertEqual(rows['item:41']['dependencies'], [])
        self.assertNotIn('gear:0', rows)

    def test_internal_model_dependencies_keep_resource_types_and_invalidate_parents(self):
        data = catalogs()
        feature = decoded_model()
        feature['dependencies'] = [{'kind': 'TXID', 'fileDataID': 999, 'available': True},
                                   {'kind': 'RPID', 'fileDataID': 1000, 'available': False}]
        result = coverage.build_manifest(data, model_features=[feature])
        rows = {r['id']: r for r in result['entries']}
        self.assertEqual(rows['asset:123']['dependencies'], ['asset:1000', 'asset:999'])
        self.assertIn('resource:texture', rows['asset:999']['renderCapabilities'])
        self.assertNotIn('decoded-model-features-missing', rows['asset:999']['coverageGaps'])
        self.assertIn('source-resource-unavailable', rows['asset:1000']['issues'])
        before = rows['spell:1']['dependencyFingerprint']
        feature['dependencies'][0]['fileDataID'] = 998
        after = coverage.build_manifest(data, model_features=[feature])
        self.assertNotEqual(before, next(r for r in after['entries'] if r['id'] == 'spell:1')['dependencyFingerprint'])

    def test_equipment_file_references_do_not_include_selector_metadata(self):
        data = catalogs()
        data['items'] = {'source': SOURCE, 'displays': {'1': {
            'models': [[{'file': 1000, 'race': 8, 'sex': 1, 'position': 17}]],
            'textures': [[{'file': 1001, 'race': 4, 'sex': 3}]],
            'regions': {'5': [{'file': 1002, 'race': 6, 'sex': 1}]}}}}
        rows = {r['id']: r for r in coverage.build_manifest(data)['entries']}
        self.assertEqual(rows['gear:1']['dependencies'], ['asset:1000', 'asset:1001', 'asset:1002'])
        self.assertFalse(any('asset:' + str(i) in rows for i in (3, 4, 5, 6, 8, 17)))

    def test_modern_character_body_joins_through_display_not_chrmodel_id(self):
        data = catalogs()
        data['characters'] = {'source': SOURCE, 'bodies': [
            {'race': 1, 'sex': 0, 'modelId': 999, 'displayId': 11}]}
        rows = {r['id']: r for r in coverage.build_manifest(data)['entries']}
        self.assertEqual(rows['character:1:0:0']['dependencies'], ['display:11'])
        self.assertIn('character-customization-dependencies-unverified', rows['character:1:0:0']['issues'])
        self.assertNotIn('model:999', rows)

    def test_inventory_fixture_limit_preserves_all_content_and_explicit_omissions(self):
        whole = coverage.build_manifest(catalogs())
        bounded = coverage.build_manifest(catalogs(), max_cases=0)
        self.assertEqual(whole['entries'], bounded['entries'])
        self.assertEqual(bounded['cases'], [])
        self.assertEqual(bounded['summary']['inventoryCaseCandidates'], len(whole['cases']))
        self.assertEqual(sum(bounded['summary']['omittedInventoryCases'].values()), len(whole['cases']))
        self.assertEqual(len(coverage.build_manifest(catalogs(), max_cases=1)['cases']), 1)

    def test_nonchannel_spell_visual_does_not_invent_a_channel_lifecycle(self):
        data = catalogs()
        spell = {'visuals': [{'id': 4}], 'channel': False, 'castMs': 0}
        data['spells']['spells'] = {'1': spell}
        data['spells']['visuals']['4']['events'].append({'start': 'Channel Start', 'target': 'Caster', 'kit': 8})
        stages, gaps = coverage.recipe_stages(spell, data['spells'])
        self.assertNotIn('channel', stages)
        self.assertIn('channel-event-on-nonchannel-spell', gaps)
        result = coverage.build_manifest(data)
        cast = next(c for c in result['representativeCases'] if c['effects'][0]['stage'] == 'cast')
        self.assertEqual(cast['effects'][0]['durationMs'], 0)

    def test_invalid_procedural_chain_ids_do_not_break_inventory_or_truncate(self):
        for value in (None, 3.5, '4', -1, True):
            data = catalogs()
            data['spells']['kits']['8']['proceduralEffects'] = [{'id': 99, 'type': 0, 'values': [value, 1, 0, 0]}]
            rows = {r['id']: r for r in coverage.build_manifest(data)['entries']}
            self.assertEqual(rows['procedure:99']['dependencies'], [])

    def test_bounded_diversity_covers_lifecycles_before_redundant_popular_families(self):
        self.assertEqual(coverage.known_capabilities({'renderCapabilities':
            ['missing-reference:kit:999', 'catalog-primitive:Opaque', 'procedure:type:999', 'asset:unclassified']}), set())
        data = catalogs()
        graph = data['spells']
        graph['visuals']['4']['missiles'] = []
        graph['spells'] = {str(i): {'visuals': [{'id': 4}], 'durationMs': i} for i in range(1, 51)}
        for spell_id, stage in [(100, 'Aura Start'), (200, 'Channel Start')]:
            graph['visuals'][str(spell_id)] = {'events': [{'start': stage, 'target': 'Caster', 'kit': 8}]}
            graph['spells'][str(spell_id)] = {'visuals': [{'id': spell_id}], 'channel': stage == 'Channel Start'}
        graph['visuals']['400'] = {'events': [], 'missiles': [{'effect': 9}]}
        graph['spells']['400'] = {'visuals': [{'id': 400}]}
        graph['spells']['300'] = {'visuals': [{'id': 4}],
            'summonCue': {'visualSpellID': 100, 'displayID': 11, 'presentation': 'illustrative'}}
        # Many opaque primitive IDs must not displace the executable, known lifecycle paths.
        graph['kits']['999'] = {'unsupported': [{'type': 'Opaque', 'id': i} for i in range(100)]}
        graph['visuals']['999'] = {'events': [{'start': 'ServerOnly', 'target': 'Area', 'kit': 999}]}
        graph['spells']['999'] = {'visuals': [{'id': 999}]}
        result = coverage.build_manifest(data, representative_limit=6, case_limit=5)
        self.assertEqual(len(result['representativeCases']), 5)
        self.assertEqual({c['effects'][0]['stage'] for c in result['representativeCases']},
                         {'cast', 'flight', 'aura', 'channel', 'summon'})
        popular = next(f for f in result['renderFamilies'] if 'spell:1' in f['memberIds'])
        self.assertEqual(popular['selectedIds'], ['spell:1', 'spell:50'])
        self.assertFalse(any('spell:999' in f['selectedIds'] for f in result['renderFamilies']))
        self.assertTrue(any('case-selection-budget' in r['ungenerated'] for r in result['lifecycleRecipes']))
        self.assertTrue(all(r['status']['visual'] == 'unverified' for r in result['entries']))
        graph['spells'] = dict(reversed(list(graph['spells'].items())))
        self.assertEqual(result, coverage.build_manifest(data, representative_limit=6, case_limit=5))

    def test_rank_and_distinct_content_share_structural_paths_with_stable_edge_selection(self):
        data = catalogs()
        spells = data['spells']['spells']
        spells['10'] = dict(copy.deepcopy(spells['1']), name='Higher rank', durationMs=5000)
        spells['1']['durationMs'] = 1000
        result = coverage.build_manifest(data, representative_limit=2)
        rows = {r['id']: r for r in result['entries']}
        self.assertNotEqual(rows['spell:1']['fingerprint'], rows['spell:10']['fingerprint'])
        self.assertEqual(rows['spell:1']['renderSignature'], rows['spell:10']['renderSignature'])
        family = next(f for f in result['renderFamilies'] if 'spell:1' in f['memberIds'])
        self.assertEqual(family['memberCount'], 2)
        self.assertEqual(family['representativeId'], 'spell:1')
        self.assertEqual(family['edgeIds'], ['spell:10'])
        self.assertEqual(family['selectedIds'], ['spell:1', 'spell:10'])
        data['spells']['spells'] = dict(reversed(list(spells.items())))
        again = coverage.build_manifest(data, representative_limit=2)
        self.assertEqual(result, again)

    def test_ids_scales_and_mesh_size_are_content_not_rendering_mechanisms(self):
        data = catalogs()
        before = coverage.build_manifest(data, model_features=[decoded_model()])
        changed = copy.deepcopy(data)
        changed['spells']['effects']['9']['scale'] = 10
        changed['spells']['effects']['9']['fileDataID'] = 999
        feature = decoded_model(999)
        feature['source']['counts']['vertices'] = 500
        after = coverage.build_manifest(changed, model_features=[feature])
        row = lambda manifest: next(r for r in manifest['entries'] if r['id'] == 'spell:1')
        self.assertNotEqual(row(before)['dependencyFingerprint'], row(after)['dependencyFingerprint'])
        self.assertEqual(row(before)['renderSignature'], row(after)['renderSignature'])

    def test_shader_uv_and_gravity_modes_separate_families_and_missing_fields_stay_unknown(self):
        base = decoded_model()
        original = coverage.build_manifest(catalogs(), model_features=[base])
        def spell(manifest):
            return next(r for r in manifest['entries'] if r['id'] == 'spell:1')
        variants = []
        shader = copy.deepcopy(base)
        shader['skinFeatures'][0]['batches'][0]['shader'] = 0x4014
        variants.append(shader)
        uv = copy.deepcopy(base)
        uv['renderFeatures']['particleUvModes'] = ['polar']
        variants.append(uv)
        gravity = copy.deepcopy(base)
        gravity['renderFeatures']['particleGravityModes'] = ['vector-xyz']
        variants.append(gravity)
        for feature in variants:
            with self.subTest(feature=feature):
                changed = coverage.build_manifest(catalogs(), model_features=[feature])
                self.assertNotEqual(spell(original)['renderSignature'], spell(changed)['renderSignature'])
        partial = copy.deepcopy(base)
        del partial['renderFeatures']
        unknown = spell(coverage.build_manifest(catalogs(), model_features=[partial]))
        self.assertIn('model-feature-unclassified:particleGravityModes', unknown['coverageGaps'])
        self.assertIn('model-feature-unclassified:meshUvSources', unknown['coverageGaps'])
        missing = spell(coverage.build_manifest(catalogs()))
        self.assertIn('decoded-model-features-missing', missing['coverageGaps'])
        self.assertEqual(missing['drawExpectation'], 'unknown')

    def test_invisible_decoded_models_and_empty_visuals_expect_no_draw_without_approving_visibility(self):
        invisible = decoded_model()
        invisible['source']['counts'] = {'vertices': 0, 'particles': 0, 'ribbons': 0}
        invisible['source']['features'] = {}
        invisible['skinFeatures'] = []
        invisible['renderFeatures'] = {}
        result = coverage.build_manifest(catalogs(), model_features=[invisible])
        rows = {r['id']: r for r in result['entries']}
        for key in ['effect:9', 'kit:8', 'visual:4', 'spell:1', 'spell:2']:
            self.assertEqual(rows[key]['drawExpectation'], 'none')
            self.assertEqual(rows[key]['status']['render'], 'expected-none')
            self.assertEqual(rows[key]['status']['visual'], 'unverified')
        opaque = copy.deepcopy(invisible)
        opaque['status'] = 'unsupported'
        result = coverage.build_manifest(catalogs(), model_features=[opaque])
        self.assertEqual(next(r for r in result['entries'] if r['id'] == 'spell:1')['drawExpectation'], 'unknown')

    def test_missing_dependencies_unsupported_primitives_and_kit_only_states_remain_explicit(self):
        data = catalogs()
        data['spells']['kits']['8']['effects'].append({'effect': 404})
        data['spells']['kits']['8']['unsupported'] = [{'type': 'UnknownPrimitive', 'id': 500}]
        data['spells']['kits']['99'] = {'effects': []}
        result = coverage.build_manifest(data)
        spell = next(r for r in result['entries'] if r['id'] == 'spell:1')
        self.assertIn('missing-reference:effect:404', spell['coverageGaps'])
        self.assertIn('catalog-primitive-unclassified:UnknownPrimitive', spell['coverageGaps'])
        self.assertEqual(spell['status']['render'], 'unverified')
        self.assertIn({'entryId': 'kit:99', 'reason': 'kit-only-native-routing-unimplemented'}, result['ungeneratedRecipes'])

    def test_lifecycle_recipes_use_supported_native_stages_and_do_not_claim_server_mechanics(self):
        data = catalogs()
        data['spells']['spells']['1']['channel'] = True
        graph = data['spells']
        graph['visuals']['4']['events'] += [{'start': start, 'target': 'Target', 'kit': 8}
            for start in ['Impact', 'Aura Start', 'Aura End', 'Channel Start', 'Channel End', 'ServerOnly']]
        graph['spells']['1']['summonCue'] = {'visualSpellID': 2, 'displayID': 11, 'presentation': 'illustrative'}
        result = coverage.build_manifest(data)
        cases = [c for c in result['representativeCases'] if c['coverageIds'] == ['spell:1']]
        self.assertEqual({c['effects'][0]['stage'] for c in cases}, {'cast', 'flight', 'aura', 'channel', 'summon'})
        for case in cases:
            self.assertTrue(all(a['kind'] == 'character' for a in case['actors']))
            self.assertGreater(case['timesMs'][-1], case['effects'][0]['durationMs'])
        recipe = next(r for r in result['lifecycleRecipes'] if r['entryId'] == 'spell:1')
        self.assertIn('server-or-unmapped-event:ServerOnly', recipe['ungenerated'])
        self.assertEqual(recipe['consumerContext'], 'spell-fx')

    def test_representative_pass_does_not_approve_members_or_other_consumer_contexts(self):
        data = catalogs()
        data['spells']['spells']['3'] = copy.deepcopy(data['spells']['spells']['1'])
        original = coverage.build_manifest(data, verification_id='renderer-a', representative_limit=1)
        member = next(r for r in original['entries'] if r['id'] == 'spell:1')
        member['status']['visual'] = 'pass'
        member['evidence'] = [{'consumerContext': 'spell-fx', 'path': 'reviewed.png'}]
        result = coverage.build_manifest(data, verification_id='renderer-a', resume=original, representative_limit=1)
        family = next(f for f in result['renderFamilies'] if 'spell:1' in f['memberIds'])
        self.assertEqual(family['byStatus']['visual'], {'pass': 1, 'unverified': 1})
        self.assertTrue(all(c['status'] == 'unverified' for c in family['consumerCoverage'].values()))
        self.assertIn('consumer-context-unverified:placed-doodad', family['coverageGaps'])
        self.assertTrue(all(c['coverageIds'] == ['spell:1'] for c in result['representativeCases']))

    def test_model_feature_changes_invalidate_dependent_credit_and_explicit_build_mismatch_fails(self):
        original = coverage.build_manifest(catalogs(), model_features=[decoded_model()], verification_id='renderer-a')
        for row in original['entries']:
            row['status']['visual'] = 'pass'
        changed = decoded_model()
        changed['renderFeatures']['meshUvSources'] = [1, 0]
        result = coverage.build_manifest(catalogs(), model_features=[changed], verification_id='renderer-a', resume=original)
        self.assertEqual(next(r for r in result['entries'] if r['id'] == 'spell:1')['status']['visual'], 'unverified')
        with self.assertRaisesRegex(ValueError, 'feature client source mismatch'):
            coverage.build_manifest(catalogs(), model_features={'source': dict(SOURCE, version='2'), 'models': [decoded_model()]})
        single = coverage.build_manifest(catalogs(), model_features=decoded_model())
        self.assertEqual(next(r for r in single['entries'] if r['id'] == 'effect:9')['drawExpectation'], 'potential-draw')
        self.assertTrue(all(r['status']['decode'] == 'unverified' for r in single['entries']))
        with self.assertRaisesRegex(ValueError, 'requires models or fileDataID'):
            coverage.build_manifest(catalogs(), model_features={'unrecognized': []})

    def test_procedural_graph_and_server_targets_are_classified_without_inventing_recipes(self):
        data = catalogs()
        graph = data['spells']
        graph['chainEffects'] = {'5': {'rendererCompatible': True, 'textureFileDataIDs': [456]}}
        graph['kits']['8']['proceduralEffects'] = [{'id': 7, 'type': 0, 'values': [5]}]
        graph['visuals']['4']['events'] = [{'start': 'Aura Start', 'target': 'Area', 'kit': 8}]
        graph['visuals']['4']['missiles'] = []
        result = coverage.build_manifest(data)
        spell = next(r for r in result['entries'] if r['id'] == 'spell:1')
        self.assertIn('procedure:chain', spell['renderCapabilities'])
        self.assertIn('event-target-requires-context:Area', spell['coverageGaps'])
        self.assertIn('chain:5', next(r for r in result['entries'] if r['id'] == 'procedure:7')['dependencies'])
        self.assertEqual(result['representativeCases'], [])
        recipe = next(r for r in result['lifecycleRecipes'] if r['entryId'] == 'spell:1')
        self.assertIn('server-or-unprovided-target:Area', recipe['ungenerated'])

    def test_cli_representatives_read_audit_jsonl_and_emit_only_bounded_native_recipes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            source, features = path / 'spells.json', path / 'models.jsonl'
            source.write_text(json.dumps(catalogs()['spells']))
            features.write_text(json.dumps(decoded_model()) + '\n')
            cmd = [sys.executable, str(Path(__file__).with_name('renderer-coverage.py')),
                   '--spells', str(source), '--model-features', str(features), '--representatives',
                   '--representative-limit', '1', '--batch-size', '1', '--output', str(path / 'out')]
            subprocess.run(cmd, check=True, capture_output=True)
            manifest = json.loads((path / 'out/manifest.json').read_text())
            cases = json.loads((path / 'out/cases.json').read_text())
            self.assertEqual(manifest['summary']['selectedSpellMembers'], 1)
            self.assertFalse(manifest['inputs']['modelFeatures']['identityVerified'])
            self.assertTrue(all(c['effects'][0].get('spellId') == 1 for c in cases))
            self.assertTrue(all(len(json.loads(p.read_text())) == 1 for p in (path / 'out').glob('batch-*.json')))
            self.assertTrue(any('representative-selection-budget' in f['coverageGaps'] for f in manifest['renderFamilies']))

    def test_shared_assets_and_kits_deduplicate_without_crediting_spell_routing(self):
        result = coverage.build_manifest(catalogs(), batch_size=2)
        rows = {r['id']: r for r in result['entries']}
        self.assertEqual([k for k in rows if k.startswith('asset:')], ['asset:123', 'asset:124'])
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
        self.assertEqual(gear['actors'][0]['equipment'], [{'slot': 0, 'itemId': 1, 'displayId': 5}])

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
