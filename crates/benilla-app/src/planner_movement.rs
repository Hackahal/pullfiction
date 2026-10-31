//! Replay routes reuse the client's walking queries. No log positions are rewritten.
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
    /// Integrated normal-run distance available between the observations.
    #[serde(default)]
    pub travel_budget: Option<f32>,
    #[serde(default)]
    pub run_speed: Option<f32>,
    /// Sparse position estimates, including wisps, need not obey a run-speed cap.
    #[serde(default)]
    pub unrestricted: bool,
}
impl Segment {
    /// Optional reconstruction is discarded independently of the recorded replay pose.
    pub fn validated(self) -> Option<Self> {
        self.valid().then_some(self)
    }

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
            && self.duration <= if self.unrestricted { 120. } else { 2. }
            && match (self.travel_budget, self.run_speed) {
                (None, None) => true,
                (Some(budget), Some(speed)) => {
                    budget.is_finite()
                        && (0.0..=12000.).contains(&budget)
                        && speed.is_finite()
                        && (0.0..=100.).contains(&speed)
                }
                _ => false,
            }
    }
}

/// A malformed optional reconstruction must not discard valid recorded actors.
pub fn deserialize_optional<'de, D>(deserializer: D) -> Result<Option<Segment>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

struct Memo {
    from: Vec3,
    to: Vec3,
    duration: f32,
    unrestricted: bool,
    points: Option<Vec<Vec3>>,
}
#[derive(Default)]
pub(crate) struct Routes {
    revision: u64,
    remaining: usize,
    deferred: bool,
    actors: HashMap<String, Memo>,
}
impl Routes {
    pub(crate) fn clear(&mut self) {
        self.actors.clear();
    }
    pub(crate) fn begin(&mut self, revision: u64) {
        if self.revision != revision {
            self.clear();
            self.revision = revision;
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
        if !self.actors.get(key).is_some_and(|m| {
            m.from == from
                && m.to == to
                && m.duration == segment.duration
                && m.unrestricted == segment.unrestricted
        }) {
            let points = match route_budget(
                probe,
                from,
                to,
                segment.duration,
                segment.unrestricted,
                &mut self.remaining,
            ) {
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
                    unrestricted: segment.unrestricted,
                    points,
                },
            );
        }
        let points = self.actors.get(key)?.points.as_ref()?;
        let (mut point, heading, velocity) = sample_segment(points, segment)?;
        // String-pulling removes horizontal waypoints, not the stairs/terrain beneath a leg.
        point.y = probe.floor(point.x, point.z, point.y)?;
        Some((point, heading, velocity))
    }
}

#[cfg(test)]
fn route(probe: &impl Probe, from: Vec3, to: Vec3, duration: f32) -> Option<Vec<Vec3>> {
    route_budget(probe, from, to, duration, false, &mut 4).unwrap()
}

fn route_budget(
    probe: &impl Probe,
    from: Vec3,
    to: Vec3,
    duration: f32,
    unrestricted: bool,
    budget: &mut usize,
) -> Result<Option<Vec<Vec3>>, ()> {
    let mut deferred = false;
    let result = (|| {
        if from.distance(to) > if unrestricted { 400. } else { 40. } {
            return None;
        }
        // Long direct legs also consume a job: their floor probes can be costly.
        if unrestricted {
            if *budget == 0 {
                deferred = true;
                return None;
            }
            *budget -= 1;
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
            if !unrestricted {
                if *budget == 0 {
                    deferred = true;
                    return None;
                }
                *budget -= 1;
            }
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
        if unrestricted && points.windows(2).map(|p| p[0].distance(p[1])).sum::<f32>() > 800. {
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
        if length <= 0.03 || !unrestricted && length / duration > 20. {
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

/// Cadence follows the recorded movement aura, not an impossible anchor velocity.
pub(crate) fn gait_speed(translation: f32, normal: Option<f32>) -> f32 {
    if translation > 0.1 {
        normal.unwrap_or(7.)
    } else {
        translation
    }
}

fn sample_segment(points: &[Vec3], segment: &Segment) -> Option<(Vec3, f32, f32)> {
    let length: f32 = points.windows(2).map(|p| p[0].distance(p[1])).sum();
    let (mut fraction, mut rate) = (segment.fraction, segment.rate);
    if let Some(budget) = segment
        .travel_budget
        .filter(|b| !segment.unrestricted && *b >= length && length > 0.)
    {
        let travelled = fraction * budget - (budget - length) / 2.;
        fraction = (travelled / length).clamp(0., 1.);
        rate = if travelled >= 0. && travelled < length {
            rate * budget / length
        } else {
            0.
        };
    }
    sample(points, fraction, rate)
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
            travel_budget: None,
            run_speed: None,
            unrestricted: false,
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
    #[test]
    fn invalid_optional_segments_preserve_recorded_actor_fallbacks() {
        let mut invalid = segment();
        invalid.fraction = 1.1;
        let mut frame = vec![
            ("bad", Vec3::new(1., 2., 3.), Some(invalid)),
            ("good", Vec3::new(4., 5., 6.), Some(segment())),
            ("unplanned", Vec3::new(7., 8., 9.), None),
        ];
        for actor in &mut frame {
            actor.2 = actor.2.take().and_then(Segment::validated);
        }
        assert_eq!(frame.len(), 3);
        assert_eq!((frame[0].0, frame[0].1), ("bad", Vec3::new(1., 2., 3.)));
        assert!(frame[0].2.is_none());
        assert_eq!(frame[1].2.as_ref().unwrap().from, segment().from);
        assert!(frame[2].2.is_none());
    }
    #[test]
    fn floor_misses_recover_when_readiness_changes_without_a_collider_epoch() {
        let mut probe = Wall {
            probes: Cell::new(0),
            loaded: false,
        };
        let mut readiness = readiness::NativeReadiness::<u32>::default();
        let mut routes = Routes::default();
        let first = readiness.observe(7, [], None, true, false);
        routes.begin(first);
        assert!(routes.pose("p", &segment(), &probe).is_none());
        probe.loaded = true;
        let unchanged = readiness.observe(7, [], None, true, false);
        assert_eq!(first, unchanged);
        routes.begin(unchanged);
        assert!(routes.pose("p", &segment(), &probe).is_none());
        let loaded = readiness.observe(7, [], None, true, true);
        assert_ne!(first, loaded);
        routes.begin(loaded);
        assert!(routes.pose("p", &segment(), &probe).is_some());
    }
    #[test]
    fn malformed_optional_movement_keeps_the_deserialized_frame() {
        #[derive(serde::Deserialize)]
        struct Actor {
            key: String,
            position: [f32; 3],
            #[serde(default, deserialize_with = "super::deserialize_optional")]
            movement: Option<Segment>,
        }
        for bad in [
            "null",
            "false",
            "[]",
            "42",
            r#"{"from":null}"#,
            r#"{"from":[0,0,0],"to":[1,0,0],"fraction":"bad","rate":1,"duration":1,"recorded_facing":false}"#,
        ] {
            let json = format!(
                r#"[{{"key":"bad","position":[1,2,3],"movement":{bad}}},{{"key":"other","position":[4,5,6]}}]"#
            );
            let actors: Vec<Actor> = serde_json::from_str(&json).unwrap();
            assert_eq!(actors.len(), 2);
            assert_eq!(actors[0].key, "bad");
            assert_eq!(actors[0].position, [1., 2., 3.]);
            assert!(actors[0].movement.is_none());
            assert_eq!(actors[1].position, [4., 5., 6.]);
        }
        let valid: Actor = serde_json::from_str(r#"{"key":"p","position":[1,2,3],"movement":{"from":[0,0,0],"to":[1,0,0],"fraction":0.5,"rate":1,"duration":1,"recorded_facing":false}}"#).unwrap();
        assert!(valid.movement.unwrap().valid());
        assert!(
            serde_json::from_str::<Actor>(r#"{"key":"p","position":"bad","movement":null}"#)
                .is_err()
        );
    }
    #[test]
    fn normal_run_has_constant_speed_with_holds_and_exact_anchors() {
        let points = [Vec3::ZERO, Vec3::new(6., 0., 0.)];
        let mut s = segment();
        s.travel_budget = Some(14.);
        s.run_speed = Some(7.);
        for (fraction, x, speed) in [
            (0., 0., 0.),
            (0.1, 0., 0.),
            (0.4, 1.6, 7.),
            (0.5, 3., 7.),
            (0.6, 4.4, 7.),
            (0.9, 6., 0.),
            (1., 6., 0.),
        ] {
            s.fraction = fraction;
            let (p, _, v) = sample_segment(&points, &s).unwrap();
            assert!((p.x - x).abs() < 0.001);
            assert!((v - speed).abs() < 0.001);
        }
    }
    #[test]
    fn detour_uses_its_actual_length_and_impossible_spans_preserve_anchors() {
        let points = [Vec3::ZERO, Vec3::new(0., 0., 4.), Vec3::new(6., 0., 4.)];
        let mut s = segment();
        s.travel_budget = Some(14.);
        s.run_speed = Some(7.);
        s.fraction = 0.4;
        let (p, heading, v) = sample_segment(&points, &s).unwrap();
        assert!((v - 7.).abs() < 0.001);
        assert!((p.z - 3.6).abs() < 0.001);
        assert!((heading.abs() - std::f32::consts::PI).abs() < 0.001);
        s.travel_budget = Some(7.);
        s.rate = 1.;
        for (fraction, want) in [(0., points[0]), (1., points[2])] {
            s.fraction = fraction;
            assert_eq!(sample_segment(&points, &s).unwrap().0, want);
        }
        s.fraction = 0.5;
        let v = sample_segment(&points, &s).unwrap().2;
        assert_eq!(v, 10.);
        assert_eq!(gait_speed(v, s.run_speed), 7.);
        assert_eq!(gait_speed(0., s.run_speed), 0.);
        assert_eq!(gait_speed(20., Some(11.9)), 11.9);
    }
    #[test]
    fn sparse_wisps_route_faster_than_normal_without_unbounded_work() {
        struct Open;
        impl Probe for Open {
            fn floor(&self, _: f32, _: f32, _: f32) -> Option<f32> {
                Some(0.)
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                true
            }
        }
        let mut s = segment();
        s.to = [0., -100., 0.];
        s.duration = 3.;
        s.rate = 1. / 3.;
        s.unrestricted = true;
        s.travel_budget = Some(21.);
        s.run_speed = Some(7.);
        let mut routes = Routes::default();
        routes.begin(1);
        for i in 0..4 {
            let (p, _, v) = routes.pose(&i.to_string(), &s, &Open).unwrap();
            assert!((p.x - 50.).abs() < 0.001);
            assert!(v > 30.);
        }
        assert!(routes.pose("deferred", &s, &Open).is_none());
        assert!(routes.deferred());
        routes.begin(1);
        assert!(routes.pose("deferred", &s, &Open).is_some());
        s.unrestricted = false;
        s.duration = 2.;
        assert!(routes.pose("0", &s, &Open).is_none());
        s.unrestricted = true;
        s.duration = 3.;
        s.to = [0., -401., 0.];
        assert!(routes.pose("far", &s, &Open).is_none());
    }
    #[test]
    fn optional_timing_rejects_partial_nonfinite_and_out_of_bounds_values() {
        for (budget, speed) in [
            (Some(f32::NAN), Some(7.)),
            (Some(7.), None),
            (None, Some(7.)),
            (Some(-1.), Some(7.)),
            (Some(7.), Some(101.)),
        ] {
            let mut s = segment();
            s.travel_budget = budget;
            s.run_speed = speed;
            assert!(!s.valid());
        }
        let mut s = segment();
        s.duration = 120.;
        assert!(!s.valid());
        s.unrestricted = true;
        assert!(s.valid());
        s.duration = 120.01;
        assert!(!s.valid());
    }
}
