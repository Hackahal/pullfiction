use super::*;
use serde_json::json;

#[test]
fn creature_display_palette_is_per_display_and_missing_reference_is_an_error() {
    let mut data = fixture();
    let palette = [[[0.25f32; 3]; 3]; 3];
    data["displays"]["100"]["particleColorID"] = json!(7);
    assert!(from_json(&serde_json::to_vec(&data).unwrap()).is_err());
    data["displays"]["100"]["particleColors"] = json!(palette);
    let catalog = from_json(&serde_json::to_vec(&data).unwrap()).unwrap();
    assert_eq!(catalog.particle_colors(100), Some(&palette));
}

fn fixture() -> Value {
    json!({
        "schema": 1,
        "source": {"product":"wow_classic_era", "version":"1.15.9.70576", "buildKey":"5604ce35a8644bdcf0e26c1daf979c15"},
        "tableLayouts": {"CreatureDisplayInfo":"f75f884c", "CreatureModelData":"3ffee408", "CreatureDisplayInfoExtra":"f5e49981", "CreatureSoundData":"e5ee765b", "TextureFileData":"bd7c74c2", "ComponentTextureFileData":"b32b030a"},
        "firstDisplayID": 100,
        "models": {"7": {"fileDataID":123020, "scale":1.5, "flags":2, "sizeClass":4, "bloodID":-1,
            "soundID":9, "footprintTextureID":7, "footprintLength":18, "footprintWidth":12,
            "collisionHeight":3, "foleyMaterialID":0}},
        "displays": {"100": {"modelID":7, "extraDisplayID":8, "scale":2,
            "textures":[123,0,456,789], "alpha":128, "bloodID":2, "sizeClass":-1, "soundID":9}},
        "extras": {"8": {"race":3, "sex":1, "skin":4, "face":5, "hairStyle":6, "hairColor":7, "facialHair":8, "bakeMaterialResourcesID":900,"hdBakeMaterialResourcesID":0,"bakeFileDataID":4444}},
        "soundRows": [9]
    })
}

#[test]
fn browser_local_creature_catalog_resolves_original_mob_fields_without_old_tables() {
    let data = serde_json::to_vec(&fixture()).unwrap();
    let catalog = load(|name| {
        assert_eq!(name, "__classic/creature-catalog.json");
        Ok(data)
    })
    .unwrap();
    let model = catalog.model(100).unwrap();
    assert_eq!(model.model_path, "__classic/123020.m2");
    assert_eq!(model.scale, 3.0);
    assert_eq!(
        model.textures,
        [
            Some("__classic/123.blp".into()),
            None,
            Some("__classic/456.blp".into())
        ]
    );
    assert_eq!(model.collision_height, 3.0);
    assert_eq!(catalog.display_scale(100), Some(2.0));
    assert_eq!(catalog.display_base_alpha(100), Some(128.0 / 255.0));
    assert_eq!(catalog.size_class(100), Some(4));
    assert!(!catalog.breathes(100));
    assert_eq!(catalog.footprint(100).unwrap().length, 0.5);
    assert_eq!(catalog.footprint(100).unwrap().width, 1.0 / 3.0);
    assert_eq!(catalog.display_race_sex(100), Some((3, 1)));
    let appearance = model.npc_appearance.unwrap();
    assert_eq!(
        (
            appearance.skin,
            appearance.face,
            appearance.hair_style,
            appearance.hair_color,
            appearance.facial_hair
        ),
        (4, 5, 6, 7, 8)
    );
    assert_eq!(appearance.equipment, [0; 10]);
    assert_eq!(appearance.bake_name.as_deref(), Some("pf_4444.blp"));
    assert_eq!(catalog.records_row(999), Some(100));
    assert_eq!(catalog.footstep_shake(100), None);
}

#[test]
fn browser_local_creature_character_alias_keeps_the_original_path_gate() {
    let mut data = fixture();
    let alias = "Character\\Human\\Male\\HumanMale.m2";
    data["models"]["7"]["pathAlias"] = json!(alias);
    data["characterModelPaths"] = json!({alias: 123020});
    for (table, layout) in [
        ("ChrRaces", "47a2e62f"),
        ("ChrRaceXChrModel", "a203bc29"),
        ("ChrModel", "03fab755"),
    ] {
        data["tableLayouts"][table] = json!(layout);
    }
    let catalog = from_json(&serde_json::to_vec(&data).unwrap()).unwrap();
    assert_eq!(catalog.model(100).unwrap().model_path, alias);
    data["characterModelPaths"][alias] = json!(999);
    assert!(from_json(&serde_json::to_vec(&data).unwrap()).is_err());
}

#[test]
fn browser_local_creature_source_layout_read_and_required_fields_fail_explicitly() {
    assert!(load(|_| anyhow::bail!("fixture read failure")).is_err());
    assert!(from_json(b"invalid JSON").is_err());
    for pointer in [
        "/source/version",
        "/source/product",
        "/source/buildKey",
        "/tableLayouts/CreatureDisplayInfo",
        "/tableLayouts/CreatureModelData",
        "/tableLayouts/TextureFileData",
        "/tableLayouts/ComponentTextureFileData",
    ] {
        let mut data = fixture();
        *data.pointer_mut(pointer).unwrap() = json!("unsupported");
        assert!(
            from_json(&serde_json::to_vec(&data).unwrap()).is_err(),
            "{pointer}"
        );
    }
    for (pointer, value) in [
        ("/displays/100/alpha", json!(256)),
        ("/displays/100/modelID", json!(999)),
        ("/displays/100/extraDisplayID", json!(999)),
        ("/models/7/scale", Value::Null),
        ("/extras/8/bakeFileDataID", json!(0)),
        ("/extras/8/bakeFileDataID", json!(-1)),
        ("/extras/8/bakeFileDataID", Value::Null),
        ("/extras/8/bakeMaterialResourcesID", json!(0)),
    ] {
        let mut data = fixture();
        *data.pointer_mut(pointer).unwrap() = value;
        assert!(
            from_json(&serde_json::to_vec(&data).unwrap()).is_err(),
            "{pointer}"
        );
    }
    let mut data = fixture();
    data["models"]["7"]["fileDataID"] = json!(0);
    let catalog = from_json(&serde_json::to_vec(&data).unwrap()).unwrap();
    assert!(
        catalog.model(100).is_none(),
        "unnamed model creates no virtual zero-ID asset"
    );
    assert_eq!(catalog.records_row(100), Some(100));
    let mut data = fixture();
    data["extras"]["8"]["bakeMaterialResourcesID"] = json!(0);
    data["extras"]["8"]["bakeFileDataID"] = json!(0);
    let catalog = from_json(&serde_json::to_vec(&data).unwrap()).unwrap();
    assert!(catalog
        .model(100)
        .unwrap()
        .npc_appearance
        .unwrap()
        .bake_name
        .is_none());
    data["extras"]["8"]["hdBakeMaterialResourcesID"] = json!(91);
    assert!(from_json(&serde_json::to_vec(&data).unwrap()).is_err());
}

#[test]
#[ignore = "requires an explicit retained modern creature graph export"]
fn browser_local_retained_creatures_match_exported_mob_values() {
    let path =
        std::env::var_os("BENILLA_MODERN_CREATURE_GRAPH").expect("BENILLA_MODERN_CREATURE_GRAPH");
    let bytes = std::fs::read(path).unwrap();
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    let catalog = from_json(&bytes).unwrap();
    assert_eq!(catalog.len(), data["displays"].as_object().unwrap().len());
    assert_eq!(
        catalog.extra_len(),
        data["extras"].as_object().unwrap().len()
    );
    assert_eq!(
        catalog
            .extra
            .values()
            .filter(|row| row.bake_name.is_some())
            .count() as u64,
        data["bakeCoverage"]["resolvedNormalReferences"]
            .as_u64()
            .unwrap()
    );
    for (key, row) in data["displays"].as_object().unwrap() {
        let id: u32 = key.parse().unwrap();
        let model = &data["models"][row["modelID"].as_u64().unwrap().to_string()];
        assert_eq!(
            catalog.display_base_alpha(id).unwrap(),
            row["alpha"].as_u64().unwrap() as f32 / 255.0
        );
        if model["fileDataID"] == 0 {
            assert!(catalog.model(id).is_none());
            continue;
        }
        let resolved = catalog.model(id).unwrap();
        if row["extraDisplayID"] != 0 {
            let extra = &data["extras"][row["extraDisplayID"].as_u64().unwrap().to_string()];
            let bake = extra["bakeFileDataID"].as_u64().unwrap();
            assert_eq!(
                resolved.npc_appearance.as_ref().unwrap().bake_name,
                (bake != 0).then(|| format!("pf_{bake}.blp"))
            );
        }
        assert_eq!(
            resolved.model_path,
            model["pathAlias"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!(
                    "__classic/{}.m2",
                    model["fileDataID"].as_u64().unwrap()
                ))
        );
        assert_eq!(
            resolved.scale,
            model["scale"].as_f64().unwrap() as f32 * row["scale"].as_f64().unwrap() as f32
        );
        assert_eq!(
            resolved.collision_height,
            model["collisionHeight"].as_f64().unwrap() as f32
        );
        for i in 0..3 {
            let file = row["textures"][i].as_u64().unwrap();
            assert_eq!(
                resolved.textures[i],
                (file != 0).then(|| format!("__classic/{file}.blp"))
            );
        }
    }
    assert_eq!(
        catalog.model(11121).unwrap().model_path,
        "__classic/125519.m2"
    );
    assert_eq!(catalog.display_base_alpha(1214), Some(128.0 / 255.0));
    assert_eq!(
        catalog.model(49).unwrap().model_path,
        "Character\\Human\\Male\\HumanMale.m2"
    );
    assert_eq!(data["characterModelPaths"].as_object().unwrap().len(), 16);
    assert_eq!(
        catalog.model(10115).unwrap().textures[2].as_deref(),
        Some("__classic/123558.blp")
    );
    for (display, file) in [(16582, 1050488), (15940, 1009583), (128860, 6838207)] {
        assert_eq!(
            catalog
                .model(display)
                .unwrap()
                .npc_appearance
                .unwrap()
                .bake_name,
            Some(format!("pf_{file}.blp"))
        );
    }
    println!(
        "source={}; displays={}; named models={}; extras={}; sound rows={}",
        data["source"],
        catalog.len(),
        catalog.models.len(),
        catalog.extra_len(),
        catalog.sound_rows.len()
    );
}
