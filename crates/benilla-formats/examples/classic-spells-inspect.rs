//! Inspect a caller-supplied modern catalog through production runtime resolution.
use std::collections::HashMap;
fn main() -> anyhow::Result<()> {
    let bytes = std::fs::read(std::env::args().nth(1).expect("catalog JSON path"))?;
    let mut visuals =
        benilla_formats::SpellVisualCatalog::from_tables(HashMap::new(), HashMap::new());
    visuals.merge_modern_json(&bytes)?;
    let mut spells = benilla_formats::SpellCatalog::from_displays(HashMap::new());
    spells.merge_modern_json(&bytes)?;
    for id in [133, 116, 400574, 401556, 400613, 415068] {
        let spell = spells.get(id).expect("modern spell");
        let stages = visuals.stages(spell.visual).expect("modern visual");
        let count = [
            stages.precast,
            stages.cast,
            stages.impact,
            stages.state,
            stages.channel,
        ]
        .iter()
        .filter_map(|id| visuals.kit(*id))
        .map(|kit| visuals.model_attachments(kit).len())
        .sum::<usize>();
        println!(
            "spell {id}: visual {}, {count} model attachments",
            spell.visual
        );
        anyhow::ensure!(count > 0, "missing modern attachments");
    }
    Ok(())
}
