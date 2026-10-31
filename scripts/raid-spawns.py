#!/usr/bin/env python3
"""Project numeric reference placements from a CMaNGOS Classic DB SQL snapshot.

No source SQL, game art, player records or combat logs are shipped. The source
is a pre-SoD reference, not a claim about SoD raid layouts or patrol positions.
"""
import argparse
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
import re

MAPS = (249, 309, 409, 469, 509, 531, 533)
TABLES = 'creature|creature_template|creature_spawn_entry'
TUPLE = re.compile(r"\((?:[^'()]|'(?:\\.|[^'\\])*')*\)")


def tables(path):
    result, columns, active = {}, {}, None
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as source:
        for line in source:
            match = re.match(r'CREATE TABLE `(' + TABLES + ')`', line)
            if match:
                active = match[1]
                columns[active] = []
                result[active] = []
                continue
            if active:
                if line.startswith(')'):
                    active = None
                elif line.lstrip().startswith('`'):
                    columns[active].append(line.strip().split('`')[1].lower())
            match = re.match(r'INSERT INTO `(' + TABLES + ')` VALUES ', line)
            if match:
                for row in TUPLE.finditer(line):
                    values = next(csv.reader([row[0][1:-1]], quotechar="'", escapechar='\\'))
                    if len(values) != len(columns[match[1]]):
                        raise ValueError('SQL row does not match its declared columns')
                    result[match[1]].append(dict(zip(columns[match[1]], values)))
    return result


def project(data):
    templates = {int(t['entry']): t for t in data['creature_template']}
    variants = {}
    for row in data.get('creature_spawn_entry', []):
        variants.setdefault(int(row['guid']), []).append(int(row['entry']))
    raids = {str(m): [] for m in MAPS}
    for row in data['creature']:
        map_id = int(row['map'])
        if map_id not in MAPS:
            continue
        entries = [int(row['id'])] if int(row['id']) else sorted(variants.get(int(row['guid']), []))
        # Random-entry slots use a deterministic representative, never stacked variants.
        entry = next((e for e in entries if e in templates), None)
        if entry is None:
            continue
        template = templates[entry]
        name = template['name']
        if (int(template['creaturetype']) == 8 or 'trigger' in name.lower()
                or int(template['unitflags']) & 0x02000000
                or int(template['faction']) in (31, 35, 114, 188, 190, 794, 875, 1574)
                and int(template['rank']) != 3):
            continue
        position = [round(float(row['position_' + axis]), 4) for axis in 'xyz']
        facing = round(float(row['orientation']), 5)
        if not all(math.isfinite(n) and abs(n) < 20000 for n in position + [facing]):
            raise ValueError('Invalid reference position')
        display = int(template.get('modelid1', template.get('displayid1', '0')))
        if not display:
            continue
        raids[str(map_id)].append({'id': row['guid'], 'entry': entry, 'name': name,
            'displayID': display, 'boss': int(template['rank']) == 3,
            'position': position, 'facing': facing})
    for rows in raids.values():
        rows.sort(key=lambda r: int(r['id']))
    return raids


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--source-url', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    value = {'schema': 1, 'provider': 'CMaNGOS Classic DB',
        'sourceURL': args.source_url, 'sourceSHA256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'ruleset': 'vanilla', 'maps': project(tables(args.source))}
    if not all(value['maps'].values()):
        raise ValueError('Expected reference spawns for every supported Vanilla raid')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, separators=(',', ':')) + '\n', encoding='utf-8')
    print({m: len(rows) for m, rows in value['maps'].items()})


if __name__ == '__main__':
    main()
