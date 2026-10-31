//! Explicitly enabled diagnostics for the shipping browser renderer. No filesystem or account I/O.
use std::{cell::RefCell, time::Duration};
#[path = "renderer_clock.rs"]
mod clock;

use benilla_assets::{
    coords::{bevy_to_wow, wow_to_bevy},
    materials::{TerrainMaterial, WowModelMaterial},
    AnimRng,
};
use benilla_world::{schedule::WorldStage, terrain_stream::WorldLoadProgress, view::WorldCamera};
use bevy::{
    asset::UntypedAssetLoadFailedEvent,
    prelude::*,
    render::view::screenshot::{Screenshot, ScreenshotCaptured},
    time::{Real, TimeSystems, TimeUpdateStrategy, Virtual},
    transform::TransformSystems,
};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(
    inline_js = "export function rendererLabReport(json) { try { if (typeof globalThis.__pullfictionRendererLab === 'function') globalThis.__pullfictionRendererLab(json); else globalThis.pullfiction?.('renderer-lab', json); } catch (error) { console.error('Renderer lab callback failed', error); } } export function rendererLabPng(bytes, width, height) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('PNG encoder unavailable'); const pixels = ctx.createImageData(width, height); pixels.data.set(bytes); ctx.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png'); }"
)]
extern "C" {
    #[wasm_bindgen(js_name = rendererLabReport)]
    fn report(json: &str);
    #[wasm_bindgen(catch, js_name = rendererLabPng)]
    fn encode_png(bytes: &[u8], width: u32, height: u32) -> Result<String, JsValue>;
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CameraConfig {
    eye: [f32; 3],
    target: [f32; 3],
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    enabled: bool,
    camera: Option<CameraConfig>,
    step_seconds: Option<f64>,
    frozen: Option<bool>,
    advance_frames: Option<u32>,
    /// Diagnostic replay clock, advanced alongside every fixed simulation step.
    replay_time_ms: Option<f64>,
    seed: Option<u32>,
    synthetic: Option<bool>,
    models: Option<Vec<benilla_app::renderer_fixture::RendererModelFixture>>,
    reset_time: Option<bool>,
    isolate_world: Option<bool>,
    portal_cull: Option<bool>,
}

enum Request {
    Configure(Config),
    Advance(u32),
    Capture(String),
    Status(String),
}
thread_local! { static REQUESTS: RefCell<Vec<Request>> = const { RefCell::new(Vec::new()) }; }

fn enqueue(request: Request) -> Result<(), JsValue> {
    REQUESTS.with(|queue| {
        let mut queue = queue.borrow_mut();
        if queue.len() >= 16 {
            return Err(JsValue::from_str("Renderer lab request queue full"));
        }
        if matches!(&request, Request::Configure(_))
            && queue.iter().any(|r| matches!(r, Request::Configure(_)))
        {
            return Err(JsValue::from_str(
                "A renderer lab configuration is already queued",
            ));
        }
        queue.push(request);
        Ok(())
    })
}

/// Pin the diagnostic camera and simulation clock. Seed 1 resets the shared animation RNG only.
/// `advanceFrames` advances at most 600 fixed steps, then freezes, independent of readiness.
#[wasm_bindgen]
pub fn renderer_lab_configure(json: &str) -> Result<(), JsValue> {
    if json.len() > 32768 {
        return Err(JsValue::from_str(
            "Renderer lab configuration exceeds 32768 bytes",
        ));
    }
    let config: Config =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    validate(&config).map_err(JsValue::from_str)?;
    enqueue(Request::Configure(config))
}

fn validate(config: &Config) -> Result<(), &'static str> {
    if let Some(models) = &config.models {
        if models.len() > 64 {
            return Err("At most 64 diagnostic model fixtures are allowed");
        }
        let mut keys = std::collections::HashSet::new();
        for model in models {
            model.validate()?;
            if !keys.insert(&model.key) {
                return Err("Model fixture keys must be unique");
            }
        }
    }
    if config.enabled && config.synthetic == Some(true) && config.camera.is_none() {
        return Err("Synthetic scene requires a camera with a target");
    }
    if config
        .step_seconds
        .is_some_and(|n| !n.is_finite() || !(0.001..=0.1).contains(&n))
        || config.advance_frames.is_some_and(|n| n > 600)
    {
        return Err("Invalid fixed step or advanceFrames (maximum 600)");
    }
    if config
        .replay_time_ms
        .is_some_and(|n| !n.is_finite() || !(0.0..=120_000.0).contains(&n))
    {
        return Err("Invalid diagnostic replay time");
    }
    if config.seed.is_some_and(|n| n != 1) {
        return Err("Only animation RNG seed 1 is supported");
    }
    if let Some(camera) = &config.camera {
        if camera
            .eye
            .iter()
            .chain(camera.target.iter())
            .any(|n| !n.is_finite() || n.abs() > 20000.)
        {
            return Err("Invalid WoW camera coordinates");
        }
        let direction = Vec3::from_array(camera.target) - Vec3::from_array(camera.eye);
        // World Z is up; a vertical look direction gives looking_at no valid right vector.
        if direction.length_squared() < 0.0001 || direction.truncate().length_squared() < 0.0001 {
            return Err("Camera eye and target need a nonvertical separation");
        }
    }
    Ok(())
}

fn token_request(token: &str, capture: bool) -> Result<(), JsValue> {
    if token.is_empty() || token.len() > 128 {
        return Err(JsValue::from_str(
            "Renderer lab token must contain 1..128 bytes",
        ));
    }
    enqueue(if capture {
        Request::Capture(token.into())
    } else {
        Request::Status(token.into())
    })
}

/// Capture actual GPU output; the dedicated callback receives a JSON string containing a PNG URL.
#[wasm_bindgen]
pub fn renderer_lab_capture(token: &str) -> Result<(), JsValue> {
    token_request(token, true)
}

/// Poll readiness without allocating a GPU readback.
#[wasm_bindgen]
pub fn renderer_lab_status(token: &str) -> Result<(), JsValue> {
    token_request(token, false)
}

/// Advance already loaded fixtures without rebuilding their model/particle/animation state.
#[wasm_bindgen]
pub fn renderer_lab_advance(frames: u32) -> Result<(), JsValue> {
    if frames > 600 {
        return Err(JsValue::from_str("At most 600 fixed steps are allowed"));
    }
    enqueue(Request::Advance(frames))
}

#[derive(Resource, Default)]
struct Lab {
    config: Option<Config>,
    prior_clock: Option<TimeUpdateStrategy>,
    prior_replay_clock: Option<(f64, f64, bool)>,
    prior_rng: Option<AnimRng>,
    prior_camera: Option<Transform>,
    remaining: u32,
    advanced: u32,
    frame: u64,
    captures: Vec<(String, bool)>,
    in_flight: Option<(String, Entity, u64)>,
    failures: Vec<String>,
    failure_count: usize,
    animation_seed: Option<u32>,
    prior_times: Option<(Time<Virtual>, Time)>,
    case_start_seconds: f64,
    case_start_real_seconds: f64,
    reset_applied: bool,
}

#[derive(Component)]
struct Synthetic;
#[derive(Resource, Default)]
struct PvsPose(Option<Transform>);

fn record_pvs_pose(
    lab: Res<Lab>,
    cameras: Query<&GlobalTransform, With<WorldCamera>>,
    mut pose: ResMut<PvsPose>,
) {
    if lab.config.is_some() {
        pose.0 = cameras
            .single()
            .ok()
            .map(GlobalTransform::compute_transform);
    }
}

type SubjectRoots<'w, 's> = Query<
    'w,
    's,
    (),
    Or<(
        With<benilla_app::planner_replay::ReplayBody>,
        With<benilla_app::renderer_fixture::RendererFixtureRoot>,
        With<Synthetic>,
    )>,
>;
type IsolationMeshes<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static mut Visibility,
        Option<&'static benilla_world::model_render::ModelPart>,
        Has<benilla_world::particles::ChildDraw>,
        Has<Mesh3d>,
    ),
    Or<(With<Mesh3d>, With<benilla_world::model_render::ModelPart>)>,
>;

fn is_subject(
    entity: Entity,
    part: Option<&benilla_world::model_render::ModelPart>,
    particle: bool,
    roots: &SubjectRoots,
    parents: &Query<&ChildOf>,
) -> bool {
    use benilla_world::model_render::ModelKind;
    crate::renderer_isolation::preserve_subject(
        entity,
        particle
            || part.is_some_and(|part| {
                matches!(part.kind, ModelKind::Creature | ModelKind::GameObject)
            }),
        |entity| roots.contains(entity),
        |entity| parents.get(entity).ok().map(ChildOf::parent),
    )
}

fn isolation_flags(
    lab: Res<Lab>,
    mut isolation: ResMut<crate::renderer_isolation::Isolation>,
    mut debug: ResMut<benilla_world::dev_state::DebugState>,
    roots: SubjectRoots,
    parents: Query<&ChildOf>,
    mut meshes: IsolationMeshes,
) {
    let portal_request = lab.config.as_ref().and_then(|config| config.portal_cull);
    if let Some(next) = isolation.portal_override(portal_request, debug.models.portal_cull) {
        debug.models.portal_cull = next;
    }
    let requested = lab
        .config
        .as_ref()
        .is_some_and(|config| config.isolate_world.unwrap_or(false));
    if requested && !isolation.active {
        isolation.prior_world_kinds = Some(debug.models.kind_visible);
        for (entity, visibility, part, particle, _) in &mut meshes {
            if !is_subject(entity, part, particle, &roots, &parents) {
                isolation.remember(entity, *visibility);
            }
        }
    }
    if requested {
        // The retained static pass bypasses Mesh3d visibility, but honors these production toggles.
        if debug.models.kind_visible[0] || debug.models.kind_visible[1] {
            debug.models.kind_visible[0] = false;
            debug.models.kind_visible[1] = false;
        }
    } else if isolation.active {
        if let Some(previous) = isolation.prior_world_kinds.take() {
            debug.models.kind_visible[0] = previous[0];
            debug.models.kind_visible[1] = previous[1];
        }
        // Restore before the normal Update visibility authorities resolve the current camera.
        for (entity, mut visibility, _, _, _) in &mut meshes {
            isolation.restore(entity, &mut visibility);
        }
        isolation.prune(|entity| meshes.contains(entity));
        isolation.overflow = false;
        isolation.hidden_mesh_count = 0;
    }
    isolation.active = requested;
}

fn isolate_meshes(
    mut isolation: ResMut<crate::renderer_isolation::Isolation>,
    roots: SubjectRoots,
    parents: Query<&ChildOf>,
    mut meshes: IsolationMeshes,
) {
    if !isolation.active {
        return;
    }
    isolation.prune(|entity| meshes.contains(entity));
    isolation.overflow = false;
    isolation.hidden_mesh_count = 0;
    for (entity, mut visibility, part, particle, is_mesh) in &mut meshes {
        if is_subject(entity, part, particle, &roots, &parents) {
            isolation.restore(entity, &mut visibility);
        } else {
            isolation.hide(entity, &mut visibility);
            if is_mesh && *visibility == Visibility::Hidden {
                isolation.hidden_mesh_count += 1;
            }
        }
    }
}

pub(crate) fn install(app: &mut App) {
    benilla_app::renderer_fixture::install(app);
    app.init_resource::<Lab>()
        .init_resource::<crate::renderer_isolation::Isolation>()
        .init_resource::<PvsPose>()
        .add_systems(First, control.before(TimeSystems))
        .add_systems(First, isolation_flags.after(control).before(TimeSystems))
        .add_systems(
            Update,
            record_pvs_pose
                .after(benilla_world::view::CameraPoseSet)
                .before(benilla_world::wmo_portal::WmoPvsSet),
        )
        .add_systems(
            PostUpdate,
            isolate_meshes
                .after(TransformSystems::Propagate)
                .before(bevy::camera::visibility::VisibilitySystems::VisibilityPropagate),
        )
        .add_systems(
            Update,
            pin_camera
                .after(WorldStage::Input)
                .before(benilla_world::view::CameraPoseSet)
                .before(WorldStage::Stream),
        )
        .add_systems(PostUpdate, pin_camera.before(TransformSystems::Propagate))
        .add_systems(Last, capture);
}

#[allow(clippy::too_many_arguments)]
fn control(
    mut commands: Commands,
    mut lab: ResMut<Lab>,
    mut strategy: ResMut<TimeUpdateStrategy>,
    mut rng: Option<ResMut<AnimRng>>,
    mut cameras: Query<&mut Transform, With<WorldCamera>>,
    synthetic: Query<Entity, With<Synthetic>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut fixtures: ResMut<benilla_app::renderer_fixture::RendererFixtureControl>,
    mut virtual_time: ResMut<Time<Virtual>>,
    mut generic_time: ResMut<Time>,
    real_time: Res<Time<Real>>,
    mut replay: ResMut<benilla_app::planner_replay::ReplayControl>,
) {
    lab.frame = lab.frame.saturating_add(1);
    let requests = REQUESTS.with(|queue| std::mem::take(&mut *queue.borrow_mut()));
    for request in requests {
        match request {
            Request::Configure(config) => {
                if lab.in_flight.is_some() {
                    report_error(None, "Cannot reconfigure during GPU capture");
                    continue;
                }
                for entity in &synthetic {
                    commands.entity(entity).try_despawn();
                }
                if config.enabled && config.synthetic == Some(true) {
                    let center =
                        wow_to_bevy(config.camera.as_ref().expect("validated camera").target);
                    // Self-authored unlit shapes test the same production GPU path without game art.
                    commands.spawn((
                        Synthetic,
                        Mesh3d(meshes.add(Cuboid::new(3., 3., 3.))),
                        MeshMaterial3d(materials.add(StandardMaterial {
                            base_color: Color::srgb(0.95, 0.24, 0.08),
                            unlit: true,
                            ..default()
                        })),
                        Transform::from_translation(center),
                    ));
                    commands.spawn((
                        Synthetic,
                        Mesh3d(meshes.add(Plane3d::default().mesh().size(12., 12.))),
                        MeshMaterial3d(materials.add(StandardMaterial {
                            base_color: Color::srgb(0.12, 0.3, 0.65),
                            unlit: true,
                            ..default()
                        })),
                        Transform::from_translation(center - Vec3::Y * 1.51),
                    ));
                }
                fixtures.pending = Some(if config.enabled {
                    config.models.clone().unwrap_or_default()
                } else {
                    Vec::new()
                });
                if config.enabled {
                    if lab.prior_clock.is_none() {
                        lab.prior_clock = Some(std::mem::replace(
                            &mut *strategy,
                            TimeUpdateStrategy::Automatic,
                        ));
                    }
                    lab.animation_seed = None;
                    lab.reset_applied = config.reset_time.unwrap_or(false);
                    if lab.reset_applied {
                        if lab.prior_times.is_none() {
                            lab.prior_times = Some((*virtual_time, *generic_time));
                        }
                        let mut fresh = Time::new_with(*virtual_time.context());
                        fresh.set_wrap_period(virtual_time.wrap_period());
                        *virtual_time = fresh;
                        *generic_time = virtual_time.as_generic();
                    }
                    lab.case_start_seconds = virtual_time.elapsed_secs_f64();
                    lab.case_start_real_seconds = real_time.elapsed_secs_f64();
                    if config.seed == Some(1) {
                        if let Some(rng) = rng.as_deref_mut() {
                            let previous = std::mem::take(rng);
                            if lab.prior_rng.is_none() {
                                lab.prior_rng = Some(previous);
                            }
                            lab.animation_seed = Some(1);
                        }
                    }
                    if let Some(time) = config.replay_time_ms {
                        lab.prior_replay_clock.get_or_insert((
                            replay.time,
                            replay.rate,
                            replay.playing,
                        ));
                        replay.time = time;
                        replay.rate = 1.;
                        replay.playing = false;
                    }
                    lab.remaining = config.advance_frames.unwrap_or(0);
                    lab.advanced = 0;
                    lab.failures.clear();
                    lab.failure_count = 0;
                    lab.config = Some(config);
                } else {
                    lab.config = None;
                    if let Some((time, rate, playing)) = lab.prior_replay_clock.take() {
                        replay.time = time;
                        replay.rate = rate;
                        replay.playing = playing;
                    }
                    if let Some(previous) = lab.prior_clock.take() {
                        *strategy = previous;
                    }
                    if let (Some(previous), Some(rng)) = (lab.prior_rng.take(), rng.as_deref_mut())
                    {
                        *rng = previous;
                    }
                    if let Some(previous) = lab.prior_camera.take() {
                        if let Ok(mut camera) = cameras.single_mut() {
                            *camera = previous;
                        }
                    }
                    if let Some((previous_virtual, previous_generic)) = lab.prior_times.take() {
                        *virtual_time = previous_virtual;
                        *generic_time = previous_generic;
                    }
                }
                report(&json!({"type":"configured", "enabled": lab.config.is_some(),"resetApplied":lab.config.is_some() && lab.reset_applied,"startSimulationSeconds":lab.case_start_seconds,"startRealSeconds":lab.case_start_real_seconds,"virtualSeconds":virtual_time.elapsed_secs_f64(),"genericSeconds":generic_time.elapsed_secs_f64(),"realSeconds":real_time.elapsed_secs_f64()}).to_string());
            }
            Request::Capture(token) => lab.captures.push((token, true)),
            Request::Status(token) => lab.captures.push((token, false)),
            Request::Advance(frames) => {
                if lab.in_flight.is_some() {
                    report_error(None, "Cannot advance during GPU capture");
                    continue;
                }
                let Some(config) = lab.config.as_mut() else {
                    report_error(None, "Renderer lab is disabled");
                    continue;
                };
                config.frozen = Some(true);
                config.advance_frames = Some(frames);
                lab.remaining = frames;
                lab.advanced = 0;
                report(&json!({"type":"advance-started","frames":frames}).to_string());
            }
        }
    }
    if let Some(config) = lab.config.as_ref() {
        let advancing = lab.remaining > 0;
        let frozen = config.frozen.unwrap_or(true) || config.advance_frames.is_some();
        let dt = clock::delta_seconds(
            config.step_seconds.unwrap_or(1. / 60.),
            advancing,
            frozen,
            lab.in_flight.is_some(),
        );
        *strategy = TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(dt));
        if config.replay_time_ms.is_some() {
            replay.time += dt * 1000.;
        }
        if advancing && dt > 0. {
            lab.remaining -= 1;
            lab.advanced += 1;
        }
    }
}

fn pin_camera(mut lab: ResMut<Lab>, mut cameras: Query<&mut Transform, With<WorldCamera>>) {
    let Some(config) = lab.config.as_ref().and_then(|c| c.camera.clone()) else {
        return;
    };
    if let Ok(mut camera) = cameras.single_mut() {
        if lab.prior_camera.is_none() {
            lab.prior_camera = Some(*camera);
        }
        *camera = Transform::from_translation(wow_to_bevy(config.eye))
            .looking_at(wow_to_bevy(config.target), Vec3::Y);
    }
}

fn report_error(token: Option<&str>, error: &str) {
    report(&json!({"type":"error", "token":token, "error":error}).to_string());
}

type VisibilitySnapshot<'w, 's> = Query<
    'w,
    's,
    (
        Option<&'static GlobalTransform>,
        Option<&'static Visibility>,
        Option<&'static InheritedVisibility>,
        Option<&'static ViewVisibility>,
        Option<&'static benilla_world::model_fade::ModelAlpha>,
        Option<&'static benilla_world::model_fade::UnitAppearFade>,
    ),
>;

fn visibility_snapshot(entity: Entity, states: &VisibilitySnapshot) -> serde_json::Value {
    let Ok((transform, visibility, inherited, view, alpha, appear)) = states.get(entity) else {
        return serde_json::Value::Null;
    };
    json!({"position":transform.map(|t|bevy_to_wow(t.translation())),"visibility":visibility.map(|v|format!("{v:?}")),"inheritedVisible":inherited.map(|v|v.get()),"visibleInAnyView":view.map(|v|v.get()),"modelAlpha":alpha.map_or(1.,|a|a.0),"appearFade":appear.map(|a|format!("{a:?}"))})
}

#[allow(clippy::too_many_arguments)]
fn capture(
    actor_diagnostics: Res<benilla_app::renderer_actor_diagnostics::ActorDiagnostics>,
    mut commands: Commands,
    mut lab: ResMut<Lab>,
    clocks: (Res<Time>, Res<Time<Real>>),
    progress: Res<WorldLoadProgress>,
    windows: Query<&Window, With<bevy::window::PrimaryWindow>>,
    cameras: Query<&Transform, With<WorldCamera>>,
    subjects: (
        Query<(Entity, &benilla_app::planner_replay::ReplayBody)>,
        Query<&Mesh3d>,
        Query<&Children>,
        VisibilitySnapshot,
    ),
    images: Res<Assets<Image>>,
    meshes: Res<Assets<Mesh>>,
    models: Res<Assets<WowModelMaterial>>,
    terrain: Res<Assets<TerrainMaterial>>,
    standard: Res<Assets<StandardMaterial>>,
    mut failures: MessageReader<UntypedAssetLoadFailedEvent>,
    renderer: (
        Option<Res<bevy::render::renderer::RenderAdapterInfo>>,
        Res<benilla_app::renderer_fixture::RendererFixtureControl>,
        Res<crate::renderer_isolation::Isolation>,
        Res<PvsPose>,
    ),
    world_context: (
        Res<benilla_world::view::Viewer>,
        Res<benilla_world::world_map::CurrentMap>,
        Res<benilla_world::terrain_stream::ViewFocus>,
        Res<benilla_world::terrain_stream::TerrainStreamer>,
        Res<benilla_world::schedule::WorldLive>,
        Option<Res<benilla_assets::MapCatalogRes>>,
        Res<benilla_world::wmo_portal::WmoCullProbe>,
        Res<benilla_world::wmo_portal::ExteriorWindows>,
        Query<&benilla_world::wmo_portal::WmoPortalInstance>,
    ),
) {
    let viewer = &world_context.0;
    let (bodies, mesh_instances, children, visibility) = subjects;
    for failure in failures.read() {
        if lab.config.is_some() {
            lab.failure_count = lab.failure_count.saturating_add(1);
            if lab.failures.len() < 64 {
                lab.failures.push(
                    format!("{}: {}", failure.path, failure.error)
                        .chars()
                        .take(2048)
                        .collect(),
                );
            }
        }
    }
    if let Some((token, entity, frame)) = lab.in_flight.clone() {
        if lab.frame.saturating_sub(frame) > 600 {
            commands.entity(entity).try_despawn();
            lab.in_flight = None;
            report_error(
                Some(&token),
                "GPU readback timed out after 600 render updates",
            );
        }
    }
    for (token, wants_image) in std::mem::take(&mut lab.captures) {
        let Some(config) = &lab.config else {
            report_error(Some(&token), "Renderer lab is disabled");
            continue;
        };
        let camera = cameras.single().ok();
        let time = &clocks.0;
        let clock_limitations: Vec<_> = [
            (!lab.reset_applied).then_some("Global simulation time is not rewound"),
            Some("Existing actor animation and particle state is not reset by the clock"),
            Some("Persistent world systems retain their prior timestamp origins"),
            Some("Async readiness and draw ordering need repeated-capture validation"),
            Some("Asset queue and subject GPU readiness are not exposed"),
        ]
        .into_iter()
        .flatten()
        .collect();
        let mut detail_budget = 512usize;
        let subjects: Vec<_> = bodies.iter().take(4096).map(|(entity, body)| {
            let attached: Vec<_> = std::iter::once(entity).chain(children.iter_descendants(entity)).filter_map(|child| mesh_instances.get(child).ok().map(|mesh|(child,mesh))).collect();
            let loaded = attached.iter().filter(|(_,mesh)| meshes.contains(mesh.0.id())).count();
            let included = attached.len().min(64).min(detail_budget);
            detail_budget -= included;
            let mesh_states: Vec<_> = attached.iter().take(included).map(|(child,_)|visibility_snapshot(*child,&visibility)).collect();
            json!({"key":body.key,"meshInstances":attached.len(),"loadedMeshes":loaded,"gpuReady":null,"state":visibility_snapshot(entity,&visibility),"meshesInAnyView":attached.iter().filter(|(child,_)|visibility.get(*child).ok().and_then(|(_,_,_,view,_,_)|view).is_some_and(|v|v.get())).count(),"meshStates":mesh_states,"meshStatesTruncated":included<attached.len()})
        }).collect();
        let loaded_bodies = subjects
            .iter()
            .filter(|subject| subject["loadedMeshes"].as_u64().unwrap_or(0) > 0)
            .count();
        let ready_visual_bodies = actor_diagnostics
            .0
            .iter()
            .filter(|actor| actor.visual_ready())
            .count();
        let mut payload = json!({
            "type":if wants_image {"capture"} else {"status"}, "token":token,
            "frame":lab.frame, "simulationSeconds":time.elapsed_secs_f64(),
            "mapId":world_context.1.0,
            "mapDirectory":world_context.5.as_ref().and_then(|catalog|catalog.0.directory(world_context.1.0)),
            "portalCull":renderer.2.portal_cull,
            "portalCullOverride":config.portal_cull,
            "pvs":{"eye":bevy_to_wow(world_context.6.eye),"camera":renderer.3.0.as_ref().map(|pose|json!({"eye":bevy_to_wow(pose.translation),"target":bevy_to_wow(pose.translation+*pose.forward())})),"exteriorWindows":format!("{:?}",*world_context.7),"instances":world_context.8.iter().take(16).map(|instance|json!({"position":bevy_to_wow(instance.world_from_local.translation.into()),"groups":instance.visible.len(),"visibleGroups":instance.visible.iter().enumerate().filter_map(|(index,visible)|visible.then_some(index)).take(256).collect::<Vec<_>>()})).collect::<Vec<_>>(),"instancesTruncated":world_context.8.iter().count()>16},
            "actorDiagnostics":actor_diagnostics.0,
            "cueDiagnostics":actor_diagnostics.1,
            "clock":{"resetApplied":lab.reset_applied,"startSimulationSeconds":lab.case_start_seconds,"startRealSeconds":lab.case_start_real_seconds,"realSeconds":clocks.1.elapsed_secs_f64(),"realClockReset":false},
            "advancedFrames":lab.advanced, "remainingFrames":lab.remaining,
            "frozen":lab.remaining == 0 && (config.frozen.unwrap_or(true) || config.advance_frames.is_some()),
            "camera":camera.map(|c|json!({"eye":bevy_to_wow(c.translation),"target":bevy_to_wow(c.translation + *c.forward())})),
            "configuredCamera":config.camera.as_ref().map(|c|json!({"eye":c.eye,"target":c.target})),
            "resources":{"replayBodies":bodies.iter().count(),"replayBodiesWithLoadedMeshes":loaded_bodies,"replayBodiesWithReadyVisuals":ready_visual_bodies,"meshInstances":mesh_instances.iter().count(),"images":images.len(),"meshes":meshes.len(),"modelMaterials":models.len(),"terrainMaterials":terrain.len(),"standardMaterials":standard.len()},
            "subjects":subjects,
            "gpu":renderer.0.as_ref().map(|a|json!({"name":a.name,"backend":format!("{:?}",a.backend),"deviceType":format!("{:?}",a.device_type),"driver":a.driver,"driverInfo":a.driver_info})),
            "models":renderer.1.statuses,
            "isolation":{"active":renderer.2.active,"hiddenMeshCount":renderer.2.hidden_mesh_count,"savedVisibilityCount":renderer.2.count(),"overflow":renderer.2.overflow,"retainedWorldKindsSuppressed":renderer.2.prior_world_kinds.is_some(),"limitations":["Lighting, collision, fog and world readiness retain their production scene state", "Non-mesh effect streams remain active"]},
            "readiness":{"worldPresentable":progress.presentable(),"worldReady":progress.ready,"worldTotal":progress.total,"focusResident":progress.focus_resident,"collidersPending":progress.colliders_pending,"mergePending":progress.merge_pending,"placementsPending":progress.placements_pending,"gxPending":progress.gx_pending,"assetQueuePending":null,"subjectGpuReady":null},
            "viewer":{"worldCovered":viewer.world_covered,"position":viewer.at.map(bevy_to_wow),"selfFade":viewer.self_fade,"worldLive":world_context.4.0,"focusFollowsBody":world_context.2.follows_body(),"focusTile":progress.focus_tile,"tileResidency":world_context.3.residency()},
            "errors":lab.failures,
            "errorCount":lab.failure_count,
            "determinism":{"complete":false,"requestedSeed":config.seed,"animationSeed":lab.animation_seed,"limitations":clock_limitations}
        });
        if !wants_image {
            report(&payload.to_string());
            continue;
        }
        if lab.remaining > 0 {
            report_error(Some(&token), "Fixed-step advance is still running");
            continue;
        }
        if lab.in_flight.is_some() {
            report_error(Some(&token), "A GPU capture is already pending");
            continue;
        }
        let Ok(window) = windows.single() else {
            report_error(Some(&token), "Primary window unavailable");
            continue;
        };
        let (width, height) = (window.physical_width(), window.physical_height());
        if camera.is_none() || width == 0 || height == 0 || width > 4096 || height > 4096 {
            report_error(
                Some(&token),
                "GPU capture needs a world camera and a 1..4096 pixel window on each axis",
            );
            continue;
        }
        payload["captureSource"] = json!("bevy-gpu-readback");
        let capture_token = token.clone();
        let entity = commands.spawn(Screenshot::primary_window()).observe(move |shot: On<ScreenshotCaptured>, mut lab: ResMut<Lab>| {
            if lab.in_flight.as_ref().is_none_or(|(token, entity, _)| token != &capture_token || *entity != shot.entity) { return; }
            lab.in_flight = None;
            if shot.image.width() > 4096 || shot.image.height() > 4096 || shot.image.width() == 0 || shot.image.height() == 0 {
                report_error(Some(&capture_token), "GPU image dimensions changed outside the capture limit");
                return;
            }
            match shot.image.clone().try_into_dynamic() {
                Ok(image) => {
                    let rgba = image.to_rgba8();
                    match encode_png(rgba.as_raw(), rgba.width(), rgba.height()) {
                        Ok(url) if url.starts_with("data:image/png;base64,") => {
                            let mut result = payload.clone();
                            result["image"] = json!({"dataUrl":url,"width":rgba.width(),"height":rgba.height()});
                            report(&result.to_string());
                        }
                        Ok(_) => report_error(Some(&capture_token), "PNG encoder returned no image"),
                        Err(error) => report_error(Some(&capture_token), &format!("PNG encoding failed: {error:?}")),
                    }
                }
                Err(error) => report_error(Some(&capture_token), &format!("GPU image conversion failed: {error}")),
            }
        }).id();
        lab.in_flight = Some((token, entity, lab.frame));
    }
}
