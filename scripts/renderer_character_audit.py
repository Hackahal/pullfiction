"""Character/item recipe evidence for renderer-model-audit's offline full-catalog run.

The graph is factorized by actual customization choice/condition edges. Recipe
checks cover every choice, legacy conversion, related-choice pair and legal
item/body/slot selection, not every Cartesian combination of equipped items.
"""
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from classic_characters import Characters, SLOT_INVENTORIES
from classic_db2 import DB2Error


def catalog_texture_references(catalogs):
    result = defaultdict(set)
    for _, catalog in catalogs:
        for key, display in catalog.get('displays', {}).items():
            if 'modelID' in display:
                candidates = display.get('textures', [])
                extra = catalog.get('extras', {}).get(str(display.get('extraDisplayID', 0)), {})
                candidates = [*candidates, extra.get('bakeFileDataID', 0)]
            else:
                candidates = [r['file'] for slot in display.get('textures', []) for r in slot]
                candidates += [r['file'] for rows in display.get('regions', {}).values() for r in rows]
            for file in candidates:
                if type(file) is int and file > 0:
                    result[file].add('display:' + key)
    return result


def customization_graph(engine, character_catalog):
    tables = engine.tables
    bodies, model_ids = [], set()
    for body in character_catalog['bodies']:
        display = engine.creatures['displays'][body['displayId']]
        file = engine.creatures['models'][display['modelID']]['fileDataID']
        bodies.append(dict(body, file=file, creatureModelID=display['modelID']))
        model_ids.add(body['modelId'])
    options = {key: row for key, row in tables['ChrCustomizationOption'].items() if row['ChrModelID'] in model_ids}
    choices = {key: row for key, row in tables['ChrCustomizationChoice'].items() if row['ChrCustomizationOptionID'] in options}
    elements = {key: row for key, row in tables['ChrCustomizationElement'].items() if row['ChrCustomizationChoiceID'] in choices}
    materials = {row['ChrCustomizationMaterialID'] for row in elements.values() if row['ChrCustomizationMaterialID']}
    materials = {key: tables['ChrCustomizationMaterial'][key] for key in sorted(materials)}
    resources = {row['MaterialResourcesID'] for row in materials.values()}
    files = [{'file': file, 'resource': resource, 'profile': profile}
             for resource in sorted(resources) for file, profile in engine.texture_files[resource]]
    return {'bodies': bodies, 'options': options, 'choices': choices, 'elements': elements,
            'materials': materials, 'textureFiles': files,
            'proofBoundary': 'Complete available choice/conditional-material reference graph; no Cartesian outfit or visual acceptance.'}


def customization_requests(graph, catalog):
    options, choices = graph['options'], graph['choices']
    by_model = {body['modelId']: body for body in graph['bodies']}
    result = []
    for index, row in enumerate(catalog['legacyConversions']):
        look = [0] * 5
        look[row['option'] - 1] = row['data']
        if row['dependentOption']:
            look[row['dependentOption'] - 1] = row['dependentData']
        result.append(('legacy:' + str(index), {'race': row['race'], 'sex': row['sex'], 'legacyLook': look}))
    pairs = set()
    for key, choice in choices.items():
        option = options[choice['ChrCustomizationOptionID']]
        body = by_model[option['ChrModelID']]
        result.append(('choice:' + str(key), {'race': body['race'], 'sex': body['sex'],
            'choices': {str(option['ID']): key}}))
    for element in graph['elements'].values():
        a, b = element['ChrCustomizationChoiceID'], element['RelatedChrCustomizationChoiceID']
        if not b or b not in choices or (a, b) in pairs:
            continue
        pairs.add((a, b))
        oa, ob = choices[a]['ChrCustomizationOptionID'], choices[b]['ChrCustomizationOptionID']
        if oa == ob or options[oa]['ChrModelID'] != options[ob]['ChrModelID']:
            continue  # Retained in the graph as an incompatible/unreachable condition.
        body = by_model[options[oa]['ChrModelID']]
        result.append((f'related:{a}:{b}', {'race': body['race'], 'sex': body['sex'], 'choices': {str(oa): a, str(ob): b}}))
    return result


def run(storage, source, catalogs, output, inspect_asset, asset_error):
    source_files = {}
    def read(name):
        raw = storage.read(name)
        if not name.startswith('id:'):
            source_files[name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        return raw
    engine = Characters(read, source)
    characters = next(c for _, c in catalogs if 'legacyConversions' in c)
    items = next(c for _, c in catalogs if 'items' in c)
    all_items = {**items.get('unresolvedItems', {}), **items['items']}
    graph = customization_graph(engine, characters)
    (output / 'character-graph.json').write_text(json.dumps(graph, separators=(',', ':')) + '\n')
    textures = catalog_texture_references(catalogs)
    for row in graph['textureFiles']:
        textures[row['file']].add('customization-resource:' + str(row['resource']))
    texture_status = Counter()
    with (output / 'appearance-textures.jsonl').open('w') as stream:
        for file, refs in sorted(textures.items()):
            row = {'fileDataID': file, 'references': sorted(refs)}
            try:
                raw = storage.read('id:' + str(file))
                row.update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw), status='readable')
                info, _ = inspect_asset(raw)
                row['header'] = info
                row['status'] = 'header-verified' if raw[:4] == b'BLP2' else 'unexpected-format'
            except asset_error as error:
                row.update(status='unavailable-or-invalid', error=str(error))
            texture_status[row['status']] += 1
            stream.write(json.dumps(row) + '\n')
    requests = customization_requests(graph, characters)
    recipe_status, unsupported = Counter(), Counter()
    def record(stream, key, request):
        row = {'key': key, 'request': request}
        try:
            recipe = engine.appearance(request)
            row.update(status='partial' if recipe['unsupported'] else 'resolved', body=recipe['file'],
                textures=recipe['textures'], attachments=recipe['attachments'],
                geosets=recipe['visibleGeosets'], unsupported=recipe['unsupported'])
            unsupported.update(r['type'] for r in recipe['unsupported'])
        except (asset_error, DB2Error, ValueError) as error:
            row.update(status='unavailable-or-invalid', error=str(error))
        recipe_status[row['status']] += 1
        stream.write(json.dumps(row, separators=(',', ':')) + '\n')
    with (output / 'character-recipes.jsonl').open('w') as stream:
        for key, request in requests:
            record(stream, key, request)
    character_counts = dict(recipe_status)
    recipe_status.clear()
    expected_gear = 0
    item_slots = {}
    for key, item in all_items.items():
        item_slots[key] = [slot for slot, inventories in SLOT_INVENTORIES.items() if item['inventory'] in inventories]
        expected_gear += len(item_slots[key]) * len(graph['bodies'])
    with (output / 'gear-recipes.jsonl').open('w') as stream:
        for key, slots in item_slots.items():
            for slot in slots:
                for body in graph['bodies']:
                    record(stream, f"item:{key}:{slot}:{body['race']}:{body['sex']}",
                        {'race': body['race'], 'sex': body['sex'], 'legacyLook': [0]*5,
                         'gear': [{'id': int(key), 'slot': slot}]})
    result = {'source': source, 'sourceTables': source_files,
        'characterBodiesExpected': len(graph['bodies']), 'legacyConversionRowsExpected': len(characters['legacyConversions']),
        'customizationChoicesExpected': len(graph['choices']), 'customizationElementsMapped': len(graph['elements']),
        'characterRecipesExpected': len(requests), 'characterRecipesProcessed': sum(character_counts.values()),
        'characterRecipeStatus': character_counts, 'gearItemsExpected': len(all_items),
        'gearItemsWithDefaultAppearance': len(items['items']),
        'gearItemsWithoutDefaultAppearance': len(items.get('unresolvedItems', {})),
        'gearItemsWithVisualSlots': sum(bool(v) for v in item_slots.values()),
        'gearItemsWithoutVisualSlots': sum(not v for v in item_slots.values()),
        'gearRecipesExpected': expected_gear, 'gearRecipesProcessed': sum(recipe_status.values()),
        'gearRecipeStatus': dict(recipe_status), 'unsupportedReasons': dict(unsupported),
        'textureFilesExpected': len(textures), 'textureFilesProcessed': sum(texture_status.values()),
        'textureStatus': dict(texture_status), 'gpuExecution': 'unverified', 'visualApproval': 'unverified',
        'proofBoundary': 'Production recipe selection, condition-edge coverage and offline texture-header checks; no Cartesian multi-item outfit coverage or GPU acceptance.'}
    (output / 'appearance-summary.json').write_text(json.dumps(result, indent=2) + '\n')
    return result
