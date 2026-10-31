"""Read Classic lighting into the original renderer's atmosphere sampler.

WoWDBDefs supplies names/layouts. No install data is shipped. Modern LightData
stores the old bands at common time keys; keep those authored packed colours and
half-minute times, without baking a selected raid or noon-only atmosphere.
"""
import math
import struct
from classic_db2 import DB2Error, decode, f32, unpack
from classic_spells import read_tables

TABLES = ['Light', 'LightParams', 'LightData', 'LightSkybox']
LAYOUTS = {'Light': '5f16bc84', 'LightParams': '51c96bad',
           'LightData': '70c6cd80', 'LightSkybox': '9d4956ff'}
COLOR_FIELDS = ['DirectColor', 'AmbientColor', 'SkyTopColor', 'SkyMiddleColor',
                'SkyBand1Color', 'SkyBand2Color', 'SkySmogColor', 'SkyFogColor',
                'ShadowOpacity', 'SunColor', 'CloudSunColor', 'CloudLayer1AmbientColor',
                'CloudEmissiveColor', 'CloudLayer2AmbientColor', 'OceanCloseColor',
                'OceanFarColor', 'RiverCloseColor', 'RiverFarColor']


def number(value):
    value = f32(value)
    if not math.isfinite(value):
        raise DB2Error('Non-finite authored lighting value.')
    return value


def skybox_names(data):
    """The pinned WDC5 Name is an inline relative string offset, not a file ID."""
    layout, rows = decode(data)
    if layout != LAYOUTS['LightSkybox']:
        raise DB2Error('Unsupported LightSkybox layout.')
    record_size = unpack(data, '<I', 144)[0]
    section_count = unpack(data, '<I', 200)[0]
    result = {}
    for index in range(section_count):
        key, offset, count, string_size, _, id_size, _, _, copy_count = unpack(data, '<Q8I', 204 + index*40)
        if key or copy_count or id_size != count*4:
            raise DB2Error('Unsupported LightSkybox string section.')
        string_start, string_end = offset + count*record_size, offset + count*record_size + string_size
        for i in range(count):
            row_id = unpack(data, '<I', string_end + i*4)[0]
            relative = unpack(data, '<i', offset + i*record_size)[0]
            start = offset + i*record_size + relative
            if not string_start <= start < string_end:
                raise DB2Error('LightSkybox Name is outside its string table.')
            end = data.find(b'\0', start, string_end)
            if end < 0:
                raise DB2Error('Unterminated LightSkybox Name.')
            try:
                path = data[start:end].decode('utf-8').replace('\\', '/')
            except UnicodeError as error:
                raise DB2Error('Invalid LightSkybox Name.') from error
            if not path or '..' in path.split('/') or ':' in path:
                raise DB2Error('Invalid LightSkybox model path.')
            result[row_id] = path.rsplit('.', 1)[0] + '.m2'
    if set(result) != set(rows):
        raise DB2Error('LightSkybox names do not cover the table.')
    return result


def lighting_catalog(read, source):
    raw = {name: read('dbfilesclient/' + name.lower() + '.db2') for name in TABLES}
    tables, layouts = read_tables(lambda path: raw[next(n for n in TABLES if path.endswith(n.lower()+'.db2'))], TABLES)
    if layouts != LAYOUTS:
        raise DB2Error('Unsupported Classic lighting layouts. Update pinned definitions explicitly.')
    skyboxes = skybox_names(raw['LightSkybox'])
    params = []
    for key, row in tables['LightParams'].items():
        params.append({'id': key, 'glow': number(row['Glow']), 'highlightSky': bool(row['HighlightSky']),
                       'waterAlpha': [number(row[n]) for n in ['WaterShallowAlpha', 'WaterDeepAlpha', 'OceanShallowAlpha', 'OceanDeepAlpha']],
                       'skybox': row['LightSkyboxID']})
    lights = []
    for key, row in tables['Light'].items():
        slots = row['LightParamsID']
        if len(slots) != 4 or slots[3]:
            raise DB2Error('Unsupported Classic Light parameter slots.')
        # Modern [clear, storm, death, unused] omits the old underwater links.
        # Missing links stay unknown. The adapter explicitly chooses the surface
        # profile for these unsupported slots; this is not authored underwater data.
        lights.append({'id': key, 'map': row['ContinentID'],
                       'position': [number(v) for v in row['GameCoords']],
                       'falloffStart': number(row['GameFalloffStart']),
                       'falloffEnd': number(row['GameFalloffEnd']),
                       'params': [slots[0], None, slots[1], None, slots[2]]})
    samples = []
    for key, row in tables['LightData'].items():
        if not 0 <= row['Time'] < 2880:
            raise DB2Error('Invalid LightData half-minute time.')
        samples.append({'id': key, 'param': row['LightParamID'], 'time': row['Time'],
                        'colors': [row[n] & 0xffffffff for n in COLOR_FIELDS],
                        'fogEnd': number(row['FogEnd']), 'fogStart': number(row['FogScaler']),
                        'cloudDensity': number(row['CloudDensity'])})
    return {'schema': 1, 'source': source, 'layouts': layouts, 'lights': lights,
            'params': params, 'samples': samples,
            'skyboxes': [{'id': key, 'path': value} for key, value in skyboxes.items()],
            'coverage': {'underwaterProfileLinks': False,
                         'underwaterPolicy': 'surface-profile',
                         'reason': 'Modern Light omits the original clear/storm underwater profile links.',
                         'timeKeys': 'Modern authored common LightData keys; original interpolation retained.'}}
