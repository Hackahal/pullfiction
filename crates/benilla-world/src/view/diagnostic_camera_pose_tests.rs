//! Self-authored schedule regression; no game data or GPU needed.
use super::*;

#[test]
fn diagnostic_pin_must_precede_the_pose_published_for_pvs() {
    fn published(ordered: bool) -> Quat {
        let mut app = App::new();
        crate::view::plugin(&mut app);
        app.world_mut().spawn((
            crate::view::WorldCamera,
            Transform::IDENTITY,
            GlobalTransform::IDENTITY,
        ));
        app.add_systems(
            Update,
            (|mut camera: Query<&mut Transform, With<crate::view::WorldCamera>>| {
                camera.single_mut().unwrap().rotation = Quat::IDENTITY;
            })
            .in_set(crate::schedule::WorldStage::Input),
        );
        let pin = |mut camera: Query<&mut Transform, With<crate::view::WorldCamera>>| {
            camera.single_mut().unwrap().rotation = Quat::from_rotation_y(1.234);
        };
        if ordered {
            app.add_systems(
                Update,
                pin.after(crate::schedule::WorldStage::Input)
                    .before(crate::view::CameraPoseSet),
            );
        } else {
            // The bad interleaving permitted when a pin is unordered with CameraPoseSet.
            app.add_systems(
                Update,
                pin.after(crate::schedule::WorldStage::Input)
                    .after(crate::view::CameraPoseSet),
            );
        }
        app.update();
        app.world_mut()
            .query_filtered::<&GlobalTransform, With<crate::view::WorldCamera>>()
            .single(app.world())
            .unwrap()
            .rotation()
    }
    let before = published(false);
    let after = published(true);
    let desired = Quat::from_rotation_y(1.234);
    println!(
        "late-pin angle error={} ordered angle error={}",
        before.angle_between(desired),
        after.angle_between(desired)
    );
    assert!(
        before.angle_between(desired) > 1.0,
        "the late pin reproduces the mismatched PVS/render pose"
    );
    assert!(after.angle_between(desired) < 0.0001);
}
