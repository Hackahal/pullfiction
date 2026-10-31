//! Modern item display lookup used by the project browser renderer.
use crate::{ItemDisplay, ItemDisplayCatalog};
use anyhow::{Context, Result};
use serde_json::Value;

pub(crate) fn particle_colors(row: &Value) -> Result<Option<crate::ParticleColorPalette>> {
    let value = &row["particleColors"];
    if value.is_null() {
        anyhow::ensure!(
            row["particleColorID"].as_u64().unwrap_or(0) == 0,
            "display has an unresolved ParticleColor palette"
        );
        return Ok(None);
    }
    let palette: crate::ParticleColorPalette = serde_json::from_value(value.clone())?;
    anyhow::ensure!(
        palette
            .iter()
            .flatten()
            .flatten()
            .all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
        "invalid display ParticleColor RGB value"
    );
    Ok(Some(palette))
}
fn pick(rows: &Value) -> Option<u32> {
    let rows = rows.as_array()?;
    let row = rows.iter().min_by_key(|r| {
        (
            (r["race"] != 0) as u8,
            (r["sex"] != 0 && r["sex"] != -1) as u8,
        )
    })?;
    row["file"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|&n| n > 0)
}
pub fn merge(catalog: &mut ItemDisplayCatalog, bytes: &[u8]) -> Result<()> {
    let data: Value = serde_json::from_slice(bytes)?;
    anyhow::ensure!(data["schema"] == 1, "unsupported modern item graph");
    let rows = data["displays"]
        .as_object()
        .context("modern item displays missing")?;
    for (id, row) in rows {
        let id = id.parse()?;
        if catalog.get(id).is_some() {
            continue;
        }
        catalog.insert_modern(
            id,
            ItemDisplay {
                modern_display_id: Some(id),
                particle_colors: particle_colors(row)?,
                item_visual: i32::try_from(row["visual"].as_i64().unwrap_or(0))
                    .context("invalid modern item visual id")?,
                spell_visual: row["rangedVisual"].as_u64().unwrap_or(0) as u32,
                modern_models: std::array::from_fn(|i| {
                    row["models"][i]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|r| {
                            Some((
                                r["race"].as_i64()? as u8,
                                r["sex"].as_i64()? as u8,
                                r["file"].as_u64()? as u32,
                            ))
                        })
                        .collect()
                }),
                model: std::array::from_fn(|i| {
                    pick(&row["models"][i]).map(|id| format!("__classic/{id}.m2"))
                }),
                model_texture: std::array::from_fn(|i| {
                    pick(&row["textures"][i]).map(|id| format!("__classic/{id}.blp"))
                }),
                region_textures: std::array::from_fn(|i| {
                    pick(&row["regions"][i.to_string()]).map(|id| format!("__classic/{id}.blp"))
                }),
                geoset_groups: std::array::from_fn(|i| {
                    row["geosets"][i].as_u64().unwrap_or(0) as u32
                }),
                helmet_vis: std::array::from_fn(|i| row["helmet"][i].as_u64().unwrap_or(0) as u32),
                ..Default::default()
            },
        );
    }
    Ok(())
}

pub(crate) fn visual_catalog(bytes: &[u8]) -> Result<crate::ItemVisualCatalog> {
    let data: Value = serde_json::from_slice(bytes)?;
    anyhow::ensure!(data["schema"] == 1, "unsupported modern item graph");
    let rows = data["itemVisuals"]
        .as_object()
        .context("modern item visual rows missing")?;
    let mut visuals = std::collections::HashMap::new();
    for (id, row) in rows {
        let id: u32 = id.parse()?;
        anyhow::ensure!(id > 0, "invalid modern item visual row id");
        let slots: [i64; crate::ITEM_VISUAL_SLOTS] = serde_json::from_value(row.clone())?;
        let mut paths = std::array::from_fn(|_| None);
        for (index, slot) in slots.into_iter().enumerate() {
            anyhow::ensure!(
                (i64::from(i32::MIN)..=i64::from(i32::MAX)).contains(&slot),
                "invalid modern item visual model id"
            );
            if slot > 0 {
                paths[index] = Some(format!("__classic/{slot}.m2"));
            }
        }
        visuals.insert(id, paths);
    }
    Ok(crate::ItemVisualCatalog::from_visuals(visuals))
}

pub(crate) fn enchant_catalog(bytes: &[u8]) -> Result<crate::EnchantCatalog> {
    let visual_rows = visual_catalog(bytes)?;
    let data: Value = serde_json::from_slice(bytes)?;
    let rows = data["enchantments"]
        .as_object()
        .context("modern enchantment rows missing")?;
    let (mut visuals, mut names, mut flags) = (
        std::collections::HashMap::new(),
        std::collections::HashMap::new(),
        std::collections::HashMap::new(),
    );
    for (id, row) in rows {
        let id: u32 = id.parse()?;
        anyhow::ensure!(id > 0, "invalid modern enchantment row id");
        let visual = i32::try_from(
            row["visual"]
                .as_i64()
                .context("modern enchantment visual missing")?,
        )?;
        anyhow::ensure!(
            visual <= 0 || visual_rows.effects(visual).is_some(),
            "modern enchantment references an absent item visual"
        );
        if visual != 0 {
            visuals.insert(id, visual);
        }
        let name = row["name"]
            .as_str()
            .context("modern enchantment name missing")?;
        if !name.is_empty() {
            names.insert(id, name.to_owned());
        }
        flags.insert(
            id,
            u32::try_from(
                row["flags"]
                    .as_u64()
                    .context("modern enchantment flags missing")?,
            )?,
        );
    }
    Ok(crate::EnchantCatalog::from_rows(visuals, names, flags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn modern_item_visuals_and_enchants_preserve_slots_and_legacy_displays() {
        let graph = serde_json::json!({"schema":1,"displays":{"8":{"visual":7}},
            "itemVisuals":{"7":[0,77,0,-1,88]},
            "enchantments":{"9":{"visual":7,"flags":1,"name":"Authored enchant","hordeName":"Alternate"}}});
        let bytes = serde_json::to_vec(&graph).unwrap();
        let modern = ItemDisplayCatalog::from_modern_json(&bytes).unwrap();
        assert_eq!(modern.get(8).unwrap().item_visual, 7);
        let visuals = crate::ItemVisualCatalog::from_modern_json(&bytes).unwrap();
        assert_eq!(
            visuals.effects(7).unwrap(),
            &[
                None,
                Some("__classic/77.m2".into()),
                None,
                None,
                Some("__classic/88.m2".into())
            ]
        );
        let enchant = crate::EnchantCatalog::from_modern_json(&bytes).unwrap();
        assert_eq!(enchant.visual(9), Some(7));
        assert_eq!(enchant.name(9), Some("Authored enchant"));
        assert!(enchant.binds_the_item(9));
        let mut legacy = ItemDisplayCatalog::from_displays(HashMap::from([(
            8,
            ItemDisplay {
                item_visual: 99,
                ..Default::default()
            },
        )]));
        merge(&mut legacy, &bytes).unwrap();
        assert_eq!(
            legacy.get(8).unwrap().item_visual,
            99,
            "existing legacy row wins deterministically"
        );
    }

    #[test]
    fn modern_item_visuals_reject_invalid_model_and_enchant_references() {
        let mut graph = serde_json::json!({"schema":1,"itemVisuals":{"7":[0,77,0,0,0]},
            "enchantments":{"9":{"visual":999,"flags":0,"name":""}}});
        assert!(enchant_catalog(&serde_json::to_vec(&graph).unwrap()).is_err());
        graph["itemVisuals"]["7"] = serde_json::json!([77, 0, 0]);
        assert!(visual_catalog(&serde_json::to_vec(&graph).unwrap()).is_err());
        graph["itemVisuals"]["7"] = serde_json::json!([4294967295u64, 0, 0, 0, 0]);
        assert!(visual_catalog(&serde_json::to_vec(&graph).unwrap()).is_err());
    }
    #[test]
    fn display_particle_palette_requires_resolved_finite_rgb() {
        let palette = [[[0.25f32; 3]; 3]; 3];
        assert_eq!(
            particle_colors(&serde_json::json!({"particleColorID":7,"particleColors":palette}))
                .unwrap(),
            Some(palette)
        );
        assert!(particle_colors(&serde_json::json!({"particleColorID":7})).is_err());
        let invalid = [[[2f32; 3]; 3]; 3];
        assert!(particle_colors(&serde_json::json!({"particleColors":invalid})).is_err());
        assert!(particle_colors(&serde_json::json!({})).unwrap().is_none());
    }
    #[test]
    fn modern_display_uses_fdid_assets_and_race_sex_variants() {
        let mut catalog = ItemDisplayCatalog::from_displays(HashMap::new());
        let data = serde_json::json!({"schema":1,"displays":{"696393":{"models":[[{"file":100,"race":1,"sex":0},{"file":101,"race":7,"sex":1}],[]],"textures":[[{"file":200}],[]],"regions":{"3":[{"file":300}]},"geosets":[1,2,3],"helmet":[0,0],"rangedVisual":5}}});
        merge(&mut catalog, &serde_json::to_vec(&data).unwrap()).unwrap();
        let row = catalog.get(696393).unwrap();
        assert_eq!(row.modern_display_id, Some(696393));
        assert_eq!(row.spell_visual, 5);
        assert_eq!(row.model[0].as_deref(), Some("__classic/100.m2"));
        assert_eq!(
            row.modern_model(0, 7, 1).as_deref(),
            Some("__classic/101.m2")
        );
        assert_eq!(row.region_textures[3].as_deref(), Some("__classic/300.blp"));
    }
}
