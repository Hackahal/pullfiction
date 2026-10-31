//! Modern named DB2 fields at the original creature-catalog boundary.
use super::*;
use serde_json::{Map, Value};

const GRAPH: &str = "__classic/creature-catalog.json";

fn rows<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>> {
    value[field]
        .as_object()
        .with_context(|| format!("modern creature catalog missing {field}"))
}

fn unsigned(value: &Value, field: &str) -> Result<u32> {
    u32::try_from(
        value[field]
            .as_u64()
            .with_context(|| format!("invalid creature {field}"))?,
    )
    .with_context(|| format!("creature {field} exceeds u32"))
}

fn signed(value: &Value, field: &str) -> Result<i32> {
    i32::try_from(
        value[field]
            .as_i64()
            .with_context(|| format!("invalid creature {field}"))?,
    )
    .with_context(|| format!("creature {field} exceeds i32"))
}

fn number(value: &Value, field: &str) -> Result<f32> {
    let number = value[field]
        .as_f64()
        .with_context(|| format!("invalid creature {field}"))? as f32;
    anyhow::ensure!(number.is_finite(), "non-finite creature {field}");
    Ok(number)
}

fn byte(value: &Value, field: &str) -> Result<u8> {
    Ok(u8::try_from(unsigned(value, field)?)?)
}

fn source_and_layouts(data: &Value) -> Result<()> {
    anyhow::ensure!(
        data["schema"] == 1,
        "unsupported modern creature catalog schema"
    );
    let source = &data["source"];
    let version = source["version"]
        .as_str()
        .context("missing creature source version")?;
    let build = source["buildKey"]
        .as_str()
        .context("missing creature source build key")?;
    anyhow::ensure!(
        source["product"] == "wow_classic_era"
            && version
                .strip_prefix("1.15.9.")
                .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            && build.len() == 32
            && build
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "creature catalog requires an identified Classic Era 1.15.9 source"
    );
    for (table, layout) in [
        ("CreatureDisplayInfo", "f75f884c"),
        ("CreatureModelData", "3ffee408"),
        ("CreatureDisplayInfoExtra", "f5e49981"),
        ("CreatureSoundData", "e5ee765b"),
        ("TextureFileData", "bd7c74c2"),
        ("ComponentTextureFileData", "b32b030a"),
    ] {
        anyhow::ensure!(
            data["tableLayouts"][table] == layout,
            "unsupported modern {table} layout"
        );
    }
    Ok(())
}

pub(super) fn load(read: impl FnOnce(&str) -> Result<Vec<u8>>) -> Result<CreatureCatalog> {
    let bytes = read(GRAPH).context("reading browser-local modern creature catalog")?;
    from_json(&bytes).context("loading browser-local modern creature catalog")
}

fn from_json(bytes: &[u8]) -> Result<CreatureCatalog> {
    let data: Value = serde_json::from_slice(bytes)?;
    source_and_layouts(&data)?;
    let mut catalog = CreatureCatalog::default();
    let mut model_ids = HashSet::new();
    for (key, row) in rows(&data, "models")? {
        let key: u32 = key.parse()?;
        model_ids.insert(key);
        catalog.model_sounds.insert(key, unsigned(row, "soundID")?);
        let file = unsigned(row, "fileDataID")?;
        if file == 0 {
            // Authored unnamed model rows have record identity but no model asset.
            continue;
        }
        let path = if let Some(alias) = row["pathAlias"].as_str() {
            anyhow::ensure!(
                alias.starts_with("Character\\")
                    && alias.ends_with(".m2")
                    && !alias.contains("..")
                    && data["characterModelPaths"][alias] == file,
                "invalid modern character model alias"
            );
            for (table, layout) in [
                ("ChrRaces", "47a2e62f"),
                ("ChrRaceXChrModel", "a203bc29"),
                ("ChrModel", "03fab755"),
            ] {
                anyhow::ensure!(
                    data["tableLayouts"][table] == layout,
                    "unsupported character alias {table} layout"
                );
            }
            alias.to_string()
        } else {
            format!("__classic/{file}.m2")
        };
        catalog.models.insert(
            key,
            ModelRow {
                path,
                scale: number(row, "scale")?,
                flags: unsigned(row, "flags")?,
                size_class: signed(row, "sizeClass")?,
                blood: signed(row, "bloodID")?,
                footprint_texture: signed(row, "footprintTextureID")?,
                footprint_length: number(row, "footprintLength")?,
                footprint_width: number(row, "footprintWidth")?,
                collision_height: number(row, "collisionHeight")?,
                foley_material: unsigned(row, "foleyMaterialID")?,
                // Modern CameraEffect references are not legacy CameraShakes keys.
                footstep_shake: 0,
                death_thud_shake: 0,
            },
        );
    }
    for (key, row) in rows(&data, "extras")? {
        let key: u32 = key.parse()?;
        let bake = unsigned(row, "bakeFileDataID")?;
        let resource = unsigned(row, "bakeMaterialResourcesID")?;
        let hd_resource = unsigned(row, "hdBakeMaterialResourcesID")?;
        anyhow::ensure!(
            (resource == 0) == (bake == 0),
            "NPC appearance {key} has an unresolved or orphaned bake texture"
        );
        anyhow::ensure!(
            resource != 0 || hd_resource == 0,
            "NPC appearance {key} has only an unsupported HD bake"
        );
        catalog.extra.insert(
            key,
            NpcAppearance {
                race: byte(row, "race")?,
                sex: byte(row, "sex")?,
                skin: byte(row, "skin")?,
                face: byte(row, "face")?,
                hair_style: byte(row, "hairStyle")?,
                hair_color: byte(row, "hairColor")?,
                facial_hair: byte(row, "facialHair")?,
                // This layout has no NPCItemDisplay array. The authored baked atlas carries
                // its painted equipment and goes through the original baked-texture path.
                equipment: [0; 10],
                bake_name: (bake != 0).then(|| format!("pf_{bake}.blp")),
            },
        );
    }
    for (key, row) in rows(&data, "displays")? {
        let key: u32 = key.parse()?;
        let model_id = unsigned(row, "modelID")?;
        anyhow::ensure!(
            model_ids.contains(&model_id),
            "creature display {key} names absent model {model_id}"
        );
        let extended_id = unsigned(row, "extraDisplayID")?;
        anyhow::ensure!(
            extended_id == 0 || catalog.extra.contains_key(&extended_id),
            "creature display {key} names absent appearance {extended_id}"
        );
        let texture_ids = row["textures"]
            .as_array()
            .context("missing creature texture slots")?;
        anyhow::ensure!(
            texture_ids.len() == 4,
            "modern creature requires four authored texture slots"
        );
        let mut textures = [None, None, None];
        for (slot, value) in textures.iter_mut().zip(texture_ids) {
            let file = u32::try_from(value.as_u64().context("invalid creature texture file ID")?)?;
            *slot = (file != 0).then(|| format!("__classic/{file}.blp"));
        }
        let alpha = unsigned(row, "alpha")?;
        anyhow::ensure!(alpha <= 255, "creature alpha exceeds 255");
        catalog.display.insert(
            key,
            DisplayRow {
                particle_colors: crate::modern_items::particle_colors(row)?,
                model_id,
                extended_id,
                scale: number(row, "scale")?,
                textures,
                blood_level: unsigned(row, "bloodID")?,
                size_class: signed(row, "sizeClass")?,
                model_alpha: alpha,
                sound_id: unsigned(row, "soundID")?,
            },
        );
    }
    anyhow::ensure!(
        !catalog.display.is_empty() && !model_ids.is_empty(),
        "empty modern creature catalog"
    );
    let first = unsigned(&data, "firstDisplayID")?;
    anyhow::ensure!(
        catalog.display.contains_key(&first),
        "modern first creature display is absent"
    );
    catalog.first_display = Some(first);
    for id in data["soundRows"]
        .as_array()
        .context("missing modern creature sound row IDs")?
    {
        catalog.sound_rows.insert(u32::try_from(
            id.as_u64().context("invalid creature sound row ID")?,
        )?);
    }
    Ok(catalog)
}

#[cfg(test)]
mod tests;
