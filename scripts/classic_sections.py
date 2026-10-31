"""Read available fixed WDC5 sections without decrypting or zero-filling holes.

The callback reads exact offline ranges and raises EncryptedSectionError only
for a missing encryption key. Other failures remain fatal. Returned bytes are a
standalone WDC5 subset with logical string offsets rebased to its included rows.
Coverage is mandatory: a readable subset must never masquerade as a full table.
"""
import struct

from classic_db2 import DB2Error, unpack
from classic_spells import schema, DEFINITIONS

LIMIT = 128 * 1024 * 1024


class EncryptedSectionError(OSError):
    pass


def readable_table(read_range, name):
    def exact(offset, size):
        if offset < 0 or size < 0 or offset + size > LIMIT:
            raise DB2Error('WDC5 range exceeds resource limit.')
        data = bytes(read_range(offset, size))
        if len(data) != size:
            raise DB2Error('Truncated WDC5 range.')
        return data

    header = bytearray(exact(0, 204))
    if header[:4] != b'WDC5':
        raise DB2Error('Expected WDC5.')
    values = list(unpack(header, '<9I2H7I', 136))
    records, fields, stride = values[:3]
    total_fields, count = values[11], values[-1]
    if (values[9] & 1 or not stride or not 0 < count <= 4096 or
            not 0 < fields == total_fields <= 4096 or values[14] != fields * 24):
        raise DB2Error('Unsupported fixed WDC5 section layout.')
    descriptors = exact(204, count * 40)
    sections = [unpack(descriptors, '<Q8I', i * 40) for i in range(count)]
    if sum(row[2] for row in sections) != records or sum(row[3] for row in sections) != values[3]:
        raise DB2Error('WDC5 section totals disagree with header.')
    metadata_start = 204 + count * 40
    metadata = exact(metadata_start, total_fields * 4 + values[14] + values[15] + values[16])
    metadata_end = metadata_start + len(metadata)
    fields, _, _ = schema(name, f'{values[5]:08x}')
    if len(fields) != total_fields:
        raise DB2Error('WDC5 field count disagrees with pinned schema.')
    columns = (DEFINITIONS / (name + '.dbd')).read_text().split('\n\n')[0]
    text_names = {line.split()[1].rstrip('?') for line in columns.splitlines()
                  if line.startswith(('string ', 'locstring '))}
    text_offsets = []
    for index, field in enumerate(fields):
        if field not in text_names:
            continue
        bit, bits, _, kind, *_ = unpack(metadata, '<HH5I', total_fields * 4 + index * 24)
        if kind != 0 or not bits or bits % 32 or bit % 8 or bit + bits > stride * 8:
            raise DB2Error(f'Unsupported {name}.{field} string storage.')
        text_offsets.extend(bit // 8 + i * 4 for i in range(bits // 32))

    included, omitted = [], []
    prior_records = prior_strings = 0
    previous_end = metadata_end
    for index, row in enumerate(sections):
        key, offset, rows, strings, sparse_end, ids, relations, sparse, copies = row
        size = rows * stride + strings + ids + copies * 8 + relations
        if sparse_end or sparse or ids not in (0, rows * 4) or offset < previous_end:
            raise DB2Error('Unsupported or overlapping WDC5 section.')
        previous_end = offset + size
        try:
            payload = bytearray(exact(offset, size))
        except EncryptedSectionError:
            if not key:
                raise DB2Error('An unencrypted WDC5 section could not be read.')
            omitted.append({'section': index, 'keyName': f'{key:016X}', 'records': rows, 'copies': copies})
        else:
            included.append((row, payload, prior_records, prior_strings))
        prior_records += rows
        prior_strings += strings
    if not included:
        raise EncryptedSectionError('No readable WDC5 sections.')

    kept_records = sum(row[2] for row, *_ in included)
    kept_strings = sum(row[3] for row, *_ in included)
    values[0], values[3], values[-1] = kept_records, kept_strings, len(included)
    struct.pack_into('<9I2H7I', header, 136, *values)
    offset = 204 + len(included) * 40 + len(metadata)
    directories, payloads = [], []
    new_records = new_strings = 0
    for row, payload, old_records, old_strings in included:
        for record in range(row[2]):
            for field in text_offsets:
                at = record * stride + field
                relative = unpack(payload, '<i', at)[0]
                if not relative:
                    continue
                # WDC5 points into a virtual concatenation of all records followed
                # by all string blocks, rather than physical section file offsets.
                local = (old_records + record) * stride + field + relative - records * stride - old_strings
                if not 0 <= local < row[3]:
                    raise DB2Error(f'{name} string is outside its section.')
                rebased = kept_records * stride + new_strings + local - (new_records + record) * stride - field
                if not -(1 << 31) <= rebased < (1 << 31):
                    raise DB2Error('WDC5 string offset overflow.')
                struct.pack_into('<i', payload, at, rebased)
        descriptor = list(row)
        descriptor[0], descriptor[1] = 0, offset
        directories.append(struct.pack('<Q8I', *descriptor))
        payloads.append(payload)
        offset += len(payload)
        new_records += row[2]
        new_strings += row[3]
    coverage = {'complete': not omitted, 'sourceRecords': records,
                'includedRecords': kept_records,
                'includedCopies': sum(row[8] for row, *_ in included),
                'sourceSections': count, 'includedSections': len(included),
                'omittedSections': omitted, 'zeroFilledBytes': 0}
    return bytes(header) + b''.join(directories) + metadata + b''.join(payloads), coverage
