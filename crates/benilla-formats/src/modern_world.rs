//! Browser-local world metadata; the original catalog methods remain the consumers.
#[cfg(target_arch = "wasm32")]
use crate::Chain;
use anyhow::{ensure, Context, Result};
use serde_json::Value;

#[cfg(target_arch = "wasm32")]
pub(crate) fn load(chain: &mut Chain) -> Result<Option<Value>> {
    if !crate::browser_local::active() {
        return Ok(None);
    }
    load_required(|name| chain.read_file(name)).map(Some)
}

pub(crate) fn load_required(read: impl FnOnce(&str) -> Result<Vec<u8>>) -> Result<Value> {
    let bytes =
        read("__classic/world-catalog.json").context("reading browser-local world catalog")?;
    let data: Value = serde_json::from_slice(&bytes).context("invalid modern world catalog")?;
    validate(&data)?;
    Ok(data)
}
pub(crate) fn validate(data: &Value) -> Result<()> {
    ensure!(
        uint(data, "schema")? == 1,
        "unsupported modern world catalog schema"
    );
    let source = &data["source"];
    ensure!(
        string(source, "product")? == "wow_classic_era",
        "unsupported modern world catalog product"
    );
    let version = string(source, "version")?;
    ensure!(
        version
            .strip_prefix("1.15.9.")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())),
        "unsupported modern world catalog version"
    );
    let key = string(source, "buildKey")?;
    ensure!(
        key.len() == 32
            && key
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "invalid modern world build key"
    );
    for (name, layout) in [
        ("Map", "b47c6f05"),
        ("AreaTable", "705c911d"),
        ("WMOAreaTable", "c5a7b977"),
    ] {
        ensure!(
            string(&data["layouts"], name)? == layout,
            "unsupported modern {name} layout"
        );
    }
    ensure!(
        data["coverage"]["legacyBattlegroundMetadata"] == false,
        "modern world catalog must declare unsupported legacy battleground metadata"
    );
    Ok(())
}
pub(crate) fn array<'a>(data: &'a Value, name: &str, len: Option<usize>) -> Result<&'a [Value]> {
    let values = data[name]
        .as_array()
        .with_context(|| format!("missing world catalog {name}"))?;
    ensure!(
        len.is_none_or(|n| n == values.len()),
        "invalid world catalog {name} length"
    );
    Ok(values)
}
pub(crate) fn uint(data: &Value, name: &str) -> Result<u32> {
    data[name]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .with_context(|| format!("invalid world catalog {name}"))
}
pub(crate) fn sint(data: &Value, name: &str) -> Result<i32> {
    data[name]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .with_context(|| format!("invalid signed world catalog {name}"))
}
pub(crate) fn real(data: &Value, name: &str) -> Result<f32> {
    let value = data[name]
        .as_f64()
        .with_context(|| format!("invalid world catalog {name}"))? as f32;
    ensure!(value.is_finite(), "non-finite world catalog {name}");
    Ok(value)
}
pub(crate) fn string<'a>(data: &'a Value, name: &str) -> Result<&'a str> {
    let value = data[name]
        .as_str()
        .with_context(|| format!("invalid world catalog {name}"))?;
    ensure!(!value.contains('\0'), "NUL in world catalog {name}");
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        json!({"schema":1,"source":{"product":"wow_classic_era","version":"1.15.9.70576","buildKey":"5604ce35a8644bdcf0e26c1daf979c15"},
            "layouts":{"Map":"b47c6f05","AreaTable":"705c911d","WMOAreaTable":"c5a7b977"},
            "coverage":{"legacyBattlegroundMetadata":false},
            "maps":[{"id":409,"directory":"MoltenCore","name":"Molten Core","descriptions":["Alliance","Horde"],"instanceType":2,"areaTableId":2717,"loadingScreenId":192,"maxPlayers":40,"minimapIconScale":1.25}],
            "areas":[
                {"id":2717,"mapId":409,"zoneId":0,"exploreFlag":9,"flags":1,"factionGroupMask":0,"explorationLevel":-1,"name":"Molten Core"},
                {"id":3000,"mapId":409,"zoneId":2717,"exploreFlag":10,"flags":0,"factionGroupMask":0,"explorationLevel":60,"name":"A room"}],
            "wmoAreas":[
                {"id":1,"wmoId":52,"nameSetId":0,"groupId":-1,"soundProvider":[2,11],"ambience":3,"zoneMusic":4,"introSound":5,"areaTableId":2717,"name":"Building"},
                {"id":2,"wmoId":52,"nameSetId":0,"groupId":7,"soundProvider":[0,0],"ambience":6,"zoneMusic":0,"introSound":0,"areaTableId":3000,"name":"Room"}]})
    }

    #[test]
    fn modern_world_maps_keep_original_catalog_queries() {
        let maps = crate::maps::from_modern_world(&fixture()).unwrap();
        assert_eq!(maps.directory(409), Some("MoltenCore"));
        assert_eq!(maps.name(409), Some("Molten Core"));
        assert_eq!(maps.area_table_id(409), Some(2717));
        assert_eq!(maps.loading_screen_id(409), Some(192));
        assert_eq!(maps.instance_type(409), Some(2));
        let columns = maps.battleground(409).unwrap();
        assert_eq!(columns.max_players, 40);
        assert_eq!(columns.descriptions, ["Alliance", "Horde"]);
        assert_eq!(columns.minimap_icon_scale, 1.25);
    }

    #[test]
    fn modern_world_areas_keep_order_parent_cold_and_signed_levels() {
        let areas = crate::area_table::from_modern_world(&fixture()).unwrap();
        assert_eq!(areas.top_zone(3000), Some(2717));
        assert_eq!(areas.name(3000), Some("A room"));
        assert!(areas.is_cold(3000));
        assert_eq!(areas.get(2717).unwrap().exploration_level, -1);
        assert_eq!(
            areas.rows_in_order().map(|(id, _)| id).collect::<Vec<_>>(),
            vec![2717, 3000]
        );
    }

    #[test]
    fn modern_world_wmo_rows_keep_default_inheritance_and_exact_names() {
        let wmos = crate::wmo_area::from_modern_world(&fixture()).unwrap();
        assert_eq!(wmos.default_row(52, 0).unwrap().name, "Building");
        assert_eq!(wmos.group_row(52, 0, 7).unwrap().name, "Room");
        let room = wmos.resolve(52, 0, 7).unwrap();
        assert_eq!(room.sound_provider, [2, 11]);
        assert_eq!(room.ambience, 6);
        assert_eq!(room.intro_sound, 5);
        assert_eq!(room.zone_music, 4);
        assert_eq!(room.area_table_id, 3000);
        assert!(wmos.group_row(52, 0, 99).is_none());
        assert_eq!(wmos.resolve(52, 1, 99).unwrap().name, "Building");
    }

    #[test]
    fn modern_world_rejects_missing_typed_fields_unknown_layouts_and_duplicate_ids() {
        for (table, field) in [
            ("maps", "maxPlayers"),
            ("areas", "explorationLevel"),
            ("wmoAreas", "groupId"),
        ] {
            let mut data = fixture();
            data[table][0].as_object_mut().unwrap().remove(field);
            let result = match table {
                "maps" => crate::maps::from_modern_world(&data).map(|_| ()),
                "areas" => crate::area_table::from_modern_world(&data).map(|_| ()),
                _ => crate::wmo_area::from_modern_world(&data).map(|_| ()),
            };
            assert!(result.is_err());
        }
        let mut data = fixture();
        data["layouts"]["Map"] = json!("00000000");
        assert!(crate::maps::from_modern_world(&data).is_err());
        let mut data = fixture();
        let copy = data["maps"][0].clone();
        data["maps"].as_array_mut().unwrap().push(copy);
        assert!(crate::maps::from_modern_world(&data).is_err());
        data = fixture();
        data["maps"][0]["maxPlayers"] = json!(true);
        assert!(crate::maps::from_modern_world(&data).is_err());
    }

    #[test]
    fn modern_world_required_catalog_does_not_fall_back_to_legacy_bytes() {
        let error = load_required(|name| {
            assert_eq!(name, "__classic/world-catalog.json");
            anyhow::bail!("not prepared")
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("not prepared"));
        assert!(load_required(|_| Ok(b"not JSON".to_vec())).is_err());
    }

    #[test]
    fn modern_world_retained_converter_output_if_supplied() {
        let Some(path) = std::env::var_os("PULLFICTION_WORLD_CATALOG") else {
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        let data: Value = serde_json::from_slice(&bytes).unwrap();
        let maps = crate::maps::from_modern_world(&data).unwrap();
        let areas = crate::area_table::from_modern_world(&data).unwrap();
        let wmos = crate::wmo_area::from_modern_world(&data).unwrap();
        assert_eq!(maps.len(), data["maps"].as_array().unwrap().len());
        assert_eq!(areas.len(), data["areas"].as_array().unwrap().len());
        assert!(wmos.len() > 0);
        for id in [0, 1, 249, 309, 409, 469, 509, 531, 533, 2856] {
            assert!(maps.directory(id).is_some(), "required map {id}");
        }
        assert_eq!(maps.directory(533), Some("Stratholme Raid"));
        assert_eq!(maps.area_table_id(409), Some(2717));
    }
}
