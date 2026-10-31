"""Strict WDC5 fixed-record decoder for the Classic asset preparation pipeline.

Field storage layout follows the public WDC5 format, independently implemented.
Names/layout hashes for the two catalogs follow wowdev/WoWDBDefs. Unknown layouts
and sparse/encrypted sections fail explicitly rather than returning partial tables.
"""
import struct


class DB2Error(ValueError):
    pass


def unpack(data, fmt, offset):
    size = struct.calcsize(fmt)
    if offset < 0 or offset + size > len(data):
        raise DB2Error('Truncated WDC5 structure.')
    return struct.unpack_from(fmt, data, offset)


def uint_array(data, count, offset):
    if count < 0 or offset < 0 or count > (len(data) - offset) // 4:
        raise DB2Error('Truncated WDC5 integer array.')
    return unpack(data, '<' + 'I' * count, offset)


def decode(data, *, relationships=False):
    if data[:4] != b'WDC5':
        raise DB2Error('Expected WDC5.')
    header = unpack(data, '<9I2H7I', 136)
    records, fields, record_size, _, _, layout, _, _, _, flags, id_index, total_fields, _, _, storage_size, common_size, palette_size, section_count = header
    if flags & 1:
        raise DB2Error('Sparse WDC5 records are not supported yet.')
    # A sectionless empty table has field descriptors but no record/storage
    # blocks. Require the exact envelope; this must not admit missing sections.
    if not any((records, record_size, storage_size, common_size, palette_size, section_count)):
        if fields != total_fields or len(data) != 204 + total_fields * 4:
            raise DB2Error('Invalid empty WDC5 envelope.')
        return f'{layout:08x}', {}
    if not record_size or storage_size != total_fields * 24 or fields != total_fields:
        raise DB2Error('Unsupported WDC5 field storage layout.')
    sections = [unpack(data, '<Q8I', 204 + i * 40) for i in range(section_count)]
    position = 204 + section_count * 40 + total_fields * 4
    storage = [unpack(data, '<HH5I', position + i * 24) for i in range(total_fields)]
    position += storage_size
    palettes, common = {}, {}
    start = position
    for i, (_, _, size, kind, *_rest) in enumerate(storage):
        if kind in (3, 4):
            if size % 4:
                raise DB2Error('Invalid WDC5 palette length.')
            palettes[i] = uint_array(data, size // 4, position)
            position += size
    if position != start + palette_size:
        raise DB2Error('WDC5 palette size mismatch.')
    start = position
    for i, (_, _, size, kind, *_rest) in enumerate(storage):
        if kind == 2:
            if size % 8:
                raise DB2Error('Invalid WDC5 common table length.')
            common[i] = dict(unpack(data, '<II', p) for p in range(position, position + size, 8))
            position += size
    if position != start + common_size:
        raise DB2Error('WDC5 common size mismatch.')

    def field(record, index, row_id):
        offset, bits, _, kind, default, _, count = storage[index]
        if kind == 2:
            return common[index].get(row_id, default)
        if offset + bits > len(record) * 8 or bits > 4096:
            raise DB2Error('WDC5 field exceeds record.')
        value = (int.from_bytes(record, 'little') >> offset) & ((1 << bits) - 1)
        if kind == 0:
            if bits > 32 and bits % 32 == 0:
                return [(value >> i) & 0xFFFFFFFF for i in range(0, bits, 32)]
            return value
        if kind == 1:
            return value
        if kind == 5:
            return value - (1 << bits) if bits and value & (1 << (bits - 1)) else value
        if kind in (3, 4):
            count = count if kind == 4 else 1
            start = value * count
            if count < 1 or start + count > len(palettes[index]):
                raise DB2Error('WDC5 palette index out of range.')
            result = list(palettes[index][start:start + count])
            return result if kind == 4 else result[0]
        raise DB2Error(f'Unknown WDC5 compression kind {kind}.')

    result, copies, read_records = {}, [], 0
    for key, offset, count, string_size, offset_end, id_size, relation_size, sparse_count, copy_count in sections:
        if key or sparse_count or offset_end:
            raise DB2Error('Encrypted or sparse WDC5 sections are not supported yet.')
        record_end = offset + count * record_size
        trailer = record_end + string_size
        if offset < position or record_end > len(data) or id_size not in (0, count * 4):
            raise DB2Error('Invalid WDC5 section bounds or ID list.')
        external_ids = uint_array(data, count, trailer) if id_size else None
        if external_ids is None and id_index >= total_fields:
            raise DB2Error('WDC5 has no valid record IDs.')
        section_ids = []
        for i in range(count):
            record = data[offset + i * record_size:offset + (i + 1) * record_size]
            row_id = external_ids[i] if external_ids is not None else field(record, id_index, 0)
            if not isinstance(row_id, int) or row_id < 0 or row_id in result:
                raise DB2Error('Duplicate or invalid WDC5 record ID.')
            result[row_id] = [field(record, column, row_id) for column in range(total_fields)]
            section_ids.append(row_id)
        trailer += id_size
        copies.extend(unpack(data, '<II', trailer + i * 8) for i in range(copy_count))
        if trailer + copy_count * 8 + relation_size > len(data):
            raise DB2Error('Truncated WDC5 section trailer.')
        if relationships:
            parents = {}
            if relation_size:
                rel = trailer + copy_count * 8
                entries, _min, _max = unpack(data, '<3I', rel)
                if relation_size != 12 + entries * 8:
                    raise DB2Error('Invalid WDC5 relationship size.')
                for j in range(entries):
                    parent, index = unpack(data, '<II', rel + 12 + j * 8)
                    if index >= count or index in parents:
                        raise DB2Error('Invalid WDC5 relationship record index.')
                    parents[index] = parent
            for index, row_id in enumerate(section_ids):
                result[row_id].append(parents.get(index, 0))
        read_records += count
    if read_records != records:
        raise DB2Error('WDC5 record count mismatch.')
    # Copy entries may reference another copy. Resolve in bounded passes and reject cycles.
    while copies:
        pending = []
        for dest, source in copies:
            if dest in result:
                raise DB2Error('Duplicate WDC5 copy ID.')
            if source not in result:
                pending.append((dest, source))
                continue
            row = result[source].copy()
            if not flags & 4:
                row[id_index] = dest
            result[dest] = row
        if len(pending) == len(copies):
            raise DB2Error('Unresolved or cyclic WDC5 copy table.')
        copies = pending
    return f'{layout:08x}', result


def f32(value):
    return struct.unpack('<f', struct.pack('<I', value))[0]


def creature_catalog(display_data, model_data):
    layout, display_rows = decode(display_data)
    model_layout, model_rows = decode(model_data)
    if (layout, model_layout) != ('f75f884c', '3ffee408'):
        raise DB2Error(f'Unsupported creature database layouts {layout}/{model_layout}.')
    models = {key: {'fileDataID': row[2], 'scale': f32(row[19]),
                    'collisionWidth': f32(row[13]), 'collisionHeight': f32(row[14]),
                    'bounds': [f32(v) for v in row[0]]} for key, row in model_rows.items()}
    displays = {key: {'modelID': row[1], 'scale': f32(row[4]), 'textures': row[25],
                      'extraDisplayID': row[7], 'portraitFileDataID': row[11]} for key, row in display_rows.items()}
    if any(r['modelID'] not in models for r in displays.values()):
        raise DB2Error('Creature display refers to an absent model record.')
    return {'displays': displays, 'models': models, 'layouts': [layout, model_layout]}
