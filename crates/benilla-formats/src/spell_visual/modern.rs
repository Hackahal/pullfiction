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
    pub animation: EffectAnimation,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EffectAnimation {
    pub start: Option<u16>,
    pub loop_anim: Option<u16>,
    pub end: Option<u16>,
}

/// Identity of the exact modern graph bytes consumed by this catalog. This is
/// read-only provenance, separate from whichever file provider is active later.
#[derive(Clone, Debug)]
pub struct ModernGraphProvenance {
    pub byte_len: usize,
    /// FNV-1a over raw bytes, formatted as 16 lowercase hexadecimal digits.
    /// This identifies inputs for diagnostics; it is not a cryptographic digest.
    pub fnv1a64: String,
    pub source: Value,
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
    pub fn modern_graph_provenance(&self) -> Option<&ModernGraphProvenance> {
        self.modern_graph_provenance.as_ref()
    }

    /// Procedural chain effects use full DB2 identifiers. Legacy kit parameters
    /// retain their original encoded small-integer representation.
    pub fn chain_procs(&self, kit: &VisualKit) -> Vec<ChainProc> {
        if kit.modern_id != 0 {
            return self
                .modern_chain_procs
                .get(&kit.modern_id)
                .cloned()
                .unwrap_or_default();
        }
        kit.chain_proc().into_iter().collect()
    }

    /// Modern kits may combine more than the legacy four procedure slots. Keep
    /// every authored trail, including when several event kits share a stage.
    pub fn trail_procs(&self, kit: &VisualKit) -> Vec<TrailProc> {
        if kit.modern_id != 0 {
            return self
                .modern_trail_procs
                .get(&kit.modern_id)
                .cloned()
                .unwrap_or_default();
        }
        kit.trail_proc().into_iter().collect()
    }

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
        if let Some(chains) = data["chainEffects"].as_object() {
            for (key, row) in chains {
                if row["rendererCompatible"] != true {
                    continue;
                }
                let number = |field: &str| -> Result<f32> {
                    let n = row[field]
                        .as_f64()
                        .with_context(|| format!("missing chain {field}"))?
                        as f32;
                    anyhow::ensure!(n.is_finite(), "invalid chain {field}");
                    Ok(n)
                };
                let effect = ChainEffect {
                    avg_seg_len: number("avgSegLen")?,
                    half_width: number("halfWidth")?,
                    noise_scale: number("noiseScale")?,
                    scroll_period_s: number("scrollPeriod")?,
                    bolt_life_ms: id(&row["boltLifeMs"]),
                    bolt_stagger_ms: id(&row["boltStaggerMs"]),
                    texture: format!("__classic/{}.blp", id(&row["textureFileDataIDs"][0])),
                };
                anyhow::ensure!(
                    effect.avg_seg_len >= 0.
                        && effect.half_width >= 0.
                        && effect.noise_scale >= 0.
                        && id(&row["textureFileDataIDs"][0]) != 0,
                    "invalid modern chain geometry or texture"
                );
                self.chain_effects.insert(key.parse()?, effect);
            }
        }
        let effects = object(&data, "effects")?;
        for (key, row) in effects {
            let key: u32 = key.parse()?;
            if id(&row["type"]) == 0 && id(&row["fileDataID"]) != 0 {
                let extension = match row["assetFormat"].as_str() {
                    Some("wmo") => "wmo",
                    Some("m2") | None => "m2", // Existing schema-1 graphs predate header hints.
                    Some(_) => continue, // Unknown or unavailable bytes do not establish a model type.
                };
                self.effect_paths.insert(
                    EFFECT_BASE + key,
                    format!("__classic/{}.{extension}", id(&row["fileDataID"])),
                );
                // Missile layers reference the effect name directly, without a kit
                // attachment (whose exported scale already includes this factor).
                self.modern_placements.insert(
                    EFFECT_BASE + key,
                    EffectPlacement {
                        offset: [0.; 3],
                        rotation: [0.; 3],
                        scale: row["scale"].as_f64().unwrap_or(1.) as f32,
                        delay: 0.,
                        animation: EffectAnimation::default(),
                    },
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
                            animation: {
                                let anim = |field: &str| {
                                    a["animation"][field]
                                        .as_u64()
                                        .and_then(|id| u16::try_from(id).ok())
                                };
                                EffectAnimation {
                                    start: anim("start"),
                                    loop_anim: anim("loop"),
                                    end: anim("end"),
                                }
                            },
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
            let mut procs = Vec::new();
            let mut trails = Vec::new();
            let mut freeze = None;
            for proc in row["proceduralEffects"].as_array().into_iter().flatten() {
                if proc["rendererCompatible"] == false {
                    continue;
                }
                let ty = id(&proc["type"]) as i32;
                // Observed Web Wrap/Spray, Icebolt and Frost Blast kits use
                // exactly this zero-rate instruction. Other rates or extra
                // parameters have not been mapped to legacy body semantics.
                if ty == char_proc_type::ANIM_RATE
                    && proc["values"].as_array().is_some_and(|values| {
                        values.len() == 4 && values.iter().all(|v| v.as_f64() == Some(0.0))
                    })
                {
                    freeze = Some(CharProc {
                        ty,
                        params: [0.; 4],
                    });
                    continue;
                }
                if ty == char_proc_type::WEAPON_TRAIL {
                    let values = std::array::from_fn(|i| proc["values"][i].as_f64());
                    // Mirror the converter's exact subset: RGB and alpha are
                    // packed integers; One is unused by the trail dispatcher.
                    if let [Some(rgb), Some(unused), Some(duration), Some(alpha)] = values {
                        if unused.is_finite()
                            && [
                                (rgb, 0xffffff as f64),
                                (duration, i32::MAX as f64),
                                (alpha, 255.),
                            ]
                            .iter()
                            .all(|&(v, max)| {
                                v.is_finite() && v >= 0. && v <= max && v.fract() == 0.
                            })
                        {
                            if let Some(trail) = (CharProc {
                                ty,
                                params: [rgb as f32, unused as f32, duration as f32, alpha as f32],
                            })
                            .as_weapon_trail()
                            {
                                trails.push(trail);
                            }
                        }
                    }
                    continue;
                }
                if !char_proc_type::is_chain(ty) {
                    continue;
                }
                let value = |index: usize| -> Result<u32> {
                    let value = proc["values"][index]
                        .as_f64()
                        .context("missing chain procedure value")?;
                    anyhow::ensure!(
                        value.is_finite()
                            && value >= 0.
                            && value <= u32::MAX as f64
                            && value.fract() == 0.,
                        "invalid chain procedure value"
                    );
                    Ok(value as u32)
                };
                let effect_id = value(0)?;
                if !self.chain_effects.contains_key(&effect_id) {
                    continue;
                }
                procs.push(ChainProc {
                    effect_id,
                    beams: value(1)?.min(CHAIN_MAX_BEAMS),
                    flag: value(2)? != 0,
                    ty,
                });
            }
            self.modern_chain_procs.insert(key, procs);
            self.modern_trail_procs.insert(key, trails);
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
                    char_proc_slots: [freeze, None, None, None],
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
                ("Cast", "Target", &mut stages.cast_target),
                (
                    "Cast",
                    "Target (Not Caster)",
                    &mut stages.cast_target_not_caster,
                ),
                ("Impact", "Target", &mut stages.impact),
                ("Impact", "Caster", &mut stages.impact_caster),
                (
                    "Impact",
                    "Target (Not Caster)",
                    &mut stages.impact_not_caster,
                ),
                ("Aura Start", "Target", &mut stages.state),
                ("Aura Start", "Self", &mut stages.state_self),
                ("Channel Start", "Caster", &mut stages.channel),
            ] {
                // Modern channel-hold kits also arrive as Target events. The native
                // channel slot is played on the owner of UNIT_CHANNEL_SPELL. Keep
                // explicit Caster events when the visual provides them.
                let target = if start == "Channel Start"
                    && !events
                        .iter()
                        .any(|e| e["start"] == start && e["target"] == "Caster")
                {
                    "Target"
                } else {
                    target
                };
                let mut ids: Vec<u32> = events
                    .iter()
                    .filter(|e| {
                        e["start"] == start
                            && (e["target"] == target
                                || target == "Self"
                                    && (e["target"] == "Target" || e["target"] == "Caster")
                                || (target == "Target"
                                    && start != "Impact"
                                    && start != "Cast"
                                    && e["target"] == "Target (Not Caster)"))
                    })
                    .map(|e| id(&e["kit"]))
                    .filter(|i| self.kits.contains_key(i))
                    .collect();
                if target == "Self" {
                    // Caster and Target can name the same kit on a self aura.
                    // Preserve order without spawning its attachments twice.
                    let mut seen = Vec::new();
                    ids.retain(|id| {
                        if seen.contains(id) {
                            false
                        } else {
                            seen.push(*id);
                            true
                        }
                    });
                }
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
                    let procs = ids
                        .iter()
                        .flat_map(|id| {
                            self.modern_chain_procs
                                .get(id)
                                .into_iter()
                                .flatten()
                                .copied()
                        })
                        .collect();
                    self.modern_chain_procs.insert(synthetic, procs);
                    let trails = ids
                        .iter()
                        .flat_map(|id| {
                            self.modern_trail_procs
                                .get(id)
                                .into_iter()
                                .flatten()
                                .copied()
                        })
                        .collect();
                    self.modern_trail_procs.insert(synthetic, trails);
                    let anim_id = ids
                        .iter()
                        .find_map(|i| self.kits.get(i).and_then(|k| k.anim_id));
                    // Every imported body instruction currently has identical
                    // freeze semantics. Collapse duplicates rather than impose
                    // the legacy four-slot limit on a combined modern stage.
                    let freeze = ids
                        .iter()
                        .filter_map(|id| self.kits.get(id))
                        .flat_map(VisualKit::char_procs)
                        .find(|p| p.ty == char_proc_type::ANIM_RATE && p.params == [0.; 4]);
                    self.kits.insert(
                        synthetic,
                        VisualKit {
                            modern_id: synthetic,
                            anim_id,
                            char_proc_slots: [freeze, None, None, None],
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
        self.modern_graph_provenance = Some(ModernGraphProvenance {
            byte_len: bytes.len(),
            fnv1a64: format!(
                "{:016x}",
                bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
                    (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
                })
            ),
            source: data["source"].clone(),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modern_exact_zero_rate_freezes_survive_combined_aura_kits() {
        let freeze = serde_json::json!({"type":11,"values":[0,0,0,0]});
        let data = serde_json::json!({"schema":1,"effects":{},
            "kits":{
                "3378":{"effects":[],"animations":[],"proceduralEffects":[freeze.clone()]},
                "22":{"effects":[],"animations":[],"proceduralEffects":vec![freeze;6]},
                "23":{"effects":[],"animations":[],"proceduralEffects":[
                    {"type":11,"values":[0,2,0,0]},
                    {"type":11,"values":[1,0,0,0]},
                    {"type":11,"values":[0,0,0]},
                    {"type":11,"values":[0,0,0,null]},
                    {"type":11,"values":[0,0,0,0],"rendererCompatible":false},
                    {"type":14,"values":[0,0,0,0]}]}},
            "visuals":{"50":{"missiles":[],"events":[
                {"start":"Aura Start","target":"Caster","kit":3378},
                {"start":"Aura Start","target":"Target","kit":22}]}}});
        let mut catalog = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        catalog
            .merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        let expected = [CharProc {
            ty: char_proc_type::ANIM_RATE,
            params: [0.; 4],
        }];
        assert_eq!(
            catalog.kit(3378).unwrap().char_procs().collect::<Vec<_>>(),
            expected
        );
        assert!(
            catalog.kit(23).unwrap().char_procs().next().is_none(),
            "untraced rates, flags, missing values and other proc types stay unsupported"
        );
        let kit = *catalog.kit(catalog.stages(50).unwrap().state_self).unwrap();
        assert_eq!(
            kit.char_procs().collect::<Vec<_>>(),
            expected,
            "identical freeze instructions have one semantic node, with no four-slot truncation"
        );
    }
    #[test]
    fn modern_self_aura_combines_owners_without_duplicating_or_including_not_caster() {
        let data = serde_json::json!({"schema":1,"effects":{},
            "kits":{"10":{"effects":[],"animations":[{"LoopAnimID":124}]},
                    "11":{"effects":[],"animations":[{"LoopAnimID":125}]},
                    "12":{"effects":[],"animations":[{"LoopAnimID":126}]}},
            "visuals":{
                "50":{"events":[{"start":"Aura Start","target":"Caster","kit":10}],"missiles":[]},
                "51":{"events":[{"start":"Aura Start","target":"Target","kit":10},
                                    {"start":"Aura Start","target":"Caster","kit":10}],"missiles":[]},
                "52":{"events":[{"start":"Aura Start","target":"Target","kit":10},
                                    {"start":"Aura Start","target":"Caster","kit":11},
                                    {"start":"Aura Start","target":"Target (Not Caster)","kit":12}],"missiles":[]}}});
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        assert_eq!(
            cat.stages(50).unwrap().state,
            0,
            "unknown/nonself never takes the Caster route"
        );
        assert_eq!(cat.stages(50).unwrap().state_self, 10);
        assert_eq!(
            cat.stages(51).unwrap().state_self,
            10,
            "same kit is not doubled"
        );
        let combined = cat.kit(cat.stages(52).unwrap().state_self).unwrap();
        assert_eq!(combined.anim_id, Some(124));
        // Distinct Caster and Target kits are combined, excluding Not Caster.
        assert_ne!(
            cat.stages(52).unwrap().state_self,
            cat.stages(52).unwrap().state
        );
    }
    #[test]
    fn modern_attachment_animation_override_keeps_explicit_stand_zero() {
        let data = serde_json::json!({"schema":1,"effects":{"1":{"type":0,"fileDataID":100}},
            "kits":{"7":{"effects":[{"id":8,"effect":1,"attachment":34,
                "animation":{"start":0,"loop":144,"end":193}}],"animations":[]}},"visuals":{}});
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        let (_, effect) = cat.model_attachments(cat.kit(7).unwrap())[0];
        let phases = cat.placement(effect).unwrap().animation;
        assert_eq!(
            (phases.start, phases.loop_anim, phases.end),
            (Some(0), Some(144), Some(193))
        );
    }
    #[test]
    fn modern_effect_paths_use_probed_formats_and_do_not_guess_unknown_headers() {
        let data = serde_json::json!({"schema":1,"effects":{
            "1":{"type":0,"fileDataID":100,"assetFormat":"m2"},
            "2":{"type":0,"fileDataID":200,"assetFormat":"wmo"},
            "3":{"type":0,"fileDataID":300,"assetFormat":"unknown"},
            "4":{"type":0,"fileDataID":400}},"kits":{},"visuals":{}});
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        assert_eq!(cat.effect_path(EFFECT_BASE + 1), Some("__classic/100.m2"));
        assert_eq!(cat.effect_path(EFFECT_BASE + 2), Some("__classic/200.wmo"));
        assert_eq!(cat.effect_path(EFFECT_BASE + 3), None);
        assert_eq!(
            cat.effect_path(EFFECT_BASE + 4),
            Some("__classic/400.m2"),
            "old graphs retain compatibility"
        );
    }
    #[test]
    fn modern_weapon_trails_preserve_all_slots_and_combined_event_kits() {
        let proc = serde_json::json!({"type":8,"values":[14304033,20,600,100]});
        let data = serde_json::json!({"schema":1,"effects":{},
            "kits":{"1":{"effects":[],"animations":[],"proceduralEffects":vec![proc.clone();6]},
                    "2":{"effects":[],"animations":[],"proceduralEffects":[proc,
                        {"type":8,"values":[1,20,0,100]},
                        {"type":8,"values":[1,20,600,256]},
                        {"type":14,"values":[0.3,0,0,0]}]}},
            "visuals":{"7":{"missiles":[],"events":[
                {"start":"Cast","target":"Caster","kit":1},
                {"start":"Cast","target":"Caster","kit":2}]}}});
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        let trails = cat.trail_procs(cat.kit(cat.stages(7).unwrap().cast).unwrap());
        assert_eq!(trails.len(), 7, "modern data has no four-slot truncation");
        assert!(trails
            .iter()
            .all(|t| t.rgb() == [0xda, 0x43, 0x21] && t.alpha() == 100 && t.duration_ms == 600));
        assert!(
            cat.kit(2).unwrap().char_procs().next().is_none(),
            "unimplemented body procedures do not enter legacy aura semantics"
        );
        let legacy = VisualKit {
            char_proc_slots: [
                Some(CharProc {
                    ty: 8,
                    params: [14304033., 20., 600., 100.],
                }),
                None,
                None,
                None,
            ],
            ..Default::default()
        };
        assert_eq!(cat.trail_procs(&legacy), trails[..1]);
    }
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
        assert_eq!(visuals.placement(EFFECT_BASE + 735).unwrap().scale, 1.);
        let mut spells = crate::SpellCatalog::from_displays(HashMap::new());
        spells.merge_modern_json(&bytes).unwrap();
        assert_eq!(spells.get(400574).unwrap().visual, 7749);
        assert_eq!(spells.get(400574).unwrap().school, 6);
    }
    #[test]
    fn modern_projectiles_keep_all_layers_and_ranged_animation_flags() {
        let data = serde_json::json!({"schema":1,"effects":{"1":{"type":0,"fileDataID":100,"scale":20},"2":{"type":0,"fileDataID":200,"scale":0.5}},"kits":{},"visuals":{"50":{"events":[],"missiles":[{"effect":1,"destination":34},{"effect":2,"destination":34}]}},"spells":{"409593":{"visuals":[{"id":50,"priority":1,"difficulty":0,"conditions":[0,0,0,0]}],"attributes":[2,0,0,0,0]}}});
        let bytes = serde_json::to_vec(&data).unwrap();
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&bytes).unwrap();
        let paths: Vec<_> = cat
            .missile_effects(50)
            .iter()
            .map(|&id| cat.effect_path(id).unwrap())
            .collect();
        assert_eq!(paths, ["__classic/100.m2", "__classic/200.m2"]);
        assert_eq!(
            cat.missile_effects(50)
                .iter()
                .map(|&id| cat.placement(id).unwrap().scale)
                .collect::<Vec<_>>(),
            [20., 0.5]
        );
        let mut spells = crate::SpellCatalog::from_displays(HashMap::new());
        spells.merge_modern_json(&bytes).unwrap();
        assert!(spells.get(409593).unwrap().ranged_slot());
    }
    #[test]
    fn malformed_modern_graph_fails_instead_of_silently_loading_legacy_ids() {
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        assert!(cat.merge_modern_json(br#"{"schema":2}"#).is_err());
        assert!(cat.merge_modern_json(br#"{"schema":1}"#).is_err());
        assert!(cat.modern_graph_provenance().is_none());
    }

    #[test]
    fn modern_provenance_identifies_consumed_bytes_and_preserves_source() {
        let bytes =
            br#"{"schema":1,"source":{"version":"1.15.9"},"effects":{},"kits":{},"visuals":{}}"#;
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        assert!(cat.modern_graph_provenance().is_none());
        cat.merge_modern_json(bytes).unwrap();
        let provenance = cat.modern_graph_provenance().unwrap();
        assert_eq!(provenance.byte_len, bytes.len());
        assert_eq!(provenance.fnv1a64, "aac74ac21a4d6010");
        assert_eq!(provenance.source["version"], "1.15.9");
        let fingerprint = provenance.fnv1a64.clone();
        let with_space = [bytes.as_slice(), b" "].concat();
        cat.merge_modern_json(&with_space).unwrap();
        assert_ne!(cat.modern_graph_provenance().unwrap().fnv1a64, fingerprint);
    }

    #[test]
    fn modern_target_channel_holds_resolve_without_merging_explicit_caster_kits() {
        let data = serde_json::json!({
            "schema":1, "effects":{},
            "kits": {
                "10":{"effects":[],"animations":[{"LoopAnimID":124}]},
                "11":{"effects":[],"animations":[{"LoopAnimID":125}]}
            },
            "visuals": {
                "50":{"events":[{"start":"Channel Start","target":"Target","kit":10}],"missiles":[]},
                "51":{"events":[{"start":"Channel Start","target":"Target","kit":10},{"start":"Channel Start","target":"Caster","kit":11}],"missiles":[]}
            }
        });
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        let target = cat.stages(50).unwrap().channel;
        assert_eq!(target, 10);
        assert_eq!(cat.kit(target).unwrap().anim_id, Some(124));
        assert_eq!(cat.stages(51).unwrap().channel, 11);
    }

    #[test]
    fn modern_procedural_chains_keep_full_ids_and_combined_stage_kits() {
        let data = serde_json::json!({
            "schema": 1, "effects": {},
            "chainEffects": {
                "8227": {"rendererCompatible": true, "avgSegLen": 2.78, "halfWidth": 0.25,
                    "noiseScale": 0.01, "scrollPeriod": -0.5, "boltLifeMs": 1000,
                    "boltStaggerMs": 200, "textureFileDataIDs": [186202, 0, 0]},
                "9": {"rendererCompatible": false}
            },
            "kits": {
                "402": {"effects": [], "animations": [], "proceduralEffects": [
                    {"type": 0, "values": [8227, 1, 1, 0]},
                    {"type": 0, "values": [9, 1, 1, 0]}]},
                "403": {"effects": [], "animations": [], "proceduralEffects": [
                    {"type": 12, "values": [8227, 9, 0, 0]}]}
            },
            "visuals": {"177": {"events": [
                {"start": "Channel Start", "target": "Target", "kit": 402},
                {"start": "Channel Start", "target": "Target", "kit": 403}], "missiles": []}}
        });
        let mut cat = SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
        cat.merge_modern_json(&serde_json::to_vec(&data).unwrap())
            .unwrap();
        let effect = cat.chain_effect(8227).unwrap();
        assert_eq!(effect.texture, "__classic/186202.blp");
        assert_eq!((effect.half_width, effect.scroll_period_s), (0.25, -0.5));
        assert!(cat.chain_effect(9).is_none());
        let kit = cat.kit(cat.stages(177).unwrap().channel).unwrap();
        assert_eq!(
            cat.chain_procs(kit),
            [
                ChainProc {
                    effect_id: 8227,
                    beams: 1,
                    flag: true,
                    ty: 0
                },
                ChainProc {
                    effect_id: 8227,
                    beams: 3,
                    flag: false,
                    ty: 12
                }
            ]
        );
        let mut invalid = data.clone();
        invalid["kits"]["402"]["proceduralEffects"][0]["values"][1] = serde_json::json!(1.5);
        assert!(cat
            .merge_modern_json(&serde_json::to_vec(&invalid).unwrap())
            .is_err());
        // The converter retains non-finite authored bits as JSON-safe nulls and
        // explicitly disables that procedure; it must not abort the whole graph.
        invalid["kits"]["402"]["proceduralEffects"][0] = serde_json::json!({
            "type": 0, "values": [null, 1, 0, 0],
            "rawValueBits": [2139095040u32, 1065353216u32, 0, 0],
            "rendererCompatible": false
        });
        cat.merge_modern_json(&serde_json::to_vec(&invalid).unwrap())
            .unwrap();
        assert!(cat.chain_procs(cat.kit(402).unwrap()).is_empty());
        assert_eq!(cat.chain_procs(cat.kit(403).unwrap()).len(), 1);
    }
}
