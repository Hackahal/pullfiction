//! Memoized replay ground answers. A repeated paused snapshot must not reseat an actor.
#[derive(Default)]
pub(crate) struct GroundMemo {
    request: Option<[f32; 3]>,
    epoch: u64,
    position: Option<[f32; 3]>,
}
impl GroundMemo {
    pub(crate) fn resolve(
        &mut self,
        request: [f32; 3],
        epoch: u64,
        sample: impl FnOnce() -> Option<[f32; 3]>,
    ) -> Option<[f32; 3]> {
        let same = self.request == Some(request);
        if same && self.epoch == epoch && self.position.is_some() {
            return self.position;
        }
        let position = sample().or_else(|| if same { self.position } else { None });
        self.request = Some(request);
        self.epoch = epoch;
        self.position = position;
        position
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_paused_snapshots_keep_one_ground_answer() {
        let mut memo = GroundMemo::default();
        let mut casts = 0;
        for _ in 0..100 {
            let p = memo.resolve([1., 0., 2.], 4, || {
                casts += 1;
                Some([1., 10.05, 2.])
            });
            assert_eq!(p, Some([1., 10.05, 2.]));
        }
        assert_eq!(casts, 1);
    }
    #[test]
    fn collider_changes_recheck_and_missing_initial_floor_can_recover() {
        let mut memo = GroundMemo::default();
        assert_eq!(memo.resolve([1., 0., 2.], 1, || None), None);
        assert_eq!(
            memo.resolve([1., 0., 2.], 1, || Some([1., 10., 2.])),
            Some([1., 10., 2.])
        );
        assert_eq!(
            memo.resolve([1., 0., 2.], 2, || Some([1., 11., 2.])),
            Some([1., 11., 2.])
        );
    }
    #[test]
    fn a_streaming_miss_does_not_hide_a_stationary_visible_actor() {
        let mut memo = GroundMemo::default();
        memo.resolve([1., 0., 2.], 1, || Some([1., 10., 2.]));
        assert_eq!(memo.resolve([1., 0., 2.], 2, || None), Some([1., 10., 2.]));
        assert_eq!(
            memo.resolve([1., 0., 2.], 3, || Some([1., 12., 2.])),
            Some([1., 12., 2.])
        );
    }
    #[test]
    fn changed_level_hint_invalidates_same_xy_after_a_seek() {
        let mut memo = GroundMemo::default();
        memo.resolve([1., 413., 2.], 1, || Some([1., 413., 2.]));
        assert_eq!(
            memo.resolve([1., 477., 2.], 1, || Some([1., 477., 2.])),
            Some([1., 477., 2.])
        );
    }
    #[test]
    fn moving_into_unloaded_floor_does_not_reuse_an_unrelated_position() {
        let mut memo = GroundMemo::default();
        memo.resolve([1., 0., 2.], 1, || Some([1., 10., 2.]));
        assert_eq!(memo.resolve([100., 0., 200.], 1, || None), None);
        assert_eq!(
            memo.resolve([100., 0., 200.], 1, || Some([100., 20., 200.])),
            Some([100., 20., 200.])
        );
    }
}

/// All walkable crossings in a vertical column, rather than the first roof hit.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FloorCandidate {
    pub height: f32,
    pub interior: bool,
}

/// WoW-space upward-facing triangle intersection. Walls/ceilings cannot be floors.
pub(crate) fn triangle_floor(tri: &[[f32; 3]; 3], x: f32, y: f32) -> Option<f32> {
    let [a, b, c] = *tri;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if length < 1e-8 || n[2] / length < 0.45 {
        return None;
    }
    let u = ((x - a[0]) * ac[1] - (y - a[1]) * ac[0]) / n[2];
    let v = (ab[0] * (y - a[1]) - ab[1] * (x - a[0])) / n[2];
    if u < -1e-4 || v < -1e-4 || u + v > 1.0001 {
        return None;
    }
    let z = a[2] + u * ab[2] + v * ac[2];
    z.is_finite().then_some(z)
}

/// A level hint is inferred context; the returned height always comes from geometry.
/// Continuity breaks close choices without pinning a seek to an unrelated old floor.
pub(crate) fn choose_floor(
    candidates: &[FloorCandidate],
    hint: f32,
    previous: Option<f32>,
) -> Option<f32> {
    let score = |c: &FloorCandidate| {
        (c.height - hint).abs()
            + previous.map_or(0., |p| (c.height - p).abs().min(40.) * 0.15)
            + if c.interior { 0. } else { 0.25 }
    };
    candidates
        .iter()
        .filter(|c| c.height.is_finite())
        .min_by(|a, b| {
            score(a)
                .total_cmp(&score(b))
                .then_with(|| a.height.total_cmp(&b.height))
        })
        .map(|c| c.height)
}

#[cfg(test)]
mod floor_tests {
    use super::*;
    fn levels(values: &[f32]) -> Vec<FloorCandidate> {
        values
            .iter()
            .map(|&height| FloorCandidate {
                height,
                interior: true,
            })
            .collect()
    }
    #[test]
    fn stacked_bwl_floors_follow_encounter_context_in_both_seek_directions() {
        assert_eq!(
            choose_floor(&levels(&[449.164, 413.309]), 413.465, None),
            Some(413.309)
        );
        assert_eq!(
            choose_floor(&levels(&[477.018, 408.641]), 476.73, Some(408.641)),
            Some(477.018)
        );
        assert_eq!(
            choose_floor(&levels(&[477.018, 408.641]), 409., Some(477.018)),
            Some(408.641)
        );
    }
    #[test]
    fn aq_roof_and_stacked_interior_floors_do_not_win_by_ray_order() {
        let mut floors = levels(&[100.22, -2.138, -98.495]);
        floors.push(FloorCandidate {
            height: 206.502,
            interior: false,
        });
        assert_eq!(choose_floor(&floors, 100.304, None), Some(100.22));
        assert_eq!(choose_floor(&floors, -98., None), Some(-98.495));
        floors.reverse();
        assert_eq!(choose_floor(&floors, 100.304, None), Some(100.22));
    }
    #[test]
    fn floor_intersections_reject_ceiling_and_walls_and_keep_slopes() {
        let tri = [[0., 0., 10.], [10., 0., 10.], [0., 10., 20.]];
        assert_eq!(triangle_floor(&tri, 2., 2.), Some(12.));
        assert_eq!(triangle_floor(&[tri[0], tri[2], tri[1]], 2., 2.), None);
        assert_eq!(triangle_floor(&tri, 20., 20.), None);
        assert_eq!(choose_floor(&[], 100., None), None);
    }
}
