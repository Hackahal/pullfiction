//! Modern replay-only character data. Rendering and geoset selection stay in their original code.
pub(super) use crate::modern_world::{array, string, uint};
use anyhow::{ensure, Context, Result};
use serde_json::Value;

pub(super) const GRAPH: &str = "__classic/character-catalog.json";

pub(super) fn load(read: impl FnOnce(&str) -> Result<Vec<u8>>) -> Result<Value> {
    let bytes = read(GRAPH).context("reading browser-local character catalog")?;
    let data: Value =
        serde_json::from_slice(&bytes).context("invalid modern character catalog JSON")?;
    validate(&data)?;
    Ok(data)
}
pub(super) fn validate(data: &Value) -> Result<()> {
    ensure!(
        uint(data, "schema")? == 1,
        "unsupported modern character schema"
    );
    let source = &data["source"];
    let version = string(source, "version")?;
    let build = string(source, "buildKey")?;
    ensure!(
        string(source, "product")? == "wow_classic_era"
            && version
                .strip_prefix("1.15.9.")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
            && build.len() == 32
            && build
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "invalid modern character source"
    );
    for (name, layout) in [
        ("ChrRaces", "47a2e62f"),
        ("ChrRaceXChrModel", "a203bc29"),
        ("ChrModel", "03fab755"),
        ("ChrCustomizationConversion", "98d50cbd"),
        ("ChrCustomizationChoice", "9559c358"),
        ("ChrCustomizationOption", "ef4b96c5"),
        ("CharHairGeosets", "0dfa0f80"),
        ("CharacterFacialHairStyles", "7d8b51fb"),
        ("HelmetGeosetData", "103b3b37"),
        ("ChrModelMaterial", "22469480"),
        ("ChrCustomizationElement", "d68dcdea"),
        ("ChrCustomizationMaterial", "e61f7a35"),
        ("ChrModelTextureLayer", "31f57e28"),
    ] {
        ensure!(
            string(&data["layouts"], name)? == layout,
            "unsupported modern character {name} layout"
        );
    }
    ensure!(
        data["coverage"]["replayMetadata"] == true
            && data["coverage"]["characterCreation"] == false
            && data["coverage"]["charSections"] == false,
        "modern character catalog must declare replay-only metadata coverage"
    );
    Ok(())
}
pub(super) fn byte(data: &Value, name: &str) -> Result<u8> {
    Ok(u8::try_from(uint(data, name)?)?)
}

/// Resolve every legacy dial through authored conversion rows, including conditional rows.
/// The output keys are actual modern option IDs, not positions in a UI sort order.
pub(super) fn choices(
    data: &Value,
    race: u8,
    sex: u8,
    look: [u8; 5],
) -> Result<std::collections::BTreeMap<u32, u32>> {
    let mut result = std::collections::BTreeMap::new();
    for (index, value) in look.into_iter().enumerate() {
        let mut selected = None;
        for row in array(data, "legacyConversions", None)? {
            if byte(row, "race")? != race
                || byte(row, "sex")? != sex
                || uint(row, "option")? != index as u32 + 1
                || byte(row, "data")? != value
            {
                continue;
            }
            let dependent = uint(row, "dependentOption")?;
            let dep_value = byte(row, "dependentData")?;
            if dependent != 0 && look.get(dependent as usize - 1).copied() != Some(dep_value) {
                continue;
            }
            ensure!(
                selected.is_none(),
                "ambiguous legacy character look mapping"
            );
            selected = Some((uint(row, "modernOptionId")?, uint(row, "choiceId")?));
        }
        let (option, choice) =
            selected.context("legacy character look has no authored conversion")?;
        ensure!(
            result.insert(option, choice).is_none(),
            "legacy look maps conflicting modern options"
        );
    }
    Ok(result)
}

#[cfg(test)]
#[path = "modern_tests.rs"]
mod tests;
