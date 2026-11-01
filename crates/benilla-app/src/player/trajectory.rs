//! Canonical chronological replay physics. Queries never seed or advance a simulation.
pub use super::trajectory_probe::Support;
use super::{
    edge,
    trajectory_probe::{self as physics, State},
    CAPSULE_HEIGHT, CAPSULE_RADIUS, GROUND_PROBE,
};
use crate::webbridge::path::{Probe, Search, WorldProbe};
use avian3d::prelude::{Collider, ColliderDisabled, CollisionLayers, Position, Rotation};
use benilla_assets::coords::{bevy_to_wow, wow_to_bevy};
use benilla_world::collision::{ColliderEpoch, MoverTraceExclusions, WorldCollision};
use bevy::platform::time::Instant;
use bevy::prelude::*;
use serde::Deserialize;
use std::{
    collections::VecDeque,
    hash::{Hash, Hasher},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

#[path = "trajectory_terrain.rs"]
mod terrain;

const TERRAIN_CAPACITY: &str = "Canonical terrain dependency capacity exceeded";
const FRAME_STEPS: usize = 200;
const BEAM: usize = 8;
const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_TICKS: usize = 100_000;
const MAX_COMPONENT_WORK: usize = 500_000;
const FRAME_SEARCH: usize = 2048;
const MAX_SEARCH: usize = 2048;
const INITIAL_SETTLE_REACH: f32 = 3.;
const MAX_INFERRED_FALL: f32 = 32.;

fn complete() -> bool {
    true
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct NativeComponentInput {
    pub source: String,
    pub actor: String,
    pub component: String,
    pub content: String,
    pub map: u32,
    pub samples: Vec<(f64, f32, f32, Option<f32>)>,
    pub initial_heights: Vec<f32>,
    #[serde(default = "complete")]
    pub coverage_complete: bool,
    #[serde(default)]
    pub profiles: Vec<MovementProfile>,
    #[serde(default)]
    pub slow_fall: Vec<(f64, bool)>,
    #[serde(default)]
    pub transfers: Vec<(f64, f64)>,
    #[serde(default)]
    pub hover_launches: Vec<f64>,
    /// Known starts and whether their bounded completion-search window is loaded.
    #[serde(default)]
    pub unresolved_transfers: Vec<(f64, bool)>,
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct MovementProfile {
    #[serde(default)]
    pub unrestricted: bool,
    pub travel_budget: Option<f32>,
    pub run_speed: Option<f32>,
    #[serde(default)]
    pub progress: Vec<(f64, f32)>,
}
impl NativeComponentInput {
    fn feather_at(&self, time: f64) -> bool {
        let n = self.slow_fall.partition_point(|r| r.0 <= time);
        n > 0 && self.slow_fall[n - 1].1
    }
    pub fn validate(&self) -> Result<(), String> {
        if [&self.source, &self.actor, &self.component, &self.content]
            .iter()
            .any(|s| s.is_empty() || s.len() > 512)
            || self.samples.is_empty()
            || self.samples.len() > 8192
            || self.initial_heights.len() > 3
            || (self.initial_heights.is_empty() && self.samples[0].3.is_none())
            || (!self.profiles.is_empty() && self.profiles.len() + 1 != self.samples.len())
        {
            return Err("Invalid canonical component bounds".into());
        }
        if self.samples.iter().any(|&(t, x, y, z)| {
            !t.is_finite()
                || !(0. ..=1e12).contains(&t)
                || [x, y]
                    .into_iter()
                    .chain(z)
                    .any(|v| !v.is_finite() || v.abs() > 20000.)
        }) || self
            .initial_heights
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 20000.)
            || self.samples.windows(2).any(|p| p[1].0 - p[0].0 < 0.001)
            || self.samples.last().unwrap().0 - self.samples[0].0 > 1_800_000.
        {
            return Err("Invalid canonical observations".into());
        }
        for (i, p) in self.profiles.iter().enumerate() {
            let (a, b) = (self.samples[i].0, self.samples[i + 1].0);
            if p.travel_budget.is_some_and(|v| !v.is_finite() || v < 0.)
                || p.run_speed
                    .is_some_and(|v| !v.is_finite() || v <= 0. || v > 35.)
                || p.progress.len() > 128
                || p.progress.iter().any(|&(t, f)| {
                    !t.is_finite() || !f.is_finite() || t < a || t > b || !(0. ..=1.).contains(&f)
                })
                || p.progress
                    .windows(2)
                    .any(|r| r[1].0 <= r[0].0 || r[1].1 < r[0].1)
                || (!p.progress.is_empty()
                    && (p.progress[0] != (a, 0.) || *p.progress.last().unwrap() != (b, 1.)))
            {
                return Err("Invalid canonical movement profile".into());
            }
        }
        let first = self.samples[0].0;
        let last = self.samples.last().unwrap().0;
        if self.slow_fall.len() > 512
            || self
                .slow_fall
                .iter()
                .any(|r| !r.0.is_finite() || r.0 < first || r.0 > last)
            || self.slow_fall.windows(2).any(|p| p[0].0 >= p[1].0)
            || (!self.slow_fall.is_empty() && self.slow_fall[0].0 != first)
            || self.transfers.len() > 128
            || self.transfers.iter().any(|&(a, b)| {
                !a.is_finite()
                    || !b.is_finite()
                    || a < first
                    || b > last
                    || b <= a
                    || b - a > 6000.
                    || !self.samples.iter().any(|s| s.0 == b)
            })
            || self.transfers.windows(2).any(|p| p[0].1 > p[1].0)
            || self.unresolved_transfers.len() > 128
            || self
                .unresolved_transfers
                .iter()
                .any(|r| !r.0.is_finite() || r.0 < first || r.0 > last)
            || self
                .unresolved_transfers
                .windows(2)
                .any(|p| p[0].0 >= p[1].0)
            || self
                .unresolved_transfers
                .iter()
                .any(|r| self.transfers.iter().any(|&(a, b)| a <= r.0 && r.0 <= b))
            || self.hover_launches.len() > 128
            || self
                .hover_launches
                .iter()
                .any(|t| !t.is_finite() || *t < first || *t > last)
            || self.hover_launches.windows(2).any(|p| p[0] >= p[1])
        {
            return Err("Invalid recorded movement modes".into());
        }
        Ok(())
    }
    fn seeds(&self) -> Vec<f32> {
        self.samples[0]
            .3
            .map_or_else(|| self.initial_heights.clone(), |z| vec![z])
    }
    fn key(&self) -> (&str, &str, &str, &str) {
        (&self.source, &self.actor, &self.component, &self.content)
    }
    fn bytes(&self) -> usize {
        self.samples.len() * 32
            + self.slow_fall.len() * 16
            + self.transfers.len() * 16
            + self.hover_launches.len() * 8
            + self.unresolved_transfers.len() * 16
            + self
                .profiles
                .iter()
                .map(|p| 64 + p.progress.len() * 16)
                .sum::<usize>()
            + 2048
    }
    fn fraction(&self, index: usize, time: f64, length: f32, allow_holds: bool) -> f32 {
        let (a, b) = (self.samples[index - 1].0, self.samples[index].0);
        let raw = ((time - a) / (b - a)).clamp(0., 1.) as f32;
        let Some(p) = self.profiles.get(index - 1) else {
            return raw;
        };
        let progress = if p.progress.is_empty() {
            raw
        } else {
            let n = p
                .progress
                .partition_point(|r| r.0 < time)
                .clamp(1, p.progress.len() - 1);
            let (x, y) = (p.progress[n - 1], p.progress[n]);
            x.1 + (y.1 - x.1) * ((time - x.0) / (y.0 - x.0)).clamp(0., 1.) as f32
        };
        if allow_holds
            && !p.unrestricted
            && length > 0.
            && p.travel_budget.is_some_and(|b| b >= length)
        {
            let budget = p.travel_budget.unwrap();
            ((progress * budget - (budget - length) * 0.5) / length).clamp(0., 1.)
        } else {
            progress
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Pose {
    pub position: [f32; 3],
    pub heading: f32,
    pub planar_speed: f32,
    pub vertical_velocity: f32,
    pub support: Support,
    pub inferred_jumps: usize,
    pub jump_arc: bool,
    pub airborne_seconds: f32,
    pub fall_distance: f32,
    far_latched: bool,
    pub feather_fall: bool,
    pub controlled_air: bool,
}
impl Pose {
    pub fn falling_far(&self) -> bool {
        self.support == Support::Falling
            && !self.controlled_air
            && (self.far_latched
                || far_rule(self.jump_arc, self.fall_distance, self.airborne_seconds))
    }
}
fn far_rule(jump: bool, drop: f32, seconds: f32) -> bool {
    if jump {
        drop >= super::FALL_FAR_DROP
    } else {
        seconds >= super::FALL_FAR_TIME
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Query {
    Ready(Pose),
    Pending,
    NotReady,
    MissingCoverage,
    Conflict(&'static str),
    Missing,
}
#[derive(Clone)]
struct Tick {
    time: f64,
    pose: Pose,
    connector_clear: bool,
}
#[derive(Clone, Default)]
struct History(Option<Arc<Node>>);
impl Drop for History {
    fn drop(&mut self) {
        let mut at = self.0.take();
        while let Some(node) = at {
            match Arc::try_unwrap(node) {
                Ok(mut node) => at = node.previous.0.take(),
                Err(_) => break,
            }
        }
    }
}
struct Node {
    tick: Arc<Tick>,
    previous: History,
    len: usize,
}
impl History {
    fn len(&self) -> usize {
        self.0.as_ref().map_or(0, |n| n.len)
    }
    fn push(&mut self, tick: Arc<Tick>) {
        self.0 = Some(Arc::new(Node {
            tick,
            previous: self.clone(),
            len: self.len() + 1,
        }));
    }
    fn rows(&self) -> Vec<Arc<Tick>> {
        self.rows_since(f64::NEG_INFINITY)
    }
    fn rows_since(&self, earliest: f64) -> Vec<Arc<Tick>> {
        let mut rows = Vec::new();
        let mut at = self;
        while let Some(n) = &at.0 {
            if n.tick.time < earliest {
                break;
            }
            rows.push(n.tick.clone());
            at = &n.previous;
        }
        rows.reverse();
        rows
    }
}
#[derive(Clone)]
struct Cursor {
    state: State,
    time: f64,
    next: usize,
    launches: Vec<f64>,
    windows: Vec<[f64; 2]>,
    next_jump: usize,
    ticks: History,
    heading: f32,
    guidance: Option<(usize, Arc<Vec<Vec3>>)>,
    arc: Option<(bool, f64, f32)>,
    far_latched: bool,
    stationary_certified: bool,
    initial_settling: bool,
    airborne_interval: Option<usize>,
    feather_fall: bool,
    transfer: Option<TransferArc>,
    next_hover: usize,
}
#[derive(Clone)]
struct TransferArc {
    index: usize,
    end: f64,
    from: f32,
    to: f32,
    rise: f32,
}
#[derive(Clone)]
struct Candidate {
    cursor: Cursor,
    checkpoints: Vec<Arc<Cursor>>,
    seed: usize,
    repairs: usize,
    order: u64,
    retry_until: usize,
    walking_fallback: Option<Box<Candidate>>,
    xy_only: bool,
    transfer_rises: Vec<(usize, f32)>,
}
impl Candidate {
    fn rank(&self) -> (usize, usize, usize, u64) {
        (
            self.seed,
            self.cursor.launches.len(),
            self.repairs,
            self.order,
        )
    }
}
struct Repair {
    candidate: Candidate,
    failed: Cursor,
    search: Search,
    goal: Vec3,
}
struct Planning {
    waiting: VecDeque<Candidate>,
    finished: Vec<Candidate>,
    repair: Option<Repair>,
    work: usize,
    next_order: u64,
    initialized: bool,
    seed: usize,
    window: usize,
    last_failure: &'static str,
}
impl Default for Planning {
    fn default() -> Self {
        Self {
            waiting: VecDeque::new(),
            finished: vec![],
            repair: None,
            work: 0,
            next_order: 0,
            initialized: false,
            seed: 0,
            window: 1,
            last_failure: "No physical trajectory fits observations",
        }
    }
}
struct Entry {
    input: Arc<NativeComponentInput>,
    input_bytes: usize,
    terrain_blocked: Option<Query>,
    accounted_bytes: usize,
    planning: Planning,
    result: Query,
    ticks: Vec<Arc<Tick>>,
    demand_frame: AtomicU64,
    visible_demand_frame: AtomicU64,
    demand_time: AtomicU64,
}
#[derive(Default, Resource)]
pub struct CanonicalTrajectories {
    entries: VecDeque<Entry>,
    accounted_bytes: usize,
    world_resets: u64,
    evictions: u64,
    capacity_conflicts: u64,
    last_reset: Option<ValidationReset>,
    terrain_request_key: Option<u64>,
    terrain_owner_key: Option<u64>,
    terrain_seek_generation: AtomicU64,
    terrain_seek_pending: AtomicBool,
    terrain_requests_extended: bool,
    terrain_requested_tiles: usize,
    terrain_capacity_exceeded: bool,
    revision: u64,
    validation_epoch: u64,
    world: Option<u64>,
    world_ready: bool,
    turn: usize,
    frame: u64,
    source: Option<String>,
    pub steps_last_frame: usize,
    pub search_expansions_last_frame: usize,
    pub elapsed_processing_ms: f64,
}
/// The conservative collision signature remains the certification boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationReset {
    InitialWorld,
    CollisionChanged,
    ReadinessChanged,
}
#[derive(Clone, Debug)]
pub struct TrajectoryDiagnostics {
    pub source: String,
    pub actor: String,
    pub component: String,
    pub content: String,
    pub demand_time: Option<f64>,
    pub committed_through: Option<f64>,
    pub preparing_through: f64,
    pub cache_bytes: usize,
    pub physics_work: usize,
    pub waiting_candidates: usize,
    pub repairing: bool,
    pub needs_work: bool,
    pub result: Query,
}
#[derive(Clone, Debug)]
pub struct CacheDiagnostics {
    pub validation_epoch: u64,
    pub world_ready: bool,
    pub world_resets: u64,
    pub last_reset: Option<ValidationReset>,
    pub terrain_requested_tiles: usize,
    pub terrain_capacity_exceeded: bool,
    pub evictions: u64,
    pub capacity_conflicts: u64,
    pub cache_bytes: usize,
    pub cache_limit_bytes: usize,
    pub steps_last_frame: usize,
    pub search_expansions_last_frame: usize,
    pub elapsed_processing_ms: f64,
}
impl CanonicalTrajectories {
    /// Queue navigation ownership replacement without changing the still-active demand set.
    /// The replacement batch commits it at clear_demands; checkpoints remain cached.
    pub fn begin_seek(&self) {
        self.terrain_seek_pending.store(true, Ordering::Relaxed);
    }
    /// Start a complete presentation demand set; queries below renew its members.
    /// Keep cached checkpoints and pending cursors so a later seek can resume them.
    pub fn clear_demands(&self) {
        if self.terrain_seek_pending.swap(false, Ordering::Relaxed) {
            self.terrain_seek_generation.fetch_add(1, Ordering::Relaxed);
        }
        for entry in &self.entries {
            entry.demand_frame.store(0, Ordering::Relaxed);
            entry.visible_demand_frame.store(0, Ordering::Relaxed);
        }
    }
    pub fn cache_bytes(&self) -> usize {
        self.bytes()
    }
    pub fn diagnostics(&self) -> CacheDiagnostics {
        CacheDiagnostics {
            validation_epoch: self.validation_epoch,
            world_ready: self.world_ready,
            world_resets: self.world_resets,
            last_reset: self.last_reset,
            terrain_requested_tiles: self.terrain_requested_tiles,
            terrain_capacity_exceeded: self.terrain_capacity_exceeded,
            evictions: self.evictions,
            capacity_conflicts: self.capacity_conflicts,
            cache_bytes: self.accounted_bytes,
            cache_limit_bytes: MAX_BYTES,
            steps_last_frame: self.steps_last_frame,
            search_expansions_last_frame: self.search_expansions_last_frame,
            elapsed_processing_ms: self.elapsed_processing_ms,
        }
    }
    /// Snapshot only when diagnostics are requested, never in the planner loop.
    pub fn component_diagnostics(&self) -> Vec<TrajectoryDiagnostics> {
        self.entries
            .iter()
            .map(|e| TrajectoryDiagnostics {
                source: e.input.source.clone(),
                actor: e.input.actor.clone(),
                component: e.input.component.clone(),
                content: e.input.content.clone(),
                demand_time: (e.demand_frame.load(Ordering::Relaxed) != 0)
                    .then(|| f64::from_bits(e.demand_time.load(Ordering::Relaxed))),
                committed_through: e.ticks.last().map(|t| t.time),
                preparing_through: e.target_time(),
                cache_bytes: e.accounted_bytes,
                physics_work: e.planning.work,
                waiting_candidates: e.planning.waiting.len(),
                repairing: e.planning.repair.is_some(),
                needs_work: e.needs_work(),
                result: e.result.clone(),
            })
            .collect()
    }
    pub fn component_count(&self) -> usize {
        self.entries.len()
    }
    /// Invalidates presentation poses certified against a previous physics world.
    /// Unlike revision(), progress, demand, source updates and eviction do not
    /// advance this epoch.
    pub fn validation_epoch(&self) -> u64 {
        self.validation_epoch
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn retain_source(&mut self, source: &str) {
        let changed = self.source.as_deref() != Some(source);
        self.source = Some(source.to_owned());
        let n = self.entries.len();
        self.retain_entries(|e| e.input.source == source);
        if changed || self.entries.len() != n {
            self.revision = self.revision.wrapping_add(1);
        }
    }
    pub fn submit(&mut self, input: NativeComponentInput) -> Result<(), String> {
        input.validate()?;
        if let Some(e) = self.entries.iter().find(|e| e.input.key() == input.key()) {
            // Immutable identifiers must not alias a changed payload.
            if e.input.as_ref() != &input {
                return Err("Canonical content identity reused for changed input".into());
            }
            return Ok(());
        }
        self.retain_entries(|e| {
            !(e.input.source == input.source
                && e.input.actor == input.actor
                && e.input.component == input.component)
        });
        while self.entries.len() >= MAX_ENTRIES || self.bytes() + input.bytes() > MAX_BYTES {
            if self.entries.is_empty() {
                return Err("Canonical input capacity exceeded".into());
            }
            if !self.evict_inactive() {
                return Err("Canonical active cache capacity exceeded".into());
            }
        }
        let result = if !input.coverage_complete {
            Query::MissingCoverage
        } else {
            Query::NotReady
        };
        let accounted_bytes = input.bytes();
        self.entries.push_back(Entry {
            input_bytes: accounted_bytes,
            terrain_blocked: None,
            accounted_bytes,
            input: Arc::new(input),
            planning: Planning::default(),
            result,
            ticks: vec![],
            demand_frame: AtomicU64::new(0),
            visible_demand_frame: AtomicU64::new(0),
            demand_time: AtomicU64::new(0),
        });
        self.accounted_bytes += accounted_bytes;
        self.revision = self.revision.wrapping_add(1);
        Ok(())
    }
    fn find(&self, source: &str, actor: &str, component: &str, content: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|e| e.input.key() == (source, actor, component, content))
    }
    /// Prepare a known component before presentation, within the ordinary cache,
    /// physics and search bounds. Visible queries retain priority. Callers clear
    /// and rebuild the demand set on navigation; cached certified prefixes survive.
    pub fn prepare(
        &self,
        source: &str,
        actor: &str,
        component: &str,
        content: &str,
        time: f64,
    ) -> bool {
        let Some(e) = self.find(source, actor, component, content) else {
            return false;
        };
        if !time.is_finite()
            || time < e.input.samples[0].0
            || time > e.input.samples.last().unwrap().0
        {
            return false;
        }
        // A background request cannot replace a selected pose in this demand set.
        if e.visible_demand_frame.load(Ordering::Relaxed) != self.frame + 1 {
            e.demand_frame.store(self.frame + 1, Ordering::Relaxed);
            e.demand_time.store(time.to_bits(), Ordering::Relaxed);
        }
        true
    }
    pub fn query(
        &self,
        source: &str,
        actor: &str,
        component: &str,
        content: &str,
        time: f64,
    ) -> Query {
        let Some(e) = self.find(source, actor, component, content) else {
            return Query::Missing;
        };
        if !time.is_finite()
            || time < e.input.samples[0].0
            || time > e.input.samples.last().unwrap().0
        {
            return Query::Missing;
        }
        e.demand_frame.store(self.frame + 1, Ordering::Relaxed);
        e.visible_demand_frame
            .store(self.frame + 1, Ordering::Relaxed);
        e.demand_time.store(time.to_bits(), Ordering::Relaxed);
        if e.ticks.last().is_some_and(|r| time <= r.time) {
            return sample(&e.ticks, time).map_or(Query::Missing, Query::Ready);
        }
        e.result.clone()
    }
    pub fn hold(
        &self,
        source: &str,
        actor: &str,
        component: &str,
        content: &str,
        time: f64,
    ) -> Option<Pose> {
        let e = self.find(source, actor, component, content)?;
        let mut pose = if !e.ticks.is_empty() {
            sample(
                &e.ticks,
                time.clamp(e.input.samples[0].0, e.ticks.last()?.time),
            )?
        } else {
            let first = e.input.samples[0];
            origin([first.1, first.2, first.3?])
        };
        pose.planar_speed = 0.;
        pose.vertical_velocity = 0.;
        Some(pose)
    }
    fn observe_world(&mut self, world: u64, ready: bool) {
        if self.world == Some(world) && self.world_ready == ready {
            return;
        }
        self.last_reset = Some(if self.world.is_none() {
            ValidationReset::InitialWorld
        } else if self.world != Some(world) {
            ValidationReset::CollisionChanged
        } else {
            ValidationReset::ReadinessChanged
        });
        self.world_resets = self.world_resets.wrapping_add(1);
        self.world = Some(world);
        self.world_ready = ready;
        self.validation_epoch = self.validation_epoch.wrapping_add(1);
        for e in &mut self.entries {
            let before = e.accounted_bytes;
            e.planning = Planning::default();
            e.terrain_blocked = None;
            e.ticks.clear();
            e.result = if !e.input.coverage_complete {
                Query::MissingCoverage
            } else {
                Query::NotReady
            };
            e.refresh_bytes();
            self.accounted_bytes = self.accounted_bytes - before + e.accounted_bytes;
        }
        self.revision = self.revision.wrapping_add(1);
    }
    fn evict_inactive(&mut self) -> bool {
        let candidate = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                let demand = e.demand_frame.load(Ordering::Relaxed);
                demand == 0 || demand.saturating_add(120) < self.frame
            })
            .min_by_key(|(_, e)| e.demand_frame.load(Ordering::Relaxed))
            .map(|(i, _)| i);
        if let Some(index) = candidate {
            self.accounted_bytes -= self.entries.remove(index).unwrap().accounted_bytes;
            self.evictions = self.evictions.wrapping_add(1);
            self.revision = self.revision.wrapping_add(1);
            true
        } else {
            false
        }
    }
    fn retain_entries(&mut self, mut keep: impl FnMut(&Entry) -> bool) {
        let total = &mut self.accounted_bytes;
        self.entries.retain(|e| {
            if keep(e) {
                true
            } else {
                *total -= e.accounted_bytes;
                false
            }
        });
    }
    fn bytes(&self) -> usize {
        self.accounted_bytes
    }
    fn step_entry(
        &mut self,
        index: usize,
        world: &WorldCollision,
        capsule: &Collider,
        search_budget: usize,
    ) -> (usize, usize, bool) {
        let entry = &mut self.entries[index];
        let before = entry.accounted_bytes;
        let result = entry.step(world, capsule, search_budget);
        self.accounted_bytes = self.accounted_bytes - before + entry.accounted_bytes;
        result
    }
    // Returns true when the current work must stop after a capacity conflict.
    fn enforce_capacity(&mut self, index: usize) -> bool {
        if self.bytes() <= MAX_BYTES {
            return false;
        }
        // Eviction can shift deque indices; keep the stepped entry's identity.
        let stepped_input = self.entries[index].input.clone();
        while self.bytes() > MAX_BYTES && self.evict_inactive() {}
        if self.bytes() <= MAX_BYTES {
            return false;
        }
        let Some(index) = self
            .entries
            .iter()
            .position(|e| Arc::ptr_eq(&e.input, &stepped_input))
        else {
            return true;
        };
        let entry = &mut self.entries[index];
        let before = entry.accounted_bytes;
        entry.result = Query::Conflict("Canonical cache capacity exceeded");
        entry.planning = Planning::default();
        entry.refresh_bytes();
        self.accounted_bytes = self.accounted_bytes - before + entry.accounted_bytes;
        self.capacity_conflicts = self.capacity_conflicts.wrapping_add(1);
        self.revision = self.revision.wrapping_add(1);
        true
    }
    fn prepare_terrain(
        &mut self,
        map: Option<u32>,
        requests: &mut benilla_world::terrain_stream::TrajectoryTerrainRequests,
    ) -> bool {
        use benilla_world::terrain_stream::MAX_TRAJECTORY_TERRAIN_TILES;
        let active = |e: &Entry| {
            e.demand_frame.load(Ordering::Relaxed) != 0
                && Some(e.input.map) == map
                && e.input.coverage_complete
        };
        let mut ownership = std::collections::hash_map::DefaultHasher::new();
        map.hash(&mut ownership);
        let seek = self.terrain_seek_generation.load(Ordering::Relaxed);
        seek.hash(&mut ownership);
        let mut signature = std::collections::hash_map::DefaultHasher::new();
        map.hash(&mut signature);
        seek.hash(&mut signature);
        self.validation_epoch.hash(&mut signature);
        for e in self.entries.iter().filter(|e| active(e)) {
            e.input.key().hash(&mut signature);
            e.input.key().hash(&mut ownership);
            e.terrain_through().hash(&mut signature);
            e.visit_terrain_cursors(|cursor| {
                let p = bevy_to_wow(cursor.state.center);
                terrain::point_key([p[0], p[1]]).hash(&mut signature);
                if let Some((_, path)) = &cursor.guidance {
                    for p in path.iter() {
                        let p = bevy_to_wow(*p);
                        terrain::point_key([p[0], p[1]]).hash(&mut signature);
                    }
                }
            });
        }
        let owner_key = ownership.finish();
        let key = signature.finish();
        if self.terrain_request_key == Some(key) && requests.map == map {
            return false;
        }
        let previous_map = requests.map;
        let previous_tiles = requests.tiles.clone();
        let mut coverage = terrain::Coverage::default();
        // Keep discovered repair/cursor dependencies while the same component
        // demand set owns them. Dropping one would invalidate the certified prefix
        // and repeat the same load/restart loop at that frontier.
        let retain_discovered = self.terrain_owner_key == Some(owner_key) && requests.map == map;
        if retain_discovered {
            for &tile in &requests.tiles {
                coverage.insert_tile(tile);
            }
        }
        for e in self.entries.iter().filter(|e| active(e)) {
            let through = e.terrain_through();
            let rows = &e.input.samples[..=through];
            coverage.point([rows[0].1, rows[0].2]);
            for pair in rows.windows(2) {
                coverage.segment([pair[0].1, pair[0].2], [pair[1].1, pair[1].2]);
            }
            // A seek may drop stale discovered tiles, but a certified detour is still
            // part of the required prefix. Rebuild it only when ownership changes.
            if !retain_discovered {
                coverage.path(
                    e.ticks
                        .iter()
                        .take_while(|tick| tick.time <= rows.last().unwrap().0)
                        .map(|tick| [tick.pose.position[0], tick.pose.position[1]]),
                );
            }
            e.visit_terrain_cursors(|cursor| {
                if !retain_discovered {
                    coverage.path(
                        std::iter::successors(cursor.ticks.0.as_deref(), |node| {
                            node.previous.0.as_deref()
                        })
                        .map(|node| [node.tick.pose.position[0], node.tick.pose.position[1]]),
                    );
                }
                let p = bevy_to_wow(cursor.state.center);
                coverage.point([p[0], p[1]]);
                if let Some((_, path)) = &cursor.guidance {
                    for pair in path.windows(2) {
                        let a = bevy_to_wow(pair[0]);
                        let b = bevy_to_wow(pair[1]);
                        coverage.segment([a[0], a[1]], [b[0], b[1]]);
                    }
                }
            });
        }
        self.terrain_requested_tiles = coverage.count();
        self.terrain_capacity_exceeded = coverage.count() > MAX_TRAJECTORY_TERRAIN_TILES;
        let overflow = self.terrain_capacity_exceeded;
        if !overflow {
            requests.tiles = coverage.tiles();
        } else if requests.map != map {
            requests.tiles.clear();
        }
        // On overflow retain only the previously bounded set, preventing tile
        // drops from clearing the explicit conflict through world invalidation.
        requests.map = map;
        for e in self.entries.iter_mut().filter(|e| active(e)) {
            if overflow {
                if e.terrain_blocked.is_none() {
                    e.terrain_blocked = Some(e.result.clone());
                    e.result = Query::Conflict(TERRAIN_CAPACITY);
                    self.revision = self.revision.wrapping_add(1);
                }
            } else if let Some(prior) = e.terrain_blocked.take() {
                e.result = prior;
                self.revision = self.revision.wrapping_add(1);
            }
        }
        self.terrain_request_key = Some(key);
        if !overflow {
            self.terrain_owner_key = Some(owner_key);
        }
        self.terrain_requests_extended = requests.map != previous_map
            || requests
                .tiles
                .iter()
                .any(|tile| !previous_tiles.contains(tile));
        requests.map != previous_map || requests.tiles != previous_tiles
    }
    #[cfg(test)]
    fn recompute_bytes(&self) -> usize {
        self.entries
            .iter()
            .map(|e| e.estimated_bytes() - e.input_bytes + e.input.bytes())
            .sum()
    }
}
fn observations_match(input: &NativeComponentInput, rows: &[Arc<Tick>], through: f64) -> bool {
    input
        .samples
        .iter()
        .take_while(|s| s.0 <= through)
        .all(|&(time, x, y, z)| {
            sample(rows, time).is_some_and(|pose| {
                (pose.position[0] - x).hypot(pose.position[1] - y) <= 0.05
                    && z.is_none_or(|z| (pose.position[2] - z).abs() <= 0.1)
            })
        })
}
fn origin(position: [f32; 3]) -> Pose {
    Pose {
        position,
        heading: 0.,
        planar_speed: 0.,
        vertical_velocity: 0.,
        support: Support::Grounded,
        inferred_jumps: 0,
        jump_arc: false,
        airborne_seconds: 0.,
        fall_distance: 0.,
        far_latched: false,
        feather_fall: false,
        controlled_air: false,
    }
}
fn sample(ticks: &[Arc<Tick>], time: f64) -> Option<Pose> {
    let end = ticks.partition_point(|r| r.time < time);
    if end == 0 {
        return ticks.first().map(|t| t.pose.clone());
    }
    if end == ticks.len() {
        return ticks.last().map(|t| t.pose.clone());
    }
    let (a, b) = (&ticks[end - 1], &ticks[end]);
    if time == b.time {
        return Some(b.pose.clone());
    }
    let mut pose = a.pose.clone();
    if b.connector_clear {
        let f = ((time - a.time) / (b.time - a.time)) as f32;
        for i in 0..3 {
            pose.position[i] += (b.pose.position[i] - a.pose.position[i]) * f;
        }
        // A launch/landing is a discrete velocity edge. Never smear the next
        // jump impulse backwards across a stationary span.
        let same_arc = a.pose.support == b.pose.support
            && a.pose.feather_fall == b.pose.feather_fall
            && a.pose.controlled_air == b.pose.controlled_air
            && a.pose.jump_arc == b.pose.jump_arc
            && a.pose.inferred_jumps == b.pose.inferred_jumps;
        if same_arc {
            pose.vertical_velocity += (b.pose.vertical_velocity - a.pose.vertical_velocity) * f;
        }
        if a.pose.support == Support::Falling && b.pose.support == Support::Falling && same_arc {
            pose.airborne_seconds += (b.pose.airborne_seconds - a.pose.airborne_seconds) * f;
            pose.fall_distance += (b.pose.fall_distance - a.pose.fall_distance) * f;
        }
    }
    Some(pose)
}
fn push_tick(
    cursor: &mut Cursor,
    world: &WorldCollision,
    capsule: &Collider,
    previous: Vec3,
    dt: f32,
) {
    let position = bevy_to_wow(cursor.state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5));
    if let Some((jump, start, height)) = cursor.arc {
        cursor.far_latched |= far_rule(
            jump,
            (height - position[2]).max(0.),
            ((cursor.time - start) / 1000.) as f32,
        );
    }
    let velocity = (cursor.state.center - previous) / dt.max(0.000001);
    let wow_velocity = bevy_to_wow(velocity);
    let speed = wow_velocity[0].hypot(wow_velocity[1]);
    if speed > 0.03 {
        cursor.heading = wow_velocity[1].atan2(wow_velocity[0]);
    }
    let clear = world
        .cast_mover(capsule, previous, cursor.state.center - previous, 0.)
        .is_none();
    cursor.ticks.push(Arc::new(Tick {
        time: cursor.time,
        pose: Pose {
            position,
            heading: cursor.heading,
            planar_speed: speed,
            vertical_velocity: cursor.state.vy,
            support: cursor.state.support,
            inferred_jumps: cursor.launches.len(),
            jump_arc: cursor.arc.is_some_and(|a| a.0),
            far_latched: cursor.far_latched,
            feather_fall: cursor.feather_fall,
            controlled_air: cursor
                .transfer
                .as_ref()
                .is_some_and(|arc| cursor.time < arc.end),
            airborne_seconds: cursor
                .arc
                .map_or(0., |a| ((cursor.time - a.1) / 1000.) as f32),
            fall_distance: cursor.arc.map_or(0., |a| (a.2 - position[2]).max(0.)),
        },
        connector_clear: clear,
    }));
}
fn initial(
    input: &NativeComponentInput,
    seed: usize,
    world: &WorldCollision,
    capsule: &Collider,
) -> Result<Option<Candidate>, ()> {
    let first = input.samples[0];
    let height = input.seeds()[seed];
    let feet = wow_to_bevy([first.1, first.2, height]);
    if !edge::may_resolve(world, feet, Vec3::ZERO, edge::Sweep::Walk) {
        return Err(());
    }
    let center = feet + Vec3::Y * (CAPSULE_HEIGHT * 0.5);
    let grounded = physics::has_support(world, capsule, center, GROUND_PROBE);
    let state = State {
        center,
        vy: 0.,
        support: if grounded {
            Support::Grounded
        } else {
            Support::Falling
        },
        max_residual: 0.,
        max_requested_steering_speed: 0.,
        max_applied_planar_speed: 0.,
        steering_clamped: false,
    };
    let xy_only = input.samples.iter().all(|s| s.3.is_none());
    let mut cursor = Cursor {
        state,
        time: first.0,
        next: 1,
        launches: vec![],
        windows: vec![],
        next_jump: 0,
        ticks: History::default(),
        heading: 0.,
        guidance: None,
        arc: (!grounded).then_some((false, first.0, height)),
        far_latched: false,
        stationary_certified: false,
        initial_settling: !grounded && xy_only,
        airborne_interval: None,
        feather_fall: input.slow_fall.first().is_some_and(|r| r.1),
        transfer: None,
        next_hover: 0,
    };
    push_tick(&mut cursor, world, capsule, center, 1.);
    Ok(Some(Candidate {
        checkpoints: vec![Arc::new(cursor.clone())],
        cursor,
        seed,
        repairs: 0,
        order: 0,
        retry_until: 0,
        walking_fallback: None,
        xy_only,
        transfer_rises: vec![],
    }))
}
enum Advance {
    Step,
    Observed(bool),
    Window,
    NotReady,
    Rejected(&'static str),
}
fn jump_event(
    cursor: &mut Cursor,
    world: &WorldCollision,
    capsule: &Collider,
) -> Result<(), &'static str> {
    if let Some([start, end]) = cursor.windows.get(cursor.next_jump).copied() {
        if cursor.time >= start {
            if physics::launch_if_supported(&mut cursor.state, world, capsule) {
                cursor.far_latched = false;
                cursor.arc = Some((
                    true,
                    cursor.time,
                    bevy_to_wow(cursor.state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5))[2],
                ));
                cursor.launches.push(cursor.time);
                cursor.next_jump += 1;
            } else if cursor.time >= end {
                return Err("No grounded support for inferred jump");
            }
        }
    }
    Ok(())
}
fn advance(
    c: &mut Candidate,
    input: &NativeComponentInput,
    world: &WorldCollision,
    capsule: &Collider,
    commit: f64,
    target: f64,
) -> Advance {
    if c.cursor.next == input.samples.len() || c.cursor.time >= target {
        return Advance::Window;
    }
    let at = c.cursor.next;
    let a = input.samples[at - 1];
    let b = input.samples[at];
    let seconds = ((b.0 - a.0) / 1000.) as f32;
    let chord = Vec2::new(b.1 - a.1, b.2 - a.2).length();
    let short_sparse =
        seconds <= 5. && chord <= 40. && input.profiles.get(at - 1).is_some_and(|p| p.unrestricted);
    if (seconds > 2. && !short_sparse) || chord / seconds > 35. {
        return Advance::Rejected("Component crosses a sparse or discontinuous boundary");
    }
    let transfer = input
        .transfers
        .iter()
        .position(|&(start, end)| start <= c.cursor.time && c.cursor.time < end);
    let stationary = a.1 == b.1
        && a.2 == b.2
        && wow_to_bevy([a.1, a.2, 0.]).with_y(0.) == c.cursor.state.center.with_y(0.);
    let skip = stationary
        && input
            .hover_launches
            .get(c.cursor.next_hover)
            .is_none_or(|&t| t > c.cursor.time)
        && transfer.is_none()
        && c.cursor.stationary_certified
        && c.cursor.state.vy == 0.
        && c.cursor.state.support == Support::Grounded
        && c.cursor.arc.is_none()
        && c.cursor
            .windows
            .get(c.cursor.next_jump)
            .is_none_or(|w| w[0] > c.cursor.time)
        && physics::has_support(world, capsule, c.cursor.state.center, GROUND_PROBE);
    let mut dt_ms = (b.0 - c.cursor.time)
        .min(if skip { 2000. } else { 10. })
        .min(if chord > 0. {
            250. * seconds as f64 / chord as f64
        } else {
            2000.
        });
    if let Some(profile) = input.profiles.get(at - 1) {
        if let Some(knot) = profile.progress.iter().find(|r| r.0 > c.cursor.time) {
            dt_ms = dt_ms.min(knot.0 - c.cursor.time);
        }
    }
    if let Some(knot) = input.slow_fall.iter().find(|r| r.0 > c.cursor.time) {
        dt_ms = dt_ms.min(knot.0 - c.cursor.time);
    }
    if let Some(&t) = input.hover_launches.get(c.cursor.next_hover) {
        if t > c.cursor.time {
            dt_ms = dt_ms.min(t - c.cursor.time);
        }
    }
    for &(start, end) in &input.transfers {
        for knot in [start, end] {
            if knot > c.cursor.time {
                dt_ms = dt_ms.min(knot - c.cursor.time);
            }
        }
    }
    if commit > c.cursor.time {
        dt_ms = dt_ms.min(commit - c.cursor.time);
    }
    if let Some([start, end]) = c.cursor.windows.get(c.cursor.next_jump) {
        for t in [start, end] {
            if *t > c.cursor.time {
                dt_ms = dt_ms.min(t - c.cursor.time);
            }
        }
    }
    while input
        .hover_launches
        .get(c.cursor.next_hover)
        .is_some_and(|&t| t <= c.cursor.time)
    {
        let t = input.hover_launches[c.cursor.next_hover];
        c.cursor.next_hover += 1;
        // A wire hover grant consumes one launch now, never after landing.
        if c.cursor.state.support != Support::Falling
            && physics::launch_if_supported(&mut c.cursor.state, world, capsule)
        {
            c.cursor.arc = Some((true, t, c.cursor.state.center.y - CAPSULE_HEIGHT * 0.5));
            c.cursor.far_latched = false;
        }
    }
    if let Err(reason) = jump_event(&mut c.cursor, world, capsule) {
        return Advance::Rejected(reason);
    }
    if let Some(index) = transfer {
        if !c
            .cursor
            .transfer
            .as_ref()
            .is_some_and(|arc| arc.index == index)
        {
            let end = input.transfers[index].1;
            let sample = input.samples.iter().find(|s| s.0 == end).unwrap();
            let from = c.cursor.state.center.y - CAPSULE_HEIGHT * 0.5;
            let goal = wow_to_bevy([sample.1, sample.2, from]);
            if !edge::may_resolve(world, goal, Vec3::ZERO, edge::Sweep::Walk) {
                return Advance::NotReady;
            }
            let Some(to) = sample
                .3
                .or_else(|| WorldProbe::new(world).floor(goal.x, goal.z, from))
            else {
                return Advance::Rejected("No supported destination for recorded transfer");
            };
            c.cursor.transfer = Some(TransferArc {
                index,
                end,
                from,
                to,
                rise: c
                    .transfer_rises
                    .iter()
                    .find(|r| r.0 == index)
                    .map_or(0., |r| r.1),
            });
        }
        c.cursor.airborne_interval = Some(at);
    } else {
        c.cursor.transfer = None;
    }
    let mut points = None;
    if let Some((index, guide)) = &c.cursor.guidance {
        if *index == at && transfer.is_none() {
            points = Some(guide.as_ref());
        }
    }
    let length = points.map_or(chord, |p| {
        p.windows(2)
            .map(|p| (p[1] - p[0]).with_y(0.).length())
            .sum()
    });
    let time = (c.cursor.time + dt_ms).min(b.0);
    // Holds inferred for ordinary running cannot stop horizontal progress in
    // midair. Keep the observed/profile clock through the rest of this interval,
    // including landing, so switching back cannot pull the actor backwards.
    if c.cursor.state.support == Support::Falling || c.cursor.arc.is_some() {
        c.cursor.airborne_interval = Some(at);
    }
    let mut fraction = input.fraction(at, time, length, c.cursor.airborne_interval != Some(at));
    if transfer.is_some() {
        fraction = ((time - a.0) / (b.0 - a.0)).clamp(0., 1.) as f32;
    }
    if let Some(&(start, _)) = input
        .transfers
        .iter()
        .find(|&&(start, _)| a.0 < start && start < b.0)
    {
        // An observation straddling an explicit transfer cannot move the actor
        // toward its destination before the recorded spell completion.
        fraction = ((time - start) / (b.0 - start)).clamp(0., 1.) as f32;
    }
    let desired = if let Some(points) = points {
        let mut remaining = length * fraction;
        let mut result = *points.last().unwrap();
        for pair in points.windows(2) {
            let leg = (pair[1] - pair[0]).with_y(0.).length();
            if leg > 0. && remaining <= leg {
                result = pair[0].lerp(pair[1], remaining / leg);
                break;
            }
            remaining -= leg;
        }
        result
    } else {
        wow_to_bevy([
            a.1 + (b.1 - a.1) * fraction,
            a.2 + (b.2 - a.2) * fraction,
            0.,
        ])
    };
    let dt = Duration::from_secs_f64(dt_ms / 1000.);
    let previous = c.cursor.state.center;
    let previous_support = c.cursor.state.support;
    if !dt.is_zero() {
        let ready = if let Some(arc) = &c.cursor.transfer {
            let (start, end) = input.transfers[arc.index];
            let u = ((time - start) / (end - start)).clamp(0., 1.) as f32;
            let height = arc.from + (arc.to - arc.from) * u + arc.rise * 4. * u * (1. - u);
            physics::transfer_step(
                &mut c.cursor.state,
                world,
                capsule,
                desired.with_y(height + CAPSULE_HEIGHT * 0.5),
                dt,
            )
        } else {
            let steering =
                ((desired - previous).with_y(0.) / dt.as_secs_f32()).clamp_length_max(35.);
            let terminal = if input.feather_at(c.cursor.time) {
                super::FEATHER_TERMINAL_VELOCITY
            } else {
                super::TERMINAL_VELOCITY
            };
            physics::physics_step_with_terminal(
                &mut c.cursor.state,
                world,
                capsule,
                steering,
                dt,
                terminal,
            )
        };
        if !ready {
            return Advance::NotReady;
        }
    }
    c.cursor.feather_fall = input.feather_at(time);
    if c.cursor.state.support != Support::Falling {
        c.cursor.arc = None;
        c.cursor.far_latched = false;
    } else if previous_support != Support::Falling {
        c.cursor.arc = Some((
            false,
            time,
            bevy_to_wow(previous - Vec3::Y * (CAPSULE_HEIGHT * 0.5))[2],
        ));
    }
    c.cursor.time = time;
    let jump_result = jump_event(&mut c.cursor, world, capsule);
    // Certification is intentionally exact: zero desired XZ, no body change,
    // genuine walkable support and no airborne state. A changed support/center
    // must spend another ordinary10ms step before it can certify again.
    c.cursor.stationary_certified = stationary
        && c.cursor.state.center == previous
        && c.cursor.state.vy == 0.
        && c.cursor.state.support == Support::Grounded
        && c.cursor.arc.is_none()
        && previous_support == Support::Grounded
        && physics::has_support(world, capsule, c.cursor.state.center, GROUND_PROBE);

    push_tick(&mut c.cursor, world, capsule, previous, dt.as_secs_f32());
    if c.cursor.initial_settling {
        let height = input.initial_heights[c.seed];
        if height - (c.cursor.state.center.y - CAPSULE_HEIGHT * 0.5) > INITIAL_SETTLE_REACH {
            return Advance::Rejected(
                "Estimated origin could not settle within reconstruction bound",
            );
        }
        if c.cursor.state.support == Support::Grounded {
            c.cursor.initial_settling = false;
        }
    }
    // XY-only evidence cannot justify a floor hypothesis that falls far beneath
    // the observed raid. Reject it before committing a prefix and try the next
    // origin, using the same bounded drop scope as sparse reconstruction.
    if c.xy_only
        && c.cursor.arc.is_some_and(|(_, _, height)| {
            height - (c.cursor.state.center.y - CAPSULE_HEIGHT * 0.5) > MAX_INFERRED_FALL
        })
    {
        return Advance::Rejected("Inferred fall exceeds reconstruction bound");
    }
    if let Err(reason) = jump_result {
        return Advance::Rejected(reason);
    }
    if time >= b.0 {
        let position = bevy_to_wow(c.cursor.state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5));
        let valid = (position[0] - b.1).hypot(position[1] - b.2) <= 0.05
            && b.3.is_none_or(|z| (position[2] - z).abs() <= 0.1);
        c.cursor.next += 1;
        c.cursor.airborne_interval = None;
        if c.cursor.guidance.as_ref().is_some_and(|(i, _)| *i == at) {
            c.cursor.guidance = None;
        }
        if valid {
            c.checkpoints.push(Arc::new(c.cursor.clone()));
            if c.retry_until <= at {
                c.retry_until = 0;
                c.walking_fallback = None;
            }
        }
        return Advance::Observed(valid);
    }
    if time == commit {
        c.checkpoints.push(Arc::new(c.cursor.clone()));
    }
    Advance::Step
}
fn fork_jumps(
    plan: &mut Planning,
    failed: Candidate,
    input: &NativeComponentInput,
    committed: f64,
) {
    let index = failed.cursor.next - 1;
    if failed.retry_until >= index && failed.retry_until != 0 {
        return;
    }
    if failed.cursor.launches.len() >= 128 {
        plan.last_failure = "Inferred jump hypothesis budget exceeded";
        return;
    }
    let end = input.samples[index].0;
    let mut proposed = vec![end - 400., end - 250., end - 100.];
    // A delayed observation may arrive long after a ledge. Infer an alternative
    // launch from the walk's actual loss of support, rather than only its end.
    let mut last_supported = None;
    let mut edge = None;
    let mut largest_drop = 0.25;
    for tick in failed
        .cursor
        .ticks
        .rows_since(committed)
        .iter()
        .filter(|tick| tick.time <= end)
    {
        if tick.pose.controlled_air {
            last_supported = None;
            continue;
        }
        if tick.pose.support != Support::Falling {
            last_supported = Some((tick.time, tick.pose.position[2]));
        } else if !tick.pose.jump_arc {
            if let Some((time, height)) = last_supported {
                let drop = height - tick.pose.position[2];
                if drop > largest_drop {
                    largest_drop = drop;
                    edge = Some(time);
                }
            }
        }
    }
    if let Some(edge) = edge {
        proposed.extend([edge, edge - 100., edge - 250.]);
    }
    let mut starts = vec![];
    for proposed_start in proposed {
        let start = proposed_start.max(committed).max(input.samples[0].0);
        if starts.contains(&start) {
            continue;
        }
        starts.push(start);
        let Some(checkpoint) = failed.checkpoints.iter().rev().find(|s| s.time <= start) else {
            continue;
        };
        if checkpoint.windows.last().is_some_and(|w| w[1] >= start) {
            continue;
        }
        let mut child = failed.clone();
        child.cursor = (**checkpoint).clone();
        child.checkpoints.retain(|p| p.time <= checkpoint.time);
        child.cursor.windows.push([start, end]);
        child.cursor.guidance = None;
        child.retry_until = index;
        plan.next_order += 1;
        child.order = plan.next_order;
        plan.waiting.push_back(child);
    }
}
fn fork_transfer(
    plan: &mut Planning,
    failed: &Candidate,
    input: &NativeComponentInput,
    committed: f64,
) -> bool {
    let Some(arc) = &failed.cursor.transfer else {
        return false;
    };
    let start = input.transfers[arc.index].0;
    // A known controlled movement cannot be replaced with an ordinary jump.
    if start < committed {
        return true;
    }
    let Some(checkpoint) = failed.checkpoints.iter().rev().find(|c| c.time <= start) else {
        return true;
    };
    for rise in [2., 4.] {
        if rise <= arc.rise {
            continue;
        }
        let mut child = failed.clone();
        child.cursor = (**checkpoint).clone();
        child.cursor.guidance = None;
        child.checkpoints.retain(|c| c.time <= checkpoint.time);
        child.transfer_rises.retain(|r| r.0 != arc.index);
        child.transfer_rises.push((arc.index, rise));
        child.walking_fallback = None;
        child.retry_until = failed.cursor.next - 1;
        plan.next_order += 1;
        child.order = plan.next_order;
        plan.waiting.push_back(child);
    }
    true
}
fn prune(plan: &mut Planning) {
    let mut candidates = plan.waiting.drain(..).collect::<Vec<_>>();
    candidates.sort_by_key(Candidate::rank);
    candidates.truncate(BEAM);
    plan.waiting.extend(candidates);
}
fn prepare_repair(
    candidate: Candidate,
    input: &NativeComponentInput,
    world: &WorldCollision,
    committed: f64,
) -> Result<Repair, Candidate> {
    let index = candidate.cursor.next - 1;
    if candidate.retry_until >= index && candidate.retry_until != 0 {
        return Err(candidate);
    }
    let Some(checkpoint) = candidate.checkpoints.last() else {
        return Err(candidate);
    };
    if checkpoint.time < committed
        || checkpoint.state.support == Support::Falling
        || candidate.cursor.state.support == Support::Falling
        || candidate.repairs >= 128
    {
        return Err(candidate);
    }
    let from = checkpoint.state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5);
    let target = input.samples[index];
    let at = candidate.cursor.state.center.y - CAPSULE_HEIGHT * 0.5;
    let probe = WorldProbe::new(world);
    let raw = wow_to_bevy([target.1, target.2, at]);
    let Some(y) = target.3.or_else(|| probe.floor(raw.x, raw.z, at)) else {
        return Err(candidate);
    };
    let goal = raw.with_y(y);
    let Some(search) = Search::new(&probe, from, goal) else {
        return Err(candidate);
    };
    let failed = candidate.cursor.clone();
    Ok(Repair {
        candidate,
        failed,
        search,
        goal,
    })
}
impl Entry {
    fn refresh_bytes(&mut self) {
        self.accounted_bytes = self.estimated_bytes();
    }
    // Preserve the previous conservative estimate, including shared histories,
    // nested fallbacks, checkpoints and reserved repair search space.
    fn estimated_bytes(&self) -> usize {
        fn candidate(c: &Candidate) -> usize {
            c.cursor.ticks.len() * 192
                + c.checkpoints.len() * 8
                + c.transfer_rises.len() * 16
                + c.cursor.windows.len() * 16
                + c.cursor.launches.len() * 8
                + c.checkpoints
                    .iter()
                    .map(|p| {
                        std::mem::size_of::<Cursor>() + p.windows.len() * 16 + p.launches.len() * 8
                    })
                    .sum::<usize>()
                + c.walking_fallback.as_deref().map_or(0, candidate)
        }
        self.input_bytes
            + self.ticks.len() * 128
            + self
                .planning
                .waiting
                .iter()
                .chain(&self.planning.finished)
                .map(candidate)
                .sum::<usize>()
            + self.planning.repair.as_ref().map_or(0, |r| {
                candidate(&r.candidate) + r.failed.ticks.len() * 192 + MAX_SEARCH * 384
            })
    }

    // Last observed endpoint needed to certify the requested prefix plus the
    // existing eight-second lookahead and two-second validation window.
    fn terrain_through(&self) -> usize {
        let first = self.input.samples[0].0;
        let last = self.input.samples.last().unwrap().0;
        let wanted = f64::from_bits(self.demand_time.load(Ordering::Relaxed));
        let commit =
            (first + (((wanted + 8000.).min(last) - first) / 8000.).ceil() * 8000.).min(last);
        let mut target = commit + 2000.;
        if let Some(&(_, end)) = self
            .input
            .transfers
            .iter()
            .find(|&&(a, b)| a < commit && commit < b)
        {
            target = target.max(end);
        }
        self.input
            .samples
            .partition_point(|s| s.0 < target)
            .min(self.input.samples.len() - 1)
    }
    fn visit_terrain_cursors(&self, mut visit: impl FnMut(&Cursor)) {
        fn candidate(c: &Candidate, visit: &mut impl FnMut(&Cursor)) {
            visit(&c.cursor);
            if let Some(fallback) = &c.walking_fallback {
                candidate(fallback, visit);
            }
        }
        for c in self.planning.waiting.iter().chain(&self.planning.finished) {
            candidate(c, &mut visit);
        }
        if let Some(repair) = &self.planning.repair {
            candidate(&repair.candidate, &mut visit);
            visit(&repair.failed);
        }
    }
    fn needs_visible_pose(&self) -> bool {
        self.needs_work()
            && self.visible_demand_frame.load(Ordering::Relaxed)
                == self.demand_frame.load(Ordering::Relaxed)
            && !self.ticks.last().is_some_and(|tick| {
                tick.time >= f64::from_bits(self.demand_time.load(Ordering::Relaxed))
            })
    }
    fn needs_work(&self) -> bool {
        if self.demand_frame.load(Ordering::Relaxed) == 0
            || matches!(
                self.result,
                Query::Ready(_) | Query::Conflict(_) | Query::MissingCoverage
            )
        {
            return false;
        }
        let wanted = f64::from_bits(self.demand_time.load(Ordering::Relaxed));
        !self
            .ticks
            .last()
            .is_some_and(|t| t.time >= (wanted + 8000.).min(self.input.samples.last().unwrap().0))
    }
    fn commit_time(&self) -> f64 {
        (self.input.samples[0].0 + self.planning.window as f64 * 8000.)
            .min(self.input.samples.last().unwrap().0)
    }
    fn target_time(&self) -> f64 {
        let commit = self.commit_time();
        let mut target = self.input.samples[0].0 + self.planning.window as f64 * 8000. + 2000.;
        if let Some(&(_, end)) = self
            .input
            .transfers
            .iter()
            .find(|&&(start, end)| start < commit && commit < end)
        {
            target = target.max(end);
        }
        self.input
            .samples
            .iter()
            .find(|s| s.0 >= target)
            .unwrap_or(self.input.samples.last().unwrap())
            .0
    }
    fn committed(&self) -> f64 {
        self.ticks
            .last()
            .map_or(self.input.samples[0].0, |r| r.time)
    }
    // Returns (physics work, search work, visible-state revision).
    fn step(
        &mut self,
        world: &WorldCollision,
        capsule: &Collider,
        search_budget: usize,
    ) -> (usize, usize, bool) {
        let result = self.step_inner(world, capsule, search_budget);
        self.refresh_bytes();
        result
    }
    fn step_inner(
        &mut self,
        world: &WorldCollision,
        capsule: &Collider,
        search_budget: usize,
    ) -> (usize, usize, bool) {
        let old = self.result.clone();
        let commit = self.commit_time();
        let target = self.target_time();
        let committed = self.committed();
        if !self.input.coverage_complete
            || matches!(self.result, Query::Conflict(_) | Query::MissingCoverage)
            || matches!(self.result, Query::Ready(_))
        {
            return (0, 0, false);
        }
        if let Some(&(_, loaded)) = self
            .input
            .unresolved_transfers
            .iter()
            .find(|r| r.0 <= target)
        {
            self.result = if loaded {
                Query::Conflict("Recorded transfer completion is unresolved")
            } else {
                Query::MissingCoverage
            };
            return (0, 0, old != self.result);
        }
        if self.planning.work >= MAX_COMPONENT_WORK {
            self.result = Query::Conflict("Canonical physics work budget exceeded");
            self.planning = Planning::default();
            return (0, 0, true);
        }
        if let Some(mut repair) = self.planning.repair.take() {
            if search_budget == 0 {
                self.planning.repair = Some(repair);
                return (0, 0, false);
            }
            let before = repair.search.expanded();
            let done =
                repair
                    .search
                    .advance(&WorldProbe::new(world), search_budget.min(64), MAX_SEARCH);
            let expanded = repair.search.expanded() - before;
            if done {
                let path = repair.search.finish_raw(&WorldProbe::new(world));
                if !path.partial
                    && path
                        .points
                        .last()
                        .is_some_and(|p| p.distance(repair.goal) < 0.01)
                    && path.points.len() > 1
                {
                    let mut child = repair.candidate.clone();
                    let checkpoint = child.checkpoints.last().unwrap().clone();
                    child.cursor = (*checkpoint).clone();
                    child.repairs += 1;
                    child.cursor.guidance = Some((repair.failed.next - 1, Arc::new(path.points)));
                    child.retry_until = repair.failed.next - 1;
                    child.walking_fallback = Some(Box::new(repair.candidate));
                    self.planning.waiting.push_back(child);
                } else {
                    fork_jumps(&mut self.planning, repair.candidate, &self.input, committed);
                    prune(&mut self.planning);
                }
            } else {
                self.planning.repair = Some(repair);
            }
            return (0, expanded, false);
        }
        if let Some(mut candidate) = self.planning.waiting.pop_front() {
            let before = candidate.cursor.ticks.len();
            let outcome = advance(&mut candidate, &self.input, world, capsule, commit, target);
            let used = candidate.cursor.ticks.len() - before;
            self.planning.work += used;
            match outcome {
                Advance::Step | Advance::Observed(true) => {
                    self.result = Query::Pending;
                    if candidate.cursor.ticks.len() > MAX_TICKS {
                        self.result = Query::Conflict("Canonical curve capacity exceeded");
                        self.planning.waiting.clear();
                        self.planning.finished.clear();
                    } else {
                        self.planning.waiting.push_back(candidate);
                    }
                }
                Advance::Observed(false) => {
                    if fork_transfer(&mut self.planning, &candidate, &self.input, committed) {
                        // Already queued the bounded, swept height alternatives.
                    } else if let Some(fallback) = candidate.walking_fallback.take() {
                        fork_jumps(&mut self.planning, *fallback, &self.input, committed);
                    } else {
                        match prepare_repair(candidate, &self.input, world, committed) {
                            Ok(repair) => self.planning.repair = Some(repair),
                            Err(failed) => {
                                fork_jumps(&mut self.planning, failed, &self.input, committed)
                            }
                        }
                    }
                    prune(&mut self.planning);
                }
                Advance::Window => {
                    if candidate.cursor.initial_settling {
                        self.planning.last_failure =
                            "Estimated origin did not reach grounded support";
                    } else if observations_match(
                        &self.input,
                        &candidate.cursor.ticks.rows(),
                        candidate.cursor.time,
                    ) {
                        self.planning.finished.push(candidate);
                    } else {
                        self.planning.last_failure =
                            "Canonical checkpoint skipped an observed constraint";
                    }
                }
                Advance::NotReady => {
                    self.result = Query::NotReady;
                    self.planning.waiting.push_front(candidate);
                    return (used, 0, old != self.result);
                }
                Advance::Rejected(reason) => self.planning.last_failure = reason,
            }
            return (used, 0, old != self.result);
        }
        if !self.planning.finished.is_empty() {
            self.planning.finished.sort_by_key(Candidate::rank);
            let winner = self.planning.finished.remove(0);
            let rows = winner.cursor.ticks.rows();
            self.ticks = rows.into_iter().filter(|r| r.time <= commit).collect();
            if self.ticks.len() > 1
                && self.ticks[0].time == self.input.samples[0].0
                && self.ticks[1].pose.planar_speed > 0.03
            {
                let mut first = (*self.ticks[0]).clone();
                first.pose.heading = self.ticks[1].pose.heading;
                first.pose.planar_speed = self.ticks[1].pose.planar_speed;
                self.ticks[0] = Arc::new(first);
            }
            let final_time = self.input.samples.last().unwrap().0;
            if commit >= final_time {
                self.result = Query::Ready(self.ticks.last().unwrap().pose.clone());
                self.planning = Planning::default();
            } else {
                // Replan the uncommitted lookahead from the exact source boundary.
                // Only the winning prefix is fixed. Position, fall velocity, support,
                // observation cursor and interval guidance all survive this checkpoint.
                let checkpoint = winner
                    .checkpoints
                    .iter()
                    .rev()
                    .find(|s| s.time == commit)
                    .expect("integration splits at commit boundary");
                let mut cursor = (**checkpoint).clone();
                cursor.windows.truncate(cursor.next_jump);
                let mut next = winner.clone();
                next.cursor = cursor.clone();
                next.checkpoints = vec![Arc::new(cursor)];
                next.retry_until = 0;
                next.walking_fallback = None;
                self.planning.window += 1;
                self.planning.finished.clear();
                self.planning.waiting.push_back(next);
                self.result = Query::Pending;
            }
            return (0, 0, true);
        }
        if !self.planning.initialized
            || (self.ticks.is_empty() && self.planning.seed + 1 < self.input.seeds().len())
        {
            if self.planning.initialized {
                self.planning.seed += 1;
            }
            match initial(&self.input, self.planning.seed, world, capsule) {
                Ok(Some(candidate)) => {
                    self.planning.waiting.push_back(candidate);
                    self.planning.initialized = true;
                    self.result = Query::Pending;
                }
                Ok(None) => {
                    self.planning.initialized = true;
                    self.planning.last_failure = "No supported initial height hypothesis";
                    if self.planning.seed + 1 == self.input.seeds().len() {
                        self.result = Query::Conflict(self.planning.last_failure);
                    }
                }
                Err(()) => self.result = Query::NotReady,
            }
        } else {
            self.result = Query::Conflict(self.planning.last_failure);
        }
        (0, 0, old != self.result)
    }
}
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TrajectoryDrive;
pub fn install(app: &mut App) {
    physics::install_budget(app);
    app.init_resource::<benilla_world::terrain_stream::TrajectoryTerrainRequests>();
    app.init_resource::<CanonicalTrajectories>().add_systems(
        Update,
        drive
            .in_set(TrajectoryDrive)
            .in_set(benilla_world::schedule::WorldStage::Input),
    );
}
#[derive(Default)]
struct ResidencyIdentity {
    value: Option<benilla_world::terrain_stream::TerrainResidency>,
    revision: u64,
}
fn drive(
    mut plans: ResMut<CanonicalTrajectories>,
    world: WorldCollision,
    epoch: Res<ColliderEpoch>,
    map: Option<Res<benilla_world::world_map::CurrentMap>>,
    progress: Option<Res<benilla_world::terrain_stream::WorldLoadProgress>>,
    exclusions: Res<MoverTraceExclusions>,
    bodies: bevy::prelude::Query<(
        Entity,
        Ref<Collider>,
        Option<&Position>,
        Option<&Rotation>,
        Option<&CollisionLayers>,
        Has<ColliderDisabled>,
    )>,
    residency: Option<Res<benilla_world::terrain_stream::TerrainResidency>>,
    mut identity: Local<ResidencyIdentity>,
    mut budget: ResMut<physics::PhysicsBudget>,
    mut terrain_requests: Option<ResMut<benilla_world::terrain_stream::TrajectoryTerrainRequests>>,
) {
    let start = Instant::now();
    if identity.value.as_ref() != residency.as_deref() {
        identity.value = residency.as_deref().cloned();
        identity.revision = identity.revision.wrapping_add(1);
    }
    let current_map = map.as_ref().map(|m| m.0);
    let mut signature = std::collections::hash_map::DefaultHasher::new();
    current_map.hash(&mut signature);
    epoch.get().hash(&mut signature);
    identity.revision.hash(&mut signature);
    let mut excluded = exclusions.0.iter().map(|e| e.to_bits()).collect::<Vec<_>>();
    excluded.sort_unstable();
    excluded.hash(&mut signature);
    let mut shapes = bodies
        .iter()
        .filter(|(entity, _, _, _, layers, _)| {
            !exclusions.0.contains(entity)
                && layers
                    .is_none_or(|l| l.memberships.0 & WorldCollision::body_filter().mask.0 != 0)
        })
        .collect::<Vec<_>>();
    shapes.sort_by_key(|row| row.0.to_bits());
    for (entity, collider, position, rotation, layers, disabled) in shapes {
        entity.to_bits().hash(&mut signature);
        disabled.hash(&mut signature);
        collider.last_changed().get().hash(&mut signature);
        (collider.shape_scaled().as_ref() as *const _ as *const () as usize).hash(&mut signature);
        position
            .map(|p| p.0.to_array().map(f32::to_bits))
            .hash(&mut signature);
        rotation
            .map(|r| r.0.to_array().map(f32::to_bits))
            .hash(&mut signature);
        layers
            .map(|l| (l.memberships.0, l.filters.0))
            .hash(&mut signature);
    }
    // New dependencies need a fresh streamer acknowledgement. A subset of the
    // already acknowledged set cannot make its remaining collision less ready.
    let requests_changed = terrain_requests
        .as_deref_mut()
        .is_some_and(|requests| plans.prepare_terrain(current_map, requests));
    let ready = current_map.is_some()
        && progress.as_deref().is_none_or(|p| {
            !(requests_changed && plans.terrain_requests_extended)
                && p.scene_ready
                && (terrain_requests
                    .as_deref()
                    .is_none_or(|r| r.map != current_map || r.tiles.is_empty())
                    || p.trajectory_ready)
                && p.colliders_pending == 0
                && p.merge_pending == 0
                && p.placements_pending == 0
        });
    let validation_epoch = plans.validation_epoch;
    plans.observe_world(signature.finish(), ready);
    if plans.validation_epoch != validation_epoch {
        if let Some(requests) = terrain_requests.as_deref_mut() {
            plans.prepare_terrain(current_map, requests);
        }
    }
    plans.frame = plans.frame.wrapping_add(1);
    plans.steps_last_frame = 0;
    plans.search_expansions_last_frame = 0;
    let capsule = Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
    budget.canonical_active = ready
        && plans
            .entries
            .iter()
            .any(|e| e.needs_work() && e.input.map == current_map.unwrap());
    let quota = budget.remaining.min(if budget.diagnostic_active {
        FRAME_STEPS / 2
    } else {
        FRAME_STEPS
    });
    // Spend the same bounded budget on missing visible poses before speculative
    // lookahead for actors that can already be rendered. Fairness is retained
    // within the foreground class; prefetch resumes on a subsequent frame.
    let foreground = plans
        .entries
        .iter()
        .any(|e| e.input.map == current_map.unwrap_or(u32::MAX) && e.needs_visible_pose());
    let mut idle = 0;
    let mut transitions = 0;
    while ready
        && budget.remaining > 0
        && plans.steps_last_frame < quota
        && !plans.entries.is_empty()
        && start.elapsed().as_secs_f64() < 0.006
    {
        let index = plans.turn % plans.entries.len();
        plans.turn = plans.turn.wrapping_add(1);
        if !plans.entries[index].needs_work()
            || (foreground && !plans.entries[index].needs_visible_pose())
            || plans.entries[index].input.map != current_map.unwrap()
        {
            idle += 1;
            if idle >= plans.entries.len() {
                break;
            }
            continue;
        }
        let searches = FRAME_SEARCH - plans.search_expansions_last_frame;
        let (used, expanded, changed) = plans.step_entry(index, &world, &capsule, searches);
        budget.remaining = budget.remaining.saturating_sub(used);
        plans.steps_last_frame += used;
        plans.search_expansions_last_frame += expanded;
        if changed {
            plans.revision = plans.revision.wrapping_add(1);
        }
        if used == 0 && expanded == 0 && !changed {
            idle += 1;
        } else {
            idle = 0;
        }
        transitions += 1;
        if idle >= plans.entries.len() || transitions > FRAME_STEPS * 4 {
            break;
        }
        if plans.enforce_capacity(index) {
            break;
        }
    }
    // Paused replay apply only wakes on revision. Renew the currently presented
    // demand set while work is pending, so old seeks can age out of the cache
    // without evicting a still-requested component during a long cold prefix.
    if plans.frame % 30 == 0 && plans.entries.iter().any(Entry::needs_work) {
        plans.revision = plans.revision.wrapping_add(1);
    }
    plans.elapsed_processing_ms = start.elapsed().as_secs_f64() * 1000.;
    #[cfg(test)]
    assert_eq!(plans.bytes(), plans.recompute_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::RunSystemOnce;
    fn world(profile: &[(f32, f32)]) -> App {
        super::super::trajectory_probe::tests::world(profile)
    }
    fn input() -> NativeComponentInput {
        NativeComponentInput {
            source: "report".into(),
            actor: "player".into(),
            component: "origin-0".into(),
            content: "raw-v1".into(),
            map: 0,
            samples: vec![
                (0., 0., 1., None),
                (1000., 0., -3., None),
                (2000., 0., -7., None),
            ],
            initial_heights: vec![0.],
            coverage_complete: true,
            profiles: vec![],
            slow_fall: vec![],
            transfers: vec![],
            hover_launches: vec![],
            unresolved_transfers: vec![],
        }
    }
    fn entry(input: NativeComponentInput) -> Entry {
        input.validate().unwrap();
        Entry {
            input_bytes: input.bytes(),
            terrain_blocked: None,
            accounted_bytes: input.bytes(),
            input: Arc::new(input),
            planning: Planning::default(),
            result: Query::NotReady,
            ticks: vec![],
            demand_frame: AtomicU64::new(0),
            visible_demand_frame: AtomicU64::new(0),
            demand_time: AtomicU64::new(0),
        }
    }
    fn finish(app: &mut App, input: NativeComponentInput, batch: usize) -> Entry {
        app.world_mut()
            .run_system_once(move |world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut e = entry(input.clone());
                for _ in 0..100000 {
                    for _ in 0..batch {
                        e.step(&world, &capsule, FRAME_SEARCH);
                    }
                    if matches!(
                        e.result,
                        Query::Ready(_) | Query::Conflict(_) | Query::MissingCoverage
                    ) {
                        return e;
                    }
                }
                panic!("canonical fixture did not terminate")
            })
            .unwrap()
    }
    fn assert_accounting(plans: &CanonicalTrajectories) {
        assert_eq!(plans.bytes(), plans.recompute_bytes());
        for e in &plans.entries {
            assert_eq!(e.input_bytes, e.input.bytes());
            assert_eq!(e.accounted_bytes, e.estimated_bytes());
        }
    }
    #[test]
    fn terrain_preparation_retains_the_chronological_prefix_and_bounded_lookahead() {
        let mut plans = CanonicalTrajectories::default();
        let mut i = input();
        i.samples = (0..80)
            .map(|n| (n as f64 * 1000., n as f32 * 100., 1., Some(0.)))
            .collect();
        plans.submit(i.clone()).unwrap();
        plans.query(&i.source, &i.actor, &i.component, &i.content, 5000.);
        let mut requests = benilla_world::terrain_stream::TrajectoryTerrainRequests::default();
        plans.prepare_terrain(Some(0), &mut requests);
        assert_eq!(requests.map, Some(0));
        for p in [[0., 1.], [500., 1.], [1800., 1.]] {
            assert!(requests.tiles.contains(&terrain::tile(p)), "missing {p:?}");
        }
        assert!(!requests.tiles.contains(&terrain::tile([7900., 1.])));
        assert_eq!(
            plans.diagnostics().terrain_requested_tiles,
            requests.tiles.len()
        );
        assert!(!plans.diagnostics().terrain_capacity_exceeded);
        let before = requests.tiles.clone();
        plans.prepare_terrain(Some(0), &mut requests);
        assert_eq!(requests.tiles, before);
        assert_accounting(&plans);
        plans.clear_demands();
        plans.prepare_terrain(Some(0), &mut requests);
        assert!(requests.tiles.is_empty());
        plans.query(&i.source, &i.actor, &i.component, &i.content, 5000.);
        plans.prepare_terrain(Some(1), &mut requests);
        assert!(requests.tiles.is_empty(), "requests never cross maps");
        plans.retain_source("new-report");
        plans.prepare_terrain(Some(0), &mut requests);
        assert!(requests.tiles.is_empty());
    }
    #[test]
    fn same_component_seeks_replace_old_terrain_ownership_without_false_capacity() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut i = input();
                i.samples = (0..80)
                    .map(|n| (n as f64 * 1000., n as f32 * 100., 1., Some(0.)))
                    .collect();
                let mut plans = CanonicalTrajectories::default();
                plans.submit(i.clone()).unwrap();
                plans.query(&i.source, &i.actor, &i.component, &i.content, 60000.);
                let mut requests =
                    benilla_world::terrain_stream::TrajectoryTerrainRequests::default();
                plans.prepare_terrain(Some(0), &mut requests);
                let forward = requests.tiles.clone();
                assert!(!plans.terrain_capacity_exceeded);
                plans.begin_seek();
                for _ in 0..3 {
                    plans.frame += 1;
                    assert!(!plans.prepare_terrain(Some(0), &mut requests));
                    assert_eq!(
                        requests.tiles, forward,
                        "old demand may run while the replacement batch is unavailable"
                    );
                }

                let mut candidate = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                let checkpoint = Arc::new(candidate.cursor.clone());
                candidate.checkpoints.push(checkpoint.clone());
                candidate.cursor.guidance = Some((
                    0,
                    Arc::new(vec![
                        wow_to_bevy([0., 1., 0.]),
                        wow_to_bevy([0., 12000., 0.]),
                    ]),
                ));
                let mut fresh = CanonicalTrajectories::default();
                fresh.submit(i.clone()).unwrap();
                fresh.query(&i.source, &i.actor, &i.component, &i.content, 0.);
                let fresh_before = fresh.entries[0].accounted_bytes;
                fresh.entries[0]
                    .planning
                    .waiting
                    .push_back(candidate.clone());
                fresh.entries[0].refresh_bytes();
                fresh.accounted_bytes =
                    fresh.accounted_bytes - fresh_before + fresh.entries[0].accounted_bytes;
                let mut bounded =
                    benilla_world::terrain_stream::TrajectoryTerrainRequests::default();
                fresh.prepare_terrain(Some(0), &mut bounded);
                assert!(
                    !fresh.terrain_capacity_exceeded,
                    "the new prefix/cursors alone fit"
                );
                assert!(
                    forward
                        .iter()
                        .chain(&bounded.tiles)
                        .copied()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        > benilla_world::terrain_stream::MAX_TRAJECTORY_TERRAIN_TILES
                );

                let before = plans.entries[0].accounted_bytes;
                plans.entries[0].planning.waiting.push_back(candidate);
                plans.entries[0].refresh_bytes();
                plans.accounted_bytes =
                    plans.accounted_bytes - before + plans.entries[0].accounted_bytes;
                plans.clear_demands();
                plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
                plans.entries[0].planning.waiting[0].cursor.guidance = Some((
                    0,
                    Arc::new(vec![
                        wow_to_bevy([0., 1., 0.]),
                        wow_to_bevy([0., 20000., 0.]),
                    ]),
                ));
                plans.prepare_terrain(Some(0), &mut requests);
                assert!(
                    plans.terrain_capacity_exceeded,
                    "genuinely oversized new coverage remains a conflict"
                );
                assert_eq!(
                    requests.tiles, forward,
                    "overflow leaves the previous bounded set resident"
                );
                plans.entries[0].planning.waiting[0].cursor.guidance = Some((
                    0,
                    Arc::new(vec![
                        wow_to_bevy([0., 1., 0.]),
                        wow_to_bevy([0., 12000., 0.]),
                    ]),
                ));
                plans.prepare_terrain(Some(0), &mut requests);
                assert!(
                    !plans.terrain_capacity_exceeded,
                    "a backward seek must release the old frontier's retained tiles"
                );
                assert_eq!(requests.tiles, bounded.tiles);
                assert!(!matches!(
                    plans.entries[0].result,
                    Query::Conflict(TERRAIN_CAPACITY)
                ));
                assert!(Arc::ptr_eq(
                    plans.entries[0].planning.waiting[0]
                        .checkpoints
                        .last()
                        .unwrap(),
                    &checkpoint
                ));
                assert_accounting(&plans);

                // A completed detour no longer owns this path at the next forward seek.
                let before = plans.entries[0].accounted_bytes;
                plans.entries[0].planning.waiting[0].cursor.guidance = None;
                plans.entries[0].refresh_bytes();
                plans.accounted_bytes =
                    plans.accounted_bytes - before + plans.entries[0].accounted_bytes;
                plans.begin_seek();
                plans.clear_demands();
                plans.query(&i.source, &i.actor, &i.component, &i.content, 60000.);
                plans.prepare_terrain(Some(0), &mut requests);
                assert!(
                    !plans.terrain_capacity_exceeded,
                    "a forward seek must release the old detour's retained tiles"
                );
                assert_eq!(requests.tiles, forward);
                assert!(Arc::ptr_eq(
                    plans.entries[0].planning.waiting[0]
                        .checkpoints
                        .last()
                        .unwrap(),
                    &checkpoint
                ));
                assert_accounting(&plans);
            })
            .unwrap();
    }

    #[test]
    fn seek_terrain_preserves_certified_and_active_history_without_steady_frame_churn() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut i = input();
                i.samples = (0..=40)
                    .map(|n| (n as f64 * 1000., 0., 1., Some(0.)))
                    .collect();
                let mut candidate = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                let tick = candidate.cursor.ticks.rows()[0].clone();
                let detour = |time, y| {
                    let mut value = (*tick).clone();
                    value.time = time;
                    value.pose.position = [0., y, 0.];
                    Arc::new(value)
                };
                candidate.cursor.ticks.push(detour(1000., -1500.));
                candidate.cursor.ticks.push(detour(2000., 1.));
                let mut fallback = candidate.clone();
                fallback.cursor.guidance = Some((
                    0,
                    Arc::new(vec![
                        wow_to_bevy([0., 1., 0.]),
                        wow_to_bevy([0., 3000., 0.]),
                    ]),
                ));
                candidate.walking_fallback = Some(Box::new(fallback));
                let mut failed = candidate.cursor.clone();
                failed.ticks.push(detour(3000., -3000.));
                let probe = WorldProbe::new(&world);
                let from = candidate.cursor.state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5);
                let goal = from + Vec3::X;
                let mut plans = CanonicalTrajectories::default();
                plans.submit(i.clone()).unwrap();
                let before = plans.entries[0].accounted_bytes;
                plans.entries[0].ticks = vec![
                    tick.clone(),
                    detour(1000., 1500.),
                    detour(2000., 1.),
                    detour(40000., 12000.),
                ];
                plans.entries[0].planning.repair = Some(Repair {
                    candidate,
                    failed,
                    search: Search::new(&probe, from, goal).unwrap(),
                    goal,
                });
                plans.entries[0].refresh_bytes();
                plans.accounted_bytes =
                    plans.accounted_bytes - before + plans.entries[0].accounted_bytes;
                plans.begin_seek();
                plans.clear_demands();
                plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
                let mut requests =
                    benilla_world::terrain_stream::TrajectoryTerrainRequests::default();
                assert!(plans.prepare_terrain(Some(0), &mut requests));
                for y in [1500., -1500., 3000., -3000.] {
                    assert!(
                        requests.tiles.contains(&terrain::tile([0., y])),
                        "lost required detour {y}"
                    );
                }
                assert!(
                    !requests.tiles.contains(&terrain::tile([0., 12000.])),
                    "a backward seek does not need a future certified prefix"
                );
                let discovered = requests.tiles.clone();
                let before = plans.entries[0].accounted_bytes;
                plans.entries[0].planning = Planning::default();
                plans.entries[0].refresh_bytes();
                plans.accounted_bytes =
                    plans.accounted_bytes - before + plans.entries[0].accounted_bytes;
                for _ in 0..20 {
                    plans.frame += 1;
                    plans.clear_demands();
                    plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
                    assert!(!plans.prepare_terrain(Some(0), &mut requests));
                    assert_eq!(
                        requests.tiles, discovered,
                        "normal playback retains discovered dependencies"
                    );
                }
                plans.begin_seek();
                plans.clear_demands();
                plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
                assert!(plans.prepare_terrain(Some(0), &mut requests));
                assert!(
                    requests.tiles.contains(&terrain::tile([0., 1500.])),
                    "the required certified detour survives seek"
                );
                assert!(
                    !requests.tiles.contains(&terrain::tile([0., -3000.])),
                    "a new seek releases completed cursor work"
                );
                let current = requests.tiles.clone();
                plans.begin_seek();
                plans.clear_demands();
                plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
                assert!(
                    !plans.prepare_terrain(Some(0), &mut requests),
                    "identical seek coverage does not churn residency"
                );
                assert_eq!(requests.tiles, current);
                assert_accounting(&plans);
            })
            .unwrap();
    }

    #[test]
    fn terrain_dependency_capacity_is_explicit_and_smaller_seek_restores_prior_status() {
        let mut plans = CanonicalTrajectories::default();
        let mut i = input();
        i.samples = (0..=20)
            .map(|n| (n as f64 * 1000., 0., 1., Some(0.)))
            .collect();
        i.samples.push((40000., 16000., 16000., Some(0.)));
        plans.submit(i.clone()).unwrap();
        plans.query(&i.source, &i.actor, &i.component, &i.content, 30000.);
        let mut requests = benilla_world::terrain_stream::TrajectoryTerrainRequests::default();
        plans.prepare_terrain(Some(0), &mut requests);
        assert!(plans.diagnostics().terrain_capacity_exceeded);
        assert!(
            plans.diagnostics().terrain_requested_tiles
                > benilla_world::terrain_stream::MAX_TRAJECTORY_TERRAIN_TILES
        );
        assert_eq!(plans.entries[0].result, Query::Conflict(TERRAIN_CAPACITY));
        assert!(!plans.entries[0].needs_work());
        assert!(
            requests.tiles.is_empty(),
            "oversized demand is rejected instead of partially certified"
        );
        assert_accounting(&plans);
        plans.clear_demands();
        plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
        plans.prepare_terrain(Some(0), &mut requests);
        assert!(!plans.diagnostics().terrain_capacity_exceeded);
        assert!(!requests.tiles.is_empty());
        assert_eq!(plans.entries[0].result, Query::NotReady);
        assert!(plans.entries[0].needs_work());
        assert_accounting(&plans);
    }
    #[test]
    fn seek_subset_keeps_ready_checkpoints_through_the_production_drive() {
        use benilla_world::terrain_stream::{
            TerrainResidency, TrajectoryTerrainRequests, WorldLoadProgress,
        };
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        app.world_mut().insert_resource(TerrainResidency::default());
        app.world_mut().insert_resource(WorldLoadProgress {
            scene_ready: true,
            trajectory_ready: true,
            ..Default::default()
        });
        let mut i = input();
        i.samples = (0..80)
            .map(|n| (n as f64 * 1000., n as f32 * 100., 1., Some(0.)))
            .collect();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(i.clone())
            .unwrap();
        app.world().resource::<CanonicalTrajectories>().query(
            &i.source,
            &i.actor,
            &i.component,
            &i.content,
            60000.,
        );
        let mut driver = IntoSystem::into_system(drive);
        driver.initialize(app.world_mut());
        app.world_mut()
            .resource_mut::<physics::PhysicsBudget>()
            .remaining = 0;
        driver.run((), app.world_mut()).unwrap();
        let previous = app
            .world()
            .resource::<TrajectoryTerrainRequests>()
            .tiles
            .clone();
        app.world_mut()
            .insert_resource(TerrainResidency::with_tiles(previous.clone()));
        driver.run((), app.world_mut()).unwrap();
        let (candidate, tick) = app
            .world_mut()
            .run_system_once(move |world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let candidate = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                let tick = candidate.cursor.ticks.rows()[0].clone();
                (candidate, tick)
            })
            .unwrap();
        let checkpoint = candidate.checkpoints.last().unwrap().clone();
        let epoch;
        {
            let mut plans = app.world_mut().resource_mut::<CanonicalTrajectories>();
            assert!(plans.world_ready);
            let before = plans.entries[0].accounted_bytes;
            plans.entries[0].ticks.push(tick.clone());
            plans.entries[0].planning.waiting.push_back(candidate);
            plans.entries[0].refresh_bytes();
            plans.accounted_bytes =
                plans.accounted_bytes - before + plans.entries[0].accounted_bytes;
            plans.begin_seek();
            epoch = plans.validation_epoch;
        }
        // Replay application can wait for its replacement input across several drive frames.
        for _ in 0..3 {
            driver.run((), app.world_mut()).unwrap();
            assert_eq!(
                app.world().resource::<TrajectoryTerrainRequests>().tiles,
                previous
            );
        }
        {
            let plans = app.world().resource::<CanonicalTrajectories>();
            let i = &plans.entries[0].input;
            plans.clear_demands();
            plans.query(&i.source, &i.actor, &i.component, &i.content, 0.);
        }
        driver.run((), app.world_mut()).unwrap();
        let current = &app.world().resource::<TrajectoryTerrainRequests>().tiles;
        assert!(current.len() < previous.len());
        assert!(current.iter().all(|tile| previous.contains(tile)));
        let plans = app.world().resource::<CanonicalTrajectories>();
        assert!(plans.world_ready);
        assert_eq!(
            plans.validation_epoch, epoch,
            "a dependency-only shrink does not invalidate the world"
        );
        assert!(Arc::ptr_eq(&plans.entries[0].ticks[0], &tick));
        assert!(Arc::ptr_eq(
            plans.entries[0].planning.waiting[0]
                .checkpoints
                .last()
                .unwrap(),
            &checkpoint
        ));
        assert_accounting(plans);
    }

    #[test]
    fn terrain_requests_are_published_before_world_ready_and_physics_waits_for_their_collisions() {
        use benilla_world::terrain_stream::{
            TerrainResidency, TrajectoryTerrainRequests, WorldLoadProgress,
        };
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        app.world_mut().insert_resource(TerrainResidency::default());
        app.world_mut().insert_resource(WorldLoadProgress {
            scene_ready: true,
            trajectory_ready: true,
            ..Default::default()
        });
        let i = input();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(i.clone())
            .unwrap();
        let mut driver = IntoSystem::into_system(drive);
        driver.initialize(app.world_mut());
        app.world().resource::<CanonicalTrajectories>().query(
            &i.source,
            &i.actor,
            &i.component,
            &i.content,
            1000.,
        );
        driver.run((), app.world_mut()).unwrap();
        let tiles = app
            .world()
            .resource::<TrajectoryTerrainRequests>()
            .tiles
            .clone();
        assert!(tiles.contains(&terrain::tile([0., 1.])));
        assert_eq!(
            app.world().resource::<CanonicalTrajectories>().entries[0]
                .planning
                .work,
            0
        );
        app.world_mut()
            .resource_mut::<WorldLoadProgress>()
            .trajectory_ready = false;
        // A terrain resident bit alone is insufficient while its room placements
        // are still being installed by the streamer.
        app.world_mut()
            .insert_resource(TerrainResidency::with_tiles(tiles.clone()));
        app.world_mut()
            .resource_mut::<physics::PhysicsBudget>()
            .remaining = FRAME_STEPS;
        driver.run((), app.world_mut()).unwrap();
        assert_eq!(
            app.world().resource::<CanonicalTrajectories>().entries[0]
                .planning
                .work,
            0
        );
        app.world_mut()
            .resource_mut::<WorldLoadProgress>()
            .trajectory_ready = true;
        for _ in 0..20 {
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = FRAME_STEPS;
            driver.run((), app.world_mut()).unwrap();
            if matches!(
                app.world().resource::<CanonicalTrajectories>().entries[0].result,
                Query::Ready(_)
            ) {
                break;
            }
        }
        let plans = app.world().resource::<CanonicalTrajectories>();
        assert!(
            plans.entries[0].planning.work > 0
                || matches!(plans.entries[0].result, Query::Ready(_))
        );
        assert!(matches!(
            plans.query(&i.source, &i.actor, &i.component, &i.content, 1000.),
            Query::Ready(_)
        ));
        assert_accounting(plans);
    }
    #[test]
    fn cached_accounting_matches_oracle_across_cache_lifecycle() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut plans = CanonicalTrajectories::default();
                let original = input();
                plans.submit(original.clone()).unwrap();
                assert_accounting(&plans);
                plans.observe_world(1, true);
                for _ in 0..2000 {
                    plans.step_entry(0, &world, &capsule, FRAME_SEARCH);
                    assert_accounting(&plans);
                    if matches!(
                        plans.entries[0].result,
                        Query::Ready(_) | Query::Conflict(_)
                    ) {
                        break;
                    }
                }
                assert!(matches!(plans.entries[0].result, Query::Ready(_)));
                assert!(plans.bytes() > original.bytes());
                let mut replaced = original.clone();
                replaced.content = "new-content".into();
                plans.submit(replaced).unwrap();
                assert_accounting(&plans);
                assert_eq!(plans.bytes(), original.bytes());
                plans.entries[0].planning.work = MAX_COMPONENT_WORK;
                plans.step_entry(0, &world, &capsule, FRAME_SEARCH);
                assert!(matches!(plans.entries[0].result, Query::Conflict(_)));
                assert_accounting(&plans);
                plans.observe_world(2, false);
                assert_accounting(&plans);
                assert_eq!(
                    plans.diagnostics().last_reset,
                    Some(ValidationReset::CollisionChanged)
                );
                plans.observe_world(2, true);
                assert_eq!(
                    plans.diagnostics().last_reset,
                    Some(ValidationReset::ReadinessChanged)
                );
                assert!(plans.evict_inactive());
                assert_accounting(&plans);
                assert_eq!(plans.bytes(), 0);
                plans.submit(original).unwrap();
                plans.retain_source("different-report");
                assert_accounting(&plans);
                assert_eq!(plans.bytes(), 0);
            })
            .unwrap();
    }
    #[test]
    fn nested_candidates_repair_and_shifted_capacity_conflict_are_accounted() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut plans = CanonicalTrajectories::default();
                let mut inactive = input();
                inactive.actor = "evict-first".into();
                plans.submit(inactive).unwrap();
                let active = input();
                plans.submit(active.clone()).unwrap();
                plans.query(
                    &active.source,
                    &active.actor,
                    &active.component,
                    &active.content,
                    0.,
                );
                let mut c = initial(&active, 0, &world, &capsule).unwrap().unwrap();
                c.checkpoints.push(Arc::new(c.cursor.clone()));
                c.walking_fallback = Some(Box::new(c.clone()));
                let probe = WorldProbe::new(&world);
                let from = c.cursor.state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5);
                let goal = from + Vec3::X;
                let search = Search::new(&probe, from, goal).unwrap();
                let before = plans.entries[1].accounted_bytes;
                plans.entries[1].planning.repair = Some(Repair {
                    candidate: c.clone(),
                    failed: c.cursor.clone(),
                    search,
                    goal,
                });
                plans.entries[1].refresh_bytes();
                plans.accounted_bytes =
                    plans.accounted_bytes - before + plans.entries[1].accounted_bytes;
                assert_accounting(&plans);
                plans.step_entry(1, &world, &capsule, 1);
                assert_accounting(&plans);
                // Reserve enough checkpoint estimates to force capacity recovery,
                // keeping allocation small because each checkpoint is shared.
                c.checkpoints =
                    vec![Arc::new(c.cursor.clone()); MAX_BYTES / std::mem::size_of::<Cursor>() + 1];
                let before = plans.entries[1].accounted_bytes;
                plans.entries[1].planning.waiting.push_back(c);
                plans.entries[1].refresh_bytes();
                plans.accounted_bytes =
                    plans.accounted_bytes - before + plans.entries[1].accounted_bytes;
                assert_accounting(&plans);
                assert!(plans.enforce_capacity(1));
                assert_eq!(plans.entries.len(), 1);
                assert_eq!(plans.entries[0].input.actor, active.actor);
                assert!(matches!(
                    plans.entries[0].result,
                    Query::Conflict("Canonical cache capacity exceeded")
                ));
                assert_eq!(plans.diagnostics().evictions, 1);
                assert_eq!(plans.diagnostics().capacity_conflicts, 1);
                assert!(plans.bytes() < MAX_BYTES);
                assert_accounting(&plans);
            })
            .unwrap();
    }
    #[test]
    fn preparation_is_bounded_background_demand_and_preserves_seek_checkpoints() {
        let mut plans = CanonicalTrajectories::default();
        let i = input();
        plans.submit(i.clone()).unwrap();
        assert!(!plans.prepare(&i.source, &i.actor, &i.component, &i.content, f64::NAN));
        assert!(!plans.prepare(&i.source, &i.actor, &i.component, &i.content, 3000.));
        assert!(plans.prepare(&i.source, &i.actor, &i.component, &i.content, 1000.));
        assert!(plans.entries[0].needs_work());
        assert!(!plans.entries[0].needs_visible_pose());
        assert!(
            plans.entries[0].ticks.is_empty(),
            "demand cannot advance physics"
        );
        plans.query(&i.source, &i.actor, &i.component, &i.content, 500.);
        assert!(plans.entries[0].needs_visible_pose());
        plans.prepare(&i.source, &i.actor, &i.component, &i.content, 1500.);
        assert_eq!(plans.component_diagnostics()[0].demand_time, Some(500.));
        plans.clear_demands();
        assert!(!plans.entries[0].needs_work());
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let completed = finish(&mut app, i.clone(), 1);
        let bytes = completed.accounted_bytes;
        plans.entries[0] = completed;
        plans.accounted_bytes = bytes;
        let before = plans.entries[0].ticks.clone();
        let epoch = plans.validation_epoch();
        for time in [2000., 0., 1500., 500., 2000.] {
            plans.clear_demands();
            assert!(matches!(
                plans.query(&i.source, &i.actor, &i.component, &i.content, time),
                Query::Ready(_)
            ));
            assert_eq!(plans.validation_epoch(), epoch);
            assert_eq!(plans.bytes(), bytes);
            assert!(!plans.entries[0].needs_work());
            for (a, b) in before.iter().zip(&plans.entries[0].ticks) {
                assert!(Arc::ptr_eq(a, b));
            }
        }
        assert_accounting(&plans);
    }
    #[test]
    fn immutable_content_and_source_updates_never_depend_on_seek_generation() {
        let mut p = CanonicalTrajectories::default();
        let i = input();
        p.submit(i.clone()).unwrap();
        let revision = p.revision();
        p.submit(i.clone()).unwrap();
        assert_eq!(p.revision(), revision);
        assert!(p
            .hold(&i.source, &i.actor, &i.component, &i.content, 0.)
            .is_none());
        let mut changed = i.clone();
        changed.samples[1].1 = 1.;
        assert!(p.submit(changed.clone()).is_err());
        changed.content = "raw-v2".into();
        p.submit(changed).unwrap();
        assert_eq!(
            p.query(&i.source, &i.actor, &i.component, &i.content, 0.),
            Query::Missing
        );
        p.retain_source("new-report");
        assert!(p.entries.is_empty());
        assert!(p.revision() > revision);
    }
    #[test]
    fn observed_origin_is_hard_and_pending_inferred_seeds_are_not_rendered() {
        let mut p = CanonicalTrajectories::default();
        let mut i = input();
        i.samples[0].3 = Some(0.);
        i.initial_heights = vec![99.];
        p.submit(i.clone()).unwrap();
        assert_eq!(i.seeds(), vec![0.]);
        assert_eq!(
            p.hold(&i.source, &i.actor, &i.component, &i.content, 1000.)
                .unwrap()
                .position,
            [0., 1., 0.]
        );
        i.coverage_complete = false;
        i.content = "partial".into();
        i.samples[0].3 = None;
        p.submit(i.clone()).unwrap();
        assert_eq!(
            p.query(&i.source, &i.actor, &i.component, &i.content, 500.),
            Query::MissingCoverage
        );
        assert!(p
            .hold(&i.source, &i.actor, &i.component, &i.content, 500.)
            .is_none());
    }
    #[test]
    fn native_input_profile_and_transport_caps_are_explicit() {
        let mut i = input();
        i.initial_heights = vec![0.; 4];
        assert!(i.validate().is_err());
        i.initial_heights = vec![0.];
        i.samples[1].0 = 0.;
        assert!(i.validate().is_err());
        i = input();
        i.profiles = vec![MovementProfile::default()];
        assert!(i.validate().is_err());
        i.profiles = vec![
            MovementProfile {
                travel_budget: Some(14.),
                progress: vec![(0., 0.), (1000., 1.)],
                ..default()
            },
            MovementProfile::default(),
        ];
        assert!(i.validate().is_ok());
        assert_eq!(i.fraction(1, 100., 4., true), 0.);
        assert_eq!(i.fraction(1, 100., 4., false), 0.1);
        assert_eq!(i.fraction(1, 500., 4., true), 0.5);
        assert_eq!(i.fraction(1, 900., 4., true), 1.);
        i.profiles[0].progress[1].1 = 0.5;
        assert!(i.validate().is_err());
    }
    #[test]
    fn actual_physics_walking_and_shuffled_readback_have_one_shared_observation_state() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let i = input();
        let e = finish(&mut app, i.clone(), 7);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        let baseline =
            [0., 499., 999., 1000., 1001., 1999., 2000.].map(|t| sample(&e.ticks, t).unwrap());
        let mut p = CanonicalTrajectories::default();
        p.accounted_bytes += e.accounted_bytes;
        p.entries.push_back(e);
        for n in [6, 0, 4, 2, 5, 1, 3, 3, 0, 6] {
            assert_eq!(
                p.query(
                    &i.source,
                    &i.actor,
                    &i.component,
                    &i.content,
                    [0., 499., 999., 1000., 1001., 1999., 2000.][n]
                ),
                Query::Ready(baseline[n].clone())
            );
        }
        for &(t, x, y, _) in &i.samples {
            let pose = sample(&p.entries[0].ticks, t).unwrap();
            assert!((pose.position[0] - x).hypot(pose.position[1] - y) <= 0.05);
        }
        assert_eq!(baseline[0].position, [0., 1., 0.]);
        assert!(baseline[0].planar_speed > 0.03);
        assert_eq!(baseline[0].heading, baseline[1].heading);
        assert!(
            p.hold(&i.source, &i.actor, &i.component, &i.content, 1000.)
                .unwrap()
                .planar_speed
                == 0.
        );
    }
    #[test]
    fn admitted_fast_grounded_motion_matches_observations_without_bypassing_walls() {
        let mut i = input();
        i.samples = vec![
            (0., 0., 1., None),
            (163., 0., -4.02, None),
            (596., 0., -13.09, None),
        ];
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let e = finish(&mut app, i.clone(), 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        for &(time, x, y, _) in &i.samples {
            let pose = sample(&e.ticks, time).unwrap();
            assert!((pose.position[0] - x).hypot(pose.position[1] - y) <= 0.05);
            assert!(pose.planar_speed <= 35.01);
        }
        assert!(sample(&e.ticks, 100.).unwrap().planar_speed > 30.);
        let mut app = world(&[(-20., 0.), (0., 0.), (0., 10.), (100., 10.)]);
        let blocked = finish(&mut app, i, 17);
        assert!(matches!(blocked.result, Query::Conflict(_)));
    }
    #[test]
    fn delayed_observation_can_require_a_jump_at_the_actual_earlier_ledge() {
        let mut app = super::super::trajectory_probe::tests::world_layers(&[
            &[(-5., 10.), (0., 10.)],
            &[(0., 0.), (30., 0.)],
            &[(4.6, 0.), (4.6, 7.), (30., 7.)],
        ]);
        let mut i = input();
        i.initial_heights = vec![10.];
        i.samples = vec![
            (0., 0., 1., None),
            (500., 0., -1., None),
            (1000., 0., -3., None),
            (2000., 0., -7., Some(7.)),
            (3000., 0., -11., Some(7.)),
        ];
        i.profiles = i
            .samples
            .windows(2)
            .map(|pair| MovementProfile {
                travel_budget: Some(((pair[1].0 - pair[0].0) / 1000.) as f32 * 7.),
                run_speed: Some(7.),
                progress: vec![(pair[0].0, 0.), (pair[1].0, 1.)],
                ..default()
            })
            .collect();
        let e = finish(&mut app, i.clone(), 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert!(sample(&e.ticks, 500.).unwrap().jump_arc);
        assert!(sample(&e.ticks, 2000.).unwrap().position[2] > 6.9);
        assert!(sample(&e.ticks, 2000.).unwrap().inferred_jumps > 0);
        for &(t, x, y, z) in &i.samples {
            let pose = sample(&e.ticks, t).unwrap();
            assert!((pose.position[0] - x).hypot(pose.position[1] - y) <= 0.05);
            assert!(z.is_none_or(|z| (pose.position[2] - z).abs() <= 0.1));
        }
    }
    #[test]
    fn flat_landing_does_not_restart_a_delayed_running_clock_mid_interval() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.samples = vec![(0., 0., 0., Some(2.)), (1000., 0., -2., Some(0.))];
        i.profiles = vec![MovementProfile {
            travel_budget: Some(7.),
            run_speed: Some(7.),
            progress: vec![(0., 0.), (1000., 1.)],
            ..default()
        }];
        let e = finish(&mut app, i, 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert!(e
            .ticks
            .iter()
            .any(|t| t.pose.support == Support::Grounded && t.time < 800.));
        assert!(
            e.ticks
                .windows(2)
                .all(|p| p[1].pose.position[1] <= p[0].pose.position[1] + 0.0001),
            "landing must retain the forward observation clock"
        );
        assert!((sample(&e.ticks, 700.).unwrap().position[1] + 1.4).abs() < 0.05);
    }
    #[test]
    fn recorded_slow_fall_uses_client_terminal_and_exact_mode_boundaries() {
        let mut app = world(&[(-5., 10.), (0., 10.), (0., -30.), (40., -30.)]);
        let mut i = input();
        i.initial_heights = vec![10.];
        i.samples = (0..=4)
            .map(|n| (n as f64 * 1000., 0., 1. - n as f32 * 4., None))
            .collect();
        i.samples[0].3 = Some(10.);
        i.slow_fall = vec![(0., false), (1000., true), (2500., false)];
        let e = finish(&mut app, i, 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert!(!sample(&e.ticks, 999.).unwrap().feather_fall);
        assert!(sample(&e.ticks, 1000.).unwrap().feather_fall);
        let slow = sample(&e.ticks, 2000.).unwrap();
        assert!(
            slow.feather_fall
                && slow.vertical_velocity >= -super::super::FEATHER_TERMINAL_VELOCITY - 0.001
        );
        assert!(!sample(&e.ticks, 2500.).unwrap().feather_fall);
        assert!(
            sample(&e.ticks, 2800.).unwrap().vertical_velocity
                < -super::super::FEATHER_TERMINAL_VELOCITY
        );
    }
    #[test]
    fn recorded_hover_grant_launches_once_and_an_airborne_grant_is_consumed() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.slow_fall = vec![(0., false), (500., true)];
        i.hover_launches = vec![500., 1000.];
        let e = finish(&mut app, i, 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert!(sample(&e.ticks, 499.).unwrap().position[2].abs() < 0.05);
        let launched = sample(&e.ticks, 520.).unwrap();
        assert!(launched.jump_arc && launched.position[2] > 0.05 && launched.feather_fall);
        assert_eq!(launched.inferred_jumps, 0);
        assert!(sample(&e.ticks, 1010.).unwrap().vertical_velocity < 0.);
        assert_eq!(sample(&e.ticks, 2000.).unwrap().support, Support::Grounded);
    }
    #[test]
    fn stationary_certification_cannot_coarsen_a_due_recorded_hover_launch() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.samples = vec![
            (0., 0., 0., None),
            (1000., 0., 0., None),
            (2000., 0., 0., None),
        ];
        i.slow_fall = vec![(0., false), (500., true)];
        i.hover_launches = vec![500.];
        let e = finish(&mut app, i, 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert!(sample(&e.ticks, 750.).unwrap().position[2] > 1.);
        for p in e.ticks.windows(2) {
            if p[0].pose.support == Support::Falling || p[1].pose.support == Support::Falling {
                assert!(
                    p[1].time - p[0].time <= 10.001,
                    "airborne mode cannot use a certified stationary step"
                );
            }
        }
    }
    #[test]
    fn unresolved_known_transfer_never_commits_an_ordinary_flight() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.unresolved_transfers = vec![(500., false)];
        let pending = finish(&mut app, i.clone(), 17);
        assert!(matches!(pending.result, Query::MissingCoverage));
        assert!(pending.ticks.is_empty());
        i.unresolved_transfers[0].1 = true;
        let conflict = finish(&mut app, i, 17);
        assert!(matches!(conflict.result, Query::Conflict(_)));
        assert!(conflict.ticks.is_empty());
    }
    #[test]
    fn recorded_transfer_crosses_a_gap_with_capsule_clearance_and_cannot_cross_a_wall() {
        let mut i = input();
        i.initial_heights = vec![10.];
        i.samples = vec![
            (0., 0., -3., Some(10.)),
            (1000., 0., -3., Some(10.)),
            (2000., 0., -10., None),
            (3000., 0., -18., Some(10.)),
            (4000., 0., -20., Some(10.)),
        ];
        i.transfers = vec![(1000., 3000.)];
        let mut app = super::super::trajectory_probe::tests::world_layers(&[
            &[(-5., 10.), (4., 10.)],
            &[(0., 0.), (30., 0.)],
            &[(15., 0.), (15., 10.), (30., 10.)],
        ]);
        let e = finish(&mut app, i.clone(), 17);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert_eq!(sample(&e.ticks, 999.).unwrap().position[1], -3.);
        assert!(sample(&e.ticks, 2000.).unwrap().controlled_air);
        assert!(!sample(&e.ticks, 2000.).unwrap().falling_far());
        assert!(!sample(&e.ticks, 3000.).unwrap().controlled_air);
        assert_eq!(sample(&e.ticks, 4000.).unwrap().support, Support::Grounded);
        for &(t, x, y, z) in &i.samples {
            let p = sample(&e.ticks, t).unwrap();
            assert!((p.position[0] - x).hypot(p.position[1] - y) <= 0.05);
            assert!(z.is_none_or(|z| (p.position[2] - z).abs() <= 0.1));
        }
        let mut rail_world = super::super::trajectory_probe::tests::world_layers(&[
            &[(-5., 10.), (4., 10.), (4., 11.), (4.2, 11.), (4.2, 10.)],
            &[(0., 0.), (30., 0.)],
            &[(15., 0.), (15., 10.), (30., 10.)],
        ]);
        let over_rail = finish(&mut rail_world, i.clone(), 17);
        assert!(
            matches!(over_rail.result, Query::Ready(_)),
            "{:?}",
            over_rail.result
        );
        assert!(sample(&over_rail.ticks, 2000.).unwrap().position[2] > 11.5);
        let mut app = super::super::trajectory_probe::tests::world_layers(&[
            &[(-5., 10.), (4., 10.)],
            &[(0., 0.), (30., 0.)],
            &[(8., 0.), (8., 20.), (30., 20.)],
        ]);
        let blocked = finish(&mut app, i.clone(), 17);
        assert!(matches!(blocked.result, Query::Conflict(_)));
        i.transfers.clear();
        let mut app = super::super::trajectory_probe::tests::world_layers(&[
            &[(-5., 10.), (4., 10.)],
            &[(0., 0.), (30., 0.)],
            &[(15., 0.), (15., 10.), (30., 10.)],
        ]);
        assert!(matches!(finish(&mut app, i, 17).result, Query::Conflict(_)));
    }
    #[test]
    fn invalid_effect_modes_do_not_enter_the_native_cache() {
        let mut i = input();
        for modes in [
            vec![(1., true)],
            vec![(0., true), (0., false)],
            vec![(0., false), (3000., true)],
        ] {
            i.slow_fall = modes;
            assert!(i.validate().is_err());
        }
        i.slow_fall.clear();
        for modes in [
            vec![(0., 3000.)],
            vec![(1000., 500.)],
            vec![(0., 1500.)],
            vec![(0., 2000.), (1000., 2000.)],
        ] {
            i.transfers = modes;
            assert!(i.validate().is_err());
        }
    }
    #[test]
    fn full_fall_state_survives_observations_without_imposing_a_floor() {
        let mut app = world(&[(-5., 10.), (0., 10.), (0., 0.), (30., 0.)]);
        let mut i = input();
        i.initial_heights = vec![10.];
        i.samples = vec![
            (0., 0., 1., None),
            (500., 0., -1., None),
            (1000., 0., -4., None),
            (1500., 0., -7., None),
        ];
        let e = finish(&mut app, i.clone(), 13);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        let b = sample(&e.ticks, 500.).unwrap();
        let c = sample(&e.ticks, 1000.).unwrap();
        assert!(b.position[2] > 0. && c.position[2] > 0.);
        assert!(b.vertical_velocity < 0. && c.vertical_velocity < b.vertical_velocity);
        assert_eq!(b.support, Support::Falling);
        assert!(!b.falling_far() && c.falling_far());
        assert!(!b.jump_arc && !c.jump_arc);
        assert!(c.airborne_seconds > b.airborne_seconds && c.fall_distance > b.fall_distance);
        assert_eq!(e.planning.work, 0); // terminal planner data released
    }
    #[test]
    fn short_sparse_gap_carries_falling_state_and_never_reseeds_height() {
        let mut app = world(&[(-5., 40.), (0., 40.), (0., 0.), (30., 0.)]);
        let mut i = input();
        i.initial_heights = vec![40.];
        i.samples = vec![
            (0., 0., 1., Some(40.)),
            (500., 0., -1., None),
            (3000., 0., -15., None),
        ];
        i.profiles = vec![
            MovementProfile::default(),
            MovementProfile {
                unrestricted: true,
                ..default()
            },
        ];
        let e = finish(&mut app, i.clone(), 13);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        let at = sample(&e.ticks, 500.).unwrap();
        let after = sample(&e.ticks, 750.).unwrap();
        assert_eq!(at.support, Support::Falling);
        assert_eq!(after.support, Support::Falling);
        assert!(after.position[2] < at.position[2]);
        assert!(after.vertical_velocity < at.vertical_velocity);
        assert!(after.airborne_seconds > at.airborne_seconds);
        for &(t, x, y, _) in &i.samples {
            let p = sample(&e.ticks, t).unwrap();
            assert!((p.position[0] - x).hypot(p.position[1] - y) <= 0.05);
        }
        for (duration, distance) in [(5001., 1.), (5000., 40.01)] {
            let mut bounded = i.clone();
            bounded.samples = vec![(0., 0., 1., Some(40.)), (duration, 0., 1. - distance, None)];
            bounded.profiles = vec![MovementProfile {
                unrestricted: true,
                ..default()
            }];
            let rejected = finish(&mut app, bounded, 13);
            assert!(matches!(rejected.result, Query::Conflict(_)));
        }
    }
    #[test]
    fn explicit_height_and_unreachable_wall_constraints_do_not_become_ready() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.samples[1].3 = Some(99.);
        let e = finish(&mut app, i, 23);
        assert!(matches!(e.result, Query::Conflict(_)));
        let mut app = world(&[
            (-20., 0.),
            (0., 0.),
            (0., 10.),
            (1., 10.),
            (1., 0.),
            (100., 0.),
        ]);
        let e = finish(&mut app, input(), 29);
        assert!(matches!(e.result, Query::Conflict(_)), "{:?}", e.result);
    }
    #[test]
    fn legal_native_jump_control_keeps_air_velocity_without_additional_impulses() {
        let mut profile = vec![(-5., 0.), (0., 0.)];
        for n in 0..20 {
            profile.push((n as f32 + 0.16, (n + 1) as f32 * 0.28));
            profile.push((n as f32 + 1., (n + 1) as f32 * 0.28));
        }
        profile.push((40., 5.6));
        let mut app = world(&profile);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut i = input();
                i.samples = vec![(0., 0., 1., None), (2000., 0., -27., None)];
                let mut c = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                c.cursor.windows = vec![[700., 750.]];
                loop {
                    match advance(&mut c, &i, &world, &capsule, 2000., 2000.) {
                        Advance::Window => break,
                        Advance::Step | Advance::Observed(true) => {}
                        _ => panic!("legal jump failed"),
                    }
                }
                assert_eq!(c.cursor.launches, vec![700.]);
                let rows = c.cursor.ticks.rows();
                assert!(rows.iter().any(|r| r.pose.support == Support::Falling));
                assert!((sample(&rows, 2000.).unwrap().position[1] + 27.).abs() < 0.05);
            })
            .unwrap();
    }
    #[test]
    fn source_anchored_prefix_commit_preserves_a_full_boundary_checkpoint_and_never_rewrites_it() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.samples = (0..18)
            .map(|n| (n as f64 * 1300., 0., 1. - n as f32, None))
            .collect();
        app.world_mut()
            .run_system_once(move |world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut e = entry(i.clone());
                while e.ticks.is_empty() {
                    e.step(&world, &capsule, FRAME_SEARCH);
                }
                assert_eq!(e.ticks.last().unwrap().time, 8000.);
                let first = e
                    .ticks
                    .iter()
                    .map(|r| (r.time, r.pose.clone()))
                    .collect::<Vec<_>>();
                let c = &e.planning.waiting[0].cursor;
                assert_eq!(c.time, 8000.);
                assert_eq!(c.next, 7);
                assert_eq!(c.state.vy, 0.);
                while !matches!(e.result, Query::Ready(_) | Query::Conflict(_)) {
                    e.step(&world, &capsule, FRAME_SEARCH);
                }
                assert!(matches!(e.result, Query::Ready(_)));
                for (time, pose) in first {
                    assert_eq!(sample(&e.ticks, time).unwrap(), pose);
                }
            })
            .unwrap();
    }
    #[test]
    fn later_failure_retains_committed_poses_and_safe_hold_without_floor_reselection() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.samples = (0..15)
            .map(|n| (n as f64 * 1000., 0., 1. - n as f32, None))
            .collect();
        i.samples[13].3 = Some(99.);
        let i2 = i.clone();
        let e = finish(&mut app, i, 41);
        assert!(matches!(e.result, Query::Conflict(_)));
        assert_eq!(e.ticks.last().unwrap().time, 8000.);
        let mut p = CanonicalTrajectories::default();
        p.accounted_bytes += e.accounted_bytes;
        p.entries.push_back(e);
        assert!(matches!(
            p.query(&i2.source, &i2.actor, &i2.component, &i2.content, 8000.),
            Query::Ready(_)
        ));
        assert!(matches!(
            p.query(&i2.source, &i2.actor, &i2.component, &i2.content, 13000.),
            Query::Conflict(_)
        ));
        assert_eq!(
            p.hold(&i2.source, &i2.actor, &i2.component, &i2.content, 13000.)
                .unwrap()
                .position,
            sample(&p.entries[0].ticks, 8000.).unwrap().position
        );
    }
    #[test]
    fn component_and_cache_caps_cancel_and_release_work() {
        let mut p = CanonicalTrajectories::default();
        for n in 0..MAX_ENTRIES + 1 {
            let mut i = input();
            i.actor = n.to_string();
            p.submit(i).unwrap();
        }
        assert_eq!(p.entries.len(), MAX_ENTRIES);
        assert_eq!(p.entries[0].input.actor, "1");
        let pinned = p.entries[0].input.clone();
        p.query(
            &pinned.source,
            &pinned.actor,
            &pinned.component,
            &pinned.content,
            0.,
        );
        let mut incoming = input();
        incoming.actor = "pin-sentinel".into();
        p.submit(incoming).unwrap();
        assert!(p
            .find(
                &pinned.source,
                &pinned.actor,
                &pinned.component,
                &pinned.content
            )
            .is_some());
        assert!(!p.entries.iter().any(|e| e.input.actor == "2"));
        assert!(p.bytes() < MAX_BYTES);
        p.observe_world(1, true);
        let rev = p.revision();
        p.observe_world(1, true);
        assert_eq!(rev, p.revision());
        p.observe_world(2, true);
        assert!(p.revision() > rev);
        assert!(p
            .entries
            .iter()
            .all(|e| matches!(e.result, Query::NotReady)));
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let mut e = entry(input());
                e.planning.work = MAX_COMPONENT_WORK;
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                e.step(&world, &capsule, 2048);
                assert!(matches!(e.result, Query::Conflict(_)));
                assert!(e.planning.waiting.is_empty());
            })
            .unwrap();
    }
    #[test]
    fn presentation_demand_cancellation_pauses_old_work_and_resumes_the_same_prefix() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        let mut old = input();
        old.actor = "old".into();
        old.samples = (0..61)
            .map(|t| (t as f64 * 1000., 0., 1. - t as f32, None))
            .collect();
        let mut current = old.clone();
        current.actor = "current".into();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(old.clone())
            .unwrap();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(current.clone())
            .unwrap();
        let mut driver = IntoSystem::into_system(drive);
        driver.initialize(app.world_mut());
        for _ in 0..100 {
            let p = app.world().resource::<CanonicalTrajectories>();
            p.query(
                &old.source,
                &old.actor,
                &old.component,
                &old.content,
                30000.,
            );
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = FRAME_STEPS;
            driver.run((), app.world_mut()).unwrap();
            if !app.world().resource::<CanonicalTrajectories>().entries[0]
                .ticks
                .is_empty()
            {
                break;
            }
        }
        let p = app.world().resource::<CanonicalTrajectories>();
        assert!(!p.entries[0].ticks.is_empty());
        let before = p.entries[0].planning.work;
        let prefix = p.entries[0].ticks.clone();
        p.clear_demands();
        p.query(
            &current.source,
            &current.actor,
            &current.component,
            &current.content,
            1000.,
        );
        for _ in 0..3 {
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = FRAME_STEPS;
            driver.run((), app.world_mut()).unwrap();
        }
        let p = app.world().resource::<CanonicalTrajectories>();
        assert_eq!(
            p.entries[0].planning.work, before,
            "a seek away must pause old work"
        );
        assert!(p.entries[1].planning.work > 0);
        assert_eq!(p.entries[0].ticks.len(), prefix.len());
        for (a, b) in p.entries[0].ticks.iter().zip(&prefix) {
            assert!(Arc::ptr_eq(a, b));
        }
        p.clear_demands();
        p.query(
            &old.source,
            &old.actor,
            &old.component,
            &old.content,
            30000.,
        );
        app.world_mut()
            .resource_mut::<physics::PhysicsBudget>()
            .remaining = FRAME_STEPS;
        driver.run((), app.world_mut()).unwrap();
        let p = app.world().resource::<CanonicalTrajectories>();
        assert!(p.entries[0].planning.work > before);
        for (a, b) in p.entries[0].ticks.iter().zip(&prefix) {
            assert!(Arc::ptr_eq(a, b));
        }
    }
    #[test]
    fn visible_pending_pose_gets_work_before_ready_pose_prefetch() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        let mut ready = input();
        ready.actor = "ready".into();
        ready.samples = (0..61)
            .map(|t| (t as f64 * 1000., 0., 1. - t as f32, None))
            .collect();
        let mut pending = ready.clone();
        pending.actor = "pending".into();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(ready.clone())
            .unwrap();
        let mut driver = IntoSystem::into_system(drive);
        driver.initialize(app.world_mut());
        for _ in 0..100 {
            let p = app.world().resource::<CanonicalTrajectories>();
            p.query(
                &ready.source,
                &ready.actor,
                &ready.component,
                &ready.content,
                0.,
            );
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = FRAME_STEPS;
            driver.run((), app.world_mut()).unwrap();
            if !app.world().resource::<CanonicalTrajectories>().entries[0]
                .ticks
                .is_empty()
            {
                break;
            }
        }
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(pending.clone())
            .unwrap();
        let p = app.world().resource::<CanonicalTrajectories>();
        assert!(matches!(
            p.query(
                &ready.source,
                &ready.actor,
                &ready.component,
                &ready.content,
                1000.
            ),
            Query::Ready(_)
        ));
        p.query(
            &pending.source,
            &pending.actor,
            &pending.component,
            &pending.content,
            1000.,
        );
        assert!(
            p.entries[0].needs_work(),
            "ready entry still has prefetch demand"
        );
        let before = p.entries[0].planning.work;
        app.world_mut()
            .resource_mut::<physics::PhysicsBudget>()
            .remaining = FRAME_STEPS;
        driver.run((), app.world_mut()).unwrap();
        let p = app.world().resource::<CanonicalTrajectories>();
        assert_eq!(
            p.entries[0].planning.work, before,
            "foreground must precede speculative prefetch"
        );
        assert!(p.entries[1].planning.work > 0);
        assert!(p.steps_last_frame <= FRAME_STEPS);
    }
    #[test]
    fn actual_driver_queues_before_map_ready_and_shares_fair_bounded_work() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        {
            let mut p = app.world_mut().resource_mut::<CanonicalTrajectories>();
            for n in 0..40 {
                let mut i = input();
                i.actor = format!("p{n}");
                i.samples = (0..13)
                    .map(|t| (t as f64 * 1000., 0., 1. - t as f32, None))
                    .collect();
                p.submit(i).unwrap();
            }
        }
        let mut driver = IntoSystem::into_system(drive);
        driver.initialize(app.world_mut());
        driver.run((), app.world_mut()).unwrap();
        assert_eq!(
            app.world()
                .resource::<CanonicalTrajectories>()
                .steps_last_frame,
            0
        );
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        let started = Instant::now();
        let mut frames = 0;
        let mut total = 0;
        let mut epoch = None;
        loop {
            {
                let p = app.world().resource::<CanonicalTrajectories>();
                for e in &p.entries {
                    p.query(
                        &e.input.source,
                        &e.input.actor,
                        &e.input.component,
                        &e.input.content,
                        0.,
                    );
                }
            }
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = FRAME_STEPS;
            driver.run((), app.world_mut()).unwrap();
            frames += 1;
            let p = app.world().resource::<CanonicalTrajectories>();
            if let Some(epoch) = epoch {
                assert_eq!(
                    p.validation_epoch(),
                    epoch,
                    "ordinary planning/commit must retain world epoch"
                );
            } else {
                epoch = Some(p.validation_epoch());
            }
            assert!(p.steps_last_frame <= 200);
            assert!(p.search_expansions_last_frame <= 2048);
            total += p.steps_last_frame;
            if frames == 3 {
                assert!(p.entries.iter().all(|e| e.planning.work > 0));
            }
            if p.entries.iter().all(|e| !e.ticks.is_empty()) {
                eprintln!(
                    "40actor firstprefix frames={frames} totalSteps={total} cpuMs={} bytes={}",
                    started.elapsed().as_secs_f64() * 1000.,
                    p.bytes()
                );
                break;
            }
            assert!(frames < 2000);
        }
        let before = app.world().resource::<CanonicalTrajectories>().revision();
        app.world_mut().resource_mut::<ColliderEpoch>().bump();
        app.world_mut()
            .resource_mut::<physics::PhysicsBudget>()
            .remaining = 0;
        driver.run((), app.world_mut()).unwrap();
        let p = app.world().resource::<CanonicalTrajectories>();
        assert!(p.revision() > before);
        assert!(p.entries.iter().all(|e| e.ticks.is_empty()));
    }
    #[test]
    fn collision_transform_layer_mask_and_residency_changes_invalidate_completed_plans() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        let i = input();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(i.clone())
            .unwrap();
        let mut driver = IntoSystem::into_system(drive);
        driver.initialize(app.world_mut());
        for _ in 0..10 {
            app.world().resource::<CanonicalTrajectories>().query(
                &i.source,
                &i.actor,
                &i.component,
                &i.content,
                0.,
            );
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = 200;
            driver.run((), app.world_mut()).unwrap();
        }
        assert!(!app.world().resource::<CanonicalTrajectories>().entries[0]
            .ticks
            .is_empty());
        let entity = app
            .world_mut()
            .query_filtered::<Entity, With<Collider>>()
            .single(app.world())
            .unwrap();
        for change in 0..6 {
            let old = app.world().resource::<CanonicalTrajectories>().revision();
            let old_epoch = app
                .world()
                .resource::<CanonicalTrajectories>()
                .validation_epoch();
            match change {
                0 => {
                    app.world_mut().entity_mut(entity).insert(Position(Vec3::Y));
                }
                1 => {
                    app.world_mut()
                        .entity_mut(entity)
                        .insert(Rotation(Quat::from_rotation_y(0.1)));
                }
                2 => {
                    let mut collider = app.world_mut().get_mut::<Collider>(entity).unwrap();
                    let shape = collider.shape_mut();
                    *shape = shape.clone();
                }
                3 => {
                    app.world_mut()
                        .entity_mut(entity)
                        .insert(CollisionLayers::new(0u32, 0u32));
                }
                4 => {
                    app.world_mut()
                        .resource_mut::<MoverTraceExclusions>()
                        .0
                        .insert(entity);
                }
                _ => {
                    app.world_mut().insert_resource(
                        benilla_world::terrain_stream::TerrainResidency::one_object(),
                    );
                }
            }
            app.world_mut()
                .resource_mut::<physics::PhysicsBudget>()
                .remaining = 0;
            driver.run((), app.world_mut()).unwrap();
            let p = app.world().resource::<CanonicalTrajectories>();
            assert!(p.revision() > old);
            assert!(p.validation_epoch() > old_epoch);
            assert!(p.entries[0].ticks.is_empty());
        }
    }
    #[test]
    fn lookahead_keeps_a_later_legal_jump_when_first_fit_fails_the_next_observation() {
        let mut app = world(&[
            (-20., 0.),
            (0., 0.),
            (0., 1.2),
            (3., 1.2),
            (3., -10.),
            (100., -10.),
        ]);
        let mut i = input();
        i.samples = vec![
            (0., 0., 2., None),
            (600., 0., -1., None),
            (800., 0., -2., Some(1.62)),
            (1800., 0., -7., None),
        ];
        i.samples[2].3 = Some(1.70);
        let oracle = i.clone();
        app.world_mut()
            .run_system_once(move |world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut candidate = initial(&oracle, 0, &world, &capsule).unwrap().unwrap();
                candidate.cursor.windows = vec![[200., 600.]];
                while candidate.cursor.time < 800. {
                    match advance(&mut candidate, &oracle, &world, &capsule, 1800., 1800.) {
                        Advance::Observed(valid) => {
                            if candidate.cursor.time == 600. {
                                assert!(valid);
                            } else if candidate.cursor.time == 800. {
                                assert!(!valid);
                            }
                        }
                        Advance::Step => {}
                        _ => panic!("early jump fixture unexpectedly terminated"),
                    }
                }
            })
            .unwrap();
        let e = finish(&mut app, i.clone(), 13);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert_eq!(sample(&e.ticks, 200.).unwrap().inferred_jumps, 0);
        assert_eq!(sample(&e.ticks, 350.).unwrap().inferred_jumps, 1);
        assert_eq!(sample(&e.ticks, 1800.).unwrap().inferred_jumps, 1);
        let later = sample(&e.ticks, 1300.).unwrap();
        assert_eq!(later.inferred_jumps, 1);
        assert!(!later.jump_arc);
        assert_eq!(later.support, Support::Falling);
        for &(t, x, y, z) in &i.samples {
            let pose = sample(&e.ticks, t).unwrap();
            assert!((pose.position[0] - x).hypot(pose.position[1] - y) <= 0.05);
            assert!(z.is_none_or(|z| (pose.position[2] - z).abs() <= 0.1));
        }
    }
    #[test]
    fn small_unsupported_origin_settles_without_rewriting_its_height() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        let mut i = input();
        i.initial_heights = vec![2.];
        let e = finish(&mut app, i.clone(), 19);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert_eq!(e.ticks[0].pose.position[2], 2.);
        assert_eq!(e.ticks[0].pose.support, Support::Falling);
        assert!(sample(&e.ticks, 250.).unwrap().vertical_velocity < 0.);
        assert_eq!(sample(&e.ticks, 1000.).unwrap().support, Support::Grounded);
        assert!(sample(&e.ticks, 1000.).unwrap().position[2].abs() < 0.05);
        i.initial_heights = vec![99.];
        i.samples.truncate(1);
        let unsupported = finish(&mut app, i.clone(), 19);
        assert!(matches!(unsupported.result, Query::Conflict(_)));
        i.samples[0].3 = Some(99.);
        let observed = finish(&mut app, i, 19);
        assert!(matches!(observed.result, Query::Ready(_)));
        assert_eq!(observed.ticks[0].pose.position[2], 99.);
    }
    #[test]
    fn xy_only_void_fall_tries_another_origin_but_recorded_height_remains_authoritative() {
        let mut app = super::super::trajectory_probe::tests::world_layers(&[
            &[(-20., 0.), (0., 0.), (0., -100.), (100., -100.)],
            &[(-20., 10.), (100., 10.)],
        ]);
        let mut i = input();
        i.initial_heights = vec![0., 10.];
        i.samples = (0..=6)
            .map(|n| (n as f64 * 2000., 0., 1. - n as f32 * 4., None))
            .collect();
        let e = finish(&mut app, i.clone(), 23);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert_eq!(e.ticks[0].pose.position[2], 10.);
        assert_eq!(sample(&e.ticks, 8000.).unwrap().support, Support::Grounded);
        i.samples[0].3 = Some(0.);
        let e = finish(&mut app, i, 23);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert_eq!(e.ticks[0].pose.position[2], 0.);
        assert!(sample(&e.ticks, 8000.).unwrap().position[2] < -99.);
    }
    #[test]
    fn ranked_seed_prior_wins_only_after_a_feasible_window_and_explicit_z_overrides_it() {
        let mut app = world(&[(-20., 0.), (100., 0.), (-20., 10.), (100., 10.)]);
        let mut i = input();
        i.initial_heights = vec![10., 0.];
        let e = finish(&mut app, i.clone(), 3);
        assert!(matches!(e.result, Query::Ready(_)));
        assert_eq!(e.ticks[0].pose.position[2], 10.);
        i.initial_heights = vec![99., 10.];
        let e = finish(&mut app, i.clone(), 17);
        assert!(matches!(e.result, Query::Ready(_)));
        assert_eq!(e.ticks[0].pose.position[2], 10.);
        i.samples[0].3 = Some(0.);
        let e = finish(&mut app, i, 11);
        assert!(matches!(e.result, Query::Ready(_)));
        assert_eq!(e.ticks[0].pose.position[2], 0.);
    }
    #[test]
    fn falling_far_uses_native_launch_height_or_stepoff_time_and_latches_until_support() {
        let mut pose = origin([0.; 3]);
        pose.support = Support::Falling;
        pose.jump_arc = true;
        pose.airborne_seconds = 9.;
        assert!(!pose.falling_far());
        pose.fall_distance = super::super::FALL_FAR_DROP;
        assert!(pose.falling_far());
        pose.far_latched = true;
        pose.fall_distance = 0.;
        assert!(pose.falling_far());
        pose.support = Support::Grounded;
        assert!(!pose.falling_far());
        pose.support = Support::Falling;
        pose.far_latched = false;
        pose.jump_arc = false;
        pose.airborne_seconds = super::super::FALL_FAR_TIME - 0.001;
        pose.fall_distance = 100.;
        assert!(!pose.falling_far());
        pose.airborne_seconds = super::super::FALL_FAR_TIME;
        assert!(pose.falling_far());
    }
    #[test]
    fn grounded_astar_repairs_a_wall_under_the_same_physical_owner() {
        use avian3d::prelude::{PhysicsPlugins, RigidBody};
        let mut app = App::new();
        app.init_resource::<MoverTraceExclusions>()
            .init_resource::<ColliderEpoch>()
            .add_plugins((
                MinimalPlugins,
                bevy::transform::TransformPlugin,
                bevy::asset::AssetPlugin::default(),
                bevy::scene::ScenePlugin,
                PhysicsPlugins::new(bevy::app::PostUpdate),
            ));
        app.init_asset::<Mesh>();
        let vertices = vec![
            Vec3::new(-20., 0., -20.),
            Vec3::new(20., 0., -20.),
            Vec3::new(20., 0., 20.),
            Vec3::new(-20., 0., 20.),
            Vec3::new(0., 0., -1.),
            Vec3::new(0., 4., -1.),
            Vec3::new(0., 4., 1.),
            Vec3::new(0., 0., 1.),
            Vec3::new(0.2, 0., -1.),
            Vec3::new(0.2, 4., -1.),
            Vec3::new(0.2, 4., 1.),
            Vec3::new(0.2, 0., 1.),
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 6, 5],
            [4, 7, 6],
            [8, 9, 10],
            [8, 10, 11],
            [4, 5, 9],
            [4, 9, 8],
            [7, 11, 10],
            [7, 10, 6],
            [5, 6, 10],
            [5, 10, 9],
        ];
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::trimesh(vertices, triangles),
            Transform::default(),
        ));
        app.update();
        let mut i = input();
        i.samples = vec![(0., 0., 2., None), (2000., 0., -2., None)];
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                assert!(
                    world
                        .cast_mover(
                            &capsule,
                            Vec3::new(-2., CAPSULE_HEIGHT * 0.5, 0.),
                            Vec3::X * 4.,
                            0.
                        )
                        .is_some(),
                    "fixture wall must physically block direct capsule"
                );
            })
            .unwrap();
        let e = finish(&mut app, i, 23);
        assert!(matches!(e.result, Query::Ready(_)), "{:?}", e.result);
        assert_eq!(e.ticks.last().unwrap().pose.inferred_jumps, 0);

        assert!(e.ticks.iter().any(|t| t.pose.position[0].abs() > 1.));
        for t in &e.ticks {
            let p = wow_to_bevy(t.pose.position);
            assert!(p.x.abs() >= CAPSULE_RADIUS || p.z.abs() > 1. + CAPSULE_RADIUS);
        }
        assert!((e.ticks.last().unwrap().pose.position[1] + 2.).abs() <= 0.05);
    }
    #[test]
    fn diagnostic_and_canonical_jobs_share_two_hundred_steps_without_starvation() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        install(&mut app);
        physics::install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(0));
        let mut i = input();
        i.samples = (0..6)
            .map(|t| (t as f64 * 1000., 0., 1. - t as f32, None))
            .collect();
        app.world_mut()
            .resource_mut::<CanonicalTrajectories>()
            .submit(i.clone())
            .unwrap();
        app.world_mut().resource_mut::<physics::Control>().pending = Some(physics::Request {
            token: 4,
            samples: vec![
                physics::Observation {
                    id: "a".into(),
                    time: 0.,
                    position: (0., 1., None),
                },
                physics::Observation {
                    id: "b".into(),
                    time: 1900.,
                    position: (0., -3., None),
                },
            ],
            initial_heights: vec![0.; 3],
            jump_windows: vec![],
            max_steps: 5000,
        });
        let mut both_progress = false;
        for _ in 0..20 {
            app.world().resource::<CanonicalTrajectories>().query(
                &i.source,
                &i.actor,
                &i.component,
                &i.content,
                0.,
            );
            app.world_mut().run_schedule(First);
            app.world_mut().run_schedule(Update);
            let p = app.world().resource::<CanonicalTrajectories>();
            let diagnostic = app.world().resource::<physics::Control>();
            assert!(p.steps_last_frame <= 200);
            assert!(app.world().resource::<physics::PhysicsBudget>().remaining <= 200);
            both_progress |= p.steps_last_frame > 0 && diagnostic.response.is_none();
            if diagnostic.response.is_some()
                && matches!(
                    p.query(&i.source, &i.actor, &i.component, &i.content, 0.),
                    Query::Ready(_)
                )
            {
                assert!(both_progress);
                assert_eq!(diagnostic.response.as_ref().unwrap().steps, 570);
                return;
            }
        }
        panic!("one physics service starved the other");
    }
    #[test]
    fn stationary_fast_forward_matches_every_ten_ms_pose_on_flat_slope_and_ledge() {
        for profile in [
            vec![(-20., 0.), (100., 0.)],
            vec![(-20., -2.), (100., 10.)],
            vec![(-20., 0.), (0., 0.), (0., -10.), (100., -10.)],
        ] {
            let mut app = world(&profile);
            app.world_mut()
                .run_system_once(move |world: WorldCollision| {
                    let capsule =
                        Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                    let mut i = input();
                    i.samples = vec![(0., 0., 0.5, None), (1000., 0., 0.5, None)];
                    i.initial_heights = vec![if profile[0].1 < 0. { -0.05 } else { 0. }];
                    let original = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                    let run = |force_ten: bool| {
                        let mut c = original.clone();
                        loop {
                            if force_ten {
                                c.cursor.stationary_certified = false;
                            }
                            match advance(&mut c, &i, &world, &capsule, 1000., 1000.) {
                                Advance::Window => break,
                                Advance::Step | Advance::Observed(true) => {}
                                _ => panic!("stationary fixture unexpectedly failed"),
                            }
                        }
                        c.cursor.ticks.rows()
                    };
                    let fast = run(false);
                    let reference = run(true);
                    assert!(
                        fast.len() < reference.len() / 5,
                        "certified stationary state should skip redundant queries"
                    );
                    for t in 0..=1000 {
                        assert_eq!(
                            sample(&fast, t as f64),
                            sample(&reference, t as f64),
                            "stationary mismatch at {t}ms"
                        );
                    }
                })
                .unwrap();
        }
    }
    #[test]
    fn stationary_skip_splits_jump_and_profile_events_and_never_skips_airborne_motion() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut i = input();
                i.samples = vec![(0., 0., 0., None), (1000., 0., 0., None)];
                i.profiles = vec![MovementProfile {
                    progress: vec![(0., 0.), (275., 0.275), (1000., 1.)],
                    ..default()
                }];
                let mut original = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                original.cursor.windows = vec![[500., 600.]];
                let run = |force_ten: bool| {
                    let mut c = original.clone();
                    loop {
                        if force_ten {
                            c.cursor.stationary_certified = false;
                        }
                        match advance(&mut c, &i, &world, &capsule, 800., 1000.) {
                            Advance::Window => break,
                            Advance::Step | Advance::Observed(true) => {}
                            _ => panic!("jump fixture failed"),
                        }
                    }
                    assert_eq!(c.cursor.launches, vec![500.]);
                    c.cursor.ticks.rows()
                };
                let fast = run(false);
                let reference = run(true);
                assert!(fast.iter().any(|t| t.time == 275.));
                assert!(fast.iter().any(|t| t.time == 500.));
                for t in 0..=1000 {
                    assert_eq!(
                        sample(&fast, t as f64),
                        sample(&reference, t as f64),
                        "jump mismatch at {t}ms"
                    );
                }
                assert!(fast
                    .windows(2)
                    .filter(|p| p[0].time >= 500.)
                    .all(|p| p[1].time - p[0].time <= 10.));
            })
            .unwrap();
    }
    #[test]
    fn stale_stationary_certificate_cannot_skip_unsupported_or_steep_state() {
        let mut app = world(&[(-20., 0.), (0., 0.), (0., -10.), (100., -10.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut i = input();
                i.samples = vec![(0., 0., 1., None), (1000., 0., 1., None)];
                let original = initial(&i, 0, &world, &capsule).unwrap().unwrap();
                let mut unsupported = original.clone();
                unsupported.cursor.state.center.x = 0.5;
                unsupported.cursor.stationary_certified = true;
                let mut after = i.clone();
                after.samples.iter_mut().for_each(|s| s.2 = -0.5);
                advance(&mut unsupported, &after, &world, &capsule, 1000., 1000.);
                assert_eq!(unsupported.cursor.time, 10.);
                assert_eq!(unsupported.cursor.state.support, Support::Falling);
                let mut steep = original.clone();
                steep.cursor.state.support = Support::Steep;
                steep.cursor.stationary_certified = true;
                advance(&mut steep, &i, &world, &capsule, 1000., 1000.);
                assert_eq!(steep.cursor.time, 10.);
            })
            .unwrap();
    }
    #[test]
    fn half_stationary_prefix_reduces_work_and_storage_without_changing_walking_cadence() {
        let mut app = world(&[(-20., 0.), (100., 0.)]);
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut results = vec![];
                for mixed in [false, true] {
                    let mut i = input();
                    i.samples = (0..13)
                        .map(|n| {
                            (
                                n as f64 * 1000.,
                                0.,
                                1. - if mixed {
                                    ((n + 1) / 2) as f32
                                } else {
                                    n as f32
                                },
                                None,
                            )
                        })
                        .collect();
                    let mut e = entry(i);
                    let mut steps = 0;
                    while e.ticks.is_empty() {
                        steps += e.step(&world, &capsule, 2048).0;
                        assert!(!matches!(e.result, Query::Conflict(_)));
                    }
                    results.push((steps, e.ticks.len()));
                }
                eprintln!(
                    "prefix moving steps/ticks={:?}; half-stationary={:?}",
                    results[0], results[1]
                );
                assert_eq!(results, vec![(1000, 801), (510, 409)]);
            })
            .unwrap();
    }
    #[test]
    fn validation_epoch_changes_only_with_physics_world_or_readiness() {
        let mut p = CanonicalTrajectories::default();
        assert_eq!(p.validation_epoch(), 0);
        p.observe_world(7, true);
        let epoch = p.validation_epoch();
        assert_eq!(epoch, 1);
        p.submit(input()).unwrap();
        p.query("report", "player", "origin-0", "raw-v1", 0.);
        p.retain_source("report");
        for n in 0..MAX_ENTRIES {
            let mut i = input();
            i.actor = n.to_string();
            p.submit(i).unwrap();
        }
        assert_eq!(p.validation_epoch(), epoch);
        p.observe_world(7, true);
        assert_eq!(p.validation_epoch(), epoch);
        p.observe_world(7, false);
        assert_eq!(p.validation_epoch(), epoch + 1);
        p.observe_world(7, true);
        assert_eq!(p.validation_epoch(), epoch + 2);
        p.observe_world(8, true);
        assert_eq!(p.validation_epoch(), epoch + 3);
    }
}
