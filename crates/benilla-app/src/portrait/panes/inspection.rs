//! An equipped character-pane copy with its own lifetime, transparent target and readback.
//! No NetEntity, GUID, raid frame, world pose or NPC portrait queue is involved.
use super::super::inspection_protocol::{self as protocol, HEIGHT, TIMEOUT, WIDTH};
use super::super::DressUpLook;
use super::*;
use crate::entities::{CharCreate, InspectionAssembler};
use crate::planner_replay::ReplayUnit;
use benilla_ui::widget::CopyCamera;
use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured};
use wasm_bindgen::prelude::*;

pub type ActorInspectionRequest = protocol::Request<ReplayUnit>;
impl ActorInspectionRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.validate_header()?;
        if !self.unit.player || self.unit.key != self.key {
            return Err("Inspection requires the matching player snapshot");
        }
        if self.unit.race.is_some_and(|r| !(1..=8).contains(&r))
            || self.unit.sex.is_some_and(|s| s > 1)
        {
            return Err("Unsupported Classic character race or sex");
        }
        if self.unit.gear.len() > 19 {
            return Err("Inspection accepts at most 19 equipment slots");
        }
        let mut seen = [false; 19];
        for item in &self.unit.gear {
            let Some(slot) = seen.get_mut(usize::from(item.slot)) else {
                return Err("Invalid inspection equipment slot");
            };
            if *slot || item.inventory > u8::MAX as u32 {
                return Err("Invalid or duplicate inspection equipment slot");
            }
            *slot = true;
            if item.id != 0
                && item.display == 0
                && matches!(
                    item.slot,
                    0 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 14 | 15 | 16 | 17 | 18
                )
            {
                return Err("Equipped item appearance metadata is unavailable");
            }
        }
        Ok(())
    }
}

/// Last write wins, including close. The transport drains once per native update.
#[derive(Default, Resource)]
pub struct ActorInspectionControl {
    pub pending: Option<Option<ActorInspectionRequest>>,
}
#[derive(Default, Resource)]
pub(super) struct InspectionBake(pub DressUpBake);
#[derive(Default, Resource)]
struct Inspection {
    request: Option<ActorInspectionRequest>,
    look: Option<DressUpLook>,
    generation: u32,
    started: f64,
    done: bool,
    timing: protocol::CaptureTiming,
    capturing: bool,
    pane: Option<PaneBooth>,
}

#[wasm_bindgen(inline_js = r#"
let epoch=0, ownedUrl=null;
export function inspection_begin(serial,closed) {
  epoch=serial;
  if(closed && ownedUrl) { URL.revokeObjectURL(ownedUrl); ownedUrl=null; }
}
export function inspection_error(serial,key,requestId,error) {
  if(epoch===serial) globalThis.pullfiction?.('actor-inspection',JSON.stringify({key,requestId,error}));
}
export function inspection_image(serial,key,requestId,width,height,rgba) {
  if(epoch!==serial) return;
  try {
    const canvas=new OffscreenCanvas(width,height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);
    let timer;
    Promise.race([canvas.convertToBlob({type:'image/png'}),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Inspection image encoding timed out')),15000);
    })]).then(blob=>{
      if(epoch!==serial) return;
      const url=URL.createObjectURL(blob);
      if(!globalThis.pullfiction) { URL.revokeObjectURL(url); return; }
      if(ownedUrl) URL.revokeObjectURL(ownedUrl);
      ownedUrl=url;
      globalThis.pullfiction('actor-inspection',JSON.stringify({key,requestId,url,width,height}));
    }).catch(error=>inspection_error(serial,key,requestId,String(error))).finally(()=>clearTimeout(timer));
  } catch(error) { inspection_error(serial,key,requestId,String(error)); }
}
"#)]
extern "C" {
    fn inspection_begin(serial: u32, closed: bool);
    fn inspection_error(serial: u32, key: &str, request_id: f64, error: &str);
    fn inspection_image(
        serial: u32,
        key: &str,
        request_id: f64,
        width: u32,
        height: u32,
        rgba: &[u8],
    );
}

pub(crate) fn install(app: &mut App) {
    app.init_resource::<ActorInspectionControl>()
        .init_resource::<Inspection>()
        .init_resource::<InspectionBake>()
        .add_systems(
            Update,
            (
                feed.after(benilla_world::schedule::WorldStage::Input)
                    .before(crate::entities::DisplayBuildSet),
                assemble
                    .after(crate::entities::DisplayBuildSet)
                    .before(sync),
                sync.after(feed)
                    .after(sync_panes)
                    .before(super::super::gate_booth_cameras),
                capture.after(super::super::gate_booth_cameras).after(sync),
            ),
        );
}
fn look_for(unit: &ReplayUnit, chars: &CharCreate) -> DressUpLook {
    // Match replay's explicit fallback. The editor labels missing source appearance as estimated.
    let race = unit.race.unwrap_or(1);
    let sex = unit.sex.unwrap_or(0);
    let mut equipment = [benilla_protocol::CharEnumItem::default(); 19];
    for item in &unit.gear {
        if let Some(slot) = equipment.get_mut(usize::from(item.slot)) {
            *slot = benilla_protocol::CharEnumItem {
                display_id: item.display,
                inventory_type: item.inventory as u8,
            };
        }
    }
    DressUpLook {
        display_id: chars.0.body_display(race, sex).unwrap_or(49),
        race,
        sex,
        skin: unit.look[0],
        face: unit.look[1],
        hair_style: unit.look[2],
        hair_color: unit.look[3],
        facial_hair: unit.look[4],
        equipment,
        emblem: None,
    }
}
fn feed(
    mut control: ResMut<ActorInspectionControl>,
    mut state: ResMut<Inspection>,
    chars: Option<Res<CharCreate>>,
    time: Res<Time<Real>>,
    mut displays: ResMut<PaneDisplays>,
) {
    if let Some(request) = control.pending.take() {
        state.generation = state.generation.wrapping_add(1);
        inspection_begin(state.generation, request.is_none());
        let look = request
            .as_ref()
            .and_then(|r| chars.as_deref().map(|c| look_for(&r.unit, c)));
        let same_appearance = look.is_some() && state.look == look;
        state.timing.request(same_appearance);
        state.look = look;
        state.request = request;
        state.started = time.elapsed_secs_f64();
        state.done = false;
        state.capturing = false;
    }
    // Do not latch a temporary Human body before the character catalog has arrived. A request
    // issued during client preparation waits on that same catalog, under the original timeout.
    if !state.done && state.look.is_none() {
        state.look = state
            .request
            .as_ref()
            .and_then(|r| chars.as_deref().map(|c| look_for(&r.unit, c)));
    }
    if !state.done && state.request.is_some() && time.elapsed_secs_f64() - state.started > TIMEOUT {
        let request = state.request.as_ref().unwrap();
        inspection_error(
            state.generation,
            &request.key,
            request.request_id as f64,
            "Equipped character preview was not ready within 15 seconds",
        );
        state.request = None;
        state.look = None;
    }
    displays.1 = state.look.map(|l| l.display_id);
}
fn assemble(
    state: Res<Inspection>,
    mut bake: ResMut<InspectionBake>,
    mut assembler: InspectionAssembler,
) {
    if bake.0.look == state.look {
        return;
    }
    let revision = bake.0.revision.wrapping_add(1);
    match state.look {
        None => {
            bake.0 = DressUpBake {
                revision,
                ..default()
            }
        }
        Some(look) => {
            if let Some(mut built) = assembler.assemble(look) {
                built.revision = revision;
                bake.0 = built;
            }
        }
    }
}
fn sync(
    mut commands: Commands,
    mut state: ResMut<Inspection>,
    mut allocation: ResMut<PaneBooths>,
    mut booths: ResMut<Booths>,
    mut marks: ResMut<BoothPanes>,
    world: PaneWorld,
    mut render: PaneRender,
    bake: Res<InspectionBake>,
) {
    let state = &mut *state;
    let Some(look) = state.look else {
        if let Some(pane) = state.pane.take() {
            retire_target(
                &mut commands,
                pane,
                &mut booths,
                &mut marks,
                &mut allocation.free_layers,
                &mut render.images,
            );
        }
        return;
    };
    if state.done || bake.0.look != Some(look) {
        return;
    }
    if state.pane.is_none() {
        let layer = allocation.free_layers.pop().unwrap_or_else(|| {
            let layer = PANE_LAYER_BASE + allocation.next_layer;
            allocation.next_layer += 1;
            layer
        });
        state.pane = Some(open_named(
            &mut commands,
            &mut render.images,
            &mut booths,
            "actor-inspection".into(),
            None,
            layer,
            UVec2::new(WIDTH, HEIGHT),
            None,
        ));
    }
    let yaw = state.request.as_ref().unwrap().yaw;
    let pane = state.pane.as_mut().unwrap();
    let Some(booth) = booths.0.get_mut(&pane.key) else {
        return;
    };
    let scene = render
        .lights
        .scene(benilla_ui::widget::ModelLight::character(), None);
    let revision = bake.0.revision;
    let rebuilt = pane
        .built
        .as_ref()
        .is_none_or(|b| b.build != revision || b.scene != scene);
    if rebuilt {
        state.timing.rebuilt();
        let Some(anchors) = build(
            &mut commands,
            &mut render,
            booth,
            pane,
            &world,
            &Source::Assembled,
            scene,
            Some(&bake.0),
        ) else {
            return;
        };
        pane.built = Some(Built {
            build: revision,
            look: Look::Assembled(revision),
            scene,
            anchors,
        });
    }
    let view = body_view(
        &pane.built.as_ref().unwrap().anchors,
        CopyCamera::Pane,
        yaw,
        render.gx.0,
        &PaneUnits::default(),
        Vec2::new(WIDTH as f32, HEIGHT as f32),
        1.0,
    );
    let wake_before = booth.wake;
    place(&mut commands, pane, booth, view);
    booth.live = true;
    marks
        .0
        .insert(pane.key.clone(), WIDTH as f32 / HEIGHT as f32);
    // A warm copy owes one actual render of the new yaw. Its geometry/materials already
    // passed a valid readback; do not restart the cold four-frame wake on each drag update.
    booth.wake = state.timing.reframe_wake(wake_before, booth.wake);
}
fn capture(
    mut commands: Commands,
    mut state: ResMut<Inspection>,
    mut booths: ResMut<Booths>,
    bake: Res<InspectionBake>,
) {
    if state.done || state.capturing || state.request.is_none() {
        return;
    }
    if bake.0.look != state.look {
        return;
    }
    let Some(pane) = state
        .pane
        .as_ref()
        .filter(|p| p.built.as_ref().is_some_and(|b| b.build == bake.0.revision))
    else {
        return;
    };
    let Some(booth) = booths.0.get_mut(&pane.key) else {
        return;
    };
    if !booth.pending.is_empty() || booth.pipes_settling || booth.wake > 0 {
        return;
    }
    let target = booth.target.clone();
    if !state.timing.capture_frame() {
        return;
    }
    state.capturing = true;
    let generation = state.generation;
    commands.spawn(Screenshot::image(target)).observe(
        move |shot: On<ScreenshotCaptured>,
              mut state: ResMut<Inspection>,
              mut booths: ResMut<Booths>,
              mut marks: ResMut<BoothPanes>| {
            if state.generation != generation || state.request.is_none() {
                return;
            }
            state.capturing = false;
            let Some(image) = super::super::test_bake::encode_target_readback(&shot.image) else {
                state.timing.empty_readback();
                return;
            };
            let Some(pixels) = image
                .data
                .as_ref()
                .filter(|p| protocol::visible_readback(image.width(), image.height(), p))
            else {
                state.timing.empty_readback();
                return;
            };
            let request = state.request.as_ref().unwrap();
            inspection_image(
                generation,
                &request.key,
                request.request_id as f64,
                WIDTH,
                HEIGHT,
                pixels,
            );
            state.timing.valid_readback();
            state.done = true;
            if let Some(pane) = state.pane.as_ref() {
                marks.0.remove(&pane.key);
                if let Some(booth) = booths.0.get_mut(&pane.key) {
                    booth.live = false;
                    booth.wake = 0;
                }
            }
        },
    );
    // The observer parks this pane only after a valid image.
}
