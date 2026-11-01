//! Bounded tile dependencies for canonical source prefixes, independent of view focus.
use benilla_formats::{world_to_tile, TILE_SIZE};

// Room for swept bodies, jump/fall boxes and ordinary local repair detours. Every
// actual physics query still checks TerrainResidency; this is preparation only.
pub(super) const CORRIDOR_MARGIN: f32 = 64.;
pub(super) struct Coverage {
    rows: [u64; 64],
}
impl Default for Coverage {
    fn default() -> Self {
        Self { rows: [0; 64] }
    }
}
impl Coverage {
    pub fn path(&mut self, points: impl IntoIterator<Item = [f32; 2]>) {
        let mut previous = None;
        for point in points {
            match previous {
                Some(prior) if point_key(prior) != point_key(point) => self.segment(prior, point),
                None => self.point(point),
                _ => {}
            }
            previous = Some(point);
        }
    }
    pub fn insert_tile(&mut self, (x, y): (i32, i32)) {
        if (0..64).contains(&x) && (0..64).contains(&y) {
            self.rows[y as usize] |= 1u64 << x;
        }
    }
    pub fn point(&mut self, p: [f32; 2]) {
        self.segment(p, p);
    }
    pub fn segment(&mut self, a: [f32; 2], b: [f32; 2]) {
        let min = [
            a[0].min(b[0]) - CORRIDOR_MARGIN,
            a[1].min(b[1]) - CORRIDOR_MARGIN,
        ];
        let max = [
            a[0].max(b[0]) + CORRIDOR_MARGIN,
            a[1].max(b[1]) + CORRIDOR_MARGIN,
        ];
        // Clamp only the request grid. Out-of-grid source coordinates remain
        // subject to the unchanged residency/physics rejection.
        let grid = |v: f32| ((17066.666 - v) / TILE_SIZE).floor() as i32;
        let (x0, x1) = (grid(max[1]).max(0), grid(min[1]).min(63));
        let (y0, y1) = (grid(max[0]).max(0), grid(min[0]).min(63));
        if x0 > x1 || y0 > y1 {
            return;
        }
        let mask = (u64::MAX << x0) & (u64::MAX >> (63 - x1));
        for y in y0..=y1 {
            self.rows[y as usize] |= mask;
        }
    }
    pub fn count(&self) -> usize {
        self.rows.iter().map(|r| r.count_ones() as usize).sum()
    }
    pub fn tiles(&self) -> Vec<(i32, i32)> {
        self.rows
            .iter()
            .enumerate()
            .flat_map(|(y, row)| {
                (0..64)
                    .filter(move |x| row & (1u64 << x) != 0)
                    .map(move |x| (x, y as i32))
            })
            .collect()
    }
}
pub(super) fn point_key(p: [f32; 2]) -> [(i32, i32); 2] {
    [
        tile([p[0] - CORRIDOR_MARGIN, p[1] - CORRIDOR_MARGIN]),
        tile([p[0] + CORRIDOR_MARGIN, p[1] + CORRIDOR_MARGIN]),
    ]
}
pub(super) fn tile(p: [f32; 2]) -> (i32, i32) {
    let (x, y) = world_to_tile(p[0], p[1]);
    (x as i32, y as i32)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_paths_match_full_segments_in_both_time_orders() {
        let points = [
            [0., 1.],
            [2., 2.],
            [64., 62.],
            [600., 800.],
            [550., 830.],
            [-300., -200.],
        ];
        let mut expected = Coverage::default();
        expected.point(points[0]);
        for pair in points.windows(2) {
            expected.segment(pair[0], pair[1]);
        }
        let mut forward = Coverage::default();
        forward.path(points);
        assert_eq!(forward.tiles(), expected.tiles());
        let mut backward = Coverage::default();
        backward.path(points.into_iter().rev());
        assert_eq!(backward.tiles(), expected.tiles());
        let mut empty = Coverage::default();
        empty.path([]);
        assert_eq!(empty.count(), 0);
    }
    #[test]
    fn scarlet_origin_is_requested_independently_of_camera() {
        let origin = [2948.06, -6027.62];
        let mut coverage = Coverage::default();
        coverage.point(origin);
        assert!(coverage.tiles().contains(&tile(origin)));
        assert!(!coverage.tiles().contains(&tile([2270., -5330.])));
        assert!(coverage.count() <= 4);
    }
    #[test]
    fn corridor_keeps_intermediate_tiles_and_both_boundary_sides() {
        let mut coverage = Coverage::default();
        coverage.segment([0., 0.], [1800., 0.]);
        for x in [0., 400., 800., 1200., 1800.] {
            assert!(coverage.tiles().contains(&tile([x, 0.])));
        }
        assert!(coverage.tiles().contains(&tile([-1., -1.])));
        assert!(coverage.tiles().contains(&tile([1., 1.])));
        let count = coverage.count();
        coverage.segment([1800., 0.], [0., 0.]);
        assert_eq!(coverage.count(), count);
    }
    #[test]
    fn broad_source_is_counted_exactly_without_unbounded_storage() {
        let mut coverage = Coverage::default();
        coverage.segment([-20000., -20000.], [20000., 20000.]);
        assert_eq!(coverage.count(), 4096);
        assert_eq!(coverage.tiles().len(), 4096);
    }
}
