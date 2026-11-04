//! Decoded replay rows shared by the transport and renderer.
use crate::planner_replay_presentation::{ReplayAura, ReplayCast};

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ReplayTrajectoryReference {
    pub source: String,
    pub component: String,
    pub content: String,
    pub at: Option<f64>,
    #[serde(default)]
    pub hold: bool,
}
#[derive(Clone, serde::Deserialize)]
pub struct ReplayTrajectoryBridge {
    pub from: ReplayTrajectoryReference,
    pub to: ReplayTrajectoryReference,
}

#[derive(Clone, serde::Deserialize)]
pub struct ReplayGear {
    pub id: u32,
    pub slot: u16,
    pub display: u32,
    pub class: u32,
    pub subclass: u32,
    pub inventory: u32,
    pub material: i32,
    pub sheath: u32,
    pub name: String,
    pub quality: u32,
    #[serde(default)]
    pub enchant: u32,
    #[serde(default)]
    pub temporary: u32,
}
fn nameplate_default() -> bool {
    true
}

#[derive(Clone, serde::Deserialize)]
pub struct ReplayUnit {
    pub key: String,
    pub name: String,
    pub player: bool,
    pub class: u32,
    pub entry: u32,
    pub display: Option<u32>,
    pub scale: f32,
    pub position: Option<[f32; 3]>,
    pub ground: bool,
    #[serde(default)]
    pub floor_hint: Option<f32>,
    pub facing: f32,
    pub speed: f32,
    #[serde(
        default,
        deserialize_with = "crate::planner_movement::deserialize_optional"
    )]
    pub movement: Option<crate::planner_movement::Segment>,
    #[serde(default)]
    pub trajectory: Option<ReplayTrajectoryReference>,
    #[serde(default)]
    pub trajectory_prepare: Option<ReplayTrajectoryReference>,
    #[serde(default)]
    pub trajectory_bridge: Option<ReplayTrajectoryBridge>,
    pub dead: bool,
    #[serde(default)]
    pub friendly: bool,
    /// Per-actor plate category filter; omitted values preserve older clients.
    #[serde(default = "nameplate_default")]
    pub nameplate: bool,
    #[serde(default)]
    pub raid: bool,
    #[serde(default)]
    pub estimated: bool,
    #[serde(default)]
    pub wisp: bool,
    #[serde(default)]
    pub race: Option<u8>,
    #[serde(default)]
    pub sex: Option<u8>,
    #[serde(default)]
    pub look: [u8; 5],
    #[serde(default)]
    pub gear: Vec<ReplayGear>,
    #[serde(default)]
    pub health: Option<u32>,
    #[serde(default)]
    pub max_health: Option<u32>,
    #[serde(default)]
    pub power: Option<u32>,
    #[serde(default)]
    pub max_power: Option<u32>,
    #[serde(default)]
    pub power_type: u8,
    #[serde(default)]
    pub plate_cast: Option<ReplayCast>,
    #[serde(default)]
    pub plate_auras: Vec<ReplayAura>,
    #[serde(default)]
    pub channel: bool,
    #[serde(default)]
    pub channel_target: Option<String>,
    #[serde(default)]
    pub cast: u32,
    #[serde(default)]
    pub auras: Vec<u32>,
    #[serde(default)]
    pub self_auras: Vec<u32>,
}
