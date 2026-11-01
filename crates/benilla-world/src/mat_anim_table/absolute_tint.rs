//! Exact per-material RGB samples without rebuilding a material's bindings each frame.

use super::MatAnimTable;
use benilla_assets::materials::WowModelMaterial;
use bevy::asset::AssetId;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;

/// Owns animation rows for changing model-particle colours. The material is touched only when
/// selecting its row, or when the bounded table is full and the original uniform path is needed.
#[derive(Resource, Default)]
pub struct AbsoluteTintMaterials(HashMap<AssetId<WowModelMaterial>, u16>);

impl AbsoluteTintMaterials {
    pub fn set(
        &mut self,
        table: &mut MatAnimTable,
        materials: &mut Assets<WowModelMaterial>,
        id: AssetId<WowModelMaterial>,
        tint: Vec4,
    ) {
        set_sample(
            &mut self.0,
            table,
            materials,
            id,
            tint,
            |m| (m.extension.tint, m.extension.anim_slots.y),
            |m, slot, tint| match slot {
                Some(slot) => m.extension.anim_slots.y = -f32::from(slot),
                None => m.extension.tint = tint,
            },
        );
    }
}

fn set_sample<A: Asset>(
    slots: &mut HashMap<AssetId<A>, u16>,
    table: &mut MatAnimTable,
    materials: &mut Assets<A>,
    id: AssetId<A>,
    tint: Vec4,
    fields: impl Fn(&A) -> (Vec4, f32),
    write: impl Fn(&mut A, Option<u16>, Vec4),
) {
    let Some(material) = materials.get(id) else {
        return;
    };
    let (old_tint, selector) = fields(material);
    let slot = slots.get(&id).copied().or_else(|| {
        let slot = table.alloc()?;
        slots.insert(id, slot);
        Some(slot)
    });
    if let Some(slot) = slot {
        // Absolute RGB avoids both quantization and the rounding in seed + (sample - seed).
        table.set(slot, [tint.x, tint.y, tint.z, 1.0]);
        if selector != -f32::from(slot) {
            write(materials.get_mut(id).unwrap(), Some(slot), tint);
        }
    } else if old_tint != tint {
        // Never freeze colour animation when other UV/tint/clip users exhaust the shared table.
        write(materials.get_mut(id).unwrap(), None, tint);
    }
}

fn reap_slots<A: Asset>(
    slots: &mut HashMap<AssetId<A>, u16>,
    table: &mut MatAnimTable,
    materials: &Assets<A>,
) {
    slots.retain(|id, slot| {
        if materials.contains(*id) {
            true
        } else {
            table.free(*slot);
            false
        }
    });
}

pub(super) fn reap(
    mut slots: ResMut<AbsoluteTintMaterials>,
    mut table: ResMut<MatAnimTable>,
    materials: Res<Assets<WowModelMaterial>>,
) {
    reap_slots(&mut slots.0, &mut table, &materials);
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::asset::{AssetEvent, AssetPlugin};
    use bevy::ecs::message::MessageCursor;

    #[derive(Asset, TypePath)]
    struct TintFixture {
        tint: Vec4,
        selector: f32,
    }

    fn sample(
        app: &mut App,
        slots: &mut HashMap<AssetId<TintFixture>, u16>,
        table: &mut MatAnimTable,
        id: AssetId<TintFixture>,
        tint: Vec4,
    ) {
        set_sample(
            slots,
            table,
            &mut app.world_mut().resource_mut::<Assets<TintFixture>>(),
            id,
            tint,
            |m| (m.tint, m.selector),
            |m, slot, tint| match slot {
                Some(slot) => m.selector = -f32::from(slot),
                None => m.tint = tint,
            },
        );
        app.update();
    }

    #[test]
    fn changing_exact_rgb_updates_rows_without_material_events_and_reclaims_slots() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default()))
            .init_asset::<TintFixture>();
        let seed = Vec4::ONE;
        let mut assets = app.world_mut().resource_mut::<Assets<TintFixture>>();
        let a = assets.add(TintFixture {
            tint: seed,
            selector: 0.0,
        });
        let b = assets.add(TintFixture {
            tint: seed,
            selector: 0.0,
        });
        let mut slots = HashMap::default();
        let mut table = MatAnimTable::default();
        let mut cursor = MessageCursor::<AssetEvent<TintFixture>>::default();
        let first = Vec4::new(0.12345679, 0.4, 0.7, 1.0);
        sample(&mut app, &mut slots, &mut table, a.id(), first);
        sample(&mut app, &mut slots, &mut table, b.id(), Vec4::ZERO);
        cursor
            .read(app.world().resource::<Messages<AssetEvent<TintFixture>>>())
            .for_each(drop);
        let next = Vec4::new(f32::from_bits(first.x.to_bits() + 1), 0.1, 0.9, 1.0);
        sample(&mut app, &mut slots, &mut table, a.id(), next);
        assert_eq!(table.row(slots[&a.id()]), [next.x, next.y, next.z, 1.0]);
        assert_eq!(table.row(slots[&b.id()]), [0.0, 0.0, 0.0, 1.0]);
        assert!(cursor
            .read(app.world().resource::<Messages<AssetEvent<TintFixture>>>())
            .all(|e| !matches!(e, AssetEvent::Modified { .. })));
        let freed = slots[&a.id()];
        app.world_mut()
            .resource_mut::<Assets<TintFixture>>()
            .remove(a.id());
        reap_slots(
            &mut slots,
            &mut table,
            app.world().resource::<Assets<TintFixture>>(),
        );
        assert_eq!(table.row(freed), [0.0; 4]);
        assert_eq!(table.alloc(), Some(freed));
        assert!(!slots.contains_key(&a.id()));
        assert!(slots.contains_key(&b.id()));
        let before = slots.len();
        sample(&mut app, &mut slots, &mut table, a.id(), first);
        assert_eq!(slots.len(), before, "a missing material allocates nothing");
    }

    #[test]
    fn saturation_uses_exact_uniform_updates_then_recovers_a_row() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default()))
            .init_asset::<TintFixture>();
        let a = app
            .world_mut()
            .resource_mut::<Assets<TintFixture>>()
            .add(TintFixture {
                tint: Vec4::ONE,
                selector: 0.0,
            });
        let mut table = MatAnimTable::default();
        let held: Vec<_> = std::iter::from_fn(|| table.alloc()).collect();
        let mut slots = HashMap::default();
        let tint = Vec4::new(0.12345679, 0.2, 0.3, 1.0);
        sample(&mut app, &mut slots, &mut table, a.id(), tint);
        assert!(slots.is_empty());
        assert_eq!(
            app.world()
                .resource::<Assets<TintFixture>>()
                .get(&a)
                .unwrap()
                .tint,
            tint
        );
        table.free(held[0]);
        sample(&mut app, &mut slots, &mut table, a.id(), tint);
        assert_eq!(slots[&a.id()], held[0]);
        assert_eq!(table.row(held[0]), [tint.x, tint.y, tint.z, 1.0]);
        assert_eq!(
            app.world()
                .resource::<Assets<TintFixture>>()
                .get(&a)
                .unwrap()
                .selector,
            -f32::from(held[0])
        );
    }
}
