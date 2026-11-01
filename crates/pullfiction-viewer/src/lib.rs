//! Pull Fiction renderer using browser-local client assets.
#![cfg(target_arch = "wasm32")]
mod annotations;
mod command_queue;
#[cfg(feature = "renderer-lab")]
mod renderer_diagnostics;
#[cfg(feature = "renderer-lab")]
mod renderer_isolation;
mod replay_validation;
mod surface_geometry;
mod viewer;
#[cfg(feature = "renderer-lab")]
pub use renderer_diagnostics::{
    renderer_lab_advance, renderer_lab_capture, renderer_lab_configure, renderer_lab_status,
};
pub use viewer::*;
type ReplayBody = benilla_app::planner_replay::ReplayBody;
