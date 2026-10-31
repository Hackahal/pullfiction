//! Short illustrative cast cues for logged summons with no recorded position.
//! These end after five yards; they never represent an inferred combat trajectory.
use crate::planner_replay::ReplayControl;
use bevy::prelude::*;

pub(crate) struct CastCue {
    pub source: Entity,
    pub at: f64,
    pub school: u32,
}
#[derive(Component)]
pub(crate) struct Cue {
    at: f64,
    generation: u64,
    origin: Vec3,
    direction: Vec3,
    material: Handle<StandardMaterial>,
}
const DURATION_MS: f64 = 1500.;
const DISTANCE: f32 = 5.;
fn color(school: u32) -> Color {
    let rgb = match school {
        1 => [1., 0.85, 0.35],
        2 => [1., 0.35, 0.08],
        3 => [0.3, 0.85, 0.35],
        4 => [0.35, 0.75, 1.],
        5 => [0.55, 0.25, 0.8],
        6 => [0.75, 0.45, 1.],
        _ => [0.8, 0.8, 0.8],
    };
    Color::srgba(rgb[0], rgb[1], rgb[2], 0.8)
}
pub(crate) fn update(
    mut commands: Commands,
    mut replay: ResMut<ReplayControl>,
    sources: Query<&GlobalTransform>,
    mut cues: Query<(Entity, &Cue, &mut Transform)>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut mesh: Local<Option<Handle<Mesh>>>,
) {
    for (entity, cue, mut transform) in &mut cues {
        let age = replay.time - cue.at;
        if cue.generation != replay.generation || !(0.0..DURATION_MS).contains(&age) {
            materials.remove(cue.material.id());
            commands.entity(entity).despawn();
            continue;
        }
        let t = (age / DURATION_MS) as f32;
        transform.translation = cue.origin + cue.direction * (DISTANCE * t);
        let fade = ((1. - t) / 0.6).clamp(0., 1.);
        let smooth = fade * fade * (3. - 2. * fade);
        if let Some(material) = materials.get_mut(&cue.material) {
            material.base_color.set_alpha(0.8 * smooth);
        }
        transform.scale = Vec3::splat(0.8 + 0.2 * smooth);
    }
    let pending = std::mem::take(&mut replay.pending_cues);
    for cue in pending {
        if replay.time - cue.at >= DURATION_MS {
            continue;
        }
        let Ok(source) = sources.get(cue.source) else {
            continue;
        };
        let origin = source.translation() + Vec3::Y * 1.2;
        let forward = source.forward().as_vec3();
        let direction = Vec3::new(forward.x, 0., forward.z).normalize_or(-Vec3::Z);
        let material = materials.add(StandardMaterial {
            base_color: color(cue.school),
            unlit: true,
            alpha_mode: AlphaMode::Blend,
            ..default()
        });
        let mesh = mesh
            .get_or_insert_with(|| {
                meshes.add(Sphere::new(0.28).mesh().ico(2).expect("valid sphere"))
            })
            .clone();
        commands.spawn((
            Mesh3d(mesh),
            MeshMaterial3d(material.clone()),
            Transform::from_translation(origin),
            Cue {
                at: cue.at,
                generation: replay.generation,
                origin,
                direction,
                material,
            },
        ));
    }
}
