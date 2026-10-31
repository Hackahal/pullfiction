#!/usr/bin/env python3
"""Local, log-independent renderer inventory and deterministic fixture batches.

Catalog JSON is optional and read-only. Generated metadata belongs in an ignored
local directory. Metadata enumeration never earns decode, render or visual credit.
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

    def add(self, key, kind, row, dependencies=(), family=None, issues=()):
        dependencies = sorted(set(dependencies))
        self.entries[key] = {'id': key, 'kind': kind, 'family': family or key,
                             'dependencies': dependencies, 'fingerprint': digest([kind, row, dependencies]),
                             'status': {'enumerated': True, **{d: 'unverified' for d in DIMENSIONS}},
                             'issues': list(issues), 'evidence': []}
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


def build_manifest(catalogs=None, *, content='sod', npcs=None, raids=None, bosses=None, resume=None, batch_size=32, verification_id=None):
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size < 1:
        raise ValueError('batch_size must be a positive integer')
    catalogs = catalogs or {}
    profile = build_profile(catalogs, content)
    profile['verificationId'] = verification_id
    inv = Inventory(profile)
    spell_inventory(inv, catalogs.get('spells', {}), content)
    creature_inventory(inv, catalogs.get('creatures', {}), npcs or {}, content, bosses or [])
    notes = gear_inventory(inv, catalogs.get('items', {}), catalogs.get('characters', []), content)
    world_inventory(inv, catalogs.get('world', {}), raids or [], content)
    for key, row in inv.entries.items():
        missing = [d for d in row['dependencies'] if d not in inv.entries]
        row['issues'] += ['missing-reference:' + d for d in missing]
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
    cases = sorted(inv.cases.values(), key=lambda c: c['id'])
    entries = sorted(inv.entries.values(), key=lambda e: e['id'])
    batches = [{'id': f'batch-{i // batch_size:05}', 'caseIds': [c['id'] for c in cases[i:i + batch_size]]}
               for i in range(0, len(cases), batch_size)]
    counts = dict(collections.Counter(e['kind'] for e in entries))
    status_counts = {d: dict(collections.Counter(e['status'][d] for e in entries)) for d in DIMENSIONS}
    return {'schema': SCHEMA, 'profile': profile, 'entries': entries, 'cases': cases, 'batches': batches,
            'summary': {'entities': len(entries), 'cases': len(cases), 'byKind': counts, 'byStatus': status_counts},
            'inputs': {k: {'sha256': digest(v), 'source': source_identity(v)} for k, v in catalogs.items()},
            'notes': dict(notes, referenceImages='none; captures are regression evidence only',
                          scale='Catalog scales and unknown server template scales are separate.',
                          missingCatalogs=[k for k in ('spells', 'creatures', 'items', 'characters', 'world') if not catalogs.get(k)],
                          proof='Metadata only. No decode, GPU render, visual inspection or parity is inferred.')}


def load(path):
    return json.loads(Path(path).read_text()) if path else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('spells', 'creatures', 'items', 'characters', 'world', 'npcs', 'raids', 'bosses', 'resume'):
        parser.add_argument('--' + name, help='Optional local JSON path')
    parser.add_argument('--content', choices=('sod', 'era'), default='sod')
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--verification-id', help='Composite renderer/converter/browser identity. Required to resume verification credits.')
    parser.add_argument('--output', required=True, help='Ignored local output directory')
    args = parser.parse_args()
    try:
        catalogs = {k: value for k in ('spells', 'creatures', 'items', 'characters', 'world') if (value := load(getattr(args, k))) is not None}
        manifest = build_manifest(catalogs, content=args.content, npcs=load(args.npcs), raids=load(args.raids),
                                  bosses=load(args.bosses), resume=load(args.resume), batch_size=args.batch_size, verification_id=args.verification_id)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    # Only metadata is written. Batch JSON files let a browser runner bound GPU lifetime.
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, allow_nan=False) + '\n')
    (out / 'cases.json').write_text(json.dumps(manifest['cases'], indent=2, allow_nan=False) + '\n')
    by_id = {c['id']: c for c in manifest['cases']}
    for batch in manifest['batches']:
        (out / (batch['id'] + '.json')).write_text(json.dumps([by_id[c] for c in batch['caseIds']], indent=2, allow_nan=False) + '\n')
    print(json.dumps(manifest['summary'], sort_keys=True))


if __name__ == '__main__':
    main()
