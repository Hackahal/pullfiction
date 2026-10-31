//! Replay floor columns from complete loaded WMO assets, independent of render/collider queues.
use super::planner_grounding::{triangle_floor, FloorCandidate};
use benilla_assets::{
    coords::{bevy_to_wow, wow_to_bevy},
    WmoModel,
};
use benilla_world::wmo_portal::WmoPortalInstance;
use bevy::prelude::*;

pub(crate) fn floors_at(
    request: Vec3,
    models: &Assets<WmoModel>,
    instances: &Query<&WmoPortalInstance>,
) -> Vec<FloorCandidate> {
    let mut candidates = Vec::new();
    for instance in instances {
        let Some(model) = models.get(&instance.handle) else {
            continue;
        };
        let local = bevy_to_wow(
            instance
                .world_from_local
                .inverse()
                .transform_point3(request),
        );
        for (group, tris) in model.group_collision_tris.iter().enumerate() {
            let Some(Some((min, max))) = model.group_collision_bounds.get(group) else {
                continue;
            };
            if local[0] < min[0] || local[0] > max[0] || local[1] < min[1] || local[1] > max[1] {
                continue;
            }
            let mut consider = |tri: &[[f32; 3]; 3]| {
                let Some(z) = triangle_floor(tri, local[0], local[1]) else {
                    return;
                };
                let world = instance
                    .world_from_local
                    .transform_point3(wow_to_bevy([local[0], local[1], z]));
                candidates.push(FloorCandidate {
                    height: world.y,
                    interior: model.group_bounds.get(group).is_some_and(|g| g.interior),
                });
            };
            if let Some(Some(grid)) = model.group_collision_grids.get(group) {
                for i in grid.candidates(local[0], local[1]) {
                    if let Some(tri) = tris.get(i) {
                        consider(tri)
                    }
                }
            } else {
                for tri in tris {
                    consider(tri)
                }
            }
        }
    }
    candidates
}
