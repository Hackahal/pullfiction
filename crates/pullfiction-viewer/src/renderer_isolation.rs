//! Bounded, reversible visibility overlay used only by renderer diagnostics.
use bevy::prelude::*;
use std::collections::HashMap;

const MAX_SAVED_MESHES: usize = 131_072;

#[derive(Resource, Default)]
pub(crate) struct Isolation {
    pub active: bool,
    pub prior_world_kinds: Option<[bool; 4]>,
    pub overflow: bool,
    pub hidden_mesh_count: usize,
    pub portal_cull: Option<bool>,
    prior_portal_cull: Option<bool>,
    saved: HashMap<Entity, Visibility>,
}

impl Isolation {
    /// Returns a write only when the diagnostic override or its restoration changes the toggle.
    pub fn portal_override(&mut self, requested: Option<bool>, current: bool) -> Option<bool> {
        let next = if let Some(requested) = requested {
            self.prior_portal_cull.get_or_insert(current);
            requested
        } else {
            self.prior_portal_cull.take().unwrap_or(current)
        };
        self.portal_cull = Some(next);
        (next != current).then_some(next)
    }
    pub fn count(&self) -> usize {
        self.saved.len()
    }
    pub fn remember(&mut self, entity: Entity, visibility: Visibility) -> bool {
        if self.saved.contains_key(&entity) {
            return true;
        }
        if self.saved.len() >= MAX_SAVED_MESHES {
            self.overflow = true;
            return false;
        }
        self.saved.insert(entity, visibility);
        true
    }
    pub fn hide(&mut self, entity: Entity, visibility: &mut Visibility) {
        if self.remember(entity, *visibility) {
            *visibility = Visibility::Hidden;
        }
    }
    pub fn restore(&mut self, entity: Entity, visibility: &mut Visibility) {
        if let Some(original) = self.saved.remove(&entity) {
            *visibility = original;
        }
    }
    pub fn prune(&mut self, alive: impl Fn(Entity) -> bool) {
        self.saved.retain(|entity, _| alive(*entity));
    }
}

/// Native model/FX tags take precedence; untagged attachments follow typed subject ancestry.
pub(crate) fn preserve_subject(
    entity: Entity,
    dynamic_model_or_particle: bool,
    root: impl Fn(Entity) -> bool,
    parent: impl Fn(Entity) -> Option<Entity>,
) -> bool {
    if dynamic_model_or_particle {
        return true;
    }
    let mut current = Some(entity);
    for _ in 0..64 {
        let Some(entity) = current else {
            return false;
        };
        if root(entity) {
            return true;
        }
        current = parent(entity);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::RunSystemOnce;
    #[derive(Component)]
    struct Subject;
    #[derive(Component)]
    struct DynamicFx;
    #[test]
    fn portal_override_restores_the_original_toggle_and_avoids_idle_writes() {
        let mut isolation = Isolation::default();
        assert_eq!(isolation.portal_override(None, true), None);
        assert_eq!(isolation.portal_override(Some(false), true), Some(false));
        assert_eq!(isolation.portal_override(Some(false), false), None);
        assert_eq!(isolation.portal_override(Some(true), false), Some(true));
        assert_eq!(isolation.portal_override(None, true), None);
        assert_eq!(isolation.portal_override(Some(true), false), Some(true));
        assert_eq!(isolation.portal_override(None, true), Some(false));
        assert_eq!(isolation.portal_cull, Some(false));
    }
    #[test]
    fn saved_state_is_bounded_and_prunes_removed_entities() {
        let mut isolation = Isolation::default();
        for index in 0..MAX_SAVED_MESHES {
            assert!(isolation.remember(
                Entity::from_raw_u32(index as u32 + 1).unwrap(),
                Visibility::Visible
            ));
        }
        let mut visibility = Visibility::Visible;
        isolation.hide(
            Entity::from_raw_u32(MAX_SAVED_MESHES as u32 + 2).unwrap(),
            &mut visibility,
        );
        assert_eq!(visibility, Visibility::Visible);
        assert!(isolation.overflow);
        assert_eq!(isolation.count(), MAX_SAVED_MESHES);
        isolation.prune(|_| false);
        assert_eq!(isolation.count(), 0);
    }
    #[test]
    fn typed_subjects_and_free_fx_survive_and_world_visibility_restores() {
        let mut world = World::new();
        world.init_resource::<Isolation>();
        let subject = world.spawn(Subject).id();
        let attachment = world
            .spawn((Mesh3d::default(), Visibility::Inherited, ChildOf(subject)))
            .id();
        let free_fx = world
            .spawn((Mesh3d::default(), Visibility::Visible, DynamicFx))
            .id();
        let world_mesh = world.spawn((Mesh3d::default(), Visibility::Visible)).id();
        let initially_hidden = world.spawn((Mesh3d::default(), Visibility::Hidden)).id();
        world.run_system_once(|mut isolation:ResMut<Isolation>,roots:Query<(),With<Subject>>,parents:Query<&ChildOf>,mut meshes:Query<(Entity,&mut Visibility,Has<DynamicFx>),With<Mesh3d>>| {
            for (entity,mut visibility,dynamic) in &mut meshes {
                if !preserve_subject(entity,dynamic,|entity|roots.contains(entity),|entity|parents.get(entity).ok().map(ChildOf::parent)) { isolation.hide(entity,&mut visibility); }
            }
        }).unwrap();
        assert_eq!(
            *world.get::<Visibility>(attachment).unwrap(),
            Visibility::Inherited
        );
        assert_eq!(
            *world.get::<Visibility>(free_fx).unwrap(),
            Visibility::Visible
        );
        assert_eq!(
            *world.get::<Visibility>(world_mesh).unwrap(),
            Visibility::Hidden
        );
        assert_eq!(world.resource::<Isolation>().count(), 2);
        world
            .run_system_once(
                |mut isolation: ResMut<Isolation>,
                 mut meshes: Query<(Entity, &mut Visibility), With<Mesh3d>>| {
                    for (entity, mut visibility) in &mut meshes {
                        isolation.restore(entity, &mut visibility);
                    }
                },
            )
            .unwrap();
        assert_eq!(
            *world.get::<Visibility>(world_mesh).unwrap(),
            Visibility::Visible
        );
        assert_eq!(
            *world.get::<Visibility>(initially_hidden).unwrap(),
            Visibility::Hidden
        );
        assert_eq!(world.resource::<Isolation>().count(), 0);
    }
}
