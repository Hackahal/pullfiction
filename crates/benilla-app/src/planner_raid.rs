//! Replay roster and native compact class-colour frames, with recorded casts/auras.
use crate::{
    net,
    planner_replay::{ReplayBody, ReplayControl},
    ui_party::GroupState,
};
use benilla_protocol::messages::GroupMemberEntry;
use bevy::{ecs::system::SystemParam, prelude::*};
#[path = "planner_ui_payload.rs"]
mod payload;
pub(crate) use payload::UiPayload;
#[path = "planner_raid_serialization.rs"]
mod serialization;
use serialization::{decimal, literal_value, quote, AuraInput, RaidSerialization};

const UI: &str = include_str!("planner_raid.lua");
pub(crate) fn install(app: &mut App) {
    app.add_systems(
        Update,
        drive
            .after(crate::ui_script::UiFeed)
            .before(crate::ui_script::UiPaint)
            .run_if(crate::ui_script::ingame_ui_up),
    );
}
#[derive(SystemParam)]
struct RaidWorld<'w, 's> {
    units: Query<
        'w,
        's,
        (
            Entity,
            &'static ReplayBody,
            &'static net::Guid,
            &'static net::ObjectStore,
            &'static Transform,
        ),
    >,
    control: ResMut<'w, ReplayControl>,
    group: ResMut<'w, GroupState>,
    names: Res<'w, crate::names::NameCache>,
    selection: Res<'w, crate::target::Selection>,
    clicks: ResMut<'w, crate::vplates::PlateClicks>,
    windows: Query<'w, 's, &'static Window>,
}
fn drive(
    mut vm: crate::script_calls::VmWith<RaidWorld<'static, 'static>>,
    mut session: Local<Option<u64>>,
    mut roster: Local<Vec<u64>>,
    mut last_update: Local<UiPayload>,
    mut serialized: Local<RaidSerialization>,
) {
    vm.turn(|mut script,mut world|{
    let Some(script)=script.as_mut()else{last_update.clear();serialized.clear();return;};
    if !script.lua().globals().get::<benilla_ui::mlua::Value>("WorldFrame").is_ok_and(|v| !v.is_nil()){last_update.clear();serialized.clear();return;}
    if *session!=Some(script.session()){
        last_update.clear();serialized.clear();
        if let Err(e)=script.run(UI){warn!("raid UI: {e}");return;}
        *session=Some(script.session());roster.clear();
    }
    let requested=world.control.select.take();
    if let Some(key)=requested{
        if let Some((entity,..))=world.units.iter().find(|(_,body,..)|body.key==key){world.clicks.left.push(entity);}
        else if key.is_empty(){let _=script.run("ClearTarget()");}
    }
    world.control.selected_key=world.units.iter().find(|(_,_,guid,..)|Some(guid.0)==world.selection.guid).map(|(_,body,..)|body.key.clone());
    let globals=script.lua().globals();
    let focus=globals.get::<Option<String>>("PullFictionRaidFocus");
    let _=globals.set("PullFictionRaidFocus",benilla_ui::mlua::Value::Nil);
    if let Ok(Some(key))=focus{
        if let Ok(guid)=key.parse::<u64>(){if let Some((_,body,..))=world.units.iter().find(|(_,_,g,..)|g.0==guid){world.control.focus_actor=Some(body.key.clone());}}
    }
    let mut units:Vec<_>=world.units.iter().filter(|(_,b,..)|b.raid).collect();units.sort_by(|a,b|a.1.key.cmp(&b.1.key));units.truncate(40);
    let guids:Vec<_>=units.iter().map(|(_,_,g,..)|g.0).collect();
    serialized.begin(script.session(),world.control.generation,&guids);
    if *roster!=guids{
        let members=units.iter().enumerate().skip(1).map(|(i,(_,_,guid,store,_))|GroupMemberEntry{name:world.names.resolve_unit(guid.0,Some(store),crate::query_cache::Ask::Read).unwrap_or("").into(),guid:guid.0,status:1,flags:(i/5)as u8}).collect();
        let known:std::collections::HashMap<_,_>=units.iter().map(|(_,_,g,s,_)|(g.0,world.names.resolve_unit(g.0,Some(s),crate::query_cache::Ask::Read).unwrap_or("").to_string())).collect();
        // The offline observer is outside the recorded raid. Anchor the
        // native roster on its first recorded member, rather than adding a 41st viewer.
        let lookup=|guid|known.get(&guid).cloned();let me=guids.first().copied();
        world.group.apply_list_awaiting(1,0,members,guids.first().copied().unwrap_or(0),None,me,&lookup,&lookup);
        *roster=guids;
    }
    let rows=units.iter().map(|(_,body,guid,store,_)|{
        let hp=store.0.unit_health().unwrap_or(0);let max=store.0.unit_max_health().unwrap_or(1).max(1);
        let name=world.names.resolve_unit(guid.0,Some(store),crate::query_cache::Ask::Read).unwrap_or("");
        let sources=serialized.sources(guid.0,name,body.plate_auras.iter().map(|a|AuraInput{spell:a.spell,name:&a.name,icon:&a.icon,stack:a.stack,debuff:a.debuff}));
        let auras=&sources.auras;
        let cast=body.plate_cast.as_ref().map(|c|format!("{{name={},progress={:.4},remaining={}}}",quote(&c.name),c.progress.clamp(0.,1.),quote(&format!("{:.1}",c.remaining.max(0.))))).unwrap_or("nil".into());
        format!("{{guid={},name={},class={},hp={hp},max={max},known={},power={},maxpower={},powertype={},powerknown={},selected={},cast={cast},auras={{{auras}}}}}",sources.guid,sources.name,store.0.unit_class().unwrap_or(0),body.health_known,store.0.unit_power(store.0.unit_power_type()).unwrap_or(0),store.0.unit_max_power(store.0.unit_power_type()).unwrap_or(0),store.0.unit_power_type(),body.power_known,world.selection.guid==Some(guid.0))
    }).collect::<Vec<_>>().join(",");
    let (width,height)=world.windows.single().map(|w|(w.width(),w.height())).unwrap_or((1200.,900.));let seam=crate::ui_script::seam_scale(height);
    let bounds=world.control.raid_frame_size;
    let w=if bounds[0]>0. {bounds[0]}else{724.};let h=if bounds[1]>0. {bounds[1]}else{276.};
    let layout=crate::planner_raid_layout::layout(units.len(),w.min((width-24.).max(80.)),h.min((height-24.).max(80.)));
    let update=format!("PullFictionRaid_Update({{{rows}}},{},{:.5},{},{:.5})",world.control.raid_frames,1./seam,layout.rows,layout.scale);
    // Keep the complete, quantized payload as the memo key. It includes fields the Lua
    // consumer currently ignores, so a later visual change cannot silently miss an update.
    // Only a changed payload allocates Lua tables; data is never compiled as source.
    if let Err(e)=last_update.run(script.session(),update,|_| {
        let lua=script.lua();
        let rows=lua.create_table()?;
        for (i,(_,body,guid,store,_)) in units.iter().enumerate() {
            let row=serialized.table(guid.0,lua)?;
            row.set("class",store.0.unit_class().unwrap_or(0))?;
            row.set("hp",store.0.unit_health().unwrap_or(0))?;
            row.set("max",store.0.unit_max_health().unwrap_or(1).max(1))?;
            row.set("known",body.health_known)?;
            row.set("power",store.0.unit_power(store.0.unit_power_type()).unwrap_or(0))?;
            row.set("maxpower",store.0.unit_max_power(store.0.unit_power_type()).unwrap_or(0))?;
            row.set("powertype",store.0.unit_power_type())?;
            row.set("powerknown",body.power_known)?;
            row.set("selected",world.selection.guid==Some(guid.0))?;
            if let Some(c)=&body.plate_cast {
                let cast=lua.create_table()?;
                cast.set("name",literal_value(&c.name))?;
                cast.set("progress",decimal(c.progress.clamp(0.,1.),4))?;
                cast.set("remaining",format!("{:.1}",c.remaining.max(0.)))?;
                row.set("cast",cast)?;
            }
            rows.set(i+1,row)?;
        }
        let function=lua.globals().get::<benilla_ui::mlua::Function>("PullFictionRaid_Update")?;
        script.call_function::<()>(&function,(rows,world.control.raid_frames,decimal(1./seam,5),layout.rows,decimal(layout.scale,5)))
    }){serialized.clear();warn!("raid update: {e}");}
 });
}

#[cfg(test)]
#[path = "planner_raid_render_tests.rs"]
mod render_tests;
