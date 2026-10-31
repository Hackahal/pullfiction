//! Selected-player editor orbit geometry, shared with native unit tests.
use bevy::prelude::*;

/// Bound orbit gestures with the world's camera sphere sweep.
/// The caller supplies the stock collision query; movement stops before the hit.
pub(crate) fn clear_camera_motion(
    from: Vec3,
    desired: Vec3,
    mut cast: impl FnMut(Vec3, Vec3) -> Option<f32>,
) -> Vec3 {
    let delta = desired - from;
    let length = delta.length();
    if length < 0.0001 {
        return desired;
    }
    let allowed = cast(from, delta)
        .map(|hit| (hit - 0.02).max(0.))
        .unwrap_or(length)
        .min(length);
    from + delta / length * allowed
}
pub(crate) fn orbit_camera(
    xf: &mut Transform,
    target: Vec3,
    delta: Vec2,
    zoom: f32,
    max_distance: f32,
) {
    let distance = (xf.translation.distance(target) - zoom).clamp(2., max_distance.max(2.));
    let direction = target - xf.translation;
    if direction.length_squared() > 0.001 {
        xf.look_at(target, Vec3::Y);
    }
    let (yaw, pitch, _) = xf.rotation.to_euler(EulerRot::YXZ);
    xf.rotation = Quat::from_euler(
        EulerRot::YXZ,
        yaw - delta.x * 0.005,
        (pitch - delta.y * 0.005).clamp(-1.48, 1.48),
        0.,
    );
    xf.translation = target - *xf.forward() * distance;
}

/// Keep editor selection out of the client's look latch. The ordinary free camera
/// receives the original right-button edges and raw motion unchanged.
pub(crate) fn editor_mouse_input(
    input: &ButtonInput<MouseButton>,
    orbit: bool,
) -> ButtonInput<MouseButton> {
    let mut filtered = input.clone();
    filtered.reset(MouseButton::Left);
    if orbit {
        filtered.reset(MouseButton::Right);
    }
    filtered
}
/// Scene selection must yield to the native raid frames and other mouse-enabled UI.
pub fn ui_owns_point(script: &benilla_ui::script::UiScript, pixel: Vec2, height: f32) -> bool {
    let point = crate::ui_script::window_to_ui(height, pixel);
    script
        .hit_test(point.x, point.y)
        .is_some_and(|id| !script.is_world_frame(id))
}
#[cfg(test)]
mod camera_tests {
    use super::*;
    #[test]
    fn bounded_orbit_motion_stops_before_a_reported_floor_hit() {
        let from = Vec3::new(10., 0.5, 20.);
        let desired = from + Vec3::new(0., -2., -3.);
        let hit = 0.2 * (desired - from).length();
        let safe = clear_camera_motion(from, desired, |origin, delta| {
            assert_eq!(origin, from);
            assert_eq!(delta, desired - from);
            Some(hit)
        });
        assert!(safe.y > 0.1);
        assert!(safe.distance(from) < hit);
        assert_eq!(clear_camera_motion(from, desired, |_, _| None), desired);
    }
    #[test]
    fn orbit_uses_the_native_camera_sphere_against_solid_floors() {
        use avian3d::prelude::*;
        use benilla_world::collision::{MoverTraceExclusions, WorldCollision, CAMERA_PROBE_RADIUS};
        use bevy::ecs::system::RunSystemOnce;

        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            bevy::transform::TransformPlugin,
            bevy::asset::AssetPlugin::default(),
            bevy::scene::ScenePlugin,
            PhysicsPlugins::new(PostUpdate),
        ));
        app.init_asset::<Mesh>();
        app.init_resource::<MoverTraceExclusions>();
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(20., 0.2, 20.),
            Transform::from_xyz(0., -0.1, 0.),
        ));
        app.finish();
        app.cleanup();
        app.update();
        let safe = app
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                clear_camera_motion(Vec3::Y, Vec3::new(0., -1., -2.), |from, delta| {
                    world.cast_camera(from, delta, false)
                })
            })
            .unwrap();
        assert!(safe.y >= CAMERA_PROBE_RADIUS);
        assert!(safe.y < 0.5, "the sweep should reach the floor: {safe:?}");
    }
    #[test]
    fn editor_camera_never_pushes_past_a_near_wall_or_away_from_its_goal() {
        let from = Vec3::new(10., 3., 20.);
        let desired = from + Vec3::Z * 4.;
        assert_eq!(clear_camera_motion(from, desired, |_, _| Some(0.01)), from);
        assert_eq!(
            clear_camera_motion(from, desired, |_, _| Some(20.)),
            desired
        );
        assert_eq!(
            clear_camera_motion(from, from, |_, _| panic!("zero sweep")),
            from
        );
    }
    #[test]
    fn orbit_uses_the_selected_player_as_its_pivot_and_preserves_distance() {
        let target = Vec3::new(120., 25., -35.);
        let mut camera = Transform::from_translation(target + Vec3::new(0., 10., 20.))
            .looking_at(target, Vec3::Y);
        let distance = camera.translation.distance(target);
        orbit_camera(&mut camera, target, Vec2::new(50., -20.), 0., 40.);
        assert!((camera.translation.distance(target) - distance).abs() < 0.001);
        assert!((*camera.forward()).dot((target - camera.translation).normalize()) > 0.999);
    }
    #[test]
    fn orbit_zoom_stays_between_two_yards_and_the_configured_maximum() {
        let target = Vec3::ZERO;
        let mut camera = Transform::from_translation(Vec3::Z * 20.).looking_at(target, Vec3::Y);
        orbit_camera(&mut camera, target, Vec2::ZERO, 100., 30.);
        assert!((camera.translation.length() - 2.).abs() < 0.001);
        orbit_camera(&mut camera, target, Vec2::ZERO, -100., 30.);
        assert!((camera.translation.length() - 30.).abs() < 0.001);
    }
    #[test]
    fn free_camera_retains_native_right_press_hold_and_release_while_left_selects() {
        let mut buttons = ButtonInput::default();
        buttons.press(MouseButton::Left);
        buttons.press(MouseButton::Right);
        let press = editor_mouse_input(&buttons, false);
        assert!(press.just_pressed(MouseButton::Right));
        assert!(press.pressed(MouseButton::Right));
        assert!(!press.pressed(MouseButton::Left));
        assert!(!press.just_pressed(MouseButton::Left));
        assert!(buttons.pressed(MouseButton::Left)); // the native UI still sees its input
        buttons.clear();
        let held = editor_mouse_input(&buttons, false);
        assert!(held.pressed(MouseButton::Right));
        assert!(!held.just_pressed(MouseButton::Right));
        buttons.release(MouseButton::Right);
        assert!(editor_mouse_input(&buttons, false).just_released(MouseButton::Right));
    }
    #[test]
    fn custom_orbit_does_not_also_start_native_mouse_look() {
        let mut buttons = ButtonInput::default();
        buttons.press(MouseButton::Right);
        let orbit = editor_mouse_input(&buttons, true);
        assert!(!orbit.pressed(MouseButton::Right));
        assert!(!orbit.just_pressed(MouseButton::Right));
    }
    #[test]
    fn native_raid_frames_own_scene_clicks_and_double_click_requests_focus() {
        use benilla_ui::script::UiScript;
        let mut script = UiScript::new().unwrap();
        script.set_screen_size(1024., 768.);
        script.run(r#"WorldFrame=CreateFrame('WorldFrame','WorldFrame');WorldFrame:SetAllPoints();WorldFrame:EnableMouse(true)"#).unwrap();
        script.run(include_str!("planner_raid.lua")).unwrap();
        script.run(r#"PullFictionRaid_Update({{guid='123',name='Mage',class=8,hp=100,max=100,power=100,maxpower=100,powertype=0,auras={}}},true,1,5,1)"#).unwrap();
        script.resolve();
        assert!(ui_owns_point(&script, Vec2::new(20., 20.), 768.));
        assert!(ui_owns_point(&script, Vec2::new(40., 40.), 1536.));
        assert!(!ui_owns_point(&script, Vec2::new(300., 300.), 768.));
        script.mouse_move(20., 748.);
        script.mouse_button(20., 748., "LeftButton", true);
        script.mouse_button(20., 748., "LeftButton", false);
        assert_eq!(
            script
                .eval::<String>("return PullFictionPlateClick")
                .unwrap(),
            "123"
        );
        assert!(script
            .eval::<Option<String>>("return PullFictionRaidFocus")
            .unwrap()
            .is_none());
        script.tick(0.1);
        script.mouse_button(20., 748., "LeftButton", true);
        script.mouse_button(20., 748., "LeftButton", false);
        assert_eq!(
            script
                .eval::<String>("return PullFictionRaidFocus")
                .unwrap(),
            "123"
        );
        assert!(script.errors().is_empty(), "{:?}", script.errors());
    }
    #[test]
    fn unrelated_mouse_buttons_are_preserved() {
        let mut buttons = ButtonInput::default();
        buttons.press(MouseButton::Middle);
        buttons.press(MouseButton::Other(4));
        let native = editor_mouse_input(&buttons, false);
        assert!(native.just_pressed(MouseButton::Middle));
        assert!(native.just_pressed(MouseButton::Other(4)));
    }
}
