//! Replay-only native FrameXML plates. No browser DOM or modern-addon API emulation.
use crate::{
    entities::{overhead_anchor, BoneAttach, OverheadFallback},
    names::NameCache,
    net,
    planner_plate_layout::{Candidate, Layout},
    planner_replay::{ReplayBody, ReplayControl},
    query_cache::Ask,
};
use benilla_world::view::WorldCamera;
use bevy::{ecs::system::SystemParam, prelude::*};
use std::collections::HashMap;
const UI: &str = include_str!("planner_nameplates.lua");
pub(crate) fn install(app: &mut App) {
    app.add_systems(
        Update,
        drive
            .after(crate::vplates::VPlateSet)
            .after(crate::ui_script::UiFeed)
            .before(crate::ui_script::UiPaint)
            .before(crate::nameplates::drive_nameplates)
            .run_if(crate::ui_script::ingame_ui_up),
    );
}
#[derive(SystemParam)]
struct PlateWorld<'w, 's> {
    units: Query<
        'w,
        's,
        (
            Entity,
            &'static ReplayBody,
            &'static net::Guid,
            &'static net::ObjectStore,
            &'static Transform,
            &'static Visibility,
            &'static net::NetEntity,
        ),
    >,
    camera: Query<'w, 's, (&'static Camera, &'static Transform), With<WorldCamera>>,
    anchors: Query<'w, 's, &'static BoneAttach>,
    poses: Query<'w, 's, &'static benilla_world::rig_anim::RigPose>,
    fallbacks: Query<'w, 's, &'static OverheadFallback>,
    globals: Query<'w, 's, &'static GlobalTransform>,
    mounts: Query<'w, 's, (), With<crate::entities::mount::MountChild>>,
    names: Res<'w, NameCache>,
    control: Res<'w, ReplayControl>,
    selection: Res<'w, crate::target::Selection>,
    plates: ResMut<'w, crate::vplates::VPlates>,
    clicks: ResMut<'w, crate::vplates::PlateClicks>,
    time: Res<'w, Time>,
    rig: Res<'w, crate::player::CameraControl>,
}
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn icon(s: &str) -> String {
    let file = s.rsplit('/').next().unwrap_or(s);
    let stem = file.split('.').next().unwrap_or(file);
    if stem.is_empty() {
        "Interface\\Icons\\INV_Misc_QuestionMark".into()
    } else {
        format!("Interface\\Icons\\{stem}")
    }
}

fn drive(
    mut vm: crate::script_calls::VmWith<PlateWorld<'static, 'static>>,
    mut layout: Local<Layout>,
    mut session: Local<Option<u64>>,
    mut last_update: Local<crate::planner_raid::UiPayload>,
) {
    vm.turn(|mut script,mut world|{
  let Some(script)=script.as_mut()else{last_update.clear();return;};
  if !script.eval::<bool>("return WorldFrame ~= nil").unwrap_or(false){last_update.clear();return;}
  if *session!=Some(script.session()){
   last_update.clear();
   if let Err(e)=script.run(UI){warn!("replay plates init: {e}");return;}
   *session=Some(script.session());*layout=Layout::default();
  }
  if let Ok(key)=script.eval::<String>("local k=PullFictionPlateClick; PullFictionPlateClick=nil; return k or ''"){
   if let Ok(guid)=key.parse::<u64>(){if let Some((entity,..))=world.units.iter().find(|(_,_,g,..)|g.0==guid){world.clicks.left.push(entity);}}
  }
  let Ok((camera,xf))=world.camera.single()else{return;};
  let Some(viewport)=camera.logical_viewport_size()else{return;};
  let seam=crate::ui_script::seam_scale(viewport.y);let cam_tf=GlobalTransform::from(*xf);
  let mut candidates=Vec::new();let mut data=HashMap::new();let mut name_only_entities=HashMap::new();
  if world.control.nameplates.is_some(){
   for(entity,body,guid,store,tf,visibility,net)in &world.units{
    if *visibility==Visibility::Hidden{continue;}
    let player=net.kind==benilla_protocol::EntityKind::Player;
    let friendly=player||body.friendly;
    let enabled=world.control.nameplates.unwrap_or(false);
    let name_only=friendly&&(!enabled||!world.control.friendly_nameplates.unwrap_or(true));
    if !friendly&&(!enabled||!body.nameplate||!world.control.enemy_nameplates.unwrap_or(true)){continue;}
    // Keep the client's ordinary names when a name-only label cannot be placed.
    if !name_only { world.plates.0.insert(entity); }
    if body.health_known&&store.0.unit_health().unwrap_or(0)==0{continue;}
    if xf.translation.distance_squared(tf.translation)>80.*80.{continue;}
    let at=overhead_anchor(entity,tf,&world.anchors,&world.poses,&world.fallbacks,&world.globals,&world.mounts)+Vec3::Y*0.35;
    let Ok(screen)=camera.world_to_viewport(&cam_tf,at)else{continue;};
    if screen.x<0.||screen.y<0.||screen.x>viewport.x||screen.y>viewport.y{continue;}
    let selected=world.selection.guid==Some(guid.0);
    if name_only { name_only_entities.insert(guid.0,entity); }
    let color=crate::planner_unit_colors::nameplate_color(player,store.0.unit_class().unwrap_or(0),body.estimated,body.friendly);
    let mut auras:Vec<_>=body.plate_auras.iter().filter(|a|store.0.unit_aura_ids().any(|id|id==a.spell)).filter(|a|!friendly||selected||a.debuff).collect();
    auras.sort_by_key(|a|(!a.debuff,a.spell));auras.truncate(if friendly&&!selected{2}else{4});
    if name_only { auras.clear(); }
    let width=if selected{154.}else if friendly{104.}else{140.};
    let height=if name_only {13.}else{13.+if friendly&&!selected{5.}else{10.}+if body.plate_cast.is_some(){14.}else{0.}+if auras.is_empty(){0.}else{18.}};
    candidates.push(Candidate{key:guid.0,anchor:[screen.x,screen.y],size:[width,height],priority:if selected{0}else if !friendly{1}else{2}});
    let name=world.names.resolve_unit(guid.0,Some(store),Ask::Read).unwrap_or("");
    let name=if body.estimated{format!("~ {name}")}else{name.to_owned()};
    let health=if body.health_known{store.0.unit_health().unwrap_or(0)as f32/store.0.unit_max_health().unwrap_or(1).max(1)as f32}else{0.};
    let hptext=if body.health_known{format!("{:.0}%",health*100.)}else{"?".into()};
    let aura_text=auras.iter().map(|a|format!("{{icon={},stack={},debuff={}}}",quote(&icon(&a.icon)),a.stack,a.debuff)).collect::<Vec<_>>().join(",");
    let cast=body.plate_cast.as_ref().filter(|_|!name_only).map(|c|format!("{{name={},icon={},progress={:.4},remaining={}}}",quote(&c.name),quote(&icon(&c.icon)),c.progress.clamp(0.,1.),quote(&format!("{:.1}",c.remaining.max(0.))))).unwrap_or("nil".into());
    data.insert(guid.0,format!("key={},name={},w={width},h={height},friendly={friendly},selected={selected},name_only={name_only},r={},g={},b={},health={:.4},hptext={},cast={cast},auras={{{aura_text}}}",quote(&guid.0.to_string()),quote(&name),color[0],color[1],color[2],health.clamp(0.,1.),quote(&hptext)));
   }
  }
  let placed=layout.place(candidates,[viewport.x,viewport.y],world.time.delta_secs());
  for p in &placed { if let Some(entity)=name_only_entities.get(&p.key) { world.plates.0.insert(*entity); } }
  let units=placed.iter().filter_map(|p|data.get(&p.key).map(|d|format!("{{x={:.2},y={:.2},{d}}}",p.top[0],p.top[1]))).collect::<Vec<_>>().join(",");
  let update=format!("PullFictionPlates_Update({{{units}}},{:.5},{})",1./seam,world.rig.is_looking());
  if let Err(e)=last_update.run(script.session(),update,|code|script.run(code)){warn!("replay plates update: {e}");}
 });
}
