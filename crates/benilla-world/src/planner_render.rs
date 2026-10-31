//! Model effects without terrain streaming, a game session or archive-backed bootstrap tables.
use bevy::prelude::*;
pub fn install_effects(app: &mut App) {
    crate::shaders::plugin(app);
    app.init_resource::<avian3d::collider_tree::ColliderTrees>()
        .init_resource::<crate::view::ViewDistance>()
        .init_resource::<crate::wmo_portal::ExteriorWindows>()
        .init_resource::<crate::wmo_portal::CameraInteriorClaim>()
        .init_resource::<crate::liquid::WaterIndex>()
        .init_resource::<crate::liquid::Underwater>()
        .init_resource::<crate::model_forms::ModelForms>()
        .add_plugins(bevy::render::extract_resource::ExtractResourcePlugin::<
            crate::lighting::SharedLightBuffer,
        >::default())
        .add_plugins(crate::particles::ParticlePlugin)
        .add_plugins(crate::ribbons::RibbonPlugin);
}

/// Browser replay simulation clock. A paused replay still redraws existing particles.
#[derive(Resource, Default)]
pub struct ReplayStep {
    pub delta: f32,
    pub now: f32,
    pub reset: bool,
}
