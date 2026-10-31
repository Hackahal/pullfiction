"""Merge Classic Era split ADT geometry, texture and object files for the renderer.

This is a cache representation, never a rewrite of the source installation.
"""
import struct
from classic_compat import CompatError, read, span


def chunks(data):
    cursor = 0
    while cursor < len(data):
        tag, size = read(data, '<4sI', cursor)
        yield tag[::-1].decode(), span(data, cursor + 8, size)
        cursor += 8 + size


def chunk(tag, data):
    return tag.encode()[::-1] + struct.pack('<I', len(data)) + data


def rle_literal(data):
    return b''.join(bytes([len(data[i:i+127])]) + data[i:i+127] for i in range(0, len(data), 127))


def liquid_blocks(data, index, liquid_types):
    if not data:
        return b'', 0
    offset, count, attributes = read(data, '<III', index * 12)
    if count > 4:
        raise CompatError('Too many liquid layers for renderer')
    boundaries = {len(data)}
    for i in range(256):
        start, layers, attr = read(data, '<III', i * 12)
        boundaries.update(v for v in (start, attr) if v)
        for j in range(layers):
            bitmap, vertices = read(data, '<II', start + j * 24 + 16)
            boundaries.update(v for v in (bitmap, vertices) if v)
    blocks, flags = [], 0
    for layer in range(count):
        kind, lvf, low, high, x, y, width, height, mask, vertices = read(data, '<HHff4BII', offset + layer * 24)
        if width + x > 8 or height + y > 8:
            raise CompatError('Unsupported liquid vertex layout')
        liquid = liquid_types[kind]
        n = (width + 1) * (height + 1)
        if lvf > 3 and vertices:
            size = min(p for p in boundaries if p > vertices) - vertices
            formats = {5: 0, 8: 1, 1: 2, 9: 3}
            if size % n or size // n not in formats:
                raise CompatError('Cannot resolve modern liquid vertex format')
            lvf = formats[size // n]
        elif lvf > 3:
            lvf = 0
        heights = read(data, '<' + 'f' * n, vertices) if vertices and lvf != 2 else [low] * n
        depth_offset = vertices + (n * 4 if lvf != 2 else 0) + (n * 4 if lvf in (1, 3) else 0)
        depths = span(data, depth_offset, n) if vertices and lvf in (0, 2, 3) else bytes([255]) * n
        block = bytearray(0x324)
        struct.pack_into('<ff', block, 0, low, high)
        for gy in range(9):
            for gx in range(9):
                lx, ly = min(max(gx - x, 0), width), min(max(gy - y, 0), height)
                i = ly * (width + 1) + lx
                struct.pack_into('<4Bf', block, 8 + (gy * 9 + gx) * 8, depths[i], 0, 0, 0, heights[i])
        block[656:720] = bytes([15]) * 64
        bits = int.from_bytes(span(data, mask, (width * height + 7) // 8), 'little') if mask else (1 << (width * height)) - 1
        for ly in range(height):
            for lx in range(width):
                if bits & (1 << (ly * width + lx)):
                    block[656 + (y + ly) * 8 + x + lx] = liquid
        blocks.append(bytes(block))
    # The renderer uses header bits only for block count; each cell retains its real kind.
    return b''.join(blocks), ((1 << len(blocks)) - 1) << 2


def adapt_adt(root, textures, objects, big_alpha=True, liquid_types=None):
    roots, tex, obj = list(chunks(root)), list(chunks(textures)), list(chunks(objects))
    geom = [b for t, b in roots if t == 'MCNK']
    tex_chunks = [b for t, b in tex if t == 'MCNK']
    if len(geom) != 256 or len(tex_chunks) != 256:
        raise CompatError('Expected 256 split terrain chunks')
    top = dict((t, b) for t, b in roots if t != 'MCNK')
    tex_top = dict((t, b) for t, b in tex if t != 'MCNK')
    obj_top = dict((t, b) for t, b in obj if t != 'MCNK')
    result = bytearray(chunk('MVER', struct.pack('<I', 18)))
    ids = tex_top.get('MDID', b'')
    names = b''.join(f'__classic/{i}.blp\0'.encode() for i in read(ids, '<' + 'I' * (len(ids)//4), 0)) if ids else tex_top.get('MTEX', b'')
    result.extend(chunk('MTEX', names))
    for tag, stride, flag_offset, fdid_flag, blob_tag, index_tag, ext in [
        ('MDDF', 36, 34, 0x40, 'MMDX', 'MMID', 'm2'),
        ('MODF', 64, 56, 0x8, 'MWMO', 'MWID', 'wmo')]:
        records = bytearray(obj_top.get(tag, b''))
        old_strings, old_indices = obj_top.get(blob_tag, b''), obj_top.get(index_tag, b'')
        strings, indices = bytearray(), bytearray()
        for pos in range(0, len(records), stride):
            name_id = read(records, '<I', pos)[0]
            flags = read(records, '<H', pos + flag_offset)[0]
            if flags & fdid_flag:
                name = f'__classic/{name_id}.{ext}'.encode()
            else:
                start = read(old_indices, '<I', name_id * 4)[0]
                end = old_strings.find(b'\0', start)
                if end < 0:
                    raise CompatError('Missing ADT placement filename')
                name = old_strings[start:end]
            struct.pack_into('<I', records, pos, len(indices) // 4)
            struct.pack_into('<H', records, pos + flag_offset, flags & ~fdid_flag)
            indices.extend(struct.pack('<I', len(strings)))
            strings.extend(name + b'\0')
        for t, b in [(blob_tag, strings), (index_tag, indices), (tag, records)]:
            result.extend(chunk(t, b))
    for index, (geometry, texture) in enumerate(zip(geom, tex_chunks)):
        header = bytearray(span(geometry, 0, 128))
        nested = dict(chunks(geometry[128:]))
        nested.update(dict(chunks(texture)))
        layers = bytearray(nested.get('MCLY', b''))
        alpha, packed = nested.get('MCAL', b''), bytearray()
        for pos in range(16, len(layers), 16):
            flags, offset = read(layers, '<II', pos + 4)
            struct.pack_into('<I', layers, pos + 8, len(packed))
            if flags & 0x200:
                end = read(layers, '<I', pos + 24)[0] if pos + 16 < len(layers) else len(alpha)
                # Offsets in the original next layer must not come from already converted data.
                packed.extend(alpha[offset:end])
            elif flags & 0x100:
                size = 4096 if big_alpha else 2048
                values = span(alpha, offset, size)
                if not big_alpha:
                    values = bytes(v for b in values for v in ((b & 15) * 17, (b >> 4) * 17))
                packed.extend(rle_literal(values))
                struct.pack_into('<I', layers, pos + 4, flags | 0x200)
        nested['MCLY'], nested['MCAL'] = bytes(layers), bytes(packed)
        liquid, liquid_flags = liquid_blocks(top.get('MH2O', b''), index, liquid_types or {})
        flags = read(header, '<I', 0)[0]
        if flags & 0x10000:
            holes = int.from_bytes(header[0x14:0x1c], 'little')
            low = sum(1 << (y * 4 + x) for y in range(4) for x in range(4) if any(holes & (1 << ((y*2+dy)*8 + x*2+dx)) for dy in range(2) for dx in range(2)))
            struct.pack_into('<H', header, 0x3c, low)
        struct.pack_into('<I', header, 0, (flags & ~0x1003c) | liquid_flags)
        struct.pack_into('<I', header, 0xc, len(layers) // 16)
        body = bytearray(header)
        for field in (0x14, 0x18, 0x1c, 0x24, 0x28, 0x2c, 0x30, 0x60, 0x64):
            struct.pack_into('<I', body, field, 0)
        if liquid:
            nested['MCLQ'] = liquid
        for tag, field in [('MCVT',0x14),('MCNR',0x18),('MCLY',0x1c),('MCAL',0x24),('MCSH',0x2c),('MCLQ',0x60)]:
            if nested.get(tag):
                struct.pack_into('<I', body, field, len(body) + 8)
                body.extend(chunk(tag, nested[tag]))
        struct.pack_into('<I', body, 0x28, len(nested.get('MCAL', b'')))
        struct.pack_into('<I', body, 0x64, len(liquid))
        result.extend(chunk('MCNK', body))
    return bytes(result)
