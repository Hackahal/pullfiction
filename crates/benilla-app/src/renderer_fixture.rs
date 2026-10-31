//! Explicit browser diagnostics using the production spell-effect model assembly path.
use std::collections::HashSet;

use benilla_assets::{coords::wow_to_bevy, m2_url, materials::WowModelMaterial, M2Model};
use bevy::{asset::LoadState, mesh::skinning::SkinnedMeshInverseBindposes, prelude::*};
use serde::{Deserialize, Serialize};

use crate::{
    creature_anim::FxStage,
    entities::{
        display::{empty_shell, ModelHandle},
        spell_fx::{attach_effect_visuals, EffectHost, FxMaterials, FxTintAnims, SpellFx},
        DisplayBuildSet,
    },
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererModelFixture {
    pub key: String,
    pub path: String,
    pub position: [f32; 3],
    pub scale: f32,
    pub animation: Option<u16>,
}

impl RendererModelFixture {
    pub fn validate(&self) -> Result<(), &'static str> {
        let numeric = self
            .path
            .strip_prefix("__classic/")
            .and_then(|path| path.strip_suffix(".m2"));
        if self.key.is_empty()
            || self.key.len() > 80
            || self.path.len() > 64
            || !numeric.is_some_and(|id| {
                !id.is_empty()
                    && id.len() <= 10
                    && id.bytes().all(|c| c.is_ascii_digit())
                    && id.parse::<u32>().is_ok_and(|id| id != 0)
            })
        {
            return Err("Model fixtures need a key and a numeric __classic/<ID>.m2 virtual path");
        }
        if self
            .position
            .iter()
            .any(|n| !n.is_finite() || n.abs() > 20000.)
            || !self.scale.is_finite()
            || !(0.001..=100.).contains(&self.scale)
        {
            return Err("Invalid model fixture position or scale");
        }
        Ok(())
    }
}

#[derive(Default, Resource)]
pub struct RendererFixtureControl {
    /// Replaces the prior fixtures. An empty vector clears diagnostic model instances.
    pub pending: Option<Vec<RendererModelFixture>>,
    pub statuses: Vec<RendererFixtureStatus>,
    entries: Vec<Entry>,
    owned_paths: HashSet<String>,
}

struct Entry {
    request: RendererModelFixture,
    owner: Entity,
    root: Entity,
    attached: bool,
}

/// Diagnostic subject ancestry, including untagged production attachment meshes.
#[derive(Component)]
pub struct RendererFixtureRoot;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererFixtureStatus {
    pub key: String,
    pub path: String,
    pub loaded: bool,
    pub dependencies_ready: bool,
    pub attached: bool,
    pub mesh_instances: usize,
    pub loaded_meshes: usize,
    pub authored_emitters: Option<usize>,
    pub authored_ribbons: Option<usize>,
    pub live_emitters: usize,
    pub live_particles: usize,
    pub live_ribbons: usize,
    pub error: Option<String>,
}

pub fn install(app: &mut App) {
    app.init_resource::<RendererFixtureControl>()
        .add_systems(
            Update,
            (prepare, ensure_models).chain().before(DisplayBuildSet),
        )
        .add_systems(Update, attach.after(DisplayBuildSet))
        .add_systems(
            PostUpdate,
            status.after(benilla_world::billboard::BillboardPlace),
        );
}

fn ensure_models(
    mut control: ResMut<RendererFixtureControl>,
    mut fx: ResMut<SpellFx>,
    asset_server: Res<AssetServer>,
) {
    let missing: Vec<_> = control
        .entries
        .iter()
        .filter(|entry| !fx.models.contains_key(&entry.request.path))
        .map(|entry| entry.request.path.clone())
        .collect();
    for path in missing {
        let mut model = empty_shell();
        model.handle = ModelHandle::M2(asset_server.load(m2_url(&path)));
        fx.models.insert(path.clone(), model);
        control.owned_paths.insert(path);
    }
}

fn prepare(
    mut commands: Commands,
    mut control: ResMut<RendererFixtureControl>,
    mut fx: ResMut<SpellFx>,
    asset_server: Res<AssetServer>,
    children: Query<&Children>,
    ribbons: Query<(Entity, &benilla_world::ribbons::RibbonTrail)>,
) {
    let Some(requests) = control.pending.take() else {
        return;
    };
    let old: HashSet<_> = control
        .entries
        .iter()
        .flat_map(|entry| {
            std::iter::once(entry.owner).chain(children.iter_descendants(entry.owner))
        })
        .collect();
    for (entity, ribbon) in &ribbons {
        if ribbon.owner().is_some_and(|owner| old.contains(&owner)) {
            commands.entity(entity).try_despawn();
        }
    }
    for entry in control.entries.drain(..) {
        commands.entity(entry.owner).try_despawn();
    }
    for path in control.owned_paths.drain() {
        fx.models.remove(&path);
    }
    control.statuses.clear();
    // The bridge stays bounded even if a future caller skips the viewer's validation.
    if requests.len() > 64 || requests.iter().any(|request| request.validate().is_err()) {
        return;
    }
    for request in requests {
        if !fx.models.contains_key(&request.path) {
            let mut model = empty_shell();
            model.handle = ModelHandle::M2(asset_server.load(m2_url(&request.path)));
            fx.models.insert(request.path.clone(), model);
            control.owned_paths.insert(request.path.clone());
        }
        let owner = commands
            .spawn((
                Transform::from_translation(wow_to_bevy(request.position))
                    .with_scale(Vec3::splat(request.scale)),
                Visibility::default(),
                RendererFixtureRoot,
            ))
            .id();
        let root = commands
            .spawn((Transform::IDENTITY, Visibility::default(), ChildOf(owner)))
            .id();
        control.entries.push(Entry {
            request,
            owner,
            root,
            attached: false,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn attach(
    mut commands: Commands,
    mut control: ResMut<RendererFixtureControl>,
    fx: Res<SpellFx>,
    time: Res<Time>,
    mut materials: ResMut<Assets<WowModelMaterial>>,
    mut tint: ResMut<FxTintAnims>,
    mut uv: ResMut<benilla_world::doodad_anim::UvAnimMaterials>,
    mut table: ResMut<benilla_world::mat_anim_table::MatAnimTable>,
    ibps: Res<Assets<SkinnedMeshInverseBindposes>>,
    mut palettes: ResMut<benilla_world::rig_palette::RigPalettes>,
) {
    for entry in control.entries.iter_mut().filter(|entry| !entry.attached) {
        let Some(model) = fx.models.get(&entry.request.path) else {
            continue;
        };
        entry.attached = attach_effect_visuals(
            &mut commands,
            entry.root,
            model,
            time.elapsed_secs(),
            false,
            // A diagnostic model is destroyed between cases. The existing attached-owner
            // lifecycle frees emitter pools AND their geometry-particle instances together.
            EffectHost {
                parent: Some(entry.owner),
            },
            Some(FxStage::State),
            &mut FxMaterials {
                store: &mut materials,
                tint: &mut tint,
                uv: &mut uv,
                table: &mut table,
            },
            &ibps,
            &mut palettes,
            entry.request.animation,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn status(
    mut control: ResMut<RendererFixtureControl>,
    fx: Res<SpellFx>,
    asset_server: Res<AssetServer>,
    models: Res<Assets<M2Model>>,
    meshes: Res<Assets<Mesh>>,
    children: Query<&Children>,
    mesh_instances: Query<&Mesh3d>,
    emitters: Query<&benilla_world::particles::ParticleEmitter>,
    ribbons: Query<&benilla_world::ribbons::RibbonTrail>,
) {
    if control.entries.is_empty() {
        return;
    }
    control.statuses = control
        .entries
        .iter()
        .map(|entry| {
            let handle = fx
                .models
                .get(&entry.request.path)
                .and_then(|model| match &model.handle {
                    ModelHandle::M2(handle) => Some(handle),
                    _ => None,
                });
            let model = handle.and_then(|handle| models.get(handle));
            let owned: HashSet<_> = std::iter::once(entry.root)
                .chain(children.iter_descendants(entry.root))
                .collect();
            let attached_meshes: Vec<_> = owned
                .iter()
                .copied()
                .filter_map(|entity| mesh_instances.get(entity).ok())
                .collect();
            let pools: Vec<_> = emitters
                .iter()
                .filter(|emitter| emitter.anchor() == Some(entry.root))
                .collect();
            let error = handle.and_then(|handle| match asset_server.get_load_state(handle.id()) {
                Some(LoadState::Failed(error)) => {
                    Some(error.to_string().chars().take(2048).collect())
                }
                _ => None,
            });
            RendererFixtureStatus {
                key: entry.request.key.clone(),
                path: entry.request.path.clone(),
                loaded: model.is_some(),
                dependencies_ready: handle
                    .is_some_and(|h| asset_server.is_loaded_with_dependencies(h.id())),
                attached: entry.attached,
                mesh_instances: attached_meshes.len(),
                loaded_meshes: attached_meshes
                    .iter()
                    .filter(|mesh| meshes.contains(mesh.0.id()))
                    .count(),
                authored_emitters: model.map(|model| model.emitters.len()),
                authored_ribbons: model.map(|model| model.ribbons.len()),
                live_emitters: pools.len(),
                live_particles: pools.iter().map(|emitter| emitter.live()).sum(),
                live_ribbons: ribbons
                    .iter()
                    .filter(|ribbon| ribbon.owner().is_some_and(|owner| owned.contains(&owner)))
                    .count(),
                error,
            }
        })
        .collect();
}
