use anyhow::Result;
use serde_json::{json, Value};

const SPELL_GRAPH: &str = "__classic/spell-effects.json";
const ITEM_GRAPH: &str = "__classic/item-appearances.json";

fn only_graph(expected: &str, name: &str, graph: &Value) -> Result<Vec<u8>> {
    anyhow::ensure!(
        name == expected,
        "old table or unexpected file requested: {name}"
    );
    Ok(serde_json::to_vec(graph)?)
}

fn spell_graph() -> Value {
    json!({
        "schema": 1,
        "spells": {"400574": {
            "visuals": [
                {"id": 7749, "priority": 1, "difficulty": 0, "conditions": [0, 0, 0, 0]},
                {"id": 999, "priority": 10, "difficulty": 1, "conditions": [0, 0, 0, 0]},
                {"id": 998, "priority": 20, "difficulty": 0, "conditions": [1, 0, 0, 0]}
            ],
            "attributes": [66, 64, 32, 1024, 8],
            "iconFile": 135846, "speed": 25, "schoolMask": 64,
            "castMs": 1500, "durationMs": 6000, "channel": true
        }},
        "effects": {"735": {"fileDataID": 165578, "type": 0, "scale": 1, "alpha": 1, "speed": 0}},
        "kits": {"1005": {
            "effects": [{"id": 3, "effect": 735, "attachment": 34, "scale": 1.5,
                "offset": [1, 2, 3], "rotation": [0, 0, 0], "delay": 0.2,
                "positioner": 0, "flags": 0}],
            "animations": [{"LoopAnimID": 212, "InitialAnimID": 16}], "unsupported": []
        }},
        "visuals": {"7749": {
            "events": [
                {"start": "Precast Start", "end": "Cast", "target": "Caster", "kit": 1005, "delay": 0, "maxDelay": 0},
                {"start": "Cast", "end": "None", "target": "Caster", "kit": 1005, "delay": 0, "maxDelay": 0},
                {"start": "Impact", "end": "None", "target": "Target", "kit": 1005, "delay": 0, "maxDelay": 0},
                {"start": "Aura Start", "end": "Aura End", "target": "Target (Not Caster)", "kit": 1005, "delay": 0, "maxDelay": 0},
                {"start": "Channel Start", "end": "Channel End", "target": "Caster", "kit": 1005, "delay": 0, "maxDelay": 0}
            ],
            "missiles": [{"effect": 735, "attachment": 21, "destination": 34, "positioner": 0, "motion": 0}],
            "hasMissile": true, "missileSet": 1
        }},
        "animationFallbacks": {"0": 0, "16": 0, "212": 16}
    })
}

fn item_graph() -> Value {
    json!({"schema": 1, "items": {}, "displays": {"696393": {
        "models": [[{"file": 100, "race": 0, "sex": -1, "position": -1},
                    {"file": 101, "race": 7, "sex": 1, "position": 0}], []],
        "textures": [[{"file": 200, "race": 0, "sex": -1}], []],
        "regions": {"3": [{"file": 300, "race": 0, "sex": -1}]},
        "geosets": [1, 2, 3], "helmet": [4, 5], "visual": 7, "rangedVisual": 7749
    }}})
}

#[test]
fn browser_local_original_spell_catalog_needs_only_modern_graph() {
    let graph = spell_graph();
    let catalog =
        crate::spells::load_browser_local_catalog(|name| only_graph(SPELL_GRAPH, name, &graph))
            .unwrap();
    let spell = catalog.get(400574).unwrap();
    assert_eq!(spell.visual, 7749);
    assert_eq!(spell.icon.as_deref(), Some("__classic/135846"));
    assert_eq!(spell.speed, 25.0);
    assert_eq!(spell.school, 6);
    assert!(spell.passive);
    assert!(spell.ranged_attack());
    assert_eq!(spell.attributes_ex, 64);
    assert_eq!(spell.attributes_ex3, 1024);
    assert_eq!(spell.attributes_ex4, 8);
    assert!(catalog.learn_effects(400574).is_empty());
    assert_eq!(catalog.dispel_name(spell), None);
    assert_eq!(spell.name, "Spell 400574", "no localized name is exported");
    assert_eq!(
        spell.duration_index, 0,
        "the graph has no original duration-table key"
    );
}

#[test]
fn browser_local_original_visual_stages_and_animations_need_no_old_tables() {
    let graph = spell_graph();
    let catalog = crate::spell_visual::load_browser_local_catalog(|name| {
        only_graph(SPELL_GRAPH, name, &graph)
    })
    .unwrap();
    let stages = catalog.stages(7749).unwrap();
    assert_eq!(
        [
            stages.precast,
            stages.cast,
            stages.impact,
            stages.state,
            stages.channel
        ],
        [1005; 5]
    );
    let kit = catalog.kit(stages.cast).unwrap();
    assert_eq!(kit.positive_anim(), Some(212));
    let attachments = catalog.model_attachments(kit);
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].0, 34);
    assert_eq!(
        catalog.effect_path(attachments[0].1),
        Some("__classic/165578.m2")
    );
    assert_eq!(
        catalog.placement(attachments[0].1).unwrap().offset,
        [1.0, 2.0, 3.0]
    );
    assert_eq!(
        catalog.effect_path(stages.missile_model),
        Some("__classic/165578.m2")
    );
    assert_eq!(catalog.missile_effects(7749), [stages.missile_model]);
    let animations =
        crate::anim_data::load_browser_local_catalog(|name| only_graph(SPELL_GRAPH, name, &graph))
            .unwrap();
    assert_eq!(animations.fallback(212), Some(16));
    assert_eq!(
        animations.weapon_flags(212),
        0,
        "modern graph exports no legacy weapon policy"
    );
    assert_eq!(animations.name(212), None);
}

#[test]
fn browser_local_original_item_catalog_needs_only_modern_graph() {
    let graph = item_graph();
    let catalog =
        crate::items::load_browser_local_catalog(|name| only_graph(ITEM_GRAPH, name, &graph))
            .unwrap();
    let item = catalog.get(696393).unwrap();
    assert_eq!(item.model[0].as_deref(), Some("__classic/100.m2"));
    assert_eq!(
        item.modern_model(0, 7, 1).as_deref(),
        Some("__classic/101.m2")
    );
    assert_eq!(item.model_texture[0].as_deref(), Some("__classic/200.blp"));
    assert_eq!(
        item.region_textures[3].as_deref(),
        Some("__classic/300.blp")
    );
    assert_eq!(item.geoset_groups, [1, 2, 3]);
    assert_eq!(item.helmet_vis, [4, 5]);
    assert_eq!(item.spell_visual, 7749);
    assert_eq!(item.icon, None, "display graph has no display-level icon");
}

#[test]
fn browser_local_required_graph_read_and_parse_errors_reach_the_caller() {
    macro_rules! check {
        ($loader:path) => {
            let error = $loader(|_| anyhow::bail!("fixture read failure"))
                .err()
                .expect("read error");
            assert!(format!("{error:#}").contains("fixture read failure"));
            assert!($loader(|_| Ok(b"invalid JSON".to_vec())).is_err());
            assert!($loader(|_| Ok(br#"{"schema":2}"#.to_vec())).is_err());
            assert!($loader(|_| Ok(br#"{"schema":1}"#.to_vec())).is_err());
        };
    }
    check!(crate::spells::load_browser_local_catalog);
    check!(crate::spell_visual::load_browser_local_catalog);
    check!(crate::anim_data::load_browser_local_catalog);
    check!(crate::items::load_browser_local_catalog);
}

#[test]
#[ignore = "requires an explicit read-only local 1.15.9 graph export directory"]
fn browser_local_exported_modern_graphs_resolve_original_catalogs() {
    let directory = std::path::PathBuf::from(
        std::env::var_os("BENILLA_MODERN_CATALOG_DIR").expect("BENILLA_MODERN_CATALOG_DIR"),
    );
    let spell_bytes = std::fs::read(directory.join("spell-effects.json")).unwrap();
    let spell_graph: Value = serde_json::from_slice(&spell_bytes).unwrap();
    let item_bytes = std::fs::read(directory.join("item-appearances.json")).unwrap();
    let item_graph: Value = serde_json::from_slice(&item_bytes).unwrap();
    assert!(spell_graph["source"]["version"]
        .as_str()
        .unwrap()
        .starts_with("1.15.9."));
    assert_eq!(spell_graph["source"], item_graph["source"]);
    let spells = crate::spells::load_browser_local_catalog(|name| {
        only_graph(SPELL_GRAPH, name, &spell_graph)
    })
    .unwrap();
    let visuals = crate::spell_visual::load_browser_local_catalog(|name| {
        only_graph(SPELL_GRAPH, name, &spell_graph)
    })
    .unwrap();
    let animations = crate::anim_data::load_browser_local_catalog(|name| {
        only_graph(SPELL_GRAPH, name, &spell_graph)
    })
    .unwrap();
    let items =
        crate::items::load_browser_local_catalog(|name| only_graph(ITEM_GRAPH, name, &item_graph))
            .unwrap();
    assert_eq!(
        spells.len(),
        spell_graph["spells"].as_object().unwrap().len()
    );
    assert_eq!(
        visuals.len(),
        spell_graph["visuals"].as_object().unwrap().len()
    );
    assert_eq!(
        animations.len(),
        spell_graph["animationFallbacks"].as_object().unwrap().len()
    );
    assert_eq!(
        items.len(),
        item_graph["displays"].as_object().unwrap().len()
    );
    assert!(spells
        .iter()
        .any(|(_, spell)| spell.visual != 0 && visuals.stages(spell.visual).is_some()));
    assert!(items
        .iter()
        .any(|(_, item)| item.model[0].is_some() || item.model[1].is_some()));
    println!(
        "source={}; spells={}; visuals={}; kits={}; animations={}; items={}",
        spell_graph["source"],
        spells.len(),
        visuals.len(),
        visuals.kit_len(),
        animations.len(),
        items.len()
    );
}
