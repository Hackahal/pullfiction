//! Check every source-derived modern gear glow mapping through production native catalogs.
//! The input is ignored catalog JSON, never a checked-in client asset.
fn main() {
    let path = std::env::args().nth(1).expect("item catalog JSON path");
    let bytes = std::fs::read(path).expect("read source-derived item graph");
    let source: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let displays = benilla_formats::ItemDisplayCatalog::from_modern_json(&bytes).unwrap();
    let visuals = benilla_formats::ItemVisualCatalog::from_modern_json(&bytes).unwrap();
    let enchants = benilla_formats::EnchantCatalog::from_modern_json(&bytes).unwrap();
    let mut intrinsic = 0;
    for (id, row) in source["displays"].as_object().unwrap() {
        let visual = row["visual"].as_i64().unwrap() as i32;
        assert_eq!(
            displays.get(id.parse().unwrap()).unwrap().item_visual,
            visual
        );
        intrinsic += usize::from(visual > 0);
    }
    for (id, slots) in source["itemVisuals"].as_object().unwrap() {
        let actual = visuals.effects(id.parse().unwrap()).unwrap();
        for (slot, source) in slots.as_array().unwrap().iter().enumerate() {
            let file = source.as_i64().unwrap();
            let expected = (file > 0).then(|| format!("__classic/{file}.m2"));
            assert_eq!(actual[slot], expected);
        }
    }
    for (id, row) in source["enchantments"].as_object().unwrap() {
        let id: u32 = id.parse().unwrap();
        assert!(enchants.has_row(id));
        let visual = row["visual"].as_i64().unwrap() as i32;
        assert_eq!(enchants.visual(id), (visual != 0).then_some(visual));
        let name = row["name"].as_str().unwrap();
        assert_eq!(enchants.name(id), (!name.is_empty()).then_some(name));
    }
    println!(
        "{}",
        serde_json::json!({"status":"passed","displays":displays.len(),
        "intrinsicVisualDisplays":intrinsic,"itemVisualRows":visuals.len(),
        "enchantmentRows":source["enchantments"].as_object().unwrap().len(),
        "enchantmentsWithVisual":enchants.visual_count(),"enchantmentNames":enchants.name_count(),
        "proofBoundary":"Production catalog parsing and every source mapping; GPU/visual state unverified"})
    );
}
