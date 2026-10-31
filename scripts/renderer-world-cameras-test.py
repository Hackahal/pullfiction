#!/usr/bin/env python3
"""Analytical camera geometry and output guards; no CASC or renderer required."""
import importlib.util
import math
from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('world_cameras', Path(__file__).with_name('renderer-world-cameras.py'))
cameras = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cameras)
from classic_world import pack


def plane(z, downward=False):
    triangles = np.array([[[-10., -10, z], [10, -10, z], [10, 10, z]],
                          [[-10., -10, z], [10, 10, z], [-10, 10, z]]])
    return triangles[:, ::-1] if downward else triangles


def normals(triangles):
    return np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])


class CameraTests(unittest.TestCase):
    def test_ray_selects_nearest_forward_triangle(self):
        mesh = np.concatenate([plane(0), plane(1), plane(4)])
        hit = cameras.rays(np.array([1., 0, 3]), [[0, 0, -1]], mesh)[0]
        self.assertEqual(hit, (2., 2))

    def test_ray_hits_both_windings_and_triangle_edge(self):
        for downward in [False, True]:
            distance, index = cameras.rays(np.array([0., 0, 2]), [[0, 0, -1]], plane(0, downward))[0]
            self.assertEqual(distance, 2.)
            self.assertIsNotNone(index)

    def test_parallel_behind_degenerate_and_empty_triangles_miss(self):
        origin = np.array([0., 0, 2])
        for mesh, direction in [(plane(0), [1, 0, 0]), (plane(0), [0, 0, 1]),
                                (np.zeros((1, 3, 3)), [0, 0, -1]),
                                (np.zeros((0, 3, 3)), [0, 0, -1])]:
            distance, index = cameras.rays(origin, [direction], mesh)[0]
            self.assertTrue(math.isinf(distance))
            self.assertIsNone(index)

    def test_enclosed_floor_has_exact_eye_and_overhead_clearance(self):
        mesh = np.concatenate([plane(0), plane(5, True)])
        clearance, reason = cameras.vertical_clearance(np.zeros(3), mesh, normals(mesh))
        self.assertIsNone(reason)
        eye, above, below = clearance
        np.testing.assert_array_equal(eye, [0, 0, 1.7])
        self.assertAlmostEqual(above, 3.3)
        self.assertAlmostEqual(below, 1.7)

    def test_exposed_roof_wrong_ceiling_winding_and_low_ceiling_rejected(self):
        for mesh in [plane(0), np.concatenate([plane(0), plane(5)]),
                     np.concatenate([plane(0), plane(2, True)])]:
            clearance, reason = cameras.vertical_clearance(np.zeros(3), mesh, normals(mesh))
            self.assertIsNone(clearance)
            self.assertEqual(reason, 'no-front-facing-overhead-or-low-ceiling')

    def test_intervening_floor_rejected(self):
        mesh = np.concatenate([plane(0), plane(.5), plane(5, True)])
        clearance, reason = cameras.vertical_clearance(np.zeros(3), mesh, normals(mesh))
        self.assertIsNone(clearance)
        self.assertEqual(reason, 'floor-not-nearest-below-eye')

    def test_room_view_has_clear_forward_target(self):
        floor = plane(0)
        walls = []
        for a, b in [((-10, -10), (10, -10)), ((10, -10), (10, 10)),
                     ((10, 10), (-10, 10)), ((-10, 10), (-10, -10))]:
            walls.extend([[list(a) + [0], list(b) + [0], list(b) + [5]],
                          [list(a) + [0], list(b) + [5], list(a) + [5]]])
        mesh = np.concatenate([floor, plane(5, True), np.array(walls)])
        selection, count, _ = cameras.choose_eye({'position': [0, 0, 1.7]}, floor, np.array([0, 1]), mesh)
        self.assertEqual(count, 2)
        self.assertIsNotNone(selection)
        self.assertEqual(selection['eye'][2], 1.7)
        self.assertGreaterEqual(selection['centerHorizontalLosYards'], 8)
        self.assertGreaterEqual(selection['targetLosYards'], math.hypot(5, .25))

    def test_wall_close_to_eye_rejects_candidate(self):
        floor = np.array([[[-.1, -.1, 0], [.1, -.1, 0], [0, .2, 0]]])
        wall = np.array([[[.2, -10, 0], [.2, 10, 0], [.2, 10, 5]],
                         [[.2, -10, 0], [.2, 10, 5], [.2, -10, 5]]])
        mesh = np.concatenate([floor, plane(5, True), wall])
        selection, count, rejected = cameras.choose_eye({'position': [0, 0, 1.7]}, floor, np.array([0]), mesh)
        self.assertIsNone(selection)
        self.assertEqual(count, 1)
        self.assertEqual(rejected, {'wall-within-eye-clearance': 1})

    def test_orbit_reconstructs_known_eye_and_target_is_forward(self):
        eye = np.array([-7035.25, 1024.125, 391.7])
        for heading in [0, .65, math.pi, 2 * math.pi + 1]:
            c = cameras.camera_from_eye(eye, heading)
            reconstructed = np.array(c['target']) + c['distance'] * np.array([
                math.cos(c['yaw']) * math.cos(c['pitch']),
                math.sin(c['yaw']) * math.cos(c['pitch']), math.sin(c['pitch'])])
            np.testing.assert_allclose(reconstructed, eye, atol=1e-12, rtol=0)
            np.testing.assert_allclose(np.array(c['target']) - eye,
                                       [5 * math.cos(heading), 5 * math.sin(heading), -.25], atol=1e-12)

    def test_placed_bounds_preserve_raw_world_coordinate_transform(self):
        lo, hi = cameras.placed_bounds({'bounds': [[1, 2, 3], [4, 5, 6]]},
                                       {'position': [10, 20, 30], 'rotation': [0, 0, 0]})
        np.testing.assert_allclose(lo, [6, 15, 33], atol=1e-12)
        np.testing.assert_allclose(hi, [9, 18, 36], atol=1e-12)

    def test_modern_triangle_flags_and_placement_preserved(self):
        for flags, count in [(0x100, 1), (0x104, 0)]:
            raw = pack({'MOGP': bytes(68) + pack({'MOVT': struct.pack('<9f', 0, 0, 0, 2, 0, 0, 0, 2, 0),
                        'MOVI': struct.pack('<3H', 0, 1, 2), 'MPY2': struct.pack('<2H', flags, 300)})})
            class Local:
                def raw(self, _):
                    return raw
            geometry = cameras.Geometry(Local())
            triangles, floors, _ = geometry.read({'source': 'id:1'},
                                                {'position': [10, 20, 30], 'rotation': [0, 0, 0]})
            self.assertEqual(len(floors), count)
            np.testing.assert_allclose(triangles[0], [[10, 20, 30], [8, 20, 30], [10, 18, 30]], atol=1e-12)
            self.assertIn('sha256', geometry.sources['id:1'])

    def test_authored_tile_mask_excludes_neighbor_map_wmo_placements(self):
        report = {'wdt': {'terrainTiles': 1}, 'tiles': [{'bounds': [[-12000, -2000, -500], [-11000, -1000, 200]]}]}
        self.assertTrue(cameras.eye_on_authored_tile(report, [-11500, -1500, 0]))
        self.assertFalse(cameras.eye_on_authored_tile(report, [-10650, -3635, -10]))
        self.assertFalse(cameras.eye_on_authored_tile({'wdt': {'terrainTiles': 1}}, [0, 0, 0]))
        self.assertTrue(cameras.eye_on_authored_tile({'wdt': {'terrainTiles': 0}}, [0, 0, 0]))

    def test_output_guard_covers_install_and_symlinked_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install, data = root / 'install', root / 'actual-data'
            install.mkdir(); data.mkdir(); (install / 'Data').symlink_to(data, target_is_directory=True)
            safe = root / 'out.json'
            for unsafe in [install / 'new' / 'out.json', install / 'Data' / 'out.json', data / 'out.json']:
                with self.assertRaisesRegex(ValueError, 'outside the installation'):
                    cameras.validate_destinations(install, unsafe, safe)
            with self.assertRaisesRegex(ValueError, 'different files'):
                cameras.validate_destinations(install, safe, safe)
            self.assertFalse(safe.exists())

    def test_exclusive_output_write_preserves_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = root / 'install'; install.mkdir()
            output, evidence = root / 'fresh' / 'out.json', root / 'fresh' / 'evidence.json'
            cameras.write_outputs(install, output, evidence, [], {'proofBoundary': cameras.PROOF})
            before = output.read_bytes(), evidence.read_bytes()
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                cameras.write_outputs(install, output, evidence, ['changed'], {})
            self.assertEqual(before, (output.read_bytes(), evidence.read_bytes()))


if __name__ == '__main__':
    unittest.main()
