"""On-demand world conversion and tactical geometry from one local modern client.

The reader callback is the only source of game bytes. This module has no native
storage, HTTP, old-client fallback or output files. Conversion follows the modern
WDT/WMO adapters in classic-serve.py and the shared classic_terrain adapter.
Coordinates follow benilla-assets/coords.rs and benilla-formats/terrain.rs.
"""
import math
import re
import struct

from classic_compat import CompatError, read, span
from classic_db2 import decode
from classic_table_strings import named_table
from classic_terrain import adapt_adt, chunk, chunks

TILE = 1600 / 3
CENTER = 32 * TILE
MAX_TILES = 128
MAX_GROUPS = 2048
MAX_TRIANGLES = 500_000


def parts(data):
    result = {}
    for tag, body in chunks(data):
        if tag in result:
            raise CompatError('Duplicate world chunk: ' + tag)
        result[tag] = body
    return result


def pack(parts):
    return b''.join(chunk(tag, body) for tag, body in parts.items())


def records(data, stride):
    if len(data) % stride:
        raise CompatError('Misaligned world record table')
    return range(0, len(data), stride)


def text(blob, offset):
    end = blob.find(b'\0', offset)
    if offset < 0 or end < offset:
        raise CompatError('Invalid world string offset')
    return blob[offset:end].decode('utf-8', errors='replace')


def adapt_wdt(data):
    value = parts(data)
    if value.get('MODF') and not value.get('MWMO'):
        modf, names = bytearray(value['MODF']), bytearray()
        for pos in records(modf, 64):
            fdid = read(modf, '<I', pos)[0]
            if not 0 < fdid < 0xffffffff:
                raise CompatError('Invalid global WMO file ID')
            struct.pack_into('<I', modf, pos, len(names))
            names.extend(f'__classic/{fdid}.wmo\0'.encode())
        value['MWMO'], value['MODF'] = bytes(names), bytes(modf)
    return pack(value)


def adapt_wmo(data):
    value = parts(data)
    if 'MOHD' not in value:
        return adapt_wmo_group(data, value)
    if not value.get('MOTX'):
        strings, materials = bytearray(), bytearray(value.get('MOMT', b''))
        for pos in records(materials, 64):
            for field in (12, 24, 36):
                fdid = read(materials, '<I', pos + field)[0]
                struct.pack_into('<I', materials, pos + field, len(strings))
                strings.extend((f'__classic/{fdid}.blp' if fdid else '').encode() + b'\0')
        value['MOTX'], value['MOMT'] = bytes(strings), bytes(materials)
    if 'MODI' in value:
        strings, offsets = bytearray(), []
        for pos in records(value['MODI'], 4):
            fdid = read(value['MODI'], '<I', pos)[0]
            offsets.append(len(strings))
            strings.extend(f'__classic/{fdid}.m2\0'.encode())
        doodads = bytearray(value.get('MODD', b''))
        for pos in records(doodads, 40):
            name_flags = read(doodads, '<I', pos)[0]
            index = name_flags & 0xffffff
            if index >= len(offsets):
                raise CompatError('Invalid WMO doodad model index')
            struct.pack_into('<I', doodads, pos, (name_flags & 0xff000000) | offsets[index])
        value['MODN'], value['MODD'] = bytes(strings), bytes(doodads)
    return pack(value)


def adapt_wmo_group(data, value):
    """Normalize representable modern triangle/batch fields for the original reader.

    MPY2 has uint16 flags/material, and MOBA flag 0x2 selects its uint16 material
    at offset 10. Wire definitions: wowlib's WMO group-chunks reference. Keep
    the source chunks; reject fields that cannot retain their original meaning.
    """
    if 'MOGP' not in value:
        return data
    group = value['MOGP']
    if len(group) < 68:
        raise CompatError('Truncated WMO group header')
    children = list(chunks(group[68:]))
    geometry = {}
    for tag, body in children:
        if tag in ('MOPY', 'MPY2', 'MOVI', 'MOVT', 'MOBA'):
            if tag in geometry:
                raise CompatError('Duplicate WMO geometry chunk: ' + tag)
            geometry[tag] = body
    batches = bytearray(geometry.get('MOBA', b''))
    modern_batches = [p for p in records(batches, 24) if batches[p+22] & 2]
    if 'MPY2' not in geometry and not modern_batches:
        return data
    indices = geometry.get('MOVI', b'')
    vertices = geometry.get('MOVT', b'')
    records(indices, 6)
    records(vertices, 12)
    if any(index >= len(vertices)//12 for (index,) in struct.iter_unpack('<H', indices)):
        raise CompatError('WMO triangle index exceeds vertices')
    if 'MPY2' in geometry:
        source = geometry['MPY2']
        records(source, 4)
        if len(source)//4 != len(indices)//6:
            raise CompatError('WMO MPY2 triangle metadata count mismatch')
        legacy = bytearray()
        for flags, material in struct.iter_unpack('<HH', source):
            if flags > 0xff:
                raise CompatError('WMO MPY2 flags exceed original triangle format')
            if material == 0xffff and flags & 8 and not flags & 0x20:
                material = 0xff  # The no-material sentinel of a collision-only face.
            if material > 0xff:
                raise CompatError('WMO MPY2 material exceeds original triangle format')
            legacy.extend((flags, material))
        if 'MOPY' in geometry and geometry['MOPY'] != legacy:
            raise CompatError('Conflicting WMO MOPY and MPY2 triangle metadata')
        geometry['MOPY'] = bytes(legacy)
    if len(geometry.get('MOPY', b'')) != len(indices)//3:
        raise CompatError('WMO triangle metadata count mismatch')
    for pos in modern_batches:
        material = read(batches, '<H', pos+10)[0]
        start, count = read(batches, '<I', pos+12)[0], read(batches, '<H', pos+16)[0]
        if material > 0xff:
            raise CompatError('WMO batch material exceeds original batch format')
        if start % 3 or count % 3 or start+count > len(indices)//2:
            raise CompatError('Invalid WMO batch triangle range')
        batches[pos+22] &= ~2
        batches[pos+23] = material
    if modern_batches:
        geometry['MOBA'] = bytes(batches)
    # UV/color layers can repeat legitimately; preserve their order and bytes.
    children = [(tag, geometry.get(tag, body)) for tag, body in children]
    if 'MPY2' in geometry and not any(tag == 'MOPY' for tag, _ in children):
        children.append(('MOPY', geometry['MOPY']))
    value['MOGP'] = group[:68] + b''.join(chunk(tag, body) for tag, body in children)
    return pack(value)


def world_name(value):
    if not isinstance(value, str) or len(value) > 512:
        raise CompatError('Invalid world resource')
    name = value.replace('\\', '/').lower()
    if any(p in ('', '.', '..') for p in name.split('/')):
        raise CompatError('Invalid world resource')
    if not re.fullmatch(r'(?:world/(?:maps|wmo)/[^\x00:*?]+|__classic/[1-9]\d*(?:_\d{3})?)\.(?:wdt|adt|wmo)', name):
        raise CompatError('World resource is outside the raid scope')
    return name


def rotate(point, degrees):
    """Exact raw-WoW form of coords.rs placement_rotation, including tilted objects."""
    rx, ry, rz = map(math.radians, degrees)
    def x(p, a):
        c, s = math.cos(a), math.sin(a)
        return [p[0], c*p[1]-s*p[2], s*p[1]+c*p[2]]
    def y(p, a):
        c, s = math.cos(a), math.sin(a)
        return [c*p[0]+s*p[2], p[1], -s*p[0]+c*p[2]]
    def z(p, a):
        c, s = math.cos(a), math.sin(a)
        return [c*p[0]-s*p[1], s*p[0]+c*p[1], p[2]]
    return x(y(z(x(point, rz-math.pi/2), -rx), ry-math.pi), math.pi/2)


def transform(point, position, rotation):
    return [p + o for p, o in zip(rotate(point, rotation), position)]


def floor_face(triangle):
    a, b, c = triangle
    ab, ac = [b[i]-a[i] for i in range(3)], [c[i]-a[i] for i in range(3)]
    n = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
    length = math.sqrt(sum(v*v for v in n))
    return length > 1e-8 and n[2] / length >= .45


class World:
    def __init__(self, local_read):
        self.raw = local_read
        self.liquid_types = None
        self.translations = None
        self.translations_loaded = False
        self.wmo_minimaps = None
        self.map_files = {}

    def set_maps(self, rows):
        """Resolve filename-free clients through their actual Map table IDs."""
        selected = {}
        for row in rows:
            directory, file_id = row.get('Directory'), row.get('WdtFileDataID')
            if not isinstance(directory, str) or not re.fullmatch(r"[A-Za-z0-9 _'-]{1,128}", directory):
                raise CompatError('Invalid client map directory')
            if file_id == 0 and type(file_id) is int:
                continue  # An authored zero means this map has no WDT reference.
            if not isinstance(file_id, int) or isinstance(file_id, bool) or not 0 < file_id < 0xffffffff:
                raise CompatError('Invalid client WDT file ID')
            key = directory.lower()
            if key in selected and selected[key] != file_id:
                raise CompatError('Conflicting client WDT file IDs')
            selected[key] = file_id
        self.map_files = selected

    def source(self, name):
        map_file = re.fullmatch(r'world/maps/([^/]+)/([^/]+)\.wdt', name, flags=re.I)
        if map_file and map_file[1].lower() == map_file[2].lower():
            file_id = self.map_files.get(map_file[1].lower())
            if file_id:
                return 'id:' + str(file_id)
        match = re.fullmatch(r'__classic/([1-9]\d*)(?:_(\d{3}))?\.wmo', name)
        if not match:
            return name
        fdid, group = match.groups()
        if int(fdid) >= 0xffffffff:
            raise CompatError('Invalid WMO file ID')
        if group is None:
            return 'id:' + fdid
        root = parts(self.raw('id:' + fdid))
        groups = root.get('GFID', b'')
        count = read(root['MOHD'], '<I', 4)[0]
        index = int(group)
        if index >= count:
            raise CompatError('WMO group index outside GFID')
        group_id = read(groups, '<I', index * 4)[0]
        if not 0 < group_id < 0xffffffff:
            raise CompatError('Missing modern WMO group file ID')
        return 'id:' + str(group_id)

    def wdt(self, directory):
        return parts(self.raw(self.source(f'world/maps/{directory}/{directory}.wdt')))

    def terrain_ids(self, wdt, x, y):
        if not 0 <= x < 64 or not 0 <= y < 64:
            raise CompatError('Terrain coordinates outside WDT')
        if not read(wdt['MAIN'], '<I', (y*64+x)*8)[0] & 1:
            raise CompatError('Terrain tile is absent in selected WDT')
        return read(wdt['MAID'], '<8I', (y*64+x)*32)

    def resource(self, resource):
        name = world_name(resource)
        if name.endswith('.adt'):
            match = re.fullmatch(r'world/maps/([^/]+)/([^/]+)_(\d+)_(\d+)\.adt', name)
            if not match or match[1] != match[2]:
                raise CompatError('Invalid terrain tile request')
            directory, _, x, y = match.groups()
            wdt = self.wdt(directory)
            ids = self.terrain_ids(wdt, int(x), int(y))
            if not all(ids[i] for i in (0, 1, 3)):
                raise CompatError('Missing split terrain file IDs')
            if self.liquid_types is None:
                layout, rows = decode(self.raw('dbfilesclient/liquidtype.db2'))
                if layout != 'd1eceec9':
                    raise CompatError('Unsupported LiquidType layout')
                self.liquid_types = {key: row[3] for key, row in rows.items()}
            return adapt_adt(self.raw(f'id:{ids[0]}'), self.raw(f'id:{ids[3]}'),
                             self.raw(f'id:{ids[1]}'), bool(read(wdt['MPHD'], '<I', 0)[0] & 4), self.liquid_types)
        data = self.raw(self.source(name))
        return adapt_wdt(data) if name.endswith('.wdt') else adapt_wmo(data)

    def optional(self, resource):
        try:
            return self.raw(resource)
        except Exception:
            return None  # Only optional local minimap art may be absent.

    def minimap(self, logical):
        if not self.translations_loaded:
            self.translations_loaded = True
            data = self.optional('textures/minimap/md5translate.trs')
            self.translations = {}
            if data:
                for line in data.decode(errors='replace').splitlines():
                    if '\t' in line:
                        key, value = line.split('\t', 1)
                        value = value.strip().lower()
                        if re.fullmatch(r'[a-z0-9_.-]+\.blp', value):
                            self.translations[key.replace('\\', '/').lower()] = value
        hashed = self.translations.get(logical.lower())
        candidates = ['textures/minimap/' + hashed] if hashed else []
        # Some modern roots retain logical names without the translation table.
        candidates.append('textures/minimap/' + logical.lower())
        for resource in candidates:
            if self.optional(resource):
                return resource
        return None

    def wmo_minimap(self, wmo_id, group, col, row):
        """Modern WMO tiles retain placement identity in DB2 after names/TRS disappear."""
        if self.wmo_minimaps is None:
            data = self.raw('dbfilesclient/wmominimaptexture.db2')
            rows, layout = named_table(data, 'WMOMinimapTexture')
            if layout != '01230a50':
                raise CompatError('Unsupported WMOMinimapTexture layout')
            index = {}
            for value in rows.values():
                key = tuple(value[field] for field in ('WMOID', 'GroupNum', 'BlockX', 'BlockY'))
                file = value['FileDataID']
                if not (0 < key[0] < 0xffffffff and 0 <= key[1] <= 0xffff
                        and all(0 <= n <= 0xff for n in key[2:]) and 0 < file < 0xffffffff):
                    raise CompatError('Invalid WMO minimap tile reference')
                # Copy rows can repeat an identical tile. Retain true conflicts
                # as ambiguous keys; an unrelated WMO must remain usable.
                index[key] = file if key not in index or index[key] == file else None
            self.wmo_minimaps = index
        file = self.wmo_minimaps.get((wmo_id, group, col, row))
        if file is None and (wmo_id, group, col, row) in self.wmo_minimaps:
            raise CompatError('Ambiguous WMO minimap tile reference')
        if file is None:
            return None
        resource = f'id:{file}'
        self.raw(resource)  # An authored reference whose file is missing is an explicit error.
        return resource

    def map(self, map_id, directory):
        if type(map_id) is not int or not 0 < map_id < 0xffffffff:
            raise CompatError('Invalid selected map ID')
        if not isinstance(directory, str) or not re.fullmatch(r"[A-Za-z0-9_ '\-]{1,100}", directory):
            raise CompatError('Invalid selected map directory')
        directory = directory.lower()
        wdt = self.wdt(directory)
        cells = [(x, y) for y in range(64) for x in range(64)
                 if read(wdt['MAIN'], '<I', (y*64+x)*8)[0] & 1]
        if len(cells) > MAX_TILES:
            raise CompatError('Selected raid exceeds tactical terrain budget')
        areas, tiles, floors, placements = [], [], [], {}
        triangles = 0

        def add_floor(area, vertices, indices, interior=False):
            nonlocal triangles
            if not indices:
                return
            triangles += len(indices) // 3
            if triangles > MAX_TRIANGLES:
                raise CompatError('Selected raid exceeds tactical floor budget')
            if any(not all(math.isfinite(v) and abs(v) < 1e6 for v in p) for p in vertices):
                raise CompatError('Invalid world floor coordinate')
            floors.append({'area': area, 'vertices': vertices, 'indices': indices, 'interior': interior})

        def add_placements(value, global_wmo=False):
            names, indices = value.get('MWMO', b''), value.get('MWID', b'')
            for p in records(value.get('MODF', b''), 64):
                blob = value['MODF']
                name_id, uid = read(blob, '<2I', p)
                if global_wmo:
                    name = text(names, name_id)
                else:
                    name = text(names, read(indices, '<I', name_id*4)[0])
                pos, rot = read(blob, '<3f', p+8), read(blob, '<3f', p+20)
                if not global_wmo:
                    pos = [CENTER-pos[2], CENTER-pos[0], pos[1]]
                # One placement commonly occurs in several adjacent object ADTs.
                placements[uid] = (world_name(name), pos, rot)

        if read(wdt['MPHD'], '<I', 0)[0] & 1:
            add_placements(parts(adapt_wdt(pack(wdt))), True)
        terrain_heights = []
        for x, y in cells:
            ids = self.terrain_ids(wdt, x, y)
            if not ids[0] or not ids[1]:
                raise CompatError('Missing selected terrain geometry/object file IDs')
            root, obj = self.raw(f'id:{ids[0]}'), self.raw(f'id:{ids[1]}')
            # Only object filename/placement conversion is needed by metadata.
            obj_parts = dict((tag, body) for tag, body in chunks(obj) if tag != 'MCNK')
            modf = bytearray(obj_parts.get('MODF', b''))
            strings, offsets = bytearray(), bytearray()
            for p in records(modf, 64):
                name_id, flags = read(modf, '<I', p)[0], read(modf, '<H', p+56)[0]
                name = f'__classic/{name_id}.wmo' if flags & 8 else text(obj_parts.get('MWMO', b''), read(obj_parts.get('MWID', b''), '<I', name_id*4)[0])
                struct.pack_into('<I', modf, p, len(offsets)//4)
                offsets.extend(struct.pack('<I', len(strings)))
                strings.extend(name.encode()+b'\0')
            add_placements({'MWMO': bytes(strings), 'MWID': bytes(offsets), 'MODF': bytes(modf)})
            vertices, indices = terrain_floor(root)
            terrain_heights.extend(p[2] for p in vertices)
            add_floor('terrain', vertices, indices)
            if ids[7] and self.optional(f'id:{ids[7]}'):
                north, west = (32-y)*TILE, (32-x)*TILE
                tiles.append({'resource': f'id:{ids[7]}', 'corners': [[north, west], [north, west-TILE], [north-TILE, west-TILE], [north-TILE, west]], 'area': 'terrain'})
        if terrain_heights:
            areas.append({'id': 'terrain', 'name': 'Terrain', 'height': sum(terrain_heights)/len(terrain_heights)})
        group_count = 0
        for uid, (path, position, rotation) in placements.items():
            root = parts(self.resource(path))
            count = read(root['MOHD'], '<I', 4)[0]
            group_count += count
            if group_count > MAX_GROUPS:
                raise CompatError('Selected raid exceeds tactical WMO group budget')
            group_info, names = root.get('MOGI', b''), root.get('MOGN', b'')
            if len(group_info) != count*32:
                raise CompatError('WMO group metadata count mismatch')
            stem = path.removeprefix('world/').removesuffix('.wmo')
            wmo_id = read(root['MOHD'], '<I', 32)[0]
            for group in range(count):
                record = group*32
                lo, hi = read(group_info, '<3f', record+4), read(group_info, '<3f', record+16)
                offset = read(group_info, '<i', record+28)[0]
                label = text(names, offset) if 0 <= offset < len(names) else ''
                area = f'{uid}:{group}'
                data = self.resource(path[:-4] + f'_{group:03}.wmo')
                vertices, indices = wmo_floor(data, position, rotation)
                add_floor(area, vertices, indices, bool(read(group_info, '<I', record)[0] & 0x2000))
                before = len(tiles)
                # Same minimap grid and U/V orientation as planner-map-art.py.
                nx, dx = minimap_grid(hi[0]-lo[0])
                ny, dy = minimap_grid(hi[1]-lo[1])
                if nx*ny > 4096:
                    raise CompatError('WMO minimap extent exceeds budget')
                for col in range(nx):
                    for row in range(ny):
                        resource = self.wmo_minimap(wmo_id, group, col, row) if wmo_id else None
                        if resource is None:
                            resource = self.minimap(f'{stem}_{group:03}_{col:02}_{row:02}.blp')
                        if resource:
                            x, y = lo[0]+col*dx, lo[1]+row*dy
                            corners = [transform([a, b, lo[2]], position, rotation)[:2] for a, b in [(x, y+dy), (x+dx, y+dy), (x+dx, y), (x, y)]]
                            tiles.append({'resource': resource, 'corners': corners, 'area': area, 'cell': [col, row]})
                if indices or len(tiles) > before:
                    height = sum(p[2] for p in vertices)/len(vertices) if vertices else transform([(lo[i]+hi[i])/2 for i in range(3)], position, rotation)[2]
                    areas.append({'id': area, 'name': label or f'Area {group+1}', 'height': height})
        points = [p for tile in tiles for p in tile['corners']] + [p for floor in floors for p in floor['vertices']]
        if not points or not areas:
            raise CompatError('Selected raid has no available local minimap or floor geometry')
        bounds = [min(-p[1] for p in points), min(-p[0] for p in points), max(-p[1] for p in points), max(-p[0] for p in points)]
        return {'map': map_id, 'bounds': bounds, 'areas': areas, 'tiles': tiles, 'floors': floors}


def minimap_grid(extent):
    if not math.isfinite(extent) or extent < 0 or extent > 100_000:
        raise CompatError('Invalid WMO minimap extent')
    pixels = max(32, min(256, 2**math.ceil(math.log2(max(1, extent*2)))))
    return max(1, math.ceil(extent/128)), pixels*.5


def wmo_floor(data, position, rotation):
    group = parts(data).get('MOGP')
    if group is None:
        raise CompatError('Expected WMO group geometry')
    value = {}
    for tag, body in chunks(span(group, 68, len(group)-68)):
        # Modern groups can author multiple UV/color layers. Floor extraction
        # needs only geometry and collision metadata; do not collapse those
        # unrelated layers or reject a valid world because they repeat.
        if tag not in ('MOVT', 'MOVI', 'MOPY'):
            continue
        if tag in value:
            raise CompatError('Duplicate WMO floor geometry chunk: ' + tag)
        value[tag] = body
    raw_vertices, raw_indices, flags = value.get('MOVT', b''), value.get('MOVI', b''), value.get('MOPY', b'')
    local = [read(raw_vertices, '<3f', p) for p in records(raw_vertices, 12)]
    if len(flags) != len(raw_indices)//3 or len(raw_indices) % 6:
        raise CompatError('WMO triangle metadata count mismatch')
    vertices, indices, remap = [], [], {}
    for p in records(raw_indices, 6):
        if flags[p//3] & 4:  # Shared renderer walking collision rejects MOPY DETAIL.
            continue
        tri = read(raw_indices, '<3H', p)
        if any(i >= len(local) for i in tri):
            raise CompatError('WMO floor index exceeds vertices')
        placed = [transform(local[i], position, rotation) for i in tri]
        if not floor_face(placed):
            continue
        for i, point in zip(tri, placed):
            if i not in remap:
                remap[i] = len(vertices)
                vertices.append(point)
            indices.append(remap[i])
    return vertices, indices


def terrain_floor(data):
    """Bounded tactical mesh using real outer MCVT samples, conservatively keeping holes.

    One 4x4-quad cell spans 16.67 yards. Full-resolution geometry stays in world().
    No invented floor height or rectangular map replaces absent selected geometry.
    """
    vertices, indices = [], []
    for tag, body in chunks(data):
        if tag != 'MCNK':
            continue
        header, nested = span(body, 0, 128), parts(body[128:])
        if 'MCVT' not in nested:
            raise CompatError('Selected terrain has no height samples')
        heights = read(nested['MCVT'], '<145f', 0)
        wx, wy, wz = read(header, '<3f', 0x68)
        flags = read(header, '<I', 0)[0]
        holes = int.from_bytes(header[0x14:0x1c], 'little') if flags & 0x10000 else read(header, '<H', 0x3c)[0]
        base = len(vertices)
        step = TILE/128
        for row in (0, 4, 8):
            for col in (0, 4, 8):
                vertices.append([wx-row*step, wy-col*step, wz+heights[row*17+col]])
        for row in range(2):
            for col in range(2):
                if flags & 0x10000:
                    hole = any(holes & (1 << (y*8+x)) for y in range(row*4, row*4+4) for x in range(col*4, col*4+4))
                else:
                    hole = any(holes & (1 << (y*4+x)) for y in range(row*2, row*2+2) for x in range(col*2, col*2+2))
                if not hole:
                    a = base+row*3+col
                    indices.extend([a, a+3, a+1, a+1, a+3, a+4])
    if not indices:
        raise CompatError('Selected terrain contains no floor geometry')
    return vertices, indices
