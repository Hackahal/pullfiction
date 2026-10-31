//! Validate adapted terrain using the production parser.
fn main() -> anyhow::Result<()> {
    for path in std::env::args().skip(1) {
        let data = std::fs::read(&path)?;
        let benilla_adt::ParsedAdt::Root(root) =
            benilla_adt::parse_adt(&mut std::io::Cursor::new(data.as_slice()))?;
        anyhow::ensure!(root.mcnk_chunks.len() == 256, "wrong terrain chunk count");
        let mut heights = 0;
        let mut layers = 0;
        let mut liquids = 0;
        for c in &root.mcnk_chunks {
            anyhow::ensure!(
                c.heights.as_ref().is_some_and(
                    |h| h.heights.len() == 145 && h.heights.iter().all(|v| v.is_finite())
                ),
                "missing terrain heights"
            );
            heights += c.heights.as_ref().unwrap().heights.len();
            layers += c.layers.as_ref().map_or(0, |l| l.layers.len());
            liquids += c.liquids.len();
            let _ = benilla_adt::CombinedAlphaMap::new(c, false, true);
        }
        println!("{path}: {heights} heights, {layers} layers, {liquids} liquid layers, {} objects, {} WMOs",root.doodad_placements.len(),root.wmo_placements.len());
    }
    Ok(())
}
