//! Read caller-provided model/SKIN paths. No game assets are bundled in the example.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: classic-inspect MODEL SKIN".into());
    }
    let model = benilla_m2::classic::parse_classic_model(
        &std::fs::read(&args[0])?,
        &std::fs::read(&args[1])?,
    )?;
    let rotation_keys: usize = model
        .bones
        .iter()
        .map(|b| b.rotation.sequences.iter().map(Vec::len).sum::<usize>())
        .sum();
    println!("{} vertices, {} triangles, {} bones, {} sequences, {} rotation keys; {} particles and {} ribbons pending integration",
        model.vertices.len(), model.skin.triangles.len()/3, model.bones.len(), model.sequences.len(), rotation_keys, model.particle_emitters, model.ribbon_emitters);
    Ok(())
}
