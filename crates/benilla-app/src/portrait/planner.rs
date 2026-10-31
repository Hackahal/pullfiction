//! Serialize the existing NPC portrait booth to local browser images for tactical maps.
use super::{gate_booth_cameras, sync_portraits, Booths};
use crate::planner_replay::{ReplayBody, ReplayControl, ReplayPortrait};
use bevy::prelude::*;
use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured};
use std::collections::{HashSet, VecDeque};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(
    inline_js = "export function map_portrait(display,w,h,rgba) { const c = new OffscreenCanvas(w,h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),w,h),0,0); c.convertToBlob({type:'image/png'}).then(b => { const url=URL.createObjectURL(b); if(globalThis.pullfiction)globalThis.pullfiction('portrait',JSON.stringify({display,url}));else URL.revokeObjectURL(url); }); }"
)]
extern "C" {
    fn map_portrait(display: u32, w: u32, h: u32, rgba: &[u8]);
}

#[derive(Default, Resource)]
pub(super) struct PortraitExport {
    pub subject: Option<Entity>,
    pub display: Option<u32>,
    queue: VecDeque<ReplayPortrait>,
    completed: HashSet<u32>,
    active: Option<ReplayPortrait>,
    started: f64,
    phase: u32,
    capturing: bool,
    queue_since: Option<f64>,
}

pub(super) fn install(app: &mut App) {
    app.init_resource::<PortraitExport>().add_systems(
        Update,
        (
            feed.before(sync_portraits)
                .after(benilla_world::schedule::WorldStage::Input),
            capture.after(gate_booth_cameras),
        ),
    );
}
fn feed(
    mut export: ResMut<PortraitExport>,
    replay: Option<ResMut<ReplayControl>>,
    units: Query<(Entity, &ReplayBody, &crate::net::NetEntity)>,
    time: Res<Time>,
    mut booths: ResMut<Booths>,
) {
    let Some(mut replay) = replay else {
        return;
    };
    for request in std::mem::take(&mut replay.portrait_requests) {
        if !export.completed.contains(&request.display)
            && export
                .active
                .as_ref()
                .is_none_or(|a| a.display != request.display)
            && !export.queue.iter().any(|q| q.display == request.display)
        {
            export.queue.push_back(request);
        }
    }
    let now = time.elapsed_secs_f64();
    if export.queue.is_empty() {
        export.queue_since = None;
    } else {
        let since = *export.queue_since.get_or_insert(now);
        if now - since > 120.0 {
            export.queue.clear();
            export.queue_since = None;
        }
    }
    if export.active.is_some() && !export.capturing && now - export.started > 12.0 {
        export.active = None;
        export.subject = None;
        export.display = None;
        export.phase = 0;
        if let Some(booth) = booths.0.get_mut("npc") {
            booth.baked_guid = None;
        }
    }
    if export.active.is_none() {
        if export.queue.is_empty() {
            return;
        }
        for _ in 0..export.queue.len() {
            let Some(request) = export.queue.pop_front() else {
                break;
            };
            let unit = units.iter().find(|(_, body, net)| {
                body.key == request.key && net.display_id == Some(request.display)
            });
            if let Some((entity, _, _)) = unit {
                export.subject = Some(entity);
                export.display = Some(request.display);
                export.active = Some(request);
                export.started = now;
                export.phase = 0;
                break;
            } else {
                export.queue.push_back(request);
            }
        }
    }
}
fn capture(mut commands: Commands, mut export: ResMut<PortraitExport>, mut booths: ResMut<Booths>) {
    let Some(display) = export.display else {
        return;
    };
    if export.capturing {
        return;
    }
    let Some(booth) = booths.0.get_mut("npc") else {
        return;
    };
    if booth.baked_guid != Some(u64::from(display))
        || booth.baked.is_none()
        || !booth.pending.is_empty()
        || booth.pipes_settling
    {
        return;
    }
    if export.phase == 0 && booth.wake > 0 {
        return;
    }
    // Wake the frozen render target before readback, as dump_booth_target does.
    booth.wake = booth.wake.max(3);
    export.phase += 1;
    if export.phase < 4 {
        return;
    }
    export.capturing = true;
    commands
        .spawn(Screenshot::image(booth.target.clone()))
        .observe(
            move |shot: On<ScreenshotCaptured>,
                  mut export: ResMut<PortraitExport>,
                  mut booths: ResMut<Booths>| {
                if let Some(image) = super::test_bake::encode_target_readback(&shot.image) {
                    if let Some(pixels) = image.data.as_ref() {
                        // The opaque booth clear is not a portrait. A first readback can precede
                        // the mesh/material GPU preparation even after the pipeline queue drains.
                        if super::test_bake::has_model_pixels(pixels) {
                            map_portrait(display, image.width(), image.height(), pixels);
                            export.completed.insert(display);
                        } else {
                            // Keep this model and authored camera alive until its draw lands.
                            // `feed` retains the existing timeout for an unavailable model.
                            export.phase = 0;
                            export.capturing = false;
                            if let Some(booth) = booths.0.get_mut("npc") {
                                booth.wake = booth.wake.max(super::BOOTH_SETTLE_FRAMES);
                            }
                            return;
                        }
                    }
                }
                export.active = None;
                export.subject = None;
                export.display = None;
                export.phase = 0;
                export.capturing = false;
                // This scratch booth must not enter the unit-frame GUID cache.
                if let Some(booth) = booths.0.get_mut("npc") {
                    booth.baked_guid = None;
                }
            },
        );
}
