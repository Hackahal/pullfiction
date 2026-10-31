#!/usr/bin/env python3
"""Link renderer inventories and domain audits without inventing completion credit.

This reports reference closure, implementation assessments and recorded execution
evidence separately. It never turns conversion, a test count or family membership
into visual approval. Inputs and generated reports are local metadata only.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path

IDENTITY = ('product', 'version', 'buildKey')
RECORD_TABLES = ('spells', 'models', 'characters', 'gearDisplays', 'items', 'textureFiles', 'maps')


def client_identity(document):
    source = document.get('source', document.get('profile', {}))
    if not isinstance(source, dict) or any(source.get(k) in (None, '') for k in IDENTITY):
        raise ValueError('Every input needs an explicit client product/version/buildKey.')
    return {k: source[k] for k in IDENTITY}


def reference_closure(entries):
    rows = {row['id']: row for row in entries}
    if len(rows) != len(entries):
        raise ValueError('Duplicate content IDs in coverage manifest.')
    memo = {}

    def visit(key, stack):
        if key in stack:
            return {'cycle:' + key}
        if key in memo:
            return memo[key]
        row = rows.get(key)
        if row is None:
            return {'missing:' + key}
        issues = set()
        for dep in row.get('dependencies', []):
            issues.update(visit(dep, stack | {key}))
        memo[key] = issues
        return issues

    by_kind = collections.defaultdict(collections.Counter)
    unresolved = []
    for key, row in rows.items():
        issues = visit(key, set())
        by_kind[row['kind']]['total'] += 1
        by_kind[row['kind']]['referencesResolved' if not issues else 'unresolvedReferences'] += 1
        if issues:
            unresolved.append({'id': key, 'issues': sorted(issues)})
    return dict(by_kind), unresolved


def capability_rows(document):
    values = document.get('capabilityLedger', {})
    if isinstance(values, dict):
        return [dict(row, id=key) for key, row in sorted(values.items())]
    if isinstance(values, list):
        return [dict(row) for row in values]
    raise ValueError('Capability ledger must be an object or list.')


def recorded_execution(row, verification_id):
    """Self-declared tested flags alone cannot grant current-build execution credit."""
    evidence = row.get('testEvidence', [])
    return bool(verification_id and any(isinstance(e, dict)
        and e.get('verificationId') == verification_id
        and e.get('result') == 'pass' and type(e.get('testCount')) is int
        and e['testCount'] > 0 for e in evidence))


def build_report(coverage, domains, *, verification_id=None, checks=None):
    identity = client_identity(coverage)
    references, unresolved = reference_closure(coverage.get('entries', []))
    reports = {}
    checks = checks or {}
    if checks:
        if client_identity(checks) != identity or checks.get('verificationId') != verification_id:
            raise ValueError('Check evidence must match the client and verification identity.')
    for name, document in sorted(domains.items()):
        if client_identity(document) != identity:
            raise ValueError('Client identity mismatch for domain ' + name)
        capabilities = capability_rows(document)
        for row in capabilities:
            imported = [check for check in checks.get('checks', [])
                        if name + ':' + row['id'] in check.get('covers', [])]
            if imported:
                row['testEvidence'] = [*row.get('testEvidence', []), *imported]
        required_capabilities = [row for row in capabilities if row.get('required', True)]
        ids = [row['id'] for row in capabilities]
        if len(ids) != len(set(ids)):
            raise ValueError('Duplicate capability IDs for ' + name)
        indexed = {row['id']: row for row in capabilities}
        categories = dict(document.get('categories', {}))
        if 'spellsProcessed' in document:
            categories.setdefault('spell-records', {'expected': len(document.get('spells', {})),
                'processed': document['spellsProcessed'], 'status': 'requirements enumerated; execution separate'})
        for key, category in categories.items():
            expected, processed = category.get('expected'), category.get('processed')
            if expected is not None and processed is not None:
                if type(expected) is not int or type(processed) is not int or not 0 <= processed <= expected:
                    raise ValueError('Invalid category denominator for ' + name + '/' + key)
        record_counts = {}
        for table in RECORD_TABLES:
            records = document.get(table)
            if records is None:
                continue
            records = list(records.values()) if isinstance(records, dict) else records
            if not isinstance(records, list):
                raise ValueError('Invalid record collection ' + table)
            counts = collections.Counter(total=len(records))
            for record in records:
                if record.get('hasUnclassifiedMetadata') or record.get('unclassifiedMetadata'):
                    counts['recordsWithUnclassifiedMetadata'] += 1
                if record.get('conditionalRenderCapabilities'):
                    counts['recordsWithConditionalRequirements'] += 1
                required = record.get('requiredRenderCapabilities', record.get('requiredCapabilities',
                    record.get('renderCapabilities', record.get('requiredModeIds'))))
                if required is None:
                    counts['requirementsUnclassified'] += 1
                    continue
                if not required:
                    counts['noEnumeratedRequirements'] += 1
                    continue
                rows = [indexed.get(key) for key in set(required)
                        if indexed.get(key, {}).get('required', True)]
                if not rows:
                    counts['noRequiredRenderingModes'] += 1
                    continue
                if all(row is not None and row.get('mapped') is True for row in rows):
                    counts['requiredModesMapped'] += 1
                # Bounded/common/partial are kept explicit; they are not full support.
                # A shared mode can be partial overall while a particular record uses
                # a supported subset. Keep that explicit record assessment scoped here.
                support = record.get('capabilitySupport', {})
                required_ids = [key for key in set(required) if indexed.get(key, {}).get('required', True)]
                if all(indexed.get(key) is not None and
                       support.get(key, indexed[key].get('implementation')) == 'implemented' for key in required_ids):
                    counts['requiredModesImplemented'] += 1
                if all(row is not None and recorded_execution(row, verification_id) for row in rows):
                    counts['requiredModesWithRecordedCurrentExecution'] += 1
            record_counts[table] = dict(counts)
        reports[name] = {
            'categoryAudits': categories,
            'recordRequirements': record_counts,
            'capabilities': {
                'required': len(required_capabilities),
                'optional': len(capabilities) - len(required_capabilities),
                'mapped': sum(row.get('mapped') is True for row in required_capabilities),
                'byImplementation': dict(collections.Counter(row.get('implementation', 'unknown') for row in required_capabilities)),
                'withRecordedCurrentExecution': sum(recorded_execution(row, verification_id) for row in required_capabilities),
            },
            'capabilityLedger': capabilities,
            'sourceProofBoundary': document.get('proofBoundary', document.get('notes')),
        }
    return {'schema': 1, 'source': identity, 'verificationId': verification_id,
        'inventoryReferences': references, 'unresolvedReferences': unresolved, 'domains': reports,
        'visualApproval': 'not inferred',
        'proofBoundary': ('Reference resolution is not complete semantic mapping. Implementation counts are explicit '
            'domain assessments. Required-mode counts do not certify resource availability, every lifecycle or every '
            'consumer. Recorded execution requires nonzero matching-build evidence; it is not visual approval.')}


def markdown(report):
    out = ['# Renderer automated readiness', '',
           'Client: ' + ' / '.join(str(report['source'][key]) for key in IDENTITY), '',
           report['proofBoundary'], '', '## Source inventory references', '',
           '| Category | Records | Reference closure resolved | Unresolved |', '|---|---:|---:|---:|']
    for kind, row in sorted(report['inventoryReferences'].items()):
        out.append(f"| {kind} | {row['total']} | {row.get('referencesResolved', 0)} | {row.get('unresolvedReferences', 0)} |")
    for domain, data in report['domains'].items():
        out += ['', '## ' + domain, '', '| Audit | Expected | Processed | Result |', '|---|---:|---:|---|']
        for kind, row in sorted(data['categoryAudits'].items()):
            result = row.get('status', row.get('summary', 'not classified'))
            if not isinstance(result, str):
                result = ', '.join(f'{key}: {value}' for key, value in sorted(result.items()))
            out.append(f"| {kind} | {row.get('expected', 'unknown')} | {row.get('processed', 'unknown')} | {result} |")
        caps = data['capabilities']
        out += ['', f"Required capabilities: {caps['required']}; mapped: {caps['mapped']}; "
                f"with recorded current execution: {caps['withRecordedCurrentExecution']}.", '',
                'Implementation assessments: ' + ', '.join(f'{key}: {value}' for key, value in sorted(caps['byImplementation'].items())), '']
        if data['recordRequirements']:
            out += ['These counts cover each record\'s declared required modes. Unknown metadata, conditional '
                    'context, unavailable assets and untested consumers remain separate; implemented modes '
                    'do not certify the whole record\'s appearance.', '',
                    '| Records | Total | Required modes mapped | Required modes implemented | Unknown metadata | Conditional requirements | No enumerated requirements |',
                    '|---|---:|---:|---:|---:|---:|---:|']
            for table, row in sorted(data['recordRequirements'].items()):
                out.append(f"| {table} | {row['total']} | {row.get('requiredModesMapped', 0)} | "
                           f"{row.get('requiredModesImplemented', 0)} | {row.get('recordsWithUnclassifiedMetadata', 0)} | "
                           f"{row.get('recordsWithConditionalRequirements', 0)} | {row.get('noEnumeratedRequirements', 0)} |")
    out += ['', 'Visual approval belongs to the separate inspection record and is never inferred here.', '']
    return '\n'.join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--coverage', type=Path, required=True)
    parser.add_argument('--domain', action='append', default=[], metavar='NAME=JSON_PATH')
    parser.add_argument('--verification-id')
    parser.add_argument('--checks', type=Path, help='Explicit capability check evidence for this verification identity')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        paths = {}
        for spec in args.domain:
            name, path = spec.split('=', 1)
            if not name or name in paths or name in ('coverage', 'checks'):
                raise ValueError('Domain names must be nonempty and unique.')
            paths[name] = Path(path)
        load = lambda path: json.loads(path.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON: ' + value)))
        report = build_report(load(args.coverage), {key: load(path) for key, path in paths.items()},
                              verification_id=args.verification_id, checks=load(args.checks) if args.checks else None)
        report['inputs'] = {key: {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                            for key, path in {'coverage': args.coverage, **paths}.items()}
        if args.checks:
            report['inputs']['checks'] = {'path': str(args.checks), 'sha256': hashlib.sha256(args.checks.read_bytes()).hexdigest()}
        if args.output.exists():
            raise ValueError('Select a fresh output directory; existing evidence is not overwritten.')
        args.output.mkdir(parents=True)
        (args.output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
        (args.output / 'report.md').write_text(markdown(report))
        print(json.dumps({'domains': list(report['domains']), 'unresolvedReferences': len(report['unresolvedReferences']),
                          'visualApproval': report['visualApproval'], 'output': str(args.output)}))
    except (ValueError, OSError, TypeError, KeyError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
