//! Short replay routes reuse the client's walking queries. No log positions are rewritten.
use crate::webbridge::path::{self, Probe};
use bevy::math::Vec3;
use std::collections::HashMap;

#[derive(Clone, serde::Deserialize)]
pub struct Segment {
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub fraction: f32,
    /// Fraction of the whole route travelled per replay second, independent of playback rate.
    pub rate: f32,
    pub duration: f32,
    pub recorded_facing: bool,
}
impl Segment {
    pub fn valid(&self) -> bool {
        self.from
            .iter()
            .chain(self.to.iter())
            .all(|v| v.is_finite() && v.abs() <= 20000.)
            && self.fraction.is_finite()
            && (0.0..=1.0).contains(&self.fraction)
            && self.rate.is_finite()
            && (0.0..=1000.).contains(&self.rate)
            && self.duration.is_finite()
            && self.duration > 0.
            && self.duration <= 2.
    }
}

struct Memo {
    from: Vec3,
    to: Vec3,
    duration: f32,
    points: Option<Vec<Vec3>>,
}
#[derive(Default)]
pub(crate) struct Routes {
    epoch: u64,
    remaining: usize,
    deferred: bool,
    actors: HashMap<String, Memo>,
}
impl Routes {
    pub(crate) fn clear(&mut self) {
        self.actors.clear();
    }
    pub(crate) fn begin(&mut self, epoch: u64) {
        if self.epoch != epoch {
            self.clear();
            self.epoch = epoch;
        }
        self.remaining = 4;
        self.deferred = false;
    }
    pub(crate) fn deferred(&self) -> bool {
        self.deferred
    }
    pub(crate) fn retain(&mut self, keep: &std::collections::HashSet<&str>) {
        self.actors.retain(|k, _| keep.contains(k.as_str()));
    }
    pub(crate) fn pose(
        &mut self,
        key: &str,
        segment: &Segment,
        probe: &impl Probe,
    ) -> Option<(Vec3, f32, f32)> {
        if !segment.valid() {
            return None;
        }
        let from = benilla_assets::coords::wow_to_bevy(segment.from);
        let to = benilla_assets::coords::wow_to_bevy(segment.to);
        if !self
            .actors
            .get(key)
            .is_some_and(|m| m.from == from && m.to == to && m.duration == segment.duration)
        {
            let points = match route_budget(probe, from, to, segment.duration, &mut self.remaining)
            {
                Ok(points) => points,
                Err(()) => {
                    self.deferred = true;
                    return None;
                }
            };
            self.actors.insert(
                key.to_owned(),
                Memo {
                    from,
                    to,
                    duration: segment.duration,
                    points,
                },
            );
        }
        let points = self.actors.get(key)?.points.as_ref()?;
        let (mut point, heading, velocity) = sample(points, segment.fraction, segment.rate)?;
        // String-pulling removes horizontal waypoints, not the stairs/terrain beneath a leg.
        point.y = probe.floor(point.x, point.z, point.y)?;
        Some((point, heading, velocity))
    }
}

#[cfg(test)]
fn route(probe: &impl Probe, from: Vec3, to: Vec3, duration: f32) -> Option<Vec<Vec3>> {
    route_budget(probe, from, to, duration, &mut 4).unwrap()
}

fn route_budget(
    probe: &impl Probe,
    from: Vec3,
    to: Vec3,
    duration: f32,
    budget: &mut usize,
) -> Result<Option<Vec<Vec3>>, ()> {
    let mut deferred = false;
    let result = (|| {
        if from.distance(to) > 40. {
            return None;
        }
        let start = Vec3::new(from.x, probe.floor(from.x, from.z, from.y)?, from.z);
        let goal = Vec3::new(to.x, probe.floor(to.x, to.z, to.y)?, to.z);
        // A floor on another storey is not a substitute for an observed/hinted endpoint.
        if (start.y - from.y).abs() > 2. || (goal.y - to.y).abs() > 2. {
            return None;
        }
        let points = if path::straight(probe, start, goal) {
            vec![start, goal]
        } else {
            if *budget == 0 {
                deferred = true;
                return None;
            }
            *budget -= 1;
            let found = path::find(probe, start, goal, 2048)?;
            if found.partial {
                return None;
            }
            found.points
        };
        // The shared search's arrival radius can report success short of the exact goal.
        if points.last()?.distance(goal) > 0.01 {
            return None;
        }
        // Horizontal string-pulling may discard a hill's summit or a stair landing.
        // Rebuild close floor samples from each known previous height, rather than
        // probing from the endpoint chord (which could be below the real floor).
        let mut grounded = vec![points[0]];
        for pair in points.windows(2) {
            let steps = ((pair[1] - pair[0]).with_y(0.).length() / 0.5)
                .ceil()
                .max(1.) as usize;
            for step in 1..=steps {
                let p = pair[0].lerp(pair[1], step as f32 / steps as f32);
                let reference = grounded.last()?.y;
                let y = probe.floor(p.x, p.z, reference)?;
                if (y - reference).abs() > 2. {
                    return None;
                }
                grounded.push(Vec3::new(p.x, y, p.z));
            }
        }
        if grounded.last()?.distance(goal) > 0.01 {
            return None;
        }
        let points = grounded;
        let length: f32 = points.windows(2).map(|p| p[0].distance(p[1])).sum();
        if length <= 0.03 || length / duration > 20. {
            return None;
        }
        Some(points)
    })();
    if deferred {
        Err(())
    } else {
        Ok(result)
    }
}

fn sample(points: &[Vec3], fraction: f32, rate: f32) -> Option<(Vec3, f32, f32)> {
    let length: f32 = points.windows(2).map(|p| p[0].distance(p[1])).sum();
    let mut remaining = length * fraction;
    for (i, pair) in points.windows(2).enumerate() {
        let delta = pair[1] - pair[0];
        let leg = delta.length();
        if leg <= 0.00001 {
            continue;
        }
        if remaining <= leg || i == points.len() - 2 {
            let pos = pair[0].lerp(pair[1], (remaining / leg).clamp(0., 1.));
            let facing = (-delta.x).atan2(-delta.z);
            return Some((pos, facing, length * rate));
        }
        remaining -= leg;
    }
    None
}

#[cfg(test)]
#[path = "planner_replay_readiness.rs"]
mod readiness;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Wall {
        probes: Cell<usize>,
        loaded: bool,
    }
    impl Probe for Wall {
        fn floor(&self, _: f32, _: f32, _: f32) -> Option<f32> {
            self.probes.set(self.probes.get() + 1);
            self.loaded.then_some(0.)
        }
        fn clear(&self, a: Vec3, b: Vec3) -> bool {
            if (a.x - 3.) * (b.x - 3.) > 0. {
                return true;
            }
            if (b.x - a.x).abs() < 0.00001 {
                return a.z.min(b.z) > 1.5 || a.z.max(b.z) < -1.5;
            }
            let t = (3. - a.x) / (b.x - a.x);
            (a.z + (b.z - a.z) * t).abs() > 1.5
        }
    }
    fn segment() -> Segment {
        Segment {
            from: [0., 0., 0.],
            to: [0., -6., 0.],
            fraction: 0.5,
            rate: 0.5,
            duration: 2.,
            recorded_facing: false,
        }
    }
    #[test]
    fn wall_route_keeps_exact_anchors_and_never_crosses_wall() {
        let probe = Wall {
            probes: Cell::new(0),
            loaded: true,
        };
        let points = route(&probe, Vec3::ZERO, Vec3::new(6., 0., 0.), 2.).unwrap();
        assert_eq!(sample(&points, 0., 0.5).unwrap().0, Vec3::ZERO);
        assert_eq!(sample(&points, 1., 0.5).unwrap().0, Vec3::new(6., 0., 0.));
        for pair in points.windows(2) {
            assert!(probe.clear(pair[0], pair[1]));
        }
        assert!(sample(&points, 0.5, 0.5).unwrap().0.z.abs() > 1.5);
    }
    #[test]
    fn seek_order_does_not_change_pose_and_cached_frames_do_not_search() {
        let probe = Wall {
            probes: Cell::new(0),
            loaded: true,
        };
        let mut routes = Routes::default();
        routes.begin(1);
        let mut s = segment();
        let first = routes.pose("p", &s, &probe).unwrap();
        let count = probe.probes.get();
        s.fraction = 0.9;
        routes.pose("p", &s, &probe);
        s.fraction = 0.5;
        assert_eq!(routes.pose("p", &s, &probe).unwrap(), first);
        assert_eq!(probe.probes.get(), count + 2);
        routes.begin(2);
        routes.pose("p", &s, &probe);
        assert!(probe.probes.get() > count);
    }
    #[test]
    fn missing_collision_recovers_on_epoch_and_work_is_bounded() {
        let mut probe = Wall {
            probes: Cell::new(0),
            loaded: false,
        };
        let mut routes = Routes::default();
        routes.begin(1);
        assert!(routes.pose("p", &segment(), &probe).is_none());
        probe.loaded = true;
        assert!(routes.pose("p", &segment(), &probe).is_none());
        routes.begin(2);
        assert!(routes.pose("p", &segment(), &probe).is_some());
        for key in ["a", "b", "c"] {
            routes.pose(key, &segment(), &probe);
        }
        let count = probe.probes.get();
        assert!(routes.pose("deferred", &segment(), &probe).is_none());
        assert!(probe.probes.get() - count < 12);
        assert!(routes.deferred());
        routes.begin(2);
        assert!(routes.pose("deferred", &segment(), &probe).is_some());
    }
    #[test]
    fn implausible_routes_and_bad_transport_are_rejected() {
        let probe = Wall {
            probes: Cell::new(0),
            loaded: true,
        };
        assert!(route(&probe, Vec3::ZERO, Vec3::new(6., 0., 0.), 0.1).is_none());
        assert!(route(&probe, Vec3::ZERO, Vec3::new(6., 10., 0.), 2.).is_none());
        let mut s = segment();
        s.rate = f32::NAN;
        assert!(!s.valid());
        s = segment();
        s.fraction = 1.1;
        assert!(!s.valid());
    }
    #[test]
    fn clear_routes_do_not_consume_the_search_budget() {
        struct Open;
        impl Probe for Open {
            fn floor(&self, _: f32, _: f32, _: f32) -> Option<f32> {
                Some(0.)
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                true
            }
        }
        let mut routes = Routes::default();
        routes.begin(1);
        for i in 0..40 {
            assert!(routes.pose(&i.to_string(), &segment(), &Open).is_some());
        }
        assert_eq!(routes.remaining, 4);
        assert!(!routes.deferred());
    }
    #[test]
    fn stairs_follow_the_floor_and_unreachable_routes_are_not_used() {
        struct Stairs;
        impl Probe for Stairs {
            fn floor(&self, x: f32, _: f32, _: f32) -> Option<f32> {
                Some((x / 2.).floor().clamp(0., 3.) * 0.5)
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                true
            }
        }
        let mut s = segment();
        s.to[2] = 1.5;
        let mut routes = Routes::default();
        routes.begin(1);
        let p = routes.pose("stairs", &s, &Stairs).unwrap().0;
        assert_eq!(p.y, (p.x / 2.).floor().clamp(0., 3.) * 0.5);
        assert!((2. ..4.).contains(&p.x));
        struct Blocked;
        impl Probe for Blocked {
            fn floor(&self, _: f32, _: f32, _: f32) -> Option<f32> {
                Some(0.)
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                false
            }
        }
        assert!(routes.pose("blocked", &segment(), &Blocked).is_none());
    }
    #[test]
    fn paused_retained_frame_finishes_deferred_routes() {
        let probe = Wall {
            probes: Cell::new(0),
            loaded: true,
        };
        let mut routes = Routes::default();
        let mut frame = readiness::RetainedFrame::default();
        frame.synchronize((409, 1), false);
        frame.replace(["a", "b", "c", "d", "e", "f"]);
        routes.begin(1);
        for key in frame.ready(1, false).unwrap() {
            routes.pose(key, &segment(), &probe);
        }
        frame.applied(1);
        assert!(routes.deferred());
        if routes.deferred() {
            frame.retry_after_spawn();
        }
        routes.begin(1);
        for key in frame.ready(1, false).unwrap() {
            assert!(routes.pose(key, &segment(), &probe).is_some());
        }
        frame.applied(1);
        assert!(!routes.deferred());
        assert!(frame.ready(1, false).is_none());
    }
    #[test]
    fn smoothed_hill_keeps_height_with_production_floor_ray_limits() {
        struct Hill;
        impl Probe for Hill {
            fn floor(&self, x: f32, _: f32, y: f32) -> Option<f32> {
                let h = (3. - (x - 3.).abs()).max(0.);
                (h <= y + 1.6 && h >= y - 4.).then_some(h)
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                true
            }
        }
        let mut routes = Routes::default();
        routes.begin(1);
        let p = routes.pose("hill", &segment(), &Hill).unwrap().0;
        assert!((p.x - 3.).abs() < 0.001);
        assert!((p.y - 3.).abs() < 0.001);
    }
}
