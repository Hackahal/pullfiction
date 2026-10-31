#!/usr/bin/env python3
"""Synthetic renderer-readiness contracts; no client assets or GPU required."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('readiness', Path(__file__).with_name('renderer-readiness.py'))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)
SOURCE = {'product': 'test', 'version': '1', 'buildKey': 'abc'}


def inputs():
    coverage = {'profile': SOURCE, 'entries': [
        {'id': 'spell:1', 'kind': 'spell', 'dependencies': ['asset:2']},
        {'id': 'asset:2', 'kind': 'asset', 'dependencies': []}]}
    domain = {'source': SOURCE, 'spells': {'1': {'renderCapabilities': ['mode:1']}},
              'capabilityLedger': {'mode:1': {'mapped': True, 'implementation': 'implemented',
                                             'automaticallyTested': True}}}
    return coverage, domain


class ReadinessTests(unittest.TestCase):
    def test_declared_support_does_not_infer_execution_or_visual_approval(self):
        coverage, domain = inputs()
        report = readiness.build_report(coverage, {'spell': domain}, verification_id='build1')
        counts = report['domains']['spell']['recordRequirements']['spells']
        self.assertEqual(counts['requiredModesImplemented'], 1)
        self.assertNotIn('requiredModesWithRecordedCurrentExecution', counts)
        self.assertEqual(report['visualApproval'], 'not inferred')

    def test_only_nonzero_matching_build_evidence_earns_execution_credit(self):
        coverage, domain = inputs()
        cap = domain['capabilityLedger']['mode:1']
        cap['testEvidence'] = [{'verificationId': 'build1', 'result': 'pass', 'testCount': 2}]
        report = readiness.build_report(coverage, {'spell': domain}, verification_id='build1')
        self.assertEqual(report['domains']['spell']['capabilities']['withRecordedCurrentExecution'], 1)
        cap['testEvidence'][0]['testCount'] = 0
        self.assertFalse(readiness.recorded_execution(cap, 'build1'))
        cap['testEvidence'][0]['testCount'] = 2
        self.assertFalse(readiness.recorded_execution(cap, 'different-build'))

    def test_transitive_missing_references_and_cycles_remain_unresolved(self):
        coverage, _ = inputs()
        coverage['entries'][1]['dependencies'] = ['missing:3']
        counts, unresolved = readiness.reference_closure(coverage['entries'])
        self.assertEqual(counts['spell']['unresolvedReferences'], 1)
        self.assertEqual(len(unresolved), 2)
        coverage['entries'][1]['dependencies'] = ['spell:1']
        self.assertEqual(len(readiness.reference_closure(coverage['entries'])[1]), 2)

    def test_source_mismatch_and_missing_identity_fail_closed(self):
        coverage, domain = inputs()
        domain['source'] = dict(SOURCE, buildKey='different')
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            readiness.build_report(coverage, {'spell': domain})
        domain['source'] = {}
        with self.assertRaisesRegex(ValueError, 'explicit client'):
            readiness.build_report(coverage, {'spell': domain})

    def test_unknown_requirements_bounded_support_and_empty_lists_are_not_complete(self):
        coverage, domain = inputs()
        domain['spells'] = {'1': {'renderCapabilities': ['unknown']}, '2': {'renderCapabilities': []}, '3': {}}
        report = readiness.build_report(coverage, {'spell': domain})
        counts = report['domains']['spell']['recordRequirements']['spells']
        self.assertEqual(counts['total'], 3)
        self.assertNotIn('requiredModesImplemented', counts)
        domain['spells'] = {'1': {'renderCapabilities': ['mode:1']}}
        domain['capabilityLedger']['mode:1']['implementation'] = 'implemented-bounded'
        self.assertNotIn('requiredModesImplemented', readiness.build_report(coverage, {'spell': domain})['domains']['spell']['recordRequirements']['spells'])

    def test_invalid_denominators_and_duplicate_ids_are_rejected(self):
        coverage, domain = inputs()
        domain['categories'] = {'models': {'expected': 1, 'processed': 2}}
        with self.assertRaisesRegex(ValueError, 'denominator'):
            readiness.build_report(coverage, {'spell': domain})
        coverage['entries'].append(copy.deepcopy(coverage['entries'][0]))
        with self.assertRaisesRegex(ValueError, 'Duplicate content'):
            readiness.build_report(coverage, {})

    def test_optional_audio_metadata_does_not_block_required_rendering_modes(self):
        coverage, domain = inputs()
        domain['capabilityLedger']['sound'] = {'required': False, 'implementation': 'unsupported'}
        domain['spells']['1']['renderCapabilities'].append('sound')
        report = readiness.build_report(coverage, {'spell': domain})['domains']['spell']
        self.assertEqual(report['capabilities']['required'], 1)
        self.assertEqual(report['capabilities']['optional'], 1)
        self.assertEqual(report['recordRequirements']['spells']['requiredModesImplemented'], 1)

    def test_imported_checks_are_explicitly_scoped_to_domain_and_build(self):
        coverage, domain = inputs()
        check = {'verificationId': 'build1', 'result': 'pass', 'testCount': 3,
                 'covers': ['spell:mode:1']}
        checks = {'source': SOURCE, 'verificationId': 'build1', 'checks': [check]}
        report = readiness.build_report(coverage, {'spell': domain, 'other': domain}, verification_id='build1', checks=checks)
        self.assertEqual(report['domains']['spell']['capabilities']['withRecordedCurrentExecution'], 1)
        self.assertEqual(report['domains']['other']['capabilities']['withRecordedCurrentExecution'], 0)
        with self.assertRaisesRegex(ValueError, 'verification identity'):
            readiness.build_report(coverage, {'spell': domain}, verification_id='build2', checks=checks)

    def test_record_specific_supported_subset_does_not_approve_other_records(self):
        coverage, domain = inputs()
        domain['capabilityLedger']['mode:1']['implementation'] = 'partial'
        domain['spells'] = {'1': {'requiredRenderCapabilities': ['mode:1'],
            'capabilitySupport': {'mode:1': 'implemented'}, 'hasUnclassifiedMetadata': True},
            '2': {'requiredRenderCapabilities': ['mode:1']}}
        counts = readiness.build_report(coverage, {'spell': domain})['domains']['spell']['recordRequirements']['spells']
        self.assertEqual(counts['requiredModesImplemented'], 1)
        self.assertEqual(counts['recordsWithUnclassifiedMetadata'], 1)


if __name__ == '__main__':
    unittest.main()
