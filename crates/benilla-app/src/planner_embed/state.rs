//! Replay data for the existing planner Lua, independent of the game session and object store.

use std::collections::HashMap;

use bevy::prelude::Resource;

use crate::planner_plate_layout::{Candidate, Layout};

#[derive(Clone, Debug, Default)]
pub struct PlannerUiCast {
    pub name: String,
    pub icon: String,
    pub progress: f32,
    pub remaining: f32,
}

#[derive(Clone, Debug)]
pub struct PlannerUiAura {
    pub spell: u32,
    pub name: String,
    pub icon: String,
    pub stack: u32,
    pub debuff: bool,
    /// The original nameplate adapter checks the aura against the unit's active aura IDs.
    pub active: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PlannerUiUnit {
    pub key: String,
    pub guid: u64,
    pub name: String,
    pub player: bool,
    pub raid: bool,
    pub class: u8,
    pub friendly: bool,
    pub estimated: bool,
    pub health_known: bool,
    pub health: u32,
    pub max_health: u32,
    pub power_known: bool,
    pub power: u32,
    pub max_power: u32,
    pub power_type: u8,
    pub visible: bool,
    pub distance: f32,
    /// The original overhead-bone/fallback anchor plus 0.35 world Y, projected to logical px.
    pub anchor: Option<[f32; 2]>,
    pub cast: Option<PlannerUiCast>,
    pub auras: Vec<PlannerUiAura>,
}

/// The host supplies this frame's recorded units and camera projection before `PlannerUiPaint`.
#[derive(Resource, Clone, Debug)]
pub struct PlannerUiFrame {
    pub units: Vec<PlannerUiUnit>,
    pub selected: Option<u64>,
    pub nameplates: bool,
    pub friendly_nameplates: bool,
    pub enemy_nameplates: bool,
    pub raid_frames: bool,
    pub raid_frame_size: [f32; 2],
    pub looking: bool,
}

impl Default for PlannerUiFrame {
    fn default() -> Self {
        Self {
            units: Vec::new(),
            selected: None,
            nameplates: false,
            friendly_nameplates: true,
            enemy_nameplates: true,
            raid_frames: false,
            raid_frame_size: [0.; 2],
            looking: false,
        }
    }
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
    let stem = s
        .rsplit('/')
        .next()
        .unwrap_or(s)
        .split('.')
        .next()
        .unwrap_or("");
    format!(
        "Interface\\Icons\\{}",
        if stem.is_empty() {
            "INV_Misc_QuestionMark"
        } else {
            stem
        }
    )
}

pub(super) fn plate_chunk(
    frame: &PlannerUiFrame,
    layout: &mut Layout,
    viewport: [f32; 2],
    dt: f32,
    seam: f32,
) -> String {
    let mut candidates = Vec::new();
    let mut data = HashMap::new();
    if frame.nameplates {
        for unit in &frame.units {
            if !unit.visible || unit.health_known && unit.health == 0 || unit.distance > 80. {
                continue;
            }
            let Some(screen) = unit.anchor else { continue };
            if screen[0] < 0.
                || screen[1] < 0.
                || screen[0] > viewport[0]
                || screen[1] > viewport[1]
            {
                continue;
            }
            let selected = frame.selected == Some(unit.guid);
            let friendly = unit.player || unit.friendly;
            if friendly && !frame.friendly_nameplates || !friendly && !frame.enemy_nameplates {
                continue;
            }
            let color = crate::planner_unit_colors::nameplate_color(
                unit.player,
                unit.class,
                unit.estimated,
                unit.friendly,
            );
            let mut auras: Vec<_> = unit
                .auras
                .iter()
                .filter(|a| a.active)
                .filter(|a| !friendly || selected || a.debuff)
                .collect();
            auras.sort_by_key(|a| (!a.debuff, a.spell));
            auras.truncate(if friendly && !selected { 2 } else { 4 });
            let width = if selected {
                154.
            } else if friendly {
                104.
            } else {
                140.
            };
            let height = 13.
                + if friendly && !selected { 5. } else { 10. }
                + if unit.cast.is_some() { 14. } else { 0. }
                + if auras.is_empty() { 0. } else { 18. };
            candidates.push(Candidate {
                key: unit.guid,
                anchor: screen,
                size: [width, height],
                priority: if selected {
                    0
                } else if !friendly {
                    1
                } else {
                    2
                },
            });
            let name = if unit.estimated {
                format!("~ {}", unit.name)
            } else {
                unit.name.clone()
            };
            let health = if unit.health_known {
                unit.health as f32 / unit.max_health.max(1) as f32
            } else {
                0.
            };
            let hptext = if unit.health_known {
                format!("{:.0}%", health * 100.)
            } else {
                "?".into()
            };
            let aura_text = auras
                .iter()
                .map(|a| {
                    format!(
                        "{{icon={},stack={},debuff={}}}",
                        quote(&icon(&a.icon)),
                        a.stack,
                        a.debuff,
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let cast = unit
                .cast
                .as_ref()
                .map(|c| {
                    format!(
                        "{{name={},icon={},progress={:.4},remaining={}}}",
                        quote(&c.name),
                        quote(&icon(&c.icon)),
                        c.progress.clamp(0., 1.),
                        quote(&format!("{:.1}", c.remaining.max(0.))),
                    )
                })
                .unwrap_or("nil".into());
            data.insert(unit.guid, format!(
                "key={},name={},w={width},h={height},friendly={friendly},selected={selected},r={},g={},b={},health={:.4},hptext={},cast={cast},auras={{{aura_text}}}",
                quote(&unit.guid.to_string()), quote(&name), color[0], color[1], color[2], health.clamp(0., 1.), quote(&hptext),
            ));
        }
    }
    let placed = layout.place(candidates, viewport, dt);
    let units = placed
        .iter()
        .filter_map(|p| {
            data.get(&p.key)
                .map(|d| format!("{{x={:.2},y={:.2},{d}}}", p.top[0], p.top[1]))
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "PullFictionPlates_Update({{{units}}},{:.5},{})",
        1. / seam,
        frame.looking
    )
}

pub(super) fn raid_chunk(frame: &PlannerUiFrame, viewport: [f32; 2], seam: f32) -> String {
    let mut units: Vec<_> = frame.units.iter().filter(|u| u.raid).collect();
    units.sort_by(|a, b| a.key.cmp(&b.key));
    units.truncate(40);
    let rows = units.iter().map(|u| {
        let auras = u.auras.iter().map(|a| format!(
            "{{spell={},name={},icon={},stack={},debuff={}}}", a.spell, quote(&a.name), quote(&icon(&a.icon)), a.stack, a.debuff,
        )).collect::<Vec<_>>().join(",");
        let cast = u.cast.as_ref().map(|c| format!(
            "{{name={},progress={:.4},remaining={}}}", quote(&c.name), c.progress.clamp(0., 1.), quote(&format!("{:.1}", c.remaining.max(0.))),
        )).unwrap_or("nil".into());
        format!(
            "{{guid={},name={},class={},hp={},max={},known={},power={},maxpower={},powertype={},powerknown={},selected={},cast={cast},auras={{{auras}}}}}",
            quote(&u.guid.to_string()), quote(&u.name), u.class, u.health, u.max_health.max(1), u.health_known,
            u.power, u.max_power, u.power_type, u.power_known, frame.selected == Some(u.guid),
        )
    }).collect::<Vec<_>>().join(",");
    let [w, h] = frame.raid_frame_size;
    let w = if w > 0. { w } else { 724. };
    let h = if h > 0. { h } else { 276. };
    let layout = crate::planner_raid_layout::layout(
        units.len(),
        w.min((viewport[0] - 24.).max(80.)),
        h.min((viewport[1] - 24.).max(80.)),
    );
    format!(
        "PullFictionRaid_Update({{{rows}}},{},{:.5},{},{:.5})",
        frame.raid_frames,
        1. / seam,
        layout.rows,
        layout.scale
    )
}
