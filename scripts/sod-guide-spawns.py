#!/usr/bin/env python3
"""Project SoD BFD guide icons into approximate native XY using shared room anchors.

Inputs are reviewed numeric projections, not HTML or art. Guide icons are not
server spawn coordinates. World Z and facing remain unknown, never copied from
Classic boss records or inferred from combat logs.
"""
import argparse
import json
import math
from pathlib import Path
import re
from statistics import median

GUIDE_URL = 'https://www.wowhead.com/classic/guide/season-of-discovery/blackfathom-deeps-level-up-raid-overview'
BOSSES = {
    'Baron Aquanis': 202699,
    'Ghamoo-ra': 201722,
    'Lady Sarevess': 204068,
    'Gelihast': 204921,
    'Lorgus Jett': 207356,
    'Twilight Lord Kelris': 209678,
    "Aku'mai": 213334,
}
ANCHORS = {'Ghamoo-ra': 4887, 'Lady Sarevess': 4831, 'Gelihast': 6243,
           'Twilight Lord Kelris': 4832, "Aku'mai": 4829}


class GuideError(ValueError):
    pass


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def checksum(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def positive_id(value):
    return type(value) is int and 0 < value <= 0xffffffff


def solve(matrix, values):
    """Solve a nonsingular 3x3 system with partial-pivot Gaussian elimination."""
    rows = [list(map(float, row)) + [float(value)] for row, value in zip(matrix, values)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda index: abs(rows[index][column]))
        if abs(rows[pivot][column]) < 1e-10:
            raise GuideError('Guide registration anchors do not span a two-dimensional frame')
        rows[column], rows[pivot] = rows[pivot], rows[column]
        divisor = rows[column][column]
        rows[column] = [value / divisor for value in rows[column]]
        for index in range(3):
            if index == column:
                continue
            factor = rows[index][column]
            rows[index] = [a - factor * b for a, b in zip(rows[index], rows[column])]
    return [row[3] for row in rows]


def affine(anchors):
    """Fit [1, percentX, percentY] to native X and Y with equal anchor weights."""
    rows = [[1.0, *anchor['percent']] for anchor in anchors]
    normal = [[sum(row[i] * row[j] for row in rows) for j in range(3)] for i in range(3)]
    result = {}
    for axis, key in enumerate(('nativeX', 'nativeY')):
        values = [sum(row[i] * anchor['nativeXY'][axis] for row, anchor in zip(rows, anchors)) for i in range(3)]
        result[key] = solve(normal, values)
    return result


def transform(percent, coefficients):
    return [sum(a * b for a, b in zip(coefficients[key], [1, *percent]))
            for key in ('nativeX', 'nativeY')]


def project(guide, models, baseline):
    if (not isinstance(guide, dict) or guide.get('ruleset') != 'sod'
            or guide.get('nativeMap') != 48 or guide.get('mapperZone') != 719
            or guide.get('mapperFloor') != 0 or guide.get('mapperPhase') != 0
            or guide.get('sourceURL') != GUIDE_URL or not checksum(guide.get('sourceSHA256'))):
        raise GuideError('Expected the reviewed SoD BFD guide in native map 48, zone 719, floor 0, phase 0')
    pins = {}
    for pin in guide.get('pins', []):
        if (not isinstance(pin, dict) or pin.get('label') not in {*BOSSES, 'Entrance'}
                or pin['label'] in pins or not isinstance(pin.get('percent'), list)
                or len(pin['percent']) != 2
                or not all(finite(value) and 0 <= value <= 100 for value in pin['percent'])
                or pin.get('type') != (0 if pin['label'] == 'Entrance' else 4)):
            raise GuideError('Invalid, duplicate or unrelated guide icon')
        pins[pin['label']] = pin
    if set(pins) != {*BOSSES, 'Entrance'}:
        raise GuideError('Expected exactly seven BFD boss icons and the entrance')
    if (not isinstance(baseline, dict) or baseline.get('schema') != 1
            or baseline.get('ruleset') != 'vanilla' or not checksum(baseline.get('sourceSHA256'))
            or not isinstance(baseline.get('sourceURL'), str)
            or not baseline['sourceURL'].startswith('https://github.com/cmangos/classic-db/blob/')
            or not isinstance(baseline.get('maps'), dict)
            or not isinstance(baseline['maps'].get('48'), list)):
        raise GuideError('Expected a CMaNGOS Classic BFD registration reference for native map 48')
    anchors = []
    for name, entry in ANCHORS.items():
        matches = [row for row in baseline['maps']['48'] if row.get('entry') == entry and row.get('name') == name]
        if len(matches) != 1:
            raise GuideError(f'Expected one independent Classic room anchor for {name}')
        row = matches[0]
        if (not isinstance(row.get('position'), list) or len(row['position']) != 3
                or not all(finite(value) and abs(value) < 20000 for value in row['position'])):
            raise GuideError(f'Invalid native reference coordinate for {name}')
        anchors.append({'name': name, 'referenceEntry': entry, 'referenceSpawnID': row['id'],
                        'percent': pins[name]['percent'], 'nativeXY': row['position'][:2]})
    coefficients = affine(anchors)
    residuals = []
    for anchor in anchors:
        predicted = transform(anchor['percent'], coefficients)
        residual = math.dist(predicted, anchor['nativeXY'])
        anchor['residualYards'] = round(residual, 6)
        residuals.append(residual)
    if max(residuals) > 35:
        raise GuideError('Guide registration exceeds the reviewed 35-yard anchor residual threshold')
    if (not isinstance(models, dict) or models.get('schema') != 1 or models.get('provider') != 'Wowhead'
            or not isinstance(models.get('versions'), dict)
            or not isinstance(models['versions'].get('sod'), dict)
            or not isinstance(models['versions']['sod'].get('creatures'), dict)):
        raise GuideError('Expected separately verified SoD NPC display metadata')
    creatures = models['versions']['sod']['creatures']
    result = []
    for name, entry in BOSSES.items():
        model = creatures.get(str(entry))
        if (not isinstance(model, dict) or model.get('name') != name
                or not positive_id(model.get('displayID'))
                or not isinstance(model.get('displayIDs'), list)
                or not model['displayIDs'] or len(model['displayIDs']) > 64
                or not all(positive_id(value) for value in model['displayIDs'])
                or model['displayID'] not in model['displayIDs']
                or model.get('sourceURL') != f'https://www.wowhead.com/classic/npc={entry}?env=4'
                or not checksum(model.get('sourceSHA256'))):
            raise GuideError(f'Missing or mismatched own SoD NPC metadata for {name}')
        xy = transform(pins[name]['percent'], coefficients)
        if not all(finite(value) and abs(value) < 20000 for value in xy):
            raise GuideError('Invalid projected native coordinate')
        result.append({'id': f'guide-bfd-{entry}', 'entry': entry, 'name': name,
                       'displayID': model['displayID'], 'displayIDs': model['displayIDs'], 'boss': True,
                       'sourcePercent': pins[name]['percent'],
                       'position': [*(round(value, 4) for value in xy), None], 'facing': None,
                       'kind': 'guide-reference', 'positionPrecision': 'guide-icon-approximate',
                       'heightSource': 'unknown', 'facingSource': 'unknown',
                       'sourceURL': guide['sourceURL'], 'sourceSHA256': guide['sourceSHA256'],
                       'displaySourceURL': model['sourceURL'], 'displaySourceSHA256': model['sourceSHA256']})
    return {'schema': 1, 'provider': 'Wowhead SoD raid guide', 'ruleset': 'sod',
            'sourceURL': guide['sourceURL'], 'sourceSHA256': guide['sourceSHA256'],
            'sourceEntrancePercent': pins['Entrance']['percent'],
            'coordinateSemantics': 'Approximate guide icon locations registered to shared Classic rooms; not server spawn coordinates. Native Z and facing are unknown.',
            'registration': {'nativeMap': 48, 'mapperZone': 719, 'mapperFloor': 0, 'mapperPhase': 0,
                             'method': 'equal-weight least-squares affine',
                             'inputBasis': ['1', 'percentX', 'percentY'],
                             'coefficients': coefficients, 'anchors': anchors,
                             'maxResidualYards': round(max(residuals), 6),
                             'medianResidualYards': round(median(residuals), 6),
                             'residualSemantics': 'Anchor-fit residuals only, not a bound on actual SoD NPC placement error.',
                             'referenceSourceURL': baseline['sourceURL'],
                             'referenceSourceSHA256': baseline['sourceSHA256']},
            'maps': {'48': result}}


def catalog_inputs(catalog):
    """Recover reviewed source facts, never fitted coordinates, from a shipped catalog."""
    if (not isinstance(catalog, dict) or catalog.get('schema') != 1
            or catalog.get('ruleset') != 'sod' or catalog.get('provider') != 'Wowhead SoD raid guide'
            or catalog.get('sourceURL') != GUIDE_URL or not checksum(catalog.get('sourceSHA256'))
            or not isinstance(catalog.get('maps'), dict) or set(catalog['maps']) != {'48'}
            or not isinstance(catalog['maps']['48'], list) or len(catalog['maps']['48']) != len(BOSSES)):
        raise GuideError('Expected the reviewed seven-boss SoD BFD numeric guide catalog')
    registration = catalog.get('registration')
    if (not isinstance(registration, dict) or registration.get('nativeMap') != 48
            or registration.get('mapperZone') != 719 or registration.get('mapperFloor') != 0
            or registration.get('mapperPhase') != 0):
        raise GuideError('Incompatible catalog registration map, zone or floor')
    pins = [{'label': 'Entrance', 'percent': catalog.get('sourceEntrancePercent'), 'type': 0}]
    creatures, names = {}, set()
    for row in catalog['maps']['48']:
        if (not isinstance(row, dict) or row.get('name') not in BOSSES
                or row['name'] in names or row.get('entry') != BOSSES[row['name']]
                or row.get('kind') != 'guide-reference'
                or row.get('positionPrecision') != 'guide-icon-approximate'
                or row.get('sourceURL') != catalog['sourceURL']
                or row.get('sourceSHA256') != catalog['sourceSHA256']):
            raise GuideError('Invalid or duplicate catalog boss identity or guide provenance')
        name, entry = row['name'], row['entry']
        names.add(name)
        pins.append({'label': name, 'percent': row.get('sourcePercent'), 'type': 4})
        creatures[str(entry)] = {'name': name, 'displayID': row.get('displayID'),
                                 'displayIDs': row.get('displayIDs'),
                                 'sourceURL': row.get('displaySourceURL'),
                                 'sourceSHA256': row.get('displaySourceSHA256')}
    guide = {'sourceURL': catalog['sourceURL'], 'sourceSHA256': catalog['sourceSHA256'],
             'ruleset': 'sod', 'nativeMap': 48, 'mapperZone': 719, 'mapperFloor': 0,
             'mapperPhase': 0, 'pins': pins}
    models = {'schema': 1, 'provider': 'Wowhead', 'versions': {'sod': {'creatures': creatures}}}
    return guide, models


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument('--source-dir', type=Path,
                         help='Directory containing bfd-guide-pins.json and bfd-npc-models.json')
    sources.add_argument('--source-catalog', type=Path,
                         help='Reviewed shipped catalog retaining original sourcePercent and own NPC metadata')
    parser.add_argument('--baseline', required=True, type=Path,
                        help='Reviewed numeric classic-dungeons.json registration reference')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text(encoding='utf-8'))
    if args.source_catalog:
        guide, models = catalog_inputs(read(args.source_catalog))
    else:
        guide, models = read(args.source_dir / 'bfd-guide-pins.json'), read(args.source_dir / 'bfd-npc-models.json')
    output = project(guide, models, read(args.baseline))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, separators=(',', ':'), ensure_ascii=True) + '\n', encoding='utf-8')
    print(json.dumps({'map': 48, 'guideReferences': len(output['maps']['48']),
                      'maxAnchorResidualYards': output['registration']['maxResidualYards'],
                      'medianAnchorResidualYards': output['registration']['medianResidualYards']}))


if __name__ == '__main__':
    main()
