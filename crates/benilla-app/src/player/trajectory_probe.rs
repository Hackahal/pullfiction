//! On-demand diagnostic only. No replay actor, input, network, or scene state is written.
use super::{
    edge, mover, CAPSULE_HEIGHT, CAPSULE_RADIUS, GROUND_COS, GROUND_PROBE, JUMP_SPEED, LAND_PROBE,
    SKIN_WIDTH, TERMINAL_VELOCITY,
};
use avian3d::prelude::Collider;
use benilla_assets::coords::{bevy_to_wow, wow_to_bevy};
use benilla_world::collision::{ColliderEpoch, WorldCollision};
use bevy::platform::time::Instant;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const FRAME_STEPS: usize = 200;
const MAX_STEPS: usize = 5000;
fn default_steps() -> usize {
    MAX_STEPS
}
#[derive(Clone, Deserialize)]
pub struct Observation {
    pub id: String,
    /// Replay milliseconds, independent of presentation/wall-clock time.
    pub time: f64,
    pub position: (f32, f32, Option<f32>),
}
#[derive(Clone, Deserialize)]
pub struct Request {
    pub token: u32,
    pub samples: Vec<Observation>,
    pub initial_heights: Vec<f32>,
    /// Optional input hypotheses, never a claim that a jump was recorded.
    #[serde(default)]
    pub jump_windows: Vec<[f64; 2]>,
    #[serde(default = "default_steps")]
    pub max_steps: usize,
}
impl Request {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.samples.is_empty()
            || self.samples.len() > 500
            || self.initial_heights.is_empty()
            || self.initial_heights.len() > 3
            || !(1..=MAX_STEPS).contains(&self.max_steps)
            || self.jump_windows.len() > 3
        {
            return Err("Invalid trajectory probe input bounds");
        }
        let mut ids = std::collections::HashSet::new();
        if self.samples.iter().any(|s| {
            s.id.is_empty()
                || s.id.len() > 80
                || !ids.insert(s.id.as_str())
                || !s.time.is_finite()
                || !(0. ..=1e12).contains(&s.time)
                || !s.position.0.is_finite()
                || !s.position.1.is_finite()
                || s.position.0.abs() > 20000.
                || s.position.1.abs() > 20000.
                || s.position
                    .2
                    .is_some_and(|z| !z.is_finite() || z.abs() > 20000.)
        }) || self
            .initial_heights
            .iter()
            .any(|z| !z.is_finite() || z.abs() > 20000.)
            || self
                .samples
                .windows(2)
                .any(|p| p[1].time - p[0].time < 0.001)
            || self.samples.last().unwrap().time - self.samples[0].time > 15000.
        {
            return Err("Invalid trajectory probe observations");
        }
        if self.jump_windows.iter().any(|[start, end]| {
            !start.is_finite()
                || !end.is_finite()
                || *start < self.samples[0].time
                || *end > self.samples.last().unwrap().time
                || end < start
                || end - start > 500.
        }) || self
            .jump_windows
            .windows(2)
            .any(|pair| pair[1][0] <= pair[0][1])
        {
            return Err("Invalid inferred jump windows");
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Complete,
    Conflicted,
    NotReady,
    Unsupported,
    BudgetExceeded,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    Grounded,
    Steep,
    Falling,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    HorizontalClipped,
    ObservedHeight,
    InitialVelocityUnknown,
    SparseInterval,
    HorizontalDiscontinuity,
    NoGroundedJumpSupport,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    pub time: f64,
    pub position: [f32; 3],
    pub vertical_velocity: f32,
    pub support: Support,
    pub xy_residual: f32,
    pub max_xy_residual: f32,
    pub max_requested_steering_speed: f32,
    pub max_applied_planar_speed: f32,
    pub steering_clamped: bool,
    pub observed_z_residual: Option<f32>,
    pub conflicts: Vec<Conflict>,
    pub steps: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hypothesis {
    pub initial_height: f32,
    pub status: Status,
    pub samples: Vec<Sample>,
    pub steps: usize,
    pub conflicts: Vec<Conflict>,
    pub inferred_launch_times: Vec<f64>,
    pub unresolved_jump_windows: Vec<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub token: u32,
    pub status: Status,
    pub steps: usize,
    pub elapsed_processing_ms: f64,
    pub collider_revision: u64,
    pub hypotheses: Vec<Hypothesis>,
}
#[derive(Default, Resource)]
pub struct Control {
    pub pending: Option<Request>,
    pub response: Option<Response>,
}

#[derive(Clone)]
pub(super) struct State {
    pub(super) center: Vec3,
    pub(super) vy: f32,
    pub(super) support: Support,
    pub(super) max_residual: f32,
    pub(super) max_requested_steering_speed: f32,
    pub(super) max_applied_planar_speed: f32,
    pub(super) steering_clamped: bool,
}
struct Job {
    request: Request,
    hypotheses: Vec<Hypothesis>,
    active: usize,
    next: usize,
    next_jump: usize,
    time: f64,
    state: Option<State>,
    steps: usize,
    elapsed_ms: f64,
    revision: u64,
    map: u32,
    terminal: Option<Status>,
}
impl Job {
    fn new(request: Request, revision: u64, map: u32) -> Self {
        let hypotheses = request
            .initial_heights
            .iter()
            .map(|z| Hypothesis {
                initial_height: *z,
                status: Status::Complete,
                samples: vec![],
                steps: 0,
                conflicts: vec![],
                inferred_launch_times: vec![],
                unresolved_jump_windows: vec![],
            })
            .collect();
        Self {
            time: request.samples[0].time,
            request,
            hypotheses,
            active: 0,
            next: 1,
            next_jump: 0,
            state: None,
            steps: 0,
            elapsed_ms: 0.,
            revision,
            map,
            terminal: None,
        }
    }
    fn row(&self, at: usize, initial: bool) -> Sample {
        let observation = &self.request.samples[at];
        let state = self.state.as_ref().unwrap();
        let position = bevy_to_wow(state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5));
        let residual =
            (position[0] - observation.position.0).hypot(position[1] - observation.position.1);
        let z_residual = observation.position.2.map(|z| position[2] - z);
        let mut conflicts = vec![];
        // Only logged observation endpoints constrain XY. The interpolated
        // chord guides control, but a valid physical path may deviate from it.
        if residual > 0.05 {
            conflicts.push(Conflict::HorizontalClipped);
        }
        if z_residual.is_some_and(|d| d.abs() > 0.1) {
            conflicts.push(Conflict::ObservedHeight);
        }
        if initial
            && state.support == Support::Falling
            && self.hypotheses[self.active]
                .inferred_launch_times
                .is_empty()
        {
            conflicts.push(Conflict::InitialVelocityUnknown);
        }
        Sample {
            id: observation.id.clone(),
            time: observation.time,
            position,
            vertical_velocity: state.vy,
            support: state.support,
            xy_residual: residual,
            max_xy_residual: state.max_residual,
            max_requested_steering_speed: state.max_requested_steering_speed,
            max_applied_planar_speed: state.max_applied_planar_speed,
            steering_clamped: state.steering_clamped,
            observed_z_residual: z_residual,
            conflicts,
            steps: self.hypotheses[self.active].steps,
        }
    }
    fn record(&mut self, at: usize, initial: bool) {
        let row = self.row(at, initial);
        if !row.conflicts.is_empty() {
            self.hypotheses[self.active].status = Status::Conflicted;
        }
        for conflict in &row.conflicts {
            if !self.hypotheses[self.active].conflicts.contains(conflict) {
                self.hypotheses[self.active].conflicts.push(*conflict);
            }
        }
        self.hypotheses[self.active].samples.push(row);
        let state = self.state.as_mut().unwrap();
        state.max_residual = 0.;
        state.max_requested_steering_speed = 0.;
        state.max_applied_planar_speed = 0.;
        state.steering_clamped = false;
    }
    fn jump_events(&mut self, world: &WorldCollision, capsule: &Collider) {
        while let Some([start, end]) = self.request.jump_windows.get(self.next_jump).copied() {
            if self.time < start {
                break;
            }
            let state = self.state.as_mut().unwrap();
            if self.time <= end && launch_if_supported(state, world, capsule) {
                self.hypotheses[self.active]
                    .inferred_launch_times
                    .push(self.time);
                self.next_jump += 1;
                // Windows do not overlap. No second impulse can occur at this time.
                break;
            }
            if self.time >= end {
                let hypothesis = &mut self.hypotheses[self.active];
                hypothesis.unresolved_jump_windows.push(self.next_jump);
                if !hypothesis
                    .conflicts
                    .contains(&Conflict::NoGroundedJumpSupport)
                {
                    hypothesis.conflicts.push(Conflict::NoGroundedJumpSupport);
                }
                hypothesis.status = Status::Conflicted;
                self.next_jump += 1;
            } else {
                break;
            }
        }
    }
    fn advance(&mut self, world: &WorldCollision, capsule: &Collider, limit: usize) -> bool {
        let before = self.steps;
        while self.active < self.hypotheses.len() {
            if self.state.is_none() {
                let first = &self.request.samples[0];
                let feet = wow_to_bevy([
                    first.position.0,
                    first.position.1,
                    self.hypotheses[self.active].initial_height,
                ]);
                if !edge::may_resolve(world, feet, Vec3::ZERO, edge::Sweep::Walk) {
                    self.terminal = Some(Status::NotReady);
                    return true;
                }
                let center = feet + Vec3::Y * (CAPSULE_HEIGHT * 0.5);
                let support = if has_support(world, capsule, center, GROUND_PROBE) {
                    Support::Grounded
                } else {
                    Support::Falling
                };
                self.state = Some(State {
                    center,
                    vy: 0.,
                    support,
                    max_residual: 0.,
                    max_requested_steering_speed: 0.,
                    max_applied_planar_speed: 0.,
                    steering_clamped: false,
                });
                self.time = first.time;
                self.next = 1;
                self.next_jump = 0;
                self.jump_events(world, capsule);
                self.record(0, true);
            }
            if self.next == self.request.samples.len() {
                self.active += 1;
                self.state = None;
                continue;
            }
            if self.steps >= self.request.max_steps {
                self.terminal = Some(Status::BudgetExceeded);
                return true;
            }
            if self.steps - before >= limit {
                return false;
            }
            let a = &self.request.samples[self.next - 1];
            let b = &self.request.samples[self.next];
            let seconds = (b.time - a.time) / 1000.;
            let velocity = (wow_to_bevy([b.position.0, b.position.1, 0.])
                - wow_to_bevy([a.position.0, a.position.1, 0.]))
                / seconds as f32;
            if seconds > 2. || velocity.length() > 35. {
                self.hypotheses[self.active]
                    .conflicts
                    .push(if seconds > 2. {
                        Conflict::SparseInterval
                    } else {
                        Conflict::HorizontalDiscontinuity
                    });
                self.hypotheses[self.active].status = Status::Unsupported;
                self.active += 1;
                self.state = None;
                continue;
            }
            let mut dt_ms = (b.time - self.time)
                .min(10.)
                .min(if velocity.length() > 0. {
                    250. / velocity.length() as f64
                } else {
                    10.
                });
            if let Some(window) = self.request.jump_windows.get(self.next_jump) {
                for boundary in window {
                    if *boundary > self.time {
                        dt_ms = dt_ms.min(boundary - self.time);
                    }
                }
            }
            let dt = Duration::from_secs_f64(dt_ms / 1000.);
            let next_time = (self.time + dt_ms).min(b.time);
            let fraction = ((next_time - a.time) / (b.time - a.time)) as f32;
            let desired = wow_to_bevy([
                a.position.0 + (b.position.0 - a.position.0) * fraction,
                a.position.1 + (b.position.1 - a.position.1) * fraction,
                0.,
            ]);
            if dt.is_zero() {
                // Finite sub-nanosecond event boundaries advance event time only;
                // never divide a control velocity by a rounded zero duration.
                self.time = next_time;
                let observation_due = self.time >= b.time;
                self.jump_events(world, capsule);
                if observation_due {
                    self.record(self.next, false);
                    self.next += 1;
                }
                continue;
            }
            let state = self.state.as_mut().unwrap();
            // Observations constrain the target, not the resolved body. Infer a
            // bounded control input that compensates ramp/step drift; collisions
            // still decide the resulting position, including genuine wall clips.
            let wish = (desired - state.center).with_y(0.) / dt.as_secs_f32();
            let requested = wish.length();
            let steering = wish.clamp_length_max(20.);
            if !physics_step(state, world, capsule, steering, dt) {
                self.terminal = Some(Status::NotReady);
                return true;
            }
            state.max_requested_steering_speed = state.max_requested_steering_speed.max(requested);
            state.max_applied_planar_speed = state.max_applied_planar_speed.max(steering.length());
            state.steering_clamped |= requested > 20.;
            self.steps += 1;
            self.hypotheses[self.active].steps += 1;
            self.time = next_time;
            state.max_residual = state
                .max_residual
                .max((state.center - desired).with_y(0.).length());
            let observation_due = self.time >= b.time;
            self.jump_events(world, capsule);
            if observation_due {
                self.record(self.next, false);
                self.next += 1;
            }
        }
        true
    }
    fn response(mut self) -> Response {
        let status = self.terminal.unwrap_or_else(|| {
            if self
                .hypotheses
                .iter()
                .any(|h| h.status == Status::Unsupported)
            {
                Status::Unsupported
            } else if self
                .hypotheses
                .iter()
                .any(|h| h.status == Status::Conflicted)
            {
                Status::Conflicted
            } else {
                Status::Complete
            }
        });
        if self.terminal.is_some() {
            for hypothesis in &mut self.hypotheses[self.active..] {
                hypothesis.status = status;
            }
        }
        Response {
            token: self.request.token,
            status,
            steps: self.steps,
            elapsed_processing_ms: self.elapsed_ms,
            collider_revision: self.revision,
            hypotheses: self.hypotheses,
        }
    }
}
pub(super) fn launch_if_supported(
    state: &mut State,
    world: &WorldCollision,
    capsule: &Collider,
) -> bool {
    let grounded = state.vy <= 0.
        && (has_support(
            world,
            capsule,
            state.center,
            if state.support == Support::Falling {
                LAND_PROBE
            } else {
                GROUND_PROBE
            },
        ) || state.support == Support::Steep);
    if grounded {
        state.vy = JUMP_SPEED;
        state.support = Support::Falling;
    }
    grounded
}
pub(super) fn has_support(
    world: &WorldCollision,
    capsule: &Collider,
    center: Vec3,
    reach: f32,
) -> bool {
    world
        .cast_mover(capsule, center, Vec3::NEG_Y * reach, SKIN_WIDTH)
        .is_some_and(|h| h.normal1.y >= GROUND_COS)
}
pub(super) fn physics_step(
    state: &mut State,
    world: &WorldCollision,
    capsule: &Collider,
    horizontal: Vec3,
    dt: Duration,
) -> bool {
    physics_step_with_terminal(state, world, capsule, horizontal, dt, TERMINAL_VELOCITY)
}
pub(super) fn physics_step_with_terminal(
    state: &mut State,
    world: &WorldCollision,
    capsule: &Collider,
    horizontal: Vec3,
    dt: Duration,
    terminal: f32,
) -> bool {
    let feet = state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5);
    let grounded = state.vy <= 0.
        && (has_support(
            world,
            capsule,
            state.center,
            if state.support == Support::Falling {
                LAND_PROBE
            } else {
                GROUND_PROBE
            },
        ) || state.support == Support::Steep);
    let (end, mean) = if grounded {
        (0., 0.)
    } else {
        mover::fall_step(state.vy, dt.as_secs_f32(), terminal)
    };
    let sweep = if grounded {
        edge::Sweep::Walk
    } else {
        edge::Sweep::Fall {
            drop: -mean * dt.as_secs_f32(),
        }
    };
    if !edge::may_resolve(world, feet, horizontal * dt.as_secs_f32(), sweep) {
        return false;
    }
    if grounded {
        let moved = mover::grounded_step(
            world,
            capsule,
            state.center,
            horizontal,
            dt,
            mover::Support {
                steep: state.support == Support::Steep,
                ..Default::default()
            },
        );
        // The local mover spends this unsupported snap; remote packet replay
        // deliberately does not. The next substep carries the resulting fall.
        state.center = moved.center - Vec3::Y * moved.unsupported.unwrap_or(0.);
        state.vy = 0.;
        state.support = if moved.steep_support {
            Support::Steep
        } else if moved.unsupported.is_some() {
            Support::Falling
        } else {
            Support::Grounded
        };
    } else {
        state.center = mover::airborne_step(
            world,
            capsule,
            state.center,
            horizontal + Vec3::Y * mean,
            dt,
        );
        state.vy = end;
        // This is the same short capsule classification used by a falling mover,
        // never a long ray that substitutes another storey for its current state.
        if state.vy <= 0. && has_support(world, capsule, state.center, LAND_PROBE) {
            state.vy = 0.;
            state.support = Support::Grounded;
        } else {
            state.support = Support::Falling;
        }
    }
    true
}
/// Recorded server-controlled travel still uses the client's airborne capsule
/// mover. Only its requested vertical velocity is controlled by the episode.
pub(super) fn transfer_step(
    state: &mut State,
    world: &WorldCollision,
    capsule: &Collider,
    desired: Vec3,
    dt: Duration,
) -> bool {
    let mut velocity = (desired - state.center) / dt.as_secs_f32();
    velocity.y = velocity.y.clamp(-TERMINAL_VELOCITY, TERMINAL_VELOCITY);
    let horizontal = velocity.with_y(0.).clamp_length_max(35.);
    velocity.x = horizontal.x;
    velocity.z = horizontal.z;
    let feet = state.center - Vec3::Y * (CAPSULE_HEIGHT * 0.5);
    if !edge::may_resolve(
        world,
        feet,
        horizontal * dt.as_secs_f32(),
        edge::Sweep::Fall {
            drop: (-velocity.y * dt.as_secs_f32()).max(0.),
        },
    ) {
        return false;
    }
    state.center = mover::airborne_step(world, capsule, state.center, velocity, dt);
    state.vy = velocity.y;
    state.support = if state.vy <= 0. && has_support(world, capsule, state.center, LAND_PROBE) {
        state.vy = 0.;
        Support::Grounded
    } else {
        Support::Falling
    };
    true
}
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProbeDrive;
#[derive(Resource)]
pub(super) struct PhysicsBudget {
    pub(super) remaining: usize,
    pub(super) diagnostic_active: bool,
    pub(super) canonical_active: bool,
}
pub(super) fn install_budget(app: &mut App) {
    if !app.world().contains_resource::<PhysicsBudget>() {
        app.insert_resource(PhysicsBudget {
            remaining: FRAME_STEPS,
            diagnostic_active: false,
            canonical_active: false,
        })
        .add_systems(First, |mut budget: ResMut<PhysicsBudget>| {
            budget.remaining = FRAME_STEPS
        });
    }
}
pub(crate) fn install(app: &mut App) {
    install_budget(app);
    app.init_resource::<Control>().add_systems(
        Update,
        drive
            .in_set(ProbeDrive)
            .in_set(benilla_world::schedule::WorldStage::Input),
    );
}
fn drive(
    mut control: ResMut<Control>,
    world: WorldCollision,
    epoch: Res<ColliderEpoch>,
    map: Option<Res<benilla_world::world_map::CurrentMap>>,
    mut job: Local<Option<Job>>,
    mut budget: Option<ResMut<PhysicsBudget>>,
) {
    let map = map.map_or(0, |m| m.0);
    if let Some(request) = control.pending.take() {
        control.response = None;
        if request.validate().is_err() {
            *job = None;
            if let Some(budget) = budget.as_mut() {
                budget.diagnostic_active = false;
            }
            control.response = Some(Response {
                token: request.token,
                status: Status::Unsupported,
                steps: 0,
                elapsed_processing_ms: 0.,
                collider_revision: epoch.get(),
                hypotheses: vec![],
            });
            return;
        }
        *job = Some(Job::new(request, epoch.get(), map));
    }
    if let Some(budget) = budget.as_mut() {
        budget.diagnostic_active = job.is_some();
    }
    let Some(active) = job.as_mut() else {
        return;
    };
    let start = Instant::now();
    let done = if active.revision != epoch.get() || active.map != map {
        active.terminal = Some(Status::NotReady);
        true
    } else {
        let capsule = Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
        let before = active.steps;
        let done = active.advance(
            &world,
            &capsule,
            budget.as_ref().map_or(FRAME_STEPS, |b| {
                b.remaining.min(if b.canonical_active {
                    FRAME_STEPS / 2
                } else {
                    FRAME_STEPS
                })
            }),
        );
        if let Some(budget) = budget.as_mut() {
            budget.remaining = budget.remaining.saturating_sub(active.steps - before);
        }
        done
    };
    active.elapsed_ms += start.elapsed().as_secs_f64() * 1000.;
    if done {
        if let Some(budget) = budget.as_mut() {
            budget.diagnostic_active = false;
        }
        control.response = Some(job.take().unwrap().response());
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use avian3d::prelude::*;
    use bevy::ecs::system::RunSystemOnce;
    pub(crate) fn world(profile: &[(f32, f32)]) -> App {
        world_layers(&[profile])
    }
    pub(crate) fn world_layers(profiles: &[&[(f32, f32)]]) -> App {
        let mut app = App::new();
        app.init_resource::<benilla_world::collision::MoverTraceExclusions>()
            .init_resource::<ColliderEpoch>()
            .add_plugins((
                MinimalPlugins,
                bevy::transform::TransformPlugin,
                bevy::asset::AssetPlugin::default(),
                bevy::scene::ScenePlugin,
                PhysicsPlugins::new(bevy::app::PostUpdate),
            ));
        app.init_asset::<Mesh>();
        let (mut vertices, mut triangles) = (vec![], vec![]);
        for pair in profiles.iter().flat_map(|profile| profile.windows(2)) {
            let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
            let base = vertices.len() as u32;
            vertices.extend([
                Vec3::new(x0, y0, -5.),
                Vec3::new(x1, y1, -5.),
                Vec3::new(x1, y1, 5.),
                Vec3::new(x0, y0, 5.),
            ]);
            triangles.extend([[base, base + 2, base + 1], [base, base + 3, base + 2]]);
        }
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::trimesh(vertices, triangles),
            Transform::default(),
        ));
        app.update();
        app
    }
    fn observation(id: &str, time: f64, x: f32, z: Option<f32>) -> Observation {
        Observation {
            id: id.into(),
            time,
            position: (0., -x, z),
        }
    }
    fn request() -> Request {
        Request {
            token: 7,
            samples: vec![
                observation("a", 0., -1., None),
                observation("b", 500., 1., None),
                observation("c", 1000., 4., None),
                observation("d", 1500., 7., None),
            ],
            initial_heights: vec![10.],
            jump_windows: vec![],
            max_steps: MAX_STEPS,
        }
    }
    fn run(app: &mut App, request: Request, batch: usize) -> Response {
        request.validate().unwrap();
        app.world_mut()
            .run_system_once(move |world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut job = Job::new(request.clone(), 0, 0);
                loop {
                    let before = job.steps;
                    let done = job.advance(&world, &capsule, batch);
                    assert!(job.steps - before <= batch);
                    if done {
                        return job.response();
                    }
                }
            })
            .unwrap()
    }
    #[test]
    fn input_bounds_and_observed_z_provenance_are_validated() {
        let valid = request();
        assert!(valid.validate().is_ok());
        let mut r = valid.clone();
        r.samples[1].time = r.samples[0].time;
        assert!(r.validate().is_err());
        let mut r = valid.clone();
        r.samples[1].id = r.samples[0].id.clone();
        assert!(r.validate().is_err());
        let mut r = valid.clone();
        r.samples.last_mut().unwrap().time = 15001.;
        assert!(r.validate().is_err());
        let mut r = valid.clone();
        r.initial_heights = vec![0.; 4];
        assert!(r.validate().is_err());
        let mut r = valid.clone();
        r.max_steps = 5001;
        assert!(r.validate().is_err());
        let mut r = valid.clone();
        r.samples[1].position.2 = Some(f32::NAN);
        assert!(r.validate().is_err());
        let mut r = valid.clone();
        r.samples = vec![valid.samples[0].clone(); 501];
        assert!(r.validate().is_err());
        let mut r = valid;
        r.samples[0].position.2 = Some(0.);
        assert!(
            r.validate().is_ok(),
            "an observed mismatch is a diagnostic constraint, not a reseed"
        );
    }
    #[test]
    fn chronological_drop_carries_velocity_across_explicit_height_constraints() {
        let mut app = world(&[(-5., 10.), (0., 10.), (0., 0.), (20., 0.)]);
        let base = run(&mut app, request(), 200);
        let mut constrained = request();
        constrained.samples[1].position.2 = Some(0.);
        let compared = run(&mut app, constrained, 17);
        let a = &base.hypotheses[0].samples;
        let b = &compared.hypotheses[0].samples;
        assert_eq!(a.len(), 4);
        assert!(a[1].position[2] > 5. && a[1].position[2] < 10.);
        assert_eq!(a[1].support, Support::Falling);
        assert!(a[1].vertical_velocity < 0.);
        assert!(
            a[2].vertical_velocity < a[1].vertical_velocity,
            "velocity is carried through observation boundaries"
        );
        for (left, right) in a.iter().zip(b) {
            assert_eq!(left.position, right.position);
            assert_eq!(left.vertical_velocity, right.vertical_velocity);
        }
        assert!(b[1].conflicts.contains(&Conflict::ObservedHeight));
        assert_eq!(b[3].support, Support::Grounded);
        assert!(b[3].position[2].abs() < 0.1);
    }
    #[test]
    fn freefall_uses_the_shared_exact_kernel_without_floor_snapping() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        let mut r = request();
        r.samples = vec![
            observation("a", 0., 0., Some(10.)),
            observation("b", 500., 1., None),
        ];
        let response = run(&mut app, r, 31);
        let row = &response.hypotheses[0].samples[1];
        let (vy, mean) = mover::fall_step(0., 0.5, TERMINAL_VELOCITY);
        assert!((row.position[2] - (10. + mean * 0.5)).abs() < 0.001);
        assert!((row.vertical_velocity - vy).abs() < 0.001);
        assert_eq!(row.support, Support::Falling);
    }
    #[test]
    fn collision_clipped_xy_is_reported_and_never_forced_to_the_observation() {
        let mut app = world(&[(-5., 0.), (1., 0.), (1., 10.), (20., 10.)]);
        let mut r = request();
        r.initial_heights = vec![0.];
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 1000., 3., None),
        ];
        let before: Vec<_> = app
            .world_mut()
            .query_filtered::<(Entity, &Transform), With<RigidBody>>()
            .iter(app.world())
            .map(|(e, t)| (e, *t))
            .collect();
        let response = run(&mut app, r, 200);
        let row = &response.hypotheses[0].samples[1];
        assert!(row.xy_residual > 1.);
        assert!(row.conflicts.contains(&Conflict::HorizontalClipped));
        assert!(row.position[1] > -1.);
        assert_eq!(response.status, Status::Conflicted);
        assert!(row.steering_clamped);
        assert!(row.max_requested_steering_speed > 20.);
        assert!(row.max_applied_planar_speed <= 20.0001);
        let after: Vec<_> = app
            .world_mut()
            .query_filtered::<(Entity, &Transform), With<RigidBody>>()
            .iter(app.world())
            .map(|(e, t)| (e, *t))
            .collect();
        assert_eq!(before, after, "the diagnostic must not move scene bodies");
    }
    #[test]
    fn controlled_step_bias_recovers_through_the_mover_without_position_snaps() {
        let mut profile = vec![(-5., 0.), (0., 0.)];
        for step in 0..20 {
            let x = step as f32;
            let y = (step + 1) as f32 * 0.28;
            profile.push((x + 0.16, y));
            profile.push((x + 1., y));
        }
        profile.push((30., 5.6));
        let mut app = world(&profile);
        let baseline = app
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                let capsule =
                    Collider::capsule(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2. * CAPSULE_RADIUS);
                let mut state = State {
                    center: Vec3::new(-1., CAPSULE_HEIGHT * 0.5, 0.),
                    vy: 0.,
                    support: Support::Grounded,
                    max_residual: 0.,
                    max_requested_steering_speed: 0.,
                    max_applied_planar_speed: 0.,
                    steering_clamped: false,
                };
                for _ in 0..150 {
                    assert!(physics_step(
                        &mut state,
                        &world,
                        &capsule,
                        Vec3::X * 16.,
                        Duration::from_millis(10)
                    ));
                }
                state.center.x
            })
            .unwrap();
        let mut r = request();
        r.initial_heights = vec![0.];
        r.samples = vec![
            observation("a", 0., -1., None),
            observation("b", 1500., 23., None),
        ];
        let controlled = run(&mut app, r, 37);
        let row = &controlled.hypotheses[0].samples[1];
        eprintln!(
            "open-loop step bias={}, controlled residual={}, requested={}, applied={}",
            23. - baseline,
            row.xy_residual,
            row.max_requested_steering_speed,
            row.max_applied_planar_speed
        );
        assert!(
            (23. - baseline).abs() > 0.05,
            "fixture must demonstrate a measurable real-mover bias"
        );
        assert!(row.xy_residual < 0.01);
        assert!(row.max_applied_planar_speed <= 20.0001);
        assert!(row.max_requested_steering_speed > 16.);
        assert!(!row.conflicts.contains(&Conflict::HorizontalClipped));
    }
    #[test]
    fn steering_speed_is_capped_without_reclassifying_valid_raw_intervals_as_teleports() {
        let mut app = world(&[(-5., 0.), (50., 0.)]);
        let mut r = request();
        r.initial_heights = vec![0.];
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 1000., 25., None),
        ];
        let response = run(&mut app, r, 23);
        let row = &response.hypotheses[0].samples[1];
        assert_eq!(response.status, Status::Conflicted);
        assert!(row.steering_clamped);
        assert!(row.max_requested_steering_speed > 20.);
        assert!(row.max_applied_planar_speed <= 20.0001);
        assert!(row.xy_residual > 4.9);
        assert!(
            row.position[1] >= -20.01,
            "steering cannot teleport to the 25-yard observation"
        );
        assert!(!response.hypotheses[0]
            .conflicts
            .contains(&Conflict::HorizontalDiscontinuity));
    }

    #[test]
    fn inferred_jump_window_input_is_optional_ordered_and_bounded() {
        let mut r = request();
        assert!(r.jump_windows.is_empty());
        r.jump_windows = vec![[0., 0.], [100., 200.], [500., 1000.]];
        assert!(r.validate().is_ok());
        for windows in [
            vec![[0., 501.]],
            vec![[-1., 0.]],
            vec![[1000., 1501.]],
            vec![[20., 10.]],
            vec![[0., 100.], [100., 200.]],
            vec![[200., 300.], [0., 100.]],
            vec![[0., 1.]; 4],
            vec![[f64::NAN, 100.]],
        ] {
            r.jump_windows = windows;
            assert!(r.validate().is_err());
        }
        let parsed:Request=serde_json::from_str(r#"{"token":1,"initial_heights":[0],"samples":[{"id":"a","time":0,"position":[0,0,null]},{"id":"b","time":100,"position":[0,-1,null]}]}"#).unwrap();
        assert!(parsed.jump_windows.is_empty());
        assert!(parsed.validate().is_ok());
    }
    #[test]
    fn a_grounded_jump_window_launches_once_at_its_boundary_and_carries_the_native_arc() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        let mut r = request();
        r.initial_heights = vec![0.];
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 200., 1., None),
            observation("c", 400., 2., None),
            observation("d", 1000., 5., None),
        ];
        r.jump_windows = vec![[100.25, 100.25]];
        let response = run(&mut app, r, 200);
        let h = &response.hypotheses[0];
        assert_eq!(h.inferred_launch_times, vec![100.25]);
        assert!(h.unresolved_jump_windows.is_empty());
        assert_eq!(h.samples[0].support, Support::Grounded);
        assert_eq!(h.samples[0].vertical_velocity, 0.);
        let expected = mover::fall_step(JUMP_SPEED, 0.09975, TERMINAL_VELOCITY).0;
        assert!((h.samples[1].vertical_velocity - expected).abs() < 0.001);
        assert!(h.samples[1].position[2] > 0.5);
        assert_eq!(h.samples[1].support, Support::Falling);
        assert!(h.samples[2].vertical_velocity < h.samples[1].vertical_velocity);
        assert_eq!(h.samples[3].support, Support::Grounded);
        assert!(h.samples.iter().all(|s| s.xy_residual < 0.01));
    }
    #[test]
    fn windows_without_ground_support_report_conflicts_without_airborne_impulses() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        let mut r = request();
        r.initial_heights = vec![0.];
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 200., 1., None),
            observation("c", 400., 2., None),
            observation("d", 1000., 5., None),
        ];
        r.jump_windows = vec![[0., 0.], [100., 200.], [300., 400.]];
        let response = run(&mut app, r, 11);
        let h = &response.hypotheses[0];
        assert_eq!(h.inferred_launch_times, vec![0.]);
        assert_eq!(h.unresolved_jump_windows, vec![1, 2]);
        assert!(h.conflicts.contains(&Conflict::NoGroundedJumpSupport));
        assert!(!h.samples[0]
            .conflicts
            .contains(&Conflict::InitialVelocityUnknown));
        assert!(
            (h.samples[1].vertical_velocity
                - mover::fall_step(JUMP_SPEED, 0.2, TERMINAL_VELOCITY).0)
                .abs()
                < 0.001
        );
        assert!(
            (h.samples[2].vertical_velocity
                - mover::fall_step(JUMP_SPEED, 0.4, TERMINAL_VELOCITY).0)
                .abs()
                < 0.001
        );
        assert_eq!(response.status, Status::Conflicted);
    }
    #[test]
    fn a_jump_window_can_wait_for_real_landing_support_without_resetting_velocity() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        let mut r = request();
        r.initial_heights = vec![1.];
        r.jump_windows = vec![[100., 500.]];
        let response = run(&mut app, r, 13);
        let h = &response.hypotheses[0];
        assert_eq!(h.inferred_launch_times.len(), 1);
        assert!(h.inferred_launch_times[0] > 100. && h.inferred_launch_times[0] <= 500.);
        assert!(h.unresolved_jump_windows.is_empty());
    }
    #[test]
    fn inferred_jump_times_and_samples_are_independent_of_batch_and_hypothesis_order() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        let mut r = request();
        r.initial_heights = vec![0., 1.];
        r.jump_windows = vec![[100., 500.]];
        let first = run(&mut app, r.clone(), 200);
        let second = run(&mut app, r.clone(), 1);
        for (a, b) in first.hypotheses.iter().zip(&second.hypotheses) {
            assert_eq!(a.samples, b.samples);
            assert_eq!(a.inferred_launch_times, b.inferred_launch_times);
            assert_eq!(a.unresolved_jump_windows, b.unresolved_jump_windows);
        }
        r.initial_heights.reverse();
        let reversed = run(&mut app, r, 17);
        assert_eq!(first.hypotheses[0].samples, reversed.hypotheses[1].samples);
        assert_eq!(first.hypotheses[1].samples, reversed.hypotheses[0].samples);
    }
    #[test]
    fn a_physical_jump_may_deviate_from_the_guidance_chord_and_still_fit_observations() {
        let mut profile = vec![(-5., 0.), (0., 0.)];
        for step in 0..20 {
            let x = step as f32;
            let y = (step + 1) as f32 * 0.28;
            profile.push((x + 0.16, y));
            profile.push((x + 1., y));
        }
        profile.push((40., 5.6));
        let mut app = world(&profile);
        let mut r = request();
        r.initial_heights = vec![0.];
        r.samples = vec![
            observation("a", 0., -1., None),
            observation("b", 2000., 27., None),
        ];
        r.jump_windows = vec![[700., 750.]];
        let response = run(&mut app, r, 37);
        let h = &response.hypotheses[0];
        let end = &h.samples[1];
        eprintln!(
            "physical endpoint={} maxChordDeviation={} jumps={:?} status={:?}",
            end.xy_residual, end.max_xy_residual, h.inferred_launch_times, response.status
        );
        assert_eq!(h.inferred_launch_times.len(), 1);
        assert!(
            end.max_xy_residual > 0.05,
            "fixture must demonstrate a between-observation physical deviation"
        );
        assert!(h.samples.iter().all(|s| s.xy_residual <= 0.05));
        assert_eq!(response.status, Status::Complete);
        assert!(!h.conflicts.contains(&Conflict::HorizontalClipped));
        assert!(end.max_applied_planar_speed <= 20.0001);
    }
    #[test]
    fn repeated_reads_and_batch_order_preserve_identical_canonical_samples() {
        let mut app = world(&[(-5., 10.), (0., 10.), (0., 0.), (20., 0.)]);
        let mut r = request();
        r.initial_heights = vec![10., 0.];
        let first = run(&mut app, r.clone(), 200);
        let second = run(&mut app, r.clone(), 7);
        for (a, b) in first.hypotheses.iter().zip(&second.hypotheses) {
            assert_eq!(a.samples, b.samples);
            assert_eq!(a.steps, b.steps);
        }
        r.initial_heights.reverse();
        let reversed = run(&mut app, r, 31);
        assert_eq!(first.hypotheses[0].samples, reversed.hypotheses[1].samples);
        assert_eq!(first.hypotheses[1].samples, reversed.hypotheses[0].samples);
    }
    #[test]
    fn total_budget_and_unsupported_sparse_inputs_remain_explicit() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        let mut r = request();
        r.max_steps = 3;
        let response = run(&mut app, r, 200);
        assert_eq!(response.steps, 3);
        assert_eq!(response.status, Status::BudgetExceeded);
        let mut r = request();
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 2100., 1., None),
        ];
        let response = run(&mut app, r, 200);
        assert_eq!(response.status, Status::Unsupported);
        assert_eq!(response.steps, 0);
        assert_eq!(
            response.hypotheses[0].conflicts,
            vec![Conflict::InitialVelocityUnknown, Conflict::SparseInterval]
        );
        let mut r = request();
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 1000., 100., None),
        ];
        let response = run(&mut app, r, 200);
        assert_eq!(response.status, Status::Unsupported);
        assert_eq!(response.steps, 0);
        assert!(response.hypotheses[0]
            .conflicts
            .contains(&Conflict::HorizontalDiscontinuity));
    }
    #[test]
    fn latest_request_cancels_local_work_and_geometry_changes_abort_it() {
        let mut app = world(&[(-5., 0.), (20., 0.)]);
        install(&mut app);
        let mut system = IntoSystem::into_system(drive);
        system.initialize(app.world_mut());
        let mut r = request();
        r.samples = vec![
            observation("a", 0., 0., None),
            observation("b", 1900., 2., None),
        ];
        r.initial_heights = vec![0.; 3];
        app.world_mut().resource_mut::<Control>().pending = Some(r.clone());
        app.world_mut().resource_mut::<PhysicsBudget>().remaining = FRAME_STEPS;
        system.run((), app.world_mut()).unwrap();
        assert!(app.world().resource::<Control>().response.is_none());
        r.token = 99;
        r.initial_heights = vec![0.];
        r.samples[1].time = 100.;
        r.samples[1].position.1 = -1.;
        app.world_mut().resource_mut::<Control>().pending = Some(r);
        app.world_mut().resource_mut::<PhysicsBudget>().remaining = FRAME_STEPS;
        system.run((), app.world_mut()).unwrap();
        assert_eq!(
            app.world_mut()
                .resource_mut::<Control>()
                .response
                .take()
                .unwrap()
                .token,
            99
        );
        let mut r = request();
        r.initial_heights = vec![10.; 3];
        app.world_mut().resource_mut::<Control>().pending = Some(r);
        app.world_mut().resource_mut::<PhysicsBudget>().remaining = FRAME_STEPS;
        system.run((), app.world_mut()).unwrap();
        app.world_mut().resource_mut::<ColliderEpoch>().bump();
        app.world_mut().resource_mut::<PhysicsBudget>().remaining = FRAME_STEPS;
        system.run((), app.world_mut()).unwrap();
        assert_eq!(
            app.world_mut()
                .resource_mut::<Control>()
                .response
                .take()
                .unwrap()
                .status,
            Status::NotReady
        );
    }
}
