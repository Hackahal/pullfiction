use super::*;
use serde_json::json;

fn fixture() -> Value {
    let mut data = json!({"schema":1,"source":{"product":"wow_classic_era","version":"1.15.9.70576","buildKey":"5604ce35a8644bdcf0e26c1daf979c15"},
        "layouts":{"ChrRaces":"47a2e62f","ChrRaceXChrModel":"a203bc29","ChrModel":"03fab755","ChrCustomizationConversion":"98d50cbd","ChrCustomizationChoice":"9559c358","ChrCustomizationOption":"ef4b96c5","CharHairGeosets":"0dfa0f80","CharacterFacialHairStyles":"7d8b51fb","HelmetGeosetData":"103b3b37","ChrModelMaterial":"22469480","ChrCustomizationElement":"d68dcdea","ChrCustomizationMaterial":"e61f7a35","ChrModelTextureLayer":"31f57e28"},
        "coverage":{"replayMetadata":true,"characterCreation":false,"charSections":false},
        "legacyConversions":[],"sectionTextureTypes":[{"race":1,"sex":0,"types":[1,6]},{"race":2,"sex":1,"types":[1,8]}]});
    for (race, sex) in [(1, 0), (2, 1)] {
        for option in 1..=5 {
            for value in 0..=1 {
                data["legacyConversions"].as_array_mut().unwrap().push(json!({"race":race,"sex":sex,"option":option,"data":value,"dependentOption":0,"dependentData":0,"modernOptionId":100+option,"choiceId":1000+option*10+value}));
            }
        }
    }
    data
}

fn plan(
    sections: &CharSections,
    look: [u8; 5],
    equipment: [Option<&ItemDisplay>; 8],
) -> CompositePlan {
    sections
        .composite_plan(
            1, 0, look[0], look[1], look[4], look[2], look[3], equipment, None, false,
        )
        .unwrap()
}

#[test]
fn modern_sections_body_key_keeps_all_five_dials_and_eight_display_ids() {
    let data = serde_json::to_vec(&fixture()).unwrap();
    let sections = load(|name| {
        assert_eq!(name, "__classic/character-catalog.json");
        Ok(data)
    })
    .unwrap();
    let displays: [ItemDisplay; 8] = std::array::from_fn(|i| ItemDisplay {
        modern_display_id: Some(100 + i as u32),
        ..Default::default()
    });
    let equipment = std::array::from_fn(|i| Some(&displays[i]));
    let complete = plan(&sections, [1; 5], equipment);
    assert_eq!(
        complete.base,
        "__classic/appearance/1-0-1-1-1-1-1-100-101-102-103-104-105-106-107-body.blp"
    );
    let mut identities = BTreeSet::from([plan(&sections, [0; 5], [None; 8]).base]);
    for i in 0..5 {
        let mut look = [0; 5];
        look[i] = 1;
        let key = plan(&sections, look, [None; 8]).base;
        let components: Vec<_> = key
            .strip_prefix("__classic/appearance/")
            .unwrap()
            .strip_suffix("-body.blp")
            .unwrap()
            .split('-')
            .collect();
        assert_eq!(
            components[2 + i],
            "1",
            "look dial retains its contracted component position"
        );
        identities.insert(key);
    }
    for i in 0..8 {
        let mut equipment = [None; 8];
        equipment[i] = Some(&displays[i]);
        identities.insert(plan(&sections, [0; 5], equipment).base);
    }
    assert_eq!(
        identities.len(),
        14,
        "no look dial or equipment slot collapses to another key"
    );
}

#[test]
fn modern_sections_base_only_plan_preserves_512_atlas_and_authored_mips() {
    let sections = from_catalog(fixture()).unwrap();
    let plan = plan(&sections, [0; 5], [None; 8]);
    assert!(plan.layers.is_empty());
    let expected = BlpMipChain {
        width: 512,
        height: 512,
        texels: crate::BlpTexels::Rgba8Unorm,
        mips: vec![
            vec![3; 512 * 512 * 4],
            vec![7; 256 * 256 * 4],
            vec![11; 128 * 128 * 4],
        ],
    };
    let mut reads = Vec::new();
    let result = plan
        .run(|name| {
            reads.push(name.to_string());
            Ok(expected.clone())
        })
        .unwrap();
    assert_eq!(reads, [plan.base.clone()]);
    assert_eq!((result.width, result.height), (512, 512));
    assert_eq!(result.texels, expected.texels);
    assert_eq!(
        result.mips, expected.mips,
        "no legacy256 tile blit or rescale runs"
    );
}

#[test]
fn modern_sections_borrowed_hair_and_extra_aliases_follow_actual_capabilities() {
    let sections = from_catalog(fixture()).unwrap();
    assert_eq!(
        sections.hair_mesh_texture(1, 0, 1, 1),
        Some("__classic/appearance/1-0-1-1-hair.blp")
    );
    assert_eq!(sections.skin_extra_texture(1, 0, 1), None);
    assert_eq!(sections.hair_mesh_texture(2, 1, 1, 1), None);
    assert_eq!(
        sections.skin_extra_texture(2, 1, 1),
        Some("__classic/appearance/2-1-1-extra.blp")
    );
    assert_eq!(sections.hair_texture(1, 0, 99, 1), None);
    assert_eq!(sections.skin_extra_texture(2, 1, 99), None);
}

#[test]
fn modern_sections_missing_metadata_is_an_error_and_unrepresentable_inputs_have_no_plan() {
    assert!(load(|_| anyhow::bail!("fixture metadata missing")).is_err());
    assert!(load(|_| Ok(b"invalid JSON".to_vec())).is_err());
    for field in ["legacyConversions", "sectionTextureTypes"] {
        let mut data = fixture();
        data[field] = Value::Null;
        assert!(from_catalog(data).is_err(), "{field}");
    }
    let sections = from_catalog(fixture()).unwrap();
    assert!(sections
        .composite_plan(1, 0, 99, 0, 0, 0, 0, [None; 8], None, false)
        .is_none());
    assert!(sections
        .composite_plan(1, 0, 0, 0, 0, 0, 0, [None; 8], None, true)
        .is_none());
    assert!(sections
        .composite_plan(
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            [None; 8],
            Some(GuildEmblem::default()),
            false
        )
        .is_none());
    let legacy = ItemDisplay::default();
    let mut equipment = [None; 8];
    equipment[0] = Some(&legacy);
    assert!(sections
        .composite_plan(1, 0, 0, 0, 0, 0, 0, equipment, None, false)
        .is_none());
}

#[test]
#[ignore = "requires an explicit retained modern character catalog"]
fn modern_sections_retained_metadata_keeps_every_authored_replay_look() {
    let path =
        std::env::var_os("BENILLA_MODERN_CHARACTER_GRAPH").expect("BENILLA_MODERN_CHARACTER_GRAPH");
    let data: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let sections = from_catalog(data.clone()).unwrap();
    let mut count = 0;
    for row in data["legacyConversions"].as_array().unwrap() {
        let race = modern::byte(row, "race").unwrap();
        let sex = modern::byte(row, "sex").unwrap();
        let mut look = [0; 5];
        look[modern::uint(row, "option").unwrap() as usize - 1] =
            modern::byte(row, "data").unwrap();
        let plan = sections
            .composite_plan(
                race, sex, look[0], look[1], look[4], look[2], look[3], [None; 8], None, false,
            )
            .unwrap();
        assert!(plan.layers.is_empty());
        assert_eq!(plan.base, body_path(race, sex, look, [0; 8]));
        count += 1;
    }
    for row in data["sectionTextureTypes"].as_array().unwrap() {
        let race = modern::byte(row, "race").unwrap();
        let sex = modern::byte(row, "sex").unwrap();
        let types = row["types"].as_array().unwrap();
        assert_eq!(
            sections.hair_mesh_texture(race, sex, 0, 0).is_some(),
            types.contains(&json!(6))
        );
        assert_eq!(
            sections.skin_extra_texture(race, sex, 0).is_some(),
            types.contains(&json!(8))
        );
    }
    println!(
        "modern sections source={}; authored legacy dial rows={}; body capabilities={}",
        data["source"],
        count,
        data["sectionTextureTypes"].as_array().unwrap().len()
    );
}
