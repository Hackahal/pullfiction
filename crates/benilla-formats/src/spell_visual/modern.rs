//! Pull Fiction's modern DB2-derived resolver. Legacy DBC data remains available
//! for native 1.12 play; the browser asset worker supplies this build-pinned graph.
use super::*;
use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub struct EffectPlacement {
    pub offset: [f32; 3],
    pub rotation: [f32; 3],
    pub scale: f32,
    pub delay: f32,
}
const EFFECT_BASE: u32 = 0x4000_0000;
fn id(value: &Value) -> u32 {
    value
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}
fn object<'a>(v: &'a Value, key: &str) -> Result<&'a serde_json::Map<String, Value>> {
    v[key]
        .as_object()
        .with_context(|| format!("modern effects missing {key}"))
}
impl SpellVisualCatalog {
    /// All authored projectile models, layered on a shared flight and arrival.
    pub fn missile_effects(&self, visual: u32) -> &[u32] {
        self.modern_missiles
            .get(&visual)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub fn placement(&self, effect: u32) -> Option<EffectPlacement> {
        self.modern_placements.get(&effect).copied()
    }
    /// All authored model attachments, without the original nine-slot limit.
    pub fn model_attachments(&self, kit: &VisualKit) -> Vec<(u16, u32)> {
        if kit.modern_id != 0 {
            return self
                .modern_attachments
                .get(&kit.modern_id)
                .cloned()
                .unwrap_or_default();
        }
        kit.effects().collect()
    }
    pub fn merge_modern_json(&mut self, bytes: &[u8]) -> Result<()> {
        let data: Value = serde_json::from_slice(bytes)?;
        anyhow::ensure!(data["schema"] == 1, "unsupported modern spell graph schema");
        let effects = object(&data, "effects")?;
        for (key, row) in effects {
            let key: u32 = key.parse()?;
            if id(&row["type"]) == 0 && id(&row["fileDataID"]) != 0 {
                self.effect_paths.insert(
                    EFFECT_BASE + key,
                    format!("__classic/{}.m2", id(&row["fileDataID"])),
                );
            }
        }
        for (key, row) in object(&data, "kits")? {
            let key: u32 = key.parse()?;
            let attachments = row["effects"]
                .as_array()
                .context("missing kit attachments")?;
            let paths = attachments
                .iter()
                .filter_map(|a| {
                    let source = EFFECT_BASE + id(&a["effect"]);
                    let effect = 0x5000_0000 + id(&a["id"]);
                    let path = self.effect_paths.get(&source)?.clone();
                    self.effect_paths.insert(effect, path);
                    let floats = |field: &str| {
                        std::array::from_fn(|i| a[field][i].as_f64().unwrap_or(0.0) as f32)
                    };
                    let scale = a["scale"].as_f64().unwrap_or(1.0) as f32;
                    self.modern_placements.insert(
                        effect,
                        EffectPlacement {
                            offset: floats("offset"),
                            rotation: floats("rotation"),
                            scale,
                            delay: a["delay"].as_f64().unwrap_or(0.0).max(0.0) as f32,
                        },
                    );
                    let attach = a["attachment"].as_i64().unwrap_or(-1);
                    Some((
                        if attach < 0 {
                            WORLD_EFFECT_TAG
                        } else {
                            u16::try_from(attach).ok()?
                        },
                        effect,
                    ))
                })
                .collect();
            self.modern_attachments.insert(key, paths);
            let anim = row["animations"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|a| {
                    ["LoopAnimID", "InitialAnimID"]
                        .into_iter()
                        .find_map(|field| a[field].as_i64().and_then(|n| u16::try_from(n).ok()))
                });
            self.kits.insert(
                key,
                VisualKit {
                    modern_id: key,
                    anim_id: anim,
                    ..Default::default()
                },
            );
        }
        // Each lifecycle/target may contain several kits. Combine their attachments
        // in a synthetic kit instead of silently keeping the last row.
        let mut synthetic = 0x6000_0000u32;
        for (key, row) in object(&data, "visuals")? {
            let key: u32 = key.parse()?;
            let events = row["events"].as_array().context("missing visual events")?;
            let mut stages = VisualStages::default();
            for (start, target, slot) in [
                ("Precast Start", "Caster", &mut stages.precast),
                ("Cast", "Caster", &mut stages.cast),
                ("Impact", "Target", &mut stages.impact),
                ("Aura Start", "Target", &mut stages.state),
                ("Channel Start", "Caster", &mut stages.channel),
            ] {
                let ids: Vec<u32> = events
                    .iter()
                    .filter(|e| {
                        e["start"] == start
                            && (e["target"] == target
                                || (target == "Target" && e["target"] == "Target (Not Caster)"))
                    })
                    .map(|e| id(&e["kit"]))
                    .filter(|i| self.kits.contains_key(i))
                    .collect();
                if ids.len() == 1 {
                    *slot = ids[0];
                } else if !ids.is_empty() {
                    synthetic += 1;
                    let effects = ids
                        .iter()
                        .flat_map(|i| {
                            self.modern_attachments
                                .get(i)
                                .into_iter()
                                .flatten()
                                .copied()
                        })
                        .collect();
                    self.modern_attachments.insert(synthetic, effects);
                    let anim_id = ids
                        .iter()
                        .find_map(|i| self.kits.get(i).and_then(|k| k.anim_id));
                    self.kits.insert(
                        synthetic,
                        VisualKit {
                            modern_id: synthetic,
                            anim_id,
                            ..Default::default()
                        },
                    );
                    *slot = synthetic;
                }
            }
            let missile_effects = row["missiles"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| EFFECT_BASE + id(&m["effect"]))
                .filter(|e| self.effect_paths.contains_key(e))
                .collect();
            self.modern_missiles.insert(key, missile_effects);
            if let Some(missile) = row["missiles"].as_array().and_then(|m| m.first()) {
                stages.missile_model = EFFECT_BASE + id(&missile["effect"]);
                let tag = missile["destination"].as_i64().unwrap_or(34);
                stages.missile_attach = MISSILE_ATTACH_TABLE
                    .iter()
                    .position(|&x| i64::from(x) == tag)
                    .unwrap_or(1) as u32;
                stages.missile_gate = 1;
            }
            self.visuals.insert(key, stages);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modern_graph_resolves_new_spell_visuals_and_all_attachments() {
        let bytes=serde_json::to_vec(&serde_json::json!({"schema":1,"effects":{"735":{"fileDataID":165578,"type":0}},"kits":{"1005":{"effects":[{"id":3,"effect":735,"attachment":34,"scale":1.5,"offset":[1,2,3],"rotation":[0,0,0],"delay":0.2},{"id":4,"effect":735,"attachment":21,"scale":1,"offset":[0,0,0],"rotation":[0,0,0],"delay":0}],"animations":[]}},"visuals":{"7749":{"events":[{"start":"Impact","target":"Target","kit":1005}],"missiles":[]}},"spells":{"400574":{"visuals":[{"id":7749,"priority":1,"difficulty":0,"conditions":[0,0,0,0]}],"speed":0,"schoolMask":64}}})).unwrap();
        let mut visuals = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        visuals.merge_modern_json(&bytes).unwrap();
        let kit = visuals.kit(visuals.stages(7749).unwrap().impact).unwrap();
        let slots = visuals.model_attachments(kit);
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].0, 34);
        assert_eq!(visuals.effect_path(slots[0].1), Some("__classic/165578.m2"));
        let p = visuals.placement(slots[0].1).unwrap();
        assert_eq!(p.scale, 1.5);
        assert_eq!(p.offset, [1., 2., 3.]);
        let mut spells = crate::SpellCatalog::from_displays(HashMap::new());
        spells.merge_modern_json(&bytes).unwrap();
        assert_eq!(spells.get(400574).unwrap().visual, 7749);
        assert_eq!(spells.get(400574).unwrap().school, 6);
    }
    #[test]
    fn modern_projectiles_keep_all_layers_and_ranged_animation_flags() {
        let data = serde_json::json!({"schema":1,"effects":{"1":{"type":0,"fileDataID":100},"2":{"type":0,"fileDataID":200}},"kits":{},"visuals":{"50":{"events":[],"missiles":[{"effect":1,"destination":34},{"effect":2,"destination":34}]}},"spells":{"409593":{"visuals":[{"id":50,"priority":1,"difficulty":0,"conditions":[0,0,0,0]}],"attributes":[2,0,0,0,0]}}});
        let bytes = serde_json::to_vec(&data).unwrap();
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&bytes).unwrap();
        let paths: Vec<_> = cat
            .missile_effects(50)
            .iter()
            .map(|&id| cat.effect_path(id).unwrap())
            .collect();
        assert_eq!(paths, ["__classic/100.m2", "__classic/200.m2"]);
        let mut spells = crate::SpellCatalog::from_displays(HashMap::new());
        spells.merge_modern_json(&bytes).unwrap();
        assert!(spells.get(409593).unwrap().ranged_slot());
    }
    #[test]
    fn malformed_modern_graph_fails_instead_of_silently_loading_legacy_ids() {
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        assert!(cat.merge_modern_json(br#"{"schema":2}"#).is_err());
        assert!(cat.merge_modern_json(br#"{"schema":1}"#).is_err());
    }
}
