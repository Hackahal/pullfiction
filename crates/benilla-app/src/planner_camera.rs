//! Player-anchored follow, after the normal free-camera input owner finishes.
use crate::planner_camera_math::{
    camera_cut, candidate_keys, capped_position, clear_boom, ease, player_shot, AnchorHold, Subject,
};
use crate::{
    planner_replay::{ReplayBody, ReplayControl},
    player::camera::FlyCam,
};
use benilla_world::{collision::WorldCollision, schedule::WorldStage, view::WorldCamera};
use bevy::prelude::*;
#[derive(Default)]
struct Rig {
    active: bool,
    pivot: Vec3,
    look: Vec3,
    goal: Vec3,
    yaw: f32,
    next: f32,
    anchor: AnchorHold,
    generation: u64,
    maximum: f32,
    locked: String,
}
pub(crate) fn install(app: &mut App) {
    app.add_systems(
        Update,
        follow
            .after(WorldStage::Input)
            .after(crate::planner_sandbox::SandboxCameraConstraint)
            .before(WorldStage::Stream),
    );
}
#[allow(clippy::type_complexity)]
fn follow(
    time: Res<Time>,
    control: Res<ReplayControl>,
    world: WorldCollision,
    bodies: Query<(&ReplayBody, &Transform, &Visibility), Without<WorldCamera>>,
    mut cameras: Query<
        (&mut Transform, &mut FlyCam, &Projection),
        (With<WorldCamera>, Without<ReplayBody>),
    >,
    mut rig: Local<Rig>,
) {
    if control.camera_keys.is_empty() {
        *rig = Rig::default();
        return;
    }
    let keys: std::collections::HashSet<_> =
        control.camera_keys.iter().map(String::as_str).collect();
    let mut subjects: Vec<_> = bodies
        .iter()
        .filter(|(b, _, v)| **v != Visibility::Hidden && keys.contains(b.key.as_str()))
        .map(|(b, t, _)| Subject {
            key: b.key.clone(),
            point: t.translation + Vec3::Y * (b.label_height * 0.5).clamp(1., 6.),
            player: b.raid,
            weight: if b.raid {
                1.
            } else if b.friendly {
                0.35
            } else {
                2.
            },
        })
        .collect();
    subjects.sort_by(|a, b| a.key.cmp(&b.key));
    let Ok((mut xf, mut fly, projection)) = cameras.single_mut() else {
        return;
    };
    let (fov, aspect) = match projection {
        Projection::Perspective(p) => (p.fov, p.aspect_ratio),
        _ => (1., 1.5),
    };
    let maximum = if control.camera_max_distance >= 15. {
        control.camera_max_distance.min(60.)
    } else {
        40.
    };
    let reset = !rig.active || rig.generation != control.generation;
    if reset {
        let Some(first) = subjects.iter().find(|s| s.player) else {
            return;
        };
        let boom = xf.translation - first.point;
        rig.yaw = boom.x.atan2(boom.z);
        rig.anchor = AnchorHold::default();
        rig.next = 0.;
        rig.generation = control.generation;
        rig.active = true;
    }
    let missing = rig
        .anchor
        .key
        .as_ref()
        .is_some_and(|key| !subjects.iter().any(|s| s.player && &s.key == key));
    if missing || rig.maximum != maximum || rig.locked != control.camera_locked_player {
        rig.next = 0.;
    }
    let now = time.elapsed_secs();
    let cut = reset
        || rig
            .anchor
            .key
            .as_ref()
            .and_then(|key| subjects.iter().find(|s| &s.key == key))
            .is_some_and(|anchor| camera_cut(false, rig.pivot, anchor.point, maximum));
    if cut {
        rig.next = 0.;
    }
    if now >= rig.next {
        let candidates = candidate_keys(
            &subjects,
            rig.anchor.key.as_deref(),
            &control.camera_locked_player,
        );
        let shots: Vec<_> = candidates
            .iter()
            .filter_map(|key| subjects.iter().find(|s| &s.key == key))
            .map(|a| {
                player_shot(
                    a,
                    &subjects,
                    rig.yaw,
                    maximum,
                    fov,
                    aspect,
                    |from, delta| world.cast_camera(from, delta, false),
                )
            })
            .collect();
        if let Some(key) = rig
            .anchor
            .select(&shots, now, &control.camera_locked_player)
        {
            if let Some(shot) = shots.iter().find(|s| s.key == key) {
                if let Some(a) = subjects.iter().find(|s| s.key == key) {
                    rig.pivot = a.point;
                }
                rig.goal = shot.position;
                rig.look = shot.look;
                rig.yaw = shot.yaw;
            }
        }
        rig.maximum = maximum;
        rig.locked = control.camera_locked_player.clone();
        rig.next = now + 0.4;
    }
    let Some(anchor) = rig
        .anchor
        .key
        .as_ref()
        .and_then(|k| subjects.iter().find(|s| &s.key == k))
    else {
        return;
    };
    let pivot = anchor.point;
    if rig.pivot == Vec3::ZERO {
        rig.pivot = pivot;
    }
    // Carry the chosen shot with the anchor between scoring passes. The player's
    // facing is deliberately ignored; turning around must not orbit the camera.
    let movement = pivot - rig.pivot;
    rig.goal += movement;
    rig.look += movement;
    rig.pivot = pivot;
    let dt = time.delta_secs();
    let desired = if cut {
        rig.goal
    } else {
        xf.translation.lerp(rig.goal, ease(dt, 4.))
    };
    let bounded = capped_position(pivot, desired, maximum);
    let next = clear_boom(pivot, bounded - pivot, |from, delta| {
        world.cast_camera(from, delta, false)
    });
    if xf.translation != next {
        xf.translation = next;
    }
    if next.distance_squared(rig.look) > 0.01 {
        let goal = Transform::from_translation(next)
            .looking_at(rig.look, Vec3::Y)
            .rotation;
        let rotation = if cut {
            goal
        } else {
            xf.rotation.slerp(goal, ease(dt, 7.))
        };
        if xf.rotation != rotation {
            xf.rotation = rotation;
        }
        let (yaw, pitch, _) = xf.rotation.to_euler(EulerRot::YXZ);
        fly.park(yaw, pitch);
    }
}
