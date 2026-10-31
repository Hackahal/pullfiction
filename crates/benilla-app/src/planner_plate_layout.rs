//! Replay-only placement. Coordinates are logical screen pixels, independent of client UI scale.
use std::collections::HashMap;
#[derive(Clone, Copy, Debug)]
pub(crate) struct Candidate {
    pub key: u64,
    pub anchor: [f32; 2],
    pub size: [f32; 2],
    pub priority: u8,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Placed {
    pub key: u64,
    pub top: [f32; 2],
}
#[derive(Default)]
pub(crate) struct Layout {
    offsets: HashMap<u64, [f32; 2]>,
}
fn overlaps(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}
impl Layout {
    pub fn place(&mut self, mut units: Vec<Candidate>, viewport: [f32; 2], dt: f32) -> Vec<Placed> {
        units.sort_by_key(|u| (u.priority, u.key));
        self.offsets
            .retain(|key, _| units.iter().any(|u| u.key == *key));
        let mut occupied = Vec::new();
        let mut result = Vec::new();
        for u in units {
            let base = [u.anchor[0] - u.size[0] / 2., u.anchor[1] - u.size[1] - 6.];
            let previous = self.offsets.get(&u.key).copied().unwrap_or([0., 0.]);
            let mut choices = vec![previous, [0., 0.]];
            for row in 0..7 {
                for col in [0, -1, 1, -2, 2] {
                    choices.push([
                        col as f32 * (u.size[0] + 8.),
                        -(row as f32) * (u.size[1] + 7.),
                    ]);
                }
            }
            choices.sort_by(|a, b| {
                let score = |v: [f32; 2]| {
                    v[0] * v[0]
                        + v[1] * v[1]
                        + 0.9 * ((v[0] - previous[0]).powi(2) + (v[1] - previous[1]).powi(2))
                };
                score(*a).total_cmp(&score(*b))
            });
            let limit = if u.priority < 2 { 260. } else { 180. };
            let rect = |offset: [f32; 2]| {
                [
                    base[0] + offset[0] - 3.,
                    base[1] + offset[1] - 3.,
                    base[0] + offset[0] + u.size[0] + 3.,
                    base[1] + offset[1] + u.size[1] + 3.,
                ]
            };
            let fits = |r: [f32; 4], occupied: &Vec<[f32; 4]>| {
                r[0] >= 6.
                    && r[1] >= 100.
                    && r[2] <= viewport[0] - 6.
                    && r[3] <= viewport[1] - 70.
                    && !occupied.iter().any(|o| overlaps(r, *o))
            };
            let Some(desired) = choices
                .into_iter()
                .find(|v| v[0].abs() <= limit && v[1].abs() <= limit && fits(rect(*v), &occupied))
            else {
                continue;
            };
            let alpha = 1. - (-14. * dt.min(0.1)).exp();
            let eased = [
                previous[0] + (desired[0] - previous[0]) * alpha,
                previous[1] + (desired[1] - previous[1]) * alpha,
            ];
            let offset = if fits(rect(eased), &occupied) {
                eased
            } else {
                desired
            };
            occupied.push(rect(offset));
            self.offsets.insert(u.key, offset);
            result.push(Placed {
                key: u.key,
                top: [base[0] + offset[0], base[1] + offset[1]],
            });
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(key: u64) -> Candidate {
        Candidate {
            key,
            anchor: [500., 500.],
            size: [100., 30.],
            priority: 2,
        }
    }
    #[test]
    fn crowded_units_do_not_overlap_and_stay_near_their_actors() {
        let mut l = Layout::default();
        let p = l.place((1..15).map(candidate).collect(), [1000., 800.], 0.05);
        assert!(p.len() > 5);
        for (a, i) in p.iter().enumerate() {
            assert!((i.top[0] - 450.).abs() <= 180.);
            assert!((i.top[1] - 464.).abs() <= 180.);
            for j in &p[a + 1..] {
                assert!(!overlaps(
                    [i.top[0], i.top[1], i.top[0] + 100., i.top[1] + 30.],
                    [j.top[0], j.top[1], j.top[0] + 100., j.top[1] + 30.]
                ));
            }
        }
    }
    #[test]
    fn input_reordering_does_not_swap_lanes_and_camera_motion_follows_anchors() {
        let mut l = Layout::default();
        let units = vec![candidate(1), candidate(2), candidate(3)];
        let a = l.place(units.clone(), [1000., 800.], 0.05);
        let b = l.place(units.iter().rev().copied().collect(), [1000., 800.], 0.05);
        for (p, q) in a.iter().zip(&b) {
            assert_eq!(p.key, q.key);
            assert_eq!(p.top, q.top);
        }
        let c = l.place(
            units
                .into_iter()
                .map(|mut u| {
                    u.anchor[0] += 12.;
                    u
                })
                .collect(),
            [1000., 800.],
            0.05,
        );
        for (p, q) in b.iter().zip(&c) {
            assert_eq!(q.top[0] - p.top[0], 12.);
        }
    }
    #[test]
    fn selected_enemy_keeps_the_anchor_before_friendly_plates() {
        let mut l = Layout::default();
        let mut enemy = candidate(99);
        enemy.priority = 0;
        let p = l.place(vec![candidate(1), enemy], [1000., 800.], 0.05);
        assert_eq!(p[0].key, 99);
        assert_eq!(p[0].top, [450., 464.]);
    }
}
