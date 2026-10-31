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

/// Local diagnostic values are serialized only when explicitly requested by the viewer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteReason {
    Searching,
    FrameBudget,
    MissingFloor,
    EndpointFloor,
    DistanceLimit,
    Partial,
    IncompleteGoal,
    Reconstruction,
    LengthLimit,
    SpeedLimit,
    Ready,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteStatus {
    Pending,
    Ready,
    Deferred,
    Held,
}
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementDiagnostic {
    pub key: String,
    pub status: RouteStatus,
    pub reason: RouteReason,
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub rendered_position: [f32; 3],
    pub route_point_count: usize,
    pub expanded: usize,
    pub cache_hit: bool,
}
enum RouteState {
    Pending(path::Search),
    Ready(Vec<Vec3>),
    Failed(RouteReason),
}
struct Memo {
    from: Vec3,
    to: Vec3,
    duration: f32,
    unrestricted: bool,
    state: RouteState,
    expanded: usize,
    reason: RouteReason,
    rendered: Vec3,
    cache_hit: bool,
}
const FRAME_EXPANSIONS: usize = 2048;
#[derive(Default)]
pub(crate) struct Routes {
    revision: u64,
    remaining: usize,
    expansions: usize,
    search_jobs: usize,
    deferred: bool,
    actors: HashMap<String, Memo>,
}
impl Routes {
    pub(crate) fn clear(&mut self) {
        self.actors.clear();
        self.deferred = false;
    }
    pub(crate) fn begin(&mut self, revision: u64) {
        if self.revision != revision {
            self.clear();
            self.revision = revision;
        }
        self.remaining = 4;
        self.expansions = FRAME_EXPANSIONS;
        self.search_jobs = 4;
        self.deferred = false;
    }
    pub(crate) fn deferred(&self) -> bool {
        self.deferred
    }
    pub(crate) fn remove(&mut self, key: &str) {
        self.actors.remove(key);
    }
    pub(crate) fn retain(&mut self, keep: &std::collections::HashSet<&str>) {
        self.actors.retain(|k, _| keep.contains(k.as_str()));
    }
    pub(crate) fn diagnostics(&self) -> Vec<MovementDiagnostic> {
        let mut keys: Vec<_> = self.actors.keys().collect();
        keys.sort();
        keys.into_iter()
            .take(256)
            .map(|key| {
                let m = &self.actors[key];
                MovementDiagnostic {
                    key: key.clone(),
                    status: match m.state {
                        RouteState::Pending(_) => RouteStatus::Pending,
                        RouteState::Ready(_) if m.reason == RouteReason::Ready => {
                            RouteStatus::Ready
                        }
                        RouteState::Ready(_) => RouteStatus::Held,
                        RouteState::Failed(RouteReason::FrameBudget) => RouteStatus::Deferred,
                        RouteState::Failed(_) => RouteStatus::Held,
                    },
                    reason: m.reason,
                    from: benilla_assets::coords::bevy_to_wow(m.from),
                    to: benilla_assets::coords::bevy_to_wow(m.to),
                    rendered_position: benilla_assets::coords::bevy_to_wow(
                        m.rendered + Vec3::Y * 0.05,
                    ),
                    route_point_count: match &m.state {
                        RouteState::Ready(p) => p.len(),
                        _ => 0,
                    },
                    expanded: m.expanded,
                    cache_hit: m.cache_hit,
                }
            })
            .collect()
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
        let cache_hit = self.actors.get(key).is_some_and(|m| {
            m.from == from
                && m.to == to
                && m.duration == segment.duration
                && m.unrestricted == segment.unrestricted
                && !matches!(m.state, RouteState::Failed(RouteReason::FrameBudget))
        });
        if !cache_hit {
            let state = if self.remaining == 0 && segment.unrestricted {
                RouteState::Failed(RouteReason::FrameBudget)
            } else {
                if segment.unrestricted {
                    self.remaining -= 1;
                }
                start_route(
                    probe,
                    from,
                    to,
                    segment.duration,
                    segment.unrestricted,
                    &mut self.remaining,
                )
            };
            self.actors.insert(
                key.to_owned(),
                Memo {
                    from,
                    to,
                    duration: segment.duration,
                    unrestricted: segment.unrestricted,
                    state,
                    expanded: 0,
                    reason: RouteReason::Searching,
                    rendered: from,
                    cache_hit: false,
                },
            );
        }
        let memo = self.actors.get_mut(key)?;
        memo.cache_hit = cache_hit;
        if let RouteState::Pending(search) = &mut memo.state {
            if self.expansions == 0 || self.search_jobs == 0 {
                memo.reason = RouteReason::FrameBudget;
                self.deferred = true;
            } else {
                self.search_jobs -= 1;
                let before = search.expanded();
                let total = if segment.unrestricted {
                    path::MAX_EXPANSIONS
                } else {
                    2048
                };
                let done = search.advance(probe, self.expansions, total);
                let used = search.expanded() - before;
                self.expansions -= used;
                memo.expanded = search.expanded();
                if done {
                    let RouteState::Pending(search) = std::mem::replace(
                        &mut memo.state,
                        RouteState::Failed(RouteReason::Partial),
                    ) else {
                        unreachable!()
                    };
                    let found = if segment.unrestricted {
                        search.finish_raw(probe)
                    } else {
                        search.finish(probe)
                    };
                    memo.state = if found.partial {
                        RouteState::Failed(RouteReason::Partial)
                    } else {
                        finish_route(
                            probe,
                            found.points,
                            from,
                            to,
                            segment.duration,
                            segment.unrestricted,
                        )
                    };
                } else {
                    memo.reason = RouteReason::Searching;
                    self.deferred = true;
                }
            }
        }
        // Normal direct routes can defer when the four search jobs are already consumed.
        if matches!(memo.state, RouteState::Failed(RouteReason::FrameBudget)) {
            self.deferred = true;
        }
        let fallback = (if segment.fraction == 1. { to } else { from }, 0., 0.);
        let pose = match &memo.state {
            RouteState::Ready(points) => {
                memo.reason = RouteReason::Ready;
                if segment.fraction == 0. || segment.fraction == 1. {
                    fallback
                } else {
                    // The cached polyline already passed collision validation. Projecting
                    // this sample again can move it onto a different stair/corner curve.
                    sample_segment(points, segment).unwrap_or(fallback)
                }
            }
            RouteState::Failed(reason) => {
                memo.reason = *reason;
                fallback
            }
            RouteState::Pending(_) => fallback,
        };
        memo.rendered = pose.0;
        Some(pose)
    }
}
fn start_route(
    probe: &impl Probe,
    from: Vec3,
    to: Vec3,
    duration: f32,
    unrestricted: bool,
    budget: &mut usize,
) -> RouteState {
    let result = (|| {
        if from.distance(to) > if unrestricted { 400. } else { 40. } {
            return Err(RouteReason::DistanceLimit);
        }
        let start = Vec3::new(
            from.x,
            probe
                .floor(from.x, from.z, from.y)
                .ok_or(RouteReason::MissingFloor)?,
            from.z,
        );
        let goal = Vec3::new(
            to.x,
            probe
                .floor(to.x, to.z, to.y)
                .ok_or(RouteReason::MissingFloor)?,
            to.z,
        );
        if (start.y - from.y).abs() > 2. || (goal.y - to.y).abs() > 2. {
            return Err(RouteReason::EndpointFloor);
        }
        if path::straight(probe, start, goal) {
            return Ok(finish_route(
                probe,
                vec![start, goal],
                from,
                to,
                duration,
                unrestricted,
            ));
        }
        if !unrestricted {
            if *budget == 0 {
                return Err(RouteReason::FrameBudget);
            }
            *budget -= 1;
        }
        Ok(RouteState::Pending(
            path::Search::new(probe, start, goal).ok_or(RouteReason::MissingFloor)?,
        ))
    })();
    result.unwrap_or_else(RouteState::Failed)
}
fn finish_route(
    probe: &impl Probe,
    points: Vec<Vec3>,
    from: Vec3,
    to: Vec3,
    duration: f32,
    unrestricted: bool,
) -> RouteState {
    let result = (|| {
        let goal = Vec3::new(
            to.x,
            probe
                .floor(to.x, to.z, to.y)
                .ok_or(RouteReason::MissingFloor)?,
            to.z,
        );
        if points
            .last()
            .ok_or(RouteReason::IncompleteGoal)?
            .distance(goal)
            > 0.01
        {
            return Err(RouteReason::IncompleteGoal);
        }
        if unrestricted && points.windows(2).map(|p| p[0].distance(p[1])).sum::<f32>() > 800. {
            return Err(RouteReason::LengthLimit);
        }
        let mut grounded = vec![points[0]];
        for pair in points.windows(2) {
            // Refine a whole trusted leg transactionally. A downward floor ray can
            // select a stair face that bends an otherwise capsule-clear 3D edge.
            let refined = (|| {
                let mut leg = vec![pair[0]];
                let steps = ((pair[1] - pair[0]).with_y(0.).length() / 0.5)
                    .ceil()
                    .max(1.) as usize;
                for step in 1..=steps {
                    let p = pair[0].lerp(pair[1], step as f32 / steps as f32);
                    let previous = *leg.last()?;
                    let y = probe.floor(p.x, p.z, previous.y)?;
                    let point = Vec3::new(p.x, y, p.z);
                    if (y - previous.y).abs() > 2. || !probe.clear(previous, point) {
                        return None;
                    }
                    leg.push(point);
                }
                if leg.last()?.distance(pair[1]) > 0.01 {
                    return None;
                }
                // Keep the exact trusted endpoint so adjacent refined/original
                // legs share the same joint, with no unchecked connector.
                *leg.last_mut()? = pair[1];
                if !probe.clear(leg[leg.len() - 2], pair[1]) {
                    return None;
                }
                Some(leg)
            })();
            if *grounded.last().unwrap() != pair[0] {
                return Err(RouteReason::Reconstruction);
            }
            if let Some(leg) = refined {
                grounded.extend_from_slice(&leg[1..]);
            } else if probe.clear(pair[0], pair[1]) {
                grounded.push(pair[1]);
            } else {
                return Err(RouteReason::Reconstruction);
            }
        }
        if grounded.last().unwrap().distance(goal) > 0.01 {
            return Err(RouteReason::IncompleteGoal);
        }
        let length: f32 = grounded.windows(2).map(|p| p[0].distance(p[1])).sum();
        if length <= 0.03 {
            return Err(RouteReason::LengthLimit);
        }
        if !unrestricted && length / duration > 20. {
            return Err(RouteReason::SpeedLimit);
        }
        // Observed endpoint heights remain authoritative after the collision floor checks.
        grounded[0] = from;
        *grounded.last_mut().unwrap() = to;
        if !probe.clear(grounded[0], grounded[1])
            || !probe.clear(grounded[grounded.len() - 2], *grounded.last().unwrap())
        {
            return Err(RouteReason::Reconstruction);
        }
        if unrestricted && length > 800. {
            return Err(RouteReason::LengthLimit);
        }
        Ok(grounded)
    })();
    match result {
        Ok(points) => RouteState::Ready(points),
        Err(reason) => RouteState::Failed(reason),
    }
}
#[cfg(test)]
fn route(probe: &impl Probe, from: Vec3, to: Vec3, duration: f32) -> Option<Vec<Vec3>> {
    let state = start_route(probe, from, to, duration, false, &mut 4);
    let state = match state {
        RouteState::Pending(mut search) => {
            search.advance(probe, 2048, 2048);
            let found = search.finish(probe);
            if found.partial {
                return None;
            }
            finish_route(probe, found.points, from, to, duration, false)
        }
        s => s,
    };
    match state {
        RouteState::Ready(p) => Some(p),
        _ => None,
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
            let pos = if fraction == 0. {
                points[0]
            } else if fraction == 1. {
                *points.last()?
            } else {
                pair[0].lerp(pair[1], (remaining / leg).clamp(0., 1.))
            };
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
        assert_eq!(probe.probes.get(), count);
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
        assert_eq!(routes.pose("p", &segment(), &probe).unwrap().0, Vec3::ZERO);
        probe.loaded = true;
        assert_eq!(routes.pose("p", &segment(), &probe).unwrap().0, Vec3::ZERO);
        routes.begin(2);
        assert!(routes.pose("p", &segment(), &probe).is_some());
        for key in ["a", "b", "c"] {
            routes.pose(key, &segment(), &probe);
        }
        let count = probe.probes.get();
        assert_eq!(routes.pose("deferred", &segment(), &probe).unwrap().2, 0.);
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
        assert_eq!(
            routes.pose("blocked", &segment(), &Blocked).unwrap().0,
            Vec3::ZERO
        );
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
    fn corner_refinement_preserves_original_clear_3d_leg_and_sampling_curve() {
        struct Corner {
            blocked: bool,
        }
        impl Probe for Corner {
            fn floor(&self, x: f32, _: f32, _: f32) -> Option<f32> {
                Some(if x >= 0.999 {
                    1.
                } else if x <= 0.34 {
                    x
                } else {
                    0.
                })
            }
            fn clear(&self, a: Vec3, b: Vec3) -> bool {
                // Original diagonal rises safely over a step corner. Floor
                // projection instead pushes intermediate points into its riser.
                !self.blocked && (a.y - a.x).abs() < 0.001 && (b.y - b.x).abs() < 0.001
            }
        }
        let (from, to) = (Vec3::ZERO, Vec3::ONE);
        let state = finish_route(
            &Corner { blocked: false },
            vec![from, to],
            from,
            to,
            2.,
            true,
        );
        let RouteState::Ready(points) = &state else {
            panic!("clear original leg must survive rejected refinement")
        };
        assert_eq!(points, &vec![from, to]);
        let mut routes = Routes::default();
        routes.begin(1);
        let mut s = segment();
        s.from = benilla_assets::coords::bevy_to_wow(from);
        s.to = benilla_assets::coords::bevy_to_wow(to);
        s.unrestricted = true;
        routes.actors.insert(
            "corner".into(),
            Memo {
                from,
                to,
                duration: s.duration,
                unrestricted: true,
                state,
                expanded: 1,
                reason: RouteReason::Ready,
                rendered: from,
                cache_hit: false,
            },
        );
        let (point, _, speed) = routes
            .pose("corner", &s, &Corner { blocked: false })
            .unwrap();
        assert_eq!(point, Vec3::splat(0.5));
        assert!(speed > 0.);
        // An independently sampled floor would be y=0, on the blocked riser.
        assert_eq!(
            Corner { blocked: false }.floor(point.x, point.z, point.y),
            Some(0.)
        );
        let blocked = finish_route(
            &Corner { blocked: true },
            vec![from, to],
            from,
            to,
            2.,
            true,
        );
        assert!(matches!(
            blocked,
            RouteState::Failed(RouteReason::Reconstruction)
        ));
        routes.actors.get_mut("corner").unwrap().state = blocked;
        let held = routes
            .pose("corner", &s, &Corner { blocked: true })
            .unwrap();
        assert_eq!(held.0, from);
        assert_eq!(held.2, 0.);
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
        assert_eq!(routes.pose("p", &segment(), &probe).unwrap().0, Vec3::ZERO);
        probe.loaded = true;
        let unchanged = readiness.observe(7, [], None, true, false);
        assert_eq!(first, unchanged);
        routes.begin(unchanged);
        assert_eq!(routes.pose("p", &segment(), &probe).unwrap().0, Vec3::ZERO);
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
        assert_eq!(routes.pose("deferred", &s, &Open).unwrap().2, 0.);
        assert!(routes.deferred());
        routes.begin(1);
        assert!(routes.pose("deferred", &s, &Open).is_some());
        s.unrestricted = false;
        s.duration = 2.;
        assert_eq!(routes.pose("0", &s, &Open).unwrap().2, 0.);
        s.unrestricted = true;
        s.duration = 3.;
        s.to = [0., -401., 0.];
        assert_eq!(routes.pose("far", &s, &Open).unwrap().2, 0.);
    }
    struct LongWall;
    impl Probe for LongWall {
        fn floor(&self, _: f32, _: f32, _: f32) -> Option<f32> {
            Some(0.)
        }
        fn clear(&self, a: Vec3, b: Vec3) -> bool {
            if (a.x - 5.) * (b.x - 5.) > 0. {
                return true;
            }
            if (b.x - a.x).abs() < 0.00001 {
                return a.z.min(b.z) > 45.5 || a.z.max(b.z) < -45.5;
            }
            let t = (5. - a.x) / (b.x - a.x);
            (a.z + (b.z - a.z) * t).abs() > 45.5
        }
    }
    #[test]
    fn sparse_search_resumes_across_frames_with_safe_holds_and_exact_observations() {
        let mut s = segment();
        s.to = [0., -10., 0.];
        s.duration = 30.;
        s.unrestricted = true;
        let mut routes = Routes::default();
        let mut frames = 0;
        loop {
            routes.begin(1);
            let before = routes.expansions;
            let pose = routes.pose("wisp", &s, &LongWall).unwrap();
            assert!(before - routes.expansions <= FRAME_EXPANSIONS);
            frames += 1;
            let row = routes.diagnostics().pop().unwrap();
            assert!(row.expanded <= path::MAX_EXPANSIONS);
            if row.status == RouteStatus::Ready {
                break;
            }
            assert_eq!(row.status, RouteStatus::Pending, "{row:?}");
            assert_eq!(pose.0, Vec3::ZERO);
            assert_eq!(pose.2, 0.);
            assert!(routes.deferred());
            assert!(frames < 10);
        }
        assert!(
            frames > 1,
            "fixture must exceed the old 2048 expansion limit"
        );
        let memo = &routes.actors["wisp"];
        assert!(memo.expanded > 2048);
        let RouteState::Ready(points) = &memo.state else {
            panic!()
        };
        for pair in points.windows(2) {
            assert!(LongWall.clear(pair[0], pair[1]));
        }
        for (fraction, want) in [(0., Vec3::ZERO), (1., Vec3::new(10., 0., 0.))] {
            s.fraction = fraction;
            assert_eq!(routes.pose("wisp", &s, &LongWall).unwrap().0, want);
        }
        routes.begin(2);
        s.fraction = 0.5;
        assert_eq!(routes.pose("wisp", &s, &LongWall).unwrap().0, Vec3::ZERO);
        assert!(routes.actors["wisp"].expanded <= 2048);
        routes.clear();
        assert!(routes.diagnostics().is_empty());
        assert!(!routes.deferred());
    }
    #[test]
    fn total_limit_partial_and_floor_failures_hold_until_authoritative_arrival() {
        struct Pit;
        impl Probe for Pit {
            fn floor(&self, x: f32, _: f32, _: f32) -> Option<f32> {
                (!(3. ..=7.).contains(&x)).then_some(0.)
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                true
            }
        }
        let mut s = segment();
        s.to = [0., -10., 0.];
        s.duration = 30.;
        s.unrestricted = true;
        let mut routes = Routes::default();
        for _ in 0..8 {
            routes.begin(1);
            let p = routes.pose("pit", &s, &Pit).unwrap();
            assert_eq!(p.0, Vec3::ZERO);
            assert_eq!(p.2, 0.);
        }
        let row = routes.diagnostics().pop().unwrap();
        assert_eq!(row.status, RouteStatus::Held);
        assert_eq!(row.reason, RouteReason::Partial);
        assert_eq!(row.expanded, path::MAX_EXPANSIONS);
        s.fraction = 1.;
        assert_eq!(
            routes.pose("pit", &s, &Pit).unwrap().0,
            Vec3::new(10., 0., 0.)
        );
    }
    #[test]
    fn incomplete_goals_and_wrong_storeys_hold_with_typed_reasons() {
        struct GoalBlocked;
        impl Probe for GoalBlocked {
            fn floor(&self, _: f32, _: f32, _: f32) -> Option<f32> {
                Some(0.)
            }
            fn clear(&self, _: Vec3, b: Vec3) -> bool {
                b.x < 5.9
            }
        }
        let mut routes = Routes::default();
        routes.begin(1);
        let mut s = segment();
        assert_eq!(routes.pose("p", &s, &GoalBlocked).unwrap().0, Vec3::ZERO);
        assert_eq!(routes.diagnostics()[0].reason, RouteReason::IncompleteGoal);
        s.to[2] = 20.;
        assert_eq!(routes.pose("p", &s, &GoalBlocked).unwrap().2, 0.);
        assert_eq!(routes.diagnostics()[0].reason, RouteReason::EndpointFloor);
        let json = serde_json::to_value(routes.diagnostics()).unwrap();
        assert_eq!(json[0]["status"], "held");
        assert_eq!(json[0]["reason"], "endpointFloor");
        assert_eq!(json[0]["routePointCount"], 0);
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
