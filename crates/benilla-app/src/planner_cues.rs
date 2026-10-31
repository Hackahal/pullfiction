//! Short illustrative cast cues for logged summons with no recorded position.
//! These end after five yards; they never represent an inferred combat trajectory.
use crate::creature_anim::{
    spell_visual::{resolve_kit, resolve_kit_effects, SpellVisuals},
    FxClass, FxStage, SpellKitFx,
};
use crate::entities::Creatures;
use crate::planner_replay::ReplayControl;
use bevy::prelude::*;

#[path = "planner_cue_motion.rs"]
mod motion;

pub(crate) struct CastCue {
    pub source: Entity,
    pub at: f64,
    pub school: u32,
    pub spell_id: u32,
}
#[derive(Component)]
pub(crate) struct Cue {
    pub(crate) at: f64,
    generation: u64,
    origin: Vec3,
    direction: Vec3,
    material: Option<Handle<StandardMaterial>>,
    pub(crate) spell_id: u32,
    pub(crate) display_id: Option<u32>,
}
impl Cue {
    pub(crate) fn frame(&self, replay_time: f64) -> Option<(f32, f32)> {
        motion::sample(replay_time - self.at)
    }
}
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
    creatures: Option<Res<Creatures>>,
    spells: Option<Res<crate::ui_action::Spells>>,
    visuals: Option<Res<SpellVisuals>>,
    mut effects: MessageWriter<SpellKitFx>,
) {
    for (entity, cue, mut transform) in &mut cues {
        let frame = cue.frame(replay.time);
        if cue.generation != replay.generation || frame.is_none() {
            if let Some(material) = &cue.material {
                materials.remove(material.id());
            }
            commands.entity(entity).despawn();
            continue;
        }
        let (distance, smooth) = frame.unwrap();
        transform.translation = cue.origin + cue.direction * distance;
        commands
            .entity(entity)
            .insert(benilla_world::model_fade::ModelFade(smooth));
        if let Some(material) = cue.material.as_ref().and_then(|h| materials.get_mut(h)) {
            material.base_color.set_alpha(0.8 * smooth);
            transform.scale = Vec3::splat(0.8 + 0.2 * smooth);
        }
    }
    let pending = std::mem::take(&mut replay.pending_cues);
    for cue in pending {
        if motion::sample(replay.time - cue.at).is_none() {
            continue;
        }
        let Ok(source) = sources.get(cue.source) else {
            continue;
        };
        let origin = source.translation() + Vec3::Y * 1.2;
        let forward = source.forward().as_vec3();
        let direction = Vec3::new(forward.x, 0., forward.z).normalize_or(-Vec3::Z);
        if let Some(presentation) = spells
            .as_ref()
            .and_then(|s| s.catalog.summon_cue(cue.spell_id))
        {
            // This temporary host carries authored visual data only. It is neither a player
            // aura nor a claimed reconstruction of the invisible NPC's server trajectory.
            let Some(scale) = creatures
                .as_ref()
                .and_then(|c| c.model_scale(presentation.display_id))
            else {
                continue;
            };
            let Some(kit) =
                spells
                    .as_deref()
                    .zip(visuals.as_deref())
                    .and_then(|(spells, visuals)| {
                        resolve_kit(
                            spells,
                            &visuals.0,
                            presentation.visual_spell_id,
                            |s| s.state,
                            || None,
                        )
                    })
            else {
                continue;
            };
            let slots = resolve_kit_effects(&visuals.as_ref().unwrap().0, &kit);
            if slots.is_empty() {
                continue;
            }
            // The selected NPC's authored attachment offset already sets its visual height.
            let origin = source.translation();
            let host = commands
                .spawn((
                    Transform::from_translation(origin)
                        .with_rotation(source.rotation())
                        .with_scale(Vec3::splat(scale)),
                    Visibility::default(),
                    // The host is an intentionally empty attachment frame. Effect models still
                    // load and assemble through the ordinary SpellKitFx path.
                    crate::entities::VisualAttached,
                    benilla_world::model_fade::ModelFade(1.),
                    Cue {
                        at: cue.at,
                        generation: replay.generation,
                        origin,
                        direction,
                        material: None,
                        spell_id: cue.spell_id,
                        display_id: Some(presentation.display_id),
                    },
                ))
                .id();
            effects.write(SpellKitFx::Begin {
                entity: host,
                spell_id: presentation.visual_spell_id,
                persistent: true,
                class: FxClass::AuraState,
                stage: FxStage::State,
                effects: slots,
            });
            continue;
        }
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
                material: Some(material),
                spell_id: cue.spell_id,
                display_id: None,
            },
        ));
    }
}
