#!/usr/bin/env python3
"""Local renderer inventory, shared rendering paths and deterministic lifecycle batches.

Catalog JSON is optional and read-only. Generated metadata belongs in an ignored
local directory. Metadata enumeration never earns decode, render or visual credit.
Content fingerprints and rendering signatures are separate; representatives never
approve other members or consumer contexts.
Resume accepts only identical profiles and entry fingerprints. No image goldens
are generated, inferred or overwritten by this program.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path

SCHEMA = 1
DIMENSIONS = ('decode', 'render', 'visual', 'regression')
STATES = {'unverified', 'pass', 'fail', 'unsupported', 'unavailable', 'expected-none'}
STAGES = {'Precast Start': 'cast', 'Cast': 'cast', 'Impact': 'impact',
          'Channel Start': 'channel', 'Aura Start': 'aura', 'Aura End': 'end',
          'Channel End': 'end', 'Summon': 'summon'}
CAMERA = {'yaw': .65, 'pitch': .35, 'distance': 16, 'target': [0, 0, 1.5]}
# Diagnostic samples only. These are not inferred spell mechanics.
TIMES = [0, 250, 750, 1500]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def actor(kind='synthetic', **fields):
    return dict(id='subject', kind=kind, position=[0, 0, 0], facing=0, scale=1, **fields)


def fixture(key, category, content, label=None, actors=None, effects=None, coverage=None):
    return {'id': key, 'label': label or key, 'category': category, 'content': content,
            'mapId': None, 'position': [0, 0, 0], 'camera': dict(CAMERA),
            'actors': [actor()] if actors is None else actors, 'effects': effects or [],
            'timesMs': TIMES[:], 'seed': 1,
            'expectedReadableFeatures': ['subject silhouette', 'authored textures or effect when present'],
            'coverageIds': coverage or [key],
            'readiness': {'status': 'unverified', 'reason': 'Catalog references require asset decode and runtime readiness.'}}


def items(table):
    return sorted(table.items(), key=lambda x: (int(x[0]) if str(x[0]).isdigit() else math.inf, str(x[0])))


class Inventory:
    def __init__(self, profile):
        self.profile = profile
        self.entries = {}
        self.cases = {}
        self.rows = {}

    def add(self, key, kind, row, dependencies=(), family=None, issues=()):
        dependencies = sorted(set(dependencies))
        self.entries[key] = {'id': key, 'kind': kind, 'family': family or key,
                             'dependencies': dependencies, 'fingerprint': digest([kind, row, dependencies]),
                             'status': {'enumerated': True, **{d: 'unverified' for d in DIMENSIONS}},
                             'issues': list(issues), 'evidence': []}
        self.rows[key] = row
        return key

    def asset(self, file_id):
        if not isinstance(file_id, int) or file_id <= 0:
            return None
        key = f'asset:{file_id}'
        if key not in self.entries:
            self.add(key, 'asset', {'fileDataID': file_id})
        return key

    def case(self, case):
        self.cases[case['id']] = case


def source_identity(catalog):
    if isinstance(catalog, list):
        sources = [x.get('source', {}) for x in catalog if isinstance(x, dict)]
        if sources and any(x != sources[0] for x in sources):
            raise ValueError('Character catalog contains different client sources.')
        return sources[0] if sources else {}
    return catalog.get('source', {})


def build_profile(catalogs, content):
    sources = [source_identity(v) for v in catalogs.values() if v]
    sources = [s for s in sources if s]
    identity = sources[0] if sources else {'product': 'unknown', 'version': 'unknown', 'buildKey': 'unknown'}
    for s in sources:
        if any(s.get(k) != identity.get(k) for k in ('product', 'version', 'buildKey')):
            raise ValueError('Catalog client source mismatch. Generate separate manifests per product/version/buildKey.')
    layouts = {}
    for name, catalog in catalogs.items():
        if not isinstance(catalog, dict):
            continue
        values = catalog.get('tableLayouts', catalog.get('layouts', {}))
        if isinstance(values, dict):
            for table, layout in values.items():
                key = str(table)
                if key in layouts and layouts[key] != str(layout):
                    raise ValueError(f'Conflicting layout for {key}.')
                layouts[key] = str(layout)
    profile = dict(identity, content=content, layouts=layouts,
                   capabilities={k: 'unverified' for k in ('models', 'spellKits', 'equipment', 'world', 'lighting')})
    profile['id'] = digest(profile)[:20]
    return profile


def spell_inventory(inv, graph, content):
    for key, row in items(graph.get('chainEffects', {})):
        deps = [a for f in row.get('textureFileDataIDs', []) if (a := inv.asset(f))]
        inv.add(f'chain:{key}', 'chain', row, deps)
    for key, row in items(graph.get('effects', {})):
        asset = inv.asset(row.get('fileDataID'))
        eid = inv.add(f'effect:{key}', 'effect', row, [asset] if asset else [],
                      family=asset or f'effect:{key}', issues=[] if asset else ['no-model-file-reference'])
        if asset:
            e = {'id': 'effect', 'effectId': int(key), 'modelFileId': row['fileDataID'],
                 'stage': 'model', 'startMs': 0, 'durationMs': 1500}
            inv.case(fixture(eid, 'spell', content, effects=[e]))
    for key, row in items(graph.get('kits', {})):
        deps = [f"effect:{e['effect']}" for e in row.get('effects', []) if e.get('effect')]
        for proc in row.get('proceduralEffects', []):
            pid = f"procedure:{proc.get('id', digest(proc)[:16])}"
            values = proc.get('values', [])
            chain = int(values[0]) if values and proc.get('type') in (0, 12) else 0
            inv.add(pid, 'procedure', proc, [f'chain:{chain}'] if chain else [])
            deps.append(pid)
        inv.add(f'kit:{key}', 'kit', row, deps, issues=[f"catalog-primitive:{x.get('type', 'unknown')}" for x in row.get('unsupported', [])])
    for key, row in items(graph.get('visuals', {})):
        deps = [f"kit:{e['kit']}" for e in row.get('events', []) if e.get('kit')]
        deps += [f"effect:{m['effect']}" for m in row.get('missiles', []) if m.get('effect')]
        inv.add(f'visual:{key}', 'visual', row, deps)
        for event in row.get('events', []):
            kit_id = event.get('kit')
            if not kit_id:
                continue
            stage = STAGES.get(event.get('start'))
            if not stage:
                inv.entries[f'visual:{key}']['issues'].append(f"unmapped-event:{event.get('start')}")
                continue
            target = event.get('target', 'unknown')
            # Shared kit/stage/target fixtures cover rendering, never spell routing conditions.
            cid = f'kit:{kit_id}:{stage}:{target}:' + digest(event)[:12]
            if cid not in inv.cases:
                effect = {'id': 'kit', 'kitId': kit_id, 'stage': stage, 'casterId': 'subject',
                          'targetId': 'target', 'startMs': 0, 'durationMs': 1500,
                          'attachmentTarget': target, 'authored': event}
                c = fixture(cid, 'spell', content, actors=[actor(), {'id': 'target', 'kind': 'synthetic', 'position': [8, 0, 0], 'facing': 0, 'scale': 1}],
                            effects=[effect], coverage=[f'kit:{kit_id}'])
                c['expectedReadableFeatures'] += [f'authored {stage} stage', f'authored attachment target: {target}']
                inv.case(c)
        for missile in row.get('missiles', []):
            effect_id = missile.get('effect')
            if effect_id:
                cid = 'missile:' + digest(missile)[:16]
                effect = {'id': 'missile', 'effectId': effect_id, 'stage': 'flight', 'casterId': 'subject',
                          'targetId': 'target', 'startMs': 0, 'durationMs': 1500, 'authored': missile}
                c = fixture(cid, 'spell', content, actors=[actor(), {'id': 'target', 'kind': 'synthetic',
                            'position': [8, 0, 0], 'facing': 0, 'scale': 1}], effects=[effect], coverage=[f'effect:{effect_id}'])
                inv.case(c)
    for key, row in items(graph.get('spells', {})):
        deps = [f"visual:{v['id']}" for v in row.get('visuals', []) if v.get('id')]
        if cue := row.get('summonCue'):
            deps += [f"spell:{cue['visualSpellID']}", f"display:{cue['displayID']}"]
        sid = inv.add(f'spell:{key}', 'spell', row, deps, family=','.join(sorted(set(deps))) or 'spell:expected-none')
        if not deps:
            inv.entries[sid]['issues'].append('expected-none: catalog has no authored visual reference')
            inv.entries[sid]['status']['render'] = 'expected-none'
        # Conditions are deliberately retained in row fingerprint, never treated as resolved gameplay.


def creature_inventory(inv, catalog, npcs, content, bosses):
    models, displays = catalog.get('models', {}), catalog.get('displays', {})
    for key, row in items(models):
        asset = inv.asset(row.get('fileDataID'))
        mid = inv.add(f'model:{key}', 'model', row, [asset] if asset else [], family=asset)
        if asset:
            inv.case(fixture(mid, 'model', content, actors=[actor('model', modelFileId=row['fileDataID'])]))
    for key, row in items(displays):
        deps = [f"model:{row['modelID']}"] if row.get('modelID') else []
        deps += [a for f in row.get('textures', []) if (a := inv.asset(f))]
        inv.add(f'display:{key}', 'display', row, deps, family=f"model:{row.get('modelID', 0)}")
        inv.case(fixture(f'display:{key}', 'model', content,
                         actors=[actor('creature', displayId=int(key))]))
    versions = npcs.get('versions', {})
    rows = versions.get('sod' if content == 'sod' else 'vanilla', {}).get('creatures', {}) if versions else npcs.get('creatures', {})
    boss_rows = {str(x['npcId']): x for x in bosses}
    for key in sorted(set(rows) | set(boss_rows), key=int):
        row = rows.get(key, {})
        ids = sorted(set(row.get('displayIDs', []) or ([row['displayID']] if row.get('displayID') else [])))
        nid = inv.add(f'npc:{content}:{key}', 'boss' if key in boss_rows else 'npc', row,
                      [f'display:{d}' for d in ids], issues=[] if ids else ['no-display-metadata'])
        for display in ids or [None]:
            cid = f'{nid}:display:{display or "unknown"}'
            a = actor('creature', npcId=int(key))
            if display:
                a['displayId'] = display
            c = fixture(cid, 'boss' if key in boss_rows else 'model', content,
                        label=row.get('name') or boss_rows.get(key, {}).get('name', cid), actors=[a], coverage=[nid])
            c['expectedReadableFeatures'] += ['all authored display variants tracked', 'server template scale is unknown unless separately supplied']
            if not ids:
                c['readiness'] = {'status': 'unavailable', 'reason': 'NPC display metadata is unavailable.'}
            inv.case(c)


def gear_inventory(inv, catalog, characters, content):
    slots = {}  # InventoryType to renderer equipment slot. Non-wearable entries stay inventory only.
    equipment_slot = {1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9,
                      11: 10, 12: 12, 13: 15, 14: 16, 15: 17, 16: 14, 17: 15, 19: 18,
                      20: 4, 21: 15, 22: 16, 23: 16, 25: 17, 26: 17}
    for key, row in items(catalog.get('items', {})):
        display = row.get('display', 0)
        inv.add(f'item:{key}', 'item', row, [f'gear:{display}'] if display else [], family=f'gear:{display}')
        if row.get('inventory') in equipment_slot:
            slots.setdefault(str(display), equipment_slot[row['inventory']])
    recipes = characters if isinstance(characters, list) else characters.get('characters', [])
    for i, recipe in enumerate(recipes):
        asset = inv.asset(recipe.get('file'))
        deps = ([asset] if asset else []) + [a for t in recipe.get('textures', []) for l in t.get('layers', []) if (a := inv.asset(l.get('file')))]
        key = f"character:{recipe.get('race', 0)}:{recipe.get('sex', 0)}:{i}"
        inv.add(key, 'character', recipe, deps)
        inv.case(fixture(key, 'gear', content, actors=[actor('character', race=recipe.get('race'), sex=recipe.get('sex'))]))
    representatives = {}
    for key, row in items(catalog.get('displays', {})):
        # Texture/model file IDs can be nested lists in exported item catalogs.
        def files(value):
            if isinstance(value, int):
                yield value
            elif isinstance(value, (list, tuple)):
                for child in value:
                    yield from files(child)
            elif isinstance(value, dict):
                for child in value.values():
                    yield from files(child)
        deps = [a for f in files([row.get('models', []), row.get('textures', []), row.get('regions', {})]) if (a := inv.asset(f))]
        family = 'gear-family:' + digest({k: row.get(k) for k in ('models', 'geosets', 'helmet', 'regions', 'visual', 'rangedVisual')})[:16]
        inv.add(f'gear:{key}', 'gear-display', row, deps, family=family)
        if key in slots:
            representatives.setdefault((family, slots[key]), key)
    # Every distinct feature family/slot crosses each available race/body recipe.
    # This is a representative assembly matrix, not all possible gear combinations.
    for (family, slot), display in sorted(representatives.items()):
        for recipe in recipes:
            race, sex = recipe.get('race'), recipe.get('sex')
            cid = f'gear-case:{display}:{slot}:{race}:{sex}'
            a = actor('character', race=race, sex=sex, equipment=[{'slot': slot, 'displayId': int(display)}])
            inv.case(fixture(cid, 'gear', content, actors=[a], coverage=[f'gear:{display}']))
    return {'equipmentStrategy': 'all-item/display inventory; feature-family/slot crossed with supplied race/body recipes',
            'equipmentExclusions': ['all simultaneous gear combinations', 'unavailable race/body recipes', 'unmapped inventory slots']}


def world_inventory(inv, catalog, raids, content):
    maps = {r['id']: r for r in catalog.get('maps', [])}
    raid_maps = {r['map']: r for r in raids if not r.get('rulesets') or content in r['rulesets']}
    for map_id in sorted(set(maps) | set(raid_maps)):
        row = maps.get(map_id, raid_maps.get(map_id))
        inv.add(f'map:{map_id}', 'map', row)
        c = fixture(f'map:{map_id}', 'world', content, label=row.get('name'), actors=[])
        c['mapId'] = map_id
        spawn = raid_maps.get(map_id, {}).get('spawn')
        if spawn:
            c['position'] = spawn[:]
            c['camera']['target'] = [spawn[0], spawn[1], spawn[2] + 1.5]
        c['readiness']['reason'] = 'Catalog/spawn viewpoint requires floor and actual visible-geometry validation.'
        c['expectedReadableFeatures'] = ['visible floor and room geometry', 'authored material and doorway continuity']
        inv.case(c)
        lid = inv.add(f'lighting:{map_id}', 'lighting', {'mapId': map_id}, [f'map:{map_id}'])
        lc = dict(c, id=lid, category='lighting', coverageIds=[lid],
                  expectedReadableFeatures=['authored fog', 'interior/exterior transition', 'shadow path where authored'])
        inv.case(lc)
    for kind, field in [('area', 'areas'), ('wmo-area', 'wmoAreas')]:
        for row in catalog.get(field, []):
            deps = [f"map:{row['mapId']}"] if row.get('mapId') is not None else []
            inv.add(f"{kind}:{row['id']}", kind, row, deps,
                    issues=['viewpoint-unverified: named area is not visible-room coverage'])


def transitive_fingerprints(entries):
    # A changed dependency invalidates an old success for every referencing entity.
    memo = {}
    def visit(key, stack):
        if key in memo:
            return memo[key]
        if key in stack:
            return digest(['cycle', key])
        row = entries.get(key)
        if row is None:
            return digest(['missing', key])
        value = digest([row['fingerprint'], [(d, visit(d, stack | {key})) for d in row['dependencies']]])
        memo[key] = value
        return value
    for key in entries:
        visit(key, set())
    return memo


def model_feature_index(document):
    """Read existing model-audit rows without changing their decode/fidelity contract."""
    if isinstance(document, dict):
        if 'fileDataID' in document:
            rows = [document]
        elif 'models' in document:
            rows = document['models']
        else:
            raise ValueError('Model features object requires models or fileDataID.')
    else:
        rows = document or []
    if isinstance(rows, dict):
        rows = [dict(row, fileDataID=int(key)) for key, row in rows.items()]
    if not isinstance(rows, list):
        raise ValueError('Model features must be model-audit rows or an object with models.')
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Model feature rows must be objects.')
        key = row.get('fileDataID')
        if not isinstance(key, int) or isinstance(key, bool) or key <= 0:
            raise ValueError('Model feature row requires a positive fileDataID.')
        if key in result and result[key] != row:
            raise ValueError(f'Conflicting model feature rows for {key}.')
        result[key] = row
    return result


def render_paths(inv, model_features):
    """Content-free path shapes. Unknown metadata stays in the signature and gap ledger."""
    memo = {}
    def visit(key, stack=frozenset()):
        if key in memo:
            return memo[key]
        if key not in inv.entries or key in stack:
            reason = 'dependency-cycle' if key in stack else 'missing-reference'
            return {'signature': digest([reason, key.split(':')[0]])[:20],
                    'capabilities': [reason], 'gaps': [f'{reason}:{key}'], 'draw': 'unknown'}
        entry, row = inv.entries[key], inv.rows[key]
        kind = entry['kind']
        children = {d: visit(d, stack | {key}) for d in entry['dependencies']}
        caps, gaps, shape = {kind}, set(), []
        draw = 'unknown'
        if kind == 'asset':
            # Asset IDs alone say nothing about geometry, UVs, emitters or visibility.
            summary = model_features.get(row['fileDataID'])
            if summary is None:
                caps.add('asset:unclassified')
                gaps.add('decoded-model-features-missing')
            else:
                source = summary.get('source', {})
                counts, features = source.get('counts', {}), source.get('features', {})
                for field, label in [('vertices', 'mesh'), ('particles', 'particles'), ('ribbons', 'ribbons')]:
                    if field in counts:
                        caps.add(label + (':present' if counts[field] else ':none'))
                    else:
                        gaps.add('model-count-unknown:' + field)
                if all(k in counts for k in ('vertices', 'particles', 'ribbons')):
                    draw = 'potential-draw' if any(counts[k] for k in ('vertices', 'particles', 'ribbons')) else 'none'
                for field in ('externalSkeleton', 'externalAnimation', 'multiTextureParticles',
                              'geometryModelParticles', 'multiStageMaterials', 'wideIndexSections'):
                    if field in features:
                        caps.add(f'model:{field}:' + ('present' if features[field] else 'none'))
                    elif field.startswith('external') or counts.get(
                            'particles' if field in ('multiTextureParticles', 'geometryModelParticles') else 'vertices', 0):
                        gaps.add('model-feature-unclassified:' + field)
                for field in ('particleShapes', 'particleFlags'):
                    for value in sorted(features.get(field, {})):
                        caps.add(f'model:{field}:{value}')
                    if counts.get('particles') and field not in features:
                        gaps.add('model-feature-unclassified:' + field)
                for skin in summary.get('skinFeatures', []):
                    for batch in skin.get('batches', []):
                        caps.add(f"mesh:shader:{batch.get('shader', 'unknown')}:stages:{batch.get('textureStages', 'unknown')}")
                # Optional decoded refinements are opaque mode labels, not inferred defaults.
                refinements = summary.get('renderFeatures', {})
                for field in ('meshUvSources', 'meshBlendModes', 'particleUvModes', 'particleGravityModes'):
                    values = refinements.get(field)
                    if values is not None:
                        shape.append([field, values])
                        caps.add('mode:' + field + ':' + json.dumps(values, sort_keys=True, separators=(',', ':')))
                    elif counts.get('particles' if field.startswith('particle') else 'vertices', 0):
                        gaps.add('model-feature-unclassified:' + field)
                if counts.get('vertices') and not summary.get('skinFeatures'):
                    gaps.add('mesh-shaders-unclassified')
                if summary.get('status') != 'adapted':
                    gaps.add('model-adaptation:' + summary.get('status', 'unknown'))
                if summary.get('missingDependencies'):
                    gaps.add('model-dependencies-unavailable')
                if summary.get('drawExpectation') == 'none':
                    draw = 'none'
        elif kind == 'effect':
            caps.add('effect:type:' + str(row.get('type', 'unknown')))
            if not entry['dependencies']:
                gaps.add('effect-draw-path-unknown')
        elif kind == 'chain':
            # Texture dependencies do not require model-feature summaries.
            children = {}
            caps.add('procedure:chain')
            caps.add('chain:compatible:' + str(row.get('rendererCompatible', 'unknown')))
            if row.get('rendererCompatible') is not True:
                gaps.add('chain-path-unsupported-or-unclassified')
            draw = 'potential-draw' if row.get('rendererCompatible') is True else 'unknown'
        elif kind == 'procedure':
            caps.add('procedure:type:' + str(row.get('type', 'unknown')))
            if not children:
                gaps.add('procedural-path-unclassified')
        elif kind == 'kit':
            for attachment in row.get('effects', []):
                dep = children.get(f"effect:{attachment.get('effect')}", {})
                shape.append(['attachment', dep.get('signature'),
                              'world' if attachment.get('attachment') == -1 else 'bone',
                              attachment.get('flags', 'unknown'),
                              bool(any(attachment.get('offset', []))), bool(any(attachment.get('rotation', []))),
                              attachment.get('scale', 1) != 1, bool(attachment.get('delay'))])
                if attachment.get('positioner'):
                    gaps.add('attachment-positioner-unclassified')
            if row.get('animations'):
                caps.add('host:animation')
            for primitive in row.get('unsupported', []):
                name = primitive.get('type', 'unknown')
                caps.add('catalog-primitive:' + name)
                # Sound-only metadata does not make a known empty visual into a missing draw.
                if name != 'SoundKitID':
                    gaps.add('catalog-primitive-unclassified:' + name)
            if not children and not gaps:
                draw = 'potential-draw' if row.get('animations') else 'none'
        elif kind == 'visual':
            for event in row.get('events', []):
                child = children.get(f"kit:{event.get('kit')}", {})
                shape.append(['event', event.get('start'), event.get('end'), event.get('target'),
                              bool(event.get('delay') or event.get('maxDelay')), child.get('signature')])
                caps.add('lifecycle:' + str(event.get('start', 'unknown')))
                caps.add('target:' + str(event.get('target', 'unknown')))
                if event.get('target') not in ('Caster', 'Target', 'Target (Not Caster)'):
                    gaps.add('event-target-requires-context:' + str(event.get('target', 'unknown')))
                if event.get('start') not in STAGES:
                    gaps.add('lifecycle-event-unmapped:' + str(event.get('start')))
            for missile in row.get('missiles', []):
                child = children.get(f"effect:{missile.get('effect')}", {})
                shape.append(['missile', child.get('signature'), bool(missile.get('motion')),
                              bool(missile.get('positioner'))])
                caps.add('lifecycle:flight')
                if missile.get('motion') or missile.get('positioner'):
                    gaps.add('missile-motion-or-positioner-unclassified')
            if row.get('hasMissile') and not row.get('missiles'):
                gaps.add('missile-reference-missing')
            if not children and not gaps:
                draw = 'none'
        elif kind == 'spell':
            if any(any(v.get('conditions', [])) or v.get('difficulty') for v in row.get('visuals', [])):
                caps.add('routing:conditional')
                gaps.add('gameplay-routing-conditions-unverified')
            caps.add('routing:channel' if row.get('channel') else 'routing:ordinary')
            if row.get('summonCue'):
                caps.add('presentation:illustrative-summon')
                gaps.add('server-summon-motion-unknown')
            if not children:
                draw = 'none'
        else:
            caps.add('path:unclassified')
        for child in children.values():
            caps.update(child['capabilities'])
            gaps.update(child['gaps'])
        if children:
            draws = {c['draw'] for c in children.values()}
            draw = 'potential-draw' if 'potential-draw' in draws else 'unknown' if 'unknown' in draws else 'none'
        draw_gaps = [g for g in gaps if not g.startswith('model-feature-unclassified:')
                     and g not in ('gameplay-routing-conditions-unverified', 'server-summon-motion-unknown')]
        if draw_gaps and draw == 'none':
            draw = 'unknown'
        canonical = [kind, sorted(caps), sorted(shape, key=digest),
                     sorted({c['signature'] for c in children.values()}), sorted({g.split(':')[0] for g in gaps})]
        value = {'signature': digest(canonical)[:20], 'capabilities': sorted(caps),
                 'gaps': sorted(gaps), 'draw': draw}
        memo[key] = value
        return value
    for key in inv.entries:
        path = visit(key)
        inv.entries[key].update(renderSignature=path['signature'], renderCapabilities=path['capabilities'],
                                coverageGaps=path['gaps'], drawExpectation=path['draw'])
        if path['draw'] == 'none' and inv.entries[key]['kind'] in ('spell', 'effect', 'kit', 'visual'):
            inv.entries[key]['status']['render'] = 'expected-none'


def entry_order(key):
    return (int(key.rsplit(':', 1)[-1]) if key.rsplit(':', 1)[-1].isdigit() else math.inf, key)


def recipe_stages(spell, graph):
    stages, gaps = set(), []
    for visual in spell.get('visuals', []):
        row = graph.get('visuals', {}).get(str(visual.get('id')))
        if row is None:
            gaps.append('visual-reference-unavailable')
            continue
        for event in row.get('events', []):
            start = event.get('start')
            if event.get('target') not in ('Caster', 'Target', 'Target (Not Caster)'):
                gaps.append('server-or-unprovided-target:' + str(event.get('target', 'unknown')))
                continue
            stage = {'Precast Start': 'cast', 'Cast': 'cast', 'Impact': 'flight',
                     'Aura Start': 'aura', 'Aura End': 'aura',
                     'Channel Start': 'channel', 'Channel End': 'channel'}.get(start)
            if stage:
                stages.add(stage)
            else:
                gaps.append('server-or-unmapped-event:' + str(start))
        if row.get('missiles'):
            stages.add('flight')
    if spell.get('summonCue'):
        stages.add('summon')
    return stages, gaps


def known_capabilities(entry):
    # Missing references, opaque primitive IDs and unclassified modes cannot buy diversity.
    prefixes = ('mesh:shader:', 'model:particleShapes:', 'model:particleFlags:',
                'model:multiTextureParticles:', 'model:geometryModelParticles:',
                'model:wideIndexSections:', 'procedure:chain', 'chain:compatible:True',
                'host:animation', 'presentation:', 'target:', 'mode:')
    return {c for c in entry['renderCapabilities'] if (c.startswith(prefixes) or c in ('procedure:type:0', 'procedure:type:12'))
            and not any(word in c.lower() for word in ('unknown', 'unclassified', 'missing'))}


def family_recipes(inv, graph, content, limit, model_features, case_limit):
    """Rank shared paths, choose stable members and exercise existing native lifecycle inputs."""
    grouped = collections.defaultdict(list)
    for entry in inv.entries.values():
        if entry['kind'] == 'spell':
            grouped[entry['renderSignature']].append(entry)
    def edge_score(entry):
        row = inv.rows[entry['id']]
        pending, seen, vertices, particles, scale = [entry['id']], set(), 0, 0, 1
        while pending:
            key = pending.pop()
            if key in seen or key not in inv.entries:
                continue
            seen.add(key)
            child = inv.rows[key]
            pending.extend(inv.entries[key]['dependencies'])
            scale = max(scale, abs(child.get('scale', 1)))
            if inv.entries[key]['kind'] == 'asset':
                counts = model_features.get(child['fileDataID'], {}).get('source', {}).get('counts', {})
                vertices = max(vertices, counts.get('vertices', 0))
                particles = max(particles, counts.get('particles', 0))
        return (particles, vertices, scale, max(0, row.get('durationMs', 0)),
                row.get('castMs', 0), row.get('speed', 0))
    candidates_by_family, stages_by_family = {}, {}
    for signature, members in grouped.items():
        members.sort(key=lambda e: entry_order(e['id']))
        edge = min(members, key=lambda e: (tuple(-x for x in edge_score(e)), entry_order(e['id'])))
        candidates_by_family[signature] = list(dict.fromkeys([members[0]['id'], edge['id']]))
        stages_by_family[signature] = set().union(*(recipe_stages(inv.rows[key], graph)[0]
                                                  for key in candidates_by_family[signature]))
    remaining, ordered, covered_stages, covered_caps = set(grouped), [], set(), set()
    budget = limit
    while remaining and budget > 0:
        signature = min(remaining, key=lambda s: (-len(stages_by_family[s] - covered_stages),
            -bool(stages_by_family[s]), -len(known_capabilities(grouped[s][0]) - covered_caps), -len(grouped[s]), s))
        remaining.remove(signature)
        ordered.append(signature)
        covered_stages.update(stages_by_family[signature])
        covered_caps.update(known_capabilities(grouped[signature][0]))
        budget -= min(budget, len(candidates_by_family[signature]))
    ordered += sorted(remaining, key=lambda s: (-len(grouped[s]), s))
    families, recipes, cases = [], [], []
    selected = 0
    for signature in ordered:
        members = grouped[signature]
        candidates = candidates_by_family[signature]
        picked = candidates[:max(0, limit - selected)]
        selected += len(picked)
        family = {'id': 'render-family:' + signature, 'signature': signature,
                  'memberIds': [m['id'] for m in members], 'memberCount': len(members),
                  'representativeId': candidates[0], 'edgeIds': candidates[1:], 'selectedIds': picked,
                  'capabilities': members[0]['renderCapabilities'],
                  'coverageGaps': sorted({g for m in members for g in m['coverageGaps']}),
                  'byStatus': {d: dict(collections.Counter(m['status'][d] for m in members)) for d in DIMENSIONS},
                  'consumerCoverage': {context: {'status': 'unverified', 'caseIds': []} for context in
                                       ('spell-fx', 'placed-doodad', 'ui-model', 'cutout-depth-fade')},
                  'proof': 'Representatives exercise shared paths only; individual member verification is unchanged.'}
        family['coverageGaps'] = sorted(set(family['coverageGaps']) |
            {f'consumer-context-unverified:{context}' for context in family['consumerCoverage']})
        if not picked:
            family['coverageGaps'] = sorted(set(family['coverageGaps']) | {'representative-selection-budget'})
        families.append(family)
        for key in picked:
            spell = inv.rows[key]
            stages, gaps = recipe_stages(spell, graph)
            ids = []
            for stage in sorted(stages):
                cid = f'path:{key}:{stage}'
                e = {'id': 'lifecycle', 'spellId': int(key.split(':')[1]), 'stage': stage,
                     'casterId': 'subject', 'targetId': 'target', 'startMs': 0,
                     'durationMs': 0 if stage == 'flight' else 1500}
                c = fixture(cid, 'spell', content, label=f'{key} shared {stage} path',
                            actors=[actor('character', race=1, sex=0),
                                    dict(actor('character', race=1, sex=0), id='target', position=[8, 0, 0])],
                            effects=[e], coverage=[key])
                c['timesMs'] = [0, 250, 500, 750, 1000, 1500, 1750, 2200]
                c['expectedReadableFeatures'] = ['authored draw when present; intentional no-draw is valid',
                    'start, hold or travel, end and owner cleanup; diagnostic ages only']
                c['readiness']['reason'] = 'Native lifecycle recipe; verify dependencies, visibility and actual arrival/cleanup.'
                cases.append(c)
                ids.append(cid)
                family['consumerCoverage']['spell-fx']['caseIds'].append(cid)
            if not stages:
                gaps.append('expected-no-draw' if inv.entries[key]['drawExpectation'] == 'none' else 'native-recipe-unavailable')
            recipes.append({'entryId': key, 'familyId': family['id'], 'caseIds': ids,
                            'consumerContext': 'spell-fx', 'ungenerated': sorted(set(gaps)),
                            'coverageGaps': inv.entries[key]['coverageGaps'],
                            'drawExpectation': inv.entries[key]['drawExpectation']})
    if case_limit is not None:
        # Bound actual captures separately from member selection, retaining explicit omissions.
        pending = {c['id']: c for c in cases}
        chosen, stages, capabilities = [], set(), set()
        order = {f['id']: i for i, f in enumerate(families)}
        recipe_by_case = {cid: recipe for recipe in recipes for cid in recipe['caseIds']}
        while pending and len(chosen) < case_limit:
            cid = min(pending, key=lambda key: (
                -(pending[key]['effects'][0]['stage'] not in stages),
                -len(known_capabilities(inv.entries[recipe_by_case[key]['entryId']]) - capabilities),
                order[recipe_by_case[key]['familyId']], entry_order(recipe_by_case[key]['entryId']), key))
            case = pending.pop(cid)
            chosen.append(case)
            stages.add(case['effects'][0]['stage'])
            capabilities.update(known_capabilities(inv.entries[recipe_by_case[cid]['entryId']]))
        retained = {c['id'] for c in chosen}
        for recipe in recipes:
            if any(cid not in retained for cid in recipe['caseIds']):
                recipe['ungenerated'] = sorted(set(recipe['ungenerated']) | {'case-selection-budget'})
            recipe['caseIds'] = [cid for cid in recipe['caseIds'] if cid in retained]
        for family in families:
            old_ids = family['consumerCoverage']['spell-fx']['caseIds']
            if any(cid not in retained for cid in old_ids):
                family['coverageGaps'] = sorted(set(family['coverageGaps']) | {'case-selection-budget'})
            family['consumerCoverage']['spell-fx']['caseIds'] = [cid for cid in old_ids if cid in retained]
        cases = chosen
    reachable, pending = set(), [key for key in inv.entries if key.startswith('spell:')]
    while pending:
        key = pending.pop()
        if key in reachable:
            continue
        reachable.add(key)
        pending.extend(inv.entries.get(key, {}).get('dependencies', []))
    ungenerated = [{'entryId': key, 'reason': 'kit-only-native-routing-unimplemented'}
                   for key in sorted(inv.entries) if key.startswith('kit:') and key not in reachable]
    return families, recipes, cases, ungenerated


def build_manifest(catalogs=None, *, content='sod', npcs=None, raids=None, bosses=None, resume=None, batch_size=32, verification_id=None,
                   model_features=None, representative_limit=64, case_limit=None):
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size < 1:
        raise ValueError('batch_size must be a positive integer')
    if not isinstance(representative_limit, int) or isinstance(representative_limit, bool) or representative_limit < 0:
        raise ValueError('representative_limit must be a nonnegative integer')
    if case_limit is not None and (not isinstance(case_limit, int) or isinstance(case_limit, bool) or case_limit < 0):
        raise ValueError('case_limit must be a nonnegative integer')
    catalogs = catalogs or {}
    profile = build_profile(catalogs, content)
    profile['verificationId'] = verification_id
    features = model_feature_index(model_features)
    feature_source = model_features.get('source', {}) if isinstance(model_features, dict) and 'models' in model_features else {}
    if feature_source and any(feature_source.get(k) != profile.get(k) for k in ('product', 'version', 'buildKey')):
        raise ValueError('Model feature client source mismatch.')
    inv = Inventory(profile)
    spell_inventory(inv, catalogs.get('spells', {}), content)
    creature_inventory(inv, catalogs.get('creatures', {}), npcs or {}, content, bosses or [])
    notes = gear_inventory(inv, catalogs.get('items', {}), catalogs.get('characters', []), content)
    world_inventory(inv, catalogs.get('world', {}), raids or [], content)
    for key, row in inv.entries.items():
        if row['kind'] == 'asset' and (summary := features.get(inv.rows[key]['fileDataID'])) is not None:
            # Refinements can change path selection and invalidate dependent old verification.
            row['fingerprint'] = digest([row['fingerprint'], summary])
        missing = [d for d in row['dependencies'] if d not in inv.entries]
        row['issues'] += ['missing-reference:' + d for d in missing]
    render_paths(inv, features)
    fingerprints = transitive_fingerprints(inv.entries)
    old = {e['id']: e for e in (resume or {}).get('entries', [])} if verification_id and (resume or {}).get('profile') == profile else {}
    for key, row in inv.entries.items():
        row['dependencyFingerprint'] = fingerprints[key]
        previous = old.get(key, {})
        if previous.get('dependencyFingerprint') == row['dependencyFingerprint']:
            for dimension in DIMENSIONS:
                if previous.get('status', {}).get(dimension) in STATES:
                    row['status'][dimension] = previous['status'][dimension]
            row['evidence'] = previous.get('evidence', [])
    families, recipes, representative_cases, ungenerated = family_recipes(
        inv, catalogs.get('spells', {}), content, representative_limit, features, case_limit)
    cases = sorted(inv.cases.values(), key=lambda c: c['id'])
    entries = sorted(inv.entries.values(), key=lambda e: e['id'])
    batches = [{'id': f'batch-{i // batch_size:05}', 'caseIds': [c['id'] for c in cases[i:i + batch_size]]}
               for i in range(0, len(cases), batch_size)]
    counts = dict(collections.Counter(e['kind'] for e in entries))
    status_counts = {d: dict(collections.Counter(e['status'][d] for e in entries)) for d in DIMENSIONS}
    inputs = {k: {'sha256': digest(v), 'source': source_identity(v)} for k, v in catalogs.items()}
    if model_features is not None:
        inputs['modelFeatures'] = {'sha256': digest(model_features), 'source': feature_source,
                                   'identityVerified': bool(feature_source)}
    return {'schema': SCHEMA, 'profile': profile, 'entries': entries, 'cases': cases, 'batches': batches,
            'renderFamilies': families, 'lifecycleRecipes': recipes,
            'representativeCases': representative_cases, 'ungeneratedRecipes': ungenerated,
            'summary': {'entities': len(entries), 'cases': len(cases), 'byKind': counts, 'byStatus': status_counts,
                        'renderFamilies': len(families), 'representativeCases': len(representative_cases),
                        'selectedSpellMembers': sum(len(f['selectedIds']) for f in families)},
            'inputs': inputs,
            'notes': dict(notes, referenceImages='none; captures are regression evidence only',
                          scale='Catalog scales and unknown server template scales are separate.',
                          familySignatures='Structural rendering paths exclude content IDs and numeric tuning; fingerprints retain them.',
                          selection='New executable lifecycle stages, then known capabilities, member count and stable signature; lowest ID plus numeric edge per family.',
                          consumerContexts='Asset/path grouping does not verify spell, doodad, UI or cutout/fade consumers for one another.',
                          modelFeatureIdentity='matched' if feature_source else 'not supplied; audit source hashes remain provenance only',
                          missingCatalogs=[k for k in ('spells', 'creatures', 'items', 'characters', 'world') if not catalogs.get(k)],
                          proof='Metadata only. No decode, GPU render, visual inspection or parity is inferred.')}


def load(path):
    return json.loads(Path(path).read_text()) if path else None


def load_model_features(path):
    if not path:
        return None
    text = Path(path).read_text()
    return [json.loads(line) for line in text.splitlines() if line.strip()] if Path(path).suffix == '.jsonl' else json.loads(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('spells', 'creatures', 'items', 'characters', 'world', 'npcs', 'raids', 'bosses', 'resume'):
        parser.add_argument('--' + name, help='Optional local JSON path')
    parser.add_argument('--content', choices=('sod', 'era'), default='sod')
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--model-features', help='Optional existing model-audit JSONL or JSON model rows; no game assets')
    parser.add_argument('--representative-limit', type=int, default=64, help='Maximum selected spell members across shared families')
    parser.add_argument('--case-limit', type=int, help='Optional maximum executable lifecycle captures; new stages/capabilities first')
    parser.add_argument('--representatives', action='store_true', help='Write executable lifecycle representatives as cases/batches instead of inventory cases')
    parser.add_argument('--verification-id', help='Composite renderer/converter/browser identity. Required to resume verification credits.')
    parser.add_argument('--output', required=True, help='Ignored local output directory')
    args = parser.parse_args()
    try:
        catalogs = {k: value for k in ('spells', 'creatures', 'items', 'characters', 'world') if (value := load(getattr(args, k))) is not None}
        manifest = build_manifest(catalogs, content=args.content, npcs=load(args.npcs), raids=load(args.raids),
                                  bosses=load(args.bosses), resume=load(args.resume), batch_size=args.batch_size, verification_id=args.verification_id,
                                  model_features=load_model_features(args.model_features), representative_limit=args.representative_limit,
                                  case_limit=args.case_limit)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    # Only metadata is written. Batch JSON files let a browser runner bound GPU lifetime.
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, allow_nan=False) + '\n')
    cases = manifest['representativeCases'] if args.representatives else manifest['cases']
    (out / 'cases.json').write_text(json.dumps(cases, indent=2, allow_nan=False) + '\n')
    for i in range(0, len(cases), args.batch_size):
        (out / f'batch-{i // args.batch_size:05}.json').write_text(json.dumps(cases[i:i + args.batch_size], indent=2, allow_nan=False) + '\n')
    print(json.dumps(manifest['summary'], sort_keys=True))


if __name__ == '__main__':
    main()
