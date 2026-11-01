#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('encounter_audit', Path(__file__).with_name('encounter-audit.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def fixture():
    raw = {'gameVersion': 'sod', 'report': {'code': 'fixture'},
        'fight': {'id': 1, 'name': 'Boss', 'encounterID': 9, 'startTime': 1000, 'endTime': 5000, 'gameZone': {'id': 2856}},
        'actors': [{'id': 1, 'type': 'Player'}, {'id': 2, 'type': 'NPC', 'gameID': 123},
                   {'id': 3, 'type': 'NPC', 'gameID': 124}],
        'abilities': [{'gameID': 10, 'name': 'Aura'}],
        'events': [{'timestamp': 2000, 'type': 'applybuff', 'sourceID': 2, 'targetID': 2, 'abilityGameID': 10},
                   {'timestamp': 2500, 'type': 'summon', 'sourceID': 2, 'targetID': 3, 'targetInstance': 2, 'abilityGameID': 11},
                   {'timestamp': 3000, 'type': 'damage', 'sourceID': 1, 'targetID': 2, 'abilityGameID': 12},
                   {'timestamp': 3500, 'type': 'damage', 'sourceID': 2, 'targetID': 1, 'abilityGameID': -2}]}
    graph = {'schema': 1, 'source': {'buildKey': 'fixture'},
        'spells': {'10': {'visuals': [{'id': 20}]}},
        'visuals': {'20': {'events': [{'start': 'Aura Start', 'target': 'Caster', 'kit': 30, 'end': 'Aura End'}]}},
        'kits': {'30': {'effects': []}}, 'effects': {}}
    return raw, graph


class EncounterAuditTest(unittest.TestCase):
    def test_boss_owned_pets_are_encounter_sources_but_player_pets_are_not(self):
        raw, graph = fixture()
        raw['actors'][2].update(type='Pet', petOwner=2)
        raw['actors'].append({'id': 4, 'type': 'Pet', 'gameID': 416, 'petOwner': 1})
        raw['events'].extend([
            {'timestamp': 3100, 'type': 'heal', 'sourceID': 3, 'targetID': 2, 'abilityGameID': 13},
            {'timestamp': 3200, 'type': 'damage', 'sourceID': 4, 'targetID': 2, 'abilityGameID': 14},
            {'timestamp': 3300, 'type': 'applybuff', 'sourceID': 3, 'targetID': 3, 'abilityGameID': 15},
            {'timestamp': 3400, 'type': 'removebuff', 'targetID': 3, 'abilityGameID': 15}])
        report, _ = a.diagnose(raw, graph)
        encounter = report['encounters'][0]
        observed = {m['spellId']: m for m in encounter['mechanics']}
        self.assertIn(13, observed)
        self.assertNotIn(14, observed)
        self.assertEqual(observed[15]['eventCounts']['removebuff'], 1)
        self.assertTrue(any(e['key'] == '3:2' and e['lifecycle'][0]['type'] == 'summon'
                            for e in encounter['actors']))
        catalog = {x['id']: x for x in raw['actors']}
        catalog[3]['petOwner'] = 999
        self.assertFalse(a.npc(catalog[3], catalog))
        catalog[3]['petOwner'] = 3
        self.assertFalse(a.npc(catalog[3], catalog))

    def test_recorded_prelude_matches_the_actual_importer_and_includes_related_chapter_events(self):
        raw, graph = fixture()
        raw['fight'] = {**raw['fight'], 'id': 2, 'startTime': 2000}
        trash = {**raw['fight'], 'id': 1, 'encounterID': 0, 'startTime': 1000, 'endTime': 2000}
        raw['report'] = {'code': 'fixture', 'gameVersion': 'sod', 'fights': [trash, raw['fight']]}
        raw['events'] = [
            {'timestamp': 1200, 'type': 'encounterstart', 'encounterID': 44, 'fight': 1},
            {'timestamp': 1500, 'type': 'applybuff', 'fight': 1, 'sourceID': 2, 'targetID': 2, 'abilityGameID': 10},
            {'timestamp': 5000, 'type': 'encounterend', 'encounterID': 44, 'fight': 2}]
        result, _ = a.diagnose(raw, graph)
        encounter = result['encounters'][0]
        self.assertEqual(encounter['recordedBounds']['startTime'], 1200)
        self.assertEqual(encounter['recordedBounds']['reportedBounds']['startTime'], 2000)
        self.assertEqual(encounter['eventCount'], 3)
        self.assertEqual(encounter['mechanics'][0]['occurrences'][0]['atMs'], 300)
        raw['events'].pop()
        without_end, _ = a.diagnose(raw, graph)
        self.assertEqual(without_end['encounters'][0]['recordedBounds']['startTime'], 2000)
        self.assertEqual(without_end['encounters'][0]['mechanics'], [])

    def test_expected_mechanics_are_separate_unverified_contracts_even_without_log_events(self):
        raw, graph = fixture()
        contract = {'unitId': 'sod-boss', 'ruleset': 'sod', 'encounterId': 9,
            'sources': [{'url': 'https://example.org/original-guide'}],
            'expectedMechanics': [{k: 'Flood' for k in ('mechanic', 'trigger', 'state', 'lifecycle', 'placement', 'animation', 'acceptanceCheck')} |
                                  {'sources': ['original-guide'], 'verification': 'visually matched'}]}
        report, _ = a.diagnose(raw, graph, expectations=[contract])
        expected = report['encounters'][0]['expectations']
        self.assertEqual(expected['mechanics'][0]['verification'], 'unverified')
        self.assertIn('Flood', a.markdown(report))
        self.assertFalse(any(m['evidence']['visuallyMatched'] for m in report['encounters'][0]['mechanics']))
        other = dict(contract, ruleset='vanilla')
        self.assertIsNone(a.diagnose(raw, graph, expectations=[other])[0]['encounters'][0]['expectations'])
        self.assertIsNone(a.diagnose(raw, graph)[0]['encounters'][0]['expectations'])
        for bad in [dict(contract, ruleset=None), dict(contract, sources=[]),
                    dict(contract, expectedMechanics=[{'mechanic': 'Flood'}])]:
            with self.assertRaises(ValueError):
                a.diagnose(raw, graph, expectations=[bad])
        with self.assertRaises(ValueError):
            a.diagnose(raw, graph, expectations=[contract, contract])
        raw['events'].extend([
            {'timestamp': 2000, 'type': 'applybuff', 'sourceID': 1, 'targetID': 1, 'abilityGameID': 15},
            {'timestamp': 1000, 'type': 'combatantinfo', 'sourceID': 1, 'auras': [{'ability': 16}]},
            {'timestamp': 3000, 'type': 'damage', 'sourceID': 1, 'targetID': 2, 'abilityGameID': 17}])
        contract['expectedMechanics'][0]['spellIds'] = [15, 16, 18]
        e = a.diagnose(raw, graph, expectations=[contract])[0]['encounters'][0]
        self.assertEqual([m['spellId'] for m in e['mechanics']], [10, 11, 15, 16])
        self.assertEqual(e['expectations']['mechanics'][0]['observationCoverage']['missingSpellIds'], [18])
        self.assertEqual(e['mechanics'][-1]['occurrences'][0]['type'], 'combatantinfo-aura')
        self.assertIsNone(e['mechanics'][-1]['occurrences'][0]['source'])
        self.assertEqual(e['expectations']['mechanics'][0]['verification'], 'unverified')
        contract['expectedMechanics'][0]['spellIds'] = [True]
        with self.assertRaises(ValueError):
            a.diagnose(raw, graph, expectations=[contract])

    def test_cli_writes_traceable_cases_and_refuses_to_reuse_an_output_directory(self):
        raw, graph = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'replay.json').write_text(json.dumps(raw))
            (root / 'graph.json').write_text(json.dumps(graph))
            command = [sys.executable, str(Path(a.__file__)), '--replay', str(root / 'replay.json'),
                       '--graph', str(root / 'graph.json'), '--output', str(root / 'output')]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((root / 'output/report.json').read_text())
            self.assertEqual(report['caseCount'], 1)
            self.assertIn(str((root / 'replay.json').resolve()), report['inputs'])
            self.assertEqual(report['inputRoles']['replay'], str((root / 'replay.json').resolve()))
            self.assertEqual(json.loads((root / 'output/batch-000.json').read_text())[0]['effects'][0]['spellId'], 10)
            self.assertIn('Boss', (root / 'output/report.md').read_text())
            before = (root / 'output/report.json').read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual((root / 'output/report.json').read_bytes(), before)

    def test_inventory_includes_adds_but_not_player_attacks_or_special_id_lookups(self):
        raw, graph = fixture()
        report, cases = a.diagnose(raw, graph)
        e = report['encounters'][0]
        self.assertEqual([m['spellId'] for m in e['mechanics']], [10, 11])
        self.assertEqual(e['specialAbilityEvents'], {'-2': 1})
        self.assertEqual(e['actors'][1]['key'], '3:2')
        self.assertEqual(e['actors'][1]['lifecycle'][0]['eventIndex'], 1)
        self.assertFalse(e['mechanics'][0]['evidence']['nativeExecuted'])
        self.assertEqual(cases[0]['effects'][0]['targetId'], 'subject')
        self.assertEqual(cases[0]['actors'][0]['npcId'], 123)

    def test_provider_falling_does_not_resolve_an_unrelated_positive_client_spell_id(self):
        raw, graph = fixture()
        raw['abilities'].append({'gameID': 3, 'name': 'Falling'})
        raw['events'].append({'timestamp': 3000, 'type': 'damage', 'sourceID': -1, 'targetID': 1, 'abilityGameID': 3})
        e = a.diagnose(raw, graph)[0]['encounters'][0]
        self.assertNotIn(3, [m['spellId'] for m in e['mechanics']])
        self.assertEqual(e['specialAbilityEvents']['provider-environmental:3:Falling'], 1)

    def test_unknown_caster_aura_owner_does_not_generate_a_target_fixture(self):
        raw, graph = fixture()
        raw['events'][0]['targetID'] = 1
        _, cases = a.diagnose(raw, graph)
        self.assertEqual(cases, [])

    def test_source_free_removal_keeps_npc_aura_cleanup_on_the_exact_target_instance(self):
        raw, graph = fixture()
        raw['events'].extend([
            {'timestamp': 4000, 'type': 'removebuff', 'targetID': 2, 'abilityGameID': 10},
            {'timestamp': 4001, 'type': 'removebuff', 'targetID': 2, 'targetInstance': 2, 'abilityGameID': 10}])
        report, _ = a.diagnose(raw, graph)
        mechanic = report['encounters'][0]['mechanics'][0]
        self.assertEqual(mechanic['eventCounts'], {'applybuff': 1, 'removebuff': 1})
        self.assertEqual(mechanic['occurrences'][-1]['eventIndex'], 4)

    def test_source_free_refresh_stacks_and_environment_cleanup_are_retained(self):
        raw, graph = fixture()
        raw['events'].extend([
            {'timestamp': 3000, 'type': 'refreshbuff', 'targetID': 2, 'abilityGameID': 10},
            {'timestamp': 3100, 'type': 'applybuffstack', 'targetID': 2, 'abilityGameID': 10},
            {'timestamp': 3200, 'type': 'applydebuff', 'sourceID': -1, 'targetID': 1, 'abilityGameID': 15},
            {'timestamp': 3300, 'type': 'removedebuff', 'targetID': 1, 'abilityGameID': 15}])
        report, _ = a.diagnose(raw, graph)
        mechanics = {m['spellId']: m for m in report['encounters'][0]['mechanics']}
        self.assertEqual(mechanics[10]['eventCounts'], {'applybuff': 1, 'refreshbuff': 1, 'applybuffstack': 1})
        self.assertEqual(mechanics[15]['eventCounts'], {'applydebuff': 1, 'removedebuff': 1})

    def test_replay_checker_handles_a_recorded_snapshot_reset_before_source_free_refresh(self):
        raw, graph = fixture()
        raw['actors'][2].update(type='Pet', petOwner=2)
        raw['events'].extend([
            {'timestamp': 2600, 'type': 'cast', 'sourceID': 3, 'sourceInstance': 2,
             'resourceActor': 1, 'x': 100, 'y': 200, 'abilityGameID': 11},
            {'timestamp': 3000, 'type': 'combatantinfo', 'sourceID': 2, 'auras': []},
            {'timestamp': 4000, 'type': 'refreshbuff', 'targetID': 2, 'abilityGameID': 10},
            {'timestamp': 4500, 'type': 'destroy', 'targetID': 3, 'targetInstance': 2}])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'replay.json').write_text(json.dumps(raw))
            (root / 'graph.json').write_text(json.dumps(graph))
            audit = subprocess.run([sys.executable, str(Path(a.__file__)), '--replay', str(root / 'replay.json'),
                '--graph', str(root / 'graph.json'), '--output', str(root / 'output')], capture_output=True, text=True)
            self.assertEqual(audit.returncode, 0, audit.stderr)
            checked = subprocess.run(['node', str(Path(a.__file__).with_name('encounter-replay-check.mjs')),
                '--audit', str(root / 'output/report.json'), '--output', str(root / 'checked.json')], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            result = json.loads((root / 'checked.json').read_text())
            self.assertEqual(result['encounters'][0]['status'], 'pass')
            self.assertEqual(result['encounters'][0]['unpositionedLifecycle'][0]['actor'], '3:2')

    def test_legitimate_identical_events_retain_indices_and_counts(self):
        raw, graph = fixture()
        raw['events'].append(dict(raw['events'][0]))
        report, _ = a.diagnose(raw, graph)
        m = report['encounters'][0]['mechanics'][0]
        self.assertEqual(m['eventCounts']['applybuff'], 2)
        self.assertEqual([e['eventIndex'] for e in m['occurrences']], [0, 4])

    def test_missing_catalog_and_ground_context_are_explicit(self):
        raw, graph = fixture()
        graph['visuals']['20']['events'][0]['target'] = 'Area'
        report, cases = a.diagnose(raw, graph)
        self.assertEqual(cases, [])
        mechanics = report['encounters'][0]['mechanics']
        self.assertIn('ground-destination-and-lifetime-unobserved', mechanics[0]['gaps'])
        self.assertIn('spell-definition-unavailable', mechanics[1]['gaps'])

    def test_ruleset_mismatch_and_incomplete_stream_cannot_earn_complete_coverage(self):
        raw, graph = fixture()
        raw['report']['gameVersion'] = 'vanilla'
        with self.assertRaisesRegex(ValueError, 'rulesets'): a.diagnose(raw, graph)
        raw['report']['gameVersion'] = 'sod'
        raw['stream'] = {'ranges': [[0, 500]]}
        with self.assertRaisesRegex(ValueError, 'streamed'): a.diagnose(raw, graph, coverage='complete')
        report, _ = a.diagnose(raw, graph, coverage='partial')
        self.assertEqual(report['encounters'][0]['coverage'], 'unknown')

    def test_map_and_fight_selection_does_not_mix_reports_or_adjacent_encounters(self):
        raw, graph = fixture()
        raw['events'][0]['fight'] = 2
        report, cases = a.diagnose(raw, graph, map_id=2856)
        self.assertEqual([m['spellId'] for m in report['encounters'][0]['mechanics']], [11])
        self.assertEqual(cases, [])
        with self.assertRaisesRegex(ValueError, 'No recorded'): a.diagnose(raw, graph, map_id=531)


if __name__ == '__main__':
    unittest.main()
