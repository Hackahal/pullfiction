use super::*;
use crate::characters::{CharCreateCatalog, CharacterGeosets, EquipGeosets};
use serde_json::json;

fn fixture() -> Value {
    let mut value = json!({"schema":1,"source":{"product":"wow_classic_era","version":"1.15.9.70576","buildKey":"5604ce35a8644bdcf0e26c1daf979c15"},
        "layouts":{"ChrRaces":"47a2e62f","ChrRaceXChrModel":"a203bc29","ChrModel":"03fab755","ChrCustomizationConversion":"98d50cbd","ChrCustomizationChoice":"9559c358","ChrCustomizationOption":"ef4b96c5","CharHairGeosets":"0dfa0f80","CharacterFacialHairStyles":"7d8b51fb","HelmetGeosetData":"103b3b37","ChrModelMaterial":"22469480","ChrCustomizationElement":"d68dcdea","ChrCustomizationMaterial":"e61f7a35","ChrModelTextureLayer":"31f57e28"},
        "coverage":{"replayMetadata":true,"characterCreation":false,"charSections":false},
        "races":[],"bodies":[],"legacyConversions":[],
        "hair":[{"race":1,"sex":0,"variation":1,"geoset":42},{"race":1,"sex":0,"variation":1,"geoset":99}],
        "facialHair":[{"race":1,"sex":0,"variation":1,"geosets":[3,4,5]}],
        "helmetMasks":[{"id":90,"masks":[0,2,2,0,2]}]});
    for race in 1..=8 {
        value["races"].as_array_mut().unwrap().push(json!({"id":race,"flags":race,"faction":race+10,"prefix":format!("Race{race}"),"name":format!("Race {race}"),"displays":[race*2,race*2+1]}));
        for sex in 0..=1 {
            let model = race * 2 + sex;
            value["bodies"].as_array_mut().unwrap().push(json!({"race":race,"sex":sex,"modelId":model,"displayId":model,"textureLayoutId":77,"textureTypes":[1,6]}));
            for option in 1..=5 {
                for data in 0..=1 {
                    let modern = model * 10 + option;
                    value["legacyConversions"].as_array_mut().unwrap().push(json!({"race":race,"sex":sex,"option":option,"data":data,"dependentOption":0,"dependentData":0,"modernOptionId":modern,"choiceId":50000-modern*2-data}));
                }
            }
        }
    }
    value
}

#[test]
fn modern_character_identity_and_five_dials_use_authored_values() {
    let data = fixture();
    let catalog = CharCreateCatalog::from_modern_replay(&data).unwrap();
    for race in 1..=8 {
        for sex in 0..=1 {
            assert_eq!(
                catalog.body_display(race, sex),
                Some(u32::from(race * 2 + sex))
            );
            let ranges = catalog.ranges(race, sex).unwrap();
            assert_eq!(
                [
                    ranges.skin,
                    ranges.face,
                    ranges.hair_style,
                    ranges.hair_color,
                    ranges.facial_hair
                ],
                [2; 5]
            );
            assert_eq!(choices(&data, race, sex, [1; 5]).unwrap().len(), 5);
        }
    }
    assert_eq!(catalog.race_file(1), Some("Race1"));
    assert_eq!(catalog.race_name(1), Some("Race 1"));
    assert_eq!(catalog.race_rows()[0].faction, 11);
    assert_eq!(catalog.body_display(1, 2), None);
    assert_eq!(choices(&data, 1, 0, [1; 5]).unwrap()[&23], 49953);
    assert!(choices(&data, 1, 0, [2; 5]).is_err());
    assert!(catalog.class_list(1).is_empty());
    assert!(catalog
        .name_gen_error()
        .unwrap()
        .contains("outside the replay"));
}

#[test]
fn modern_geosets_keep_original_selector_and_helmet_race_masks() {
    let data = fixture();
    let geosets = CharacterGeosets::from_modern(&data).unwrap();
    let shown = geosets.visible_geosets(1, 0, 1, 1, &EquipGeosets::default());
    for id in [0, 42, 103, 205, 304, 702] {
        assert!(shown.contains(&id), "missing {id}");
    }
    assert!(!shown.contains(&99)); // Original scan keeps the first row.
    assert!(!shown.contains(&701));
    let equipped = EquipGeosets {
        helm_vis: Some([90, 0]),
        ..Default::default()
    };
    let hidden = geosets.visible_geosets(1, 0, 1, 1, &equipped);
    for id in [42, 101, 201, 304, 701] {
        assert!(hidden.contains(&id), "missing {id}");
    }
    for id in [103, 205, 702] {
        assert!(!hidden.contains(&id), "unexpected {id}");
    }
    assert!(geosets
        .visible_geosets(2, 0, 1, 1, &equipped)
        .contains(&702));
}

#[test]
fn modern_character_missing_preparation_and_invalid_data_are_errors() {
    let error = load(|name| {
        assert_eq!(name, GRAPH);
        anyhow::bail!("missing prepared local bytes")
    })
    .unwrap_err();
    assert!(format!("{error:#}").contains("missing prepared local bytes"));
    for mutate in [
        |v: &mut Value| v["layouts"]["CharHairGeosets"] = json!("00000000"),
        |v: &mut Value| v["bodies"][0]["displayId"] = json!(99),
        |v: &mut Value| v["bodies"].as_array_mut().unwrap().clear(),
        |v: &mut Value| v["legacyConversions"][0]["data"] = json!(3),
        |v: &mut Value| v["races"][0]["displays"][0] = json!(-1),
        |v: &mut Value| v["coverage"]["characterCreation"] = json!(true),
    ] {
        let mut data = fixture();
        mutate(&mut data);
        assert!(CharCreateCatalog::from_modern_replay(&data).is_err());
    }
    let mut data = fixture();
    data["facialHair"][0]["geosets"][0] = json!(-1);
    assert!(CharacterGeosets::from_modern(&data).is_err());
}

#[test]
fn modern_character_retained_source_supports_all_sixteen_body_queries() {
    let Ok(path) = std::env::var("PULLFICTION_CHARACTER_CATALOG") else {
        return;
    };
    let data: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let catalog = CharCreateCatalog::from_modern_replay(&data).unwrap();
    let geosets = CharacterGeosets::from_modern(&data).unwrap();
    let expected = [
        [49, 50],
        [51, 52],
        [53, 54],
        [55, 56],
        [57, 58],
        [59, 60],
        [1563, 1564],
        [1478, 1479],
    ];
    for (index, pair) in expected.into_iter().enumerate() {
        for (sex, display) in pair.into_iter().enumerate() {
            let race = index as u8 + 1;
            assert_eq!(catalog.body_display(race, sex as u8), Some(display));
            assert!(!catalog.race_name(race).unwrap().is_empty());
            for row in array(&data, "legacyConversions", None)
                .unwrap()
                .iter()
                .filter(|r| r["race"] == race && r["sex"] == sex)
            {
                let mut look = [0; 5];
                look[uint(row, "option").unwrap() as usize - 1] = byte(row, "data").unwrap();
                let converted = choices(&data, race, sex as u8, look).unwrap();
                assert_eq!(
                    converted[&uint(row, "modernOptionId").unwrap()],
                    uint(row, "choiceId").unwrap()
                );
            }
            assert!(geosets
                .visible_geosets(race, sex as u8, 0, 0, &EquipGeosets::default())
                .contains(&0));
        }
    }
    assert!(geosets
        .visible_geosets(1, 0, 0, 0, &EquipGeosets::default())
        .contains(&702));
}
