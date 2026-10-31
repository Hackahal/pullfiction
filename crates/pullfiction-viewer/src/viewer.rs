//! Pull Fiction viewer with free-camera controls and native raid UI. Assets come from browser-local client files.
#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use benilla_assets::coords::{bevy_to_wow, wow_to_bevy};
use benilla_world::{boot, collision::WorldCollision, schedule::WorldStage, view::WorldCamera};
use bevy::prelude::*;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(
    inline_js = "export function report(kind, value) { globalThis.pullfiction?.(kind, value); }"
)]
extern "C" {
    fn report(kind: &str, value: &str);
}

use crate::annotations::{self, Annotations, Payload as Points};

type ReplayActor = benilla_app::planner_replay::ReplayUnit;
// Full-run playback includes all observed trash instances before their deaths.
// Keep a bounded transport, with room for a raid rather than one encounter.
const MAX_REPLAY_FRAME_BYTES: usize = 4_000_000;
const MAX_REPLAY_FRAME_ACTORS: usize = 4096;

/// A separate full-body character-pane copy; the caller sends the baseline appearance snapshot.
#[wasm_bindgen]
pub fn request_actor_inspection(json: &str) -> Result<(), JsValue> {
    if json.len() > 128_000 {
        return Err(JsValue::from_str("Inspection request exceeds 128000 bytes"));
    }
    let request: benilla_app::ActorInspectionRequest =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    request.validate().map_err(JsValue::from_str)?;
    enqueue_inspection(Command::ActorInspection(Some(request)));
    Ok(())
}
#[wasm_bindgen]
pub fn close_actor_inspection() {
    enqueue_inspection(Command::ActorInspection(None));
}
fn enqueue_inspection(command: Command) {
    COMMANDS.with(|queue| {
        let mut queue = queue.borrow_mut();
        queue.retain(|c| !matches!(c, Command::ActorInspection(_)));
        queue.push(command);
    });
}

#[wasm_bindgen]
pub fn set_replay_frame(json: &str) -> Result<(), JsValue> {
    if json.len() > MAX_REPLAY_FRAME_BYTES {
        return Err(JsValue::from_str(&format!(
            "Replay frame too large: {} bytes exceeds the {} byte limit",
            json.len(),
            MAX_REPLAY_FRAME_BYTES
        )));
    }
    let actors: Vec<ReplayActor> =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if actors.len() > MAX_REPLAY_FRAME_ACTORS {
        return Err(JsValue::from_str(&format!(
            "Replay actor limit exceeded: {} actors exceeds {}",
            actors.len(),
            MAX_REPLAY_FRAME_ACTORS
        )));
    }
    if actors.iter().any(|a| {
        a.key.len() > 80
            || a.name.len() > 120
            || !a.facing.is_finite()
            || !a.speed.is_finite()
            || !crate::replay_validation::valid_object_scale(a.scale)
            || a.floor_hint
                .is_some_and(|z| !z.is_finite() || z.abs() > 20000.)
            || a.position
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || v.abs() > 20000.0)
    }) {
        return Err(JsValue::from_str("Invalid replay frame"));
    }
    enqueue(Command::Replay(actors));
    Ok(())
}
#[wasm_bindgen]
pub fn set_replay_camera(json: &str) -> Result<(), JsValue> {
    if json.len() > 200_000 {
        return Err(JsValue::from_str("Camera subjects too large"));
    }
    let keys: Vec<String> =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if keys.len() > 4096 || keys.iter().any(|k| k.len() > 80) {
        return Err(JsValue::from_str("Invalid camera subjects"));
    }
    enqueue(Command::Camera(keys));
    Ok(())
}
#[wasm_bindgen]
pub fn configure_replay_camera(distance: f32, player: &str) -> Result<(), JsValue> {
    if !distance.is_finite() || !(15.0..=60.0).contains(&distance) || player.len() > 80 {
        return Err(JsValue::from_str("Invalid camera options"));
    }
    enqueue(Command::CameraOptions(distance, player.to_string()));
    Ok(())
}
#[wasm_bindgen]
pub fn focus_replay(x: f32, y: f32, z: f32) {
    if [x, y, z].iter().all(|v| v.is_finite() && v.abs() < 20000.0) {
        enqueue(Command::Focus([x, y, z]));
    }
}

#[wasm_bindgen]
pub fn request_portraits(json: &str) -> Result<(), JsValue> {
    if json.len() > 64000 {
        return Err(JsValue::from_str("Too many portrait requests"));
    }
    let requests: Vec<benilla_app::planner_replay::ReplayPortrait> =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if requests.len() > 512 || requests.iter().any(|r| r.key.len() > 80 || r.display == 0) {
        return Err(JsValue::from_str("Invalid portrait request"));
    }
    enqueue(Command::Portraits(requests));
    Ok(())
}
#[wasm_bindgen]
pub fn replay_clock(time: f64, rate: f64, playing: bool) {
    if time.is_finite() && time >= 0.0 && rate.is_finite() && (0.1..=16.0).contains(&rate) {
        enqueue(Command::Clock(time, rate, playing));
    }
}

#[wasm_bindgen]
pub fn replay_events(json: &str, reset: bool) -> Result<(), JsValue> {
    if json.len() > 1_000_000 {
        return Err(JsValue::from_str("Too many combat events"));
    }
    let events: Vec<benilla_app::planner_replay::ReplayEvent> =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if events.len() > 400 {
        return Err(JsValue::from_str("Too many combat events per frame"));
    }
    enqueue(Command::Effects(events, reset));
    Ok(())
}

#[wasm_bindgen]
pub fn set_replay_nameplate_filters(friendly: bool, enemy: bool) {
    enqueue(Command::NameplateFilters(friendly, enemy));
}
#[wasm_bindgen]
pub fn set_replay_nameplates(enabled: bool) {
    enqueue(Command::Nameplates(enabled));
}

#[wasm_bindgen]
pub fn set_raid_frame_size(width: f32, height: f32) {
    if [width, height]
        .iter()
        .all(|n| n.is_finite() && (80.0..=3000.0).contains(n))
    {
        enqueue(Command::RaidFrameSize(width, height));
    }
}
#[wasm_bindgen]
pub fn set_replay_raid_frames(enabled: bool) {
    enqueue(Command::RaidFrames(enabled));
}
#[wasm_bindgen]
pub fn select_replay(key: &str) {
    if key.len() <= 80 {
        enqueue(Command::Select(key.into()));
    }
}

#[derive(Clone, Deserialize)]
struct Raid {
    map: u32,
    name: String,
    spawn: [f32; 3],
    facing: f32,
}
#[derive(Resource)]
struct ActiveRaid {
    raid: Raid,
    changed_at: f32,
}
fn raids() -> Vec<Raid> {
    serde_json::from_str(include_str!("../../../web/planner/raids.json"))
        .expect("Checked raid catalogue")
}
#[wasm_bindgen]
pub fn load_raid(map: u32) -> Result<(), JsValue> {
    let raid = raids()
        .into_iter()
        .find(|r| r.map == map)
        .ok_or_else(|| JsValue::from_str("Unsupported Vanilla raid map"))?;
    enqueue(Command::Raid(raid));
    Ok(())
}

enum Command {
    Raid(Raid),
    RaidFrames(bool),
    RaidFrameSize(f32, f32),
    Select(String),
    Nameplates(bool),
    NameplateFilters(bool, bool),
    Pick(Vec2),
    MapPick([f32; 3]),
    PlanPick(Vec2, u32, bool),
    PlanMapPick([f32; 3], u32, bool),
    AnnotationPick(Vec2),
    BoxSelect(Vec2, Vec2, u32, u32),
    AnnotationHover(Vec2, bool),
    EditorMode(bool),
    Navigate(bool, f32, f32),
    Zoom(f32),
    OrbitPlayer(String),
    Points(Points),
    Home,
    Typing(bool),
    Replay(Vec<ReplayActor>),
    Focus([f32; 3]),
    Camera(Vec<String>),
    CameraOptions(f32, String),
    Effects(Vec<benilla_app::planner_replay::ReplayEvent>, bool),
    Clock(f64, f64, bool),
    Portraits(Vec<benilla_app::planner_replay::ReplayPortrait>),
    ActorInspection(Option<benilla_app::ActorInspectionRequest>),
}

thread_local! {
    static COMMANDS: RefCell<Vec<Command>> = const { RefCell::new(Vec::new()) };
}

fn enqueue(command: Command) {
    COMMANDS.with(|q| {
        let mut q = q.borrow_mut();
        if q.len() < 1024 {
            q.push(command);
        }
    });
}

#[wasm_bindgen]
pub fn pick(x: f32, y: f32) {
    if x.is_finite() && y.is_finite() {
        enqueue(Command::Pick(Vec2::new(x, y)));
    }
}

#[wasm_bindgen]
pub fn zoom_editor(distance: f32) {
    if distance.is_finite() && distance.abs() <= 50. {
        enqueue(Command::Zoom(distance));
    }
}
#[wasm_bindgen]
pub fn set_editor_orbit_player(key: &str) {
    if key.len() <= 80 {
        enqueue(Command::OrbitPlayer(key.to_string()));
    }
}
#[wasm_bindgen]
pub fn navigate_editor(pan: bool, dx: f32, dy: f32) {
    if [dx, dy].iter().all(|n| n.is_finite() && n.abs() <= 5000.) {
        enqueue(Command::Navigate(pan, dx, dy));
    }
}
#[wasm_bindgen]
pub fn set_editor_mode(on: bool) {
    enqueue(Command::EditorMode(on));
}
#[wasm_bindgen]
pub fn select_annotations_rect(x1: f32, y1: f32, x2: f32, y2: f32, mode: u32, epoch: u32) {
    if [x1, y1, x2, y2].iter().all(|v| v.is_finite()) && mode <= 2 {
        enqueue(Command::BoxSelect(
            Vec2::new(x1, y1),
            Vec2::new(x2, y2),
            mode,
            epoch,
        ));
    }
}
#[wasm_bindgen]
pub fn hover_annotation(x: f32, y: f32, placing: bool) {
    if x.is_finite() && y.is_finite() {
        enqueue(Command::AnnotationHover(Vec2::new(x, y), placing));
    }
}
#[wasm_bindgen]
pub fn pick_annotation(x: f32, y: f32) {
    if x.is_finite() && y.is_finite() {
        enqueue(Command::AnnotationPick(Vec2::new(x, y)));
    }
}
#[wasm_bindgen]
pub fn preview_annotation(x: f32, y: f32, token: u32) {
    if x.is_finite() && y.is_finite() {
        enqueue(Command::PlanPick(Vec2::new(x, y), token, true));
    }
}
#[wasm_bindgen]
pub fn preview_map_annotation(x: f32, y: f32, z: f32, token: u32) {
    if [x, y, z].iter().all(|v| v.is_finite() && v.abs() < 20000.) {
        enqueue(Command::PlanMapPick([x, y, z], token, true));
    }
}
#[wasm_bindgen]
pub fn pick_for_annotation(x: f32, y: f32, token: u32) {
    if x.is_finite() && y.is_finite() {
        enqueue(Command::PlanPick(Vec2::new(x, y), token, false));
    }
}
#[wasm_bindgen]
pub fn pick_map_for_annotation(x: f32, y: f32, z: f32, token: u32) {
    if [x, y, z].iter().all(|v| v.is_finite() && v.abs() < 20000.) {
        enqueue(Command::PlanMapPick([x, y, z], token, false));
    }
}
#[wasm_bindgen]
pub fn pick_map(x: f32, y: f32, height: f32) {
    if [x, y, height]
        .iter()
        .all(|v| v.is_finite() && v.abs() < 20000.0)
    {
        enqueue(Command::MapPick([x, y, height]));
    }
}

#[wasm_bindgen]
pub fn set_typing(enabled: bool) {
    enqueue(Command::Typing(enabled));
}

#[wasm_bindgen]
pub fn home() {
    enqueue(Command::Home);
}

#[wasm_bindgen]
pub fn set_annotations(json: &str) -> Result<(), JsValue> {
    if json.len() > 5_000_000 {
        return Err(JsValue::from_str("Plan is too large"));
    }
    let points: Points =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if !points.valid() {
        return Err(JsValue::from_str("Invalid plan geometry"));
    }
    enqueue(Command::Points(points));
    Ok(())
}

/// Explicit boot lets the page register its callbacks before the engine starts.
#[wasm_bindgen]
pub fn start() {
    console_error_panic_hook::set_once();
    let mut app = App::new();
    let data = benilla_formats::wow_data().expect("Browser data endpoint");
    benilla_assets::register_mpq_source(&mut app, &data).expect("Register local assets");
    app.insert_resource(benilla_world::build_id::BuildId {
        version: env!("CARGO_PKG_VERSION"),
        profile: "planner",
        extended: true,
        ..default()
    });
    app.insert_resource(benilla_world::world_map::StartMap(409));
    app.insert_resource(ActiveRaid {
        raid: raids().into_iter().find(|r| r.map == 409).unwrap(),
        changed_at: 0.0,
    });
    app.add_plugins(boot::tuned_default_plugins(Window {
        title: "Pull Fiction".into(),
        resolution: (1440, 900).into(),
        ..default()
    }));
    app.add_plugins(benilla_world::world_plugins::WorldPlugins);
    app.insert_resource(benilla_world::schedule::WorldLive(true));
    annotations::install(&mut app);
    benilla_app::planner_sandbox::install(&mut app);
    benilla_app::planner_replay::install(&mut app);
    crate::renderer_diagnostics::install(&mut app);
    app.add_systems(
        Update,
        commands
            .in_set(WorldStage::Input)
            .before(benilla_app::planner_sandbox::SandboxInput),
    );
    app.add_systems(Update, (telemetry, actor_labels));
    benilla_assets::register_asset_loaders(&mut app);
    app.run();
}

fn commands(
    cameras: Query<(&Camera, &GlobalTransform), With<WorldCamera>>,
    mut sandbox: ResMut<benilla_app::planner_sandbox::SandboxControl>,
    world: WorldCollision,
    actors: Query<(&benilla_app::planner_replay::ReplayBody, &GlobalTransform)>,
    mut replay: ResMut<benilla_app::planner_replay::ReplayControl>,
    mut inspection: ResMut<benilla_app::ActorInspectionControl>,
    mut points: ResMut<Annotations>,
    mut interaction: ResMut<annotations::Interaction>,
    mut current_map: ResMut<benilla_world::world_map::CurrentMap>,
    mut active: ResMut<ActiveRaid>,
    mut progress: ResMut<benilla_world::terrain_stream::WorldLoadProgress>,
    time: Res<Time>,
    ui: Option<NonSend<benilla_ui::script::UiScript>>,
    windows: Query<&Window>,
) {
    let ui_owns_point = |pixel| {
        ui.as_deref().is_some_and(|script| {
            let height = windows.single().map(|w| w.height()).unwrap_or(768.);
            benilla_app::planner_sandbox::ui_owns_point(script, pixel, height)
        })
    };
    let batch = COMMANDS.with(|q| std::mem::take(&mut *q.borrow_mut()));
    let Ok((camera, global)) = cameras.single() else {
        return;
    };
    for command in batch {
        match command {
            Command::Raid(raid) => {
                current_map.0 = raid.map;
                sandbox.location = Some((raid.spawn, raid.facing));
                sandbox.home = true;
                replay.pending = Some(Vec::new());
                replay.focus = None;
                replay.focus_actor = None;
                replay.camera_keys.clear();
                replay.select = Some(String::new());
                replay.events.clear();
                replay.reset = true;
                sandbox.orbit_player = None;
                progress.scene_ready = false;
                active.raid = raid;
                active.changed_at = time.elapsed_secs();
            }
            Command::RaidFrames(on) => replay.raid_frames = on,
            Command::RaidFrameSize(width, height) => replay.raid_frame_size = [width, height],
            Command::Select(key) => replay.select = Some(key),
            Command::Nameplates(on) => replay.nameplates = Some(on),
            Command::NameplateFilters(friendly, enemy) => {
                replay.nameplates = Some(friendly || enemy);
                replay.friendly_nameplates = Some(friendly);
                replay.enemy_nameplates = Some(enemy);
            }
            Command::Focus(at) => replay.focus = Some(at),
            Command::Camera(keys) => replay.camera_keys = keys,
            Command::CameraOptions(distance, player) => {
                replay.camera_max_distance = distance;
                sandbox.orbit_distance_max = distance;
                replay.camera_locked_player = player;
            }
            Command::Replay(actors) => replay.pending = Some(actors),
            Command::Portraits(requests) => replay.portrait_requests.extend(requests),
            Command::ActorInspection(request) => inspection.pending = Some(request),
            Command::Clock(time, rate, playing) => {
                replay.time = time;
                replay.rate = rate;
                replay.playing = playing;
            }
            Command::Effects(events, reset) => {
                if reset {
                    replay.events.clear();
                }
                replay.events.extend(events);
                replay.reset |= reset;
            }
            Command::Home => sandbox.home = true,
            Command::Typing(enabled) => sandbox.typing = enabled,
            Command::OrbitPlayer(key) => sandbox.orbit_player = (!key.is_empty()).then_some(key),
            Command::Zoom(distance) => sandbox.zoom += distance,
            Command::Navigate(pan, dx, dy) => sandbox.navigation.push((pan, dx, dy)),
            Command::EditorMode(on) => {
                interaction.editing = on;
                if !on {
                    interaction.hover = None;
                    interaction.point = None;
                    interaction.placing = false;
                }
            }
            Command::Points(p) => {
                let revision = points.revision;
                points.replace(p);
                if points.revision != revision {
                    points.conform(&world);
                }
            }
            Command::BoxSelect(a, b, mode, epoch) => {
                if ui_owns_point(a) {
                    continue;
                }
                points.update_actor_anchors(&actors);
                let min = a.min(b);
                let max = a.max(b);
                let actor_keys: Vec<_> = actors
                    .iter()
                    .filter_map(|(actor, xf)| {
                        let p = camera
                            .world_to_viewport(global, xf.translation() + Vec3::Y)
                            .ok()?;
                        (p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y)
                            .then_some(actor.key.clone())
                    })
                    .collect();
                report("marks",&serde_json::json!({"ids":points.box_hits(camera,global,a,b),"actors":actor_keys,"mode":mode,"epoch":epoch}).to_string());
            }
            Command::AnnotationHover(pixel, placing) => {
                points.update_actor_anchors(&actors);
                let native_ui = ui_owns_point(pixel);
                let valid = pixel.x >= 0. && pixel.y >= 0. && !native_ui;
                let handle = if valid && !placing {
                    points.handle_hit(camera, global, pixel)
                } else {
                    None
                };
                let id = handle.map(|h| h.0).or_else(|| {
                    if valid && !placing {
                        points.hit(camera, global, pixel)
                    } else {
                        None
                    }
                });
                let locked = id
                    .and_then(|id| points.marks.iter().find(|m| m.id == id))
                    .is_some_and(|m| m.locked);
                let point = if valid {
                    camera
                        .viewport_to_world(global, pixel)
                        .ok()
                        .and_then(|ray| {
                            world
                                .ray_body(ray.origin, ray.direction, 1200.)
                                .map(|hit| bevy_to_wow(ray.origin + *ray.direction * hit.distance))
                        })
                } else {
                    None
                };
                interaction.hover = id.map(str::to_owned);
                interaction.hover_handle = handle.map(|h| h.1);
                interaction.point = point;
                interaction.placing = placing && valid;
                let actor = if valid {
                    actors
                        .iter()
                        .filter_map(|(a, xf)| {
                            let feet = camera
                                .world_to_viewport(global, xf.translation() + Vec3::Y * 0.4)
                                .ok()?;
                            let head = camera
                                .world_to_viewport(
                                    global,
                                    xf.translation() + Vec3::Y * a.label_height,
                                )
                                .ok()?;
                            let delta = head - feet;
                            let t = if delta.length_squared() > 0.001 {
                                ((pixel - feet).dot(delta) / delta.length_squared()).clamp(0., 1.)
                            } else {
                                0.
                            };
                            Some((a.key.as_str(), (feet + delta * t).distance(pixel)))
                        })
                        .filter(|(_, d)| *d < 24.)
                        .min_by(|a, b| a.1.total_cmp(&b.1))
                        .map(|(key, _)| key)
                } else {
                    None
                };
                let view = global.compute_transform();
                let flatten = |v: Vec3| {
                    let p = bevy_to_wow(v);
                    Vec2::new(p[0], p[1]).normalize_or_zero()
                };
                let right = flatten(*view.right());
                let mut up = flatten(*view.up());
                if up.length_squared() < 0.01 {
                    up = flatten(*view.forward());
                }
                let anchor_pixel = id
                    .and_then(|id| points.marks.iter().find(|m| m.id == id))
                    .and_then(|m| {
                        camera
                            .world_to_viewport(global, wow_to_bevy(m.anchor) + Vec3::Y * 0.2)
                            .ok()
                    })
                    .map(|p| p.to_array());
                report("plan-hover",&serde_json::json!({"nativeUI":native_ui,"anchorPixel":anchor_pixel,"pixel":pixel.to_array(),"right":right.to_array(),"up":up.to_array(),"actor":actor,"hits":if valid {points.hits(camera,global,pixel)}else{vec![]},"id":id,"handle":handle.map(|h|h.1),"point":point,"locked":locked}).to_string());
            }
            Command::AnnotationPick(pixel) => {
                if let Some(id) = points.hit(camera, global, pixel) {
                    report("mark", id);
                }
            }
            Command::PlanMapPick(at, token, preview) => {
                let origin = wow_to_bevy([at[0], at[1], at[2] + 50.]);
                let point = world
                    .ray_body(origin, Dir3::NEG_Y, 2000.)
                    .map(|hit| bevy_to_wow(origin + Vec3::NEG_Y * hit.distance));
                report(
                    "plan-point",
                    &serde_json::json!({"token":token,"point":point,"preview":preview}).to_string(),
                );
            }
            Command::PlanPick(pixel, token, preview) => {
                let point = camera
                    .viewport_to_world(global, pixel)
                    .ok()
                    .and_then(|ray| {
                        world
                            .ray_body(ray.origin, ray.direction, 1200.)
                            .map(|hit| bevy_to_wow(ray.origin + *ray.direction * hit.distance))
                    });
                report(
                    "plan-point",
                    &serde_json::json!({"token":token,"point":point,"preview":preview}).to_string(),
                );
            }
            Command::MapPick(at) => {
                let origin = wow_to_bevy([at[0], at[1], at[2] + 50.0]);
                if let Some(hit) = world.ray_body(origin, Dir3::NEG_Y, 2000.0) {
                    let point = bevy_to_wow(origin + Vec3::NEG_Y * hit.distance);
                    report("point", &serde_json::to_string(&point).unwrap());
                } else {
                    report(
                        "notice",
                        "No loaded ground at this map point. Move the 3D view here first.",
                    );
                }
            }
            Command::Pick(pixel) => {
                if let Ok(ray) = camera.viewport_to_world(global, pixel) {
                    if let Some(hit) = world.ray_body(ray.origin, ray.direction, 1200.0) {
                        let point = bevy_to_wow(ray.origin + *ray.direction * hit.distance);
                        report("point", &serde_json::to_string(&point).unwrap());
                    } else {
                        report(
                            "notice",
                            "No surface here yet. Aim at a visible floor or wall, or wait for geometry to load.",
                        );
                    }
                }
            }
        }
    }
}

fn telemetry(
    time: Res<Time>,
    mut last: Local<f32>,
    camera: Query<&Transform, With<WorldCamera>>,
    progress: Res<benilla_world::terrain_stream::WorldLoadProgress>,
    instances: Query<(), With<benilla_world::wmo_portal::WmoPortalInstance>>,
    active: Res<ActiveRaid>,
) {
    if time.elapsed_secs() - *last < 1.0 {
        return;
    }
    *last = time.elapsed_secs();
    if let Ok(xf) = camera.single() {
        let at = bevy_to_wow(xf.translation);
        if time.elapsed_secs() - active.changed_at > 0.5
            && !instances.is_empty()
            && progress.presentable()
        {
            report("scene", &active.raid.map.to_string());
        }
        report(
            "status",
            &format!(
                "{} · {} instance · X {:.0}  Y {:.0}  Z {:.0}",
                active.raid.name,
                instances.iter().count(),
                at[0],
                at[1],
                at[2]
            ),
        );
    }
}

fn actor_labels(
    time: Res<Time>,
    mut known: Local<std::collections::HashSet<u32>>,
    mut last: Local<f32>,
    mut replay: ResMut<benilla_app::planner_replay::ReplayControl>,
) {
    if let Some(key) = replay.focus_actor.take() {
        report("focus-actor", &key);
    }
    if time.elapsed_secs() - *last < 0.05 {
        return;
    }
    *last = time.elapsed_secs();
    let fresh: Vec<_> = replay
        .visual_diagnostics
        .iter()
        .filter_map(|(spell, value)| known.insert(*spell).then_some(value))
        .collect();
    if !fresh.is_empty() {
        report(
            "visualDiagnostics",
            &serde_json::to_string(&fresh).unwrap_or_default(),
        );
    }
    report("actors",&serde_json::json!({"visualEvents":replay.visual_events,"unsupported":replay.unsupported.len(),"selected":replay.selected_key}).to_string());
}
