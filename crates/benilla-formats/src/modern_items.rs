//! Modern item display lookup used by the project browser renderer.
use crate::{ItemDisplay, ItemDisplayCatalog};
use anyhow::{Context, Result};
use serde_json::Value;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
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
