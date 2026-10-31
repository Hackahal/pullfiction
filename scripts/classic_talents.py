"""Optional Classic talent metadata from the selected local client, never allocations.

Pinned WoWDBDefs describes rank spells and zero-based prerequisite ranks. Public
output uses zero-based grid cells and one-based required ranks. Icons are local
file references, not bundled textures. Missing encrypted sections stay missing.
"""
from classic_creatures import source_check
from classic_db2 import DB2Error
from classic_sections import EncryptedSectionError
from classic_table_strings import named_table

# File IDs are from the pinned WoWDBDefs manifest.json, not guessed filenames.
TABLE_IDS = {'Talent': 1369062, 'TalentTab': 2178102, 'ChrClasses': 1361031}
LAYOUTS = {'Talent': '147b0045', 'TalentTab': 'b436f3c7', 'ChrClasses': 'afc9b0c2'}


def talent_catalog(read, source, table=None):
    source_check(source)
    tables, layouts, coverage, unavailable = {}, {}, {}, []
    for name, file_id in TABLE_IDS.items():
        try:
            if table is None:
                rows, layout = named_table(read('id:' + str(file_id)), name)
                report = {'complete': True, 'includedRecords': len(rows)}
            else:
                result = table(name)
                rows = {row['ID']: row for row in result['rows']}
                layout, report = result['layout'], result['coverage']
            if layout != LAYOUTS[name]:
                raise DB2Error(f'Unsupported {name} talent layout {layout}; expected {LAYOUTS[name]}.')
            tables[name], layouts[name], coverage[name] = rows, layout, report
        except EncryptedSectionError:
            tables[name] = {}
            coverage[name] = {'complete': False, 'includedRecords': 0}
            unavailable.append(name)
    complete = all(report['complete'] for report in coverage.values())
    trees = []
    for row in tables['TalentTab'].values():
        mask = row['ClassMask']
        classes = [key for key in tables['ChrClasses'] if 1 <= key <= 32 and mask & (1 << (key - 1))]
        if len(classes) != 1:
            if not coverage['ChrClasses']['complete']:
                continue
            raise DB2Error('Talent tab must identify exactly one readable player class.')
        if not isinstance(row['Name_lang'], str) or not row['Name_lang'] or not 0 <= row['OrderIndex'] <= 2:
            raise DB2Error('Invalid Classic talent tab name or order.')
        trees.append({'id': row['ID'], 'classId': classes[0], 'name': row['Name_lang'],
                      'icon': 'id:' + str(row['SpellIconID']) if row['SpellIconID'] > 0 else '',
                      'order': row['OrderIndex'], 'nodes': []})
    by_id = {tree['id']: tree for tree in trees}
    for row in tables['Talent'].values():
        tree = by_id.get(row['TabID'])
        if tree is None:
            if not complete:
                continue
            raise DB2Error('Talent node names an absent tree.')
        ranks = row['SpellRank']
        populated = [value for value in ranks if value]
        if (row['ClassID'] != tree['classId'] or not 0 <= row['TierID'] <= 6 or
                not 0 <= row['ColumnIndex'] < 4 or not 1 <= len(populated) <= 5 or
                ranks[:len(populated)] != populated or any(value <= 0 for value in populated)):
            raise DB2Error('Invalid Classic talent node class, grid or rank spells.')
        prerequisites = [{'id': key, 'rank': rank + 1}
                         for key, rank in zip(row['PrereqTalent'], row['PrereqRank']) if key]
        tree['nodes'].append({'id': row['ID'], 'row': row['TierID'], 'column': row['ColumnIndex'],
                              'maxRank': len(populated), 'ranks': populated, 'prerequisites': prerequisites})
    for tree in trees:
        nodes = {node['id']: node for node in tree['nodes']}
        cells = {(node['row'], node['column']) for node in tree['nodes']}
        if len(cells) != len(nodes):
            raise DB2Error('Multiple talent nodes occupy the same grid cell.')
        for node in tree['nodes']:
            for prereq in node['prerequisites']:
                parent = nodes.get(prereq['id'])
                if (parent is None and complete) or (parent is not None and not 1 <= prereq['rank'] <= parent['maxRank']):
                    raise DB2Error('Invalid talent prerequisite or required rank.')
        tree['nodes'].sort(key=lambda node: (node['row'], node['column'], node['id']))
    trees.sort(key=lambda tree: (tree['classId'], tree['order'], tree['id']))
    return {'schema': 1, 'source': source, 'layouts': layouts, 'trees': trees,
            'classes': [{'id': key, 'name': row['Name_lang']} for key, row in sorted(tables['ChrClasses'].items())],
            'readable': bool(trees), 'partial': not complete,
            'coverage': {'complete': complete, 'tables': coverage, 'unavailableTables': unavailable},
            'reason': 'Some local talent sections are encrypted or unavailable.' if not complete else ''}
