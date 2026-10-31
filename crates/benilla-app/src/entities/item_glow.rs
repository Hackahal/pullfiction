//! Item glows: the permanent glow an item display authors and the glow a weapon enchant carries,
//! `Spells\Enchantments` models hung on the item's own model, not the wearer's body.
//!
//! The chain is `ItemDisplayInfo` column 22, then `ItemVisuals`, then five `ItemVisualEffects`
//! models ([`benilla_formats::ItemVisualCatalog`]). The held-item attach passes the display's own
//! id (`0x47a200` into `0x4798c0`, attaching at `0x479700` when it is above 0); the helm, shoulder
//! and quiver sites pass a literal 0, so on a body only hand items glow, and the ammo lane
//! (`0x479f40`) passes its own. `0x479700` hangs effect i on the item model's attachment id i
//! (`0x712f70`). An item model rests at bind pose, so each glow is a plain child of the item root:
//! it goes with a gear change and moves with a sheath swap.

use std::collections::HashMap;

use benilla_formats::{EnchantCatalog, ItemVisualCatalog, ITEM_VISUAL_SLOTS};
use bevy::prelude::*;

use benilla_assets::m2_url;
use benilla_assets::materials::WowModelMaterial;

use super::equipment::{ItemDisplays, ItemModelKind};
use super::spell_fx::{attach_effect_visuals, EffectHost, FxMaterials, FxTintAnims};
use super::{DisplayModel, ModelHandle};

/// The joined `ItemVisuals`/`ItemVisualEffects` catalog and a path-keyed [`DisplayModel`] per glow
/// model. Without it nothing glows; without [`crate::items::Enchants`] only enchant glows go quiet.
#[derive(Resource)]
pub(crate) struct ItemGlows {
    pub(super) visuals: ItemVisualCatalog,
    pub(super) models: HashMap<String, DisplayModel>,
}

impl ItemGlows {
    pub(super) fn new(visuals: ItemVisualCatalog) -> Self {
        ItemGlows {
            visuals,
            models: HashMap::new(),
        }
    }

    /// The glow models by attach slot; `None` when the id names no row (0, the shipped `-1`s).
    pub(super) fn effects(&self, visual: i32) -> Option<&[Option<String>; ITEM_VISUAL_SLOTS]> {
        self.visuals.effects(visual)
    }
}

/// The ItemVisuals id an item glows with, the fork of `0x62ec70` (per weapon slot, `0x5eed50`):
/// the base display's id when it names a row, which suppresses the enchant's, else the first
/// enchant slot with a nonzero visual, else 0.
pub(in crate::entities) fn effective_visual(
    glows: &ItemGlows,
    enchants: Option<&EnchantCatalog>,
    base: i32,
    item_enchants: impl IntoIterator<Item = u32>,
) -> i32 {
    if glows.visuals.effects(base).is_some() {
        return base;
    }
    let Some(enchants) = enchants else { return 0 };
    for enchant in item_enchants {
        if let Some(visual) = enchants.visual(enchant) {
            return visual;
        }
    }
    0
}

/// Create a visual's glow-model cache entries, so `super::update_display_models` builds them the
/// frame the equipment resolve asks.
pub(in crate::entities) fn ensure_glow_models(
    glows: &mut ItemGlows,
    visual: i32,
    asset_server: &AssetServer,
) {
    let Some(paths) = glows.visuals.effects(visual) else {
        return;
    };
    // Collected first: `effects` borrows the catalog, and the insert below borrows the cache.
    let wanted: Vec<String> = paths
        .iter()
        .flatten()
        .filter(|p| !glows.models.contains_key(*p))
        .cloned()
        .collect();
    for path in wanted {
        let handle = ModelHandle::M2(asset_server.load(m2_url(&path)));
        glows.models.insert(
            path,
            DisplayModel {
                handle,
                ..super::empty_shell()
            },
        );
    }
}

/// A held-item root that should carry a glow, written by `super::equipment`'s attach and consumed
/// once by [`attach_item_glows`].
#[derive(Component)]
pub(in crate::entities) struct ItemGlow {
    pub(in crate::entities) display: u32,
    pub(in crate::entities) kind: ItemModelKind,
    pub(in crate::entities) visual: i32,
    /// The item's seat on the body ([`super::BoneAttach`]), kept to place the portrait mirrors:
    /// the attach path that knew it is gone by the time the glow models load.
    pub(in crate::entities) bone: u16,
    pub(in crate::entities) offset: bevy::prelude::Vec3,
    /// The item's M2 attachment id on the body: a glow chains under its item (`0x712f70`), so a
    /// widget's attach reset takes both together.
    pub(in crate::entities) attach: u16,
}

/// The item's glow instances are spawned, or there were none. As children of the root they go
/// with a gear change and move, live particles and all, with a sheath swap.
#[derive(Component)]
pub(crate) struct ItemGlowAttached;

/// Spawn each pending item's glow instances, one per authored slot at that slot's attachment point
/// on the item model; all or nothing, so the set waits while any of its models loads.
pub(super) fn attach_item_glows(
    mut commands: Commands,
    pending: Query<(Entity, &ItemGlow), Without<ItemGlowAttached>>,
    glows: Option<Res<ItemGlows>>,
    items: Option<Res<ItemDisplays>>,
    time: Res<Time>,
    mut wow_materials: ResMut<Assets<WowModelMaterial>>,
    mut tint_reg: ResMut<FxTintAnims>,
    mut uv_reg: ResMut<benilla_world::doodad_anim::UvAnimMaterials>,
    mut anim_table: ResMut<benilla_world::mat_anim_table::MatAnimTable>,
    ibps: Res<Assets<bevy::mesh::skinning::SkinnedMeshInverseBindposes>>,
    mut palettes: ResMut<benilla_world::rig_palette::RigPalettes>,
    // The session's first spawned glow is logged once at info level.
    mut logged: Local<bool>,
) {
    let (Some(glows), Some(items)) = (glows, items) else {
        return;
    };
    let now = time.elapsed_secs();
    for (root, glow) in &pending {
        let Some(paths) = glows.effects(glow.visual) else {
            commands.entity(root).insert(ItemGlowAttached); // nothing to hang
            continue;
        };
        let Some(item) = items.models.get(&(glow.display, glow.kind)) else {
            continue; // the item's display entry was evicted: retry
        };
        // Ready: every model has built its parts; an emitter-only model's empty list is `Some`.
        let ready = paths
            .iter()
            .flatten()
            .all(|p| glows.models.get(p).is_some_and(|dm| dm.parts.is_some()));
        if !ready {
            continue;
        }
        let mut spawned = 0usize;
        for (slot, path) in paths
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.as_ref().map(|p| (i, p)))
        {
            let Some(dm) = glows.models.get(path) else {
                continue;
            };
            // A model without this slot's attachment hangs nothing there, as in the reference:
            // `0x712f70` stores `0x710310`'s miss as `0xffff`, whose child `0x7140aa`, `0x718668`
            // and `0x719266` skip. Common: Ironfoe's hammer authors only ids 2 to 4.
            let Some(at) =
                crate::portrait::attachment_point(&item.skeleton, &item.attachments, slot as u16)
            else {
                debug!(
                    "item glow: display {} has no attachment {slot} for {path}",
                    glow.display
                );
                continue;
            };
            let instance = commands
                .spawn((Transform::from_translation(at), Visibility::default()))
                .id();
            commands.entity(root).add_child(instance);
            // The portrait mirrors, at the item's seat plus this slot's point. The shared spell-fx
            // lane stamps none, as a spell's effect must never reach a portrait, so the glow's
            // come from here; 32 of the 35 shipped glow models are pure emitters.
            let seat = glow.offset + at;
            for p in dm.parts.iter().flatten() {
                match &p.billboard {
                    Some(info) => {
                        commands.entity(instance).with_child((
                            Transform::default(),
                            Visibility::default(),
                            crate::portrait::PortraitBillboard {
                                mesh: p.mesh.clone(),
                                material: p.material.clone(),
                                bone: glow.bone,
                                seat: crate::portrait::PortraitSeat::Rider(seat + info.pivot),
                                kind: info.kind,
                                attach: Some(glow.attach),
                            },
                        ));
                    }
                    None => {
                        commands.entity(instance).with_child((
                            Transform::default(),
                            Visibility::default(),
                            crate::portrait::PortraitRider {
                                static_mesh: p.mesh.clone(),
                                material: p.material.clone(),
                                bone: glow.bone,
                                offset: seat,
                                attach: Some(glow.attach),
                            },
                        ));
                    }
                }
            }
            if !dm.emitters.is_empty() {
                commands
                    .entity(instance)
                    .insert(crate::portrait::PortraitEffects {
                        bone: glow.bone,
                        offset: seat,
                        attach: Some(glow.attach),
                        emitters: dm.emitters.clone(),
                        rig: None,
                    });
            }
            attach_effect_visuals(
                &mut commands,
                instance,
                dm,
                now,
                false, // a weapon glow is never ground-anchored
                // Chained to the item root (`0x712f70`) and through it to the wearer, so it fades
                // in with the body and dies with the weapon.
                EffectHost { parent: Some(root) },
                // Not armed by `PlaySpellVisualKit`: no kit stage, the plain single-clip arm.
                None,
                &mut FxMaterials {
                    store: &mut wow_materials,
                    tint: &mut tint_reg,
                    uv: &mut uv_reg,
                    table: &mut anim_table,
                },
                &ibps,
                &mut palettes,
                None, // the glow models author one looping sequence
            );
            spawned += 1;
        }
        commands.entity(root).insert(ItemGlowAttached);
        // What spawned, not what the row authors: they differ where the model lacks a point.
        let authored = paths.iter().flatten().count();
        if !*logged && spawned > 0 {
            *logged = true;
            info!(
                "item glow: display {} visual {} → {spawned} of {authored} model(s) attached \
                 (the first this session)",
                glow.display, glow.visual,
            );
        }
        debug!(
            "item glow: display {} visual {} → {spawned} of {authored} model(s)",
            glow.display, glow.visual,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_item_glow_waits_attaches_authored_slot_and_frees_with_weapon() {
        let bytes = serde_json::to_vec(&serde_json::json!({"schema":1,
            "displays":{"8":{"visual":7}}, "itemVisuals":{"7":[0,0,0,77,0]},
            "enchantments":{"9":{"visual":7,"flags":0,"name":"Authored"}}}))
        .unwrap();
        let catalog = benilla_formats::ItemDisplayCatalog::from_modern_json(&bytes).unwrap();
        let visuals = ItemVisualCatalog::from_modern_json(&bytes).unwrap();
        let enchants = EnchantCatalog::from_modern_json(&bytes).unwrap();
        let mut glows = ItemGlows::new(visuals);
        let visual = effective_visual(
            &glows,
            Some(&enchants),
            catalog.get(8).unwrap().item_visual,
            [9],
        );
        assert_eq!(visual, 7);
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .init_resource::<Assets<Image>>()
            .init_resource::<Assets<WowModelMaterial>>()
            .init_resource::<Assets<bevy::mesh::skinning::SkinnedMeshInverseBindposes>>()
            .init_resource::<FxTintAnims>()
            .init_resource::<benilla_world::doodad_anim::UvAnimMaterials>()
            .init_resource::<benilla_world::mat_anim_table::MatAnimTable>()
            .init_resource::<benilla_world::rig_palette::RigPalettes>()
            .init_resource::<benilla_world::particles::ParticleTuning>()
            .init_resource::<benilla_world::particles::buffer::EffectQuads>()
            .init_resource::<benilla_world::view::ViewDistance>()
            .init_resource::<benilla_world::wmo_portal::CameraInteriorClaim>()
            .init_resource::<benilla_world::liquid::Underwater>()
            .init_resource::<avian3d::collider_tree::ColliderTrees>()
            .add_systems(Update, attach_item_glows);
        app.world_mut().spawn((
            benilla_world::view::WorldCamera,
            Camera::default(),
            Projection::default(),
            Transform::default(),
            GlobalTransform::default(),
            bevy::camera::primitives::Frustum::default(),
        ));
        let texture = app
            .world_mut()
            .resource_mut::<Assets<Image>>()
            .add(Image::default());
        let effect = DisplayModel {
            parts: None,
            emitters: vec![benilla_assets::ModelEmitter {
                def: benilla_world::testing::plain_particle_def(),
                texture: Some(texture.clone()),
                extra_textures: None,
                bone_pivot: [0.0; 3],
                billboard: None,
                recursion: None,
                geometry: None,
                owner_reach: 0.0,
                water_bound: (Vec3::ZERO, 0.0),
                idle_seq: 0,
            }],
            ..super::super::display::empty_shell()
        };
        glows.models.insert("__classic/77.m2".into(), effect);
        let item = DisplayModel {
            skeleton: benilla_assets::ModelSkeleton {
                joints: vec![benilla_assets::ModelJoint {
                    parent: -1,
                    local_translation: Vec3::ZERO,
                    billboard: None,
                    parent_arm: None,
                }],
                ..Default::default()
            },
            attachments: vec![benilla_assets::ModelAttachment {
                id: 3,
                bone: 0,
                offset: Vec3::new(1.0, 2.0, 3.0),
            }],
            ..super::super::display::empty_shell()
        };
        app.world_mut().insert_resource(ItemDisplays {
            catalog,
            models: HashMap::from([((8, ItemModelKind::Weapon), item)]),
        });
        app.world_mut().insert_resource(glows);
        let weapon = app
            .world_mut()
            .spawn((
                Transform::default(),
                Visibility::default(),
                ItemGlow {
                    display: 8,
                    kind: ItemModelKind::Weapon,
                    visual,
                    bone: 0,
                    offset: Vec3::ZERO,
                    attach: 1,
                },
            ))
            .id();
        app.update();
        assert!(
            app.world().get::<ItemGlowAttached>(weapon).is_none(),
            "wait for every model"
        );
        app.world_mut()
            .resource_mut::<ItemGlows>()
            .models
            .get_mut("__classic/77.m2")
            .unwrap()
            .parts = Some(Vec::new());
        app.update();
        assert!(app.world().get::<ItemGlowAttached>(weapon).is_some());
        let mut query = app
            .world_mut()
            .query::<(Entity, &benilla_world::particles::ParticleEmitter)>();
        let (pool, emitter) = query.single(app.world()).expect("real glow emitter pool");
        let instance = emitter.anchor().unwrap();
        assert_eq!(emitter.texture(), &texture);
        assert_eq!(
            app.world().get::<Transform>(instance).unwrap().translation,
            Vec3::new(1.0, 2.0, 3.0)
        );
        app.world_mut().entity_mut(weapon).despawn();
        assert!(
            app.world().get_entity(instance).is_err(),
            "glow instance belongs to its weapon"
        );
        benilla_world::particles::simulate_for_test(app.world_mut());
        assert!(
            app.world().get_entity(pool).is_err(),
            "production owner-loss policy frees the glow pool"
        );
    }

    fn catalog(visual_rows: &[u32], enchant_rows: &[(u32, i32)]) -> (ItemGlows, EnchantCatalog) {
        let visuals = visual_rows
            .iter()
            .map(|id| {
                (
                    *id,
                    std::array::from_fn(|i| {
                        (i == 3).then(|| format!("Spells\\Enchantments\\Row{id}.mdx"))
                    }),
                )
            })
            .collect();
        (
            ItemGlows::new(ItemVisualCatalog::from_visuals(visuals)),
            EnchantCatalog::from_rows(
                enchant_rows.iter().copied().collect(),
                HashMap::new(),
                Default::default(),
            ),
        )
    }

    #[test]
    fn base_visual_wins_over_enchant_and_suppresses_it() {
        let (glows, ench) = catalog(&[25, 61], &[(1, 61), (7, 25)]);
        let ench = Some(&ench);
        assert_eq!(effective_visual(&glows, ench, 25, [1]), 25);
        assert_eq!(effective_visual(&glows, ench, 0, [1]), 61);
        // An enchant without a visual is walked past, not the end of the scan.
        assert_eq!(effective_visual(&glows, ench, 0, [999, 7]), 25);
        assert_eq!(effective_visual(&glows, ench, 0, [999]), 0);
        // The shipped `-1` base is not a row: it neither glows nor suppresses the enchant.
        assert_eq!(effective_visual(&glows, ench, -1, [1]), 61);
        assert_eq!(effective_visual(&glows, ench, -1, []), 0);
    }

    #[test]
    fn without_the_enchant_catalog_only_the_base_leg_answers() {
        let (glows, _) = catalog(&[25, 61], &[(1, 61)]);
        assert_eq!(effective_visual(&glows, None, 25, [1]), 25);
        assert_eq!(effective_visual(&glows, None, 0, [1]), 0);
    }
}
