#!/usr/bin/env python3
"""Join recorded encounter mechanics to the production spell audit and workbench.

All outputs are local evidence. A generated case never grants runtime or visual
credit. Report/events/details accept the retained WCL cache format; --replay
accepts a portable Pull Fiction replay instead.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def spell_id(event):
    return event.get('abilityGameID', (event.get('ability') or {}).get('guid', 0))


def actor_key(event, side):
    value = event.get(side + 'ID')
    return f'{value}:{event.get(side + "Instance") or 1}' if value is not None else None


def npc(actor, actors=None):
    if actor.get('type') not in ('NPC', 'Pet') or actor.get('id', 0) <= 0:
        return False
    seen = set()
    while actor.get('petOwner'):
        if actor['id'] in seen or not actors:
            return False
        seen.add(actor['id'])
        actor = actors.get(actor['petOwner'], {})
        if not actor:
            return False
    return actor.get('type') == 'NPC' and actor.get('id', 0) > 0


def expectation_index(specifications):
    """Keep research contracts separate from observed spells and execution credit."""
    result = {}
    for spec in specifications:
        ruleset, encounter = spec.get('ruleset'), spec.get('encounterId')
        if ruleset not in ('sod', 'vanilla') or type(encounter) is not int or encounter <= 0:
            raise ValueError('Expected mechanics need an explicit ruleset and positive encounterId')
        if (ruleset, encounter) in result:
            raise ValueError(f'Duplicate encounter specification: {ruleset}/{encounter}')
        sources, mechanics = spec.get('sources'), spec.get('expectedMechanics')
        if not isinstance(sources, list) or not sources or not any(
                isinstance(s, dict) and str(s.get('url', '')).startswith(('https://', 'http://')) for s in sources):
            raise ValueError('Expected mechanics need source URLs')
        if not isinstance(mechanics, list) or not mechanics:
            raise ValueError('Expected mechanics must be a nonempty list')
        checks, contracts = set(), []
        for original in mechanics:
            m = {**original, 'mechanic': original.get('mechanic', original.get('name'))} if isinstance(original, dict) else original
            if not isinstance(m, dict) or not all(isinstance(m.get(k), str) and m[k].strip() for k in
                    ('mechanic', 'trigger', 'state', 'lifecycle', 'placement', 'animation', 'acceptanceCheck')):
                raise ValueError('Each expected mechanic needs trigger, state, lifecycle, placement, animation and acceptanceCheck')
            if m['acceptanceCheck'] in checks:
                raise ValueError('Expected mechanic acceptanceCheck identifiers must be unique within an encounter')
            if not isinstance(m.get('spellIds', []), list) or any(type(s) is not int or s <= 1 for s in m.get('spellIds', [])):
                raise ValueError('Expected mechanic spellIds must be positive client spell IDs')
            checks.add(m['acceptanceCheck'])
            contracts.append({**m, 'verification': 'unverified',
                'sourceAttribution': 'mechanic references supplied' if m.get('sources') or m.get('sourceRefs') else
                                     'specification bibliography only; mechanic-level attribution unresolved'})
        result[ruleset, encounter] = {'unitId': spec.get('unitId'), 'sources': sources,
            'mechanics': contracts,
            'proofBoundary': 'Research defines acceptance criteria; it does not prove observed, executed or visually matched behavior.'}
    return result


def recorded_bounds(raw, fights):
    edges = [e for e in raw['events'] if e.get('type') in ('encounterstart', 'encounterend')]
    if not edges or not raw.get('report', {}).get('fights'):
        return fights
    result = subprocess.run(['node', str(ROOT / 'scripts/resolve-encounter-bounds.mjs')],
        input=json.dumps({'report': {**raw['report'], 'gameVersion': raw['gameVersion']},
                         'fights': fights, 'boundaryEvents': edges}),
        text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def diagnose(raw, graph, *, map_id=None, coverage='unknown', expectations=()):
    if raw.get('gameVersion') not in ('sod', 'vanilla'):
        raise ValueError('An explicit supported replay gameVersion is required')
    if raw.get('report', {}).get('gameVersion', raw['gameVersion']) != raw['gameVersion']:
        raise ValueError('Replay and report rulesets disagree')
    if not graph.get('source', {}).get('buildKey'):
        raise ValueError('A client graph with build identity is required')
    selected_fight = raw.get('fight')
    chapters = selected_fight.get('chapters') if isinstance(selected_fight, dict) else None
    fights = next((rows for rows in (raw.get('fights'), chapters)
                   if isinstance(rows, list) and rows), None)
    if fights is None:
        fights = [selected_fight] if selected_fight is not None else raw.get('report', {}).get('fights', [])
    fights = [f for f in fights if f.get('encounterID') and
              (map_id is None or f.get('gameZone', {}).get('id') == map_id)]
    if not fights:
        raise ValueError('No recorded boss encounters match the selection')
    fights = recorded_bounds(raw, fights)
    expected = expectation_index(expectations)
    actors = {a['id']: a for a in raw['actors']}
    names = {a['gameID']: a.get('name') for a in raw.get('abilities', [])}
    events = list(enumerate(raw['events']))
    ids = {spell_id(e) for _, e in events if isinstance(spell_id(e), int) and spell_id(e) > 1}
    ids.update(s for spec in expected.values() for m in spec['mechanics'] for s in m.get('spellIds', []))
    audit_graph = dict(graph, spells={str(i): graph['spells'][str(i)] for i in ids if str(i) in graph['spells']})
    audit = module('encounter_spell_audit', 'renderer-spell-audit.py').audit(audit_graph)
    encounters, cases = [], []
    for fight in fights:
        start, end = fight['startTime'], fight['endTime']
        if end <= start:
            raise ValueError('Invalid encounter boundaries')
        rows = [(i, e) for i, e in events if start <= e.get('timestamp', -1) <= end and
                (fight.get('recordedPrelude') or e.get('fight') is None or str(e['fight']) == str(fight['id']))]
        specification = expected.get((raw['gameVersion'], fight['encounterID']))
        declared_ids = {s for m in (specification or {}).get('mechanics', []) for s in m.get('spellIds', [])}
        npc_auras = {(actor_key(e, 'target'), spell_id(e)) for _, e in rows
                    if (npc(actors.get(e.get('sourceID'), {}), actors) or e.get('sourceID') == -1) and
                    e.get('type', '').startswith(('applybuff', 'applydebuff', 'refreshbuff', 'refreshdebuff'))}
        observed, entities, special = defaultdict(list), {}, Counter()
        for index, e in rows:
            source, target = actors.get(e.get('sourceID'), {}), actors.get(e.get('targetID'), {})
            if e.get('sourceID') == -1 and names.get(spell_id(e)) == 'Falling':
                special[f'provider-environmental:{spell_id(e)}:Falling'] += 1
                continue
            if e.get('type') == 'combatantinfo':
                for aura in e.get('auras') or []:
                    sid = aura.get('ability', aura.get('abilityGameID'))
                    if isinstance(sid, dict):
                        sid = sid.get('guid')
                    if sid in declared_ids:
                        observed[sid].append({'eventIndex': index, 'atMs': e['timestamp'] - start,
                            'type': 'combatantinfo-aura', 'source': None, 'target': actor_key(e, 'source'),
                            'inferred': False, 'tick': False,
                            'observationBasis': 'snapshot only; caster and application time unknown'})
            # Include adds, NPC auras on players, and environment effects. Do not
            # count player attacks on a boss as additional encounter mechanics.
            mechanic = npc(source, actors) or (e.get('sourceID') == -1 and
                         (e.get('type') in ('damage', 'summon', 'create') or e.get('type', '').startswith(
                             ('applybuff', 'applydebuff', 'refreshbuff', 'refreshdebuff', 'removebuff', 'removedebuff'))))
            # Removal events can omit the original caster or name a dispeller.
            # Associate them with the observed NPC aura on this exact instance.
            mechanic |= (e.get('type', '').startswith(('removebuff', 'removedebuff', 'refreshbuff',
                          'refreshdebuff', 'applybuffstack', 'applydebuffstack')) and
                          (actor_key(e, 'target'), spell_id(e)) in npc_auras)
            # Research can identify important player-sourced encounter spells.
            # This explicit mapping does not include ordinary player attacks.
            mechanic |= spell_id(e) in declared_ids
            for side, actor in [('source', source), ('target', target)]:
                if not npc(actor, actors):
                    continue
                key = actor_key(e, side)
                entity = entities.setdefault(key, {'key': key, 'npcId': actor.get('gameID'),
                    'name': actor.get('name'), 'firstObservedMs': e['timestamp'] - start,
                    'lastObservedMs': e['timestamp'] - start, 'positionSamples': 0,
                    'lifecycle': []})
                entity['lastObservedMs'] = max(entity['lastObservedMs'], e['timestamp'] - start)
                entity['firstObservedMs'] = min(entity['firstObservedMs'], e['timestamp'] - start)
                resource = e.get(side + 'Resources') or (e if e.get('resourceActor') == (1 if side == 'source' else 2) else {})
                if resource.get('x') is not None and resource.get('y') is not None and (resource['x'] or resource['y']):
                    entity['positionSamples'] += 1
                if side == 'target' and e.get('type') in ('summon', 'create', 'destroy', 'death', 'resurrect'):
                    entity['lifecycle'].append({'type': e['type'], 'atMs': e['timestamp'] - start,
                                                'eventIndex': index})
            if not mechanic:
                continue
            sid = spell_id(e)
            if not isinstance(sid, int) or sid <= 1:
                special[str(sid)] += 1
                continue
            observed[sid].append({'eventIndex': index, 'atMs': e['timestamp'] - start,
                'type': e['type'], 'source': actor_key(e, 'source'), 'target': actor_key(e, 'target'),
                'inferred': bool(e.get('fake')), 'tick': bool(e.get('tick'))})
        mechanics = []
        for sid, occurrences in sorted(observed.items()):
            spell = graph['spells'].get(str(sid))
            capabilities = audit['spells'].get(str(sid), {})
            routes = [dict(e, visualId=v['id']) for v in (spell or {}).get('visuals', [])
                      for e in graph.get('visuals', {}).get(str(v['id']), {}).get('events', [])]
            counts = Counter(e['type'] for e in occurrences)
            gaps = []
            if spell is None:
                gaps.append('spell-definition-unavailable')
            elif not any(v.get('id', 0) > 0 for v in spell.get('visuals', [])):
                gaps.append('no-declared-visual; inspect actor or scripted mechanic separately')
            support = capabilities.get('capabilitySupport', {})
            gaps.extend(f'{c}={support.get(c, "unknown")}' for c in
                        capabilities.get('requiredRenderCapabilities', []) if support.get(c) != 'implemented')
            if any(e.get('target') == 'Area' for e in routes):
                gaps.append('ground-destination-and-lifetime-unobserved')
            if any(e['start'] == 'Aura Start' and e['target'] == 'Caster' for e in routes):
                gaps.append('caster-aura-route-supported-only-for-recorded-self-application')
            if counts['summon'] or counts['create']:
                gaps.append('summoned-entity-placement-and-appearance-need-replay-check')
            if any(e['inferred'] for e in occurrences):
                gaps.append('contains-WCL-inferred-events')
            # Only native stages for which this pull supplies a corresponding
            # observation. Isolated fixtures are diagnostic, never encounter timing.
            requested = []
            if counts['cast'] and any(e['start'] in ('Cast', 'Precast Start') and
                                       e['target'] in ('Caster', 'Target', 'Target (Not Caster)') for e in routes):
                requested.append(('cast', next(e for e in occurrences if e['type'] == 'cast')))
            for self_cast in (False, True):
                applications = [e for e in occurrences if e['type'] in ('applybuff', 'applydebuff') and
                                bool(e['source'] == e['target']) == self_cast]
                if applications and any(e['start'] == 'Aura Start' and
                       (e['target'] == 'Target' or self_cast and e['target'] == 'Caster' or
                        not self_cast and e['target'] == 'Target (Not Caster)') for e in routes):
                    requested.append(('aura', applications[0]))
            if (spell or {}).get('channel') and counts['cast'] and any(e['start'] == 'Channel Start' for e in routes):
                requested.append(('channel', next(e for e in occurrences if e['type'] == 'cast')))
            case_ids = []
            for stage, occurrence in requested:
                source_id = int(occurrence['source'].split(':')[0]) if occurrence['source'] else 0
                source = actors.get(source_id, {})
                if not npc(source, actors) or not source.get('gameID'):
                    gaps.append('fixture-source-host-unavailable')
                    continue
                self_cast = occurrence['source'] == occurrence['target']
                cid = f'encounter:{fight["id"]}:spell:{sid}:{stage}:{"self" if self_cast else "other"}'
                host = {'id': 'subject', 'kind': 'creature', 'npcId': source['gameID'],
                        'position': [0, 0, 0], 'facing': 0, 'scale': 1}
                target_actor = actors.get(int(occurrence['target'].split(':')[0]), {}) if occurrence['target'] else {}
                target = {'id': 'target', 'position': [8, 0, 0], 'facing': 3.14, 'scale': 1}
                if npc(target_actor, actors) and target_actor.get('gameID'):
                    target.update(kind='creature', npcId=target_actor['gameID'])
                else:
                    target.update(kind='character', race=1, sex=0)
                duration = max(0, int((spell or {}).get('castMs', 0))) if stage == 'cast' else 1500
                cases.append({'id': cid, 'label': f'{fight["name"]}: {names.get(sid) or sid} {stage}',
                    'category': 'spell', 'content': raw['gameVersion'] if raw['gameVersion'] == 'sod' else 'era',
                    'mapId': None, 'position': [0, 0, 0],
                    'camera': {'yaw': .65, 'pitch': .35, 'distance': 18, 'target': [3, 0, 1.5]},
                    'actors': [host] if self_cast else [host, target],
                    'effects': [{'id': 'mechanic', 'spellId': sid, 'stage': stage, 'casterId': 'subject',
                                 'targetId': 'subject' if self_cast else 'target', 'startMs': 250,
                                 'durationMs': duration}],
                    'timesMs': sorted({0, 250, 500, 1000, 250 + duration, 750 + duration, 1750 + duration}),
                    'seed': 1, 'coverageIds': [f'spell:{sid}', f'encounter:{fight["id"]}'],
                    'expectedReadableFeatures': ['authored effect/host animation if present',
                        'start, hold, end and cleanup; diagnostic durations and host placement'],
                    'readiness': {'status': 'unverified', 'reason': 'Generated from a recorded occurrence; no execution or visual credit.'}})
                case_ids.append(cid)
            if not case_ids:
                gaps.append('no-observed-supported-native-fixture; inspect through the complete replay')
            mechanics.append({'spellId': sid, 'name': names.get(sid) or (spell or {}).get('name'),
                'eventCounts': dict(counts), 'occurrences': occurrences,
                'visualIds': capabilities.get('visualIds', []), 'routes': routes,
                'capabilitySupport': support, 'gaps': sorted(set(gaps)), 'caseIds': case_ids,
                'conditionalCapabilities': capabilities.get('conditionalRenderCapabilities', []),
                'unclassifiedMetadata': capabilities.get('unclassifiedMetadata', []),
                'evidence': {'observed': True, 'catalogued': spell is not None,
                    'nativeExecuted': False, 'replayVerified': False, 'visuallyMatched': False}})
        stream = raw.get('stream')
        actual_coverage = coverage
        if stream:
            # A streamed export needs detailed coverage, not just state history.
            actual_coverage = 'unknown'
            if coverage == 'complete':
                raise ValueError('Export a complete non-streamed replay or supply report/events; streamed coverage is not certified')
        encounters.append({'id': fight['id'], 'name': fight['name'], 'encounterId': fight['encounterID'],
            'mapId': fight.get('gameZone', {}).get('id'), 'durationMs': end - start,
            'eventCount': len(rows), 'coverage': actual_coverage,
            'recordedBounds': {'startTime': start, 'endTime': end,
                               'reportedBounds': fight.get('reportedBounds'),
                               'recordedPrelude': fight.get('recordedPrelude')},
            'coverageBasis': 'caller declaration; not an independent API completeness check',
            'expectations': None if specification is None else {**specification, 'mechanics': [
                {**m, 'observationCoverage': {'declaredSpellIds': m.get('spellIds', []),
                    'observedSpellIds': sorted(set(m.get('spellIds', [])) & observed.keys()),
                    'missingSpellIds': sorted(set(m.get('spellIds', [])) - observed.keys()),
                    'basis': 'listed spell observations only; not mechanic execution or visual acceptance'}}
                for m in specification['mechanics']]},
            'mechanics': mechanics, 'actors': sorted(entities.values(), key=lambda a: a['key']),
            'specialAbilityEvents': dict(special),
            'unproven': ['unobserved mechanics and encounter variants', 'ground destinations and hazard geometry',
                        'server animation/phase scripts', 'whole-encounter rendering and official-client appearance']})
    return {'schema': 1, 'source': graph['source'], 'ruleset': raw['gameVersion'],
        'catalogScope': {'referenceDefinitionsPresent': bool(graph.get('referenceDefinitions')),
            'proceduralMetadataPresent': 'SpellProceduralEffect' in graph.get('layouts', {}),
            'warning': 'Client build identity does not establish converter freshness. Use a graph exported by the current production converter.'},
        'report': {k: raw['report'][k] for k in ('code', 'revision', 'segments', 'endTime') if k in raw['report']},
        'encounters': encounters, 'caseCount': len(cases),
        'proofBoundary': 'Observed log events and source capability classification only. Isolated fixtures do not certify real replay, hidden mechanics, or visual parity.'}, cases


def markdown(report):
    lines = ['# Encounter fidelity audit', '', report['proofBoundary'], '',
             report['catalogScope']['warning'], '',
             '| Encounter | Events | NPC/environment spell IDs | NPC instances | Diagnostic cases |',
             '| --- | ---: | ---: | ---: | ---: |']
    for e in report['encounters']:
        lines.append(f'| {e["name"]} | {e["eventCount"]} | {len(e["mechanics"])} | {len(e["actors"])} | {sum(len(m["caseIds"]) for m in e["mechanics"])} |')
    for e in report['encounters']:
        lines.extend(['', f'## {e["name"]}', '', f'Detailed coverage: {e["coverage"]}. {e["coverageBasis"]}.', '',
                      '| Spell | ID | Events | Gaps requiring inspection |', '| --- | ---: | --- | --- |'])
        for m in e['mechanics']:
            counts = ', '.join(f'{k}={v}' for k, v in sorted(m['eventCounts'].items()))
            gaps = '; '.join(m['gaps']) or 'No declared capability gap; execution and visual checks pending'
            lines.append(f'| {(m["name"] or "Unknown").replace("|", "/")} | {m["spellId"]} | {counts} | {gaps} |')
        expected = e.get('expectations')
        if not expected:
            lines.extend(['', 'Expected mechanics: no research specification supplied. This is an observed-event inventory.'])
            continue
        lines.extend(['', '### Research acceptance checklist', '', expected['proofBoundary'], '',
                      '| Mechanic | Acceptance check | Verification |', '| --- | --- | --- |'])
        for m in expected['mechanics']:
            lines.append(f'| {m["mechanic"].replace("|", "/")} | {m["acceptanceCheck"].replace("|", "/")} | unverified |')
    return '\n'.join(lines) + '\n'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--replay', type=Path)
    p.add_argument('--report', type=Path)
    p.add_argument('--events', type=Path)
    p.add_argument('--details', type=Path)
    p.add_argument('--graph', type=Path, required=True)
    p.add_argument('--expectations', type=Path, action='append', default=[],
                   help='Research specification JSON; repeat for multiple encounters. Grants no verification credit.')
    p.add_argument('--map-id', type=int)
    p.add_argument('--coverage', choices=('complete', 'partial', 'unknown'), default='unknown')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--batch-size', type=int, default=24)
    args = p.parse_args()
    if args.batch_size < 1:
        p.error('--batch-size must be positive')
    if args.replay and any((args.report, args.events, args.details)):
        p.error('Use --replay or --report/--events/--details')
    if not args.replay and not all((args.report, args.events, args.details)):
        p.error('--report, --events and --details are required without --replay')
    inputs = {}
    def read(path):
        data = path.read_bytes()
        inputs[str(path.resolve())] = hashlib.sha256(data).hexdigest()
        return json.loads(data)
    graph = read(args.graph)
    if args.replay:
        raw = read(args.replay)
    else:
        report, events, detail = read(args.report), read(args.events), read(args.details)
        raw = {'report': report, 'gameVersion': report.get('gameVersion'), 'fights': report['fights'],
               'events': events, 'actors': detail['masterData']['actors'],
               'abilities': detail['masterData'].get('abilities', [])}
    result, cases = diagnose(raw, graph, map_id=args.map_id, coverage=args.coverage,
                             expectations=[read(path) for path in args.expectations])
    result['inputs'] = inputs
    result['inputRoles'] = {name: str(getattr(args, name).resolve()) for name in
                           ('replay', 'report', 'events', 'details', 'graph') if getattr(args, name)}
    result['workflowSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    result['sourceFiles'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
        ('scripts/renderer-spell-audit.py', 'scripts/classic_spells.py', 'scripts/resolve-encounter-bounds.mjs', 'web/planner/replay.mjs', 'web/planner/replay-actions.mjs',
         'web/planner/replay-movement.mjs', 'web/planner/plan.mjs',
         'web/planner/replay-channel-auras.mjs',
         'web/planner/encounters/sod-reborn-council.mjs',
         'web/planner/encounters/sod-mason.mjs',
         'web/planner/encounters/sod-beatrix.mjs',
         'web/planner/encounters/sod-viscidus.mjs', 'web/planner/encounters/sod-aq40-illusions.mjs',
         'web/planner/encounters/sod-aq40-movement.mjs',
         'web/planner/encounters/sod-aq40-results.mjs',
         'web/planner/encounters/sod-raid-results.mjs', 'web/planner/encounters/sod-ossirian.mjs',
         'web/planner/encounters/vanilla-hakkar.mjs', 'web/planner/encounter-bounds.mjs',
         'crates/benilla-formats/src/spell_visual/modern.rs', 'crates/benilla-formats/src/spell_visual/mod.rs',
         'crates/benilla-app/src/aura_visual.rs', 'crates/benilla-app/src/planner_replay.rs',
         'crates/benilla-app/src/planner_replay_transport.rs',
         'web/editor/src/replay-frame-transport.ts', 'web/editor/src/replay-presence-index.ts', 'web/editor/src/incremental-replay.ts',
         'crates/benilla-app/src/creature_anim/spell_visual.rs', 'web/editor/src/controller.ts', 'web/editor/src/wcl-browser.ts', 'web/editor/src/types.ts')}
    # Refuse reuse so a later failure cannot leave old batches beside a new report.
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'report.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    (args.output / 'report.md').write_text(markdown(result))
    for i in range(0, len(cases), args.batch_size):
        (args.output / f'batch-{i // args.batch_size:03}.json').write_text(json.dumps(cases[i:i + args.batch_size], indent=2, allow_nan=False) + '\n')
    print(json.dumps({'encounters': len(result['encounters']), 'cases': len(cases), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
