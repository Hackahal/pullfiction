//! The modern asset boundary supplies the names consumed by the original native UI.
use super::*;

#[test]
fn illustrative_summon_visuals_keep_their_provenance_and_require_a_local_spell() {
    let mut catalog = SpellCatalog::from_displays(HashMap::new());
    let fixture = |provenance: &str, visual: u32| {
        format!(
            r#"{{"schema":1,"spells":{{"440802":{{"visuals":[],"summonCue":{{"displayID":114765,"visualSpellID":{visual},"presentation":"{provenance}"}}}},"440804":{{"visuals":[]}}}}}}"#
        )
    };
    catalog
        .merge_modern_json(fixture("illustrative", 440804).as_bytes())
        .unwrap();
    assert_eq!(
        catalog.summon_cue(440802),
        Some(SummonCueVisual {
            display_id: 114765,
            visual_spell_id: 440804
        })
    );
    assert!(catalog
        .merge_modern_json(fixture("recorded", 440804).as_bytes())
        .is_err());
    assert!(catalog
        .merge_modern_json(fixture("illustrative", 999).as_bytes())
        .is_err());
    assert!(catalog
        .merge_modern_json(fixture("illustrative", 0).as_bytes())
        .is_err());
    catalog
        .merge_modern_json(br#"{"schema":1,"spells":{"440802":{"visuals":[]}}}"#)
        .unwrap();
    assert_eq!(catalog.summon_cue(440802), None);
}

#[test]
fn modern_spell_names_reach_original_display_records_with_visual_metadata() {
    let mut catalog = SpellCatalog::from_displays(HashMap::new());
    catalog
        .merge_modern_json(
            br#"{"schema":1,"spells":{
                "7":{"name":"Fixture cast","visuals":[{"id":42,"priority":0,"difficulty":0,"conditions":[0,0,0,0]}],"iconFile":123,"schoolMask":64,"speed":20,"attributes":[1,2,3,4,5]},
                "8":{"name":"Fixture aura","visuals":[]}
            }}"#,
        )
        .unwrap();
    let spell = catalog.get(7).unwrap();
    assert_eq!(spell.name, "Fixture cast");
    assert_eq!(spell.visual, 42);
    assert_eq!(spell.icon.as_deref(), Some("__classic/123"));
    assert_eq!(spell.school, 6);
    assert_eq!(spell.speed, 20.0);
    assert_eq!(spell.attributes_ex4, 5);
    assert_eq!(catalog.get(8).unwrap().name, "Fixture aura");
}

#[test]
fn modern_names_replace_old_names_and_missing_names_are_never_fabricated() {
    let mut catalog = SpellCatalog::from_displays(HashMap::from([
        (
            7,
            SpellDisplay {
                id: 7,
                name: "Spell 7".to_owned(),
                ..Default::default()
            },
        ),
        (
            8,
            SpellDisplay {
                id: 8,
                name: "Existing local name".to_owned(),
                ..Default::default()
            },
        ),
    ]));
    catalog
        .merge_modern_json(
            r#"{"schema":1,"spells":{
                "7":{"name":"Localized spell å","visuals":[]},
                "8":{"visuals":[]},"9":{"visuals":[]}
            }}"#
            .as_bytes(),
        )
        .unwrap();
    assert_eq!(catalog.get(7).unwrap().name, "Localized spell å");
    assert_eq!(catalog.get(8).unwrap().name, "Existing local name");
    assert_eq!(catalog.get(9).unwrap().name, "");
}

#[test]
fn browser_local_spell_loader_preserves_names_and_native_passive_flag() {
    let catalog = load_browser_local_catalog(|name| {
        assert_eq!(name, "__classic/spell-effects.json");
        Ok(format!(
            r#"{{"schema":1,"spells":{{"7":{{"name":"Fixture passive aura","visuals":[],"attributes":[{ATTR_PASSIVE}]}}}}}}"#
        )
        .into_bytes())
    })
    .unwrap();
    assert_eq!(catalog.get(7).unwrap().name, "Fixture passive aura");
    assert!(catalog.get(7).unwrap().passive);
}

/// Opt-in verification of a caller-owned export. No client data is bundled in tests.
#[test]
fn retained_modern_spell_names_round_trip_through_original_catalog() {
    let Ok(path) = std::env::var("PULLFICTION_TEST_SPELL_GRAPH") else {
        return;
    };
    let bytes = std::fs::read(path).expect("caller-owned modern spell graph");
    let source: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(source["source"]["version"], "1.15.9.70576");
    assert_eq!(source["layouts"]["SpellName"], "782ee721");
    let catalog = load_browser_local_catalog(|name| {
        assert_eq!(name, "__classic/spell-effects.json");
        Ok(bytes.clone())
    })
    .unwrap();
    let rows = source["spells"].as_object().unwrap();
    assert_eq!(catalog.len(), rows.len());
    let mut named = 0;
    for (key, row) in rows {
        if let Some(name) = row["name"].as_str() {
            let spell = catalog.get(key.parse().unwrap()).unwrap();
            assert_eq!(spell.name, name, "client spell {key}");
            named += 1;
        }
    }
    assert_eq!(named, 31_249);
    for (id, expected) in [
        (133, "Fireball"),
        (116, "Frostbolt"),
        (1459, "Arcane Intellect"),
        (19746, "Concentration Aura"),
        (400574, "Arcane Blast"),
        (401556, "Living Flame"),
    ] {
        assert_eq!(catalog.get(id).unwrap().name, expected);
    }
    println!(
        "Original SpellCatalog: {named} exact client names, {} total spells",
        catalog.len()
    );
}
