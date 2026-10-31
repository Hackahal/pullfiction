//! Read-only state from the production actor/visual consumers, diagnostic builds only.
use crate::{
    creature_anim::{CastHold, Casting},
    net::{NetEntity, ObjectStore},
    planner_replay::ReplayBody,
};
use bevy::prelude::*;
use serde::Serialize;

#[derive(Default, Resource, Serialize)]
pub struct ActorDiagnostics(pub Vec<ActorState>, pub Vec<CueState>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueState {
    spell_id: u32,
    display_id: Option<u32>,
    illustrative: bool,
    age_ms: f64,
    position: [f32; 3],
    host_scale: [f32; 3],
    fade: f32,
    live_emitters: usize,
    drawn_emitters: usize,
    live_particles: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorState {
    key: String,
    channel_spell: u32,
    casting: Option<u32>,
    hold_animation: Option<u16>,
    hold_spell: Option<u32>,
    channel_visual: Option<u32>,
    channel_kit: Option<u32>,
    catalog_provenance: Option<CatalogProvenance>,
    visual: ActorVisualState,
}
impl ActorState {
    /// Assets and production assembly are ready; visible-particle acceptance is separate.
    pub fn visual_ready(&self) -> bool {
        self.visual.attached
            && self.visual.display.as_ref().is_some_and(|display| {
                display.model_loaded && display.dependencies_ready && display.parts_prepared
            })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActorVisualState {
    attached: bool,
    display: Option<crate::entities::display::DisplayDiagnosticState>,
    live_emitters: usize,
    live_particles: usize,
    drawn_emitters: usize,
    live_ribbons: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogProvenance {
    byte_len: usize,
    fnv1a64: String,
    source_json: String,
}
pub fn install(app: &mut App) {
    app.init_resource::<ActorDiagnostics>()
        .add_systems(PostUpdate, collect);
}
fn collect(
    actors: Query<(
        Entity,
        &ReplayBody,
        &NetEntity,
        &ObjectStore,
        Option<&Casting>,
        Option<&CastHold>,
        Has<crate::entities::VisualAttached>,
    )>,
    creatures: Option<Res<crate::entities::Creatures>>,
    assets: Res<AssetServer>,
    emitters: Query<&benilla_world::particles::ParticleEmitter>,
    ribbons: Query<&benilla_world::ribbons::RibbonTrail>,
    children: Query<&Children>,
    cues: Query<(Entity, &crate::planner_cues::Cue, &Transform)>,
    replay: Res<crate::planner_replay::ReplayControl>,
    spells: Option<Res<crate::ui_action::Spells>>,
    visuals: Option<Res<crate::creature_anim::spell_visual::SpellVisuals>>,
    mut output: ResMut<ActorDiagnostics>,
) {
    output.0 = actors
        .iter()
        .map(|(entity, body, net, store, casting, hold, attached)| {
            let channel_spell = store.0.unit_channel_spell();
            let visual = spells
                .as_ref()
                .and_then(|s| s.catalog.get(channel_spell))
                .map(|s| s.visual);
            ActorState {
                key: body.key.clone(),
                channel_spell,
                casting: casting.map(|c| c.spell_id),
                hold_animation: hold.map(|h| h.anim_id),
                hold_spell: hold.map(|h| h.spell_id),
                channel_visual: visual,
                channel_kit: visual
                    .and_then(|id| visuals.as_ref()?.0.stages(id).map(|s| s.channel)),
                catalog_provenance: visuals
                    .as_ref()
                    .and_then(|v| v.0.modern_graph_provenance())
                    .map(|p| CatalogProvenance {
                        byte_len: p.byte_len,
                        fnv1a64: p.fnv1a64.clone(),
                        source_json: p.source.to_string(),
                    }),
                visual: {
                    let owned: std::collections::HashSet<_> = std::iter::once(entity)
                        .chain(children.iter_descendants(entity))
                        .collect();
                    let pools: Vec<_> = emitters
                        .iter()
                        .filter(|emitter| {
                            emitter
                                .anchor()
                                .is_some_and(|anchor| owned.contains(&anchor))
                        })
                        .collect();
                    ActorVisualState {
                        attached,
                        display: net.display_id.and_then(|id| {
                            crate::entities::display::diagnostic_creature_display(
                                creatures.as_deref()?,
                                id,
                                &assets,
                            )
                        }),
                        live_emitters: pools.len(),
                        live_particles: pools.iter().map(|emitter| emitter.live()).sum(),
                        drawn_emitters: pools.iter().filter(|emitter| emitter.drawn()).count(),
                        live_ribbons: ribbons
                            .iter()
                            .filter(|ribbon| {
                                ribbon.owner().is_some_and(|owner| owned.contains(&owner))
                            })
                            .count(),
                    }
                },
            }
        })
        .collect();
    output.1 = cues
        .iter()
        .map(|(entity, cue, transform)| {
            let owned: std::collections::HashSet<_> = std::iter::once(entity)
                .chain(children.iter_descendants(entity))
                .collect();
            let pools: Vec<_> = emitters
                .iter()
                .filter(|emitter| {
                    emitter
                        .anchor()
                        .is_some_and(|anchor| owned.contains(&anchor))
                })
                .collect();
            let age = replay.time - cue.at;
            CueState {
                spell_id: cue.spell_id,
                display_id: cue.display_id,
                illustrative: true,
                age_ms: age,
                position: benilla_assets::coords::bevy_to_wow(transform.translation),
                host_scale: transform.scale.to_array(),
                fade: cue.frame(replay.time).map_or(0., |(_, alpha)| alpha),
                live_emitters: pools.len(),
                drawn_emitters: pools.iter().filter(|e| e.drawn()).count(),
                live_particles: pools.iter().map(|e| e.live()).sum(),
            }
        })
        .collect();
}
