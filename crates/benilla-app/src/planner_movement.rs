//! Replay routes reuse the client's walking queries. No log positions are rewritten.
use crate::webbridge::path::{self, Probe};
use bevy::math::Vec3;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct FloorPair {
    pub from: f32,
    pub to: f32,
}
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
    #[serde(default)]
    pub from_inferred: bool,
    #[serde(default)]
    pub to_inferred: bool,
    /// Ordered, geometry-validated alternative endpoint heights. XY is immutable.
    #[serde(default)]
    pub floor_candidates: Vec<FloorPair>,
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
            && self.floor_candidates.len() <= 2
            && (self.floor_candidates.is_empty()
                || Vec3::new(self.from[0] - self.to[0], 0., self.from[1] - self.to[1]).length()
                    <= 40.)
            && self.floor_candidates.iter().all(|pair| {
                pair.from.is_finite()
                    && pair.to.is_finite()
                    && pair.from.abs() <= 20000.
                    && pair.to.abs() <= 20000.
                    && (pair.from - self.from[2]).abs() <= 32.
                    && (pair.to - self.to[2]).abs() <= 32.
                    && (self.from_inferred || pair.from == self.from[2])
                    && (self.to_inferred || pair.to == self.to[2])
            })
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
    EstimatedDrop,
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
    pub selected_from: Option<[f32; 3]>,
    pub selected_to: Option<[f32; 3]>,
    /// Zero is the primary inferred pair, alternatives are one-based.
    pub alternative_index: Option<usize>,
    pub primary_failure: Option<RouteReason>,
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
    from_inferred: bool,
    to_inferred: bool,
    candidates: Vec<FloorPair>,
    next_attempt: usize,
    primary_failure: Option<RouteReason>,
    selected: Option<(Vec3, Vec3, usize)>,
    estimated_drop: bool,
    drop_rate: f32,
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
                        RouteState::Ready(_)
                            if matches!(
                                m.reason,
                                RouteReason::Ready | RouteReason::EstimatedDrop
                            ) =>
                        {
                            RouteStatus::Ready
                        }
                        RouteState::Ready(_) => RouteStatus::Held,
                        RouteState::Failed(_) if m.reason == RouteReason::FrameBudget => {
                            RouteStatus::Deferred
                        }
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
                    selected_from: m.selected.map(|p| benilla_assets::coords::bevy_to_wow(p.0)),
                    selected_to: m.selected.map(|p| benilla_assets::coords::bevy_to_wow(p.1)),
                    alternative_index: m.selected.map(|p| p.2),
                    primary_failure: m.primary_failure,
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
                && m.from_inferred == segment.from_inferred
                && m.to_inferred == segment.to_inferred
                && m.candidates == segment.floor_candidates
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
                    from_inferred: segment.from_inferred,
                    to_inferred: segment.to_inferred,
                    candidates: segment.floor_candidates.clone(),
                    next_attempt: usize::from(!segment.unrestricted),
                    primary_failure: None,
                    selected: None,
                    estimated_drop: false,
                    drop_rate: segment.rate,
                },
            );
        }
        let memo = self.actors.get_mut(key)?;
        memo.cache_hit = cache_hit;
        // Fraction/rate can change during playback while the geometric segment
        // is identical. Do not discard an in-progress A* for a cadence change.
        if memo.drop_rate != segment.rate
            && segment.unrestricted
            && (memo.from_inferred || memo.to_inferred)
            && memo.primary_failure.is_some()
            && memo.next_attempt > memo.candidates.len()
            && matches!(memo.state, RouteState::Failed(_))
        {
            memo.next_attempt = 0;
        }
        memo.drop_rate = segment.rate;
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
        let mut candidate_deferred = false;
        // Alternatives never start another A*. A failed primary search retains
        // its expansion count; only direct walking/drop probes consume more jobs.
        if let RouteState::Failed(reason) = memo.state {
            if reason != RouteReason::FrameBudget {
                memo.primary_failure.get_or_insert(reason);
                while memo.next_attempt <= memo.candidates.len()
                    && (memo.from_inferred || memo.to_inferred)
                {
                    if self.search_jobs == 0 {
                        self.deferred = true;
                        candidate_deferred = true;
                        memo.reason = RouteReason::FrameBudget;
                        break;
                    }
                    self.search_jobs -= 1;
                    let index = memo.next_attempt;
                    memo.next_attempt += 1;
                    let (a, b) = if index == 0 {
                        (from, to)
                    } else {
                        let pair = &memo.candidates[index - 1];
                        (from.with_y(pair.from), to.with_y(pair.to))
                    };
                    let walked = (index > 0)
                        .then(|| direct_alternative(probe, a, b, segment))
                        .flatten();
                    let (points, drop) = if let Some(points) = walked {
                        (Some(points), false)
                    } else {
                        (estimated_drop(probe, a, b, segment), true)
                    };
                    if let Some(points) = points {
                        memo.state = RouteState::Ready(points);
                        memo.selected = Some((a, b, index));
                        memo.estimated_drop = drop;
                        break;
                    }
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
                memo.reason = if memo.estimated_drop {
                    RouteReason::EstimatedDrop
                } else {
                    RouteReason::Ready
                };
                // Sampling retains exact endpoint coordinates and the corresponding
                // route tangent/speed, including the timing policy's intentional holds.
                let sampled = sample_segment(points, segment).unwrap_or(fallback);
                if memo.estimated_drop && sampled.2 > 20. {
                    memo.reason = memo.primary_failure.unwrap_or(RouteReason::SpeedLimit);
                    fallback
                } else {
                    sampled
                }
            }
            RouteState::Failed(reason) => {
                if !candidate_deferred {
                    memo.reason = *reason;
                }
                fallback
            }
            RouteState::Pending(_) => fallback,
        };
        memo.rendered = pose.0;
        Some(pose)
    }
}
/// Alternative pairs are probes of an already supplied floor hypothesis, never searches.
fn direct_alternative(
    probe: &impl Probe,
    from: Vec3,
    to: Vec3,
    segment: &Segment,
) -> Option<Vec<Vec3>> {
    if from.distance(to) > if segment.unrestricted { 400. } else { 40. } {
        return None;
    }
    let start = from.with_y(probe.floor(from.x, from.z, from.y)?);
    let goal = to.with_y(probe.floor(to.x, to.z, to.y)?);
    if (start.y - from.y).abs() > 2.
        || (goal.y - to.y).abs() > 2.
        || !path::straight(probe, start, goal)
    {
        return None;
    }
    match finish_route(
        probe,
        vec![start, goal],
        from,
        to,
        segment.duration,
        segment.unrestricted,
    ) {
        RouteState::Ready(points) => Some(points),
        _ => None,
    }
}
/// A local presentation estimate: walk to support's end, sweep a short air leg,
/// then sweep vertically onto a verified lower floor. Walking limits stay intact.
fn estimated_drop(
    probe: &impl Probe,
    from: Vec3,
    to: Vec3,
    segment: &Segment,
) -> Option<Vec<Vec3>> {
    if !segment.unrestricted || !(segment.from_inferred || segment.to_inferred) {
        return None;
    }
    let flat = (to - from).with_y(0.).length();
    if flat > 40. || from.y <= to.y || from.y - to.y > 32. {
        return None;
    }
    let source_y = probe.floor(from.x, from.z, from.y)?;
    let landing_y = probe.floor(to.x, to.z, to.y)?;
    if (source_y - from.y).abs() > 0.1 || (landing_y - to.y).abs() > 0.1 {
        return None;
    }
    let mut points = vec![from];
    let steps = (flat / 0.5).ceil().max(1.) as usize;
    let mut ledge = false;
    for step in 1..=steps {
        let p = from.lerp(to, step as f32 / steps as f32);
        let previous = *points.last()?;
        let floor = probe.floor(p.x, p.z, previous.y);
        if let Some(y) = floor
            .filter(|y| *y - previous.y <= path::MAX_RISE && *y - previous.y >= -path::MAX_DROP)
        {
            let supported = p.with_y(y);
            if !probe.clear(previous, supported) {
                return None;
            }
            points.push(supported);
        } else {
            ledge = true;
            break;
        }
    }
    if !ledge {
        return None;
    }
    let edge = *points.last()?;
    let drop = edge.y - to.y;
    if drop <= 0. || drop > 32. || (to - edge).with_y(0.).length() > 3. {
        return None;
    }
    let air = to.with_y(edge.y);
    if !probe.clear(edge, air) || !probe.clear(air, to) {
        return None;
    }
    if air != edge {
        points.push(air);
    }
    points.push(to);
    let length: f32 = points.windows(2).map(|p| p[0].distance(p[1])).sum();
    if length / segment.duration > 20. || length * segment.rate > 20. {
        return None;
    }
    Some(points)
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
            from_inferred: false,
            to_inferred: false,
            floor_candidates: vec![],
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
                from_inferred: false,
                to_inferred: false,
                candidates: vec![],
                next_attempt: 0,
                primary_failure: None,
                selected: None,
                estimated_drop: false,
                drop_rate: s.rate,
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
    fn disconnected_gluth_storeys_cannot_become_a_direct_original_leg_fallback() {
        struct Stacked;
        impl Probe for Stacked {
            fn floor(&self, _: f32, _: f32, y: f32) -> Option<f32> {
                Some(if y > 310. { 317.7975 } else { 297.9374 })
            }
            fn clear(&self, _: Vec3, _: Vec3) -> bool {
                true
            }
        }
        let mut s = segment();
        s.from = [3249.52, -3195.56, 317.7975];
        s.to = [3252.01, -3191.10, 297.9374];
        s.duration = 0.679;
        s.rate = 1. / s.duration;
        s.unrestricted = true;
        let mut routes = Routes::default();
        for _ in 0..8 {
            routes.begin(1);
            let pose = routes.pose("stacked", &s, &Stacked).unwrap();
            assert_eq!(pose.0, benilla_assets::coords::wow_to_bevy(s.from));
            assert_eq!(pose.2, 0.);
        }
        let row = routes.diagnostics().pop().unwrap();
        assert_eq!(row.status, RouteStatus::Held);
        assert_eq!(row.reason, RouteReason::Partial);
        assert_eq!(row.expanded, path::MAX_EXPANSIONS);
    }
    #[test]
    fn ready_routes_keep_endpoint_tangents_and_sample_speed_without_moving_anchors() {
        let probe = Wall {
            probes: Cell::new(0),
            loaded: true,
        };
        for unrestricted in [false, true] {
            let mut routes = Routes::default();
            routes.begin(1);
            let mut s = segment();
            s.unrestricted = unrestricted;
            for fraction in [0., 1.] {
                s.fraction = fraction;
                let pose = routes.pose("endpoint", &s, &probe).unwrap();
                let RouteState::Ready(points) = &routes.actors["endpoint"].state else {
                    panic!("ready route")
                };
                assert_eq!(pose, sample_segment(points, &s).unwrap());
                assert!(
                    pose.2 > 0.03,
                    "endpoint velocity must permit replay tangent adoption"
                );
                assert_eq!(
                    pose.0,
                    benilla_assets::coords::wow_to_bevy(if fraction == 0. { s.from } else { s.to })
                );
                let pair = if fraction == 0. {
                    &points[..2]
                } else {
                    &points[points.len() - 2..]
                };
                let delta = pair[1] - pair[0];
                assert_eq!(pose.1, (-delta.x).atan2(-delta.z));
            }
            // A deliberate normal-run timing hold must retain zero speed, while
            // still preserving the endpoint and route tangent from sampling.
            if !unrestricted {
                s.travel_budget = Some(30.);
                s.run_speed = Some(7.);
                for fraction in [0., 1.] {
                    s.fraction = fraction;
                    let pose = routes.pose("endpoint", &s, &probe).unwrap();
                    let RouteState::Ready(points) = &routes.actors["endpoint"].state else {
                        panic!()
                    };
                    assert_eq!(pose, sample_segment(points, &s).unwrap());
                    assert_eq!(pose.2, 0.);
                }
            }
        }
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
        assert_eq!(routes.diagnostics()[0].reason, RouteReason::Partial);
        assert!(matches!(
            finish_route(
                &GoalBlocked,
                vec![Vec3::ZERO, Vec3::new(5., 0., 0.)],
                Vec3::ZERO,
                Vec3::new(6., 0., 0.),
                2.,
                false
            ),
            RouteState::Failed(RouteReason::IncompleteGoal)
        ));
        s.to[2] = 20.;
        assert_eq!(routes.pose("p", &s, &GoalBlocked).unwrap().2, 0.);
        assert_eq!(routes.diagnostics()[0].reason, RouteReason::EndpointFloor);
        let json = serde_json::to_value(routes.diagnostics()).unwrap();
        assert_eq!(json[0]["status"], "held");
        assert_eq!(json[0]["reason"], "endpointFloor");
        assert_eq!(json[0]["routePointCount"], 0);
    }

    struct CandidateFloors;
    impl Probe for CandidateFloors {
        fn floor(&self, x: f32, z: f32, y: f32) -> Option<f32> {
            if !(-1. ..=7.).contains(&x) || !(-1. ..=1.).contains(&z) {
                return None;
            }
            if y <= -5. {
                (x < 2.).then_some(-10.)
            } else {
                Some(0.)
            }
        }
        fn clear(&self, _: Vec3, _: Vec3) -> bool {
            true
        }
    }
    #[test]
    fn inferred_alternatives_defer_in_order_without_extra_search_expansions() {
        let mut s = segment();
        s.from[2] = -10.;
        s.from_inferred = true;
        s.floor_candidates = vec![
            FloorPair { from: -5., to: 0. },
            FloorPair { from: 0., to: 0. },
        ];
        assert!(s.valid());
        let mut routes = Routes::default();
        routes.begin(1);
        routes.search_jobs = 1;
        let held = routes.pose("candidate", &s, &CandidateFloors).unwrap();
        assert_eq!(held.0, benilla_assets::coords::wow_to_bevy(s.from));
        assert_eq!(held.2, 0.);
        let first = routes.diagnostics().pop().unwrap();
        assert_eq!(first.status, RouteStatus::Deferred);
        assert_eq!(first.primary_failure, Some(RouteReason::Partial));
        assert!(first.expanded > 0);
        assert_eq!(routes.actors["candidate"].next_attempt, 1);
        routes.begin(1);
        routes.search_jobs = 1;
        let expansions = routes.expansions;
        assert_eq!(
            routes.pose("candidate", &s, &CandidateFloors).unwrap().2,
            0.
        );
        assert_eq!(routes.expansions, expansions);
        assert_eq!(routes.search_jobs, 0);
        assert_eq!(routes.actors["candidate"].next_attempt, 2);
        assert!(routes.deferred());
        routes.begin(1);
        routes.search_jobs = 1;
        routes.pose("candidate", &s, &CandidateFloors).unwrap();
        let selected = routes.diagnostics().pop().unwrap();
        assert_eq!(selected.status, RouteStatus::Ready);
        assert_eq!(selected.expanded, first.expanded);
        assert_eq!(selected.alternative_index, Some(2));
        assert_eq!(selected.from, s.from);
        assert_eq!(selected.selected_from, Some([0., 0., 0.]));
        assert_eq!(selected.selected_to, Some(s.to));
        assert_eq!(routes.search_jobs, 0);
        for fraction in [0., 1.] {
            s.fraction = fraction;
            assert_eq!(
                routes.pose("candidate", &s, &CandidateFloors).unwrap().0,
                benilla_assets::coords::wow_to_bevy(if fraction == 0. {
                    [0., 0., 0.]
                } else {
                    s.to
                })
            );
        }
    }
    #[test]
    fn primary_wins_and_candidate_provenance_and_order_invalidate_cache() {
        let mut s = segment();
        let mut routes = Routes::default();
        routes.begin(1);
        routes.pose("p", &s, &CandidateFloors).unwrap();
        s.from_inferred = true;
        routes.pose("p", &s, &CandidateFloors).unwrap();
        assert!(!routes.diagnostics()[0].cache_hit);
        s.floor_candidates = vec![
            FloorPair { from: -1., to: 0. },
            FloorPair { from: 0., to: 0. },
        ];
        routes.pose("p", &s, &CandidateFloors).unwrap();
        assert!(!routes.diagnostics()[0].cache_hit);
        assert_eq!(routes.diagnostics()[0].alternative_index, None);
        assert_eq!(
            routes.search_jobs, 4,
            "successful primary must not test alternatives"
        );
        routes.pose("p", &s, &CandidateFloors).unwrap();
        assert!(routes.diagnostics()[0].cache_hit);
        s.floor_candidates.reverse();
        routes.pose("p", &s, &CandidateFloors).unwrap();
        assert!(!routes.diagnostics()[0].cache_hit);
        routes.begin(2);
        assert!(routes.diagnostics().is_empty());
        let mut sparse = segment();
        sparse.unrestricted = true;
        sparse.duration = 30.;
        sparse.to = [0., -10., 0.];
        sparse.from_inferred = true;
        let mut searching = Routes::default();
        searching.begin(1);
        searching.pose("wisp", &sparse, &LongWall).unwrap();
        let first = searching.actors["wisp"].expanded;
        assert_eq!(first, FRAME_EXPANSIONS);
        sparse.rate = 0.25;
        searching.begin(1);
        searching.pose("wisp", &sparse, &LongWall).unwrap();
        assert!(searching.actors["wisp"].cache_hit);
        assert!(
            searching.actors["wisp"].expanded > first,
            "rate changes must not restart A*"
        );
    }
    #[test]
    fn floor_candidate_transport_is_bounded_and_fixed_heights_cannot_change() {
        let mut s = segment();
        s.floor_candidates = vec![FloorPair { from: 1., to: 0. }];
        assert!(!s.valid());
        s.from_inferred = true;
        assert!(s.valid());
        s.floor_candidates[0].to = 1.;
        assert!(!s.valid());
        s.to_inferred = true;
        assert!(s.valid());
        s.floor_candidates.push(FloorPair { from: 0., to: 0. });
        assert!(s.valid());
        s.floor_candidates.push(FloorPair { from: 0., to: 0. });
        assert!(!s.valid());
        s.floor_candidates.truncate(1);
        s.floor_candidates[0].from = 33.;
        assert!(!s.valid());
        s.floor_candidates[0].from = f32::NAN;
        assert!(!s.valid());
        s.floor_candidates[0].from = 0.;
        s.to[1] = -41.;
        assert!(!s.valid());
        let parsed:Segment=serde_json::from_str(r#"{"from":[0,0,0],"to":[0,-6,0],"fraction":0.5,"rate":0.5,"duration":2,"recorded_facing":false,"from_inferred":true,"floor_candidates":[{"from":1,"to":0}]}"#).unwrap();
        assert!(parsed.valid());
        assert!(!parsed.to_inferred);
        assert_eq!(parsed.floor_candidates.len(), 1);
    }
    struct DropLedge {
        height: f32,
        landing: f32,
        block: u8,
    }
    impl Probe for DropLedge {
        fn floor(&self, x: f32, z: f32, y: f32) -> Option<f32> {
            if !(-1. ..=42.).contains(&x) || !(-1. ..=1.).contains(&z) || self.block == 3 && x >= 4.
            {
                return None;
            }
            let floor = if x < 2. { self.height } else { self.landing };
            (floor <= y + 1.6 && floor >= y - 4.).then_some(floor)
        }
        fn clear(&self, a: Vec3, b: Vec3) -> bool {
            !(self.block == 1 && b.x >= 4. && a.y == self.height && b.y == self.height
                || self.block == 2 && a.x == b.x && a.y > b.y)
        }
    }
    fn drop_segment() -> Segment {
        let mut s = segment();
        s.from[2] = 10.;
        s.to = [0., -4., 0.];
        s.from_inferred = true;
        s.to_inferred = true;
        s.unrestricted = true;
        s
    }
    #[test]
    fn estimated_drop_follows_support_and_sweeps_air_and_vertical_landing() {
        let mut s = drop_segment();
        let probe = DropLedge {
            height: 10.,
            landing: 0.,
            block: 0,
        };
        let mut routes = Routes::default();
        routes.begin(1);
        let pose = routes.pose("drop", &s, &probe).unwrap();
        assert!(pose.2 > 0.);
        let row = routes.diagnostics().pop().unwrap();
        assert_eq!(row.status, RouteStatus::Ready);
        assert_eq!(row.reason, RouteReason::EstimatedDrop);
        assert_eq!(row.alternative_index, Some(0));
        assert_eq!(row.primary_failure, Some(RouteReason::Partial));
        let RouteState::Ready(points) = &routes.actors["drop"].state else {
            panic!()
        };
        assert_eq!(points[0], benilla_assets::coords::wow_to_bevy(s.from));
        assert_eq!(
            *points.last().unwrap(),
            benilla_assets::coords::wow_to_bevy(s.to)
        );
        assert!(points.len() > 3);
        for pair in points.windows(2) {
            assert!(probe.clear(pair[0], pair[1]));
        }
        let air = points[points.len() - 2];
        assert_eq!(air, Vec3::new(4., 10., 0.));
        assert!(points.windows(2).map(|p| p[0].distance(p[1])).sum::<f32>() / s.duration <= 20.);
        s.rate = 10.;
        routes.begin(1);
        let fast = routes.pose("drop", &s, &probe).unwrap();
        assert_eq!(fast.0, benilla_assets::coords::wow_to_bevy(s.from));
        assert_eq!(fast.2, 0.);
        assert!(
            routes.diagnostics()[0].cache_hit,
            "cadence changes must retain validated geometry"
        );
        assert_eq!(routes.diagnostics()[0].status, RouteStatus::Held);
        let expanded = routes.diagnostics()[0].expanded;
        s.rate = 0.5;
        routes.begin(1);
        assert!(routes.pose("drop", &s, &probe).unwrap().2 > 0.);
        assert_eq!(routes.diagnostics()[0].expanded, expanded);
        // A speed rejection can be reconsidered without repeating the failed A*.
        let mut rejected = Routes::default();
        s.rate = 10.;
        rejected.begin(1);
        assert_eq!(rejected.pose("drop", &s, &probe).unwrap().2, 0.);
        let primary_expanded = rejected.diagnostics()[0].expanded;
        s.rate = 0.5;
        rejected.begin(1);
        assert!(rejected.pose("drop", &s, &probe).unwrap().2 > 0.);
        assert_eq!(rejected.diagnostics()[0].expanded, primary_expanded);
    }
    #[test]
    fn blocked_oversized_fast_upward_and_observed_drops_remain_safe_holds() {
        for block in [1, 2, 3] {
            let s = drop_segment();
            let probe = DropLedge {
                height: 10.,
                landing: 0.,
                block,
            };
            let mut routes = Routes::default();
            routes.begin(1);
            let pose = routes.pose("drop", &s, &probe).unwrap();
            assert_eq!(pose.0, benilla_assets::coords::wow_to_bevy(s.from));
            assert_eq!(pose.2, 0.);
            assert_eq!(routes.diagnostics()[0].status, RouteStatus::Held);
        }
        for case in 0..6 {
            let mut s = drop_segment();
            let mut probe = DropLedge {
                height: 10.,
                landing: 0.,
                block: 0,
            };
            match case {
                0 => {
                    s.from[2] = 33.;
                    probe.height = 33.;
                }
                1 => {
                    s.duration = 0.5;
                    s.rate = 2.;
                }
                2 => {
                    s.to[1] = -6.;
                }
                3 => {
                    s.to[1] = -41.;
                }
                4 => {
                    s.from_inferred = false;
                    s.to_inferred = false;
                }
                _ => {
                    s.to[2] = 20.;
                    probe.landing = 20.;
                }
            }
            assert!(
                estimated_drop(
                    &probe,
                    benilla_assets::coords::wow_to_bevy(s.from),
                    benilla_assets::coords::wow_to_bevy(s.to),
                    &s
                )
                .is_none(),
                "case {case}"
            );
            let mut routes = Routes::default();
            routes.begin(1);
            let held = routes.pose("rejected-drop", &s, &probe).unwrap();
            assert_eq!(
                held.0,
                benilla_assets::coords::wow_to_bevy(s.from),
                "case {case}"
            );
            assert_eq!(held.2, 0., "case {case}");
            let row = routes.diagnostics().pop().unwrap();
            assert_eq!(row.status, RouteStatus::Held, "case {case}");
            assert_eq!(Some(row.reason), row.primary_failure);
        }
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
