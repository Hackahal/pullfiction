//! Offline log actors and combat edges, reusing the game's model, equipment and spell pipelines.
#[path = "planner_replay_transport.rs"]
pub mod transport;

use crate::{
    creature_anim::{
        CastEvent, CastEventKind, Casting, MovementState, PlaySeq, SpellGoTargets, SwingMessage,
    },
    names::{CreatureRecord, NameCache},
    net,
};
use benilla_assets::coords::wow_to_bevy;
use benilla_protocol::{messages::ObjectType, EntityKind, ObjectFields};
use benilla_world::{collision::WorldCollision, schedule::WorldStage, view::WorldCamera};
use bevy::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};

#[path = "planner_replay_readiness.rs"]
mod readiness;

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ReplayTrajectoryReference {
    pub source: String,
    pub component: String,
    pub content: String,
    pub at: Option<f64>,
    #[serde(default)]
    pub hold: bool,
}
#[derive(Clone, serde::Deserialize)]
pub struct ReplayTrajectoryBridge {
    pub from: ReplayTrajectoryReference,
    pub to: ReplayTrajectoryReference,
}
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ReplayTrajectoryMissing {
    pub source: String,
    pub actor: String,
    pub component: String,
    pub content: String,
}
#[derive(Clone, Copy, Default, PartialEq, serde::Serialize)]
pub struct ReplayTrajectoryStatus {
    pub ready: usize,
    pub pending: usize,
    pub conflict: usize,
}
#[derive(Clone)]
struct CanonicalDiagnostic {
    reference: ReplayTrajectoryReference,
    status: &'static str,
    reason: Option<&'static str>,
    pose: Option<crate::planner_trajectory::Pose>,
    bridge: bool,
}
#[derive(Default)]
pub(crate) struct CanonicalPresentation {
    revision: u64,
    validation_epoch: u64,
    holds: HashMap<(String, String, String, String), crate::planner_trajectory::Pose>,
    diagnostics: HashMap<String, CanonicalDiagnostic>,
}
impl CanonicalPresentation {
    fn synchronize_world(&mut self, epoch: u64) -> bool {
        if self.validation_epoch == epoch {
            return false;
        }
        self.validation_epoch = epoch;
        self.holds.clear();
        self.diagnostics.clear();
        true
    }
    fn resolve(
        &mut self,
        plans: &crate::planner_trajectory::CanonicalTrajectories,
        reference: &ReplayTrajectoryReference,
        actor: &str,
        time: f64,
        status: &mut ReplayTrajectoryStatus,
        missing: &mut Vec<ReplayTrajectoryMissing>,
    ) -> (Option<crate::planner_trajectory::Pose>, bool) {
        use crate::planner_trajectory::Query;
        let at = reference.at.unwrap_or(time);
        let result = plans.query(
            &reference.source,
            actor,
            &reference.component,
            &reference.content,
            at,
        );
        let (ready, label, reason) = match &result {
            Query::Ready(_) => {
                status.ready += 1;
                (true, "ready", None)
            }
            Query::Conflict(reason) => {
                status.conflict += 1;
                (false, "conflict", Some(*reason))
            }
            Query::MissingCoverage => {
                status.pending += 1;
                (false, "missingCoverage", None)
            }
            Query::NotReady => {
                status.pending += 1;
                (false, "notReady", None)
            }
            Query::Pending => {
                status.pending += 1;
                (false, "pending", None)
            }
            Query::Missing => {
                status.pending += 1;
                if reference.content != "geometry-pending" {
                    missing.push(ReplayTrajectoryMissing {
                        source: reference.source.clone(),
                        actor: actor.into(),
                        component: reference.component.clone(),
                        content: reference.content.clone(),
                    });
                }
                (false, "missing", None)
            }
        };
        let key = (
            actor.to_owned(),
            reference.source.clone(),
            reference.component.clone(),
            reference.content.clone(),
        );
        let mut pose = match result {
            Query::Ready(pose) => {
                self.holds.insert(key.clone(), pose.clone());
                Some(pose)
            }
            Query::Conflict(_) => plans.hold(
                &reference.source,
                actor,
                &reference.component,
                &reference.content,
                at,
            ),
            _ => self.holds.get(&key).cloned(),
        };
        if !ready {
            if let Some(pose) = &mut pose {
                pose.planar_speed = 0.;
            }
        }
        self.diagnostics.insert(
            actor.into(),
            CanonicalDiagnostic {
                reference: reference.clone(),
                status: label,
                reason,
                pose: pose.clone(),
                bridge: false,
            },
        );
        (pose, ready)
    }
}

#[derive(Debug, PartialEq)]
struct CanonicalMotion {
    position: [f32; 3],
    facing: f32,
    speed: f32,
    vertical_speed: f32,
    airborne: bool,
    falling_far: bool,
}
fn present_canonical_motion(
    pose: &crate::planner_trajectory::Pose,
    observed_facing: f32,
    playing: bool,
    hold: bool,
    ready: bool,
) -> CanonicalMotion {
    let hold = hold || !ready;
    CanonicalMotion {
        position: pose.position,
        facing: if !hold && pose.planar_speed > 0.03 {
            pose.heading
        } else {
            observed_facing
        },
        speed: if playing && !hold {
            pose.planar_speed
        } else {
            0.
        },
        vertical_speed: if hold { 0. } else { pose.vertical_velocity },
        airborne: !hold && pose.support == crate::planner_trajectory_probe::Support::Falling,
        falling_far: !hold && pose.falling_far(),
    }
}

#[cfg(test)]
mod canonical_presentation_tests {
    use super::*;
    fn pose() -> crate::planner_trajectory::Pose {
        let mut plans = crate::planner_trajectory::CanonicalTrajectories::default();
        plans.retain_source("s");
        plans
            .submit(crate::planner_trajectory::NativeComponentInput {
                source: "s".into(),
                actor: "p".into(),
                component: "c".into(),
                content: "v".into(),
                map: 1,
                samples: vec![(0., 1., 2., Some(3.))],
                initial_heights: vec![],
                coverage_complete: true,
                profiles: vec![],
                slow_fall: vec![],
                transfers: vec![],
                hover_launches: vec![],
                unresolved_transfers: vec![],
            })
            .unwrap();
        let mut pose = plans.hold("s", "p", "c", "v", 0.).unwrap();
        pose.heading = 0.;
        pose.planar_speed = 7.;
        pose
    }
    #[test]
    fn endpoint_holds_keep_canonical_xyz_but_stop_motion_and_use_stationary_facing() {
        let pose = pose();
        let held = present_canonical_motion(&pose, 1.57, true, true, true);
        assert_eq!(held.position, [1., 2., 3.]);
        assert_eq!(held.facing, 1.57);
        assert_eq!(held.speed, 0.);
        assert_eq!(held.vertical_speed, 0.);
        assert!(!held.airborne);
        let active = present_canonical_motion(&pose, 1.57, true, false, true);
        assert_eq!(active.speed, 7.);
        assert_eq!(active.facing, 0.);
    }
    #[test]
    fn historical_airborne_endpoint_does_not_animate_a_fall_during_a_hold() {
        let mut pose = pose();
        pose.support = crate::planner_trajectory_probe::Support::Falling;
        pose.vertical_velocity = -10.;
        pose.airborne_seconds = 2.;
        pose.fall_distance = 5.;
        let active = present_canonical_motion(&pose, 1.57, true, false, true);
        assert!(active.airborne && active.falling_far);
        let held = present_canonical_motion(&pose, 1.57, true, true, true);
        assert_eq!(held.position, pose.position);
        assert_eq!(held.vertical_speed, 0.);
        assert!(!held.airborne && !held.falling_far);
    }
    #[test]
    fn pending_cached_airborne_pose_is_held_while_ready_flight_keeps_its_motion() {
        use avian3d::prelude::{Collider, PhysicsPlugins, RigidBody};
        let mut app = App::new();
        app.init_resource::<benilla_world::collision::MoverTraceExclusions>()
            .init_resource::<benilla_world::collision::ColliderEpoch>()
            .add_plugins((
                MinimalPlugins,
                bevy::transform::TransformPlugin,
                bevy::asset::AssetPlugin::default(),
                bevy::scene::ScenePlugin,
                PhysicsPlugins::new(bevy::app::PostUpdate),
            ));
        app.init_asset::<Mesh>();
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(200., 1., 20.),
            Transform::from_xyz(0., -0.5, 0.),
        ));
        app.update();
        crate::planner_trajectory::install(&mut app);
        app.world_mut()
            .insert_resource(benilla_world::world_map::CurrentMap(1));
        let input = crate::planner_trajectory::NativeComponentInput {
            source: "s".into(),
            actor: "p".into(),
            component: "c".into(),
            content: "v".into(),
            map: 1,
            samples: (0..31)
                .map(|t| (t as f64 * 1000., t as f32 * 0.1, 0., Some(0.)))
                .collect(),
            initial_heights: vec![],
            coverage_complete: true,
            profiles: vec![],
            slow_fall: vec![],
            transfers: vec![],
            hover_launches: vec![],
            unresolved_transfers: vec![],
        };
        app.world_mut()
            .resource_mut::<crate::planner_trajectory::CanonicalTrajectories>()
            .submit(input)
            .unwrap();
        app.world()
            .resource::<crate::planner_trajectory::CanonicalTrajectories>()
            .query("s", "p", "c", "v", 5000.);
        // The static collision fixture is already synchronized; run the real
        // planner without advancing an unrelated physics simulation schedule.
        app.world_mut().run_schedule(Update);
        let plans = app
            .world()
            .resource::<crate::planner_trajectory::CanonicalTrajectories>();
        assert_eq!(
            plans.query("s", "p", "c", "v", 5000.),
            crate::planner_trajectory::Query::Pending
        );
        let mut flight = pose();
        flight.support = crate::planner_trajectory_probe::Support::Falling;
        flight.vertical_velocity = -10.;
        flight.airborne_seconds = 2.;
        flight.fall_distance = 5.;
        let mut presentation = CanonicalPresentation::default();
        presentation.synchronize_world(plans.validation_epoch());
        presentation.holds.insert(
            ("p".into(), "s".into(), "c".into(), "v".into()),
            flight.clone(),
        );
        let reference = ReplayTrajectoryReference {
            source: "s".into(),
            component: "c".into(),
            content: "v".into(),
            at: None,
            hold: false,
        };
        let (fallback, ready) = presentation.resolve(
            plans,
            &reference,
            "p",
            5000.,
            &mut Default::default(),
            &mut vec![],
        );
        assert!(!ready);
        let held = present_canonical_motion(&fallback.unwrap(), 1.57, true, reference.hold, ready);
        assert_eq!(held.position, flight.position);
        assert_eq!(held.speed, 0.);
        assert_eq!(held.vertical_speed, 0.);
        assert!(!held.airborne && !held.falling_far);
        let active = present_canonical_motion(&flight, 1.57, true, false, true);
        assert_eq!(active.position, flight.position);
        assert_eq!(active.vertical_speed, -10.);
        assert_eq!(active.speed, 7.);
        assert!(active.airborne && active.falling_far);
    }
    #[test]
    fn changed_validation_world_discards_presentation_fallback_before_a_pending_query() {
        let mut presentation = CanonicalPresentation::default();
        assert!(presentation.synchronize_world(1));
        presentation
            .holds
            .insert(("p".into(), "s".into(), "c".into(), "v".into()), pose());
        assert!(!presentation.synchronize_world(1));
        assert_eq!(presentation.holds.len(), 1);
        assert!(presentation.synchronize_world(2));
        let plans = crate::planner_trajectory::CanonicalTrajectories::default();
        let reference = ReplayTrajectoryReference {
            source: "s".into(),
            component: "c".into(),
            content: "v".into(),
            at: None,
            hold: false,
        };
        let (pose, ready) = presentation.resolve(
            &plans,
            &reference,
            "p",
            0.,
            &mut Default::default(),
            &mut vec![],
        );
        assert!(pose.is_none() && !ready);
        assert!(presentation.holds.is_empty());
    }
}

#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReplayApply;

#[derive(Clone, serde::Deserialize)]
pub struct ReplayGear {
    pub id: u32,
    pub slot: u16,
    pub display: u32,
    pub class: u32,
    pub subclass: u32,
    pub inventory: u32,
    pub material: i32,
    pub sheath: u32,
    pub name: String,
    pub quality: u32,
    #[serde(default)]
    pub enchant: u32,
    #[serde(default)]
    pub temporary: u32,
}
#[derive(Clone, serde::Deserialize)]
pub struct ReplayCast {
    pub name: String,
    pub icon: String,
    pub progress: f32,
    pub remaining: f32,
}
#[derive(Clone, serde::Deserialize)]
pub struct ReplayAura {
    #[serde(default)]
    pub name: String,
    pub spell: u32,
    pub icon: String,
    pub stack: u32,
    pub debuff: bool,
}
fn nameplate_default() -> bool {
    true
}

#[derive(Clone, serde::Deserialize)]
pub struct ReplayUnit {
    pub key: String,
    pub name: String,
    pub player: bool,
    pub class: u32,
    pub entry: u32,
    pub display: Option<u32>,
    pub scale: f32,
    pub position: Option<[f32; 3]>,
    pub ground: bool,
    #[serde(default)]
    pub floor_hint: Option<f32>,
    pub facing: f32,
    pub speed: f32,
    #[serde(
        default,
        deserialize_with = "crate::planner_movement::deserialize_optional"
    )]
    pub movement: Option<crate::planner_movement::Segment>,
    #[serde(default)]
    pub trajectory: Option<ReplayTrajectoryReference>,
    #[serde(default)]
    pub trajectory_prepare: Option<ReplayTrajectoryReference>,
    #[serde(default)]
    pub trajectory_bridge: Option<ReplayTrajectoryBridge>,
    pub dead: bool,
    #[serde(default)]
    pub friendly: bool,
    /// Per-actor plate category filter; omitted values preserve older clients.
    #[serde(default = "nameplate_default")]
    pub nameplate: bool,
    #[serde(default)]
    pub raid: bool,
    #[serde(default)]
    pub estimated: bool,
    #[serde(default)]
    pub wisp: bool,
    #[serde(default)]
    pub race: Option<u8>,
    #[serde(default)]
    pub sex: Option<u8>,
    #[serde(default)]
    pub look: [u8; 5],
    #[serde(default)]
    pub gear: Vec<ReplayGear>,
    #[serde(default)]
    pub health: Option<u32>,
    #[serde(default)]
    pub max_health: Option<u32>,
    #[serde(default)]
    pub power: Option<u32>,
    #[serde(default)]
    pub max_power: Option<u32>,
    #[serde(default)]
    pub power_type: u8,
    #[serde(default)]
    pub plate_cast: Option<ReplayCast>,
    #[serde(default)]
    pub plate_auras: Vec<ReplayAura>,
    #[serde(default)]
    pub channel: bool,
    #[serde(default)]
    pub channel_target: Option<String>,
    #[serde(default)]
    pub cast: u32,
    #[serde(default)]
    pub auras: Vec<u32>,
}
#[derive(Clone, serde::Deserialize)]
pub struct ReplayImpact {
    pub target: String,
    pub t: f64,
}
use crate::planner_timing::ReplayFlight;
#[derive(Clone, serde::Deserialize)]
pub struct ReplayEvent {
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub impacts: Vec<ReplayImpact>,
    pub kind: String,
    pub source: Option<String>,
    pub target: Option<String>,
    pub spell: u32,
    #[serde(default)]
    pub amount: u32,
    #[serde(default)]
    pub melee: bool,
}
#[derive(Clone, serde::Deserialize)]
pub struct ReplayPortrait {
    pub key: String,
    pub display: u32,
}
#[derive(serde::Serialize)]
pub struct ReplayKitDiagnostic {
    pub kit: u32,
    pub animation: Option<u16>,
    pub models: usize,
}
#[derive(serde::Serialize)]
pub struct ReplaySpellDiagnostic {
    pub spell: u32,
    pub catalogued: bool,
    pub visual: Option<u32>,
    pub resolved: bool,
    pub kits: Vec<ReplayKitDiagnostic>,
    pub projectiles: usize,
}
#[derive(Default, Resource)]
pub struct ReplayControl {
    pub movement_diagnostics_request: Option<u32>,
    pub playback_preparation_request: Option<u32>,
    pub movement_diagnostics_response: Option<(u32, Vec<serde_json::Value>)>,
    pub trajectory_status: ReplayTrajectoryStatus,
    pub trajectory_missing: Vec<ReplayTrajectoryMissing>,
    pub portrait_requests: Vec<ReplayPortrait>,
    pub pending: Option<Vec<ReplayUnit>>,
    pub focus: Option<[f32; 3]>,
    pub camera_keys: Vec<String>,
    pub camera_max_distance: f32,
    pub camera_locked_player: String,
    pub nameplates: Option<bool>,
    pub friendly_nameplates: Option<bool>,
    pub enemy_nameplates: Option<bool>,
    pub raid_frames: bool,
    pub raid_frame_size: [f32; 2],
    pub select: Option<String>,
    pub selected_key: Option<String>,
    pub focus_actor: Option<String>,
    pub time: f64,
    pub rate: f64,
    pub playing: bool,
    pub(crate) generation: u64,
    pub(crate) entities: HashSet<Entity>,
    flights: HashMap<(Entity, u32, Entity), VecDeque<f64>>,
    pub events: Vec<ReplayEvent>,
    pub(crate) pending_cues: Vec<crate::planner_cues::CastCue>,
    pub reset: bool,
    pub visual_events: u64,
    pub unsupported: HashSet<u32>,
    pub visual_diagnostics: HashMap<u32, ReplaySpellDiagnostic>,
}
impl ReplayControl {
    pub(crate) fn has_impact(&self, caster: Entity, spell: u32, target: Entity) -> bool {
        self.flights
            .get(&(caster, spell, target))
            .is_some_and(|v| !v.is_empty())
    }
    pub(crate) fn flight(
        &mut self,
        caster: Entity,
        spell: u32,
        target: Option<Entity>,
        fallback: f64,
    ) -> Option<ReplayFlight> {
        if !self.entities.contains(&caster) {
            return None;
        }
        let recorded = target
            .and_then(|target| self.flights.get_mut(&(caster, spell, target)))
            .and_then(|v| v.pop_front());
        Some(ReplayFlight {
            at: recorded.unwrap_or(self.time + fallback.max(0.0)),
            generation: self.generation,
            recorded: recorded.is_some(),
        })
    }
}
#[derive(Component)]
pub struct ReplayBody {
    pub key: String,
    identity: crate::planner_replay_identity::ActorIdentity,
    pub label_height: f32,
    pub(crate) health_known: bool,
    pub(crate) power_known: bool,
    pub(crate) friendly: bool,
    pub(crate) nameplate: bool,
    pub(crate) raid: bool,
    pub(crate) estimated: bool,
    pub(crate) plate_cast: Option<ReplayCast>,
    pub(crate) plate_auras: Vec<ReplayAura>,
    cast: u32,
}

pub fn install(app: &mut App) {
    #[cfg(feature = "renderer-lab")]
    crate::renderer_actor_diagnostics::install(app);
    app.init_resource::<ReplayControl>();
    crate::planner_trajectory_probe::install(app);
    crate::planner_trajectory::install(app);
    crate::planner_camera::install(app);
    crate::planner_nameplates::install(app);
    crate::planner_raid::install(app);
    app.add_systems(
        Update,
        apply
            .in_set(WorldStage::Input)
            .in_set(ReplayApply)
            .after(crate::planner_trajectory::TrajectoryDrive),
    );
    app.add_systems(
        Update,
        crate::planner_cues::update
            .after(apply)
            .in_set(WorldStage::Input),
    );
    app.add_systems(
        Update,
        stock_nameplates
            .after(crate::ui_script::UiFeed)
            .run_if(crate::ui_script::ingame_ui_up),
    );
}

#[allow(clippy::type_complexity)]
pub(crate) fn apply(
    mut commands: Commands,
    mut control: ResMut<ReplayControl>,
    mut names: ResMut<NameCache>,
    mut index: ResMut<net::GuidIndex>,
    mut serial: Local<u64>,
    (mut ground_cache, mut routes, plans, mut canonical): (
        Local<HashMap<String, crate::planner_grounding::GroundMemo>>,
        Local<crate::planner_movement::Routes>,
        Res<crate::planner_trajectory::CanonicalTrajectories>,
        Local<CanonicalPresentation>,
    ),
    collider_epoch: Res<benilla_world::collision::ColliderEpoch>,
    mut units: Local<HashMap<String, (Entity, u64)>>,
    mut query: Query<
        (
            &mut Transform,
            &mut Visibility,
            &mut MovementState,
            &mut net::ObjectStore,
            &mut ReplayBody,
        ),
        (With<ReplayBody>, Without<WorldCamera>),
    >,
    mut cameras: Query<
        (&mut Transform, &mut crate::player::camera::FlyCam),
        (With<WorldCamera>, Without<ReplayBody>),
    >,
    mut floor_context: (
        Res<Assets<benilla_assets::WmoModel>>,
        Query<&benilla_world::wmo_portal::WmoPortalInstance>,
        Res<crate::planner_sandbox::SandboxControl>,
        WorldCollision,
        Res<benilla_world::world_map::CurrentMap>,
        MessageReader<AssetEvent<benilla_assets::WmoModel>>,
        Local<
            readiness::NativeReadiness<(
                bevy::asset::AssetId<benilla_assets::WmoModel>,
                bevy::math::Affine3A,
            )>,
        >,
        Local<readiness::RetainedFrame<Vec<ReplayUnit>>>,
    ),
    mut items: ResMut<crate::items::Items>,
    chars: Option<Res<crate::entities::CharCreate>>,
    (spells, visuals): (
        Option<Res<crate::ui_action::Spells>>,
        Option<Res<crate::creature_anim::spell_visual::SpellVisuals>>,
    ),
    mut seq: ResMut<PlaySeq>,
    (mut changes, mut casts, mut targets, mut swings): (
        MessageWriter<net::FieldChanged>,
        MessageWriter<CastEvent>,
        MessageWriter<SpellGoTargets>,
        MessageWriter<SwingMessage>,
    ),
) {
    let world = &floor_context.3;
    if let Some(at) = control.focus.take() {
        let mut target = wow_to_bevy(at);
        let mut floors =
            crate::planner_floor_geometry::floors_at(target, &floor_context.0, &floor_context.1);
        let origin = Vec3::new(target.x, target.y + 4., target.z);
        if let Some(hit) = world.ray_body(origin, Dir3::NEG_Y, 80.) {
            floors.push(crate::planner_grounding::FloorCandidate {
                height: origin.y - hit.distance,
                interior: false,
            });
        }
        if let Some(height) = crate::planner_grounding::choose_floor(&floors, target.y, None) {
            target.y = height + 2.;
        }
        if let Ok((mut xf, mut fly)) = cameras.single_mut() {
            let offset = Vec3::new(0., 16., 26.);
            let eye = crate::planner_editor_camera::clear_camera_motion(
                target,
                target + offset,
                |from, delta| world.cast_camera(from, delta, false),
            );
            xf.translation = eye;
            if eye.distance_squared(target) > 0.0001 {
                xf.look_at(target, Vec3::Y);
            }
            let (yaw, pitch, _) = xf.rotation.to_euler(EulerRot::YXZ);
            fly.park(yaw, pitch);
        }
    }
    let reset = std::mem::take(&mut control.reset);
    if reset {
        ground_cache.clear();
        routes.clear();
        control.generation += 1;
        control.flights.clear();
        for (entity, _) in units.values() {
            if let Ok((_, _, _, _, mut body)) = query.get_mut(*entity) {
                if body.cast != 0 {
                    casts.write(CastEvent {
                        entity: *entity,
                        spell_id: body.cast,
                        kind: CastEventKind::Fail,
                        cast_flags: 0,
                        item_cast: false,
                        seq: seq.next(),
                    });
                }
                body.cast = 0;
                commands.entity(*entity).remove::<Casting>();
            }
        }
    }
    let source = ((floor_context.4).0, control.generation);
    if floor_context.7.synchronize(source, reset) {
        ground_cache.clear();
        routes.clear();
    }
    let assets_changed = floor_context.5.read().fold(false, |changed, event| {
        changed
            | matches!(
                event,
                AssetEvent::Added { .. }
                    | AssetEvent::Modified { .. }
                    | AssetEvent::Removed { .. }
                    | AssetEvent::LoadedWithDependencies { .. }
            )
    });
    // Portal/PVS state mutates every frame. Only a WMO's handle and placement affect its floors.
    let readiness_revision = floor_context.6.observe(
        collider_epoch.get(),
        floor_context
            .1
            .iter()
            .map(|instance| (instance.handle.id(), instance.world_from_local)),
        floor_context.2.location.map(|(point, _)| point[2]),
        chars.is_some(),
        assets_changed || chars.as_ref().is_some_and(|catalog| catalog.is_changed()),
    );
    if let Some(batch) = control.pending.take() {
        floor_context.7.replace(batch);
    }
    // A paused frame may need several bounded batches to route every actor.
    if routes.deferred() {
        floor_context.7.retry_after_spawn();
    }
    let validation_changed = canonical.synchronize_world(plans.validation_epoch());
    if validation_changed || canonical.revision != plans.revision() {
        canonical.revision = plans.revision();
        floor_context.7.retry_after_spawn();
    }
    // Retain the owned input, not a cloned actor graph. Native assets may finish after JS settles.
    if let Some(batch) = floor_context.7.ready(readiness_revision, control.playing) {
        // This batch owns the complete rendered demand set. Pause old seeks
        // without discarding their validated checkpoints or unfinished work.
        plans.clear_demands();
        let mut spawned = false;
        // Resolve after all actors have identities, including targets later in this
        // frame. An absent recorded target stays absent rather than being guessed.
        let channel_targets: Vec<_> = batch
            .iter()
            .map(|unit| {
                (
                    unit.key.clone(),
                    unit.player,
                    if unit.channel && !unit.dead {
                        unit.channel_target.clone()
                    } else {
                        None
                    },
                )
            })
            .collect();
        let keep: HashSet<_> = batch.iter().map(|u| u.key.as_str()).collect();
        ground_cache.retain(|key, _| keep.contains(key.as_str()));
        canonical
            .diagnostics
            .retain(|key, _| keep.contains(key.as_str()));
        let active_references: HashSet<_> = batch
            .iter()
            .flat_map(|unit| {
                unit.trajectory
                    .iter()
                    .chain(
                        unit.trajectory_bridge
                            .iter()
                            .flat_map(|bridge| [&bridge.from, &bridge.to]),
                    )
                    .map(move |reference| {
                        (
                            unit.key.clone(),
                            reference.source.clone(),
                            reference.component.clone(),
                            reference.content.clone(),
                        )
                    })
            })
            .collect();
        canonical
            .holds
            .retain(|key, _| active_references.contains(key));
        for unit in batch {
            if let Some(reference) = &unit.trajectory_prepare {
                if let Some(time) = reference.at {
                    plans.prepare(
                        &reference.source,
                        &unit.key,
                        &reference.component,
                        &reference.content,
                        time,
                    );
                }
            }
        }
        let mut trajectory_status = ReplayTrajectoryStatus::default();
        let mut trajectory_missing = Vec::new();
        // A paused retry can reflect newly ready floor assets/placements without
        // a collider epoch change. Its route misses must be retried as well.
        routes.begin(readiness_revision);
        routes.retain(&keep);
        let route_probe = crate::webbridge::path::WorldProbe::new(world);
        units.retain(|key, (entity, guid)| {
            if keep.contains(key.as_str()) {
                true
            } else {
                commands.entity(*entity).despawn();
                index.0.remove(guid);
                false
            }
        });
        for unit in batch {
            if !unit.player || unit.dead || unit.position.is_none() || unit.movement.is_none() {
                routes.remove(&unit.key);
            }
            // Actor keys are local to a report. Reusing another report's entity
            // would retain its GUID kind, template, name and floor memo.
            let changed_identity = units
                .get(&unit.key)
                .and_then(|(entity, _)| query.get(*entity).ok())
                .is_some_and(|(_, _, _, _, body)| {
                    !body.identity.matches(unit.player, unit.entry, &unit.name)
                });
            if changed_identity {
                if let Some((entity, guid)) = units.remove(&unit.key) {
                    commands.entity(entity).despawn();
                    index.0.remove(&guid);
                    ground_cache.remove(&unit.key);
                }
            }
            let race = unit.race.unwrap_or(1);
            let sex = unit.sex.unwrap_or(0);
            let native_display = if unit.player {
                chars
                    .as_ref()
                    .and_then(|c| c.0.body_display(race, sex))
                    .unwrap_or(49)
            } else {
                unit.display.unwrap_or(0)
            };
            // Wisp 3681/display10045 from the local client's creature catalog. This is a
            // presentation morph only; player identity/equipment/recorded state stay intact.
            let display = if unit.player && unit.wisp {
                10045
            } else {
                native_display
            };
            let trajectory_owned = unit.player
                && !unit.dead
                && (unit.trajectory.is_some() || unit.trajectory_bridge.is_some());
            if !trajectory_owned {
                canonical.diagnostics.remove(&unit.key);
            }
            let mut pos = if trajectory_owned {
                None
            } else {
                unit.position.map(wow_to_bevy)
            };
            if unit.ground && !trajectory_owned {
                if let Some(mut request) = pos {
                    // Missing log Z is not a real zero-height observation.
                    request.y = unit
                        .floor_hint
                        .or_else(|| floor_context.2.location.map(|(p, _)| p[2]))
                        .unwrap_or(0.);
                    let memo = ground_cache.entry(unit.key.clone()).or_default();
                    pos = memo
                        .resolve(request.to_array(), readiness_revision, || {
                            // Prefer the actor's previous local floor in multi-level rooms.
                            let previous = units
                                .get(&unit.key)
                                .filter(|_| !reset)
                                .and_then(|(entity, _)| query.get(*entity).ok())
                                .filter(|(_, vis, _, _, _)| **vis != Visibility::Hidden)
                                .map(|(xf, _, _, _, _)| xf.translation)
                                .filter(|old| {
                                    Vec2::new(old.x - request.x, old.z - request.z).length() < 15.
                                });
                            let mut floors = crate::planner_floor_geometry::floors_at(
                                request,
                                &floor_context.0,
                                &floor_context.1,
                            );
                            // Outdoor terrain remains a candidate even where another dungeon
                            // level occupies the same XY underneath it.
                            let origin = Vec3::new(request.x, request.y + 4., request.z);
                            if let Some(hit) = world.ray_body(origin, Dir3::NEG_Y, 80.) {
                                floors.push(crate::planner_grounding::FloorCandidate {
                                    height: origin.y - hit.distance,
                                    interior: false,
                                });
                            }
                            let y = crate::planner_grounding::choose_floor(
                                &floors,
                                request.y,
                                previous.map(|p| p.y),
                            )?;
                            Some([request.x, y + 0.05, request.z])
                        })
                        .map(Vec3::from_array);
                }
            } else {
                ground_cache.remove(&unit.key);
            }

            let mut facing = unit.facing;
            let mut speed = unit.speed;
            let mut canonical_motion = None;
            if let Some(reference) = unit.trajectory.as_ref().filter(|_| trajectory_owned) {
                routes.remove(&unit.key);
                let (pose, ready) = canonical.resolve(
                    &plans,
                    reference,
                    &unit.key,
                    control.time,
                    &mut trajectory_status,
                    &mut trajectory_missing,
                );
                if let Some(pose) = pose {
                    let motion = present_canonical_motion(
                        &pose,
                        unit.facing,
                        control.playing,
                        reference.hold,
                        ready,
                    );
                    pos = Some(wow_to_bevy(motion.position) + Vec3::Y * 0.05);
                    facing = motion.facing;
                    speed = motion.speed;
                    canonical_motion = Some(motion);
                }
            } else if let Some(bridge) =
                unit.trajectory_bridge.as_ref().filter(|_| trajectory_owned)
            {
                let (from, from_ready) = canonical.resolve(
                    &plans,
                    &bridge.from,
                    &unit.key,
                    control.time,
                    &mut trajectory_status,
                    &mut trajectory_missing,
                );
                let (to, to_ready) = canonical.resolve(
                    &plans,
                    &bridge.to,
                    &unit.key,
                    control.time,
                    &mut trajectory_status,
                    &mut trajectory_missing,
                );
                if let Some(diagnostic) = canonical.diagnostics.get_mut(&unit.key) {
                    diagnostic.bridge = true;
                }
                if let Some(from) = from {
                    pos = Some(wow_to_bevy(from.position) + Vec3::Y * 0.05);
                    speed = 0.;
                    if from_ready && to_ready {
                        if let (Some(to), Some(mut segment)) = (to, unit.movement.clone()) {
                            segment.from = from.position;
                            segment.to = to.position;
                            // Preserve missing-Z provenance for a swept sparse drop,
                            // but never offer replacement canonical endpoint heights.
                            segment.floor_candidates.clear();
                            if let Some((point, heading, velocity)) =
                                routes.pose(&unit.key, &segment, &route_probe)
                            {
                                pos = Some(point + Vec3::Y * 0.05);
                                if velocity > 0.03 {
                                    facing = heading;
                                }
                                speed = if control.playing { velocity } else { 0. };
                            }
                        }
                    } else {
                        routes.remove(&unit.key);
                    }
                } else {
                    routes.remove(&unit.key);
                }
            } else if unit.player && !unit.dead && unit.position.is_some() {
                canonical.diagnostics.remove(&unit.key);
                if let Some(segment) = &unit.movement {
                    if let Some((point, heading, velocity)) =
                        routes.pose(&unit.key, segment, &route_probe)
                    {
                        pos = Some(point + Vec3::Y * 0.05);
                        if velocity > 0.03 {
                            facing = heading;
                        }
                        speed = if control.playing { velocity } else { 0. };
                    }
                }
            }
            let transform = Transform::from_translation(pos.unwrap_or(Vec3::ZERO))
                .with_rotation(Quat::from_rotation_y(facing));
            // Animation cadence is a gait choice, independent of the translation
            // required to preserve observed anchors in an impossible/sparse span.
            let gait_speed = if unit.player {
                crate::planner_movement::gait_speed(
                    speed,
                    unit.movement.as_ref().and_then(|s| s.run_speed),
                )
            } else {
                speed
            };
            let mut motion = MovementState {
                speed: gait_speed.min(30.),
                flags: if speed > 0.1 { 1 } else { 0 },
                ..default()
            };
            if let Some(pose) = canonical_motion {
                motion.vertical_speed = pose.vertical_speed;
                if pose.airborne {
                    motion.flags |= crate::creature_anim::move_flags::FALLING;
                    if pose.falling_far {
                        motion.flags |= crate::creature_anim::move_flags::FALLING_FAR;
                    }
                }
            }
            let visibility = if pos.is_some() {
                Visibility::Inherited
            } else {
                Visibility::Hidden
            };
            let max = unit.max_health.unwrap_or(1).max(1);
            let health = if unit.dead {
                0
            } else {
                unit.health.unwrap_or(max)
            };
            let power_type = unit.power_type.min(4);
            let mut fields = vec![
                (4, unit.scale.to_bits()),
                (22, health),
                (28, max),
                (
                    36,
                    (if unit.player {
                        u32::from(race) | (unit.class << 8) | (u32::from(sex) << 16)
                    } else {
                        0
                    }) | (u32::from(power_type) << 24),
                ),
                (131, display),
                (132, native_display),
                (
                    193,
                    u32::from(unit.look[0])
                        | (u32::from(unit.look[1]) << 8)
                        | (u32::from(unit.look[2]) << 16)
                        | (u32::from(unit.look[3]) << 24),
                ),
                (194, u32::from(unit.look[4]) | (2 << 24)),
            ];
            for ty in 0..5u8 {
                fields.push((
                    23 + u16::from(ty),
                    if ty == power_type {
                        unit.power.unwrap_or(0)
                    } else {
                        0
                    },
                ));
                fields.push((
                    29 + u16::from(ty),
                    if ty == power_type {
                        unit.max_power.unwrap_or(0)
                    } else {
                        0
                    },
                ));
            }
            // The client descriptor is authoritative for active aura IDs/stacks too. WCL supplies
            // active snapshots; this only packs the 1.12 buff/debuff slots, without simulating rules.
            let mut aura_ids = [0u32; 48];
            let mut aura_flags = [0u32; 6];
            let mut aura_stacks = [0u32; 12];
            if unit.plate_auras.is_empty() {
                for (slot, id) in unit.auras.iter().take(48).enumerate() {
                    aura_ids[slot] = *id;
                    if *id != 0 {
                        aura_flags[slot / 8] |= 2 << ((slot % 8) * 4);
                    }
                }
            } else {
                let (mut buff, mut debuff) = (0usize, 32usize);
                for a in &unit.plate_auras {
                    let slot = if a.debuff {
                        if debuff >= 48 {
                            continue;
                        }
                        let i = debuff;
                        debuff += 1;
                        i
                    } else {
                        if buff >= 32 {
                            continue;
                        }
                        let i = buff;
                        buff += 1;
                        i
                    };
                    aura_ids[slot] = a.spell;
                    aura_flags[slot / 8] |= 2 << ((slot % 8) * 4);
                    aura_stacks[slot / 4] |= (a.stack.clamp(1, 255) - 1) << ((slot % 4) * 8);
                }
            }
            for (slot, id) in aura_ids.into_iter().enumerate() {
                fields.push((47 + slot as u16, id));
            }
            for (slot, flags) in aura_flags.into_iter().enumerate() {
                fields.push((95 + slot as u16, flags));
            }
            for (slot, stacks) in aura_stacks.into_iter().enumerate() {
                fields.push((113 + slot as u16, stacks));
            }
            for slot in 0..19u16 {
                fields.push((260 + 12 * slot, 0));
                fields.push((261 + 12 * slot, 0));
                fields.push((262 + 12 * slot, 0));
            }
            for g in &unit.gear {
                if g.slot >= 19 {
                    continue;
                }
                if !items.template_known(g.id) {
                    let mut template = replay_item_template();
                    template.name = g.name.clone();
                    template.display_info_id = g.display;
                    template.class = g.class;
                    template.subclass = g.subclass;
                    template.inventory_type = g.inventory;
                    template.material = g.material.max(0) as u32;
                    template.sheath = g.sheath;
                    template.quality = g.quality;
                    items.insert_template(g.id, Some(template));
                }
                fields.push((260 + 12 * g.slot, g.id));
                fields.push((261 + 12 * g.slot, g.enchant));
                fields.push((262 + 12 * g.slot, g.temporary));
            }
            fields.push((
                144,
                if unit.channel && !unit.dead {
                    unit.cast
                } else {
                    0
                },
            ));
            let next_cast = if unit.dead || unit.channel {
                0
            } else {
                unit.cast
            };
            if let Some((entity, guid)) = units.get(&unit.key) {
                if unit.player {
                    crate::planner_replay_identity::refresh_player(
                        &mut names,
                        *guid,
                        &unit.name,
                        (race, unit.class as u8, sex),
                    );
                }
                if let Ok((mut xf, mut vis, mut movement, mut store, mut body)) =
                    query.get_mut(*entity)
                {
                    // Keep the visual's scale, which attachment/scale easing owns.
                    if xf.translation != transform.translation {
                        xf.translation = transform.translation;
                    }
                    if xf.rotation != transform.rotation {
                        xf.rotation = transform.rotation;
                    }
                    if *vis != visibility {
                        *vis = visibility;
                    }
                    *movement = motion;
                    body.health_known = unit.health.is_some();
                    body.power_known = unit.power.is_some();
                    body.friendly = unit.friendly;
                    body.nameplate = unit.nameplate;
                    body.raid = unit.raid;
                    body.estimated = unit.estimated;
                    body.plate_cast = unit.plate_cast.clone();
                    body.plate_auras = unit.plate_auras.clone();
                    for (field, old, new) in
                        net::write_fields(&mut store.0, ObjectFields::from_pairs(&fields))
                    {
                        changes.write(net::FieldChanged {
                            at: crate::lanes::stamp(),
                            entity: *entity,
                            guid: *guid,
                            kind: if unit.player {
                                ObjectType::Player
                            } else {
                                ObjectType::Unit
                            },
                            index: field,
                            old,
                            new,
                        });
                    }
                    if body.cast != next_cast {
                        if body.cast != 0
                            && !control.events.iter().any(|e| {
                                e.kind == "go"
                                    && e.source.as_ref() == Some(&unit.key)
                                    && e.spell == body.cast
                            })
                        {
                            casts.write(CastEvent {
                                entity: *entity,
                                spell_id: body.cast,
                                kind: CastEventKind::Fail,
                                cast_flags: 0,
                                item_cast: false,
                                seq: seq.next(),
                            });
                        }
                        if next_cast != 0 {
                            commands.entity(*entity).insert(Casting {
                                spell_id: next_cast,
                                until: None,
                            });
                            casts.write(CastEvent {
                                entity: *entity,
                                spell_id: next_cast,
                                kind: CastEventKind::Start,
                                cast_flags: 0,
                                item_cast: false,
                                seq: seq.next(),
                            });
                        } else {
                            commands.entity(*entity).remove::<Casting>();
                        }
                        body.cast = next_cast;
                    }
                }
                continue;
            }
            *serial += 1;
            let guid = if unit.player {
                0x1000_0000u64 + *serial
            } else {
                0xF130_0000_0000_0000u64 | (u64::from(unit.entry & 0xFF_FFFF) << 24) | *serial
            };
            fields.extend([
                (0, guid as u32),
                (1, (guid >> 32) as u32),
                (2, if unit.player { 0x19 } else { 9 }),
                (3, unit.entry),
                (34, 60),
                (
                    35,
                    if unit.player || unit.friendly {
                        115
                    } else {
                        14
                    },
                ),
                (46, 8),
            ]);
            if unit.player {
                names.insert_player(guid, unit.name.clone(), Some((race, unit.class as u8, sex)));
            } else {
                names.insert_creature(
                    unit.entry,
                    Some(CreatureRecord {
                        name: unit.name.clone(),
                        subname: None,
                        creature_type: 0,
                        pet_family: 0,
                        rank: 1,
                        type_flags: 0,
                        pet_spell_list: 0,
                        civilian: false,
                        racial_leader: false,
                        display_id: display,
                    }),
                );
            }
            let id = commands
                .spawn((
                    ReplayBody {
                        identity: crate::planner_replay_identity::ActorIdentity::new(
                            unit.player,
                            unit.entry,
                            &unit.name,
                        ),
                        key: unit.key.clone(),
                        friendly: unit.friendly,
                        nameplate: unit.nameplate,
                        raid: unit.raid,
                        estimated: unit.estimated,
                        plate_cast: unit.plate_cast.clone(),
                        plate_auras: unit.plate_auras.clone(),
                        health_known: unit.health.is_some(),
                        power_known: unit.power.is_some(),
                        label_height: if unit.player { 2.6 } else { 4.5 * unit.scale },
                        cast: 0,
                    },
                    net::motion::RecordedFacing,
                    net::Guid(guid),
                    net::ObjectStore(crate::planner_replay_identity::initial_fields(
                        unit.player,
                        &fields,
                    )),
                    transform,
                    visibility,
                    motion,
                    net::NetEntity {
                        kind: if unit.player {
                            EntityKind::Player
                        } else if display != 0 {
                            EntityKind::Unit
                        } else {
                            EntityKind::Other
                        },
                        display_id: (display != 0).then_some(display),
                        scale: unit.scale,
                    },
                ))
                .id();
            index.0.insert(guid, id);
            units.insert(unit.key.clone(), (id, guid));
            spawned = true;
        }
        for (key, player, target) in channel_targets {
            let Some(&(entity, guid)) = units.get(&key) else {
                continue;
            };
            let target_guid = target.as_ref().and_then(|key| units.get(key)).map(|u| u.1);
            commands.queue(move |world: &mut World| {
                let Some(mut store) = world.get_mut::<net::ObjectStore>(entity) else {
                    return;
                };
                let delta = crate::planner_replay_identity::channel_target_fields(target_guid);
                let changed = net::write_fields(&mut store.0, delta);
                drop(store);
                for (field, old, new) in changed {
                    world.write_message(net::FieldChanged {
                        at: crate::lanes::stamp(),
                        entity,
                        guid,
                        kind: if player {
                            ObjectType::Player
                        } else {
                            ObjectType::Unit
                        },
                        index: field,
                        old,
                        new,
                    });
                }
            });
        }
        floor_context.7.applied(readiness_revision);
        if canonical.diagnostics.values().any(|row| row.bridge) {
            for row in routes.diagnostics() {
                if canonical
                    .diagnostics
                    .get(&row.key)
                    .is_some_and(|row| row.bridge)
                {
                    match row.status {
                        crate::planner_movement::RouteStatus::Pending
                        | crate::planner_movement::RouteStatus::Deferred => {
                            trajectory_status.pending += 1
                        }
                        crate::planner_movement::RouteStatus::Held => {
                            trajectory_status.conflict += 1
                        }
                        _ => {}
                    }
                }
            }
        }
        trajectory_missing.sort_by(|a, b| {
            (&a.source, &a.actor, &a.component, &a.content).cmp(&(
                &b.source,
                &b.actor,
                &b.component,
                &b.content,
            ))
        });
        trajectory_missing.dedup();
        control.trajectory_status = trajectory_status;
        control.trajectory_missing = trajectory_missing;
        if spawned {
            // The cast transition above needs the deferred ReplayBody to be queryable first.
            floor_context.7.retry_after_spawn();
        }
    }
    if let Some(token) = control.movement_diagnostics_request.take() {
        let mut rows: Vec<serde_json::Value> = routes
            .diagnostics()
            .into_iter()
            .map(|row| serde_json::to_value(row).unwrap_or_default())
            .collect();
        for (key, diagnostic) in &canonical.diagnostics {
            let extra = serde_json::json!({
                "key": key, "canonical": !diagnostic.bridge, "canonicalBridge": diagnostic.bridge,
                "canonicalStatus": diagnostic.status, "canonicalReason": diagnostic.reason,
                "component": diagnostic.reference.component, "content": diagnostic.reference.content,
                "verticalVelocity": diagnostic.pose.as_ref().map(|pose| pose.vertical_velocity),
                "support": diagnostic.pose.as_ref().map(|pose| pose.support),
                "inferredJumps": diagnostic.pose.as_ref().map(|pose| pose.inferred_jumps),
                "jumpArc": diagnostic.pose.as_ref().map(|pose| pose.jump_arc),
                "featherFall": diagnostic.pose.as_ref().map(|pose| pose.feather_fall),
                "controlledAir": diagnostic.pose.as_ref().map(|pose| pose.controlled_air),
            });
            if let Some(row) = rows
                .iter_mut()
                .find(|row| row["key"].as_str() == Some(key.as_str()))
            {
                row.as_object_mut()
                    .unwrap()
                    .extend(extra.as_object().unwrap().clone());
            } else {
                let mut row = extra;
                row["status"] = serde_json::json!(diagnostic.status);
                rows.push(row);
            }
        }
        // Report actual rendered transforms, including the presentation floor lift.
        for row in &mut rows {
            if let Some((entity, _)) = row["key"].as_str().and_then(|key| units.get(key)) {
                if let Ok((xf, _, _, _, _)) = query.get(*entity) {
                    row["renderedPosition"] =
                        serde_json::json!(benilla_assets::coords::bevy_to_wow(xf.translation));
                    row["renderedFacing"] =
                        serde_json::json!(xf.rotation.to_euler(EulerRot::YXZ).0);
                }
            }
        }
        rows.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
        control.movement_diagnostics_response = Some((token, rows));
    }
    control.entities = units.values().map(|u| u.0).collect();
    let cutoff = control.time - 5000.0;
    control.flights.retain(|_, values| {
        values.retain(|t| *t >= cutoff);
        !values.is_empty()
    });
    let mut events = std::mem::take(&mut control.events);
    events.sort_by(|a, b| a.t.total_cmp(&b.t));
    for event in events {
        let source = event
            .source
            .as_ref()
            .and_then(|k| units.get(k))
            .map(|v| v.0);
        let target = event
            .target
            .as_ref()
            .and_then(|k| units.get(k))
            .map(|v| v.0);
        let stamp = seq.next();
        if event.spell > 1
            && spells
                .as_ref()
                .is_some_and(|s| s.catalog.get(event.spell).is_none())
        {
            control.unsupported.insert(event.spell);
        }
        if event.spell > 1 && !control.visual_diagnostics.contains_key(&event.spell) {
            let def = spells.as_ref().and_then(|s| s.catalog.get(event.spell));
            let stages = def.and_then(|s| visuals.as_ref()?.0.stages(s.visual));
            let kits: Vec<_> = stages
                .into_iter()
                .flat_map(|s| [s.precast, s.cast, s.impact, s.state, s.channel])
                .filter_map(|id| {
                    let v = &visuals.as_ref()?.0;
                    let k = v.kit(id)?;
                    Some(ReplayKitDiagnostic {
                        kit: id,
                        animation: k.anim_id,
                        models: v.model_attachments(k).len(),
                    })
                })
                .collect();
            control.visual_diagnostics.insert(
                event.spell,
                ReplaySpellDiagnostic {
                    spell: event.spell,
                    catalogued: def.is_some(),
                    visual: def.map(|s| s.visual),
                    resolved: stages.is_some(),
                    kits,
                    projectiles: def
                        .and_then(|s| {
                            visuals
                                .as_ref()
                                .map(|v| v.0.missile_effects(s.visual).len())
                        })
                        .unwrap_or(0),
                },
            );
        }
        match event.kind.as_str() {
            "summon-cue" => {
                if let Some(source) = source {
                    let school = spells
                        .as_ref()
                        .and_then(|s| s.catalog.get(event.spell))
                        .map_or(0, |s| s.school);
                    control.pending_cues.push(crate::planner_cues::CastCue {
                        spell_id: event.spell,
                        source,
                        at: event.t,
                        school,
                    });
                }
            }
            "go" => {
                if let Some(entity) = source {
                    // A proc/instant GO must not cancel a different spell's wind-up.
                    if query
                        .get(entity)
                        .is_ok_and(|(_, _, _, _, body)| body.cast == event.spell)
                    {
                        commands.entity(entity).remove::<Casting>();
                    }
                    casts.write(CastEvent {
                        entity,
                        spell_id: event.spell,
                        kind: CastEventKind::Go,
                        cast_flags: 0,
                        item_cast: false,
                        seq: stamp,
                    });
                    let mut hit_targets = Vec::new();
                    for impact in &event.impacts {
                        if let Some(&(target, _)) = units.get(&impact.target) {
                            control
                                .flights
                                .entry((entity, event.spell, target))
                                .or_default()
                                .push_back(impact.t);
                            hit_targets.push(target);
                        }
                    }
                    if hit_targets.is_empty() {
                        hit_targets.extend(target);
                    }
                    targets.write(SpellGoTargets {
                        caster: Some(entity),
                        spell_id: event.spell,
                        hits: hit_targets,
                        misses: vec![],
                        dest: None,
                        ammo_display_id: None,
                        seq: stamp,
                    });
                    control.visual_events += 1;
                }
            }
            "damage" if event.melee => {
                if let Some(entity) = source {
                    swings.write(SwingMessage {
                        attacker: entity,
                        victim: target,
                        hit_info: 0,
                        victim_state: 1,
                        damage: event.amount,
                        displayed: true,
                        seq: stamp,
                    });
                    control.visual_events += 1;
                }
            }
            "impact" => {
                if let Some(entity) = target {
                    casts.write(CastEvent {
                        entity,
                        spell_id: event.spell,
                        kind: CastEventKind::Impact {
                            weapon_visual: None,
                            caster: source,
                        },
                        cast_flags: 0,
                        item_cast: false,
                        seq: stamp,
                    });
                    control.visual_events += 1;
                }
            }
            _ => {}
        }
    }
}

// Use the client widgets and their normal selection/hover handling in both planner modes.
fn stock_nameplates(
    mut vm: crate::script_calls::VmWith<Res<'static, ReplayControl>>,
    mut applied: Local<Option<(u64, bool)>>,
) {
    vm.turn(|mut script, control| {
        let Some(script) = script.as_mut() else {
            return;
        };
        let Some(on) = control.nameplates else {
            return;
        };
        let key = (script.session(), on);
        if *applied == Some(key) {
            return;
        }
        if !script
            .eval::<bool>("return WorldFrame ~= nil")
            .unwrap_or(false)
        {
            return;
        }
        let code =
            "NAMEPLATES_ON=nil; FRIENDNAMEPLATES_ON=nil; HideNameplates(); HideFriendNameplates()";
        if script.run(code).is_ok() {
            *applied = Some(key);
        }
    });
}

// Base metadata for equipment resolved from the imported replay.
fn replay_item_template() -> benilla_protocol::messages::ItemInfo {
    benilla_protocol::messages::ItemInfo {
        class: 0,
        subclass: 0,
        name: String::new(),
        display_info_id: 0,
        quality: 1,
        flags: 0,
        buy_price: 0,
        sell_price: 0,
        inventory_type: 0,
        allowable_class: -1,
        allowable_race: -1,
        item_level: 0,
        required_level: 0,
        required_skill: 0,
        required_skill_rank: 0,
        required_spell: 0,
        required_honor_rank: 0,
        required_city_rank: 0,
        required_rep_faction: 0,
        required_rep_rank: 0,
        max_count: 0,
        stackable: 1,
        container_slots: 0,
        stats: Vec::new(),
        damages: Vec::new(),
        dmg_min: 0.0,
        dmg_max: 0.0,
        dmg_type: 0,
        armor: 0,
        resistances: [0; 6],
        delay_ms: 0,
        ammo_type: 0,
        ranged_mod_range: 0.0,
        spells: Vec::new(),
        spell_charges_0: 0,
        use_spell: None,
        bonding: 0,
        description: String::new(),
        page_text: 0,
        language_id: 0,
        page_material: 0,
        start_quest: 0,
        lock_id: 0,
        material: 0,
        sheath: 0,
        random_property: 0,
        block: 0,
        item_set: 0,
        max_durability: 0,
        area: 0,
        map: 0,
        bag_family: 0,
    }
}
