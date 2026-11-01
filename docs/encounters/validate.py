#!/usr/bin/env python3
"""Validate this research library without a network request or third-party package.

The schema evaluator supports every keyword used by the two shipped schemas.
Unknown schema keywords fail closed rather than receiving partial validation.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
KEYWORDS = {'$schema', 'title', 'description', 'type', 'const', 'enum', 'required',
            'properties', 'additionalProperties', 'items', 'minItems', 'minLength',
            'minimum', 'pattern', 'uniqueItems', 'anyOf'}
FORBIDDEN_KEYS = {'masterData', 'friendlyPlayers', 'combatEvents', 'observedEvidence',
                  'confirmedGaps', 'checks', 'headers', 'variables', 'query',
                  'accessToken', 'refreshToken', 'clientSecret', 'password'}
LEAKS = [r'/(?:Users|home)/[A-Za-z0-9_.-]+/', r'/private/(?:var|tmp)/',
         r'/tmp/[A-Za-z0-9_.-]+', r'file:/[/]', r'localhost:\d+',
         r'127\.0\.0\.1:\d+', r'\.' + r'agent/', r'gh[pousr]_[A-Za-z0-9]{20,}',
         r'\bsk-[A-Za-z0-9]{20,}', r'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.',
         r'(?i)(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)'
         r'\s*[:=]\s*[\"\x27]?(?:Bearer\s+)?[A-Za-z0-9_+/.=-]{20,}']

def require(condition, message):
    if not condition:
        raise ValueError(message)

def read(path):
    return json.loads(path.read_text(encoding="utf-8"))

def types(value, name):
    return {'object': isinstance(value, dict), 'array': isinstance(value, list),
            'string': isinstance(value, str), 'integer': type(value) is int,
            'number': type(value) in (int, float), 'boolean': type(value) is bool,
            'null': value is None}[name]

def schema_profile(schema):
    require(set(schema) <= KEYWORDS, f'Unsupported schema keyword: {set(schema) - KEYWORDS}')
    for child in schema.get('properties', {}).values():
        schema_profile(child)
    if isinstance(schema.get('items'), dict):
        schema_profile(schema['items'])
    for child in schema.get('anyOf', []):
        schema_profile(child)

def validate(value, schema, at):
    if 'type' in schema:
        allowed = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        require(any(types(value, t) for t in allowed), f'{at}: wrong type')
    if 'const' in schema:
        require(json.dumps(value, sort_keys=True) == json.dumps(schema['const'], sort_keys=True), f'{at}: wrong constant')
    if 'enum' in schema:
        require(value in schema['enum'], f'{at}: unexpected value')
    if 'anyOf' in schema:
        succeeded = False
        for choice in schema['anyOf']:
            try:
                validate(value, choice, at)
                succeeded = True
            except ValueError:
                pass
        require(succeeded, f'{at}: no matching alternative')
    if isinstance(value, dict):
        require(set(schema.get('required', [])) <= set(value), f'{at}: missing required key')
        props = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            require(set(value) <= set(props), f'{at}: unexpected keys {set(value) - set(props)}')
        for key, item in value.items():
            if key in props:
                validate(item, props[key], f'{at}.{key}')
    if isinstance(value, list):
        require(len(value) >= schema.get('minItems', 0), f'{at}: too few items')
        if schema.get('uniqueItems'):
            encoded = [json.dumps(v, sort_keys=True) for v in value]
            require(len(encoded) == len(set(encoded)), f'{at}: duplicate array item')
        if 'items' in schema:
            for i, item in enumerate(value):
                validate(item, schema['items'], f'{at}[{i}]')
    if isinstance(value, str):
        require(len(value) >= schema.get('minLength', 0), f'{at}: empty text')
        if 'pattern' in schema:
            require(re.search(schema['pattern'], value) is not None, f'{at}: pattern mismatch')
    if type(value) in (int, float) and 'minimum' in schema:
        require(value >= schema['minimum'], f'{at}: number below minimum')

def inspect_payload(value, at):
    if isinstance(value, dict):
        require(not (set(value) & FORBIDDEN_KEYS), f'{at}: raw data or secret field')
        for key, item in value.items():
            if key == 'verification':
                require(item == 'unverified', f'{at}: verification credit is prohibited')
            inspect_payload(item, f'{at}.{key}')
    elif isinstance(value, list):
        for i, item in enumerate(value):
            inspect_payload(item, f'{at}[{i}]')


def validate_library(ruleset, expected_files, expected_units):
    schema = read(ROOT / 'encounter.schema.json')
    index_schema = read(ROOT / 'index.schema.json')
    schema_profile(schema)
    schema_profile(index_schema)
    index = read(ROOT / ('index.json' if ruleset == 'sod' else 'vanilla/index.json'))
    validate(index, index_schema, 'index')
    inspect_payload(index, 'index')
    require(index['ruleset'] == ruleset, 'Index ruleset mismatch')
    files = sorted((ROOT / ruleset).glob(f'{ruleset}-*.json'))
    require(len(files) == len(index['entries']) == expected_files, f'Expected {expected_files} canonical {ruleset} files')
    require(len(index['units']) == expected_units, f'Expected {expected_units} boss research units')
    require(len({u['unitId'] for u in index['units']}) == expected_units, 'Duplicate boss research unit')
    documents = {}
    provider_pairs, check_ids = set(), set()
    contracts = candidates = bibliography_only = original_retained = metadata_mapped = 0
    for path in files:
        doc = read(path)
        validate(doc, schema, path.name)
        require(doc['ruleset'] == ruleset and doc['unitId'].startswith(ruleset + '-'), f'{path.name}: cross-ruleset document')
        inspect_payload(doc, path.name)
        require(path.stem == doc['unitId'], f'{path.name}: unit/file mismatch')
        documents[doc['unitId']] = doc
        sources = [s['id'] for s in doc['sources']]
        require(len(sources) == len(set(sources)), f'{path.name}: duplicate source ID')
        require(any(s.get('url', '').startswith(('https://', 'http://')) for s in doc['sources']), f'{path.name}: no source URLs')
        mids = [m['id'] for m in doc['expectedMechanics']]
        require(len(mids) == len(set(mids)), f'{path.name}: duplicate mechanic ID')
        associated = {sid for m in doc['expectedMechanics'] for sid in m['spellIds']}
        require(not associated.intersection(doc['clientCandidateSpellIds']), f'{path.name}: encounter candidate is also associated')
        variant_names, variant_ids, variant_npcs = set(), set(), set()
        for variant in doc.get('variants', []):
            require(variant['name'] not in variant_names, f'{path.name}: duplicate variant')
            variant_names.add(variant['name'])
            if doc['unitId'].endswith('-zg-edge-of-madness'):
                npc_field = 'baselineNpcId' if ruleset == 'sod' else 'npcId'
                require(npc_field in variant and type(variant[npc_field]) is int and
                        variant[npc_field] > 0 and variant[npc_field] not in variant_npcs,
                        f'{path.name}: missing or repeated EoM NPC identity')
                variant_npcs.add(variant[npc_field])
                if ruleset == 'vanilla':
                    require('id' in variant and 'contracts' in variant, f'{path.name}: missing EoM selection fields')
            if 'id' in variant:
                require(isinstance(variant['id'], str) and variant['id'] and variant['id'] not in variant_ids, f'{path.name}: invalid variant identity')
                variant_ids.add(variant['id'])
            for key in ['npcId', 'baselineNpcId']:
                if key in variant:
                    require(type(variant[key]) is int and variant[key] > 0, f'{path.name}: invalid variant NPC identity')
            if 'contracts' in variant:
                refs = variant['contracts']
                require(isinstance(refs, list) and refs and all(isinstance(r, str) for r in refs) and
                        len(refs) == len(set(refs)) and set(refs) <= set(mids), f'{path.name}: invalid variant contract reference')
        original_retained += doc['researchEvidence']['retainedCombatEventsAvailable']
        pm = doc['providerMapping']
        if doc['encounterId'] is None:
            require(pm['status'] == 'unresolved', f'{path.name}: null identity marked mapped')
        else:
            require(pm['status'] != 'unresolved', f'{path.name}: mapped identity marked unresolved')
            pair = (doc['ruleset'], doc['encounterId'])
            require(pair not in provider_pairs, f'{path.name}: duplicate provider identity')
            provider_pairs.add(pair)
        if pm['status'] == 'mapped-from-report-metadata':
            metadata_mapped += 1
            md = pm['metadataReceipt']
            require(pm['sourceRef'] in sources, f'{path.name}: missing metadata source')
            require(md['kind'] == 'immutable-metadata-identity-receipt', f'{path.name}: bad receipt kind')
            require(md['selectedMapId'] == doc['mapId'], f'{path.name}: metadata map differs')
            require(type(md['reportRevision']) is int and md['reportRevision'] > 0, f'{path.name}: missing revision')
            require(re.fullmatch(r'[A-Za-z0-9]{16}', md['reportCode']), f'{path.name}: malformed report code')
            require(md['selectedFightIds'] and md['matchedNpcTemplateIds'], f'{path.name}: no selected identity match')
            require(any('Discovery' in p for p in md['discoveryPartitions']), f'{path.name}: no Discovery provenance')
            for key in ['reportResponseSha256', 'provenanceResponseSha256']:
                require(re.fullmatch(r'[a-f0-9]{64}', md[key]), f'{path.name}: malformed metadata hash')
            require(doc['sourceContextUpdate']['mechanicsReaudited'] is False, f'{path.name}: unexpected acceptance')
        for m in doc['expectedMechanics']:
            contracts += 1
            require(set(m['sourceRefs']) <= set(sources), f'{path.name}: dangling source reference')
            require(set(m.get('bibliographyRefs', [])) <= set(sources), f'{path.name}: dangling bibliography')
            if not m['sourceRefs']:
                bibliography_only += 1
                require(m.get('bibliographyRefs') and m.get('attributionLimit'), f'{path.name}: unattributed mechanic not qualified')
            require(not (set(m['spellIds']) & set(m['clientCandidateSpellIds'])), f'{path.name}: candidate promoted to associated ID')
            require(not re.search(r'see\s+spec\.md', m['state'], re.I), f'{path.name}: external placeholder remains')
            require(m['acceptanceCheck'] not in check_ids, f'{path.name}: duplicate named acceptance check')
            check_ids.add(m['acceptanceCheck'])
            candidates += len(m['clientCandidateSpellIds'])
    require(set(documents) == {e['unitId'] for e in index['entries']}, 'Index/file mismatch')
    for entry in index['entries']:
        doc = documents[entry['unitId']]
        require(entry['path'] == ruleset + '/' + entry['unitId'] + '.json', 'Unexpected index path')
        require(entry['encounterId'] == doc['encounterId'], 'Index provider ID mismatch')
        require(entry['mechanicCount'] == len(doc['expectedMechanics']), 'Index mechanic count mismatch')
        for field in ['boss', 'raid', 'rawEncounterId', 'bossUnits']:
            require(entry[field] == doc[field], f'Index {field} mismatch')
        require(entry['retainedCombatEventsAvailable'] == doc['researchEvidence']['retainedCombatEventsAvailable'], 'Index evidence availability mismatch')
        require(entry.get('providerMappingStatus') == doc['providerMapping']['status'], 'Index mapping status mismatch')
        require(entry.get('variants', []) == [v['name'] for v in doc.get('variants', [])], 'Index variant metadata mismatch')
        require(entry.get('group') == doc.get('group'), 'Index group metadata mismatch')
        if doc['providerMapping']['status'] == 'mapped-from-report-metadata':
            require(entry.get('metadataReportCode') == doc['providerMapping']['metadataReceipt']['reportCode'], 'Index metadata report mismatch')
            require(entry.get('eventAvailability') == doc['sourceContextUpdate']['eventAvailability'], 'Index event availability mismatch')
        else:
            require('metadataReportCode' not in entry and 'eventAvailability' not in entry, 'Unexpected index metadata evidence')
    for unit in index['units']:
        doc = documents[unit['canonicalUnitId']]
        require(unit['unitId'] in doc['bossUnits'], 'Incorrect unit grouping')
        require(unit['encounterFile'] == ruleset + '/' + doc['unitId'] + '.json', 'Unit link mismatch')
        require(unit['unitId'].startswith(ruleset + '-'), 'Cross-ruleset indexed member')
    for doc in documents.values():
        members = {u['unitId'] for u in index['units'] if u['canonicalUnitId'] == doc['unitId']}
        require(members == set(doc['bossUnits']), 'Document/index memberships differ')
        require(all(u.startswith(ruleset + '-') for u in doc['bossUnits']), 'Cross-ruleset document member')
    if ruleset == 'sod':
        pair = documents['sod-bwl-ebonroc-and-flamegor']
        require(set(pair['bossUnits']) == {'sod-bwl-ebonroc', 'sod-bwl-flamegor'}, 'Paired drake units lost')
        require('sod-bwl-ebonroc' not in documents and 'sod-bwl-flamegor' not in documents, 'Duplicate paired publication')
        eom = documents['sod-zg-edge-of-madness']
        require({v['name'] for v in eom['variants']} == {"Gri'lek", "Hazza'rah", 'Renataki', 'Wushoolay'}, 'EoM variant lost')
        require(eom['encounterId'] is None, 'Unselected EoM variant was mapped')
    else:
        eom = documents['vanilla-zg-edge-of-madness']
        require({v['name'] for v in eom['variants']} == {"Gri'lek", "Hazza'rah", 'Renataki', 'Wushoolay'}, 'Vanilla EoM variant lost')
        require(eom['encounterId'] is None, 'Unobserved Vanilla EoM variant was mapped')
    counts = index['counts']
    require(counts == {'encounterFiles': expected_files, 'bossResearchUnits': expected_units,
                       'retainedEvidenceEncounters': original_retained,
                       'sourceOnlyEncounters': expected_files - original_retained,
                       'providerMappedEncounters': len(provider_pairs),
                       'providerUnresolvedEncounters': expected_files - len(provider_pairs),
                       'metadataOnlyMappings': metadata_mapped}, 'Index count mismatch')
    for path in ROOT.rglob('*'):
        if not path.is_file():
            continue
        require(path.suffix in {'.json', '.md', '.py'}, f'Unexpected asset/source file: {path.name}')
        body = path.read_text(encoding="utf-8")
        require('\u200b' not in body, f'{path.name}: invisible zero-width space')
        for pattern in LEAKS:
            require(re.search(pattern, body) is None, f'{path.name}: local path, service or credential pattern')
    print(json.dumps({'ruleset': ruleset, 'encounters': len(documents), 'bossResearchUnits': expected_units,
                      'mechanics': contracts, 'providerMapped': len(provider_pairs),
                      'providerUnresolved': expected_files - len(provider_pairs),
                      'metadataOnlyMappings': metadata_mapped,
                      'retainedEvidenceAvailable': original_retained,
                      'bibliographyOnlyMechanics': bibliography_only,
                      'explicitClientCandidateReferences': candidates,
                      'schemaAndReferences': 'valid', 'verification': 'unverified'}, indent=2))

def main():
    validate_library('sod', 88, 89)
    validate_library('vanilla', 59, 59)


if __name__ == '__main__':
    main()
