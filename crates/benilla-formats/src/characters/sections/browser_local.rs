//! Prepared modern atlas names behind the original borrowed section getters.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

use super::super::modern;
use serde_json::Value;

fn body_path(race: u8, sex: u8, look: [u8; 5], equipment: [u32; 8]) -> String {
    let mut values = vec![u32::from(race), u32::from(sex)];
    values.extend(look.map(u32::from));
    values.extend(equipment);
    format!(
        "__classic/appearance/{}-body.blp",
        values
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join("-")
    )
}

pub(super) fn load(read: impl FnOnce(&str) -> Result<Vec<u8>>) -> Result<CharSections> {
    from_catalog(modern::load(read)?)
}

fn from_catalog(data: Value) -> Result<CharSections> {
    modern::validate(&data)?;
    let mut dials: BTreeMap<(u8, u8, u32), BTreeSet<u8>> = BTreeMap::new();
    for row in modern::array(&data, "legacyConversions", None)? {
        let race = modern::byte(row, "race")?;
        let sex = modern::byte(row, "sex")?;
        let option = modern::uint(row, "option")?;
        anyhow::ensure!((1..=5).contains(&option), "invalid section legacy dial");
        anyhow::ensure!(
            modern::uint(row, "dependentOption")? == 0,
            "borrowed section aliases require independent authored legacy dials"
        );
        modern::byte(row, "dependentData")?;
        modern::uint(row, "modernOptionId")?;
        modern::uint(row, "choiceId")?;
        dials
            .entry((race, sex, option))
            .or_default()
            .insert(modern::byte(row, "data")?);
    }
    let mut sections = HashMap::new();
    let mut bodies = BTreeSet::new();
    for row in modern::array(&data, "sectionTextureTypes", None)? {
        let race = modern::byte(row, "race")?;
        let sex = modern::byte(row, "sex")?;
        anyhow::ensure!(
            bodies.insert((race, sex)),
            "duplicate section body capability"
        );
        let types = modern::array(row, "types", None)?;
        for ty in types {
            anyhow::ensure!(
                matches!(ty.as_u64(), Some(1 | 6 | 8)),
                "invalid authored section texture type"
            );
        }
        anyhow::ensure!(
            types.contains(&Value::from(1)),
            "modern section body has no authored body layers"
        );
        for option in 1..=5 {
            anyhow::ensure!(
                dials
                    .get(&(race, sex, option))
                    .is_some_and(|v| v.contains(&0)),
                "modern section body lacks authored legacy dial metadata"
            );
        }
        for &skin in &dials[&(race, sex, 1)] {
            sections.insert(
                (race, sex, SECTION_SKIN, 0, skin),
                [
                    body_path(race, sex, [skin, 0, 0, 0, 0], [0; 8]),
                    if types.contains(&Value::from(8)) {
                        format!("__classic/appearance/{race}-{sex}-{skin}-extra.blp")
                    } else {
                        String::new()
                    },
                    String::new(),
                ],
            );
        }
        if types.contains(&Value::from(6)) {
            for &style in &dials[&(race, sex, 3)] {
                for &color in &dials[&(race, sex, 4)] {
                    sections.insert(
                        (race, sex, SECTION_HAIR, style, color),
                        [
                            format!("__classic/appearance/{race}-{sex}-{style}-{color}-hair.blp"),
                            String::new(),
                            String::new(),
                        ],
                    );
                }
            }
        }
    }
    anyhow::ensure!(
        !bodies.is_empty(),
        "modern sections have no authored body capabilities"
    );
    anyhow::ensure!(
        bodies == dials.keys().map(|&(race, sex, _)| (race, sex)).collect(),
        "modern sections lack body capabilities for authored legacy dials"
    );
    Ok(CharSections {
        sections,
        modern: Some(data),
    })
}

pub(super) fn composite_plan(
    data: &Value,
    race: u8,
    sex: u8,
    look: [u8; 5],
    equipment: [Option<&ItemDisplay>; 8],
    emblem: Option<GuildEmblem>,
    tabard_preview: bool,
) -> Option<CompositePlan> {
    // These original API inputs have no equivalent in the prepared replay-atlas key.
    if emblem.is_some() || tabard_preview {
        return None;
    }
    modern::choices(data, race, sex, look).ok()?;
    let mut ids = [0; 8];
    for (id, display) in ids.iter_mut().zip(equipment) {
        if let Some(display) = display {
            *id = display.modern_display_id.filter(|&id| id != 0)?;
        }
    }
    Some(CompositePlan {
        base: body_path(race, sex, look, ids),
        layers: Vec::new(),
    })
}

#[cfg(test)]
mod tests;
