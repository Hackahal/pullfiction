//! Offline observer and stock FrameXML adapter for a browser raid planner.
//! No login, realm connection or combat simulation is started by this adapter.

pub use crate::planner_editor_camera::ui_owns_point;
use crate::planner_editor_camera::{clear_camera_motion, orbit_camera};
use benilla_assets::coords::wow_to_bevy;
use benilla_world::{schedule::WorldStage, view::WorldCamera};
use bevy::prelude::*;

use crate::{client_state::ClientState, game_plugins::GamePlugins, net, player};

#[derive(Resource, Default)]
struct CameraMotionStart(Option<Vec3>);

const GUID: u64 = 0xB377;
const SPAWN: [f32; 3] = [1080.0, -481.0, -108.0];

/// The embedding page's free-camera navigation and reset requests.
#[derive(Resource, Default)]
pub struct SandboxControl {
    pub home: bool,
    /// Per-raid entry point supplied by the planner's checked map catalogue.
    pub location: Option<([f32; 3], f32)>,
    /// True while a DOM input owns the keyboard.
    pub typing: bool,
    /// Editor pan/orbit deltas in screen pixels. Page input owns this gesture.
    pub navigation: Vec<(bool, f32, f32)>,
    pub zoom: f32,
    pub orbit_player: Option<String>,
    pub orbit_distance_max: f32,
}

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct SandboxInput;

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SandboxCameraConstraint;

/// Add after DefaultPlugins and WorldPlugins. Reuses the full game's existing UI and controller.
pub fn install(app: &mut App) {
    app.add_plugins(GamePlugins {
        connect: false,
        start: ClientState::InWorld,
    });
    app.init_resource::<SandboxControl>()
        .init_resource::<CameraMotionStart>();
    benilla_ui::web_saved::set_reader(crate::local_state::read);
    app.add_systems(PostStartup, seed);
    app.add_systems(
        Update,
        apply_control
            .in_set(SandboxInput)
            .after(crate::planner_replay::apply)
            .before(player::PlayerControlSet)
            .in_set(WorldStage::Input),
    );
    app.add_systems(
        Update,
        constrain_camera
            .after(WorldStage::Input)
            .before(WorldStage::Stream)
            .in_set(SandboxCameraConstraint),
    );
    app.add_systems(
        Update,
        stock_ui
            .after(crate::ui_script::UiFeed)
            .run_if(crate::ui_script::ingame_ui_up),
    );
}

fn seed(
    mut commands: Commands,
    mut player: ResMut<player::Player>,
    mut self_guid: ResMut<net::SelfGuid>,
    mut index: ResMut<net::GuidIndex>,
    mut names: ResMut<crate::names::NameCache>,
) {
    self_guid.0 = Some(GUID);
    names.insert_player(GUID, "Observer".into(), None);
    let fields = crate::planner_observer::fields(GUID);
    // A model-free identity keeps native UI and camera bootstrap alive. Omitting
    // NetEntity prevents the normal model attachment pipeline from creating an avatar.
    let entity = commands
        .spawn((
            net::Guid(GUID),
            net::SelfPlayer,
            net::ObjectStore(fields),
            Transform::from_translation(wow_to_bevy(SPAWN))
                .with_rotation(Quat::from_rotation_y(-1.05)),
            Visibility::Hidden,
        ))
        .id();
    index.0.insert(GUID, entity);
    player.pos = wow_to_bevy(SPAWN);
    player.active = true;
    player.detached = true;
    player.settling = true;
    player.world_stale = true;
    player.settle_deadline = 60.0;
}

fn apply_control(
    mut control: ResMut<SandboxControl>,
    mut player: ResMut<player::Player>,
    mut camera: Query<(&mut Transform, &mut player::camera::FlyCam), With<WorldCamera>>,
    mut body: Query<&mut Transform, (With<net::SelfPlayer>, Without<WorldCamera>)>,
    mut initialized: Local<bool>,
    mut keys: ResMut<ButtonInput<KeyCode>>,
    time: Res<Time>,
    mut ui_capture: ResMut<crate::ui_script::UiKeyboardCapture>,
    actors: Query<(&crate::planner_replay::ReplayBody, &GlobalTransform)>,
    mut orbit_previous: Local<Option<(String, Vec3)>>,
    mut motion_start: ResMut<CameraMotionStart>,
    world: benilla_world::collision::WorldCollision,
) {
    if control.typing {
        keys.clear();
        ui_capture.typing = true;
    }
    // The stock controller still supplies free-flight input; it never drives an avatar.
    player.detached = true;
    if !*initialized || control.home {
        *initialized = true;
        let (spawn, facing) = control.location.unwrap_or((SPAWN, -1.05));
        player.pos = wow_to_bevy(spawn);
        player.settle_since = time.elapsed_secs();
        player.settle_deadline = time.elapsed_secs() + 90.0;
        // The existing hand-over clears jump velocity, autorun and stale movement flags.
        player.reseat = true;
        player.settling = true;
        player.world_stale = true;
        if let Ok(mut xf) = body.single_mut() {
            xf.translation = player.pos;
            xf.rotation = Quat::from_rotation_y(facing);
        }
        if let Ok((mut xf, mut fly)) = camera.single_mut() {
            let (eye, target) = if control.location.is_none() || spawn == SPAWN {
                ([1080.0, -481.0, -102.0], [1100.0, -516.0, -105.0])
            } else {
                (
                    [spawn[0], spawn[1], spawn[2] + 6.0],
                    [
                        spawn[0] + facing.cos() * 20.0,
                        spawn[1] + facing.sin() * 20.0,
                        spawn[2] + 2.0,
                    ],
                )
            };
            *xf = Transform::from_translation(wow_to_bevy(eye))
                .looking_at(wow_to_bevy(target), Vec3::Y);
            let (yaw, pitch, _) = xf.rotation.to_euler(EulerRot::YXZ);
            fly.park(yaw, pitch);
        }
        control.home = false;
    }
    let gestures = std::mem::take(&mut control.navigation);
    let zoom = std::mem::take(&mut control.zoom).clamp(-50., 50.);
    let has_navigation = !gestures.is_empty();
    let orbit = control.orbit_player.as_ref().and_then(|key| {
        actors
            .iter()
            .find(|(body, _)| &body.key == key)
            .map(|(body, xf)| {
                (
                    key.clone(),
                    xf.translation() + Vec3::Y * (body.label_height * 0.6),
                )
            })
    });
    if let Ok((mut xf, mut fly)) = camera.single_mut() {
        // Free camera deliberately passes through geometry. Only an active
        // orbit below enables the post-input collision sweep.
        motion_start.0 = None;
        if let Some((key, target)) = &orbit {
            if let Some((previous_key, previous_target)) = orbit_previous.as_ref() {
                if previous_key == key {
                    xf.translation += *target - *previous_target;
                }
            }
        }
        let max_distance = if control.orbit_distance_max >= 15. {
            control.orbit_distance_max
        } else {
            40.
        };
        if zoom != 0. {
            if let Some((_, target)) = &orbit {
                orbit_camera(&mut xf, *target, Vec2::ZERO, zoom, max_distance);
            } else {
                let forward = *xf.forward();
                xf.translation += forward * zoom;
            }
        }
        for (pan, dx, dy) in gestures {
            if pan {
                let right = *xf.right();
                let up = *xf.up();
                xf.translation += (-right * dx + up * dy) * 0.06;
            } else if let Some((_, target)) = &orbit {
                orbit_camera(&mut xf, *target, Vec2::new(dx, dy), 0., max_distance);
            }
        }
        if let Some((_, target)) = &orbit {
            xf.translation = clear_camera_motion(*target, xf.translation, |from, delta| {
                world.cast_camera(from, delta, false)
            });
            // The pivot boom already bounds the orbit's movement, including following a moving
            // actor. Only subsequent native free-flight input needs the incremental sweep.
            motion_start.0 = Some(xf.translation);
        }
        if zoom != 0. || orbit.is_some() || has_navigation {
            let (yaw, pitch, _) = xf.rotation.to_euler(EulerRot::YXZ);
            fly.park(yaw, pitch);
        }
    }
    *orbit_previous = orbit;
}

fn constrain_camera(
    start: Res<CameraMotionStart>,
    world: benilla_world::collision::WorldCollision,
    mut camera: Query<&mut Transform, With<WorldCamera>>,
) {
    if let (Some(from), Ok(mut xf)) = (start.0, camera.single_mut()) {
        xf.translation = clear_camera_motion(from, xf.translation, |from, delta| {
            world.cast_camera(from, delta, false)
        });
    }
}

fn stock_ui(mut vm: crate::script_calls::HostedVm, mut applied: Local<Option<u64>>) {
    vm.run(|script| {
        let Some(script) = script else {
            return;
        };
        let key = script.session();
        if *applied == Some(key) {
            return;
        }
        if !script
            .eval::<bool>("return UIParent ~= nil")
            .unwrap_or(false)
        {
            return;
        }
        // Raid frames and nameplates use WorldFrame; the avatar HUD is not part of the editor.
        let code = "UIParent:Hide()";
        match script.run(code) {
            Ok(()) => *applied = Some(key),
            Err(error) => warn!("planner: stock interface mode failed: {error}"),
        }
    });
}
