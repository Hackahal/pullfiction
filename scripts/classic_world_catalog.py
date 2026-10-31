"""Modern-only world metadata for the original catalog and renderer interfaces."""
import math
import re
from classic_db2 import DB2Error, f32
from classic_table_strings import named_table

LAYOUTS = {'Map': 'b47c6f05', 'AreaTable': '705c911d', 'WMOAreaTable': 'c5a7b977'}


def real(value):
    value = f32(value)
    if not math.isfinite(value):
        raise DB2Error('Non-finite world catalog value.')
    return value


def world_catalog(read, source):
    if (source.get('product') != 'wow_classic_era'
            or not re.fullmatch(r'1\.15\.9\.\d+', source.get('version', ''))
            or not re.fullmatch(r'[0-9a-f]{32}', source.get('buildKey', ''))):
        raise DB2Error('Unsupported world catalog source.')
    tables, layouts = {}, {}
    for name, expected in LAYOUTS.items():
        rows, layout = named_table(read('dbfilesclient/' + name.lower() + '.db2'), name)
        if layout != expected:
            raise DB2Error(f'Unsupported {name} layout {layout}. Update pinned definitions explicitly.')
        tables[name], layouts[name] = rows, layout
    maps = []
    for key, row in tables['Map'].items():
        directory = row['Directory']
        if not directory or any(c in directory for c in '/\\:\0') or directory in ('.', '..'):
            raise DB2Error('Invalid Map directory.')
        maps.append({'id': key, 'directory': directory, 'name': row['MapName_lang'],
                     'descriptions': [row['MapDescription0_lang'], row['MapDescription1_lang']],
                     'instanceType': row['InstanceType'], 'areaTableId': row['AreaTableID'],
                     'loadingScreenId': row['LoadingScreenID'], 'maxPlayers': row['MaxPlayers'],
                     'minimapIconScale': real(row['MinimapIconScale'])})
    areas = [{'id': key, 'mapId': row['ContinentID'], 'zoneId': row['ParentAreaID'],
              'exploreFlag': row['AreaBit'], 'flags': row['Flags'][0] & 0xffffffff,
              'factionGroupMask': row['FactionGroupMask'], 'explorationLevel': row['ExplorationLevel'],
              'name': row['AreaName_lang']} for key, row in tables['AreaTable'].items()]
    wmos = [{'id': key, 'wmoId': row['WMOID'], 'nameSetId': row['NameSetID'],
             'groupId': row['WMOGroupID'], 'soundProvider': [row['SoundProviderPref'], row['SoundProviderPrefUnderwater']],
             'ambience': row['AmbienceID'], 'zoneMusic': row['ZoneMusic'], 'introSound': row['IntroSound'],
             'areaTableId': row['AreaTableID'], 'name': row['AreaName_lang']}
            for key, row in tables['WMOAreaTable'].items()]
    return {'schema': 1, 'source': source, 'layouts': layouts, 'maps': maps, 'areas': areas, 'wmoAreas': wmos,
            'coverage': {'legacyBattlegroundMetadata': False,
                         'reason': 'Legacy queue brackets, queue eligibility and unnamed battlefield columns are outside the replay planner.'}}
