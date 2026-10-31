#!/usr/bin/env python3
import struct
import unittest
from classic_compat import Adapter, CompatError, UnsupportedFeatureError, adapt_model, read, shader_coordinates


def put(b, offset, *values):
    struct.pack_into('<' + 'I' * len(values), b, offset, *values)


def fixture():
    b = bytearray(900)
    b[:4] = b'MD20'
    put(b, 4, 274)
    put(b, 0x1C, 2, 304)
    put(b, 304 + 4, 1000)
    put(b, 368 + 4, 1000)
    put(b, 0x2C, 1, 432)
    struct.pack_into('<h', b, 440, -1)
    # Bone translation: first sequence has a key, second has an empty track.
    struct.pack_into('<Hh', b, 448, 1, -1)
    put(b, 452, 2, 528)
    put(b, 460, 2, 544)
    put(b, 528, 1, 560)
    put(b, 536, 0, 0)
    put(b, 544, 1, 564)
    put(b, 552, 0, 0)
    put(b, 560, 25)
    struct.pack_into('<3f', b, 564, 1, 2, 3)
    put(b, 0x44, 1)
    skin = bytearray(48)
    skin[:4] = b'SKIN'
    outer = b'MD21' + struct.pack('<I', len(b)) + b
    return outer, bytes(skin)


def three_stage_fixture(kinds=(0, 0, 0), ids=(101, 102, 103), shader=0x8009, transforms=(65535, 65535, 65535)):
    source, skin = fixture()
    body = bytearray(source[8:])
    texture_offset = len(body)
    for index, kind in enumerate(kinds):
        body.extend(struct.pack('<4I', kind, 3 if index == 0 else 0, 0, 0))
    put(body, 0x50, 3, texture_offset)
    lookup = len(body)
    body.extend(struct.pack('<3H', 0, 1, 2))
    put(body, 0x80, 3, lookup)
    lookup = len(body)
    body.extend(struct.pack('<3H', *transforms))
    put(body, 0x98, 3, lookup)
    skin = bytearray(skin)
    put(skin, 36, 1, len(skin))
    batch = bytearray(24)
    struct.pack_into('<H', batch, 2, shader)
    struct.pack_into('<H', batch, 14, 3)
    skin.extend(batch)
    source = b'MD21' + struct.pack('<I', len(body)) + body
    source += b'TXID' + struct.pack('<I3I', 12, *ids)
    return source, bytes(skin)


def particle_geometry_fixture(geometry_ids=None):
    source, skin = fixture()
    body = bytearray(source[8:])
    count, start = 3, len(body)
    body.extend(bytes(count * 492))
    put(body, 0x128, count, start)
    for index in range(count):
        at = start + index * 492
        struct.pack_into('<BB', body, at + 40, 2, 2)
        for offset in (52, 72, 92, 112, 132, 152, 176, 200, 220, 240, 456):
            struct.pack_into('<Hh', body, at + offset, 0, -1)
    legacy_name = b'Particle/Test.m2\0'
    put(body, start + 492 + 24, len(legacy_name), len(body))
    body.extend(legacy_name)
    source = b'MD21' + struct.pack('<I', len(body)) + body
    if geometry_ids is not None:
        data = b''.join(struct.pack('<I', value) for value in geometry_ids)
        source += b'GPID' + struct.pack('<I', len(data)) + data
    return source, skin


class AdapterTest(unittest.TestCase):
    def test_multitexture_stages_scroll_and_exp2_are_retained_without_signed_short_aliasing(self):
        source, skin = particle_geometry_fixture()
        body = bytearray(source[8:])
        count, particles = read(body, '<II', 0x128)
        # Keep only the first sprite emitter, with three concrete authored texture stages.
        put(body, 0x128, 1, particles)
        textures = len(body)
        body.extend(bytes(3 * 16))
        put(body, 0x50, 3, textures)
        put(body, 0x70, 1, len(body))
        body.extend(bytes(4))
        struct.pack_into('<I', body, particles+4, 0x70830021)
        struct.pack_into('<H', body, particles+22, 0 | (1 << 5) | (2 << 10))
        body[particles+44:particles+46] = bytes([32, 16])
        struct.pack_into('<8H', body, particles+476, 0x8019, 384, 128, 128, 25, 25, 0, 0)
        raw = b'MD21' + struct.pack('<I',len(body)) + body
        raw += b'TXID' + struct.pack('<I3I',12,101,102,103)
        exp = bytearray(48)
        put(exp,0,1,8)
        struct.pack_into('<3f',exp,8,2.5,1.5,0.75)
        put(exp,20,2,36,2,40)
        struct.pack_into('<2H2h',exp,36,0,32767,0,16384)
        raw += b'EXP2' + struct.pack('<I',len(exp)) + exp
        output = adapt_model(raw,[skin])
        magic, offset, count = read(output,'<4sII',len(output)-12)
        self.assertEqual((magic,count),(b'PFP5',1))
        self.assertEqual(read(output,'<4I',offset+76),(0x70830021,0,1,2))
        self.assertEqual(read(output,'<2f',offset+92),(1.0,0.5))
        self.assertEqual(read(output,'<4f',offset+100),(-25/512,0.75,0.25,0.25))
        self.assertEqual(read(output,'<2f',offset+132),(1.5,0.75))
        n, at = read(output,'<II',offset+140)
        self.assertEqual(n,2)
        self.assertAlmostEqual(read(output,'<4f',at)[3],16384/32767)
        self.assertEqual(read(output,'<f2I',offset+148),(2.5,0,1))
        self.assertTrue(read(output,'<I',read(output,'<I',0x140)[0]+4)[0] & 1)
        # Material TXAC entries follow emitter entries and do not select particle UV shaders.
        self.assertEqual(adapt_model(raw+b'TXAC'+struct.pack('<I2H',4,0,0x303),[skin]),output)
        with self.assertRaisesRegex(UnsupportedFeatureError,'animated particle texture'):
            adapt_model(raw+b'TXAC'+struct.pack('<I2H',4,1,0),[skin])

    def test_gpid_preserves_geometry_particle_indices_and_legacy_fallback(self):
        source, skin = particle_geometry_fixture((101, 0, 103))
        output = adapt_model(source, [skin])
        count, offset = read(output, '<II', 0x13c)
        self.assertEqual(count, 3)
        names = []
        for index in range(count):
            size, at = read(output, '<II', offset + index * 504 + 24)
            names.append(output[at:at + size])
        self.assertEqual(names, [b'__classic/101.m2\0', b'Particle/Test.m2\0', b'__classic/103.m2\0'])
        without, skin = particle_geometry_fixture()
        empty, _ = particle_geometry_fixture((0, 0, 0))
        self.assertEqual(adapt_model(without, [skin]), adapt_model(empty, [skin]))

    def test_gpid_mismatch_and_invalid_file_id_fail_explicitly(self):
        for ids in [(101,), (101, 0xffffffff, 103)]:
            source, skin = particle_geometry_fixture(ids)
            with self.subTest(ids=ids), self.assertRaises(CompatError):
                adapt_model(source, [skin])

    def camera_fixture(self, version, fov=0.9):
        source, skin = fixture()
        body = bytearray(source[8:])
        put(body, 4, version)
        camera = len(body)
        body.extend(bytes(148))
        put(body, 0x110, 1, camera)
        struct.pack_into('<iff', body, camera, -1, 100.0, 0.1)
        struct.pack_into('<3f', body, camera + 32, 1, 2, 3)
        struct.pack_into('<3f', body, camera + 64, 4, 5, 6)
        for offset in [12, 44, 76, 96]:
            struct.pack_into('<Hh', body, camera + offset, 0, -1)
        put(body, camera + 100, 1, camera + 116)
        put(body, camera + 108, 1, camera + 124)
        put(body, camera + 116, 1, camera + 132)
        put(body, camera + 124, 1, camera + 136)
        struct.pack_into('<3f', body, camera + 136, fov, 0, 0)
        return b'MD21' + struct.pack('<I', len(body)) + body, skin

    def test_modern_camera_layout_preserves_portrait_values_for_both_versions(self):
        for version in [272, 274]:
            with self.subTest(version=version):
                source, skin = self.camera_fixture(version)
                output = adapt_model(source, [skin])
                count, offset = read(output, '<II', 0x124)
                self.assertEqual(count, 1)
                kind, fov, far, near = read(output, '<ifff', offset)
                self.assertEqual(kind, -1)
                self.assertAlmostEqual(fov, 0.9)
                self.assertAlmostEqual(far, 100.0)
                self.assertAlmostEqual(near, 0.1)
                self.assertEqual(read(output, '<3f', offset + 44), (1, 2, 3))
                self.assertEqual(read(output, '<3f', offset + 84), (4, 5, 6))

    def test_invalid_camera_values_and_unvalidated_272_particles_remain_rejected(self):
        for version in [272, 274]:
            for fov in [float('nan'), float('inf'), 0, -1, 4]:
                source, skin = self.camera_fixture(version, fov)
                with self.assertRaisesRegex(CompatError, 'invalid field of view'):
                    adapt_model(source, [skin])
        source, skin = self.camera_fixture(272)
        source = bytearray(source)
        put(source, 8 + 0x128, 1)
        with self.assertRaisesRegex(CompatError, 'particle layout'):
            adapt_model(source, [skin])

    def test_local_clocks_and_empty_bands_preserve_bind_pose(self):
        source, skin = fixture()
        output = adapt_model(source, [skin])
        self.assertEqual(read(output, '<4sI', 0), (b'MD20', 256))
        n, sequence_offset = read(output, '<II', 0x1C)
        self.assertEqual(n, 2)
        self.assertEqual(read(output, '<II', sequence_offset + 4), (0, 1000))
        self.assertEqual(read(output, '<II', sequence_offset + 68 + 4), (1001, 2001))
        _, bone_offset = read(output, '<II', 0x34)
        _, _, range_count, ranges, key_count, times, _, values = read(output, '<Hh6I', bone_offset + 12)
        self.assertEqual((range_count, key_count), (2, 2))
        self.assertEqual(read(output, '<4I', ranges), (0, 0, 1, 1))
        self.assertEqual(read(output, '<2I', times), (25, 1001))
        self.assertEqual(read(output, '<6f', values), (1, 2, 3, 0, 0, 0))

    def test_external_skeleton_never_silently_disappears(self):
        source, skin = fixture()
        changed = source + b'SKID' + struct.pack('<II', 4, 123)
        with self.assertRaisesRegex(CompatError, 'External modern skeleton'):
            adapt_model(changed, [skin])

    def test_model_lights_and_ribbons_keep_tracks(self):
        source, skin = fixture()
        body = bytearray(source[8:])
        light = len(body)
        body.extend(bytes(156))
        put(body, 0x108, 1, light)
        struct.pack_into('<Hh3f', body, light, 1, -1, 2, 3, 4)
        ribbon = len(body)
        body.extend(bytes(176))
        put(body, 0x120, 1, ribbon)
        struct.pack_into('<3f', body, ribbon + 8, 5, 6, 7)
        output = adapt_model(b'MD21' + struct.pack('<I', len(body)) + body, [skin])
        n, at = read(output, '<II', 0x11c)
        self.assertEqual(n, 1)
        self.assertEqual(read(output, '<Hh3f', at), (1,-1,2,3,4))
        n, at = read(output, '<II', 0x134)
        self.assertEqual(n, 1)
        self.assertEqual(read(output, '<3f', at+8), (5,6,7))

    def test_shader_coordinates_keep_uv_sets_and_real_reflections(self):
        for shader, stages, expected in [(16,1,(0,)),(0x90,1,(65535,)),(0x4010,1,(1,)),(0,2,(0,0)),(8,2,(0,65535)),(0x80,2,(65535,0)),(0x88,2,(65535,65535)),(0x4000,2,(0,1)),(0x8000,2,(0,65535)),(0x8017,2,(0,0)),(0x800f,2,(0,1))]:
            with self.subTest(shader=shader):
                self.assertEqual(shader_coordinates(shader,stages),expected)
        with self.assertRaises(CompatError): shader_coordinates(0x80ff,1)
        self.assertEqual(shader_coordinates(0x8009,3), (0,65535,0))
        with self.assertRaises(UnsupportedFeatureError): shader_coordinates(0x8003,3)

    def test_invalid_track_modes_are_not_cached_as_capability_limits(self):
        for interpolation in (2, 3, 4, 65535):
            source, skin = fixture()
            source = bytearray(source)
            struct.pack_into('<H', source, source.index(b'MD20') + 448, interpolation)
            with self.subTest(interpolation=interpolation):
                with self.assertRaises(CompatError) as caught:
                    adapt_model(bytes(source), [skin])
                self.assertEqual(isinstance(caught.exception, UnsupportedFeatureError), interpolation in (2, 3))

    def test_lucifron_addalpha_shader_and_skin_order_survive_conversion(self):
        source, skin = fixture()
        skin = bytearray(skin)
        put(skin, 36, 2, 48)
        for shader, count, combo in [(0x8001, 2, 0), (0, 1, 2)]:
            record = bytearray(24)
            struct.pack_into('<H', record, 2, shader)
            struct.pack_into('<H', record, 14, count)
            struct.pack_into('<H', record, 16, combo)
            skin.extend(record)
        output = adapt_model(source, [skin])
        self.assertEqual(output[0x144:0x14c], b'PFM1\x01\x00\x00\x00')
        _, view = read(output, '<II', 0x4c)
        count, batches = read(output, '<II', view + 32)
        self.assertEqual(count, 2)
        self.assertEqual(read(output, '<H', batches + 2)[0], 0x8001)
        self.assertEqual(read(output, '<H', batches + 14)[0], 2)
        self.assertEqual(read(output, '<H', batches + 16)[0], 0)
        self.assertEqual(read(output, '<H', batches + 24 + 2)[0], 0)
        self.assertEqual(read(output, '<H', batches + 24 + 14)[0], 1)
        self.assertEqual(read(output, '<H', batches + 24 + 16)[0], 2)
        _, coordinates = read(output, '<II', 0x9c)
        self.assertEqual(read(output, '<3H', coordinates), (0, 65535, 0))

    def test_each_batch_gets_its_own_coordinate_mapping_across_profiles(self):
        source, skin = fixture()
        skin = bytearray(skin)
        put(skin,36,3,48)
        for shader in (16,0x90,0x4010):
            record=bytearray(24)
            struct.pack_into('<H',record,2,shader)
            struct.pack_into('<H',record,14,1)
            skin.extend(record)
        output=adapt_model(source,[skin,skin])
        n, at=read(output,'<II',0x9c)
        self.assertEqual(read(output,'<6H',at),(0,65535,1,0,65535,1))
        n, at=read(output,'<II',0x4c)
        self.assertEqual(n,2)
        for profile in range(2):
            count, batches=read(output,'<II',at+profile*44+32)
            self.assertEqual(count,3)
            self.assertEqual([read(output,'<H',batches+i*24+18)[0] for i in range(3)],list(range(profile*3,profile*3+3)))

    def test_static_three_stage_shader_preserves_all_samples_and_coordinates(self):
        for kinds, ids in [((0, 0, 0), (101, 102, 103)), ((11, 0, 11), (0, 102, 0))]:
            source, skin = three_stage_fixture(kinds, ids)
            output = adapt_model(source, [skin])
            self.assertEqual(read(output, '<I', 0x5c)[0], 3)
            count, coords = read(output, '<II', 0x9c)
            self.assertEqual((count, read(output, '<3H', coords)), (3, (0, 65535, 0)))
            _, profile = read(output, '<II', 0x4c)
            _, batches = read(output, '<II', profile + 32)
            self.assertEqual(read(output, '<H', batches + 2)[0], 0x8009)
            self.assertEqual(read(output, '<H', batches + 14)[0], 3)
            # The repeated runtime skin intentionally has a separate clamp sampler.
            _, textures = read(output, '<II', 0x5c)
            self.assertEqual(read(output, '<I', textures + 4)[0], 3)
            self.assertEqual(read(output, '<I', textures + 2 * 16 + 4)[0], 0)

    def test_third_stage_unknown_shader_animation_and_runtime_bindings_stay_unsupported(self):
        for options, message in [({'shader': 0x4014}, 'more than two'),
                                 ({'transforms': (0, 65535, 65535)}, 'texture animation'),
                                 ({'kinds': (2, 3, 0), 'ids': (0, 0, 103)}, 'second-stage runtime'),
                                 ({'kinds': (11, 0, 12), 'ids': (0, 102, 0)}, 'third-stage runtime')]:
            source, skin = three_stage_fixture(**options)
            with self.subTest(options=options), self.assertRaisesRegex(UnsupportedFeatureError, message):
                adapt_model(source, [skin])

    def test_bad_array_offsets_and_aliases_fail(self):
        source, skin = fixture()
        changed = bytearray(source)
        put(changed, 8 + 0x30, 0xFFFFFFFF)
        with self.assertRaises(CompatError):
            adapt_model(changed, [skin])
        changed = bytearray(source)
        put(changed, 8 + 304 + 12, 0x40)
        struct.pack_into('<H', changed, 8 + 304 + 62, 999)
        with self.assertRaisesRegex(CompatError, 'absent sequence'):
            adapt_model(changed, [skin])


if __name__ == '__main__':
    unittest.main()
