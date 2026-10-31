"""Strict named WDC5 rows, including inline relative strings and copy records.

Uses the repository's fixed-record decoder and pinned WoWDBDefs schemas. It does
not interpret client data, replace missing tables, or read outside the callback.
"""
from classic_db2 import DB2Error, decode, unpack
from classic_spells import DEFINITIONS, schema


def named_table(data, name):
    layout, raw = decode(data)
    fields, parent, types = schema(name, layout)
    if parent:
        _, raw = decode(data, relationships=True)
    if any(len(values) != len(fields) + bool(parent) for values in raw.values()):
        raise DB2Error(f'{name} field count disagrees with pinned schema.')
    rows = {key: dict(zip(fields, values)) for key, values in raw.items()}
    for key, row in rows.items():
        for field, (bits, signed) in types.items():
            def scalar(value):
                value &= (1 << bits) - 1
                return value - (1 << bits) if signed and value & (1 << (bits - 1)) else value
            value = row[field]
            row[field] = [scalar(v) for v in value] if isinstance(value, list) else scalar(value)
        if parent:
            row[parent] = raw[key][-1]
        row['ID'] = key
    columns = (DEFINITIONS / (name + '.dbd')).read_text().split('\n\n')[0]
    text_fields = {line.split()[1].rstrip('?') for line in columns.splitlines()
                   if line.startswith(('string ', 'locstring '))}
    text_fields = {field: index for index, field in enumerate(fields) if field in text_fields}
    if not text_fields:
        return rows, layout
    header = unpack(data, '<9I2H7I', 136)
    record_size, total_fields, section_count = header[2], header[11], header[-1]
    storage = 204 + section_count * 40 + total_fields * 4
    offsets = {field: unpack(data, '<HH5I', storage + index * 24)
               for field, index in text_fields.items()}
    walked, string_prefix, copies, resolved = 0, 0, [], set()
    row_ids = list(raw)
    for section in range(section_count):
        key, offset, count, string_size, sparse, id_size, _, sparse_count, copy_count = unpack(data, '<Q8I', 204 + section * 40)
        if key or sparse or sparse_count:
            raise DB2Error(f'Unsupported {name} string section.')
        begin, end = offset + count * record_size, offset + count * record_size + string_size
        ids = row_ids[walked:walked + count]
        record_prefix = walked
        walked += count
        for index, row_id in enumerate(ids):
            for field, (bit_offset, bits, _, kind, *_rest) in offsets.items():
                if kind != 0 or not bits or bits % 32 or bit_offset % 8:
                    raise DB2Error(f'Unsupported {name}.{field} string storage.')
                strings = []
                for element in range(bits // 32):
                    at = offset + index * record_size + bit_offset // 8 + element * 4
                    relative = unpack(data, '<i', at)[0]
                    if relative == 0:
                        strings.append('')
                        continue
                    logical = (record_prefix + index) * record_size + bit_offset // 8 + element * 4 + relative
                    start = begin + logical - header[0] * record_size - string_prefix
                    if not begin <= start < end:
                        raise DB2Error(f'{name}.{field} is outside its string table.')
                    stop = data.find(b'\0', start, end)
                    if stop < 0:
                        raise DB2Error(f'Unterminated {name}.{field}.')
                    try:
                        strings.append(data[start:stop].decode('utf-8'))
                    except UnicodeError as error:
                        raise DB2Error(f'Invalid UTF-8 in {name}.{field}.') from error
                rows[row_id][field] = strings[0] if len(strings) == 1 else strings
            resolved.add(row_id)
        string_prefix += string_size
        copies.extend(unpack(data, '<II', end + id_size + index * 8) for index in range(copy_count))
    while copies:
        pending = []
        for dest, source in copies:
            if source not in resolved:
                pending.append((dest, source))
                continue
            for field in text_fields:
                rows[dest][field] = rows[source][field]
            resolved.add(dest)
        if len(pending) == len(copies):
            raise DB2Error(f'Unresolved {name} string copies.')
        copies = pending
    if resolved != set(rows):
        raise DB2Error(f'{name} string records are incomplete.')
    return rows, layout
